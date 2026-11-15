//! The real wire over real TLS, on the loopback interface.
//!
//! The test builds a certificate authority and a server certificate at test time (no key is
//! committed), serves HTTP/1.1 over TLS from a thread and points the production egress module and
//! `UreqWire` at it. The wire resolves the invented name `api.test.example` to the loopback
//! address and trusts only the test authority. Everything above the wire is production code, so
//! the policy, the headers, the redirect rule, the size cap and the timeout are exercised against a
//! real socket.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use std::{
    io::{Read, Write},
    net::{SocketAddr, TcpListener, TcpStream},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    thread::{self, JoinHandle},
    time::Duration,
};

use openquant_engine::batch::{
    egress::{Auth, Egress, EgressError, Origin, Policy, Refusal, Request, Target},
    secret::Secret,
    wire::{Method, UreqWire, WireError},
};
use rcgen::{BasicConstraints, CertificateParams, DnType, IsCa, KeyPair};
use rustls::{
    ServerConfig, ServerConnection, StreamOwned,
    pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer},
};

const NAME: &str = "api.test.example";
const OTHER: &str = "other.test.example";
const TOKEN: &str = "synthetic-tls-token-0001";
const DIGEST: &str = "sha256:0000000000000000000000000000000000000000000000000000000000000001";

/// A test authority and a server certificate that it signed for `names`.
struct Tls {
    root_der: Vec<u8>,
    chain: Vec<CertificateDer<'static>>,
    key: Vec<u8>,
}

fn issue(names: &[&str]) -> Tls {
    let ca_key = KeyPair::generate().unwrap();
    let mut ca_params = CertificateParams::new(Vec::<String>::new()).unwrap();
    ca_params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
    ca_params
        .distinguished_name
        .push(DnType::CommonName, "OpenQuant test authority");
    let ca = ca_params.self_signed(&ca_key).unwrap();
    let leaf_key = KeyPair::generate().unwrap();
    let leaf_params =
        CertificateParams::new(names.iter().map(|n| (*n).to_owned()).collect::<Vec<_>>()).unwrap();
    let issuer = rcgen::Issuer::new(ca_params, ca_key);
    let leaf = leaf_params.signed_by(&leaf_key, &issuer).unwrap();
    Tls {
        root_der: ca.der().to_vec(),
        chain: vec![CertificateDer::from(leaf.der().to_vec())],
        key: leaf_key.serialize_der(),
    }
}

/// What the server does with one connection.
#[derive(Clone)]
enum Script {
    Respond {
        status: u16,
        headers: Vec<(String, String)>,
        body: Vec<u8>,
    },
    /// Read the request, then say nothing for this long.
    Stall(Duration),
}

fn respond(status: u16, body: &[u8]) -> Script {
    Script::Respond {
        status,
        headers: Vec::new(),
        body: body.to_vec(),
    }
}

/// A request as the server read it.
#[derive(Clone, Debug)]
struct Received {
    request_line: String,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

impl Received {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(n, _)| n.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }
}

struct Server {
    address: SocketAddr,
    hits: Arc<AtomicUsize>,
    received: Arc<Mutex<Vec<Received>>>,
    stop: Arc<AtomicBool>,
    handle: Option<JoinHandle<()>>,
}

impl Drop for Server {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }
}

fn read_request(stream: &mut StreamOwned<ServerConnection, TcpStream>) -> Option<Received> {
    let mut buffer = Vec::new();
    let mut byte = [0_u8; 1];
    while !buffer.ends_with(b"\r\n\r\n") {
        if stream.read(&mut byte).ok()? == 0 {
            return None;
        }
        buffer.push(byte[0]);
    }
    let text = String::from_utf8(buffer).ok()?;
    let mut lines = text.split("\r\n");
    let request_line = lines.next()?.to_owned();
    let headers: Vec<(String, String)> = lines
        .filter(|line| !line.is_empty())
        .filter_map(|line| {
            line.split_once(": ")
                .map(|(n, v)| (n.to_owned(), v.to_owned()))
        })
        .collect();
    let length = headers
        .iter()
        .find(|(n, _)| n.eq_ignore_ascii_case("content-length"))
        .and_then(|(_, v)| v.parse::<usize>().ok())
        .unwrap_or(0);
    let mut body = vec![0_u8; length];
    stream.read_exact(&mut body).ok()?;
    Some(Received {
        request_line,
        headers,
        body,
    })
}

fn serve(tls: &Tls, script: Vec<Script>) -> Server {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let config = ServerConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .unwrap()
        .with_no_client_auth()
        .with_single_cert(
            tls.chain.clone(),
            PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(tls.key.clone())),
        )
        .unwrap();
    let config = Arc::new(config);
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let address = listener.local_addr().unwrap();
    let hits = Arc::new(AtomicUsize::new(0));
    let received = Arc::new(Mutex::new(Vec::new()));
    let stop = Arc::new(AtomicBool::new(false));
    let handle = {
        let (hits, received, stop) = (hits.clone(), received.clone(), stop.clone());
        thread::spawn(move || {
            let mut script: std::collections::VecDeque<Script> = script.into();
            while !stop.load(Ordering::SeqCst) {
                let Ok((tcp, _)) = listener.accept() else {
                    thread::sleep(Duration::from_millis(5));
                    continue;
                };
                tcp.set_nonblocking(false).unwrap();
                tcp.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
                let Ok(connection) = ServerConnection::new(config.clone()) else {
                    continue;
                };
                let mut stream = StreamOwned::new(connection, tcp);
                let Some(request) = read_request(&mut stream) else {
                    continue; // a failed handshake: the client refused the certificate
                };
                hits.fetch_add(1, Ordering::SeqCst);
                received.lock().unwrap().push(request);
                match script.pop_front() {
                    Some(Script::Respond {
                        status,
                        headers,
                        body,
                    }) => {
                        let mut head = format!(
                            "HTTP/1.1 {status} X\r\ncontent-length: {}\r\nconnection: close\r\n",
                            body.len()
                        );
                        for (name, value) in headers {
                            head.push_str(&format!("{name}: {value}\r\n"));
                        }
                        head.push_str("\r\n");
                        let _ = stream.write_all(head.as_bytes());
                        let _ = stream.write_all(&body);
                        let _ = stream.flush();
                        stream.conn.send_close_notify();
                        let _ = stream.flush();
                    }
                    Some(Script::Stall(pause)) => thread::sleep(pause),
                    None => {}
                }
            }
        })
    };
    Server {
        address,
        hits,
        received,
        stop,
        handle: Some(handle),
    }
}

fn egress_for(tls: &Tls, servers: &[(&str, &Server)]) -> Egress {
    let resolve: Vec<(String, SocketAddr)> = servers
        .iter()
        .map(|(name, server)| ((*name).to_owned(), server.address))
        .collect();
    let wire = UreqWire::for_loopback_test(std::slice::from_ref(&tls.root_der), &resolve);
    let origin = Origin::parse(&format!("https://{NAME}")).unwrap();
    let policy = Policy::batch(&origin, "acct0123", "queue0123").unwrap();
    Egress::new(Arc::new(policy), Arc::new(wire))
}

fn input_path() -> String {
    format!("/v1/attempts/att-1/inputs/{DIGEST}")
}

const NO_QUERY: [(String, String); 0] = [];

fn get_input<'a>(path: &'a str, token: &'a Secret, timeout: Duration, limit: u64) -> Request<'a> {
    Request {
        target: Target {
            method: Method::Get,
            host: NAME,
            path,
            query: &NO_QUERY,
        },
        auth: Auth::Bearer(token),
        content_type: None,
        body: &[],
        timeout,
        max_response_bytes: limit,
    }
}

#[test]
fn a_get_over_tls_carries_the_credential_and_returns_the_body() {
    let tls = issue(&[NAME]);
    let server = serve(&tls, vec![respond(200, b"{\"ok\":true}")]);
    let egress = egress_for(&tls, &[(NAME, &server)]);
    let token = Secret::new(TOKEN);
    let path = input_path();
    let response = egress
        .send(&get_input(&path, &token, Duration::from_secs(5), 1024))
        .unwrap();
    assert_eq!(response.status, 200);
    assert_eq!(response.body, b"{\"ok\":true}");
    let seen = server.received.lock().unwrap().clone();
    assert_eq!(seen.len(), 1);
    assert_eq!(seen[0].request_line, format!("GET {path} HTTP/1.1"));
    assert_eq!(
        seen[0].header("authorization"),
        Some(&format!("Bearer {TOKEN}")[..])
    );
    assert_eq!(seen[0].header("host"), Some(NAME));
    assert!(
        seen[0]
            .header("user-agent")
            .unwrap()
            .starts_with("engine-batch/")
    );
    assert!(seen[0].header("cookie").is_none());
}

#[test]
fn a_post_body_arrives_whole_with_its_media_type() {
    let tls = issue(&[NAME]);
    let server = serve(&tls, vec![respond(204, b"")]);
    let egress = egress_for(&tls, &[(NAME, &server)]);
    let token = Secret::new(TOKEN);
    let body: Vec<u8> = (0..5000_u32)
        .map(|n| u8::try_from(n % 251).unwrap())
        .collect();
    let path = "/v1/attempts/att-1/evaluation-submission";
    let request = Request {
        target: Target {
            method: Method::Post,
            host: NAME,
            path,
            query: &NO_QUERY,
        },
        auth: Auth::Bearer(&token),
        content_type: Some("application/json"),
        body: &body,
        timeout: Duration::from_secs(5),
        max_response_bytes: 1024,
    };
    let response = egress.send(&request).unwrap();
    assert_eq!(response.status, 204);
    let seen = server.received.lock().unwrap().clone();
    assert_eq!(seen[0].request_line, format!("POST {path} HTTP/1.1"));
    assert_eq!(seen[0].header("content-type"), Some("application/json"));
    assert_eq!(seen[0].body, body);
}

#[test]
fn a_redirect_is_not_followed_to_another_host_or_to_the_same_one() {
    let tls = issue(&[NAME, OTHER]);
    let first = serve(
        &tls,
        vec![
            Script::Respond {
                status: 302,
                headers: vec![("location".to_owned(), format!("https://{OTHER}/steal"))],
                body: Vec::new(),
            },
            Script::Respond {
                status: 307,
                headers: vec![(
                    "location".to_owned(),
                    format!("https://{NAME}{}", input_path()),
                )],
                body: Vec::new(),
            },
        ],
    );
    let other = serve(&tls, vec![respond(200, b"{}")]);
    let egress = egress_for(&tls, &[(NAME, &first), (OTHER, &other)]);
    let token = Secret::new(TOKEN);
    let path = input_path();
    let to_other = egress
        .send(&get_input(&path, &token, Duration::from_secs(5), 1024))
        .unwrap_err();
    assert_eq!(
        to_other,
        EgressError::Refused(Refusal::Redirect {
            status: 302,
            to_host: Some(OTHER.to_owned())
        })
    );
    let to_same = egress
        .send(&get_input(&path, &token, Duration::from_secs(5), 1024))
        .unwrap_err();
    assert_eq!(
        to_same,
        EgressError::Refused(Refusal::Redirect {
            status: 307,
            to_host: Some(NAME.to_owned())
        })
    );
    assert_eq!(
        first.hits.load(Ordering::SeqCst),
        2,
        "one request per exchange: nothing was followed"
    );
    assert_eq!(
        other.hits.load(Ordering::SeqCst),
        0,
        "the redirect target was never contacted"
    );
}

#[test]
fn a_response_body_above_the_limit_is_refused() {
    let tls = issue(&[NAME]);
    let server = serve(&tls, vec![respond(200, &vec![b'x'; 5000])]);
    let egress = egress_for(&tls, &[(NAME, &server)]);
    let token = Secret::new(TOKEN);
    let path = input_path();
    let error = egress
        .send(&get_input(&path, &token, Duration::from_secs(5), 1000))
        .unwrap_err();
    assert_eq!(error, EgressError::Wire(WireError::BodyTooLarge));
}

#[test]
fn a_server_that_stalls_ends_in_a_timeout() {
    let tls = issue(&[NAME]);
    let server = serve(&tls, vec![Script::Stall(Duration::from_secs(3))]);
    let egress = egress_for(&tls, &[(NAME, &server)]);
    let token = Secret::new(TOKEN);
    let path = input_path();
    let started = std::time::Instant::now();
    let error = egress
        .send(&get_input(&path, &token, Duration::from_millis(400), 1024))
        .unwrap_err();
    assert_eq!(error, EgressError::Wire(WireError::Timeout));
    assert!(
        started.elapsed() < Duration::from_secs(2),
        "the timeout bounds the exchange"
    );
}

#[test]
fn a_certificate_from_an_authority_that_is_not_trusted_is_refused() {
    let server_tls = issue(&[NAME]);
    let other_tls = issue(&[NAME]);
    let server = serve(&server_tls, vec![respond(200, b"{}")]);
    // The client trusts only the other authority.
    let egress = egress_for(&other_tls, &[(NAME, &server)]);
    let token = Secret::new(TOKEN);
    let path = input_path();
    let error = egress
        .send(&get_input(&path, &token, Duration::from_secs(5), 1024))
        .unwrap_err();
    assert_eq!(error, EgressError::Wire(WireError::Connection));
    assert_eq!(
        server.hits.load(Ordering::SeqCst),
        0,
        "no request was sent over the refused connection"
    );
}

#[test]
fn a_certificate_for_another_name_is_refused() {
    let tls = issue(&[OTHER]);
    let server = serve(&tls, vec![respond(200, b"{}")]);
    let egress = egress_for(&tls, &[(NAME, &server)]);
    let token = Secret::new(TOKEN);
    let path = input_path();
    let error = egress
        .send(&get_input(&path, &token, Duration::from_secs(5), 1024))
        .unwrap_err();
    assert_eq!(error, EgressError::Wire(WireError::Connection));
    assert_eq!(server.hits.load(Ordering::SeqCst), 0);
}

#[test]
fn the_exchange_does_not_go_through_a_proxy_named_in_the_environment() {
    // The sandbox that runs the tests may export HTTPS_PROXY. A wire that read it would send this
    // loopback exchange to the proxy and fail. The wire sets no proxy at all.
    let tls = issue(&[NAME]);
    let server = serve(&tls, vec![respond(200, b"{}")]);
    let egress = egress_for(&tls, &[(NAME, &server)]);
    let token = Secret::new(TOKEN);
    let path = input_path();
    assert_eq!(
        egress
            .send(&get_input(&path, &token, Duration::from_secs(5), 1024))
            .unwrap()
            .status,
        200
    );
    assert_eq!(server.hits.load(Ordering::SeqCst), 1);
}

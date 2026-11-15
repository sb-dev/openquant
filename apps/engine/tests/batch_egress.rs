//! The egress module (OQ-05 section 5, decision D16): an allowlist of exact host, method and path,
//! HTTPS only, no redirect followed, a request budget and no credential in a log.
//!
//! The module under test is the production `Egress` over a recording wire. The tests that need a
//! real TLS exchange are in `batch_wire_tls.rs`.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

mod batch_support;

use std::{
    collections::{BTreeSet, VecDeque},
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};

use batch_support::data::{read_json, repo};
use openquant_engine::{
    batch::{
        egress::{Auth, Class, Egress, EgressError, Origin, Policy, Refusal, Request, Target},
        secret::Secret,
        wire::{Method, Wire, WireError, WireRequest, WireResponse},
    },
    market::http::{
        Credentials, Host, HttpRequest, HttpTransport, TransportError, TransportLimits,
    },
};

/// What the recording wire saw of one request.
#[derive(Clone, Debug)]
struct Wired {
    method: Method,
    host: String,
    path: String,
    query: Vec<(String, String)>,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
    max_response_bytes: u64,
}

struct RecordingWire {
    seen: Mutex<Vec<Wired>>,
    replies: Mutex<VecDeque<Result<WireResponse, WireError>>>,
}

impl RecordingWire {
    fn new(replies: Vec<Result<WireResponse, WireError>>) -> Arc<Self> {
        Arc::new(Self {
            seen: Mutex::new(Vec::new()),
            replies: Mutex::new(replies.into()),
        })
    }

    fn seen(&self) -> Vec<Wired> {
        self.seen.lock().unwrap().clone()
    }
}

impl Wire for RecordingWire {
    fn send(&self, request: &WireRequest<'_>) -> Result<WireResponse, WireError> {
        self.seen.lock().unwrap().push(Wired {
            method: request.method,
            host: request.host.to_owned(),
            path: request.path.to_owned(),
            query: request.query.to_vec(),
            headers: request
                .headers
                .iter()
                .map(|(n, v)| ((*n).to_owned(), v.expose().to_owned()))
                .collect(),
            body: request.body.to_vec(),
            max_response_bytes: request.max_response_bytes,
        });
        self.replies
            .lock()
            .unwrap()
            .pop_front()
            .unwrap_or_else(|| Ok(ok(b"{}")))
    }
}

fn ok(body: &[u8]) -> WireResponse {
    WireResponse {
        status: 200,
        headers: Vec::new(),
        body: body.to_vec(),
    }
}

fn redirect(status: u16, location: &str) -> WireResponse {
    WireResponse {
        status,
        headers: vec![("location".to_owned(), location.to_owned())],
        body: Vec::new(),
    }
}

fn policy() -> Arc<Policy> {
    let origin = Origin::parse("https://api.openquant.example").unwrap();
    Arc::new(Policy::batch(&origin, "acct0123", "queue0123").unwrap())
}

const TOKEN: &str = "synthetic-egress-token-0001";
const NO_QUERY: [(String, String); 0] = [];

fn get<'a>(host: &'a str, path: &'a str, auth: Auth<'a>) -> Request<'a> {
    Request {
        target: Target {
            method: Method::Get,
            host,
            path,
            query: &NO_QUERY,
        },
        auth,
        content_type: None,
        body: &[],
        timeout: Duration::from_secs(5),
        max_response_bytes: 1024,
    }
}

const DIGEST: &str = "sha256:0000000000000000000000000000000000000000000000000000000000000001";

fn input_path() -> String {
    format!("/v1/attempts/att-1/inputs/{DIGEST}")
}

#[test]
fn a_request_to_a_host_off_the_allowlist_never_reaches_the_wire() {
    let wire = RecordingWire::new(vec![]);
    let egress = Egress::new(policy(), wire.clone());
    let token = Secret::new(TOKEN);
    for host in [
        "evil.example",
        "api.openquant.example.evil.example",
        "API.OPENQUANT.EXAMPLE",
        "api.openquant.example.",
        "api.openquant.example:443",
        "api.alpaca.markets", // the live trading host is outside the batch allowlist
        "127.0.0.1",
        "localhost",
    ] {
        let error = egress
            .send(&get(host, &input_path(), Auth::Bearer(&token)))
            .unwrap_err();
        assert_eq!(error, EgressError::Refused(Refusal::Host), "{host}");
    }
    assert!(wire.seen().is_empty(), "nothing reached the wire");
    assert_eq!(
        egress.requests(Class::Api),
        0,
        "a refused request is not billed"
    );
    assert_eq!(egress.refusals().len(), 8);
}

#[test]
fn only_the_listed_method_and_path_of_an_allowed_host_pass() {
    let wire = RecordingWire::new(vec![]);
    let egress = Egress::new(policy(), wire.clone());
    let token = Secret::new(TOKEN);
    let host = "api.openquant.example";
    // A write to an input, a read of a result route, the live account of the paper host and an
    // order endpoint: none is on the list.
    let input = input_path();
    let attempts: Vec<(Method, &str, &str, Refusal)> = vec![
        (Method::Put, host, input.as_str(), Refusal::Path),
        (
            Method::Get,
            host,
            "/v1/attempts/att-1/gate-report",
            Refusal::Path,
        ),
        (Method::Get, host, "/v1/missions/m-1", Refusal::Path),
        (
            Method::Get,
            host,
            "/v1/attempts/att-1/inputs/not-a-digest",
            Refusal::Path,
        ),
        (
            Method::Get,
            host,
            "/v1/attempts/../inputs/sha256:00",
            Refusal::Path,
        ),
        (
            Method::Get,
            "paper-api.alpaca.markets",
            "/v2/account",
            Refusal::Path,
        ),
        (
            Method::Get,
            "paper-api.alpaca.markets",
            "/v2/orders",
            Refusal::Path,
        ),
        (
            Method::Post,
            "paper-api.alpaca.markets",
            "/v2/calendar",
            Refusal::Method,
        ),
        (
            Method::Get,
            "data.alpaca.markets",
            "/v2/stocks/AAPL/trades",
            Refusal::Path,
        ),
        (
            Method::Get,
            "api.cloudflare.com",
            "/client/v4/accounts/acct0123/queues/queue0123/messages/pull",
            Refusal::Method,
        ),
        (
            Method::Post,
            "api.cloudflare.com",
            "/client/v4/accounts/other/queues/queue0123/messages/pull",
            Refusal::Path,
        ),
        (
            Method::Post,
            "api.cloudflare.com",
            "/client/v4/accounts/acct0123/queues/queue0123",
            Refusal::Path,
        ),
    ];
    for (method, host, path, expected) in attempts {
        let request = Request {
            target: Target {
                method,
                host,
                path,
                query: &NO_QUERY,
            },
            ..get(host, path, Auth::Bearer(&token))
        };
        assert_eq!(
            egress.send(&request).unwrap_err(),
            EgressError::Refused(expected),
            "{method:?} {host}{path}"
        );
    }
    assert!(wire.seen().is_empty());
}

#[test]
fn a_query_key_that_the_rule_does_not_list_is_refused_and_only_the_key_is_logged() {
    let wire = RecordingWire::new(vec![]);
    let egress = Egress::new(policy(), wire.clone());
    let creds = Credentials::new("synthetic-key-id", "synthetic-secret");
    let query = vec![
        ("symbols".to_owned(), "AAPL".to_owned()),
        ("api_key".to_owned(), "leak-me".to_owned()),
    ];
    let request = Request {
        target: Target {
            method: Method::Get,
            host: "data.alpaca.markets",
            path: "/v1/corporate-actions",
            query: &query,
        },
        ..get(
            "data.alpaca.markets",
            "/v1/corporate-actions",
            Auth::AlpacaKeys(&creds),
        )
    };
    let error = egress.send(&request).unwrap_err();
    assert_eq!(
        error,
        EgressError::Refused(Refusal::Query {
            key: "api_key".to_owned()
        })
    );
    let text = format!("{:?} {error} {:?}", egress.log(), egress.refusals());
    assert!(
        !text.contains("leak-me") && !text.contains("synthetic-secret"),
        "{text}"
    );
    assert!(wire.seen().is_empty());
}

#[test]
fn a_body_above_the_limit_of_the_rule_is_refused_before_the_wire() {
    let wire = RecordingWire::new(vec![]);
    let egress = Egress::new(policy(), wire.clone());
    let token = Secret::new(TOKEN);
    let body = vec![0_u8; 4 * 1024 * 1024 + 1];
    let path = "/v1/attempts/att-1/claim";
    let request = Request {
        target: Target {
            method: Method::Post,
            host: "api.openquant.example",
            path,
            query: &NO_QUERY,
        },
        body: &body,
        content_type: Some("application/json"),
        ..get("api.openquant.example", path, Auth::Bearer(&token))
    };
    assert_eq!(
        egress.send(&request).unwrap_err(),
        EgressError::Refused(Refusal::RequestTooLarge {
            limit_bytes: 4 * 1024 * 1024
        })
    );
    assert!(wire.seen().is_empty());
}

#[test]
fn a_redirect_is_refused_and_never_followed() {
    for (status, location, host) in [
        (
            301,
            "https://evil.example/steal?token=abc",
            Some("evil.example"),
        ),
        (
            302,
            "https://user:pw@Other.Example:8443/x",
            Some("other.example"),
        ),
        (307, "http://downgrade.example/x", Some("downgrade.example")),
        (308, "/v1/attempts/att-1/inputs/elsewhere", None),
        (
            303,
            "https://api.openquant.example/v1/attempts/att-1/claim",
            Some("api.openquant.example"),
        ),
    ] {
        let wire = RecordingWire::new(vec![Ok(redirect(status, location))]);
        let egress = Egress::new(policy(), wire.clone());
        let token = Secret::new(TOKEN);
        let error = egress
            .send(&get(
                "api.openquant.example",
                &input_path(),
                Auth::Bearer(&token),
            ))
            .unwrap_err();
        assert_eq!(
            error,
            EgressError::Refused(Refusal::Redirect {
                status,
                to_host: host.map(str::to_owned)
            }),
            "{location}"
        );
        assert_eq!(
            wire.seen().len(),
            1,
            "the redirect target is never requested: {location}"
        );
        // Only the host name of the target is recorded: no path, query or credential.
        let text = format!("{:?}", egress.log());
        assert!(
            !text.contains("steal") && !text.contains("token=abc") && !text.contains("pw@"),
            "{text}"
        );
        assert_eq!(egress.requests(Class::Api), 1, "the exchange was billed");
    }
}

#[test]
fn the_provider_sees_a_refused_redirect_as_a_bare_status_without_its_target() {
    let wire = RecordingWire::new(vec![Ok(redirect(
        302,
        "https://data.evil.example/v2/stocks/AAPL/bars",
    ))]);
    let egress = Egress::new(policy(), wire.clone());
    let creds = Credentials::new("synthetic-key-id", "synthetic-secret");
    let request = HttpRequest {
        host: Host::Data,
        path: "/v2/stocks/AAPL/bars".to_owned(),
        query: vec![],
    };
    let limits = TransportLimits {
        timeout: Duration::from_secs(3),
        max_response_bytes: 1000,
    };
    let answer = egress.get(&request, &creds, limits).unwrap();
    assert_eq!(
        answer.status, 302,
        "the adapter records the status and classifies the redirect"
    );
    assert!(
        answer.headers.is_empty() && answer.body.is_empty(),
        "the target is not passed on"
    );
    assert_eq!(wire.seen().len(), 1);
    assert_eq!(egress.requests(Class::Provider), 1);
    assert_eq!(
        egress.refusals(),
        vec![Refusal::Redirect {
            status: 302,
            to_host: Some("data.evil.example".to_owned())
        }]
    );
    // A request outside the policy is a refusal the adapter cannot get around.
    let live = HttpRequest {
        host: Host::Data,
        path: "/v2/orders".to_owned(),
        query: vec![],
    };
    assert_eq!(
        egress.get(&live, &creds, limits).unwrap_err(),
        TransportError::EgressRefused
    );
    assert_eq!(wire.seen().len(), 1);
}

#[test]
fn the_budget_counts_every_request_of_a_class_and_refuses_the_next() {
    let wire = RecordingWire::new(vec![]);
    let egress = Egress::new(policy(), wire.clone()).with_limit(Class::Api, 2);
    let token = Secret::new(TOKEN);
    let path = input_path();
    let request = get("api.openquant.example", &path, Auth::Bearer(&token));
    egress.send(&request).unwrap();
    egress.send(&request).unwrap();
    assert_eq!(
        egress.send(&request).unwrap_err(),
        EgressError::Refused(Refusal::Budget {
            class: Class::Api,
            limit: 2
        })
    );
    assert_eq!(
        wire.seen().len(),
        2,
        "the third request did not reach the wire"
    );
    assert_eq!(egress.requests(Class::Api), 2);
    // Another class has its own budget.
    let creds = Credentials::new("synthetic-key-id", "synthetic-secret");
    let calendar = HttpRequest {
        host: Host::Paper,
        path: "/v2/calendar".to_owned(),
        query: vec![],
    };
    let limits = TransportLimits {
        timeout: Duration::from_secs(3),
        max_response_bytes: 1000,
    };
    egress.get(&calendar, &creds, limits).unwrap();
    assert_eq!(egress.requests(Class::Provider), 1);
    egress.set_limit(Class::Provider, 1);
    assert_eq!(
        egress.get(&calendar, &creds, limits).unwrap_err(),
        TransportError::EgressRefused
    );
    assert_eq!(egress.requests(Class::Provider), 1);
}

#[test]
fn a_failed_request_is_billed_and_a_wire_failure_is_reported_as_it_is() {
    let wire = RecordingWire::new(vec![Err(WireError::Timeout), Err(WireError::Connection)]);
    let egress = Egress::new(policy(), wire);
    let token = Secret::new(TOKEN);
    let path = input_path();
    let request = get("api.openquant.example", &path, Auth::Bearer(&token));
    assert_eq!(
        egress.send(&request).unwrap_err(),
        EgressError::Wire(WireError::Timeout)
    );
    assert_eq!(
        egress.send(&request).unwrap_err(),
        EgressError::Wire(WireError::Connection)
    );
    assert_eq!(egress.requests(Class::Api), 2);
}

#[test]
fn credentials_reach_the_wire_and_never_a_log() {
    let wire = RecordingWire::new(vec![]);
    let egress = Egress::new(policy(), wire.clone());
    let token = Secret::new(TOKEN);
    egress
        .send(&get(
            "api.openquant.example",
            &input_path(),
            Auth::Bearer(&token),
        ))
        .unwrap();
    let creds = Credentials::new("synthetic-key-id-5a", "synthetic-secret-77");
    let request = HttpRequest {
        host: Host::Data,
        path: "/v2/stocks/AAPL/bars".to_owned(),
        query: vec![("feed".to_owned(), "sip".to_owned())],
    };
    let limits = TransportLimits {
        timeout: Duration::from_secs(3),
        max_response_bytes: 1000,
    };
    egress.get(&request, &creds, limits).unwrap();

    let seen = wire.seen();
    let header = |wired: &Wired, name: &str| {
        wired
            .headers
            .iter()
            .find(|(n, _)| n == name)
            .map(|(_, v)| v.clone())
    };
    assert_eq!(
        header(&seen[0], "authorization").as_deref(),
        Some(&format!("Bearer {TOKEN}")[..])
    );
    assert_eq!(
        header(&seen[1], "apca-api-key-id").as_deref(),
        Some("synthetic-key-id-5a")
    );
    assert_eq!(
        header(&seen[1], "apca-api-secret-key").as_deref(),
        Some("synthetic-secret-77")
    );
    assert!(
        header(&seen[1], "authorization").is_none(),
        "the provider gets no bearer token"
    );
    assert_eq!(seen[1].host, "data.alpaca.markets");
    assert_eq!(seen[1].path, "/v2/stocks/AAPL/bars");
    assert_eq!(seen[1].query, vec![("feed".to_owned(), "sip".to_owned())]);
    // The response limit is the smaller of the call's and the rule's.
    assert_eq!(seen[0].max_response_bytes, 1024);
    assert_eq!(seen[1].max_response_bytes, 1000);
    assert_eq!(seen[0].method, Method::Get);
    assert!(seen[0].body.is_empty());

    let text = format!(
        "{:?} {:?} {egress:?} {token:?} {creds:?} {:?}",
        egress.log(),
        egress.refusals(),
        Auth::Bearer(&token)
    );
    for secret in [TOKEN, "synthetic-key-id-5a", "synthetic-secret-77"] {
        assert!(!text.contains(secret), "{secret} is in {text}");
    }
}

/// The routes of the manifest that a batch credential or an attempt capability of the batch
/// principal may call, as (id, method, path template).
fn batch_routes() -> BTreeSet<(String, String, String)> {
    let manifest = read_json(&repo().join("packages/api-contracts/routes/v1.json"));
    manifest["routes"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|route| {
            route["auth"].as_array().unwrap().iter().any(|entry| {
                matches!(entry["kind"].as_str(), Some("service" | "attempt"))
                    && entry["principals"]
                        .as_array()
                        .is_some_and(|p| p.iter().any(|v| v == "batch"))
            })
        })
        .map(|route| {
            (
                route["id"].as_str().unwrap().to_owned(),
                route["method"].as_str().unwrap().to_owned(),
                route["path"].as_str().unwrap().to_owned(),
            )
        })
        .collect()
}

#[test]
fn the_api_rules_are_exactly_the_batch_routes_of_the_route_manifest() {
    let policy = policy();
    let ruled: BTreeSet<(String, String, String)> = policy
        .rules()
        .iter()
        .filter(|rule| rule.class == Class::Api)
        .map(|rule| {
            (
                rule.id.clone(),
                rule.method.as_str().to_owned(),
                rule.template(),
            )
        })
        .collect();
    let manifest = batch_routes();
    assert_eq!(
        ruled, manifest,
        "a route cannot appear or disappear unreviewed"
    );
    assert_eq!(manifest.len(), 7);
    for rule in policy.rules().iter().filter(|r| r.class == Class::Api) {
        assert_eq!(rule.host, "api.openquant.example");
    }
}

#[test]
fn the_other_rules_are_the_provider_reads_and_the_queue_paths_of_the_specification() {
    let policy = policy();
    let mut listed: Vec<(String, String, String)> = policy
        .rules()
        .iter()
        .filter(|rule| rule.class != Class::Api)
        .map(|rule| {
            (
                rule.host.clone(),
                rule.method.as_str().to_owned(),
                rule.template(),
            )
        })
        .collect();
    listed.sort();
    let mut expected = vec![
        ("data.alpaca.markets", "GET", "/v1/corporate-actions"),
        ("data.alpaca.markets", "GET", "/v2/stocks/{symbol}/bars"),
        ("paper-api.alpaca.markets", "GET", "/v2/assets/{symbol}"),
        ("paper-api.alpaca.markets", "GET", "/v2/calendar"),
        (
            "api.cloudflare.com",
            "POST",
            "/client/v4/accounts/acct0123/queues/queue0123/messages/ack",
        ),
        (
            "api.cloudflare.com",
            "POST",
            "/client/v4/accounts/acct0123/queues/queue0123/messages/pull",
        ),
    ]
    .into_iter()
    .map(|(h, m, p)| (h.to_owned(), m.to_owned(), p.to_owned()))
    .collect::<Vec<_>>();
    expected.sort();
    assert_eq!(listed, expected);
    // The class of each rule: the provider reads count against the provider budget.
    for rule in policy.rules() {
        let expected = match rule.host.as_str() {
            "api.cloudflare.com" => Class::Queue,
            "api.openquant.example" => Class::Api,
            _ => Class::Provider,
        };
        assert_eq!(rule.class, expected, "{}", rule.id);
    }
}

#[test]
fn https_is_not_a_setting_and_every_other_scheme_is_refused_in_configuration() {
    for bad in [
        "http://api.openquant.example",
        "ftp://api.openquant.example",
        "api.openquant.example",
        "//api.openquant.example",
        "https://api.openquant.example:8443",
        "https://api.openquant.example/v1",
        "https://127.0.0.1",
        "https://[::1]",
    ] {
        assert!(Origin::parse(bad).is_err(), "{bad}");
    }
    assert!(Origin::parse("https://api.openquant.example").is_ok());
}

fn rust_files(dir: &Path, out: &mut Vec<PathBuf>) {
    for entry in fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            rust_files(&path, out);
        } else if path.extension().is_some_and(|e| e == "rs") {
            out.push(path);
        }
    }
}

#[test]
fn the_wire_is_the_only_code_that_opens_a_connection() {
    let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut files = Vec::new();
    rust_files(&src, &mut files);
    assert!(files.len() > 20);
    let forbidden = [
        "ureq",
        "reqwest",
        "hyper",
        "isahc",
        "attohttpc",
        "minreq",
        "TcpStream",
        "TcpListener",
        "UdpSocket",
        "ToSocketAddrs",
        "curl",
    ];
    for file in files {
        let text = fs::read_to_string(&file).unwrap();
        let relative = file
            .strip_prefix(&src)
            .unwrap()
            .to_string_lossy()
            .replace('\\', "/");
        if relative == "batch/wire.rs" {
            continue;
        }
        for word in forbidden {
            // The egress module's own documentation names the client; code never does.
            let code: String = text
                .lines()
                .filter(|line| !line.trim_start().starts_with("//"))
                .collect::<Vec<_>>()
                .join("\n");
            assert!(
                !code.contains(word),
                "{relative} uses {word}: only batch/wire.rs may"
            );
        }
    }
    // One HTTP client crate in the manifest, and no async runtime.
    let manifest =
        fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("Cargo.toml")).unwrap();
    let dependencies = manifest.split("[dev-dependencies]").next().unwrap();
    assert!(dependencies.contains("ureq"));
    for crate_name in [
        "reqwest",
        "hyper",
        "isahc",
        "attohttpc",
        "minreq",
        "surf",
        "tokio",
        "async-std",
        "curl",
    ] {
        assert!(!dependencies.contains(crate_name), "{crate_name}");
    }
}

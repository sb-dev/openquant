//! The wire: one HTTPS exchange, with no policy.
//!
//! [`UreqWire`] is the only code in the binary that opens a connection (OQ-05 section 5). The
//! egress module in front of it decides what may be sent, so nothing here knows a host list.
//! The wire is HTTPS only, follows no redirect (a 3xx is returned as a response), never reads a
//! proxy variable, reads a body only up to the limit it is given and puts a hard bound on the
//! whole exchange.

use std::{fmt, net::SocketAddr, sync::Arc, time::Duration};

use ureq::{
    Agent,
    config::Config,
    tls::{Certificate, RootCerts, TlsConfig},
    unversioned::{
        resolver::{DefaultResolver, ResolvedSocketAddrs, Resolver},
        transport::{DefaultConnector, NextTimeout},
    },
};

use super::secret::Secret;

/// An HTTP method of the allowlist.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Method {
    Get,
    Post,
    Put,
}

impl Method {
    /// The method name.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Get => "GET",
            Self::Post => "POST",
            Self::Put => "PUT",
        }
    }
}

/// A request as the wire sends it. The host and path are those the egress policy allowed.
pub struct WireRequest<'a> {
    pub method: Method,
    pub host: &'a str,
    pub path: &'a str,
    pub query: &'a [(String, String)],
    /// Every header value is a [`Secret`] so that a printed request shows no value.
    pub headers: Vec<(&'static str, Secret)>,
    pub body: &'a [u8],
    /// The bound of the whole exchange: connection, request and response.
    pub timeout: Duration,
    /// The wire stops reading a response body above this many bytes.
    pub max_response_bytes: u64,
}

impl fmt::Debug for WireRequest<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("WireRequest")
            .field("method", &self.method)
            .field("host", &self.host)
            .field("path", &self.path)
            .field(
                "query_keys",
                &self
                    .query
                    .iter()
                    .map(|(k, _)| k.as_str())
                    .collect::<Vec<_>>(),
            )
            .field("body_bytes", &self.body.len())
            .finish_non_exhaustive()
    }
}

/// A response. A redirect is returned as it is, never followed.
#[derive(Clone, PartialEq, Eq)]
pub struct WireResponse {
    pub status: u16,
    /// Header names in lower case.
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl fmt::Debug for WireResponse {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("WireResponse")
            .field("status", &self.status)
            .field("body_bytes", &self.body.len())
            .finish_non_exhaustive()
    }
}

/// Why an exchange produced no response.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WireError {
    /// The exchange did not finish within its timeout.
    Timeout,
    /// The connection, the TLS handshake or the HTTP exchange failed.
    Connection,
    /// The response body is larger than the limit.
    BodyTooLarge,
}

impl fmt::Display for WireError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Timeout => "the exchange timed out",
            Self::Connection => "the connection failed",
            Self::BodyTooLarge => "the response body is above the limit",
        })
    }
}

impl std::error::Error for WireError {}

/// One HTTPS exchange.
pub trait Wire: Send + Sync {
    /// Send `request` and return the response, a redirect included.
    ///
    /// # Errors
    /// [`WireError`] when no response was received.
    fn send(&self, request: &WireRequest<'_>) -> Result<WireResponse, WireError>;
}

/// Characters that stay as they are in a query component: RFC 3986 unreserved characters.
fn is_unreserved(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~')
}

fn encode_component(text: &str, out: &mut String) {
    for byte in text.bytes() {
        if is_unreserved(byte) {
            out.push(char::from(byte));
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
}

/// `https://<host><path>?<query>`. The scheme is fixed: no caller can ask for another one.
#[must_use]
pub fn https_url(host: &str, path: &str, query: &[(String, String)]) -> String {
    let mut url = format!("https://{host}{path}");
    for (index, (key, value)) in query.iter().enumerate() {
        url.push(if index == 0 { '?' } else { '&' });
        encode_component(key, &mut url);
        url.push('=');
        encode_component(value, &mut url);
    }
    url
}

fn wire_error(error: &ureq::Error) -> WireError {
    match error {
        ureq::Error::Timeout(_) => WireError::Timeout,
        ureq::Error::BodyExceedsLimit(_) => WireError::BodyTooLarge,
        _ => WireError::Connection,
    }
}

/// The real wire: ureq over rustls with the bundled web PKI roots.
#[derive(Clone)]
pub struct UreqWire {
    agent: Agent,
}

impl fmt::Debug for UreqWire {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("UreqWire")
    }
}

fn base_config() -> ureq::config::ConfigBuilder<ureq::typestate::AgentScope> {
    Config::builder()
        // A 3xx is a response, never a hop: the egress module refuses it.
        .max_redirects(0)
        .max_redirects_will_error(false)
        // A 4xx or 5xx is a response too: the caller reads the error body.
        .http_status_as_error(false)
        .https_only(true)
        // A deployed Machine must not route around the allowlist through an inherited proxy.
        .proxy(None)
        .user_agent(concat!("engine-batch/", env!("CARGO_PKG_VERSION")))
}

impl UreqWire {
    /// The production wire.
    #[must_use]
    pub fn new() -> Self {
        let config = base_config().build();
        Self {
            agent: Agent::new_with_config(config),
        }
    }

    /// A wire for a test that serves TLS on the loopback interface: it trusts only
    /// `trusted_roots` (DER certificates) and resolves each name of `resolve` to the given
    /// socket address. The egress policy above the wire is unchanged, so a name still has to be
    /// on the allowlist. The binary calls it only through [`UreqWire::for_loopback`], in the
    /// test-only loopback mode of a debug build (`config::LoopbackTest`).
    #[doc(hidden)]
    #[must_use]
    pub fn for_loopback_test(trusted_roots: &[Vec<u8>], resolve: &[(String, SocketAddr)]) -> Self {
        let roots: Vec<Certificate<'static>> = trusted_roots
            .iter()
            .map(|der| Certificate::from_der(der).to_owned())
            .collect();
        let tls = TlsConfig::builder()
            .root_certs(RootCerts::new_with_certs(&roots))
            .build();
        let config = base_config().tls_config(tls).build();
        let resolver = FixedResolver {
            map: resolve.to_vec(),
        };
        Self {
            agent: Agent::with_parts(config, DefaultConnector::default(), resolver),
        }
    }
}

impl UreqWire {
    /// The wire of the test-only loopback mode: each of `hosts` (the hosts of the egress
    /// allowlist) resolves to `127.0.0.1:port`, and only the certificate authority `root_der` is
    /// trusted. Nothing else of the wire changes: HTTPS only, no redirect, no proxy.
    #[must_use]
    pub fn for_loopback(root_der: Vec<u8>, hosts: &[String], port: u16) -> Self {
        let address = SocketAddr::from(([127, 0, 0, 1], port));
        let resolve: Vec<(String, SocketAddr)> =
            hosts.iter().map(|host| (host.clone(), address)).collect();
        Self::for_loopback_test(&[root_der], &resolve)
    }
}

impl Default for UreqWire {
    fn default() -> Self {
        Self::new()
    }
}

/// Maps listed names to fixed addresses and resolves every other name as the default does.
#[derive(Debug)]
struct FixedResolver {
    map: Vec<(String, SocketAddr)>,
}

impl Resolver for FixedResolver {
    fn resolve(
        &self,
        uri: &ureq::http::Uri,
        config: &Config,
        timeout: NextTimeout,
    ) -> Result<ResolvedSocketAddrs, ureq::Error> {
        let host = uri.host().unwrap_or_default();
        if let Some((_, address)) = self.map.iter().find(|(name, _)| name == host) {
            let mut found = self.empty();
            found.push(*address);
            return Ok(found);
        }
        DefaultResolver::default().resolve(uri, config, timeout)
    }
}

impl Wire for UreqWire {
    fn send(&self, request: &WireRequest<'_>) -> Result<WireResponse, WireError> {
        let url = https_url(request.host, request.path, request.query);
        let response = match request.method {
            Method::Get => {
                let mut builder = self
                    .agent
                    .get(&url)
                    .config()
                    .timeout_global(Some(request.timeout))
                    .build();
                for (name, value) in &request.headers {
                    builder = builder.header(*name, value.expose());
                }
                builder.call()
            }
            Method::Post | Method::Put => {
                let builder = if request.method == Method::Post {
                    self.agent.post(&url)
                } else {
                    self.agent.put(&url)
                };
                let mut builder = builder
                    .config()
                    .timeout_global(Some(request.timeout))
                    .build();
                for (name, value) in &request.headers {
                    builder = builder.header(*name, value.expose());
                }
                builder.send(request.body)
            }
        };
        let mut response = response.map_err(|error| wire_error(&error))?;
        let status = response.status().as_u16();
        let headers: Vec<(String, String)> = response
            .headers()
            .iter()
            .filter_map(|(name, value)| {
                Some((
                    name.as_str().to_ascii_lowercase(),
                    value.to_str().ok()?.to_owned(),
                ))
            })
            .collect();
        let body = response
            .body_mut()
            .with_config()
            .limit(request.max_response_bytes)
            .read_to_vec()
            .map_err(|error| wire_error(&error))?;
        Ok(WireResponse {
            status,
            headers,
            body,
        })
    }
}

/// Shared wire handle.
pub type SharedWire = Arc<dyn Wire>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_url_is_https_and_encodes_the_query() {
        let query = vec![
            ("start".to_owned(), "2023-01-01T00:00:00Z".to_owned()),
            ("symbols".to_owned(), "A B&C".to_owned()),
        ];
        assert_eq!(
            https_url("data.alpaca.markets", "/v2/stocks/AAPL/bars", &query),
            "https://data.alpaca.markets/v2/stocks/AAPL/bars?start=2023-01-01T00%3A00%3A00Z&symbols=A%20B%26C"
        );
        assert_eq!(
            https_url("api.example.com", "/v1/x", &[]),
            "https://api.example.com/v1/x"
        );
    }

    #[test]
    fn a_request_prints_no_header_value_and_no_query_value() {
        let query = vec![("page_token".to_owned(), "secret-page".to_owned())];
        let request = WireRequest {
            method: Method::Get,
            host: "data.alpaca.markets",
            path: "/v2/stocks/AAPL/bars",
            query: &query,
            headers: vec![("authorization", Secret::new("Bearer synthetic-token"))],
            body: b"",
            timeout: Duration::from_secs(1),
            max_response_bytes: 10,
        };
        let text = format!("{request:?}");
        assert!(
            !text.contains("synthetic-token") && !text.contains("secret-page"),
            "{text}"
        );
        assert!(text.contains("page_token"));
    }
}

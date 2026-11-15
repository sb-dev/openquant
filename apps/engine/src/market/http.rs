//! The transport seam of the market adapters.
//!
//! An adapter never opens a connection. It describes a request and hands it to an
//! [`HttpTransport`]. Tests use a scripted fake. The batch host supplies the real transport, which
//! is the only HTTP client in the binary (OQ-05 section 5): HTTPS only, GET only, no redirect
//! followed and only the hosts and paths of the egress allowlist.
//!
//! The credentials travel beside the request, not inside it, so that the request can be logged and
//! compared freely. [`Credentials`] prints as `<redacted>` in every format, and the adapter, its
//! errors and its call log never contain them.

use std::{fmt, time::Duration};

/// A provider host the adapters may call.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Host {
    /// `data.alpaca.markets`: bars and corporate actions.
    Data,
    /// `paper-api.alpaca.markets`: the calendar and the asset record, read with a paper key.
    Paper,
}

impl Host {
    /// The DNS name of the host.
    #[must_use]
    pub const fn name(self) -> &'static str {
        match self {
            Self::Data => "data.alpaca.markets",
            Self::Paper => "paper-api.alpaca.markets",
        }
    }
}

/// One GET request: host, path and query. Never a URL string, so no credential or redirect target
/// can be smuggled into it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HttpRequest {
    pub host: Host,
    pub path: String,
    /// Query parameters in the order they are sent, unencoded.
    pub query: Vec<(String, String)>,
}

impl HttpRequest {
    /// The value of the first query parameter named `name`.
    #[must_use]
    pub fn query_value(&self, name: &str) -> Option<&str> {
        self.query
            .iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.as_str())
    }
}

/// A response as the transport received it. A redirect is returned as is, never followed.
#[derive(Clone, PartialEq, Eq)]
pub struct HttpResponse {
    pub status: u16,
    /// Header names in lower case.
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl HttpResponse {
    /// The value of the header `name` (lower case), if the response has it.
    #[must_use]
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.as_str())
    }
}

/// The body is never printed: it can hold account data.
impl fmt::Debug for HttpResponse {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("HttpResponse")
            .field("status", &self.status)
            .field("body_bytes", &self.body.len())
            .finish_non_exhaustive()
    }
}

/// A provider key pair. It prints as `<redacted>` with `Debug` and `Display`.
#[derive(Clone, PartialEq, Eq)]
pub struct Credentials {
    key_id: String,
    secret: String,
}

impl Credentials {
    /// A key id and its secret.
    #[must_use]
    pub fn new(key_id: impl Into<String>, secret: impl Into<String>) -> Self {
        Self {
            key_id: key_id.into(),
            secret: secret.into(),
        }
    }

    /// The key id, for a transport that signs a request.
    #[must_use]
    pub fn key_id(&self) -> &str {
        &self.key_id
    }

    /// The secret, for a transport that signs a request. Nothing else reads it.
    #[must_use]
    pub fn secret(&self) -> &str {
        &self.secret
    }
}

impl fmt::Debug for Credentials {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Credentials(<redacted>)")
    }
}

impl fmt::Display for Credentials {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("<redacted>")
    }
}

/// Bounds for one transport call.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TransportLimits {
    /// Time for the whole call, connection and body.
    pub timeout: Duration,
    /// The transport stops reading a body above this many bytes.
    pub max_response_bytes: u64,
}

/// Why a transport call produced no response.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TransportError {
    /// The call did not finish within its timeout.
    Timeout,
    /// The connection failed or dropped.
    Connection,
    /// The egress allowlist refused the host, method, path or a redirect target.
    EgressRefused,
    /// The body is larger than the limit.
    BodyTooLarge,
}

impl fmt::Display for TransportError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Timeout => "transport timed out",
            Self::Connection => "transport connection failed",
            Self::EgressRefused => "egress allowlist refused the request",
            Self::BodyTooLarge => "response body above the limit",
        })
    }
}

impl std::error::Error for TransportError {}

/// Performs one GET and returns the response without following redirects.
pub trait HttpTransport {
    /// Send `request` with `credentials`.
    ///
    /// # Errors
    /// [`TransportError`] when no response was received or the egress policy refused the call.
    fn get(
        &self,
        request: &HttpRequest,
        credentials: &Credentials,
        limits: TransportLimits,
    ) -> Result<HttpResponse, TransportError>;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn credentials_never_print() {
        let credentials = Credentials::new("synthetic-key-id", "synthetic-secret");
        for text in [
            format!("{credentials:?}"),
            format!("{credentials}"),
            format!("{credentials:#?}"),
        ] {
            assert!(!text.contains("synthetic"), "{text}");
        }
        assert_eq!(credentials.key_id(), "synthetic-key-id");
        assert_eq!(credentials.secret(), "synthetic-secret");
    }

    #[test]
    fn a_response_prints_its_size_not_its_body() {
        let response = HttpResponse {
            status: 200,
            headers: vec![("retry-after".to_owned(), "3".to_owned())],
            body: b"account-private-text".to_vec(),
        };
        let text = format!("{response:?}");
        assert!(text.contains("200") && text.contains("20"));
        assert!(!text.contains("account-private-text"));
        assert_eq!(response.header("retry-after"), Some("3"));
        assert_eq!(response.header("x"), None);
    }
}

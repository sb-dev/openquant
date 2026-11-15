//! Typed provider errors (OQ-05 section 7.1).
//!
//! The classes separate authentication, permission, rate limit, timeout, unavailable data,
//! unsupported capability, malformed response, cancellation and an egress refusal, because each is
//! handled differently: only a transient class is retried, and only within the bounded policy. No
//! error carries a credential, a request URL, a query or a response body.

use std::fmt;

use super::{number::NumberError, time::TimeError};

/// A provider operation. One adapter capability each.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Operation {
    DailyBars,
    MinuteBars,
    CorporateActions,
    Calendar,
    Asset,
}

impl Operation {
    /// Every operation, in a fixed order.
    pub const ALL: [Self; 5] = [
        Self::DailyBars,
        Self::MinuteBars,
        Self::CorporateActions,
        Self::Calendar,
        Self::Asset,
    ];

    /// The operation name used in capability references.
    #[must_use]
    pub const fn name(self) -> &'static str {
        match self {
            Self::DailyBars => "daily_bars",
            Self::MinuteBars => "minute_bars",
            Self::CorporateActions => "corporate_actions",
            Self::Calendar => "calendar",
            Self::Asset => "asset",
        }
    }

    /// The capability reference of this operation at compatibility version 1, as the research
    /// profile and the retrieval request write it: `provider:<provider>/<operation>@1`.
    #[must_use]
    pub fn capability_ref(self, provider: &str) -> String {
        format!("provider:{provider}/{}@1", self.name())
    }

    /// The operation named by a capability reference of `provider`, if there is one.
    #[must_use]
    pub fn from_capability_ref(provider: &str, reference: &str) -> Option<Self> {
        Self::ALL
            .into_iter()
            .find(|operation| operation.capability_ref(provider) == reference)
    }
}

impl fmt::Display for Operation {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.name())
    }
}

/// The error classes of `retrieval-result/1`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum ErrorClass {
    Authentication,
    Permission,
    RateLimited,
    Timeout,
    UnavailableData,
    UnsupportedCapability,
    MalformedResponse,
    Cancelled,
    EgressRefused,
}

impl ErrorClass {
    /// The wire name of the class.
    #[must_use]
    pub const fn wire_name(self) -> &'static str {
        match self {
            Self::Authentication => "AUTHENTICATION",
            Self::Permission => "PERMISSION",
            Self::RateLimited => "RATE_LIMITED",
            Self::Timeout => "TIMEOUT",
            Self::UnavailableData => "UNAVAILABLE_DATA",
            Self::UnsupportedCapability => "UNSUPPORTED_CAPABILITY",
            Self::MalformedResponse => "MALFORMED_RESPONSE",
            Self::Cancelled => "CANCELLED",
            Self::EgressRefused => "EGRESS_REFUSED",
        }
    }
}

impl fmt::Display for ErrorClass {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.wire_name())
    }
}

/// Why a provider operation failed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ProviderError {
    /// HTTP 401: the key is missing, wrong or revoked. Never retried.
    Authentication,
    /// HTTP 403: the key is valid but has no right to this data (an entitlement). Never retried.
    Permission,
    /// HTTP 429. `retry_after_seconds` preserves the provider's `Retry-After`, capped at one day.
    RateLimited { retry_after_seconds: Option<u64> },
    /// HTTP 408 or 5xx. Transient.
    Server { status: u16 },
    /// HTTP 3xx. A redirect is never followed, not even to the same host.
    RedirectRefused { status: u16 },
    /// HTTP 404.
    NotFound,
    /// HTTP 400, 422 or another 4xx: the provider refused the request itself.
    BadRequest { status: u16 },
    /// A status code outside 2xx to 5xx.
    UnexpectedStatus { status: u16 },
    /// The body is not what the operation returns.
    MalformedResponse {
        operation: Operation,
        reason: String,
    },
    /// The body is larger than the response limit.
    ResponseTooLarge { limit_bytes: u64 },
    /// The transport timed out.
    Timeout,
    /// The connection failed or dropped.
    Connection,
    /// The egress allowlist refused the call. A configuration failure, never retried.
    EgressRefused,
    /// The retrieval deadline passed, or a wait would pass it.
    DeadlineExceeded,
    /// The request budget is used up. A retrieval that stops here is partial and never complete.
    RequestLimitReached { max_requests: u32 },
    /// The retrieval was cancelled.
    Cancelled,
    /// The provider or its profile cannot supply what the request needs.
    UnsupportedCapability { what: String },
    /// The request itself is invalid (a symbol that cannot be a path segment, an empty range).
    InvalidRequest { reason: String },
}

impl ProviderError {
    /// The `retrieval-result/1` class of this error.
    #[must_use]
    pub const fn class(&self) -> ErrorClass {
        match self {
            Self::Authentication => ErrorClass::Authentication,
            Self::Permission => ErrorClass::Permission,
            Self::RateLimited { .. } => ErrorClass::RateLimited,
            Self::Server { .. }
            | Self::NotFound
            | Self::Connection
            | Self::RequestLimitReached { .. } => ErrorClass::UnavailableData,
            Self::RedirectRefused { .. } | Self::EgressRefused => ErrorClass::EgressRefused,
            Self::BadRequest { .. }
            | Self::UnsupportedCapability { .. }
            | Self::InvalidRequest { .. } => ErrorClass::UnsupportedCapability,
            Self::UnexpectedStatus { .. }
            | Self::MalformedResponse { .. }
            | Self::ResponseTooLarge { .. } => ErrorClass::MalformedResponse,
            Self::Timeout | Self::DeadlineExceeded => ErrorClass::Timeout,
            Self::Cancelled => ErrorClass::Cancelled,
        }
    }

    /// Whether the bounded retry policy may try the request again. Only a transient failure is
    /// retried. The five classes that `retrieval-result/1` forces to non-retryable never are.
    #[must_use]
    pub const fn retryable(&self) -> bool {
        matches!(
            self,
            Self::RateLimited { .. } | Self::Server { .. } | Self::Timeout | Self::Connection
        )
    }

    /// A stable machine-readable name of the error, for records and tests.
    #[must_use]
    pub const fn code(&self) -> &'static str {
        match self {
            Self::Authentication => "AUTHENTICATION",
            Self::Permission => "PERMISSION",
            Self::RateLimited { .. } => "RATE_LIMITED",
            Self::Server { .. } => "SERVER",
            Self::RedirectRefused { .. } => "REDIRECT_REFUSED",
            Self::NotFound => "NOT_FOUND",
            Self::BadRequest { .. } => "BAD_REQUEST",
            Self::UnexpectedStatus { .. } => "UNEXPECTED_STATUS",
            Self::MalformedResponse { .. } => "MALFORMED_RESPONSE",
            Self::ResponseTooLarge { .. } => "RESPONSE_TOO_LARGE",
            Self::Timeout => "TIMEOUT",
            Self::Connection => "CONNECTION",
            Self::EgressRefused => "EGRESS_REFUSED",
            Self::DeadlineExceeded => "DEADLINE_EXCEEDED",
            Self::RequestLimitReached { .. } => "REQUEST_LIMIT_REACHED",
            Self::Cancelled => "CANCELLED",
            Self::UnsupportedCapability { .. } => "UNSUPPORTED_CAPABILITY",
            Self::InvalidRequest { .. } => "INVALID_REQUEST",
        }
    }

    /// The provider's retry hint, in seconds, when it gave one.
    #[must_use]
    pub const fn retry_after_seconds(&self) -> Option<u64> {
        match self {
            Self::RateLimited {
                retry_after_seconds,
            } => *retry_after_seconds,
            _ => None,
        }
    }

    /// A malformed-response error with an own reason text. Never put response content in it.
    pub(crate) fn malformed(operation: Operation, reason: impl Into<String>) -> Self {
        Self::MalformedResponse {
            operation,
            reason: reason.into(),
        }
    }

    pub(crate) fn malformed_time(operation: Operation, what: &str, error: TimeError) -> Self {
        Self::malformed(operation, format!("{what}: {error}"))
    }

    pub(crate) fn malformed_number(operation: Operation, what: &str, error: NumberError) -> Self {
        Self::malformed(operation, format!("{what}: {error}"))
    }
}

impl fmt::Display for ProviderError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Authentication => f.write_str("provider refused the credentials (401)"),
            Self::Permission => f.write_str("provider denied access to the data (403)"),
            Self::RateLimited {
                retry_after_seconds: Some(seconds),
            } => write!(f, "provider rate limit (429), retry after {seconds} s"),
            Self::RateLimited {
                retry_after_seconds: None,
            } => f.write_str("provider rate limit (429)"),
            Self::Server { status } => write!(f, "provider server error ({status})"),
            Self::RedirectRefused { status } => {
                write!(
                    f,
                    "provider redirect ({status}) refused, redirects are never followed"
                )
            }
            Self::NotFound => f.write_str("provider has no such record (404)"),
            Self::BadRequest { status } => write!(f, "provider refused the request ({status})"),
            Self::UnexpectedStatus { status } => write!(f, "unexpected HTTP status {status}"),
            Self::MalformedResponse { operation, reason } => {
                write!(f, "malformed {operation} response: {reason}")
            }
            Self::ResponseTooLarge { limit_bytes } => {
                write!(f, "response body above the limit of {limit_bytes} bytes")
            }
            Self::Timeout => f.write_str("provider request timed out"),
            Self::Connection => f.write_str("provider connection failed"),
            Self::EgressRefused => f.write_str("egress allowlist refused the request"),
            Self::DeadlineExceeded => f.write_str("retrieval deadline exceeded"),
            Self::RequestLimitReached { max_requests } => {
                write!(
                    f,
                    "request limit of {max_requests} reached before the retrieval finished"
                )
            }
            Self::Cancelled => f.write_str("retrieval cancelled"),
            Self::UnsupportedCapability { what } => write!(f, "unsupported capability: {what}"),
            Self::InvalidRequest { reason } => write!(f, "invalid request: {reason}"),
        }
    }
}

impl std::error::Error for ProviderError {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capability_references_round_trip() {
        for operation in Operation::ALL {
            let reference = operation.capability_ref("alpaca");
            assert_eq!(
                Operation::from_capability_ref("alpaca", &reference),
                Some(operation)
            );
        }
        assert_eq!(
            Operation::Asset.capability_ref("alpaca"),
            "provider:alpaca/asset@1"
        );
        assert_eq!(
            Operation::from_capability_ref("alpaca", "provider:massive/asset@1"),
            None
        );
        assert_eq!(
            Operation::from_capability_ref("alpaca", "provider:alpaca/assets@1"),
            None
        );
    }

    #[test]
    fn only_transient_errors_are_retryable_and_the_forced_classes_never() {
        let retryable = [
            ProviderError::RateLimited {
                retry_after_seconds: Some(1),
            },
            ProviderError::Server { status: 503 },
            ProviderError::Timeout,
            ProviderError::Connection,
        ];
        for error in &retryable {
            assert!(error.retryable(), "{error}");
        }
        let never = [
            ProviderError::Authentication,
            ProviderError::Permission,
            ProviderError::RedirectRefused { status: 302 },
            ProviderError::EgressRefused,
            ProviderError::Cancelled,
            ProviderError::NotFound,
            ProviderError::BadRequest { status: 400 },
            ProviderError::DeadlineExceeded,
            ProviderError::RequestLimitReached { max_requests: 3 },
            ProviderError::UnsupportedCapability {
                what: "x".to_owned(),
            },
            ProviderError::malformed(Operation::Asset, "x"),
        ];
        for error in &never {
            assert!(!error.retryable(), "{error}");
        }
        // retrieval-result/1 rejects a retryable failure of these five classes.
        for error in retryable.iter().chain(never.iter()) {
            if matches!(
                error.class(),
                ErrorClass::Authentication
                    | ErrorClass::Permission
                    | ErrorClass::UnsupportedCapability
                    | ErrorClass::Cancelled
                    | ErrorClass::EgressRefused
            ) {
                assert!(!error.retryable(), "{error}");
            }
        }
    }

    #[test]
    fn wire_names_are_the_schema_enum() {
        let names: Vec<&str> = [
            ErrorClass::Authentication,
            ErrorClass::Permission,
            ErrorClass::RateLimited,
            ErrorClass::Timeout,
            ErrorClass::UnavailableData,
            ErrorClass::UnsupportedCapability,
            ErrorClass::MalformedResponse,
            ErrorClass::Cancelled,
            ErrorClass::EgressRefused,
        ]
        .into_iter()
        .map(ErrorClass::wire_name)
        .collect();
        assert_eq!(
            names,
            [
                "AUTHENTICATION",
                "PERMISSION",
                "RATE_LIMITED",
                "TIMEOUT",
                "UNAVAILABLE_DATA",
                "UNSUPPORTED_CAPABILITY",
                "MALFORMED_RESPONSE",
                "CANCELLED",
                "EGRESS_REFUSED"
            ]
        );
    }
}

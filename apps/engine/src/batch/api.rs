//! The application API as the batch host uses it: claim an attempt, read inputs, upload
//! artefacts and submit results (OQ-05 sections 4, 5 and 7; `routes/v1.json`).
//!
//! The host holds no R2 or database credential (D13). It reads and writes only through the
//! attempt routes: a claim with the `batch` service credential, then the attempt capability that
//! the grant carries, which expires with the lease. Every body is canonical JSON of a contract
//! the host validated before it sent it, and every answer is parsed with the contract layer.
//!
//! Retry. A read, an artefact upload (addressed by its digest) and a result submission (the same
//! submission returns the stored result) are repeatable, so a transient failure is retried a
//! bounded number of times. A claim is not: a lost grant is recovered by the lease-expiry row, so
//! a claim is repeated only after a refusal that says nothing changed.

use std::{fmt, time::Duration};

use openquant_contracts::{Envelope, canonical::digest_bytes, parse_json, validate};
use serde_json::Value;

use super::{
    clock::Time,
    egress::{Auth, Egress, EgressError, Request, Target},
    secret::Secret,
    wire::{Method, WireError},
};
use crate::market::time::Timestamp;

/// Times a repeatable call is tried, the first included.
pub const MAX_TRIES: u32 = 3;

/// The response size of a small answer (a grant, an error, an empty body).
const SMALL_RESPONSE: u64 = 1024 * 1024;

/// An input is at most one artefact: the hard limit of the artefact routes.
pub const MAX_INPUT_BYTES: u64 = 16 * 1024 * 1024;

/// The result routes of an attempt.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ResultRoute {
    Retrieval,
    Validation,
    Evaluation,
    GateReport,
}

impl ResultRoute {
    const fn segment(self) -> &'static str {
        match self {
            Self::Retrieval => "retrieval-result",
            Self::Validation => "validation-result",
            Self::Evaluation => "evaluation-submission",
            Self::GateReport => "gate-report",
        }
    }
}

/// An error that the API answered, as `api-error/1` gives it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ApiFailure {
    pub status: u16,
    /// The `ApiErrorCode` wire name.
    pub code: String,
    pub message: String,
    pub retry_safe: bool,
    /// True when the API says that nothing changed (`state_changed` is `NONE`).
    pub state_unchanged: bool,
}

/// Why an API call failed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ApiError {
    /// The API answered with an `api-error/1` body.
    Api(ApiFailure),
    /// The API answered with a status and a body that is not `api-error/1`.
    Unstructured { status: u16 },
    /// The egress module refused the request or the wire failed.
    Egress(EgressError),
    /// The answer breaks a binding that the host checks itself: a digest, a size or a shape.
    Integrity(String),
}

impl fmt::Display for ApiError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Api(failure) => write!(
                f,
                "the API answered {} {}: {}",
                failure.status, failure.code, failure.message
            ),
            Self::Unstructured { status } => {
                write!(f, "the API answered {status} without an error body")
            }
            Self::Egress(error) => write!(f, "{error}"),
            Self::Integrity(why) => write!(f, "the API answer is not what was asked for: {why}"),
        }
    }
}

impl std::error::Error for ApiError {}

impl ApiError {
    /// The `ApiErrorCode` of an API answer.
    #[must_use]
    pub fn code(&self) -> Option<&str> {
        match self {
            Self::Api(failure) => Some(failure.code.as_str()),
            _ => None,
        }
    }

    /// Whether the attempt is no longer this worker's: its lease ended, a newer attempt exists, or
    /// it is not claimable (terminal, cancelled or claimed elsewhere). Work stops and nothing more
    /// is written.
    #[must_use]
    pub fn ownership_lost(&self) -> bool {
        matches!(
            self.code(),
            Some("STALE_OWNERSHIP" | "LEASE_EXPIRED" | "ATTEMPT_NOT_CLAIMABLE")
        )
    }

    /// Whether the same call may be repeated: a transport failure, or a refusal that the API
    /// marks as safe to retry.
    #[must_use]
    pub fn transient(&self) -> bool {
        match self {
            Self::Egress(EgressError::Wire(WireError::Timeout | WireError::Connection)) => true,
            Self::Api(failure) => {
                let transient_status = matches!(failure.status, 429 | 500 | 502 | 503 | 504);
                let named = matches!(failure.code.as_str(), "UNAVAILABLE" | "RATE_LIMITED");
                (transient_status && (failure.retry_safe || failure.state_unchanged)) || named
            }
            Self::Unstructured { status } => matches!(status, 502..=504),
            _ => false,
        }
    }
}

/// The grant of a claim.
#[derive(Clone)]
pub struct Grant {
    pub capability: Secret,
    pub granted_at: Timestamp,
    pub lease_expires_at: Timestamp,
}

impl fmt::Debug for Grant {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Grant")
            .field("granted_at", &self.granted_at.to_string())
            .field("lease_expires_at", &self.lease_expires_at.to_string())
            .finish_non_exhaustive()
    }
}

/// One API call.
struct Call<'a> {
    method: Method,
    path: &'a str,
    auth: Auth<'a>,
    content_type: Option<&'a str>,
    body: &'a [u8],
    max_response_bytes: u64,
    /// Whether a transient failure may be retried.
    repeatable: bool,
    /// The status of success.
    expect: u16,
}

/// The API client of one job. It is built over the job's [`Egress`].
pub struct ApiClient<'a> {
    egress: &'a Egress,
    host: String,
    service_token: &'a Secret,
    time: &'a dyn Time,
    timeout: Duration,
}

impl<'a> ApiClient<'a> {
    /// A client of the API at `host`. `service_token` is the `batch` credential, used for claims.
    #[must_use]
    pub fn new(
        egress: &'a Egress,
        host: &str,
        service_token: &'a Secret,
        time: &'a dyn Time,
    ) -> Self {
        Self {
            egress,
            host: host.to_owned(),
            service_token,
            time,
            timeout: Duration::from_secs(60),
        }
    }

    fn parse_error(status: u16, body: &[u8]) -> ApiError {
        let Ok(text) = std::str::from_utf8(body) else {
            return ApiError::Unstructured { status };
        };
        let Ok(value) = parse_json(text) else {
            return ApiError::Unstructured { status };
        };
        if validate(Envelope::ApiError, &value).is_err() {
            return ApiError::Unstructured { status };
        }
        let text_of = |key: &str| {
            value
                .get(key)
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned()
        };
        ApiError::Api(ApiFailure {
            status,
            code: text_of("code"),
            message: text_of("message"),
            retry_safe: value
                .get("retry_safe")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            state_unchanged: value.get("state_changed").and_then(Value::as_str) == Some("NONE"),
        })
    }

    /// One call, with the bounded retry of a repeatable call.
    fn call(&self, call: &Call<'_>) -> Result<Vec<u8>, ApiError> {
        let no_query: [(String, String); 0] = [];
        let mut tries = 0;
        loop {
            tries += 1;
            let request = Request {
                target: Target {
                    method: call.method,
                    host: &self.host,
                    path: call.path,
                    query: &no_query,
                },
                auth: call.auth,
                content_type: call.content_type,
                body: call.body,
                timeout: self.timeout,
                max_response_bytes: call.max_response_bytes,
            };
            let error = match self.egress.send(&request) {
                Ok(response) if response.status == call.expect => return Ok(response.body),
                Ok(response) => Self::parse_error(response.status, &response.body),
                Err(error) => ApiError::Egress(error),
            };
            // A claim is repeated only when the API says nothing changed and a retry is safe.
            let may_retry = if call.repeatable {
                error.transient()
            } else {
                matches!(&error, ApiError::Api(f) if f.code == "RATE_LIMITED" && f.state_unchanged)
            };
            if !may_retry || tries >= MAX_TRIES {
                return Err(error);
            }
            self.time.sleep_ms(500 * u64::from(tries));
        }
    }

    /// Claim the attempt with `attempt-claim/1`, the claim form, as canonical JSON.
    ///
    /// # Errors
    /// [`ApiError`]. `ATTEMPT_NOT_CLAIMABLE` and `STALE_OWNERSHIP` mean the attempt is not this
    /// worker's to run.
    pub fn claim(&self, attempt_id: &str, claim: &[u8]) -> Result<Grant, ApiError> {
        let path = format!("/v1/attempts/{attempt_id}/claim");
        let body = self.call(&Call {
            method: Method::Post,
            path: &path,
            auth: Auth::Bearer(self.service_token),
            content_type: Some("application/json"),
            body: claim,
            max_response_bytes: SMALL_RESPONSE,
            repeatable: false,
            expect: 200,
        })?;
        let integrity = |why: &str| ApiError::Integrity(format!("the grant {why}"));
        let text = std::str::from_utf8(&body).map_err(|_| integrity("is not UTF-8"))?;
        let value = parse_json(text).map_err(|_| integrity("is not JSON"))?;
        validate(Envelope::AttemptClaim, &value).map_err(|_| integrity("breaks its schema"))?;
        if value.get("form").and_then(Value::as_str) != Some("grant") {
            return Err(integrity("is not the grant form"));
        }
        let timestamp = |key: &str| {
            value
                .get(key)
                .and_then(Value::as_str)
                .and_then(|text| Timestamp::parse(text).ok())
        };
        let token = value
            .pointer("/capability/token")
            .and_then(Value::as_str)
            .ok_or_else(|| integrity("has no capability"))?;
        Ok(Grant {
            capability: Secret::new(token),
            granted_at: timestamp("granted_at").ok_or_else(|| integrity("has no grant time"))?,
            lease_expires_at: timestamp("lease_expires_at")
                .ok_or_else(|| integrity("has no lease end"))?,
        })
    }

    /// Read an input by its digest. The bytes are checked against the digest.
    ///
    /// # Errors
    /// [`ApiError`]; [`ApiError::Integrity`] when the bytes do not hash to `digest`.
    pub fn input(
        &self,
        grant: &Grant,
        attempt_id: &str,
        digest: &str,
    ) -> Result<Vec<u8>, ApiError> {
        let path = format!("/v1/attempts/{attempt_id}/inputs/{digest}");
        let bytes = self.call(&Call {
            method: Method::Get,
            path: &path,
            auth: Auth::Bearer(&grant.capability),
            content_type: None,
            body: &[],
            max_response_bytes: MAX_INPUT_BYTES,
            repeatable: true,
            expect: 200,
        })?;
        let actual = digest_bytes(&bytes);
        if actual == digest {
            Ok(bytes)
        } else {
            Err(ApiError::Integrity(format!(
                "the input {digest} hashes to {actual}"
            )))
        }
    }

    /// Upload an immutable artefact under its digest. The digest is computed here.
    ///
    /// # Errors
    /// [`ApiError`].
    pub fn put_artefact(
        &self,
        grant: &Grant,
        attempt_id: &str,
        media_type: &str,
        bytes: &[u8],
    ) -> Result<String, ApiError> {
        let digest = digest_bytes(bytes);
        let path = format!("/v1/attempts/{attempt_id}/artefacts/{digest}");
        self.call(&Call {
            method: Method::Put,
            path: &path,
            auth: Auth::Bearer(&grant.capability),
            content_type: Some(media_type),
            body: bytes,
            max_response_bytes: SMALL_RESPONSE,
            repeatable: true,
            expect: 204,
        })?;
        Ok(digest)
    }

    /// Submit a result as canonical JSON. A repeated submission returns the stored result.
    ///
    /// # Errors
    /// [`ApiError`].
    pub fn submit(
        &self,
        grant: &Grant,
        attempt_id: &str,
        route: ResultRoute,
        body: &[u8],
    ) -> Result<(), ApiError> {
        let path = format!("/v1/attempts/{attempt_id}/{}", route.segment());
        self.call(&Call {
            method: Method::Post,
            path: &path,
            auth: Auth::Bearer(&grant.capability),
            content_type: Some("application/json"),
            body,
            max_response_bytes: SMALL_RESPONSE,
            repeatable: true,
            expect: 204,
        })?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn failure(status: u16, code: &str, retry_safe: bool) -> ApiError {
        ApiError::Api(ApiFailure {
            status,
            code: code.to_owned(),
            message: String::new(),
            retry_safe,
            state_unchanged: false,
        })
    }

    #[test]
    fn ownership_is_lost_for_exactly_three_codes() {
        for code in ["STALE_OWNERSHIP", "LEASE_EXPIRED", "ATTEMPT_NOT_CLAIMABLE"] {
            assert!(failure(409, code, false).ownership_lost(), "{code}");
        }
        for code in [
            "NOT_FOUND",
            "IDENTITY_MISMATCH",
            "DIGEST_MISMATCH",
            "LIMIT_EXCEEDED",
            "FORBIDDEN",
        ] {
            assert!(!failure(422, code, false).ownership_lost(), "{code}");
        }
    }

    #[test]
    fn only_transient_failures_are_repeated() {
        assert!(failure(503, "UNAVAILABLE", true).transient());
        assert!(failure(429, "RATE_LIMITED", true).transient());
        assert!(!failure(422, "IDENTITY_MISMATCH", true).transient());
        assert!(!failure(409, "STALE_OWNERSHIP", true).transient());
        assert!(ApiError::Egress(EgressError::Wire(WireError::Timeout)).transient());
        assert!(!ApiError::Egress(EgressError::Wire(WireError::BodyTooLarge)).transient());
        assert!(ApiError::Unstructured { status: 502 }.transient());
        assert!(!ApiError::Unstructured { status: 400 }.transient());
    }
}

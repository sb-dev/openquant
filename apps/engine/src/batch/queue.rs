//! The Cloudflare Queues HTTP-pull consumer (OQ-05 section 4): pull, acknowledge, retry.
//!
//! The batch host is the only consumer: there is no push consumer. A pulled message has a lease id
//! and a visibility timeout. The worker acknowledges it only after the result is committed (or the
//! attempt is proven to be no longer claimable), and a message that it never acknowledges comes
//! back after the visibility timeout. The queue lease is separate from the application lease.
//!
//! The request and response shapes below are the ones Cloudflare's HTTP-pull documentation is
//! reported to give. They are reported facts, not verified here: no call to Cloudflare was made
//! and no credential exists. The deployment probe (P6) confirms them, and so the response is read
//! leniently: unknown fields are ignored.
//!
//! The message body is decoded by its content type, as the pull-consumer documentation states
//! (<https://developers.cloudflare.com/queues/configuration/pull-consumers/>, 1 July 2026): `json`
//! and `bytes` bodies arrive base64-encoded (RFC 4648), `text` as a plain string, and `v8` cannot
//! be decoded by a pull consumer. The documentation's example carries the content type in
//! `metadata["CF-Content-Type"]`; that location is from the example only.

use std::{fmt, time::Duration};

use base64::Engine as _;
use serde::Deserialize;
use serde_json::{Map, Value, json};

use super::{
    egress::{Auth, CLOUDFLARE_HOST, Egress, EgressError, Refusal, Request, Target},
    secret::Secret,
    wire::{Method, WireError},
};

/// Why a pulled message body could not be decoded to text. The message is a poison message.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Undecodable {
    /// The content type is `v8`, unknown or missing: a pull consumer cannot decode it.
    UnsupportedEncoding { content_type: Option<String> },
    /// The body does not fit its content type: not a string, not strict base64, or not UTF-8.
    Malformed {
        content_type: String,
        why: &'static str,
    },
}

impl Undecodable {
    /// The reason code of the poison message.
    #[must_use]
    pub const fn code(&self) -> &'static str {
        match self {
            Self::UnsupportedEncoding { .. } => "UNSUPPORTED_QUEUE_ENCODING",
            Self::Malformed { .. } => "MALFORMED_QUEUE_BODY",
        }
    }

    /// The content type as the queue named it, shortened and escaped for a log line.
    #[must_use]
    pub fn content_type(&self) -> String {
        match self {
            Self::UnsupportedEncoding { content_type: None } => "(none)".to_owned(),
            Self::UnsupportedEncoding {
                content_type: Some(name),
            }
            | Self::Malformed {
                content_type: name, ..
            } => name
                .chars()
                .take(32)
                .collect::<String>()
                .escape_debug()
                .to_string(),
        }
    }
}

/// Decode a pulled body by its content type: `json` and `bytes` are standard base64 with padding,
/// `text` is the string itself. The result is text; it is untrusted until it parses.
fn decode_body(content_type: Option<&str>, body: &Value) -> Result<String, Undecodable> {
    let Some(kind @ ("json" | "bytes" | "text")) = content_type else {
        return Err(Undecodable::UnsupportedEncoding {
            content_type: content_type.map(str::to_owned),
        });
    };
    let malformed = |why| Undecodable::Malformed {
        content_type: kind.to_owned(),
        why,
    };
    let Value::String(text) = body else {
        return Err(malformed("the body is not a string"));
    };
    if kind == "text" {
        return Ok(text.clone());
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(text)
        .map_err(|_| malformed("the body is not standard base64"))?;
    String::from_utf8(bytes).map_err(|_| malformed("the decoded body is not UTF-8"))
}

/// One pulled message. It is consumed by [`CloudflareQueue::ack`] or [`CloudflareQueue::retry`].
#[derive(Clone)]
pub struct Delivery {
    id: String,
    lease_id: Secret,
    body: Result<String, Undecodable>,
    attempts: u32,
}

impl Delivery {
    /// A delivery whose body is already text. The queue client builds its own from a pull.
    #[must_use]
    pub fn new(
        id: impl Into<String>,
        lease_id: impl Into<String>,
        body: impl Into<String>,
        attempts: u32,
    ) -> Self {
        Self {
            id: id.into(),
            lease_id: Secret::new(lease_id),
            body: Ok(body.into()),
            attempts,
        }
    }

    /// The message id.
    #[must_use]
    pub fn id(&self) -> &str {
        &self.id
    }

    /// The message body decoded to text. It is untrusted until it parses as `job-dispatch/1`.
    ///
    /// # Errors
    /// [`Undecodable`] when the body could not be decoded by its content type.
    pub fn body(&self) -> Result<&str, &Undecodable> {
        self.body.as_deref()
    }

    /// How many times the queue has delivered the message, this delivery included.
    #[must_use]
    pub const fn attempts(&self) -> u32 {
        self.attempts
    }
}

impl fmt::Debug for Delivery {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Delivery")
            .field("id", &self.id)
            .field("attempts", &self.attempts)
            .field("body_bytes", &self.body.as_ref().map(String::len))
            .finish_non_exhaustive()
    }
}

/// Why a queue call failed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum QueueError {
    /// The token was refused (401 or 403). Retrying does not help.
    Unauthorized,
    /// A failure that a later call may not repeat: a timeout, a 429, a 5xx.
    Transient(String),
    /// The answer is not the shape that the queue's documentation gives.
    Malformed(String),
    /// The egress module refused the request: a configuration or policy failure.
    Refused(Refusal),
}

impl fmt::Display for QueueError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Unauthorized => f.write_str("the queue token was refused"),
            Self::Transient(why) => write!(f, "queue call failed: {why}"),
            Self::Malformed(why) => write!(f, "queue answer not understood: {why}"),
            Self::Refused(refusal) => write!(f, "queue call refused: {refusal}"),
        }
    }
}

impl std::error::Error for QueueError {}

fn map_egress(error: EgressError) -> QueueError {
    match error {
        EgressError::Refused(refusal) => QueueError::Refused(refusal),
        EgressError::Wire(WireError::Timeout) => QueueError::Transient("timeout".to_owned()),
        EgressError::Wire(WireError::Connection) => {
            QueueError::Transient("connection failed".to_owned())
        }
        EgressError::Wire(WireError::BodyTooLarge) => {
            QueueError::Malformed("response body above the limit".to_owned())
        }
    }
}

#[derive(Deserialize)]
struct Envelope {
    #[serde(default)]
    success: bool,
    #[serde(default)]
    result: Option<PullResult>,
}

#[derive(Deserialize)]
struct PullResult {
    #[serde(default)]
    messages: Vec<PulledMessage>,
}

#[derive(Deserialize)]
struct PulledMessage {
    id: String,
    lease_id: String,
    #[serde(default)]
    body: Value,
    #[serde(default)]
    attempts: u32,
    #[serde(default)]
    metadata: Map<String, Value>,
}

/// The consumer of one queue, over an [`Egress`].
pub struct CloudflareQueue<'a> {
    egress: &'a Egress,
    account_id: String,
    queue_id: String,
    token: Secret,
    request_timeout: Duration,
}

impl<'a> CloudflareQueue<'a> {
    /// A consumer of queue `queue_id` of `account_id`. The token is the one minimum-scope Queues
    /// consumer token.
    #[must_use]
    pub fn new(egress: &'a Egress, account_id: &str, queue_id: &str, token: Secret) -> Self {
        Self {
            egress,
            account_id: account_id.to_owned(),
            queue_id: queue_id.to_owned(),
            token,
            request_timeout: Duration::from_secs(30),
        }
    }

    fn path(&self, action: &str) -> String {
        format!(
            "/client/v4/accounts/{}/queues/{}/messages/{action}",
            self.account_id, self.queue_id
        )
    }

    fn post(&self, action: &str, body: &Value) -> Result<(u16, Vec<u8>), QueueError> {
        let bytes = serde_json::to_vec(body)
            .map_err(|e| QueueError::Malformed(format!("cannot write the request: {e}")))?;
        let path = self.path(action);
        let no_query: [(String, String); 0] = [];
        let request = Request {
            target: Target {
                method: Method::Post,
                host: CLOUDFLARE_HOST,
                path: &path,
                query: &no_query,
            },
            auth: Auth::Bearer(&self.token),
            content_type: Some("application/json"),
            body: &bytes,
            timeout: self.request_timeout,
            max_response_bytes: 4 * 1024 * 1024,
        };
        let response = self.egress.send(&request).map_err(map_egress)?;
        match response.status {
            200 => Ok((response.status, response.body)),
            401 | 403 => Err(QueueError::Unauthorized),
            408 | 429 | 500..=599 => {
                Err(QueueError::Transient(format!("status {}", response.status)))
            }
            status => Err(QueueError::Malformed(format!("status {status}"))),
        }
    }

    /// Pull up to `max` messages. Each stays invisible to other consumers for `visibility`.
    ///
    /// # Errors
    /// [`QueueError`].
    pub fn pull(&self, max: u32, visibility: Duration) -> Result<Vec<Delivery>, QueueError> {
        let millis = u64::try_from(visibility.as_millis()).unwrap_or(u64::MAX);
        let (_, body) = self.post(
            "pull",
            &json!({"batch_size": max, "visibility_timeout_ms": millis}),
        )?;
        let envelope: Envelope = serde_json::from_slice(&body)
            .map_err(|e| QueueError::Malformed(format!("not the pull answer: {e}")))?;
        if !envelope.success {
            return Err(QueueError::Transient(
                "the queue reported no success".to_owned(),
            ));
        }
        let messages = envelope.result.map(|r| r.messages).unwrap_or_default();
        // A body that cannot be decoded fails its own message, not the pull: the worker gives it
        // back as a poison message.
        Ok(messages
            .into_iter()
            .map(|message| {
                let content_type = message
                    .metadata
                    .get("CF-Content-Type")
                    .and_then(Value::as_str);
                Delivery {
                    body: decode_body(content_type, &message.body),
                    id: message.id,
                    lease_id: Secret::new(message.lease_id),
                    attempts: message.attempts,
                }
            })
            .collect())
    }

    fn settle(&self, body: &Value) -> Result<(), QueueError> {
        let (_, answer) = self.post("ack", body)?;
        let envelope: Envelope = serde_json::from_slice(&answer)
            .map_err(|e| QueueError::Malformed(format!("not the acknowledge answer: {e}")))?;
        if envelope.success {
            Ok(())
        } else {
            Err(QueueError::Transient(
                "the queue reported no success".to_owned(),
            ))
        }
    }

    /// Acknowledge a message: the queue forgets it. Only after the result is committed.
    ///
    /// # Errors
    /// [`QueueError`]. A failed acknowledgement leaves the message to come back.
    pub fn ack(&self, delivery: Delivery) -> Result<(), QueueError> {
        self.settle(&json!({"acks": [{"lease_id": delivery.lease_id.expose()}], "retries": []}))
    }

    /// Give a message back: it becomes visible again after `delay`.
    ///
    /// # Errors
    /// [`QueueError`].
    pub fn retry(&self, delivery: Delivery, delay: Duration) -> Result<(), QueueError> {
        self.settle(&json!({
            "acks": [],
            "retries": [{"lease_id": delivery.lease_id.expose(), "delay_seconds": delay.as_secs()}],
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_delivery_prints_no_lease_and_no_body() {
        let delivery = Delivery::new("m1", "synthetic-lease-id", "{\"secret\":\"body\"}", 2);
        let text = format!("{delivery:?}");
        assert!(
            !text.contains("synthetic-lease-id") && !text.contains("body\""),
            "{text}"
        );
        assert_eq!(delivery.id(), "m1");
        assert_eq!(delivery.attempts(), 2);
    }

    const TEXT: &str = r#"{"schema_version":"job-dispatch/1"}"#;

    fn b64(bytes: &[u8]) -> Value {
        Value::String(base64::engine::general_purpose::STANDARD.encode(bytes))
    }

    #[test]
    fn json_and_bytes_bodies_are_base64_and_a_text_body_is_plain() {
        for kind in ["json", "bytes"] {
            assert_eq!(
                decode_body(Some(kind), &b64(TEXT.as_bytes())).as_deref(),
                Ok(TEXT)
            );
        }
        assert_eq!(
            decode_body(Some("text"), &Value::String(TEXT.to_owned())).as_deref(),
            Ok(TEXT)
        );
        // A json body that is the plain JSON text is not base64 and is not read as if it were.
        let error = decode_body(Some("json"), &Value::String(TEXT.to_owned())).unwrap_err();
        assert_eq!(error.code(), "MALFORMED_QUEUE_BODY");
    }

    #[test]
    fn a_body_that_is_not_strict_base64_utf8_or_a_string_is_malformed() {
        // URL-safe alphabet, missing padding, padding inside, whitespace, non-zero trailing bits.
        for text in ["e30-", "e30", "e3=0", "e3 0", "e31="] {
            let error = decode_body(Some("json"), &Value::String(text.to_owned())).unwrap_err();
            assert_eq!(error.code(), "MALFORMED_QUEUE_BODY", "{text}");
        }
        assert_eq!(
            decode_body(Some("json"), &b64(&[0xff, 0xfe, b'{'])),
            Err(Undecodable::Malformed {
                content_type: "json".to_owned(),
                why: "the decoded body is not UTF-8",
            })
        );
        let error = decode_body(Some("json"), &json!({"schema_version": "job-dispatch/1"}));
        assert_eq!(error.unwrap_err().code(), "MALFORMED_QUEUE_BODY");
    }

    #[test]
    fn v8_unknown_and_missing_content_types_are_unsupported() {
        for content_type in [Some("v8"), Some("JSON"), Some("xml"), None] {
            let error = decode_body(content_type, &b64(TEXT.as_bytes())).unwrap_err();
            assert_eq!(
                error,
                Undecodable::UnsupportedEncoding {
                    content_type: content_type.map(str::to_owned),
                }
            );
            assert_eq!(error.code(), "UNSUPPORTED_QUEUE_ENCODING");
        }
        // The content type is untrusted: shortened and escaped before it reaches a log line.
        let long = "x\n".repeat(40);
        let error = decode_body(Some(&long), &Value::Null).unwrap_err();
        assert!(!error.content_type().contains('\n'));
        assert!(error.content_type().len() <= 64);
    }
}

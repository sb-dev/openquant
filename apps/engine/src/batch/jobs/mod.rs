//! The four batch jobs and what they share: `retrieve`, `validate`, `evaluate` and `assess`
//! (OQ-05 section 4; decision D21).
//!
//! A job runs after its attempt was claimed. It reads inputs by digest, does its work with the
//! shared Rust core or the market module, uploads immutable artefacts first and submits one
//! result last. Its only ways to end are a submitted result ([`Submitted`]) or an abandonment
//! ([`Abandoned`]): the attempt is no longer this worker's, the lease is about to end, the request
//! is not one this binary may run, or the API fails in a way that no result can describe. An
//! abandoned job submits nothing, and its queue message is not acknowledged: recovery decides
//! what happens to the attempt (OQ-05 section 4).

pub mod assess;
mod bind;
pub mod evaluate;
pub mod retrieve;
pub mod validate;

use std::{
    cell::Cell,
    fmt,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};

use openquant_contracts::{
    ContractError, Payload, canonical::digest_bytes, canonical_json, generated::JobDispatch, parse,
};
use serde_json::{Value, json};

use super::{
    api::{ApiClient, ApiError, Grant, ResultRoute},
    clock::Time,
    config::{Config, EvidenceRecord},
    egress::Egress,
    identity::ExecutableId,
};
use crate::market::time::Timestamp;

/// Seconds between two liveness probes of a long job. A probe re-reads an input of the attempt:
/// it fails with an ownership error as soon as the attempt is cancelled, fenced or expired, which
/// is the only way the worker can learn it (the API has no lease or cancellation route).
pub const PROBE_INTERVAL_SECONDS: i64 = 20;

/// The media type of every contract document and of the raw provider responses.
pub const JSON_MEDIA_TYPE: &str = "application/json";

/// A shared flag: set when the attempt is no longer this worker's.
#[derive(Clone, Debug, Default)]
pub struct CancelToken(Arc<AtomicBool>);

impl CancelToken {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Mark the attempt as lost.
    pub fn cancel(&self) {
        self.0.store(true, Ordering::SeqCst);
    }

    #[must_use]
    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }
}

/// A job that ended with a submitted, accepted result.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Submitted {
    /// What was submitted, for the log. Never a credential or a payload.
    pub summary: String,
}

/// A job that ended without a result.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Abandoned {
    /// The API says the attempt is not this worker's: cancelled, fenced or expired.
    OwnershipLost(ApiError),
    /// The lease is about to end: nothing more is written.
    Deadline,
    /// The attempt was marked lost by an earlier call.
    Cancelled,
    /// The request names an engine, a method, an environment or an attempt that this binary
    /// cannot serve, or a document does not bind to its request. A submission would be refused.
    Unfit(String),
    /// An API call failed in a way that no result can describe.
    Api(ApiError),
    /// A defect of this binary.
    Internal(String),
}

impl fmt::Display for Abandoned {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::OwnershipLost(error) => write!(f, "the attempt is no longer ours: {error}"),
            Self::Deadline => f.write_str("the lease is about to end"),
            Self::Cancelled => f.write_str("the attempt was cancelled"),
            Self::Unfit(why) => write!(f, "this binary cannot serve the request: {why}"),
            Self::Api(error) => write!(f, "an API call failed: {error}"),
            Self::Internal(why) => write!(f, "internal error: {why}"),
        }
    }
}

impl std::error::Error for Abandoned {}

/// What a job returns.
pub type JobResult = Result<Submitted, Abandoned>;

/// Everything a job reads or uses, for one claimed attempt.
pub struct JobContext<'a> {
    pub config: &'a Config,
    pub api: &'a ApiClient<'a>,
    pub egress: &'a Egress,
    pub time: &'a dyn Time,
    pub grant: &'a Grant,
    pub executable: &'a ExecutableId,
    pub evidence: Option<&'a EvidenceRecord>,
    pub dispatch: &'a JobDispatch,
    pub cancel: &'a CancelToken,
    /// No work and no write after this instant: the lease end minus the margin.
    pub deadline: Timestamp,
    /// The monotonic time at which the job started.
    pub started_ms: u64,
    last_probe: Cell<i64>,
}

impl<'a> JobContext<'a> {
    #[allow(clippy::too_many_arguments)]
    #[must_use]
    pub fn new(
        config: &'a Config,
        api: &'a ApiClient<'a>,
        egress: &'a Egress,
        time: &'a dyn Time,
        grant: &'a Grant,
        executable: &'a ExecutableId,
        evidence: Option<&'a EvidenceRecord>,
        dispatch: &'a JobDispatch,
        cancel: &'a CancelToken,
        deadline: Timestamp,
    ) -> Self {
        Self {
            config,
            api,
            egress,
            time,
            grant,
            executable,
            evidence,
            dispatch,
            cancel,
            deadline,
            started_ms: time.monotonic_ms(),
            last_probe: Cell::new(time.now().epoch_seconds()),
        }
    }

    /// The attempt id of the dispatch.
    #[must_use]
    pub fn attempt_id(&self) -> &str {
        self.dispatch.attempt.attempt_id.as_str()
    }

    /// The `AttemptBinding` object.
    #[must_use]
    pub fn attempt(&self) -> Value {
        json!({
            "attempt_id": self.dispatch.attempt.attempt_id.as_str(),
            "ownership_revision": self.dispatch.attempt.ownership_revision.get(),
        })
    }

    /// Record that an API error ended this worker's ownership, and turn it into an abandonment.
    pub fn note(&self, error: ApiError) -> Abandoned {
        if error.ownership_lost() {
            self.cancel.cancel();
            Abandoned::OwnershipLost(error)
        } else {
            Abandoned::Api(error)
        }
    }

    /// Fail when the attempt was lost or the lease is about to end.
    ///
    /// # Errors
    /// [`Abandoned::Cancelled`] or [`Abandoned::Deadline`].
    pub fn live(&self) -> Result<(), Abandoned> {
        if self.cancel.is_cancelled() {
            return Err(Abandoned::Cancelled);
        }
        if self.time.now() >= self.deadline {
            return Err(Abandoned::Deadline);
        }
        Ok(())
    }

    /// [`Self::live`], and once every [`PROBE_INTERVAL_SECONDS`] a probe of the attempt: a read of
    /// `probe_digest`, which an attempt that lost its lease cannot make.
    ///
    /// # Errors
    /// The error of [`Self::live`], or the abandonment that the probe finds.
    pub fn heartbeat(&self, probe_digest: &str) -> Result<(), Abandoned> {
        self.live()?;
        let now = self.time.now().epoch_seconds();
        if now - self.last_probe.get() >= PROBE_INTERVAL_SECONDS {
            self.last_probe.set(now);
            self.fetch(probe_digest)?;
        }
        Ok(())
    }

    /// Read an input by digest.
    ///
    /// # Errors
    /// [`Abandoned`] when the lease is ending, the attempt was lost or the read fails.
    pub fn fetch(&self, digest: &str) -> Result<Vec<u8>, Abandoned> {
        self.live()?;
        self.api
            .input(self.grant, self.attempt_id(), digest)
            .map_err(|error| self.note(error))
    }

    /// Read an input and parse it as the contract `T`.
    ///
    /// # Errors
    /// [`Abandoned::Unfit`] when it does not parse; the errors of [`Self::fetch`].
    pub fn fetch_contract<T: Payload>(&self, digest: &str, what: &str) -> Result<T, Abandoned> {
        let bytes = self.fetch(digest)?;
        parse_document(&bytes, what)
    }

    /// Upload an artefact and return its `ArtefactRef`.
    ///
    /// # Errors
    /// [`Abandoned`] when the lease is ending, the attempt was lost or the upload fails.
    pub fn upload(&self, media_type: &str, bytes: &[u8]) -> Result<Value, Abandoned> {
        self.live()?;
        let digest = self
            .api
            .put_artefact(self.grant, self.attempt_id(), media_type, bytes)
            .map_err(|error| self.note(error))?;
        Ok(artefact_ref(&digest, media_type, bytes.len()))
    }

    /// Submit a result document as canonical JSON.
    ///
    /// # Errors
    /// [`Abandoned`] when the lease is ending, the attempt was lost or the API refuses it.
    pub fn submit(&self, route: ResultRoute, document: &Value) -> Result<(), Abandoned> {
        self.live()?;
        let bytes = canonical_json(document)
            .map_err(|e| Abandoned::Internal(format!("cannot write the result: {e}")))?;
        self.api
            .submit(self.grant, self.attempt_id(), route, bytes.as_bytes())
            .map_err(|error| self.note(error))
    }

    /// The duration of the job so far, as `connected-common` states it.
    #[must_use]
    pub fn duration(&self) -> Value {
        let elapsed = self.time.monotonic_ms().saturating_sub(self.started_ms);
        json!({"label": "observed", "milliseconds": elapsed.min(604_800_000)})
    }

    /// The elapsed milliseconds, for a log line.
    #[must_use]
    pub fn elapsed_ms(&self) -> u64 {
        self.time.monotonic_ms().saturating_sub(self.started_ms)
    }
}

/// The `ArtefactRef` object of stored bytes.
#[must_use]
pub fn artefact_ref(digest: &str, media_type: &str, size: usize) -> Value {
    json!({"digest": digest, "media_type": media_type, "size_bytes": size})
}

/// Parse stored bytes as the contract `T`.
///
/// # Errors
/// [`Abandoned::Unfit`] with the contract error.
pub fn parse_document<T: Payload>(bytes: &[u8], what: &str) -> Result<T, Abandoned> {
    let text = std::str::from_utf8(bytes)
        .map_err(|_| Abandoned::Unfit(format!("the {what} is not UTF-8")))?;
    parse::<T>(text).map_err(|error: ContractError| {
        Abandoned::Unfit(format!("the {what} is not a valid document: {error}"))
    })
}

/// The digest of canonical JSON bytes, for a check against a reference.
#[must_use]
pub fn bytes_digest(bytes: &[u8]) -> String {
    digest_bytes(bytes)
}

/// Cut `text` to at most `limit` characters, on a character boundary.
#[must_use]
pub fn clip(text: &str, limit: usize) -> String {
    text.chars().take(limit).collect()
}

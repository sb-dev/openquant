//! The worker loop: pull a job message, claim its attempt, run the job, upload and submit, then
//! acknowledge (OQ-05 section 4).
//!
//! The order is the point of this module.
//!
//! 1. A pulled message body is decoded by its content type and parsed as `job-dispatch/1`.
//!    Anything else is a poison message that the worker gives back with a long delay and never
//!    acknowledges.
//! 2. The attempt is claimed through `attempt-claim/1` before any input is read. The claim, not the
//!    queue lease, decides who may produce the official result. A claim is refused for an attempt
//!    that is claimed elsewhere, terminal or fenced: the message has no purpose any more, because
//!    recovery fences a new attempt with a new message when a lease ends, so the worker
//!    acknowledges it.
//! 3. The job runs under a deadline, the lease end minus a margin. It uploads immutable artefacts
//!    first and submits last.
//! 4. The message is acknowledged only after the submission was accepted. A job that ends without a
//!    result (the attempt was cancelled or fenced, the lease is about to end, the request is not one
//!    this binary can serve, the process stops) leaves its message unacknowledged: it comes back
//!    after the visibility timeout, the claim is then refused and the message is acknowledged.
//!    A crash anywhere before the acknowledgement has the same effect, and a lost acknowledgement
//!    after a committed result yields no second result: the claim of the redelivery is refused.
//!
//! The API has no lease-renewal route, so the lease cannot be extended. The worker keeps its job
//! inside the lease (the deadline), probes liveness during a long job and gives up before the
//! lease ends (see `JobContext::heartbeat`).

use std::{
    fmt,
    path::Path,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use openquant_contracts::{
    Envelope, canonical_json, generated as g, parse, payload_digest, validate,
};
use serde_json::json;

use super::{
    api::{ApiClient, ApiError},
    clock::Time,
    config::{Config, EvidenceRecord, LEASE_MARGIN_SECONDS},
    egress::{Class, Egress, Policy},
    identity::ExecutableId,
    jobs::{
        Abandoned, CancelToken, JobContext, JobResult, assess, evaluate, retrieve,
        validate as validate_job,
    },
    queue::{CloudflareQueue, Delivery, QueueError},
    wire::Wire,
};

/// The most API requests one job makes, retries included.
pub const API_REQUEST_BUDGET: u32 = 2_000;

/// The pause between two empty pulls grows from this many milliseconds to the next constant.
pub const IDLE_MIN_MS: u64 = 1_000;
pub const IDLE_MAX_MS: u64 = 30_000;

/// How long a message that cannot be processed yet is kept away from the next pull.
const POISON_DELAY: Duration = Duration::from_secs(3_600);
const CONFIG_DELAY: Duration = Duration::from_secs(300);
const TRANSIENT_DELAY: Duration = Duration::from_secs(30);

/// A request to stop. The worker finishes the job it holds and pulls no other.
#[derive(Clone, Debug, Default)]
pub struct StopFlag(Arc<AtomicBool>);

impl StopFlag {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    pub fn stop(&self) {
        self.0.store(true, Ordering::SeqCst);
    }

    #[must_use]
    pub fn is_stopped(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }
}

/// What became of one message.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Handled {
    /// The result was submitted and accepted. `acked` is false when the acknowledgement failed:
    /// the message comes back and its claim is refused.
    Completed { summary: String, acked: bool },
    /// The job ended without a result. The message was not acknowledged.
    Abandoned { reason: String },
    /// The claim was refused because the attempt is not claimable or is fenced. The message was
    /// acknowledged (`acked`): recovery owns the attempt.
    NotClaimable { code: String, acked: bool },
    /// The claim was refused for another reason. The message was given back with a delay.
    ClaimRefused { code: String, retried: bool },
    /// The body cannot be decoded (`UNSUPPORTED_QUEUE_ENCODING`, `MALFORMED_QUEUE_BODY`) or is
    /// not a `job-dispatch/1` (the contract failure code). The message was given back with a long
    /// delay.
    Poison { code: String, retried: bool },
    /// The message is for another environment. It was given back with a delay.
    WrongEnvironment { retried: bool },
}

/// What one poll found.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Polled {
    Idle,
    Message {
        message_id: String,
        handled: Handled,
    },
}

/// Why the worker cannot go on.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum WorkerError {
    /// A credential was refused. Retrying does not help.
    Unauthorized(String),
    /// The queue could not be pulled from.
    Queue(QueueError),
    /// The worker is misconfigured.
    Setup(String),
}

impl fmt::Display for WorkerError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Unauthorized(what) => write!(f, "{what} was refused"),
            Self::Queue(error) => write!(f, "{error}"),
            Self::Setup(why) => write!(f, "worker setup: {why}"),
        }
    }
}

impl std::error::Error for WorkerError {}

/// A log sink. A line holds ids, kinds and counts, never a credential, a URL or a payload.
pub type Log = Arc<dyn Fn(&str) + Send + Sync>;

/// The batch worker.
pub struct Worker {
    config: Arc<Config>,
    policy: Arc<Policy>,
    wire: Arc<dyn Wire>,
    time: Arc<dyn Time>,
    executable: ExecutableId,
    worker_id: String,
    evidence: Option<EvidenceRecord>,
    stop: StopFlag,
    log: Log,
}

impl fmt::Debug for Worker {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Worker")
            .field("worker_id", &self.worker_id)
            .field("environment", &self.config.environment)
            .finish_non_exhaustive()
    }
}

fn plain_identifier(text: &str) -> bool {
    let mut chars = text.chars();
    text.len() <= 64
        && chars.next().is_some_and(|c| c.is_ascii_alphanumeric())
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | ':' | '-'))
}

impl Worker {
    /// A worker over `wire`. `worker_id` is recorded with each claim for diagnosis and grants no
    /// authority.
    ///
    /// # Errors
    /// [`WorkerError::Setup`] when the worker id is not an identifier or the queue identifiers
    /// do not fit the egress policy.
    pub fn new(
        config: Config,
        wire: Arc<dyn Wire>,
        time: Arc<dyn Time>,
        executable: ExecutableId,
        worker_id: &str,
        log: Log,
    ) -> Result<Self, WorkerError> {
        if !plain_identifier(worker_id) {
            return Err(WorkerError::Setup(
                "the worker id is not an identifier".to_owned(),
            ));
        }
        let policy = Policy::batch(&config.api, &config.queue_account_id, &config.queue_id)
            .map_err(|e| WorkerError::Setup(e.to_string()))?;
        let evidence = EvidenceRecord::load(&config);
        Ok(Self {
            config: Arc::new(config),
            policy: Arc::new(policy),
            wire,
            time,
            executable,
            worker_id: worker_id.to_owned(),
            evidence,
            stop: StopFlag::new(),
            log,
        })
    }

    /// The flag that stops the loop after the current job.
    #[must_use]
    pub fn stop_flag(&self) -> StopFlag {
        self.stop.clone()
    }

    fn say(&self, line: &str) {
        (self.log)(line);
    }

    fn egress(&self) -> Egress {
        Egress::new(self.policy.clone(), self.wire.clone())
    }

    fn stop_requested(&self) -> bool {
        self.stop.is_stopped() || self.config.stop_file.as_deref().is_some_and(Path::exists)
    }

    /// Pull at most one message and handle it.
    ///
    /// # Errors
    /// [`WorkerError`] when the queue token is refused or a pull fails.
    pub fn poll_once(&self) -> Result<Polled, WorkerError> {
        let queue_egress = self.egress();
        let queue = CloudflareQueue::new(
            &queue_egress,
            &self.config.queue_account_id,
            &self.config.queue_id,
            self.config.queue_token.clone(),
        );
        let mut deliveries =
            queue
                .pull(1, self.config.visibility)
                .map_err(|error| match error {
                    QueueError::Unauthorized => {
                        WorkerError::Unauthorized("the queue token".to_owned())
                    }
                    other => WorkerError::Queue(other),
                })?;
        let Some(delivery) = deliveries.pop() else {
            return Ok(Polled::Idle);
        };
        let message_id = delivery.id().to_owned();
        let handled = self.handle(&queue, delivery)?;
        Ok(Polled::Message {
            message_id,
            handled,
        })
    }

    /// Give a message back; true when the queue took it.
    fn give_back(&self, queue: &CloudflareQueue<'_>, delivery: Delivery, delay: Duration) -> bool {
        match queue.retry(delivery, delay) {
            Ok(()) => true,
            Err(error) => {
                self.say(&format!("could not give a message back: {error}"));
                false
            }
        }
    }

    fn acknowledge(&self, queue: &CloudflareQueue<'_>, delivery: Delivery) -> bool {
        match queue.ack(delivery) {
            Ok(()) => true,
            Err(error) => {
                self.say(&format!(
                    "acknowledgement failed, the message will come back: {error}"
                ));
                false
            }
        }
    }

    fn handle(
        &self,
        queue: &CloudflareQueue<'_>,
        delivery: Delivery,
    ) -> Result<Handled, WorkerError> {
        let text = match delivery.body() {
            Ok(text) => text,
            Err(undecodable) => {
                // The log names the content type, never the body.
                let code = undecodable.code().to_owned();
                self.say(&format!(
                    "message {} has a body that cannot be decoded ({code}, content type {}): \
                     given back",
                    delivery.id(),
                    undecodable.content_type()
                ));
                let retried = self.give_back(queue, delivery, POISON_DELAY);
                return Ok(Handled::Poison { code, retried });
            }
        };
        let dispatch: g::JobDispatch = match parse(text) {
            Ok(dispatch) => dispatch,
            Err(error) => {
                let code = error.failure_code().to_string();
                self.say(&format!(
                    "message {} is not a job-dispatch/1 ({code}): given back",
                    delivery.id()
                ));
                let retried = self.give_back(queue, delivery, POISON_DELAY);
                return Ok(Handled::Poison { code, retried });
            }
        };
        if dispatch.environment.to_string() != self.config.environment {
            self.say(&format!(
                "message {} is for another environment: given back",
                delivery.id()
            ));
            let retried = self.give_back(queue, delivery, CONFIG_DELAY);
            return Ok(Handled::WrongEnvironment { retried });
        }
        let dispatch_digest = match payload_digest(&dispatch) {
            Ok(digest) => digest,
            Err(error) => {
                let code = error.failure_code().to_string();
                let retried = self.give_back(queue, delivery, POISON_DELAY);
                return Ok(Handled::Poison { code, retried });
            }
        };

        // One egress per job: its own budgets, over the shared policy and wire.
        let egress = self.egress().with_limit(Class::Api, API_REQUEST_BUDGET);
        let api = ApiClient::new(
            &egress,
            self.config.api.host(),
            &self.config.api_token,
            self.time.as_ref(),
        );
        let attempt_id = dispatch.attempt.attempt_id.as_str().to_owned();
        let claim = json!({
            "schema_version": "attempt-claim/1",
            "form": "claim",
            "attempt": {
                "attempt_id": attempt_id,
                "ownership_revision": dispatch.attempt.ownership_revision.get(),
            },
            "dispatch_digest": dispatch_digest,
            "executable": self.executable.to_value(),
            "worker_id": self.worker_id,
        });
        if let Err(error) = validate(Envelope::AttemptClaim, &claim) {
            return Err(WorkerError::Setup(format!(
                "the claim is not valid: {error}"
            )));
        }
        let claim_bytes = canonical_json(&claim)
            .map_err(|e| WorkerError::Setup(format!("the claim cannot be written: {e}")))?;
        let grant = match api.claim(&attempt_id, claim_bytes.as_bytes()) {
            Ok(grant) => grant,
            Err(error) => return self.claim_refused(queue, delivery, &attempt_id, &error),
        };
        let deadline = grant.lease_expires_at.add_seconds(-LEASE_MARGIN_SECONDS);
        let cancel = CancelToken::new();
        let cx = JobContext::new(
            &self.config,
            &api,
            &egress,
            self.time.as_ref(),
            &grant,
            &self.executable,
            self.evidence.as_ref(),
            &dispatch,
            &cancel,
            deadline,
        );
        let kind = match &dispatch.inputs {
            g::JobInputs::RetrieveJobInputs(_) => "retrieve",
            g::JobInputs::ValidateJobInputs(_) => "validate",
            g::JobInputs::EvaluateJobInputs(_) => "evaluate",
            g::JobInputs::AssessJobInputs(_) => "assess",
        };
        self.say(&format!(
            "attempt {attempt_id} claimed: {kind} job {}",
            dispatch.job_id.as_str()
        ));
        let result: JobResult = if self.time.now() >= deadline {
            Err(Abandoned::Deadline)
        } else {
            match &dispatch.inputs {
                g::JobInputs::RetrieveJobInputs(inputs) => retrieve::run(&cx, inputs),
                g::JobInputs::ValidateJobInputs(inputs) => validate_job::run(&cx, inputs),
                g::JobInputs::EvaluateJobInputs(inputs) => evaluate::run(&cx, inputs),
                g::JobInputs::AssessJobInputs(inputs) => assess::run(&cx, inputs),
            }
        };
        match result {
            Ok(submitted) => {
                self.say(&format!(
                    "attempt {attempt_id} {kind} done in {} ms: {}",
                    cx.elapsed_ms(),
                    submitted.summary
                ));
                // The result is committed: now, and only now, acknowledge.
                let acked = self.acknowledge(queue, delivery);
                Ok(Handled::Completed {
                    summary: submitted.summary,
                    acked,
                })
            }
            Err(abandoned) => {
                self.say(&format!(
                    "attempt {attempt_id} {kind} abandoned: {abandoned}"
                ));
                Ok(Handled::Abandoned {
                    reason: abandoned.to_string(),
                })
            }
        }
    }

    fn claim_refused(
        &self,
        queue: &CloudflareQueue<'_>,
        delivery: Delivery,
        attempt_id: &str,
        error: &ApiError,
    ) -> Result<Handled, WorkerError> {
        let code = error
            .code()
            .map_or_else(|| "UNREACHABLE".to_owned(), str::to_owned);
        self.say(&format!("attempt {attempt_id} not claimed ({code})"));
        match code.as_str() {
            // Not PENDING any more: claimed elsewhere, terminal, cancelled or fenced. Recovery
            // decides what happens to the attempt and sends a new message when it fences one.
            "ATTEMPT_NOT_CLAIMABLE" | "STALE_OWNERSHIP" => {
                let acked = self.acknowledge(queue, delivery);
                Ok(Handled::NotClaimable { code, acked })
            }
            "UNAUTHENTICATED" | "FORBIDDEN" => {
                Err(WorkerError::Unauthorized("the batch credential".to_owned()))
            }
            "RATE_LIMITED" | "UNAVAILABLE" | "INTERNAL" | "UNREACHABLE" => {
                let retried = self.give_back(queue, delivery, TRANSIENT_DELAY);
                Ok(Handled::ClaimRefused { code, retried })
            }
            _ => {
                let retried = self.give_back(queue, delivery, CONFIG_DELAY);
                Ok(Handled::ClaimRefused { code, retried })
            }
        }
    }

    /// Pull and handle messages until a stop is requested.
    ///
    /// # Errors
    /// [`WorkerError::Unauthorized`] when a credential is refused.
    pub fn run(&self) -> Result<(), WorkerError> {
        let mut idle = IDLE_MIN_MS;
        while !self.stop_requested() {
            match self.poll_once() {
                Ok(Polled::Message { .. }) => idle = IDLE_MIN_MS,
                Ok(Polled::Idle) => {
                    self.pause(idle);
                    idle = (idle * 2).min(IDLE_MAX_MS);
                }
                Err(error @ WorkerError::Unauthorized(_)) => return Err(error),
                Err(error) => {
                    self.say(&format!("pull failed: {error}"));
                    self.pause(idle);
                    idle = (idle * 2).min(IDLE_MAX_MS);
                }
            }
        }
        Ok(())
    }

    /// Sleep `milliseconds` in slices of a second, so that a stop is seen at once.
    fn pause(&self, milliseconds: u64) {
        let mut left = milliseconds;
        while left > 0 && !self.stop_requested() {
            let slice = left.min(1_000);
            self.time.sleep_ms(slice);
            left -= slice;
        }
    }
}

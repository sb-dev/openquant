//! The harness of the batch tests: a fake world, a worker over it, and builders for the
//! documents of each job kind.

#![allow(
    dead_code,
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use std::{
    collections::BTreeMap,
    fs,
    panic::{AssertUnwindSafe, catch_unwind},
    path::PathBuf,
    sync::{
        Arc, Mutex, MutexGuard,
        atomic::{AtomicUsize, Ordering},
    },
};

use openquant_contracts::{
    canonical::digest_bytes,
    generated::{EvaluationRequest, JobDispatch, RetrievalRequest},
    parse,
};
use openquant_engine::batch::{
    config::{self, Config},
    identity::ExecutableId,
    worker::{Log, Polled, Worker},
};
use serde_json::{Value, json};

use super::{
    data::{S0Case, canonical, cohort_policy, engine, execution_policy, method, session_dates},
    world::{Crash, FakeTime, FakeWire, World},
};

pub const START: &str = "2026-11-14T10:00:00Z";

/// A queued job: the attempt and the dispatch that names it.
#[derive(Clone, Debug)]
pub struct Enqueued {
    pub message: String,
    pub attempt_id: String,
    pub job_id: String,
    pub request: Value,
}

pub struct Harness {
    pub world: Arc<Mutex<World>>,
    pub time: Arc<FakeTime>,
    pub wire: Arc<FakeWire>,
    pub vars: BTreeMap<String, String>,
    pub logs: Arc<Mutex<Vec<String>>>,
    pub executable: ExecutableId,
    workers: AtomicUsize,
}

impl Harness {
    pub fn new() -> Self {
        let time = FakeTime::at(START);
        let world = World::new(time.clone());
        let vars = BTreeMap::from([
            (config::ENV_ENVIRONMENT.to_owned(), "STAGING".to_owned()),
            (
                config::ENV_API_URL.to_owned(),
                format!("https://{}", world.api_host),
            ),
            (
                config::ENV_API_TOKEN.to_owned(),
                world.service_token.clone(),
            ),
            (
                config::ENV_QUEUE_ACCOUNT.to_owned(),
                world.queue_account.clone(),
            ),
            (config::ENV_QUEUE_ID.to_owned(), world.queue_id.clone()),
            (
                config::ENV_QUEUE_TOKEN.to_owned(),
                world.queue_token.clone(),
            ),
        ]);
        let world = Arc::new(Mutex::new(world));
        Self {
            wire: Arc::new(FakeWire(world.clone())),
            world,
            time,
            vars,
            logs: Arc::new(Mutex::new(Vec::new())),
            executable: Self::default_executable(),
            workers: AtomicUsize::new(0),
        }
    }

    /// A harness whose clock starts at `start`.
    pub fn starting_at(start: &str) -> Self {
        let mut harness = Self::new();
        harness.time = FakeTime::at(start);
        let mut world = harness.world();
        world.time = harness.time.clone();
        drop(world);
        harness
    }

    pub fn set(&mut self, name: &str, value: &str) {
        self.vars.insert(name.to_owned(), value.to_owned());
    }

    pub fn world(&self) -> MutexGuard<'_, World> {
        self.world
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    pub fn config(&self) -> Config {
        Config::from_lookup(&|name| self.vars.get(name).cloned()).expect("the test configuration")
    }

    pub fn default_executable() -> ExecutableId {
        ExecutableId {
            name: "engine-batch".to_owned(),
            version: "0.0.0".to_owned(),
            digest: digest_bytes(b"the executable of the test"),
        }
    }

    /// A new worker over the same world: a restarted process.
    pub fn worker(&self) -> Worker {
        let number = self.workers.fetch_add(1, Ordering::SeqCst);
        let logs = self.logs.clone();
        let log: Log = Arc::new(move |line: &str| logs.lock().unwrap().push(line.to_owned()));
        Worker::new(
            self.config(),
            self.wire.clone(),
            self.time.clone(),
            self.executable.clone(),
            &format!("test-worker-{number}"),
            log,
        )
        .expect("the worker")
    }

    pub fn poll(&self) -> Polled {
        self.worker().poll_once().expect("a poll")
    }

    /// Poll with a worker whose process may die: `None` when the fake world killed it.
    pub fn poll_catching(&self) -> Option<Polled> {
        let worker = self.worker();
        match catch_unwind(AssertUnwindSafe(|| worker.poll_once())) {
            Ok(polled) => Some(polled.expect("a poll")),
            Err(payload) if payload.is::<Crash>() => None,
            Err(payload) => std::panic::resume_unwind(payload),
        }
    }

    pub fn log_text(&self) -> String {
        self.logs.lock().unwrap().join("\n")
    }

    /// Write the recorded provider evidence and point the configuration at it.
    pub fn record_evidence(&mut self, verified: bool) -> PathBuf {
        let constraints = json!({
            "redistribution_permitted": false,
            "retain_raw": true,
            "terms_ref": "docs/reference/service-providers.md#alpaca",
        });
        let licence = "Synthetic Alpaca-shaped values on an invented instrument, generated for this repository under Apache-2.0. Not provider data.";
        self.record_evidence_with(verified, constraints, licence)
    }

    /// The same with the recorded terms of a market-data case.
    pub fn record_evidence_with(
        &mut self,
        verified: bool,
        constraints: Value,
        licence: &str,
    ) -> PathBuf {
        let fact = |name: &str| {
            if verified || name != "declaration_field" {
                json!("verified")
            } else {
                json!({"failed": "the field is absent from a real response"})
            }
        };
        let evidence = json!({
            "schema": config::EVIDENCE_SCHEMA,
            "facts": {
                "paper_authority": fact("paper_authority"),
                "no_live_authority": fact("no_live_authority"),
                "data_entitlement": fact("data_entitlement"),
                "session_semantics": fact("session_semantics"),
                "egress_refusals": fact("egress_refusals"),
                "declaration_field": fact("declaration_field"),
            },
            "constraints": constraints,
            "licence": licence,
        });
        let dir = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join("batch-evidence");
        fs::create_dir_all(&dir).unwrap();
        static COUNTER: AtomicUsize = AtomicUsize::new(0);
        let path = dir.join(format!(
            "evidence-{}-{}.json",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::SeqCst)
        ));
        fs::write(&path, evidence.to_string()).unwrap();
        self.set(config::ENV_PROVIDER_EVIDENCE, path.to_str().unwrap());
        path
    }
}

/// The disposition of the message `message` in what a poll found.
pub fn worker_handled(polled: &Polled, message: &str) -> openquant_engine::batch::worker::Handled {
    match polled {
        Polled::Message {
            message_id,
            handled,
        } => {
            assert_eq!(message_id, message, "the poll handled another message");
            handled.clone()
        }
        Polled::Idle => panic!("the poll found no message"),
    }
}

pub fn dispatch_value(job_id: &str, attempt_id: &str, revision: u64, inputs: Value) -> Value {
    let dispatch = json!({
        "schema_version": "job-dispatch/1",
        "environment": "STAGING",
        "job_id": job_id,
        "attempt": {"attempt_id": attempt_id, "ownership_revision": revision},
        "mission_id": "msn-synth-0001",
        "dispatched_at": START,
        "inputs": inputs,
    });
    let _: JobDispatch = parse(&dispatch.to_string()).expect("the dispatch is valid");
    dispatch
}

impl Harness {
    fn enqueue_job(
        &self,
        job_id: &str,
        attempt_id: &str,
        inputs: Value,
        request: Value,
    ) -> Enqueued {
        self.enqueue_job_at(job_id, attempt_id, 1, inputs, request)
    }

    fn enqueue_job_at(
        &self,
        job_id: &str,
        attempt_id: &str,
        revision: u64,
        inputs: Value,
        request: Value,
    ) -> Enqueued {
        let dispatch = dispatch_value(job_id, attempt_id, revision, inputs);
        let message = self.world().enqueue(&dispatch);
        Enqueued {
            message,
            attempt_id: attempt_id.to_owned(),
            job_id: job_id.to_owned(),
            request,
        }
    }

    /// An evaluate job that replays the frozen input of an S0 case.
    pub fn enqueue_replay(&self, case: &S0Case, tag: &str) -> Enqueued {
        self.enqueue_replay_attempt(case, tag, 1)
    }

    /// The `attempt`th attempt (and ownership revision) of the replay run of `tag`.
    pub fn enqueue_replay_attempt(&self, case: &S0Case, tag: &str, attempt: u64) -> Enqueued {
        let run_id = format!("run-s0-{tag}");
        let attempt_id = format!("att-s0-{tag}-{attempt}");
        let mut world = self.world();
        let strategy_ref = world.store_json(&case.strategy);
        let input_ref = world.store_json(&case.input);
        let request = json!({
            "schema_version": "evaluation-request/1",
            "run_id": run_id,
            "attempt": {"attempt_id": attempt_id, "ownership_revision": attempt},
            "mode": "REPLAY",
            "environment": "STAGING",
            "engine": engine(),
            "method": method(),
            "strategy": {
                "strategy_id": case.strategy["strategy_id"],
                "version": case.strategy["version"],
                "artefact": strategy_ref,
            },
            "conditions": {"fixture_set": "s0", "case_id": case.id},
            "input": {"source": "INPUT_REFERENCE", "input": input_ref},
        });
        let _: EvaluationRequest = parse(&request.to_string()).expect("the request is valid");
        let request_ref = world.store_json(&request);
        drop(world);
        self.enqueue_job_at(
            &run_id,
            &attempt_id,
            attempt,
            json!({"kind": "evaluate", "request": request_ref}),
            request,
        )
    }

    /// An evaluate job over a provider manifest. Sessions are indices into the manifest calendar.
    pub fn enqueue_backtest(&self, spec: &BacktestSpec<'_>) -> Enqueued {
        let dates: Vec<String> = spec.manifest["content"]["calendar"]
            .as_array()
            .unwrap()
            .iter()
            .map(|row| row["session"].as_str().unwrap().to_owned())
            .collect();
        let mut world = self.world();
        let manifest_ref = world.store_json(spec.manifest);
        let strategy_ref = world.store_json(spec.strategy);
        let policy = cohort_policy();
        let policy_ref = world.store_json(&policy);
        let request = json!({
            "schema_version": "evaluation-request/1",
            "run_id": spec.run_id,
            "attempt": {"attempt_id": spec.attempt_id, "ownership_revision": 1},
            "mission_id": "msn-synth-0001",
            "mode": "BACKTEST",
            "environment": "STAGING",
            "engine": engine(),
            "method": method(),
            "strategy": {
                "strategy_id": spec.strategy["strategy_id"],
                "version": spec.strategy["version"],
                "artefact": strategy_ref,
            },
            "conditions": {
                "profile": spec.profile.clone().unwrap_or_else(|| spec.manifest["source"]["profile"].clone()),
                "cohort_policy": {
                    "id": policy["policy_id"],
                    "revision": policy["revision"],
                    "digest": policy_ref["digest"],
                },
                "suite_id": policy["suite_id"],
                "plan_digest": digest_bytes(b"the plan of the test"),
                "trial_slot": "seed",
                "run_slot": format!("seed.{}.{}", spec.window.to_lowercase(), spec.scenario.to_lowercase()),
                "window_role": spec.window,
                "cost_scenario": spec.scenario,
            },
            "input": {
                "source": "PROVIDER_MANIFEST",
                "manifest": manifest_ref,
                "windows": spec.windows.clone().unwrap_or_else(|| json!({
                    "warmup_start": dates[spec.warmup],
                    "scored_start": dates[spec.scored_start],
                    "scored_end": dates[spec.scored_end],
                    "information_cutoff": format!("{}T23:00:00Z", dates[spec.scored_end]),
                })),
                "initial_capital": "100000",
                "policy": spec.policy.clone().unwrap_or_else(|| execution_policy(spec.scale)),
                "seed": 0,
            },
            "holdout_exclusions": [],
        });
        let _: EvaluationRequest = parse(&request.to_string()).expect("the request is valid");
        let request_ref = world.store_json(&request);
        drop(world);
        self.enqueue_job(
            spec.run_id,
            spec.attempt_id,
            json!({"kind": "evaluate", "request": request_ref}),
            request,
        )
    }

    /// A retrieve job for the request of a market-data case (its `request` member).
    pub fn enqueue_retrieve(&self, request: &Value, tag: &str) -> Enqueued {
        let _: RetrievalRequest = parse(&request.to_string()).expect("the request is valid");
        let job_id = request["job_id"].as_str().unwrap().to_owned();
        let attempt_id = request["attempt"]["attempt_id"]
            .as_str()
            .unwrap()
            .to_owned();
        let request_ref = self.world().store_json(request);
        let _ = tag;
        self.enqueue_job(
            &job_id,
            &attempt_id,
            json!({"kind": "retrieve", "request": request_ref}),
            request.clone(),
        )
    }

    /// A validate job. `parent` is the registered parent of a revision.
    pub fn enqueue_validate(&self, draft: &Value, parent: Option<&Value>, tag: &str) -> Enqueued {
        let job_id = format!("job-validate-{tag}");
        let attempt_id = format!("att-validate-{tag}-1");
        let mut world = self.world();
        let draft_ref = world.store_json(draft);
        let policy_ref = world.store_json(&cohort_policy());
        let mut inputs = json!({
            "kind": "validate",
            "draft": draft_ref,
            "cohort_policy": policy_ref,
        });
        if let Some(parent) = parent {
            inputs["parent"] = world.store_json(parent);
        }
        drop(world);
        self.enqueue_job(&job_id, &attempt_id, inputs, Value::Null)
    }
}

/// The parameters of a provider evaluate job.
pub struct BacktestSpec<'a> {
    pub manifest: &'a Value,
    pub strategy: &'a Value,
    pub scale: u32,
    pub warmup: usize,
    pub scored_start: usize,
    pub scored_end: usize,
    pub window: &'a str,
    pub scenario: &'a str,
    pub run_id: &'a str,
    pub attempt_id: &'a str,
    pub policy: Option<Value>,
    /// Replace the windows of the request (a test of a window that does not fit).
    pub windows: Option<Value>,
    /// Replace the profile that the request names (a test of a manifest of another profile).
    pub profile: Option<Value>,
}

impl<'a> BacktestSpec<'a> {
    /// A development, base-cost run of the sessions from index 60 to the last of the manifest,
    /// warmed up from the first, at price scale 2.
    pub fn new(
        manifest: &'a Value,
        strategy: &'a Value,
        run_id: &'a str,
        attempt_id: &'a str,
    ) -> Self {
        let sessions = manifest["content"]["calendar"].as_array().unwrap().len();
        Self {
            manifest,
            strategy,
            scale: 2,
            warmup: 0,
            scored_start: 60,
            scored_end: sessions - 1,
            window: "DEVELOPMENT",
            scenario: "BASE",
            run_id,
            attempt_id,
            policy: None,
            windows: None,
            profile: None,
        }
    }
}

/// The sessions of a synthetic manifest, for a window rule in the tests.
pub fn dates_of(manifest: &Value) -> Vec<String> {
    manifest["content"]["calendar"]
        .as_array()
        .unwrap()
        .iter()
        .map(|row| row["session"].as_str().unwrap().to_owned())
        .collect()
}

pub fn first_dates(count: usize) -> Vec<String> {
    session_dates(count)
}

pub fn canonical_text(value: &Value) -> String {
    canonical(value)
}

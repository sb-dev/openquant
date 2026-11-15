//! The `evaluate` job: one run of the shared core (OQ-05 sections 4 and 7; OQ-02 section 3.6).
//!
//! The job never forks the evaluator. It builds the inner `evaluation-input/1` (for a provider
//! run, from the frozen dataset manifest and the request), prepares the run with `Run::prepare`,
//! steps it to the end with the same `Run::run_events` that `run_to_end` uses, writes the result,
//! derives the metrics of a completed run and submits the bindings.
//!
//! Binding. The worker refuses a request whose run, attempt, environment, required engine digest
//! and operator set or method identity are not those of this binary, before it does any work: its
//! submission would be refused. A document that does not bind to its request in a way that the API
//! can report (a manifest of another profile, a window that is not a session, an input that fails
//! `Run::prepare`) is reported as `NOT_PREPARED` with the core's failure code.
//!
//! A REPLAY request carries no cohort policy, so its metrics use the stated convention below.

use openquant_contracts::{
    Contract, EvaluationInput, StrategyArtefact, canonical::digest_bytes, canonical_json,
    generated as g, payload_digest, to_value, validate,
};
use openquant_core::{
    Failure, Run, State,
    interfaces::MarketEvent,
    metrics::{MetricsContext, Scenario, Window, compute_metrics},
};
use serde_json::{Value, json};

use super::{Abandoned, JSON_MEDIA_TYPE, JobContext, JobResult, Submitted, clip};
use crate::batch::{
    api::ResultRoute,
    identity::{OPERATOR_SET, running_engine_digest, running_method},
    input::build_input,
    journal::{CHUNKS_PER_CHECKPOINT, Journal},
};

/// The most events of one chunk between two liveness checks (three events per session).
pub const CHUNK_EVENTS: usize = 30;

/// A result is stored as one artefact within the cohort limit of 8 MiB (decision record, output
/// limit). The largest result within the S0 limits is 2,369,582 bytes.
pub const RESULT_LIMIT_BYTES: usize = 8 * 1024 * 1024;

/// A REPLAY request has no window role, cost scenario, metric scale or uncertainty limitation:
/// its metrics use the development window, the base scenario, the pilot's metric scale and the
/// text below. They describe the replay of a frozen input, not a mission trial.
pub const REPLAY_WINDOW: Window = Window::Development;
pub const REPLAY_SCENARIO: Scenario = Scenario::Base;
pub const REPLAY_METRIC_SCALE: u32 = 6;
pub const REPLAY_LIMITATION: &str = "Not computed. This is a replay of a frozen input: no uncertainty method applies (OQ-02 section 3.6).";

fn text<'v>(value: &'v Value, pointer: &str) -> Result<&'v str, Abandoned> {
    value
        .pointer(pointer)
        .and_then(Value::as_str)
        .ok_or_else(|| Abandoned::Unfit(format!("the request has no {pointer}")))
}

/// The members of a request that both forms share, checked against what this binary is.
struct Bound {
    value: Value,
    mode: String,
    run_id: String,
}

fn bind(
    cx: &JobContext<'_>,
    request_digest: &str,
    request: &g::EvaluationRequest,
) -> Result<Bound, Abandoned> {
    let value = to_value(request).map_err(|e| Abandoned::Internal(format!("request: {e}")))?;
    let actual =
        payload_digest(request).map_err(|e| Abandoned::Internal(format!("request: {e}")))?;
    if actual != request_digest {
        return Err(Abandoned::Unfit(
            "the stored request is not in canonical form".to_owned(),
        ));
    }
    let run_id = text(&value, "/run_id")?.to_owned();
    if run_id != cx.dispatch.job_id.as_str() {
        return Err(Abandoned::Unfit(
            "the request is for another run than the dispatch".to_owned(),
        ));
    }
    if text(&value, "/attempt/attempt_id")? != cx.attempt_id()
        || value
            .pointer("/attempt/ownership_revision")
            .and_then(Value::as_u64)
            != Some(cx.dispatch.attempt.ownership_revision.get())
    {
        return Err(Abandoned::Unfit(
            "the request names another attempt or ownership revision than the dispatch".to_owned(),
        ));
    }
    let environment = text(&value, "/environment")?;
    if environment != cx.config.environment || environment != cx.dispatch.environment.to_string() {
        return Err(Abandoned::Unfit(
            "the request is for another environment than this deployment".to_owned(),
        ));
    }
    let engine = running_engine_digest().map_err(Abandoned::Internal)?;
    if text(&value, "/engine/engine_digest")? != engine {
        return Err(Abandoned::Unfit(
            "the request requires another engine digest than the one that runs".to_owned(),
        ));
    }
    if text(&value, "/engine/operator_set")? != OPERATOR_SET {
        return Err(Abandoned::Unfit(
            "the request requires another operator set than the one that runs".to_owned(),
        ));
    }
    let method = running_method();
    if text(&value, "/method/name")? != method.name
        || text(&value, "/method/version")? != method.version
        || text(&value, "/method/digest")? != method.digest
    {
        return Err(Abandoned::Unfit(
            "the request requires another method identity than the one that runs".to_owned(),
        ));
    }
    let mode = text(&value, "/mode")?.to_owned();
    Ok(Bound {
        value,
        mode,
        run_id,
    })
}

/// What the metrics of a run need from the request and the cohort policy.
struct MetricsFacts {
    window: Window,
    scenario: Scenario,
    metric_scale: u32,
    limitation: String,
}

fn metrics_facts(cx: &JobContext<'_>, bound: &Bound) -> Result<MetricsFacts, Abandoned> {
    if bound.mode == "REPLAY" {
        return Ok(MetricsFacts {
            window: REPLAY_WINDOW,
            scenario: REPLAY_SCENARIO,
            metric_scale: REPLAY_METRIC_SCALE,
            limitation: REPLAY_LIMITATION.to_owned(),
        });
    }
    let window = Window::from_wire(text(&bound.value, "/conditions/window_role")?)
        .ok_or_else(|| Abandoned::Unfit("the request names an unknown window role".to_owned()))?;
    let scenario = Scenario::from_wire(text(&bound.value, "/conditions/cost_scenario")?)
        .ok_or_else(|| Abandoned::Unfit("the request names an unknown cost scenario".to_owned()))?;
    let digest = text(&bound.value, "/conditions/cohort_policy/digest")?;
    let policy: g::CohortPolicy = cx.fetch_contract(digest, "cohort policy")?;
    let policy_value =
        to_value(&policy).map_err(|e| Abandoned::Internal(format!("policy: {e}")))?;
    let metric_scale = policy_value
        .pointer("/metrics/metric_scale")
        .and_then(Value::as_u64)
        .and_then(|n| u32::try_from(n).ok())
        .ok_or_else(|| Abandoned::Unfit("the cohort policy states no metric scale".to_owned()))?;
    let limitation = policy_value
        .pointer("/metrics/uncertainty/limitation")
        .and_then(Value::as_str)
        .ok_or_else(|| Abandoned::Unfit("the cohort policy states no limitation".to_owned()))?
        .to_owned();
    Ok(MetricsFacts {
        window,
        scenario,
        metric_scale,
        limitation,
    })
}

/// The submission of a run that could not start.
fn not_prepared(
    cx: &JobContext<'_>,
    bound: &Bound,
    request_digest: &str,
    failure: &Failure,
    input: Option<Value>,
) -> JobResult {
    let mut evaluation = json!({
        "status": "NOT_PREPARED",
        "code": failure.code.to_string(),
        "detail": clip(&failure.detail, 1000),
    });
    if let (Some(input), Some(object)) = (input, evaluation.as_object_mut()) {
        object.insert("input".to_owned(), input);
    }
    let engine = running_engine_digest().map_err(Abandoned::Internal)?;
    submit_evaluation(cx, bound, request_digest, &engine, evaluation)?;
    Ok(Submitted {
        summary: format!("evaluation-submission NOT_PREPARED {}", failure.code),
    })
}

fn submit_evaluation(
    cx: &JobContext<'_>,
    bound: &Bound,
    request_digest: &str,
    engine_digest: &str,
    evaluation: Value,
) -> Result<(), Abandoned> {
    let document = json!({
        "schema_version": "evaluation-submission/1",
        "run_id": bound.run_id,
        "attempt": cx.attempt(),
        "request_digest": request_digest,
        "mode": bound.mode,
        "environment": cx.config.environment,
        "executable": cx.executable.to_value(),
        "engine_digest": engine_digest,
        "method": running_method().to_value(),
        "evaluation": evaluation,
        "duration": cx.duration(),
    });
    validate(
        openquant_contracts::Envelope::EvaluationSubmission,
        &document,
    )
    .map_err(|e| Abandoned::Internal(format!("the submission breaks its schema: {e}")))?;
    cx.submit(ResultRoute::Evaluation, &document)
}

/// How far the stepping got.
struct Stepped {
    state: State,
    failure: Option<Failure>,
    /// The cursor of the checkpoint that the run resumed from, when it did.
    resumed_from: Option<String>,
}

/// Run the events through the core in chunks, with a liveness check between chunks. The state and
/// the failure are those of `Run::run_to_end`. With a journal the run resumes from a verified
/// checkpoint of an earlier attempt and writes one every few chunks.
fn step_all(
    cx: &JobContext<'_>,
    run: &Run,
    probe_digest: &str,
    journal: Option<&Journal>,
) -> Result<Stepped, Abandoned> {
    let initial = run
        .initial_state()
        .map_err(|f| Abandoned::Internal(format!("initial state: {}", f.detail)))?;
    let resumed = journal.and_then(|journal| journal.resume(run));
    let resumed_from = resumed.as_ref().map(|state| {
        state
            .next
            .as_ref()
            .map_or_else(|| "the end".to_owned(), ToString::to_string)
    });
    let mut state = resumed.unwrap_or(initial);
    let events: Vec<MarketEvent> = match run.events() {
        Ok(events) => events,
        Err(failure) => {
            return Ok(Stepped {
                state,
                failure: Some(failure),
                resumed_from,
            });
        }
    };
    // As `Run::run_to_end` does: the events from the state's cursor on.
    let remaining: Vec<MarketEvent> = match &state.next {
        None => Vec::new(),
        Some(next) => events
            .into_iter()
            .skip_while(|event| &event.cursor != next)
            .collect(),
    };
    for (index, chunk) in remaining.chunks(CHUNK_EVENTS).enumerate() {
        cx.heartbeat(probe_digest)?;
        let (next, failure) = run.run_events(state, chunk);
        state = next;
        if failure.is_some() {
            return Ok(Stepped {
                state,
                failure,
                resumed_from,
            });
        }
        if let Some(journal) = journal
            && (index + 1) % CHUNKS_PER_CHECKPOINT == 0
        {
            journal.save(run, &state);
        }
    }
    Ok(Stepped {
        state,
        failure: None,
        resumed_from,
    })
}

/// The strategy of the request, checked against its reference.
fn strategy_of(cx: &JobContext<'_>, bound: &Bound) -> Result<StrategyArtefact, Abandoned> {
    let digest = text(&bound.value, "/strategy/artefact/digest")?;
    let strategy: StrategyArtefact = cx.fetch_contract(digest, "strategy artefact")?;
    let actual =
        payload_digest(&strategy).map_err(|e| Abandoned::Internal(format!("strategy: {e}")))?;
    if actual != digest {
        return Err(Abandoned::Unfit(
            "the stored strategy is not in canonical form".to_owned(),
        ));
    }
    Ok(strategy)
}

/// The input of the run and its reference: the frozen input of a replay, or the input built from
/// the manifest of a backtest and uploaded. `Err(Ok(..))` is a run that cannot start.
enum Prepared {
    Input {
        input: Box<EvaluationInput>,
        reference: Value,
    },
    NotPrepared {
        failure: Failure,
    },
}

fn prepare_input(
    cx: &JobContext<'_>,
    bound: &Bound,
    strategy_hash: &str,
) -> Result<Prepared, Abandoned> {
    if bound.mode == "REPLAY" {
        let digest = text(&bound.value, "/input/input/digest")?;
        let input: EvaluationInput = cx.fetch_contract(digest, "frozen input")?;
        let actual =
            payload_digest(&input).map_err(|e| Abandoned::Internal(format!("input: {e}")))?;
        if actual != digest {
            return Err(Abandoned::Unfit(
                "the stored frozen input is not in canonical form".to_owned(),
            ));
        }
        let reference = bound
            .value
            .pointer("/input/input")
            .cloned()
            .ok_or_else(|| Abandoned::Unfit("the request names no input".to_owned()))?;
        return Ok(Prepared::Input {
            input: Box::new(input),
            reference,
        });
    }
    let manifest_digest = text(&bound.value, "/input/manifest/digest")?;
    let manifest: g::DatasetManifest = cx.fetch_contract(manifest_digest, "dataset manifest")?;
    let actual =
        payload_digest(&manifest).map_err(|e| Abandoned::Internal(format!("manifest: {e}")))?;
    if actual != manifest_digest {
        return Err(Abandoned::Unfit(
            "the stored manifest is not in canonical form".to_owned(),
        ));
    }
    let manifest_value =
        to_value(&manifest).map_err(|e| Abandoned::Internal(format!("manifest: {e}")))?;
    // The manifest must be the one of the profile that the request names.
    if manifest_value.pointer("/source/profile") != bound.value.pointer("/conditions/profile") {
        return Ok(Prepared::NotPrepared {
            failure: Failure::new(
                openquant_core::FailureCode::IdentityMismatch,
                "the dataset manifest was built under another research profile revision than the request names".to_owned(),
            ),
        });
    }
    let source = bound
        .value
        .get("input")
        .ok_or_else(|| Abandoned::Unfit("the request names no input".to_owned()))?;
    match build_input(strategy_hash, OPERATOR_SET, &manifest_value, source) {
        Err(failure) => Ok(Prepared::NotPrepared { failure }),
        Ok((value, input)) => {
            let bytes =
                canonical_json(&value).map_err(|e| Abandoned::Internal(format!("input: {e}")))?;
            let reference = cx.upload(JSON_MEDIA_TYPE, bytes.as_bytes())?;
            Ok(Prepared::Input {
                input: Box::new(input),
                reference,
            })
        }
    }
}

/// Run one `evaluate` job.
///
/// # Errors
/// [`Abandoned`] when the request cannot be served, an input cannot be read, the lease is ending
/// or the API refuses an upload or the submission.
pub fn run(cx: &JobContext<'_>, inputs: &g::EvaluateJobInputs) -> JobResult {
    let request_digest = inputs.request.digest.as_str();
    let request: g::EvaluationRequest = cx.fetch_contract(request_digest, "evaluation request")?;
    let bound = bind(cx, request_digest, &request)?;
    let strategy = strategy_of(cx, &bound)?;
    let strategy_hash = text(&bound.value, "/strategy/artefact/digest")?.to_owned();

    let (input, input_ref) = match prepare_input(cx, &bound, &strategy_hash)? {
        Prepared::NotPrepared { failure } => {
            return not_prepared(cx, &bound, request_digest, &failure, None);
        }
        Prepared::Input { input, reference } => (input, reference),
    };
    let run = match Run::prepare(&strategy, &input) {
        Ok(run) => run,
        Err(failure) => {
            return not_prepared(cx, &bound, request_digest, &failure, Some(input_ref));
        }
    };

    let journal = cx
        .config
        .scratch_dir
        .as_deref()
        .map(|dir| Journal::for_run(dir, &bound.run_id, &run));
    let Stepped {
        state,
        failure,
        resumed_from,
    } = step_all(cx, &run, request_digest, journal.as_ref())?;
    let result = run
        .result(&state, failure.as_ref())
        .map_err(|f| Abandoned::Internal(format!("result: {}", f.detail)))?;
    let result_value =
        to_value(&result).map_err(|e| Abandoned::Internal(format!("result: {e}")))?;
    validate(Contract::EvaluationResult, &result_value)
        .map_err(|e| Abandoned::Internal(format!("the result breaks its schema: {e}")))?;
    let result_bytes =
        canonical_json(&result_value).map_err(|e| Abandoned::Internal(format!("result: {e}")))?;
    if result_bytes.len() > RESULT_LIMIT_BYTES {
        return Err(Abandoned::Internal(format!(
            "the result is {} bytes, above the artefact limit of {RESULT_LIMIT_BYTES}",
            result_bytes.len()
        )));
    }
    if digest_bytes(result_bytes.as_bytes())
        != payload_digest(&result).map_err(|e| Abandoned::Internal(e.to_string()))?
    {
        return Err(Abandoned::Internal(
            "the canonical result does not hash to its payload digest".to_owned(),
        ));
    }
    let result_ref = cx.upload(JSON_MEDIA_TYPE, result_bytes.as_bytes())?;

    let status = result_value
        .pointer("/outcome/status")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let evaluation = if status == "COMPLETED" {
        let facts = metrics_facts(cx, &bound)?;
        let method = running_method();
        let metrics = compute_metrics(
            &run,
            &result,
            &MetricsContext {
                run_id: &bound.run_id,
                window: facts.window,
                scenario: facts.scenario,
                currency: input.policy.currency.as_str(),
                metric_scale: facts.metric_scale,
                limitation: &facts.limitation,
                method: &method,
            },
        )
        .map_err(|e| Abandoned::Internal(format!("metrics: {e}")))?;
        let metrics_value =
            to_value(&metrics).map_err(|e| Abandoned::Internal(format!("metrics: {e}")))?;
        let metrics_bytes = canonical_json(&metrics_value)
            .map_err(|e| Abandoned::Internal(format!("metrics: {e}")))?;
        let metrics_ref = cx.upload(JSON_MEDIA_TYPE, metrics_bytes.as_bytes())?;
        json!({
            "status": "COMPLETED",
            "input": input_ref,
            "result": result_ref,
            "metrics": metrics_ref,
        })
    } else {
        let code = result_value
            .pointer("/outcome/code")
            .and_then(Value::as_str)
            .ok_or_else(|| Abandoned::Internal("a failed result has no code".to_owned()))?;
        json!({
            "status": status,
            "code": code,
            "input": input_ref,
            "result": result_ref,
        })
    };
    submit_evaluation(cx, &bound, request_digest, &run.engine_digest, evaluation)?;
    // The result is committed: the journal has done its work.
    if let Some(journal) = &journal {
        journal.clear();
    }
    Ok(Submitted {
        summary: match resumed_from {
            Some(cursor) => {
                format!("evaluation-submission {status} (resumed from a checkpoint at {cursor})")
            }
            None => format!("evaluation-submission {status}"),
        },
    })
}

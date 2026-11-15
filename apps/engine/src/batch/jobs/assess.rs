//! The `assess` job: the gates of one candidate (OQ-02 sections 3.2 and 3.6; decision D18).
//!
//! The job reads what its dispatch names: the cohort policy, the evaluation plan, the validation
//! result, the dataset manifests and, for each run of the candidate's trial slot, the committed
//! `evaluation-submission/1` with the artefacts it cites. It re-reads the numerical result of a
//! completed run and audits it (`Run::prepare` on the strategy and the input, then the accounting
//! and timing audits), decides every gate of the policy with the Rust method and writes
//! `gate-report/1`. The API only applies finding treatment and combines the gate results.
//!
//! Binding. The job binds the evidence before it decides (`bind.rs`): each run of the dispatch to
//! a planned slot of the evaluation plan with the same window role and cost scenario, each
//! planned slot to one run, each submission, metrics document, validation result and manifest to
//! the run, the plan, the candidate, the dataset and the running binary. The metrics are also
//! recomputed from the rebuilt run, so the gates do not rest on a published number. Evidence that
//! does not bind is handed to the gates marked with its mismatch, and the gates that need it say
//! `INSUFFICIENT` with the reason code of absent evidence and the mismatch as the reason. A
//! planned run that no run of the dispatch claims is a run without a result.
//!
//! Evidence the worker cannot read stays missing: a run without a submission is `Missing`, and
//! the audits of a run are absent when the strategy artefact is not readable by this attempt. The
//! gates then say `INSUFFICIENT` with the reason code that names what is missing, never a guess.

use std::str::FromStr;

use openquant_contracts::{
    EvaluationInput, FailureCode, StrategyArtefact, canonical_json, generated as g, payload_digest,
    to_value,
};
use openquant_core::{
    Run,
    audit::audit_run,
    gates::{
        CandidateEvidence, ManifestEvidence, MetricsEvidence, Mismatch, Outcome, ReportContext,
        RunEvidence, ValidationEvidence, assess, report,
    },
    metrics::{MethodRef, MetricsContext, Scenario, Window, compute_metrics},
};
use serde_json::{Value, json};

use super::{
    Abandoned, JobContext, JobResult, Submitted,
    bind::{
        Binder, Claim, MetricsSource, Placement, Plan, Unfilled, dataset_mismatch,
        first_difference, place,
    },
    parse_document,
};
use crate::batch::{
    api::{ApiError, ResultRoute},
    identity::{running_engine_digest, running_method},
};

fn pointer_text<'v>(value: &'v Value, pointer: &str) -> Option<&'v str> {
    value.pointer(pointer).and_then(Value::as_str)
}

/// Fetch a stored artefact that the attempt may not be able to read. `None` for `NOT_FOUND`.
fn fetch_optional(cx: &JobContext<'_>, digest: &str) -> Result<Option<Vec<u8>>, Abandoned> {
    match cx.fetch(digest) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(Abandoned::Api(ApiError::Api(failure))) if failure.code == "NOT_FOUND" => Ok(None),
        Err(other) => Err(other),
    }
}

struct Strategy(Option<StrategyArtefact>);

fn strategy_of(cx: &JobContext<'_>, strategy_hash: &str) -> Result<Strategy, Abandoned> {
    let Some(bytes) = fetch_optional(cx, strategy_hash)? else {
        return Ok(Strategy(None));
    };
    let strategy: StrategyArtefact = parse_document(&bytes, "strategy artefact")?;
    let actual =
        payload_digest(&strategy).map_err(|e| Abandoned::Internal(format!("strategy: {e}")))?;
    if actual != strategy_hash {
        return Err(Abandoned::Unfit(
            "the stored strategy is not in canonical form".to_owned(),
        ));
    }
    Ok(Strategy(Some(strategy)))
}

/// What the cohort policy fixes for the metrics of every run (the same two members that the
/// `evaluate` job reads).
struct MetricFacts {
    scale: u32,
    limitation: String,
}

fn metric_facts(policy: &Value) -> Result<MetricFacts, Abandoned> {
    let scale = policy
        .pointer("/metrics/metric_scale")
        .and_then(Value::as_u64)
        .and_then(|n| u32::try_from(n).ok())
        .ok_or_else(|| Abandoned::Unfit("the cohort policy states no metric scale".to_owned()))?;
    let limitation = pointer_text(policy, "/metrics/uncertainty/limitation")
        .ok_or_else(|| Abandoned::Unfit("the cohort policy states no limitation".to_owned()))?
        .to_owned();
    Ok(MetricFacts { scale, limitation })
}

/// What every run is bound against.
struct Binding<'a> {
    binder: &'a Binder<'a>,
    facts: &'a MetricFacts,
}

fn validation_evidence(
    cx: &JobContext<'_>,
    reference: &g::ArtefactRef,
    binder: &Binder<'_>,
) -> Result<ValidationEvidence, Abandoned> {
    let digest = reference.digest.as_str();
    let result: g::ValidationResult = cx.fetch_contract(digest, "validation result")?;
    let value = to_value(&result).map_err(|e| Abandoned::Internal(format!("validation: {e}")))?;
    let digest = digest.to_owned();
    if let Some(mismatch) = binder.validation(&value) {
        return Ok(ValidationEvidence::Unbound { digest, mismatch });
    }
    Ok(match pointer_text(&value, "/outcome/status") {
        Some("VALID") => ValidationEvidence::Valid { digest },
        _ => ValidationEvidence::Invalid { digest },
    })
}

fn manifest_evidence(
    cx: &JobContext<'_>,
    references: &[g::ArtefactRef],
    datasets: &[(String, Value)],
) -> Result<Option<ManifestEvidence>, Abandoned> {
    let Some(first) = references.first() else {
        return Ok(None);
    };
    let digest = first.digest.as_str();
    let manifest_document: g::DatasetManifest = cx.fetch_contract(digest, "dataset manifest")?;
    let value =
        to_value(&manifest_document).map_err(|e| Abandoned::Internal(format!("manifest: {e}")))?;
    let missing = |pointer: &str| -> u32 {
        let count = value
            .pointer(pointer)
            .and_then(Value::as_array)
            .map_or(0, |items| {
                items
                    .iter()
                    .filter(|item| {
                        item.get("available_at")
                            .and_then(Value::as_str)
                            .is_none_or(str::is_empty)
                    })
                    .count()
            });
        u32::try_from(count).unwrap_or(u32::MAX)
    };
    Ok(Some(ManifestEvidence {
        digest: digest.to_owned(),
        bars_without_availability: missing("/content/bars"),
        actions_without_availability: missing("/content/corporate_actions"),
        unbound: dataset_mismatch(&value, datasets),
    }))
}

/// The evidence of one run, and the dataset its input names when the run binds.
struct Examined {
    evidence: RunEvidence,
    dataset: Option<Value>,
}

/// A run whose evidence does not bind: it keeps what identifies it and the submission that was
/// read, and nothing that a gate could use.
fn unbind(mut evidence: RunEvidence, mismatch: Mismatch) -> Examined {
    evidence.outcome = Outcome::Missing;
    evidence.result_digest = None;
    evidence.metrics = None;
    evidence.input_policy = None;
    evidence.checks = None;
    evidence.unbound = Some(mismatch);
    Examined {
        evidence,
        dataset: None,
    }
}

/// The evidence of one run of the slot.
fn run_evidence(
    cx: &JobContext<'_>,
    strategy: &Strategy,
    binding: &Binding<'_>,
    assessed: &g::AssessedRun,
    placement: &Placement,
) -> Result<Examined, Abandoned> {
    let (window, scenario) = (placement.window, placement.scenario);
    let evidence = RunEvidence {
        run_id: assessed.run_id.as_str().to_owned(),
        window,
        scenario,
        repeat_of: placement.repeat_of.clone(),
        submission_digest: None,
        result_digest: None,
        outcome: Outcome::Missing,
        metrics: None,
        input_policy: None,
        checks: None,
        unbound: placement.mismatch.clone(),
    };
    // A run that does not belong to the slot it names is not read at all.
    if evidence.unbound.is_some() {
        return Ok(Examined {
            evidence,
            dataset: None,
        });
    }
    let Some(reference) = &assessed.submission else {
        return Ok(Examined {
            evidence,
            dataset: None,
        });
    };
    let submission_digest = reference.digest.as_str();
    let submission: g::EvaluationSubmission =
        cx.fetch_contract(submission_digest, "evaluation submission")?;
    let value =
        to_value(&submission).map_err(|e| Abandoned::Internal(format!("submission: {e}")))?;
    let mut evidence = evidence;
    evidence.submission_digest = Some(submission_digest.to_owned());
    if let Some(mismatch) = binding.binder.submission(assessed.run_id.as_str(), &value) {
        return Ok(unbind(evidence, mismatch));
    }
    let status = pointer_text(&value, "/evaluation/status").unwrap_or_default();
    let code = || -> Result<FailureCode, Abandoned> {
        let text = pointer_text(&value, "/evaluation/code")
            .ok_or_else(|| Abandoned::Unfit("a submission has no failure code".to_owned()))?;
        FailureCode::from_str(text)
            .map_err(|_| Abandoned::Unfit(format!("a submission has the unknown code {text}")))
    };
    let input_of = |value: &Value| -> Result<Option<(String, EvaluationInput)>, Abandoned> {
        let Some(digest) = pointer_text(value, "/evaluation/input/digest") else {
            return Ok(None);
        };
        let input: EvaluationInput = cx.fetch_contract(digest, "evaluation input")?;
        Ok(Some((digest.to_owned(), input)))
    };
    match status {
        "COMPLETED" => {
            let result_digest =
                pointer_text(&value, "/evaluation/result/digest").map(str::to_owned);
            let metrics_digest =
                pointer_text(&value, "/evaluation/metrics/digest").ok_or_else(|| {
                    Abandoned::Unfit("a completed submission has no metrics".to_owned())
                })?;
            let metrics: g::EvaluationMetrics = cx.fetch_contract(metrics_digest, "metrics")?;
            let metrics_value =
                to_value(&metrics).map_err(|e| Abandoned::Internal(format!("metrics: {e}")))?;
            let (Some((_, input)), Some(result_digest)) = (input_of(&value)?, result_digest) else {
                return Err(Abandoned::Unfit(
                    "a completed submission cites no input or no result".to_owned(),
                ));
            };
            let input_value =
                to_value(&input).map_err(|e| Abandoned::Internal(format!("input: {e}")))?;
            // The run used the window that the plan resolved for its role.
            if let Some(mismatch) = binding.binder.input_windows(window, &input_value) {
                return Ok(unbind(evidence, mismatch));
            }
            // The audits rebuild the run from its strategy and input. Without the strategy there
            // is nothing to audit, and a report that hid the gap would be worse than none.
            let Some(strategy) = &strategy.0 else {
                return Err(Abandoned::Unfit(
                    "the strategy artefact cannot be read by this attempt: the accounting and timing audits rebuild each completed run from it".to_owned(),
                ));
            };
            let result: g::EvaluationResult =
                cx.fetch_contract(&result_digest, "evaluation result")?;
            let run = Run::prepare(strategy, &input).map_err(|_| rebuild_failed(assessed))?;
            let checks = audit_run(&run, &result).map_err(|_| rebuild_failed(assessed))?;
            let mismatch = binding.binder.metrics(
                &MetricsSource {
                    run_id: assessed.run_id.as_str(),
                    window,
                    scenario,
                    result_digest: &result_digest,
                    input_hash: &run.input_hash,
                    engine_digest: &run.engine_digest,
                },
                &metrics_value,
            );
            let mismatch = mismatch.or_else(|| {
                recomputed(
                    binding,
                    &run,
                    &result,
                    assessed.run_id.as_str(),
                    window,
                    scenario,
                    input.policy.currency.as_str(),
                    &metrics_value,
                )
            });
            let mut evidence = evidence;
            evidence.outcome = Outcome::of(&result);
            evidence.result_digest = Some(result_digest);
            evidence.metrics = Some(MetricsEvidence {
                digest: metrics_digest.to_owned(),
                document: metrics_value,
                unbound: mismatch,
            });
            evidence.input_policy = input_value.get("policy").cloned();
            evidence.checks = Some(checks);
            Ok(Examined {
                evidence,
                dataset: input_value.get("dataset").cloned(),
            })
        }
        "FAILED" | "INSUFFICIENT" => {
            let code = code()?;
            let mut evidence = evidence;
            evidence.outcome = if status == "FAILED" {
                Outcome::Failed(code)
            } else {
                Outcome::Insufficient(code)
            };
            evidence.result_digest =
                pointer_text(&value, "/evaluation/result/digest").map(str::to_owned);
            let mut dataset = None;
            if let Some((_, input)) = input_of(&value)? {
                let input_value =
                    to_value(&input).map_err(|e| Abandoned::Internal(format!("input: {e}")))?;
                if let Some(mismatch) = binding.binder.input_windows(window, &input_value) {
                    return Ok(unbind(evidence, mismatch));
                }
                evidence.input_policy = input_value.get("policy").cloned();
                dataset = input_value.get("dataset").cloned();
            }
            Ok(Examined { evidence, dataset })
        }
        _ => {
            let mut evidence = evidence;
            evidence.outcome = Outcome::NotPrepared(code()?);
            Ok(Examined {
                evidence,
                dataset: None,
            })
        }
    }
}

fn rebuild_failed(assessed: &g::AssessedRun) -> Abandoned {
    Abandoned::Internal(format!(
        "the run {} could not be rebuilt for its audits",
        assessed.run_id.as_str()
    ))
}

/// Recompute the metrics of the rebuilt run, and compare them with the published document. A
/// document that the result does not support is not used.
#[allow(clippy::too_many_arguments)]
fn recomputed(
    binding: &Binding<'_>,
    run: &Run,
    result: &g::EvaluationResult,
    run_id: &str,
    window: Window,
    scenario: Scenario,
    currency: &str,
    published: &Value,
) -> Option<Mismatch> {
    let method: &MethodRef = binding.binder.method;
    let metrics = match compute_metrics(
        run,
        result,
        &MetricsContext {
            run_id,
            window,
            scenario,
            currency,
            metric_scale: binding.facts.scale,
            limitation: &binding.facts.limitation,
            method,
        },
    ) {
        Ok(metrics) => metrics,
        Err(error) => {
            return Some(Mismatch::new(
                "metrics.recomputed",
                "metrics that the result supports",
                format!("the result gives none: {error}"),
            ));
        }
    };
    let Ok(expected) = to_value(&metrics) else {
        return Some(Mismatch::new(
            "metrics.recomputed",
            "metrics that the result supports",
            "metrics that cannot be written",
        ));
    };
    if canonical_json(&expected).ok() == canonical_json(published).ok() {
        return None;
    }
    let (pointer, wanted, found) = first_difference(&expected, published).unwrap_or_default();
    Some(Mismatch::new(
        format!("metrics.recomputed at {pointer}"),
        format!("{wanted}, the value that the result gives"),
        found,
    ))
}

/// A planned run that no run of the dispatch claims.
fn unfilled_run(gap: &Unfilled) -> RunEvidence {
    RunEvidence {
        run_id: gap.slot.id.clone(),
        window: gap.slot.window,
        scenario: gap.slot.scenario,
        repeat_of: gap.repeat_of.clone(),
        submission_digest: None,
        result_digest: None,
        outcome: Outcome::Missing,
        metrics: None,
        input_policy: None,
        checks: None,
        unbound: None,
    }
}

/// The labels of a run of the dispatch.
fn claim_of(assessed: &g::AssessedRun) -> Result<Claim<'_>, Abandoned> {
    let window = Window::from_wire(&assessed.window_role.to_string())
        .ok_or_else(|| Abandoned::Unfit("the dispatch names an unknown window role".to_owned()))?;
    let scenario = Scenario::from_wire(&assessed.cost_scenario.to_string()).ok_or_else(|| {
        Abandoned::Unfit("the dispatch names an unknown cost scenario".to_owned())
    })?;
    Ok(Claim {
        run_id: assessed.run_id.as_str(),
        run_slot: assessed.run_slot.as_str(),
        window,
        scenario,
        replay_of: assessed.replay_of.as_ref().map(|id| id.as_str()),
    })
}

/// Run one `assess` job.
///
/// # Errors
/// [`Abandoned`] when an input cannot be read or the report cannot be written.
pub fn run(cx: &JobContext<'_>, inputs: &g::AssessJobInputs) -> JobResult {
    let policy_digest = inputs.cohort_policy.digest.as_str();
    let policy: g::CohortPolicy = cx.fetch_contract(policy_digest, "cohort policy")?;
    let policy_value =
        to_value(&policy).map_err(|e| Abandoned::Internal(format!("cohort policy: {e}")))?;
    let facts = metric_facts(&policy_value)?;
    // The plan is the registered comparison: the runs are bound to it before any gate decides.
    let plan_digest = inputs.plan.digest.as_str();
    let plan_document: g::EvaluationPlan = cx.fetch_contract(plan_digest, "evaluation plan")?;
    let plan_value =
        to_value(&plan_document).map_err(|e| Abandoned::Internal(format!("plan: {e}")))?;
    let plan = Plan::read(&plan_value, inputs.trial_slot.as_str())
        .map_err(|why| Abandoned::Unfit(format!("the evaluation plan is unusable: {why}")))?;
    let strategy_hash = inputs.strategy_hash.as_str();
    let strategy = strategy_of(cx, strategy_hash)?;
    let engine_digest = running_engine_digest().map_err(Abandoned::Internal)?;
    let method = running_method();
    let binder = Binder {
        plan: &plan,
        strategy_hash,
        engine_digest: &engine_digest,
        method: &method,
    };
    let binding = Binding {
        binder: &binder,
        facts: &facts,
    };

    let claims = inputs
        .runs
        .iter()
        .map(claim_of)
        .collect::<Result<Vec<_>, _>>()?;
    let placed = place(&plan, &claims);
    let mut runs = Vec::with_capacity(inputs.runs.len() + placed.unfilled.len());
    let mut datasets: Vec<(String, Value)> = Vec::new();
    for (assessed, placement) in inputs.runs.iter().zip(&placed.runs) {
        cx.heartbeat(plan_digest)?;
        let examined = run_evidence(cx, &strategy, &binding, assessed, placement)?;
        if let Some(dataset) = examined.dataset {
            datasets.push((assessed.run_id.as_str().to_owned(), dataset));
        }
        runs.push(examined.evidence);
    }
    // A planned run that no run of the dispatch claims has no result.
    runs.extend(placed.unfilled.iter().map(unfilled_run));
    let validation = validation_evidence(cx, &inputs.validation, &binder)?;
    let manifest = manifest_evidence(cx, &inputs.manifests, &datasets)?;
    let evidence = CandidateEvidence {
        plan_digest: Some(plan_digest.to_owned()),
        validation,
        manifest,
        runs,
    };
    let assessment =
        assess(&policy_value, &evidence).map_err(|e| Abandoned::Internal(format!("gates: {e}")))?;

    let cohort_policy = json!({
        "id": pointer_text(&policy_value, "/policy_id").unwrap_or_default(),
        "revision": policy_value.pointer("/revision").cloned().unwrap_or(Value::Null),
        "digest": policy_digest,
    });
    let context = ReportContext {
        job_id: cx.dispatch.job_id.as_str(),
        attempt: cx.attempt(),
        executable: cx.executable.to_value(),
        method: &method,
        strategy_hash,
        cohort_policy,
        duration: cx.duration(),
    };
    let gate_report = report(&context, &assessment)
        .map_err(|e| Abandoned::Internal(format!("gate report: {e}")))?;
    let document =
        to_value(&gate_report).map_err(|e| Abandoned::Internal(format!("gate report: {e}")))?;
    cx.submit(ResultRoute::GateReport, &document)?;
    Ok(Submitted {
        summary: format!("gate-report of {} gates", assessment.gates.len()),
    })
}

//! The `assess` job: the gates of one candidate (OQ-02 sections 3.2 and 3.6; decision D18).
//!
//! The job reads what its dispatch names: the cohort policy, the evaluation plan, the validation
//! result, the dataset manifests and, for each run of the candidate's trial slot, the committed
//! `evaluation-submission/1` with the artefacts it cites. It re-reads the numerical result of a
//! completed run and audits it (`Run::prepare` on the strategy and the input, then the accounting
//! and timing audits), decides every gate of the policy with the Rust method and writes
//! `gate-report/1`. The API only applies finding treatment and combines the gate results.
//!
//! Evidence the worker cannot read stays missing: a run without a submission is `Missing`, and
//! the audits of a run are absent when the strategy artefact is not readable by this attempt. The
//! gates then say `INSUFFICIENT` with the reason code that names what is missing, never a guess.

use std::str::FromStr;

use openquant_contracts::{
    EvaluationInput, FailureCode, StrategyArtefact, generated as g, payload_digest, to_value,
};
use openquant_core::{
    Run,
    audit::{RunChecks, audit_run},
    gates::{
        CandidateEvidence, ManifestEvidence, MetricsEvidence, Outcome, ReportContext, RunEvidence,
        ValidationEvidence, assess, report,
    },
    metrics::{Scenario, Window},
};
use serde_json::{Value, json};

use super::{Abandoned, JobContext, JobResult, Submitted, parse_document};
use crate::batch::{
    api::{ApiError, ResultRoute},
    identity::running_method,
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

fn validation_evidence(
    cx: &JobContext<'_>,
    reference: &g::ArtefactRef,
) -> Result<ValidationEvidence, Abandoned> {
    let digest = reference.digest.as_str();
    let result: g::ValidationResult = cx.fetch_contract(digest, "validation result")?;
    let value = to_value(&result).map_err(|e| Abandoned::Internal(format!("validation: {e}")))?;
    let digest = digest.to_owned();
    Ok(match pointer_text(&value, "/outcome/status") {
        Some("VALID") => ValidationEvidence::Valid { digest },
        _ => ValidationEvidence::Invalid { digest },
    })
}

fn manifest_evidence(
    cx: &JobContext<'_>,
    references: &[g::ArtefactRef],
) -> Result<Option<ManifestEvidence>, Abandoned> {
    let Some(first) = references.first() else {
        return Ok(None);
    };
    let digest = first.digest.as_str();
    let manifest: g::DatasetManifest = cx.fetch_contract(digest, "dataset manifest")?;
    let value = to_value(&manifest).map_err(|e| Abandoned::Internal(format!("manifest: {e}")))?;
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
    }))
}

/// The evidence of one run of the slot.
fn run_evidence(
    cx: &JobContext<'_>,
    strategy: &Strategy,
    assessed: &g::AssessedRun,
) -> Result<RunEvidence, Abandoned> {
    let window = Window::from_wire(&assessed.window_role.to_string())
        .ok_or_else(|| Abandoned::Unfit("the dispatch names an unknown window role".to_owned()))?;
    let scenario = Scenario::from_wire(&assessed.cost_scenario.to_string()).ok_or_else(|| {
        Abandoned::Unfit("the dispatch names an unknown cost scenario".to_owned())
    })?;
    let mut evidence = RunEvidence {
        run_id: assessed.run_id.as_str().to_owned(),
        window,
        scenario,
        repeat_of: assessed.replay_of.as_ref().map(|id| id.as_str().to_owned()),
        submission_digest: None,
        result_digest: None,
        outcome: Outcome::Missing,
        metrics: None,
        input_policy: None,
        checks: None,
    };
    let Some(reference) = &assessed.submission else {
        return Ok(evidence);
    };
    let submission_digest = reference.digest.as_str();
    let submission: g::EvaluationSubmission =
        cx.fetch_contract(submission_digest, "evaluation submission")?;
    let value =
        to_value(&submission).map_err(|e| Abandoned::Internal(format!("submission: {e}")))?;
    evidence.submission_digest = Some(submission_digest.to_owned());
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
            evidence.outcome = Outcome::Completed;
            evidence.result_digest =
                pointer_text(&value, "/evaluation/result/digest").map(str::to_owned);
            let metrics_digest =
                pointer_text(&value, "/evaluation/metrics/digest").ok_or_else(|| {
                    Abandoned::Unfit("a completed submission has no metrics".to_owned())
                })?;
            let metrics: g::EvaluationMetrics = cx.fetch_contract(metrics_digest, "metrics")?;
            evidence.metrics = Some(MetricsEvidence {
                digest: metrics_digest.to_owned(),
                document: to_value(&metrics)
                    .map_err(|e| Abandoned::Internal(format!("metrics: {e}")))?,
            });
            let (Some((_, input)), Some(result_digest)) =
                (input_of(&value)?, evidence.result_digest.clone())
            else {
                return Err(Abandoned::Unfit(
                    "a completed submission cites no input or no result".to_owned(),
                ));
            };
            let input_value =
                to_value(&input).map_err(|e| Abandoned::Internal(format!("input: {e}")))?;
            evidence.input_policy = input_value.get("policy").cloned();
            // The audits rebuild the run from its strategy and input. Without the strategy there
            // is nothing to audit, and a report that hid the gap would be worse than none.
            let Some(strategy) = &strategy.0 else {
                return Err(Abandoned::Unfit(
                    "the strategy artefact cannot be read by this attempt: the accounting and timing audits rebuild each completed run from it".to_owned(),
                ));
            };
            let result: g::EvaluationResult =
                cx.fetch_contract(&result_digest, "evaluation result")?;
            evidence.checks = Some(audit(strategy, &input, &result).ok_or_else(|| {
                Abandoned::Internal(format!(
                    "the run {} could not be rebuilt for its audits",
                    assessed.run_id.as_str()
                ))
            })?);
            evidence.outcome = Outcome::of(&result);
        }
        "FAILED" | "INSUFFICIENT" => {
            let code = code()?;
            evidence.outcome = if status == "FAILED" {
                Outcome::Failed(code)
            } else {
                Outcome::Insufficient(code)
            };
            evidence.result_digest =
                pointer_text(&value, "/evaluation/result/digest").map(str::to_owned);
            if let Some((_, input)) = input_of(&value)? {
                let input_value =
                    to_value(&input).map_err(|e| Abandoned::Internal(format!("input: {e}")))?;
                evidence.input_policy = input_value.get("policy").cloned();
            }
        }
        _ => {
            evidence.outcome = Outcome::NotPrepared(code()?);
        }
    }
    Ok(evidence)
}

/// Rebuild the run and audit its result. `None` when the run cannot be rebuilt.
fn audit(
    strategy: &StrategyArtefact,
    input: &EvaluationInput,
    result: &g::EvaluationResult,
) -> Option<RunChecks> {
    let run = Run::prepare(strategy, input).ok()?;
    audit_run(&run, result).ok()
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
    let plan_digest = inputs.plan.digest.as_str();
    // The plan is read to bind the report to it: it must be a valid evaluation plan.
    let _plan: g::EvaluationPlan = cx.fetch_contract(plan_digest, "evaluation plan")?;
    let strategy_hash = inputs.strategy_hash.as_str();
    let strategy = strategy_of(cx, strategy_hash)?;
    let validation = validation_evidence(cx, &inputs.validation)?;
    let manifest = manifest_evidence(cx, &inputs.manifests)?;
    let mut runs = Vec::with_capacity(inputs.runs.len());
    for assessed in &inputs.runs {
        cx.heartbeat(plan_digest)?;
        runs.push(run_evidence(cx, &strategy, assessed)?);
    }
    let evidence = CandidateEvidence {
        plan_digest: Some(plan_digest.to_owned()),
        validation,
        manifest,
        runs,
    };
    let assessment =
        assess(&policy_value, &evidence).map_err(|e| Abandoned::Internal(format!("gates: {e}")))?;

    let method = running_method();
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

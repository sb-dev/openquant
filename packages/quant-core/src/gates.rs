//! The cohort gates of one candidate (OQ-02 sections 3.2 and 3.6; decision D18 of the S1 pilot
//! record).
//!
//! `assess` reads a candidate's evidence and the registered `cohort-policy/1`, and decides each
//! gate of the suite. `report` wraps the decisions in `gate-report/1` and validates it. The module
//! is pure: it reads no file, runs no evaluator and calls no service. The assess job supplies the
//! evidence it fetched; the API applies finding treatment and combines the gate results.
//!
//! # Policy dispatch
//!
//! The policy lists every gate once, in a fixed order. A `NOT_APPLICABLE` gate is reported
//! `NOT_APPLICABLE` and a `RECORDED_INSUFFICIENT` gate `INSUFFICIENT`, each with reason code
//! `POLICY_RECORDED` and the policy's reason. A `REQUIRED` gate is evaluated by its reviewed
//! method. A required gate that the method cannot evaluate (for example a policy that marks
//! `PARAMETER_SENSITIVITY` required) is a typed error, never a silent pass.
//!
//! # Threshold gates
//!
//! `EXCESS_OVER_BUY_AND_HOLD`, `WALK_FORWARD`, `MINIMUM_TRADE_COUNT` and `COST_STRESS` carry
//! thresholds. For each threshold and each window it lists, the candidate's regular run of that
//! window and cost scenario is read (a deterministic repeat is never used), the metric is taken
//! from the published `evaluation-metrics/1` and compared with the threshold exactly. Every
//! threshold must hold in every window: nothing is averaged across windows. Precedence: a measured
//! failure decides the gate by its `below_threshold` (`FAIL` or `INSUFFICIENT` with
//! `BELOW_THRESHOLD`) even when another window lacks evidence, because a threshold that provably
//! fails cannot be rescued; otherwise missing evidence makes it `INSUFFICIENT` with the reason code
//! that names what is missing; otherwise it passes.
//!
//! # Method-only gates
//!
//! The other required gates are decided by their method. Where the frozen specification leaves a
//! mapping open, the choice is stated here and in `method.txt`:
//!
//! * A run that `FAILED` with a candidate defect (`INVALID_LEVEL` or an operator code) makes
//!   `DEFINITION_VALIDATION` `FAIL`: an operator code means that the definition does not validate
//!   in the engine, and `INVALID_LEVEL` that its exit rules produce a level that breaks
//!   `0 < stop < entry < target` on the data, which no static check can see. The other correctness
//!   gates are not failed by it: a failed run has no ledger to reconcile, no timing to audit and
//!   no result to repeat, so they are `INSUFFICIENT` with `RUN_FAILED`. Failing them without
//!   evidence would report a defect nobody observed.
//! * A run that failed for any other reason (`FUTURE_DATA`, `EVENT_OUT_OF_ORDER` and the input,
//!   schema, identity, policy and checkpoint codes) is a platform defect: every gate that needs
//!   the run is `INSUFFICIENT` with `RUN_FAILED`. `ARITHMETIC_OVERFLOW` is outside the engine
//!   domain: `OUTSIDE_ENGINE_DOMAIN`.
//!
//! # Evidence that does not bind
//!
//! The caller binds the evidence before it decides: a run to its slot of the evaluation plan, its
//! submission to the run and to the running binary, its metrics to the run, the result they derive
//! from and the method, the validation result to the candidate, the manifest to the datasets of
//! the runs. Evidence that does not bind arrives with its [`Mismatch`] and is never read: the
//! gates treat it as absent, with the reason code that the method text gives to absent evidence of
//! its kind (`RUN_MISSING` for a run or a manifest, `METRICS_UNAVAILABLE` for metrics,
//! `VALIDATION_FAILED` for a validation result) and a reason that names the mismatch. The gate
//! report schema has no code of its own for it.

use std::{collections::BTreeSet, fmt};

use openquant_contracts::{FailureCode, generated as g, parse_value};
use serde_json::{Value, json};
use thiserror::Error;

use crate::{
    audit::{Check, RunChecks},
    exact::Q,
    metrics::{MethodRef, Scenario, Window},
    numeric::truncate_on_boundary,
};

const MAX_REASON: usize = 1000;
const MAX_INPUTS: usize = 128;
const MAX_GATES: usize = 32;
const MAX_LIST: usize = 32;

/// Why gates could not be decided. Never a verdict on a candidate.
#[derive(Debug, Error)]
pub enum GateError {
    /// The cohort policy does not have the shape this method needs.
    #[error("the cohort policy cannot be used: {0}")]
    Policy(String),
    /// The policy marks a gate required that this method cannot evaluate.
    #[error("the gate {0} is required by the policy and has no reviewed method")]
    UnsupportedRequiredGate(String),
    /// The evidence is not usable as supplied.
    #[error("the evidence cannot be used: {0}")]
    Evidence(String),
    /// A list of the report is longer than the schema allows.
    #[error("{0}")]
    Limit(String),
    /// The finished report failed its own schema. This is a defect of this module.
    #[error("the gate report failed its schema: {0}")]
    Contract(String),
}

/// How a run ended, for the gates that need it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome {
    Completed,
    /// The numerical outcome was `FAILED` with this code.
    Failed(FailureCode),
    /// The numerical outcome was `INSUFFICIENT` with this code: the run completed, without metrics.
    Insufficient(FailureCode),
    /// The job ended before the core prepared a run, with this failure code.
    NotPrepared(FailureCode),
    /// No run was written or it never reported.
    Missing,
}

impl Outcome {
    /// The outcome of a numerical result.
    #[must_use]
    pub fn of(result: &g::EvaluationResult) -> Self {
        match (result.outcome.status, result.outcome.code) {
            (g::Status::Completed, _) => Self::Completed,
            (g::Status::Insufficient, Some(code)) => Self::Insufficient(code),
            (_, Some(code)) => Self::Failed(code),
            (_, None) => Self::Failed(FailureCode::InvalidInput),
        }
    }
}

/// Whether a failure code belongs to a candidate defect: an invalid level or an operator code
/// (OQ-02 section 3.6).
#[must_use]
pub fn is_candidate_defect(code: FailureCode) -> bool {
    matches!(
        code,
        FailureCode::InvalidLevel
            | FailureCode::UnsupportedOperator
            | FailureCode::OperatorTypeMismatch
            | FailureCode::OperatorUnitMismatch
            | FailureCode::InvalidParameter
    )
}

/// One member of a piece of evidence that is not what the assessment requires: another run, slot,
/// window, scenario, candidate, dataset, engine or method than the plan, the slot or the running
/// binary name. The assess job finds it by comparing the evidence with what binds it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Mismatch {
    /// The member that differs, as the document names it (`metrics.window.role`).
    pub field: String,
    /// What the plan, the slot, the candidate or the running binary require.
    pub required: String,
    /// What the evidence states.
    pub found: String,
}

impl Mismatch {
    #[must_use]
    pub fn new(
        field: impl Into<String>,
        required: impl Into<String>,
        found: impl Into<String>,
    ) -> Self {
        Self {
            field: field.into(),
            required: required.into(),
            found: found.into(),
        }
    }
}

impl fmt::Display for Mismatch {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "{} is {}, required {}",
            self.field, self.found, self.required
        )
    }
}

/// A published `evaluation-metrics/1` document and its digest.
#[derive(Clone, Debug)]
pub struct MetricsEvidence {
    pub digest: String,
    pub document: Value,
    /// Why the document is not the metrics of its run. Such a document is never read.
    pub unbound: Option<Mismatch>,
}

/// What the assessment read about one run.
#[derive(Clone, Debug)]
pub struct RunEvidence {
    pub run_id: String,
    pub window: Window,
    pub scenario: Scenario,
    /// The run that this one repeats, for the deterministic repeat.
    pub repeat_of: Option<String>,
    /// The digest of the run's `evaluation-submission/1`, which the gates cite as evidence.
    pub submission_digest: Option<String>,
    /// The digest of the run's `evaluation-result/1`; equal digests are what replay compares.
    pub result_digest: Option<String>,
    pub outcome: Outcome,
    pub metrics: Option<MetricsEvidence>,
    /// The `policy` member of the run's evaluation input, as the wire carries it.
    pub input_policy: Option<Value>,
    /// The audits of a completed run (`audit::audit_run`).
    pub checks: Option<RunChecks>,
    /// Why this run is not the run of its slot of the plan: its labels, its submission or its
    /// input do not bind. Such a run supplies no evidence, whatever else it carries.
    pub unbound: Option<Mismatch>,
}

/// What the validate job said about the candidate.
#[derive(Clone, Debug)]
pub enum ValidationEvidence {
    Valid {
        digest: String,
    },
    Invalid {
        digest: String,
    },
    /// A validation result that is not the candidate's, or not of the running engine and method.
    /// It is read and listed among the inputs, and no gate uses it.
    Unbound {
        digest: String,
        mismatch: Mismatch,
    },
    Missing,
}

/// What the dataset manifest says about availability times.
#[derive(Clone, Debug)]
pub struct ManifestEvidence {
    pub digest: String,
    pub bars_without_availability: u32,
    pub actions_without_availability: u32,
    /// Why this manifest is not the dataset of the runs. Such a manifest is never read.
    pub unbound: Option<Mismatch>,
}

/// Everything the assessment of one candidate reads.
#[derive(Clone, Debug)]
pub struct CandidateEvidence {
    pub plan_digest: Option<String>,
    pub validation: ValidationEvidence,
    pub manifest: Option<ManifestEvidence>,
    pub runs: Vec<RunEvidence>,
}

/// One artefact the assessment read.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GateInput {
    pub kind: &'static str,
    pub run_id: Option<String>,
    pub digest: String,
}

/// The decisions, ready for `report`.
#[derive(Clone, Debug)]
pub struct Assessment {
    pub inputs: Vec<GateInput>,
    /// One `GateOutcome` per gate of the policy, in policy order.
    pub gates: Vec<Value>,
    /// What each failing or undecided method-only gate found, for the job log. The gate report has
    /// no field for it.
    pub notes: Vec<String>,
}

// -------------------------------------------------------------------------------------------
// The policy
// -------------------------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Comparison {
    GreaterThan,
    AtLeast,
    LessThan,
    AtMost,
}

impl Comparison {
    fn parse(text: &str) -> Option<Self> {
        match text {
            "GREATER_THAN" => Some(Self::GreaterThan),
            "AT_LEAST" => Some(Self::AtLeast),
            "LESS_THAN" => Some(Self::LessThan),
            "AT_MOST" => Some(Self::AtMost),
            _ => None,
        }
    }

    fn wire(self) -> &'static str {
        match self {
            Self::GreaterThan => "GREATER_THAN",
            Self::AtLeast => "AT_LEAST",
            Self::LessThan => "LESS_THAN",
            Self::AtMost => "AT_MOST",
        }
    }

    fn holds(self, observed: &Q, threshold: &Q) -> bool {
        match self {
            Self::GreaterThan => observed > threshold,
            Self::AtLeast => observed >= threshold,
            Self::LessThan => observed < threshold,
            Self::AtMost => observed <= threshold,
        }
    }
}

#[derive(Clone, Debug)]
struct Threshold {
    metric: String,
    comparison: Comparison,
    value: Q,
    text: String,
    windows: Vec<Window>,
    scenario: Scenario,
}

#[derive(Clone, Debug)]
enum Rule {
    Required {
        thresholds: Vec<Threshold>,
        below_is_fail: bool,
        limitation: Option<String>,
    },
    RecordedInsufficient {
        reason: String,
    },
    NotApplicable {
        reason: String,
    },
}

#[derive(Clone, Debug)]
struct GateRule {
    gate: String,
    category: String,
    rule: Rule,
}

fn policy_error(detail: impl Into<String>) -> GateError {
    GateError::Policy(detail.into())
}

fn text<'a>(value: &'a Value, key: &str, what: &str) -> Result<&'a str, GateError> {
    value
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| policy_error(format!("{what} has no string {key:?}")))
}

fn read_thresholds(rule: &Value, gate: &str) -> Result<Vec<Threshold>, GateError> {
    let list = rule
        .get("thresholds")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default();
    let mut out = Vec::new();
    for threshold in list {
        let what = format!("a threshold of {gate}");
        let comparison_text = text(threshold, "comparison", &what)?;
        let comparison = Comparison::parse(comparison_text).ok_or_else(|| {
            policy_error(format!("{what} has the comparison {comparison_text:?}"))
        })?;
        let value_text = text(threshold, "value", &what)?;
        let scenario_text = text(threshold, "cost_scenario", &what)?;
        let windows = threshold
            .get("windows")
            .and_then(Value::as_array)
            .map(Vec::as_slice)
            .unwrap_or_default()
            .iter()
            .map(|w| {
                w.as_str()
                    .and_then(Window::from_wire)
                    .ok_or_else(|| policy_error(format!("{what} names a window {w}")))
            })
            .collect::<Result<Vec<_>, _>>()?;
        out.push(Threshold {
            metric: text(threshold, "metric", &what)?.to_owned(),
            comparison,
            value: Q::parse(value_text).map_err(|e| policy_error(format!("{what}: {e}")))?,
            text: value_text.to_owned(),
            windows,
            scenario: Scenario::from_wire(scenario_text).ok_or_else(|| {
                policy_error(format!("{what} has the cost scenario {scenario_text:?}"))
            })?,
        });
    }
    Ok(out)
}

fn read_rules(policy: &Value) -> Result<Vec<GateRule>, GateError> {
    let gates = policy
        .get("gates")
        .and_then(Value::as_array)
        .ok_or_else(|| policy_error("the policy has no gates"))?;
    let mut out = Vec::new();
    let mut seen = BTreeSet::new();
    for entry in gates {
        let gate = text(entry, "gate", "a gate rule")?.to_owned();
        if !seen.insert(gate.clone()) {
            return Err(policy_error(format!("the gate {gate} is listed twice")));
        }
        let category = text(entry, "category", &gate)?.to_owned();
        let rule = match text(entry, "requirement", &gate)? {
            "REQUIRED" => Rule::Required {
                thresholds: read_thresholds(entry, &gate)?,
                below_is_fail: match text(entry, "below_threshold", &gate)? {
                    "FAIL" => true,
                    "INSUFFICIENT" => false,
                    other => {
                        return Err(policy_error(format!("{gate}: below_threshold {other:?}")));
                    }
                },
                limitation: entry
                    .get("limitation")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
            },
            "RECORDED_INSUFFICIENT" => Rule::RecordedInsufficient {
                reason: text(entry, "reason", &gate)?.to_owned(),
            },
            "NOT_APPLICABLE" => Rule::NotApplicable {
                reason: text(entry, "reason", &gate)?.to_owned(),
            },
            other => return Err(policy_error(format!("{gate}: requirement {other:?}"))),
        };
        out.push(GateRule {
            gate,
            category,
            rule,
        });
    }
    Ok(out)
}

// -------------------------------------------------------------------------------------------
// One decision
// -------------------------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Verdict {
    Pass,
    Fail,
    Insufficient,
}

#[derive(Clone, Debug)]
struct Decision {
    verdict: Verdict,
    /// For `INSUFFICIENT`.
    reason_code: &'static str,
    reason: String,
    evidence: Vec<String>,
    observations: Vec<Value>,
}

impl Decision {
    fn pass(evidence: Vec<String>, observations: Vec<Value>) -> Self {
        Self {
            verdict: Verdict::Pass,
            reason_code: "",
            reason: String::new(),
            evidence,
            observations,
        }
    }

    fn fail(evidence: Vec<String>, observations: Vec<Value>) -> Self {
        Self {
            verdict: Verdict::Fail,
            reason_code: "",
            reason: String::new(),
            evidence,
            observations,
        }
    }

    fn insufficient(code: &'static str, reason: impl Into<String>) -> Self {
        Self {
            verdict: Verdict::Insufficient,
            reason_code: code,
            reason: truncate_on_boundary(&reason.into(), MAX_REASON).to_owned(),
            evidence: Vec::new(),
            observations: Vec::new(),
        }
    }

    fn with(mut self, evidence: Vec<String>, observations: Vec<Value>) -> Self {
        self.evidence = evidence;
        self.observations = observations;
        self
    }
}

/// Why a run cannot supply evidence, as a reason code and text. `None` for a completed run.
fn unavailable(run: &RunEvidence) -> Option<(&'static str, String)> {
    let who = format!(
        "{} ({}, {})",
        run.run_id,
        run.window.wire(),
        run.scenario.wire()
    );
    if let Some(mismatch) = &run.unbound {
        return Some((
            "RUN_MISSING",
            format!("Run {who} does not bind to its slot of the plan: {mismatch}."),
        ));
    }
    match run.outcome {
        Outcome::Completed => None,
        Outcome::Missing => Some(("RUN_MISSING", format!("Run {who} has no result."))),
        Outcome::Failed(FailureCode::ArithmeticOverflow)
        | Outcome::NotPrepared(FailureCode::ArithmeticOverflow) => Some((
            "OUTSIDE_ENGINE_DOMAIN",
            format!("Run {who} failed with ARITHMETIC_OVERFLOW, outside the engine domain."),
        )),
        Outcome::Failed(code) | Outcome::NotPrepared(code) => {
            Some(("RUN_FAILED", format!("Run {who} failed with {code}.")))
        }
        Outcome::Insufficient(code) => Some((
            "RUN_INSUFFICIENT",
            format!("Run {who} ended with INSUFFICIENT evidence ({code}) and has no metrics."),
        )),
    }
}

fn digest_of(run: &RunEvidence) -> Result<String, GateError> {
    run.submission_digest.clone().ok_or_else(|| {
        GateError::Evidence(format!(
            "run {} supplies evidence but has no submission digest",
            run.run_id
        ))
    })
}

fn push_unique(list: &mut Vec<String>, item: String) {
    if !list.contains(&item) {
        list.push(item);
    }
}

fn metric_text(document: &Value, metric: &str) -> Result<Option<String>, GateError> {
    let strategy = document.get("strategy");
    let read = |node: Option<&Value>| -> Option<String> {
        let value = node?.get("value")?;
        value
            .as_str()
            .map(str::to_owned)
            .or_else(|| value.as_u64().map(|n| n.to_string()))
    };
    let held = document
        .get("benchmarks")
        .and_then(|b| b.get("buy_and_hold"));
    let computed = held.filter(|h| h.get("status").and_then(Value::as_str) == Some("COMPUTED"));
    Ok(match metric {
        "net_return"
        | "max_drawdown"
        | "worst_session_return"
        | "turnover"
        | "exposure"
        | "trade_count"
        | "scored_session_count" => read(strategy.and_then(|s| s.get(metric))),
        "execution_cost" => read(
            strategy
                .and_then(|s| s.get("execution_cost"))
                .and_then(|c| c.get("total")),
        ),
        "buy_and_hold_return" => read(computed.and_then(|h| h.get("net_return"))),
        "excess_return_over_buy_and_hold" => read(computed.and_then(|h| h.get("excess_return"))),
        other => {
            return Err(GateError::Policy(format!(
                "the metric {other:?} is unknown"
            )));
        }
    })
}

fn threshold_decision(
    rule: &GateRule,
    thresholds: &[Threshold],
    below_is_fail: bool,
    runs: &[RunEvidence],
) -> Result<Decision, GateError> {
    if thresholds.is_empty() {
        return Err(policy_error(format!(
            "{} is required and has no threshold",
            rule.gate
        )));
    }
    let mut observations = Vec::new();
    let mut evidence = Vec::new();
    let mut failed = false;
    let mut missing: Option<(&'static str, String)> = None;
    for threshold in thresholds {
        for window in &threshold.windows {
            let candidates: Vec<&RunEvidence> = runs
                .iter()
                .filter(|r| {
                    r.repeat_of.is_none() && r.window == *window && r.scenario == threshold.scenario
                })
                .collect();
            let [run] = candidates.as_slice() else {
                if candidates.is_empty() {
                    let reason = format!(
                        "No {} run of the {} window is part of the evidence.",
                        threshold.scenario.wire(),
                        window.wire()
                    );
                    missing.get_or_insert(("RUN_MISSING", reason));
                    continue;
                }
                // Several runs claim one window and scenario. When one of them does not bind to
                // its slot of the plan, the claim is the dispatch's mistake and the cell has no
                // evidence. Several runs that all bind cannot be told apart: a defect.
                if let Some(gap) = candidates
                    .iter()
                    .filter(|r| r.unbound.is_some())
                    .find_map(|r| unavailable(r))
                {
                    missing.get_or_insert(gap);
                    continue;
                }
                return Err(GateError::Evidence(format!(
                    "{} regular runs for the {} window under {}",
                    candidates.len(),
                    window.wire(),
                    threshold.scenario.wire()
                )));
            };
            if let Some((code, reason)) = unavailable(run) {
                missing.get_or_insert((code, reason));
                continue;
            }
            let Some(metrics) = &run.metrics else {
                missing.get_or_insert((
                    "METRICS_UNAVAILABLE",
                    format!("Run {} completed and has no metrics document.", run.run_id),
                ));
                continue;
            };
            if let Some(mismatch) = &metrics.unbound {
                missing.get_or_insert((
                    "METRICS_UNAVAILABLE",
                    format!(
                        "The metrics of run {} do not bind to it: {mismatch}.",
                        run.run_id
                    ),
                ));
                continue;
            }
            let Some(observed) = metric_text(&metrics.document, &threshold.metric)? else {
                let benchmark = matches!(
                    threshold.metric.as_str(),
                    "buy_and_hold_return" | "excess_return_over_buy_and_hold"
                );
                missing.get_or_insert(if benchmark {
                    (
                        "BENCHMARK_UNAVAILABLE",
                        format!(
                            "The buy-and-hold benchmark of run {} has no value.",
                            run.run_id
                        ),
                    )
                } else {
                    (
                        "METRICS_UNAVAILABLE",
                        format!(
                            "The metrics of run {} lack {}.",
                            run.run_id, threshold.metric
                        ),
                    )
                });
                continue;
            };
            let value = Q::parse(&observed).map_err(|e| {
                GateError::Evidence(format!(
                    "metric {} of run {}: {e}",
                    threshold.metric, run.run_id
                ))
            })?;
            let holds = threshold.comparison.holds(&value, &threshold.value);
            failed |= !holds;
            push_unique(&mut evidence, digest_of(run)?);
            observations.push(json!({
                "run_id": run.run_id,
                "metric": threshold.metric,
                "window": window.wire(),
                "cost_scenario": threshold.scenario.wire(),
                "observed": observed,
                "comparison": threshold.comparison.wire(),
                "threshold": threshold.text,
                "holds": holds,
            }));
        }
    }
    if failed {
        let decision = if below_is_fail {
            Decision::fail(evidence.clone(), observations.clone())
        } else {
            Decision::insufficient("BELOW_THRESHOLD", below_reason(&observations))
                .with(evidence, observations)
        };
        return Ok(decision);
    }
    if let Some((code, reason)) = missing {
        return Ok(Decision::insufficient(code, reason).with(evidence, observations));
    }
    Ok(Decision::pass(evidence, observations))
}

fn below_reason(observations: &[Value]) -> String {
    let failing: Vec<String> = observations
        .iter()
        .filter(|o| o.get("holds") == Some(&Value::Bool(false)))
        .map(|o| {
            format!(
                "{} {} {} in the {} window",
                o.get("metric").and_then(Value::as_str).unwrap_or(""),
                o.get("comparison").and_then(Value::as_str).unwrap_or(""),
                o.get("threshold").and_then(Value::as_str).unwrap_or(""),
                o.get("window").and_then(Value::as_str).unwrap_or("")
            )
        })
        .collect();
    format!("A threshold does not hold: {}.", failing.join("; "))
}

// -------------------------------------------------------------------------------------------
// Method-only gates
// -------------------------------------------------------------------------------------------

fn first_unavailable<'a>(
    runs: impl Iterator<Item = &'a RunEvidence>,
) -> Option<(&'static str, String)> {
    runs.filter_map(unavailable).next()
}

fn validation_decision(
    evidence: &CandidateEvidence,
    notes: &mut Vec<String>,
) -> Result<Decision, GateError> {
    let defect = evidence.runs.iter().find(|run| {
        run.unbound.is_none()
            && match run.outcome {
                Outcome::Failed(code) | Outcome::NotPrepared(code) => is_candidate_defect(code),
                _ => false,
            }
    });
    // A validation result that does not bind to the candidate is not cited, and decides nothing.
    let validation_digest = match &evidence.validation {
        ValidationEvidence::Valid { digest } | ValidationEvidence::Invalid { digest } => {
            Some(digest.clone())
        }
        ValidationEvidence::Unbound { .. } | ValidationEvidence::Missing => None,
    };
    if let Some(run) = defect {
        notes.push(format!(
            "DEFINITION_VALIDATION: run {} failed with a candidate defect: {:?}",
            run.run_id, run.outcome
        ));
        let mut cited: Vec<String> = validation_digest.into_iter().collect();
        push_unique(&mut cited, digest_of(run)?);
        return Ok(Decision::fail(cited, Vec::new()));
    }
    match validation_digest {
        Some(digest) if matches!(evidence.validation, ValidationEvidence::Invalid { .. }) => {
            notes
                .push("DEFINITION_VALIDATION: the validate job found the draft invalid".to_owned());
            Ok(Decision::fail(vec![digest], Vec::new()))
        }
        Some(digest) => Ok(Decision::pass(vec![digest], Vec::new())),
        None => Ok(match &evidence.validation {
            ValidationEvidence::Unbound { mismatch, .. } => {
                notes.push(format!(
                    "DEFINITION_VALIDATION: the validation result does not bind: {mismatch}"
                ));
                Decision::insufficient(
                    "VALIDATION_FAILED",
                    format!("The validation result does not bind to the candidate: {mismatch}."),
                )
            }
            _ => Decision::insufficient(
                "VALIDATION_FAILED",
                "No validation result is part of the evidence.",
            ),
        }),
    }
}

fn replay_decision(
    evidence: &CandidateEvidence,
    notes: &mut Vec<String>,
) -> Result<Decision, GateError> {
    let repeats: Vec<&RunEvidence> = evidence
        .runs
        .iter()
        .filter(|r| r.repeat_of.is_some())
        .collect();
    if repeats.is_empty() {
        return Ok(Decision::insufficient(
            "RUN_MISSING",
            "No deterministic repeat is part of the evidence.",
        ));
    }
    let mut cited = Vec::new();
    let mut differing = Vec::new();
    let mut missing = None;
    for repeat in repeats {
        let base = evidence
            .runs
            .iter()
            .find(|r| r.repeat_of.is_none() && Some(&r.run_id) == repeat.repeat_of.as_ref());
        let Some(base) = base else {
            missing.get_or_insert((
                "RUN_MISSING",
                format!(
                    "The run {} that {} repeats is not part of the evidence.",
                    repeat.repeat_of.clone().unwrap_or_default(),
                    repeat.run_id
                ),
            ));
            continue;
        };
        if let Some((code, reason)) = first_unavailable([base, repeat].into_iter()) {
            missing.get_or_insert((code, reason));
            continue;
        }
        let (Some(a), Some(b)) = (&base.result_digest, &repeat.result_digest) else {
            return Err(GateError::Evidence(format!(
                "completed runs {} and {} have no result digest",
                base.run_id, repeat.run_id
            )));
        };
        push_unique(&mut cited, digest_of(base)?);
        push_unique(&mut cited, digest_of(repeat)?);
        if a != b {
            differing.push(format!("{} and {}", base.run_id, repeat.run_id));
        }
    }
    if !differing.is_empty() {
        notes.push(format!(
            "DETERMINISTIC_REPLAY: different result digests for {}",
            differing.join("; ")
        ));
        return Ok(Decision::fail(cited, Vec::new()));
    }
    if let Some((code, reason)) = missing {
        return Ok(Decision::insufficient(code, reason).with(cited, Vec::new()));
    }
    Ok(Decision::pass(cited, Vec::new()))
}

fn audit_decision(
    gate: &str,
    runs: &[RunEvidence],
    pick: fn(&RunChecks) -> &Check,
    notes: &mut Vec<String>,
) -> Result<Decision, GateError> {
    if runs.is_empty() {
        return Ok(Decision::insufficient(
            "RUN_MISSING",
            "No run is part of the evidence.",
        ));
    }
    let mut cited = Vec::new();
    let mut failing = false;
    let mut missing = None;
    for run in runs {
        if let Some((code, reason)) = unavailable(run) {
            missing.get_or_insert((code, reason));
            continue;
        }
        let checks = run.checks.as_ref().ok_or_else(|| {
            GateError::Evidence(format!("completed run {} has no audit", run.run_id))
        })?;
        push_unique(&mut cited, digest_of(run)?);
        if let Check::Fail(detail) = pick(checks) {
            failing = true;
            notes.push(format!("{gate}: run {}: {detail}", run.run_id));
        }
    }
    if failing {
        return Ok(Decision::fail(cited, Vec::new()));
    }
    if let Some((code, reason)) = missing {
        return Ok(Decision::insufficient(code, reason).with(cited, Vec::new()));
    }
    Ok(Decision::pass(cited, Vec::new()))
}

fn point_in_time_decision(evidence: &CandidateEvidence, notes: &mut Vec<String>) -> Decision {
    let Some(manifest) = &evidence.manifest else {
        return Decision::insufficient(
            "RUN_MISSING",
            "No dataset manifest is part of the evidence.",
        );
    };
    // A manifest that is not the dataset of the runs says nothing about their data: it is not
    // read, and not cited.
    if let Some(mismatch) = &manifest.unbound {
        notes.push(format!(
            "POINT_IN_TIME_DATA: the manifest does not bind to the runs: {mismatch}"
        ));
        return Decision::insufficient(
            "RUN_MISSING",
            format!("The dataset manifest does not bind to the datasets of the runs: {mismatch}."),
        );
    }
    let cited = vec![manifest.digest.clone()];
    if manifest.bars_without_availability > 0 || manifest.actions_without_availability > 0 {
        notes.push(format!(
            "POINT_IN_TIME_DATA: {} bars and {} actions have no availability time",
            manifest.bars_without_availability, manifest.actions_without_availability
        ));
        return Decision::fail(cited, Vec::new());
    }
    let future = evidence.runs.iter().find(|r| {
        r.unbound.is_none()
            && matches!(
                r.outcome,
                Outcome::Failed(FailureCode::FutureData)
                    | Outcome::NotPrepared(FailureCode::FutureData)
            )
    });
    if let Some(run) = future {
        return Decision::insufficient(
            "RUN_FAILED",
            format!(
                "Run {} failed with FUTURE_DATA: the platform must find the cause.",
                run.run_id
            ),
        )
        .with(cited, Vec::new());
    }
    Decision::pass(cited, Vec::new())
}

/// Whether two values are equal when every decimal text is compared by value.
fn same_value(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::String(x), Value::String(y)) => match (Q::parse(x), Q::parse(y)) {
            (Ok(p), Ok(q)) => p == q,
            _ => x == y,
        },
        (Value::Object(x), Value::Object(y)) => {
            x.len() == y.len()
                && x.iter()
                    .all(|(k, v)| y.get(k).is_some_and(|w| same_value(v, w)))
        }
        (Value::Array(x), Value::Array(y)) => {
            x.len() == y.len() && x.iter().zip(y).all(|(p, q)| same_value(p, q))
        }
        _ => a == b,
    }
}

const COST_COMPONENTS: [&str; 3] = ["fixed_fee_per_fill", "fee_bps", "gap_exit_slippage_bps"];

/// Whether the policy of a run's input is the cohort's execution policy for the scenario: equal for
/// `BASE`, and for `COST_STRESS` equal except that each named cost component is multiplied by the
/// multiplier.
///
/// # Errors
/// [`GateError::Policy`] when the cohort policy lacks the members it needs.
pub fn cost_scenario_matches(
    cohort: &Value,
    scenario: Scenario,
    input_policy: &Value,
) -> Result<bool, GateError> {
    let conditions = cohort
        .get("conditions")
        .ok_or_else(|| policy_error("the policy has no conditions"))?;
    let base = conditions
        .get("execution_policy")
        .ok_or_else(|| policy_error("the policy has no execution policy"))?;
    let base_cost = base
        .get("cost_model")
        .ok_or_else(|| policy_error("no cost model"))?;
    let input_cost = input_policy.get("cost_model");
    let stress = conditions.get("cost_stress");
    let named: BTreeSet<&str> = stress
        .and_then(|s| s.get("components"))
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default()
        .iter()
        .filter_map(Value::as_str)
        .collect();
    let multiplier = match (
        scenario,
        stress
            .and_then(|s| s.get("multiplier"))
            .and_then(Value::as_str),
    ) {
        (Scenario::Base, _) => Q::one(),
        (Scenario::CostStress, Some(m)) => {
            Q::parse(m).map_err(|e| policy_error(format!("the multiplier: {e}")))?
        }
        (Scenario::CostStress, None) => return Err(policy_error("the policy has no cost stress")),
    };
    let without_cost = |policy: &Value| -> Value {
        let mut copy = policy.clone();
        if let Some(cost) = copy.get_mut("cost_model").and_then(Value::as_object_mut) {
            for key in COST_COMPONENTS {
                cost.remove(key);
            }
        }
        copy
    };
    if !same_value(&without_cost(base), &without_cost(input_policy)) {
        return Ok(false);
    }
    for key in COST_COMPONENTS {
        let (Some(expected), Some(actual)) = (
            base_cost.get(key).and_then(Value::as_str),
            input_cost.and_then(|c| c.get(key)).and_then(Value::as_str),
        ) else {
            return Ok(false);
        };
        let (Ok(expected), Ok(actual)) = (Q::parse(expected), Q::parse(actual)) else {
            return Ok(false);
        };
        let wanted = if scenario == Scenario::CostStress && named.contains(key) {
            &expected * &multiplier
        } else {
            expected
        };
        if wanted != actual {
            return Ok(false);
        }
    }
    Ok(true)
}

fn cost_model_decision(
    cohort: &Value,
    evidence: &CandidateEvidence,
    notes: &mut Vec<String>,
) -> Result<Decision, GateError> {
    if evidence.runs.is_empty() {
        return Ok(Decision::insufficient(
            "RUN_MISSING",
            "No run is part of the evidence.",
        ));
    }
    let mut cited = Vec::new();
    let mut failing = false;
    let mut missing = None;
    for run in &evidence.runs {
        let Some(policy) = run.input_policy.as_ref().filter(|_| run.unbound.is_none()) else {
            let (code, reason) = unavailable(run).unwrap_or((
                "RUN_MISSING",
                format!("Run {} has no input policy.", run.run_id),
            ));
            missing.get_or_insert((code, reason));
            continue;
        };
        push_unique(&mut cited, digest_of(run)?);
        if !cost_scenario_matches(cohort, run.scenario, policy)? {
            failing = true;
            notes.push(format!(
                "BASE_COST_MODEL: run {} does not carry the {} cost model of the cohort",
                run.run_id,
                run.scenario.wire()
            ));
        }
    }
    if failing {
        return Ok(Decision::fail(cited, Vec::new()));
    }
    if let Some((code, reason)) = missing {
        return Ok(Decision::insufficient(code, reason).with(cited, Vec::new()));
    }
    Ok(Decision::pass(cited, Vec::new()))
}

// -------------------------------------------------------------------------------------------
// The assessment
// -------------------------------------------------------------------------------------------

fn outcome_json(rule: &GateRule, decision: Decision, limitation: Option<&String>) -> Value {
    let mut out = serde_json::Map::new();
    let decided = decision.verdict != Verdict::Insufficient;
    out.insert(
        "result".to_owned(),
        json!(match decision.verdict {
            Verdict::Pass => "PASS",
            Verdict::Fail => "FAIL",
            Verdict::Insufficient => "INSUFFICIENT",
        }),
    );
    out.insert("gate".to_owned(), json!(rule.gate));
    out.insert("category".to_owned(), json!(rule.category));
    if decided {
        out.insert("evidence".to_owned(), json!(decision.evidence));
        out.insert("observations".to_owned(), json!(decision.observations));
    } else {
        out.insert("reason_code".to_owned(), json!(decision.reason_code));
        out.insert("reason".to_owned(), json!(decision.reason));
        if !decision.evidence.is_empty() {
            out.insert("evidence".to_owned(), json!(decision.evidence));
        }
        if !decision.observations.is_empty() {
            out.insert("observations".to_owned(), json!(decision.observations));
        }
    }
    if let Some(limitation) = limitation {
        out.insert("limitation".to_owned(), json!(limitation));
    }
    Value::Object(out)
}

fn undecided(rule: &GateRule, result: &str, reason: &str) -> Value {
    json!({
        "result": result,
        "gate": rule.gate,
        "category": rule.category,
        "reason_code": "POLICY_RECORDED",
        "reason": reason,
    })
}

const THRESHOLD_GATES: [&str; 4] = [
    "EXCESS_OVER_BUY_AND_HOLD",
    "WALK_FORWARD",
    "MINIMUM_TRADE_COUNT",
    "COST_STRESS",
];

fn collect_inputs(evidence: &CandidateEvidence) -> Vec<GateInput> {
    let mut inputs: Vec<GateInput> = Vec::new();
    let mut add = |kind: &'static str, run_id: Option<&String>, digest: &String| {
        let input = GateInput {
            kind,
            run_id: run_id.cloned(),
            digest: digest.clone(),
        };
        if !inputs.contains(&input) {
            inputs.push(input);
        }
    };
    if let Some(digest) = &evidence.plan_digest {
        add("EVALUATION_PLAN", None, digest);
    }
    match &evidence.validation {
        ValidationEvidence::Valid { digest }
        | ValidationEvidence::Invalid { digest }
        | ValidationEvidence::Unbound { digest, .. } => add("VALIDATION_RESULT", None, digest),
        ValidationEvidence::Missing => {}
    }
    for run in &evidence.runs {
        if let Some(digest) = &run.submission_digest {
            add("EVALUATION_SUBMISSION", Some(&run.run_id), digest);
        }
        if let Some(digest) = &run.result_digest {
            add("EVALUATION_RESULT", Some(&run.run_id), digest);
        }
        if let Some(metrics) = &run.metrics {
            add("EVALUATION_METRICS", Some(&run.run_id), &metrics.digest);
        }
    }
    if let Some(manifest) = &evidence.manifest {
        add("DATASET_MANIFEST", None, &manifest.digest);
    }
    inputs
}

/// Decide every gate of the policy for one candidate.
///
/// `policy` is a validated `cohort-policy/1`.
///
/// # Errors
/// [`GateError`] when the policy or the evidence cannot be used. A candidate that fails a gate is
/// not an error: the gate's outcome says so.
pub fn assess(policy: &Value, evidence: &CandidateEvidence) -> Result<Assessment, GateError> {
    let rules = read_rules(policy)?;
    let mut gates = Vec::new();
    let mut notes = Vec::new();
    for rule in &rules {
        let value = match &rule.rule {
            Rule::NotApplicable { reason } => undecided(rule, "NOT_APPLICABLE", reason),
            Rule::RecordedInsufficient { reason } => undecided(rule, "INSUFFICIENT", reason),
            Rule::Required {
                thresholds,
                below_is_fail,
                limitation,
            } => {
                let gate = rule.gate.as_str();
                let decision = if THRESHOLD_GATES.contains(&gate) {
                    threshold_decision(rule, thresholds, *below_is_fail, &evidence.runs)?
                } else {
                    if !thresholds.is_empty() {
                        return Err(policy_error(format!(
                            "{gate} has a fixed method and carries thresholds"
                        )));
                    }
                    match gate {
                        "DEFINITION_VALIDATION" => validation_decision(evidence, &mut notes)?,
                        "DETERMINISTIC_REPLAY" => replay_decision(evidence, &mut notes)?,
                        "ACCOUNTING_RECONCILIATION" => {
                            audit_decision(gate, &evidence.runs, |c| &c.reconciliation, &mut notes)?
                        }
                        "SIGNAL_DATA_TIMING" => {
                            audit_decision(gate, &evidence.runs, |c| &c.timing, &mut notes)?
                        }
                        "POINT_IN_TIME_DATA" => point_in_time_decision(evidence, &mut notes),
                        "BASE_COST_MODEL" => cost_model_decision(policy, evidence, &mut notes)?,
                        other => return Err(GateError::UnsupportedRequiredGate(other.to_owned())),
                    }
                };
                outcome_json(rule, decision, limitation.as_ref())
            }
        };
        gates.push(value);
    }
    Ok(Assessment {
        inputs: collect_inputs(evidence),
        gates,
        notes,
    })
}

/// The envelope around the gates of one `assess` attempt.
#[derive(Clone, Debug)]
pub struct ReportContext<'a> {
    pub job_id: &'a str,
    /// `{"attempt_id", "ownership_revision"}`.
    pub attempt: Value,
    /// `{"name", "version", "digest"}` of the executable that ran.
    pub executable: Value,
    pub method: &'a MethodRef,
    pub strategy_hash: &'a str,
    /// `{"id", "revision", "digest"}` of the cohort policy.
    pub cohort_policy: Value,
    /// The measured duration, as `connected-common` states it.
    pub duration: Value,
}

/// Build the `gate-report/1` of an assessment.
///
/// # Errors
/// [`GateError::Limit`] when a list is longer than the schema allows, [`GateError::Evidence`] when
/// a gate cites a digest that is not among the inputs, and [`GateError::Contract`] when the
/// finished report fails its schema.
pub fn report(
    context: &ReportContext<'_>,
    assessment: &Assessment,
) -> Result<g::GateReport, GateError> {
    if assessment.inputs.len() > MAX_INPUTS {
        return Err(GateError::Limit(format!(
            "{} inputs exceed the limit of {MAX_INPUTS}",
            assessment.inputs.len()
        )));
    }
    if assessment.gates.len() > MAX_GATES {
        return Err(GateError::Limit(format!(
            "{} gates exceed the limit of {MAX_GATES}",
            assessment.gates.len()
        )));
    }
    let known: BTreeSet<&str> = assessment
        .inputs
        .iter()
        .map(|i| i.digest.as_str())
        .collect();
    for gate in &assessment.gates {
        for key in ["evidence", "observations"] {
            let list = gate.get(key).and_then(Value::as_array).map_or(0, Vec::len);
            if list > MAX_LIST {
                return Err(GateError::Limit(format!(
                    "a gate lists {list} {key}, above the limit of {MAX_LIST}"
                )));
            }
        }
        for cited in gate
            .get("evidence")
            .and_then(Value::as_array)
            .map(Vec::as_slice)
            .unwrap_or_default()
        {
            if !cited.as_str().is_some_and(|d| known.contains(d)) {
                return Err(GateError::Evidence(format!(
                    "a gate cites {cited}, which is not among the inputs"
                )));
            }
        }
    }
    let inputs: Vec<Value> = assessment
        .inputs
        .iter()
        .map(|i| match &i.run_id {
            Some(run) => json!({"kind": i.kind, "run_id": run, "digest": i.digest}),
            None => json!({"kind": i.kind, "digest": i.digest}),
        })
        .collect();
    let document = json!({
        "schema_version": "gate-report/1",
        "job_id": context.job_id,
        "attempt": context.attempt,
        "executable": context.executable,
        "method": context.method.to_value(),
        "strategy_hash": context.strategy_hash,
        "cohort_policy": context.cohort_policy,
        "inputs": inputs,
        "gates": assessment.gates,
        "duration": context.duration,
    });
    parse_value::<g::GateReport>(document).map_err(|e| GateError::Contract(e.to_string()))
}

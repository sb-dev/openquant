//! Evaluate one case and run the repeatability, schema and restore checks.
//!
//! The harness holds no numerical logic. It parses the documents, drives the shared core,
//! serialises the shared result, and compares the result with the independent expectation.

use std::sync::atomic::{AtomicUsize, Ordering};

use openquant_contracts::{
    Checkpoint, ContractError, EvaluationInput, EvaluationResult, StrategyArtefact, canonical_json,
    parse, payload_digest, to_value,
};
use openquant_core::{
    Failure, Run, State, interfaces::MarketEvent, model::status_of, result::early_failure,
};
use serde_json::{Value, json};

use crate::{
    case::Case,
    compare::{Comparison, Mismatch, SectionCount, compare_detailed},
};

/// Outcome of restoring from every phase boundary.
#[derive(Clone, Debug)]
pub struct RestoreCheck {
    /// Number of cut points tried (every boundary from before the first event to the last
    /// completed event).
    pub cuts: usize,
    /// Cut points that also went through the checkpoint schema as text and were run to the end
    /// and compared byte for byte with the uninterrupted result.
    pub deep: usize,
    /// The first cut whose restored state or continued run differed from uninterrupted
    /// execution.
    pub first_mismatch: Option<usize>,
    /// Why the first mismatching cut failed.
    pub detail: Option<String>,
}

/// Everything the report needs about one case.
#[derive(Clone, Debug)]
pub struct CaseReport {
    pub id: String,
    pub title: String,
    /// The S0 rows of OQ-06 section 8 this case declares.
    pub covers: Vec<String>,
    /// The case directory name below `cases/`.
    pub case_dir: String,
    /// How the expected values were derived (`origin` of `expected.json`).
    pub origin: String,
    pub strategy_hash: Option<String>,
    pub input_hash: Option<String>,
    pub engine_digest: Option<String>,
    /// The engine identity object of the shared result.
    pub engine: Option<Value>,
    /// Canonical JSON of the shared result, when a result exists.
    pub result_text: Option<String>,
    pub result: Option<EvaluationResult>,
    /// The outcome object (status, code, location, detail).
    pub outcome: Value,
    /// False when the case was rejected before the first event was processed.
    pub started: bool,
    /// An error in the harness itself (not a numerical difference).
    pub error: Option<String>,
    /// A second evaluation from freshly parsed documents produced identical bytes.
    pub repeat_identical: Option<bool>,
    /// The result validates against the shared result schema and round-trips unchanged.
    pub result_schema: Option<Result<(), String>>,
    pub restore: Option<RestoreCheck>,
    /// Checks the expectation states (scalars plus array lengths).
    pub expected_fields: usize,
    /// Checks that matched.
    pub matched_fields: usize,
    pub sections: Vec<SectionCount>,
    pub mismatches: Vec<Mismatch>,
    pub passed: bool,
}

fn failure_outcome(failure: &Failure) -> Value {
    json!({
        "status": status_of(failure.code).to_string(),
        "code": failure.code.to_string(),
        "detail": failure.detail,
    })
}

fn contract_outcome(error: &ContractError) -> Value {
    let code = error.failure_code();
    json!({
        "status": status_of(code).to_string(),
        "code": code.to_string(),
        "detail": error.to_string(),
    })
}

fn actual_view(result: &Value) -> Value {
    let journal = &result["journal"];
    json!({
        "outcome": result["outcome"],
        "signals": journal["signals"],
        "entries": journal["entries"],
        "fills": journal["fills"],
        "trades": journal["trades"],
        "cash_ledger": journal["cash_ledger"],
        "daily": journal["daily"],
        "corporate_actions": journal["corporate_actions"],
        "final": result["final"],
    })
}

fn expectation(case: &Case) -> &Value {
    case.expected.get("expect").unwrap_or(&Value::Null)
}

/// `kind (oracle script, sha256)` from the `origin` object of `expected.json`.
fn origin_text(expected: &Value) -> String {
    let origin = &expected["origin"];
    let Some(kind) = origin["kind"].as_str() else {
        return "not stated".to_owned();
    };
    match (origin["oracle"].as_str(), origin["oracle_sha256"].as_str()) {
        (Some(script), Some(sha)) => format!("{kind}: `{script}` sha256 `{sha}`"),
        (Some(script), None) => format!("{kind}: `{script}`"),
        _ => kind.to_owned(),
    }
}

/// A report with the case metadata filled in and nothing else decided yet.
fn blank(case: &Case, comparison: Comparison, outcome: Value) -> CaseReport {
    CaseReport {
        id: case.file.id.clone(),
        title: case.file.title.clone(),
        covers: case.file.covers.clone(),
        case_dir: case
            .dir
            .file_name()
            .map_or_else(String::new, |n| n.to_string_lossy().into_owned()),
        origin: origin_text(&case.expected),
        strategy_hash: None,
        input_hash: None,
        engine_digest: None,
        engine: None,
        result_text: None,
        result: None,
        outcome,
        started: false,
        error: None,
        repeat_identical: None,
        result_schema: None,
        restore: None,
        expected_fields: comparison.expected(),
        matched_fields: comparison.matched(),
        passed: comparison.is_match(),
        sections: comparison.sections,
        mismatches: comparison.mismatches,
    }
}

fn result_text(
    run: &Run,
    state: &State,
    failure: Option<&Failure>,
) -> Result<(EvaluationResult, String), String> {
    let result = run.result(state, failure).map_err(|f| f.to_string())?;
    let value = to_value(&result).map_err(|e| e.to_string())?;
    let text = canonical_json(&value).map_err(|e| e.to_string())?;
    Ok((result, text))
}

/// Serialise any checkpoint through the shared schema, as a stored checkpoint would be.
fn checkpoint_roundtrip(checkpoint: &Checkpoint) -> Result<Checkpoint, String> {
    let text = canonical_json(&to_value(checkpoint).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    parse(&text).map_err(|e| e.to_string())
}

/// Runs with at most this many events get the deep check at every cut point. The deep check
/// serialises the checkpoint as schema-validated text and runs the restored state to the end.
/// Longer runs get it at a spread of cuts so the local replay stays quick; every cut is still
/// checkpointed, restored on a freshly prepared run and compared field by field with the
/// uninterrupted state.
const DEEP_CHECK_EVERY_CUT_UP_TO: usize = 128;

/// Number of evenly spread cuts that get the deep check in a longer run.
const DEEP_CHECKS_IN_LONG_RUNS: usize = 16;

/// Whether the cut gets the deep check.
fn is_deep(cut: usize, last: usize) -> bool {
    if last <= DEEP_CHECK_EVERY_CUT_UP_TO {
        return true;
    }
    let stride = last.div_ceil(DEEP_CHECKS_IN_LONG_RUNS);
    cut.is_multiple_of(stride) || cut == last
}

/// The first field in which two states differ, compared by value (a decimal 0 equals 0.00).
fn state_difference(left: &State, right: &State) -> Option<&'static str> {
    let fields = [
        ("next event", left.next == right.next),
        (
            "cash available",
            left.cash_available == right.cash_available,
        ),
        ("cash reserved", left.cash_reserved == right.cash_reserved),
        ("receivables", left.receivables == right.receivables),
        ("positions", left.positions == right.positions),
        ("pending entries", left.pending == right.pending),
        ("applied action identities", left.applied == right.applied),
        ("journal", left.journal == right.journal),
    ];
    fields
        .into_iter()
        .find_map(|(name, equal)| (!equal).then_some(name))
}

/// Checkpoint `state`, restore it on a freshly prepared run and compare. `state` is the
/// uninterrupted state after `cut` events. With a `baseline` (the deep check) the checkpoint
/// also goes through the shared schema as text and the restored run continues to the end.
fn check_cut(
    run: &Run,
    restart: &Run,
    state: &State,
    events: &[MarketEvent],
    cut: usize,
    baseline: Option<&str>,
) -> Result<(), String> {
    let mut checkpoint = run.checkpoint(state).map_err(|f| f.to_string())?;
    if baseline.is_some() {
        checkpoint = checkpoint_roundtrip(&checkpoint)?;
    }
    // The restoring side is prepared again from the documents, as a restarted process would be.
    let restored = restart
        .restore(&checkpoint)
        .map_err(|f| format!("restore failed: {f}"))?;
    // `Run::step` is a pure function of its arguments, so identical states continue
    // identically. The comparison covers every state field, including the journal.
    if let Some(field) = state_difference(state, &restored) {
        return Err(format!(
            "the restored state differs from the uninterrupted state in {field}"
        ));
    }
    if let Some(baseline) = baseline {
        let (end, failure) = restart.run_events(restored, events.get(cut..).unwrap_or_default());
        let (_, text) = result_text(restart, &end, failure.as_ref())?;
        if text != baseline {
            return Err("the continued run differs from uninterrupted execution".to_owned());
        }
    }
    Ok(())
}

fn restore_check(
    run: &Run,
    restart: &Run,
    baseline: &str,
    completed: usize,
) -> Result<RestoreCheck, String> {
    let events = run.events().map_err(|f| f.to_string())?;
    let last = completed.min(events.len());
    let mut state = run.initial_state().map_err(|f| f.to_string())?;
    let mut check = RestoreCheck {
        cuts: last + 1,
        deep: 0,
        first_mismatch: None,
        detail: None,
    };
    for cut in 0..=last {
        let deep = is_deep(cut, last);
        if deep {
            check.deep += 1;
        }
        let verdict = check_cut(run, restart, &state, &events, cut, deep.then_some(baseline));
        if let Err(problem) = verdict
            && check.first_mismatch.is_none()
        {
            check.first_mismatch = Some(cut);
            check.detail = Some(match events.get(cut) {
                Some(event) => format!("cut before {}: {problem}", event.cursor),
                None => format!("cut after the last event: {problem}"),
            });
        }
        if let Some(event) = events.get(cut).filter(|_| cut < last) {
            state = run.step(&state, event).map_err(|f| f.to_string())?.state;
        }
    }
    Ok(check)
}

/// Evaluate every case, spreading the cases over the available processors.
///
/// Cases are independent, so the reports are the same as evaluating them one after another and
/// keep the order of `cases`.
///
/// # Panics
/// Resumes a panic raised in a worker. `run_case` is total, so this signals a harness bug.
#[must_use]
pub fn run_cases(cases: &[Case]) -> Vec<CaseReport> {
    let workers = std::thread::available_parallelism()
        .map_or(1, usize::from)
        .min(cases.len())
        .max(1);
    let next = &AtomicUsize::new(0);
    let mut done: Vec<(usize, CaseReport)> = Vec::with_capacity(cases.len());
    std::thread::scope(|scope| {
        let handles: Vec<_> = (0..workers)
            .map(|_| {
                scope.spawn(move || {
                    let mut mine = Vec::new();
                    loop {
                        let index = next.fetch_add(1, Ordering::Relaxed);
                        let Some(case) = cases.get(index) else {
                            break;
                        };
                        mine.push((index, run_case(case)));
                    }
                    mine
                })
            })
            .collect();
        for handle in handles {
            match handle.join() {
                Ok(mine) => done.extend(mine),
                Err(payload) => std::panic::resume_unwind(payload),
            }
        }
    });
    done.sort_by_key(|(index, _)| *index);
    done.into_iter().map(|(_, report)| report).collect()
}

/// Evaluate a case.
#[must_use]
pub fn run_case(case: &Case) -> CaseReport {
    let expect = expectation(case);
    let strategy: StrategyArtefact = match parse(&case.strategy_text) {
        Ok(strategy) => strategy,
        Err(error) => return rejected(case, None, contract_outcome(&error)),
    };
    let input: EvaluationInput = match parse(&case.input_text) {
        Ok(input) => input,
        Err(error) => return rejected(case, None, contract_outcome(&error)),
    };
    let run = match Run::prepare(&strategy, &input) {
        Ok(run) => run,
        Err(failure) => {
            let early = early_result(&strategy, &input, &failure);
            return rejected(case, early, failure_outcome(&failure));
        }
    };
    match execute(case, &strategy, &input, &run) {
        Ok(report) => report,
        Err(message) => {
            let comparison = compare_detailed(expect, &json!({}));
            let outcome = json!({ "status": "HARNESS_ERROR", "detail": message });
            let mut report = blank(case, comparison, outcome);
            report.error = Some(message);
            report.passed = false;
            report
        }
    }
}

/// The shared result for a run that failed before its first event, with its canonical text.
fn early_result(
    strategy: &StrategyArtefact,
    input: &EvaluationInput,
    failure: &Failure,
) -> Option<(EvaluationResult, String)> {
    let result = early_failure(
        &payload_digest(strategy).ok()?,
        &payload_digest(input).ok()?,
        failure,
    )
    .ok()?;
    let text = canonical_json(&to_value(&result).ok()?).ok()?;
    Some((result, text))
}

/// A case rejected before any event was processed. The shared result exists when both
/// documents parsed, so identities and zero state stay inspectable.
fn rejected(case: &Case, early: Option<(EvaluationResult, String)>, outcome: Value) -> CaseReport {
    let expect = expectation(case);
    let Some((result, text)) = early else {
        let comparison = compare_detailed(expect, &json!({ "outcome": outcome }));
        return blank(case, comparison, outcome);
    };
    let value = to_value(&result).unwrap_or(Value::Null);
    let comparison = compare_detailed(expect, &actual_view(&value));
    let mut report = blank(case, comparison, value["outcome"].clone());
    report.strategy_hash = Some(result.strategy_hash.to_string());
    report.input_hash = Some(result.input_hash.to_string());
    report.engine_digest = Some(result.engine_digest.to_string());
    report.engine = Some(value["engine"].clone());
    report.result_text = Some(text);
    report.result = Some(result);
    report
}

/// A second evaluation from freshly parsed documents, using the other driver path
/// (`run_to_end` from the initial state). Returns the canonical result text.
fn repeat_text(case: &Case) -> Result<String, String> {
    let strategy: StrategyArtefact = parse(&case.strategy_text).map_err(|e| e.to_string())?;
    let input: EvaluationInput = parse(&case.input_text).map_err(|e| e.to_string())?;
    let run = Run::prepare(&strategy, &input).map_err(|f| f.to_string())?;
    let initial = run.initial_state().map_err(|f| f.to_string())?;
    let (end, failure) = run.run_to_end(initial);
    result_text(&run, &end, failure.as_ref()).map(|(_, text)| text)
}

/// The result text must validate against the shared schema and survive a parse and
/// serialise round trip unchanged.
fn schema_check(text: &str) -> Result<(), String> {
    let parsed: EvaluationResult = parse(text).map_err(|e| e.to_string())?;
    let again = canonical_json(&to_value(&parsed).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    if again == text {
        Ok(())
    } else {
        Err("the result changes when parsed and serialised again".to_owned())
    }
}

fn execute(
    case: &Case,
    strategy: &StrategyArtefact,
    input: &EvaluationInput,
    run: &Run,
) -> Result<CaseReport, String> {
    let events = run.events().map_err(|f| f.to_string())?;
    let initial = run.initial_state().map_err(|f| f.to_string())?;
    let (end, failure) = run.run_events(initial, &events);
    let (result, text) = result_text(run, &end, failure.as_ref())?;

    let repeat_identical = repeat_text(case).is_ok_and(|again| again == text);
    let result_schema = schema_check(&text);

    let completed = match &end.next {
        None => events.len(),
        Some(next) => events
            .iter()
            .position(|event| &event.cursor == next)
            .unwrap_or(events.len()),
    };
    let restore = if case.file.restore_every_cut {
        let restart = Run::prepare(strategy, input).map_err(|f| f.to_string())?;
        Some(restore_check(run, &restart, &text, completed)?)
    } else {
        None
    };

    let value = to_value(&result).map_err(|e| e.to_string())?;
    let comparison = compare_detailed(expectation(case), &actual_view(&value));
    let mut report = blank(case, comparison, value["outcome"].clone());
    report.passed = report.passed
        && repeat_identical
        && result_schema.is_ok()
        && restore.as_ref().is_none_or(|r| r.first_mismatch.is_none());
    report.strategy_hash = Some(result.strategy_hash.to_string());
    report.input_hash = Some(result.input_hash.to_string());
    report.engine_digest = Some(result.engine_digest.to_string());
    report.engine = Some(value["engine"].clone());
    report.result_text = Some(text);
    report.result = Some(result);
    report.started = true;
    report.repeat_identical = Some(repeat_identical);
    report.result_schema = Some(result_schema);
    report.restore = restore;
    Ok(report)
}

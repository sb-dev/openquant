//! Evaluate one case and run the repeatability and restore checks.

use openquant_contracts::{
    Checkpoint, ContractError, EvaluationInput, EvaluationResult, StrategyArtefact, canonical_json,
    parse, to_value,
};
use openquant_core::{Failure, Run, State, model::status_of};
use serde_json::{Value, json};

use crate::{
    case::Case,
    compare::{Mismatch, compare, count_expected},
};

/// Outcome of restoring from every phase boundary.
#[derive(Clone, Debug)]
pub struct RestoreCheck {
    /// Number of cut points tried (every boundary from before the first event to the end).
    pub cuts: usize,
    /// The first cut whose restored run differed from uninterrupted execution.
    pub first_mismatch: Option<usize>,
}

/// Everything the report needs about one case.
#[derive(Clone, Debug)]
pub struct CaseReport {
    pub id: String,
    pub title: String,
    pub covers: Vec<String>,
    pub strategy_hash: Option<String>,
    pub input_hash: Option<String>,
    pub engine_digest: Option<String>,
    /// Canonical JSON of the shared result, when a run started.
    pub result_text: Option<String>,
    pub result: Option<EvaluationResult>,
    /// The outcome object (status, code, location, detail).
    pub outcome: Value,
    pub repeat_identical: Option<bool>,
    pub restore: Option<RestoreCheck>,
    pub expected_fields: usize,
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

fn early(case: &Case, outcome: Value) -> CaseReport {
    let mismatches = compare(
        case.expected.get("expect").unwrap_or(&Value::Null),
        &json!({ "outcome": outcome }),
    );
    CaseReport {
        id: case.file.id.clone(),
        title: case.file.title.clone(),
        covers: case.file.covers.clone(),
        strategy_hash: None,
        input_hash: None,
        engine_digest: None,
        result_text: None,
        result: None,
        outcome,
        repeat_identical: None,
        restore: None,
        expected_fields: count_expected(case.expected.get("expect").unwrap_or(&Value::Null)),
        passed: mismatches.is_empty(),
        mismatches,
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

fn restore_check(run: &Run, baseline: &str, completed: usize) -> Result<RestoreCheck, String> {
    let events = run.events().map_err(|f| f.to_string())?;
    let initial = run.initial_state().map_err(|f| f.to_string())?;
    let mut first_mismatch = None;
    for cut in 0..=completed.min(events.len()) {
        let (prefix, failure) = run.run_events(initial.clone(), &events[..cut]);
        if failure.is_some() {
            first_mismatch.get_or_insert(cut);
            continue;
        }
        let checkpoint = run.checkpoint(&prefix).map_err(|f| f.to_string())?;
        // Round trip through the shared schema, as a stored checkpoint would.
        let text = canonical_json(&to_value(&checkpoint).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
        let checkpoint: Checkpoint = parse(&text).map_err(|e| e.to_string())?;
        let restored = run.restore(&checkpoint).map_err(|f| f.to_string())?;
        let (end, failure) = run.run_events(restored, &events[cut..]);
        let (_, again) = result_text(run, &end, failure.as_ref())?;
        if again != baseline {
            first_mismatch.get_or_insert(cut);
        }
    }
    Ok(RestoreCheck {
        cuts: completed.min(events.len()) + 1,
        first_mismatch,
    })
}

/// Evaluate a case.
#[must_use]
pub fn run_case(case: &Case) -> CaseReport {
    let strategy: StrategyArtefact = match parse(&case.strategy_text) {
        Ok(strategy) => strategy,
        Err(error) => return early(case, contract_outcome(&error)),
    };
    let input: EvaluationInput = match parse(&case.input_text) {
        Ok(input) => input,
        Err(error) => return early(case, contract_outcome(&error)),
    };
    let run = match Run::prepare(&strategy, &input) {
        Ok(run) => run,
        Err(failure) => return early(case, failure_outcome(&failure)),
    };
    match execute(case, &run) {
        Ok(report) => report,
        Err(message) => {
            let mut report = early(
                case,
                json!({ "status": "FAILED", "code": "INVALID_INPUT", "detail": message }),
            );
            report.passed = false;
            report
        }
    }
}

fn execute(case: &Case, run: &Run) -> Result<CaseReport, String> {
    let events = run.events().map_err(|f| f.to_string())?;
    let initial = run.initial_state().map_err(|f| f.to_string())?;
    let (end, failure) = run.run_events(initial, &events);
    let (result, text) = result_text(run, &end, failure.as_ref())?;

    // A second, independent evaluation must agree byte for byte.
    let (end_again, failure_again) =
        run.run_to_end(run.initial_state().map_err(|f| f.to_string())?);
    let (_, text_again) = result_text(run, &end_again, failure_again.as_ref())?;
    let repeat_identical = text == text_again;

    let completed = match &end.next {
        None => events.len(),
        Some(next) => events
            .iter()
            .position(|event| &event.cursor == next)
            .unwrap_or(events.len()),
    };
    let restore = if case.file.restore_every_cut {
        Some(restore_check(run, &text, completed)?)
    } else {
        None
    };

    let value = to_value(&result).map_err(|e| e.to_string())?;
    let expect = case.expected.get("expect").unwrap_or(&Value::Null);
    let mismatches = compare(expect, &actual_view(&value));
    let passed = mismatches.is_empty()
        && repeat_identical
        && restore.as_ref().is_none_or(|r| r.first_mismatch.is_none());
    Ok(CaseReport {
        id: case.file.id.clone(),
        title: case.file.title.clone(),
        covers: case.file.covers.clone(),
        strategy_hash: Some(result.strategy_hash.to_string()),
        input_hash: Some(result.input_hash.to_string()),
        engine_digest: Some(result.engine_digest.to_string()),
        outcome: value["outcome"].clone(),
        result_text: Some(text),
        result: Some(result),
        repeat_identical: Some(repeat_identical),
        restore,
        expected_fields: count_expected(expect),
        mismatches,
        passed,
    })
}

//! The inner evaluation input of a provider run, built in Rust from the frozen dataset manifest
//! and the evaluation request (OQ-05 sections 4 and 7; decision D14).
//!
//! The evaluate job builds this document, uploads it and reports its hash. The API then checks
//! that the input repeats the windows, the cutoff, the capital, the execution policy and the seed
//! of the request and the dataset and instrument of the manifest. The builder is pure: it reads no
//! clock, file or network, and it selects; it never computes a price, an availability time or a
//! number. Everything numerical was written by the normaliser into the manifest.
//!
//! The rules, in order:
//!
//! 1. The calendar of the run starts at `windows.warmup_start` and ends at the later of
//!    `windows.scored_end` and the latest payment session of a cash dividend of the run. A
//!    payment session after the scored end extends the calendar only: the core processes no event
//!    after the scored end, so the receivable stays in equity (decision record, dividend payment).
//! 2. The run holds the actions whose effective session lies from `warmup_start` to `scored_end`,
//!    the bars from `warmup_start` to `scored_end` and the unplanned events of the same sessions.
//!    Nothing is dropped inside that range, and an unsupported action stays in so that the core
//!    reports it (OQ-02 section 1.1).
//! 3. The document must pass `evaluation-input/1`. Any other problem is a [`Failure`] with the
//!    code that the core would give, so the job reports it as `NOT_PREPARED`.

use openquant_contracts::{EvaluationInput, parse_value};
use openquant_core::{Failure, FailureCode};
use serde_json::{Value, json};

/// The most sessions of one run (the core's limit).
pub const MAX_SESSIONS: usize = 400;

fn invalid(detail: String) -> Failure {
    Failure::new(FailureCode::InvalidInput, detail)
}

fn text<'a>(value: &'a Value, pointer: &str) -> Result<&'a str, Failure> {
    value
        .pointer(pointer)
        .and_then(Value::as_str)
        .ok_or_else(|| invalid(format!("{pointer} is missing or not text")))
}

fn array<'a>(value: &'a Value, pointer: &str) -> Result<&'a Vec<Value>, Failure> {
    value
        .pointer(pointer)
        .and_then(Value::as_array)
        .ok_or_else(|| invalid(format!("{pointer} is missing or not a list")))
}

fn session_of(item: &Value, key: &str) -> Option<String> {
    item.get(key).and_then(Value::as_str).map(str::to_owned)
}

/// Build `evaluation-input/1` for one run.
///
/// `manifest` is a validated `dataset-manifest/1`, `source` the `input` member of a validated
/// `BacktestRequest` (its `ManifestInputSource`) and `strategy_hash` the digest of the strategy
/// artefact.
///
/// # Errors
/// [`Failure`] with `INVALID_INPUT` when the windows do not fit the manifest calendar, a payment
/// session is not in it or the run has more than 400 sessions; the contract code when the built
/// document is not a valid `evaluation-input/1`.
pub fn build_input(
    strategy_hash: &str,
    operator_set: &str,
    manifest: &Value,
    source: &Value,
) -> Result<(Value, EvaluationInput), Failure> {
    let warmup_start = text(source, "/windows/warmup_start")?;
    let scored_start = text(source, "/windows/scored_start")?;
    let scored_end = text(source, "/windows/scored_end")?;
    if !(warmup_start <= scored_start && scored_start <= scored_end) {
        return Err(invalid(
            "the windows must satisfy warmup_start <= scored_start <= scored_end".to_owned(),
        ));
    }
    let calendar = array(manifest, "/content/calendar")?;
    let sessions: Vec<&str> = calendar
        .iter()
        .filter_map(|row| row.get("session").and_then(Value::as_str))
        .collect();
    for (what, session) in [
        ("warmup_start", warmup_start),
        ("scored_start", scored_start),
        ("scored_end", scored_end),
    ] {
        if !sessions.contains(&session) {
            return Err(invalid(format!(
                "{what} {session} is not a session of the dataset manifest calendar"
            )));
        }
    }
    let in_run = |session: &str| session >= warmup_start && session <= scored_end;

    let mut actions: Vec<Value> = Vec::new();
    let mut calendar_end = scored_end.to_owned();
    for action in array(manifest, "/content/corporate_actions")? {
        let Some(effective) = session_of(action, "effective_session") else {
            return Err(invalid(
                "a corporate action has no effective_session".to_owned(),
            ));
        };
        if !in_run(&effective) {
            continue;
        }
        if let Some(payment) = session_of(action, "payment_session") {
            if !sessions.contains(&payment.as_str()) {
                return Err(invalid(format!(
                    "a dividend pays on {payment}, which is not a session of the dataset manifest calendar"
                )));
            }
            if payment > calendar_end {
                calendar_end = payment;
            }
        }
        actions.push(action.clone());
    }

    let run_calendar: Vec<Value> = calendar
        .iter()
        .filter(|row| {
            session_of(row, "session")
                .is_some_and(|s| s.as_str() >= warmup_start && s.as_str() <= calendar_end.as_str())
        })
        .cloned()
        .collect();
    if run_calendar.len() > MAX_SESSIONS {
        return Err(invalid(format!(
            "{} sessions exceed the limit of {MAX_SESSIONS}",
            run_calendar.len()
        )));
    }
    let select = |pointer: &str, key: &str| -> Result<Vec<Value>, Failure> {
        Ok(array(manifest, pointer)?
            .iter()
            .filter(|item| session_of(item, key).is_some_and(|s| in_run(&s)))
            .cloned()
            .collect())
    };
    let bars = select("/content/bars", "session")?;
    let events = select("/content/unplanned_events", "effective_session")?;
    let instrument_id = text(manifest, "/instrument/instrument_id")?;
    let value = json!({
        "schema_version": "evaluation-input/1",
        "strategy_hash": strategy_hash,
        "operator_set": operator_set,
        "seed": source.get("seed").cloned().unwrap_or(Value::Null),
        "dataset": manifest.get("dataset").cloned().unwrap_or(Value::Null),
        "instruments": [{
            "instrument_id": instrument_id,
            "bars": bars,
            "corporate_actions": actions,
            "unplanned_events": events,
        }],
        "calendar": {"sessions": run_calendar},
        "windows": source.get("windows").cloned().unwrap_or(Value::Null),
        "initial_capital": source.get("initial_capital").cloned().unwrap_or(Value::Null),
        "policy": source.get("policy").cloned().unwrap_or(Value::Null),
    });
    let typed = parse_value::<EvaluationInput>(value.clone())
        .map_err(|error| Failure::new(error.failure_code(), error.to_string()))?;
    Ok((value, typed))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bar(session: &str) -> Value {
        json!({"session": session, "open": "10", "high": "11", "low": "9", "close": "10",
               "volume": "100", "event_time": format!("{session}T21:00:00Z"),
               "available_at": format!("{session}T23:00:00Z")})
    }

    fn row(session: &str) -> Value {
        json!({"session": session, "open_at": format!("{session}T14:30:00Z"),
               "close_at": format!("{session}T21:00:00Z")})
    }

    fn manifest() -> Value {
        let days = [
            "2024-01-02",
            "2024-01-03",
            "2024-01-04",
            "2024-01-05",
            "2024-01-08",
        ];
        json!({
            "dataset": {"id": "d", "version": "1", "source": "PROVIDER", "licence": "synthetic"},
            "instrument": {"instrument_id": "alpaca:x"},
            "content": {
                "calendar": days.iter().map(|d| row(d)).collect::<Vec<_>>(),
                "bars": days.iter().map(|d| bar(d)).collect::<Vec<_>>(),
                "corporate_actions": [
                    {"kind": "SPLIT", "action_id": "a1", "effective_session": "2024-01-03",
                     "available_at": "2024-01-03T14:30:00Z", "ratio_new": 2, "ratio_old": 1},
                    {"kind": "CASH_DIVIDEND", "action_id": "a2", "effective_session": "2024-01-05",
                     "available_at": "2024-01-05T14:30:00Z", "amount_per_share": "0.5",
                     "payment_session": "2024-01-08", "payment_phase": "AFTER_CLOSE"}
                ],
                "unplanned_events": [],
                "action_evidence": []
            }
        })
    }

    fn source(warmup: &str, start: &str, end: &str) -> Value {
        json!({
            "source": "PROVIDER_MANIFEST",
            "windows": {"warmup_start": warmup, "scored_start": start, "scored_end": end,
                        "information_cutoff": format!("{end}T23:00:00Z")},
            "initial_capital": "1000",
            "policy": {"id": "daily-long-only-cash@1", "currency": "USD", "price_scale": 2,
                       "quantity_scale": 0, "money_scale": 2, "diagnostic_scale": 4, "lot_size": "1",
                       "cost_model": {"id": "fixed_plus_bps@1", "fixed_fee_per_fill": "0",
                                      "fee_bps": "5", "gap_exit_slippage_bps": "10"},
                       "corporate_actions": {"id": "split_cash_dividend_ex_date@1",
                                             "fractional": "INSUFFICIENT", "withholding_bps": "0"}},
            "seed": 7,
        })
    }

    const HASH: &str = "sha256:0000000000000000000000000000000000000000000000000000000000000001";

    #[test]
    fn a_dividend_payment_after_the_scored_end_extends_the_calendar_only() {
        // Scored end 2024-01-05: the dividend of that day pays on 2024-01-08, after the end.
        let (value, _) = build_input(
            HASH,
            "daily-long-only-seed@1",
            &manifest(),
            &source("2024-01-02", "2024-01-03", "2024-01-05"),
        )
        .unwrap();
        let sessions: Vec<&str> = value["calendar"]["sessions"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| s["session"].as_str().unwrap())
            .collect();
        assert_eq!(
            sessions,
            [
                "2024-01-02",
                "2024-01-03",
                "2024-01-04",
                "2024-01-05",
                "2024-01-08"
            ]
        );
        let bars = value["instruments"][0]["bars"].as_array().unwrap();
        assert_eq!(bars.len(), 4, "no bar after the scored end");
        assert_eq!(
            value["instruments"][0]["corporate_actions"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
        assert_eq!(value["seed"], 7);
    }

    #[test]
    fn an_action_outside_the_run_is_left_out_and_inside_it_is_kept() {
        let (value, _) = build_input(
            HASH,
            "daily-long-only-seed@1",
            &manifest(),
            &source("2024-01-04", "2024-01-04", "2024-01-05"),
        )
        .unwrap();
        let actions = value["instruments"][0]["corporate_actions"]
            .as_array()
            .unwrap();
        assert_eq!(actions.len(), 1);
        assert_eq!(actions[0]["action_id"], "a2");
    }

    #[test]
    fn a_window_that_is_not_a_session_is_not_prepared() {
        let failure = build_input(
            HASH,
            "daily-long-only-seed@1",
            &manifest(),
            &source("2024-01-01", "2024-01-03", "2024-01-05"),
        )
        .unwrap_err();
        assert_eq!(failure.code, FailureCode::InvalidInput);
        assert!(
            failure.detail.contains("warmup_start 2024-01-01"),
            "{}",
            failure.detail
        );
        let failure = build_input(
            HASH,
            "daily-long-only-seed@1",
            &manifest(),
            &source("2024-01-05", "2024-01-04", "2024-01-05"),
        )
        .unwrap_err();
        assert!(
            failure.detail.contains("warmup_start <= scored_start"),
            "{}",
            failure.detail
        );
    }

    #[test]
    fn a_payment_session_outside_the_calendar_is_not_prepared() {
        let mut m = manifest();
        m["content"]["corporate_actions"][1]["payment_session"] = json!("2024-01-09");
        let failure = build_input(
            HASH,
            "daily-long-only-seed@1",
            &m,
            &source("2024-01-02", "2024-01-03", "2024-01-05"),
        )
        .unwrap_err();
        assert_eq!(failure.code, FailureCode::InvalidInput);
        assert!(failure.detail.contains("2024-01-09"), "{}", failure.detail);
    }

    #[test]
    fn a_built_document_that_breaks_the_schema_gives_the_contract_code() {
        let mut s = source("2024-01-02", "2024-01-03", "2024-01-05");
        s["initial_capital"] = json!("01000");
        let failure = build_input(HASH, "daily-long-only-seed@1", &manifest(), &s).unwrap_err();
        assert_eq!(failure.code, FailureCode::InvalidDecimal);
    }
}

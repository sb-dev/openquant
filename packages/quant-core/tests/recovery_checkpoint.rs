//! Checkpoints and restore (OQ-06 section 8, S0: "Local replay"; OQ-02 section 2.3).
//!
//! A restored run must reproduce the uninterrupted result byte for byte, from every phase
//! boundary, with pending entries, scheduled stops, receivables and applied corporate actions
//! in the state. A split must be applied exactly once.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

mod execution_support;

use execution_support::*;
use openquant_contracts::{Checkpoint, EvaluationResult, canonical_json, parse, to_value};
use openquant_core::{Run, State};
use serde_json::{Value, json};

/// Eight sessions with a pending entry, a scheduled stop, a dividend receivable and a split.
///
///  S2: buy 10 @ 100 (cap 1000.00). S3: break-even fires (high 105 >= 100 + 4) and the ex-date
///  of 0.20 per share (receivable 2.00, payable at the S5 open). S4: 2-for-1 split: 20 shares,
///  scheduled stop 100 -> 50. S6: target 60 (= 120 / 2) touched: 20 * 60 = 1200.00; the S6 close
///  signals again with cap floor(5202.00 / 5) = 1040.40. S7 open 57: 18 shares (1026.00).
fn combined() -> Scenario {
    Scenario::new(vec![
        quiet_bar("100", "101", "99", "100"),   // S0
        signal_bar("100", "104", "100", "102"), // S1: ATR 4
        quiet_bar("100", "103", "99", "101"),   // S2: entry
        quiet_bar("102", "105", "101", "103"),  // S3: break-even fires, ex-date
        quiet_bar("51", "53", "50.5", "52"),    // S4: split
        quiet_bar("52", "54", "51", "53"),      // S5: dividend paid at the open
        signal_bar("53", "61", "52", "58"),     // S6: target 60 touched; signal ATR 9
        quiet_bar("57", "60", "56", "58"),      // S7: re-entry at 57
    ])
    .break_even(true)
    .split("SPLIT1", 4, 2, 1)
    .dividend("DIV1", 3, "0.20", 5, "OPEN")
}

/// A plain pending-entry and open-position run.
fn plain() -> Scenario {
    Scenario::new(vec![
        quiet_bar("50", "51", "49", "50"),
        signal_bar("50", "54", "50", "52"),
        quiet_bar("50", "53", "49", "51"),
        quiet_bar("51", "70", "50", "60"),
        quiet_bar("60", "61", "59", "60"),
    ])
    .fees("1.00", "10")
}

/// A dividend whose payment is two sessions after the ex-date, and a halt.
fn receivable_and_halt() -> Scenario {
    Scenario::new(vec![
        quiet_bar("50", "51", "49", "50"),
        signal_bar("50", "54", "50", "52"),
        quiet_bar("50", "51", "49.5", "50"),
        quiet_bar("49", "50", "48.5", "49"),
        quiet_bar("0", "0", "0", "0"),
        quiet_bar("49", "50", "48", "49"),
        quiet_bar("49", "50", "48", "49"),
    ])
    .dividend("DIV1", 3, "1.00", 6, "AFTER_CLOSE")
    .halt("HALT1", 4)
}

fn result_text(run: &Run, state: &State, failure: Option<&openquant_core::Failure>) -> String {
    canonical_json(&to_value(&run.result(state, failure).unwrap()).unwrap()).unwrap()
}

fn checkpoint_text(run: &Run, state: &State) -> String {
    round_trip(run, state).0
}

/// Run from `cut` after a full serialise, validate, parse and restore cycle.
fn resume(run: &Run, prefix: &State, cut: usize) -> (State, Option<openquant_core::Failure>) {
    let (_, checkpoint) = round_trip(run, prefix);
    let restored = run.restore(&checkpoint).unwrap();
    let events = run.events().unwrap();
    run.run_events(restored, &events[cut..])
}

/// The uninterrupted run: final state, failure and the number of events it completed.
fn baseline(run: &Run) -> (State, Option<openquant_core::Failure>, usize) {
    let events = run.events().unwrap();
    let (end, failure) = run.run_to_end(run.initial_state().unwrap());
    let completed = match &end.next {
        None => events.len(),
        Some(next) => events.iter().position(|e| &e.cursor == next).unwrap(),
    };
    (end, failure, completed)
}

#[test]
fn every_cut_point_restores_to_the_uninterrupted_result() {
    for (name, scenario) in [
        ("combined", combined()),
        ("plain", plain()),
        ("receivable_and_halt", receivable_and_halt()),
    ] {
        let run = scenario.run();
        let (end, failure, completed) = baseline(&run);
        let expected_text = result_text(&run, &end, failure.as_ref());
        let expected_checkpoint = checkpoint_text(&run, &end);
        for cut in 0..=completed {
            let prefix = state_after(&run, cut);
            let (state, again) = resume(&run, &prefix, cut);
            assert_eq!(
                again.as_ref().map(|f| (f.code, f.at.clone())),
                failure.as_ref().map(|f| (f.code, f.at.clone())),
                "{name}: failure after restore at cut {cut}"
            );
            assert_eq!(
                result_text(&run, &state, again.as_ref()),
                expected_text,
                "{name}: restore at cut {cut}"
            );
            assert_eq!(
                checkpoint_text(&run, &state),
                expected_checkpoint,
                "{name}: end checkpoint at cut {cut}"
            );
        }
    }
}

#[test]
fn the_scenarios_reach_the_states_the_tests_claim_to_cover() {
    let run = combined().run();
    // Pending entry: after the S6 close, before the S7 open.
    let pending = state_after(&run, event_index(&run, 7, "OPEN"));
    assert_eq!(pending.pending.len(), 1);
    assert_dec(&json!(pending.pending[0].cap.to_string()), "1040.40");
    // Scheduled stop: after the S3 close, before the S4 before-open phase.
    let scheduled = state_after(&run, event_index(&run, 4, "BEFORE_OPEN"));
    assert!(scheduled.positions[0].scheduled.is_some());
    // Receivable outstanding between the ex-date and the payment.
    let receivable = state_after(&run, event_index(&run, 5, "BEFORE_OPEN"));
    assert_eq!(receivable.receivables.len(), 1);
    // Applied split after the ex-date before-open phase.
    let applied = state_after(&run, event_index(&run, 4, "OPEN"));
    assert!(applied.applied.contains("SPLIT1"));
    assert!(!scheduled.applied.contains("SPLIT1"));

    // Hand check of the whole run: S6 target sale 20 @ 60.00, S7 buy 18 @ 57.00.
    let out = combined().evaluate();
    assert_eq!(out.status(), "COMPLETED");
    let rows: Vec<String> = out.fills().iter().map(fill_row).collect();
    assert_eq!(
        rows,
        vec![
            format!(
                "{} OPEN BUY 10@100.00 fee=0.00 delta=-1000.00 ENTRY",
                date(2)
            ),
            format!(
                "{} DURING_SESSION SELL 20@60.00 fee=0.00 delta=1200.00 TARGET",
                date(6)
            ),
            format!(
                "{} OPEN BUY 18@57.00 fee=0.00 delta=-1026.00 ENTRY",
                date(7)
            ),
        ]
    );
    // 5202.00 - 1026.00 = 4176.00.
    assert_dec(out.at("/final/cash_available"), "4176.00");
}

#[test]
fn a_checkpoint_round_trips_every_field() {
    let run = combined().run();
    let events = run.events().unwrap();
    for cut in 0..=events.len() {
        let prefix = state_after(&run, cut);
        let (text, checkpoint) = round_trip(&run, &prefix);
        let restored = run.restore(&checkpoint).unwrap();
        assert_eq!(restored.next, prefix.next, "cut {cut}");
        assert_eq!(restored.cash_available, prefix.cash_available, "cut {cut}");
        assert_eq!(restored.cash_reserved, prefix.cash_reserved, "cut {cut}");
        assert_eq!(restored.receivables, prefix.receivables, "cut {cut}");
        assert_eq!(restored.positions, prefix.positions, "cut {cut}");
        assert_eq!(restored.pending, prefix.pending, "cut {cut}");
        assert_eq!(restored.applied, prefix.applied, "cut {cut}");
        assert_eq!(restored.journal, prefix.journal, "cut {cut}");
        // Serialising the restored state yields the same document.
        assert_eq!(checkpoint_text(&run, &restored), text, "cut {cut}");
    }
}

#[test]
fn a_split_is_applied_exactly_once_whatever_the_restore_point() {
    let run = combined().run();
    let before = event_index(&run, 4, "BEFORE_OPEN");
    // Restore before the ex-date before-open phase, and after it (the split is then already in
    // the state and in the applied identities): 20 shares either way.
    for cut in [before, before + 1, before + 2, before + 3, before + 4] {
        let prefix = state_after(&run, cut);
        let (end, failure) = resume(&run, &prefix, cut);
        assert!(failure.is_none(), "cut {cut}");
        let result = to_value(&run.result(&end, None).unwrap()).unwrap();
        let s4 = result["journal"]["daily"]
            .as_array()
            .unwrap()
            .iter()
            .find(|d| d["session"] == date(4).as_str())
            .unwrap();
        assert_dec(&s4["positions"][0]["quantity"], "20");
        assert_dec(&s4["positions"][0]["entry_price"], "50");
        assert_dec(&s4["positions"][0]["target"], "60");
        assert_eq!(
            result["journal"]["corporate_actions"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|a| a["action_id"] == "SPLIT1")
                .count(),
            1,
            "cut {cut}"
        );
    }
}

#[test]
fn a_dividend_is_recorded_once_whatever_the_restore_point() {
    let run = receivable_and_halt().run();
    let (end, failure, _) = baseline(&run);
    let expected = result_text(&run, &end, failure.as_ref());
    let before = event_index(&run, 3, "BEFORE_OPEN");
    for cut in before..=before + 2 {
        let prefix = state_after(&run, cut);
        let (state, again) = resume(&run, &prefix, cut);
        // The halt in S4 holds a position: the run ends there either way.
        assert_eq!(
            result_text(&run, &state, again.as_ref()),
            expected,
            "cut {cut}"
        );
        let result = to_value(&run.result(&state, again.as_ref()).unwrap()).unwrap();
        let receivables = result["journal"]["cash_ledger"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|l| l["kind"] == "DIVIDEND_RECEIVABLE")
            .count();
        assert_eq!(receivables, 1, "cut {cut}");
        assert_eq!(
            result["journal"]["corporate_actions"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
    }
}

fn tampered(run: &Run, cut: usize, edit: impl FnOnce(&mut Value)) -> Checkpoint {
    let prefix = state_after(run, cut);
    let mut value = to_value(&run.checkpoint(&prefix).unwrap()).unwrap();
    edit(&mut value);
    openquant_contracts::parse_value(value).expect("the tampered checkpoint is schema-valid")
}

/// The failure code of a refused restore, or `RESTORED` when the checkpoint was accepted.
fn rejection(run: &Run, checkpoint: &Checkpoint) -> String {
    run.restore(checkpoint)
        .err()
        .map_or_else(|| "RESTORED".to_owned(), |failure| failure.code.to_string())
}

#[test]
fn a_checkpoint_that_forgets_an_applied_split_is_refused() {
    // Cursor after the S4 before-open phase, but the applied identities are empty: restoring it
    // would be accepted by the schema and could apply nothing, or apply twice if replayed.
    let run = combined().run();
    let cut = event_index(&run, 4, "OPEN");
    let checkpoint = tampered(&run, cut, |v| {
        v["state"]["applied_action_ids"] = json!([]);
    });
    assert_eq!(rejection(&run, &checkpoint), "CHECKPOINT_MISMATCH");
}

#[test]
fn a_checkpoint_that_claims_an_unapplied_split_is_refused() {
    // Cursor before the ex-date before-open phase, but SPLIT1 is already listed as applied.
    let run = combined().run();
    let cut = event_index(&run, 4, "BEFORE_OPEN");
    let checkpoint = tampered(&run, cut, |v| {
        v["state"]["applied_action_ids"] = json!(["DIV1", "SPLIT1"]);
    });
    assert_eq!(rejection(&run, &checkpoint), "CHECKPOINT_MISMATCH");
}

#[test]
fn damaged_balances_and_records_are_refused() {
    let run = combined().run();
    let pending_cut = event_index(&run, 7, "OPEN");
    type Edit = Box<dyn Fn(&mut Value)>;
    let cases: Vec<(&str, usize, Edit)> = vec![
        (
            "reserved cash that is not the sum of the caps",
            pending_cut,
            Box::new(|v| v["state"]["cash_reserved"] = json!("1040.39")),
        ),
        (
            "a journal sequence that does not match its records",
            pending_cut,
            Box::new(|v| v["state"]["journal"]["next_seq"] = json!(1)),
        ),
        (
            "daily records that do not match the cursor",
            pending_cut,
            Box::new(|v| {
                v["state"]["journal"]["daily"].as_array_mut().unwrap().pop();
            }),
        ),
        (
            "negative cash",
            pending_cut,
            Box::new(|v| v["state"]["cash_available"] = json!("-1.00")),
        ),
        (
            "a pending entry without its record",
            pending_cut,
            Box::new(|v| v["state"]["pending_entries"][0]["intent_id"] = json!("I-UNKNOWN")),
        ),
        (
            "a position without an open trade",
            event_index(&run, 4, "OPEN"),
            Box::new(|v| v["state"]["positions"][0]["trade_id"] = json!("T-UNKNOWN")),
        ),
        (
            "a snapshot name the strategy does not declare",
            event_index(&run, 4, "OPEN"),
            Box::new(|v| v["state"]["positions"][0]["snapshots"][0]["name"] = json!("other")),
        ),
        (
            "a fired adjustment the strategy does not declare",
            event_index(&run, 4, "OPEN"),
            Box::new(|v| {
                v["state"]["positions"][0]["fired_adjustments"] = json!(["not_declared"]);
            }),
        ),
        (
            "a receivable that matches no dividend",
            event_index(&run, 5, "BEFORE_OPEN"),
            Box::new(|v| v["state"]["receivables"][0]["action_id"] = json!("OTHER")),
        ),
        (
            "a receivable with another payment time",
            event_index(&run, 5, "BEFORE_OPEN"),
            Box::new(|v| v["state"]["receivables"][0]["payment_phase"] = json!("AFTER_CLOSE")),
        ),
    ];
    for (what, cut, edit) in cases {
        let prefix = state_after(&run, cut);
        let mut value = to_value(&run.checkpoint(&prefix).unwrap()).unwrap();
        edit(&mut value);
        match openquant_contracts::parse_value::<Checkpoint>(value) {
            // A schema-level rejection is also a rejection.
            Err(_) => {}
            Ok(checkpoint) => assert_eq!(
                rejection(&run, &checkpoint),
                "CHECKPOINT_MISMATCH",
                "{what}"
            ),
        }
    }
}

#[test]
fn a_receivable_that_should_already_have_been_paid_is_refused() {
    // The dividend pays at the S5 open. A checkpoint at the S6 cursor that still lists it was
    // not produced by this engine.
    let run = combined().run();
    let waiting = state_after(&run, event_index(&run, 5, "BEFORE_OPEN"));
    assert_eq!(waiting.receivables.len(), 1);
    let mut late = state_after(&run, event_index(&run, 6, "BEFORE_OPEN"));
    late.receivables = waiting.receivables.clone();
    // Keep the journal consistent with the added receivable so only the timing is wrong.
    let checkpoint = run.checkpoint(&late).unwrap();
    assert_eq!(rejection(&run, &checkpoint), "CHECKPOINT_MISMATCH");
    // At its own payment cursor the same receivable is valid.
    let mut due = state_after(&run, event_index(&run, 5, "OPEN"));
    assert_eq!(due.receivables.len(), 1);
    due.receivables = waiting.receivables;
    assert!(run.restore(&run.checkpoint(&due).unwrap()).is_ok());
}

#[test]
fn pending_entries_are_only_valid_before_an_open() {
    let run = combined().run();
    let cut = event_index(&run, 7, "OPEN");
    let mut prefix = state_after(&run, cut);
    prefix.next = Some(openquant_core::model::Cursor {
        session: date(7),
        phase: openquant_core::model::Phase::DuringSession,
    });
    let checkpoint = run.checkpoint(&prefix).unwrap();
    assert_eq!(rejection(&run, &checkpoint), "CHECKPOINT_MISMATCH");
}

#[test]
fn identities_must_match_the_run() {
    let run = combined().run();
    let other = plain().run();
    let prefix = state_after(&run, 5);
    let foreign = run.checkpoint(&prefix).unwrap();
    // Another run has another input hash.
    assert_eq!(rejection(&other, &foreign), "CHECKPOINT_MISMATCH");

    let zero: openquant_contracts::generated::Digest =
        format!("sha256:{}", "0".repeat(64)).parse().unwrap();
    let mut wrong_strategy = run.checkpoint(&prefix).unwrap();
    wrong_strategy.strategy_hash = zero.clone();
    assert_eq!(rejection(&run, &wrong_strategy), "CHECKPOINT_MISMATCH");
    let mut wrong_input = run.checkpoint(&prefix).unwrap();
    wrong_input.input_hash = zero.clone();
    assert_eq!(rejection(&run, &wrong_input), "CHECKPOINT_MISMATCH");
    let mut wrong_engine = run.checkpoint(&prefix).unwrap();
    wrong_engine.engine_digest = zero;
    assert_eq!(rejection(&run, &wrong_engine), "CHECKPOINT_MISMATCH");
}

#[test]
fn a_cursor_outside_the_run_is_refused() {
    let run = combined().run();
    let mut checkpoint = run.checkpoint(&state_after(&run, 5)).unwrap();
    checkpoint.next_event = Some(openquant_contracts::generated::Cursor {
        session: "2026-03-30".parse().unwrap(),
        phase: openquant_contracts::generated::Phase::Open,
    });
    assert_eq!(rejection(&run, &checkpoint), "CHECKPOINT_MISMATCH");
}

#[test]
fn an_event_that_is_not_next_is_refused_without_changing_the_state() {
    let run = combined().run();
    let events = run.events().unwrap();
    let initial = run.initial_state().unwrap();
    let failure = run.step(&initial, &events[1]).unwrap_err();
    assert_eq!(failure.code.to_string(), "EVENT_OUT_OF_ORDER");
    // The same step with the right event works, and stepping it again is out of order.
    let output = run.step(&initial, &events[0]).unwrap();
    let again = run.step(&output.state, &events[0]).unwrap_err();
    assert_eq!(again.code.to_string(), "EVENT_OUT_OF_ORDER");
}

#[test]
fn repeated_evaluation_is_byte_identical() {
    for scenario in [combined(), plain(), receivable_and_halt()] {
        let texts: Vec<String> = (0..3)
            .map(|_| scenario.evaluate().text_of_result())
            .collect();
        assert_eq!(texts[0], texts[1]);
        assert_eq!(texts[1], texts[2]);
    }
}

#[test]
fn stepping_event_by_event_matches_running_to_the_end() {
    let run = combined().run();
    let events = run.events().unwrap();
    let mut state = run.initial_state().unwrap();
    for event in &events {
        state = run.step(&state, event).unwrap().state;
    }
    let (end, failure) = run.run_to_end(run.initial_state().unwrap());
    assert!(failure.is_none());
    assert_eq!(
        result_text(&run, &state, None),
        result_text(&run, &end, None)
    );
    assert!(state.next.is_none());
}

#[test]
fn a_failed_run_restores_to_the_same_failure_with_the_same_partial_journal() {
    // INSUFFICIENT at S4 (an unsupported action). Resume from every cut up to the failure.
    let scenario = Scenario::new(vec![
        quiet_bar("100", "101", "99", "100"),
        signal_bar("100", "104", "100", "102"),
        quiet_bar("100", "103", "99", "101"),
        quiet_bar("102", "105", "101", "103"),
        quiet_bar("102", "105", "101", "103"),
    ])
    .unsupported("ACT1", "SPIN_OFF", 4);
    let run = scenario.run();
    let events = run.events().unwrap();
    let (end, failure) = run.run_to_end(run.initial_state().unwrap());
    let failure = failure.expect("the run must fail");
    let baseline = result_text(&run, &end, Some(&failure));
    let failing = event_index(&run, 4, "BEFORE_OPEN");
    for cut in 0..=failing {
        let prefix = state_after(&run, cut);
        let (_, checkpoint) = round_trip(&run, &prefix);
        let restored = run.restore(&checkpoint).unwrap();
        let (state, again) = run.run_events(restored, &events[cut..]);
        let again = again.expect("the restored run fails the same way");
        assert_eq!(again.code, failure.code, "cut {cut}");
        assert_eq!(again.at, failure.at, "cut {cut}");
        assert_eq!(
            result_text(&run, &state, Some(&again)),
            baseline,
            "cut {cut}"
        );
    }
}

#[test]
fn results_validate_against_the_shared_result_schema_for_every_outcome() {
    let late = format!("{}T14:30:01Z", date(3));
    let scenarios = vec![
        combined(),
        plain(),
        receivable_and_halt(),
        Scenario::new(vec![
            quiet_bar("50", "51", "49", "50"),
            signal_bar("50", "80", "50", "60"),
            quiet_bar("50", "53", "49", "51"),
        ]),
        Scenario::new(vec![
            quiet_bar("50", "51", "49", "50"),
            signal_bar("50", "54", "50", "52"),
            quiet_bar("50", "51", "49.5", "50"),
            quiet_bar("51", "52", "50", "51"),
        ])
        .with_available_at(2, &late),
    ];
    for scenario in scenarios {
        let out = scenario.evaluate();
        let text = out.text_of_result();
        let parsed: EvaluationResult = parse(&text).expect("the result is schema-valid");
        assert_eq!(canonical_json(&to_value(&parsed).unwrap()).unwrap(), text);
    }
}

// Balances are cross-checked against the journal (OQ-06 section 8, S0: damaged checkpoints are
// refused). Each test edits one stored number so that the checkpoint still passes the schema and
// every older check, and expects a refusal. The edited numbers are written out by hand.

/// The scenarios whose every cut point is restored by the tests above.
fn restore_scenarios() -> Vec<(&'static str, Scenario)> {
    vec![
        ("combined", combined()),
        ("plain", plain()),
        ("receivable_and_halt", receivable_and_halt()),
    ]
}

#[test]
fn edited_available_cash_is_refused_at_every_cut_point() {
    // The forgery of the review finding: a large, non-negative balance nothing else contradicts.
    for (name, scenario) in restore_scenarios() {
        let run = scenario.run();
        let (_, _, completed) = baseline(&run);
        for cut in 0..=completed {
            let checkpoint = tampered(&run, cut, |v| {
                v["state"]["cash_available"] = json!("999999.00");
            });
            assert_eq!(
                rejection(&run, &checkpoint),
                "CHECKPOINT_MISMATCH",
                "{name}: cash_available edited at cut {cut}"
            );
        }
    }
}

#[test]
fn balances_before_the_first_event_are_the_initial_capital() {
    // The journal is empty, so the opening balances are the only ones that can be right.
    let run = combined().run();
    for (field, edited) in [("cash_available", "4999.00"), ("cash_reserved", "1.00")] {
        let checkpoint = tampered(&run, 0, |v| v["state"][field] = json!(edited));
        assert_eq!(
            rejection(&run, &checkpoint),
            "CHECKPOINT_MISMATCH",
            "{field}"
        );
    }
    // The unedited opening checkpoint restores.
    assert!(run.restore(&tampered(&run, 0, |_| {})).is_ok());
}

#[test]
fn edited_receivables_are_refused() {
    // Between the S3 ex-date and the S5 payment DIV1 is a receivable of 2.00 (10 shares at 0.20
    // before the split), and the last ledger line says so.
    let run = combined().run();
    let cut = event_index(&run, 5, "BEFORE_OPEN");
    assert_eq!(state_after(&run, cut).receivables.len(), 1);
    let larger = tampered(&run, cut, |v| {
        v["state"]["receivables"][0]["amount"] = json!("3.00");
    });
    assert_eq!(rejection(&run, &larger), "CHECKPOINT_MISMATCH", "amount");
    let removed = tampered(&run, cut, |v| v["state"]["receivables"] = json!([]));
    assert_eq!(rejection(&run, &removed), "CHECKPOINT_MISMATCH", "removed");
}

#[test]
fn an_edited_ledger_tail_is_refused() {
    // The state is untouched; the last cash ledger line no longer states its balances.
    for (name, scenario) in restore_scenarios() {
        let run = scenario.run();
        let (_, _, completed) = baseline(&run);
        for cut in 0..=completed {
            if state_after(&run, cut).journal.cash_ledger.is_empty() {
                continue;
            }
            for field in ["available_after", "reserved_after", "receivables_after"] {
                let checkpoint = tampered(&run, cut, |v| {
                    let ledger = v["state"]["journal"]["cash_ledger"].as_array_mut().unwrap();
                    ledger.last_mut().unwrap()[field] = json!("12345.67");
                });
                assert_eq!(
                    rejection(&run, &checkpoint),
                    "CHECKPOINT_MISMATCH",
                    "{name}: ledger tail {field} at cut {cut}"
                );
            }
        }
    }
}

#[test]
fn edited_daily_records_are_refused() {
    let run = combined().run();
    let mid_session = event_index(&run, 7, "OPEN");
    // The first daily record belongs to a session long finished, so only the journal itself
    // contradicts it: the review finding's `daily[0].equity = "1.00"`, and the other numbers
    // and the date of the same record.
    for (field, edited) in [
        ("equity", "1.00"),
        ("cash_available", "1.00"),
        ("cash_reserved", "1.00"),
        ("receivables", "1.00"),
        ("session", date(1).as_str()),
    ] {
        let checkpoint = tampered(&run, mid_session, |v| {
            v["state"]["journal"]["daily"][0][field] = json!(edited);
        });
        assert_eq!(
            rejection(&run, &checkpoint),
            "CHECKPOINT_MISMATCH",
            "daily[0].{field}"
        );
    }
}

#[test]
fn positions_must_agree_with_the_last_daily_record_and_the_open_trade() {
    let run = combined().run();
    // After the S3 close and before the S4 before-open phase the state is exactly the last daily
    // record, so a moved mark or quantity contradicts its positions value.
    let boundary = event_index(&run, 4, "BEFORE_OPEN");
    for (field, edited) in [("mark", "1"), ("quantity", "11")] {
        let checkpoint = tampered(&run, boundary, |v| {
            v["state"]["positions"][0][field] = json!(edited);
        });
        assert_eq!(
            rejection(&run, &checkpoint),
            "CHECKPOINT_MISMATCH",
            "{field}"
        );
    }
    // Inside a session a position is checked against its open trade record instead. After the
    // S4 split the trade record is on the new basis: 20 shares at 50.
    let inside = event_index(&run, 4, "OPEN");
    for (field, edited) in [("quantity", "21"), ("entry_price", "49")] {
        let checkpoint = tampered(&run, inside, |v| {
            v["state"]["positions"][0][field] = json!(edited);
        });
        assert_eq!(
            rejection(&run, &checkpoint),
            "CHECKPOINT_MISMATCH",
            "{field}"
        );
    }
}

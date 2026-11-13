//! The exact state of a run: levels, snapshots and scheduled stops are `Ratio`, a split converts
//! them without rounding, a checkpoint keeps them exactly, and a level that does not fit 128
//! bits fails the run with a typed overflow instead of being rounded (OQ-02 sections 2.2 and
//! 2.5, OQ-06 section 8).

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

mod execution_support;

use execution_support::*;
use openquant_contracts::{
    Checkpoint, EvaluationInput, StrategyArtefact, canonical_json, parse, parse_json, to_value,
};
use openquant_core::{
    Run, State,
    numeric::{Decimal, Ratio},
    state::{Pending, Position, Scheduled, empty_journal},
};
use serde_json::{Value, json};

const FIXTURES: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures");

fn ratio(n: i128, d: i128) -> Ratio {
    Ratio::new(n, d).unwrap()
}

/// The 3-for-1 and reverse 1-for-3 scenario, with a PRICE and a SHARES snapshot besides the ATR.
///
/// Entry at 5.00 (session 5) for 200 shares; ATR over 3 sessions is 0.2; stop 5.00 - 3.35 * 0.2
/// = 4.33; target 5.00 + 5 * 0.2 = 6.00. The PRICE snapshot is the close at the signal session
/// (5.05), the SHARES snapshot its volume (2000).
fn split_scenario() -> Scenario {
    let quiet = || quiet_bar("5.00", "5.10", "4.90", "5.00");
    Scenario::new(vec![
        quiet(),
        quiet(),
        quiet(),
        quiet(),
        signal_bar("5.00", "5.10", "4.90", "5.05"),
        quiet_bar("5.00", "5.10", "4.90", "5.10"),
        quiet_bar("1.70", "1.72", "1.65", "1.70"),
        quiet_bar("5.10", "5.20", "5.00", "5.10"),
        quiet_bar("5.00", "5.20", "4.90", "5.00"),
    ])
    .atr_window(3)
    .multiples("3.35", "5")
    .snapshot("signal_close", "PRICE", "close")
    .snapshot("signal_volume", "SHARES", "volume")
    .split("S3F", 6, 3, 1)
    .split("R3F", 7, 1, 3)
}

#[test]
fn a_forward_and_a_reverse_split_leave_every_level_and_snapshot_exactly_where_they_were() {
    let run = split_scenario().run();
    let before = state_after(&run, event_index(&run, 6, "BEFORE_OPEN"));
    let during = state_after(&run, event_index(&run, 6, "OPEN"));
    let after = state_after(&run, event_index(&run, 7, "OPEN"));
    let (a, b, c) = (
        &before.positions[0],
        &during.positions[0],
        &after.positions[0],
    );
    // Before: the levels and snapshots of the entry.
    assert_eq!(a.entry_price, ratio(5, 1));
    assert_eq!(a.stop, ratio(433, 100));
    assert_eq!(a.target, ratio(6, 1));
    assert_eq!(a.snapshots[0], ("entry_atr".to_owned(), ratio(1, 5)));
    assert_eq!(a.snapshots[1], ("signal_close".to_owned(), ratio(505, 100)));
    assert_eq!(a.snapshots[2], ("signal_volume".to_owned(), ratio(2000, 1)));
    assert_eq!(a.quantity, Decimal::from(200));
    // After the 3-for-1: prices and PRICE snapshots a third, SHARES snapshots tripled, shares x 3,
    // all exact: 433/300 is not a decimal and is not rounded.
    assert_eq!(b.entry_price, ratio(5, 3));
    assert_eq!(b.stop, ratio(433, 300));
    assert_eq!(b.target, ratio(2, 1));
    assert_eq!(b.snapshots[0].1, ratio(1, 15));
    assert_eq!(b.snapshots[1].1, ratio(101, 60));
    assert_eq!(b.snapshots[2].1, ratio(6000, 1));
    assert_eq!(b.quantity, Decimal::from(600));
    // After the reverse split every field is what it was before the forward one.
    assert_eq!(c.entry_price, a.entry_price);
    assert_eq!(c.stop, a.stop);
    assert_eq!(c.target, a.target);
    assert_eq!(c.snapshots, a.snapshots);
    assert_eq!(c.quantity, a.quantity);
}

#[test]
fn a_restored_state_holds_the_same_exact_values_as_the_state_it_was_saved_from() {
    let run = split_scenario().run();
    // After the entry and after each split, with fractions in the state.
    for (session, phase) in [(5, "DURING_SESSION"), (6, "OPEN"), (7, "OPEN"), (8, "OPEN")] {
        let state = state_after(&run, event_index(&run, session, phase));
        let (_, checkpoint) = round_trip(&run, &state);
        let restored = run.restore(&checkpoint).unwrap();
        assert_eq!(restored.positions.len(), 1, "{session} {phase}");
        for (saved, got) in state.positions.iter().zip(&restored.positions) {
            assert_eq!(saved.entry_price, got.entry_price, "{session} {phase}");
            assert_eq!(saved.stop, got.stop, "{session} {phase}");
            assert_eq!(saved.target, got.target, "{session} {phase}");
            assert_eq!(saved.snapshots, got.snapshots, "{session} {phase}");
            assert_eq!(saved.scheduled, got.scheduled, "{session} {phase}");
            assert_eq!(saved.mark, got.mark, "{session} {phase}");
        }
    }
    // A pending entry keeps its snapshots exactly across a checkpoint.
    let state = state_after(&run, event_index(&run, 5, "OPEN"));
    assert_eq!(state.pending.len(), 1);
    let (_, checkpoint) = round_trip(&run, &state);
    let restored = run.restore(&checkpoint).unwrap();
    assert_eq!(state.pending[0].snapshots, restored.pending[0].snapshots);
    assert_eq!(restored.pending[0].snapshots[0].1, ratio(1, 5));
}

#[test]
fn a_scheduled_stop_that_is_not_a_decimal_is_kept_exactly_across_a_checkpoint() {
    // Break-even at 5.00 + 3 * ATR with ATR 0.68 / 3 = 17 / 75 and a new stop of
    // entry + ATR = 5 + 17 / 75 = 392 / 75, which does not terminate. The trigger is a high of
    // 5.68; the stop is scheduled for the next session and the checkpoint between the close and
    // the next before-open phase carries the fraction.
    let quiet = || quiet_bar("5.00", "5.10", "4.90", "5.00");
    let scenario = Scenario::new(vec![
        quiet(),
        quiet(),
        quiet(),
        quiet(),
        signal_bar("5.00", "5.18", "4.90", "5.05"),
        quiet_bar("5.00", "5.68", "4.90", "5.20"),
        quiet_bar("5.30", "5.40", "5.00", "5.10"),
    ])
    .atr_window(3)
    .multiples("2", "20")
    .break_even_trigger("3")
    .break_even_level("1");
    let run = scenario.run();
    let state = state_after(&run, event_index(&run, 6, "BEFORE_OPEN"));
    let scheduled = state.positions[0].scheduled.clone().expect("scheduled");
    assert_eq!(scheduled.level, ratio(392, 75));
    assert_eq!(scheduled.effective_session, date(6));
    let (text, checkpoint) = round_trip(&run, &state);
    let value: serde_json::Value = serde_json::from_str(&text).unwrap();
    assert_eq!(
        value["state"]["positions"][0]["scheduled_stop"]["level"],
        "392/75"
    );
    let restored = run.restore(&checkpoint).unwrap();
    assert_eq!(
        restored.positions[0].scheduled,
        state.positions[0].scheduled
    );
    // The activated stop is the exact level: a low of 5.23 does not touch 392/75 = 5.2266...,
    // and a low of 5.22 does.
    let touch = |low: &str| {
        let mut scenario = scenario.clone();
        scenario.bars[6] = Some(quiet_bar("5.30", "5.40", low, "5.30"));
        scenario.evaluate()
    };
    let above = touch("5.23");
    assert_eq!(above.fills().len(), 1, "no exit above the stop");
    let below = touch("5.22");
    // Floor of 5.2266... on the 2-decimal grid is 5.22.
    assert_eq!(
        fill_row(&below.fills()[1]),
        format!(
            "{} DURING_SESSION SELL 200@5.22 fee=0.00 delta=1044.00 STOP",
            date(6)
        )
    );
}

/// A run whose stop is `entry - m * ATR` with a price near 5e8 at eight decimals, an ATR of
/// 799999999.99999999 and a multiplier near 1e12 at twelve decimals: the exact product needs more
/// than 128 bits.
fn wide_levels(multiplier: &str) -> Scenario {
    let flat = || {
        quiet_bar(
            "500000000.00000000",
            "500000000.00000000",
            "500000000.00000000",
            "500000000.00000000",
        )
    };
    let mut scenario = Scenario::new(vec![
        flat(),
        signal_bar(
            "500000000.00000000",
            "900000000.00000000",
            "100000000.00000001",
            "500000000.00000000",
        ),
        flat(),
        flat(),
    ])
    .atr_window(1)
    .multiples(multiplier, "1")
    .capital("5000000000.00");
    scenario.policy.price_scale = 8;
    scenario.policy.money_scale = 12;
    scenario
}

#[test]
fn a_level_that_does_not_fit_128_bits_fails_the_run_with_a_typed_overflow() {
    // Stop = 5e8 - 999999999999.999999999999 * 799999999.99999999: the product has a numerator
    // beyond 10^40, which exceeds a 128-bit integer. The run does not round it, does not wrap it
    // and does not complete: it fails at the entry open with ARITHMETIC_OVERFLOW.
    let out = wide_levels("999999999999.999999999999").evaluate();
    assert_eq!(out.status(), "FAILED");
    assert_eq!(out.code(), "ARITHMETIC_OVERFLOW");
    assert_eq!(out.text("/outcome/at/session"), date(2));
    assert_eq!(out.text("/outcome/at/phase"), "OPEN");
    assert!(out.fills().is_empty());
    assert_eq!(out.entries()[0]["status"], "RESERVED");
    // The same run with a modest multiplier completes: stop 5e8 - 0.5 * 799999999.99999999 =
    // 100000000.000000005, target 5e8 + 799999999.99999999 > the bars, so it stays open.
    let out = wide_levels("0.5").evaluate();
    assert_eq!(out.status(), "COMPLETED");
    assert_eq!(
        out.at("/final/open_positions/0/stop"),
        "100000000.000000005"
    );
}

#[test]
fn the_fraction_checkpoints_restore_and_write_back_the_text_they_were_read_from() {
    let read = |path: &str| {
        std::fs::read_to_string(format!("{FIXTURES}/{path}"))
            .unwrap_or_else(|e| panic!("{path}: {e}"))
    };
    let strategy: StrategyArtefact = parse(&read("s0/cases/F0-smoke/strategy.json")).unwrap();
    let input: EvaluationInput = parse(&read("protocol/valid/input.exact-fractions.json")).unwrap();
    let run = Run::prepare(&strategy, &input).unwrap();
    for (path, stop, held) in [
        (
            "protocol/valid/checkpoint.exact-pending-fraction.json",
            None,
            false,
        ),
        (
            "protocol/valid/checkpoint.exact-open-position-fraction.json",
            Some(ratio(14_399, 150)),
            true,
        ),
    ] {
        let text = read(path);
        let checkpoint: Checkpoint = parse(&text).unwrap();
        let restored = run.restore(&checkpoint).unwrap();
        // The ATR 9.01 / 3 and the stop 102 - 2 * 9.01 / 3 are exact fractions in the state.
        if held {
            assert_eq!(restored.positions[0].snapshots[0].1, ratio(901, 300));
            assert_eq!(Some(restored.positions[0].stop), stop);
            assert_eq!(restored.positions[0].target, ratio(11_101, 100));
        } else {
            assert_eq!(restored.pending[0].snapshots[0].1, ratio(901, 300));
        }
        // Writing it back gives the fixture's own canonical text.
        let written =
            canonical_json(&to_value(&run.checkpoint(&restored).unwrap()).unwrap()).unwrap();
        assert_eq!(
            written,
            canonical_json(&parse_json(&text).unwrap()).unwrap(),
            "{path}"
        );
        // And the rest of the run from the restored state is the uninterrupted run.
        let (end, failure) = run.run_to_end(restored);
        let (whole, whole_failure) = run.run_to_end(run.initial_state().unwrap());
        assert_eq!(failure.is_some(), whole_failure.is_some());
        assert_eq!(
            canonical_json(&to_value(&run.result(&end, failure.as_ref()).unwrap()).unwrap())
                .unwrap(),
            canonical_json(
                &to_value(&run.result(&whole, whole_failure.as_ref()).unwrap()).unwrap()
            )
            .unwrap(),
            "{path}"
        );
    }
}

// ---------------------------------------------------------------------------------------
// A level with no decimal view fails the run at the event that creates it
// ---------------------------------------------------------------------------------------
//
// A `Ratio` holds two 128-bit integers. A result or a checkpoint carries a level as a 96-bit
// decimal (or as a fraction), so a level with an integer part of 2^96 (about 7.9e28) or more is
// exact in memory and cannot be shown. The run must refuse it where it is created: if the last
// completed state held it, the run could not report its own failure.

const K: &str = "999999999999";

fn op(name: &str, args: Vec<Value>) -> Value {
    json!({"op": format!("operator:{name}@1"), "args": args, "params": {}})
}

fn constant(value: &str) -> Value {
    json!({"op": "operator:const@1", "args": [], "params": {"value": value, "unit": "RATIO"}})
}

/// `base * K * K ...` with `factors` constants K (K is just under 1e12).
fn times_k(base: Value, factors: usize) -> Value {
    (0..factors).fold(base, |acc, _| op("mul", vec![acc, constant(K)]))
}

fn entry_price() -> Value {
    op("entry_price", vec![])
}

fn close() -> Value {
    json!({"op": "operator:bar_field@1", "args": [], "params": {"field": "CLOSE"}})
}

/// Entry at 5.00 on session 5 after a signal on session 4 (close 5.05, ATR over 3 sessions).
fn one_entry() -> Scenario {
    let quiet = || quiet_bar("5.00", "5.10", "4.90", "5.00");
    Scenario::new(vec![
        quiet(),
        quiet(),
        quiet(),
        quiet(),
        signal_bar("5.00", "5.10", "4.90", "5.05"),
        quiet(),
        quiet(),
        quiet(),
    ])
    .atr_window(3)
}

fn canonical_result(run: &Run, state: &State, failure: Option<&openquant_core::Failure>) -> String {
    canonical_json(&to_value(&run.result(state, failure).unwrap()).unwrap()).unwrap()
}

#[test]
fn a_target_with_no_decimal_view_fails_the_run_and_the_result_reports_it() {
    // target = 5.00 * K^3 = 4999999999985000000000014999999999995, about 5e36: below 2^127, so
    // the exact value fits a Ratio, and above 2^96, so no decimal holds it.
    let scenario = one_entry().target_expression(times_k(entry_price(), 3));
    let out = scenario.evaluate();
    assert_eq!(out.status(), "FAILED");
    assert_eq!(out.code(), "ARITHMETIC_OVERFLOW");
    assert_eq!(out.text("/outcome/at/session"), date(5));
    assert_eq!(out.text("/outcome/at/phase"), "OPEN");
    // The event that creates the level is discarded: no fill, and the intent keeps its
    // reservation, as for any other failure at an open.
    assert!(out.fills().is_empty());
    assert_eq!(out.entries()[0]["status"], "RESERVED");
    assert_eq!(out.len("/final/open_positions"), 0);
    // The public entry point returns the same failed result instead of nothing.
    let result = openquant_core::evaluate(&scenario.strategy_artefact(), &scenario.input())
        .expect("a valid input always yields a result");
    assert_eq!(
        to_value(&result).unwrap(),
        out.value,
        "evaluate() and the run agree"
    );
    // The last completed state can be written and restored, and the rest of the run fails at
    // the same event.
    let (_, checkpoint) = round_trip(&out.run, &out.state);
    let restored = out.run.restore(&checkpoint).unwrap();
    let (state, failure) = out.run.run_to_end(restored);
    assert_eq!(
        canonical_result(&out.run, &state, failure.as_ref()),
        canonical_json(&out.value).unwrap()
    );
}

#[test]
fn the_failure_text_names_the_field_and_prints_the_exact_value() {
    let out = one_entry()
        .target_expression(times_k(entry_price(), 3))
        .evaluate();
    let detail = out.text("/outcome/detail");
    assert!(detail.contains("target"), "{detail}");
    assert!(
        detail.contains("4999999999985000000000014999999999995"),
        "{detail}"
    );
}

#[test]
fn a_target_just_below_the_decimal_limit_still_completes() {
    // 5.00 * K^2 = 4999999999990000000000005, about 5e24: shown exactly.
    let out = one_entry()
        .target_expression(times_k(entry_price(), 2))
        .evaluate();
    assert_eq!(out.status(), "COMPLETED");
    assert_eq!(
        out.at("/final/open_positions/0/target"),
        "4999999999990000000000005"
    );
}

#[test]
fn a_snapshot_with_no_decimal_view_fails_the_event_that_takes_it() {
    // close * K^3 at the signal session: the snapshot of a pending entry would be written in a
    // checkpoint and could not be.
    let out = one_entry()
        .snapshot_expression("big", times_k(close(), 3))
        .evaluate();
    assert_eq!(out.status(), "FAILED");
    assert_eq!(out.code(), "ARITHMETIC_OVERFLOW");
    assert_eq!(out.text("/outcome/at/session"), date(4));
    assert_eq!(out.text("/outcome/at/phase"), "AFTER_CLOSE");
    // The signal event is discarded as a whole: no entry record, no reservation.
    assert!(out.entries().is_empty());
    assert!(out.ledger().is_empty());
    // Every state before it can be written.
    round_trip(&out.run, &out.state);
}

fn position_with(change: impl FnOnce(&mut Position)) -> State {
    let mut position = Position {
        instrument_id: "SYN".to_owned(),
        trade_id: "T-1".to_owned(),
        entry_session: date(5),
        quantity: Decimal::from(10),
        entry_price: ratio(5, 1),
        snapshots: vec![("entry_atr".to_owned(), ratio(1, 3))],
        stop: ratio(4, 1),
        target: ratio(6, 1),
        mark: Decimal::from(5),
        fired: Vec::new(),
        scheduled: Some(Scheduled {
            level: ratio(9, 2),
            effective_session: date(7),
        }),
    };
    change(&mut position);
    State {
        next: None,
        cash_available: Decimal::ZERO,
        cash_reserved: Decimal::ZERO,
        receivables: Vec::new(),
        positions: vec![position],
        pending: Vec::new(),
        applied: Default::default(),
        journal: empty_journal(),
    }
}

/// Sets one level of a position.
type SetLevel = fn(&mut Position, Ratio);

/// 2^96, the first integer a 96-bit decimal cannot hold.
const TWO_96: i128 = 79_228_162_514_264_337_593_543_950_336;

#[test]
fn every_level_a_state_holds_is_checked_for_a_decimal_view() {
    assert!(position_with(|_| {}).check_renderable().is_ok());
    let huge = ratio(TWO_96, 1);
    let fields: [(&str, SetLevel); 5] = [
        ("entry price", |p, v| p.entry_price = v),
        ("stop", |p, v| p.stop = v),
        ("target", |p, v| p.target = v),
        ("snapshot entry_atr", |p, v| p.snapshots[0].1 = v),
        ("scheduled stop", |p, v| {
            p.scheduled.as_mut().unwrap().level = v;
        }),
    ];
    for (name, set) in fields {
        let failure = position_with(|p| set(p, huge))
            .check_renderable()
            .expect_err(name);
        assert_eq!(failure.code.to_string(), "ARITHMETIC_OVERFLOW", "{name}");
        assert!(failure.detail.contains(name), "{name}: {}", failure.detail);
        assert!(
            failure.detail.contains("position SYN"),
            "{name}: {}",
            failure.detail
        );
    }
    let mut state = position_with(|_| {});
    state.pending.push(Pending {
        intent_id: "I-1".to_owned(),
        instrument_id: "SYN".to_owned(),
        signal_session: date(4),
        rank: Decimal::from(1),
        cap: Decimal::from(1000),
        snapshots: vec![("big".to_owned(), huge)],
    });
    let failure = state.check_renderable().expect_err("pending snapshot");
    assert!(
        failure.detail.contains("entry intent I-1"),
        "{}",
        failure.detail
    );
    assert!(
        failure.detail.contains("snapshot big"),
        "{}",
        failure.detail
    );
}

#[test]
fn the_decimal_limit_is_the_limit_of_the_view_not_of_the_exact_value() {
    // 2^96 - 1 is the largest integer a decimal holds.
    let limit = TWO_96 - 1;
    let table = [
        (ratio(limit, 1), true),
        (ratio(-limit, 1), true),
        (ratio(TWO_96, 1), false),
        (ratio(-TWO_96, 1), false),
        // A fraction with a whole part under 2^96 shows (rounded) and writes as n/d.
        (ratio(limit * 3 + 1, 3), true),
        // 2^96 - 1/2 rounds half-even up to 2^96: no decimal view.
        (ratio(limit * 2 + 1, 2), false),
        // A fraction whose whole part is far above 2^96.
        (ratio(300_000_000_000_000_000_000_000_000_000_001, 3), false),
        (ratio(1, 3), true),
        (ratio(0, 1), true),
    ];
    for (value, renderable) in table {
        assert_eq!(value.check_renderable().is_ok(), renderable, "{value:?}");
    }
}

#[test]
fn a_checkpoint_that_holds_a_level_with_no_decimal_view_is_refused_at_restore() {
    let read = |path: &str| {
        std::fs::read_to_string(format!("{FIXTURES}/{path}"))
            .unwrap_or_else(|e| panic!("{path}: {e}"))
    };
    let strategy: StrategyArtefact = parse(&read("s0/cases/F0-smoke/strategy.json")).unwrap();
    let input: EvaluationInput = parse(&read("protocol/valid/input.exact-fractions.json")).unwrap();
    let run = Run::prepare(&strategy, &input).unwrap();
    // 300000000000000000000000000000001/3 is reduced, has no decimal form and fits 128 bits, so
    // the reader accepts its grammar. Its whole part is 1e32.
    let mut value = parse_json(&read(
        "protocol/valid/checkpoint.exact-open-position-fraction.json",
    ))
    .unwrap();
    value["state"]["positions"][0]["target"] = json!("300000000000000000000000000000001/3");
    let checkpoint: Checkpoint = parse(&canonical_json(&value).unwrap()).unwrap();
    let failure = run.restore(&checkpoint).expect_err("no decimal view");
    assert_eq!(failure.code.to_string(), "ARITHMETIC_OVERFLOW");
    assert!(failure.detail.contains("target"), "{}", failure.detail);
}

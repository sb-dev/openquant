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
    Run,
    numeric::{Decimal, Ratio},
};

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

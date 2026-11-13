//! F0 smoke scenario: the first complete replay through the shared validator and evaluator.
//!
//! The expected numbers below were derived by hand by the lead before the first run and are
//! labelled "smoke, lead-derived". They are not the independent S0 fixtures (those are
//! hand-derived by a separate author without access to this crate).
//!
//! Fixture: ten sessions, capital 5000.00, five slots, fixed fee 1.00 per fill, lot 1.
//!   signal 2026-01-09 close 102: cap = floor(5000.00 / 5) = 1000.00
//!   entry  2026-01-12 open  102: q = floor((1000 - 1) / 102) = 9, notional 918.00, fee 1.00
//!   ATR3 = (2 + 3 + 5) ... see comments inline; entry_atr 3 gives stop 96, target 111
//!   target 111 touched 2026-01-14 (high 112): sell 9 at 111.00, proceeds 999 - 1 = 998.00

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use openquant_contracts::{
    Checkpoint, EvaluationInput, EvaluationResult, StrategyArtefact, canonical_json, parse,
    payload_digest, to_value,
};
use openquant_core::{Run, Status, evaluate, validate_strategy};

const FIXTURES: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures/s0");

fn read(path: &str) -> String {
    std::fs::read_to_string(format!("{FIXTURES}/{path}")).unwrap()
}

fn f0() -> (StrategyArtefact, EvaluationInput) {
    (
        parse(&read("cases/F0-smoke/strategy.json")).unwrap(),
        parse(&read("cases/F0-smoke/input.json")).unwrap(),
    )
}

fn result_text(result: &EvaluationResult) -> String {
    canonical_json(&to_value(result).unwrap()).unwrap()
}

#[test]
fn f0_signals_fills_cash_and_positions_match_hand_derivation() {
    let (strategy, input) = f0();
    let result = evaluate(&strategy, &input).expect("result");
    assert_eq!(result.outcome.status, Status::Completed);

    // Fills: BUY 9 @ 102.00, SELL 9 @ 111.00 on the target, BUY 9 @ 111.00.
    let fills: Vec<_> = result.journal.fills.iter().collect();
    assert_eq!(fills.len(), 3);
    let shown = |index: usize| {
        let f = fills[index];
        (
            f.session.to_string(),
            f.phase.to_string(),
            format!("{:?}", f.side),
            f.quantity.to_string(),
            f.price.to_string(),
            f.fee.to_string(),
            f.cash_delta.to_string(),
        )
    };
    assert_eq!(
        shown(0),
        (
            "2026-01-12",
            "OPEN",
            "Buy",
            "9",
            "102.00",
            "1.00",
            "-919.00"
        )
            .into_strings()
    );
    assert_eq!(
        shown(1),
        (
            "2026-01-14",
            "DURING_SESSION",
            "Sell",
            "9",
            "111.00",
            "1.00",
            "998.00"
        )
            .into_strings()
    );
    assert_eq!(
        shown(2),
        (
            "2026-01-15",
            "OPEN",
            "Buy",
            "9",
            "111.00",
            "1.00",
            "-1000.00"
        )
            .into_strings()
    );

    // Daily cash, positions and equity.
    let daily: Vec<_> = result
        .journal
        .daily
        .iter()
        .map(|d| {
            (
                d.session.to_string(),
                d.cash_available.to_string(),
                d.cash_reserved.to_string(),
                d.positions_value.to_string(),
                d.equity.to_string(),
            )
        })
        .collect();
    let expected = [
        ("2026-01-08", "5000.00", "0.00", "0.00", "5000.00"),
        ("2026-01-09", "4000.00", "1000.00", "0.00", "5000.00"),
        ("2026-01-12", "4081.00", "0.00", "945.00", "5026.00"),
        ("2026-01-13", "4081.00", "0.00", "972.00", "5053.00"),
        ("2026-01-14", "4063.20", "1015.80", "0.00", "5079.00"),
        ("2026-01-15", "4079.00", "0.00", "1026.00", "5105.00"),
        ("2026-01-16", "4079.00", "0.00", "1053.00", "5132.00"),
    ];
    let tail = &daily[daily.len() - expected.len()..];
    for (actual, want) in tail.iter().zip(expected) {
        assert_eq!(
            (
                actual.0.as_str(),
                actual.1.as_str(),
                actual.2.as_str(),
                actual.3.as_str(),
                actual.4.as_str()
            ),
            want
        );
    }

    // Final state: one open position of 9 shares, entry 111, stop 101, target 126.
    assert_eq!(result.final_.cash_available.as_str(), "4079.00");
    assert_eq!(result.final_.positions_value.as_str(), "1053.00");
    assert_eq!(result.final_.equity.as_str(), "5132.00");
    let open = &result.final_.open_positions;
    assert_eq!(open.len(), 1);
    assert_eq!(
        (
            open[0].quantity.as_str(),
            open[0].entry_price.as_str(),
            open[0].stop.as_str(),
            open[0].target.as_str()
        ),
        ("9", "111", "101", "126")
    );

    // Trades: first closed on TARGET, second open at the end.
    let trades = &result.journal.trades;
    assert_eq!(trades.len(), 2);
    assert_eq!(format!("{:?}", trades[0].exit_reason), "Target");
    assert_eq!(format!("{:?}", trades[1].exit_reason), "OpenAtEnd");
}

trait IntoStrings {
    fn into_strings(self) -> (String, String, String, String, String, String, String);
}

impl IntoStrings for (&str, &str, &str, &str, &str, &str, &str) {
    fn into_strings(self) -> (String, String, String, String, String, String, String) {
        (
            self.0.to_owned(),
            self.1.to_owned(),
            self.2.to_owned(),
            self.3.to_owned(),
            self.4.to_owned(),
            self.5.to_owned(),
            self.6.to_owned(),
        )
    }
}

#[test]
fn repeated_evaluation_is_byte_identical() {
    let (strategy, input) = f0();
    let first = result_text(&evaluate(&strategy, &input).expect("result"));
    let second = result_text(&evaluate(&strategy, &input).expect("result"));
    assert_eq!(first, second);
}

#[test]
fn restoring_from_every_cut_point_matches_uninterrupted_execution() {
    let (strategy, input) = f0();
    let run = Run::prepare(&strategy, &input).expect("prepare");
    let events = run.events().expect("events");
    let (end, failure) = run.run_to_end(run.initial_state().expect("state"));
    assert!(failure.is_none());
    let baseline = result_text(&run.result(&end, None).expect("result"));

    for cut in 0..=events.len() {
        let (prefix, failure) = run.run_events(run.initial_state().unwrap(), &events[..cut]);
        assert!(failure.is_none());
        // Round trip through the shared schema: serialise, validate, parse, restore.
        let text = canonical_json(&to_value(&run.checkpoint(&prefix).unwrap()).unwrap()).unwrap();
        let checkpoint: Checkpoint = parse(&text).unwrap();
        let restored = run.restore(&checkpoint).unwrap();
        let (end, failure) = run.run_events(restored, &events[cut..]);
        assert!(failure.is_none(), "cut {cut}");
        assert_eq!(
            result_text(&run.result(&end, None).unwrap()),
            baseline,
            "cut {cut}"
        );
    }
}

#[test]
fn checkpoint_with_foreign_identity_is_rejected() {
    let (strategy, input) = f0();
    let run = Run::prepare(&strategy, &input).unwrap();
    let state = run.initial_state().unwrap();
    let mut checkpoint = run.checkpoint(&state).unwrap();
    checkpoint.input_hash =
        "sha256:0000000000000000000000000000000000000000000000000000000000000000"
            .parse()
            .unwrap();
    let failure = run.restore(&checkpoint).unwrap_err();
    assert_eq!(failure.code.to_string(), "CHECKPOINT_MISMATCH");
}

#[test]
fn seed_variants_validate_through_one_validator_with_distinct_identities() {
    let names = [
        "seed-1-rsi30-breakeven-off",
        "seed-2-rsi32-breakeven-off",
        "seed-3-rsi30-breakeven-on",
        "seed-4-rsi32-breakeven-on",
        "seed-5-rsi40-breakeven-off-data-only",
    ];
    let mut hashes = Vec::new();
    for name in names {
        let strategy: StrategyArtefact = parse(&read(&format!("strategies/{name}.json"))).unwrap();
        let validated = validate_strategy(&strategy).unwrap_or_else(|f| panic!("{name}: {f}"));
        assert_eq!(validated.hash, payload_digest(&strategy).unwrap());
        hashes.push(validated.hash);
    }
    let mut unique = hashes.clone();
    unique.sort();
    unique.dedup();
    assert_eq!(unique.len(), names.len());
}

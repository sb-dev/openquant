//! The causal signal series (OQ-02 section 2.6): split adjustment, volume, dividends, availability.
//!
//! "Signal OHLC is split-adjusted to the signal session's share basis using only actions effective
//! and available by that session. Adjust historical volume inversely to prices on the same basis.
//! Do not use future adjustments or dividend-adjusted prices."
//!
//! Expected series are written out per bar from the rule `adjusted = raw * old / new` for each
//! split effective after the bar and no later than the decision session.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

mod operators_support;

use std::collections::BTreeMap;

use openquant_core::{
    data::{Action, ActionKind, RunInput},
    model::{MissingReason, Phase},
    numeric::Decimal,
    operators::{PriceBar, Value},
    signals::{AppliedSplit, build_series, evaluate_signals},
};
use operators_support::*;

fn date(index: usize) -> String {
    date_of(index)
}

/// One raw bar per session in ticks of 0.01, each available five minutes after its close.
fn input(bars: &[Option<Bar>]) -> RunInput {
    run_input(bars, &BTreeMap::new())
}

/// The same, with the availability instant of some bars overridden (by index).
fn input_with_availability(bars: &[Option<Bar>], late: &BTreeMap<usize, &str>) -> RunInput {
    run_input(bars, late)
}

fn split(effective_index: usize, new: u64, old: u64) -> AppliedSplit {
    AppliedSplit {
        effective_index,
        new,
        old,
    }
}

fn some(bars: &[Bar]) -> Vec<Option<Bar>> {
    bars.iter().copied().map(Some).collect()
}

/// Assert a built series bar equals `ticks * numerator / denominator` per price and
/// `volume * denominator / numerator` for volume.
#[track_caller]
fn assert_bar(got: &Option<PriceBar>, raw: Bar, numerator: i128, denominator: i128) {
    let got = got.as_ref().expect("bar present");
    let price = |ticks: i64| Frac::new(i128::from(ticks) * numerator, 100 * denominator);
    assert!(price(raw.o).matches(got.open), "open {:?}", got.open);
    assert!(price(raw.h).matches(got.high), "high {:?}", got.high);
    assert!(price(raw.l).matches(got.low), "low {:?}", got.low);
    assert!(price(raw.c).matches(got.close), "close {:?}", got.close);
    let volume = Frac::new(i128::from(raw.v) * denominator, numerator);
    assert!(volume.matches(got.volume), "volume {:?}", got.volume);
}

/// Six sessions; a 2-for-1 split is effective at index 3 (raw prices roughly halve there).
fn split_scenario() -> Vec<Bar> {
    vec![
        Bar::new(10_000, 10_400, 9_800, 10_200, 1_000),
        Bar::new(10_200, 10_600, 10_000, 10_400, 1_100),
        Bar::new(10_400, 10_800, 10_200, 10_600, 1_200),
        Bar::new(5_300, 5_500, 5_200, 5_400, 2_400),
        Bar::new(5_400, 5_600, 5_300, 5_500, 2_500),
        Bar::new(5_500, 5_700, 5_400, 5_600, 2_600),
    ]
}

#[test]
fn without_splits_the_series_is_the_raw_bars() {
    let bars = split_scenario();
    let series = build_series(&input(&some(&bars)), 5, &[], None).unwrap();
    assert_eq!(series.len(), 6);
    for (got, raw) in series.iter().zip(&bars) {
        assert_bar(got, *raw, 1, 1);
    }
}

#[test]
fn a_two_for_one_split_halves_earlier_prices_and_doubles_earlier_volume() {
    let bars = split_scenario();
    let input = input(&some(&bars));
    let series = build_series(&input, 5, &[split(3, 2, 1)], None).unwrap();
    assert_eq!(series.len(), 6);
    // Bars before the effective session: price * 1/2, volume * 2. Hand check of bar 0:
    // open 100.00 -> 50.00, high 104.00 -> 52.00, low 98.00 -> 49.00, close 102.00 -> 51.00,
    // volume 1000 -> 2000.
    let first = series[0].as_ref().unwrap();
    assert_eq!(first.open, Decimal::new(5_000, 2));
    assert_eq!(first.high, Decimal::new(5_200, 2));
    assert_eq!(first.low, Decimal::new(4_900, 2));
    assert_eq!(first.close, Decimal::new(5_100, 2));
    assert_eq!(first.volume, Decimal::from(2_000));
    for index in 0..3 {
        assert_bar(&series[index], bars[index], 1, 2);
    }
    // The effective session and later ones are raw.
    for index in 3..6 {
        assert_bar(&series[index], bars[index], 1, 1);
    }
}

#[test]
fn a_split_is_used_only_from_its_effective_session_never_earlier() {
    let bars = split_scenario();
    let input = input(&some(&bars));
    let splits = [split(3, 2, 1)];
    // Decisions before the effective session see the raw basis even though the split is known
    // to the caller: no future split is used.
    for decision in 0..3 {
        let series = build_series(&input, decision, &splits, None).unwrap();
        assert_eq!(series.len(), decision + 1);
        for (got, raw) in series.iter().zip(&bars) {
            assert_bar(got, *raw, 1, 1);
        }
    }
    // The session of the split itself is the first decision that uses it.
    let series = build_series(&input, 3, &splits, None).unwrap();
    for index in 0..3 {
        assert_bar(&series[index], bars[index], 1, 2);
    }
    assert_bar(&series[3], bars[3], 1, 1);
}

#[test]
fn successive_splits_compose_and_each_applies_only_to_earlier_bars() {
    // 2-for-1 effective at index 2, then 3-for-1 effective at index 4. Raw prices are multiples
    // of 6 ticks so every adjusted value is exact.
    let bars = [
        Bar::new(60_000, 61_200, 59_400, 60_600, 600),
        Bar::new(60_600, 61_800, 60_000, 61_200, 700),
        Bar::new(30_600, 31_200, 30_000, 30_600, 1_500),
        Bar::new(30_600, 31_800, 30_000, 31_200, 1_600),
        Bar::new(10_200, 10_400, 10_000, 10_200, 5_000),
        Bar::new(10_200, 10_600, 10_200, 10_400, 5_100),
    ];
    let input = input(&some(&bars));
    let splits = [split(2, 2, 1), split(4, 3, 1)];
    let series = build_series(&input, 5, &splits, None).unwrap();
    // Bars 0-1 see both splits (x 1/6, volume x 6); bars 2-3 only the second (x 1/3, volume x 3).
    for index in 0..2 {
        assert_bar(&series[index], bars[index], 1, 6);
    }
    for index in 2..4 {
        assert_bar(&series[index], bars[index], 1, 3);
    }
    for index in 4..6 {
        assert_bar(&series[index], bars[index], 1, 1);
    }
    // At decision 3 the second split is still in the future.
    let series = build_series(&input, 3, &splits, None).unwrap();
    for index in 0..2 {
        assert_bar(&series[index], bars[index], 1, 2);
    }
    for index in 2..4 {
        assert_bar(&series[index], bars[index], 1, 1);
    }
    // The order in which applied splits are listed does not matter.
    let reversed = build_series(&input, 5, &[split(4, 3, 1), split(2, 2, 1)], None).unwrap();
    assert_eq!(build_series(&input, 5, &splits, None).unwrap(), reversed);
}

#[test]
fn a_reverse_split_multiplies_earlier_prices_and_divides_earlier_volume() {
    // 1-for-10: 10 old shares become one new share (new = 1, old = 10).
    let bars = [
        Bar::new(500, 520, 490, 510, 10_000),
        Bar::new(510, 530, 500, 520, 12_000),
        Bar::new(5_200, 5_400, 5_100, 5_300, 1_300),
    ];
    let series = build_series(&input(&some(&bars)), 2, &[split(2, 1, 10)], None).unwrap();
    assert_bar(&series[0], bars[0], 10, 1);
    assert_bar(&series[1], bars[1], 10, 1);
    assert_bar(&series[2], bars[2], 1, 1);
    let first = series[0].as_ref().unwrap();
    assert_eq!(first.close, Decimal::new(5_100, 2));
    assert_eq!(first.volume, Decimal::from(1_000));
}

#[test]
fn a_three_for_one_split_gives_a_28_digit_quotient_that_round_trips() {
    let bars = [Bar::flat(10_000, 300), Bar::flat(3_400, 900)];
    let series = build_series(&input(&some(&bars)), 1, &[split(1, 3, 1)], None).unwrap();
    let first = series[0].as_ref().unwrap();
    // 100.00 / 3 is not a terminating decimal; the engine keeps 28 digits.
    assert_bar(&series[0], bars[0], 1, 3);
    assert_eq!(first.volume, Decimal::from(900));
    assert!(Frac::new(10_000, 300).matches(first.close));
    assert!(!Frac::new(10_000, 300).terminates());
}

#[test]
fn cash_dividends_never_adjust_the_signal_series() {
    let bars = split_scenario();
    let mut input = input(&some(&bars));
    input.actions.push(Action {
        id: "DIV-1".to_owned(),
        effective_session: date(2),
        available_at: format!("{}T12:00:00Z", date(1)),
        kind: ActionKind::CashDividend {
            amount_per_share: Decimal::new(250, 2),
            payment_session: date(4),
            payment_phase: Phase::BeforeOpen,
        },
    });
    // Neither as an applied split nor through the actions held by the input.
    let series = build_series(&input, 5, &[], None).unwrap();
    for (got, raw) in series.iter().zip(&bars) {
        assert_bar(got, *raw, 1, 1);
    }
    // With a split present, the dividend still changes nothing.
    let with_split = build_series(&input, 5, &[split(3, 2, 1)], None).unwrap();
    for index in 0..3 {
        assert_bar(&with_split[index], bars[index], 1, 2);
    }
}

#[test]
fn an_absent_bar_is_an_absent_observation_not_a_filled_one() {
    let bars = split_scenario();
    let mut sparse = some(&bars);
    sparse[1] = None;
    let series = build_series(&input(&sparse), 5, &[split(3, 2, 1)], None).unwrap();
    assert_eq!(series.len(), 6);
    assert!(series[1].is_none());
    assert_bar(&series[0], bars[0], 1, 2);
    assert_bar(&series[2], bars[2], 1, 2);
}

#[test]
fn the_series_starts_at_the_first_processed_session() {
    let bars = split_scenario();
    let mut input = input(&some(&bars));
    input.first = 2;
    let series = build_series(&input, 5, &[split(3, 2, 1)], None).unwrap();
    assert_eq!(series.len(), 4);
    assert_bar(&series[0], bars[2], 1, 2);
    assert_bar(&series[1], bars[3], 1, 1);
    // Lookback cannot reach before the warm-up start: SMA over four bars exists only at the end.
    let strategy = Def::new().indicator("x", sma(close(), 4)).validated();
    assert_eq!(
        evaluate_signals(&strategy, &series[..3])
            .unwrap()
            .indicators[0]
            .1,
        Value::Missing(MissingReason::InsufficientHistory)
    );
}

#[test]
fn a_bar_available_after_the_deadline_is_future_data() {
    let bars = split_scenario();
    let mut late = BTreeMap::new();
    late.insert(4, "2026-02-06T14:30:01Z"); // one second after the open of session 5 (index 5)
    let input = input_with_availability(&some(&bars), &late);
    let deadline = "2026-02-06T14:30:00Z";
    let failure = build_series(&input, 4, &[], Some(deadline)).unwrap_err();
    assert_eq!(failure.code.to_string(), "FUTURE_DATA");
    assert!(failure.detail.contains("2026-02-05"), "{failure}");
    // Available exactly at the deadline is allowed.
    let mut on_time = BTreeMap::new();
    on_time.insert(4, deadline);
    let input = input_with_availability(&some(&bars), &on_time);
    assert!(build_series(&input, 4, &[], Some(deadline)).is_ok());
    // No deadline (the last session has no next open) checks nothing.
    let late_input = input_with_availability(&some(&bars), &late);
    assert!(build_series(&late_input, 4, &[], None).is_ok());
}

#[test]
fn bars_after_the_decision_session_are_never_read() {
    // The series for decision t must not depend on anything after t, including bars that would
    // be unavailable or absent: truncation invariance at the series level.
    let bars = split_scenario();
    let mut late = BTreeMap::new();
    late.insert(5, "2099-01-01T00:00:00Z");
    let late_input = input_with_availability(&some(&bars), &late);
    let mut gap = some(&bars);
    gap[5] = None;
    let gap_input = input(&gap);
    for decision in 0..5 {
        let baseline =
            build_series(&input(&some(&bars)), decision, &[split(3, 2, 1)], None).unwrap();
        for variant in [&late_input, &gap_input] {
            let got = build_series(
                variant,
                decision,
                &[split(3, 2, 1)],
                Some("2026-02-28T14:30:00Z"),
            )
            .unwrap();
            assert_eq!(got, baseline, "decision {decision}");
        }
    }
}

#[test]
fn an_impossible_decision_index_fails_cleanly() {
    let bars = split_scenario();
    let input = input(&some(&bars));
    for decision in [6, 100, usize::MAX - 1, usize::MAX] {
        let failure = build_series(&input, decision, &[], None).unwrap_err();
        assert_eq!(
            failure.code.to_string(),
            "INVALID_INPUT",
            "decision {decision}"
        );
    }
    // A decision before the first processed session has no series; evaluating it is an error.
    let mut shifted = input.clone();
    shifted.first = 4;
    let series = build_series(&shifted, 2, &[], None).unwrap();
    assert!(series.is_empty());
    let strategy = Def::new().validated();
    assert!(evaluate_signals(&strategy, &series).is_err());
}

#[test]
fn degenerate_split_ratios_are_arithmetic_failures_not_panics() {
    let bars = split_scenario();
    let input = input(&some(&bars));
    // A zero ratio term divides by zero (new = 0 for prices, old = 0 for volume).
    for degenerate in [split(3, 0, 1), split(3, 1, 0)] {
        let failure = build_series(&input, 5, &[degenerate], None).unwrap_err();
        assert_eq!(failure.code.to_string(), "ARITHMETIC_OVERFLOW");
    }
    // Many splits compose until the product no longer fits, which is reported, not wrapped.
    let many: Vec<AppliedSplit> = (1..5).map(|i| split(i, u64::MAX, 1)).collect();
    let result = build_series(&input, 5, &many, None);
    assert_eq!(result.unwrap_err().code.to_string(), "ARITHMETIC_OVERFLOW");
}

// ---------------------------------------------------------------------------------------------
// Signals computed on the causal series
// ---------------------------------------------------------------------------------------------

#[test]
fn a_split_does_not_look_like_a_price_collapse_in_the_signals() {
    // Raw closes 100, 100, 100, then 50, 50, 50 after a 2-for-1 split effective at index 3.
    // On the signal basis nothing moved: the mean is 50 and RSI is undefined (flat). Without the
    // adjustment the raw series shows a -50 collapse: RSI 0 and a lower mean.
    let bars = [
        Bar::flat(10_000, 1_000),
        Bar::flat(10_000, 1_000),
        Bar::flat(10_000, 1_000),
        Bar::flat(5_000, 2_000),
        Bar::flat(5_000, 2_000),
        Bar::flat(5_000, 2_000),
    ];
    let input = input(&some(&bars));
    let strategy = Def::new()
        .indicator("mean", sma(close(), 6))
        .indicator("rsi", rsi(close(), 5))
        .indicator("vmean", sma(volume(), 6))
        .validated();
    let adjusted = build_series(&input, 5, &[split(3, 2, 1)], None).unwrap();
    let eval = evaluate_signals(&strategy, &adjusted).unwrap();
    assert_agrees(Exp::Num(Frac::int(50)), indicator(&eval, "mean"), "mean");
    assert_agrees(Exp::flat(), indicator(&eval, "rsi"), "rsi");
    assert_agrees(
        Exp::Num(Frac::int(2_000)),
        indicator(&eval, "vmean"),
        "volume mean",
    );

    let raw = build_series(&input, 5, &[], None).unwrap();
    let eval = evaluate_signals(&strategy, &raw).unwrap();
    assert_agrees(
        Exp::Num(Frac::int(75)),
        indicator(&eval, "mean"),
        "raw mean",
    );
    assert_eq!(indicator(&eval, "rsi"), Value::Num(Decimal::ZERO));
}

#[test]
fn atr_across_a_split_uses_the_adjusted_previous_close() {
    // Previous close 100.00, split 2-for-1, today's raw range 49.00..51.00 with close 50.00.
    // Unadjusted, |low - previous close| = 51.00 dominates; adjusted, the previous close is
    // 50.00 and the true range is the bar's own range, 2.00.
    let bars = [
        Bar::new(10_000, 10_100, 9_900, 10_000, 1_000),
        Bar::new(5_000, 5_100, 4_900, 5_000, 2_000),
    ];
    let input = input(&some(&bars));
    let strategy = Def::new().indicator("atr", atr(1)).validated();
    let adjusted = build_series(&input, 1, &[split(1, 2, 1)], None).unwrap();
    assert_agrees(
        Exp::Num(Frac::int(2)),
        indicator(&evaluate_signals(&strategy, &adjusted).unwrap(), "atr"),
        "adjusted ATR",
    );
    let raw = build_series(&input, 1, &[], None).unwrap();
    assert_agrees(
        Exp::Num(Frac::int(51)),
        indicator(&evaluate_signals(&strategy, &raw).unwrap(), "atr"),
        "raw ATR",
    );
}

#[test]
fn rsi_and_means_computed_after_adjustment_equal_those_of_the_underlying_series() {
    // The underlying (never-split) closes, in ticks. The raw record shows them multiplied by 3
    // before the split at index 8 (a 3-for-1 split: old prices are three times the new basis).
    let underlying = [
        10_000_i64, 10_150, 10_090, 10_240, 10_200, 10_310, 10_280, 10_190, 10_260, 10_330, 10_300,
        10_420, 10_380, 10_290, 10_350, 10_480, 10_410, 10_500,
    ];
    let split_at = 8;
    let raw: Vec<Bar> = underlying
        .iter()
        .enumerate()
        .map(|(i, close)| {
            let factor = if i < split_at { 3 } else { 1 };
            let volume = if i < split_at { 1_000 } else { 3_000 };
            Bar::flat(close * factor, volume)
        })
        .collect();
    let truth: Vec<Bar> = underlying.iter().map(|c| Bar::flat(*c, 3_000)).collect();

    let input = input(&some(&raw));
    let adjusted = build_series(&input, 17, &[split(split_at, 3, 1)], None).unwrap();
    let strategy = Def::new()
        .indicator("rsi", rsi(close(), 14))
        .indicator("mean", sma(close(), 10))
        .indicator("vmean", sma(volume(), 10))
        .validated();
    let got = evaluate_signals(&strategy, &adjusted).unwrap();
    let reference: Vec<Option<Bar>> = truth.iter().copied().map(Some).collect();
    assert_agrees(
        reference::rsi(&reference, 17, 14),
        indicator(&got, "rsi"),
        "rsi",
    );
    assert_agrees(
        reference::sma_close(&reference, 17, 10),
        indicator(&got, "mean"),
        "mean",
    );
    assert_agrees(
        reference::sma_volume(&reference, 17, 10),
        indicator(&got, "vmean"),
        "volume mean",
    );
}

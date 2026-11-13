//! Operator values against independent derivations (OQ-02 sections 2.2 and 2.6).
//!
//! Every expected number is either written out from a hand derivation in a comment or computed by
//! the exact-fraction `reference` module in `operators_support`. None comes from the engine.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

mod operators_support;

use openquant_core::{
    model::MissingReason,
    numeric::Ratio,
    operators::{PriceBar, Value},
    signals::evaluate_signals,
};
use operators_support::*;

#[test]
fn arithmetic_overflow_is_a_typed_failure_never_a_panic_or_a_wrapped_value() {
    // The exact domain is a fraction of two 128-bit integers: values at its edge must fail, not
    // wrap and not round.
    let big = Ratio::new(i128::MAX, 1).unwrap();
    let extreme = |high: Ratio, low: Ratio, volume: Ratio| PriceBar {
        open: high,
        high,
        low,
        close: high,
        volume,
    };
    let cases: Vec<(&str, serde_json::Value, Vec<Option<PriceBar>>)> = vec![
        (
            "sum of closes",
            bin("add", close(), close()),
            vec![Some(extreme(big, Ratio::ZERO, Ratio::ONE))],
        ),
        (
            "difference beyond the minimum",
            bin("sub", bin("mul", close(), cst("-1", "RATIO")), close()),
            vec![Some(extreme(big, Ratio::ZERO, Ratio::ONE))],
        ),
        (
            "product with a large ratio",
            bin("mul", volume(), cst("1000000000000", "RATIO")),
            vec![Some(extreme(Ratio::ONE, Ratio::ZERO, big))],
        ),
        (
            "quotient by a tiny ratio",
            bin("div", close(), cst("0.000000000001", "RATIO")),
            vec![Some(extreme(big, Ratio::ZERO, Ratio::ONE))],
        ),
        (
            "sum inside a rolling mean",
            sma(volume(), 2),
            vec![
                Some(extreme(Ratio::ONE, Ratio::ZERO, big)),
                Some(extreme(Ratio::ONE, Ratio::ZERO, big)),
            ],
        ),
        (
            "range of an extreme bar",
            atr(1),
            vec![
                Some(extreme(big, Ratio::ZERO, Ratio::ONE)),
                Some(extreme(big, big.negated(), Ratio::ONE)),
            ],
        ),
        (
            "denominators that do not combine",
            bin("add", close(), bin("div", close(), cst("3", "RATIO"))),
            vec![Some(extreme(
                Ratio::new(i128::MAX - 2, 1_000_000_000_000_000_000_007).unwrap(),
                Ratio::ZERO,
                Ratio::ONE,
            ))],
        ),
    ];
    for (name, expr, series) in cases {
        let strategy = Def::new().indicator("x", expr).validated();
        let failure = evaluate_signals(&strategy, &series).unwrap_err();
        assert_eq!(failure.code.to_string(), "ARITHMETIC_OVERFLOW", "{name}");
    }
}

fn closes_to_series(closes: &[i64]) -> Vec<Option<PriceBar>> {
    series_of(&flat_series(closes))
}

/// Closes built from consecutive changes (in ticks), starting at `start`.
fn closes_from_changes(start: i64, changes: &[i64]) -> Vec<i64> {
    let mut out = vec![start];
    for change in changes {
        out.push(out.last().unwrap() + change);
    }
    out
}

fn rsi14() -> Probe {
    Probe::new(rsi(close(), 14))
}

fn last(series: &[Option<PriceBar>]) -> usize {
    series.len() - 1
}

// ---------------------------------------------------------------------------------------------
// RSI
// ---------------------------------------------------------------------------------------------

#[test]
fn rsi_follows_the_spec_formula_with_simple_means() {
    // Closes 10, 12, 11, 15 with window 3: changes +2, -1, +4.
    // mean gain = 6/3 = 2, mean loss = 1/3, RS = 6, RSI = 100 - 100/(1 + 6) = 600/7.
    let series = closes_to_series(&[1000, 1200, 1100, 1500]);
    let value = Probe::new(rsi(close(), 3)).at(&series, 3);
    assert_agrees(Exp::Num(Frac::new(600, 7)), value, "RSI3");
    // The value is exactly 600/7. Its display form is the 28-digit quotient
    // 85.714285714285714285714285714 (rounded in the last digit).
    assert_eq!(num(value).to_string(), "600/7");
    assert!(
        num(value)
            .to_display_decimal()
            .unwrap()
            .to_string()
            .starts_with("85.7142857142857142857142857")
    );
}

#[test]
fn rsi_has_no_memory_beyond_its_window() {
    // A Wilder-smoothed RSI would carry the early history into the value. These two series share
    // only their last four closes (10, 12, 11, 15) and must give the same RSI3.
    let probe = Probe::new(rsi(close(), 3));
    let calm = closes_to_series(&[1000, 1001, 1000, 1001, 1000, 1200, 1100, 1500]);
    let wild = closes_to_series(&[5000, 100, 9000, 20, 1000, 1200, 1100, 1500]);
    let a = probe.at(&calm, last(&calm));
    let b = probe.at(&wild, last(&wild));
    assert_eq!(a, b);
    assert_agrees(Exp::Num(Frac::new(600, 7)), a, "RSI3");
}

#[test]
fn rsi_gain_only_is_100_loss_only_is_0_and_flat_is_undefined() {
    let up: Vec<i64> = (0..15).map(|i| 10_000 + i * 7).collect();
    let down: Vec<i64> = (0..15).map(|i| 10_000 - i * 7).collect();
    let flat = vec![10_000; 15];
    let probe = rsi14();
    assert_eq!(
        probe.at(&closes_to_series(&up), 14),
        Value::Num(Ratio::from_i64(100))
    );
    assert_eq!(
        probe.at(&closes_to_series(&down), 14),
        Value::Num(Ratio::ZERO)
    );
    assert_eq!(
        probe.at(&closes_to_series(&flat), 14),
        Value::Missing(MissingReason::UndefinedFlat)
    );
    // One single gain among flat bars is still gain-only: 100.
    let mut one_gain = vec![10_000; 15];
    one_gain[14] = 10_001;
    assert_eq!(
        probe.at(&closes_to_series(&one_gain), 14),
        Value::Num(Ratio::from_i64(100))
    );
    // One single loss among flat bars is loss-only: 0.
    let mut one_loss = vec![10_000; 15];
    for close in one_loss.iter_mut().skip(3) {
        *close = 9_999;
    }
    assert_eq!(
        probe.at(&closes_to_series(&one_loss), 14),
        Value::Num(Ratio::ZERO)
    );
}

#[test]
fn rsi_becomes_defined_again_when_the_flat_window_slides_past_a_move() {
    // One move at index 3, then flat. The window of 14 changes ending at t covers the move for
    // t = 3 + 0..=13 (change index 3 inside t-13..=t) and not from t = 17.
    let mut closes = vec![10_000; 40];
    for close in closes.iter_mut().skip(3) {
        *close = 10_100;
    }
    let series = closes_to_series(&closes);
    let probe = rsi14();
    for t in 14..=16 {
        assert_eq!(
            probe.at(&series, t),
            Value::Num(Ratio::from_i64(100)),
            "t={t}: the single gain is inside the window"
        );
    }
    for t in 17..40 {
        assert_eq!(
            probe.at(&series, t),
            Value::Missing(MissingReason::UndefinedFlat),
            "t={t}: the window is flat again"
        );
    }
}

#[test]
fn rsi_needs_window_plus_one_closes() {
    let closes: Vec<i64> = (0..30).map(|i| 10_000 + (i * i) % 17 * 5).collect();
    let series = closes_to_series(&closes);
    let probe = rsi14();
    for t in 0..14 {
        assert_eq!(
            probe.at(&series, t),
            Value::Missing(MissingReason::InsufficientHistory),
            "t={t}: only {} closes",
            t + 1
        );
    }
    assert!(matches!(probe.at(&series, 14), Value::Num(_)), "15 closes");
    // RSI[t-2] needs 17 closes: the first valid index of the lagged value is 16.
    let lagged = Probe::new(lag(rsi(close(), 14), 2));
    for t in 0..16 {
        assert_eq!(
            lagged.at(&series, t),
            Value::Missing(MissingReason::InsufficientHistory),
            "t={t}"
        );
    }
    assert!(matches!(lagged.at(&series, 16), Value::Num(_)), "17 closes");
}

#[test]
fn rsi_equals_exactly_30_and_32_on_integer_ratios() {
    let probe = rsi14();
    // Gains 3 x 100, losses 7 x 100, four unchanged: 100 * 300 / 1000 = 30 exactly.
    let mut changes = vec![100, 100, 100, -100, -100, -100, -100, -100, -100, -100];
    changes.extend([0, 0, 0, 0]);
    assert_eq!(changes.len(), 14);
    let series = closes_to_series(&closes_from_changes(10_000, &changes));
    assert_eq!(probe.at(&series, 14), Value::Num(Ratio::from_i64(30)));

    // Gains 400 + 400, loss 1700, eleven unchanged: 100 * 800 / 2500 = 32 exactly.
    let mut changes = vec![400, 400, -1700];
    changes.extend([0; 11]);
    assert_eq!(changes.len(), 14);
    let series = closes_to_series(&closes_from_changes(10_000, &changes));
    assert_eq!(probe.at(&series, 14), Value::Num(Ratio::from_i64(32)));

    // One tick either way leaves the boundary: 100 * 801 / 2501 > 32 and 100 * 799 / 2499 < 32.
    for (gain, above) in [(401, true), (399, false)] {
        let mut changes = vec![400, gain, -1700];
        changes.extend([0; 11]);
        let series = closes_to_series(&closes_from_changes(10_000, &changes));
        let value = num(probe.at(&series, 14));
        assert_eq!(value > Ratio::from_i64(32), above, "{value}");
    }
}

#[test]
fn rsi_matches_the_reference_on_a_long_random_series() {
    let bars = random_bars(7, 600);
    let reference: Vec<Option<Bar>> = bars.iter().copied().map(Some).collect();
    let series = series_of(&bars);
    let probe = rsi14();
    for t in 0..bars.len() {
        assert_agrees(
            reference::rsi(&reference, t, 14),
            probe.at(&series, t),
            &format!("t={t}"),
        );
    }
}

// ---------------------------------------------------------------------------------------------
// ATR
// ---------------------------------------------------------------------------------------------

/// Hand derivation, window 3, prices in ticks:
///
/// | bar | high | low | close | TR | decided by |
/// |-----|------|-----|-------|----|------------|
/// | b0  | 10200 | 9900 | 10000 | - | no previous close |
/// | b1  | 10500 | 10100 | 10400 | max(400, 500, 100) = 500 | high - previous close |
/// | b2  | 10300 | 9800 | 9900 | max(500, 100, 600) = 600 | previous close - low |
/// | b3  | 10000 | 9700 | 9800 | max(300, 100, 200) = 300 | high - low |
/// | b4  | 10200 | 9600 | 10000 | max(600, 400, 200) = 600 | high - low |
///
/// ATR3 at b3 = (500 + 600 + 300) / 3 = 1400/3 ticks. ATR3 at b4 = (600 + 300 + 600) / 3 = 500.
#[test]
fn atr_takes_the_largest_of_the_three_ranges() {
    let bars = [
        Bar::new(10_000, 10_200, 9_900, 10_000, 100),
        Bar::new(10_200, 10_500, 10_100, 10_400, 100),
        Bar::new(10_300, 10_300, 9_800, 9_900, 100),
        Bar::new(9_900, 10_000, 9_700, 9_800, 100),
        Bar::new(9_800, 10_200, 9_600, 10_000, 100),
    ];
    let series = series_of(&bars);
    let probe = Probe::new(atr(3));
    for t in 0..3 {
        assert_eq!(
            probe.at(&series, t),
            Value::Missing(MissingReason::InsufficientHistory),
            "t={t}: needs window + 1 = 4 bars"
        );
    }
    assert_agrees(
        Exp::Num(Frac::new(1400, 300)),
        probe.at(&series, 3),
        "ATR3[3]",
    );
    assert_agrees(Exp::Num(Frac::ticks(500)), probe.at(&series, 4), "ATR3[4]");
    // Window 1 is the last true range itself.
    let one = Probe::new(atr(1));
    assert_agrees(Exp::Num(Frac::ticks(500)), one.at(&series, 1), "TR b1");
    assert_agrees(Exp::Num(Frac::ticks(600)), one.at(&series, 2), "TR b2");
    assert_agrees(Exp::Num(Frac::ticks(300)), one.at(&series, 3), "TR b3");
    assert_eq!(
        one.at(&series, 0),
        Value::Missing(MissingReason::InsufficientHistory)
    );
}

#[test]
fn atr_of_flat_bars_is_exactly_zero() {
    let series = closes_to_series(&[10_000; 20]);
    assert_eq!(Probe::new(atr(14)).at(&series, 14), Value::Num(Ratio::ZERO));
}

#[test]
fn atr_matches_the_reference_and_is_never_below_the_mean_range() {
    let bars = random_bars(11, 500);
    let reference: Vec<Option<Bar>> = bars.iter().copied().map(Some).collect();
    let series = series_of(&bars);
    let probe = Probe::new(atr(14));
    for t in 0..bars.len() {
        let value = probe.at(&series, t);
        assert_agrees(reference::atr(&reference, t, 14), value, &format!("t={t}"));
        if let Value::Num(atr) = value {
            // ATR * 14 * 100 is the sum of the true ranges in ticks; each is at least the bar's
            // own high - low. The mean is exact, so there is no tolerance.
            let range_sum: i64 = bars[t - 13..=t].iter().map(|b| b.h - b.l).sum();
            let true_range_ticks = atr.mul(Ratio::from_i64(1400)).unwrap();
            assert!(
                true_range_ticks >= Ratio::from_i64(range_sum),
                "t={t}: TR >= high - low"
            );
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Simple means and lags
// ---------------------------------------------------------------------------------------------

#[test]
fn sma_includes_the_current_bar_and_needs_a_full_window() {
    // Closes 10, 20, 30, 50: SMA3 at t=2 is 20 and at t=3 is (20 + 30 + 50) / 3 = 100/3.
    let series = closes_to_series(&[1000, 2000, 3000, 5000]);
    let probe = Probe::new(sma(close(), 3));
    assert_eq!(
        probe.at(&series, 0),
        Value::Missing(MissingReason::InsufficientHistory)
    );
    assert_eq!(
        probe.at(&series, 1),
        Value::Missing(MissingReason::InsufficientHistory)
    );
    assert_agrees(Exp::Num(Frac::int(20)), probe.at(&series, 2), "SMA3[2]");
    assert_agrees(Exp::Num(Frac::new(100, 3)), probe.at(&series, 3), "SMA3[3]");
    // Window 1 is the bar itself.
    let one = Probe::new(sma(close(), 1));
    assert_agrees(Exp::Num(Frac::int(50)), one.at(&series, 3), "SMA1");
}

#[test]
fn volume_mean_includes_the_current_bar() {
    // Volumes 100, 200, 600 with window 2 at t=2: (200 + 600) / 2 = 400, not (100 + 200) / 2.
    let bars = [
        Bar::flat(1000, 100),
        Bar::flat(1000, 200),
        Bar::flat(1000, 600),
    ];
    let series = series_of(&bars);
    let probe = Probe::new(sma(volume(), 2));
    assert_agrees(
        Exp::Num(Frac::int(400)),
        probe.at(&series, 2),
        "volume SMA2",
    );
    assert_agrees(
        Exp::Num(Frac::int(150)),
        probe.at(&series, 1),
        "volume SMA2 at t=1",
    );
}

#[test]
fn lag_reads_earlier_sessions_and_is_missing_before_the_start() {
    let series = closes_to_series(&[1000, 1100, 1300, 1600, 2000]);
    let lag2 = Probe::new(lag(close(), 2));
    assert_eq!(
        lag2.at(&series, 0),
        Value::Missing(MissingReason::InsufficientHistory)
    );
    assert_eq!(
        lag2.at(&series, 1),
        Value::Missing(MissingReason::InsufficientHistory)
    );
    assert_agrees(Exp::Num(Frac::int(10)), lag2.at(&series, 2), "lag2[2]");
    assert_agrees(Exp::Num(Frac::int(13)), lag2.at(&series, 4), "lag2[4]");
    // lag(lag(x,1),1) equals lag(x,2).
    let nested = Probe::new(lag(lag(close(), 1), 1));
    for t in 0..5 {
        assert_eq!(nested.at(&series, t), lag2.at(&series, t), "t={t}");
    }
    // A mean of a lagged value is the lagged mean: SMA2(lag1(close))[3] = (c1 + c2) / 2.
    let mean_of_lag = Probe::new(sma(lag(close(), 1), 2));
    assert_agrees(
        Exp::Num(Frac::new(24, 2)),
        mean_of_lag.at(&series, 3),
        "SMA2(lag1)[3]",
    );
    let lag_of_mean = Probe::new(lag(sma(close(), 2), 1));
    assert_agrees(
        Exp::Num(Frac::new(24, 2)),
        lag_of_mean.at(&series, 3),
        "lag1(SMA2)[3]",
    );
}

#[test]
fn the_longest_supported_windows_work() {
    let bars = random_bars(3, 400);
    let reference: Vec<Option<Bar>> = bars.iter().copied().map(Some).collect();
    let series = series_of(&bars);
    let probe = Probe::new(sma(close(), 252));
    for t in [0, 100, 250, 251, 252, 399] {
        assert_agrees(
            reference::sma_close(&reference, t, 252),
            probe.at(&series, t),
            &format!("SMA252 t={t}"),
        );
    }
    assert!(matches!(probe.at(&series, 251), Value::Num(_)));
    assert_eq!(
        probe.at(&series, 250),
        Value::Missing(MissingReason::InsufficientHistory)
    );
    let rsi252 = Probe::new(rsi(close(), 252));
    assert_eq!(
        rsi252.at(&series, 251),
        Value::Missing(MissingReason::InsufficientHistory)
    );
    assert_agrees(
        reference::rsi(&reference, 252, 252),
        rsi252.at(&series, 252),
        "RSI252",
    );
    let lag60 = Probe::new(lag(close(), 60));
    assert_agrees(
        Exp::Num(Frac::ticks(i128::from(bars[40].c))),
        lag60.at(&series, 100),
        "lag60",
    );
}

// ---------------------------------------------------------------------------------------------
// Missing bars
// ---------------------------------------------------------------------------------------------

#[test]
fn an_absent_bar_makes_every_window_that_covers_it_missing() {
    let bars = random_bars(5, 80);
    let reference: Vec<Option<Bar>> = bars
        .iter()
        .copied()
        .enumerate()
        .map(|(i, b)| if i == 30 { None } else { Some(b) })
        .collect();
    let series: Vec<Option<PriceBar>> = reference.iter().map(|b| b.map(Bar::price_bar)).collect();
    // (name, probe, first index with a value, indexes whose value must be missing). Bar 30 is
    // absent, so a window of n bars is incomplete for t in 30..=30+n-1, a lag of k only at 30+k.
    let cases: [(&str, Probe, usize, std::ops::RangeInclusive<usize>); 5] = [
        ("close", Probe::new(close()), 0, 30..=30),
        ("sma5", Probe::new(sma(close(), 5)), 4, 30..=34),
        ("rsi14", rsi14(), 14, 30..=44),
        ("atr14", Probe::new(atr(14)), 14, 30..=44),
        ("lag3", Probe::new(lag(close(), 3)), 3, 33..=33),
    ];
    for (name, probe, first, missing) in &cases {
        for t in *first..80 {
            let value = probe.at(&series, t);
            if missing.contains(&t) {
                assert!(
                    matches!(value, Value::Missing(_)),
                    "{name} t={t}: {value:?}"
                );
            } else {
                assert!(matches!(value, Value::Num(_)), "{name} t={t}: {value:?}");
            }
        }
    }
    // Where the window is complete again the value is the reference value.
    for t in 45..80 {
        assert_agrees(
            reference::rsi(&reference, t, 14),
            rsi14().at(&series, t),
            &format!("t={t}"),
        );
        assert_agrees(
            reference::atr(&reference, t, 14),
            Probe::new(atr(14)).at(&series, t),
            &format!("t={t}"),
        );
    }
}

// ---------------------------------------------------------------------------------------------
// Typed arithmetic, comparisons, Boolean combination
// ---------------------------------------------------------------------------------------------

#[test]
fn arithmetic_is_exact_and_division_by_zero_is_an_explicit_missing_value() {
    let series = series_of(&[
        Bar::flat(1000, 400),
        Bar::flat(1250, 0),
        Bar::flat(1250, 600),
    ]);
    // Volumes 400, 0, 600: at t=2 the mean of the last two is 300, so the ratio is 600 / 300 = 2.
    let ratio = Probe::new(bin("div", volume(), sma(volume(), 2)));
    assert_agrees(Exp::Num(Frac::int(2)), ratio.at(&series, 2), "volume ratio");
    // Zero volume mean (two zero volumes) divides by zero.
    let zeros = series_of(&[Bar::flat(1000, 0), Bar::flat(1000, 0)]);
    assert_eq!(
        ratio.at(&zeros, 1),
        Value::Missing(MissingReason::DivByZero)
    );
    // A zero numerator is fine.
    let zero_numerator = series_of(&[Bar::flat(1000, 100), Bar::flat(1000, 0)]);
    assert_eq!(ratio.at(&zero_numerator, 1), Value::Num(Ratio::ZERO));
    // Division by a zero RATIO constant, and by an exact zero difference.
    assert_eq!(
        Probe::new(bin("div", close(), cst("0", "RATIO"))).at(&series, 0),
        Value::Missing(MissingReason::DivByZero)
    );
    assert_eq!(
        Probe::new(bin("div", close(), bin("sub", close(), close()))).at(&series, 0),
        Value::Missing(MissingReason::DivByZero)
    );
    // A missing operand wins over division by zero because it is evaluated and reported first.
    assert_eq!(
        Probe::new(bin("div", lag(close(), 1), cst("0", "RATIO"))).at(&series, 0),
        Value::Missing(MissingReason::InsufficientHistory)
    );
    // add / sub / mul take their units from the operands.
    // Closes 10.00, 12.50, 12.50: 12.50 + 12.50 = 25.00 and 12.50 * 1.5 = 18.75.
    assert_agrees(
        Exp::Num(Frac::ticks(2500)),
        Probe::new(bin("add", close(), lag(close(), 1))).at(&series, 2),
        "add",
    );
    assert_agrees(
        Exp::Num(Frac::int(0)),
        Probe::new(bin("sub", close(), close())).at(&series, 0),
        "sub",
    );
    assert_agrees(
        Exp::Num(Frac::ticks(-250)),
        Probe::new(bin("sub", lag(close(), 1), close())).at(&series, 1),
        "sub below zero",
    );
    assert_agrees(
        Exp::Num(Frac::ticks(1875)),
        Probe::new(bin("mul", close(), cst("1.5", "RATIO"))).at(&series, 2),
        "mul",
    );
}

#[test]
fn the_seed_rank_formula_gives_the_documented_value() {
    // rank = 50 * (volume / volume_SMA20) + (100 - RSI). With volume 3000 against a mean of 2000
    // and RSI 25: 50 * 3/2 + 75 = 150. The mean is a window of 2 here and RSI a constant.
    let strategy = Def::new()
        .indicator("rsi", cst("25", "POINTS"))
        .indicator("vmean", sma(volume(), 2))
        .rank(bin(
            "add",
            bin(
                "mul",
                cst("50", "POINTS"),
                bin("div", volume(), rf("vmean")),
            ),
            bin("sub", cst("100", "POINTS"), rf("rsi")),
        ))
        .validated();
    let series = series_of(&[Bar::flat(1000, 1000), Bar::flat(1000, 3000)]);
    let rank = signals(&strategy, &series, 1).rank;
    assert_agrees(Exp::Num(Frac::int(150)), rank, "rank");
    // The mean includes bar t: (1000 + 3000) / 2 = 2000; a lagged mean (1000) would give 175.
    assert_ne!(rank, Value::Num(Ratio::from_i64(175)));
}

#[test]
fn comparisons_are_exact_at_the_boundary() {
    let series = closes_to_series(&[3000]);
    let outcome = |name: &str, constant: &str| -> Value {
        Probe::new(bin(name, close(), cst(constant, "PRICE"))).at(&series, 0)
    };
    for (name, below, equal, above) in [
        ("gt", true, false, false),
        ("gte", true, true, false),
        ("lt", false, false, true),
        ("lte", false, true, true),
    ] {
        // `close` is 30.00 here: constant 29.99 is below it, 30 equal, 30.01 above.
        assert_eq!(outcome(name, "29.99"), Value::Flag(below), "{name} 29.99");
        assert_eq!(outcome(name, "30"), Value::Flag(equal), "{name} 30");
        assert_eq!(outcome(name, "30.00"), Value::Flag(equal), "{name} 30.00");
        assert_eq!(outcome(name, "30.01"), Value::Flag(above), "{name} 30.01");
    }
}

#[test]
fn boolean_operators_propagate_missing_values() {
    let series = closes_to_series(&[1000, 1000, 1000]);
    let missing_history = || bin("gt", lag(close(), 5), cst("0", "PRICE"));
    let t = || bin("gt", close(), cst("0", "PRICE"));
    let f = || bin("lt", close(), cst("0", "PRICE"));

    let flag = |expr: serde_json::Value| -> Value {
        let strategy = Def::new().condition(expr).validated();
        signals(&strategy, &series, 2).condition
    };
    let missing = Value::Missing(MissingReason::InsufficientHistory);
    // A missing input makes the result missing even when another input already decides it.
    assert_eq!(flag(and(vec![t(), missing_history()])), missing);
    assert_eq!(flag(and(vec![f(), missing_history()])), missing);
    assert_eq!(flag(or(vec![t(), missing_history()])), missing);
    assert_eq!(flag(or(vec![f(), missing_history()])), missing);
    assert_eq!(flag(and(vec![missing_history(), t()])), missing);
    // Without missing inputs the usual truth tables hold, for up to eight operands.
    assert_eq!(flag(and(vec![t(), t()])), Value::Flag(true));
    assert_eq!(flag(and(vec![t(), f()])), Value::Flag(false));
    assert_eq!(flag(or(vec![f(), f()])), Value::Flag(false));
    assert_eq!(flag(or(vec![f(), t()])), Value::Flag(true));
    assert_eq!(flag(and((0..8).map(|_| t()).collect())), Value::Flag(true));
    let mut one_false: Vec<_> = (0..7).map(|_| t()).collect();
    one_false.push(f());
    assert_eq!(flag(and(one_false.clone())), Value::Flag(false));
    assert_eq!(flag(or(one_false)), Value::Flag(true));
    assert_eq!(flag(or((0..8).map(|_| f()).collect())), Value::Flag(false));
}

#[test]
fn the_first_missing_operand_in_argument_order_names_the_reason() {
    // The flat window gives UNDEFINED_FLAT; the lag at the start gives INSUFFICIENT_HISTORY.
    let flat = closes_to_series(&[1000; 20]);
    let flat_rsi = || bin("lte", rsi(close(), 14), cst("30", "POINTS"));
    let short_lag = || bin("gt", lag(close(), 30), cst("0", "PRICE"));
    let flag = |expr: serde_json::Value| -> Value {
        let strategy = Def::new().condition(expr).validated();
        signals(&strategy, &flat, 19).condition
    };
    assert_eq!(
        flag(and(vec![flat_rsi(), short_lag()])),
        Value::Missing(MissingReason::UndefinedFlat)
    );
    assert_eq!(
        flag(and(vec![short_lag(), flat_rsi()])),
        Value::Missing(MissingReason::InsufficientHistory)
    );
    // Inside one comparison the left operand is reported first.
    let both = |left: serde_json::Value, right: serde_json::Value| flag(bin("lte", left, right));
    assert_eq!(
        both(rsi(close(), 14), lag(rsi(close(), 14), 30)),
        Value::Missing(MissingReason::UndefinedFlat)
    );
    assert_eq!(
        both(lag(rsi(close(), 14), 30), rsi(close(), 14)),
        Value::Missing(MissingReason::InsufficientHistory)
    );
}

// ---------------------------------------------------------------------------------------------
// The seed indicators together
// ---------------------------------------------------------------------------------------------

/// Hand-derived from the window definitions: the first index where each seed value exists.
const FIRST_VALID: [(&str, usize); 8] = [
    ("sma50", 49),     // 50 closes: indexes 0..=49
    ("vol_sma20", 19), // 20 volumes: indexes 0..=19
    ("rsi14", 14),     // 15 closes: indexes 0..=14
    ("atr14", 14),     // 15 bars: indexes 0..=14
    ("rsi_lag1", 15),  // RSI[t-1] needs 15 closes ending at t-1
    ("rsi_lag2", 16),  // RSI[t-2] needs 17 closes ending at t
    ("rsi_floor", 0),  // constants have no warm-up
    ("weak_threshold", 0),
];

#[test]
fn seed_warm_up_first_valid_indexes() {
    let strategy = openquant_core::validate_strategy(&seed(SEEDS[0])).unwrap();
    let bars = random_bars(99, 120);
    let series = series_of(&bars);
    for t in 0..bars.len() {
        let eval = signals(&strategy, &series, t);
        for (name, first) in FIRST_VALID {
            let value = indicator(&eval, name);
            if t < first {
                assert_eq!(
                    value,
                    Value::Missing(MissingReason::InsufficientHistory),
                    "{name} t={t}"
                );
            } else {
                assert!(matches!(value, Value::Num(_)), "{name} t={t}: {value:?}");
            }
        }
    }
    // The entry condition needs every referenced value: the first decision is at index 49.
    // The rank needs only the volume mean and RSI (index 19); the entry ATR snapshot index 14.
    let first_defined = |pick: &dyn Fn(&openquant_core::signals::SignalEval) -> Value| {
        (0..bars.len())
            .find(|t| !matches!(pick(&signals(&strategy, &series, *t)), Value::Missing(_)))
    };
    assert_eq!(first_defined(&|s| s.condition), Some(49));
    assert_eq!(first_defined(&|s| s.rank), Some(19));
    assert_eq!(first_defined(&|s| snapshot_value(s, "entry_atr")), Some(14));
}

#[test]
fn seed_indicators_rank_and_snapshot_match_the_reference_on_a_long_series() {
    let strategy = openquant_core::validate_strategy(&seed(SEEDS[0])).unwrap();
    let bars = random_bars(20_260_101, 1500);
    let reference: Vec<Option<Bar>> = bars.iter().copied().map(Some).collect();
    let series = series_of(&bars);
    for (t, bar) in bars.iter().enumerate() {
        let eval = signals(&strategy, &series, t);
        assert_agrees(
            reference::sma_close(&reference, t, 50),
            indicator(&eval, "sma50"),
            &format!("sma50 t={t}"),
        );
        assert_agrees(
            reference::sma_volume(&reference, t, 20),
            indicator(&eval, "vol_sma20"),
            &format!("vol_sma20 t={t}"),
        );
        assert_agrees(
            reference::rsi(&reference, t, 14),
            indicator(&eval, "rsi14"),
            &format!("rsi14 t={t}"),
        );
        assert_agrees(
            reference::atr(&reference, t, 14),
            indicator(&eval, "atr14"),
            &format!("atr14 t={t}"),
        );
        assert_agrees(
            reference::rsi_lagged(&reference, t, 14, 1),
            indicator(&eval, "rsi_lag1"),
            &format!("rsi_lag1 t={t}"),
        );
        assert_agrees(
            reference::rsi_lagged(&reference, t, 14, 2),
            indicator(&eval, "rsi_lag2"),
            &format!("rsi_lag2 t={t}"),
        );
        assert_agrees(
            reference::atr(&reference, t, 14),
            snapshot_value(&eval, "entry_atr"),
            &format!("entry_atr t={t}"),
        );
        // rank = 50 * volume / volume_SMA20 + (100 - RSI14)
        let expected_rank = match (
            reference::sma_volume(&reference, t, 20),
            reference::rsi(&reference, t, 14),
        ) {
            (Exp::Num(mean), Exp::Num(rsi)) => {
                let volume = Frac::int(i128::from(bar.v));
                Exp::Num(
                    Frac::int(50)
                        .mul(volume.div(mean))
                        .add(Frac::int(100).sub(rsi)),
                )
            }
            (Exp::Missing(reason), _) | (_, Exp::Missing(reason)) => Exp::Missing(reason),
            _ => unreachable!(),
        };
        // The first missing operand in argument order names the reason: the volume mean comes
        // first in the rank expression, then RSI.
        assert_agrees(expected_rank, eval.rank, &format!("rank t={t}"));
    }
}

#[test]
fn seed_with_zero_volume_has_an_undefined_rank_and_a_false_entry() {
    let strategy = openquant_core::validate_strategy(&seed(SEEDS[0])).unwrap();
    let bars: Vec<Bar> = random_bars(41, 70)
        .into_iter()
        .map(|b| Bar { v: 0, ..b })
        .collect();
    let series = series_of(&bars);
    let eval = signals(&strategy, &series, 69);
    assert_eq!(eval.rank, Value::Missing(MissingReason::DivByZero));
    // volume (0) is not greater than its mean (0): the entry condition is false, not missing.
    assert_eq!(eval.condition, Value::Flag(false));
}

#[test]
fn seed_on_flat_prices_has_undefined_rsi_and_a_zero_atr() {
    let strategy = openquant_core::validate_strategy(&seed(SEEDS[0])).unwrap();
    let series = closes_to_series(&[10_000; 70]);
    let eval = signals(&strategy, &series, 69);
    assert_eq!(
        indicator(&eval, "rsi14"),
        Value::Missing(MissingReason::UndefinedFlat)
    );
    assert_eq!(indicator(&eval, "atr14"), Value::Num(Ratio::ZERO));
    assert_eq!(snapshot_value(&eval, "entry_atr"), Value::Num(Ratio::ZERO));
    // close > SMA50 is false (equal), but the lagged RSI is undefined, so the whole condition is
    // unavailable rather than false.
    assert_eq!(eval.condition, Value::Missing(MissingReason::UndefinedFlat));
}

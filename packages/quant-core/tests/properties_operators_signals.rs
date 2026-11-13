//! Property tests for operators and signals (fixed seeds, no persistence files).
//!
//! Each property states a law that must hold for every input of its domain: bounds of means and
//! RSI, invariance under positive scaling and shifting, non-negativity of ATR, truncation
//! invariance of the causal series, consistency of split adjustment, algebra of the typed
//! arithmetic, and totality of validation and evaluation on random expression trees.
//!
//! Randomness is proptest with a ChaCha generator seeded from a constant per property, so a run
//! is reproducible and writes no `proptest-regressions` file.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

mod operators_support;

use std::collections::BTreeMap;

use openquant_contracts::StrategyArtefact;
use openquant_core::{
    model::{FailureCode, MissingReason, Unit},
    numeric::{Decimal, Ratio},
    operators::{PriceBar, Value},
    signals::{AppliedSplit, LevelEnv, build_series, eval_position_expr, evaluate_signals},
    validate_strategy,
};
use operators_support::*;
use proptest::{
    prelude::*,
    test_runner::{Config, RngAlgorithm, TestCaseError, TestRng, TestRunner},
};
use serde_json::{Value as Json, json};

/// A runner whose generator is seeded from `tag`, with `cases` cases and no failure persistence.
fn runner(tag: u8, cases: u32) -> TestRunner {
    let mut seed = [0_u8; 32];
    seed[0] = tag;
    seed[31] = 0x5a;
    let config = Config {
        cases,
        failure_persistence: None,
        max_shrink_iters: 256,
        ..Config::default()
    };
    TestRunner::new_with_rng(config, TestRng::from_seed(RngAlgorithm::ChaCha, &seed))
}

fn check<S: Strategy>(
    tag: u8,
    cases: u32,
    strategy: S,
    test: impl Fn(S::Value) -> Result<(), TestCaseError>,
) where
    S::Value: std::fmt::Debug,
{
    if let Err(error) = runner(tag, cases).run(&strategy, test) {
        panic!("{error}");
    }
}

// ---------------------------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------------------------

/// Consistent bars from random moves: gaps, trends, wicks and volumes, with flat stretches and
/// zero volumes mixed in so that degenerate windows occur.
fn bars(len: std::ops::RangeInclusive<usize>) -> impl Strategy<Value = Vec<Bar>> {
    let step = (
        -150_i64..=150,
        prop_oneof![3 => Just(0_i64), 7 => -400_i64..=400],
        prop_oneof![3 => Just(0_i64), 7 => 0_i64..=200],
        prop_oneof![3 => Just(0_i64), 7 => 0_i64..=200],
        prop_oneof![1 => Just(0_i64), 9 => 1_i64..=5_000],
    );
    prop::collection::vec(step, len).prop_map(|steps| {
        let mut previous = 10_000_i64;
        steps
            .into_iter()
            .map(|(gap, change, up, down, volume)| {
                let open = (previous + gap).max(100);
                let close = (open + change).max(100);
                let high = open.max(close) + up;
                let low = (open.min(close) - down).max(1);
                previous = close;
                Bar::new(open, high, low, close, volume)
            })
            .collect()
    })
}

fn some(bars: &[Bar]) -> Vec<Option<Bar>> {
    bars.iter().copied().map(Some).collect()
}

fn engine_series(bars: &[Option<Bar>]) -> Vec<Option<PriceBar>> {
    bars.iter().map(|b| b.map(Bar::price_bar)).collect()
}

// ---------------------------------------------------------------------------------------------
// Simple means
// ---------------------------------------------------------------------------------------------

#[test]
fn the_simple_mean_lies_between_the_minimum_and_maximum_of_its_window() {
    check(1, 200, (bars(1..=60), 1_u64..=25), |(bars, window)| {
        let series = engine_series(&some(&bars));
        let probe_close = Probe::new(sma(close(), window));
        let probe_volume = Probe::new(sma(volume(), window));
        let w = window as usize;
        for t in 0..bars.len() {
            let (mean, vmean) = (probe_close.at(&series, t), probe_volume.at(&series, t));
            if t + 1 < w {
                prop_assert_eq!(mean, Value::Missing(MissingReason::InsufficientHistory));
                prop_assert_eq!(vmean, Value::Missing(MissingReason::InsufficientHistory));
                continue;
            }
            let slice = &bars[t + 1 - w..=t];
            let (lo, hi) = (
                slice.iter().map(|b| b.c).min().unwrap(),
                slice.iter().map(|b| b.c).max().unwrap(),
            );
            let Value::Num(mean) = mean else {
                return Err(TestCaseError::fail("a full window must give a mean"));
            };
            prop_assert!(
                Ratio::from(Decimal::new(lo, 2)) <= mean
                    && mean <= Ratio::from(Decimal::new(hi, 2))
            );
            let (vlo, vhi) = (
                slice.iter().map(|b| b.v).min().unwrap(),
                slice.iter().map(|b| b.v).max().unwrap(),
            );
            let Value::Num(vmean) = vmean else {
                return Err(TestCaseError::fail("a full window must give a volume mean"));
            };
            prop_assert!(Ratio::from_i64(vlo) <= vmean && vmean <= Ratio::from_i64(vhi));
        }
        Ok(())
    });
}

#[test]
fn the_simple_mean_equals_the_exact_fraction() {
    check(2, 150, (bars(1..=40), 1_u64..=20), |(bars, window)| {
        let reference = some(&bars);
        let series = engine_series(&reference);
        let probe = Probe::new(sma(close(), window));
        for t in 0..bars.len() {
            let want = reference::sma_close(&reference, t, window as usize);
            prop_assert!(want.agrees(probe.at(&series, t)), "t={t}");
        }
        Ok(())
    });
}

// ---------------------------------------------------------------------------------------------
// RSI
// ---------------------------------------------------------------------------------------------

#[test]
fn rsi_is_within_0_and_100_matches_the_reference_and_is_undefined_only_when_flat() {
    check(3, 200, (bars(1..=70), 1_u64..=20), |(bars, window)| {
        let reference = some(&bars);
        let series = engine_series(&reference);
        let probe = Probe::new(rsi(close(), window));
        let w = window as usize;
        for t in 0..bars.len() {
            let value = probe.at(&series, t);
            let want = reference::rsi(&reference, t, w);
            prop_assert!(want.agrees(value), "t={t}: {want:?} vs {value:?}");
            if let Value::Num(rsi) = value {
                prop_assert!(Ratio::ZERO <= rsi && rsi <= Ratio::from_i64(100), "{rsi}");
            }
            if t >= w {
                let closes: Vec<i64> = bars[t - w..=t].iter().map(|b| b.c).collect();
                let flat = closes.windows(2).all(|p| p[0] == p[1]);
                prop_assert_eq!(
                    matches!(value, Value::Missing(MissingReason::UndefinedFlat)),
                    flat
                );
                let gains = closes.windows(2).any(|p| p[1] > p[0]);
                let losses = closes.windows(2).any(|p| p[1] < p[0]);
                if gains && !losses {
                    prop_assert_eq!(value, Value::Num(Ratio::from_i64(100)));
                }
                if losses && !gains {
                    prop_assert_eq!(value, Value::Num(Ratio::ZERO));
                }
            }
        }
        Ok(())
    });
}

#[test]
fn rsi_is_invariant_under_positive_scaling_and_adding_a_constant() {
    check(
        4,
        150,
        (bars(15..=60), 2_i64..=40, 0_i64..=9_000),
        |(bars, factor, shift)| {
            let scaled: Vec<Bar> = bars
                .iter()
                .map(|b| Bar::new(b.o * factor, b.h * factor, b.l * factor, b.c * factor, b.v))
                .collect();
            let shifted: Vec<Bar> = bars
                .iter()
                .map(|b| Bar::new(b.o + shift, b.h + shift, b.l + shift, b.c + shift, b.v))
                .collect();
            let probe = Probe::new(rsi(close(), 14));
            let base = engine_series(&some(&bars));
            let big = engine_series(&some(&scaled));
            let moved = engine_series(&some(&shifted));
            for t in 0..bars.len() {
                let original = probe.at(&base, t);
                for other in [probe.at(&big, t), probe.at(&moved, t)] {
                    match (original, other) {
                        (Value::Num(a), Value::Num(b)) => {
                            // The values are exact, so they are equal, not merely close.
                            prop_assert_eq!(a, b, "t={}", t);
                        }
                        (a, b) => prop_assert_eq!(a, b),
                    }
                }
            }
            Ok(())
        },
    );
}

#[test]
fn rsi_gains_and_losses_are_symmetric_under_price_inversion_of_the_changes() {
    // Mirroring every change around the first close swaps gains and losses: RSI' = 100 - RSI.
    check(5, 150, bars(15..=50), |bars| {
        let first = bars[0].c;
        let mirrored: Vec<Bar> = bars
            .iter()
            .map(|b| Bar::flat(2 * first + 100_000 - b.c, 1))
            .collect();
        let original: Vec<Bar> = bars.iter().map(|b| Bar::flat(b.c, 1)).collect();
        let probe = Probe::new(rsi(close(), 14));
        let (a, b) = (
            engine_series(&some(&original)),
            engine_series(&some(&mirrored)),
        );
        for t in 0..bars.len() {
            match (probe.at(&a, t), probe.at(&b, t)) {
                (Value::Num(x), Value::Num(y)) => {
                    prop_assert_eq!(x.add(y).unwrap(), Ratio::from_i64(100), "t={}", t);
                }
                (x, y) => prop_assert_eq!(x, y),
            }
        }
        Ok(())
    });
}

// ---------------------------------------------------------------------------------------------
// ATR
// ---------------------------------------------------------------------------------------------

#[test]
fn atr_is_non_negative_matches_the_reference_and_bounds_the_mean_range() {
    check(6, 200, (bars(1..=60), 1_u64..=20), |(bars, window)| {
        let reference = some(&bars);
        let series = engine_series(&reference);
        let probe = Probe::new(atr(window));
        let w = window as usize;
        for t in 0..bars.len() {
            let value = probe.at(&series, t);
            prop_assert!(reference::atr(&reference, t, w).agrees(value), "t={t}");
            if let Value::Num(atr) = value {
                prop_assert!(atr >= Ratio::ZERO, "{atr}");
                let range_sum: i64 = bars[t + 1 - w..=t].iter().map(|b| b.h - b.l).sum();
                // ATR * w * 100 is the sum of true ranges in ticks; each is at least high - low.
                let ticks = atr.mul(Ratio::from_u64(window * 100)).unwrap();
                prop_assert!(ticks >= Ratio::from_i64(range_sum));
            }
        }
        Ok(())
    });
}

// ---------------------------------------------------------------------------------------------
// Causality
// ---------------------------------------------------------------------------------------------

#[test]
fn changing_anything_after_the_decision_never_changes_signals_up_to_it() {
    // The causal series for decision t is built from bars up to t and splits effective by t.
    // Replace every later bar by garbage, remove some, give others absurd availability: signals
    // for every decision up to t stay identical, and splits effective after t are ignored.
    let strategy = validate_strategy(&seed(SEEDS[0])).unwrap();
    check(
        7,
        120,
        (
            bars(60..=110),
            prop::collection::vec(any::<u8>(), 0..3),
            0_usize..50,
            2_u64..=5,
        ),
        |(bars, split_marks, cut_seed, ratio)| {
            let len = bars.len();
            let t = 55 + cut_seed % (len - 55);
            let original = some(&bars);
            // Later bars: absent, wildly different, or late.
            let mut mutated = original.clone();
            let mut late = BTreeMap::new();
            for (offset, slot) in mutated.iter_mut().enumerate().skip(t + 1) {
                match offset % 3 {
                    0 => *slot = None,
                    1 => *slot = Some(Bar::new(1, 900_000, 1, 450_000, 7)),
                    _ => {
                        late.insert(offset, "2099-01-01T00:00:00Z");
                    }
                }
            }
            // Applied splits: those effective by t are used; some effective after t are listed too.
            let mut splits: Vec<AppliedSplit> = Vec::new();
            for mark in &split_marks {
                let effective = 5 + usize::from(*mark) % (len - 5);
                splits.push(AppliedSplit {
                    effective_index: effective,
                    new: ratio,
                    old: 1,
                });
            }
            let by_t: Vec<AppliedSplit> = splits
                .iter()
                .copied()
                .filter(|s| s.effective_index <= t)
                .collect();
            let deadline = format!("{}T14:30:00Z", date_of(t + 1));
            // Raw bars here are arbitrary; no consistency with the splits is needed.
            let base_input = run_input(&original, &BTreeMap::new());
            let mutated_input = run_input(&mutated, &late);
            for decision in 40..=t {
                let baseline = build_series(&base_input, decision, &by_t, Some(&deadline)).unwrap();
                let after =
                    build_series(&mutated_input, decision, &splits, Some(&deadline)).unwrap();
                prop_assert_eq!(&baseline, &after, "decision {}", decision);
                let a = evaluate_signals(&strategy, &baseline).unwrap();
                let b = evaluate_signals(&strategy, &after).unwrap();
                prop_assert_eq!(a.condition, b.condition);
                prop_assert_eq!(a.rank, b.rank);
                prop_assert_eq!(a.indicators, b.indicators);
                prop_assert_eq!(a.snapshots, b.snapshots);
            }
            Ok(())
        },
    );
}

#[test]
fn a_bar_that_becomes_available_after_the_next_open_is_future_data() {
    check(8, 60, (bars(20..=40), 0_usize..40), |(bars, which)| {
        let t = 10 + which % (bars.len() - 10);
        let mut late = BTreeMap::new();
        let pick = t - which % 5; // a bar inside the series
        late.insert(pick, "2026-12-31T00:00:00Z");
        let input = run_input(&some(&bars), &late);
        let deadline = format!("{}T14:30:00Z", date_of(t + 1));
        let result = build_series(&input, t, &[], Some(&deadline));
        let failure = result.unwrap_err();
        prop_assert_eq!(failure.code, FailureCode::FutureData);
        // Without that bar in the window of interest (decision before it) nothing fails.
        if pick > 0 {
            prop_assert!(build_series(&input, pick - 1, &[], Some(&deadline)).is_ok());
        }
        Ok(())
    });
}

// ---------------------------------------------------------------------------------------------
// Split adjustment
// ---------------------------------------------------------------------------------------------

#[test]
fn signals_on_the_adjusted_series_equal_signals_on_the_never_split_series() {
    // The underlying series `truth` never split. Its raw record shows prices multiplied by the
    // product of the later splits' ratios and volume divided by it. After adjustment with the
    // splits applied by the decision, every indicator equals the one on `truth`.
    check(
        9,
        120,
        (
            bars(40..=80),
            2_i64..=9,
            1_usize..30,
            prop::option::of((2_i64..=9, 1_usize..30)),
        ),
        |(bars, k1, gap1, second)| {
            let len = bars.len();
            let s1 = 5 + gap1 % (len - 6);
            let mut splits = vec![(s1, k1)];
            if let Some((k2, gap2)) = second {
                splits.push((5 + gap2 % (len - 6), k2));
            }
            // Same-session duplicates would be one action; keep distinct effective sessions.
            splits.sort_unstable();
            splits.dedup_by_key(|s| s.0);
            let total: i64 = splits.iter().map(|s| s.1).product();
            // Truth volume is a multiple of the total so that raw volumes stay integral.
            let truth: Vec<Bar> = bars
                .iter()
                .map(|b| Bar {
                    v: b.v * total,
                    ..*b
                })
                .collect();
            let factor = |index: usize| -> i64 {
                splits.iter().filter(|s| s.0 > index).map(|s| s.1).product()
            };
            let raw: Vec<Option<Bar>> = truth
                .iter()
                .enumerate()
                .map(|(i, b)| {
                    let f = factor(i);
                    Some(Bar::new(b.o * f, b.h * f, b.l * f, b.c * f, b.v / f))
                })
                .collect();
            let applied: Vec<AppliedSplit> = splits
                .iter()
                .map(|s| AppliedSplit {
                    effective_index: s.0,
                    new: s.1 as u64,
                    old: 1,
                })
                .collect();
            let decision = len - 1;
            let input = run_input(&raw, &BTreeMap::new());
            let adjusted = build_series(&input, decision, &applied, None).unwrap();
            // The adjusted series is exactly the never-split one.
            let reference = some(&truth);
            let expected = engine_series(&reference);
            prop_assert_eq!(&adjusted, &expected);

            // And so are the indicators computed from it.
            let strategy = Def::new()
                .indicator("rsi", rsi(close(), 14))
                .indicator("mean", sma(close(), 10))
                .indicator("vmean", sma(volume(), 5))
                .indicator("atr", atr(14))
                .validated();
            let got = evaluate_signals(&strategy, &adjusted).unwrap();
            let want = evaluate_signals(&strategy, &expected).unwrap();
            prop_assert_eq!(&got.indicators, &want.indicators);
            // ... and agree with the independent reference on the never-split bars.
            let t = decision;
            prop_assert!(reference::rsi(&reference, t, 14).agrees(indicator(&got, "rsi")));
            prop_assert!(reference::sma_close(&reference, t, 10).agrees(indicator(&got, "mean")));
            prop_assert!(reference::atr(&reference, t, 14).agrees(indicator(&got, "atr")));
            Ok(())
        },
    );
}

// ---------------------------------------------------------------------------------------------
// Typed arithmetic and comparisons
// ---------------------------------------------------------------------------------------------

fn price_ticks() -> impl Strategy<Value = i64> {
    prop_oneof![1 => Just(0_i64), 1 => Just(1_i64), 8 => 1_i64..=2_000_000]
}

#[test]
fn comparisons_and_arithmetic_obey_their_laws_on_exact_values() {
    check(
        10,
        300,
        (price_ticks(), price_ticks(), 1_i64..=500),
        |(a, b, k)| {
            let series = series_of(&[Bar::flat(a.max(1), 10), Bar::flat(b.max(1), 20)]);
            let (a, b) = (a.max(1), b.max(1));
            let flag = |name: &str| -> Value {
                Probe::new(bin(name, lag(close(), 1), close())).at(&series, 1)
            };
            prop_assert_eq!(flag("gt"), Value::Flag(a > b));
            prop_assert_eq!(flag("gte"), Value::Flag(a >= b));
            prop_assert_eq!(flag("lt"), Value::Flag(a < b));
            prop_assert_eq!(flag("lte"), Value::Flag(a <= b));
            let num = |name: &str, right: Json| -> Value {
                Probe::new(bin(name, lag(close(), 1), right)).at(&series, 1)
            };
            prop_assert!(Exp::Num(Frac::ticks(i128::from(a + b))).agrees(num("add", close())));
            prop_assert!(Exp::Num(Frac::ticks(i128::from(a - b))).agrees(num("sub", close())));
            // Division of equal units is a ratio; by zero it is an explicit missing value.
            let ratio = num("div", close());
            prop_assert!(Exp::Num(Frac::new(i128::from(a), i128::from(b))).agrees(ratio));
            let by_zero =
                Probe::new(bin("div", close(), bin("sub", close(), close()))).at(&series, 1);
            prop_assert_eq!(by_zero, Value::Missing(MissingReason::DivByZero));
            // A RATIO factor scales a price exactly.
            let factor = format!("{}.{:02}", k / 100, k % 100);
            let scaled = Probe::new(bin("mul", close(), cst(&factor, "RATIO"))).at(&series, 1);
            prop_assert!(Exp::Num(Frac::new(i128::from(b) * i128::from(k), 10_000)).agrees(scaled));
            Ok(())
        },
    );
}

// ---------------------------------------------------------------------------------------------
// Totality on random expression trees
// ---------------------------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Ty {
    Price,
    Shares,
    Ratio,
    Points,
    Flag,
}

/// Reads a vector of random numbers as the choices of a tree generator, cyclically.
struct Tape<'a> {
    data: &'a [u16],
    position: usize,
    /// Nodes the generator may still create. The tape repeats, so without a budget a periodic
    /// tape could ask for an endless tree.
    budget: usize,
}

impl Tape<'_> {
    fn pick(&mut self, modulo: u16) -> u16 {
        if self.data.is_empty() {
            return 0;
        }
        let value = self.data[self.position % self.data.len()];
        self.position += 1;
        value % modulo
    }

    fn window(&mut self) -> u64 {
        // Mostly small; sometimes beyond the limits.
        match self.pick(12) {
            0 => 253 + u64::from(self.pick(400)),
            1 => 252,
            _ => 1 + u64::from(self.pick(25)),
        }
    }

    fn periods(&mut self) -> u64 {
        match self.pick(12) {
            0 => 61 + u64::from(self.pick(300)),
            1 => 60,
            _ => 1 + u64::from(self.pick(8)),
        }
    }
}

const CONSTANTS: [&str; 9] = [
    "0",
    "1",
    "-1",
    "0.5",
    "2.25",
    "100",
    "99999999",
    "-0.000001",
    "1000000000000",
];

fn leaf(tape: &mut Tape<'_>, ty: Ty) -> Json {
    let constant = |tape: &mut Tape<'_>, unit: &str| {
        cst(
            CONSTANTS[usize::from(tape.pick(CONSTANTS.len() as u16))],
            unit,
        )
    };
    match ty {
        Ty::Price => {
            if tape.pick(2) == 0 {
                field(["OPEN", "HIGH", "LOW", "CLOSE"][usize::from(tape.pick(4))])
            } else {
                constant(tape, "PRICE")
            }
        }
        Ty::Shares => {
            if tape.pick(2) == 0 {
                volume()
            } else {
                constant(tape, "SHARES")
            }
        }
        Ty::Ratio => constant(tape, "RATIO"),
        Ty::Points => constant(tape, "POINTS"),
        Ty::Flag => bin("gt", constant(tape, "POINTS"), constant(tape, "POINTS")),
    }
}

fn unit_of(choice: u16) -> Ty {
    [Ty::Price, Ty::Shares, Ty::Ratio, Ty::Points][usize::from(choice % 4)]
}

/// A random expression of the requested type; one node in 25 ignores the type (an invalid tree).
fn generate(tape: &mut Tape<'_>, ty: Ty, depth: u32) -> Json {
    if tape.budget == 0 {
        return leaf(tape, ty);
    }
    tape.budget -= 1;
    if tape.pick(25) == 0 {
        let names = [
            "add",
            "sub",
            "mul",
            "div",
            "gt",
            "gte",
            "lt",
            "lte",
            "and",
            "or",
            "lag",
            "sma",
            "rsi_simple",
            "atr_simple",
            "ref",
            "entry_price",
            "ema",
            "const",
            "bar_field",
        ];
        let name = names[usize::from(tape.pick(names.len() as u16))];
        let count = usize::from(tape.pick(4));
        let mut args: Vec<Json> = Vec::new();
        for _ in 0..count {
            let unit = unit_of(tape.pick(4));
            args.push(generate(tape, unit, depth.saturating_sub(1)));
        }
        let params = match tape.pick(4) {
            0 => json!({"window": tape.window()}),
            1 => json!({"periods": tape.periods()}),
            2 => json!({"name": if tape.pick(2) == 0 { "a" } else { "x" }}),
            _ => json!({}),
        };
        return op(name, args, params);
    }
    if depth == 0 {
        return leaf(tape, ty);
    }
    let d = depth - 1;
    match ty {
        Ty::Price => match tape.pick(8) {
            0 => leaf(tape, ty),
            1 => bin("add", generate(tape, ty, d), generate(tape, ty, d)),
            2 => bin("sub", generate(tape, ty, d), generate(tape, ty, d)),
            3 => bin("mul", generate(tape, ty, d), generate(tape, Ty::Ratio, d)),
            4 => bin("div", generate(tape, ty, d), generate(tape, Ty::Ratio, d)),
            5 => {
                let w = tape.window();
                sma(generate(tape, ty, d), w)
            }
            6 => {
                let p = tape.periods();
                lag(generate(tape, ty, d), p)
            }
            _ => atr(tape.window()),
        },
        Ty::Shares => match tape.pick(6) {
            0 => leaf(tape, ty),
            1 => bin("add", generate(tape, ty, d), generate(tape, ty, d)),
            2 => bin("sub", generate(tape, ty, d), generate(tape, ty, d)),
            3 => bin("mul", generate(tape, Ty::Ratio, d), generate(tape, ty, d)),
            4 => {
                let w = tape.window();
                sma(generate(tape, ty, d), w)
            }
            _ => {
                let p = tape.periods();
                lag(generate(tape, ty, d), p)
            }
        },
        Ty::Ratio => match tape.pick(5) {
            0 => leaf(tape, ty),
            1 => bin(
                "div",
                generate(tape, Ty::Price, d),
                generate(tape, Ty::Price, d),
            ),
            2 => bin(
                "div",
                generate(tape, Ty::Shares, d),
                generate(tape, Ty::Shares, d),
            ),
            3 => bin("mul", generate(tape, ty, d), generate(tape, ty, d)),
            _ => bin("div", generate(tape, ty, d), generate(tape, ty, d)),
        },
        Ty::Points => match tape.pick(5) {
            0 => leaf(tape, ty),
            1 => {
                let w = tape.window();
                rsi(generate(tape, Ty::Price, d), w)
            }
            2 => bin("add", generate(tape, ty, d), generate(tape, ty, d)),
            3 => bin("sub", generate(tape, ty, d), generate(tape, ty, d)),
            _ => bin("mul", generate(tape, ty, d), generate(tape, Ty::Ratio, d)),
        },
        Ty::Flag => match tape.pick(4) {
            0 | 1 => {
                let unit = unit_of(tape.pick(4));
                let name = ["gt", "gte", "lt", "lte"][usize::from(tape.pick(4))];
                bin(name, generate(tape, unit, d), generate(tape, unit, d))
            }
            2 => {
                let n = 2 + usize::from(tape.pick(3));
                and((0..n).map(|_| generate(tape, Ty::Flag, d)).collect())
            }
            _ => {
                let n = 2 + usize::from(tape.pick(3));
                or((0..n).map(|_| generate(tape, Ty::Flag, d)).collect())
            }
        },
    }
}

/// Failure codes that validation of a generated tree may legitimately produce.
fn is_validation_code(code: FailureCode) -> bool {
    matches!(
        code,
        FailureCode::UnsupportedOperator
            | FailureCode::OperatorTypeMismatch
            | FailureCode::OperatorUnitMismatch
            | FailureCode::InvalidParameter
            | FailureCode::InvalidDecimal
    )
}

#[test]
fn validation_and_evaluation_are_total_on_random_trees() {
    let counter = std::cell::RefCell::new((0_u32, 0_u32));
    check(
        11,
        600,
        (
            prop::collection::vec(any::<u16>(), 1..300),
            0_u16..5,
            2_u32..6,
            bars(1..=50),
            prop::collection::vec(any::<bool>(), 50),
        ),
        |(tape, want, depth, bars, holes)| {
            let ty = [Ty::Price, Ty::Shares, Ty::Ratio, Ty::Points, Ty::Flag][usize::from(want)];
            let mut reader = Tape {
                data: &tape,
                position: 0,
                budget: 160,
            };
            let expr = generate(&mut reader, ty, depth);
            let def = Def::new().indicator("a", close()).indicator("x", expr);
            // The typed binding may refuse the tree (e.g. a pattern); that is not under test.
            let Ok(artefact) = serde_json::from_value::<StrategyArtefact>(def.json()) else {
                return Ok(());
            };
            match validate_strategy(&artefact) {
                Err(failure) => {
                    prop_assert!(is_validation_code(failure.code), "{failure}");
                    counter.borrow_mut().1 += 1;
                }
                Ok(strategy) => {
                    counter.borrow_mut().0 += 1;
                    let series: Vec<Option<PriceBar>> = bars
                        .iter()
                        .zip(&holes)
                        .map(|(b, hole)| {
                            if *hole && b.v % 7 == 0 {
                                None
                            } else {
                                Some(b.price_bar())
                            }
                        })
                        .collect();
                    for t in 0..series.len() {
                        match evaluate_signals(&strategy, &series[..=t]) {
                            Ok(eval) => {
                                // Static typing: a FLAG indicator evaluates to a flag or missing,
                                // every other unit to a number or missing.
                                let unit = strategy.indicators[1].node.unit;
                                let consistent = match indicator(&eval, "x") {
                                    Value::Flag(_) => unit == Unit::Flag,
                                    Value::Num(_) => unit != Unit::Flag,
                                    Value::Missing(_) => true,
                                };
                                prop_assert!(consistent, "value type disagrees with unit {unit:?}");
                            }
                            // Overflow is the one runtime failure a valid tree may hit.
                            Err(failure) => {
                                prop_assert_eq!(failure.code, FailureCode::ArithmeticOverflow);
                            }
                        }
                    }
                }
            }
            Ok(())
        },
    );
    let (validated, rejected) = *counter.borrow();
    // Not vacuous: the generator produces both valid and invalid trees.
    assert!(
        validated > 100,
        "valid trees: {validated}, rejected: {rejected}"
    );
    assert!(
        rejected > 20,
        "valid trees: {validated}, rejected: {rejected}"
    );
}

#[test]
fn level_and_trigger_expressions_are_total_on_random_inputs() {
    check(
        12,
        300,
        (
            prop::collection::vec(any::<u16>(), 1..80),
            1_i64..=2_000_000,
            0_i64..=500_000,
            1_i64..=2_000_000,
        ),
        |(tape, entry, atr_ticks, high)| {
            let mut reader = Tape {
                data: &tape,
                position: 0,
                budget: 160,
            };
            // entry_price / snapshot / constants with arithmetic only
            fn level(tape: &mut Tape<'_>, depth: u32) -> Json {
                if depth == 0 || tape.pick(4) == 0 {
                    return match tape.pick(3) {
                        0 => entry_price(),
                        1 => snap("s"),
                        _ => cst(CONSTANTS[usize::from(tape.pick(9))], "PRICE"),
                    };
                }
                let ratio = cst(["0", "2", "5", "0.5"][usize::from(tape.pick(4))], "RATIO");
                match tape.pick(4) {
                    0 => bin("add", level(tape, depth - 1), level(tape, depth - 1)),
                    1 => bin("sub", level(tape, depth - 1), level(tape, depth - 1)),
                    2 => bin("mul", ratio, level(tape, depth - 1)),
                    _ => bin("div", level(tape, depth - 1), ratio),
                }
            }
            let stop = level(&mut reader, 4);
            let trigger = bin("gte", field("HIGH"), level(&mut reader, 3));
            let def = Def::new().snapshot("s", close()).stop(stop).adjustment(
                "t",
                trigger,
                level(&mut reader, 3),
            );
            let strategy = def.validated();
            let snapshots = vec![("s".to_owned(), Ratio::from(Decimal::new(atr_ticks, 2)))];
            let bar = Bar::new(high, high, high.min(entry), high, 1).price_bar();
            let env = LevelEnv {
                bar: Some(bar),
                entry_price: Ratio::from(Decimal::new(entry, 2)),
                snapshots: &snapshots,
            };
            for node in [
                &strategy.stop,
                &strategy.adjustments[0].trigger,
                &strategy.adjustments[0].new_level,
            ] {
                match eval_position_expr(node, &env) {
                    Ok(Value::Num(_) | Value::Flag(_) | Value::Missing(_)) => {}
                    Err(failure) => {
                        prop_assert_eq!(failure.code, FailureCode::ArithmeticOverflow);
                    }
                }
            }
            Ok(())
        },
    );
}

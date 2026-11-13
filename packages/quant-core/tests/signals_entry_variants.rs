//! Entry-condition logic of the seed family (OQ-02 section 2.6, OQ-06 section 8 "Entry variants").
//!
//! "RSI 29, 31, 31 satisfies threshold 30 without a crossing at t; 31, 31, 31 satisfies threshold
//! 32 only. The current floor remains 30."
//!
//! These tests replace RSI by the bar close so that the three values are written directly: the
//! rule structure, the inclusive weakness comparison, the strict floor, the lagged inputs and the
//! missing-value behaviour are exercised without needing a price path that produces a given RSI.
//! First with a small hand-written strategy, then with the real artefacts of the five variants
//! whose indicator definitions are swapped for the substitute (the entry condition, the thresholds
//! and the floor stay exactly as published).

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

mod operators_support;

use openquant_core::{
    ValidatedStrategy,
    model::MissingReason,
    operators::{PriceBar, Value},
    signals::evaluate_signals,
    validate_strategy,
};
use operators_support::*;

/// `(RSI[t-2] <= T OR RSI[t-1] <= T) AND RSI[t] > 30`, with the close standing in for RSI.
fn weakness_strategy(threshold: &str) -> ValidatedStrategy {
    Def::new()
        .indicator("x", close())
        .indicator("x1", lag(rf("x"), 1))
        .indicator("x2", lag(rf("x"), 2))
        .condition(and(vec![
            or(vec![
                bin("lte", rf("x2"), cst(threshold, "PRICE")),
                bin("lte", rf("x1"), cst(threshold, "PRICE")),
            ]),
            bin("gt", rf("x"), cst("30", "PRICE")),
        ]))
        .validated()
}

fn three_bars(values: [i64; 3]) -> Vec<Option<PriceBar>> {
    series_of(&flat_series(&values))
}

fn condition(strategy: &ValidatedStrategy, series: &[Option<PriceBar>]) -> Value {
    evaluate_signals(strategy, series).unwrap().condition
}

/// The rule written as plain integer logic, in ticks of 0.01.
fn rule(x2: i64, x1: i64, x0: i64, threshold: i64) -> bool {
    (x2 <= threshold || x1 <= threshold) && x0 > 3000
}

#[test]
fn rsi_29_31_31_satisfies_threshold_30_without_a_crossing_at_t() {
    // The close does not move at t (31 -> 31): there is no upward crossing of anything at t,
    // yet the weakness two sessions ago is enough.
    let series = three_bars([2900, 3100, 3100]);
    assert_eq!(
        condition(&weakness_strategy("30"), &series),
        Value::Flag(true)
    );
    assert_eq!(
        condition(&weakness_strategy("32"), &series),
        Value::Flag(true)
    );
}

#[test]
fn rsi_31_31_31_satisfies_threshold_32_only() {
    let series = three_bars([3100, 3100, 3100]);
    assert_eq!(
        condition(&weakness_strategy("30"), &series),
        Value::Flag(false)
    );
    assert_eq!(
        condition(&weakness_strategy("32"), &series),
        Value::Flag(true)
    );
}

#[test]
fn documented_boundary_cases() {
    // (x2, x1, x0, satisfied at threshold 30, satisfied at threshold 32), prices in ticks.
    let cases: [(i64, i64, i64, bool, bool, &str); 20] = [
        (
            3000,
            3500,
            3500,
            true,
            true,
            "weakness two sessions ago, equal to 30 is inclusive",
        ),
        (
            3001,
            3500,
            3500,
            false,
            true,
            "30.01 is not weak at 30 but is at 32",
        ),
        (
            3200,
            3500,
            3500,
            false,
            true,
            "equal to 32 is inclusive at 32",
        ),
        (3201, 3500, 3500, false, false, "32.01 is weak at neither"),
        (
            3500,
            3000,
            3500,
            true,
            true,
            "weakness one session ago, equal to 30",
        ),
        (3500, 3001, 3500, false, true, "one session ago, 30.01"),
        (
            3500,
            3200,
            3500,
            false,
            true,
            "one session ago, equal to 32",
        ),
        (3500, 3201, 3500, false, false, "one session ago, 32.01"),
        (3500, 3500, 3500, false, false, "no weakness at all"),
        (
            2900,
            3100,
            3000,
            false,
            false,
            "the floor is strict: 30.00 does not exceed 30",
        ),
        (2900, 3100, 3001, true, true, "30.01 exceeds the floor"),
        (2900, 3100, 2999, false, false, "below the floor"),
        (2800, 2900, 3100, true, true, "weak on both lagged sessions"),
        (
            2900,
            3300,
            3100,
            true,
            true,
            "price falls at t: no crossing needed",
        ),
        (2000, 2500, 2800, false, false, "still below the floor at t"),
        (
            3100,
            2900,
            2900,
            false,
            false,
            "weak last session but still below the floor",
        ),
        (
            3150,
            3150,
            3050,
            false,
            true,
            "threshold 32: the floor stays 30, so 30.50 passes it",
        ),
        (
            3150,
            3150,
            3150,
            false,
            true,
            "threshold 32 with a current value above 30",
        ),
        (3100, 3100, 3100, false, true, "the 31, 31, 31 example"),
        (2900, 3100, 3100, true, true, "the 29, 31, 31 example"),
    ];
    let s30 = weakness_strategy("30");
    let s32 = weakness_strategy("32");
    for (x2, x1, x0, at30, at32, why) in cases {
        let series = three_bars([x2, x1, x0]);
        assert_eq!(condition(&s30, &series), Value::Flag(at30), "T=30 {why}");
        assert_eq!(condition(&s32, &series), Value::Flag(at32), "T=32 {why}");
        // The same cases written as plain integer logic agree with the table.
        assert_eq!(rule(x2, x1, x0, 3000), at30, "{why}");
        assert_eq!(rule(x2, x1, x0, 3200), at32, "{why}");
    }
}

#[test]
fn the_rule_holds_over_a_grid_around_every_boundary() {
    let values = [2900, 2999, 3000, 3001, 3100, 3199, 3200, 3201, 3300];
    let s30 = weakness_strategy("30");
    let s32 = weakness_strategy("32");
    let mut satisfied = (0, 0);
    for x2 in values {
        for x1 in values {
            for x0 in values {
                let series = three_bars([x2, x1, x0]);
                let want30 = rule(x2, x1, x0, 3000);
                let want32 = rule(x2, x1, x0, 3200);
                assert_eq!(
                    condition(&s30, &series),
                    Value::Flag(want30),
                    "{x2} {x1} {x0}"
                );
                assert_eq!(
                    condition(&s32, &series),
                    Value::Flag(want32),
                    "{x2} {x1} {x0}"
                );
                satisfied.0 += i32::from(want30);
                satisfied.1 += i32::from(want32);
                // A wider threshold never removes an entry.
                assert!(!want30 || want32);
            }
        }
    }
    // Not vacuous: both outcomes occur, and threshold 32 admits strictly more.
    assert!(
        satisfied.0 > 0 && satisfied.1 > satisfied.0,
        "{satisfied:?}"
    );
}

#[test]
fn a_missing_lagged_value_blocks_entry_even_when_the_other_inputs_would_qualify() {
    let strategy = weakness_strategy("32");
    let missing = Value::Missing(MissingReason::InsufficientHistory);
    // Two sessions only: RSI[t-2] does not exist, although RSI[t-1] = 29 <= 32 and RSI[t] = 31 > 30.
    let short = three_bars([2900, 3100, 3100]);
    assert_eq!(condition(&strategy, &short[1..]), missing);
    assert_eq!(condition(&strategy, &short[2..]), missing);
    // An absent observation at any of the three positions blocks the decision.
    for hole in 0..3 {
        let mut series = three_bars([2900, 2900, 3100]);
        series[hole] = None;
        assert_eq!(condition(&strategy, &series), missing, "hole at {hole}");
    }
    // The positions before t-2 do not matter.
    let mut long = series_of(&flat_series(&[1, 2, 3, 2900, 2900, 3100]));
    long[0] = None;
    assert_eq!(condition(&strategy, &long), Value::Flag(true));
}

#[test]
fn only_the_value_at_t_feeds_the_rank() {
    // The rank takes its inputs from the signal session: 50 * volume / volume mean + (100 - x).
    // With volume 1000 against a mean of 1 share and x = 31: 50 * 1000 + (100 - 31) = 50069,
    // however the two earlier values differ.
    let strategy = Def::new()
        .indicator(
            "x",
            bin(
                "mul",
                cst("1", "POINTS"),
                bin("div", close(), cst("1", "PRICE")),
            ),
        )
        .indicator("vmean", cst("1", "SHARES"))
        .rank(bin(
            "add",
            bin(
                "mul",
                cst("50", "POINTS"),
                bin("div", volume(), rf("vmean")),
            ),
            bin("sub", cst("100", "POINTS"), rf("x")),
        ))
        .validated();
    for earlier in [(2900, 3100), (4000, 4100), (100, 200)] {
        let series = three_bars([earlier.0, earlier.1, 3100]);
        let rank = evaluate_signals(&strategy, &series).unwrap().rank;
        assert_agrees(Exp::Num(Frac::int(50_069)), rank, "rank");
    }
    let series = three_bars([2900, 3100, 3200]);
    let rank = evaluate_signals(&strategy, &series).unwrap().rank;
    assert_agrees(Exp::Num(Frac::int(50_068)), rank, "rank for x = 32");
}

// ---------------------------------------------------------------------------------------------
// The real artefacts
// ---------------------------------------------------------------------------------------------

/// Hand-written from the plan: the threshold of each artefact in `SEEDS` order.
const THRESHOLDS: [i64; 5] = [3000, 3200, 3000, 3200, 4000];

/// A published artefact with `close_stands_for_rsi` applied.
fn substituted(name: &str) -> ValidatedStrategy {
    let mut value = seed_json(name);
    close_stands_for_rsi(&mut value);
    validate_strategy(&serde_json::from_value(value).unwrap()).unwrap()
}

#[test]
fn the_published_artefacts_carry_the_documented_thresholds_and_the_same_floor() {
    for (name, threshold) in SEEDS.iter().zip(THRESHOLDS) {
        let value = seed_json(name);
        let constant = |indicator: &str| -> String {
            value["definition"]["indicators"]
                .as_array()
                .unwrap()
                .iter()
                .find(|i| i["name"] == indicator)
                .unwrap()["expr"]["params"]["value"]
                .as_str()
                .unwrap()
                .to_owned()
        };
        assert_eq!(
            constant("weak_threshold"),
            (threshold / 100).to_string(),
            "{name}"
        );
        assert_eq!(
            constant("rsi_floor"),
            "30",
            "{name}: the floor is 30 in every variant"
        );
    }
}

#[test]
fn the_published_artefacts_follow_the_rule_with_their_own_threshold() {
    let values = [
        2900, 2999, 3000, 3001, 3100, 3199, 3200, 3201, 3399, 3400, 3900, 3999, 4000, 4001,
    ];
    for (name, threshold) in SEEDS.iter().zip(THRESHOLDS) {
        let strategy = substituted(name);
        for x2 in values {
            for x1 in values {
                for x0 in values {
                    let series = three_bars([x2, x1, x0]);
                    assert_eq!(
                        condition(&strategy, &series),
                        Value::Flag(rule(x2, x1, x0, threshold)),
                        "{name}: {x2} {x1} {x0}"
                    );
                }
            }
        }
    }
}

#[test]
fn the_named_examples_hold_for_all_four_variants_and_the_data_only_fifth() {
    let flag = |name: &str, values: [i64; 3]| condition(&substituted(name), &three_bars(values));
    // 29, 31, 31: satisfied at 30 and at 32 (and 40), break-even off or on.
    for name in SEEDS {
        assert_eq!(flag(name, [2900, 3100, 3100]), Value::Flag(true), "{name}");
    }
    // 31, 31, 31: only the threshold-32 variants (and 40).
    let expected = [false, true, false, true, true];
    for (name, want) in SEEDS.iter().zip(expected) {
        assert_eq!(flag(name, [3100, 3100, 3100]), Value::Flag(want), "{name}");
    }
    // 38, 39, 39: only the data-only threshold-40 artefact changes the decision.
    let expected = [false, false, false, false, true];
    for (name, want) in SEEDS.iter().zip(expected) {
        assert_eq!(flag(name, [3800, 3900, 3900]), Value::Flag(want), "{name}");
    }
    // The floor is 30 for everyone: a current value of exactly 30 never qualifies.
    for name in SEEDS {
        assert_eq!(flag(name, [2000, 2500, 3000]), Value::Flag(false), "{name}");
    }
}

#[test]
fn break_even_does_not_change_entry_signals() {
    // Variants 1 and 3 differ only in the stop adjustment, as do 2 and 4.
    for (a, b) in [(0, 2), (1, 3)] {
        let (off, on) = (substituted(SEEDS[a]), substituted(SEEDS[b]));
        for x2 in [2900, 3100, 3300] {
            for x1 in [2900, 3100, 3300] {
                for x0 in [2900, 3050, 3100] {
                    let series = three_bars([x2, x1, x0]);
                    let without = evaluate_signals(&off, &series).unwrap();
                    let with = evaluate_signals(&on, &series).unwrap();
                    assert_eq!(without.condition, with.condition);
                    assert_eq!(without.rank, with.rank);
                    assert_eq!(without.snapshots, with.snapshots);
                }
            }
        }
    }
}

#[test]
fn missing_lagged_values_block_entry_in_every_published_variant() {
    for name in SEEDS {
        let strategy = substituted(name);
        let full = three_bars([2900, 2900, 3100]);
        assert_eq!(condition(&strategy, &full), Value::Flag(true), "{name}");
        for hole in 0..3 {
            let mut series = full.clone();
            series[hole] = None;
            assert!(
                matches!(condition(&strategy, &series), Value::Missing(_)),
                "{name}: hole at {hole}"
            );
        }
        assert!(
            matches!(condition(&strategy, &full[1..]), Value::Missing(_)),
            "{name}"
        );
    }
}

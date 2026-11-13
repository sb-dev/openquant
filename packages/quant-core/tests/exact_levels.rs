//! Exact decisions on price levels (OQ-02 sections 2.2 and 2.5, OQ-06 section 8).
//!
//! A level is an exact fraction: `5 + 3 * (0.67 / 3)` is exactly `5.67`, a high of `5.67` touches
//! it and the sale fills at `5.67`. Every decision on a level (touch, gap, validity, break-even
//! trigger, signal comparison, split conversion) reads the exact value, and the fill price is the
//! exact level floored to the price grid. Each test names the direction of the earlier 28-digit
//! rounding it guards against: a mean rounded below the exact value gives a level one unit below
//! the grid line, a mean rounded above gives a level one unit above it.
//!
//! Every expected number is derived by hand beside its assertion. Nothing is produced by calling
//! the engine. The bars are those of the review that found the defect: five bars at
//! 5 / 5.10 / 4.90 / 5 whose true ranges are 0.20, 0.20 and (high - 4.90) at the signal bar, so
//! ATR over 3 sessions is `(0.40 + high - 4.90) / 3`: `0.67 / 3` for a high of 5.17 and `0.68 / 3`
//! for a high of 5.18. The entry is at the next open, 5.00, for 200 shares (cap 1000.00).

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

mod execution_support;

use execution_support::*;
use openquant_contracts::{canonical_json, to_value};
use openquant_core::{Failure, Run, State, numeric::Ratio};
use serde_json::{Value, json};

/// Sessions 0 to 4: four quiet bars and the signal bar, then `tail` from session 5. The signal
/// bar closes the decision session; session 5 opens at 5.00 and is the entry.
fn atr3(signal_high: &str, tail: Vec<Bar>) -> Scenario {
    let quiet = || quiet_bar("5.00", "5.10", "4.90", "5.00");
    let mut bars = vec![
        quiet(),
        quiet(),
        quiet(),
        quiet(),
        signal_bar("5.00", signal_high, "4.90", "5.05"),
    ];
    bars.extend(tail);
    Scenario::new(bars).atr_window(3)
}

/// The two directions of the old rounding, with the level `entry + 3 * ATR` they give.
/// A high of 5.17 gives ATR 0.67 / 3 (rounded down at 28 digits), 5.18 gives 0.68 / 3 (rounded up).
const DIRECTIONS: [(&str, &str); 2] = [("5.17", "0.67"), ("5.18", "0.68")];

fn plus_three_atr(sum: &str) -> String {
    // entry 5.00 + 3 * (sum / 3) = 5.00 + sum.
    match sum {
        "0.67" => "5.67".to_owned(),
        "0.68" => "5.68".to_owned(),
        other => panic!("no level for {other}"),
    }
}

fn minus_three_atr(sum: &str) -> String {
    // entry 5.00 - 3 * (sum / 3) = 5.00 - sum.
    match sum {
        "0.67" => "4.33".to_owned(),
        "0.68" => "4.32".to_owned(),
        other => panic!("no level for {other}"),
    }
}

#[test]
fn a_target_exactly_on_the_grid_is_touched_by_an_equal_high_and_fills_at_that_level() {
    // Stop 2 * ATR (far below), target 3 * ATR. The bar after the entry reaches exactly the
    // target. 200 shares: 0.67 -> 200 * 5.67 = 1134.00, cash 4000.00 + 1134.00 = 5134.00;
    // 0.68 -> 200 * 5.68 = 1136.00, cash 5136.00. Fees are zero.
    //
    // Rounded below (0.67 / 3 -> 0.2233...3) the old target was 5.6699...99 and filled at 5.66.
    // Rounded above (0.68 / 3 -> 0.2266...67) the old target was 5.6800...01 and a high of
    // exactly 5.68 missed it.
    for (high, sum) in DIRECTIONS {
        let level = plus_three_atr(sum);
        let delta = if sum == "0.67" { "1134.00" } else { "1136.00" };
        let cash = if sum == "0.67" { "5134.00" } else { "5136.00" };
        let out = atr3(
            high,
            vec![
                quiet_bar("5.00", &level, "4.90", "5.30"),
                quiet_bar("5.20", "5.30", "5.10", "5.20"),
            ],
        )
        .multiples("2", "3")
        .evaluate();
        assert_eq!(out.status(), "COMPLETED", "{sum}");
        assert_eq!(out.fills().len(), 2, "{sum}");
        assert_eq!(
            fill_row(&out.fills()[1]),
            format!(
                "{} DURING_SESSION SELL 200@{level} fee=0.00 delta={delta} TARGET",
                date(5)
            ),
            "{sum}"
        );
        assert_dec(&out.trades()[0]["exit_price"], &level);
        assert_eq!(out.trades()[0]["exit_reason"], "TARGET");
        assert_dec(&out.daily_of(5)["cash_available"], cash);
    }
    assert_one_tick_below_a_target_is_not_a_touch();
}

/// The same levels with a high 0.01 lower: 5.66 < 5.67 and 5.67 < 5.68. No exit; the position
/// is still open at the end, and it shows the exact target.
fn assert_one_tick_below_a_target_is_not_a_touch() {
    for (high, sum) in DIRECTIONS {
        let level = plus_three_atr(sum);
        let below = if sum == "0.67" { "5.66" } else { "5.67" };
        let out = atr3(
            high,
            vec![
                quiet_bar("5.00", below, "4.90", "5.30"),
                quiet_bar("5.20", "5.30", "5.10", "5.20"),
            ],
        )
        .multiples("2", "3")
        .evaluate();
        assert_eq!(out.status(), "COMPLETED", "{sum} {level}");
        assert_eq!(out.fills().len(), 1, "{sum}: only the entry");
        assert_eq!(out.trades()[0]["exit_reason"], "OPEN_AT_END", "{sum}");
        assert_dec(&out.daily_of(6)["positions"][0]["target"], &level);
    }
}

#[test]
fn a_stop_exactly_on_the_grid_is_touched_by_an_equal_low_and_fills_at_that_level() {
    // Stop 3 * ATR (4.33 or 4.32), target 20 * ATR (far above). The bar after the entry reaches
    // exactly the stop. 0.67 -> 200 * 4.33 = 866.00, cash 4866.00; 0.68 -> 200 * 4.32 = 864.00,
    // cash 4864.00.
    //
    // Rounded above (0.68 / 3 -> 0.2266...67) the old stop was 4.3199...99: a low of exactly 4.32
    // missed it, and a touch would have filled at 4.31. Rounded below the old stop was one unit
    // above the grid line, so the decision was right by luck and the floor hid the error.
    for (high, sum) in DIRECTIONS {
        let level = minus_three_atr(sum);
        let delta = if sum == "0.67" { "866.00" } else { "864.00" };
        let cash = if sum == "0.67" { "4866.00" } else { "4864.00" };
        let out = atr3(
            high,
            vec![
                quiet_bar("5.00", "5.10", &level, "4.60"),
                quiet_bar("4.70", "4.80", "4.60", "4.70"),
            ],
        )
        .multiples("3", "20")
        .evaluate();
        assert_eq!(out.status(), "COMPLETED", "{sum}");
        assert_eq!(
            fill_row(&out.fills()[1]),
            format!(
                "{} DURING_SESSION SELL 200@{level} fee=0.00 delta={delta} STOP",
                date(5)
            ),
            "{sum}"
        );
        assert_eq!(out.trades()[0]["exit_reason"], "STOP");
        assert_dec(&out.daily_of(5)["cash_available"], cash);
    }
    assert_one_tick_above_a_stop_is_not_a_touch();
}

/// A low 0.01 above the grid stop is no touch.
fn assert_one_tick_above_a_stop_is_not_a_touch() {
    for (high, sum) in DIRECTIONS {
        let above = if sum == "0.67" { "4.34" } else { "4.33" };
        let out = atr3(
            high,
            vec![
                quiet_bar("5.00", "5.10", above, "4.60"),
                quiet_bar("4.70", "4.80", "4.60", "4.70"),
            ],
        )
        .multiples("3", "20")
        .evaluate();
        assert_eq!(out.fills().len(), 1, "{sum}: only the entry");
        assert_eq!(out.trades()[0]["exit_reason"], "OPEN_AT_END", "{sum}");
    }
}

#[test]
fn an_open_equal_to_a_grid_target_is_a_gap_target_exit_filled_at_that_level() {
    // The bar after the entry stays inside the levels; the next session opens exactly at the
    // target. The gap fills at the target with no slippage: 0.67 -> 200 * 5.67 = 1134.00, cash
    // 5134.00; 0.68 -> 200 * 5.68 = 1136.00, cash 5136.00.
    //
    // Rounded below the old target was 5.6699...99, which the open exceeded, and the fill was the
    // floor, 5.66. Rounded above the old target was 5.6800...01: the open of 5.68 was not a gap
    // exit and the exit came later as an intraday TARGET.
    for (high, sum) in DIRECTIONS {
        let level = plus_three_atr(sum);
        let (delta, cash) = if sum == "0.67" {
            ("1134.00", "5134.00")
        } else {
            ("1136.00", "5136.00")
        };
        let top = if sum == "0.67" { "5.69" } else { "5.70" };
        let bottom = if sum == "0.67" { "5.59" } else { "5.60" };
        let out = atr3(
            high,
            vec![
                quiet_bar("5.00", "5.10", "4.90", "5.00"),
                quiet_bar(&level, top, bottom, &level),
            ],
        )
        .multiples("2", "3")
        .slippage("100")
        .evaluate();
        assert_eq!(out.status(), "COMPLETED", "{sum}");
        assert_eq!(
            fill_row(&out.fills()[1]),
            format!(
                "{} OPEN SELL 200@{level} fee=0.00 delta={delta} GAP_TARGET",
                date(6)
            ),
            "{sum}"
        );
        assert_eq!(out.trades()[0]["exit_reason"], "GAP_TARGET");
        assert_dec(&out.daily_of(6)["cash_available"], cash);
    }
}

#[test]
fn an_open_equal_to_a_grid_stop_is_a_gap_stop_exit_with_slippage() {
    // Slippage 100 bps keeps 99%. Stop 4.33 (0.67) or 4.32 (0.68); the session opens exactly there.
    // 0.67: 4.33 * 0.99 = 4.2867 -> floor 4.28; 200 * 4.28 = 856.00; cash 4856.00.
    // 0.68: 4.32 * 0.99 = 4.2768 -> floor 4.27; 200 * 4.27 = 854.00; cash 4854.00.
    //
    // Rounded above (0.68 / 3) the old stop was 4.3199...99, below the open: no gap exit; the
    // exit came intraday as a STOP filled at 4.31.
    for (high, sum) in DIRECTIONS {
        let level = minus_three_atr(sum);
        let (price, delta, cash) = if sum == "0.67" {
            ("4.28", "856.00", "4856.00")
        } else {
            ("4.27", "854.00", "4854.00")
        };
        let out = atr3(
            high,
            vec![
                quiet_bar("5.00", "5.10", "4.90", "5.00"),
                quiet_bar(&level, "4.40", "4.30", "4.35"),
            ],
        )
        .multiples("3", "20")
        .slippage("100")
        .evaluate();
        assert_eq!(out.status(), "COMPLETED", "{sum}");
        assert_eq!(
            fill_row(&out.fills()[1]),
            format!(
                "{} OPEN SELL 200@{price} fee=0.00 delta={delta} GAP_STOP",
                date(6)
            ),
            "{sum}"
        );
        assert_eq!(out.trades()[0]["exit_reason"], "GAP_STOP");
        assert_dec(&out.daily_of(6)["cash_available"], cash);
    }
}

/// Sessions with six true ranges that sum to `ranges` around a flat close of `price`, the last
/// being the signal bar, then a quiet entry session at the same price.
fn atr6(price: &str, ranges: [(&str, &str); 6]) -> Scenario {
    let flat = |(high, low): (&str, &str)| quiet_bar(price, high, low, price);
    let mut bars = vec![flat(ranges[0])];
    bars.extend(ranges[..5].iter().map(|r| flat(*r)));
    let (high, low) = ranges[5];
    bars.push(signal_bar(price, high, low, price));
    // The entry session opens at the same price.
    bars.push(quiet_bar(price, price, price, price));
    Scenario::new(bars)
}

#[test]
fn an_exact_zero_stop_is_an_invalid_level_and_a_tiny_positive_one_is_never_invented() {
    // ATR over 6 sessions with true ranges 1, 1, 1, 1, 0.5, 0.5 is 5 / 6; entry 5.00; stop
    // 6 * ATR below: 5 - 5 = 0 exactly, which violates 0 < stop. The target is
    // 5 + 5 * (5 / 6) = 55 / 6. The run fails at the entry open with INVALID_LEVEL and nothing
    // fills; the reservation stays.
    //
    // The old engine rounded 5 / 6 to 0.8333...33, multiplied to 4.9999...98 and accepted the
    // stop 0.0000000000000000000000000002.
    let out = atr6(
        "5.00",
        [
            ("5.50", "4.50"),
            ("5.50", "4.50"),
            ("5.50", "4.50"),
            ("5.50", "4.50"),
            ("5.25", "4.75"),
            ("5.25", "4.75"),
        ],
    )
    .atr_window(6)
    .multiples("6", "5")
    .evaluate();
    assert_eq!(out.status(), "FAILED");
    assert_eq!(out.code(), "INVALID_LEVEL");
    assert_eq!(out.text("/outcome/at/session"), date(7));
    assert_eq!(out.text("/outcome/at/phase"), "OPEN");
    let detail = out.text("/outcome/detail");
    assert!(
        detail.contains("found stop 0, entry 5, target 55/6"),
        "{detail}"
    );
    assert!(out.fills().is_empty());
    assert_eq!(out.entries()[0]["status"], "RESERVED");
}

#[test]
fn the_opposite_direction_of_an_exact_zero_stop_is_rejected_with_the_exact_level() {
    // ATR over 6 sessions with true ranges 1 x 5 and 2 is 7 / 6; entry 7.00; stop 6 * ATR below:
    // 7 - 7 = 0 exactly. Target 7 + 5 * (7 / 6) = 77 / 6. The old engine rounded 7 / 6 up, got a
    // slightly negative stop and printed it as -0.0000000000000000000000000002.
    let out = atr6(
        "7.00",
        [
            ("7.50", "6.50"),
            ("7.50", "6.50"),
            ("7.50", "6.50"),
            ("7.50", "6.50"),
            ("7.50", "6.50"),
            ("8.00", "6.00"),
        ],
    )
    .atr_window(6)
    .multiples("6", "5")
    .evaluate();
    assert_eq!(out.code(), "INVALID_LEVEL");
    let detail = out.text("/outcome/detail");
    assert!(
        detail.contains("found stop 0, entry 7, target 77/6"),
        "{detail}"
    );
}

#[test]
fn a_valid_level_that_is_not_a_decimal_is_kept_exactly_and_shown_rounded() {
    // The same ATR 5 / 6 with a stop 5 * ATR below: 5 - 25 / 6 = 5 / 6 > 0. It is a valid level.
    // The result shows it at the most digits a decimal carries, 0.8333...3 (28 digits), and the
    // position holds the exact fraction.
    let scenario = atr6(
        "5.00",
        [
            ("5.50", "4.50"),
            ("5.50", "4.50"),
            ("5.50", "4.50"),
            ("5.50", "4.50"),
            ("5.25", "4.75"),
            ("5.25", "4.75"),
        ],
    )
    .atr_window(6)
    .multiples("5", "5");
    let out = scenario.evaluate();
    assert_eq!(out.status(), "COMPLETED");
    let position = &out.daily_of(7)["positions"][0];
    assert_eq!(position["stop"], "0.8333333333333333333333333333");
    // The target 5 + 25 / 6 = 55 / 6 = 9.1666...: with the integer digit a decimal carries 28
    // digits, so 27 fractional digits and a final 7.
    assert_eq!(position["target"], "9.166666666666666666666666667");
}

#[test]
fn a_break_even_trigger_on_the_grid_fires_on_an_equal_high() {
    // The trigger is high >= entry + 3 * ATR: 5.67 (0.67) or 5.68 (0.68). The session after the
    // entry reaches exactly that high. The stop moves to the entry price 5.00 for the next
    // session, where a low of 5.00 touches it: 200 * 5.00 = 1000.00, cash 5000.00. Stop 2 * ATR
    // and target 20 * ATR are far away.
    //
    // Rounded above (0.68 / 3) the old trigger was 5.6800...01 and a high of 5.68 missed it.
    for (high, sum) in DIRECTIONS {
        let trigger = plus_three_atr(sum);
        let out = atr3(
            high,
            vec![
                quiet_bar("5.00", &trigger, "4.90", "5.20"),
                quiet_bar("5.30", "5.40", "5.00", "5.10"),
            ],
        )
        .multiples("2", "20")
        .break_even_trigger("3")
        .evaluate();
        assert_eq!(out.status(), "COMPLETED", "{sum}");
        let scheduled = &out.daily_of(5)["positions"][0]["scheduled_stop"];
        assert_dec(&scheduled["level"], "5");
        assert_eq!(scheduled["effective_session"], date(6).as_str(), "{sum}");
        assert_eq!(
            fill_row(&out.fills()[1]),
            format!(
                "{} DURING_SESSION SELL 200@5.00 fee=0.00 delta=1000.00 STOP",
                date(6)
            ),
            "{sum}"
        );
        assert_dec(&out.daily_of(6)["cash_available"], "5000.00");
    }
    assert_one_tick_below_the_trigger_does_not_fire();
}

/// A high 0.01 below the trigger does not fire it.
fn assert_one_tick_below_the_trigger_does_not_fire() {
    for (high, sum) in DIRECTIONS {
        let below = if sum == "0.67" { "5.66" } else { "5.67" };
        let out = atr3(
            high,
            vec![
                quiet_bar("5.00", below, "4.90", "5.20"),
                quiet_bar("5.30", "5.40", "5.00", "5.10"),
            ],
        )
        .multiples("2", "20")
        .break_even_trigger("3")
        .evaluate();
        assert!(
            out.daily_of(5)["positions"][0]
                .get("scheduled_stop")
                .is_none(),
            "{sum}"
        );
        assert_eq!(out.fills().len(), 1, "{sum}: only the entry");
    }
}

/// Three closes, the decision at the third, and an entry condition on the mean of the three.
fn signal_run(closes: [&str; 3], op: &str, constant: &str) -> Outcome {
    let konst = |value: &str, unit: &str| json!({"op": "operator:const@1", "args": [], "params": {"value": value, "unit": unit}});
    let close = json!({"op": "operator:bar_field@1", "args": [], "params": {"field": "CLOSE"}});
    let mean = json!({"op": "operator:sma@1", "args": [close], "params": {"window": 3}});
    let condition = json!({
        "op": format!("operator:{op}@1"),
        "args": [
            {"op": "operator:mul@1", "args": [mean, konst("3", "RATIO")], "params": {}},
            konst(constant, "PRICE"),
        ],
        "params": {},
    });
    let bar = |close: &str| quiet_bar(close, "0.40", "0.30", close);
    Scenario::new(vec![
        bar(closes[0]),
        bar(closes[1]),
        bar(closes[2]),
        quiet_bar("0.34", "0.40", "0.30", "0.34"),
    ])
    .scored_from(2)
    .condition(condition)
    .evaluate()
}

#[test]
fn an_entry_comparison_at_exact_equality_is_decided_exactly() {
    // The mean of closes 0.33, 0.33, 0.34 is 1.00 / 3 and three times it is exactly 1.00; the
    // mean of 0.33, 0.34, 0.34 is 1.01 / 3 and three times it is exactly 1.01.
    //
    // The old mean was rounded at 28 digits: 1.00 / 3 rounded down (so 3 * mean = 0.9999...99:
    // gte and lt at 1.00 were wrong), 1.01 / 3 rounded up (so 3 * mean = 1.0100...01: lte and gt
    // at 1.01 were wrong).
    let tie_low = ["0.33", "0.33", "0.34"];
    let tie_high = ["0.33", "0.34", "0.34"];
    let condition = |out: &Outcome| out.signal_of(2)["condition"].as_str().unwrap().to_owned();
    // 1.00 / 3: equal to 1.00.
    assert_eq!(condition(&signal_run(tie_low, "gte", "1.00")), "TRUE");
    assert_eq!(condition(&signal_run(tie_low, "lte", "1.00")), "TRUE");
    assert_eq!(condition(&signal_run(tie_low, "gt", "1.00")), "FALSE");
    assert_eq!(condition(&signal_run(tie_low, "lt", "1.00")), "FALSE");
    // 1.01 / 3: equal to 1.01.
    assert_eq!(condition(&signal_run(tie_high, "gte", "1.01")), "TRUE");
    assert_eq!(condition(&signal_run(tie_high, "lte", "1.01")), "TRUE");
    assert_eq!(condition(&signal_run(tie_high, "gt", "1.01")), "FALSE");
    assert_eq!(condition(&signal_run(tie_high, "lt", "1.01")), "FALSE");
    // One tick away is decided the ordinary way.
    assert_eq!(condition(&signal_run(tie_low, "gte", "1.01")), "FALSE");
    assert_eq!(condition(&signal_run(tie_high, "gt", "1.00")), "TRUE");
    // A TRUE condition enters: the entry fills at the next open.
    let out = signal_run(tie_low, "gte", "1.00");
    assert_eq!(out.signal_of(2)["decision"], "ENTER");
}

/// Entry at 5.00 with a stop of exactly 4.33 (ATR over 3 sessions is 0.2, stop 3.35 ATR), a
/// 3-for-1 split at session 6 and its reverse 1-for-3 at session 7, then a low of exactly 4.33.
fn split_round_trip() -> Scenario {
    let quiet = || quiet_bar("5.00", "5.10", "4.90", "5.00");
    Scenario::new(vec![
        quiet(),
        quiet(),
        quiet(),
        quiet(),
        // True ranges 0.20, 0.20 and 0.20: ATR 0.2.
        signal_bar("5.00", "5.10", "4.90", "5.00"),
        // Entry at 5.00: 200 shares. The close 5.10 is the mark.
        quiet_bar("5.00", "5.10", "4.90", "5.10"),
        // 3-for-1: prices a third, 600 shares; the mark 5.10 / 3 = 1.70.
        quiet_bar("1.70", "1.72", "1.65", "1.70"),
        // 1-for-3: back to 200 shares at 5.10.
        quiet_bar("5.10", "5.20", "5.00", "5.10"),
        // The low is exactly the stop 4.33: 5.00 - 3.35 * 0.2 = 4.33.
        quiet_bar("5.00", "5.05", "4.33", "4.50"),
        quiet_bar("4.50", "4.60", "4.40", "4.50"),
    ])
    .atr_window(3)
    .multiples("3.35", "5")
    .split("S3F", 6, 3, 1)
    .split("R3F", 7, 1, 3)
}

#[test]
fn a_split_followed_by_its_reverse_returns_the_stop_to_its_exact_value() {
    // 4.33 / 3 = 433 / 300 and 433 / 300 * 3 = 4.33 exactly. The old engine rounded the quotient
    // to 1.4433...33 and the product to 4.3299...99, below a low of exactly 4.33: no touch.
    let out = split_round_trip().evaluate();
    assert_eq!(out.status(), "COMPLETED");
    // After the reverse split the position shows its original levels.
    let position = &out.daily_of(7)["positions"][0];
    assert_dec(&position["quantity"], "200");
    assert_dec(&position["entry_price"], "5");
    assert_dec(&position["stop"], "4.33");
    assert_dec(&position["snapshots"][0]["value"], "0.2");
    // 5.00 + 5 * 0.2 = 6.00.
    assert_dec(&position["target"], "6");
    // The exact stop is touched: 200 * 4.33 = 866.00, cash 4000.00 + 866.00 = 4866.00.
    assert_eq!(
        fill_row(&out.fills()[1]),
        format!(
            "{} DURING_SESSION SELL 200@4.33 fee=0.00 delta=866.00 STOP",
            date(8)
        )
    );
    assert_dec(&out.daily_of(8)["cash_available"], "4866.00");
}

/// A run with a split before the entry open and a failure that prints levels (the structure of
/// review case R-0348): ATR over 2 sessions, stop 5 ATR below and target 2 ATR above, a 3-for-1
/// split effective at session 11, a signal at its close and the entry at session 12.
fn split_then_invalid_level() -> Scenario {
    let rows = [
        ("50.22", "53.67", "47.85", "51.46"),
        ("51.10", "52.20", "50.14", "51.86"),
        ("51.72", "52.71", "51.69", "52.05"),
        ("52.17", "52.18", "51.24", "51.66"),
        ("51.81", "53.39", "50.84", "52.60"),
        ("59.41", "59.93", "55.41", "58.27"),
        ("58.10", "58.53", "56.14", "57.52"),
        ("57.70", "57.71", "57.31", "57.46"),
        ("57.53", "60.16", "57.20", "58.94"),
        ("59.36", "59.53", "54.90", "57.38"),
        ("57.26", "58.11", "57.22", "57.65"),
        ("57.97", "59.14", "57.03", "57.46"),
        ("64.65", "67.11", "64.08", "64.78"),
        ("64.69", "66.78", "64.04", "65.33"),
        ("65.22", "66.13", "65.01", "65.86"),
    ];
    let close = json!({"op": "operator:bar_field@1", "args": [], "params": {"field": "CLOSE"}});
    let mean = json!({"op": "operator:sma@1", "args": [close.clone()], "params": {"window": 2}});
    let condition = json!({"op": "operator:gt@1", "args": [close, mean], "params": {}});
    Scenario::new(
        rows.iter()
            .map(|(o, h, l, c)| quiet_bar(o, h, l, c))
            .collect(),
    )
    .scored_from(5)
    .capital("10000.00")
    .fees("1.00", "0")
    .slippage("25")
    .atr_window(2)
    .multiples("5", "2")
    .condition(condition)
    .split("SPL-0", 11, 3, 1)
}

#[test]
fn a_failure_that_prints_levels_reads_the_same_in_every_restored_run() {
    // Review case R-0348. The signal at session 11 snapshots ATR over 2 sessions on the signal
    // basis after the 3-for-1 split of that session:
    //   true range at session 10: max(58.11 - 57.22, |58.11 - 57.38 / 3|, ...) over the adjusted
    //   bars, i.e. 0.89 / 3; true range at session 11: 59.14 - 57.65 / 3 = 119.77 / 3;
    //   ATR = (0.89 + 119.77) / 6 = 20.11.
    // The entry open at session 12 is 64.65: stop 64.65 - 5 * 20.11 = -35.90, target
    // 64.65 + 2 * 20.11 = 104.87. The levels print in their canonical form, so the text is
    // identical in an uninterrupted run and in a run restored from any cut. The old engine kept
    // 28-digit scales in the uninterrupted run ("-35.90000000000000000000000000") and printed the
    // normalised value after a restore.
    let scenario = split_then_invalid_level();
    let run = scenario.run();
    let (end, failure) = run.run_to_end(run.initial_state().unwrap());
    let failure = failure.expect("the entry fails");
    assert_eq!(failure.code.to_string(), "INVALID_LEVEL");
    assert_eq!(
        failure.detail,
        format!(
            "I-{}-SYN: levels must satisfy 0 < stop < entry < target, found stop -35.9, entry 64.65, target 104.87",
            date(11)
        )
    );
    assert_restores_at_every_cut("split then invalid level", &run, &end, Some(&failure));
}

// ---------------------------------------------------------------------------------------------
// Restore at every cut
// ---------------------------------------------------------------------------------------------

fn result_text(run: &Run, state: &State, failure: Option<&Failure>) -> String {
    canonical_json(&to_value(&run.result(state, failure).unwrap()).unwrap()).unwrap()
}

fn checkpoint_text(run: &Run, state: &State) -> String {
    round_trip(run, state).0
}

/// Serialise the state after `cut` events, validate and parse the text, restore it and run the
/// remaining events. The result text, the failure and the final checkpoint must equal those of
/// the uninterrupted run.
fn assert_restores_at_every_cut(name: &str, run: &Run, end: &State, failure: Option<&Failure>) {
    let events = run.events().unwrap();
    let completed = match &end.next {
        None => events.len(),
        Some(next) => events.iter().position(|e| &e.cursor == next).unwrap(),
    };
    let expected_text = result_text(run, end, failure);
    let expected_checkpoint = checkpoint_text(run, end);
    for cut in 0..=completed {
        let prefix = state_after(run, cut);
        let (_, checkpoint) = round_trip(run, &prefix);
        let restored = run.restore(&checkpoint).unwrap();
        let (state, again) = run.run_events(restored, &events[cut..]);
        assert_eq!(
            again
                .as_ref()
                .map(|f| (f.code, f.at.clone(), f.detail.clone())),
            failure.map(|f| (f.code, f.at.clone(), f.detail.clone())),
            "{name}: failure after a restore at cut {cut}"
        );
        assert_eq!(
            result_text(run, &state, again.as_ref()),
            expected_text,
            "{name}: result after a restore at cut {cut}"
        );
        assert_eq!(
            checkpoint_text(run, &state),
            expected_checkpoint,
            "{name}: end checkpoint after a restore at cut {cut}"
        );
    }
}

#[test]
fn these_runs_restore_to_the_uninterrupted_result_from_every_cut() {
    // Each run is checked against its hand-derived outcome (the last fill, or the failure) and
    // then restored from every cut. The outcomes are those of the tests above.
    let scenarios: Vec<(&str, Scenario, String)> = vec![
        (
            "target tie 0.67",
            atr3(
                "5.17",
                vec![
                    quiet_bar("5.00", "5.67", "4.90", "5.30"),
                    quiet_bar("5.20", "5.30", "5.10", "5.20"),
                ],
            )
            .multiples("2", "3"),
            format!(
                "{} DURING_SESSION SELL 200@5.67 fee=0.00 delta=1134.00 TARGET",
                date(5)
            ),
        ),
        (
            "gap stop 0.68",
            atr3(
                "5.18",
                vec![
                    quiet_bar("5.00", "5.10", "4.90", "5.00"),
                    quiet_bar("4.32", "4.40", "4.30", "4.35"),
                ],
            )
            .multiples("3", "20")
            .slippage("100"),
            format!(
                "{} OPEN SELL 200@4.27 fee=0.00 delta=854.00 GAP_STOP",
                date(6)
            ),
        ),
        (
            "break-even tie 0.68",
            atr3(
                "5.18",
                vec![
                    quiet_bar("5.00", "5.68", "4.90", "5.20"),
                    quiet_bar("5.30", "5.40", "5.00", "5.10"),
                ],
            )
            .multiples("2", "20")
            .break_even_trigger("3"),
            format!(
                "{} DURING_SESSION SELL 200@5.00 fee=0.00 delta=1000.00 STOP",
                date(6)
            ),
        ),
        (
            "split and reverse split",
            split_round_trip(),
            format!(
                "{} DURING_SESSION SELL 200@4.33 fee=0.00 delta=866.00 STOP",
                date(8)
            ),
        ),
        (
            "exact zero stop",
            atr6(
                "5.00",
                [
                    ("5.50", "4.50"),
                    ("5.50", "4.50"),
                    ("5.50", "4.50"),
                    ("5.50", "4.50"),
                    ("5.25", "4.75"),
                    ("5.25", "4.75"),
                ],
            )
            .atr_window(6)
            .multiples("6", "5"),
            "INVALID_LEVEL".to_owned(),
        ),
    ];
    for (name, scenario, expected) in scenarios {
        let outcome = scenario.evaluate();
        let seen = match outcome.fills().last() {
            Some(fill) if outcome.failure.is_none() => fill_row(fill),
            _ => outcome.code().to_owned(),
        };
        assert_eq!(seen, expected, "{name}");
        let run = scenario.run();
        let (end, failure) = run.run_to_end(run.initial_state().unwrap());
        assert_restores_at_every_cut(name, &run, &end, failure.as_ref());
    }
}

#[test]
fn the_checkpoint_of_a_pending_entry_and_an_open_position_keeps_non_terminating_values_exactly() {
    // ATR 0.68 / 3 = 17 / 75 does not terminate. The pending entry's snapshot, and the position's
    // snapshot, stop and target, are written as exact values: the snapshot as the fraction
    // 17/75, the stop 5 - 2 * 17 / 75 = 341 / 75 and the target 5 + 3 * 17 / 75 = 142 / 25 = 5.68
    // as a decimal.
    let scenario = atr3(
        "5.18",
        vec![
            quiet_bar("5.00", "5.10", "4.90", "5.00"),
            quiet_bar("5.00", "5.10", "4.90", "5.00"),
        ],
    )
    .multiples("2", "3");
    let run = scenario.run();
    let pending = checkpoint_text(&run, &state_after(&run, event_index(&run, 5, "OPEN")));
    let value: Value = serde_json::from_str(&pending).unwrap();
    let snapshot = &value["state"]["pending_entries"][0]["snapshots"][0];
    assert_eq!(snapshot["name"], "entry_atr");
    assert_eq!(snapshot["value"], "17/75");
    let held = checkpoint_text(
        &run,
        &state_after(&run, event_index(&run, 5, "DURING_SESSION")),
    );
    let value: Value = serde_json::from_str(&held).unwrap();
    let position = &value["state"]["positions"][0];
    assert_eq!(position["snapshots"][0]["value"], "17/75");
    assert_eq!(position["stop"], "341/75");
    assert_eq!(position["target"], "5.68");
    assert_eq!(position["entry_price"], "5");
}

// ---------------------------------------------------------------------------------------------
// Validity boundaries: exactly equal, and one exact fraction on either side
// ---------------------------------------------------------------------------------------------
//
// A level is valid at the entry open when 0 < stop < entry < target, and a break-even level when
// 0 < new stop < target. Every comparison is exact. A level that differs from its bound by less
// than one price unit has the bound itself as its grid ceiling (below it) or as its grid floor
// (above it), so a rule that read the level on the grid would decide one of the two directions
// wrongly: 1/300 below a bound is valid although its ceiling is the bound, and 1/300 above a
// bound is invalid although its floor is the bound. A positive level below one price unit has
// the grid floor 0 and is still positive.
//
// ATR over 3 sessions with a signal-bar high of 5.50 is (0.20 + 0.20 + 0.60) / 3 = 1/3, so a
// level `5.00 + m * ATR` is `5 + m / 3` and a multiple m of 0.01 moves it by exactly 1/300.

/// Entry at 5.00 on session 5 with ATR 1/3. The two bars from the entry session on are flat at
/// 5.00, so they touch no stop below 5.00 and no target above 5.00, and a valid position is still
/// open at the end.
fn third_atr() -> Scenario {
    let flat = || quiet_bar("5.00", "5.00", "5.00", "5.00");
    atr3("5.50", vec![flat(), flat()])
}

/// The failure of a run that ends at the entry open with an invalid level (session 5), and the
/// reservation that stays because no fill was made.
fn assert_invalid_at_the_entry_open(out: &Outcome, detail: &str, what: &str) {
    assert_eq!(out.status(), "FAILED", "{what}");
    assert_eq!(out.code(), "INVALID_LEVEL", "{what}");
    assert_eq!(out.text("/outcome/at/session"), date(5), "{what}");
    assert_eq!(out.text("/outcome/at/phase"), "OPEN", "{what}");
    assert_eq!(out.text("/outcome/detail"), detail, "{what}");
    assert!(out.fills().is_empty(), "{what}");
    assert_eq!(out.entries()[0]["status"], "RESERVED", "{what}");
}

#[test]
fn a_stop_is_valid_one_exact_fraction_below_the_entry_and_invalid_at_or_above_it() {
    // Target 5 + 3 / 3 = 6. The stop is 5 - m / 3.
    //   m = 0      stop 5           equal to the entry: invalid.
    //   m = 0.01   stop 1499/300    1/300 below the entry, grid ceiling 5.00 = entry: valid.
    //   m = -0.01  stop 1501/300    1/300 above the entry, grid floor 5.00 = entry: invalid.
    //   m = 0.03   stop 4.99        one price unit below, on the grid: valid.
    // A rule on the grid, 0 < ceil(stop) < entry, rejects the second row.
    let intent = format!("I-{}-SYN", date(4));
    let invalid = |level: &str| {
        format!(
            "{intent}: levels must satisfy 0 < stop < entry < target, found stop {level}, entry 5, target 6"
        )
    };
    for (multiple, level, valid) in [
        ("0", "5", None),
        ("0.01", "1499/300", Some("4.9966666666666666666666666667")),
        ("-0.01", "1501/300", None),
        ("0.03", "4.99", Some("4.99")),
    ] {
        let out = third_atr().multiples(multiple, "3").evaluate();
        let what = format!("stop multiple {multiple}, stop {level}");
        match valid {
            None => assert_invalid_at_the_entry_open(&out, &invalid(level), &what),
            Some(shown) => {
                assert_eq!(out.status(), "COMPLETED", "{what}");
                assert_eq!(out.fills().len(), 1, "{what}: only the entry");
                assert_eq!(out.at("/final/open_positions/0/stop"), shown, "{what}");
                assert_eq!(out.at("/final/open_positions/0/target"), "6", "{what}");
                // The state holds the exact fraction, not the shown decimal.
                let held = &out.state.positions[0];
                assert_eq!(held.stop.to_string(), level, "{what}");
                assert_eq!(held.target, Ratio::from_i64(6), "{what}");
            }
        }
    }
}

#[test]
fn a_target_is_valid_one_exact_fraction_above_the_entry_and_invalid_at_or_below_it() {
    // Stop 5 - 2 / 3 = 13/3. The target is 5 + t / 3.
    //   t = 0      target 5          equal to the entry: invalid.
    //   t = 0.01   target 1501/300   1/300 above the entry, grid floor 5.00 = entry: valid.
    //   t = -0.01  target 1499/300   1/300 below the entry, grid ceiling 5.00 = entry: invalid.
    //   t = 0.03   target 5.01       one price unit above, on the grid: valid.
    // A rule on the grid, entry < floor(target), rejects the second row.
    let intent = format!("I-{}-SYN", date(4));
    let invalid = |level: &str| {
        format!(
            "{intent}: levels must satisfy 0 < stop < entry < target, found stop 13/3, entry 5, target {level}"
        )
    };
    for (multiple, level, valid) in [
        ("0", "5", None),
        ("0.01", "1501/300", Some("5.0033333333333333333333333333")),
        ("-0.01", "1499/300", None),
        ("0.03", "5.01", Some("5.01")),
    ] {
        let out = third_atr().multiples("2", multiple).evaluate();
        let what = format!("target multiple {multiple}, target {level}");
        match valid {
            None => assert_invalid_at_the_entry_open(&out, &invalid(level), &what),
            Some(shown) => {
                assert_eq!(out.status(), "COMPLETED", "{what}");
                assert_eq!(out.fills().len(), 1, "{what}: only the entry");
                assert_eq!(out.at("/final/open_positions/0/target"), shown, "{what}");
                let held = &out.state.positions[0];
                assert_eq!(held.target.to_string(), level, "{what}");
                assert_eq!(held.stop.to_string(), "13/3", "{what}");
            }
        }
    }
}

/// ATR over 6 sessions 5 / 6 (true ranges 1, 1, 1, 1, 0.5, 0.5), entry 5.00 on session 7.
fn five_sixths() -> Scenario {
    atr6(
        "5.00",
        [
            ("5.50", "4.50"),
            ("5.50", "4.50"),
            ("5.50", "4.50"),
            ("5.50", "4.50"),
            ("5.25", "4.75"),
            ("5.25", "4.75"),
        ],
    )
    .atr_window(6)
}

#[test]
fn a_positive_stop_below_one_price_unit_is_valid_and_a_negative_one_is_not() {
    // Stop 5 - m * 5/6, target 5 + 5 * 5/6 = 55/6.
    //   m = 5.998  stop 1/600 > 0: its grid floor is 0.00, and it is a valid level.
    //   m = 6.002  stop -1/600 < 0: invalid, although its grid ceiling is 0.00 as well.
    // A rule on the grid, 0 < floor(stop), rejects the first row.
    let out = five_sixths().multiples("5.998", "5").evaluate();
    assert_eq!(out.status(), "COMPLETED");
    assert_eq!(out.fills().len(), 1);
    assert_eq!(
        out.at("/final/open_positions/0/stop"),
        "0.0016666666666666666666666667"
    );
    assert_eq!(out.state.positions[0].stop, Ratio::new(1, 600).unwrap());
    let out = five_sixths().multiples("6.002", "5").evaluate();
    assert_eq!(out.status(), "FAILED");
    assert_eq!(out.code(), "INVALID_LEVEL");
    assert_eq!(out.text("/outcome/at/session"), date(7));
    assert_eq!(
        out.text("/outcome/detail"),
        format!(
            "I-{}-SYN: levels must satisfy 0 < stop < entry < target, found stop -1/600, entry 5, target 55/6",
            date(6)
        )
    );
    assert!(out.fills().is_empty());
}

#[test]
fn a_break_even_new_stop_of_exactly_zero_is_an_invalid_level_at_the_close() {
    // ATR over 6 sessions is 5 / 6, the entry is 5.00 on session 7, and the new stop is
    // entry + (-6) * ATR = 5 - 5 = 0 exactly. The trigger multiple 0 makes the rule fire at the
    // close of the entry session (the high 5.00 reaches entry + 0 * ATR). Stop 5 - 2 * 5/6 =
    // 10/3 and target 5 + 5 * 5/6 = 55/6 are valid, so the run fails at the break-even decision
    // and not before.
    let mut scenario = five_sixths().break_even_trigger("0").break_even_level("-6");
    // A session after the entry, so that the stop change has a session to take effect in.
    scenario
        .bars
        .push(Some(quiet_bar("5.00", "5.00", "5.00", "5.00")));
    scenario.last += 1;
    let out = scenario.evaluate();
    assert_eq!(out.status(), "FAILED");
    assert_eq!(out.code(), "INVALID_LEVEL");
    assert_eq!(out.text("/outcome/at/session"), date(7));
    assert_eq!(out.text("/outcome/at/phase"), "AFTER_CLOSE");
    assert_eq!(
        out.text("/outcome/detail"),
        format!(
            "T-{}-SYN: new stop level 0 must be a positive price below the target 55/6",
            date(7)
        )
    );
    // The entry at the open of session 7 is complete; the close event that failed is discarded:
    // the journal keeps no daily record for session 7, and the position keeps its entry stop.
    assert_eq!(out.fills().len(), 1);
    assert_eq!(out.daily().last().unwrap()["session"], date(6).as_str());
    assert_eq!(out.state.positions[0].stop, Ratio::new(10, 3).unwrap());
    assert!(out.state.positions[0].scheduled.is_none());
}

#[test]
fn a_break_even_new_stop_is_valid_one_exact_fraction_inside_each_bound_and_invalid_on_it() {
    // Entry 5.00, ATR 1/3, target 5 + 3 / 3 = 6, stop 13/3. The trigger multiple 0 fires at the
    // close of the entry session (session 5). The new stop is 5 + m / 3.
    //   m = -15     0          equal to the lower bound: invalid.
    //   m = -14.99  1/300      1/300 above 0, grid floor 0.00: valid.
    //   m = -15.01  -1/300     1/300 below 0, grid ceiling 0.00: invalid.
    //   m = 3       6          equal to the target: invalid.
    //   m = 2.99    1799/300   1/300 below the target, grid ceiling 6.00 = target: valid.
    //   m = 3.01    1801/300   1/300 above the target, grid floor 6.00 = target: invalid.
    let trade = format!("T-{}-SYN", date(5));
    for (multiple, level, valid) in [
        ("-15", "0", false),
        ("-14.99", "1/300", true),
        ("-15.01", "-1/300", false),
        ("3", "6", false),
        ("2.99", "1799/300", true),
        ("3.01", "1801/300", false),
    ] {
        let scenario = third_atr()
            .multiples("2", "3")
            .break_even_trigger("0")
            .break_even_level(multiple);
        let what = format!("new stop multiple {multiple}, new stop {level}");
        if valid {
            // The stop is scheduled for the next session, exactly.
            let run = scenario.run();
            let state = state_after(&run, event_index(&run, 6, "BEFORE_OPEN"));
            let scheduled = state.positions[0].scheduled.clone().expect(&what);
            assert_eq!(scheduled.level.to_string(), level, "{what}");
            assert_eq!(scheduled.effective_session, date(6), "{what}");
            assert_eq!(scenario.evaluate().status(), "COMPLETED", "{what}");
        } else {
            let out = scenario.evaluate();
            assert_eq!(out.status(), "FAILED", "{what}");
            assert_eq!(out.code(), "INVALID_LEVEL", "{what}");
            assert_eq!(out.text("/outcome/at/session"), date(5), "{what}");
            assert_eq!(out.text("/outcome/at/phase"), "AFTER_CLOSE", "{what}");
            assert_eq!(
                out.text("/outcome/detail"),
                format!(
                    "{trade}: new stop level {level} must be a positive price below the target 6"
                ),
                "{what}"
            );
            assert_eq!(out.fills().len(), 1, "{what}: only the entry");
        }
    }
}

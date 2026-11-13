//! Gap exits, intraday stop and target touches, break-even stop changes and end of run
//! (OQ-02 sections 2.5-2.6). Every expected number is derived by hand beside its assertion.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

mod execution_support;

use execution_support::*;

/// Entry at the S2 open 50 with cap 1000.00, fee 1.00 + 10 bps: 19 shares, total 951.95,
/// cash 4048.05. Signal ATR 4: stop 50 - 8 = 42, target 50 + 20 = 70. `s3` is the exit session.
fn held(s3: Bar) -> Scenario {
    Scenario::new(vec![
        quiet_bar("50", "51", "49", "50"),  // S0
        signal_bar("50", "54", "50", "52"), // S1: ATR 4
        quiet_bar("50", "53", "49", "51"),  // S2: entry at 50, no touch
        s3,
        quiet_bar("45", "46", "44", "45"), // S4: nothing happens
    ])
    .fees("1.00", "10")
}

#[test]
fn a_gap_through_the_stop_fills_at_the_open_with_adverse_slippage() {
    // S3 open 40 <= stop 42. Slippage 33 bps: 40 * (1 - 0.0033) = 39.868 -> floor 39.86.
    // 19 * 39.86 = 757.34; fee ceil(1.00 + 0.75734) = 1.76; proceeds 755.58.
    // Cash 4048.05 + 755.58 = 4803.63.
    let out = held(quiet_bar("40", "41", "39", "40"))
        .slippage("33")
        .evaluate();
    assert_eq!(
        fill_row(&out.fills()[1]),
        format!(
            "{} OPEN SELL 19@39.86 fee=1.76 delta=755.58 GAP_STOP",
            date(3)
        )
    );
    assert_eq!(out.trades()[0]["exit_reason"], "GAP_STOP");
    assert_dec(&out.trades()[0]["exit_price"], "39.86");
    assert_eq!(out.trades()[0]["ambiguous_bar"], false);
    assert_dec(&out.daily_of(3)["cash_available"], "4803.63");
    assert!(out.daily_of(3)["positions"].as_array().unwrap().is_empty());
    // The gap price is not the stop level 42.00.
    assert_ne!(out.fills()[1]["price"], "42.00");
}

#[test]
fn an_open_equal_to_the_stop_is_a_gap_exit() {
    // Boundary: open 42 == stop 42 -> GAP_STOP at the open (not an intraday STOP).
    // Slippage 0: 19 * 42 = 798.00; fee ceil(1.00 + 0.798) = 1.80; proceeds 796.20.
    let out = held(quiet_bar("42", "43", "41", "42")).evaluate();
    assert_eq!(
        fill_row(&out.fills()[1]),
        format!(
            "{} OPEN SELL 19@42.00 fee=1.80 delta=796.20 GAP_STOP",
            date(3)
        )
    );
}

#[test]
fn slippage_applies_to_the_gap_price_and_floors() {
    // Open == stop 42 with 33 bps: 42 * 0.9967 = 41.8614 -> floor 41.86 (a ceiling would give
    // 41.87).
    let out = held(quiet_bar("42", "43", "41", "42"))
        .slippage("33")
        .evaluate();
    assert_dec(&out.fills()[1]["price"], "41.86");
}

#[test]
fn a_gap_above_the_target_fills_at_the_target_without_slippage() {
    // S3 open 75 >= target 70: sold at 70.00 even with 33 bps configured.
    // 19 * 70 = 1330.00; fee ceil(1.00 + 1.33) = 2.33; proceeds 1327.67; cash 5375.72.
    let out = held(quiet_bar("75", "76", "74", "75"))
        .slippage("33")
        .evaluate();
    assert_eq!(
        fill_row(&out.fills()[1]),
        format!(
            "{} OPEN SELL 19@70.00 fee=2.33 delta=1327.67 GAP_TARGET",
            date(3)
        )
    );
    assert_eq!(out.trades()[0]["exit_reason"], "GAP_TARGET");
    assert_dec(&out.daily_of(3)["cash_available"], "5375.72");
}

#[test]
fn an_open_equal_to_the_target_is_a_gap_target_exit() {
    let out = held(quiet_bar("70", "71", "69", "70")).evaluate();
    assert_eq!(
        fill_row(&out.fills()[1]),
        format!(
            "{} OPEN SELL 19@70.00 fee=2.33 delta=1327.67 GAP_TARGET",
            date(3)
        )
    );
}

#[test]
fn touching_both_levels_takes_the_stop_and_records_an_ambiguous_bar() {
    // S3 high 70 >= target and low 42 <= stop: the stop wins at 42.00.
    // 19 * 42 = 798.00; fee 1.80; proceeds 796.20; cash 4048.05 + 796.20 = 4844.25.
    let out = held(quiet_bar("50", "70", "42", "55")).evaluate();
    assert_eq!(
        fill_row(&out.fills()[1]),
        format!(
            "{} DURING_SESSION SELL 19@42.00 fee=1.80 delta=796.20 STOP",
            date(3)
        )
    );
    assert_eq!(out.fills()[1]["ambiguous_bar"], true);
    assert_eq!(out.trades()[0]["exit_reason"], "STOP");
    assert_eq!(out.trades()[0]["ambiguous_bar"], true);
    assert_dec(&out.daily_of(3)["cash_available"], "4844.25");
}

#[test]
fn a_single_touch_is_not_ambiguous() {
    let out = held(quiet_bar("50", "52", "41.99", "45")).evaluate();
    assert!(out.fills()[1].get("ambiguous_bar").is_none());
    assert_eq!(out.trades()[0]["ambiguous_bar"], false);
}

#[test]
fn stop_and_target_equalities_touch_and_one_cent_inside_does_not() {
    // low == stop 42 -> STOP at 42.00.
    let out = held(quiet_bar("50", "52", "42", "45")).evaluate();
    assert_eq!(out.fills()[1]["reason"], "STOP");
    assert_dec(&out.fills()[1]["price"], "42.00");

    // low 42.01 > stop and high 69.99 < target: no exit in S3. The position is still open at S4.
    let out = held(quiet_bar("50", "69.99", "42.01", "50")).evaluate();
    assert_eq!(out.fills().len(), 1);
    assert_eq!(out.daily_of(3)["positions"].as_array().unwrap().len(), 1);

    // high == target 70 -> TARGET at 70.00.
    let out = held(quiet_bar("50", "70", "49", "60")).evaluate();
    assert_eq!(out.fills()[1]["reason"], "TARGET");
    assert_dec(&out.fills()[1]["price"], "70.00");
    assert_eq!(out.fills()[1]["phase"], "DURING_SESSION");
}

#[test]
fn an_intraday_fill_uses_the_level_floored_to_the_price_scale() {
    // Stop = 50 - 2.5 * 3.33 = 41.675, target = 50 + 5 * 3.33 = 66.65 (ATR(1) of S1 =
    // max(53.33 - 50, |53.33 - 50|, |50 - 50|) = 3.33). Cap 1000.00 / 50 = 20 shares.
    let make = |low: &str| {
        Scenario::new(vec![
            quiet_bar("50", "51", "49", "50"),
            signal_bar("50", "53.33", "50", "51"),
            quiet_bar("50", "52", "49", "51"),
            quiet_bar("50", "52", low, "45"),
        ])
        .multiples("2.5", "5")
        .evaluate()
    };
    let touched = make("41.67");
    let position = &touched.daily_of(2)["positions"][0];
    assert_dec(&position["stop"], "41.675");
    assert_dec(&position["target"], "66.65");
    // low 41.67 <= 41.675 -> exit at floor(41.675) = 41.67; 20 * 41.67 = 833.40.
    assert_dec(&touched.fills()[1]["price"], "41.67");
    assert_dec(&touched.fills()[1]["notional"], "833.40");
    // low 41.68 > 41.675 -> not touched.
    let not_touched = make("41.68");
    assert_eq!(not_touched.fills().len(), 1);
}

#[test]
fn a_position_filled_at_the_open_is_protected_in_the_same_session() {
    // Entry at 50 (stop 42) and the same bar's low is 41: stopped out during S2 at 42.00.
    let out = Scenario::new(vec![
        quiet_bar("50", "51", "49", "50"),
        signal_bar("50", "54", "50", "52"),
        quiet_bar("50", "53", "41", "44"),
        quiet_bar("44", "45", "43", "44"),
    ])
    .evaluate();
    let rows: Vec<String> = out.fills().iter().map(fill_row).collect();
    // 20 shares at 50 (cap 1000.00); sold 20 * 42 = 840.00.
    assert_eq!(
        rows,
        vec![
            format!(
                "{} OPEN BUY 20@50.00 fee=0.00 delta=-1000.00 ENTRY",
                date(2)
            ),
            format!(
                "{} DURING_SESSION SELL 20@42.00 fee=0.00 delta=840.00 STOP",
                date(2)
            ),
        ]
    );
    assert_dec(&out.daily_of(2)["cash_available"], "4840.00");
    assert!(out.daily_of(2)["positions"].as_array().unwrap().is_empty());
}

#[test]
fn an_open_position_stays_open_at_the_end_valued_at_the_last_close() {
    // Last close 51 (S2 of the entry scenario): 19 * 51 = 969.00; no forced liquidation.
    let out = Scenario::new(vec![
        quiet_bar("50", "51", "49", "50"),
        signal_bar("50", "54", "50", "52"),
        quiet_bar("50", "53", "49", "51"),
        quiet_bar("51", "52", "50", "51"),
    ])
    .fees("1.00", "10")
    .evaluate();
    assert_eq!(out.fills().len(), 1);
    assert_eq!(out.trades()[0]["exit_reason"], "OPEN_AT_END");
    assert!(out.trades()[0].get("exit_session").is_none());
    assert_dec(out.at("/final/cash_available"), "4048.05");
    assert_dec(out.at("/final/positions_value"), "969.00");
    assert_dec(out.at("/final/equity"), "5017.05");
    assert_dec(out.at("/final/open_positions/0/quantity"), "19");
}

/// Entry at the S2 open 50 (cap 1000.00, zero costs: 20 shares), stop 42, target 70.
/// Break-even trigger: high >= 50 + 4 = 54; new stop 50, effective next session.
fn break_even(s2: Bar, s3: Bar, on: bool) -> Scenario {
    Scenario::new(vec![
        quiet_bar("50", "51", "49", "50"),
        signal_bar("50", "54", "50", "52"),
        s2,
        s3,
        quiet_bar("49", "50", "41", "42"), // S4: low 41 <= the original stop 42
    ])
    .break_even(on)
}

#[test]
fn break_even_on_and_off_give_different_scheduled_stops_and_exits() {
    // S2: high 55 >= 54 fires at the S2 close, for a position filled at the S2 open. The S2 low
    // 49 is below the new stop 50: a same-session activation would exit in S2, but a high-
    // triggered change is not effective yet.
    let s2 = || quiet_bar("50", "55", "49", "53");
    // S3: low 49.5 touches 50 but not 42.
    let s3 = || quiet_bar("52", "53", "49.5", "51");

    let on = break_even(s2(), s3(), true).evaluate();
    let scheduled = &on.daily_of(2)["positions"][0]["scheduled_stop"];
    assert_dec(&scheduled["level"], "50");
    assert_eq!(scheduled["effective_session"], date(3).as_str());
    assert_dec(&on.daily_of(2)["positions"][0]["stop"], "42");
    // No sale in S2; the scheduled stop is active in S3 and sold at 50.00: 20 * 50 = 1000.00.
    assert_eq!(on.fills().len(), 2);
    assert_eq!(
        fill_row(&on.fills()[1]),
        format!(
            "{} DURING_SESSION SELL 20@50.00 fee=0.00 delta=1000.00 STOP",
            date(3)
        )
    );
    assert_dec(&on.daily_of(3)["cash_available"], "5000.00");

    let off = break_even(s2(), s3(), false).evaluate();
    assert!(
        off.daily_of(2)["positions"][0]
            .get("scheduled_stop")
            .is_none()
    );
    // Without the change the stop stays 42: S3 survives, S4 (low 41) sells at 42.00 = 840.00.
    assert_eq!(off.fills().len(), 2);
    assert_eq!(
        fill_row(&off.fills()[1]),
        format!(
            "{} DURING_SESSION SELL 20@42.00 fee=0.00 delta=840.00 STOP",
            date(4)
        )
    );
    assert_dec(&off.daily_of(4)["cash_available"], "4840.00");
}

#[test]
fn the_break_even_trigger_includes_equality_and_excludes_one_cent_below() {
    // Trigger: high >= entry 50 + ATR 4 = 54.
    let at = break_even(
        quiet_bar("50", "54", "49", "53"),
        quiet_bar("52", "53", "51", "52"),
        true,
    )
    .evaluate();
    assert!(
        at.daily_of(2)["positions"][0]
            .get("scheduled_stop")
            .is_some()
    );
    let below = break_even(
        quiet_bar("50", "53.99", "49", "53"),
        quiet_bar("52", "53", "51", "52"),
        true,
    )
    .evaluate();
    assert!(
        below.daily_of(2)["positions"][0]
            .get("scheduled_stop")
            .is_none()
    );
}

#[test]
fn a_break_even_change_is_one_time() {
    // S2 fires (high 55). S3: stop 50 is active, low 50.5 does not touch it; the trigger is
    // true again (high 56 >= 54) but the adjustment already fired: no second schedule.
    let out = break_even(
        quiet_bar("50", "55", "49", "53"),
        quiet_bar("52", "56", "50.5", "55"),
        true,
    )
    .evaluate();
    let s3 = &out.daily_of(3)["positions"][0];
    assert_dec(&s3["stop"], "50");
    assert!(s3.get("scheduled_stop").is_none());
    // The fired list survives in the state after the S3 close.
    let run = break_even(
        quiet_bar("50", "55", "49", "53"),
        quiet_bar("52", "56", "50.5", "55"),
        true,
    )
    .run();
    let state = state_after(&run, event_index(&run, 3, "AFTER_CLOSE") + 1);
    let fired: Vec<_> = state.positions.iter().map(|p| p.fired.clone()).collect();
    assert_eq!(fired, vec![vec!["break_even".to_owned()]]);
    assert!(state.positions[0].scheduled.is_none());
}

#[test]
fn no_stop_change_is_scheduled_after_the_last_session() {
    // The run ends at S2, whose high 55 would fire the trigger. No next processed session
    // exists, so nothing is scheduled and the adjustment is not marked fired.
    let out = Scenario::new(vec![
        quiet_bar("50", "51", "49", "50"),
        signal_bar("50", "54", "50", "52"),
        quiet_bar("50", "55", "49", "53"),
    ])
    .break_even(true)
    .evaluate();
    assert!(
        out.at("/final/open_positions/0")
            .get("scheduled_stop")
            .is_none()
    );
    assert!(out.state.positions[0].fired.is_empty());
}

#[test]
fn a_scheduled_stop_is_active_before_the_next_gap_exit() {
    // The new stop 50 activates at the S3 before-open phase, so an S3 open of 49 is a gap
    // through that stop: sold at the open 49.00 in the OPEN phase, 20 * 49 = 980.00.
    let out = break_even(
        quiet_bar("50", "55", "49", "53"),
        quiet_bar("49", "51", "48", "50"),
        true,
    )
    .evaluate();
    assert_eq!(
        fill_row(&out.fills()[1]),
        format!(
            "{} OPEN SELL 20@49.00 fee=0.00 delta=980.00 GAP_STOP",
            date(3)
        )
    );
    assert_dec(&out.daily_of(3)["cash_available"], "4980.00");
}

/// Entry 50, ATR 4, target 50 + 5 * 4 = 70. S2 fires the trigger (high 55 >= 54).
fn break_even_level_scenario(multiple: &str) -> Scenario {
    Scenario::new(vec![
        quiet_bar("50", "51", "49", "50"),
        signal_bar("50", "54", "50", "52"),
        quiet_bar("50", "55", "49", "53"),
        quiet_bar("60", "62", "58", "60"),
    ])
    .break_even_level(multiple)
}

#[test]
fn a_new_stop_below_the_target_is_scheduled_as_declared() {
    // 50 + 4 * 4 = 66 < target 70: scheduled for S3.
    let out = break_even_level_scenario("4").evaluate();
    assert_eq!(out.status(), "COMPLETED");
    let scheduled = &out.daily_of(2)["positions"][0]["scheduled_stop"];
    assert_dec(&scheduled["level"], "66");
}

#[test]
fn a_new_stop_at_or_above_the_target_is_an_invalid_level() {
    // 50 + 5 * 4 = 70 equals the target; 50 + 6 * 4 = 74 is above it. Neither is a stop.
    for multiple in ["5", "6"] {
        let out = break_even_level_scenario(multiple).evaluate();
        assert_eq!(out.status(), "FAILED", "{multiple}");
        assert_eq!(out.code(), "INVALID_LEVEL", "{multiple}");
        assert_eq!(out.at("/outcome/at/session"), date(2).as_str());
        assert_eq!(out.at("/outcome/at/phase"), "AFTER_CLOSE");
        // The journal keeps everything through the S2 DURING_SESSION event.
        assert_eq!(out.daily().len(), 2);
        assert_eq!(out.fills().len(), 1);
    }
}

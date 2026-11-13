//! Splits across an ex-date (OQ-02 section 2.6, OQ-06 section 8 "Split across an ex-date").
//!
//! Numbers follow the OQ-06 example: 10 shares at 100 with entry ATR 4, stop 92 and target 120
//! become 20 shares at 50 with ATR 2, stop 46 and target 60 after a 2-for-1 split. Every
//! expected value is derived by hand beside its assertion.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

mod execution_support;

use execution_support::*;
use openquant_contracts::to_value;
use openquant_core::numeric::Ratio;
use rust_decimal::Decimal;

/// Zero costs, capital 5000.00 (cap 1000.00). S1 signals with ATR(1) = max(104 - 100,
/// |104 - 100|, |100 - 100|) = 4. S2 opens at 100: q = 1000 / 100 = 10, stop 100 - 2 * 4 = 92,
/// target 100 + 5 * 4 = 120. S3 is the last pre-split session (close 103, high 105). The split
/// is effective at S4 and the raw S4 prices are on the new basis.
fn held_across_split(break_even: bool) -> Scenario {
    Scenario::new(vec![
        quiet_bar("100", "101", "99", "100"),   // S0
        signal_bar("100", "104", "100", "102"), // S1: ATR 4
        quiet_bar("100", "103", "99", "101"),   // S2: entry 10 @ 100
        quiet_bar("102", "105", "101", "103"),  // S3: high 105 >= 100 + 4 fires break-even
        quiet_bar("51", "53", "50.5", "52"),    // S4: ex-date, new basis
        quiet_bar("52", "54", "51", "53"),      // S5
    ])
    .break_even(break_even)
    .split("SPLIT1", 4, 2, 1)
}

#[test]
fn a_two_for_one_split_converts_the_held_position_as_in_the_spec_example() {
    let out = held_across_split(false).evaluate();
    assert_eq!(out.status(), "COMPLETED");

    // Before the split (S3): 10 shares, entry 100, stop 92, target 120, ATR 4.
    let before = &out.daily_of(3)["positions"][0];
    assert_dec(&before["quantity"], "10");
    assert_dec(&before["entry_price"], "100");
    assert_dec(&before["stop"], "92");
    assert_dec(&before["target"], "120");
    assert_dec(&before["snapshots"][0]["value"], "4");
    // 10 * 103 = 1030.00; cash 5000.00 - 1000.00 = 4000.00; equity 5030.00.
    assert_dec(&out.daily_of(3)["positions_value"], "1030.00");
    assert_dec(&out.daily_of(3)["equity"], "5030.00");

    // After the split (S4): quantity x2, price levels and the ATR snapshot /2.
    let after = &out.daily_of(4)["positions"][0];
    assert_dec(&after["quantity"], "20");
    assert_dec(&after["entry_price"], "50");
    assert_dec(&after["stop"], "46");
    assert_dec(&after["target"], "60");
    assert_dec(&after["snapshots"][0]["value"], "2");
    // 20 * 52 = 1040.00; equity 4000.00 + 1040.00 = 5040.00. Cash is untouched by a split.
    assert_dec(&out.daily_of(4)["positions_value"], "1040.00");
    assert_dec(&out.daily_of(4)["cash_available"], "4000.00");
    assert_dec(&out.daily_of(4)["equity"], "5040.00");
}

#[test]
fn the_split_is_journalled_once_with_the_cursor_where_it_was_applied() {
    let out = held_across_split(false).evaluate();
    let actions = out.at("/journal/corporate_actions").as_array().unwrap();
    assert_eq!(actions.len(), 1);
    assert_eq!(actions[0]["action_id"], "SPLIT1");
    assert_eq!(actions[0]["kind"], "SPLIT");
    assert_eq!(actions[0]["effective_session"], date(4).as_str());
    assert_eq!(actions[0]["applied_at"]["session"], date(4).as_str());
    assert_eq!(actions[0]["applied_at"]["phase"], "BEFORE_OPEN");
    assert!(out.state.applied.contains("SPLIT1"));
    assert_eq!(out.state.applied.len(), 1);
    // A split moves no cash: the ledger holds only the reservation, release and entry fill.
    assert_eq!(out.ledger().len(), 3);
}

#[test]
fn the_trade_record_follows_the_share_basis_while_fills_stay_as_traded() {
    let out = held_across_split(false).evaluate();
    // The entry fill is as traded: 10 shares at 100.00 on the pre-split basis.
    assert_eq!(
        fill_row(&out.fills()[0]),
        format!(
            "{} OPEN BUY 10@100.00 fee=0.00 delta=-1000.00 ENTRY",
            date(2)
        )
    );
    // The open trade is on the current basis: 20 shares at 50.
    assert_dec(&out.trades()[0]["quantity"], "20");
    assert_dec(&out.trades()[0]["entry_price"], "50");
    assert_eq!(out.trades()[0]["exit_reason"], "OPEN_AT_END");
}

#[test]
fn a_scheduled_stop_is_converted_then_activated_on_the_new_basis() {
    // Break-even fires at the S3 close (high 105 >= 100 + 4): stop 100 scheduled for S4.
    let out = held_across_split(true).evaluate();
    let before = &out.daily_of(3)["positions"][0];
    assert_dec(&before["scheduled_stop"]["level"], "100");
    assert_eq!(
        before["scheduled_stop"]["effective_session"],
        date(4).as_str()
    );
    assert_dec(&before["stop"], "92");

    // At the S4 before-open phase the split converts 100 to 50 and 92 to 46, then the scheduled
    // stop replaces the active one: stop 50. An unconverted 100 would be above the S4 open 51
    // and force an immediate gap exit; instead the position survives.
    let after = &out.daily_of(4)["positions"][0];
    assert_dec(&after["stop"], "50");
    assert_dec(&after["target"], "60");
    assert!(after.get("scheduled_stop").is_none());
    assert_eq!(out.fills().len(), 1, "no exit at S4");
}

#[test]
fn a_scheduled_level_still_waiting_is_divided_by_the_ratio() {
    // A checkpoint taken at the S3 close whose scheduled stop is effective two sessions later:
    // the split at S4 must divide the waiting level (100 -> 50) and keep it scheduled.
    let scenario = held_across_split(true);
    let run = scenario.run();
    let state = state_after(&run, event_index(&run, 3, "AFTER_CLOSE") + 1);
    let mut value = to_value(&run.checkpoint(&state).unwrap()).unwrap();
    value["state"]["positions"][0]["scheduled_stop"]["effective_session"] = date(5).into();
    let checkpoint = openquant_contracts::parse_value(value).unwrap();
    let restored = run.restore(&checkpoint).unwrap();
    let (end, failure) = run.run_to_end(restored);
    assert!(failure.is_none());
    let result = to_value(&run.result(&end, None).unwrap()).unwrap();
    let s4 = result["journal"]["daily"]
        .as_array()
        .unwrap()
        .iter()
        .find(|d| d["session"] == date(4).as_str())
        .unwrap();
    let position = &s4["positions"][0];
    assert_dec(&position["stop"], "46");
    assert_dec(&position["scheduled_stop"]["level"], "50");
    assert_eq!(
        position["scheduled_stop"]["effective_session"],
        date(5).as_str()
    );
}

#[test]
fn a_split_converts_the_pending_entry_snapshot_but_not_its_cap_or_rank() {
    // S1 signals with ATR 4 and reserves cap 1000.00. The 2-for-1 split is effective at S2,
    // whose raw open is 50: q = 1000 / 50 = 20, ATR 4 -> 2, stop 50 - 2 * 2 = 46, target
    // 50 + 5 * 2 = 60.
    let scenario = Scenario::new(vec![
        quiet_bar("100", "101", "99", "100"),
        signal_bar("100", "104", "100", "102"),
        quiet_bar("50", "52", "49", "51"),
        quiet_bar("51", "52", "50", "51"),
    ])
    .split("SPLIT1", 2, 2, 1);
    let out = scenario.evaluate();
    assert_eq!(out.status(), "COMPLETED");
    assert_eq!(
        fill_row(&out.fills()[0]),
        format!(
            "{} OPEN BUY 20@50.00 fee=0.00 delta=-1000.00 ENTRY",
            date(2)
        )
    );
    let position = &out.daily_of(2)["positions"][0];
    assert_dec(&position["quantity"], "20");
    assert_dec(&position["snapshots"][0]["value"], "2");
    assert_dec(&position["stop"], "46");
    assert_dec(&position["target"], "60");
    assert_dec(&out.entries()[0]["cap"], "1000.00");
    assert_dec(&out.entries()[0]["rank"], "1");

    // The pending entry as it stands after the before-open phase of the ex-date.
    let run = scenario.run();
    let state = state_after(&run, event_index(&run, 2, "OPEN"));
    let checkpoint = to_value(&run.checkpoint(&state).unwrap()).unwrap();
    let pending = &checkpoint["state"]["pending_entries"][0];
    assert_dec(&pending["snapshots"][0]["value"], "2");
    assert_dec(&pending["cap"], "1000.00");
    assert_dec(&pending["rank"], "1");
    assert_dec(&checkpoint["state"]["cash_reserved"], "1000.00");
}

#[test]
fn snapshots_convert_by_unit_across_a_split() {
    // Extra snapshots at the S1 signal: volume 2000 (SHARES), close 102 (PRICE), constants
    // 3 (RATIO) and 7 (POINTS). A 2-for-1 split: SHARES x2, PRICE /2, RATIO and POINTS unchanged.
    let scenario = Scenario::new(vec![
        quiet_bar("100", "101", "99", "100"),
        signal_bar("100", "104", "100", "102"),
        quiet_bar("50", "52", "49", "51"),
        quiet_bar("51", "52", "50", "51"),
    ])
    .snapshot("vol", "SHARES", "volume")
    .snapshot("px", "PRICE", "close")
    .snapshot("k", "RATIO", "3")
    .snapshot("pts", "POINTS", "7")
    .split("SPLIT1", 2, 2, 1);
    let run = scenario.run();

    // Pending, before the open: values on the new basis.
    let state = state_after(&run, event_index(&run, 2, "OPEN"));
    let checkpoint = to_value(&run.checkpoint(&state).unwrap()).unwrap();
    let names_and_values: Vec<(String, String)> =
        checkpoint["state"]["pending_entries"][0]["snapshots"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| {
                (
                    s["name"].as_str().unwrap().to_owned(),
                    s["value"].as_str().unwrap().to_owned(),
                )
            })
            .collect();
    let expected = [
        ("entry_atr", "2"),
        ("vol", "4000"),
        ("px", "51"),
        ("k", "3"),
        ("pts", "7"),
    ];
    assert_eq!(names_and_values.len(), expected.len());
    for ((name, value), (want_name, want_value)) in names_and_values.iter().zip(expected) {
        assert_eq!(name, want_name);
        assert_eq!(
            value.parse::<Decimal>().unwrap(),
            want_value.parse::<Decimal>().unwrap()
        );
    }

    // The filled position carries the same values.
    let out = scenario.evaluate();
    let snapshots = out.daily_of(2)["positions"][0]["snapshots"]
        .as_array()
        .unwrap();
    assert_eq!(snapshots.len(), 5);
    assert_dec(&snapshots[1]["value"], "4000");
}

#[test]
fn a_held_position_converts_snapshots_by_unit_too() {
    // Position opened at S2 from the S1 signal (volume 2000, close 102), split at S4.
    let out = held_across_split(false)
        .snapshot("vol", "SHARES", "volume")
        .snapshot("px", "PRICE", "close")
        .snapshot("k", "RATIO", "3")
        .evaluate();
    let before = out.daily_of(3)["positions"][0]["snapshots"]
        .as_array()
        .unwrap()
        .clone();
    let after = out.daily_of(4)["positions"][0]["snapshots"]
        .as_array()
        .unwrap()
        .clone();
    // vol 2000 -> 4000, px 102 -> 51, k 3 -> 3.
    assert_dec(&before[1]["value"], "2000");
    assert_dec(&after[1]["value"], "4000");
    assert_dec(&before[2]["value"], "102");
    assert_dec(&after[2]["value"], "51");
    assert_dec(&before[3]["value"], "3");
    assert_dec(&after[3]["value"], "3");
}

#[test]
fn a_three_for_two_split_keeps_value_and_floors_the_converted_stop_when_sold() {
    // 10 shares at 100 (stop 92, target 120). 3-for-2 at S4: 10 * 3 / 2 = 15 shares; levels
    // multiply by 2/3: entry 66.666..., stop 61.333... (= 184/3), target 80.
    // S4 raw bar: low 61.30 <= 61.333...: the stop fills at floor to the price scale, 61.33.
    // 15 * 61.33 = 919.95; cash 4000.00 + 919.95 = 4919.95.
    let out = Scenario::new(vec![
        quiet_bar("100", "101", "99", "100"),
        signal_bar("100", "104", "100", "102"),
        quiet_bar("100", "103", "99", "101"),
        quiet_bar("102", "105", "101", "103"),
        quiet_bar("68", "70", "61.30", "65"),
    ])
    .split("SPLIT1", 4, 3, 2)
    .evaluate();
    assert_eq!(out.status(), "COMPLETED");
    assert_eq!(
        fill_row(&out.fills()[1]),
        format!(
            "{} DURING_SESSION SELL 15@61.33 fee=0.00 delta=919.95 STOP",
            date(4)
        )
    );
    assert_dec(&out.daily_of(4)["cash_available"], "4919.95");
}

#[test]
fn a_non_terminating_conversion_keeps_the_position_value_on_the_money_grid() {
    // After a 3-for-2 split the mark 103 becomes 68.666... and 15 * 68.666... is 1030.00 up to a
    // 28-digit rounding error. The valuation must be exactly 1030.00, equity 5030.00.
    let scenario = Scenario::new(vec![
        quiet_bar("100", "101", "99", "100"),
        signal_bar("100", "104", "100", "102"),
        quiet_bar("100", "103", "99", "101"),
        quiet_bar("102", "105", "101", "103"),
        quiet_bar("68", "70", "61.30", "65"),
    ])
    .split("SPLIT1", 4, 3, 2);
    let run = scenario.run();
    let state = state_after(&run, event_index(&run, 4, "OPEN"));
    assert_eq!(state.positions[0].quantity, Decimal::from(15));
    let result = to_value(&run.result(&state, None).unwrap()).unwrap();
    assert_dec(&result["final"]["positions_value"], "1030.00");
    assert_dec(&result["final"]["equity"], "5030.00");
    // The converted stop is exactly 184/3: a level is never rounded to 28 digits.
    assert_eq!(state.positions[0].stop, Ratio::new(184, 3).unwrap());
}

#[test]
fn a_reverse_split_divides_the_quantity_and_multiplies_the_prices() {
    // 1-for-2 at S4: 10 shares -> 5, entry 100 -> 200, stop 92 -> 184, target 120 -> 240,
    // ATR 4 -> 8.
    let out = Scenario::new(vec![
        quiet_bar("100", "101", "99", "100"),
        signal_bar("100", "104", "100", "102"),
        quiet_bar("100", "103", "99", "101"),
        quiet_bar("102", "105", "101", "103"),
        quiet_bar("204", "210", "200", "205"),
    ])
    .split("REVERSE1", 4, 1, 2)
    .evaluate();
    assert_eq!(out.status(), "COMPLETED");
    let position = &out.daily_of(4)["positions"][0];
    assert_dec(&position["quantity"], "5");
    assert_dec(&position["entry_price"], "200");
    assert_dec(&position["stop"], "184");
    assert_dec(&position["target"], "240");
    assert_dec(&position["snapshots"][0]["value"], "8");
    // 5 * 205 = 1025.00.
    assert_dec(&out.daily_of(4)["positions_value"], "1025.00");
}

#[test]
fn a_split_without_a_position_changes_nothing_but_is_recorded() {
    let out = Scenario::new(vec![
        quiet_bar("100", "101", "99", "100"),
        quiet_bar("100", "101", "99", "100"),
        quiet_bar("50", "51", "49", "50"),
    ])
    .split("SPLIT1", 2, 2, 1)
    .evaluate();
    assert_eq!(out.status(), "COMPLETED");
    assert_eq!(out.len("/journal/corporate_actions"), 1);
    assert_dec(out.at("/final/cash_available"), "5000.00");
    assert!(out.state.positions.is_empty());
}

#[test]
fn a_split_effective_after_the_last_session_is_not_applied() {
    let mut scenario = Scenario::new(vec![
        quiet_bar("100", "101", "99", "100"),
        quiet_bar("100", "101", "99", "100"),
        quiet_bar("100", "101", "99", "100"),
        quiet_bar("50", "51", "49", "50"),
    ])
    .split("LATE", 3, 2, 1);
    scenario.last = 2;
    let out = scenario.evaluate();
    assert_eq!(out.status(), "COMPLETED");
    assert_eq!(out.len("/journal/corporate_actions"), 0);
    assert!(out.state.applied.is_empty());
}

#[test]
fn signals_use_the_causal_split_adjusted_series() {
    // Indicators: previous close and previous volume, both lagged one session. The split is
    // effective at S4 (2-for-1).
    //  S3 close (before the split is effective): lag(close) = S2 close 101, lag(volume) = 1000,
    //    nothing adjusted yet because the split is a future action.
    //  S4 close: lag(close) = S3 close 103 / 2 = 51.5 and lag(volume) = S3 volume 1000 * 2 = 2000.
    let out = Scenario::new(vec![
        quiet_bar("100", "101", "99", "100"),
        signal_bar("100", "104", "100", "102"),
        quiet_bar("100", "103", "99", "101"),
        quiet_bar("102", "105", "101", "103"),
        quiet_bar("51", "53", "50.5", "52"),
        quiet_bar("52", "54", "51", "53"),
    ])
    .indicator("prev_close", "lag_close")
    .indicator("prev_volume", "lag_volume")
    .split("SPLIT1", 4, 2, 1)
    .evaluate();
    let indicator = |index: usize, name: &str| -> serde_json::Value {
        out.signal_of(index)["indicators"]
            .as_array()
            .unwrap()
            .iter()
            .find(|i| i["name"] == name)
            .unwrap()["value"]
            .clone()
    };
    assert_dec(&indicator(3, "prev_close"), "101");
    assert_dec(&indicator(3, "prev_volume"), "1000");
    assert_dec(&indicator(4, "prev_close"), "51.5");
    assert_dec(&indicator(4, "prev_volume"), "2000");
}

#[test]
fn dividends_never_adjust_the_signal_prices() {
    // The same lagged close at S4 with a dividend instead of a split stays at the raw 103.
    let out = Scenario::new(vec![
        quiet_bar("100", "101", "99", "100"),
        signal_bar("100", "104", "100", "102"),
        quiet_bar("100", "103", "99", "101"),
        quiet_bar("102", "105", "101", "103"),
        quiet_bar("101", "103", "100", "102"),
        quiet_bar("102", "104", "101", "103"),
    ])
    .indicator("prev_close", "lag_close")
    .dividend("DIV1", 4, "1.00", 5, "OPEN")
    .evaluate();
    let value = out.signal_of(4)["indicators"]
        .as_array()
        .unwrap()
        .iter()
        .find(|i| i["name"] == "prev_close")
        .unwrap()["value"]
        .clone();
    assert_dec(&value, "103");
}

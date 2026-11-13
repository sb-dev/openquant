//! Entry timing, sizing, fees, lots, reservations and skipped entries (OQ-02 sections 2.4-2.5).
//!
//! Every expected number below is derived by hand in the comment above the assertion. The tests
//! never call the engine to produce an expected value.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

mod execution_support;

use execution_support::*;

/// Capital 5000.00, five slots, lot 1, fee 1.00 + 10 bps, stop = entry - 2 ATR, target =
/// entry + 5 ATR. The signal bar S1 has ATR(1) = max(54 - 50, |54 - 50|, |50 - 50|) = 4.
fn x01() -> Scenario {
    Scenario::new(vec![
        quiet_bar("50", "51", "49", "50"),  // S0 close 50
        signal_bar("50", "54", "50", "52"), // S1 signals, ATR 4
        quiet_bar("50", "53", "49", "51"),  // S2 entry at open 50
        quiet_bar("51", "52", "50", "51"),  // S3 last session
    ])
    .fees("1.00", "10")
}

#[test]
fn entry_fills_at_next_open_never_at_the_signal_close() {
    let out = x01().evaluate();
    assert_eq!(out.status(), "COMPLETED");

    // cap = floor(5000.00 / 5) = 1000.00 reserved at the S1 close.
    // q = 20: notional 1000.00, fee ceil(1.00 + 1000.00 * 10 / 10000) = 2.00, total 1002.00 > 1000.00.
    // q = 19: notional 950.00, fee ceil(1.00 + 0.95) = 1.95, total 951.95 <= 1000.00.
    assert_eq!(out.fills().len(), 1);
    assert_eq!(
        fill_row(&out.fills()[0]),
        format!("{} OPEN BUY 19@50.00 fee=1.95 delta=-951.95 ENTRY", date(2))
    );
    // The signal close was 52.00; no fill happens in the signal session.
    assert!(out.fills().iter().all(|f| f["session"] != date(1).as_str()));

    // available: 5000.00 - 1000.00 = 4000.00 -> release -> 5000.00 -> debit 951.95 = 4048.05.
    let ledger: Vec<String> = out.ledger().iter().map(ledger_row).collect();
    assert_eq!(
        ledger,
        vec![
            format!(
                "{} AFTER_CLOSE RESERVE 1000.00 avail=4000.00 reserved=1000.00 recv=0.00",
                date(1)
            ),
            format!(
                "{} OPEN RELEASE 1000.00 avail=5000.00 reserved=0.00 recv=0.00",
                date(2)
            ),
            format!(
                "{} OPEN FILL_BUY 951.95 avail=4048.05 reserved=0.00 recv=0.00",
                date(2)
            ),
        ]
    );

    // Sequence numbers: RESERVE 0, RELEASE 1, BUY fill 2, FILL_BUY 3.
    assert_eq!(out.fills()[0]["seq"], 2);
    assert_eq!(out.ledger()[0]["seq"], 0);
    assert_eq!(out.ledger()[2]["seq"], 3);

    // The reservation is visible at the signal close: cash 4000.00 + 1000.00 reserved, no position.
    let s1 = out.daily_of(1);
    assert_dec(&s1["cash_available"], "4000.00");
    assert_dec(&s1["cash_reserved"], "1000.00");
    assert_dec(&s1["positions_value"], "0");
    assert_dec(&s1["equity"], "5000.00");
    assert!(s1["positions"].as_array().unwrap().is_empty());

    // S2 close 51: 19 * 51 = 969.00; equity 4048.05 + 969.00 = 5017.05.
    let s2 = out.daily_of(2);
    assert_dec(&s2["cash_available"], "4048.05");
    assert_dec(&s2["cash_reserved"], "0");
    assert_dec(&s2["positions_value"], "969.00");
    assert_dec(&s2["equity"], "5017.05");

    // Levels use the signal-session ATR 4: stop 50 - 8 = 42, target 50 + 20 = 70.
    let position = &s2["positions"][0];
    assert_dec(&position["quantity"], "19");
    assert_dec(&position["entry_price"], "50");
    assert_dec(&position["stop"], "42");
    assert_dec(&position["target"], "70");
    assert_dec(&position["snapshots"][0]["value"], "4");
}

#[test]
fn entry_record_states_cap_quantity_price_and_fee() {
    let out = x01().evaluate();
    let entry = &out.entries()[0];
    assert_eq!(entry["intent_id"], format!("I-{}-SYN", date(1)).as_str());
    assert_eq!(entry["signal_session"], date(1).as_str());
    assert_dec(&entry["cap"], "1000.00");
    assert_eq!(entry["status"], "FILLED");
    assert_dec(&entry["quantity"], "19");
    assert_dec(&entry["fill_price"], "50");
    assert_dec(&entry["fee"], "1.95");
    assert_eq!(out.entries().len(), 1);
}

#[test]
fn signal_decisions_follow_the_declared_order() {
    let out = x01().evaluate();
    // S0 is warm-up: scored from S1.
    assert_eq!(out.signal_of(0)["skip_reason"], "NOT_SCORED_YET");
    assert_eq!(out.signal_of(0)["decision"], "SKIPPED");
    // S1: condition TRUE, not held, a vacant slot, rank and ATR available, cap > 0: ENTER.
    assert_eq!(out.signal_of(1)["condition"], "TRUE");
    assert_eq!(out.signal_of(1)["decision"], "ENTER");
    // S2: volume 1000 is not above 1000: the condition is FALSE even though a position is held.
    assert_eq!(out.signal_of(2)["condition"], "FALSE");
    assert_eq!(out.signal_of(2)["decision"], "NO_ENTRY");
    // S3 is the last processed session: no next session to fill in.
    assert_eq!(out.signal_of(3)["decision"], "SKIPPED");
    assert_eq!(out.signal_of(3)["skip_reason"], "NO_NEXT_SESSION");
}

#[test]
fn a_true_condition_while_holding_is_skipped_as_held() {
    // S1 signals, S2 fills at the open and also signals (volume 2000): held.
    // S3 is quiet; S4 is the last session.
    let out = Scenario::new(vec![
        quiet_bar("50", "51", "49", "50"),
        signal_bar("50", "54", "50", "52"),
        signal_bar("50", "53", "49", "51"),
        quiet_bar("51", "52", "50", "51"),
        quiet_bar("51", "52", "50", "51"),
    ])
    .evaluate();
    assert_eq!(out.signal_of(2)["condition"], "TRUE");
    assert_eq!(out.signal_of(2)["decision"], "SKIPPED");
    assert_eq!(out.signal_of(2)["skip_reason"], "HELD");
    // Only one entry was ever reserved: no second intent while holding.
    assert_eq!(out.entries().len(), 1);
}

#[test]
fn indicator_unavailable_is_skipped_when_the_atr_is_not_ready() {
    // Scoring starts at S0. ATR(1) needs a previous close, which S0 does not have, while the
    // volume condition itself is TRUE: INDICATOR_UNAVAILABLE.
    let out = Scenario::new(vec![
        signal_bar("50", "54", "50", "52"),
        signal_bar("52", "56", "52", "54"),
        quiet_bar("54", "55", "53", "54"),
    ])
    .scored_from(0)
    .evaluate();
    assert_eq!(out.signal_of(0)["condition"], "TRUE");
    assert_eq!(out.signal_of(0)["decision"], "SKIPPED");
    assert_eq!(out.signal_of(0)["skip_reason"], "INDICATOR_UNAVAILABLE");
    // No reservation was made for S0: the first ledger line belongs to the S1 signal.
    assert_eq!(out.ledger()[0]["session"], date(1).as_str());
    assert_eq!(out.ledger()[0]["kind"], "RESERVE");
    assert_eq!(out.signal_of(1)["decision"], "ENTER");
}

#[test]
fn cap_below_one_lot_at_the_close_is_skipped_before_reserving() {
    // Capital 0.04 over five slots: floor(0.04 / 5) = floor(0.008) = 0.00 -> CAP_BELOW_ONE_LOT.
    let out = x01().capital("0.04").evaluate();
    assert_eq!(out.signal_of(1)["decision"], "SKIPPED");
    assert_eq!(out.signal_of(1)["skip_reason"], "CAP_BELOW_ONE_LOT");
    assert!(out.entries().is_empty());
    assert!(out.ledger().is_empty());
    assert!(out.fills().is_empty());
}

#[test]
fn only_the_scored_last_session_reports_no_next_session() {
    // Scored window of one session (S3 = last). S0-S2 are NOT_SCORED_YET, S3 NO_NEXT_SESSION.
    let out = x01().scored_from(3).evaluate();
    for index in 0..3 {
        assert_eq!(out.signal_of(index)["skip_reason"], "NOT_SCORED_YET");
    }
    assert_eq!(out.signal_of(3)["skip_reason"], "NO_NEXT_SESSION");
    assert!(out.fills().is_empty());
}

/// Zero costs, capital 5000.00 (cap 1000.00), entry open 30, signal ATR 4.
fn lot_scenario(lot: &str) -> Scenario {
    Scenario::new(vec![
        quiet_bar("30", "31", "29", "30"),
        signal_bar("30", "34", "30", "32"),
        quiet_bar("30", "33", "29", "31"),
    ])
    .lot(lot)
}

#[test]
fn lot_rounding_rounds_the_quantity_down_to_a_lot_multiple() {
    // 1000.00 / 30 = 33.33...
    for (lot, quantity, notional, cash) in [
        ("1", "33", "990.00", "4010.00"),  // 33 * 30
        ("10", "30", "900.00", "4100.00"), // 3 lots of 10
        ("7", "28", "840.00", "4160.00"),  // 4 lots of 7
    ] {
        let out = lot_scenario(lot).evaluate();
        assert_eq!(out.status(), "COMPLETED", "lot {lot}");
        assert_eq!(out.fills().len(), 1, "lot {lot}");
        assert_dec(&out.fills()[0]["quantity"], quantity);
        assert_dec(&out.fills()[0]["notional"], notional);
        assert_dec(&out.fills()[0]["cash_delta"], &format!("-{notional}"));
        assert_dec(&out.daily_of(2)["cash_available"], cash);
    }
}

#[test]
fn a_cap_below_one_lot_skips_the_entry_and_releases_the_reservation() {
    // Lot 100 costs 3000.00 at the open 30, above the cap 1000.00.
    let out = lot_scenario("100").evaluate();
    assert_eq!(out.status(), "COMPLETED");
    assert!(out.fills().is_empty());
    assert_eq!(out.entries()[0]["status"], "SKIPPED");
    assert_eq!(out.entries()[0]["reason"], "CAP_BELOW_ONE_LOT");
    let ledger: Vec<String> = out.ledger().iter().map(ledger_row).collect();
    assert_eq!(
        ledger,
        vec![
            format!(
                "{} AFTER_CLOSE RESERVE 1000.00 avail=4000.00 reserved=1000.00 recv=0.00",
                date(1)
            ),
            format!(
                "{} OPEN RELEASE 1000.00 avail=5000.00 reserved=0.00 recv=0.00",
                date(2)
            ),
        ]
    );
    // No position and no backfill: the cash is whole again.
    assert_dec(&out.daily_of(2)["cash_available"], "5000.00");
    assert_dec(&out.daily_of(2)["equity"], "5000.00");
    assert!(out.daily_of(2)["positions"].as_array().unwrap().is_empty());
}

#[test]
fn the_fee_rounds_up_to_the_money_scale() {
    // Capital 5000.00 -> cap 1000.00. Open 32.07, fee 15 bps, no fixed fee.
    // q = 31: notional 31 * 32.07 = 994.17; fee 994.17 * 0.0015 = 1.491255 -> ceil 1.50
    // (half-up would give 1.49); total 995.67 <= 1000.00.
    // q = 32: notional 1026.24 > 1000.00.
    let out = Scenario::new(vec![
        quiet_bar("32.07", "33", "31", "32.07"),
        signal_bar("32.07", "36.07", "32.07", "34"),
        quiet_bar("32.07", "35", "31", "33"),
    ])
    .fees("0.00", "15")
    .evaluate();
    assert_eq!(
        fill_row(&out.fills()[0]),
        format!("{} OPEN BUY 31@32.07 fee=1.50 delta=-995.67 ENTRY", date(2))
    );
    // 5000.00 - 995.67 = 4004.33
    assert_dec(&out.daily_of(2)["cash_available"], "4004.33");
}

#[test]
fn a_fixed_fee_alone_can_remove_a_whole_lot() {
    // Cap 1000.00, open 50, fixed fee 1.00, no bps: 20 shares cost 1001.00 > 1000.00,
    // so 19 shares (950.00 + 1.00 = 951.00) are bought.
    let out = Scenario::new(vec![
        quiet_bar("50", "51", "49", "50"),
        signal_bar("50", "54", "50", "52"),
        quiet_bar("50", "53", "49", "51"),
    ])
    .fees("1.00", "0")
    .evaluate();
    assert_dec(&out.fills()[0]["quantity"], "19");
    assert_dec(&out.fills()[0]["cash_delta"], "-951.00");
}

#[test]
fn a_cap_that_fits_exactly_buys_the_full_quantity() {
    // Cap 1000.00, open 50, zero costs: 1000.00 / 50 = 20 exactly; the boundary fits.
    let out = Scenario::new(vec![
        quiet_bar("50", "51", "49", "50"),
        signal_bar("50", "54", "50", "52"),
        quiet_bar("50", "53", "49", "51"),
    ])
    .evaluate();
    assert_dec(&out.fills()[0]["quantity"], "20");
    assert_dec(&out.daily_of(2)["cash_available"], "4000.00");
}

#[test]
fn the_cap_is_the_floor_of_cash_over_vacant_slots_on_the_money_grid() {
    // Capital 100.00 over three slots: 33.333... floors to 33.33, not 33.34.
    // Open 10 (ATR 1: stop 8, target 15): 33.33 / 10 -> 3 shares = 30.00.
    // Cash: 100.00 - 33.33 = 66.67 reserved; release -> 100.00; debit 30.00 -> 70.00.
    let mut scenario = Scenario::new(vec![
        quiet_bar("10", "11", "10", "10"),
        signal_bar("10", "11", "10", "10"),
        quiet_bar("10", "11", "10", "10"),
    ])
    .capital("100.00");
    scenario.strategy.slots = 3;
    let out = scenario.evaluate();
    assert_eq!(out.status(), "COMPLETED");
    assert_dec(&out.entries()[0]["cap"], "33.33");
    assert_dec(&out.ledger()[0]["amount"], "33.33");
    assert_dec(&out.ledger()[0]["available_after"], "66.67");
    assert_dec(&out.fills()[0]["quantity"], "3");
    assert_dec(&out.daily_of(2)["cash_available"], "70.00");
}

#[test]
fn released_cash_is_reused_by_the_next_close_decision() {
    // S1 reserves cap 1000.00; the S2 open is 1500, above the cap: skipped, released. The S2
    // close signals again: cap = floor(5000.00 / 5) = 1000.00 from the whole released cash.
    // S3 open 40: 1000.00 / 40 = 25 shares, notional 1000.00.
    // S2 ATR(1) = max(1504 - 1500, |1504 - 1498|, |1500 - 1498|) = 6: stop 28, target 70.
    let out = Scenario::new(vec![
        quiet_bar("1498", "1500", "1496", "1498"),
        signal_bar("1498", "1502", "1498", "1498"),
        signal_bar("1500", "1504", "1500", "1502"),
        quiet_bar("40", "45", "38", "42"),
    ])
    .evaluate();
    assert_eq!(out.status(), "COMPLETED");
    assert_eq!(out.entries().len(), 2);
    assert_eq!(out.entries()[0]["status"], "SKIPPED");
    assert_eq!(out.entries()[0]["reason"], "CAP_BELOW_ONE_LOT");
    assert_eq!(out.entries()[1]["status"], "FILLED");
    assert_dec(&out.entries()[1]["cap"], "1000.00");
    assert_eq!(out.fills().len(), 1);
    assert_eq!(
        fill_row(&out.fills()[0]),
        format!(
            "{} OPEN BUY 25@40.00 fee=0.00 delta=-1000.00 ENTRY",
            date(3)
        )
    );
    assert_dec(&out.daily_of(3)["cash_available"], "4000.00");
    let position = &out.daily_of(3)["positions"][0];
    assert_dec(&position["stop"], "28");
    assert_dec(&position["target"], "70");
}

#[test]
fn a_re_entry_needs_a_fresh_close_decision_and_waits_for_the_next_open() {
    // Entry at the S2 open 50 (cap 1000.00, zero costs: 20 shares), stop 42, target 70.
    // S3: the target is touched (high 70): sold at 70.00 during S3. S3 is quiet (no signal),
    // so no re-entry. S4 signals; the re-entry fills at the S5 open, not at S4.
    let out = Scenario::new(vec![
        quiet_bar("50", "51", "49", "50"),  // S0
        signal_bar("50", "54", "50", "52"), // S1: ATR 4
        quiet_bar("50", "53", "49", "51"),  // S2: entry at 50
        quiet_bar("52", "70", "51", "60"),  // S3: target touched, quiet
        signal_bar("60", "64", "60", "62"), // S4: signal, ATR = max(4, |64-60|, 0) = 4
        quiet_bar("62", "63", "61", "62"),  // S5: re-entry at the open 62
        quiet_bar("62", "63", "61", "62"),  // S6
    ])
    .evaluate();
    let rows: Vec<String> = out.fills().iter().map(fill_row).collect();
    // Sale: 20 * 70 = 1400.00; cash 4000.00 + 1400.00 = 5400.00.
    // S4 cap = floor(5400.00 / 5) = 1080.00 -> 1080 / 62 = 17.4 -> 17 shares = 1054.00.
    assert_eq!(
        rows,
        vec![
            format!(
                "{} OPEN BUY 20@50.00 fee=0.00 delta=-1000.00 ENTRY",
                date(2)
            ),
            format!(
                "{} DURING_SESSION SELL 20@70.00 fee=0.00 delta=1400.00 TARGET",
                date(3)
            ),
            format!(
                "{} OPEN BUY 17@62.00 fee=0.00 delta=-1054.00 ENTRY",
                date(5)
            ),
        ]
    );
    // No fill in S4, the session of the fresh signal.
    assert!(out.fills().iter().all(|f| f["session"] != date(4).as_str()));
    // S3 daily: position closed, proceeds in available cash (5400.00), no reservation (quiet).
    assert_dec(&out.daily_of(3)["cash_available"], "5400.00");
}

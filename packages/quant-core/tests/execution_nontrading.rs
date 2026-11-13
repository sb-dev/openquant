//! Halts, missing bars, future data, invalid levels and failures that keep a partial journal
//! (OQ-02 sections 2.5 and 2.6, OQ-06 section 8 "Unplanned non-trading events" and "Invalid
//! inputs"). Every expected number is derived by hand beside its assertion.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

mod execution_support;

use execution_support::*;

#[test]
fn a_confirmed_halt_expires_the_pending_entry_and_releases_the_reservation() {
    // S1 signals (ATR 4): cap 1000.00 reserved. S2 is a confirmed halt known before the open:
    // no bar, no fill; the entry expires at the S2 open and the cap returns to cash.
    let out = Scenario::new(vec![
        quiet_bar("50", "51", "49", "50"),
        signal_bar("50", "54", "50", "52"),
        quiet_bar("0", "0", "0", "0"), // replaced by the halt
        quiet_bar("50", "52", "49", "51"),
        quiet_bar("51", "52", "50", "51"),
    ])
    .halt("HALT1", 2)
    .evaluate();
    assert_eq!(out.status(), "COMPLETED");
    assert!(out.fills().is_empty());
    assert_eq!(out.entries()[0]["status"], "EXPIRED");
    assert_eq!(out.entries()[0]["reason"], "EXPIRED_NON_TRADING");
    assert_dec(&out.entries()[0]["cap"], "1000.00");
    let rows: Vec<String> = out.ledger().iter().map(ledger_row).collect();
    assert_eq!(
        rows,
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
    // The halted session still has a daily record: whole cash, no position.
    let s2 = out.daily_of(2);
    assert_dec(&s2["cash_available"], "5000.00");
    assert_dec(&s2["equity"], "5000.00");
    // A non-trading session creates no signal.
    assert!(
        out.signals()
            .iter()
            .all(|s| s["session"] != date(2).as_str())
    );
}

#[test]
fn the_session_after_a_halt_has_no_previous_close_for_the_atr() {
    // S3 signals (volume 2000) but ATR(1) needs the S2 close, which does not exist: no value
    // is invented and the entry is skipped as unavailable.
    let out = Scenario::new(vec![
        quiet_bar("50", "51", "49", "50"),
        signal_bar("50", "54", "50", "52"),
        quiet_bar("0", "0", "0", "0"),
        signal_bar("50", "54", "50", "52"),
        quiet_bar("51", "52", "50", "51"),
    ])
    .halt("HALT1", 2)
    .evaluate();
    assert_eq!(out.signal_of(3)["decision"], "SKIPPED");
    assert_eq!(out.signal_of(3)["skip_reason"], "INDICATOR_UNAVAILABLE");
    assert_eq!(out.entries().len(), 1);
}

#[test]
fn a_halt_while_holding_makes_the_valuation_unsupported() {
    // 20 shares bought at the S2 open 50 (cap 1000.00). S4 is a confirmed halt: the held
    // position cannot be valued or settled, so the evidence is INSUFFICIENT at the S4 close.
    let out = Scenario::new(vec![
        quiet_bar("50", "51", "49", "50"),
        signal_bar("50", "54", "50", "52"),
        quiet_bar("50", "51", "49.5", "50"),
        quiet_bar("50", "52", "49", "51"),
        quiet_bar("0", "0", "0", "0"),
        quiet_bar("51", "52", "50", "51"),
    ])
    .halt("HALT1", 4)
    .evaluate();
    assert_eq!(out.status(), "INSUFFICIENT");
    assert_eq!(out.code(), "UNSUPPORTED_VALUATION");
    assert_eq!(out.at("/outcome/at/session"), date(4).as_str());
    assert_eq!(out.at("/outcome/at/phase"), "AFTER_CLOSE");
    // Daily records exist through S3 only; no liquidation price was invented.
    assert_eq!(out.daily().len(), 4);
    assert_eq!(out.fills().len(), 1);
    // Positions are carried at the last valid mark, the S3 close 51: 20 * 51 = 1020.00.
    assert_dec(out.at("/final/positions_value"), "1020.00");
    assert_dec(out.at("/final/equity"), "5020.00");
    assert_dec(out.at("/final/open_positions/0/quantity"), "20");
}

#[test]
fn a_held_position_does_not_exit_during_a_halted_session() {
    // The halted S4 has a stop-breaking context before it (S3 close 51 vs stop 42); nothing can
    // be sold in the halted session, so the only fill is the entry.
    let out = Scenario::new(vec![
        quiet_bar("50", "51", "49", "50"),
        signal_bar("50", "54", "50", "52"),
        quiet_bar("50", "51", "49.5", "50"),
        quiet_bar("50", "52", "49", "51"),
        quiet_bar("0", "0", "0", "0"),
    ])
    .halt("HALT1", 4)
    .evaluate();
    assert_eq!(out.fills().len(), 1);
    assert_eq!(out.trades()[0]["exit_reason"], "OPEN_AT_END");
}

#[test]
fn an_absent_bar_without_a_confirmed_halt_is_missing_data() {
    // S3 has no bar and no evidence: INSUFFICIENT at the S3 before-open phase.
    let out = Scenario::new(vec![
        quiet_bar("50", "51", "49", "50"),
        signal_bar("50", "54", "50", "52"),
        quiet_bar("50", "51", "49.5", "50"),
        quiet_bar("0", "0", "0", "0"),
        quiet_bar("51", "52", "50", "51"),
    ])
    .without_bar(3)
    .evaluate();
    assert_eq!(out.status(), "INSUFFICIENT");
    assert_eq!(out.code(), "MISSING_REQUIRED_BAR");
    assert_eq!(out.at("/outcome/at/session"), date(3).as_str());
    assert_eq!(out.at("/outcome/at/phase"), "BEFORE_OPEN");
    // The partial journal is kept: three sessions, the entry fill, and the open position.
    assert_eq!(out.daily().len(), 3);
    assert_eq!(out.fills().len(), 1);
    assert_dec(out.at("/final/open_positions/0/quantity"), "20");
    assert_dec(out.at("/final/cash_available"), "4000.00");
}

#[test]
fn halt_evidence_that_arrives_after_the_open_does_not_explain_the_missing_bar() {
    // The halt is dated for S3 but only available at 15:00, after the 14:30 open.
    let known = format!("{}T15:00:00Z", date(3));
    let out = Scenario::new(vec![
        quiet_bar("50", "51", "49", "50"),
        signal_bar("50", "54", "50", "52"),
        quiet_bar("50", "51", "49.5", "50"),
        quiet_bar("0", "0", "0", "0"),
        quiet_bar("51", "52", "50", "51"),
    ])
    .halt_known_at("HALT1", 3, &known)
    .evaluate();
    assert_eq!(out.status(), "INSUFFICIENT");
    assert_eq!(out.code(), "MISSING_REQUIRED_BAR");
}

#[test]
fn halt_evidence_available_exactly_at_the_open_confirms_the_halt() {
    let known = format!("{}T14:30:00Z", date(3));
    let out = Scenario::new(vec![
        quiet_bar("50", "51", "49", "50"),
        quiet_bar("50", "51", "49", "50"),
        quiet_bar("50", "51", "49", "50"),
        quiet_bar("0", "0", "0", "0"),
        quiet_bar("51", "52", "50", "51"),
    ])
    .halt_known_at("HALT1", 3, &known)
    .evaluate();
    assert_eq!(out.status(), "COMPLETED");
}

#[test]
fn a_bar_available_after_the_next_open_is_future_data() {
    // The S2 bar becomes available one second after the S3 open (14:30:00Z). The S2 close
    // decision cannot use it.
    let late = format!("{}T14:30:01Z", date(3));
    let out = Scenario::new(vec![
        quiet_bar("50", "51", "49", "50"),
        signal_bar("50", "54", "50", "52"),
        quiet_bar("50", "51", "49.5", "50"),
        quiet_bar("51", "52", "50", "51"),
    ])
    .with_available_at(2, &late)
    .evaluate();
    assert_eq!(out.status(), "FAILED");
    assert_eq!(out.code(), "FUTURE_DATA");
    assert_eq!(out.at("/outcome/at/session"), date(2).as_str());
    assert_eq!(out.at("/outcome/at/phase"), "AFTER_CLOSE");
    // Everything before the failing close is kept: the S0-S1 daily records, the reservation and
    // the entry fill at the S2 open.
    assert_eq!(out.daily().len(), 2);
    assert_eq!(out.fills().len(), 1);
    assert_dec(out.at("/final/cash_available"), "4000.00");
}

#[test]
fn a_bar_available_exactly_at_the_next_open_is_usable() {
    let at_open = format!("{}T14:30:00Z", date(3));
    let out = Scenario::new(vec![
        quiet_bar("50", "51", "49", "50"),
        signal_bar("50", "54", "50", "52"),
        quiet_bar("50", "51", "49.5", "50"),
        quiet_bar("51", "52", "50", "51"),
    ])
    .with_available_at(2, &at_open)
    .evaluate();
    assert_eq!(out.status(), "COMPLETED");
}

#[test]
fn levels_that_are_not_above_zero_fail_the_run_with_a_partial_journal() {
    // ATR 30 at the S1 signal: stop = 50 - 2 * 30 = -10 <= 0 at the S2 open.
    let out = Scenario::new(vec![
        quiet_bar("50", "51", "49", "50"),
        signal_bar("50", "80", "50", "60"),
        quiet_bar("50", "53", "49", "51"),
        quiet_bar("51", "52", "50", "51"),
    ])
    .evaluate();
    assert_eq!(out.status(), "FAILED");
    assert_eq!(out.code(), "INVALID_LEVEL");
    assert_eq!(out.at("/outcome/at/session"), date(2).as_str());
    assert_eq!(out.at("/outcome/at/phase"), "OPEN");
    // The journal keeps everything through the S1 close: two daily records, one reserved entry
    // and its reservation line. No fill happened.
    assert_eq!(out.daily().len(), 2);
    assert_eq!(out.signals().len(), 2);
    assert_eq!(out.entries().len(), 1);
    assert_eq!(out.entries()[0]["status"], "RESERVED");
    assert_eq!(out.ledger().len(), 1);
    assert!(out.fills().is_empty());
    assert_dec(out.at("/final/cash_reserved"), "1000.00");
    assert_dec(out.at("/final/cash_available"), "4000.00");
    assert!(out.at("/outcome/detail").as_str().unwrap().contains("stop"));
}

#[test]
fn a_stop_equal_to_the_entry_price_is_an_invalid_level() {
    let out = Scenario::new(vec![
        quiet_bar("50", "51", "49", "50"),
        signal_bar("50", "54", "50", "52"),
        quiet_bar("50", "53", "49", "51"),
    ])
    .multiples("0", "5")
    .evaluate();
    assert_eq!(out.code(), "INVALID_LEVEL");
}

#[test]
fn a_target_equal_to_the_entry_price_is_an_invalid_level() {
    let out = Scenario::new(vec![
        quiet_bar("50", "51", "49", "50"),
        signal_bar("50", "54", "50", "52"),
        quiet_bar("50", "53", "49", "51"),
    ])
    .multiples("2", "0")
    .evaluate();
    assert_eq!(out.code(), "INVALID_LEVEL");
}

#[test]
fn a_sale_whose_fee_would_leave_cash_negative_is_refused() {
    // Capital 1000.00 in one slot with a 900.00 fixed fee: at the open 50, budget 100.00 buys
    // 2 shares (100.00 + 900.00 = 1000.00), leaving cash 0.00. At the target 70 the sale is
    // 140.00 less a 900.00 fee: proceeds -760.00 would put cash at -760.00.
    let mut scenario = Scenario::new(vec![
        quiet_bar("50", "51", "49", "50"),
        signal_bar("50", "54", "50", "52"),
        quiet_bar("50", "51", "49.5", "50"),
        quiet_bar("50", "70", "49", "60"),
    ])
    .capital("1000.00")
    .fees("900.00", "0");
    scenario.strategy.slots = 1;
    let out = scenario.evaluate();
    assert_dec(&out.fills()[0]["quantity"], "2");
    assert_eq!(out.status(), "FAILED");
    assert_eq!(out.code(), "UNSUPPORTED_POLICY");
    assert_eq!(out.at("/outcome/at/session"), date(3).as_str());
    assert_eq!(out.at("/outcome/at/phase"), "DURING_SESSION");
    // Cash is whole: the refused sale changed nothing.
    assert_dec(out.at("/final/cash_available"), "0.00");
    assert_dec(out.at("/final/open_positions/0/quantity"), "2");
}

#[test]
fn a_failed_event_leaves_no_partial_effect_in_the_state() {
    // The INVALID_LEVEL failure occurs after the cap was released in no earlier step: the state
    // is exactly the state after the S1 close, with the cursor on the S2 open.
    let out = Scenario::new(vec![
        quiet_bar("50", "51", "49", "50"),
        signal_bar("50", "80", "50", "60"),
        quiet_bar("50", "53", "49", "51"),
    ])
    .evaluate();
    let next = out.state.next.as_ref().unwrap();
    assert_eq!(
        (next.session.clone(), next.phase.to_string()),
        (date(2), "OPEN".to_owned())
    );
    assert_eq!(out.state.pending.len(), 1);
}

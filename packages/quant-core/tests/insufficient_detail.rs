//! `INSUFFICIENT` outcomes name the instrument, the event, the missing evidence and the affected
//! period (OQ-02 section 2.5: "Report the instrument, event, missing evidence and affected
//! period"; OQ-06 section 8, "Unplanned non-trading events": INSUFFICIENT "with event details").
//!
//! The detail is free text, so the tests pin the facts a reader needs as substrings, not the
//! wording. The instrument is `ACME` throughout, so that it cannot be confused with the default
//! `SYN` of the builders. The scenarios are the ones of the outcome tests beside them.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

mod execution_support;

use execution_support::*;
use openquant_contracts::{EvaluationResult, parse};

fn assert_names(out: &Outcome, what: &[&str]) {
    let detail = out.text("/outcome/detail");
    for needle in what {
        assert!(detail.contains(needle), "`{needle}` is not in: {detail}");
    }
    assert!(detail.chars().count() <= 1000, "{detail}");
}

/// Seven sessions. Twenty shares are bought at the S2 open (50.00, cap 1000.00) and held. The
/// halted session is S4, and the scored window ends at S6.
fn held_through_a_halt() -> Scenario {
    let mut scenario = Scenario::new(vec![
        quiet_bar("50", "51", "49", "50"),
        signal_bar("50", "54", "50", "52"),
        quiet_bar("50", "51", "49.5", "50"),
        quiet_bar("50", "52", "49", "51"),
        quiet_bar("0", "0", "0", "0"),
        quiet_bar("51", "52", "50", "51"),
        quiet_bar("51", "52", "50", "51"),
    ]);
    scenario.instrument = "ACME".to_owned();
    scenario
}

#[test]
fn a_halt_while_holding_names_the_instrument_the_event_and_the_unvalued_period() {
    let out = held_through_a_halt().halt("HALT-1", 4).evaluate();
    assert_eq!(out.status(), "INSUFFICIENT");
    assert_eq!(out.code(), "UNSUPPORTED_VALUATION");
    // The instrument, the halt, the first unvalued session and the end of the scored window.
    assert_names(&out, &["ACME", "HALT-1", &date(4), &date(6)]);
}

#[test]
fn every_confirmed_halt_of_the_session_is_named_and_a_late_one_is_not() {
    let late = format!("{}T15:00:00Z", date(4));
    let out = held_through_a_halt()
        .halt("HALT-1", 4)
        .halt("HALT-2", 4)
        .halt_known_at("HALT-LATE", 4, &late)
        .evaluate();
    assert_eq!(out.code(), "UNSUPPORTED_VALUATION");
    assert_names(&out, &["ACME", "HALT-1", "HALT-2", &date(4), &date(6)]);
    // Halt evidence that arrived after the open confirms nothing and is not offered as a cause.
    assert!(!out.text("/outcome/detail").contains("HALT-LATE"));
}

#[test]
fn a_long_list_of_halts_is_cut_to_the_schema_limit_after_the_instrument_and_dates() {
    // Thirty-two halts with identifiers of 64 characters cannot all fit the 1000 characters the
    // result schema allows. The text is cut, stays valid, and keeps the instrument, the dates
    // and the first identifiers, because the identifiers come last.
    let mut scenario = held_through_a_halt();
    for i in 0..32 {
        scenario = scenario.halt(&format!("H{i:02}{}", "x".repeat(61)), 4);
    }
    let out = scenario.evaluate();
    assert_eq!(out.code(), "UNSUPPORTED_VALUATION");
    let first = format!("H00{}", "x".repeat(61));
    assert_names(&out, &["ACME", &date(4), &date(6), &first]);
    assert_eq!(out.text("/outcome/detail").len(), 1000);
    let parsed: EvaluationResult = parse(&out.text_of_result()).expect("a valid result");
    assert_eq!(parsed.outcome.detail.unwrap().len(), 1000);
}

#[test]
fn a_missing_bar_names_the_instrument_and_the_session() {
    let mut scenario = Scenario::new(vec![
        quiet_bar("50", "51", "49", "50"),
        signal_bar("50", "54", "50", "52"),
        quiet_bar("50", "51", "49.5", "50"),
        quiet_bar("0", "0", "0", "0"),
        quiet_bar("51", "52", "50", "51"),
    ])
    .without_bar(3);
    scenario.instrument = "ACME".to_owned();
    let out = scenario.evaluate();
    assert_eq!(out.status(), "INSUFFICIENT");
    assert_eq!(out.code(), "MISSING_REQUIRED_BAR");
    // The session with no bar, and the last session of the scored window (S4).
    assert_names(&out, &["ACME", &date(3), &date(4)]);
}

#[test]
fn a_missing_bar_with_late_halt_evidence_names_the_halt() {
    // The halt is dated for S3 but only available at 15:00, after the 14:30 open.
    let known = format!("{}T15:00:00Z", date(3));
    let mut scenario = Scenario::new(vec![
        quiet_bar("50", "51", "49", "50"),
        signal_bar("50", "54", "50", "52"),
        quiet_bar("50", "51", "49.5", "50"),
        quiet_bar("0", "0", "0", "0"),
        quiet_bar("51", "52", "50", "51"),
    ])
    .halt_known_at("HALT-1", 3, &known);
    scenario.instrument = "ACME".to_owned();
    let out = scenario.evaluate();
    assert_eq!(out.code(), "MISSING_REQUIRED_BAR");
    assert_names(&out, &["ACME", &date(3), "HALT-1"]);
}

/// Capital 3500.00 -> cap 700.00; seven shares are bought at the S2 open 100.
fn seven_shares() -> Scenario {
    let mut scenario = Scenario::new(vec![
        quiet_bar("100", "101", "99", "100"),
        signal_bar("100", "104", "100", "102"),
        quiet_bar("100", "103", "99", "101"),
        quiet_bar("102", "105", "101", "103"),
        quiet_bar("102", "105", "101", "103"),
        quiet_bar("102", "105", "101", "103"),
    ])
    .capital("3500.00");
    scenario.instrument = "ACME".to_owned();
    scenario
}

#[test]
fn an_unsupported_action_names_the_instrument_the_action_and_the_effective_session() {
    let out = seven_shares()
        .unsupported("ACT-1", "SPIN_OFF", 4)
        .evaluate();
    assert_eq!(out.status(), "INSUFFICIENT");
    assert_eq!(out.code(), "UNSUPPORTED_CORPORATE_ACTION");
    assert_names(&out, &["ACME", "ACT-1", &date(4), "SPIN_OFF", &date(5)]);
}

#[test]
fn a_fractional_split_names_the_instrument_the_action_and_the_effective_session() {
    // 3-for-2 on 7 shares leaves 10.5.
    let out = seven_shares().split("SPLIT-1", 4, 3, 2).evaluate();
    assert_eq!(out.status(), "INSUFFICIENT");
    assert_eq!(out.code(), "FRACTIONAL_ENTITLEMENT");
    assert_names(&out, &["ACME", "SPLIT-1", &date(4), "10.5", &date(5)]);
}

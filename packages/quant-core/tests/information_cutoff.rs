//! The information cutoff bounds every availability check (OQ-02 sections 2.5 and 3.3, OQ-06
//! section 8 "Invalid inputs"). The deadline of a decision is the earlier of the next open and the
//! cutoff. At the final session there is no next open, so the cutoff is the only deadline and the
//! check must still run. Every expected outcome is derived by hand beside its assertion.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

mod execution_support;

use execution_support::*;
use openquant_contracts::EvaluationInput;
use openquant_core::Run;
use serde_json::json;

/// Four sessions. The S1 close signals (volume above the threshold), the entry fills at the S2
/// open, and the last session is S3.
fn four_sessions() -> Scenario {
    Scenario::new(vec![
        quiet_bar("50", "51", "49", "50"),
        signal_bar("50", "54", "50", "52"),
        quiet_bar("50", "53", "49", "51"),
        quiet_bar("51", "52", "50", "51"),
    ])
}

#[test]
fn the_final_session_bar_must_be_available_by_the_cutoff() {
    // Cutoff 22:00 on S3. The S3 bar (the closing mark of the final valuation) becomes available
    // at 22:30. S3 has no next session, so only the cutoff bounds it.
    let cutoff = format!("{}T22:00:00Z", date(3));
    let late = format!("{}T22:30:00Z", date(3));
    let out = four_sessions()
        .information_cutoff(&cutoff)
        .with_available_at(3, &late)
        .evaluate();
    assert_eq!(out.status(), "FAILED");
    assert_eq!(out.code(), "FUTURE_DATA");
    assert_eq!(out.at("/outcome/at/session"), date(3).as_str());
    assert_eq!(out.at("/outcome/at/phase"), "AFTER_CLOSE");
    // The journal keeps the S0-S2 daily records. The S3 close was never recorded.
    assert_eq!(out.daily().len(), 3);
}

#[test]
fn a_final_bar_available_exactly_at_the_cutoff_is_accepted() {
    // The comparison is strict: available_at == cutoff is not after the cutoff.
    let cutoff = format!("{}T22:00:00Z", date(3));
    let out = four_sessions()
        .information_cutoff(&cutoff)
        .with_available_at(3, &cutoff)
        .evaluate();
    assert_eq!(out.status(), "COMPLETED");
    assert_eq!(out.daily().len(), 4);
}

#[test]
fn without_a_late_bar_the_final_session_completes_under_a_binding_cutoff() {
    // Control: the S3 bar closes at 21:00 and is available then. A cutoff of 22:00 does not
    // reject it.
    let cutoff = format!("{}T22:00:00Z", date(3));
    let out = four_sessions().information_cutoff(&cutoff).evaluate();
    assert_eq!(out.status(), "COMPLETED");
}

#[test]
fn a_cutoff_before_the_next_open_binds_the_decision() {
    // The S1 bar is available at 22:00 on S1, long before the S2 open (14:30). A deadline of the
    // next open alone would accept it. The cutoff is 21:30 on S1, so the deadline is 21:30 and the
    // bar is future data at the S1 close.
    let cutoff = format!("{}T21:30:00Z", date(1));
    let late = format!("{}T22:00:00Z", date(1));
    let out = four_sessions()
        .information_cutoff(&cutoff)
        .with_available_at(1, &late)
        .evaluate();
    assert_eq!(out.status(), "FAILED");
    assert_eq!(out.code(), "FUTURE_DATA");
    assert_eq!(out.at("/outcome/at/session"), date(1).as_str());
    assert_eq!(out.at("/outcome/at/phase"), "AFTER_CLOSE");
    // Control: the same bar is accepted when the cutoff is later than its availability.
    let ok = four_sessions().with_available_at(1, &late).evaluate();
    assert_eq!(ok.status(), "COMPLETED");
}

fn five_sessions() -> Scenario {
    Scenario::new(vec![
        quiet_bar("50", "51", "49", "50"),
        signal_bar("50", "54", "50", "52"),
        quiet_bar("50", "53", "49", "51"),
        quiet_bar("51", "52", "50", "51"),
        quiet_bar("51", "52", "50", "51"),
    ])
}

#[test]
fn an_action_available_after_the_cutoff_is_future_data_before_its_open() {
    // A 2-for-1 split is effective at S3 and available at 23:00 on S2, before the S3 open. The
    // cutoff is 22:00 on S2, so the action deadline (the earlier of the open and the cutoff) is
    // 22:00 and the split is future data at the S3 BEFORE_OPEN.
    let available = format!("{}T23:00:00Z", date(2));
    let cutoff = format!("{}T22:00:00Z", date(2));
    let out = five_sessions()
        .split("SPLIT1", 3, 2, 1)
        .action_available_at("SPLIT1", &available)
        .information_cutoff(&cutoff)
        .evaluate();
    assert_eq!(out.status(), "FAILED");
    assert_eq!(out.code(), "FUTURE_DATA");
    assert_eq!(out.at("/outcome/at/session"), date(3).as_str());
    assert_eq!(out.at("/outcome/at/phase"), "BEFORE_OPEN");
    // Control: without the cutoff the same action is accepted, because it precedes the open.
    let ok = five_sessions()
        .split("SPLIT1", 3, 2, 1)
        .action_available_at("SPLIT1", &available)
        .evaluate();
    assert_eq!(ok.status(), "COMPLETED");
}

#[test]
fn a_halt_known_only_after_the_cutoff_does_not_confirm_the_halt() {
    // The halt on S2 is known at 13:30 on S2, before the open. The cutoff is 23:00 on S1, earlier.
    // The halt is therefore not usable evidence, and S2 has no bar: the bar is required.
    let known = format!("{}T13:30:00Z", date(2));
    let cutoff = format!("{}T23:00:00Z", date(1));
    let out = five_sessions()
        .halt_known_at("HALT1", 2, &known)
        .information_cutoff(&cutoff)
        .evaluate();
    assert_eq!(out.status(), "INSUFFICIENT");
    assert_eq!(out.code(), "MISSING_REQUIRED_BAR");
    assert_eq!(out.at("/outcome/at/session"), date(2).as_str());
    assert_eq!(out.at("/outcome/at/phase"), "BEFORE_OPEN");
    // Control: with a later cutoff the same halt is confirmed and the session is non-trading.
    let ok = five_sessions().halt_known_at("HALT1", 2, &known).evaluate();
    assert_eq!(ok.status(), "COMPLETED");
}

#[test]
fn an_impossible_cutoff_instant_is_rejected_by_preparation() {
    // The schema accepts the shape; February 30 is not a real date.
    let scenario = four_sessions();
    let mut value = scenario.input_value();
    value["windows"]["information_cutoff"] = json!("2026-02-30T00:00:00Z");
    let input: EvaluationInput = serde_json::from_value(value).expect("typed payload");
    let failure = Run::prepare(&scenario.strategy_artefact(), &input).unwrap_err();
    assert_eq!(failure.code.to_string(), "INVALID_INPUT");
}

#[test]
fn the_cutoff_is_part_of_the_input_identity() {
    // Two inputs that differ only in the cutoff are different evidence: their input hashes differ.
    let a = four_sessions().run();
    let b = four_sessions()
        .information_cutoff("2099-01-01T00:00:00Z")
        .run();
    assert_ne!(a.input_hash, b.input_hash);
}

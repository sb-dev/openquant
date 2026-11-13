//! Corporate actions the policy cannot apply: unsupported kinds, fractional entitlements and
//! actions that are not yet available. Each produces an explicit outcome at the exact event,
//! keeps the journal through the last completed event and invents nothing (OQ-02 section 2.6).

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

mod execution_support;

use execution_support::*;

/// Capital 3500.00 -> cap 700.00; entry at the S2 open 100 buys 7 shares (700.00).
/// S1 ATR 4: stop 92, target 120. The action is effective at S4 on the new basis.
fn seven_shares() -> Scenario {
    Scenario::new(vec![
        quiet_bar("100", "101", "99", "100"),
        signal_bar("100", "104", "100", "102"),
        quiet_bar("100", "103", "99", "101"),
        quiet_bar("102", "105", "101", "103"),
        quiet_bar("102", "105", "101", "103"),
        quiet_bar("102", "105", "101", "103"),
    ])
    .capital("3500.00")
}

/// Replace the S4 and S5 bars, for tests whose split moves the price basis.
fn rebased(mut scenario: Scenario, bar: Bar) -> Scenario {
    scenario.bars[4] = Some(bar.clone());
    scenario.bars[5] = Some(bar);
    scenario
}

#[test]
fn unsupported_kinds_give_insufficient_evidence_at_the_ex_date_before_open() {
    for kind in ["SPECIAL_DISTRIBUTION", "SPIN_OFF", "MERGER"] {
        let out = seven_shares().unsupported("ACT1", kind, 4).evaluate();
        assert_eq!(out.status(), "INSUFFICIENT", "{kind}");
        assert_eq!(out.code(), "UNSUPPORTED_CORPORATE_ACTION", "{kind}");
        // The failing event is the ex-date before-open phase.
        assert_eq!(out.at("/outcome/at/session"), date(4).as_str());
        assert_eq!(out.at("/outcome/at/phase"), "BEFORE_OPEN");
        // The journal holds everything through the S3 close: four sessions of daily records,
        // the entry fill, and the open position (7 shares valued at the S3 close 103).
        assert_eq!(out.daily().len(), 4, "{kind}");
        assert_eq!(out.fills().len(), 1, "{kind}");
        assert_dec(out.at("/final/positions_value"), "721.00");
        assert_dec(out.at("/final/cash_available"), "2800.00");
        assert_dec(out.at("/final/equity"), "3521.00");
        // Nothing was applied or recorded for the action.
        assert!(out.state.applied.is_empty());
        assert_eq!(out.len("/journal/corporate_actions"), 0);
        let next = out.state.next.as_ref().unwrap();
        assert_eq!(
            (next.session.clone(), next.phase.to_string()),
            (date(4), "BEFORE_OPEN".to_owned())
        );
    }
}

#[test]
fn a_fractional_entitlement_gives_insufficient_evidence() {
    // 3-for-2 on 7 shares: 7 * 3 / 2 = 10.5 shares. No cash in lieu is declared.
    let out = seven_shares().split("SPLIT1", 4, 3, 2).evaluate();
    assert_eq!(out.status(), "INSUFFICIENT");
    assert_eq!(out.code(), "FRACTIONAL_ENTITLEMENT");
    assert_eq!(out.at("/outcome/at/session"), date(4).as_str());
    assert_eq!(out.at("/outcome/at/phase"), "BEFORE_OPEN");
    // The position is untouched: 7 shares at 100.
    assert_dec(out.at("/final/open_positions/0/quantity"), "7");
    assert_dec(out.at("/final/open_positions/0/entry_price"), "100");
    assert!(out.state.applied.is_empty());
}

#[test]
fn a_reverse_split_that_leaves_a_fraction_is_insufficient() {
    // 1-for-2 on 7 shares: 3.5 shares.
    let out = seven_shares().split("REVERSE1", 4, 1, 2).evaluate();
    assert_eq!(out.status(), "INSUFFICIENT");
    assert_eq!(out.code(), "FRACTIONAL_ENTITLEMENT");
}

#[test]
fn a_whole_entitlement_is_applied_without_rounding() {
    // Capital 4000.00 -> cap 800.00 -> 8 shares at 100. 3-for-2: 12 shares exactly.
    // Levels move to stop 92 * 2/3 = 61.33.., target 80; the S4 bar stays between them.
    let out = rebased(
        seven_shares().capital("4000.00").split("SPLIT1", 4, 3, 2),
        quiet_bar("68", "70", "67", "69"),
    )
    .evaluate();
    assert_eq!(out.status(), "COMPLETED");
    assert_dec(&out.daily_of(4)["positions"][0]["quantity"], "12");
}

#[test]
fn a_fractional_ratio_without_a_position_is_not_an_entitlement_problem() {
    // Nothing is held, so there is no fractional entitlement to refuse.
    let out = Scenario::new(vec![
        quiet_bar("100", "101", "99", "100"),
        quiet_bar("100", "101", "99", "100"),
        quiet_bar("100", "101", "99", "100"),
    ])
    .split("SPLIT1", 2, 3, 2)
    .evaluate();
    assert_eq!(out.status(), "COMPLETED");
}

#[test]
fn an_action_available_after_the_session_opens_is_future_data() {
    // The S4 session opens at 14:30:00Z. An action available one second later could not have
    // been known at the open.
    let late = format!("{}T14:30:01Z", date(4));
    let out = seven_shares()
        .capital("4000.00")
        .split("SPLIT1", 4, 2, 1)
        .action_available_at("SPLIT1", &late)
        .evaluate();
    assert_eq!(out.status(), "FAILED");
    assert_eq!(out.code(), "FUTURE_DATA");
    assert_eq!(out.at("/outcome/at/session"), date(4).as_str());
    assert_eq!(out.at("/outcome/at/phase"), "BEFORE_OPEN");
    assert_eq!(out.daily().len(), 4);
    assert_dec(out.at("/final/open_positions/0/quantity"), "8");
}

#[test]
fn an_action_available_exactly_at_the_open_is_applied() {
    let at_open = format!("{}T14:30:00Z", date(4));
    // 2-for-1: stop 46, target 60; the S4 bar stays between them.
    let out = rebased(
        seven_shares()
            .capital("4000.00")
            .split("SPLIT1", 4, 2, 1)
            .action_available_at("SPLIT1", &at_open),
        quiet_bar("51", "53", "50", "52"),
    )
    .evaluate();
    assert_eq!(out.status(), "COMPLETED");
    assert_dec(&out.daily_of(4)["positions"][0]["quantity"], "16");
}

#[test]
fn a_dividend_available_after_the_open_is_future_data_too() {
    let late = format!("{}T14:30:01Z", date(4));
    let out = seven_shares()
        .dividend("DIV1", 4, "1.00", 5, "OPEN")
        .action_available_at("DIV1", &late)
        .evaluate();
    assert_eq!(out.status(), "FAILED");
    assert_eq!(out.code(), "FUTURE_DATA");
}

#[test]
fn an_unsupported_action_after_a_valid_one_does_not_keep_the_valid_one() {
    // Both are effective at S4. The event is all-or-nothing: the split is not applied when the
    // unsupported action in the same handler refuses.
    let out = seven_shares()
        .capital("4000.00")
        .split("SPLIT1", 4, 2, 1)
        .unsupported("ACT1", "MERGER", 4)
        .evaluate();
    assert_eq!(out.status(), "INSUFFICIENT");
    assert!(out.state.applied.is_empty());
    assert_dec(out.at("/final/open_positions/0/quantity"), "8");
    assert_eq!(out.len("/journal/corporate_actions"), 0);
}

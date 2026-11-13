//! Ordinary cash dividends (OQ-02 section 2.6, OQ-06 section 8 "Cash dividend").
//!
//! A receivable counts in equity from the ex-date and reaches available cash only at the
//! declared payment session and phase. Every expected number is derived by hand beside its
//! assertion.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

mod execution_support;

use execution_support::*;

/// Zero costs, capital 5000.00. S1 signals with ATR 4; S2 opens at 50: q = 1000 / 50 = 20,
/// stop 42, target 70. S3 is the ex-date: the raw price falls from 50 to 49. The last session
/// is S5.
fn twenty_shares() -> Scenario {
    Scenario::new(vec![
        quiet_bar("50", "51", "49", "50"),   // S0
        signal_bar("50", "54", "50", "52"),  // S1: ATR 4
        quiet_bar("50", "51", "49.5", "50"), // S2: entry 20 @ 50, close 50
        quiet_bar("49", "50", "48.5", "49"), // S3: ex-date, close 49
        quiet_bar("49", "50", "48", "49"),   // S4
        quiet_bar("49", "50", "48", "49"),   // S5
    ])
}

#[test]
fn a_dividend_creates_a_receivable_that_keeps_equity_and_cash_unchanged_until_payment() {
    // 1.00 per share on 20 shares: receivable 20.00 at the S3 before-open phase, payable at the
    // S5 open.
    let out = twenty_shares()
        .dividend("DIV1", 3, "1.00", 5, "OPEN")
        .evaluate();
    assert_eq!(out.status(), "COMPLETED");

    // S2 close 50: 20 * 50 = 1000.00; equity 4000.00 + 1000.00 = 5000.00.
    assert_dec(&out.daily_of(2)["equity"], "5000.00");

    // S3 close 49: positions 20 * 49 = 980.00, receivable 20.00, equity 4000 + 980 + 20 = 5000.00.
    let s3 = out.daily_of(3);
    assert_dec(&s3["cash_available"], "4000.00");
    assert_dec(&s3["receivables"], "20.00");
    assert_dec(&s3["positions_value"], "980.00");
    assert_dec(&s3["equity"], "5000.00");
    // Cash is unchanged on S4 as well.
    assert_dec(&out.daily_of(4)["cash_available"], "4000.00");
    assert_dec(&out.daily_of(4)["receivables"], "20.00");

    // S5: paid at the open: cash 4020.00, receivable 0, equity 4020 + 980 = 5000.00.
    let s5 = out.daily_of(5);
    assert_dec(&s5["cash_available"], "4020.00");
    assert_dec(&s5["receivables"], "0.00");
    assert_dec(&s5["equity"], "5000.00");

    // Raw levels and quantity are unchanged by the dividend.
    let position = &s3["positions"][0];
    assert_dec(&position["quantity"], "20");
    assert_dec(&position["entry_price"], "50");
    assert_dec(&position["stop"], "42");
    assert_dec(&position["target"], "70");
}

#[test]
fn the_ledger_shows_the_receivable_without_cash_and_the_payment_with_cash() {
    let out = twenty_shares()
        .dividend("DIV1", 3, "1.00", 5, "OPEN")
        .evaluate();
    let rows: Vec<String> = out.ledger().iter().map(ledger_row).collect();
    assert_eq!(rows.len(), 5);
    // RESERVE, RELEASE and FILL_BUY precede; then the dividend lines.
    assert_eq!(
        rows[3],
        format!(
            "{} BEFORE_OPEN DIVIDEND_RECEIVABLE 20.00 avail=4000.00 reserved=0.00 recv=20.00",
            date(3)
        )
    );
    assert_eq!(
        rows[4],
        format!(
            "{} OPEN DIVIDEND_PAYMENT 20.00 avail=4020.00 reserved=0.00 recv=0.00",
            date(5)
        )
    );
    let actions = out.at("/journal/corporate_actions").as_array().unwrap();
    assert_eq!(actions.len(), 1);
    assert_eq!(actions[0]["kind"], "CASH_DIVIDEND");
    assert_eq!(actions[0]["applied_at"]["session"], date(3).as_str());
    assert_eq!(actions[0]["applied_at"]["phase"], "BEFORE_OPEN");
}

#[test]
fn payment_happens_at_the_declared_phase_of_the_payment_session() {
    // Pay in S4 at each phase. The S4 daily record is the end of the session, so it shows the
    // payment for every phase; the ledger line carries the phase.
    for phase in ["BEFORE_OPEN", "OPEN", "DURING_SESSION", "AFTER_CLOSE"] {
        let out = twenty_shares()
            .dividend("DIV1", 3, "1.00", 4, phase)
            .evaluate();
        assert_eq!(out.status(), "COMPLETED", "{phase}");
        let payment = out
            .ledger()
            .iter()
            .find(|l| l["kind"] == "DIVIDEND_PAYMENT")
            .unwrap_or_else(|| panic!("no payment for {phase}"));
        assert_eq!(payment["session"], date(4).as_str(), "{phase}");
        assert_eq!(payment["phase"], phase);
        assert_dec(&payment["amount"], "20.00");
        assert_dec(&payment["available_after"], "4020.00");
        assert_dec(&payment["receivables_after"], "0.00");
        // Not yet paid at the end of S3.
        assert_dec(&out.daily_of(3)["cash_available"], "4000.00");
        assert_dec(&out.daily_of(3)["receivables"], "20.00");
        assert_dec(&out.daily_of(4)["cash_available"], "4020.00");
    }
}

#[test]
fn payment_in_the_ex_date_before_open_pays_after_the_action_is_applied() {
    // The receivable is created and then paid in the same handler: two ledger lines, the
    // receivable first.
    let out = twenty_shares()
        .dividend("DIV1", 3, "1.00", 3, "BEFORE_OPEN")
        .evaluate();
    let rows: Vec<String> = out.ledger().iter().skip(3).map(ledger_row).collect();
    assert_eq!(
        rows,
        vec![
            format!(
                "{} BEFORE_OPEN DIVIDEND_RECEIVABLE 20.00 avail=4000.00 reserved=0.00 recv=20.00",
                date(3)
            ),
            format!(
                "{} BEFORE_OPEN DIVIDEND_PAYMENT 20.00 avail=4020.00 reserved=0.00 recv=0.00",
                date(3)
            ),
        ]
    );
    assert_dec(&out.daily_of(3)["receivables"], "0.00");
    assert_dec(&out.daily_of(3)["cash_available"], "4020.00");
}

#[test]
fn a_payment_after_the_last_processed_session_stays_a_receivable_in_equity() {
    // The calendar has S6, but the run ends at S5: the receivable is never paid in the run.
    let mut scenario = Scenario::new(vec![
        quiet_bar("50", "51", "49", "50"),
        signal_bar("50", "54", "50", "52"),
        quiet_bar("50", "51", "49.5", "50"),
        quiet_bar("49", "50", "48.5", "49"),
        quiet_bar("49", "50", "48", "49"),
        quiet_bar("49", "50", "48", "49"),
        quiet_bar("49", "50", "48", "49"),
    ])
    .dividend("DIV1", 3, "1.00", 6, "OPEN");
    scenario.last = 5;
    let out = scenario.evaluate();
    assert_eq!(out.status(), "COMPLETED");
    assert_dec(out.at("/final/receivables"), "20.00");
    assert_dec(out.at("/final/cash_available"), "4000.00");
    // 4000.00 + 20 * 49 + 20.00 = 5000.00
    assert_dec(out.at("/final/equity"), "5000.00");
    assert!(out.ledger().iter().all(|l| l["kind"] != "DIVIDEND_PAYMENT"));
}

#[test]
fn withholding_reduces_the_receivable_and_the_result_floors_to_the_money_scale() {
    // 20 * 0.3335 = 6.67 gross; withholding 1500 bps keeps 85%: 6.67 * 0.85 = 5.6695 -> floor
    // 5.66 (rounding to nearest would give 5.67).
    let out = twenty_shares()
        .withholding("1500")
        .dividend("DIV1", 3, "0.3335", 4, "OPEN")
        .evaluate();
    let receivable = out
        .ledger()
        .iter()
        .find(|l| l["kind"] == "DIVIDEND_RECEIVABLE")
        .unwrap();
    assert_dec(&receivable["amount"], "5.66");
    assert_dec(&out.daily_of(3)["receivables"], "5.66");
    // Paid in full: cash 4000.00 + 5.66.
    assert_dec(&out.daily_of(4)["cash_available"], "4005.66");
}

#[test]
fn without_withholding_the_receivable_is_the_gross_amount() {
    // 20 * 0.3335 = 6.67
    let out = twenty_shares()
        .dividend("DIV1", 3, "0.3335", 4, "OPEN")
        .evaluate();
    assert_dec(&out.daily_of(3)["receivables"], "6.67");
}

#[test]
fn a_buyer_on_the_ex_date_gets_no_entitlement() {
    // The entry fills at the S2 open, the ex-date of the dividend: nothing was held at the start
    // of the before-open phase.
    let out = twenty_shares()
        .dividend("DIV1", 2, "1.00", 3, "OPEN")
        .evaluate();
    assert_eq!(out.status(), "COMPLETED");
    assert_eq!(out.fills().len(), 1);
    assert!(
        out.ledger()
            .iter()
            .all(|l| { l["kind"] != "DIVIDEND_RECEIVABLE" && l["kind"] != "DIVIDEND_PAYMENT" })
    );
    assert_dec(&out.daily_of(2)["receivables"], "0.00");
    // The action was still applied exactly once.
    assert_eq!(out.len("/journal/corporate_actions"), 1);
    assert!(out.state.applied.contains("DIV1"));
    assert_dec(out.at("/final/cash_available"), "4000.00");
}

#[test]
fn a_position_that_gaps_out_at_the_ex_date_open_is_still_entitled() {
    // The position is held at the start of the S3 before-open phase, so it is entitled even
    // though it sells at the S3 open. S3 open 40 <= stop 42: gap stop at 40.00 (no slippage):
    // 20 * 40 = 800.00; cash 4000.00 + 800.00 = 4800.00; receivable 20.00 (1.00 per share).
    let out = Scenario::new(vec![
        quiet_bar("50", "51", "49", "50"),
        signal_bar("50", "54", "50", "52"),
        quiet_bar("50", "51", "49.5", "50"),
        quiet_bar("40", "41", "39", "40"),
        quiet_bar("40", "41", "39", "40"),
    ])
    .dividend("DIV1", 3, "1.00", 4, "OPEN")
    .evaluate();
    assert_eq!(out.fills()[1]["reason"], "GAP_STOP");
    assert_dec(&out.daily_of(3)["receivables"], "20.00");
    assert_dec(&out.daily_of(3)["cash_available"], "4800.00");
    assert_dec(&out.daily_of(3)["equity"], "4820.00");
    assert_dec(&out.daily_of(4)["cash_available"], "4820.00");
}

#[test]
fn no_holding_before_the_ex_date_means_no_receivable() {
    let out = Scenario::new(vec![
        quiet_bar("50", "51", "49", "50"),
        quiet_bar("50", "51", "49", "50"),
        quiet_bar("49", "50", "48", "49"),
    ])
    .dividend("DIV1", 2, "1.00", 2, "AFTER_CLOSE")
    .evaluate();
    assert_eq!(out.status(), "COMPLETED");
    assert!(out.ledger().is_empty());
    assert_eq!(out.len("/journal/corporate_actions"), 1);
}

#[test]
fn a_split_and_a_dividend_on_the_same_day_use_the_pre_split_quantity_for_the_dividend() {
    // 20 shares held. On S3: 2-for-1 split and 0.50 per share. The entitlement uses the 20
    // shares held at the start of the before-open phase: 20 * 0.50 = 10.00, not 40 * 0.50.
    // After the split: 40 shares, entry 25, stop 21, target 35, ATR 2; raw S3 close 25.
    // Equity: cash 4000.00 + 40 * 25 = 1000.00 + receivable 10.00 = 5010.00.
    for (first, second) in [("SPLIT1", "DIV1"), ("DIV1", "SPLIT1")] {
        let mut scenario = twenty_shares();
        scenario.bars[3] = Some(quiet_bar("25", "25.5", "24.5", "25"));
        scenario.bars[4] = Some(quiet_bar("25", "26", "24.5", "25"));
        scenario.bars[5] = Some(quiet_bar("25", "26", "24.5", "25"));
        let scenario = if first == "SPLIT1" {
            scenario
                .split("SPLIT1", 3, 2, 1)
                .dividend("DIV1", 3, "0.50", 4, "OPEN")
        } else {
            scenario
                .dividend("DIV1", 3, "0.50", 4, "OPEN")
                .split("SPLIT1", 3, 2, 1)
        };
        let out = scenario.evaluate();
        assert_eq!(out.status(), "COMPLETED", "{first}");
        let s3 = out.daily_of(3);
        assert_dec(&s3["receivables"], "10.00");
        assert_dec(&s3["positions"][0]["quantity"], "40");
        assert_dec(&s3["positions"][0]["entry_price"], "25");
        assert_dec(&s3["positions"][0]["stop"], "21");
        assert_dec(&s3["positions"][0]["target"], "35");
        assert_dec(&s3["positions"][0]["snapshots"][0]["value"], "2");
        assert_dec(&s3["equity"], "5010.00");
        // The journal lists the actions in input order.
        let actions = out.at("/journal/corporate_actions").as_array().unwrap();
        assert_eq!(actions[0]["action_id"], first);
        assert_eq!(actions[1]["action_id"], second);
        // Paid at the S4 open: cash 4010.00, equity 4010 + 40 * 25 = 5010.00.
        assert_dec(&out.daily_of(4)["cash_available"], "4010.00");
        assert_dec(&out.daily_of(4)["equity"], "5010.00");
    }
}

#[test]
fn a_payment_cannot_enlarge_a_frozen_entry_cap_or_be_spent_before_it_arrives() {
    // S2: buy 20 @ 50 (cash 4000.00). S3 is the ex-date of 1.00 per share: receivable 20.00.
    // S3 bar low 41 <= stop 42: sold 20 @ 42.00 = 840.00, cash 4840.00. S3 also signals
    // (volume 2000, ATR(1) = max(8.5, |49.5 - 50|, |41 - 50|) = 9): the receivable is not cash,
    // so cap = floor(4840.00 / 5) = 968.00 (not 4860 / 5 = 972.00). Reserved: cash 3872.00.
    // The 20.00 is paid at the S4 before-open phase, but the cap stays 968.00: at the S4 open
    // 46.90, q = floor(968 / 46.90) = 20 (938.00; 21 would cost 984.90). Cash after the entry:
    // 3872.00 + 20.00 + 968.00 - 938.00 = 3922.00.
    let out = Scenario::new(vec![
        quiet_bar("50", "51", "49", "50"),
        signal_bar("50", "54", "50", "52"),
        quiet_bar("50", "51", "49.5", "50"),
        signal_bar("49", "49.5", "41", "45"),
        quiet_bar("46.9", "48", "46", "47"),
    ])
    .dividend("DIV1", 3, "1.00", 4, "BEFORE_OPEN")
    .evaluate();
    assert_eq!(out.status(), "COMPLETED");
    let s3 = out.daily_of(3);
    assert_dec(&s3["cash_available"], "3872.00");
    assert_dec(&s3["cash_reserved"], "968.00");
    assert_dec(&s3["receivables"], "20.00");
    assert_dec(&s3["equity"], "4860.00");
    assert_dec(&out.entries()[1]["cap"], "968.00");

    let payment = out
        .ledger()
        .iter()
        .find(|l| l["kind"] == "DIVIDEND_PAYMENT")
        .unwrap();
    assert_eq!(payment["phase"], "BEFORE_OPEN");
    assert_dec(&payment["available_after"], "3892.00");
    assert_dec(&payment["reserved_after"], "968.00");

    assert_eq!(
        fill_row(&out.fills()[2]),
        format!("{} OPEN BUY 20@46.90 fee=0.00 delta=-938.00 ENTRY", date(4))
    );
    let s4 = out.daily_of(4);
    assert_dec(&s4["cash_available"], "3922.00");
    assert_dec(&s4["positions_value"], "940.00");
    assert_dec(&s4["equity"], "4862.00");
}

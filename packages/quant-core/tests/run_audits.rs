//! The two audits of a completed run: accounting reconciliation and signal and data timing.
//!
//! Every completed S0 case must pass both: the audits restate the accounting rules from the journal
//! and the input, so a correct engine result never fails them. Then each rule is broken in turn on
//! a real result (the audits read a result, so a tampered one stands for an engine that got the
//! rule wrong), and the audit must fail it, name a difference and leave the other audit alone
//! where the two are independent.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

mod evidence_support;

use evidence_support::*;
use openquant_contracts::{EvaluationInput, StrategyArtefact, generated as g, parse};
use openquant_core::{
    Run,
    audit::{Check, audit_run},
    metrics::EvidenceError,
};

fn decimal(text: &str) -> g::Decimal {
    text.parse().unwrap()
}

fn all_s0_cases() -> Vec<String> {
    let mut ids: Vec<String> = std::fs::read_dir(std::path::Path::new(FIXTURES).join("s0/cases"))
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    ids.sort();
    ids
}

#[test]
fn every_completed_s0_result_passes_both_audits() {
    let (mut audited, mut refused) = (0, 0);
    for id in all_s0_cases() {
        let reference = format!("s0:{id}");
        let dir = s0_dir(&reference);
        let case = read_json(&dir.join("case.json"));
        let strategy: Result<StrategyArtefact, _> =
            parse(&read_text(&dir.join(case["strategy"].as_str().unwrap())));
        let input: Result<EvaluationInput, _> =
            parse(&read_text(&dir.join(case["input"].as_str().unwrap())));
        // Cases that the contract layer rejects never reach the core.
        let (Ok(strategy), Ok(input)) = (strategy, input) else {
            continue;
        };
        let Ok(run) = Run::prepare(&strategy, &input) else {
            continue;
        };
        let result = evaluate(&run);
        if result.outcome.status != g::Status::Completed {
            assert!(
                matches!(
                    audit_run(&run, &result),
                    Err(EvidenceError::NotCompleted(_))
                ),
                "{id}"
            );
            refused += 1;
            continue;
        }
        let checks = audit_run(&run, &result).unwrap();
        assert_eq!(checks.reconciliation, Check::Pass, "{id}");
        assert_eq!(checks.timing, Check::Pass, "{id}");
        audited += 1;
    }
    assert!(audited >= 70, "audited only {audited} completed cases");
    assert!(refused >= 10, "refused only {refused} incomplete cases");
}

fn r01() -> (Run, g::EvaluationResult) {
    s0_run("s0:R-01")
}

fn reconciliation(run: &Run, result: &g::EvaluationResult) -> String {
    let checks = audit_run(run, result).unwrap();
    assert_eq!(
        checks.timing,
        Check::Pass,
        "a ledger edit must not change the timing audit"
    );
    match checks.reconciliation {
        Check::Fail(detail) => detail,
        Check::Pass => panic!("the tampered result passed reconciliation"),
    }
}

#[test]
fn a_changed_fill_breaks_reconciliation() {
    let (run, result) = r01();
    // The fee, the notional, the price, the cash delta and the side each break the fill's own rule.
    type Edit = fn(&mut g::FillRecord);
    let edits: [(&str, Edit); 5] = [
        ("fee", |f| f.fee = decimal("9.99")),
        ("notional", |f| f.notional = decimal("1901.00")),
        ("price", |f| f.price = decimal("100.01")),
        ("cash_delta", |f| f.cash_delta = decimal("-1900.00")),
        ("side", |f| f.side = g::FillRecordSide::Sell),
    ];
    for (name, edit) in edits {
        let mut tampered = result.clone();
        edit(&mut tampered.journal.fills[0]);
        let detail = reconciliation(&run, &tampered);
        assert!(
            detail.contains("fill") || detail.contains("ledger"),
            "{name}: {detail}"
        );
    }
    // A negative fee.
    let mut negative = result.clone();
    negative.journal.fills[0].fee = decimal("-1.00");
    assert!(reconciliation(&run, &negative).contains("negative"));
}

#[test]
fn a_changed_ledger_line_breaks_reconciliation() {
    let (run, result) = r01();
    type Edit = fn(&mut g::LedgerEntry);
    let edits: [(&str, Edit); 5] = [
        ("available_after", |l| l.available_after = decimal("1.00")),
        ("reserved_after", |l| l.reserved_after = decimal("1.00")),
        ("receivables_after", |l| {
            l.receivables_after = decimal("1.00")
        }),
        ("amount", |l| l.amount = decimal("1.00")),
        ("kind", |l| l.kind = g::LedgerEntryKind::DividendPayment),
    ];
    for (name, edit) in edits {
        let mut tampered = result.clone();
        edit(&mut tampered.journal.cash_ledger[3]);
        let detail = reconciliation(&run, &tampered);
        assert!(
            detail.contains("ledger") || detail.contains("fill"),
            "{name}: {detail}"
        );
    }
    // The last line is the one the final balances must equal.
    let mut dropped = result.clone();
    dropped.journal.cash_ledger.pop();
    reconciliation(&run, &dropped);
    // A line that repeats a sequence number.
    let mut repeated = result.clone();
    repeated.journal.cash_ledger[2].seq = repeated.journal.cash_ledger[1].seq;
    assert!(reconciliation(&run, &repeated).contains("sequence"));
    // A fill with no ledger line.
    let mut unmatched = result.clone();
    let extra = unmatched.journal.fills[0].clone();
    unmatched.journal.fills.push(extra);
    reconciliation(&run, &unmatched);
}

#[test]
fn changed_balances_break_reconciliation() {
    let (run, result) = r01();
    type Edit = fn(&mut g::EvaluationResult);
    let edits: [(&str, Edit); 6] = [
        ("final cash", |r| r.final_.cash_available = decimal("1.00")),
        ("final reserved", |r| {
            r.final_.cash_reserved = decimal("1.00")
        }),
        ("final receivables", |r| {
            r.final_.receivables = decimal("1.00")
        }),
        ("final equity", |r| r.final_.equity = decimal("1.00")),
        ("final positions value", |r| {
            r.final_.positions_value = decimal("1.00")
        }),
        ("daily equity", |r| {
            r.journal.daily[8].equity = decimal("1.00")
        }),
    ];
    for (name, edit) in edits {
        let mut tampered = result.clone();
        edit(&mut tampered);
        let detail = reconciliation(&run, &tampered);
        assert!(!detail.is_empty(), "{name}");
    }
    type Daily = fn(&mut g::DailyRecord);
    let daily_edits: [(&str, Daily); 4] = [
        ("cash", |d| d.cash_available = decimal("1.00")),
        ("reserved", |d| d.cash_reserved = decimal("1.00")),
        ("receivables", |d| d.receivables = decimal("1.00")),
        ("positions value", |d| d.positions_value = decimal("1.00")),
    ];
    for (name, edit) in daily_edits {
        let mut tampered = result.clone();
        edit(&mut tampered.journal.daily[9]);
        let detail = reconciliation(&run, &tampered);
        assert!(detail.contains("daily record"), "{name}: {detail}");
    }
}

#[test]
fn a_position_valued_off_the_close_breaks_reconciliation() {
    let (run, result) = r01();
    let held = result
        .journal
        .daily
        .iter()
        .position(|d| !d.positions.is_empty())
        .unwrap();
    let mut tampered = result.clone();
    tampered.journal.daily[held].positions[0].quantity = decimal("1");
    let detail = reconciliation(&run, &tampered);
    assert!(detail.contains("positions_value"), "{detail}");
}

fn timing(run: &Run, result: &g::EvaluationResult) -> String {
    let checks = audit_run(run, result).unwrap();
    match checks.timing {
        Check::Fail(detail) => detail,
        Check::Pass => panic!("the tampered result passed the timing audit"),
    }
}

#[test]
fn a_fill_in_the_wrong_phase_or_session_breaks_timing() {
    let (run, result) = r01();
    // Entry in the wrong phase.
    let mut early = result.clone();
    early.journal.fills[0].phase = g::Phase::AfterClose;
    assert!(timing(&run, &early).contains("entry"));
    // A stop or target fill during the open, and a gap fill during the session.
    let exit = result
        .journal
        .fills
        .iter()
        .position(|f| {
            matches!(
                f.reason,
                g::FillRecordReason::Stop | g::FillRecordReason::Target
            )
        })
        .unwrap();
    let mut open = result.clone();
    open.journal.fills[exit].phase = g::Phase::Open;
    assert!(timing(&run, &open).contains("stop or target"));
    let (run_gap, gap) = s0_run("s0:X-05");
    let gap_exit = gap
        .journal
        .fills
        .iter()
        .position(|f| f.reason == g::FillRecordReason::GapStop)
        .unwrap();
    let mut late = gap.clone();
    late.journal.fills[gap_exit].phase = g::Phase::DuringSession;
    assert!(timing(&run_gap, &late).contains("gap exit"));
    // An entry on the signal session itself, and two sessions after it.
    let signal = &result.journal.entries[0].signal_session;
    let mut same = result.clone();
    same.journal.fills[0].session = signal.clone();
    assert!(timing(&run, &same).contains("next session"));
    let mut later = result.clone();
    let after = result
        .journal
        .daily
        .iter()
        .position(|d| d.session == result.journal.fills[0].session)
        .unwrap();
    later.journal.fills[0].session = result.journal.daily[after + 1].session.clone();
    assert!(timing(&run, &later).contains("next session"));
    // An entry without an intent.
    let mut orphan = result.clone();
    orphan.journal.fills[0].intent_id = None;
    assert!(timing(&run, &orphan).contains("intent"));
}

#[test]
fn an_action_applied_in_the_wrong_phase_or_session_breaks_timing() {
    let (run, result) = r01();
    assert!(!result.journal.corporate_actions.is_empty());
    let mut phase = result.clone();
    phase.journal.corporate_actions[0].applied_at.phase = g::Phase::Open;
    assert!(timing(&run, &phase).contains("not before the open"));
    let mut session = result.clone();
    session.journal.corporate_actions[0].applied_at.session =
        result.journal.daily[0].session.clone();
    assert!(timing(&run, &session).contains("not before the open"));
}

#[test]
fn data_that_became_available_late_breaks_timing_even_in_a_completed_result() {
    let (run, result) = r01();
    // A bar that became available after the next open, and one after the information cutoff.
    let bar_session = run.input.sessions[run.input.scored_start + 1].date.clone();
    let mut late_bar = run.clone();
    late_bar
        .input
        .bars
        .get_mut(&bar_session)
        .unwrap()
        .available_at = "2099-01-01T00:00:00Z".to_owned();
    assert!(timing(&late_bar, &result).contains("became available"));
    let last = run.input.sessions[run.input.last].date.clone();
    let mut late_end = run.clone();
    late_end.input.bars.get_mut(&last).unwrap().available_at = "2099-01-01T00:00:00Z".to_owned();
    assert!(timing(&late_end, &result).contains("became available"));
    // An action available after the open of its effective session.
    let mut late_action = run.clone();
    late_action.input.actions[0].available_at = "2099-01-01T00:00:00Z".to_owned();
    assert!(timing(&late_action, &result).contains("action"));
    // An exactly-on-time bar is usable (availability at the deadline is allowed).
    let mut exact = run.clone();
    let next_open = run.input.sessions[run.input.scored_start + 2]
        .open_at
        .clone();
    exact.input.bars.get_mut(&bar_session).unwrap().available_at = next_open;
    assert_eq!(audit_run(&exact, &result).unwrap().timing, Check::Pass);
}

#[test]
fn only_a_completed_result_of_the_same_run_is_audited() {
    let (run, result) = r01();
    let other = s0_run("s0:X-09a").1;
    assert!(matches!(
        audit_run(&run, &other),
        Err(EvidenceError::IdentityMismatch(_))
    ));
    let failed = s0_run("s0:G-07a");
    assert!(matches!(
        audit_run(&failed.0, &failed.1),
        Err(EvidenceError::NotCompleted(_))
    ));
    assert!(audit_run(&run, &result).is_ok());
}

//! The buy-and-hold benchmark against the independent fixtures, and against the evaluator.
//!
//! The fixtures (`B-*`) state the path that `oracle.py` derived from each input with exact
//! rational arithmetic and a lot search by bisection. The cross-check does not share the fixture
//! path: it runs the real evaluator on S0 cases whose strategy buys once with a known cap and
//! never exits, and requires that a benchmark on a run with that cap, starting at that entry,
//! equals the evaluator's own equity minus the cash the strategy left idle. A dividend, a split,
//! or both on the same day make the two agree only if the benchmark credits them as the
//! evaluator does.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

mod evidence_support;

use evidence_support::*;
use openquant_contracts::generated as g;
use openquant_core::{
    Run,
    benchmark::{BuyAndHold, REASON_NO_BAR, REASON_NO_LOT, buy_and_hold},
    exact::Q,
    metrics::{max_drawdown, net_return},
    numeric::Decimal,
};

fn run_of(case: &Case) -> Run {
    let source = case.text("source");
    let input = case.case["input"].as_str().unwrap();
    let input = if input.starts_with("s0:") {
        s0_input(input)
    } else {
        openquant_contracts::parse(&read_text(&case.dir.join(input))).unwrap()
    };
    Run::prepare(&s0_strategy(source), &input).unwrap()
}

fn money(value: &Q, run: &Run) -> String {
    value.to_fixed(run.input.policy.money_scale).unwrap()
}

#[test]
fn benchmark_cases_match_the_oracle() {
    let cases = cases("B-");
    assert_eq!(cases.len(), 13);
    let (mut computed, mut unavailable) = (0, 0);
    for case in cases {
        let run = run_of(&case);
        let expect = case.expect();
        let scale = u32::try_from(case.case["metric_scale"].as_u64().unwrap()).unwrap();
        match (buy_and_hold(&run), expect["status"].as_str().unwrap()) {
            (BuyAndHold::Computed(path), "COMPUTED") => {
                assert_eq!(
                    path.entry_session,
                    expect["entry_session"].as_str().unwrap(),
                    "{}",
                    case.id
                );
                assert_eq!(
                    path.quantity.to_string(),
                    expect["quantity"].as_str().unwrap(),
                    "{}",
                    case.id
                );
                let equities: Vec<String> = path.equities.iter().map(|e| money(e, &run)).collect();
                assert_eq!(
                    serde_json::json!(equities),
                    expect["equities"],
                    "{}",
                    case.id
                );
                let initial = Q::from_decimal(&run.input.initial_capital);
                let last = path.equities.last().unwrap();
                assert_eq!(
                    net_return(&initial, last).unwrap().to_fixed(scale).unwrap(),
                    expect["net_return"].as_str().unwrap(),
                    "{}",
                    case.id
                );
                assert_eq!(
                    max_drawdown(&initial, &path.equities)
                        .unwrap()
                        .to_fixed(scale)
                        .unwrap(),
                    expect["max_drawdown"].as_str().unwrap(),
                    "{}",
                    case.id
                );
                // One value per session of the scored window.
                assert_eq!(
                    path.equities.len(),
                    run.input.last - run.input.scored_start + 1
                );
                computed += 1;
            }
            (BuyAndHold::Unavailable { reason }, "INSUFFICIENT") => {
                for needle in expect["reason_includes"].as_array().unwrap() {
                    let needle = needle.as_str().unwrap();
                    assert!(
                        reason.contains(needle),
                        "{}: {reason:?} lacks {needle:?}",
                        case.id
                    );
                }
                unavailable += 1;
            }
            (other, status) => panic!("{}: expected {status}, got {other:?}", case.id),
        }
    }
    assert_eq!((computed, unavailable), (8, 5));
}

#[test]
fn the_fixed_reasons_are_the_ones_the_method_text_names() {
    assert_eq!(REASON_NO_BAR, "no session of the scored window has a bar");
    assert_eq!(
        REASON_NO_LOT,
        "no whole lot is affordable at the first fillable open"
    );
    let cases = cases("B-");
    let reason_of =
        |id: &str| match buy_and_hold(&run_of(cases.iter().find(|c| c.id == id).unwrap())) {
            BuyAndHold::Unavailable { reason } => reason,
            other => panic!("{id}: {other:?}"),
        };
    assert_eq!(reason_of("B-05"), REASON_NO_LOT);
    assert_eq!(reason_of("B-09"), REASON_NO_BAR);
}

#[test]
fn the_cost_stress_fee_can_lower_the_quantity_by_one_lot() {
    // B-07a and B-07b differ only in the fee rate: 100 bps buys 100 shares and 200 bps buys 99.
    let quantity = |id: &str| {
        let case = cases("B-").into_iter().find(|c| c.id == id).unwrap();
        match buy_and_hold(&run_of(&case)) {
            BuyAndHold::Computed(path) => path.quantity,
            other => panic!("{id}: {other:?}"),
        }
    };
    assert_eq!(quantity("B-07a"), Decimal::from(100));
    assert_eq!(quantity("B-07b"), Decimal::from(99));
}

/// S0 cases whose strategy buys once, with a cap of a fifth of the capital, and holds to the end.
const HOLDERS: [&str; 7] = [
    "C-01a",
    "C-01b",
    "C-01c",
    "C-03",
    "C-04",
    "C-05",
    "ENT-01-v1",
];

#[test]
fn a_benchmark_with_the_strategys_cap_equals_the_evaluators_own_holding() {
    let mut compared = 0;
    for id in HOLDERS {
        let reference = format!("s0:{id}");
        let (run, result) = s0_run(&reference);
        assert_eq!(result.outcome.status, g::Status::Completed, "{id}");
        let buys: Vec<&g::FillRecord> = result
            .journal
            .fills
            .iter()
            .filter(|f| f.side == g::FillRecordSide::Buy)
            .collect();
        assert_eq!(buys.len(), 1, "{id}: one entry expected");
        assert!(
            result.journal.fills.len() == 1,
            "{id}: the strategy never exits"
        );
        let entry = buys[0];
        let intent = result
            .journal
            .entries
            .iter()
            .find(|e| Some(&e.intent_id) == entry.intent_id.as_ref())
            .unwrap();
        let cap = Decimal::from_str_exact(intent.cap.as_str()).unwrap();
        // The strategy kept the rest of its capital idle. The benchmark of a run whose whole
        // capital is the cap, starting at the strategy's entry session, holds the same shares.
        let idle = &Q::from_decimal(&run.input.initial_capital) - &Q::from_decimal(&cap);
        let mut bench_run = run.clone();
        bench_run.input.initial_capital = cap;
        bench_run.input.scored_start = run.index_of(entry.session.as_str()).unwrap();
        let BuyAndHold::Computed(path) = buy_and_hold(&bench_run) else {
            panic!("{id}: the benchmark must be computed");
        };
        assert_eq!(path.entry_session, entry.session.as_str(), "{id}");
        assert_eq!(path.quantity.to_string(), entry.quantity.as_str(), "{id}");
        let daily = &result.journal.daily;
        let offset = daily.len() - path.equities.len();
        for (index, equity) in path.equities.iter().enumerate() {
            let record = &daily[offset + index];
            let strategy = Q::parse(record.equity.as_str()).unwrap();
            assert_eq!(
                &(equity + &idle),
                &strategy,
                "{id}: session {} benchmark {equity:?} plus idle cash {idle:?} against the evaluator {strategy:?}",
                record.session.as_str()
            );
            compared += 1;
        }
    }
    assert!(compared >= 30, "only {compared} equities compared");
}

#[test]
fn the_cross_check_covers_a_split_a_dividend_and_both_on_one_day() {
    let kinds = |id: &str| -> Vec<String> {
        s0_input(&format!("s0:{id}")).instruments[0]
            .corporate_actions
            .iter()
            .map(|a| match a {
                g::CorporateAction::SplitAction(_) => "SPLIT".to_owned(),
                g::CorporateAction::CashDividendAction(_) => "CASH_DIVIDEND".to_owned(),
                g::CorporateAction::UnsupportedAction(_) => "UNSUPPORTED".to_owned(),
            })
            .collect()
    };
    assert_eq!(kinds("C-01a"), ["SPLIT"]);
    assert_eq!(kinds("C-03"), ["CASH_DIVIDEND"]);
    assert_eq!(kinds("C-05"), ["SPLIT", "CASH_DIVIDEND"]);
}

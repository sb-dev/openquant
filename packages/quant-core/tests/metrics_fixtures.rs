//! Per-run metrics against the independent fixtures of `fixtures/s1/metrics` (OQ-02 section 3.6).
//!
//! The expected values come from `oracle/oracle.py` (exact rational arithmetic over the journals
//! that the S0 oracle derived without this engine) and from hand derivations asserted inside the
//! script. The tests compare every figure, string for string: the tolerance is zero. They never
//! write or regenerate an expectation, and they fail when the oracle script changed after its
//! expectations were written.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

mod evidence_support;

use evidence_support::*;
use openquant_contracts::{canonical_json, digest, generated as g, payload_digest, to_value};
use openquant_core::{
    exact::Q,
    metrics::{
        EvidenceError, MetricsContext, Scenario, SessionPoint, Window, compute_metrics,
        series_figures,
    },
};
use serde_json::{Value, json};

fn window_of(name: &str) -> Window {
    Window::from_wire(name).unwrap_or_else(|| panic!("window {name}"))
}

fn scenario_of(name: &str) -> Scenario {
    Scenario::from_wire(name).unwrap_or_else(|| panic!("scenario {name}"))
}

fn context<'a>(
    case: &'a Case,
    method: &'a openquant_core::metrics::MethodRef,
) -> MetricsContext<'a> {
    let context = &case.case["context"];
    MetricsContext {
        run_id: context["run_id"].as_str().unwrap(),
        window: window_of(context["window"].as_str().unwrap()),
        scenario: scenario_of(context["scenario"].as_str().unwrap()),
        currency: context["currency"].as_str().unwrap(),
        metric_scale: u32::try_from(context["metric_scale"].as_u64().unwrap()).unwrap(),
        limitation: LIMITATION,
        method,
    }
}

fn metrics_of(case: &Case) -> Result<g::EvaluationMetrics, EvidenceError> {
    let (run, result) = s0_run(case.text("source"));
    let method = test_method();
    compute_metrics(&run, &result, &context(case, &method))
}

#[test]
fn every_expected_file_binds_the_current_oracle_script() {
    let wanted = oracle_digest();
    let mut checked = 0;
    for prefix in ["M-", "S-", "B-"] {
        for case in cases(prefix) {
            let bound = case.expected["origin"]["oracle_sha256"].as_str().unwrap();
            assert_eq!(
                format!("sha256:{bound}"),
                wanted,
                "{}: the oracle script changed after this expectation was derived",
                case.id
            );
            assert_eq!(case.expected["origin"]["kind"], "oracle");
            checked += 1;
        }
    }
    assert!(checked >= 40, "only {checked} expectations found");
}

#[test]
fn engine_cases_match_the_oracle_figure_for_figure() {
    let cases = cases("M-");
    assert_eq!(cases.len(), 18);
    let (mut completed, mut refused) = (0, 0);
    for case in &cases {
        let outcome = metrics_of(case);
        if case.expect()["refusal"] == "NOT_COMPLETED" {
            let error = outcome.expect_err(&case.id);
            assert!(
                matches!(error, EvidenceError::NotCompleted(_)),
                "{}: {error}",
                case.id
            );
            let (_, result) = s0_run(case.text("source"));
            assert_eq!(
                result.outcome.status.to_string(),
                case.expect()["outcome"],
                "{}",
                case.id
            );
            refused += 1;
            continue;
        }
        let document = to_value(&outcome.unwrap_or_else(|e| panic!("{}: {e}", case.id))).unwrap();
        let differences = differences(case.expect(), &flatten_metrics(&document));
        assert!(
            differences.is_empty(),
            "{}:\n{}",
            case.id,
            differences.join("\n")
        );
        // The series that the figures read is the one the oracle derived from the S0 journal.
        let (_, result) = s0_run(case.text("source"));
        let scored = case.expect()["series"]["equity"].as_array().unwrap().len();
        let daily = &result.journal.daily;
        let equities: Vec<&str> = daily[daily.len() - scored..]
            .iter()
            .map(|d| d.equity.as_str())
            .collect();
        let values: Vec<&str> = daily[daily.len() - scored..]
            .iter()
            .map(|d| d.positions_value.as_str())
            .collect();
        assert_eq!(
            json!(equities),
            case.expect()["series"]["equity"],
            "{}",
            case.id
        );
        assert_eq!(
            json!(values),
            case.expect()["series"]["positions_value"],
            "{}",
            case.id
        );
        completed += 1;
    }
    assert_eq!((completed, refused), (15, 3));
}

#[test]
fn the_document_carries_identities_units_and_the_limitation() {
    let case = cases("M-").into_iter().find(|c| c.id == "M-03").unwrap();
    let (run, result) = s0_run(case.text("source"));
    let method = test_method();
    let ctx = context(&case, &method);
    let metrics = compute_metrics(&run, &result, &ctx).unwrap();
    let value = to_value(&metrics).unwrap();
    assert_eq!(value["schema_version"], "evaluation-metrics/1");
    assert_eq!(value["run_id"], "run-s1-fixture");
    assert_eq!(value["metric_scale"], 6);
    assert_eq!(value["window"]["role"], "DEVELOPMENT");
    assert_eq!(value["window"]["cost_scenario"], "BASE");
    assert_eq!(
        value["method"],
        json!({"name": method.name, "version": method.version, "digest": method.digest})
    );
    assert_eq!(
        value["source"]["result_digest"],
        payload_digest(&result).unwrap()
    );
    assert_eq!(value["source"]["input_hash"], run.input_hash);
    assert_eq!(value["source"]["strategy_hash"], run.strategy_hash);
    assert_eq!(value["source"]["engine_digest"], run.engine_digest);
    assert_eq!(
        value["uncertainty"],
        json!({"status": "NOT_COMPUTED", "limitation": LIMITATION})
    );
    let strategy = &value["strategy"];
    for ratio in [
        "net_return",
        "max_drawdown",
        "worst_session_return",
        "turnover",
        "exposure",
    ] {
        assert_eq!(strategy[ratio]["unit"], "RATIO", "{ratio}");
    }
    for count in ["trade_count", "scored_session_count"] {
        assert_eq!(strategy[count]["unit"], "COUNT", "{count}");
    }
    for money in ["fees", "gap_slippage", "total"] {
        assert_eq!(
            strategy["execution_cost"][money]["unit"], "MONEY",
            "{money}"
        );
        assert_eq!(
            strategy["execution_cost"][money]["currency"], "USD",
            "{money}"
        );
    }
    // The metrics digest is the canonical digest of the document, so the same inputs give the
    // same digest on every run.
    let again = compute_metrics(&run, &result, &ctx).unwrap();
    assert_eq!(
        canonical_json(&to_value(&again).unwrap()).unwrap(),
        canonical_json(&value).unwrap()
    );
    assert_eq!(digest(&value).unwrap(), payload_digest(&metrics).unwrap());
}

#[test]
fn money_follows_the_run_scale_and_ratios_follow_the_metric_scale() {
    for (id, scale) in [("M-14", 12), ("M-15", 0)] {
        let case = cases("M-").into_iter().find(|c| c.id == id).unwrap();
        let document = to_value(&metrics_of(&case).unwrap()).unwrap();
        assert_eq!(document["metric_scale"], scale);
        let digits = |text: &str| text.split_once('.').map_or(0, |(_, f)| f.len());
        assert_eq!(
            digits(
                document["strategy"]["net_return"]["value"]
                    .as_str()
                    .unwrap()
            ),
            scale
        );
        // The run's money scale is 2 whatever the ratio scale is.
        assert_eq!(
            digits(
                document["strategy"]["execution_cost"]["total"]["value"]
                    .as_str()
                    .unwrap()
            ),
            2
        );
    }
}

#[test]
fn series_cases_match_the_oracle() {
    let cases = cases("S-");
    assert_eq!(cases.len(), 13);
    for case in cases {
        let series = read_json(&case.dir.join(case.text("series")));
        let scale = u32::try_from(series["metric_scale"].as_u64().unwrap()).unwrap();
        let initial = Q::parse(series["initial_capital"].as_str().unwrap()).unwrap();
        let points: Vec<SessionPoint> = series["points"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| SessionPoint {
                equity: Q::parse(p["equity"].as_str().unwrap()).unwrap(),
                positions_value: Q::parse(p["positions_value"].as_str().unwrap()).unwrap(),
            })
            .collect();
        let figures = series_figures(&initial, &points).unwrap();
        let got = json!({
            "net_return": figures.net_return.to_fixed(scale).unwrap(),
            "max_drawdown": figures.max_drawdown.to_fixed(scale).unwrap(),
            "worst_session_return": figures.worst_session_return.to_fixed(scale).unwrap(),
            "exposure": figures.exposure.to_fixed(scale).unwrap(),
        });
        assert_eq!(&got, case.expect(), "{}", case.id);
    }
}

#[test]
fn a_series_with_no_equity_or_a_non_positive_one_is_refused_not_guessed() {
    let initial = Q::parse("100").unwrap();
    assert!(matches!(
        series_figures(&initial, &[]),
        Err(EvidenceError::Inconsistent(_))
    ));
    for (equity, value) in [("0", "0"), ("-5", "0")] {
        let points = [
            SessionPoint {
                equity: Q::parse("100").unwrap(),
                positions_value: Q::parse("10").unwrap(),
            },
            SessionPoint {
                equity: Q::parse(equity).unwrap(),
                positions_value: Q::parse(value).unwrap(),
            },
        ];
        assert!(
            matches!(
                series_figures(&initial, &points),
                Err(EvidenceError::NonPositiveEquity(_))
            ),
            "{equity}"
        );
    }
    let point = [SessionPoint {
        equity: Q::parse("100").unwrap(),
        positions_value: Q::zero(),
    }];
    assert!(matches!(
        series_figures(&Q::zero(), &point),
        Err(EvidenceError::NonPositiveEquity(_))
    ));
}

fn m01() -> (openquant_core::Run, g::EvaluationResult, Case) {
    let case = cases("M-").into_iter().find(|c| c.id == "M-01").unwrap();
    let (run, result) = s0_run(case.text("source"));
    (run, result, case)
}

fn compute(
    run: &openquant_core::Run,
    result: &g::EvaluationResult,
    case: &Case,
) -> Result<g::EvaluationMetrics, EvidenceError> {
    let method = test_method();
    compute_metrics(run, result, &context(case, &method))
}

#[test]
fn a_result_of_another_run_is_refused() {
    let (run, result, case) = m01();
    let other = s0_run("s0:X-09b").1;
    assert!(matches!(
        compute(&run, &other, &case),
        Err(EvidenceError::IdentityMismatch(_))
    ));
    for field in ["strategy", "input", "engine"] {
        let mut tampered = result.clone();
        let wrong: g::Digest = format!("sha256:{}", "0".repeat(64)).parse().unwrap();
        match field {
            "strategy" => tampered.strategy_hash = wrong,
            "input" => tampered.input_hash = wrong,
            _ => tampered.engine_digest = wrong,
        }
        let error = compute(&run, &tampered, &case).unwrap_err();
        assert!(
            matches!(error, EvidenceError::IdentityMismatch(_)),
            "{field}: {error}"
        );
        assert!(error.to_string().contains(field), "{field}: {error}");
    }
}

#[test]
fn a_result_that_contradicts_itself_is_refused() {
    let (run, result, case) = m01();
    let decimal = |text: &str| -> g::Decimal { text.parse().unwrap() };
    // A missing daily record.
    let mut short = result.clone();
    short.journal.daily.pop();
    assert!(matches!(
        compute(&run, &short, &case),
        Err(EvidenceError::Inconsistent(_))
    ));
    // A daily record for another session.
    let mut moved = result.clone();
    moved.journal.daily.swap(6, 7);
    assert!(matches!(
        compute(&run, &moved, &case),
        Err(EvidenceError::Inconsistent(_))
    ));
    // A warm-up equity that is not the initial capital.
    let mut warm = result.clone();
    warm.journal.daily[1].equity = decimal("4999.00");
    assert!(matches!(
        compute(&run, &warm, &case),
        Err(EvidenceError::Inconsistent(_))
    ));
    // A final equity that is not the last daily equity.
    let mut last = result.clone();
    last.final_.equity = decimal("5000.00");
    assert!(matches!(
        compute(&run, &last, &case),
        Err(EvidenceError::Inconsistent(_))
    ));
    // A non-positive equity in the scored period.
    let mut zero = result.clone();
    zero.journal.daily[6].equity = decimal("0.00");
    assert!(matches!(
        compute(&run, &zero, &case),
        Err(EvidenceError::NonPositiveEquity(_))
    ));
}

#[test]
fn a_gap_stop_fill_that_is_not_below_the_open_is_refused() {
    let case = cases("M-").into_iter().find(|c| c.id == "M-05").unwrap();
    let (run, result) = s0_run(case.text("source"));
    let mut tampered = result.clone();
    let fill = tampered
        .journal
        .fills
        .iter_mut()
        .find(|f| f.reason == g::FillRecordReason::GapStop)
        .unwrap();
    fill.price = "45.00".parse().unwrap();
    let method = test_method();
    let error = compute_metrics(&run, &tampered, &context(&case, &method)).unwrap_err();
    assert!(matches!(error, EvidenceError::Inconsistent(_)), "{error}");
}

#[test]
fn the_excess_return_is_the_exact_difference_rounded_once() {
    // M-01: strategy 47/1250 = 0.0376 and buy-and-hold 89/500 = 0.178 are both exact at six
    // digits; the excess is their difference. M-03 is the case where the two published values
    // could disagree with the published excess by one unit, and the exact difference decides.
    for case in cases("M-")
        .into_iter()
        .filter(|c| c.expect()["refusal"].is_null())
    {
        let document = to_value(&metrics_of(&case).unwrap()).unwrap();
        let held = &document["benchmarks"]["buy_and_hold"];
        if held["status"] != "COMPUTED" {
            continue;
        }
        let scale = u32::try_from(document["metric_scale"].as_u64().unwrap()).unwrap();
        let read = |value: &Value| Q::parse(value["value"].as_str().unwrap()).unwrap();
        let published = &read(&document["strategy"]["net_return"]) - &read(&held["net_return"]);
        let excess = read(&held["excess_return"]);
        // The published excess is within one unit of the last digit of the published difference.
        let unit = Q::one()
            .checked_div(
                &Q::parse(&format!("1{}", "0".repeat(usize::try_from(scale).unwrap()))).unwrap(),
            )
            .unwrap();
        let gap = (&published - &excess).abs();
        assert!(gap <= unit, "{}: {gap:?} vs {unit:?}", case.id);
    }
}

//! The `evaluate` job over a provider dataset manifest: the inner evaluation input that the job
//! builds in Rust, the failure and insufficiency outcomes, and the seed at AAPL's price magnitude
//! (OQ-05 sections 4 and 7; OQ-02 sections 2.5 and 3.6; decisions D5 and D14 and the overflow rule
//! of the pilot record).
//!
//! The data are synthetic: an invented instrument at about 190 dollars with deterministic prices
//! (`tests/batch_support/data.rs`). Expected values are derived in the test by hand from the
//! manifest, never by the code under test.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

mod batch_support;

use batch_support::{BacktestSpec, Harness, data::*, worker_handled};
use openquant_contracts::{EvaluationInput, canonical::digest_bytes, parse};
use openquant_engine::batch::worker::Handled;
use serde_json::{Value, json};

const SUBMISSION: &str = "attempts.evaluation-submission";

/// Run one backtest through the worker and return the harness.
fn run(spec: &BacktestSpec<'_>) -> Harness {
    let harness = Harness::new();
    let job = harness.enqueue_backtest(spec);
    let handled = worker_handled(&harness.poll(), &job.message);
    assert!(
        matches!(handled, Handled::Completed { acked: true, .. }),
        "{handled:?}\n{}",
        harness.log_text()
    );
    harness
}

fn outcome_of(harness: &Harness) -> Value {
    let world = harness.world();
    let accepted = world.accepted_on(SUBMISSION);
    assert_eq!(accepted.len(), 1);
    accepted[0].body["evaluation"].clone()
}

fn stored(harness: &Harness, reference: &Value) -> Vec<u8> {
    harness.world().artefacts[reference["digest"].as_str().unwrap()].clone()
}

#[test]
fn the_built_input_is_the_one_derived_by_hand_from_the_manifest() {
    // Eight sessions, 2024-01-01 to 2024-01-10 (indices 0 to 7; weekends skipped, no holidays).
    let mut manifest = synthetic_manifest(
        8,
        2,
        5,
        &[Dividend {
            ex: 5,
            pay: 7,
            amount: "0.25",
        }],
    );
    let dates = session_dates(8);
    assert_eq!(dates[5], "2024-01-08");
    assert_eq!(dates[7], "2024-01-10");
    // A split before the warm-up and one after the scored end: neither belongs to the run.
    let split = |id: &str, at: usize| {
        json!({"kind": "SPLIT", "action_id": id, "effective_session": dates[at],
               "available_at": format!("{}T14:30:00Z", dates[at]), "ratio_new": 2, "ratio_old": 1})
    };
    let actions = manifest["content"]["corporate_actions"]
        .as_array_mut()
        .unwrap();
    actions.insert(0, split("split-early", 0));
    actions.push(split("split-late", 6));
    let evidence = manifest["content"]["action_evidence"]
        .as_array_mut()
        .unwrap();
    for id in ["split-early", "split-late"] {
        evidence.push(
            json!({"action_id": id, "provider_record_id": format!("rec-{id}"),
                             "provider_field": "declaration_date", "provider_value": "2023-12-01"}),
        );
    }
    let strategy = seed(1);
    let mut spec = BacktestSpec::new(&manifest, &strategy, "run-input-1", "att-input-1-1");
    // Warm-up from index 1, scored from index 2 to index 5: the ex-date of the dividend.
    spec.warmup = 1;
    spec.scored_start = 2;
    spec.scored_end = 5;
    let harness = run(&spec);
    let evaluation = outcome_of(&harness);
    assert_eq!(evaluation["status"], "COMPLETED");
    let input_bytes = stored(&harness, &evaluation["input"]);

    // Derived by hand: the run's calendar is the sessions 1 to 5 and the payment session 7, but
    // session 6 is not in the run (the calendar is not extended to it: nothing there pays), so the
    // calendar holds the manifest rows of indices 1 to 7 in order.
    let rows = manifest["content"]["calendar"].as_array().unwrap();
    let bars = manifest["content"]["bars"].as_array().unwrap();
    let expected = json!({
        "schema_version": "evaluation-input/1",
        "strategy_hash": digest_bytes(canonical(&strategy).as_bytes()),
        "operator_set": "daily-long-only-seed@1",
        "seed": 0,
        "dataset": manifest["dataset"],
        "instruments": [{
            "instrument_id": manifest["instrument"]["instrument_id"],
            "bars": [bars[1], bars[2], bars[3], bars[4], bars[5]],
            "corporate_actions": [manifest["content"]["corporate_actions"][1]],
            "unplanned_events": [],
        }],
        "calendar": {"sessions": [rows[1], rows[2], rows[3], rows[4], rows[5], rows[6], rows[7]]},
        "windows": {
            "warmup_start": dates[1], "scored_start": dates[2], "scored_end": dates[5],
            "information_cutoff": format!("{}T23:00:00Z", dates[5]),
        },
        "initial_capital": "100000",
        "policy": execution_policy(2),
    });
    assert_eq!(
        std::str::from_utf8(&input_bytes).unwrap(),
        canonical(&expected),
        "the input that the job built and uploaded"
    );
    assert_eq!(
        expected["instruments"][0]["corporate_actions"][0]["action_id"],
        "div-synth-000"
    );
    // It is a valid evaluation-input/1 and its digest is what the submission reports.
    let parsed: EvaluationInput = parse(std::str::from_utf8(&input_bytes).unwrap()).unwrap();
    assert_eq!(parsed.dataset.source.to_string(), "PROVIDER");
    assert_eq!(evaluation["input"]["digest"], digest_bytes(&input_bytes));
    // The result binds to that input.
    let result: Value = serde_json::from_slice(&stored(&harness, &evaluation["result"])).unwrap();
    assert_eq!(result["input_hash"], evaluation["input"]["digest"]);
    assert_eq!(result["strategy_hash"], expected["strategy_hash"]);
    // The submission repeats the request's identities.
    let world = harness.world();
    let submission = &world.accepted_on(SUBMISSION)[0].body;
    assert_eq!(submission["mode"], "BACKTEST");
    assert_eq!(submission["engine_digest"], ENGINE_DIGEST);
    assert_eq!(submission["method"]["digest"], METHOD_DIGEST);
}

#[test]
fn the_seed_completes_at_aapl_magnitude_at_every_price_scale_the_profile_allows() {
    // The decision record: the smallest scale that holds the prices (2 expected); a scale of 3 or
    // 4 only after this test passes at that scale; above 4 blocks the profile. Each case runs the
    // seed over 300 sessions at about 190 dollars, trades, and completes: no exact overflow.
    for scale in [2_u32, 3, 4] {
        let manifest = synthetic_manifest(300, scale, 26, &[]);
        let strategy = seed(1);
        let mut spec = BacktestSpec::new(&manifest, &strategy, "run-scale", "att-scale-1");
        spec.scale = scale;
        let harness = run(&spec);
        let evaluation = outcome_of(&harness);
        assert_eq!(evaluation["status"], "COMPLETED", "scale {scale}");
        let result: Value =
            serde_json::from_slice(&stored(&harness, &evaluation["result"])).unwrap();
        // Two closed trades and four fills: the exact arithmetic of entries, stops and targets ran.
        assert_eq!(
            result["journal"]["trades"].as_array().unwrap().len(),
            2,
            "scale {scale}"
        );
        assert_eq!(
            result["journal"]["fills"].as_array().unwrap().len(),
            4,
            "scale {scale}"
        );
        let metrics: Value =
            serde_json::from_slice(&stored(&harness, &evaluation["metrics"])).unwrap();
        assert_eq!(
            metrics["strategy"]["scored_session_count"]["value"], 240,
            "300 sessions less 60 warm-up"
        );
        assert_eq!(metrics["strategy"]["trade_count"]["value"], 2);
        assert_eq!(metrics["window"]["scored"]["start"], session_dates(300)[60]);
        assert_eq!(metrics["window"]["scored"]["end"], session_dates(300)[299]);
        // Every fill price has at most `scale` places: nothing was rounded to fit the grid.
        for fill in result["journal"]["fills"].as_array().unwrap() {
            let price = fill["price"].as_str().unwrap();
            let places = price.split_once('.').map_or(0, |(_, f)| f.len());
            assert!(
                places <= usize::try_from(scale.max(2)).unwrap(),
                "{price} at scale {scale}"
            );
        }
    }
}

#[test]
fn the_net_return_of_a_completed_run_is_the_exact_ratio_of_its_final_equity() {
    let manifest = synthetic_manifest(300, 2, 26, &[]);
    let strategy = seed(1);
    let harness = run(&BacktestSpec::new(
        &manifest,
        &strategy,
        "run-return",
        "att-return-1",
    ));
    let evaluation = outcome_of(&harness);
    let result: Value = serde_json::from_slice(&stored(&harness, &evaluation["result"])).unwrap();
    let metrics: Value = serde_json::from_slice(&stored(&harness, &evaluation["metrics"])).unwrap();
    // Derived here with integer cents: net_return = (equity - capital) / capital, rounded half
    // to even to 6 places (the pilot's metric scale).
    let cents = |text: &str| -> i128 {
        let (whole, fraction) = text.split_once('.').unwrap();
        assert_eq!(fraction.len(), 2, "{text}");
        let sign = if whole.starts_with('-') { -1 } else { 1 };
        sign * (whole.trim_start_matches('-').parse::<i128>().unwrap() * 100
            + fraction.parse::<i128>().unwrap())
    };
    let equity = cents(result["final"]["equity"].as_str().unwrap());
    let capital = 10_000_000_i128;
    let numerator = (equity - capital) * 1_000_000;
    let (mut quotient, remainder) = (numerator.div_euclid(capital), numerator.rem_euclid(capital));
    let twice = remainder * 2;
    if twice > capital || (twice == capital && quotient % 2 != 0) {
        quotient += 1;
    }
    let sign = if quotient < 0 { "-" } else { "" };
    let magnitude = quotient.abs();
    let expected = format!(
        "{sign}{}.{:06}",
        magnitude / 1_000_000,
        magnitude % 1_000_000
    );
    assert_eq!(metrics["strategy"]["net_return"]["value"], expected);
    assert_eq!(
        metrics["metric_scale"], 6,
        "the metric scale of the cohort policy"
    );
    assert_eq!(metrics["method"]["digest"], METHOD_DIGEST);
    assert_eq!(metrics["run_id"], "run-return");
    assert_eq!(metrics["window"]["role"], "DEVELOPMENT");
    assert_eq!(metrics["window"]["cost_scenario"], "BASE");
    assert_eq!(metrics["uncertainty"]["status"], "NOT_COMPUTED");
    assert!(metrics["uncertainty"]["limitation"].as_str().unwrap().len() > 10);
}

#[test]
fn an_expression_that_overflows_the_exact_domain_is_a_typed_failure_with_no_metrics() {
    // The mean of close over open (interpretation 27 of the S0 record) overflows from about the
    // tenth session at prices near 100; here a 20-session mean at about 190 fails at its 20th.
    let manifest = synthetic_manifest(300, 2, 26, &[]);
    let strategy = mean_of_ratios_strategy();
    let harness = run(&BacktestSpec::new(
        &manifest,
        &strategy,
        "run-overflow",
        "att-overflow-1",
    ));
    let evaluation = outcome_of(&harness);
    assert_eq!(evaluation["status"], "FAILED");
    assert_eq!(evaluation["code"], "ARITHMETIC_OVERFLOW");
    assert!(
        evaluation.get("metrics").is_none(),
        "a failed run has no metrics"
    );
    let result: Value = serde_json::from_slice(&stored(&harness, &evaluation["result"])).unwrap();
    assert_eq!(result["outcome"]["status"], "FAILED");
    assert_eq!(result["outcome"]["code"], "ARITHMETIC_OVERFLOW");
    assert_eq!(
        result["outcome"]["at"]["session"],
        session_dates(300)[19],
        "the 20th session"
    );
    // The failed run keeps its input: the evidence of what was run.
    assert!(
        evaluation["input"]["digest"]
            .as_str()
            .unwrap()
            .starts_with("sha256:")
    );
}

#[test]
fn a_missing_required_bar_gives_an_insufficient_result_without_metrics() {
    let mut manifest = synthetic_manifest(130, 2, 3, &[]);
    let dates = session_dates(130);
    // Drop the bar of a scored session: the calendar says it traded, the data do not have it.
    manifest["content"]["bars"]
        .as_array_mut()
        .unwrap()
        .remove(100);
    let strategy = seed(1);
    let harness = run(&BacktestSpec::new(
        &manifest,
        &strategy,
        "run-missing",
        "att-missing-1",
    ));
    let evaluation = outcome_of(&harness);
    assert_eq!(evaluation["status"], "INSUFFICIENT");
    assert_eq!(evaluation["code"], "MISSING_REQUIRED_BAR");
    assert!(evaluation.get("metrics").is_none());
    let result: Value = serde_json::from_slice(&stored(&harness, &evaluation["result"])).unwrap();
    assert!(
        result["outcome"]["detail"]
            .as_str()
            .unwrap()
            .contains(&dates[100]),
        "{}",
        result["outcome"]["detail"]
    );
}

#[test]
fn data_that_became_available_after_the_information_cutoff_is_future_data() {
    let manifest = synthetic_manifest(130, 2, 3, &[]);
    let dates = session_dates(130);
    let strategy = seed(1);
    let mut spec = BacktestSpec::new(&manifest, &strategy, "run-future", "att-future-1");
    // The last bar becomes available at 23:00 UTC; the cutoff is an hour earlier.
    spec.windows = Some(json!({
        "warmup_start": dates[0], "scored_start": dates[60], "scored_end": dates[129],
        "information_cutoff": format!("{}T22:00:00Z", dates[129]),
    }));
    let harness = run(&spec);
    let evaluation = outcome_of(&harness);
    assert_eq!(evaluation["status"], "FAILED");
    assert_eq!(evaluation["code"], "FUTURE_DATA");
    assert!(evaluation.get("metrics").is_none());
}

#[test]
fn a_run_that_cannot_start_is_not_prepared_and_says_why() {
    let strategy = seed(1);
    let manifest = synthetic_manifest(130, 2, 3, &[]);
    let dates = session_dates(130);

    // A window start that is not a session of the manifest calendar (a Saturday).
    let mut spec = BacktestSpec::new(&manifest, &strategy, "run-np-window", "att-np-window-1");
    spec.windows = Some(json!({
        "warmup_start": "2024-01-06", "scored_start": dates[60], "scored_end": dates[129],
        "information_cutoff": format!("{}T23:00:00Z", dates[129]),
    }));
    let harness = run(&spec);
    let evaluation = outcome_of(&harness);
    assert_eq!(evaluation["status"], "NOT_PREPARED");
    assert_eq!(evaluation["code"], "INVALID_INPUT");
    assert!(
        evaluation["detail"]
            .as_str()
            .unwrap()
            .contains("warmup_start 2024-01-06"),
        "{evaluation}"
    );
    assert!(evaluation.get("input").is_none(), "no input was built");
    assert_eq!(
        harness.world().requests_with("attempts.artefact"),
        0,
        "nothing was uploaded"
    );

    // A manifest that was built under another research profile than the request names.
    let mut spec = BacktestSpec::new(&manifest, &strategy, "run-np-profile", "att-np-profile-1");
    spec.profile =
        Some(json!({"id": "another-profile", "revision": 1, "digest": digest_bytes(b"another")}));
    let harness = run(&spec);
    let evaluation = outcome_of(&harness);
    assert_eq!(evaluation["status"], "NOT_PREPARED");
    assert_eq!(evaluation["code"], "IDENTITY_MISMATCH");
    assert!(
        evaluation["detail"]
            .as_str()
            .unwrap()
            .contains("research profile")
    );

    // Prices with four places under a policy of two: the input is built, uploaded and refused by
    // the core, so the submission keeps the input and has no result.
    let fine = synthetic_manifest(130, 4, 3, &[]);
    let spec = BacktestSpec::new(&fine, &strategy, "run-np-scale", "att-np-scale-1");
    let harness = run(&spec);
    let evaluation = outcome_of(&harness);
    assert_eq!(evaluation["status"], "NOT_PREPARED");
    assert_eq!(evaluation["code"], "INVALID_DECIMAL");
    assert!(evaluation.get("result").is_none() && evaluation.get("metrics").is_none());
    let input = stored(&harness, &evaluation["input"]);
    assert_eq!(evaluation["input"]["digest"], digest_bytes(&input));

    // A strategy that the shared validator refuses: an operator that the catalogue does not have.
    let mut invalid = seed(1);
    invalid["definition"]["indicators"][0]["expr"]["op"] = json!("operator:nonexistent@1");
    let spec = BacktestSpec::new(&manifest, &invalid, "run-np-strategy", "att-np-strategy-1");
    let harness = run(&spec);
    let evaluation = outcome_of(&harness);
    assert_eq!(evaluation["status"], "NOT_PREPARED");
    assert_eq!(evaluation["code"], "UNSUPPORTED_OPERATOR");
}

#[test]
fn a_run_of_more_than_400_sessions_is_not_prepared_and_one_of_400_completes() {
    let strategy = seed(1);
    let manifest = synthetic_manifest(401, 2, 3, &[]);
    let harness = run(&BacktestSpec::new(
        &manifest,
        &strategy,
        "run-401",
        "att-401-1",
    ));
    let evaluation = outcome_of(&harness);
    assert_eq!(evaluation["status"], "NOT_PREPARED");
    assert_eq!(evaluation["code"], "INVALID_INPUT");
    assert!(
        evaluation["detail"]
            .as_str()
            .unwrap()
            .contains("401 sessions exceed the limit of 400")
    );

    let manifest = synthetic_manifest(400, 2, 3, &[]);
    let harness = run(&BacktestSpec::new(
        &manifest,
        &strategy,
        "run-400",
        "att-400-1",
    ));
    assert_eq!(outcome_of(&harness)["status"], "COMPLETED");
}

#[test]
fn the_same_request_run_twice_gives_equal_result_digests() {
    // The deterministic repeat of the pilot: a second BACKTEST over the same input.
    let manifest = synthetic_manifest(300, 2, 26, &[]);
    let strategy = seed(1);
    let first = run(&BacktestSpec::new(
        &manifest,
        &strategy,
        "run-twice-a",
        "att-twice-a-1",
    ));
    let second = run(&BacktestSpec::new(
        &manifest,
        &strategy,
        "run-twice-b",
        "att-twice-b-1",
    ));
    let (a, b) = (outcome_of(&first), outcome_of(&second));
    assert_eq!(a["input"]["digest"], b["input"]["digest"], "the same input");
    assert_eq!(
        a["result"]["digest"], b["result"]["digest"],
        "the same result bytes"
    );
    assert_ne!(
        a["metrics"]["digest"], b["metrics"]["digest"],
        "the metrics name their own run"
    );
}

#[test]
fn the_cost_stress_scenario_changes_the_costs_and_the_metrics_name_it() {
    let manifest = synthetic_manifest(300, 2, 26, &[]);
    let strategy = seed(1);
    let base = run(&BacktestSpec::new(
        &manifest,
        &strategy,
        "run-base",
        "att-base-1",
    ));
    let mut stress_spec = BacktestSpec::new(&manifest, &strategy, "run-stress", "att-stress-1");
    stress_spec.scenario = "COST_STRESS";
    let mut policy = execution_policy(2);
    policy["cost_model"]["fee_bps"] = json!("10");
    policy["cost_model"]["gap_exit_slippage_bps"] = json!("20");
    stress_spec.policy = Some(policy);
    let stress = run(&stress_spec);
    let metrics = |h: &Harness| -> Value {
        serde_json::from_slice(&stored(h, &outcome_of(h)["metrics"])).unwrap()
    };
    let (m_base, m_stress) = (metrics(&base), metrics(&stress));
    assert_eq!(m_stress["window"]["cost_scenario"], "COST_STRESS");
    let fees = |m: &Value| {
        m["strategy"]["execution_cost"]["fees"]["value"]
            .as_str()
            .unwrap()
            .to_owned()
    };
    // Fees are 5 bps of the notional in the base case and 10 bps under stress: twice as much, up
    // to the rounding of each fill to the cent.
    let to_cents = |text: String| -> i128 { text.replace('.', "").parse().unwrap() };
    let (b, s) = (to_cents(fees(&m_base)), to_cents(fees(&m_stress)));
    assert!(
        b > 0 && (s - 2 * b).abs() <= 4,
        "base {b} cents, stress {s} cents"
    );
}

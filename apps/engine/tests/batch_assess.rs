//! The `assess` job through the worker: the gates of one candidate over seven real runs
//! (OQ-02 sections 3.2 and 3.6; decision D18).
//!
//! The candidate is the S0 seed run on synthetic data at AAPL magnitude in the three windows of
//! the pilot, each under base and stress costs, and the deterministic repeat of the first window.
//! Every run, the validation result and the submissions that the assess job reads were produced by
//! the same worker, so the evidence is the real output of the other three jobs. The gate logic has
//! its own exhaustive fixtures (`packages/quant-core/tests/gates_fixtures.rs`); the checks here
//! are the ones that follow from the policy and from the published metrics without recomputing a
//! gate.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

mod batch_support;

use batch_support::{BacktestSpec, Harness, data::*, worker_handled};
use openquant_contracts::{canonical::digest_bytes, generated::GateReport, parse};
use openquant_engine::batch::worker::Handled;
use serde_json::{Value, json};

const GATE_REPORT: &str = "attempts.gate-report";
const SUBMISSION: &str = "attempts.evaluation-submission";

struct Candidate {
    harness: Harness,
    /// The dispatch message of the assess job.
    message: String,
    strategy_digest: String,
    /// Per run: the accepted submission, the window and the scenario.
    runs: Vec<(String, &'static str, &'static str, Value)>,
    validation_digest: String,
}

/// One planned run: its id, window, cost scenario, first and last scored session, and the run it repeats.
type PlannedRun = (
    &'static str,
    &'static str,
    &'static str,
    usize,
    usize,
    Option<&'static str>,
);

fn stress_policy() -> Value {
    let policy = cohort_policy();
    let mut stress = policy["conditions"]["execution_policy"].clone();
    // The pilot's cost stress: every cost parameter times 2.
    stress["cost_model"]["fee_bps"] = json!("10");
    stress["cost_model"]["gap_exit_slippage_bps"] = json!("20");
    stress
}

fn build(drop_runs: &[&str], strategy_readable: bool) -> Candidate {
    let harness = Harness::new();
    let manifest = synthetic_manifest(300, 2, 26, &[]);
    let strategy = seed(1);
    let policy = cohort_policy();
    let base = policy["conditions"]["execution_policy"].clone();
    let stress = stress_policy();
    // (run id, window, scenario, first scored session, last scored session, repeat of)
    let plan: [PlannedRun; 7] = [
        ("run-d-base", "DEVELOPMENT", "BASE", 60, 119, None),
        ("run-d-stress", "DEVELOPMENT", "COST_STRESS", 60, 119, None),
        ("run-v-base", "VALIDATION", "BASE", 120, 179, None),
        ("run-v-stress", "VALIDATION", "COST_STRESS", 120, 179, None),
        ("run-h-base", "HOLDOUT", "BASE", 180, 239, None),
        ("run-h-stress", "HOLDOUT", "COST_STRESS", 180, 239, None),
        (
            "run-d-repeat",
            "DEVELOPMENT",
            "BASE",
            60,
            119,
            Some("run-d-base"),
        ),
    ];
    let mut runs = Vec::new();
    for (run_id, window, scenario, start, end, _) in plan {
        let attempt = format!("att-{run_id}-1");
        let mut spec = BacktestSpec::new(&manifest, &strategy, run_id, &attempt);
        spec.window = window;
        spec.scenario = scenario;
        spec.warmup = start - 60;
        spec.scored_start = start;
        spec.scored_end = end;
        spec.policy = Some(if scenario == "BASE" {
            base.clone()
        } else {
            stress.clone()
        });
        let job = harness.enqueue_backtest(&spec);
        let handled = worker_handled(&harness.poll(), &job.message);
        assert!(
            matches!(handled, Handled::Completed { acked: true, .. }),
            "{run_id}: {handled:?}\n{}",
            harness.log_text()
        );
        let body = harness
            .world()
            .accepted_on(SUBMISSION)
            .into_iter()
            .find(|a| a.attempt_id == attempt)
            .unwrap()
            .body
            .clone();
        assert_eq!(body["evaluation"]["status"], "COMPLETED", "{run_id}");
        runs.push((run_id.to_owned(), window, scenario, body));
    }
    // The validation of the seed, by the same worker.
    let job = harness.enqueue_validate(&strategy, None, "assess");
    assert!(matches!(
        worker_handled(&harness.poll(), &job.message),
        Handled::Completed { .. }
    ));
    let validation = harness.world().accepted_on("attempts.validation-result")[0]
        .body
        .clone();

    let mut world = harness.world();
    let plan_ref = world.store_json(&read_json(
        &repo().join("fixtures/protocol/valid/evaluation-plan.aapl-mission.json"),
    ));
    let policy_ref = world.store_json(&policy);
    let manifest_ref = world.store_json(&manifest);
    let validation_ref = world.store_json(&validation);
    let strategy_digest = digest_bytes(canonical(&strategy).as_bytes());
    let mut assessed = Vec::new();
    for ((run_id, window, scenario, body), (_, _, _, _, _, repeat)) in runs.iter().zip(plan) {
        let mut entry = json!({
            "run_id": run_id,
            "run_slot": format!("seed.{}.{}", window.to_lowercase(), scenario.to_lowercase()),
            "status": "COMPLETED",
            "window_role": window,
            "cost_scenario": scenario,
        });
        if drop_runs.contains(&run_id.as_str()) {
            entry["status"] = json!("CANCELLED");
        } else {
            entry["submission"] = world.store_json(body);
        }
        if let Some(original) = repeat {
            entry["replay_of"] = json!(original);
        }
        assessed.push(entry);
    }
    let inputs = json!({
        "kind": "assess",
        "strategy_hash": strategy_digest,
        "plan": plan_ref,
        "trial_slot": "seed",
        "cohort_policy": policy_ref,
        "validation": validation_ref,
        "runs": assessed,
        "manifests": [manifest_ref],
    });
    if !strategy_readable {
        world.unreadable.insert(strategy_digest.clone());
    }
    let dispatch = batch_support::dispatch_value("job-assess-seed", "att-assess-seed-1", 1, inputs);
    let message = world.enqueue(&dispatch);
    drop(world);
    Candidate {
        harness,
        message,
        strategy_digest,
        runs,
        validation_digest: digest_bytes(canonical(&validation).as_bytes()),
    }
}

fn assess(candidate: &Candidate) -> Value {
    let started = std::time::Instant::now();
    let polled = candidate.harness.poll();
    // The wall time of the whole job over seven real runs, for the timing table of the README.
    eprintln!(
        "assess job over seven runs of 60 scored sessions: {:?}",
        started.elapsed()
    );
    let handled = worker_handled(&polled, &candidate.message);
    assert!(
        matches!(handled, Handled::Completed { acked: true, .. }),
        "{handled:?}\n{}",
        candidate.harness.log_text()
    );
    let world = candidate.harness.world();
    let accepted = world.accepted_on(GATE_REPORT);
    assert_eq!(accepted.len(), 1);
    accepted[0].body.clone()
}

fn gate<'a>(report: &'a Value, id: &str) -> &'a Value {
    report["gates"]
        .as_array()
        .unwrap()
        .iter()
        .find(|g| g["gate"] == id)
        .unwrap_or_else(|| panic!("no gate {id}"))
}

/// A decimal text as hundred-millionths, for an exact comparison without a float.
fn micros(text: &str) -> i128 {
    let negative = text.starts_with('-');
    let digits = text.trim_start_matches('-');
    let (whole, fraction) = digits.split_once('.').unwrap_or((digits, ""));
    let mut fraction = fraction.to_owned();
    while fraction.len() < 8 {
        fraction.push('0');
    }
    let value =
        whole.parse::<i128>().unwrap() * 100_000_000 + fraction[..8].parse::<i128>().unwrap();
    if negative { -value } else { value }
}

#[test]
fn the_report_has_the_gates_of_the_policy_in_order_and_binds_the_candidate_and_the_policy() {
    let candidate = build(&[], true);
    let report = assess(&candidate);
    let _: GateReport = parse(&report.to_string()).unwrap();
    let policy = cohort_policy();
    let wanted: Vec<&str> = policy["gates"]
        .as_array()
        .unwrap()
        .iter()
        .map(|g| g["gate"].as_str().unwrap())
        .collect();
    let found: Vec<&str> = report["gates"]
        .as_array()
        .unwrap()
        .iter()
        .map(|g| g["gate"].as_str().unwrap())
        .collect();
    assert_eq!(
        found, wanted,
        "every gate of the policy once, in policy order"
    );
    assert_eq!(wanted.len(), 17);
    assert_eq!(report["strategy_hash"], candidate.strategy_digest.as_str());
    assert_eq!(report["cohort_policy"]["id"], policy["policy_id"]);
    assert_eq!(report["cohort_policy"]["revision"], policy["revision"]);
    assert_eq!(
        report["cohort_policy"]["digest"],
        digest_bytes(canonical(&policy).as_bytes())
    );
    assert_eq!(report["method"]["digest"], METHOD_DIGEST);
    assert_eq!(report["executable"]["name"], "engine-batch");
    assert_eq!(report["job_id"], "job-assess-seed");
    // Each gate of the policy that is recorded as insufficient or not applicable says so, with the
    // reason that the policy states.
    for rule in policy["gates"].as_array().unwrap() {
        let outcome = gate(&report, rule["gate"].as_str().unwrap());
        assert_eq!(outcome["category"], rule["category"]);
        match rule["requirement"].as_str().unwrap() {
            "RECORDED_INSUFFICIENT" => {
                assert_eq!(outcome["result"], "INSUFFICIENT", "{}", rule["gate"]);
                assert_eq!(outcome["reason_code"], "POLICY_RECORDED");
                assert_eq!(outcome["reason"], rule["reason"]);
            }
            "NOT_APPLICABLE" => {
                assert_eq!(outcome["result"], "NOT_APPLICABLE", "{}", rule["gate"]);
                assert_eq!(outcome["reason_code"], "POLICY_RECORDED");
                assert_eq!(outcome["reason"], rule["reason"]);
            }
            _ => {}
        }
    }
    // The inputs that the report lists are the artefacts that the job read: the plan, the
    // validation result, the manifest and the submission of every run, each by its digest.
    let inputs = report["inputs"].as_array().unwrap();
    let digests: Vec<&str> = inputs
        .iter()
        .map(|i| i["digest"].as_str().unwrap())
        .collect();
    assert!(digests.contains(&candidate.validation_digest.as_str()));
    for (run_id, _, _, body) in &candidate.runs {
        let digest = digest_bytes(canonical(body).as_bytes());
        assert!(
            inputs.iter().any(|i| i["kind"] == "EVALUATION_SUBMISSION"
                && i["run_id"] == run_id.as_str()
                && i["digest"] == digest.as_str()),
            "{run_id}"
        );
    }
    assert!(inputs.iter().any(|i| i["kind"] == "EVALUATION_PLAN"));
    assert!(inputs.iter().any(|i| i["kind"] == "DATASET_MANIFEST"));
}

#[test]
fn the_gates_that_follow_from_the_evidence_are_decided_as_the_evidence_says() {
    let candidate = build(&[], true);
    let report = assess(&candidate);
    // The seed validates, so DEFINITION_VALIDATION passes.
    assert_eq!(gate(&report, "DEFINITION_VALIDATION")["result"], "PASS");
    // The repeat of the first window ran the same input: equal result digests, so replay passes.
    let digest_of = |run: &str| {
        candidate.runs.iter().find(|r| r.0 == run).unwrap().3["evaluation"]["result"]["digest"]
            .clone()
    };
    assert_eq!(digest_of("run-d-base"), digest_of("run-d-repeat"));
    assert_eq!(gate(&report, "DETERMINISTIC_REPLAY")["result"], "PASS");
    // The core's own results reconcile and respect timing: the audits that the job reran pass.
    assert_eq!(gate(&report, "ACCOUNTING_RECONCILIATION")["result"], "PASS");
    assert_eq!(gate(&report, "SIGNAL_DATA_TIMING")["result"], "PASS");
    // Every bar and action of the manifest has an availability time. The approved limitation
    // travels with the gate.
    let point_in_time = gate(&report, "POINT_IN_TIME_DATA");
    assert_eq!(point_in_time["result"], "PASS");
    let policy = cohort_policy();
    let rule = policy["gates"]
        .as_array()
        .unwrap()
        .iter()
        .find(|g| g["gate"] == "POINT_IN_TIME_DATA")
        .unwrap();
    assert_eq!(point_in_time["limitation"], rule["limitation"]);
    // The cost model of the runs is the cohort's.
    assert_eq!(gate(&report, "BASE_COST_MODEL")["result"], "PASS");
}

#[test]
fn a_threshold_gate_passes_exactly_when_the_published_metrics_clear_the_threshold() {
    let candidate = build(&[], true);
    let report = assess(&candidate);
    let world = candidate.harness.world();
    let metric = |run: &str, path: &[&str]| -> Value {
        let body = &candidate.runs.iter().find(|r| r.0 == run).unwrap().3;
        let bytes = &world.artefacts[body["evaluation"]["metrics"]["digest"].as_str().unwrap()];
        let mut value: Value = serde_json::from_slice(bytes).unwrap();
        for key in path {
            value = value[*key].clone();
        }
        value
    };
    let windows = [("d", "DEVELOPMENT"), ("v", "VALIDATION"), ("h", "HOLDOUT")];
    // The minimum trade count: at least 10 closed trades in every window under base costs.
    let enough = windows.iter().all(|(w, _)| {
        metric(
            &format!("run-{w}-base"),
            &["strategy", "trade_count", "value"],
        )
        .as_u64()
        .unwrap()
            >= 10
    });
    let outcome = gate(&report, "MINIMUM_TRADE_COUNT")["result"]
        .as_str()
        .unwrap();
    assert_eq!(outcome == "PASS", enough, "{outcome}");
    assert!(
        !enough,
        "these windows hold fewer than ten trades, so the gate is not a pass"
    );
    // Excess over buy-and-hold: above zero in every window under base costs.
    for (suffix, id) in [
        ("base", "EXCESS_OVER_BUY_AND_HOLD"),
        ("stress", "COST_STRESS"),
    ] {
        let positive = windows.iter().all(|(w, _)| {
            let excess = metric(
                &format!("run-{w}-{suffix}"),
                &["benchmarks", "buy_and_hold", "excess_return", "value"],
            );
            excess.as_str().is_some_and(|text| micros(text) > 0)
        });
        let outcome = gate(&report, id)["result"].as_str().unwrap();
        assert_eq!(outcome == "PASS", positive, "{id}: {outcome}");
    }
    // Walk-forward passes only when every window passes on its own.
    let walk = gate(&report, "WALK_FORWARD")["result"].as_str().unwrap();
    let all_windows = windows.iter().all(|(w, _)| {
        let excess = metric(
            &format!("run-{w}-base"),
            &["benchmarks", "buy_and_hold", "excess_return", "value"],
        );
        excess.as_str().is_some_and(|text| micros(text) > 0)
    });
    assert_eq!(walk == "PASS", all_windows, "{walk}");
}

#[test]
fn a_run_without_a_result_leaves_its_window_insufficient_and_the_other_gates_alone() {
    let candidate = build(&["run-h-base", "run-h-stress"], true);
    let report = assess(&candidate);
    for id in [
        "WALK_FORWARD",
        "MINIMUM_TRADE_COUNT",
        "EXCESS_OVER_BUY_AND_HOLD",
        "COST_STRESS",
    ] {
        assert_ne!(
            gate(&report, id)["result"],
            "PASS",
            "{id}: the holdout window has no evidence"
        );
    }
    assert_eq!(gate(&report, "DEFINITION_VALIDATION")["result"], "PASS");
    assert_eq!(gate(&report, "DETERMINISTIC_REPLAY")["result"], "PASS");
    // The two runs without a submission are not listed among the inputs.
    let inputs = report["inputs"].as_array().unwrap();
    assert!(
        !inputs
            .iter()
            .any(|i| i["run_id"] == "run-h-base" || i["run_id"] == "run-h-stress")
    );
}

#[test]
fn a_strategy_that_the_attempt_cannot_read_stops_the_assessment_loudly() {
    // The audits rebuild each completed run from its strategy and input. The assess dispatch
    // names the strategy by hash only, so the API must serve it: when it does not, the job has
    // no way to audit, and it writes no report rather than a report that hides the gap.
    let candidate = build(&[], false);
    let handled = worker_handled(&candidate.harness.poll(), &candidate.message);
    let Handled::Abandoned { reason } = handled else {
        panic!("{handled:?}");
    };
    assert!(
        reason.contains("strategy artefact") && reason.contains("audit"),
        "{reason}"
    );
    let world = candidate.harness.world();
    assert!(world.accepted_on(GATE_REPORT).is_empty());
    assert!(!world.is_acked(&candidate.message));
}

#[test]
fn an_attempt_that_loses_its_lease_during_the_assessment_writes_no_report() {
    let candidate = build(&[], true);
    // The lease ends before the report is submitted.
    candidate
        .harness
        .world()
        .on(GATE_REPORT, 1, batch_support::Action::Advance(700));
    let handled = worker_handled(&candidate.harness.poll(), &candidate.message);
    let Handled::Abandoned { reason } = handled else {
        panic!("{handled:?}");
    };
    assert!(reason.contains("LEASE_EXPIRED"), "{reason}");
    assert!(
        candidate
            .harness
            .world()
            .accepted_on(GATE_REPORT)
            .is_empty()
    );
    assert!(!candidate.harness.world().is_acked(&candidate.message));
}

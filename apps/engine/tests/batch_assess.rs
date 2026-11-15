//! The `assess` job through the worker: the gates of one candidate over seven real runs
//! (OQ-02 sections 3.2 and 3.6; decision D18).
//!
//! The candidate is the S0 seed run on synthetic data at AAPL magnitude in the three windows of
//! the pilot, each under base and stress costs, and the deterministic repeat of the first window.
//! Every run, the validation result and the submissions that the assess job reads were produced by
//! the same worker, so the evidence is the real output of the other three jobs. The evaluation
//! plan is a real one: the pilot plan with its windows resolved to the sessions of the synthetic
//! calendar, so that each run belongs to a planned run slot and to the window that the plan
//! resolved. The gate logic has its own exhaustive fixtures
//! (`packages/quant-core/tests/gates_fixtures.rs`); the checks here are the ones that follow from
//! the policy and from the published metrics without recomputing a gate, and the bindings of the
//! evidence to the plan, the slot, the candidate and the running binary.
//!
//! The binding tests change one stored document of an otherwise good candidate (a label of the
//! dispatch, a member of a submission, of a metrics document, of the validation result, of the
//! manifest or of the plan) and expect the gates that read it to say `INSUFFICIENT` with the reason
//! code that names what is missing. They use a policy whose thresholds this candidate clears in
//! every window, so that a missing observation, not a failing one, decides each threshold gate.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

mod batch_support;

use std::collections::BTreeMap;

use batch_support::{BacktestSpec, Harness, data::*, dates_of, worker_handled};
use openquant_contracts::{
    canonical::digest_bytes,
    generated::{EvaluationPlan, GateReport},
    parse,
};
use openquant_engine::batch::worker::Handled;
use serde_json::{Value, json};

const GATE_REPORT: &str = "attempts.gate-report";
const SUBMISSION: &str = "attempts.evaluation-submission";

/// A digest that is none of the candidate's.
const OTHER: &str = "sha256:5555555555555555555555555555555555555555555555555555555555555555";

struct Candidate {
    harness: Harness,
    /// The dispatch message of the assess job.
    message: String,
    strategy_digest: String,
    /// Per run: the submission that the dispatch cites, the window and the scenario.
    runs: Vec<(String, &'static str, &'static str, Value)>,
    validation_digest: String,
}

/// One planned run of the seed slot.
struct Planned {
    run: &'static str,
    /// The run slot of the plan.
    slot: &'static str,
    window: &'static str,
    scenario: &'static str,
    /// The first and the last scored session, as indices into the calendar of the manifest.
    scored: (usize, usize),
    /// The run that it repeats.
    repeat_of: Option<&'static str>,
}

const PLANNED: [Planned; 7] = [
    Planned {
        run: "run-d-base",
        slot: "seed.d.base",
        window: "DEVELOPMENT",
        scenario: "BASE",
        scored: (60, 119),
        repeat_of: None,
    },
    Planned {
        run: "run-d-stress",
        slot: "seed.d.stress",
        window: "DEVELOPMENT",
        scenario: "COST_STRESS",
        scored: (60, 119),
        repeat_of: None,
    },
    Planned {
        run: "run-v-base",
        slot: "seed.v.base",
        window: "VALIDATION",
        scenario: "BASE",
        scored: (120, 179),
        repeat_of: None,
    },
    Planned {
        run: "run-v-stress",
        slot: "seed.v.stress",
        window: "VALIDATION",
        scenario: "COST_STRESS",
        scored: (120, 179),
        repeat_of: None,
    },
    Planned {
        run: "run-h-base",
        slot: "seed.h.base",
        window: "HOLDOUT",
        scenario: "BASE",
        scored: (180, 239),
        repeat_of: None,
    },
    Planned {
        run: "run-h-stress",
        slot: "seed.h.stress",
        window: "HOLDOUT",
        scenario: "COST_STRESS",
        scored: (180, 239),
        repeat_of: None,
    },
    Planned {
        run: "run-d-repeat",
        slot: "seed.d.base.repeat",
        window: "DEVELOPMENT",
        scenario: "BASE",
        scored: (60, 119),
        repeat_of: Some("run-d-base"),
    },
];

/// The documents of the dispatch, before they are stored. A binding test changes one of them.
struct Parts {
    plan: Value,
    manifest: Value,
    validation: Value,
    /// The entries of `runs` of the dispatch, in order.
    assessed: Vec<Value>,
    /// The accepted submission of each run, by run id.
    submissions: BTreeMap<String, Value>,
    /// The metrics document of each completed run, by run id.
    metrics: BTreeMap<String, Value>,
}

fn stress_policy(policy: &Value) -> Value {
    let mut stress = policy["conditions"]["execution_policy"].clone();
    // The pilot's cost stress: every cost parameter times 2.
    stress["cost_model"]["fee_bps"] = json!("10");
    stress["cost_model"]["gap_exit_slippage_bps"] = json!("20");
    stress
}

/// The pilot policy with the thresholds loosened until this candidate clears them in every
/// window: the observed returns and trade counts of the synthetic runs are what they are, and
/// the binding tests need a baseline in which every required gate passes.
fn lenient_policy() -> Value {
    let mut policy = cohort_policy();
    for rule in policy["gates"].as_array_mut().unwrap() {
        let Some(thresholds) = rule.get_mut("thresholds").and_then(Value::as_array_mut) else {
            continue;
        };
        for threshold in thresholds {
            if threshold["metric"] == "trade_count" {
                threshold["value"] = json!("0");
            } else {
                threshold["value"] = json!("-1");
            }
        }
    }
    policy
}

/// The evaluation plan of the candidate, as the API records it: the plan of the pilot mission with
/// its windows resolved to the sessions of the synthetic calendar, the seed slot bound to the
/// strategy and the cohort policy of the test.
fn registered_plan(dates: &[String], strategy_digest: &str, policy: &Value) -> Value {
    let mut plan =
        read_json(&repo().join("fixtures/protocol/valid/evaluation-plan.aapl-mission.json"));
    let windows: Vec<Value> = [
        ("DEVELOPMENT", 60_usize, 119_usize),
        ("VALIDATION", 120, 179),
        ("HOLDOUT", 180, 239),
    ]
    .iter()
    .map(|(role, start, end)| {
        let warmup = start - 60;
        json!({
            "role": role,
            "rule": {"start": dates[*start], "end": dates[*end]},
            "label": "a window of the synthetic calendar",
            "resolved": {
                "warmup_start": dates[warmup],
                "scored_start": dates[*start],
                "scored_end": dates[*end],
                "information_cutoff": format!("{}T23:00:00Z", dates[*end]),
            },
            "run_sessions": end - warmup + 1,
        })
    })
    .collect();
    plan["windows"] = json!(windows);
    plan["trial_slots"][0]["draft_digest"] = json!(strategy_digest);
    plan["cohort_policy"] = json!({
        "id": policy["policy_id"],
        "revision": policy["revision"],
        "digest": digest_bytes(canonical(policy).as_bytes()),
    });
    let _: EvaluationPlan = parse(&canonical(&plan)).expect("the plan is valid");
    plan
}

fn build(drop_runs: &[&str], strategy_readable: bool) -> Candidate {
    build_with(&cohort_policy(), drop_runs, strategy_readable, &|_| {})
}

/// A candidate whose thresholds it clears in every window, with one stored document changed.
fn lenient(tamper: &dyn Fn(&mut Parts)) -> Candidate {
    build_with(&lenient_policy(), &[], true, tamper)
}

fn build_with(
    policy: &Value,
    drop_runs: &[&str],
    strategy_readable: bool,
    tamper: &dyn Fn(&mut Parts),
) -> Candidate {
    let harness = Harness::new();
    let manifest = synthetic_manifest(300, 2, 26, &[]);
    let dates = dates_of(&manifest);
    let strategy = seed(1);
    let strategy_digest = digest_bytes(canonical(&strategy).as_bytes());
    let plan = registered_plan(&dates, &strategy_digest, policy);
    let plan_digest = digest_bytes(canonical(&plan).as_bytes());
    let base = policy["conditions"]["execution_policy"].clone();
    let stress = stress_policy(policy);
    let mut runs = Vec::new();
    for planned in &PLANNED {
        let run_id = planned.run;
        let attempt = format!("att-{run_id}-1");
        let mut spec = BacktestSpec::new(&manifest, &strategy, run_id, &attempt);
        spec.window = planned.window;
        spec.scenario = planned.scenario;
        spec.warmup = planned.scored.0 - 60;
        spec.scored_start = planned.scored.0;
        spec.scored_end = planned.scored.1;
        spec.policy = Some(if planned.scenario == "BASE" {
            base.clone()
        } else {
            stress.clone()
        });
        spec.cohort = Some(policy.clone());
        spec.run_slot = Some(planned.slot.to_owned());
        spec.plan_digest = Some(plan_digest.clone());
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
        runs.push((run_id.to_owned(), planned.window, planned.scenario, body));
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

    let mut parts = Parts {
        plan,
        manifest: manifest.clone(),
        validation,
        assessed: Vec::new(),
        submissions: BTreeMap::new(),
        metrics: BTreeMap::new(),
    };
    for ((run_id, _, _, body), planned) in runs.iter().zip(&PLANNED) {
        let metrics_digest = body["evaluation"]["metrics"]["digest"].as_str().unwrap();
        let metrics: Value =
            serde_json::from_slice(&harness.world().artefacts[metrics_digest]).unwrap();
        parts.metrics.insert(run_id.clone(), metrics);
        parts.submissions.insert(run_id.clone(), body.clone());
        let mut entry = json!({
            "run_id": run_id,
            "run_slot": planned.slot,
            "status": if drop_runs.contains(&run_id.as_str()) { "CANCELLED" } else { "COMPLETED" },
            "window_role": planned.window,
            "cost_scenario": planned.scenario,
        });
        if let Some(original) = planned.repeat_of {
            entry["replay_of"] = json!(original);
        }
        parts.assessed.push(entry);
    }
    tamper(&mut parts);

    let mut world = harness.world();
    let plan_ref = world.store_json(&parts.plan);
    let policy_ref = world.store_json(policy);
    let manifest_ref = world.store_json(&parts.manifest);
    let validation_ref = world.store_json(&parts.validation);
    let mut cited = Vec::new();
    for entry in &mut parts.assessed {
        let run_id = entry["run_id"].as_str().unwrap().to_owned();
        if entry["status"] == "COMPLETED"
            && let Some(mut body) = parts.submissions.get(&run_id).cloned()
        {
            // A changed metrics document is stored as itself and cited by the submission.
            if let Some(metrics) = parts.metrics.get(&run_id) {
                body["evaluation"]["metrics"] = world.store_json(metrics);
            }
            entry["submission"] = world.store_json(&body);
            let planned = PLANNED.iter().find(|p| p.run == run_id);
            cited.push((
                run_id,
                planned.map_or("?", |p| p.window),
                planned.map_or("?", |p| p.scenario),
                body,
            ));
        }
    }
    let inputs = json!({
        "kind": "assess",
        "strategy_hash": strategy_digest,
        "plan": plan_ref,
        "trial_slot": "seed",
        "cohort_policy": policy_ref,
        "validation": validation_ref,
        "runs": parts.assessed,
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
        runs: cited,
        validation_digest: digest_bytes(canonical(&parts.validation).as_bytes()),
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

// ---- binding the evidence to the plan, the slot, the candidate and the running binary ----------

const THRESHOLD_GATES: [&str; 4] = [
    "EXCESS_OVER_BUY_AND_HOLD",
    "WALK_FORWARD",
    "MINIMUM_TRADE_COUNT",
    "COST_STRESS",
];

/// The gates that read every run of the candidate, whatever its window.
const RUN_GATES: [&str; 3] = [
    "ACCOUNTING_RECONCILIATION",
    "SIGNAL_DATA_TIMING",
    "BASE_COST_MODEL",
];

/// The threshold gates that read the base-cost runs, among them the validation run `run-v-base`.
const BASE_THRESHOLD_GATES: [&str; 3] = [
    "EXCESS_OVER_BUY_AND_HOLD",
    "WALK_FORWARD",
    "MINIMUM_TRADE_COUNT",
];

fn set(document: &mut Value, pointer: &str, value: Value) {
    *document
        .pointer_mut(pointer)
        .unwrap_or_else(|| panic!("the document has no member {pointer}")) = value;
}

/// The gate must be `INSUFFICIENT` with this reason code.
fn insufficient<'a>(report: &'a Value, id: &str, code: &str) -> &'a Value {
    let outcome = gate(report, id);
    assert_eq!(outcome["result"], "INSUFFICIENT", "{id}: {outcome}");
    assert_eq!(outcome["reason_code"], code, "{id}: {outcome}");
    outcome
}

fn passes(report: &Value, id: &str) {
    let outcome = gate(report, id);
    assert_eq!(outcome["result"], "PASS", "{id}: {outcome}");
}

/// The text that names why a gate is insufficient.
fn reason(outcome: &Value) -> &str {
    outcome["reason"].as_str().unwrap()
}

/// Whether any gate of the report cites the digest as evidence.
fn cites(report: &Value, digest: &str) -> bool {
    report["gates"].as_array().unwrap().iter().any(|g| {
        g["evidence"]
            .as_array()
            .is_some_and(|list| list.iter().any(|d| d == digest))
    })
}

fn submission_digest(candidate: &Candidate, run: &str) -> String {
    let body = &candidate.runs.iter().find(|r| r.0 == run).unwrap().3;
    digest_bytes(canonical(body).as_bytes())
}

/// No observation of the gate is of this run.
fn without_observation_of(outcome: &Value, run: &str) {
    for observation in outcome["observations"].as_array().into_iter().flatten() {
        assert_ne!(observation["run_id"], run, "{outcome}");
    }
}

#[test]
fn a_candidate_that_matches_its_plan_passes_every_required_gate() {
    // The baseline of the binding tests below: the real plan, the lenient thresholds, nothing
    // changed. Each test then changes one document and expects the gates that read it to stop.
    let candidate = lenient(&|_| {});
    let report = assess(&candidate);
    for id in [
        "DEFINITION_VALIDATION",
        "DETERMINISTIC_REPLAY",
        "ACCOUNTING_RECONCILIATION",
        "SIGNAL_DATA_TIMING",
        "POINT_IN_TIME_DATA",
        "BASE_COST_MODEL",
    ]
    .into_iter()
    .chain(THRESHOLD_GATES)
    {
        passes(&report, id);
    }
    // Each threshold gate read the three windows: two thresholds, three windows.
    for id in THRESHOLD_GATES {
        let want = if id == "MINIMUM_TRADE_COUNT" { 3 } else { 6 };
        assert_eq!(
            gate(&report, id)["observations"].as_array().unwrap().len(),
            want
        );
    }
}

#[test]
fn swapped_window_labels_do_not_attribute_the_evidence_to_the_wrong_window() {
    // The dispatch calls the validation runs HOLDOUT and the holdout runs VALIDATION. Their run
    // slots are the plan's slots of the other windows: the labels do not match the plan, so the
    // four runs are not evidence, and walk-forward must not report the holdout run as validation.
    let candidate = lenient(&|parts| {
        for entry in &mut parts.assessed {
            let swapped = match entry["window_role"].as_str().unwrap() {
                "VALIDATION" => "HOLDOUT",
                "HOLDOUT" => "VALIDATION",
                other => other,
            };
            entry["window_role"] = json!(swapped);
        }
    });
    let report = assess(&candidate);
    for id in THRESHOLD_GATES {
        let outcome = insufficient(&report, id, "RUN_MISSING");
        assert!(reason(outcome).contains("window_role"), "{outcome}");
        for observation in outcome["observations"].as_array().unwrap() {
            assert_eq!(observation["window"], "DEVELOPMENT", "{outcome}");
        }
    }
    for id in RUN_GATES {
        let outcome = insufficient(&report, id, "RUN_MISSING");
        assert!(reason(outcome).contains("window_role"), "{outcome}");
    }
    // Nothing that the labels do not touch changes.
    for id in [
        "DEFINITION_VALIDATION",
        "DETERMINISTIC_REPLAY",
        "POINT_IN_TIME_DATA",
    ] {
        passes(&report, id);
    }
}

#[test]
fn a_planned_run_that_the_dispatch_leaves_out_makes_every_gate_that_needs_it_insufficient() {
    // The holdout run under stress costs is planned (slot seed.h.stress) and not in the dispatch.
    // The audits and the cost-model check read every run of the plan, not only the listed ones.
    let candidate = lenient(&|parts| {
        parts
            .assessed
            .retain(|entry| entry["run_id"] != "run-h-stress");
    });
    let report = assess(&candidate);
    let outcome = insufficient(&report, "COST_STRESS", "RUN_MISSING");
    assert!(reason(outcome).contains("seed.h.stress"), "{outcome}");
    for id in RUN_GATES {
        let outcome = insufficient(&report, id, "RUN_MISSING");
        assert!(reason(outcome).contains("seed.h.stress"), "{id}: {outcome}");
    }
    // The gates that need only the runs that are present still decide.
    for id in BASE_THRESHOLD_GATES.into_iter().chain([
        "DEFINITION_VALIDATION",
        "DETERMINISTIC_REPLAY",
        "POINT_IN_TIME_DATA",
    ]) {
        passes(&report, id);
    }
}

#[test]
fn a_planned_repeat_that_the_dispatch_leaves_out_leaves_the_replay_and_the_audits_insufficient() {
    let candidate = lenient(&|parts| {
        parts
            .assessed
            .retain(|entry| entry["run_id"] != "run-d-repeat");
    });
    let report = assess(&candidate);
    let outcome = insufficient(&report, "DETERMINISTIC_REPLAY", "RUN_MISSING");
    assert!(reason(outcome).contains("seed.d.base.repeat"), "{outcome}");
    for id in RUN_GATES {
        insufficient(&report, id, "RUN_MISSING");
    }
    for id in THRESHOLD_GATES {
        passes(&report, id);
    }
}

#[test]
fn a_run_that_names_no_slot_of_the_plan_is_not_evidence() {
    // run-v-base names a slot that the plan does not list: the planned validation slot is empty
    // and the stray run is not its evidence.
    let candidate = lenient(&|parts| {
        for entry in &mut parts.assessed {
            if entry["run_id"] == "run-v-base" {
                entry["run_slot"] = json!("seed.v.elsewhere");
            }
        }
    });
    let report = assess(&candidate);
    for id in BASE_THRESHOLD_GATES {
        let outcome = insufficient(&report, id, "RUN_MISSING");
        assert!(reason(outcome).contains("run_slot"), "{id}: {outcome}");
        without_observation_of(outcome, "run-v-base");
    }
    for id in RUN_GATES {
        insufficient(&report, id, "RUN_MISSING");
    }
    passes(&report, "COST_STRESS");
}

#[test]
fn two_runs_for_one_planned_slot_are_not_evidence_of_it() {
    let candidate = lenient(&|parts| {
        parts.assessed.push(json!({
            "run_id": "run-v-base-again",
            "run_slot": "seed.v.base",
            "status": "CANCELLED",
            "window_role": "VALIDATION",
            "cost_scenario": "BASE",
        }));
    });
    let report = assess(&candidate);
    for id in BASE_THRESHOLD_GATES {
        let outcome = insufficient(&report, id, "RUN_MISSING");
        assert!(reason(outcome).contains("seed.v.base"), "{id}: {outcome}");
        without_observation_of(outcome, "run-v-base");
    }
    passes(&report, "COST_STRESS");
}

#[test]
fn a_repeat_that_the_dispatch_does_not_mark_as_a_repeat_is_not_evidence() {
    // The plan says that slot seed.d.base.repeat repeats seed.d.base. The dispatch drops the
    // replay_of of that run, which would make it a second regular run of the development window.
    let candidate = lenient(&|parts| {
        for entry in &mut parts.assessed {
            if entry["run_id"] == "run-d-repeat" {
                entry.as_object_mut().unwrap().remove("replay_of");
            }
        }
    });
    let report = assess(&candidate);
    let outcome = insufficient(&report, "DETERMINISTIC_REPLAY", "RUN_MISSING");
    assert!(reason(outcome).contains("replay_of"), "{outcome}");
    for id in RUN_GATES {
        insufficient(&report, id, "RUN_MISSING");
    }
    for id in THRESHOLD_GATES {
        passes(&report, id);
    }
}

#[test]
fn a_run_of_another_window_than_the_plan_resolved_is_not_evidence() {
    // The plan resolved the holdout window to end on another session than the run's input says.
    let candidate = lenient(&|parts| {
        let start = parts.plan["windows"][2]["resolved"]["scored_start"].clone();
        set(&mut parts.plan, "/windows/2/resolved/scored_end", start);
    });
    let report = assess(&candidate);
    for id in THRESHOLD_GATES {
        let outcome = insufficient(&report, id, "RUN_MISSING");
        assert!(reason(outcome).contains("input.windows"), "{id}: {outcome}");
        for observation in outcome["observations"].as_array().unwrap() {
            assert_ne!(observation["window"], "HOLDOUT", "{outcome}");
        }
    }
    for id in RUN_GATES {
        insufficient(&report, id, "RUN_MISSING");
    }
}

#[test]
fn a_submission_that_is_not_the_slots_is_not_evidence() {
    let variants = [
        ("submission.run_id", "/run_id", json!("run-another")),
        ("submission.engine_digest", "/engine_digest", json!(OTHER)),
        ("submission.method", "/method/digest", json!(OTHER)),
        ("submission.method", "/method/version", json!("999")),
        ("submission.method", "/method/name", json!("another-method")),
    ];
    for (field, pointer, wrong) in variants {
        let candidate = lenient(&|parts| {
            set(
                parts.submissions.get_mut("run-v-base").unwrap(),
                pointer,
                wrong.clone(),
            );
        });
        let report = assess(&candidate);
        for id in BASE_THRESHOLD_GATES {
            let outcome = insufficient(&report, id, "RUN_MISSING");
            assert!(
                reason(outcome).contains(field) && reason(outcome).contains("run-v-base"),
                "{field} {pointer}: {outcome}"
            );
            without_observation_of(outcome, "run-v-base");
        }
        for id in RUN_GATES {
            insufficient(&report, id, "RUN_MISSING");
        }
        // The stress run of the same window is another slot and decides its gate.
        passes(&report, "COST_STRESS");
        assert!(
            !cites(&report, &submission_digest(&candidate, "run-v-base")),
            "{field} {pointer}: a gate cites the submission that does not bind"
        );
    }
}

#[test]
fn metrics_that_are_not_the_runs_are_not_used() {
    let variants = [
        ("metrics.run_id", "/run_id", json!("run-another")),
        ("metrics.window.role", "/window/role", json!("HOLDOUT")),
        (
            "metrics.window.cost_scenario",
            "/window/cost_scenario",
            json!("COST_STRESS"),
        ),
        (
            "metrics.window.scored",
            "/window/scored/end",
            json!("2031-12-31"),
        ),
        (
            "metrics.source.result_digest",
            "/source/result_digest",
            json!(OTHER),
        ),
        (
            "metrics.source.input_hash",
            "/source/input_hash",
            json!(OTHER),
        ),
        (
            "metrics.source.strategy_hash",
            "/source/strategy_hash",
            json!(OTHER),
        ),
        (
            "metrics.source.engine_digest",
            "/source/engine_digest",
            json!(OTHER),
        ),
        ("metrics.method", "/method/digest", json!(OTHER)),
        ("metrics.method", "/method/version", json!("999")),
        ("metrics.method", "/method/name", json!("another-method")),
    ];
    for (field, pointer, wrong) in variants {
        let candidate = lenient(&|parts| {
            set(
                parts.metrics.get_mut("run-v-base").unwrap(),
                pointer,
                wrong.clone(),
            );
        });
        let report = assess(&candidate);
        for id in BASE_THRESHOLD_GATES {
            let outcome = insufficient(&report, id, "METRICS_UNAVAILABLE");
            assert!(
                reason(outcome).contains(field) && reason(outcome).contains("run-v-base"),
                "{field} {pointer}: {outcome}"
            );
            without_observation_of(outcome, "run-v-base");
        }
        passes(&report, "COST_STRESS");
        // The run itself is the slot's: the audits, which do not read the metrics, still pass.
        for id in RUN_GATES {
            passes(&report, id);
        }
    }
}

#[test]
fn metrics_that_the_result_does_not_support_are_not_used() {
    // The document names the right run, window, result and method, and states a number that the
    // result does not give: the assess job recomputes the metrics from the result it rebuilt.
    for pointer in [
        "/benchmarks/buy_and_hold/excess_return/value",
        "/strategy/net_return/value",
        "/strategy/trade_count/value",
    ] {
        let candidate = lenient(&|parts| {
            let wrong = if pointer.ends_with("trade_count/value") {
                json!(999)
            } else {
                json!("9.000000")
            };
            set(parts.metrics.get_mut("run-v-base").unwrap(), pointer, wrong);
        });
        let report = assess(&candidate);
        for id in BASE_THRESHOLD_GATES {
            let outcome = insufficient(&report, id, "METRICS_UNAVAILABLE");
            assert!(
                reason(outcome).contains("recomputed"),
                "{pointer}: {outcome}"
            );
            without_observation_of(outcome, "run-v-base");
        }
        passes(&report, "COST_STRESS");
    }
}

#[test]
fn a_manifest_of_another_dataset_than_the_runs_is_not_evidence() {
    for (pointer, wrong) in [
        ("/dataset/id", json!("some-other-dataset")),
        ("/dataset/version", json!("another-version")),
    ] {
        let candidate = lenient(&|parts| set(&mut parts.manifest, pointer, wrong.clone()));
        let report = assess(&candidate);
        let outcome = insufficient(&report, "POINT_IN_TIME_DATA", "RUN_MISSING");
        assert!(reason(outcome).contains("manifest.dataset"), "{outcome}");
        // The manifest was read, and no gate cites it.
        let manifest_digest = report["inputs"]
            .as_array()
            .unwrap()
            .iter()
            .find(|i| i["kind"] == "DATASET_MANIFEST")
            .unwrap()["digest"]
            .as_str()
            .unwrap()
            .to_owned();
        assert!(!cites(&report, &manifest_digest));
        for id in THRESHOLD_GATES.into_iter().chain(RUN_GATES) {
            passes(&report, id);
        }
    }
}

#[test]
fn a_validation_result_of_another_draft_engine_or_method_is_not_evidence() {
    let variants = [
        ("validation.draft_digest", "/draft_digest", json!(OTHER)),
        ("validation.engine_digest", "/engine_digest", json!(OTHER)),
        ("validation.method", "/method/digest", json!(OTHER)),
        ("validation.method", "/method/version", json!("999")),
    ];
    for (field, pointer, wrong) in variants {
        let candidate = lenient(&|parts| set(&mut parts.validation, pointer, wrong.clone()));
        let report = assess(&candidate);
        let outcome = insufficient(&report, "DEFINITION_VALIDATION", "VALIDATION_FAILED");
        assert!(reason(outcome).contains(field), "{field}: {outcome}");
        assert!(
            !cites(&report, &candidate.validation_digest),
            "{field}: a gate cites the validation result that does not bind"
        );
        for id in THRESHOLD_GATES.into_iter().chain(RUN_GATES) {
            passes(&report, id);
        }
    }
}

//! The S1 cohort gates against the independent fixtures (OQ-02 sections 3.2 and 3.6; decision D18
//! of the pilot record).
//!
//! Each `G-*` case holds a policy, compact evidence and the gate outcomes that `oracle.py`
//! derived by the rules of the method text. The evidence names the metrics that a threshold reads
//! (net return, excess return, trade count); the test builds a schema-valid `evaluation-metrics/1`
//! document around them, so the gates read published metrics and nothing else. The tests also
//! build the finished `gate-report/1`, which the schema validates.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

mod evidence_support;

use evidence_support::*;
use openquant_contracts::{Envelope, FailureCode, generated as g, parse, validate};
use openquant_core::{
    audit::{Check, RunChecks},
    exact::Q,
    gates::{
        Assessment, CandidateEvidence, GateError, GateInput, ManifestEvidence, MetricsEvidence,
        Mismatch, Outcome, ReportContext, RunEvidence, ValidationEvidence, assess,
        cost_scenario_matches, report,
    },
    metrics::{Scenario, Window},
};
use serde_json::{Value, json};

fn pilot_policy() -> Value {
    read_json(&std::path::Path::new(FIXTURES).join("protocol/valid/cohort-policy.s1-pilot.json"))
}

fn policy_of(case: &Case) -> Value {
    match case.text("policy") {
        "pilot" => pilot_policy(),
        "offline" => read_json(&metrics_dir().join("policies/offline-pass.json")),
        "inline" => read_json(&case.dir.join("policy.json")),
        other => panic!("{}: policy {other:?}", case.id),
    }
}

fn decimal(text: &str) -> Value {
    json!(text)
}

/// A schema-valid `evaluation-metrics/1` that carries the three compact values.
fn metrics_document(run: &Value) -> Value {
    let metrics = &run["metrics"];
    let net = metrics["net_return"].as_str().unwrap();
    let excess = metrics["excess_return"].as_str().unwrap();
    let ratio = |text: &str| json!({"unit": "RATIO", "value": text});
    let money = |text: &str| json!({"unit": "MONEY", "currency": "USD", "value": text});
    let held = if metrics["buy_and_hold"] == "COMPUTED" {
        let bh = &Q::parse(net).unwrap() - &Q::parse(excess).unwrap();
        json!({
            "status": "COMPUTED",
            "entry_session": "2024-01-02",
            "quantity": "500",
            "net_return": ratio(&bh.to_fixed(6).unwrap()),
            "max_drawdown": ratio("0.100000"),
            "excess_return": ratio(excess),
        })
    } else {
        json!({"status": "INSUFFICIENT", "reason": "no whole lot is affordable at the first fillable open"})
    };
    let window = run["window"].as_str().unwrap();
    let scored = match window {
        "DEVELOPMENT" => ("2023-01-03", "2023-12-29"),
        "VALIDATION" => ("2024-01-02", "2024-12-31"),
        _ => ("2025-01-02", "2025-12-31"),
    };
    let document = json!({
        "schema_version": "evaluation-metrics/1",
        "run_id": run["run_id"],
        "source": {
            "result_digest": run["result"],
            "input_hash": digest_text("input"),
            "strategy_hash": digest_text("strategy"),
            "engine_digest": digest_text("engine"),
        },
        "method": {"name": "openquant-evidence-methods", "version": "1", "digest": digest_text("method")},
        "metric_scale": 6,
        "window": {
            "role": window,
            "cost_scenario": run["scenario"],
            "scored": {"start": scored.0, "end": scored.1},
        },
        "strategy": {
            "net_return": ratio(net),
            "max_drawdown": ratio("0.050000"),
            "worst_session_return": ratio("-0.010000"),
            "turnover": ratio("2.000000"),
            "trade_count": {"unit": "COUNT", "value": metrics["trade_count"]},
            "scored_session_count": {"unit": "COUNT", "value": 250},
            "execution_cost": {"fees": money("100.00"), "gap_slippage": money("10.00"), "total": money("110.00")},
            "exposure": ratio("0.300000"),
        },
        "benchmarks": {
            "buy_and_hold": held,
            "cash": {"net_return": ratio("0.000000"), "excess_return": ratio(net)},
        },
        "uncertainty": {"status": "NOT_COMPUTED", "limitation": LIMITATION},
    });
    validate(Envelope::EvaluationMetrics, &document).unwrap_or_else(|e| panic!("{e}: {document}"));
    document
}

fn digest_text(name: &str) -> String {
    openquant_contracts::digest_bytes(name.as_bytes())
}

fn string_or_none(value: &Value) -> Option<String> {
    value.as_str().map(str::to_owned)
}

fn outcome_of(value: &Value) -> Outcome {
    let code = || -> FailureCode { serde_json::from_value(value["code"].clone()).unwrap() };
    match value["kind"].as_str().unwrap() {
        "COMPLETED" => Outcome::Completed,
        "MISSING" => Outcome::Missing,
        "FAILED" => Outcome::Failed(code()),
        "INSUFFICIENT" => Outcome::Insufficient(code()),
        "NOT_PREPARED" => Outcome::NotPrepared(code()),
        other => panic!("outcome {other}"),
    }
}

fn check_of(text: &str) -> Check {
    if text == "PASS" {
        Check::Pass
    } else {
        Check::Fail(format!("the fixture says {text}"))
    }
}

fn evidence_of(policy: &Value, value: &Value) -> CandidateEvidence {
    let base_policy = policy["conditions"]["execution_policy"].clone();
    let runs = value["runs"]
        .as_array()
        .unwrap()
        .iter()
        .map(|run| {
            let input_policy = (!run["cost"].is_null()).then(|| {
                let mut copy = base_policy.clone();
                for (key, cost) in run["cost"].as_object().unwrap() {
                    copy["cost_model"][key] = cost.clone();
                }
                copy
            });
            RunEvidence {
                run_id: run["run_id"].as_str().unwrap().to_owned(),
                window: Window::from_wire(run["window"].as_str().unwrap()).unwrap(),
                scenario: Scenario::from_wire(run["scenario"].as_str().unwrap()).unwrap(),
                repeat_of: string_or_none(&run["repeat_of"]),
                submission_digest: string_or_none(&run["submission"]),
                result_digest: string_or_none(&run["result"]),
                outcome: outcome_of(&run["outcome"]),
                metrics: (!run["metrics"].is_null()).then(|| MetricsEvidence {
                    digest: run["metrics_digest"].as_str().unwrap().to_owned(),
                    document: metrics_document(run),
                    unbound: None,
                }),
                input_policy,
                checks: (!run["checks"].is_null()).then(|| RunChecks {
                    reconciliation: check_of(run["checks"]["reconciliation"].as_str().unwrap()),
                    timing: check_of(run["checks"]["timing"].as_str().unwrap()),
                }),
                unbound: None,
            }
        })
        .collect();
    let validation = &value["validation"];
    CandidateEvidence {
        plan_digest: string_or_none(&value["plan"]),
        validation: match validation["status"].as_str().unwrap() {
            "VALID" => ValidationEvidence::Valid {
                digest: validation["digest"].as_str().unwrap().to_owned(),
            },
            "INVALID" => ValidationEvidence::Invalid {
                digest: validation["digest"].as_str().unwrap().to_owned(),
            },
            _ => ValidationEvidence::Missing,
        },
        manifest: (!value["manifest"].is_null()).then(|| ManifestEvidence {
            digest: value["manifest"]["digest"].as_str().unwrap().to_owned(),
            bars_without_availability: u32::try_from(
                value["manifest"]["bars_without_availability"]
                    .as_u64()
                    .unwrap(),
            )
            .unwrap(),
            actions_without_availability: u32::try_from(
                value["manifest"]["actions_without_availability"]
                    .as_u64()
                    .unwrap(),
            )
            .unwrap(),
            unbound: None,
        }),
        runs,
    }
}

fn input_json(input: &GateInput) -> Value {
    match &input.run_id {
        Some(run) => json!({"kind": input.kind, "run_id": run, "digest": input.digest}),
        None => json!({"kind": input.kind, "digest": input.digest}),
    }
}

/// Compare a produced gate outcome with an expected one. `reason_includes` lists texts that the
/// produced reason must contain; every other member must be equal.
fn gate_differences(expected: &Value, produced: &Value) -> Vec<String> {
    let mut out = Vec::new();
    let (want, got) = (expected.as_object().unwrap(), produced.as_object().unwrap());
    for (key, value) in want {
        match key.as_str() {
            "reason_includes" => {
                let reason = got.get("reason").and_then(Value::as_str).unwrap_or("");
                for needle in value.as_array().unwrap() {
                    let needle = needle.as_str().unwrap();
                    if !reason.contains(needle) {
                        out.push(format!("reason {reason:?} lacks {needle:?}"));
                    }
                }
            }
            _ if got.get(key) == Some(value) => {}
            _ => out.push(format!(
                "{key}: expected {value}, got {}",
                got.get(key).unwrap_or(&Value::Null)
            )),
        }
    }
    for key in got.keys() {
        let known =
            want.contains_key(key) || (key == "reason" && want.contains_key("reason_includes"));
        if !known {
            out.push(format!("unexpected member {key}: {}", got[key]));
        }
    }
    out
}

fn report_context<'a>(
    method: &'a openquant_core::metrics::MethodRef,
    policy: &Value,
) -> ReportContext<'a> {
    ReportContext {
        job_id: "job-s1-assess",
        attempt: json!({"attempt_id": "att-s1-assess-1", "ownership_revision": 1}),
        executable: json!({"name": "engine-batch", "version": "0.0.0", "digest": digest_text("executable")}),
        method,
        strategy_hash: "sha256:3b2b013c84fb0f64657822298593f8bc24a520c76023b8f18c61ee0e00abb046",
        cohort_policy: json!({"id": policy["policy_id"], "revision": policy["revision"], "digest": digest_text("policy")}),
        duration: json!({"label": "observed", "milliseconds": 120}),
    }
}

fn assess_case(case: &Case) -> Result<(Value, CandidateEvidence, Assessment), GateError> {
    let policy = policy_of(case);
    parse::<g::CohortPolicy>(&serde_json::to_string(&policy).unwrap())
        .unwrap_or_else(|e| panic!("{}: the policy is invalid: {e}", case.id));
    let evidence = evidence_of(&policy, &read_json(&case.dir.join("evidence.json")));
    let assessment = assess(&policy, &evidence)?;
    Ok((policy, evidence, assessment))
}

#[test]
fn every_gate_case_matches_the_oracle_outcome_for_outcome() {
    let cases = cases("G-");
    assert_eq!(cases.len(), 35);
    let mut reports = 0;
    for case in &cases {
        let expect = case.expect();
        if let Some(error) = expect["error"].as_str() {
            let error_text = assess_case(case).expect_err(&case.id).to_string();
            let gate = error.strip_prefix("UnsupportedRequiredGate ").unwrap();
            assert!(error_text.contains(gate), "{}: {error_text}", case.id);
            continue;
        }
        let (policy, _, assessment) =
            assess_case(case).unwrap_or_else(|e| panic!("{}: {e}", case.id));
        let want = expect["gates"].as_array().unwrap();
        assert_eq!(assessment.gates.len(), want.len(), "{}", case.id);
        for (want, got) in want.iter().zip(&assessment.gates) {
            let differences = gate_differences(want, got);
            assert!(
                differences.is_empty(),
                "{}: gate {}:\n{}",
                case.id,
                want["gate"],
                differences.join("\n")
            );
        }
        let inputs: Vec<Value> = assessment.inputs.iter().map(input_json).collect();
        assert_eq!(
            Value::Array(inputs),
            expect["inputs"],
            "{}: inputs",
            case.id
        );
        // The finished report passes its schema.
        let method = test_method();
        let finished = report(&report_context(&method, &policy), &assessment)
            .unwrap_or_else(|e| panic!("{}: {e}", case.id));
        assert_eq!(finished.gates.len(), 17, "{}", case.id);
        reports += 1;
    }
    assert_eq!(reports, 34);
}

#[test]
fn every_expected_gate_file_binds_the_current_oracle_script() {
    for case in cases("G-") {
        let bound = case.expected["origin"]["oracle_sha256"].as_str().unwrap();
        assert_eq!(format!("sha256:{bound}"), oracle_digest(), "{}", case.id);
    }
}

#[test]
fn one_outcome_per_policy_gate_in_policy_order() {
    let case = cases("G-").into_iter().find(|c| c.id == "G-02").unwrap();
    let (policy, _, assessment) = assess_case(&case).unwrap();
    let in_policy: Vec<&str> = policy["gates"]
        .as_array()
        .unwrap()
        .iter()
        .map(|g| g["gate"].as_str().unwrap())
        .collect();
    let in_report: Vec<&str> = assessment
        .gates
        .iter()
        .map(|g| g["gate"].as_str().unwrap())
        .collect();
    assert_eq!(in_policy, in_report);
    assert_eq!(in_report.len(), 17);
    let mut unique = in_report.clone();
    unique.sort_unstable();
    unique.dedup();
    assert_eq!(unique.len(), 17, "a gate appears twice");
    // The category of each outcome is the policy's.
    for (rule, outcome) in policy["gates"]
        .as_array()
        .unwrap()
        .iter()
        .zip(&assessment.gates)
    {
        assert_eq!(rule["category"], outcome["category"]);
    }
}

#[test]
fn the_limitation_is_repeated_exactly_when_the_policy_records_one() {
    for id in ["G-01", "G-02", "G-15a", "G-15b", "G-06"] {
        let case = cases("G-").into_iter().find(|c| c.id == id).unwrap();
        let (policy, _, assessment) = assess_case(&case).unwrap();
        for (rule, outcome) in policy["gates"]
            .as_array()
            .unwrap()
            .iter()
            .zip(&assessment.gates)
        {
            let recorded = rule["requirement"] == "REQUIRED" && rule.get("limitation").is_some();
            assert_eq!(
                outcome.get("limitation").is_some(),
                recorded,
                "{id}: {}",
                rule["gate"]
            );
            if recorded {
                assert_eq!(outcome["limitation"], rule["limitation"], "{id}");
            }
        }
    }
    // A gate whose result is INSUFFICIENT repeats it as well (G-15b: no manifest).
    let case = cases("G-").into_iter().find(|c| c.id == "G-15b").unwrap();
    let (_, _, assessment) = assess_case(&case).unwrap();
    let gate = assessment
        .gates
        .iter()
        .find(|g| g["gate"] == "POINT_IN_TIME_DATA")
        .unwrap();
    assert_eq!(gate["result"], "INSUFFICIENT");
    assert!(gate.get("limitation").is_some());
}

#[test]
fn an_undecided_gate_omits_empty_lists_and_a_decided_gate_has_both() {
    for id in ["G-02", "G-06", "G-08a"] {
        let case = cases("G-").into_iter().find(|c| c.id == id).unwrap();
        let (_, _, assessment) = assess_case(&case).unwrap();
        for gate in &assessment.gates {
            let decided = gate["result"] == "PASS" || gate["result"] == "FAIL";
            if decided {
                assert!(
                    gate["evidence"].as_array().is_some_and(|e| !e.is_empty()),
                    "{id}: {gate}"
                );
                assert!(gate["observations"].is_array(), "{id}: {gate}");
            } else {
                for key in ["evidence", "observations"] {
                    if let Some(list) = gate.get(key) {
                        assert!(
                            list.as_array().is_some_and(|l| !l.is_empty()),
                            "{id}: {key} is present and empty: {gate}"
                        );
                    }
                }
                assert!(
                    gate["reason_code"].is_string() && gate["reason"].is_string(),
                    "{id}: {gate}"
                );
            }
        }
    }
}

#[test]
fn every_cited_digest_is_an_input_of_the_report() {
    for case in cases("G-") {
        if case.expect()["error"].is_string() {
            continue;
        }
        let (_, _, assessment) = assess_case(&case).unwrap();
        let known: Vec<&str> = assessment
            .inputs
            .iter()
            .map(|i| i.digest.as_str())
            .collect();
        for gate in &assessment.gates {
            for cited in gate
                .get("evidence")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                assert!(
                    known.contains(&cited.as_str().unwrap()),
                    "{}: {cited}",
                    case.id
                );
            }
        }
    }
}

#[test]
fn the_report_checks_its_limits_and_its_citations() {
    let case = cases("G-").into_iter().find(|c| c.id == "G-01").unwrap();
    let (policy, _, assessment) = assess_case(&case).unwrap();
    let method = test_method();
    let context = report_context(&method, &policy);
    // The report is deterministic.
    let first = report(&context, &assessment).unwrap();
    let second = report(&context, &assessment).unwrap();
    assert_eq!(
        openquant_contracts::payload_digest(&first).unwrap(),
        openquant_contracts::payload_digest(&second).unwrap()
    );
    // Too many observations in one gate.
    let mut crowded = assessment.clone();
    crowded.gates[6]["observations"] =
        Value::Array(vec![crowded.gates[6]["observations"][0].clone(); 33]);
    assert!(matches!(
        report(&context, &crowded),
        Err(GateError::Limit(_))
    ));
    // Too many inputs.
    let mut many = assessment.clone();
    many.inputs = (0..129)
        .map(|n| GateInput {
            kind: "EVALUATION_SUBMISSION",
            run_id: Some(format!("run-{n}")),
            digest: digest_text(&format!("input-{n}")),
        })
        .collect();
    assert!(matches!(report(&context, &many), Err(GateError::Limit(_))));
    // A gate that cites a digest the report does not list.
    let mut stray = assessment.clone();
    stray.gates[0]["evidence"] = json!([digest_text("stray")]);
    assert!(matches!(
        report(&context, &stray),
        Err(GateError::Evidence(_))
    ));
    // A gate with a malformed member fails the schema, not a panic.
    let mut bad = assessment.clone();
    bad.gates[0]["result"] = json!("MAYBE");
    assert!(matches!(
        report(&context, &bad),
        Err(GateError::Contract(_))
    ));
    // Gate results of the P1 fixture shape: the report round-trips through the contract layer.
    let text = serde_json::to_string(&openquant_contracts::to_value(&first).unwrap()).unwrap();
    parse::<g::GateReport>(&text).unwrap();
}

fn pilot_case(id: &str) -> (Value, CandidateEvidence) {
    let case = cases("G-").into_iter().find(|c| c.id == id).unwrap();
    let policy = policy_of(&case);
    let evidence = evidence_of(&policy, &read_json(&case.dir.join("evidence.json")));
    (policy, evidence)
}

#[test]
fn the_policy_and_the_evidence_must_be_usable() {
    let (policy, evidence) = pilot_case("G-01");
    // A threshold gate with no threshold would pass vacuously.
    let mut empty = policy.clone();
    for rule in empty["gates"].as_array_mut().unwrap() {
        if rule["gate"] == "WALK_FORWARD" {
            rule["thresholds"] = json!([]);
        }
    }
    assert!(matches!(
        assess(&empty, &evidence),
        Err(GateError::Policy(_))
    ));
    // A method-only gate that carries thresholds.
    let mut carried = policy.clone();
    for rule in carried["gates"].as_array_mut().unwrap() {
        if rule["gate"] == "DEFINITION_VALIDATION" {
            rule["thresholds"] = policy["gates"][6]["thresholds"].clone();
        }
    }
    assert!(matches!(
        assess(&carried, &evidence),
        Err(GateError::Policy(_))
    ));
    // A gate listed twice, and a policy without gates.
    let mut twice = policy.clone();
    let first = twice["gates"][0].clone();
    twice["gates"].as_array_mut().unwrap().push(first);
    assert!(matches!(
        assess(&twice, &evidence),
        Err(GateError::Policy(_))
    ));
    assert!(matches!(
        assess(&json!({}), &evidence),
        Err(GateError::Policy(_))
    ));
    // Two regular runs for one window and scenario.
    let mut doubled = evidence.clone();
    let copy = doubled.runs[0].clone();
    doubled.runs.push(copy);
    assert!(matches!(
        assess(&policy, &doubled),
        Err(GateError::Evidence(_))
    ));
    // A completed run without its audits.
    let mut unaudited = evidence.clone();
    unaudited.runs[1].checks = None;
    assert!(matches!(
        assess(&policy, &unaudited),
        Err(GateError::Evidence(_))
    ));
    // A run that supplies evidence without a submission digest.
    let mut anonymous = evidence.clone();
    anonymous.runs[2].submission_digest = None;
    assert!(matches!(
        assess(&policy, &anonymous),
        Err(GateError::Evidence(_))
    ));
    // A completed run without a result digest, in the pair that replay compares.
    let mut unsealed = evidence.clone();
    unsealed.runs[0].result_digest = None;
    assert!(matches!(
        assess(&policy, &unsealed),
        Err(GateError::Evidence(_))
    ));
}

fn gate_of<'a>(assessment: &'a Assessment, id: &str) -> &'a Value {
    assessment.gates.iter().find(|g| g["gate"] == id).unwrap()
}

fn gate_must_be_insufficient(assessment: &Assessment, id: &str, code: &str) -> String {
    let gate = gate_of(assessment, id);
    assert_eq!(gate["result"], "INSUFFICIENT", "{id}: {gate}");
    assert_eq!(gate["reason_code"], code, "{id}: {gate}");
    gate["reason"].as_str().unwrap().to_owned()
}

fn cites(assessment: &Assessment, digest: &str) -> bool {
    assessment.gates.iter().any(|g| {
        g["evidence"]
            .as_array()
            .is_some_and(|list| list.iter().any(|d| d == digest))
    })
}

#[test]
fn a_run_that_does_not_bind_to_its_slot_supplies_no_evidence_whatever_else_it_carries() {
    // G-01 passes every gate. The validation base run keeps its result, metrics, policy and audits,
    // and carries a mismatch: no gate may read any of it.
    let (policy, mut evidence) = pilot_case("G-01");
    let victim = evidence
        .runs
        .iter_mut()
        .find(|r| r.run_id == "run-v-base")
        .unwrap();
    victim.unbound = Some(Mismatch::new("window_role", "VALIDATION", "HOLDOUT"));
    let digest = victim.submission_digest.clone().unwrap();
    let assessment = assess(&policy, &evidence).unwrap();
    // The three threshold gates that read the base-cost validation run, and the gates that read
    // every run, are insufficient for the missing run and name the mismatch.
    for id in [
        "EXCESS_OVER_BUY_AND_HOLD",
        "WALK_FORWARD",
        "MINIMUM_TRADE_COUNT",
        "ACCOUNTING_RECONCILIATION",
        "SIGNAL_DATA_TIMING",
        "BASE_COST_MODEL",
    ] {
        let reason = gate_must_be_insufficient(&assessment, id, "RUN_MISSING");
        assert!(
            reason.contains("run-v-base")
                && reason.contains("window_role is HOLDOUT, required VALIDATION"),
            "{id}: {reason}"
        );
    }
    // The stress run of the same window is another run, and the replay pair is not this run.
    assert_eq!(gate_of(&assessment, "COST_STRESS")["result"], "PASS");
    assert_eq!(
        gate_of(&assessment, "DETERMINISTIC_REPLAY")["result"],
        "PASS"
    );
    assert!(!cites(&assessment, &digest), "a gate cites the unbound run");
    for gate in &assessment.gates {
        for observation in gate["observations"].as_array().into_iter().flatten() {
            assert_ne!(observation["run_id"], "run-v-base", "{gate}");
        }
    }
    // The report is still a valid gate-report.
    let method = test_method();
    report(&report_context(&method, &policy), &assessment).unwrap();
}

#[test]
fn a_run_that_does_not_bind_is_not_a_candidate_defect_and_not_future_data() {
    let (policy, mut evidence) = pilot_case("G-01");
    // An unbound run that failed with a candidate defect does not fail the definition, and one
    // that failed with FUTURE_DATA does not hold up the point-in-time gate: both are evidence
    // that the gates do not read.
    for (code, gate) in [
        (FailureCode::InvalidLevel, "DEFINITION_VALIDATION"),
        (FailureCode::FutureData, "POINT_IN_TIME_DATA"),
    ] {
        let victim = evidence
            .runs
            .iter_mut()
            .find(|r| r.run_id == "run-h-stress")
            .unwrap();
        victim.outcome = Outcome::Failed(code);
        victim.unbound = Some(Mismatch::new("run_slot", "a slot of the plan", "seed.zzz"));
        let assessment = assess(&policy, &evidence).unwrap();
        assert_eq!(gate_of(&assessment, gate)["result"], "PASS", "{code}");
    }
}

#[test]
fn metrics_that_do_not_bind_are_unavailable_to_the_threshold_gates_only() {
    let (policy, mut evidence) = pilot_case("G-01");
    let victim = evidence
        .runs
        .iter_mut()
        .find(|r| r.run_id == "run-v-base")
        .unwrap();
    victim.metrics.as_mut().unwrap().unbound =
        Some(Mismatch::new("metrics.run_id", "run-v-base", "run-other"));
    let assessment = assess(&policy, &evidence).unwrap();
    for id in [
        "EXCESS_OVER_BUY_AND_HOLD",
        "WALK_FORWARD",
        "MINIMUM_TRADE_COUNT",
    ] {
        let reason = gate_must_be_insufficient(&assessment, id, "METRICS_UNAVAILABLE");
        assert!(
            reason.contains("run-v-base") && reason.contains("metrics.run_id is run-other"),
            "{id}: {reason}"
        );
        for observation in gate_of(&assessment, id)["observations"].as_array().unwrap() {
            assert_ne!(observation["run_id"], "run-v-base");
        }
    }
    // The metrics are not what the run supplies to the audits, the replay or the cost model.
    for id in [
        "COST_STRESS",
        "DEFINITION_VALIDATION",
        "DETERMINISTIC_REPLAY",
        "ACCOUNTING_RECONCILIATION",
        "SIGNAL_DATA_TIMING",
        "POINT_IN_TIME_DATA",
        "BASE_COST_MODEL",
    ] {
        assert_eq!(gate_of(&assessment, id)["result"], "PASS", "{id}");
    }
}

#[test]
fn a_measured_failure_still_decides_over_metrics_that_do_not_bind() {
    // Precedence is unchanged: a threshold that provably fails cannot be rescued by a window
    // that lacks evidence, whatever the reason.
    let (policy, mut evidence) = pilot_case("G-01");
    let victim = evidence
        .runs
        .iter_mut()
        .find(|r| r.run_id == "run-v-base")
        .unwrap();
    victim.metrics.as_mut().unwrap().unbound = Some(Mismatch::new("metrics.run_id", "a", "b"));
    let failing = evidence
        .runs
        .iter_mut()
        .find(|r| r.run_id == "run-h-base")
        .unwrap();
    failing.metrics.as_mut().unwrap().document["strategy"]["trade_count"]["value"] = json!(1);
    let assessment = assess(&policy, &evidence).unwrap();
    // MINIMUM_TRADE_COUNT of G-01 is INSUFFICIENT below the threshold, by the policy.
    let gate = gate_of(&assessment, "MINIMUM_TRADE_COUNT");
    assert_eq!(gate["reason_code"], "BELOW_THRESHOLD", "{gate}");
}

#[test]
fn a_manifest_that_does_not_bind_is_not_read_and_not_cited() {
    let (policy, mut evidence) = pilot_case("G-01");
    let manifest = evidence.manifest.as_mut().unwrap();
    manifest.unbound = Some(Mismatch::new("manifest.dataset", "synth@1", "other@1"));
    // Even a manifest whose bars lack an availability time says nothing about other data.
    manifest.bars_without_availability = 3;
    let digest = manifest.digest.clone();
    let assessment = assess(&policy, &evidence).unwrap();
    let reason = gate_must_be_insufficient(&assessment, "POINT_IN_TIME_DATA", "RUN_MISSING");
    assert!(
        reason.contains("manifest.dataset is other@1, required synth@1"),
        "{reason}"
    );
    assert!(!cites(&assessment, &digest));
    // The manifest was read, and the report lists it among its inputs.
    assert!(assessment.inputs.iter().any(|i| i.digest == digest));
    assert_eq!(gate_of(&assessment, "BASE_COST_MODEL")["result"], "PASS");
}

#[test]
fn a_validation_result_that_does_not_bind_is_not_cited_and_decides_nothing() {
    let (policy, mut evidence) = pilot_case("G-01");
    let ValidationEvidence::Valid { digest } = evidence.validation.clone() else {
        panic!("G-01 has a valid validation result");
    };
    evidence.validation = ValidationEvidence::Unbound {
        digest: digest.clone(),
        mismatch: Mismatch::new("validation.draft_digest", "sha256:a", "sha256:b"),
    };
    let assessment = assess(&policy, &evidence).unwrap();
    let reason =
        gate_must_be_insufficient(&assessment, "DEFINITION_VALIDATION", "VALIDATION_FAILED");
    assert!(
        reason.contains("validation.draft_digest is sha256:b"),
        "{reason}"
    );
    assert!(!cites(&assessment, &digest));
    assert!(assessment.inputs.iter().any(|i| i.digest == digest));
    // A run that failed with a candidate defect still fails the definition: that evidence is the
    // run's own, and it does not need the validation result.
    let victim = evidence
        .runs
        .iter_mut()
        .find(|r| r.run_id == "run-h-stress")
        .unwrap();
    victim.outcome = Outcome::Failed(FailureCode::InvalidLevel);
    let assessment = assess(&policy, &evidence).unwrap();
    let gate = gate_of(&assessment, "DEFINITION_VALIDATION");
    assert_eq!(gate["result"], "FAIL", "{gate}");
    assert!(!cites(&assessment, &digest));
}

#[test]
fn several_runs_for_one_cell_are_insufficient_when_one_does_not_bind_and_a_defect_when_all_do() {
    let (policy, evidence) = pilot_case("G-01");
    let mut claimed = evidence.clone();
    let mut stray = claimed
        .runs
        .iter()
        .find(|r| r.run_id == "run-v-base")
        .unwrap()
        .clone();
    stray.run_id = "run-stray".to_owned();
    stray.unbound = Some(Mismatch::new(
        "run_slot",
        "a planned slot",
        "seed.v.elsewhere",
    ));
    claimed.runs.push(stray);
    let assessment = assess(&policy, &claimed).unwrap();
    for id in [
        "EXCESS_OVER_BUY_AND_HOLD",
        "WALK_FORWARD",
        "MINIMUM_TRADE_COUNT",
    ] {
        let reason = gate_must_be_insufficient(&assessment, id, "RUN_MISSING");
        assert!(
            reason.contains("run-stray") && reason.contains("run_slot"),
            "{id}: {reason}"
        );
    }
    // Two runs that both bind cannot be told apart.
    let mut doubled = evidence;
    let copy = doubled.runs[0].clone();
    doubled.runs.push(copy);
    assert!(matches!(
        assess(&policy, &doubled),
        Err(GateError::Evidence(_))
    ));
}

#[test]
fn the_cost_scenario_check_compares_decimals_by_value_and_multiplies_only_the_named_costs() {
    let policy = pilot_policy();
    let base = policy["conditions"]["execution_policy"].clone();
    let with = |fixed: &str, bps: &str, slip: &str| {
        let mut copy = base.clone();
        copy["cost_model"]["fixed_fee_per_fill"] = decimal(fixed);
        copy["cost_model"]["fee_bps"] = decimal(bps);
        copy["cost_model"]["gap_exit_slippage_bps"] = decimal(slip);
        copy
    };
    let matches = |scenario, policy: &Value| {
        cost_scenario_matches(&policy_with_cost(), scenario, policy).unwrap()
    };
    fn policy_with_cost() -> Value {
        read_json(
            &std::path::Path::new(FIXTURES).join("protocol/valid/cohort-policy.s1-pilot.json"),
        )
    }
    assert!(matches(Scenario::Base, &with("0.00", "5", "10")));
    assert!(matches(Scenario::Base, &with("0", "5.0", "10.00")));
    assert!(!matches(Scenario::Base, &with("0.00", "5", "11")));
    assert!(!matches(Scenario::Base, &with("0.01", "5", "10")));
    assert!(matches(Scenario::CostStress, &with("0.00", "10", "20")));
    assert!(matches(Scenario::CostStress, &with("0", "10.0", "20.000")));
    assert!(!matches(Scenario::CostStress, &with("0.00", "5", "10")));
    assert!(!matches(Scenario::CostStress, &with("0.00", "10", "10")));
    assert!(!matches(Scenario::CostStress, &with("0.00", "11", "20")));
    // Anything else in the policy must be the cohort's too.
    let mut other = with("0.00", "5", "10");
    other["lot_size"] = decimal("2");
    assert!(!matches(Scenario::Base, &other));
    let mut other = with("0.00", "10", "20");
    other["corporate_actions"]["withholding_bps"] = decimal("100");
    assert!(!matches(Scenario::CostStress, &other));
    assert!(!matches(Scenario::Base, &json!({})));
    // A policy with a stress that multiplies only the fee.
    let mut partial = policy_with_cost();
    partial["conditions"]["cost_stress"]["components"] = json!(["fee_bps"]);
    assert!(
        cost_scenario_matches(&partial, Scenario::CostStress, &with("0.00", "10", "10")).unwrap()
    );
    assert!(
        !cost_scenario_matches(&partial, Scenario::CostStress, &with("0.00", "10", "20")).unwrap()
    );
}

#[test]
fn a_numerical_result_maps_to_a_gate_outcome() {
    // `Outcome::of` reads the status and the code of a result; the S0 cases cover each form.
    let completed = s0_run("s0:X-09a").1;
    assert_eq!(Outcome::of(&completed), Outcome::Completed);
    let failed = s0_run("s0:G-07a").1;
    assert_eq!(
        Outcome::of(&failed),
        Outcome::Failed(FailureCode::InvalidLevel)
    );
    let insufficient = s0_run("s0:C-02").1;
    assert_eq!(
        Outcome::of(&insufficient),
        Outcome::Insufficient(FailureCode::FractionalEntitlement)
    );
    // The five candidate-defect codes, and no other, are candidate defects.
    let defects: Vec<FailureCode> = [
        FailureCode::InvalidLevel,
        FailureCode::UnsupportedOperator,
        FailureCode::OperatorTypeMismatch,
        FailureCode::OperatorUnitMismatch,
        FailureCode::InvalidParameter,
    ]
    .into();
    for code in defects {
        assert!(openquant_core::gates::is_candidate_defect(code), "{code}");
    }
    for code in [
        FailureCode::FutureData,
        FailureCode::EventOutOfOrder,
        FailureCode::InvalidInput,
        FailureCode::ArithmeticOverflow,
        FailureCode::CheckpointMismatch,
        FailureCode::IdentityMismatch,
        FailureCode::UnsupportedPolicy,
        FailureCode::SchemaViolation,
        FailureCode::InvalidDecimal,
        FailureCode::UnsupportedSchemaVersion,
        FailureCode::MissingRequiredBar,
        FailureCode::UnsupportedCorporateAction,
    ] {
        assert!(!openquant_core::gates::is_candidate_defect(code), "{code}");
    }
}

//! Shared helpers of the derived-evidence tests: the S1 fixtures under `fixtures/s1/metrics`, the
//! S0 cases they borrow from, and the comparison of a produced document with an expectation.

#![allow(dead_code)]

use std::path::{Path, PathBuf};

use openquant_contracts::{
    EvaluationInput, EvaluationResult, StrategyArtefact, digest_bytes, parse,
};
use openquant_core::{Run, metrics::MethodRef};
use serde_json::Value;

pub const FIXTURES: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures");

/// The limitation text of the pilot cohort policy, repeated by every metrics document.
pub const LIMITATION: &str = "S1 reports no uncertainty statistic: OQ-02 section 3.6 gives no method for one stock. Development, validation and holdout returns are shown side by side instead.";

pub fn metrics_dir() -> PathBuf {
    Path::new(FIXTURES).join("s1/metrics")
}

pub fn read_text(path: &Path) -> String {
    std::fs::read_to_string(path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

pub fn read_json(path: &Path) -> Value {
    serde_json::from_str(&read_text(path)).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

/// A fixed method identity for tests that do not depend on the method text.
pub fn test_method() -> MethodRef {
    MethodRef {
        name: "openquant-evidence-methods".to_owned(),
        version: "1".to_owned(),
        digest: format!("sha256:{}", "ab".repeat(32)),
    }
}

/// One case directory of `fixtures/s1/metrics/cases`.
pub struct Case {
    pub id: String,
    pub dir: PathBuf,
    pub case: Value,
    pub expected: Value,
}

impl Case {
    pub fn text(&self, key: &str) -> &str {
        self.case[key]
            .as_str()
            .unwrap_or_else(|| panic!("{}: case.json has no string {key:?}", self.id))
    }

    /// The case's `expect` block.
    pub fn expect(&self) -> &Value {
        &self.expected["expect"]
    }
}

/// Every case whose id starts with `prefix`, in id order.
pub fn cases(prefix: &str) -> Vec<Case> {
    let root = metrics_dir().join("cases");
    let mut ids: Vec<String> = std::fs::read_dir(&root)
        .unwrap_or_else(|e| panic!("{}: {e}", root.display()))
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .filter(|name| name.starts_with(prefix))
        .collect();
    ids.sort();
    ids.into_iter()
        .map(|id| {
            let dir = root.join(&id);
            let case = read_json(&dir.join("case.json"));
            assert_eq!(
                case["id"],
                id.as_str(),
                "case.json id differs from its directory"
            );
            let expected = read_json(&dir.join(case["expected"].as_str().unwrap()));
            assert_eq!(
                expected["case"],
                id.as_str(),
                "expected.json names another case"
            );
            Case {
                id,
                dir,
                case,
                expected,
            }
        })
        .collect()
}

/// `sha256:` and the hash of the oracle script, which every expected file binds.
pub fn oracle_digest() -> String {
    digest_bytes(&std::fs::read(metrics_dir().join("oracle/oracle.py")).unwrap())
}

/// The S0 case directory behind a `s0:<id>` reference.
pub fn s0_dir(reference: &str) -> PathBuf {
    let id = reference
        .strip_prefix("s0:")
        .unwrap_or_else(|| panic!("{reference:?} is not an s0 reference"));
    Path::new(FIXTURES).join("s0/cases").join(id)
}

pub fn s0_strategy(reference: &str) -> StrategyArtefact {
    let dir = s0_dir(reference);
    let case = read_json(&dir.join("case.json"));
    parse(&read_text(&dir.join(case["strategy"].as_str().unwrap()))).unwrap()
}

pub fn s0_input(reference: &str) -> EvaluationInput {
    let dir = s0_dir(reference);
    let case = read_json(&dir.join("case.json"));
    parse(&read_text(&dir.join(case["input"].as_str().unwrap()))).unwrap()
}

/// The prepared run of an S0 case and its numerical result.
pub fn s0_run(reference: &str) -> (Run, EvaluationResult) {
    let run = Run::prepare(&s0_strategy(reference), &s0_input(reference)).unwrap();
    let result = evaluate(&run);
    (run, result)
}

/// Run to the end (or the first failure) and report.
pub fn evaluate(run: &Run) -> EvaluationResult {
    let (state, failure) = run.run_to_end(run.initial_state().unwrap());
    run.result(&state, failure.as_ref()).unwrap()
}

/// The expectation's fields as the metrics document states them, for comparison with `expect`.
pub fn flatten_metrics(document: &Value) -> Value {
    let strategy = &document["strategy"];
    let value = |metric: &Value| metric["value"].clone();
    let held = &document["benchmarks"]["buy_and_hold"];
    let held = if held["status"] == "COMPUTED" {
        serde_json::json!({
            "status": "COMPUTED",
            "entry_session": held["entry_session"],
            "quantity": held["quantity"],
            "net_return": value(&held["net_return"]),
            "max_drawdown": value(&held["max_drawdown"]),
            "excess_return": value(&held["excess_return"]),
        })
    } else {
        serde_json::json!({"status": held["status"], "reason": held["reason"]})
    };
    serde_json::json!({
        "window": document["window"]["scored"],
        "strategy": {
            "net_return": value(&strategy["net_return"]),
            "max_drawdown": value(&strategy["max_drawdown"]),
            "worst_session_return": value(&strategy["worst_session_return"]),
            "turnover": value(&strategy["turnover"]),
            "trade_count": value(&strategy["trade_count"]),
            "scored_session_count": value(&strategy["scored_session_count"]),
            "fees": value(&strategy["execution_cost"]["fees"]),
            "gap_slippage": value(&strategy["execution_cost"]["gap_slippage"]),
            "total_cost": value(&strategy["execution_cost"]["total"]),
            "exposure": value(&strategy["exposure"]),
        },
        "benchmarks": {
            "buy_and_hold": held,
            "cash": {
                "net_return": value(&document["benchmarks"]["cash"]["net_return"]),
                "excess_return": value(&document["benchmarks"]["cash"]["excess_return"]),
            },
        },
    })
}

/// Compare a flattened document with an expectation. A buy-and-hold block with the status
/// `INSUFFICIENT` lists `reason_includes`: each text must occur in the produced reason.
/// Returns the differences, one per line.
pub fn differences(expected: &Value, actual: &Value) -> Vec<String> {
    let mut out = Vec::new();
    for key in ["window", "strategy"] {
        compare(key, &expected[key], &actual[key], &mut out);
    }
    let (want, got) = (
        &expected["benchmarks"]["buy_and_hold"],
        &actual["benchmarks"]["buy_and_hold"],
    );
    if want["status"] == "INSUFFICIENT" {
        if got["status"] != "INSUFFICIENT" {
            out.push(format!("buy_and_hold: expected INSUFFICIENT, got {got}"));
        }
        let reason = got["reason"].as_str().unwrap_or("");
        for needle in want["reason_includes"].as_array().unwrap() {
            let needle = needle.as_str().unwrap();
            if !reason.contains(needle) {
                out.push(format!("buy_and_hold reason {reason:?} lacks {needle:?}"));
            }
        }
    } else {
        compare("buy_and_hold", want, got, &mut out);
    }
    compare(
        "cash",
        &expected["benchmarks"]["cash"],
        &actual["benchmarks"]["cash"],
        &mut out,
    );
    out
}

fn compare(path: &str, want: &Value, got: &Value, out: &mut Vec<String>) {
    match (want, got) {
        (Value::Object(w), Value::Object(g)) => {
            for (key, value) in w {
                compare(
                    &format!("{path}/{key}"),
                    value,
                    g.get(key).unwrap_or(&Value::Null),
                    out,
                );
            }
        }
        _ if want == got => {}
        _ => out.push(format!("{path}: expected {want}, got {got}")),
    }
}

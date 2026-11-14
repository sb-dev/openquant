//! Core-level protocol checks: payloads that parse but must be rejected by the shared validator,
//! run preparation or checkpoint restore, plus valid payloads that must be accepted.
//!
//! The manifest also lists the S1 connected envelopes. They have no core-level check, so these
//! tests skip them by name. Any other unknown contract name fails.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use std::collections::BTreeSet;

use openquant_contracts::{AnyContract, Checkpoint, EvaluationInput, StrategyArtefact, parse};
use openquant_core::{Run, validate_strategy};
use serde_json::Value;

const FIXTURES: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures");

fn read(path: &str) -> String {
    std::fs::read_to_string(format!("{FIXTURES}/{path}")).unwrap_or_else(|e| panic!("{path}: {e}"))
}

/// The manifest entries of the engine contracts. Envelope entries are skipped explicitly; an
/// unknown contract name panics, so no entry is skipped by accident.
fn entries() -> Vec<Value> {
    let value: Value = serde_json::from_str(&read("protocol/manifest.json")).unwrap();
    value["entries"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|entry| {
            let name = entry["contract"].as_str().unwrap();
            match AnyContract::from_name(name) {
                Some(AnyContract::Engine(_)) => true,
                Some(AnyContract::Envelope(_)) => false,
                None => panic!("{}: unknown contract {name:?}", entry["path"]),
            }
        })
        .cloned()
        .collect()
}

/// Run the core-level check for one entry; return the failure code text if rejected.
fn core_check(entry: &Value) -> Result<(), String> {
    let text = read(entry["path"].as_str().unwrap());
    let with_strategy =
        || -> StrategyArtefact { parse(&read(entry["with_strategy"].as_str().unwrap())).unwrap() };
    let with_input =
        || -> EvaluationInput { parse(&read(entry["with_input"].as_str().unwrap())).unwrap() };
    let code = |f: openquant_core::Failure| f.code.to_string();
    match entry["contract"].as_str().unwrap() {
        "strategy-artefact" => {
            let strategy: StrategyArtefact = parse(&text).unwrap();
            validate_strategy(&strategy).map(|_| ()).map_err(code)
        }
        "evaluation-input" => {
            let input: EvaluationInput = parse(&text).unwrap();
            Run::prepare(&with_strategy(), &input)
                .map(|_| ())
                .map_err(code)
        }
        "checkpoint" => {
            let checkpoint: Checkpoint = parse(&text).unwrap();
            let run = Run::prepare(&with_strategy(), &with_input()).unwrap();
            run.restore(&checkpoint).map(|_| ()).map_err(code)
        }
        // A result has no core-level check beyond the contract layer.
        "evaluation-result" => Ok(()),
        other => panic!("{}: no core check for contract {other:?}", entry["path"]),
    }
}

#[test]
fn valid_payloads_pass_the_shared_validator_preparation_and_restore() {
    for entry in entries().iter().filter(|e| e["expect"] == "valid") {
        core_check(entry).unwrap_or_else(|code| panic!("{} rejected: {code}", entry["path"]));
    }
}

#[test]
fn semantic_invalid_payloads_fail_with_the_expected_code() {
    let mut codes = BTreeSet::new();
    let mut count = 0;
    for entry in entries()
        .iter()
        .filter(|e| e["expect"] == "semantic_invalid")
    {
        let expected = entry["code"].as_str().unwrap();
        match core_check(entry) {
            Ok(()) => panic!("{} was accepted", entry["path"]),
            Err(code) => assert_eq!(code, expected, "{}", entry["path"]),
        }
        codes.insert(expected.to_owned());
        count += 1;
    }
    assert!(
        count >= 8,
        "expected at least eight semantic-invalid fixtures, found {count}"
    );
    for required in [
        "UNSUPPORTED_OPERATOR",
        "OPERATOR_UNIT_MISMATCH",
        "OPERATOR_TYPE_MISMATCH",
        "INVALID_PARAMETER",
        "IDENTITY_MISMATCH",
        "CHECKPOINT_MISMATCH",
        "UNSUPPORTED_POLICY",
        "INVALID_DECIMAL",
    ] {
        assert!(codes.contains(required), "no fixture exercises {required}");
    }
}

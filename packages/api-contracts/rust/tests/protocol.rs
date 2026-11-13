//! Shared protocol fixtures (`fixtures/protocol`): valid payloads parse, schema-invalid payloads
//! are rejected with the expected code, and the manifest lists every file.
//!
//! The same manifest drives the core-level checks in `packages/quant-core/tests/protocol.rs`.
//! S1 runs the same fixtures through the TypeScript validators.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use std::{collections::BTreeSet, path::Path};

use openquant_contracts::{
    Checkpoint, Contract, EvaluationInput, EvaluationResult, StrategyArtefact, digest, parse,
    parse_json, payload_digest,
};
use serde_json::{Value, json};

const FIXTURES: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../../fixtures");

/// The `expect` values the tests below act on. Any other value would be skipped by all of them.
const EXPECTATIONS: [&str; 3] = ["valid", "schema_invalid", "semantic_invalid"];

fn manifest() -> Vec<Value> {
    let text = std::fs::read_to_string(format!("{FIXTURES}/protocol/manifest.json")).unwrap();
    let value: Value = serde_json::from_str(&text).unwrap();
    assert_eq!(value["schema"], "s0-protocol-manifest/1");
    value["entries"].as_array().unwrap().clone()
}

fn text_of(entry: &Value) -> String {
    let path = entry["path"].as_str().unwrap();
    std::fs::read_to_string(format!("{FIXTURES}/{path}")).unwrap_or_else(|e| panic!("{path}: {e}"))
}

/// Parse through the typed binding; return the failure code text on rejection.
fn parse_as(contract: &str, text: &str) -> Result<String, String> {
    let reject = |e: openquant_contracts::ContractError| e.failure_code().to_string();
    match contract {
        "strategy-artefact" => parse::<StrategyArtefact>(text)
            .map(|p| payload_digest(&p).unwrap())
            .map_err(reject),
        "evaluation-input" => parse::<EvaluationInput>(text)
            .map(|p| payload_digest(&p).unwrap())
            .map_err(reject),
        "evaluation-result" => parse::<EvaluationResult>(text)
            .map(|p| payload_digest(&p).unwrap())
            .map_err(reject),
        "checkpoint" => parse::<Checkpoint>(text)
            .map(|p| payload_digest(&p).unwrap())
            .map_err(reject),
        other => panic!("unknown contract {other}"),
    }
}

/// Why an entry would be silently skipped or would panic late, or `Ok` when every test acts on it.
fn check_entry(entry: &Value) -> Result<(), String> {
    let field = |name: &str| {
        entry[name]
            .as_str()
            .ok_or_else(|| format!("{entry}: `{name}` is missing or not a string"))
    };
    let (path, expect, contract) = (field("path")?, field("expect")?, field("contract")?);
    if !EXPECTATIONS.contains(&expect) {
        return Err(format!(
            "{path}: unrecognised expect {expect:?}; every test would skip it. Use one of {EXPECTATIONS:?}"
        ));
    }
    let known: Vec<&str> = Contract::ALL
        .iter()
        .filter_map(|c| c.version_tag().split('/').next())
        .collect();
    if !known.contains(&contract) {
        return Err(format!(
            "{path}: unknown contract {contract:?}; use one of {known:?}"
        ));
    }
    Ok(())
}

#[test]
fn every_manifest_entry_has_a_recognised_expectation_and_contract() {
    let entries = manifest();
    let problems: Vec<String> = entries
        .iter()
        .filter_map(|entry| check_entry(entry).err())
        .collect();
    assert!(problems.is_empty(), "{problems:#?}");
    // The three tests below between them act on every entry.
    let acted_on: usize = EXPECTATIONS
        .iter()
        .map(|expect| entries.iter().filter(|e| e["expect"] == *expect).count())
        .sum();
    assert_eq!(acted_on, entries.len());
}

#[test]
fn the_entry_check_rejects_an_unrecognised_expectation_or_contract() {
    let entry = |contract: &str, expect: &str| json!({"path": "protocol/x.json", "contract": contract, "expect": expect});
    assert!(check_entry(&entry("checkpoint", "valid")).is_ok());
    assert!(check_entry(&entry("strategy-artefact", "schema_invalid")).is_ok());
    assert!(check_entry(&entry("evaluation-input", "semantic_invalid")).is_ok());
    for (bad, needle) in [
        (entry("checkpoint", "ignored"), "unrecognised expect"),
        (entry("checkpoint", "Valid"), "unrecognised expect"),
        (entry("checkpoint", ""), "unrecognised expect"),
        (entry("strategy", "valid"), "unknown contract"),
        (entry("", "valid"), "unknown contract"),
        (json!({"path": "p", "contract": "checkpoint"}), "`expect`"),
        (json!({"path": "p", "expect": "valid"}), "`contract`"),
        (
            json!({"contract": "checkpoint", "expect": "valid"}),
            "`path`",
        ),
    ] {
        let error = check_entry(&bad).unwrap_err();
        assert!(error.contains(needle), "{bad}: {error}");
    }
}

#[test]
fn valid_payloads_parse_and_round_trip_without_adding_or_dropping_fields() {
    let mut seen = BTreeSet::new();
    for entry in manifest().iter().filter(|e| e["expect"] == "valid") {
        let contract = entry["contract"].as_str().unwrap();
        let text = text_of(entry);
        let typed_digest = parse_as(contract, &text)
            .unwrap_or_else(|code| panic!("{} rejected: {code}", entry["path"]));
        assert_eq!(
            typed_digest,
            digest(&parse_json(&text).unwrap()).unwrap(),
            "{}",
            entry["path"]
        );
        seen.insert(contract.to_owned());
    }
    for contract in [
        "strategy-artefact",
        "evaluation-input",
        "evaluation-result",
        "checkpoint",
    ] {
        assert!(seen.contains(contract), "no valid fixture for {contract}");
    }
}

#[test]
fn schema_invalid_payloads_are_rejected_with_the_expected_code() {
    let mut codes = BTreeSet::new();
    let mut count = 0;
    for entry in manifest()
        .iter()
        .filter(|e| e["expect"] == "schema_invalid")
    {
        let contract = entry["contract"].as_str().unwrap();
        let expected = entry["code"].as_str().unwrap();
        match parse_as(contract, &text_of(entry)) {
            Ok(_) => panic!("{} was accepted", entry["path"]),
            Err(code) => assert_eq!(code, expected, "{}", entry["path"]),
        }
        codes.insert(expected.to_owned());
        count += 1;
    }
    assert!(
        count >= 8,
        "expected at least eight schema-invalid fixtures, found {count}"
    );
    for required in [
        "UNSUPPORTED_SCHEMA_VERSION",
        "SCHEMA_VIOLATION",
        "INVALID_DECIMAL",
    ] {
        assert!(codes.contains(required), "no fixture exercises {required}");
    }
}

#[test]
fn semantic_invalid_payloads_are_schema_valid() {
    for entry in manifest()
        .iter()
        .filter(|e| e["expect"] == "semantic_invalid")
    {
        let contract = entry["contract"].as_str().unwrap();
        assert!(
            parse_as(contract, &text_of(entry)).is_ok(),
            "{} must parse; the shared validator, preparation or restore rejects it",
            entry["path"]
        );
        assert!(
            entry["code"].is_string(),
            "{} needs an expected code",
            entry["path"]
        );
    }
}

fn walk(dir: &Path, out: &mut Vec<String>) {
    for item in std::fs::read_dir(dir).unwrap() {
        let path = item.unwrap().path();
        if path.is_dir() {
            walk(&path, out);
        } else {
            out.push(path.to_string_lossy().into_owned());
        }
    }
}

#[test]
fn manifest_lists_every_protocol_file_and_every_listed_file_exists() {
    let root = format!("{FIXTURES}/protocol");
    let mut files = Vec::new();
    walk(Path::new(&root), &mut files);
    let on_disk: BTreeSet<String> = files
        .iter()
        .filter_map(|f| f.strip_prefix(&format!("{FIXTURES}/")).map(str::to_owned))
        .filter(|f| f != "protocol/manifest.json" && f != "protocol/README.md")
        .collect();
    let mut listed = BTreeSet::new();
    for entry in manifest() {
        let path = entry["path"].as_str().unwrap().to_owned();
        assert!(
            Path::new(&format!("{FIXTURES}/{path}")).is_file(),
            "{path} is listed but missing"
        );
        assert!(listed.insert(path.clone()), "{path} is listed twice");
    }
    let orphans: Vec<_> = on_disk.iter().filter(|f| !listed.contains(*f)).collect();
    assert!(orphans.is_empty(), "files not in the manifest: {orphans:?}");
}

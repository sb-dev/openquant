//! Schema validation stays bounded in time and memory on hostile payloads (review finding F-01),
//! and the failure code reflects every violation rather than only the listed ones (finding F-07).

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use std::time::{Duration, Instant};

use openquant_contracts::{
    Contract, ContractError, EvaluationInput, FailureCode, SchemaViolation, parse, validate,
};
use serde_json::{Map, Value, json};

fn smoke_input() -> Value {
    serde_json::from_str(include_str!(
        "../../../../fixtures/s0/cases/F0-smoke/input.json"
    ))
    .unwrap()
}

fn violations_of(error: ContractError) -> Vec<SchemaViolation> {
    match error {
        ContractError::Schema(violations) => violations,
        other => panic!("expected a schema rejection, got {other:?}"),
    }
}

/// A payload of `count` empty objects in place of bars. Each is three bytes on the wire, yet the
/// full-diagnostic pass used to spend about 3.4 KiB on each, so 200,000 of them needed 680 MB.
fn empty_bars_payload(count: usize) -> String {
    let bars = vec!["{}"; count].join(",");
    format!(
        r#"{{"schema_version":"evaluation-input/1","instruments":[{{"instrument_id":"SYN","bars":[{bars}]}}]}}"#
    )
}

#[test]
fn two_hundred_thousand_empty_bars_are_a_typed_error_within_a_time_bound() {
    let text = empty_bars_payload(200_000);
    let started = Instant::now();
    let error = parse::<EvaluationInput>(&text).unwrap_err();
    let elapsed = started.elapsed();
    // Measured in a debug build: about 3.4 s and 680 MB before the limits, about 0.08 s after.
    assert!(
        elapsed < Duration::from_secs(2),
        "rejecting 200,000 empty bars took {elapsed:?}"
    );
    assert_eq!(error.failure_code(), FailureCode::SchemaViolation);
    let violations = violations_of(error);
    // The limit that was exceeded, then the first schema violation. No full pass ran.
    assert_eq!(violations.len(), 2, "{violations:?}");
    assert_eq!(violations[0].pointer, "/instruments/0/bars");
    assert!(violations[0].message.contains("items"), "{violations:?}");
    assert!(
        violations.iter().all(|v| v.message.len() <= 1100),
        "messages must not echo the payload"
    );
}

#[test]
fn structural_limits_name_the_offending_location() {
    let long_text = "x".repeat(20_000);
    let many_keys: Map<String, Value> = (0..100).map(|i| (format!("k{i}"), json!(i))).collect();
    let mut nested = Value::Null;
    for _ in 0..200 {
        nested = Value::Array(vec![nested]);
    }
    type Mutation<'a> = Box<dyn Fn(&mut Value) + 'a>;
    let cases: Vec<(&str, Mutation<'_>, &str, &str)> = vec![
        (
            "string",
            Box::new(|doc| doc["dataset"]["licence"] = json!(long_text)),
            "/dataset/licence",
            "string",
        ),
        (
            "array",
            Box::new(|doc| doc["instruments"][0]["bars"] = Value::Array(vec![json!(0); 9_000])),
            "/instruments/0/bars",
            "array",
        ),
        (
            // The key also covers the JSON pointer escapes for "/" and "~".
            "object",
            Box::new(|doc| doc["dataset"]["a/b~c"] = Value::Object(many_keys.clone())),
            "/dataset/a~1b~0c",
            "object",
        ),
        (
            "depth",
            Box::new(|doc| doc["extra"] = nested.clone()),
            "/extra/0/0/0",
            "deep",
        ),
        (
            "nodes",
            Box::new(|doc| {
                let bar = doc["instruments"][0]["bars"][0].clone();
                doc["instruments"][0]["bars"] = Value::Array(vec![bar; 3_000]);
            }),
            "/instruments/0/bars/",
            "values",
        ),
    ];
    for (name, mutate, pointer_prefix, word) in cases {
        let mut doc = smoke_input();
        mutate(&mut doc);
        let error = validate(Contract::EvaluationInput, &doc).unwrap_err();
        assert_eq!(error.failure_code(), FailureCode::SchemaViolation, "{name}");
        let violations = violations_of(error);
        assert!(
            violations[0].pointer.starts_with(pointer_prefix),
            "{name}: {violations:?}"
        );
        assert!(
            violations[0].message.contains(word),
            "{name}: {violations:?}"
        );
        assert!(violations.len() <= 2, "{name}: {violations:?}");
    }
}

#[test]
fn valid_documents_larger_than_the_diagnostic_limits_are_accepted() {
    // 4,000 ledger entries is the schema maximum. At nine values each the document holds more
    // values than the diagnostic pass examines, and it is valid.
    let mut result: Value = serde_json::from_str(include_str!(
        "../../../../fixtures/protocol/valid/evaluation-result.f0.json"
    ))
    .unwrap();
    let entry = result["journal"]["cash_ledger"][0].clone();
    result["journal"]["cash_ledger"] = Value::Array(vec![entry; 4_000]);
    validate(Contract::EvaluationResult, &result).unwrap();
}

/// 30 bars with three decimal-grammar violations each: 90 in all, past the reporting cap.
fn input_with_many_decimal_errors() -> Value {
    let mut doc = smoke_input();
    let bar = doc["instruments"][0]["bars"][0].clone();
    let mut bars = Vec::new();
    for _ in 0..30 {
        let mut bad = bar.clone();
        bad["open"] = json!("01");
        bad["high"] = json!("1e5");
        bad["low"] = json!("-0");
        bars.push(bad);
    }
    doc["instruments"][0]["bars"] = Value::Array(bars);
    doc
}

#[test]
fn many_decimal_errors_alone_still_report_invalid_decimal() {
    let doc = input_with_many_decimal_errors();
    let error = validate(Contract::EvaluationInput, &doc).unwrap_err();
    assert_eq!(error.failure_code(), FailureCode::InvalidDecimal);
    let violations = violations_of(error);
    assert!(violations.len() > 20, "the list is capped and marked");
    assert!(violations.iter().all(|v| v.decimal_grammar));
}

#[test]
fn a_non_decimal_error_beyond_the_reporting_cap_is_not_reported_as_invalid_decimal() {
    let mut doc = input_with_many_decimal_errors();
    doc["strategy_hash"] = json!("sha256:xyz");
    doc["policy"]["currency"] = json!("!!");
    let error = validate(Contract::EvaluationInput, &doc).unwrap_err();
    assert_eq!(error.failure_code(), FailureCode::SchemaViolation);
    let violations = violations_of(error);
    // The precondition of this test: every listed violation is a decimal one, so a
    // classification from the listed entries alone would say INVALID_DECIMAL. The last entry
    // stands for the violations beyond the cap.
    let (marker, listed) = violations.split_last().unwrap();
    assert_eq!(listed.len(), 20);
    assert!(listed.iter().all(|v| v.decimal_grammar), "{listed:?}");
    assert!(!marker.decimal_grammar, "{marker:?}");
    assert!(marker.message.contains("further"), "{marker:?}");
}

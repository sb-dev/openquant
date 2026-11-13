//! Contract layer behaviour: strict JSON, canonical JSON, digests and decimal grammar.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use openquant_contracts::{
    ContractError, FailureCode, canonical_json, decimal, digest, digest_bytes, parse_json,
};
use rust_decimal::Decimal;
use serde_json::json;

#[test]
fn canonical_json_sorts_keys_and_drops_whitespace() {
    let value = parse_json(r#" { "b": [1, 2, {"z": null, "a": true}], "a": "x" } "#).unwrap();
    assert_eq!(
        canonical_json(&value).unwrap(),
        r#"{"a":"x","b":[1,2,{"a":true,"z":null}]}"#
    );
}

#[test]
fn canonical_json_escapes_like_rfc_8785() {
    let value = json!({"k": "quote\" backslash\\ tab\t newline\n bell\u{7} del\u{7f} é"});
    assert_eq!(
        canonical_json(&value).unwrap(),
        "{\"k\":\"quote\\\" backslash\\\\ tab\\t newline\\n bell\\u0007 del\u{7f} é\"}"
    );
}

#[test]
fn digest_of_empty_object_matches_the_known_sha256_vector() {
    // SHA-256("{}")
    assert_eq!(
        digest(&json!({})).unwrap(),
        "sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a"
    );
    assert_eq!(
        digest_bytes(b"abc"),
        "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
}

#[test]
fn digest_ignores_input_whitespace_and_key_order() {
    let a = parse_json(r#"{"x":1,"y":[true,"s"]}"#).unwrap();
    let b = parse_json("{\n \"y\" : [ true , \"s\" ],\n \"x\" : 1 }").unwrap();
    assert_eq!(digest(&a).unwrap(), digest(&b).unwrap());
}

#[test]
fn canonical_json_rejects_non_ascii_keys() {
    let value = json!({"é": 1});
    assert!(matches!(
        canonical_json(&value),
        Err(ContractError::Canonical(_))
    ));
}

#[test]
fn strict_parse_rejects_duplicate_keys_floats_exponents_and_trailing_text() {
    assert!(matches!(
        parse_json(r#"{"a":1,"a":2}"#),
        Err(ContractError::DuplicateKey(key)) if key == "a"
    ));
    assert!(matches!(
        parse_json(r#"{"a":1.5}"#),
        Err(ContractError::FloatNumber)
    ));
    assert!(matches!(
        parse_json(r#"{"a":1.0}"#),
        Err(ContractError::FloatNumber)
    ));
    assert!(matches!(
        parse_json(r#"{"a":1e3}"#),
        Err(ContractError::FloatNumber)
    ));
    assert!(matches!(
        parse_json(r#"{"a":1} x"#),
        Err(ContractError::Json(_))
    ));
    assert!(matches!(parse_json("{"), Err(ContractError::Json(_))));
    assert!(parse_json(r#"{"a":[1,-2,0,true,null,"s"]}"#).is_ok());
}

#[test]
fn decimal_grammar_accepts_only_plain_decimals() {
    for good in [
        "0",
        "0.0",
        "0.50",
        "1",
        "10",
        "100.25",
        "-1",
        "-0.5",
        "123456789.123456789",
    ] {
        assert!(decimal::parse(good, 12).is_ok(), "{good}");
    }
    for bad in [
        "", "+1", "01", "00", "-0", "-0.0", "-0.00", ".5", "1.", "1e3", "1E3", "1_000", " 1", "1 ",
        "NaN", "inf", "1,5", "--1", "0x10", "٣",
    ] {
        assert!(
            matches!(decimal::parse(bad, 12), Err(ContractError::Decimal { .. })),
            "{bad:?}"
        );
    }
}

#[test]
fn decimal_scale_limit_is_enforced() {
    assert!(decimal::parse("1.25", 2).is_ok());
    assert!(matches!(
        decimal::parse("1.255", 2),
        Err(ContractError::Decimal { .. })
    ));
}

#[test]
fn decimal_format_pads_and_refuses_to_round() {
    assert_eq!(decimal::format(&Decimal::new(5, 0), 2).unwrap(), "5.00");
    assert_eq!(decimal::format(&Decimal::new(-15, 1), 2).unwrap(), "-1.50");
    assert_eq!(decimal::format(&Decimal::ZERO, 3).unwrap(), "0.000");
    assert_eq!(decimal::format(&Decimal::new(0, 0), 0).unwrap(), "0");
    assert!(decimal::format(&Decimal::new(125, 3), 2).is_err());
}

#[test]
fn decimal_format_rejects_scales_above_the_decimal_maximum() {
    for scale in [29, 40, u32::MAX] {
        for value in [Decimal::ZERO, Decimal::ONE, Decimal::new(-5, 1)] {
            assert!(
                matches!(
                    decimal::format(&value, scale),
                    Err(ContractError::Decimal { .. })
                ),
                "{value} at scale {scale}"
            );
        }
    }
    // 28 is the largest scale a Decimal carries and stays supported.
    assert_eq!(
        decimal::format(&Decimal::ZERO, 28).unwrap(),
        format!("0.{}", "0".repeat(28))
    );
    assert_eq!(
        decimal::format(&Decimal::ONE, 28).unwrap(),
        format!("1.{}", "0".repeat(28))
    );
}

#[test]
fn decimal_format_rejects_a_value_too_large_to_carry_the_requested_scale() {
    let huge = decimal::parse("10000000000000000000000000000", 0).unwrap();
    assert!(matches!(
        decimal::format(&huge, 2),
        Err(ContractError::Decimal { .. })
    ));
    assert_eq!(
        decimal::format(&huge, 0).unwrap(),
        "10000000000000000000000000000"
    );
    assert!(matches!(
        decimal::format(&Decimal::MAX, 1),
        Err(ContractError::Decimal { .. })
    ));
    assert_eq!(
        decimal::format(&Decimal::MAX, 0).unwrap(),
        "79228162514264337593543950335"
    );
    // The largest value that does carry two digits keeps them.
    let fits = decimal::parse("792281625142643375935439503.35", 2).unwrap();
    assert_eq!(
        decimal::format(&fits, 2).unwrap(),
        "792281625142643375935439503.35"
    );
}

#[test]
fn schema_decimal_failures_report_invalid_decimal() {
    let mut value: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../fixtures/s0/cases/F0-smoke/input.json"
    ))
    .unwrap();
    value["initial_capital"] = json!("5e3");
    let error =
        openquant_contracts::validate(openquant_contracts::Contract::EvaluationInput, &value)
            .unwrap_err();
    assert_eq!(error.failure_code(), FailureCode::InvalidDecimal);

    value["initial_capital"] = json!(5000);
    let error =
        openquant_contracts::validate(openquant_contracts::Contract::EvaluationInput, &value)
            .unwrap_err();
    assert_eq!(error.failure_code(), FailureCode::SchemaViolation);
}

#[test]
fn unsupported_and_missing_versions_have_distinct_codes() {
    let mut value: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../fixtures/s0/cases/F0-smoke/input.json"
    ))
    .unwrap();
    value["schema_version"] = json!("evaluation-input/2");
    let error =
        openquant_contracts::validate(openquant_contracts::Contract::EvaluationInput, &value)
            .unwrap_err();
    assert_eq!(error.failure_code(), FailureCode::UnsupportedSchemaVersion);
    value.as_object_mut().unwrap().remove("schema_version");
    let error =
        openquant_contracts::validate(openquant_contracts::Contract::EvaluationInput, &value)
            .unwrap_err();
    assert!(matches!(error, ContractError::MissingVersion));
}

#[test]
fn python_independent_digest_of_the_f0_strategy_matches() {
    // The fixture generator computed this digest with Python's json + hashlib (no shared code).
    let text = include_str!("../../../../fixtures/s0/cases/F0-smoke/strategy.json");
    let strategy: openquant_contracts::StrategyArtefact = openquant_contracts::parse(text).unwrap();
    let input_text = include_str!("../../../../fixtures/s0/cases/F0-smoke/input.json");
    let input: openquant_contracts::EvaluationInput =
        openquant_contracts::parse(input_text).unwrap();
    assert_eq!(
        openquant_contracts::payload_digest(&strategy).unwrap(),
        input.strategy_hash.as_str()
    );
}

#[test]
fn typed_round_trip_preserves_the_digest() {
    let text = include_str!("../../../../fixtures/s0/cases/F0-smoke/input.json");
    let value = parse_json(text).unwrap();
    let typed: openquant_contracts::EvaluationInput = openquant_contracts::parse(text).unwrap();
    assert_eq!(
        digest(&value).unwrap(),
        openquant_contracts::payload_digest(&typed).unwrap(),
        "typed binding must neither add nor drop fields"
    );
}

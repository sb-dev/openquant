//! `Exact`: the wire value for state that feeds a price-grid decision. A decimal when the value
//! terminates within 28 fractional digits, otherwise a reduced fraction `n/d`.
//!
//! The pattern in `common.schema.json` checks the grammar. The canonical rule (reduced,
//! denominator above 1, no decimal form, 128 bits) is checked in code and reports the same
//! failure code as a malformed decimal, `INVALID_DECIMAL`.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use std::str::FromStr;

use openquant_contracts::{
    Checkpoint, ContractError, EvaluationResult, FailureCode,
    exact::{self, Exact},
    generated, parse,
};
use rust_decimal::Decimal;
use serde_json::Value;

const CHECKPOINT: &str = include_str!(
    "../../../../fixtures/protocol/valid/checkpoint.exact-open-position-fraction.json"
);
const RESULT: &str = include_str!("../../../../fixtures/protocol/valid/evaluation-result.f0.json");

fn fraction(numerator: i128, denominator: i128) -> Exact {
    Exact::Fraction {
        numerator,
        denominator,
    }
}

#[test]
fn a_decimal_parses_as_a_decimal_and_a_canonical_fraction_as_a_fraction() {
    assert_eq!(exact::parse("0").unwrap(), Exact::Decimal(Decimal::ZERO));
    assert_eq!(exact::parse("5").unwrap(), Exact::Decimal(Decimal::from(5)));
    assert_eq!(
        exact::parse("-5.67").unwrap(),
        Exact::Decimal(Decimal::new(-567, 2))
    );
    // Trailing zeros are accepted, as for any decimal on the wire.
    assert_eq!(
        exact::parse("102.00").unwrap(),
        Exact::Decimal(Decimal::new(10_200, 2))
    );
    assert_eq!(exact::parse("1/3").unwrap(), fraction(1, 3));
    assert_eq!(exact::parse("-17/75").unwrap(), fraction(-17, 75));
    assert_eq!(exact::parse("14399/150").unwrap(), fraction(14_399, 150));
    // The widest terms: the largest 128-bit integers. 2^127 - 1 is prime, so these are reduced.
    assert_eq!(
        exact::parse("170141183460469231731687303715884105727/3").unwrap(),
        fraction(i128::MAX, 3)
    );
    assert_eq!(
        exact::parse("-1/170141183460469231731687303715884105727").unwrap(),
        fraction(-1, i128::MAX)
    );
    // 1/2^29 has 29 fractional digits, so it has no 28-digit decimal form: it is a fraction.
    assert_eq!(exact::parse("1/536870912").unwrap(), fraction(1, 1 << 29));
}

#[test]
fn every_non_canonical_or_malformed_text_is_an_invalid_decimal() {
    let cases = [
        ("2/4", "not reduced"),
        ("28798/300", "not reduced"),
        ("5/1", "denominator 1"),
        ("-5/1", "denominator 1"),
        ("1/2", "decimal form"),
        ("-3/4", "decimal form"),
        ("1/1000", "decimal form"),
        ("1/0", "leading zero"),
        ("0/5", "leading zero"),
        ("-0/5", "leading zero"),
        ("01/3", "leading zero"),
        ("1/03", "leading zero"),
        ("1/", "needs a numerator"),
        ("/3", "needs a numerator"),
        ("+1/3", "digits only"),
        ("1/+3", "digits only"),
        ("1e3/7", "digits only"),
        ("1/3e2", "digits only"),
        ("1/-3", "digits only"),
        ("--1/3", "digits only"),
        ("1.5/3", "digits only"),
        ("1/3.5", "digits only"),
        ("1/3/4", "digits only"),
        (" 1/3", "digits only"),
        ("1/3 ", "digits only"),
        ("1e3", "integer part"),
        ("+5", "integer part"),
        ("05", "leading zero"),
        ("-0", "negative zero"),
        ("1.", "fraction must be"),
        ("", "integer part"),
        (
            "170141183460469231731687303715884105729/3",
            "numerator does not fit",
        ),
        (
            "-170141183460469231731687303715884105728/3",
            "numerator does not fit",
        ),
        (
            "1/170141183460469231731687303715884105728",
            "denominator does not fit",
        ),
        ("1.00000000000000000000000000001", "out of range"),
    ];
    let long = format!("1/{}", "9".repeat(90));
    let cases = cases
        .into_iter()
        .chain([(long.as_str(), "longer than 80")])
        .collect::<Vec<_>>();
    for (text, reason) in cases {
        let error = exact::parse(text).expect_err(text);
        assert!(
            matches!(error, ContractError::Decimal { .. }),
            "{text:?}: {error:?}"
        );
        assert_eq!(
            error.failure_code(),
            FailureCode::InvalidDecimal,
            "{text:?}"
        );
        assert!(
            error.to_string().contains(reason),
            "{text:?}: {error} (wanted {reason:?})"
        );
    }
}

#[test]
fn the_terminating_decimal_of_a_fraction_is_the_one_canonical_test() {
    let value = |n, d| exact::terminating(n, d);
    assert_eq!(value(1, 2), Some(Decimal::new(5, 1)));
    assert_eq!(value(5, 1), Some(Decimal::from(5)));
    assert_eq!(value(-7, 4), Some(Decimal::new(-175, 2)));
    assert_eq!(value(0, 1), Some(Decimal::ZERO));
    assert_eq!(value(1, 3), None);
    assert_eq!(value(1, 0), None);
    assert_eq!(value(1, -2), None);
    // 28 fractional digits terminate; 29 do not fit.
    assert_eq!(value(1, 1 << 28).map(|d| d.scale()), Some(28));
    assert_eq!(value(1, 1 << 29), None);
    // More than 96 bits of digits.
    assert_eq!(value(i128::MAX, 1), None);
    assert_eq!(value(i128::MAX, 2), None);
}

#[test]
fn the_writer_follows_the_canonical_rule_and_the_reader_accepts_what_it_writes() {
    assert_eq!(exact::format(1, 2).unwrap(), "0.5");
    assert_eq!(exact::format(5, 1).unwrap(), "5");
    assert_eq!(exact::format(0, 1).unwrap(), "0");
    assert_eq!(exact::format(-7, 4).unwrap(), "-1.75");
    assert_eq!(exact::format(1, 3).unwrap(), "1/3");
    assert_eq!(exact::format(-901, 300).unwrap(), "-901/300");
    for (n, d) in [
        (1, 3),
        (-17, 75),
        (14_399, 150),
        (1, 1 << 29),
        (i128::MAX, 3),
    ] {
        let text = exact::format(n, d).unwrap();
        assert_eq!(exact::parse(&text).unwrap(), fraction(n, d), "{text}");
    }
    // Not canonical: refused rather than written.
    for (n, d) in [(2, 6), (1, 0), (1, -3), (i128::MIN, 3), (i128::MAX, 1)] {
        assert!(
            matches!(exact::format(n, d), Err(ContractError::Decimal { .. })),
            "{n}/{d}"
        );
    }
}

#[test]
fn the_generated_type_checks_the_grammar_and_the_length() {
    for ok in [
        "0",
        "-5.67",
        "1/3",
        "-14399/150",
        "170141183460469231731687303715884105727/3",
    ] {
        assert!(generated::Exact::from_str(ok).is_ok(), "{ok}");
    }
    for bad in ["01/3", "1/0", "0/5", "1/", "+1/3", "1e3", "1/-3", ""] {
        assert!(generated::Exact::from_str(bad).is_err(), "{bad:?}");
    }
    let long = format!("1/{}", "9".repeat(90));
    assert!(generated::Exact::from_str(&long).is_err());
}

fn checkpoint_with(edit: impl Fn(&mut Value)) -> String {
    let mut value: Value = serde_json::from_str(CHECKPOINT).unwrap();
    edit(&mut value);
    serde_json::to_string(&value).unwrap()
}

fn result_with(edit: impl Fn(&mut Value)) -> String {
    let mut value: Value = serde_json::from_str(RESULT).unwrap();
    edit(&mut value);
    serde_json::to_string(&value).unwrap()
}

#[test]
fn a_checkpoint_holds_a_fraction_in_every_exact_field() {
    // The fixture is a real run: stop 14399/150, snapshot 901/300.
    let value: Value = serde_json::from_str(CHECKPOINT).unwrap();
    assert_eq!(value["state"]["positions"][0]["stop"], "14399/150");
    assert_eq!(
        value["state"]["positions"][0]["snapshots"][0]["value"],
        "901/300"
    );
    parse::<Checkpoint>(CHECKPOINT).unwrap();
    // Every field the schema types as Exact accepts a fraction and a decimal.
    for text in ["1/3", "-1/3", "0.5", "7"] {
        for field in ["entry_price", "stop", "target"] {
            let edited = checkpoint_with(|v| v["state"]["positions"][0][field] = text.into());
            parse::<Checkpoint>(&edited).unwrap_or_else(|e| panic!("{field} {text}: {e}"));
        }
        let edited = checkpoint_with(|v| {
            v["state"]["positions"][0]["snapshots"][0]["value"] = text.into();
        });
        parse::<Checkpoint>(&edited).unwrap_or_else(|e| panic!("snapshot {text}: {e}"));
        let edited = checkpoint_with(|v| {
            v["state"]["positions"][0]["scheduled_stop"] = serde_json::json!({
                "level": text,
                "effective_session": "2026-01-13",
            });
        });
        parse::<Checkpoint>(&edited).unwrap_or_else(|e| panic!("scheduled {text}: {e}"));
    }
}

#[test]
fn a_fraction_where_the_schema_keeps_a_decimal_is_an_invalid_decimal() {
    // The checkpoint's cash, mark, quantity and rank and the result's levels and snapshots stay
    // Decimal: a fraction breaks the decimal grammar.
    for text in [
        checkpoint_with(|v| v["state"]["cash_available"] = "1/3".into()),
        checkpoint_with(|v| v["state"]["positions"][0]["mark"] = "1/3".into()),
        checkpoint_with(|v| v["state"]["positions"][0]["quantity"] = "1/3".into()),
        checkpoint_with(|v| v["state"]["journal"]["entries"][0]["rank"] = "1/3".into()),
    ] {
        let error = parse::<Checkpoint>(&text).unwrap_err();
        assert_eq!(error.failure_code(), FailureCode::InvalidDecimal, "{error}");
    }
    for text in [
        result_with(|v| v["final"]["open_positions"][0]["stop"] = "1/3".into()),
        result_with(|v| v["final"]["open_positions"][0]["target"] = "1/3".into()),
        result_with(|v| v["final"]["open_positions"][0]["entry_price"] = "1/3".into()),
        result_with(|v| v["final"]["open_positions"][0]["snapshots"][0]["value"] = "1/3".into()),
    ] {
        let error = parse::<EvaluationResult>(&text).unwrap_err();
        assert_eq!(error.failure_code(), FailureCode::InvalidDecimal, "{error}");
    }
}

#[test]
fn a_malformed_exact_value_is_an_invalid_decimal_and_an_overlong_one_a_schema_violation() {
    for stop in [
        "1/0",
        "0/5",
        "01/3",
        "14399/",
        "1e3/7",
        "+1/3",
        "14399/-150",
        "1.5/3",
    ] {
        let error = parse::<Checkpoint>(&checkpoint_with(|v| {
            v["state"]["positions"][0]["stop"] = stop.into();
        }))
        .unwrap_err();
        assert_eq!(
            error.failure_code(),
            FailureCode::InvalidDecimal,
            "{stop}: {error}"
        );
    }
    // Longer than 80 characters but within the grammar: a schema violation, not a malformed
    // decimal.
    let long = format!("1/{}", "9".repeat(90));
    let error = parse::<Checkpoint>(&checkpoint_with(|v| {
        v["state"]["positions"][0]["stop"] = long.as_str().into();
    }))
    .unwrap_err();
    assert_eq!(
        error.failure_code(),
        FailureCode::SchemaViolation,
        "{error}"
    );
}

#[test]
fn the_canonical_rule_is_not_the_schema_pattern() {
    // These match the pattern and pass the schema; the canonical rule (code, not pattern) rejects
    // them when the checkpoint is read as state.
    for stop in [
        "2/4",
        "5/1",
        "1/2",
        "170141183460469231731687303715884105729/3",
    ] {
        parse::<Checkpoint>(&checkpoint_with(|v| {
            v["state"]["positions"][0]["stop"] = stop.into();
        }))
        .unwrap_or_else(|e| panic!("{stop}: {e}"));
        assert!(exact::parse(stop).is_err(), "{stop}");
    }
}

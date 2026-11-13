//! The reviewed operator catalogue of `daily-long-only-seed@1` (OQ-02 section 2.2).
//!
//! The expected table below is written from the plan and the specification, not read from the
//! catalogue: a new, removed or re-scoped operator fails here until the change is reviewed.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

mod operators_support;

use openquant_core::operators::{
    CATALOGUE, OPERATOR_SET, Scope,
    catalogue::{catalogue_text, lookup},
};
use operators_support::*;

const S: Scope = Scope::Signal;
const L: Scope = Scope::Level;
const T: Scope = Scope::Trigger;

/// (name, minimum arguments, maximum arguments, scopes). Independent of `catalogue.rs`.
const EXPECTED: [(&str, usize, usize, &[Scope]); 19] = [
    ("const", 0, 0, &[S, L, T]),
    ("bar_field", 0, 0, &[S, T]),
    ("ref", 0, 0, &[S]),
    ("lag", 1, 1, &[S]),
    ("sma", 1, 1, &[S]),
    ("rsi_simple", 1, 1, &[S]),
    ("atr_simple", 0, 0, &[S]),
    ("add", 2, 2, &[S, L, T]),
    ("sub", 2, 2, &[S, L, T]),
    ("mul", 2, 2, &[S, L, T]),
    ("div", 2, 2, &[S, L, T]),
    ("gt", 2, 2, &[S, L, T]),
    ("gte", 2, 2, &[S, L, T]),
    ("lt", 2, 2, &[S, L, T]),
    ("lte", 2, 2, &[S, L, T]),
    ("and", 2, 8, &[S, L, T]),
    ("or", 2, 8, &[S, L, T]),
    ("entry_price", 0, 0, &[L, T]),
    ("snapshot", 0, 0, &[L, T]),
];

#[test]
fn the_operator_set_is_named_and_versioned() {
    assert_eq!(OPERATOR_SET, "daily-long-only-seed@1");
    assert!(catalogue_text().starts_with("daily-long-only-seed@1\n"));
}

#[test]
fn the_catalogue_holds_exactly_the_reviewed_operators() {
    let actual: Vec<_> = CATALOGUE
        .iter()
        .map(|d| (d.name, d.min_args, d.max_args, d.scopes))
        .collect();
    assert_eq!(actual.len(), EXPECTED.len());
    for (got, want) in actual.iter().zip(EXPECTED) {
        assert_eq!(got.0, want.0);
        assert_eq!((got.1, got.2), (want.1, want.2), "arity of {}", want.0);
        assert_eq!(got.3, want.3, "scopes of {}", want.0);
    }
    for descriptor in CATALOGUE {
        assert_eq!(descriptor.version, 1, "{}", descriptor.name);
        assert!(
            descriptor.semantics.len() > 10,
            "{} needs a semantics line for review and the digest",
            descriptor.name
        );
    }
}

#[test]
fn every_catalogue_operator_resolves_at_version_one() {
    for (name, ..) in EXPECTED {
        let descriptor = lookup(&format!("operator:{name}@1")).unwrap();
        assert_eq!(descriptor.name, name);
    }
}

#[test]
fn operators_outside_the_catalogue_are_unsupported() {
    // Includes the operators the plan names (ema, max, min, abs, not) and code-execution shapes.
    for name in [
        "ema",
        "max",
        "min",
        "abs",
        "not",
        "wilder_rsi",
        "rsi",
        "atr",
        "sum",
        "if",
        "eval",
        "exec",
        "shell",
        "sqrt",
        "log",
        "pow",
        "neg",
        "ceil",
        "floor",
        "round",
        "stddev",
        "highest",
        "lowest",
        "crossover",
        "shift",
        "delay",
        "mean",
        "close",
        "bar",
        "xor",
        "ne",
        "eq",
    ] {
        let failure = lookup(&format!("operator:{name}@1")).unwrap_err();
        assert_eq!(failure.code.to_string(), "UNSUPPORTED_OPERATOR", "{name}");
        // Through the validator, in an indicator.
        let failure = Def::new()
            .indicator("x", op(name, vec![], serde_json::json!({})))
            .reject();
        assert_eq!(failure.code.to_string(), "UNSUPPORTED_OPERATOR", "{name}");
        assert!(
            failure.detail.starts_with("/definition/indicators/0/expr"),
            "{name}: {}",
            failure.detail
        );
    }
}

#[test]
fn only_the_canonical_spelling_of_version_one_resolves() {
    for reference in [
        "operator:sma@0",
        "operator:sma@2",
        "operator:sma@10",
        "operator:sma@01",
        "operator:sma@001",
        "operator:sma@+1",
        "operator:sma@-1",
        "operator:sma@1.0",
        "operator:sma@1e0",
        "operator:sma@ 1",
        "operator:sma@1 ",
        "operator:sma@1\n",
        "operator:sma@",
        "operator:sma@1@1",
        "operator:sma@4294967297",
        "operator:sma@99999999999999999999999",
        "operator:sma@٣",
    ] {
        let failure = lookup(reference).unwrap_err();
        assert_eq!(
            failure.code.to_string(),
            "UNSUPPORTED_OPERATOR",
            "{reference:?}"
        );
    }
    assert!(lookup("operator:sma@1").is_ok());
}

#[test]
fn malformed_operator_references_are_unsupported() {
    for reference in [
        "",
        "sma@1",
        "operator:",
        "operator:sma",
        "operator:@1",
        "operators:sma@1",
        "Operator:sma@1",
        "operator:SMA@1",
        "operator: sma@1",
        "operator:sma @1",
        "operator:sma@1;rm",
        "operator:../sma@1",
    ] {
        let failure = lookup(reference).unwrap_err();
        assert_eq!(
            failure.code.to_string(),
            "UNSUPPORTED_OPERATOR",
            "{reference:?}"
        );
    }
}

#[test]
fn a_wrong_compatibility_version_is_rejected_by_the_validator_before_anything_else() {
    // The typed binding accepts any well-formed reference; the validator owns compatibility.
    for version in ["2", "10", "99999999999", "18446744073709551615999"] {
        let expr = serde_json::json!({
            "op": format!("operator:sma@{version}"),
            // Arity and parameters are wrong too: the unsupported version is reported first.
            "args": [], "params": {}
        });
        let failure = Def::new().indicator("x", expr).reject();
        assert_eq!(
            failure.code.to_string(),
            "UNSUPPORTED_OPERATOR",
            "@{version}"
        );
    }
}

#[test]
fn the_catalogue_text_lists_every_operator_with_its_semantics() {
    let text = catalogue_text();
    let lines: Vec<_> = text.lines().collect();
    assert_eq!(lines.len(), 1 + EXPECTED.len());
    for ((name, min, max, _), line) in EXPECTED.iter().zip(lines.iter().skip(1)) {
        assert!(
            line.starts_with(&format!("{name}@1 args={min}..{max} scopes=[")),
            "{line}"
        );
    }
}

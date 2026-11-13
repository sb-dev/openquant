//! Unit tests of the expected-versus-actual comparison.
//!
//! The comparison decides whether a fixture passes, so its own behaviour is pinned here with
//! small hand-written values: subset matching, signals matched by session, decimals compared by
//! value, array lengths and absent sections.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use openquant_engine::compare::{Mismatch, compare, compare_detailed, count_expected};
use serde_json::{Value, json};

fn mismatch(path: &str, expected: &str, actual: &str) -> Mismatch {
    Mismatch {
        path: path.to_owned(),
        expected: expected.to_owned(),
        actual: actual.to_owned(),
    }
}

#[test]
fn an_expectation_is_a_subset_of_the_actual_view() {
    let expected = json!({"final": {"cash_available": "4048.05"}});
    let actual = json!({
        "final": {"cash_available": "4048.05", "equity": "5000.00"},
        "fills": [{"price": "50.00"}],
    });
    assert_eq!(compare(&expected, &actual), vec![]);
}

#[test]
fn a_differing_scalar_is_reported_with_its_path_expected_and_actual() {
    let expected = json!({"fills": [{"price": "50.00"}, {"price": "49.00", "side": "SELL"}]});
    let actual = json!({"fills": [{"price": "50.00"}, {"price": "48.00", "side": "SELL"}]});
    assert_eq!(
        compare(&expected, &actual),
        vec![mismatch("/fills/1/price", "\"49.00\"", "\"48.00\"")]
    );
}

#[test]
fn decimal_strings_compare_by_value_not_by_spelling() {
    let equal = [
        ("50", "50.00"),
        ("0.1", "0.10"),
        ("-1.5", "-1.50"),
        ("0", "0.00"),
        ("1000", "1000.0000"),
    ];
    for (want, have) in equal {
        let result = compare(&json!({"x": want}), &json!({"x": have}));
        assert_eq!(result, vec![], "{want} should equal {have}");
    }
    let different = [("50", "50.01"), ("0.1", "-0.1"), ("1000", "100")];
    for (want, have) in different {
        let result = compare(&json!({"x": want}), &json!({"x": have}));
        assert_eq!(result.len(), 1, "{want} should differ from {have}");
    }
}

#[test]
fn strings_outside_the_decimal_grammar_compare_exactly() {
    // Exponent, leading zero, plus sign and negative zero are not wire decimals, so they do
    // not get value semantics: an engine that emitted them would be seen as different.
    for (want, have) in [
        ("1000", "1e3"),
        ("50", "050"),
        ("50", "+50"),
        ("0", "-0"),
        ("BUY", "buy"),
        ("2026-01-09", "2026-01-9"),
    ] {
        let result = compare(&json!({"x": want}), &json!({"x": have}));
        assert_eq!(result.len(), 1, "{want} must differ from {have}");
    }
    assert_eq!(compare(&json!({"x": "BUY"}), &json!({"x": "BUY"})), vec![]);
}

#[test]
fn a_json_number_is_not_a_decimal_string() {
    let result = compare(&json!({"seq": 2}), &json!({"seq": "2"}));
    assert_eq!(result, vec![mismatch("/seq", "2", "\"2\"")]);
    assert_eq!(compare(&json!({"seq": 2}), &json!({"seq": 2})), vec![]);
    assert_eq!(
        compare(
            &json!({"ambiguous_bar": false}),
            &json!({"ambiguous_bar": false})
        ),
        vec![]
    );
    assert_eq!(
        compare(
            &json!({"ambiguous_bar": true}),
            &json!({"ambiguous_bar": false})
        )
        .len(),
        1
    );
}

#[test]
fn an_array_length_mismatch_is_one_difference_without_element_noise() {
    let expected = json!({"fills": [{"price": "1"}, {"price": "2"}]});
    let actual = json!({"fills": [{"price": "9"}]});
    assert_eq!(
        compare(&expected, &actual),
        vec![mismatch("/fills (length)", "2", "1")]
    );
    let longer = json!({"fills": [{"price": "1"}, {"price": "2"}, {"price": "3"}]});
    assert_eq!(
        compare(&expected, &longer),
        vec![mismatch("/fills (length)", "2", "3")]
    );
}

#[test]
fn an_expected_empty_array_requires_an_empty_actual_array() {
    assert_eq!(
        compare(&json!({"trades": []}), &json!({"trades": []})),
        vec![]
    );
    assert_eq!(
        compare(
            &json!({"trades": []}),
            &json!({"trades": [{"trade_id": "T"}]})
        ),
        vec![mismatch("/trades (length)", "0", "1")]
    );
}

#[test]
fn an_absent_section_or_field_is_reported_as_absent() {
    let expected = json!({"final": {"equity": "5000.00"}, "trades": []});
    let actual = json!({"final": {"cash_available": "5000.00"}});
    assert_eq!(
        compare(&expected, &actual),
        vec![
            mismatch("/final/equity", "\"5000.00\"", "<absent>"),
            mismatch("/trades", "[]", "<absent>"),
        ]
    );
}

#[test]
fn an_expectation_that_is_not_an_object_is_rejected() {
    let result = compare(&json!([1, 2]), &json!({}));
    assert_eq!(result.len(), 1);
    assert_eq!(result.first().map(|m| m.path.as_str()), Some("/"));
    assert_eq!(compare(&Value::Null, &json!({})).len(), 1);
}

#[test]
fn a_value_of_the_wrong_type_is_a_difference() {
    let result = compare(
        &json!({"final": {"equity": "1"}}),
        &json!({"final": "text"}),
    );
    assert_eq!(
        result,
        vec![mismatch("/final", "{\"equity\":\"1\"}", "\"text\"")]
    );
    let result = compare(&json!({"fills": []}), &json!({"fills": {}}));
    assert_eq!(result.len(), 1);
}

#[test]
fn signals_are_matched_by_session_and_the_expectation_may_list_a_few() {
    let actual = json!({"signals": [
        {"session": "2026-01-07", "decision": "NO_ENTRY"},
        {"session": "2026-01-08", "decision": "ENTER", "rank": "1.0000"},
        {"session": "2026-01-09", "decision": "SKIPPED", "skip_reason": "HELD"},
    ]});
    // Listed out of order and only two of three sessions: matched by session, no length check.
    let expected = json!({"signals": [
        {"session": "2026-01-09", "decision": "SKIPPED", "skip_reason": "HELD"},
        {"session": "2026-01-08", "decision": "ENTER", "rank": "1"},
    ]});
    assert_eq!(compare(&expected, &actual), vec![]);
}

#[test]
fn a_differing_signal_field_is_reported_under_its_session() {
    let actual = json!({"signals": [
        {"session": "2026-01-08", "decision": "NO_ENTRY"},
        {"session": "2026-01-09", "decision": "ENTER"},
    ]});
    let expected = json!({"signals": [{"session": "2026-01-09", "decision": "NO_ENTRY"}]});
    assert_eq!(
        compare(&expected, &actual),
        vec![mismatch(
            "/signals/2026-01-09/decision",
            "\"NO_ENTRY\"",
            "\"ENTER\""
        )]
    );
}

#[test]
fn a_signal_for_a_session_the_run_never_reached_is_reported() {
    let actual = json!({"signals": [{"session": "2026-01-08", "decision": "NO_ENTRY"}]});
    let expected = json!({"signals": [{"session": "2026-01-12", "decision": "NO_ENTRY"}]});
    let result = compare(&expected, &actual);
    assert_eq!(result.len(), 1);
    let first = result.first().expect("one difference");
    assert_eq!(first.path, "/signals/2026-01-12");
    assert_eq!(first.actual, "<no signal record for this session>");
}

#[test]
fn indicator_lists_inside_a_signal_must_have_equal_length() {
    let actual = json!({"signals": [{"session": "2026-01-08",
        "indicators": [{"name": "sma3", "value": "50"}, {"name": "atr3", "value": "2"}]}]});
    let expected = json!({"signals": [{"session": "2026-01-08",
        "indicators": [{"name": "sma3", "value": "50.0000"}]}]});
    assert_eq!(
        compare(&expected, &actual),
        vec![mismatch(
            "/signals/2026-01-08/indicators (length)",
            "1",
            "2"
        )]
    );
}

#[test]
fn malformed_signal_expectations_are_differences_not_panics() {
    let actual = json!({"signals": [{"session": "2026-01-08"}]});
    assert_eq!(compare(&json!({"signals": "none"}), &actual).len(), 1);
    assert_eq!(
        compare(&json!({"signals": [{"decision": "ENTER"}]}), &actual).len(),
        1
    );
    assert_eq!(
        compare(
            &json!({"signals": [{"session": "2026-01-08"}]}),
            &json!({"signals": 3})
        )
        .len(),
        1
    );
}

#[test]
fn checks_count_scalars_and_array_lengths_per_section() {
    let expected = json!({
        "outcome": {"status": "COMPLETED"},
        "fills": [{"price": "50.00", "quantity": "19"}],
        "trades": [],
    });
    let actual = json!({
        "outcome": {"status": "COMPLETED"},
        "fills": [{"price": "50.00", "quantity": "18"}],
        "trades": [],
    });
    let comparison = compare_detailed(&expected, &actual);
    let mut counts: Vec<(&str, usize, usize, usize)> = comparison
        .sections
        .iter()
        .map(|s| (s.section.as_str(), s.expected, s.matched, s.differences))
        .collect();
    counts.sort_unstable();
    // outcome: 1 scalar. fills: 1 length + 2 scalars, one differs. trades: 1 length.
    assert_eq!(
        counts,
        vec![
            ("fills", 3, 2, 1),
            ("outcome", 1, 1, 0),
            ("trades", 1, 1, 0)
        ]
    );
    assert_eq!(comparison.expected(), 5);
    assert_eq!(comparison.matched(), 4);
    assert!(!comparison.is_match());
    assert_eq!(count_expected(&expected), 5);
}

#[test]
fn unmatched_checks_include_everything_below_a_missing_part() {
    let expected = json!({
        "fills": [{"price": "1"}, {"price": "2"}],
        "signals": [{"session": "2026-01-08", "decision": "ENTER", "rank": "1"}],
    });
    let actual = json!({"fills": [{"price": "1"}], "signals": []});
    let comparison = compare_detailed(&expected, &actual);
    // fills: length + 2 scalars = 3, nothing matched because the length differs.
    // signals: three scalars of one record, none matched.
    let fills = comparison
        .sections
        .iter()
        .find(|s| s.section == "fills")
        .expect("fills");
    assert_eq!(
        (fills.expected, fills.matched, fills.differences),
        (3, 0, 1)
    );
    let signals = comparison
        .sections
        .iter()
        .find(|s| s.section == "signals")
        .expect("signals");
    assert_eq!(
        (signals.expected, signals.matched, signals.differences),
        (3, 0, 1)
    );
    assert_eq!(comparison.expected() - comparison.matched(), 6);
}

#[test]
fn an_empty_expectation_matches_anything_and_counts_nothing() {
    let comparison = compare_detailed(&json!({}), &json!({"fills": [1, 2, 3]}));
    assert!(comparison.is_match());
    assert_eq!(comparison.expected(), 0);
    assert_eq!(comparison.matched(), 0);
    assert!(comparison.sections.is_empty());
}

#[test]
fn compare_detailed_and_compare_agree() {
    let expected = json!({"fills": [{"price": "1"}], "final": {"equity": "9"}});
    let actual = json!({"fills": [{"price": "2"}], "final": {"equity": "9.00"}});
    assert_eq!(
        compare(&expected, &actual),
        compare_detailed(&expected, &actual).mismatches
    );
}

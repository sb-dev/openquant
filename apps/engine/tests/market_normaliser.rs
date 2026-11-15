//! The normaliser against the independent oracle (`fixtures/market-data/oracle/oracle.py`).
//!
//! Every `N-*` case must give exactly the manifest, digest and scales that the oracle derived by
//! hand-checked rules and the tz database. Every `B-*` case must block the profile with the typed
//! reason the derivation note states. The other tests change one input of a committed case and
//! pin the rule at its boundary.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

mod market_support;

use market_support::{
    Case, assert_no_float, directory_case_ids, fixtures, indexed_case_ids, rules_path, run_case,
};
use openquant_contracts::canonical::digest_bytes;
use openquant_engine::market::{normalise, retrieve::RetrieveError};
use serde_json::{Value, json};

/// SHA-256 of `src/market/rules.txt`, computed with `sha256sum` when the rules were reviewed. A
/// change to the rule text changes the transformation identity of every manifest.
const RULES_SHA256: &str =
    "sha256:6572ba391c9c0c19c6a556a8df02829f3236c737045d70de532871839cf85113";

case_tests! {
    n01_split => "N-01-split",
    n02_cash_dividend => "N-02-cash-dividend",
    n03_holiday => "N-03-holiday",
    n04_early_close => "N-04-early-close",
    n05_dst_spring => "N-05-dst-spring",
    n06_dst_autumn => "N-06-dst-autumn",
    n07_unscheduled_closure_listed => "N-07-unscheduled-closure-listed",
    n08_unscheduled_closure_omitted => "N-08-unscheduled-closure-omitted",
    n09_pages => "N-09-pages",
    n10_empty => "N-10-empty",
    n11_payable_after_end => "N-11-payable-after-end",
    n12_price_scale_3 => "N-12-price-scale-3",
    n13_special_dividend => "N-13-special-dividend",
    n14_ratios_and_ids => "N-14-ratios-and-ids",
    n15_identical_duplicate => "N-15-identical-duplicate",
    n16_end_age => "N-16-end-age",
    b01_dividend_field_missing => "B-01-dividend-field-missing",
    b02_dividend_declared_on_ex_date => "B-02-dividend-declared-on-ex-date",
    b03_split_declared_after_ex_date => "B-03-split-declared-after-ex-date",
    b04_payable_not_session => "B-04-payable-not-session",
    b05_price_scale_5 => "B-05-price-scale-5",
    b06_unsupported_action_type => "B-06-unsupported-action-type",
    b07_instrument_mismatch => "B-07-instrument-mismatch",
    b08_conflicting_duplicate_bar => "B-08-conflicting-duplicate-bar",
    b09_split_ratio_unrepresentable => "B-09-split-ratio-unrepresentable",
    b10_bar_on_non_session => "B-10-bar-on-non-session",
    b11_bar_not_at_session_start => "B-11-bar-not-at-session-start",
    b12_payable_before_ex_date => "B-12-payable-before-ex-date",
    b13_dividend_amount_precision => "B-13-dividend-amount-precision",
    b14_split_field_missing => "B-14-split-field-missing",
    b15_ex_date_not_session => "B-15-ex-date-not-session",
}

fn snapshot(case: &Case) -> Value {
    run_case(case)
        .result
        .unwrap_or_else(|e| panic!("{}: {e}", case.id))
        .manifest
}

fn blocked(case: &Case) -> (String, String) {
    match run_case(case).result {
        Err(RetrieveError::Blocked(block)) => (block.code().to_owned(), block.subject()),
        other => panic!(
            "{}: expected a block, got {:?}",
            case.id,
            other.map(|s| s.digest)
        ),
    }
}

#[test]
fn the_index_lists_exactly_the_case_directories() {
    let indexed = indexed_case_ids();
    let mut sorted = indexed.clone();
    sorted.sort();
    assert_eq!(
        sorted,
        directory_case_ids(),
        "index.json and the directories agree"
    );
    assert_eq!(indexed.len(), 47, "the committed fixture set has 47 cases");
    let mut unique = sorted.clone();
    unique.dedup();
    assert_eq!(unique, sorted, "no case id repeats");
}

#[test]
fn every_expected_file_is_bound_to_the_oracle_that_derived_it() {
    let oracle = std::fs::read(fixtures().join("oracle/oracle.py")).unwrap();
    let hash = digest_bytes(&oracle);
    for id in indexed_case_ids() {
        let case = Case::load(&id);
        assert_eq!(
            case.expected["origin"]["oracle_sha256"].as_str().unwrap(),
            hash,
            "{id}: the oracle changed after this expectation was derived; regenerate and review the diff"
        );
        assert_eq!(case.expected["origin"]["kind"], "oracle", "{id}");
    }
}

#[test]
fn every_case_is_covered_by_a_test_in_this_suite() {
    // The macro above names each N and B case; the E cases are named in market_adapter.rs. A case
    // that no test runs would pass silently, so the two lists are checked against the index.
    let covered = [
        "N-01", "N-02", "N-03", "N-04", "N-05", "N-06", "N-07", "N-08", "N-09", "N-10", "N-11",
        "N-12", "N-13", "N-14", "N-15", "N-16", "B-01", "B-02", "B-03", "B-04", "B-05", "B-06",
        "B-07", "B-08", "B-09", "B-10", "B-11", "B-12", "B-13", "B-14", "B-15",
    ];
    let here: Vec<String> = indexed_case_ids()
        .into_iter()
        .filter(|id| id.starts_with("N-") || id.starts_with("B-"))
        .collect();
    assert_eq!(here.len(), covered.len());
    for (id, prefix) in here.iter().zip(covered) {
        assert!(id.starts_with(prefix), "{id} is not {prefix}");
    }
}

#[test]
fn the_rule_text_is_pinned_and_is_the_transformation_identity() {
    let text = std::fs::read(rules_path()).unwrap();
    assert_eq!(digest_bytes(&text), RULES_SHA256);
    assert_eq!(normalise::rules_digest(), RULES_SHA256);
    assert_eq!(normalise::RULES.as_bytes(), text.as_slice());
    let manifest = snapshot(&Case::load("N-02-cash-dividend"));
    assert_eq!(manifest["source"]["transformation"]["digest"], RULES_SHA256);
    assert_eq!(
        manifest["source"]["transformation"]["name"],
        "alpaca-daily-normaliser"
    );
    assert_eq!(manifest["source"]["transformation"]["version"], "1");
}

#[test]
fn a_correction_is_a_new_version_and_a_new_digest() {
    let case = Case::load("N-03-holiday");
    let before = run_case(&case).result.unwrap();
    // The same retrieval with one close price corrected by the provider.
    let mut corrected = case.clone();
    let body = corrected
        .body(2)
        .replacen("\"c\":100.50", "\"c\":100.55", 1);
    assert_ne!(body, corrected.body(2), "the replacement found the price");
    corrected.replace_body(2, &body);
    corrected.without_expectations();
    let after = run_case(&corrected).result.unwrap();
    assert_ne!(
        before.manifest["dataset"]["version"],
        after.manifest["dataset"]["version"]
    );
    assert_ne!(before.digest, after.digest);
    assert_eq!(
        before.manifest["dataset"]["id"],
        after.manifest["dataset"]["id"]
    );
    // The version is `c` and 16 hex characters of the content digest.
    let version = after.manifest["dataset"]["version"].as_str().unwrap();
    assert_eq!(version.len(), 17);
    assert!(version.starts_with('c') && version[1..].bytes().all(|b| b.is_ascii_hexdigit()));
}

#[test]
fn the_manifest_never_holds_a_float_or_an_exponent() {
    for id in ["N-12-price-scale-3", "N-02-cash-dividend", "N-09-pages"] {
        let manifest = snapshot(&Case::load(id));
        assert_no_float(&manifest);
        for bar in manifest["content"]["bars"].as_array().unwrap() {
            for field in ["open", "high", "low", "close", "volume"] {
                let text = bar[field].as_str().unwrap();
                assert!(!text.contains(['e', 'E', '+']), "{id}: {text}");
                assert!(
                    !(text.contains('.') && text.ends_with('0')),
                    "{id}: {text} has a trailing zero"
                );
            }
        }
    }
}

#[test]
fn a_bar_after_the_information_cutoff_is_kept() {
    // The request is made at 21:10Z and the information cutoff is that instant, but the Friday bar
    // becomes available at 23:00Z. The normaliser keeps it: the core decides FUTURE_DATA.
    let case = Case::load("N-16-end-age");
    assert_eq!(case.request["information_cutoff"], "2026-11-13T21:10:00Z");
    let manifest = snapshot(&case);
    let last = manifest["content"]["bars"]
        .as_array()
        .unwrap()
        .last()
        .unwrap()
        .clone();
    assert_eq!(last["session"], "2026-11-13");
    assert_eq!(last["available_at"], "2026-11-13T23:00:00Z");
}

#[test]
fn availability_needs_a_declaration_strictly_before_the_ex_date_on_both_sides_of_the_boundary() {
    // B-02 declares on the ex-date and B-03 after it: both block. One day before passes.
    let mut case = Case::load("B-02-dividend-declared-on-ex-date");
    case.without_expectations();
    let body = case.body(3);
    assert!(body.contains("\"declaration_date\":\"2024-03-08\""));
    for (declared, ok) in [
        ("2024-03-07", true),
        ("2024-03-08", false),
        ("2024-03-09", false),
        ("2024-01-02", true),
    ] {
        let mut changed = case.clone();
        changed.replace_body(
            3,
            &body.replace(
                "\"declaration_date\":\"2024-03-08\"",
                &format!("\"declaration_date\":\"{declared}\""),
            ),
        );
        let run = run_case(&changed);
        assert_eq!(run.result.is_ok(), ok, "declared {declared}");
        if let Ok(snapshot) = run.result {
            // The availability stays the ex-date open whatever the declaration date was.
            assert_eq!(
                snapshot.manifest["content"]["corporate_actions"][0]["available_at"],
                "2024-03-08T14:30:00Z"
            );
            assert_eq!(
                snapshot.manifest["content"]["action_evidence"][0]["provider_value"],
                declared
            );
        }
    }
}

#[test]
fn an_unreadable_declaration_date_is_not_evidence() {
    let mut case = Case::load("B-02-dividend-declared-on-ex-date");
    case.without_expectations();
    let body = case.body(3);
    for text in [
        "\"declaration_date\":\"2024-3-7\"",
        "\"declaration_date\":\"7 March 2024\"",
        "\"declaration_date\":null",
        "\"declaration_date\":20240307",
    ] {
        let mut changed = case.clone();
        changed.replace_body(
            3,
            &body.replace("\"declaration_date\":\"2024-03-08\"", text),
        );
        assert_eq!(
            blocked(&changed),
            (
                "ACTION_NOT_EVIDENCED".to_owned(),
                "div-synth-2024-03-08".to_owned()
            ),
            "{text}"
        );
    }
}

#[test]
fn the_payable_date_may_equal_the_ex_date_but_not_precede_it() {
    let mut case = Case::load("B-12-payable-before-ex-date");
    case.without_expectations();
    let body = case.body(3);
    let with = |payable: &str| {
        body.replace(
            "\"payable_date\":\"2024-03-07\"",
            &format!("\"payable_date\":\"{payable}\""),
        )
    };
    let mut same_day = case.clone();
    same_day.replace_body(3, &with("2024-03-08"));
    let manifest = snapshot(&same_day);
    assert_eq!(
        manifest["content"]["corporate_actions"][0]["payment_session"],
        "2024-03-08"
    );
    let mut next_week = case.clone();
    next_week.replace_body(3, &with("2024-03-12"));
    assert_eq!(
        snapshot(&next_week)["content"]["corporate_actions"][0]["payment_session"],
        "2024-03-12"
    );
    assert_eq!(blocked(&case).0, "PAYABLE_BEFORE_EX_DATE");
}

#[test]
fn a_missing_payable_date_blocks_a_regular_dividend_but_not_a_special_one() {
    let mut case = Case::load("N-13-special-dividend");
    case.without_expectations();
    let body = case.body(3);
    let without = body.replace(",\"payable_date\":\"2024-06-12\"", "");
    assert_ne!(body, without);
    let mut special = case.clone();
    special.replace_body(3, &without);
    assert_eq!(
        snapshot(&special)["content"]["corporate_actions"][0]["kind"],
        "SPECIAL_DISTRIBUTION"
    );
    let mut regular = case.clone();
    regular.replace_body(3, &without.replace("\"special\":true", "\"special\":false"));
    assert_eq!(blocked(&regular).0, "PAYABLE_DATE_NOT_SESSION");
    // The foreign flag alone also makes the action unsupported, and it is kept.
    let mut foreign = case.clone();
    foreign.replace_body(
        3,
        &body.replace(
            "\"special\":true,\"foreign\":false",
            "\"special\":false,\"foreign\":true",
        ),
    );
    assert_eq!(
        snapshot(&foreign)["content"]["corporate_actions"][0]["kind"],
        "SPECIAL_DISTRIBUTION"
    );
}

#[test]
fn the_price_scale_is_the_smallest_that_holds_every_price() {
    let base = Case::load("N-03-holiday");
    let bars = base.body(2);
    // Whole-number prices need scale 0 (money scale 2); one cent needs 2; 4 digits is the limit.
    let bar = |price: &str| bars.replacen("\"o\":100.00", &format!("\"o\":{price}"), 1);
    for (price, scale, money, evidence) in [
        ("100", 2, 2, false),
        ("100.5", 2, 2, false),
        ("100.05", 2, 2, false),
        ("100.001", 3, 3, true),
        ("100.0001", 4, 4, true),
    ] {
        let mut case = base.clone();
        case.without_expectations();
        case.replace_body(2, &bar(price));
        let snapshot = run_case(&case).result.unwrap();
        assert_eq!(
            (
                snapshot.price_scale,
                snapshot.money_scale,
                snapshot.overflow_evidence_required
            ),
            (scale, money, evidence),
            "price {price}"
        );
    }
    let mut over = base.clone();
    over.without_expectations();
    over.replace_body(2, &bar("100.00001"));
    assert_eq!(
        blocked(&over),
        ("PRICE_SCALE_ABOVE_LIMIT".to_owned(), "5".to_owned())
    );
}

#[test]
fn bars_that_the_core_would_reject_block_the_profile() {
    let base = Case::load("N-03-holiday");
    let bars = base.body(2);
    let check = |from: &str, to: &str, code: &str| {
        let mut case = base.clone();
        case.without_expectations();
        let changed = bars.replacen(from, to, 1);
        assert_ne!(changed, bars, "{from} was found");
        case.replace_body(2, &changed);
        assert_eq!(blocked(&case).0, code, "{to}");
    };
    // The first bar is 100.00 / 101.50 / 98.75 / 100.50, volume 1000000.
    check("\"o\":100.00", "\"o\":0", "INVALID_BAR");
    check("\"o\":100.00", "\"o\":-1", "INVALID_BAR");
    check("\"o\":100.00", "\"o\":1000000000.01", "INVALID_BAR");
    check("\"h\":101.50", "\"h\":100.25", "INVALID_BAR");
    check("\"l\":98.75", "\"l\":100.25", "INVALID_BAR");
    check("\"v\":1000000", "\"v\":1000000.5", "INVALID_BAR");
    check("\"v\":1000000", "\"v\":-1", "INVALID_BAR");
    check("\"v\":1000000", "\"v\":1000000000000001", "INVALID_BAR");
}

#[test]
fn the_calendar_is_never_longer_than_the_requested_range_and_its_payment_session() {
    let manifest = snapshot(&Case::load("N-11-payable-after-end"));
    let sessions: Vec<&str> = manifest["content"]["calendar"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s["session"].as_str().unwrap())
        .collect();
    assert_eq!(sessions.first(), Some(&"2024-12-02"));
    assert_eq!(sessions.last(), Some(&"2024-12-16"));
    assert!(
        !sessions.contains(&"2024-12-25"),
        "the provider calendar ran further and was trimmed"
    );
    // The missing sessions and the returned range stay inside the requested range.
    assert_eq!(
        manifest["coverage"]["requested"],
        json!({"start": "2024-12-02", "end": "2024-12-13"})
    );
    assert_eq!(
        manifest["coverage"]["returned"],
        json!({"start": "2024-12-02", "end": "2024-12-13"})
    );
}

#[test]
fn constraints_decide_whether_source_bodies_are_listed_as_stored() {
    let mut case = Case::load("N-02-cash-dividend");
    let kept = snapshot(&case);
    assert!(
        kept["source_responses"]
            .as_array()
            .unwrap()
            .iter()
            .all(|r| r.get("stored").is_some())
    );
    assert_eq!(kept["constraints"]["raw_retention"], "RETAIN");
    case.host["constraints"]["retain_raw"] = json!(false);
    case.host["constraints"]["redistribution_permitted"] = json!(true);
    let dropped = snapshot(&case);
    assert!(
        dropped["source_responses"]
            .as_array()
            .unwrap()
            .iter()
            .all(|r| r.get("stored").is_none())
    );
    assert_eq!(dropped["constraints"]["raw_retention"], "DO_NOT_RETAIN");
    assert_eq!(dropped["constraints"]["redistribution"], "PERMITTED");
    // The digest of every response is listed in both cases.
    assert_eq!(
        kept["source_responses"][0]["content_digest"],
        dropped["source_responses"][0]["content_digest"]
    );
}

#[test]
fn the_feed_is_the_profile_choice_and_the_manifest_records_it() {
    let mut case = Case::load("N-02-cash-dividend");
    case.without_expectations();
    case.request["semantics"]["feed"] = json!("IEX");
    let run = run_case(&case);
    assert_eq!(run.seen[2].request.query_value("feed"), Some("iex"));
    let manifest = run.result.unwrap().manifest;
    assert_eq!(manifest["source"]["feed"], "IEX");
    assert_eq!(manifest["semantics"]["feed"], "IEX");
    assert_eq!(
        manifest["dataset"]["id"],
        "alpaca-synth-1day-raw-iex-20250203-20250214"
    );
}

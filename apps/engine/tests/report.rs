//! Tests of the local report, the deterministic index and the failure list.
//!
//! The expected strings below come from the independent derivations of the fixtures (for X-01:
//! cap 1000.00, 19 shares at 50.00, fee 1.95, cash 4048.05, equity 4998.05), not from the
//! engine. They pin how the harness presents those numbers.

mod common;

use std::fs;

use common::{fresh_dir, header, load};
use openquant_contracts::digest_bytes;
use openquant_engine::{
    coverage::S0_ROWS,
    replay::{CaseReport, RestoreCheck, run_case, run_cases},
    report::{
        CASE_SECTIONS, REPORT_SECTIONS, format_failures, index_text, render_index, render_report,
        write_outputs,
    },
};
use serde_json::{Value, json};

fn run(id: &str) -> CaseReport {
    run_case(&load(id))
}

/// Run a committed case after changing its expectation, to produce a controlled difference.
fn broken(id: &str, change: impl FnOnce(&mut Value)) -> CaseReport {
    let mut case = load(id);
    change(&mut case.expected["expect"]);
    run_case(&case)
}

fn assert_in_order(text: &str, headings: &[&str]) {
    let mut from = 0;
    for heading in headings {
        let line = format!("\n{heading}");
        let at = text[from..]
            .find(&line)
            .unwrap_or_else(|| panic!("heading {heading:?} is missing or out of order"));
        from += at + line.len();
    }
}

#[test]
fn the_report_renders_every_required_section_for_every_kind_of_case() {
    // A completed run, a run that stops with INSUFFICIENT, a case rejected by the validator
    // after both documents parsed, and a case whose document does not parse.
    for id in ["X-01", "I-02", "I-04a", "I-05a"] {
        let report = run(id);
        let text = render_report(&header(), &[report]);
        let mut headings: Vec<&str> =
            vec![REPORT_SECTIONS[0], REPORT_SECTIONS[1], REPORT_SECTIONS[2]];
        headings.extend(CASE_SECTIONS);
        headings.push(REPORT_SECTIONS[3]);
        // The case heading sits between the coverage table and the first case section.
        assert!(text.contains(&format!("\n## {id} ")), "{id}: case heading");
        assert_in_order(&format!("\n{text}"), &headings);
    }
}

#[test]
fn the_report_exposes_signals_fills_trades_cash_and_positions() {
    let report = run("X-01");
    assert!(report.passed, "X-01 is a prerequisite of this test");
    let text = render_report(&header(), &[report]);
    // Signals: the entry signal and the last-session skip.
    assert!(text.contains("| 2026-01-09 | TRUE | ENTER |  | 1.0000 | sma3=50.3333, atr3=2.0000 |"));
    assert!(text.contains("| 2026-01-14 | FALSE | SKIPPED | NO_NEXT_SESSION |"));
    // Entry intent: cap, quantity, price and fee.
    assert!(text.contains(
        "| I-2026-01-09-SYN | 2026-01-09 | 1 | 1000.00 | FILLED |  | 19 | 50.00 | 1.95 |"
    ));
    // Fill at the next open, never at the signal close.
    assert!(text.contains(
        "| 2 | 2026-01-12 | OPEN | BUY | 19 | 50.00 | 950.00 | 1.95 | -951.95 | ENTRY |"
    ));
    // Trade left open at the end.
    assert!(
        text.contains("| T-2026-01-12-SYN | 2026-01-12 |  | 19 | 50.00 |  | OPEN_AT_END | false |")
    );
    // Cash ledger: reserve, release, fill.
    assert!(text.contains(
        "| 0 | 2026-01-09 | AFTER_CLOSE | RESERVE | 1000.00 | 4000.00 | 1000.00 | 0.00 |"
    ));
    assert!(text.contains("| 1 | 2026-01-12 | OPEN | RELEASE | 1000.00 | 5000.00 | 0.00 | 0.00 |"));
    assert!(text.contains("| 3 | 2026-01-12 | OPEN | FILL_BUY | 951.95 | 4048.05 | 0.00 | 0.00 |"));
    // Daily cash, positions and equity.
    assert!(text.contains(
        "| 2026-01-12 | 4048.05 | 0.00 | 0.00 | 950.00 | 4998.05 | 19 sh @ 50 (stop 46, target 60, entry_atr=2) |"
    ));
    // Final state.
    assert!(text.contains(
        "available 4048.05, reserved 0.00, receivables 0.00, positions value 950.00, equity 4998.05"
    ));
    assert!(
        text.contains("Open positions at the end: 19 sh @ 50 (stop 46, target 60, entry_atr=2)")
    );
}

#[test]
fn the_report_states_identities_and_the_determinism_and_restore_results() {
    let report = run("X-01");
    let (strategy, input, engine_digest) = (
        report.strategy_hash.clone().expect("strategy hash"),
        report.input_hash.clone().expect("input hash"),
        report.engine_digest.clone().expect("engine digest"),
    );
    let digest = digest_bytes(report.result_text.as_deref().expect("result").as_bytes());
    let restore = report
        .restore
        .clone()
        .expect("X-01 asks for restore from every cut");
    // Eight sessions with four events each, plus the cut before the first event.
    assert_eq!(restore.cuts, 33);
    let text = render_report(&header(), &[report]);
    for identity in [strategy, input, engine_digest, digest] {
        assert!(identity.starts_with("sha256:"));
        assert!(
            text.contains(&format!("`{identity}`")),
            "{identity} is shown"
        );
    }
    assert!(text.contains("- engine: openquant-core 0.0.0, digest `sha256:"));
    assert!(text.contains("- expected values: oracle: `oracle.py` sha256 `"));
    assert!(
        text.contains("- repeat evaluation from freshly parsed documents is byte-identical: yes")
    );
    assert!(text.contains(
        "- result against the evaluation-result schema: valid and unchanged by a parse and serialise round trip"
    ));
    assert!(text.contains(
        "- restore from every cut point: all 33 cut points restore to a state identical"
    ));
}

#[test]
fn the_summary_shows_each_cases_covered_rows_and_check_counts() {
    let reports = [run("X-01"), run("I-02")];
    let text = render_report(&header(), &reports);
    let x01 = format!(
        "{}/{}",
        reports[0].matched_fields, reports[0].expected_fields
    );
    assert!(text.contains(&format!(
        "| X-01 | Next-open entry: cap 1000, fee 1.00 + 10 bps, 19 shares, cash 4048.05 | Cash and quantities; Entry and exit phases | COMPLETED | {x01} |"
    )));
    assert!(text.contains("| I-02 | "));
    assert!(text.contains(
        "| Invalid inputs; Unplanned non-trading events | INSUFFICIENT MISSING_REQUIRED_BAR |"
    ));
    assert!(text.contains("- cases: 2, passed: 2, failed: 0"));
}

#[test]
fn the_row_coverage_table_marks_covered_failing_and_uncovered_rows() {
    let passing = [run("X-01"), run("I-02")];
    let text = render_report(&header(), &passing);
    for row in S0_ROWS {
        assert!(text.contains(&format!("| {row} | ")), "{row} has a row");
    }
    assert!(text.contains("| Cash and quantities | X-01 | 1 | 0 | covered |"));
    assert!(text.contains("| Unplanned non-trading events | I-02 | 1 | 0 | covered |"));
    assert!(text.contains("| Local replay | none | 0 | 0 | NOT COVERED |"));

    let failing = [broken("X-01", |expect| {
        expect["fills"][0]["price"] = json!("51.00");
    })];
    let text = render_report(&header(), &failing);
    assert!(text.contains("| Cash and quantities | X-01 | 0 | 1 | FAILING |"));
}

#[test]
fn a_partial_run_and_coverage_problems_are_stated() {
    let mut head = header();
    head.filter = Some("X-01".to_owned());
    head.coverage_problems =
        vec!["S0 row \"Local replay\" lists no case in coverage.json".to_owned()];
    let text = render_report(&head, &[run("X-01")]);
    assert!(text.contains("Only case `X-01` ran"));
    assert!(text.contains("### Coverage problems"));
    assert!(text.contains("- S0 row \"Local replay\" lists no case in coverage.json"));
    let text = render_report(&header(), &[run("X-01")]);
    assert!(!text.contains("Only case"));
    assert!(!text.contains("### Coverage problems"));
}

#[test]
fn a_failing_case_lists_expected_versus_actual_with_counts() {
    let report = broken("X-01", |expect| {
        expect["fills"][0]["price"] = json!("51.00");
    });
    assert!(!report.passed);
    assert_eq!(report.mismatches.len(), 1);
    let fills = report
        .sections
        .iter()
        .find(|s| s.section == "fills")
        .expect("fills section");
    assert_eq!((fills.matched, fills.differences), (fills.expected - 1, 1));
    let text = render_report(&header(), std::slice::from_ref(&report));
    assert!(text.contains("## X-01 — Next-open entry"));
    assert!(text.contains("[FAIL]"));
    assert!(text.contains("- **failing cases: X-01**"));
    assert!(text.contains("- cases: 1, passed: 0, failed: 1"));
    assert!(text.contains("| /fills/0/price | \"51.00\" | \"50.00\" |"));
    assert!(text.contains(&format!(
        "| fills | {} | {} | 1 |",
        fills.expected, fills.matched
    )));
    assert!(text.contains(&format!(
        "| **total** | **{}** | **{}** | **1** |",
        report.expected_fields, report.matched_fields
    )));
    assert_eq!(report.matched_fields + 1, report.expected_fields);
}

#[test]
fn a_passing_case_states_that_all_checks_match() {
    let report = run("X-01");
    let text = render_report(&header(), std::slice::from_ref(&report));
    assert!(text.contains(&format!(
        "All {} expected checks match the actual values.",
        report.expected_fields
    )));
    assert!(text.contains("## X-01 — Next-open entry"));
    assert!(text.contains("[PASS]"));
    assert!(!text.contains("failing cases"));
}

#[test]
fn table_cells_escape_pipes_and_stay_short() {
    let mut case = load("X-01");
    case.file.title = "A|B".to_owned();
    case.expected["expect"]["fills"][0]["side"] = json!("x|y");
    case.expected["expect"]["fills"][0]["reason"] = json!("z".repeat(2000));
    let report = run_case(&case);
    assert_eq!(report.mismatches.len(), 2);
    let text = render_report(&header(), std::slice::from_ref(&report));
    assert!(text.contains("| X-01 | A\\|B |"));
    assert!(text.contains("| /fills/0/side | \"x\\|y\" | \"BUY\" |"));
    assert!(
        text.contains("zzz..."),
        "a long value is cut with an ellipsis"
    );
    assert!(!text.contains(&"z".repeat(1000)));
    // The data keeps the full value.
    let long = report
        .mismatches
        .iter()
        .find(|m| m.path == "/fills/0/reason")
        .expect("reason");
    assert_eq!(long.expected.len(), 2002);
}

#[test]
fn a_case_rejected_after_parsing_still_has_identities_and_a_zero_state_result() {
    let report = run("I-04a");
    assert!(report.passed);
    assert!(!report.started);
    assert!(report.result_text.is_some(), "the shared result exists");
    assert!(report.strategy_hash.is_some() && report.input_hash.is_some());
    assert_eq!(report.outcome["status"], "FAILED");
    assert_eq!(report.outcome["code"], "UNSUPPORTED_OPERATOR");
    let text = render_report(&header(), &[report]);
    assert!(text.contains("Rejected before evaluation"));
    assert!(text.contains("- outcome: FAILED UNSUPPORTED_OPERATOR: "));
    assert!(text.contains("- restore from every cut point: not requested"));
    assert!(
        text.contains(
            "- repeat evaluation from freshly parsed documents is byte-identical: not run"
        )
    );
    assert!(text.contains(
        "available 0.00, reserved 0.00, receivables 0.00, positions value 0.00, equity 0.00"
    ));
}

#[test]
fn a_case_whose_document_does_not_parse_has_an_outcome_but_no_result() {
    let mut case = load("X-01");
    case.input_text = "{ not json".to_owned();
    case.expected["expect"] = json!({"outcome": {"status": "FAILED"}});
    let report = run_case(&case);
    assert!(!report.started);
    assert!(report.result_text.is_none() && report.strategy_hash.is_none());
    assert_eq!(report.outcome["status"], "FAILED");
    assert!(report.passed, "the expected outcome status is FAILED");
    let text = render_report(&header(), &[report]);
    assert!(text.contains("- strategy artefact: `n/a`"));
    assert!(text.contains("- result digest: `n/a`"));
}

#[test]
fn restore_and_repeat_failures_fail_the_case_and_are_reported() {
    let mut report = run("X-01");
    report.restore = Some(RestoreCheck {
        cuts: 33,
        deep: 33,
        first_mismatch: Some(7),
        detail: Some("cut before 2026-01-08/OPEN: the restored state differs".to_owned()),
    });
    report.repeat_identical = Some(false);
    report.result_schema = Some(Err("decimal out of grammar".to_owned()));
    report.passed = false;
    let text = render_report(&header(), std::slice::from_ref(&report));
    assert!(text.contains(
        "MISMATCH at cut 7 of 33: cut before 2026-01-08/OPEN: the restored state differs"
    ));
    assert!(text.contains("byte-identical: NO"));
    assert!(text.contains("INVALID: decimal out of grammar"));
    assert!(text.contains("FAIL at cut 7"));
    let failures = format_failures(&[report], "fixtures/s0", 0);
    assert!(failures.contains(
        "FAIL X-01 (fixtures/s0/cases/X-01/expected.json): 0 difference(s) from the expectation"
    ));
    assert!(failures.contains("repeat evaluation: not byte-identical"));
    assert!(failures.contains("result schema: decimal out of grammar"));
    assert!(failures.contains("restore: cut before 2026-01-08/OPEN: the restored state differs"));
}

#[test]
fn the_failure_list_names_case_path_expected_and_actual() {
    let report = broken("X-01", |expect| {
        expect["fills"][0]["price"] = json!("51.00");
    });
    let text = format_failures(&[report], "fixtures/s0", 0);
    assert!(text.contains(
        "FAIL X-01 (fixtures/s0/cases/X-01/expected.json): 1 difference(s) from the expectation"
    ));
    assert!(text.contains("  /fills/0/price: expected \"51.00\", actual \"50.00\""));
    assert!(format_failures(&[run("X-01")], "fixtures/s0", 0).is_empty());
}

#[test]
fn the_failure_list_can_be_limited_per_case() {
    let report = broken("X-01", |expect| {
        for index in 2..6 {
            expect["daily"][index]["equity"] = json!("1.00");
        }
    });
    assert_eq!(report.mismatches.len(), 4);
    let limited = format_failures(std::slice::from_ref(&report), "fixtures/s0", 2);
    assert!(limited.contains("4 difference(s) from the expectation"));
    assert!(limited.contains("/daily/2/equity"));
    assert!(limited.contains("/daily/3/equity"));
    assert!(!limited.contains("/daily/4/equity"));
    assert!(limited.contains("... 2 more in the report"));
    let all = format_failures(&[report], "fixtures/s0", 0);
    assert!(all.contains("/daily/5/equity") && !all.contains("more in the report"));
}

#[test]
fn the_report_is_deterministic_for_a_fixed_header() {
    let first = render_report(&header(), &[run("X-01"), run("I-04a")]);
    let second = render_report(&header(), &[run("X-01"), run("I-04a")]);
    assert_eq!(first, second);
}

#[test]
fn the_index_is_deterministic_and_holds_no_clock_or_path() {
    let reports = [run("X-01"), run("I-04a"), run("I-05a"), run("I-02")];
    let again = [run("X-01"), run("I-04a"), run("I-05a"), run("I-02")];
    let (first, second) = (index_text(&reports), index_text(&again));
    assert_eq!(first, second, "two evaluations give the same index bytes");
    assert!(first.ends_with("}\n"));

    let index = render_index(&reports);
    assert_eq!(index["schema"], "s0-replay-index/1");
    let object = index.as_object().expect("object");
    assert_eq!(object.len(), 2, "only the schema tag and the cases");
    let cases = index["cases"].as_array().expect("cases");
    assert_eq!(cases.len(), 4);
    for (entry, report) in cases.iter().zip(&reports) {
        let keys: Vec<&str> = entry
            .as_object()
            .expect("entry")
            .keys()
            .map(String::as_str)
            .collect();
        let mut sorted = keys.clone();
        sorted.sort_unstable();
        assert_eq!(sorted, ["case", "outcome", "passed", "result_digest"]);
        assert_eq!(entry["case"], report.id);
        assert_eq!(entry["passed"], report.passed);
        assert_eq!(entry["outcome"], report.outcome["status"]);
        let expected_digest = report
            .result_text
            .as_ref()
            .map(|text| digest_bytes(text.as_bytes()));
        match expected_digest {
            Some(digest) => assert_eq!(entry["result_digest"], digest),
            None => assert!(
                entry["result_digest"].is_null(),
                "{}: no result, no digest",
                report.id
            ),
        }
    }
    // No path separator anywhere except in the schema tag, and no time stamp, revision or
    // working directory.
    let stripped = first.replace("s0-replay-index/1", "");
    assert!(!stripped.contains('/') && !stripped.contains('\\'));
    for forbidden in [
        env!("CARGO_MANIFEST_DIR"),
        "home",
        "tmp",
        "REVISION-MARKER",
        "COMMAND-MARKER",
        "TOOLCHAIN-MARKER",
    ] {
        assert!(
            !first.contains(forbidden),
            "the index must not contain {forbidden:?}"
        );
    }
    assert!(!first.contains(":00") && !first.contains("T0") && !first.contains("UTC"));
}

#[test]
fn header_values_appear_in_the_report_and_never_in_the_index() {
    let reports = [run("X-01")];
    let report = render_report(&header(), &reports);
    for marker in ["REVISION-MARKER", "COMMAND-MARKER", "TOOLCHAIN-MARKER"] {
        assert!(
            report.contains(marker),
            "{marker} is shown in the report header"
        );
    }
    let index = index_text(&reports);
    for marker in ["REVISION-MARKER", "COMMAND-MARKER", "TOOLCHAIN-MARKER"] {
        assert!(
            !index.contains(marker),
            "{marker} must stay out of the index"
        );
    }
    let mut other = header();
    other.source_revision = "OTHER-REVISION".to_owned();
    assert_ne!(
        report,
        render_report(&other, &reports),
        "the header does reach the report"
    );
}

#[test]
fn write_outputs_writes_report_index_and_results() {
    let out = fresh_dir("report-write");
    let reports = [run("X-01"), run("I-04a"), run("I-05a")];
    write_outputs(&out, &header(), &reports).expect("write");
    assert_eq!(
        fs::read_to_string(out.join("report.md")).expect("report"),
        render_report(&header(), &reports)
    );
    assert_eq!(
        fs::read_to_string(out.join("index.json")).expect("index"),
        index_text(&reports)
    );
    for report in &reports {
        let path = out
            .join("results")
            .join(format!("{}.result.json", report.id));
        match &report.result_text {
            Some(text) => assert_eq!(
                fs::read_to_string(&path).expect("result"),
                format!("{text}\n")
            ),
            None => assert!(
                !path.exists(),
                "{}: no result file without a result",
                report.id
            ),
        }
    }
}

#[test]
fn stale_result_files_are_removed_only_when_all_cases_ran() {
    let out = fresh_dir("report-stale");
    let results = out.join("results");
    fs::create_dir_all(&results).expect("results dir");
    fs::write(results.join("OLD.result.json"), "{}").expect("stale file");
    fs::write(results.join("notes.txt"), "keep").expect("unrelated file");
    let reports = [run("X-01")];

    let mut partial = header();
    partial.filter = Some("X-01".to_owned());
    write_outputs(&out, &partial, &reports).expect("partial write");
    assert!(
        results.join("OLD.result.json").exists(),
        "a partial run keeps other results"
    );

    write_outputs(&out, &header(), &reports).expect("full write");
    assert!(
        !results.join("OLD.result.json").exists(),
        "a full run removes stale results"
    );
    assert!(
        results.join("notes.txt").exists(),
        "files that are not results stay"
    );
    assert!(results.join("X-01.result.json").exists());
}

#[test]
fn limitations_close_the_report() {
    let text = render_report(&header(), &[run("X-01")]);
    let tail = text.rsplit("\n## ").next().expect("last section");
    assert!(tail.starts_with("Remaining limitations"));
    for statement in ["A03–A05", "A11", "S4", "S1", "synthetic policy"] {
        assert!(tail.contains(statement), "limitation about {statement}");
    }
}

#[test]
fn parallel_evaluation_matches_sequential_evaluation_in_order() {
    let ids = [
        "X-09b", "I-05a", "X-01", "I-04a", "F0-smoke", "I-02", "X-02a",
    ];
    let cases: Vec<_> = ids.iter().map(|id| load(id)).collect();
    let parallel = run_cases(&cases);
    assert_eq!(parallel.len(), ids.len());
    for ((report, case), id) in parallel.iter().zip(&cases).zip(ids) {
        let single = run_case(case);
        assert_eq!(report.id, id, "reports keep the order of the cases");
        assert_eq!(report.result_text, single.result_text, "{id}: result bytes");
        assert_eq!(report.passed, single.passed, "{id}: verdict");
        assert_eq!(report.mismatches, single.mismatches, "{id}: differences");
        assert_eq!(
            report.expected_fields, single.expected_fields,
            "{id}: checks"
        );
    }
    assert!(run_cases(&[]).is_empty());
}

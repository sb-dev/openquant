//! Run every committed S0 fixture case through the shared Rust core.
//!
//! Each case carries expected values derived independently of the engine (an exact-rational
//! oracle plus a written derivation). This test loads all of them, runs them, and fails with a
//! list of case, path, expected value and actual value for any difference. It never weakens,
//! skips or regenerates a case. It also checks that every S0 row of OQ-06 section 8 has at least
//! one case, that the expectations state the sections a reader needs, and that two complete
//! runs write byte-identical result files and index.

mod common;

use std::{collections::BTreeSet, fs, sync::OnceLock};

use common::{fixtures, fresh_dir, header, tree};
use openquant_contracts::digest_bytes;
use openquant_core::{
    State,
    model::{FailureCode, status_of},
};
use openquant_engine::{
    case::{Case, load_cases},
    coverage::{S0_ROWS, check_coverage, load_coverage},
    replay::{CaseReport, run_cases},
    report::{CASE_SECTIONS, REPORT_SECTIONS, format_failures, render_report, write_outputs},
};
use serde_json::Value;

const SPEC: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../docs/specs/06-engineering-delivery-and-operations-spec.md"
);

fn cases() -> &'static Vec<Case> {
    static CASES: OnceLock<Vec<Case>> = OnceLock::new();
    CASES.get_or_init(|| load_cases(&fixtures()).expect("every fixture case loads"))
}

fn reports() -> &'static Vec<CaseReport> {
    static REPORTS: OnceLock<Vec<CaseReport>> = OnceLock::new();
    REPORTS.get_or_init(|| run_cases(cases()))
}

fn expect_of(case: &Case) -> &Value {
    &case.expected["expect"]
}

fn status_of_expectation(case: &Case) -> &str {
    expect_of(case)["outcome"]["status"].as_str().unwrap_or("")
}

#[test]
fn every_fixture_case_passes() {
    let reports = reports();
    assert!(!reports.is_empty(), "no fixture case was found");
    assert_eq!(reports.len(), cases().len());
    let failed = reports.iter().filter(|r| !r.passed).count();
    let failures = format_failures(reports, "fixtures/s0", 0);
    assert!(
        failures.is_empty(),
        "{failed} of {} fixture case(s) differ from their independent expectation \
         (case, expectation file, then path: expected, actual):\n{failures}",
        reports.len()
    );
}

#[test]
fn case_ids_are_unique_and_match_their_directories() {
    let mut seen = BTreeSet::new();
    for case in cases() {
        assert!(
            seen.insert(case.file.id.as_str()),
            "case id {} is used twice",
            case.file.id
        );
        assert_eq!(
            case.dir.file_name().and_then(|n| n.to_str()),
            Some(case.file.id.as_str()),
            "the directory of case {} must carry its id",
            case.file.id
        );
        assert_eq!(
            case.expected["case"].as_str(),
            Some(case.file.id.as_str()),
            "{}: expected.json names another case",
            case.file.id
        );
    }
}

/// The S0 rows read from the OQ-06 section 8 acceptance-case table: rows whose delivery scope
/// starts with S0.
fn spec_s0_rows() -> Vec<String> {
    let text = fs::read_to_string(SPEC).expect("read OQ-06");
    let start = text
        .find("### Connected slices and acceptance cases")
        .expect("the acceptance-case table");
    let end = text[start..]
        .find("\n## 9.")
        .map_or(text.len(), |at| start + at);
    text[start..end]
        .lines()
        .filter(|line| line.starts_with('|'))
        .filter_map(|line| {
            let cells: Vec<&str> = line
                .trim()
                .trim_matches('|')
                .split('|')
                .map(str::trim)
                .collect();
            (cells.len() == 4 && cells[3].starts_with("S0")).then(|| cells[0].to_owned())
        })
        .collect()
}

#[test]
fn the_s0_rows_in_the_harness_are_the_s0_rows_of_oq_06() {
    let spec: BTreeSet<String> = spec_s0_rows().into_iter().collect();
    assert_eq!(spec.len(), 11, "OQ-06 section 8 lists eleven S0 rows");
    let harness: BTreeSet<String> = S0_ROWS.iter().map(|r| (*r).to_owned()).collect();
    assert_eq!(
        harness, spec,
        "S0_ROWS must equal the S0 rows of OQ-06 section 8"
    );
}

#[test]
fn every_s0_row_has_at_least_one_case_and_the_coverage_map_agrees() {
    let coverage = load_coverage(&fixtures()).expect("coverage.json");
    let declared: Vec<_> = cases()
        .iter()
        .map(|c| (c.file.id.clone(), c.file.covers.clone()))
        .collect();
    let problems = check_coverage(&coverage, &declared);
    assert!(
        problems.is_empty(),
        "coverage problems:\n{}",
        problems.join("\n")
    );
    for row in spec_s0_rows() {
        let covering: Vec<&str> = cases()
            .iter()
            .filter(|c| c.file.covers.contains(&row))
            .map(|c| c.file.id.as_str())
            .collect();
        assert!(!covering.is_empty(), "S0 row {row:?} has no case");
        let listed = coverage.rows.get(&row).map_or(0, Vec::len);
        assert_eq!(
            covering.len(),
            listed,
            "{row:?}: case.json and coverage.json disagree"
        );
    }
}

#[test]
fn every_case_covering_an_s0_row_passes() {
    let mut problems = Vec::new();
    for row in S0_ROWS {
        let covering: Vec<&CaseReport> = reports()
            .iter()
            .filter(|r| r.covers.iter().any(|c| c == row))
            .collect();
        let failing: Vec<&str> = covering
            .iter()
            .filter(|r| !r.passed)
            .map(|r| r.id.as_str())
            .collect();
        if covering.is_empty() {
            problems.push(format!("S0 row {row:?} has no case"));
        } else if !failing.is_empty() {
            problems.push(format!(
                "S0 row {row:?} is not demonstrated: {} of {} cases fail: {}",
                failing.len(),
                covering.len(),
                failing.join(", ")
            ));
        }
    }
    assert!(problems.is_empty(), "{}", problems.join("\n"));
}

#[test]
fn no_case_is_vacuous() {
    for report in reports() {
        assert!(
            report.expected_fields > 0,
            "{}: the expectation states nothing",
            report.id
        );
        if report.started {
            // A run that processed events must state more than its outcome.
            assert!(
                report.expected_fields > 10,
                "{}: only {} checks for a case that ran",
                report.id,
                report.expected_fields
            );
        }
    }
}

#[test]
fn completed_cases_state_every_required_section() {
    const COMPLETED: [&str; 9] = [
        "outcome",
        "signals",
        "entries",
        "fills",
        "trades",
        "cash_ledger",
        "daily",
        "corporate_actions",
        "final",
    ];
    // A run that fails or is insufficient keeps the journal through the last completed event.
    const PARTIAL: [&str; 7] = [
        "outcome",
        "signals",
        "entries",
        "fills",
        "cash_ledger",
        "daily",
        "corporate_actions",
    ];
    let mut completed = 0;
    for case in cases() {
        let id = &case.file.id;
        let expect = expect_of(case);
        assert!(expect.is_object(), "{id}: expect must be an object");
        let status = status_of_expectation(case);
        assert!(
            ["COMPLETED", "FAILED", "INSUFFICIENT"].contains(&status),
            "{id}: outcome.status is {status:?}"
        );
        if status == "COMPLETED" {
            completed += 1;
            for section in COMPLETED {
                assert!(
                    !expect[section].is_null(),
                    "{id}: a completed case must state {section}"
                );
            }
            assert!(
                expect["signals"].as_array().is_some_and(|s| !s.is_empty()),
                "{id}: no signal is stated"
            );
            assert!(
                expect["daily"].as_array().is_some_and(|d| !d.is_empty()),
                "{id}: no daily record is stated"
            );
            assert!(
                expect["outcome"]["code"].is_null(),
                "{id}: a completed outcome has no code"
            );
            for field in [
                "cash_available",
                "cash_reserved",
                "receivables",
                "positions_value",
                "equity",
                "open_positions",
            ] {
                assert!(
                    !expect["final"][field].is_null(),
                    "{id}: final must state {field}"
                );
            }
        } else {
            let code = expect["outcome"]["code"]
                .as_str()
                .unwrap_or_else(|| panic!("{id}: a {status} case must state the failure code"));
            let parsed: FailureCode = code
                .parse()
                .unwrap_or_else(|_| panic!("{id}: {code:?} is not a failure code"));
            assert_eq!(
                status_of(parsed).to_string(),
                status,
                "{id}: {code} belongs to another status"
            );
            if !expect["signals"].is_null() {
                for section in PARTIAL {
                    assert!(
                        !expect[section].is_null(),
                        "{id}: a partial run must state {section}"
                    );
                }
            }
        }
    }
    assert!(
        completed >= 40,
        "only {completed} completed cases were found"
    );
}

#[test]
fn expected_values_are_bound_to_an_independent_origin() {
    let oracle_dir = fixtures().join("oracle");
    for case in cases() {
        let id = &case.file.id;
        let origin = &case.expected["origin"];
        let kind = origin["kind"]
            .as_str()
            .unwrap_or_else(|| panic!("{id}: origin.kind is missing"));
        assert!(
            !kind.contains("engine") && !kind.contains("actual") && !kind.contains("regenerat"),
            "{id}: origin.kind {kind:?} must not name the engine as the source"
        );
        if kind == "oracle" {
            let script = origin["oracle"]
                .as_str()
                .unwrap_or_else(|| panic!("{id}: origin.oracle"));
            let recorded = origin["oracle_sha256"]
                .as_str()
                .unwrap_or_else(|| panic!("{id}: origin.oracle_sha256"));
            let bytes = fs::read(oracle_dir.join(script))
                .unwrap_or_else(|e| panic!("{id}: oracle {script}: {e}"));
            let actual = digest_bytes(&bytes);
            assert_eq!(
                recorded.trim_start_matches("sha256:"),
                actual.trim_start_matches("sha256:"),
                "{id}: the oracle script changed after the expected values were derived"
            );
        }
        assert!(
            !case.derivation.trim().is_empty(),
            "{id}: derivation.md is empty"
        );
    }
}

#[test]
fn local_replay_cases_restore_from_every_cut_point() {
    let mut checked = 0;
    for (case, report) in cases().iter().zip(reports()) {
        let covers_replay = case.file.covers.iter().any(|c| c == "Local replay");
        if covers_replay {
            assert!(
                case.file.restore_every_cut,
                "{}: Local replay needs restore_every_cut",
                case.file.id
            );
        }
        let Some(restore) = &report.restore else {
            assert!(!covers_replay);
            continue;
        };
        checked += 1;
        assert!(
            restore.first_mismatch.is_none(),
            "{}: {:?}",
            case.file.id,
            restore.detail
        );
        if status_of_expectation(case) == "COMPLETED" {
            // Four events per processed session, plus the cut before the first event.
            let sessions = report.result.as_ref().map_or(0, |r| r.journal.daily.len());
            assert_eq!(
                restore.cuts,
                4 * sessions + 1,
                "{}: every cut point is tried",
                case.file.id
            );
            assert!(restore.deep >= 1 && restore.deep <= restore.cuts);
        }
    }
    assert!(checked >= 40, "only {checked} cases restored");
}

/// The restore check compares the restored state with the uninterrupted state field by field
/// (`state_difference` in `src/replay.rs`). This destructuring has no `..`, so adding a field to
/// `State` stops this test from compiling. When that happens, add the new field to
/// `state_difference` and to this pattern.
#[test]
fn the_restore_comparison_lists_every_state_field() {
    let case = cases().first().expect("a fixture case").clone();
    let strategy = openquant_contracts::parse(&case.strategy_text).expect("strategy");
    let input = openquant_contracts::parse(&case.input_text).expect("input");
    let run = openquant_core::Run::prepare(&strategy, &input).expect("prepare");
    let state = run.initial_state().expect("initial state");
    let State {
        next: _,
        cash_available: _,
        cash_reserved: _,
        receivables: _,
        positions: _,
        pending: _,
        applied: _,
        journal: _,
    } = state;
}

#[test]
fn every_completed_case_repeats_and_validates_against_the_result_schema() {
    for report in reports().iter().filter(|r| r.started) {
        assert_eq!(
            report.repeat_identical,
            Some(true),
            "{}: repeat evaluation",
            report.id
        );
        assert!(
            matches!(report.result_schema, Some(Ok(()))),
            "{}: {:?}",
            report.id,
            report.result_schema
        );
    }
}

#[test]
fn the_full_report_covers_every_case_and_every_row() {
    let text = render_report(&header(), reports());
    for heading in REPORT_SECTIONS {
        assert!(text.contains(heading), "{heading}");
    }
    for case in reports() {
        assert!(
            text.contains(&format!("\n## {} — ", case.id)),
            "{}: case section",
            case.id
        );
    }
    for row in S0_ROWS {
        assert!(text.contains(&format!("| {row} | ")), "{row}: coverage row");
    }
    let sections = text.matches("\n### Signals\n").count();
    assert_eq!(sections, reports().len(), "every case has a signals table");
    for heading in CASE_SECTIONS {
        assert_eq!(
            text.matches(&format!("\n{heading}\n")).count(),
            reports().len(),
            "{heading} appears once per case"
        );
    }
}

#[test]
fn two_runs_write_byte_identical_result_files_and_index() {
    let first = fresh_dir("fixtures-run-a");
    let second = fresh_dir("fixtures-run-b");
    // A second, independent evaluation of every case. It starts before the shared run is
    // awaited so the two evaluations overlap when other tests have already started the first.
    let again: Vec<CaseReport> = run_cases(cases());
    write_outputs(&first, &header(), reports()).expect("first write");
    write_outputs(&second, &header(), &again).expect("second write");

    let (a, b) = (tree(&first), tree(&second));
    let names =
        |files: &[(String, Vec<u8>)]| files.iter().map(|(n, _)| n.clone()).collect::<Vec<_>>();
    assert_eq!(names(&a), names(&b), "the same files are written");
    let results = a
        .iter()
        .filter(|(name, _)| name.ends_with(".result.json"))
        .count();
    assert_eq!(
        results,
        reports().iter().filter(|r| r.result_text.is_some()).count()
    );
    assert!(a.iter().any(|(name, _)| name == "index.json"));
    for ((name, left), (_, right)) in a.iter().zip(&b) {
        assert!(left == right, "{name} differs between two runs");
    }
}

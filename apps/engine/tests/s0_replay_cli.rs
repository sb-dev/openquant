//! Tests of the `s0-replay` command: exit status, outputs and repeatability.
//!
//! The command runs against small fixture directories built in the cargo test directory, so a
//! deliberate difference never touches the committed fixtures.

mod common;

use std::{
    fs,
    path::{Path, PathBuf},
    process::{Command, Output},
};

use common::{copy_files, fixtures, fresh_dir};
use serde_json::Value;

fn s0_replay(args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_s0-replay"))
        .args(args)
        .output()
        .expect("run s0-replay")
}

fn text(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

/// A fixture directory holding a copy of case X-01 only.
fn single_case_fixtures(name: &str) -> (PathBuf, PathBuf) {
    let root = fresh_dir(name);
    let case = root.join("fixtures").join("cases").join("X-01");
    copy_files(&fixtures().join("cases").join("X-01"), &case);
    (root.join("fixtures"), root.join("out"))
}

fn arg(path: &Path) -> &str {
    path.to_str().expect("utf-8 path")
}

#[test]
fn a_matching_case_exits_zero_and_writes_every_output() {
    let (fx, out) = single_case_fixtures("cli-pass");
    let run = s0_replay(&["--fixtures", arg(&fx), "--out", arg(&out), "--case", "X-01"]);
    assert!(run.status.success(), "{}", text(&run.stderr));
    let stdout = text(&run.stdout);
    assert!(
        stdout.contains("X-01") && stdout.contains("PASS"),
        "{stdout}"
    );
    assert!(stdout.contains("1 case(s), 0 failed"));
    for file in ["report.md", "index.json", "results/X-01.result.json"] {
        assert!(out.join(file).is_file(), "{file} is written");
    }
    let report = fs::read_to_string(out.join("report.md")).expect("report");
    assert!(report.contains("## X-01 — "));
    assert!(report.contains("- command: `s0-replay --fixtures"));
    let result: Value = serde_json::from_str(
        &fs::read_to_string(out.join("results/X-01.result.json")).expect("result"),
    )
    .expect("json");
    assert_eq!(result["schema_version"], "evaluation-result/1");
    assert_eq!(result["outcome"]["status"], "COMPLETED");
}

#[test]
fn any_difference_exits_non_zero_and_is_visible_in_the_output_and_the_report() {
    let (fx, out) = single_case_fixtures("cli-fail");
    // A deliberate one-cent difference in the independent expectation of the final equity.
    let path = fx.join("cases/X-01/expected.json");
    let mut expected: Value =
        serde_json::from_str(&fs::read_to_string(&path).expect("expected")).expect("json");
    expected["expect"]["final"]["equity"] = Value::String("4998.06".to_owned());
    fs::write(
        &path,
        serde_json::to_string_pretty(&expected).expect("serialise"),
    )
    .expect("write");

    let run = s0_replay(&["--fixtures", arg(&fx), "--out", arg(&out), "--case", "X-01"]);
    assert_eq!(run.status.code(), Some(1), "a difference is exit status 1");
    let stdout = text(&run.stdout);
    let stderr = text(&run.stderr);
    assert!(stdout.contains("FAIL"), "{stdout}");
    assert!(stdout.contains("1 case(s), 1 failed"));
    assert!(stderr.contains("FAIL X-01"), "{stderr}");
    assert!(
        stderr.contains("/final/equity: expected \"4998.06\", actual \"4998.05\""),
        "{stderr}"
    );
    let report = fs::read_to_string(out.join("report.md")).expect("report");
    assert!(report.contains("[FAIL]"));
    assert!(report.contains("| /final/equity | \"4998.06\" | \"4998.05\" |"));
    let index: Value =
        serde_json::from_str(&fs::read_to_string(out.join("index.json")).expect("index"))
            .expect("json");
    assert_eq!(index["cases"][0]["passed"], false);
}

#[test]
fn usage_and_file_errors_exit_two() {
    let (fx, out) = single_case_fixtures("cli-usage");
    let (fx, out) = (arg(&fx), arg(&out));
    for args in [
        vec!["--bogus", "1"],
        vec!["--out"],
        vec!["--fixtures", fx, "--out", out, "--case", "NO-SUCH-CASE"],
        vec!["--fixtures", "/nonexistent/fixtures", "--out", out],
    ] {
        let run = s0_replay(&args);
        assert_eq!(
            run.status.code(),
            Some(2),
            "{args:?}: {}",
            text(&run.stderr)
        );
        assert!(text(&run.stderr).starts_with("error: "), "{args:?}");
    }
    let help = s0_replay(&["--help"]);
    assert!(help.status.success());
    assert!(text(&help.stdout).starts_with("usage: s0-replay"));
}

#[test]
fn a_run_of_all_cases_fails_when_s0_rows_are_not_covered() {
    // A directory with a passing case but no coverage map cannot demonstrate the S0 rows.
    let (fx, out) = single_case_fixtures("cli-coverage-missing");
    let run = s0_replay(&["--fixtures", arg(&fx), "--out", arg(&out)]);
    assert_eq!(run.status.code(), Some(1), "{}", text(&run.stderr));
    assert!(text(&run.stderr).contains("coverage.json"));
    assert!(text(&run.stdout).contains("1 case(s), 0 failed, 1 coverage problem(s)"));

    // The committed coverage map names cases that this directory does not hold.
    fs::copy(fixtures().join("coverage.json"), fx.join("coverage.json")).expect("copy coverage");
    let run = s0_replay(&["--fixtures", arg(&fx), "--out", arg(&out)]);
    assert_eq!(run.status.code(), Some(1));
    assert!(text(&run.stderr).contains("but no such case exists"));
    let report = fs::read_to_string(out.join("report.md")).expect("report");
    assert!(report.contains("### Coverage problems"));
    assert!(report.contains("| Local replay | none | 0 | 0 | NOT COVERED |"));
    assert!(report.contains("[PASS]"), "the case itself still passes");
}

#[test]
fn two_runs_write_byte_identical_result_files_and_index() {
    let (fx, _) = single_case_fixtures("cli-repeat");
    let root = fx.parent().expect("root").to_path_buf();
    let (first, second) = (root.join("out-a"), root.join("out-b"));
    for out in [&first, &second] {
        let run = s0_replay(&["--fixtures", arg(&fx), "--out", arg(out), "--case", "X-01"]);
        assert!(run.status.success(), "{}", text(&run.stderr));
    }
    for file in ["index.json", "results/X-01.result.json"] {
        let (a, b) = (
            fs::read(first.join(file)).expect("first"),
            fs::read(second.join(file)).expect("second"),
        );
        assert!(!a.is_empty());
        assert!(a == b, "{file} differs between two runs");
    }
}

#[test]
fn a_partial_run_leaves_other_results_in_place() {
    let (fx, out) = single_case_fixtures("cli-partial");
    fs::create_dir_all(out.join("results")).expect("results dir");
    fs::write(out.join("results/OTHER.result.json"), "{}").expect("other result");
    let run = s0_replay(&["--fixtures", arg(&fx), "--out", arg(&out), "--case", "X-01"]);
    assert!(run.status.success(), "{}", text(&run.stderr));
    assert!(out.join("results/OTHER.result.json").exists());
}

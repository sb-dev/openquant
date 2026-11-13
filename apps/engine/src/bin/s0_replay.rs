//! `s0-replay`: replay the S0 fixture cases through the shared Rust core and write a report.
//!
//! Usage: `cargo run --locked -p openquant-engine --bin s0-replay -- [--fixtures DIR] [--out DIR] [--case ID]`
//!
//! Exit status: 0 when every case matches its independent expectation, repeats byte for byte,
//! validates against the result schema and restores from every cut point, and (for a run of all
//! cases) every S0 row is covered. 1 when anything differs. 2 for a usage or file error.

use std::{path::PathBuf, process::Command, process::ExitCode};

use openquant_engine::{
    case::load_cases,
    coverage::{check_coverage, load_coverage},
    replay::run_cases,
    report::{Header, format_failures, write_outputs},
};

const USAGE: &str = "usage: s0-replay [--fixtures DIR] [--out DIR] [--case ID]";

/// Differences listed per failing case on the terminal. The report lists all of them.
const TERMINAL_LIMIT: usize = 12;

struct Args {
    fixtures: PathBuf,
    out: PathBuf,
    only: Option<String>,
}

fn parse_args(raw: &[String]) -> Result<Args, String> {
    let mut args = Args {
        fixtures: PathBuf::from("fixtures/s0"),
        out: PathBuf::from("local-runs/s0"),
        only: None,
    };
    let mut iter = raw.iter();
    while let Some(flag) = iter.next() {
        let value = iter.next().ok_or_else(|| format!("{flag} needs a value"))?;
        match flag.as_str() {
            "--fixtures" => args.fixtures = PathBuf::from(value),
            "--out" => args.out = PathBuf::from(value),
            "--case" => args.only = Some(value.clone()),
            other => return Err(format!("unknown flag {other}")),
        }
    }
    Ok(args)
}

fn capture(program: &str, args: &[&str]) -> String {
    Command::new(program)
        .args(args)
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map_or_else(
            || "unknown".to_owned(),
            |o| String::from_utf8_lossy(&o.stdout).trim().to_owned(),
        )
}

fn source_revision() -> String {
    let revision = capture("git", &["rev-parse", "--short=12", "HEAD"]);
    let dirty = !capture("git", &["status", "--porcelain"]).is_empty();
    if dirty {
        format!("{revision}+uncommitted")
    } else {
        revision
    }
}

fn main() -> ExitCode {
    let raw: Vec<String> = std::env::args().skip(1).collect();
    if raw.iter().any(|a| a == "--help" || a == "-h") {
        println!("{USAGE}");
        return ExitCode::SUCCESS;
    }
    let args = match parse_args(&raw) {
        Ok(args) => args,
        Err(message) => {
            eprintln!("error: {message}\n{USAGE}");
            return ExitCode::from(2);
        }
    };
    let mut cases = match load_cases(&args.fixtures) {
        Ok(cases) => cases,
        Err(message) => {
            eprintln!("error: {message}");
            return ExitCode::from(2);
        }
    };
    let declared: Vec<_> = cases
        .iter()
        .map(|c| (c.file.id.clone(), c.file.covers.clone()))
        .collect();
    if let Some(only) = &args.only {
        cases.retain(|case| &case.file.id == only);
        if cases.is_empty() {
            eprintln!("error: no case named {only}");
            return ExitCode::from(2);
        }
    }
    if cases.is_empty() {
        eprintln!("error: no cases to run");
        return ExitCode::from(2);
    }

    // Row coverage is only meaningful for a run of all cases.
    let coverage_problems = if args.only.is_some() {
        Vec::new()
    } else {
        match load_coverage(&args.fixtures) {
            Ok(coverage) => check_coverage(&coverage, &declared),
            Err(message) => vec![message],
        }
    };

    // The header is read before any output is written so the working tree is judged first.
    let header = Header {
        source_revision: source_revision(),
        command: format!("s0-replay {}", raw.join(" ")).trim().to_owned(),
        toolchain: capture("rustc", &["--version"]),
        fixtures: args.fixtures.display().to_string(),
        filter: args.only.clone(),
        coverage_problems,
    };
    let reports = run_cases(&cases);
    if let Err(message) = write_outputs(&args.out, &header, &reports) {
        eprintln!("error: {message}");
        return ExitCode::from(2);
    }

    let failed = reports.iter().filter(|r| !r.passed).count();
    for report in &reports {
        println!(
            "{:<28} {} ({}/{} checks)",
            report.id,
            if report.passed { "PASS" } else { "FAIL" },
            report.matched_fields,
            report.expected_fields
        );
    }
    let failures = format_failures(&reports, &header.fixtures, TERMINAL_LIMIT);
    if !failures.is_empty() {
        eprintln!("\n{failures}");
    }
    for problem in &header.coverage_problems {
        eprintln!("coverage: {problem}");
    }
    println!(
        "{} case(s), {} failed, {} coverage problem(s). Report: {}",
        reports.len(),
        failed,
        header.coverage_problems.len(),
        args.out.join("report.md").display()
    );
    if failed == 0 && header.coverage_problems.is_empty() {
        ExitCode::SUCCESS
    } else {
        ExitCode::FAILURE
    }
}

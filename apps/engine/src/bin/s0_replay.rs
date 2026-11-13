//! `s0-replay`: replay the S0 fixture cases through the shared Rust core and write a report.
//!
//! Usage: `cargo run --locked -p openquant-engine --bin s0-replay -- [--fixtures DIR] [--out DIR] [--case ID]`

use std::{fs, path::PathBuf, process::Command, process::ExitCode};

use openquant_engine::{
    case::load_cases,
    replay::run_case,
    report::{Header, render_index, render_report},
};

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
    let args = match parse_args(&raw) {
        Ok(args) => args,
        Err(message) => {
            eprintln!("error: {message}");
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
    if let Some(only) = &args.only {
        cases.retain(|case| &case.file.id == only);
    }
    if cases.is_empty() {
        eprintln!("error: no cases to run");
        return ExitCode::from(2);
    }
    let reports: Vec<_> = cases.iter().map(run_case).collect();

    let results = args.out.join("results");
    if let Err(error) = fs::create_dir_all(&results) {
        eprintln!("error: {}: {error}", results.display());
        return ExitCode::from(2);
    }
    for report in &reports {
        if let Some(text) = &report.result_text {
            let path = results.join(format!("{}.result.json", report.id));
            if let Err(error) = fs::write(&path, format!("{text}\n")) {
                eprintln!("error: {}: {error}", path.display());
                return ExitCode::from(2);
            }
        }
    }
    let header = Header {
        source_revision: source_revision(),
        command: format!("s0-replay {}", raw.join(" ")).trim().to_owned(),
        toolchain: capture("rustc", &["--version"]),
        fixtures: args.fixtures.display().to_string(),
    };
    let writes = [
        (args.out.join("report.md"), render_report(&header, &reports)),
        (
            args.out.join("index.json"),
            serde_json::to_string_pretty(&render_index(&reports)).unwrap_or_default() + "\n",
        ),
    ];
    for (path, text) in writes {
        if let Err(error) = fs::write(&path, text) {
            eprintln!("error: {}: {error}", path.display());
            return ExitCode::from(2);
        }
    }
    let failed = reports.iter().filter(|r| !r.passed).count();
    for report in &reports {
        println!(
            "{:<28} {}",
            report.id,
            if report.passed { "PASS" } else { "FAIL" }
        );
    }
    println!(
        "{} case(s), {} failed. Report: {}",
        reports.len(),
        failed,
        args.out.join("report.md").display()
    );
    if failed == 0 {
        ExitCode::SUCCESS
    } else {
        ExitCode::FAILURE
    }
}

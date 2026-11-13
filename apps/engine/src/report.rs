//! The readable local report, the deterministic index and the failure list.
//!
//! The report is harness-specific presentation. Every number in it comes from the shared result
//! (`evaluation-result/1`) or from the comparison with the independent expectation; this module
//! only formats.

use std::{collections::BTreeSet, fmt::Write as _, fs, path::Path};

use openquant_contracts::digest_bytes;
use serde_json::{Value, json};

use crate::{coverage::S0_ROWS, replay::CaseReport};

/// Run context recorded in the report header only. It never enters a numerical result or the
/// index, so repeated evaluations agree byte for byte.
pub struct Header {
    pub source_revision: String,
    pub command: String,
    pub toolchain: String,
    pub fixtures: String,
    /// The selected case id when only one case ran. Row coverage is then partial by design.
    pub filter: Option<String>,
    /// Inconsistencies between the S0 rows, `coverage.json` and the cases. Empty when none.
    pub coverage_problems: Vec<String>,
}

/// Headings of the whole report, in order.
pub const REPORT_SECTIONS: [&str; 4] = [
    "# S0 local replay report",
    "## Summary",
    "## Acceptance row coverage",
    "## Remaining limitations",
];

/// Headings every case section contains, in order.
pub const CASE_SECTIONS: [&str; 11] = [
    "### Identities",
    "### Signals",
    "### Entry intents",
    "### Fills",
    "### Trades",
    "### Cash ledger",
    "### Corporate actions applied",
    "### Daily cash, positions and equity",
    "### Final state",
    "### Expected versus actual",
    "### Determinism and restore",
];

/// Longest value shown in a table cell before it is shortened with an ellipsis.
const CELL_LIMIT: usize = 300;

fn shorten(text: &str, limit: usize) -> String {
    if text.chars().count() <= limit {
        return text.to_owned();
    }
    let head: String = text.chars().take(limit).collect();
    format!("{head}...")
}

/// Make arbitrary text safe inside one Markdown table cell.
fn escape(text: &str) -> String {
    shorten(text, CELL_LIMIT)
        .replace('|', "\\|")
        .replace(['\n', '\r'], " ")
}

fn cell(row: &Value, key: &str) -> String {
    match row.get(key) {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(text)) => escape(text),
        Some(Value::Object(map)) => match (map.get("session"), map.get("phase")) {
            (Some(Value::String(session)), Some(Value::String(phase))) => {
                format!("{session}/{phase}")
            }
            _ => escape(&row[key].to_string()),
        },
        Some(other) => escape(&other.to_string()),
    }
}

fn text_of<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or("")
}

fn table(out: &mut String, columns: &[(&str, &str)], rows: &Value) {
    let Some(rows) = rows.as_array().filter(|r| !r.is_empty()) else {
        out.push_str("_none_\n\n");
        return;
    };
    let heads: Vec<&str> = columns.iter().map(|(head, _)| *head).collect();
    let _ = writeln!(out, "| {} |", heads.join(" | "));
    let _ = writeln!(out, "|{}|", vec!["---"; columns.len()].join("|"));
    for row in rows {
        let cells: Vec<String> = columns.iter().map(|(_, key)| cell(row, key)).collect();
        let _ = writeln!(out, "| {} |", cells.join(" | "));
    }
    out.push('\n');
}

fn indicators(row: &Value) -> String {
    row.get("indicators")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .map(|i| {
                    let value = i
                        .get("value")
                        .and_then(Value::as_str)
                        .or_else(|| i.get("missing_reason").and_then(Value::as_str))
                        .unwrap_or("");
                    format!("{}={}", text_of(i, "name"), value)
                })
                .collect::<Vec<_>>()
                .join(", ")
        })
        .unwrap_or_default()
}

/// One position as a short line: quantity, entry, levels, snapshots and a scheduled stop.
fn position_line(p: &Value) -> String {
    let snapshots = p
        .get("snapshots")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .map(|s| format!(", {}={}", text_of(s, "name"), text_of(s, "value")))
                .collect::<String>()
        })
        .unwrap_or_default();
    let scheduled = p
        .get("scheduled_stop")
        .map(|s| {
            format!(
                ", scheduled stop {} from {}",
                text_of(s, "level"),
                text_of(s, "effective_session")
            )
        })
        .unwrap_or_default();
    format!(
        "{} sh @ {} (stop {}, target {}{}{})",
        text_of(p, "quantity"),
        text_of(p, "entry_price"),
        text_of(p, "stop"),
        text_of(p, "target"),
        snapshots,
        scheduled
    )
}

fn positions(row: &Value, key: &str) -> String {
    row.get(key)
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .map(position_line)
                .collect::<Vec<_>>()
                .join("; ")
        })
        .unwrap_or_default()
}

/// `STATUS CODE`, for tables.
fn outcome_label(outcome: &Value) -> String {
    let status = outcome
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("UNKNOWN");
    match outcome.get("code").and_then(Value::as_str) {
        Some(code) => format!("{status} {code}"),
        None => status.to_owned(),
    }
}

/// `STATUS CODE at session/PHASE: detail`, for the case section.
fn outcome_text(outcome: &Value) -> String {
    let mut text = outcome_label(outcome);
    let at = cell(outcome, "at");
    if !at.is_empty() {
        let _ = write!(text, " at {at}");
    }
    if let Some(detail) = outcome.get("detail").and_then(Value::as_str) {
        let _ = write!(text, ": {detail}");
    }
    text
}

fn yes_no(flag: Option<bool>) -> &'static str {
    match flag {
        Some(true) => "yes",
        Some(false) => "NO",
        None => "not run",
    }
}

fn restore_text(report: &CaseReport) -> String {
    match &report.restore {
        None => "not requested".to_owned(),
        Some(r) => match r.first_mismatch {
            None => format!(
                "all {} cut points restore to a state identical to uninterrupted execution; {} of them were also serialised as schema-validated checkpoint text and run to the end with a byte-identical result",
                r.cuts, r.deep
            ),
            Some(cut) => format!(
                "MISMATCH at cut {cut} of {}: {}",
                r.cuts,
                r.detail.as_deref().unwrap_or("no detail")
            ),
        },
    }
}

fn schema_text(report: &CaseReport) -> String {
    match &report.result_schema {
        None => "not run".to_owned(),
        Some(Ok(())) => "valid and unchanged by a parse and serialise round trip".to_owned(),
        Some(Err(message)) => format!("INVALID: {message}"),
    }
}

fn identities(out: &mut String, report: &CaseReport) {
    let _ = writeln!(
        out,
        "- case directory: `cases/{}`\n- expected values: {}\n- strategy artefact: `{}`\n- evaluation input: `{}`\n- engine: {}, digest `{}`\n- result digest: `{}`\n- outcome: {}\n",
        report.case_dir,
        report.origin,
        report.strategy_hash.as_deref().unwrap_or("n/a"),
        report.input_hash.as_deref().unwrap_or("n/a"),
        report
            .engine
            .as_ref()
            .map_or_else(|| "n/a".to_owned(), engine_text),
        report.engine_digest.as_deref().unwrap_or("n/a"),
        report
            .result_text
            .as_ref()
            .map_or_else(|| "n/a".to_owned(), |t| digest_bytes(t.as_bytes())),
        outcome_text(&report.outcome),
    );
}

fn engine_text(engine: &Value) -> String {
    format!("{} {}", text_of(engine, "name"), text_of(engine, "version"))
}

fn expected_versus_actual(out: &mut String, report: &CaseReport) {
    out.push_str("### Expected versus actual\n\n");
    let _ = writeln!(
        out,
        "Checks are the scalar values and array lengths the independent expectation states. Sections the case does not state are not compared.\n"
    );
    if !report.sections.is_empty() {
        out.push_str("| section | checks | matched | differences |\n|---|---|---|---|\n");
        for section in &report.sections {
            let _ = writeln!(
                out,
                "| {} | {} | {} | {} |",
                section.section, section.expected, section.matched, section.differences
            );
        }
        let _ = writeln!(
            out,
            "| **total** | **{}** | **{}** | **{}** |\n",
            report.expected_fields,
            report.matched_fields,
            report.mismatches.len()
        );
    }
    if report.mismatches.is_empty() {
        let _ = writeln!(
            out,
            "All {} expected checks match the actual values.\n",
            report.expected_fields
        );
        return;
    }
    out.push_str("| path | expected | actual |\n|---|---|---|\n");
    for m in &report.mismatches {
        let _ = writeln!(
            out,
            "| {} | {} | {} |",
            escape(&m.path),
            escape(&m.expected),
            escape(&m.actual)
        );
    }
    out.push('\n');
}

fn determinism_and_restore(out: &mut String, report: &CaseReport) {
    out.push_str("### Determinism and restore\n\n");
    let _ = writeln!(
        out,
        "- repeat evaluation from freshly parsed documents is byte-identical: {}\n- result against the evaluation-result schema: {}\n- restore from every cut point: {}",
        yes_no(report.repeat_identical),
        schema_text(report),
        restore_text(report),
    );
    if let Some(error) = &report.error {
        let _ = writeln!(out, "- HARNESS ERROR: {error}");
    }
    out.push('\n');
}

fn case_section(out: &mut String, report: &CaseReport) {
    let verdict = if report.passed { "PASS" } else { "FAIL" };
    let _ = writeln!(out, "## {} — {} [{verdict}]\n", report.id, report.title);
    let _ = writeln!(out, "Covers: {}\n", report.covers.join("; "));
    if !report.started {
        out.push_str(
            "Rejected before evaluation: no event was processed, so the tables below hold the zero state.\n\n",
        );
    }
    let result: Value = report
        .result_text
        .as_deref()
        .and_then(|text| serde_json::from_str(text).ok())
        .unwrap_or(Value::Null);
    let journal = result.get("journal").cloned().unwrap_or(Value::Null);
    let rows = |key: &str| journal.get(key).cloned().unwrap_or(Value::Null);

    out.push_str("### Identities\n\n");
    identities(out, report);

    out.push_str("### Signals\n\n");
    let mut signal_rows = rows("signals");
    if let Some(items) = signal_rows.as_array_mut() {
        for row in items {
            let summary = indicators(row);
            row["indicator_summary"] = Value::String(summary);
        }
    }
    table(
        out,
        &[
            ("session", "session"),
            ("condition", "condition"),
            ("decision", "decision"),
            ("skip reason", "skip_reason"),
            ("rank", "rank"),
            ("indicators", "indicator_summary"),
        ],
        &signal_rows,
    );
    out.push_str("### Entry intents\n\n");
    table(
        out,
        &[
            ("intent", "intent_id"),
            ("signal", "signal_session"),
            ("rank", "rank"),
            ("cap", "cap"),
            ("status", "status"),
            ("reason", "reason"),
            ("qty", "quantity"),
            ("fill price", "fill_price"),
            ("fee", "fee"),
        ],
        &rows("entries"),
    );
    out.push_str("### Fills\n\n");
    table(
        out,
        &[
            ("seq", "seq"),
            ("session", "session"),
            ("phase", "phase"),
            ("side", "side"),
            ("qty", "quantity"),
            ("price", "price"),
            ("notional", "notional"),
            ("fee", "fee"),
            ("cash delta", "cash_delta"),
            ("reason", "reason"),
            ("ambiguous bar", "ambiguous_bar"),
        ],
        &rows("fills"),
    );
    out.push_str("### Trades\n\n");
    table(
        out,
        &[
            ("trade", "trade_id"),
            ("entry", "entry_session"),
            ("exit", "exit_session"),
            ("qty", "quantity"),
            ("entry price", "entry_price"),
            ("exit price", "exit_price"),
            ("exit reason", "exit_reason"),
            ("ambiguous bar", "ambiguous_bar"),
        ],
        &rows("trades"),
    );
    out.push_str("### Cash ledger\n\n");
    table(
        out,
        &[
            ("seq", "seq"),
            ("session", "session"),
            ("phase", "phase"),
            ("kind", "kind"),
            ("amount", "amount"),
            ("available", "available_after"),
            ("reserved", "reserved_after"),
            ("receivables", "receivables_after"),
        ],
        &rows("cash_ledger"),
    );
    out.push_str("### Corporate actions applied\n\n");
    table(
        out,
        &[
            ("action", "action_id"),
            ("kind", "kind"),
            ("effective", "effective_session"),
            ("applied at", "applied_at"),
        ],
        &rows("corporate_actions"),
    );
    out.push_str("### Daily cash, positions and equity\n\n");
    let mut daily = rows("daily");
    if let Some(items) = daily.as_array_mut() {
        for row in items {
            let summary = positions(row, "positions");
            row["position_summary"] = Value::String(summary);
        }
    }
    table(
        out,
        &[
            ("session", "session"),
            ("available", "cash_available"),
            ("reserved", "cash_reserved"),
            ("receivables", "receivables"),
            ("positions value", "positions_value"),
            ("equity", "equity"),
            ("positions", "position_summary"),
        ],
        &daily,
    );
    out.push_str("### Final state\n\n");
    let final_state = result.get("final").cloned().unwrap_or(Value::Null);
    let open = positions(&final_state, "open_positions");
    let _ = writeln!(
        out,
        "available {}, reserved {}, receivables {}, positions value {}, equity {}\n\nOpen positions at the end: {}\n",
        text_of(&final_state, "cash_available"),
        text_of(&final_state, "cash_reserved"),
        text_of(&final_state, "receivables"),
        text_of(&final_state, "positions_value"),
        text_of(&final_state, "equity"),
        if open.is_empty() {
            "none".to_owned()
        } else {
            open
        },
    );
    expected_versus_actual(out, report);
    determinism_and_restore(out, report);
}

const LIMITATIONS: [&str; 11] = [
    "Synthetic one-instrument inputs only. No provider data, no real model execution, no cloud, no broker.",
    "Expected values come from independent exact-rational derivations (`derivation.md` per case and the committed oracle script). Verification does not run the oracle; it compares the engine with the committed values and checks the oracle digest recorded in each expectation.",
    "A case compares only the values and sessions its derivation states. Sections a case does not state are not compared.",
    "Cases rejected before the first event (malformed documents, unsupported operators, identity mismatch) show the zero state, not a trading result.",
    "This local replay contributes to A03–A05. It does not complete any acceptance ID by itself.",
    "It does not establish A11 distributed recovery. Restore is a local serialise-and-continue check from every event boundary.",
    "It does not satisfy the public CLI release gate (installed replay, A15–A16, R04).",
    "Joint ranking across instruments, shared instrument cash and cohort coverage belong to S4.",
    "Ranking ties compare scores rounded to 28 significant digits, not exact rationals.",
    "Fee, scale and rounding values are declared synthetic policy, not a vendor or broker cost model.",
    "TypeScript bindings and the connected run, attempt and ownership envelopes arrive in S1.",
];

fn engine_line(reports: &[CaseReport]) -> String {
    let mut digests: BTreeSet<&str> = BTreeSet::new();
    let mut first: Option<&Value> = None;
    for report in reports {
        if let (Some(engine), Some(digest)) = (&report.engine, &report.engine_digest) {
            first.get_or_insert(engine);
            digests.insert(digest);
        }
    }
    let Some(engine) = first else {
        return "none (no case produced a result)".to_owned();
    };
    let digest_list = digests.into_iter().collect::<Vec<_>>().join("`, `");
    format!(
        "{}, operator set `{}`, schemas {}, engine digest `{digest_list}`",
        engine_text(engine),
        text_of(engine, "operator_set_digest"),
        engine
            .get("schema_versions")
            .and_then(Value::as_array)
            .map(|items| items
                .iter()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>()
                .join(", "))
            .unwrap_or_default(),
    )
}

fn summary(out: &mut String, reports: &[CaseReport]) {
    out.push_str("## Summary\n\n");
    out.push_str(
        "| case | title | S0 rows covered | outcome | checks matched | repeat | schema | restore | verdict |\n|---|---|---|---|---|---|---|---|---|\n",
    );
    for report in reports {
        let restore = match &report.restore {
            None => "not requested".to_owned(),
            Some(r) => match r.first_mismatch {
                None => format!("{} cuts ok", r.cuts),
                Some(cut) => format!("FAIL at cut {cut}"),
            },
        };
        let schema = match &report.result_schema {
            None => "n/a",
            Some(Ok(())) => "ok",
            Some(Err(_)) => "FAIL",
        };
        let repeat = match report.repeat_identical {
            None => "n/a",
            Some(true) => "ok",
            Some(false) => "FAIL",
        };
        let _ = writeln!(
            out,
            "| {} | {} | {} | {} | {}/{} | {} | {} | {} | {} |",
            report.id,
            escape(&report.title),
            escape(&report.covers.join("; ")),
            escape(&outcome_label(&report.outcome)),
            report.matched_fields,
            report.expected_fields,
            repeat,
            schema,
            restore,
            if report.passed { "PASS" } else { "FAIL" }
        );
    }
    out.push('\n');
}

fn row_coverage(out: &mut String, header: &Header, reports: &[CaseReport]) {
    out.push_str("## Acceptance row coverage\n\n");
    out.push_str(
        "Each S0 row of OQ-06 section 8 needs at least one case, and every case that covers it must pass.\n\n",
    );
    if let Some(only) = &header.filter {
        let _ = writeln!(
            out,
            "Only case `{only}` ran, so rows it does not cover are shown as not covered by design.\n"
        );
    }
    out.push_str("| S0 row | cases | passing | failing | status |\n|---|---|---|---|---|\n");
    for row in S0_ROWS {
        let covering: Vec<&CaseReport> = reports
            .iter()
            .filter(|r| r.covers.iter().any(|c| c == row))
            .collect();
        let passing = covering.iter().filter(|r| r.passed).count();
        let failing = covering.len() - passing;
        let status = if covering.is_empty() {
            "NOT COVERED"
        } else if failing > 0 {
            "FAILING"
        } else {
            "covered"
        };
        let ids = covering
            .iter()
            .map(|r| r.id.as_str())
            .collect::<Vec<_>>()
            .join(", ");
        let _ = writeln!(
            out,
            "| {row} | {} | {passing} | {failing} | {status} |",
            if ids.is_empty() {
                "none".to_owned()
            } else {
                escape(&ids)
            }
        );
    }
    out.push('\n');
    if !header.coverage_problems.is_empty() {
        out.push_str("### Coverage problems\n\n");
        for problem in &header.coverage_problems {
            let _ = writeln!(out, "- {problem}");
        }
        out.push('\n');
    }
}

/// Render the full markdown report.
#[must_use]
pub fn render_report(header: &Header, reports: &[CaseReport]) -> String {
    let passed = reports.iter().filter(|r| r.passed).count();
    let failed = reports.len() - passed;
    let mut out = String::new();
    out.push_str("# S0 local replay report\n\n");
    let _ = writeln!(
        out,
        "- source revision: `{}`\n- command: `{}`\n- toolchain: `{}`\n- fixtures: `{}`\n- engine: {}\n- cases: {}, passed: {passed}, failed: {failed}",
        header.source_revision,
        header.command,
        header.toolchain,
        header.fixtures,
        engine_line(reports),
        reports.len(),
    );
    if failed > 0 {
        let ids: Vec<&str> = reports
            .iter()
            .filter(|r| !r.passed)
            .map(|r| r.id.as_str())
            .collect();
        let _ = writeln!(out, "- **failing cases: {}**", ids.join(", "));
    }
    out.push('\n');
    summary(&mut out, reports);
    row_coverage(&mut out, header, reports);
    for report in reports {
        case_section(&mut out, report);
    }
    out.push_str("## Remaining limitations\n\n");
    for line in LIMITATIONS {
        let _ = writeln!(out, "- {line}");
    }
    out
}

/// Deterministic index: case ids, verdicts and result digests. No clock, revision or path.
#[must_use]
pub fn render_index(reports: &[CaseReport]) -> Value {
    let cases: Vec<Value> = reports
        .iter()
        .map(|r| {
            json!({
                "case": r.id,
                "passed": r.passed,
                "outcome": r.outcome["status"],
                "result_digest": r.result_text.as_ref().map(|t| digest_bytes(t.as_bytes())),
            })
        })
        .collect();
    json!({ "schema": "s0-replay-index/1", "cases": cases })
}

/// The bytes of `index.json`.
#[must_use]
pub fn index_text(reports: &[CaseReport]) -> String {
    serde_json::to_string_pretty(&render_index(reports)).unwrap_or_default() + "\n"
}

/// The failure list: for every failing case, the case id, the expectation file, and each
/// difference as path, expected and actual. At most `limit` differences are listed per case
/// (`0` lists all). Empty when every case passed.
#[must_use]
pub fn format_failures(reports: &[CaseReport], fixtures: &str, limit: usize) -> String {
    let mut out = String::new();
    for report in reports.iter().filter(|r| !r.passed) {
        let _ = writeln!(
            out,
            "FAIL {} ({fixtures}/cases/{}/expected.json): {} difference(s) from the expectation",
            report.id,
            report.case_dir,
            report.mismatches.len()
        );
        let shown = if limit == 0 {
            report.mismatches.len()
        } else {
            limit
        };
        for m in report.mismatches.iter().take(shown) {
            let _ = writeln!(
                out,
                "  {}: expected {}, actual {}",
                m.path,
                shorten(&m.expected, CELL_LIMIT),
                shorten(&m.actual, CELL_LIMIT)
            );
        }
        if report.mismatches.len() > shown {
            let _ = writeln!(
                out,
                "  ... {} more in the report",
                report.mismatches.len() - shown
            );
        }
        if report.repeat_identical == Some(false) {
            out.push_str("  repeat evaluation: not byte-identical\n");
        }
        if let Some(Err(message)) = &report.result_schema {
            let _ = writeln!(out, "  result schema: {message}");
        }
        if let Some(restore) = &report.restore
            && restore.first_mismatch.is_some()
        {
            let _ = writeln!(
                out,
                "  restore: {}",
                restore.detail.as_deref().unwrap_or("mismatch")
            );
        }
        if let Some(error) = &report.error {
            let _ = writeln!(out, "  harness error: {error}");
        }
    }
    out
}

/// Write `report.md`, `index.json` and one `results/<case>.result.json` per case below `out`.
///
/// Result files left by an earlier run that no case produces any more are removed, but only
/// when the run covers all cases (no `filter`), so `results/` always describes the run.
///
/// # Errors
/// A readable message naming the path that could not be written.
pub fn write_outputs(out: &Path, header: &Header, reports: &[CaseReport]) -> Result<(), String> {
    let results = out.join("results");
    let fail = |path: &Path, error: std::io::Error| format!("{}: {error}", path.display());
    fs::create_dir_all(&results).map_err(|e| fail(&results, e))?;
    let wanted: BTreeSet<String> = reports
        .iter()
        .filter(|r| r.result_text.is_some())
        .map(|r| format!("{}.result.json", r.id))
        .collect();
    if header.filter.is_none() {
        for entry in fs::read_dir(&results)
            .map_err(|e| fail(&results, e))?
            .flatten()
        {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.ends_with(".result.json") && !wanted.contains(&name) {
                fs::remove_file(entry.path()).map_err(|e| fail(&entry.path(), e))?;
            }
        }
    }
    for report in reports {
        if let Some(text) = &report.result_text {
            let path = results.join(format!("{}.result.json", report.id));
            fs::write(&path, format!("{text}\n")).map_err(|e| fail(&path, e))?;
        }
    }
    let report_path = out.join("report.md");
    fs::write(&report_path, render_report(header, reports)).map_err(|e| fail(&report_path, e))?;
    let index_path = out.join("index.json");
    fs::write(&index_path, index_text(reports)).map_err(|e| fail(&index_path, e))?;
    Ok(())
}

//! The readable local report and the deterministic index.

use std::fmt::Write as _;

use openquant_contracts::digest_bytes;
use serde_json::{Value, json};

use crate::replay::CaseReport;

/// Run context recorded in the report header only. It never enters a numerical result, so
/// repeated evaluations agree byte for byte.
pub struct Header {
    pub source_revision: String,
    pub command: String,
    pub toolchain: String,
    pub fixtures: String,
}

fn cell(row: &Value, key: &str) -> String {
    match row.get(key) {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(text)) => text.clone(),
        Some(other) => other.to_string(),
    }
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
                    format!("{}={}", cell(i, "name"), value)
                })
                .collect::<Vec<_>>()
                .join(", ")
        })
        .unwrap_or_default()
}

fn positions(row: &Value) -> String {
    row.get("positions")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .map(|p| {
                    let scheduled = p
                        .get("scheduled_stop")
                        .map(|s| {
                            format!(
                                ", scheduled stop {} from {}",
                                cell(s, "level"),
                                cell(s, "effective_session")
                            )
                        })
                        .unwrap_or_default();
                    format!(
                        "{} sh @ {} (stop {}, target {}{})",
                        cell(p, "quantity"),
                        cell(p, "entry_price"),
                        cell(p, "stop"),
                        cell(p, "target"),
                        scheduled
                    )
                })
                .collect::<Vec<_>>()
                .join("; ")
        })
        .unwrap_or_default()
}

fn case_section(out: &mut String, report: &CaseReport) {
    let verdict = if report.passed { "PASS" } else { "FAIL" };
    let _ = writeln!(out, "## {} — {} [{verdict}]\n", report.id, report.title);
    let _ = writeln!(out, "Covers: {}\n", report.covers.join("; "));
    let _ = writeln!(
        out,
        "- strategy: `{}`\n- input: `{}`\n- engine: `{}`\n- outcome: `{}`\n- repeat evaluation byte-identical: {}\n- restore from every cut point: {}\n- expected fields compared: {}, mismatches: {}\n",
        report.strategy_hash.as_deref().unwrap_or("n/a"),
        report.input_hash.as_deref().unwrap_or("n/a"),
        report.engine_digest.as_deref().unwrap_or("n/a"),
        report.outcome,
        report
            .repeat_identical
            .map_or("n/a".to_owned(), |b| b.to_string()),
        report
            .restore
            .as_ref()
            .map_or("not requested".to_owned(), |r| match r.first_mismatch {
                None => format!("all {} cut points match", r.cuts),
                Some(cut) => format!("MISMATCH at cut {cut} of {}", r.cuts),
            }),
        report.expected_fields,
        report.mismatches.len(),
    );
    let Some(text) = &report.result_text else {
        out.push_str("No run started: the case is rejected before evaluation.\n\n");
        mismatches(out, report);
        return;
    };
    let result: Value = serde_json::from_str(text).unwrap_or(Value::Null);
    let journal = &result["journal"];

    out.push_str("### Signals\n\n");
    let mut signal_rows = journal["signals"].clone();
    if let Some(rows) = signal_rows.as_array_mut() {
        for row in rows {
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
        &journal["entries"],
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
        &journal["fills"],
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
        &journal["trades"],
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
        &journal["cash_ledger"],
    );
    out.push_str("### Corporate actions applied\n\n");
    table(
        out,
        &[
            ("action", "action_id"),
            ("kind", "kind"),
            ("effective", "effective_session"),
        ],
        &journal["corporate_actions"],
    );
    out.push_str("### Daily cash, positions and equity\n\n");
    let mut daily = journal["daily"].clone();
    if let Some(rows) = daily.as_array_mut() {
        for row in rows {
            let summary = positions(row);
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
    let final_state = &result["final"];
    let _ = writeln!(
        out,
        "available {}, reserved {}, receivables {}, positions value {}, equity {}\n",
        cell(final_state, "cash_available"),
        cell(final_state, "cash_reserved"),
        cell(final_state, "receivables"),
        cell(final_state, "positions_value"),
        cell(final_state, "equity"),
    );
    mismatches(out, report);
}

fn mismatches(out: &mut String, report: &CaseReport) {
    out.push_str("### Expected versus actual\n\n");
    if report.mismatches.is_empty() {
        let _ = writeln!(
            out,
            "All {} expected values match the actual values.\n",
            report.expected_fields
        );
        return;
    }
    out.push_str("| path | expected | actual |\n|---|---|---|\n");
    for m in &report.mismatches {
        let _ = writeln!(out, "| {} | {} | {} |", m.path, m.expected, m.actual);
    }
    out.push('\n');
}

const LIMITATIONS: &[&str] = &[
    "Synthetic one-instrument inputs only. No provider data, no real model execution, no cloud, no broker.",
    "This local replay contributes to A03–A05. It does not complete any acceptance ID by itself.",
    "It does not establish A11 distributed recovery. Restore is a local serialise-and-continue check.",
    "It does not satisfy the public CLI release gate (installed replay, A15–A16, R04).",
    "Joint ranking across instruments, shared instrument cash and cohort coverage belong to S4.",
    "Ranking ties compare scores rounded to 28 significant digits, not exact rationals.",
    "Fee, scale and rounding values are declared synthetic policy, not a vendor or broker cost model.",
    "TypeScript bindings and the connected run, attempt and ownership envelopes arrive in S1.",
];

/// Render the full markdown report.
#[must_use]
pub fn render_report(header: &Header, reports: &[CaseReport]) -> String {
    let mut out = String::new();
    out.push_str("# S0 local replay report\n\n");
    let _ = writeln!(
        out,
        "- source revision: `{}`\n- command: `{}`\n- toolchain: `{}`\n- fixtures: `{}`\n- cases: {}, passed: {}, failed: {}\n",
        header.source_revision,
        header.command,
        header.toolchain,
        header.fixtures,
        reports.len(),
        reports.iter().filter(|r| r.passed).count(),
        reports.iter().filter(|r| !r.passed).count(),
    );
    out.push_str("## Summary\n\n| case | title | outcome | verdict |\n|---|---|---|---|\n");
    for report in reports {
        let _ = writeln!(
            out,
            "| {} | {} | {} | {} |",
            report.id,
            report.title,
            cell(&report.outcome, "status"),
            if report.passed { "PASS" } else { "FAIL" }
        );
    }
    out.push('\n');
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

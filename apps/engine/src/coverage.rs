//! The S0 acceptance rows of OQ-06 section 8 and the fixture coverage map.
//!
//! `fixtures/s0/coverage.json` maps each S0 row to the cases that demonstrate it, and every
//! `case.json` declares the rows it covers. The two must agree, and every S0 row needs at least
//! one case. The integration tests check [`S0_ROWS`] against the specification text itself.

use std::{collections::BTreeMap, fs, path::Path};

use serde::Deserialize;

/// The rows of the OQ-06 section 8 acceptance-case table whose delivery scope starts with S0.
pub const S0_ROWS: [&str; 11] = [
    "Definition execution",
    "Shared payloads",
    "Seed semantics",
    "Entry variants",
    "Unplanned non-trading events",
    "Split across an ex-date",
    "Cash dividend",
    "Entry and exit phases",
    "Cash and quantities",
    "Invalid inputs",
    "Local replay",
];

/// `coverage.json`.
#[derive(Clone, Debug, Deserialize)]
pub struct Coverage {
    pub schema: String,
    /// S0 row name to the ids of the cases that demonstrate it.
    pub rows: BTreeMap<String, Vec<String>>,
}

/// Load `root/coverage.json`.
///
/// # Errors
/// A readable message when the file is missing or malformed.
pub fn load_coverage(root: &Path) -> Result<Coverage, String> {
    let path = root.join("coverage.json");
    let text = fs::read_to_string(&path).map_err(|e| format!("{}: {e}", path.display()))?;
    serde_json::from_str(&text).map_err(|e| format!("{}: {e}", path.display()))
}

/// A case id with the S0 rows its `case.json` declares.
pub type Declared = (String, Vec<String>);

/// Every inconsistency between `coverage.json`, the S0 rows and the cases' own declarations.
/// An empty list means every S0 row is covered and both sides agree.
#[must_use]
pub fn check_coverage(coverage: &Coverage, cases: &[Declared]) -> Vec<String> {
    let mut problems = Vec::new();
    if coverage.schema != "s0-coverage/1" {
        problems.push(format!(
            "coverage.json schema is {:?}, expected \"s0-coverage/1\"",
            coverage.schema
        ));
    }
    for row in S0_ROWS {
        match coverage.rows.get(row) {
            None => problems.push(format!("S0 row {row:?} has no entry in coverage.json")),
            Some(ids) if ids.is_empty() => {
                problems.push(format!("S0 row {row:?} lists no case in coverage.json"));
            }
            Some(_) => {}
        }
    }
    for (row, ids) in &coverage.rows {
        if !S0_ROWS.contains(&row.as_str()) {
            problems.push(format!(
                "coverage.json names {row:?}, which is not an S0 row of OQ-06 section 8"
            ));
        }
        for id in ids {
            match cases.iter().find(|(case, _)| case == id) {
                None => problems.push(format!(
                    "coverage.json lists case {id} for {row:?}, but no such case exists"
                )),
                Some((_, covers)) if !covers.contains(row) => problems.push(format!(
                    "coverage.json lists case {id} for {row:?}, but case.json does not declare it"
                )),
                Some(_) => {}
            }
        }
    }
    for (id, covers) in cases {
        if covers.is_empty() {
            problems.push(format!("case {id} declares no S0 row"));
        }
        for row in covers {
            if !S0_ROWS.contains(&row.as_str()) {
                problems.push(format!(
                    "case {id} declares {row:?}, which is not an S0 row of OQ-06 section 8"
                ));
            } else if !coverage
                .rows
                .get(row)
                .is_some_and(|ids| ids.iter().any(|listed| listed == id))
            {
                problems.push(format!(
                    "case {id} declares {row:?}, but coverage.json does not list it"
                ));
            }
        }
    }
    let mut seen: Vec<&str> = Vec::new();
    for (id, _) in cases {
        if seen.contains(&id.as_str()) {
            problems.push(format!("case id {id} is used twice"));
        }
        seen.push(id);
    }
    problems
}

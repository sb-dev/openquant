//! Compare an actual result view with an expected view.
//!
//! Only fields present in the expectation are compared, so each fixture states exactly what its
//! independent derivation covers. Arrays must have equal length, except `signals`, which are
//! matched by `session` so a case can list only the sessions it derives. Two strings that are
//! both plain decimals compare by value; every other value compares exactly.
//!
//! The comparison counts what it checks. A *check* is one scalar value or one array length that
//! the expectation states. The counts let a reader see how much each case actually asserts and
//! make an empty expectation visible: a case that states `"trades": []` asserts that there is no
//! trade, and that is one check.

use rust_decimal::Decimal;
use serde_json::Value;

/// One difference between expected and actual.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Mismatch {
    /// JSON-pointer-like location in the result view, for example `/fills/0/price`.
    pub path: String,
    /// The expected value as compact JSON.
    pub expected: String,
    /// The actual value as compact JSON, or a marker such as `<absent>`.
    pub actual: String,
}

/// Checks made against one top-level section of the expectation.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SectionCount {
    pub section: String,
    /// Checks the expectation states for this section.
    pub expected: usize,
    /// Checks whose actual value equals the expected value.
    pub matched: usize,
    /// Number of reported differences. One difference can leave several checks unmatched, for
    /// example a missing array or a missing signal record.
    pub differences: usize,
}

/// The full result of comparing one expectation with one actual view.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Comparison {
    /// One entry per expected section, in the iteration order of the expectation object.
    pub sections: Vec<SectionCount>,
    pub mismatches: Vec<Mismatch>,
}

impl Comparison {
    /// Checks the expectation states.
    #[must_use]
    pub fn expected(&self) -> usize {
        self.sections.iter().map(|s| s.expected).sum()
    }

    /// Checks that matched.
    #[must_use]
    pub fn matched(&self) -> usize {
        self.sections.iter().map(|s| s.matched).sum()
    }

    /// True when nothing differs.
    #[must_use]
    pub fn is_match(&self) -> bool {
        self.mismatches.is_empty()
    }
}

fn show(value: &Value) -> String {
    value.to_string()
}

fn decimal(value: &Value) -> Option<Decimal> {
    let text = value.as_str()?;
    openquant_contracts::decimal::parse(text, 28).ok()
}

/// Checks a value states: its scalars plus the length of each array.
fn checks(value: &Value) -> usize {
    match value {
        Value::Object(map) => map.values().map(checks).sum(),
        Value::Array(items) => 1 + items.iter().map(checks).sum::<usize>(),
        _ => 1,
    }
}

/// Compare `expected` with `actual`, recording differences and returning the matched checks.
fn subset(path: &str, expected: &Value, actual: &Value, out: &mut Vec<Mismatch>) -> usize {
    match (expected, actual) {
        (Value::Object(want), Value::Object(have)) => {
            let mut matched = 0;
            for (key, want_value) in want {
                let child = format!("{path}/{key}");
                match have.get(key) {
                    Some(have_value) => matched += subset(&child, want_value, have_value, out),
                    None => out.push(Mismatch {
                        path: child,
                        expected: show(want_value),
                        actual: "<absent>".to_owned(),
                    }),
                }
            }
            matched
        }
        (Value::Array(want), Value::Array(have)) => {
            if want.len() != have.len() {
                out.push(Mismatch {
                    path: format!("{path} (length)"),
                    expected: want.len().to_string(),
                    actual: have.len().to_string(),
                });
                return 0;
            }
            1 + want
                .iter()
                .zip(have)
                .enumerate()
                .map(|(index, (w, h))| subset(&format!("{path}/{index}"), w, h, out))
                .sum::<usize>()
        }
        _ => {
            let equal = match (decimal(expected), decimal(actual)) {
                (Some(a), Some(b)) => a == b,
                _ => expected == actual,
            };
            if equal {
                checks(expected)
            } else {
                out.push(Mismatch {
                    path: path.to_owned(),
                    expected: show(expected),
                    actual: show(actual),
                });
                0
            }
        }
    }
}

/// Compare the `signals` section. Records are matched by `session`; the expectation may list
/// only the sessions it derives, and there is no length check.
fn signals(expected: &Value, actual: &Value, out: &mut Vec<Mismatch>) -> (usize, usize) {
    let (Some(want), Some(have)) = (expected.as_array(), actual.as_array()) else {
        out.push(Mismatch {
            path: "/signals".to_owned(),
            expected: show(expected),
            actual: show(actual),
        });
        return (checks(expected), 0);
    };
    let (mut total, mut matched) = (0, 0);
    for record in want {
        total += checks(record);
        let Some(session) = record.get("session").and_then(Value::as_str) else {
            out.push(Mismatch {
                path: "/signals".to_owned(),
                expected: show(record),
                actual: "<expected record has no session>".to_owned(),
            });
            continue;
        };
        let path = format!("/signals/{session}");
        match have
            .iter()
            .find(|h| h.get("session").and_then(Value::as_str) == Some(session))
        {
            Some(h) => matched += subset(&path, record, h, out),
            None => out.push(Mismatch {
                path,
                expected: show(record),
                actual: "<no signal record for this session>".to_owned(),
            }),
        }
    }
    (total, matched)
}

/// Compare `expected` (the `expect` object of `expected.json`) with `actual` and count checks.
#[must_use]
pub fn compare_detailed(expected: &Value, actual: &Value) -> Comparison {
    let mut comparison = Comparison::default();
    let Some(sections) = expected.as_object() else {
        comparison.mismatches.push(Mismatch {
            path: "/".to_owned(),
            expected: "an object".to_owned(),
            actual: show(expected),
        });
        return comparison;
    };
    for (section, want) in sections {
        let path = format!("/{section}");
        let before = comparison.mismatches.len();
        let (total, matched) = match actual.get(section) {
            None => {
                comparison.mismatches.push(Mismatch {
                    path,
                    expected: show(want),
                    actual: "<absent>".to_owned(),
                });
                (checks(want), 0)
            }
            Some(have) if section == "signals" => signals(want, have, &mut comparison.mismatches),
            Some(have) => (
                checks(want),
                subset(&path, want, have, &mut comparison.mismatches),
            ),
        };
        comparison.sections.push(SectionCount {
            section: section.clone(),
            expected: total,
            matched,
            differences: comparison.mismatches.len() - before,
        });
    }
    comparison
}

/// Compare `expected` (the `expect` object of `expected.json`) with `actual`.
#[must_use]
pub fn compare(expected: &Value, actual: &Value) -> Vec<Mismatch> {
    compare_detailed(expected, actual).mismatches
}

/// Number of checks the expectation states (scalars plus array lengths).
#[must_use]
pub fn count_expected(expected: &Value) -> usize {
    checks(expected)
}

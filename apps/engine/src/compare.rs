//! Compare an actual result view with an expected view.
//!
//! Only fields present in the expectation are compared, so each fixture states exactly what its
//! independent derivation covers. Arrays must have equal length, except `signals`, which are
//! matched by `session` so a case can list only the sessions it derives. Two strings that are
//! both plain decimals compare by value; every other value compares exactly.

use rust_decimal::Decimal;
use serde_json::Value;

/// One difference between expected and actual.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Mismatch {
    pub path: String,
    pub expected: String,
    pub actual: String,
}

fn show(value: &Value) -> String {
    value.to_string()
}

fn decimal(value: &Value) -> Option<Decimal> {
    let text = value.as_str()?;
    openquant_contracts::decimal::parse(text, 28).ok()
}

fn subset(path: &str, expected: &Value, actual: &Value, out: &mut Vec<Mismatch>) {
    match (expected, actual) {
        (Value::Object(want), Value::Object(have)) => {
            for (key, want_value) in want {
                let child = format!("{path}/{key}");
                match have.get(key) {
                    Some(have_value) => subset(&child, want_value, have_value, out),
                    None => out.push(Mismatch {
                        path: child,
                        expected: show(want_value),
                        actual: "<absent>".to_owned(),
                    }),
                }
            }
        }
        (Value::Array(want), Value::Array(have)) => {
            if want.len() != have.len() {
                out.push(Mismatch {
                    path: format!("{path} (length)"),
                    expected: want.len().to_string(),
                    actual: have.len().to_string(),
                });
                return;
            }
            for (index, (w, h)) in want.iter().zip(have).enumerate() {
                subset(&format!("{path}/{index}"), w, h, out);
            }
        }
        _ => {
            let equal = match (decimal(expected), decimal(actual)) {
                (Some(a), Some(b)) => a == b,
                _ => expected == actual,
            };
            if !equal {
                out.push(Mismatch {
                    path: path.to_owned(),
                    expected: show(expected),
                    actual: show(actual),
                });
            }
        }
    }
}

fn signals(expected: &Value, actual: &Value, out: &mut Vec<Mismatch>) {
    let (Some(want), Some(have)) = (expected.as_array(), actual.as_array()) else {
        out.push(Mismatch {
            path: "/signals".to_owned(),
            expected: show(expected),
            actual: show(actual),
        });
        return;
    };
    for record in want {
        let session = record.get("session");
        let found = have.iter().find(|h| h.get("session") == session);
        let path = format!(
            "/signals/{}",
            session.map_or_else(String::new, |s| s.as_str().unwrap_or("?").to_owned())
        );
        match found {
            Some(h) => subset(&path, record, h, out),
            None => out.push(Mismatch {
                path,
                expected: show(record),
                actual: "<no signal record for this session>".to_owned(),
            }),
        }
    }
}

/// Compare `expected` (the `expect` object of `expected.json`) with `actual`.
#[must_use]
pub fn compare(expected: &Value, actual: &Value) -> Vec<Mismatch> {
    let mut out = Vec::new();
    let Some(sections) = expected.as_object() else {
        out.push(Mismatch {
            path: "/".to_owned(),
            expected: "an object".to_owned(),
            actual: show(expected),
        });
        return out;
    };
    for (section, want) in sections {
        let path = format!("/{section}");
        match actual.get(section) {
            None => out.push(Mismatch {
                path,
                expected: show(want),
                actual: "<absent>".to_owned(),
            }),
            Some(have) if section == "signals" => signals(want, have, &mut out),
            Some(have) => subset(&path, want, have, &mut out),
        }
    }
    out
}

/// Number of leaf values the expectation states (for the report's coverage line).
#[must_use]
pub fn count_expected(expected: &Value) -> usize {
    match expected {
        Value::Object(map) => map.values().map(count_expected).sum(),
        Value::Array(items) => items.iter().map(count_expected).sum(),
        _ => 1,
    }
}

//! Canonical JSON (the RFC 8785 subset used here) and SHA-256 identities.
//!
//! Payloads hold only objects with ASCII keys, arrays, strings, integers, booleans and null.
//! Keys sort by byte order, which equals UTF-16 code-unit order for ASCII. Output has no
//! insignificant whitespace.

use serde_json::Value;
use sha2::{Digest as _, Sha256};

use crate::error::ContractError;

fn write_string(text: &str, out: &mut String) {
    out.push('"');
    for ch in text.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{08}' => out.push_str("\\b"),
            '\t' => out.push_str("\\t"),
            '\n' => out.push_str("\\n"),
            '\u{0c}' => out.push_str("\\f"),
            '\r' => out.push_str("\\r"),
            control if u32::from(control) < 0x20 => {
                out.push_str(&format!("\\u{:04x}", u32::from(control)));
            }
            other => out.push(other),
        }
    }
    out.push('"');
}

fn write_value(value: &Value, out: &mut String) -> Result<(), ContractError> {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(true) => out.push_str("true"),
        Value::Bool(false) => out.push_str("false"),
        Value::Number(number) => {
            if let Some(int) = number.as_i64() {
                out.push_str(&int.to_string());
            } else if let Some(uint) = number.as_u64() {
                out.push_str(&uint.to_string());
            } else {
                return Err(ContractError::Canonical(format!(
                    "non-integer number {number}"
                )));
            }
        }
        Value::String(text) => write_string(text, out),
        Value::Array(items) => {
            out.push('[');
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                write_value(item, out)?;
            }
            out.push(']');
        }
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            if let Some(bad) = keys.iter().find(|key| !key.is_ascii()) {
                return Err(ContractError::Canonical(format!(
                    "non-ASCII object key {bad:?}"
                )));
            }
            keys.sort();
            out.push('{');
            for (index, key) in keys.into_iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                write_string(key, out);
                out.push(':');
                if let Some(child) = map.get(key) {
                    write_value(child, out)?;
                }
            }
            out.push('}');
        }
    }
    Ok(())
}

/// Canonical JSON text of a value.
///
/// # Errors
/// Returns [`ContractError::Canonical`] for a non-integer number or a non-ASCII key.
pub fn canonical_json(value: &Value) -> Result<String, ContractError> {
    let mut out = String::new();
    write_value(value, &mut out)?;
    Ok(out)
}

/// `sha256:<64 lower-case hex>` of raw bytes.
#[must_use]
pub fn digest_bytes(bytes: &[u8]) -> String {
    let hash = Sha256::digest(bytes);
    let mut out = String::with_capacity(7 + 64);
    out.push_str("sha256:");
    for byte in hash.iter() {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

/// Identity digest of a value: SHA-256 over its canonical JSON.
///
/// # Errors
/// Returns [`ContractError::Canonical`] when the value cannot be canonicalised.
pub fn digest(value: &Value) -> Result<String, ContractError> {
    Ok(digest_bytes(canonical_json(value)?.as_bytes()))
}

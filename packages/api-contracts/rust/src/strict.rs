//! Strict JSON parsing: duplicate keys and non-integer numbers are errors.

use std::{collections::BTreeSet, fmt};

use serde::de::{self, Deserialize, Deserializer, MapAccess, SeqAccess, Visitor};
use serde_json::{Map, Number, Value};

use crate::error::ContractError;

/// Largest accepted payload. Inputs are bounded by schema `maxItems`; this bounds the parse.
pub const MAX_PAYLOAD_BYTES: usize = 16 * 1024 * 1024;

struct StrictValue(Value);

struct StrictVisitor;

impl<'de> Visitor<'de> for StrictVisitor {
    type Value = Value;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("a JSON value without floating-point numbers or duplicate keys")
    }

    fn visit_bool<E: de::Error>(self, v: bool) -> Result<Value, E> {
        Ok(Value::Bool(v))
    }

    fn visit_i64<E: de::Error>(self, v: i64) -> Result<Value, E> {
        Ok(Value::Number(Number::from(v)))
    }

    fn visit_u64<E: de::Error>(self, v: u64) -> Result<Value, E> {
        Ok(Value::Number(Number::from(v)))
    }

    fn visit_f64<E: de::Error>(self, _v: f64) -> Result<Value, E> {
        Err(E::custom("floating-point numbers are not allowed"))
    }

    fn visit_str<E: de::Error>(self, v: &str) -> Result<Value, E> {
        Ok(Value::String(v.to_owned()))
    }

    fn visit_string<E: de::Error>(self, v: String) -> Result<Value, E> {
        Ok(Value::String(v))
    }

    fn visit_none<E: de::Error>(self) -> Result<Value, E> {
        Ok(Value::Null)
    }

    fn visit_unit<E: de::Error>(self) -> Result<Value, E> {
        Ok(Value::Null)
    }

    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Value, A::Error> {
        let mut items = Vec::new();
        while let Some(StrictValue(item)) = seq.next_element()? {
            items.push(item);
        }
        Ok(Value::Array(items))
    }

    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Value, A::Error> {
        let mut seen = BTreeSet::new();
        let mut out = Map::new();
        while let Some(key) = map.next_key::<String>()? {
            if !seen.insert(key.clone()) {
                return Err(de::Error::custom(format!("duplicate object key: {key}")));
            }
            let StrictValue(value) = map.next_value()?;
            out.insert(key, value);
        }
        Ok(Value::Object(out))
    }
}

impl<'de> Deserialize<'de> for StrictValue {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        deserializer.deserialize_any(StrictVisitor).map(StrictValue)
    }
}

/// Parse JSON text. Rejects duplicate keys, floats, exponents and trailing text.
///
/// # Errors
/// Returns [`ContractError`] when the text is malformed or breaks a strictness rule.
pub fn parse_json(text: &str) -> Result<Value, ContractError> {
    if text.len() > MAX_PAYLOAD_BYTES {
        return Err(ContractError::TooLarge {
            limit: MAX_PAYLOAD_BYTES,
        });
    }
    match serde_json::from_str::<StrictValue>(text) {
        Ok(StrictValue(value)) => Ok(value),
        Err(error) => {
            let message = error.to_string();
            if let Some((_, rest)) = message.split_once("duplicate object key: ") {
                let key = rest.split(" at line").next().unwrap_or(rest).to_owned();
                Err(ContractError::DuplicateKey(key))
            } else if message.contains("floating-point") {
                Err(ContractError::FloatNumber)
            } else {
                Err(ContractError::Json(message))
            }
        }
    }
}

//! Strict decimal strings. Money, prices, quantities and indicator values use this grammar.

use rust_decimal::{Decimal, RoundingStrategy};

use crate::error::ContractError;

fn reject(value: &str, reason: &str) -> ContractError {
    ContractError::Decimal {
        value: value.to_owned(),
        reason: reason.to_owned(),
    }
}

/// Check the wire grammar: optional minus, no exponent, no plus, no leading zeros,
/// at least one digit on each side of a point, and no negative zero.
fn check_grammar(text: &str) -> Result<(), ContractError> {
    let unsigned = text.strip_prefix('-').unwrap_or(text);
    let negative = unsigned.len() != text.len();
    let (int_part, frac_part) = match unsigned.split_once('.') {
        Some((int_part, frac_part)) => (int_part, Some(frac_part)),
        None => (unsigned, None),
    };
    if int_part.is_empty() || !int_part.bytes().all(|b| b.is_ascii_digit()) {
        return Err(reject(text, "integer part must be digits"));
    }
    if int_part.len() > 1 && int_part.starts_with('0') {
        return Err(reject(text, "leading zero"));
    }
    if let Some(frac) = frac_part
        && (frac.is_empty() || !frac.bytes().all(|b| b.is_ascii_digit()))
    {
        return Err(reject(text, "fraction must be one or more digits"));
    }
    let all_zero = int_part.bytes().all(|b| b == b'0')
        && frac_part.is_none_or(|frac| frac.bytes().all(|b| b == b'0'));
    if negative && all_zero {
        return Err(reject(text, "negative zero"));
    }
    Ok(())
}

/// Parse a decimal string exactly.
///
/// # Errors
/// Returns [`ContractError::Decimal`] for a grammar violation, a value that does not fit in
/// 96 bits, or more than `max_scale` fractional digits.
pub fn parse(text: &str, max_scale: u32) -> Result<Decimal, ContractError> {
    check_grammar(text)?;
    let value = Decimal::from_str_exact(text).map_err(|_| reject(text, "value out of range"))?;
    if value.scale() > max_scale {
        return Err(reject(
            text,
            "more fractional digits than the declared scale",
        ));
    }
    Ok(value)
}

/// Format at exactly `scale` fractional digits without rounding.
///
/// # Errors
/// Returns [`ContractError::Decimal`] if the value has digits beyond `scale`.
pub fn format(value: &Decimal, scale: u32) -> Result<String, ContractError> {
    let truncated = value.round_dp_with_strategy(scale, RoundingStrategy::ToZero);
    if truncated != *value {
        return Err(reject(
            &value.to_string(),
            "value has digits beyond the scale",
        ));
    }
    let mut out = truncated;
    out.rescale(scale);
    if out.is_zero() {
        out = Decimal::new(0, scale);
    }
    Ok(out.to_string())
}

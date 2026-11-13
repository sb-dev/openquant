//! The `Exact` wire value: an exact rational for state that feeds a price-grid decision.
//!
//! A value is written one way only (the canonical rule, enforced here and not by the schema
//! pattern):
//!
//! - a value that terminates within 28 fractional digits and fits a [`Decimal`] is a normalised
//!   decimal, the same grammar as every other decimal on the wire (see [`crate::decimal`]);
//! - any other value is a reduced fraction `n/d`: `n` is a non-zero integer, `d` an integer above
//!   1, both written without a plus sign, leading zeros or exponent, and both within a signed
//!   128-bit integer (the numerator excludes `i128::MIN`, so its sign can always be flipped).
//!
//! The reader accepts the first form with any trailing zeros, as for any decimal. It rejects a
//! fraction that is not reduced, has denominator 1, could be written as a decimal, or does not fit
//! 128 bits. Every rejection is [`ContractError::Decimal`], which reports `INVALID_DECIMAL`, the
//! code of a malformed decimal.

use rust_decimal::Decimal;

use crate::{decimal, error::ContractError};

/// Longest `Exact` text, as in the schema (`maxLength`).
pub const MAX_LEN: usize = 80;

/// A parsed `Exact` value.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Exact {
    /// A decimal, as written.
    Decimal(Decimal),
    /// A canonical fraction: reduced, `denominator > 1`, not representable as a decimal.
    Fraction { numerator: i128, denominator: i128 },
}

fn reject(value: &str, reason: &str) -> ContractError {
    ContractError::Decimal {
        value: value.to_owned(),
        reason: reason.to_owned(),
    }
}

fn gcd(a: u128, b: u128) -> u128 {
    let (mut a, mut b) = (a, b);
    while b != 0 {
        (a, b) = (b, a % b);
    }
    a
}

/// The value `numerator / denominator` as a normalised decimal, when it terminates within 28
/// fractional digits and its digits fit a [`Decimal`]. `None` otherwise (and for a denominator
/// that is not positive).
///
/// The canonical rule uses this one function on both sides: a value for which it returns `Some`
/// is written as a decimal and a fraction with such a value is rejected.
#[must_use]
pub fn terminating(numerator: i128, denominator: i128) -> Option<Decimal> {
    if denominator <= 0 {
        return None;
    }
    let mut power: i128 = 1;
    for scale in 0..=Decimal::MAX_SCALE {
        if power % denominator == 0 {
            let mantissa = numerator.checked_mul(power / denominator)?;
            return Decimal::try_from_i128_with_scale(mantissa, scale)
                .ok()
                .map(|d| d.normalize());
        }
        power = power.checked_mul(10)?;
    }
    None
}

/// `text` as `digits` with an optional minus sign: no plus, no leading zero, not zero.
fn nonzero_integer<'a>(text: &'a str, whole: &str, signed: bool) -> Result<&'a str, ContractError> {
    let digits = if signed {
        text.strip_prefix('-').unwrap_or(text)
    } else {
        text
    };
    let mut bytes = digits.bytes();
    match bytes.next() {
        None => Err(reject(
            whole,
            "a fraction needs a numerator and a denominator",
        )),
        Some(b'0') => Err(reject(
            whole,
            "a fraction part has no leading zero and is not zero",
        )),
        Some(first) if first.is_ascii_digit() && bytes.all(|b| b.is_ascii_digit()) => Ok(text),
        Some(_) => Err(reject(whole, "a fraction part is digits only")),
    }
}

fn parse_fraction(whole: &str, numerator: &str, denominator: &str) -> Result<Exact, ContractError> {
    let numerator = nonzero_integer(numerator, whole, true)?
        .parse::<i128>()
        .map_err(|_| reject(whole, "numerator does not fit 128 bits"))?;
    let denominator = nonzero_integer(denominator, whole, false)?
        .parse::<i128>()
        .map_err(|_| reject(whole, "denominator does not fit 128 bits"))?;
    if numerator == i128::MIN {
        return Err(reject(whole, "numerator does not fit 128 bits"));
    }
    if denominator == 1 {
        return Err(reject(
            whole,
            "denominator 1: write an integer as a decimal",
        ));
    }
    if gcd(numerator.unsigned_abs(), denominator.unsigned_abs()) != 1 {
        return Err(reject(whole, "fraction is not reduced"));
    }
    if terminating(numerator, denominator).is_some() {
        return Err(reject(
            whole,
            "the value has a decimal form: write it as a decimal",
        ));
    }
    Ok(Exact::Fraction {
        numerator,
        denominator,
    })
}

/// Parse `Exact` text.
///
/// # Errors
/// [`ContractError::Decimal`] for text longer than [`MAX_LEN`], a decimal that breaks the decimal
/// grammar or does not fit 96 bits, or a fraction that breaks the grammar, does not fit 128 bits,
/// is not reduced, has denominator 1, or has a decimal form.
pub fn parse(text: &str) -> Result<Exact, ContractError> {
    if text.len() > MAX_LEN {
        return Err(reject(text, "longer than 80 characters"));
    }
    match text.split_once('/') {
        None => decimal::parse(text, Decimal::MAX_SCALE).map(Exact::Decimal),
        Some((numerator, denominator)) => parse_fraction(text, numerator, denominator),
    }
}

/// The canonical text of `numerator / denominator`.
///
/// # Errors
/// [`ContractError::Decimal`] when the denominator is not positive, the numerator is `i128::MIN`,
/// or the value is an integer or other non-terminating value that has no canonical form: an
/// integer that does not fit a [`Decimal`] cannot be written, because a fraction needs a
/// denominator above 1.
pub fn format(numerator: i128, denominator: i128) -> Result<String, ContractError> {
    let shown = format!("{numerator}/{denominator}");
    if denominator <= 0 || numerator == i128::MIN {
        return Err(reject(&shown, "not a canonical fraction"));
    }
    if let Some(value) = terminating(numerator, denominator) {
        return Ok(if value.is_zero() {
            "0".to_owned()
        } else {
            value.to_string()
        });
    }
    if numerator == 0 || denominator == 1 {
        return Err(reject(&shown, "the value is too large to write exactly"));
    }
    if gcd(numerator.unsigned_abs(), denominator.unsigned_abs()) != 1 {
        return Err(reject(&shown, "fraction is not reduced"));
    }
    Ok(shown)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn terminating_picks_the_shortest_decimal() {
        assert_eq!(terminating(1, 2), Decimal::try_new(5, 1).ok());
        assert_eq!(terminating(5, 1), Some(Decimal::from(5)));
        assert_eq!(terminating(-7, 4), Decimal::try_new(-175, 2).ok());
        assert_eq!(terminating(1, 3), None);
        assert_eq!(terminating(1, 0), None);
        assert_eq!(terminating(1, -2), None);
        // 2^28 has a 28-digit expansion and 2^29 a 29-digit one.
        assert!(terminating(1, 1_i128 << 28).is_some());
        assert_eq!(terminating(1, 1_i128 << 29), None);
    }
}

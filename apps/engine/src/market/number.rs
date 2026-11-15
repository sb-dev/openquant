//! Exact decimal text for provider numbers. No float is ever created.
//!
//! A provider writes a price as a JSON number (`125.07`, `1e2`). The adapter keeps the token text
//! of the response, and this module turns it into the canonical decimal string of the wire
//! contracts by shifting digits: no exponent, no leading zeros, no trailing fractional zeros. A
//! value is accepted only when it fits the 28 significant digits and 28 fractional digits of the
//! core's decimal type, so an exact comparison through `rust_decimal` is always possible.

use std::{cmp::Ordering, fmt};

use rust_decimal::Decimal;

/// Most significant digits and most fractional digits the core's decimal type holds.
pub const MAX_DIGITS: usize = 28;

/// The largest scale of a price that the S1 pilot accepts. A scale above it blocks the profile.
pub const MAX_PRICE_SCALE: u32 = 4;

/// Why a number token was refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NumberError {
    /// The text is not a JSON number (a quoted number, an empty token, a leading plus).
    NotANumber,
    /// The exponent is beyond what a 28-digit value can use.
    ExponentTooLarge,
    /// More than 28 significant digits or 28 fractional digits.
    TooManyDigits,
    /// A negative zero (`-0`, `-0.0`) has no wire form.
    NegativeZero,
}

impl fmt::Display for NumberError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::NotANumber => "not a JSON number",
            Self::ExponentTooLarge => "exponent out of range",
            Self::TooManyDigits => "more than 28 significant or fractional digits",
            Self::NegativeZero => "negative zero",
        })
    }
}

impl std::error::Error for NumberError {}

/// A decimal in canonical text form: `-?(0|[1-9][0-9]*)(\.[0-9]*[1-9])?`.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct DecimalText(String);

impl DecimalText {
    /// Canonical text of a JSON number token such as `125.07`, `1.5E+3` or `1e-5`.
    ///
    /// # Errors
    /// [`NumberError`] when the token is not a JSON number, cannot be held in 28 digits or is a
    /// negative zero.
    pub fn from_json_number(token: &str) -> Result<Self, NumberError> {
        let token = token.trim_matches([' ', '\t', '\r', '\n']);
        let (negative, rest) = match token.strip_prefix('-') {
            Some(rest) => (true, rest),
            None => (false, token),
        };
        let (mantissa, exponent) = match rest.split_once(['e', 'E']) {
            Some((mantissa, exponent)) => (mantissa, Some(exponent)),
            None => (rest, None),
        };
        let (int_digits, frac_digits) = match mantissa.split_once('.') {
            Some((int_digits, frac_digits)) => (int_digits, Some(frac_digits)),
            None => (mantissa, None),
        };
        if !valid_integer_part(int_digits) || frac_digits.is_some_and(|f| !all_digits(f)) {
            return Err(NumberError::NotANumber);
        }
        let exponent = match exponent {
            Some(text) => parse_exponent(text)?,
            None => 0,
        };
        let frac_digits = frac_digits.unwrap_or("");
        let digits: String = format!("{int_digits}{frac_digits}");
        // Digits before the decimal point after the exponent is applied.
        let int_len = i64::try_from(int_digits.len()).map_err(|_| NumberError::TooManyDigits)?;
        let point = int_len + exponent;
        let significant = digits.trim_start_matches('0');
        if significant.is_empty() {
            return if negative {
                Err(NumberError::NegativeZero)
            } else {
                Ok(Self("0".to_owned()))
            };
        }
        let leading_zeros = digits.len() - significant.len();
        let leading = i64::try_from(leading_zeros).map_err(|_| NumberError::TooManyDigits)?;
        // `significant` starts at digit position `leading`; its decimal point sits at `point - leading`.
        let significant = significant.trim_end_matches('0');
        let point = point - leading;
        let sig_len = i64::try_from(significant.len()).map_err(|_| NumberError::TooManyDigits)?;
        if significant.len() > MAX_DIGITS {
            return Err(NumberError::TooManyDigits);
        }
        let (int_part, frac_part) = if point <= 0 {
            let zeros = usize::try_from(-point).map_err(|_| NumberError::TooManyDigits)?;
            (
                "0".to_owned(),
                format!("{}{significant}", "0".repeat(zeros)),
            )
        } else if point >= sig_len {
            let zeros = usize::try_from(point - sig_len).map_err(|_| NumberError::TooManyDigits)?;
            (format!("{significant}{}", "0".repeat(zeros)), String::new())
        } else {
            let split = usize::try_from(point).map_err(|_| NumberError::TooManyDigits)?;
            let (int_part, frac_part) = significant
                .split_at_checked(split)
                .ok_or(NumberError::NotANumber)?;
            (int_part.to_owned(), frac_part.to_owned())
        };
        if frac_part.len() > MAX_DIGITS || int_part.len() > MAX_DIGITS {
            return Err(NumberError::TooManyDigits);
        }
        let mut text = String::new();
        if negative {
            text.push('-');
        }
        text.push_str(&int_part);
        if !frac_part.is_empty() {
            text.push('.');
            text.push_str(&frac_part);
        }
        Ok(Self(text))
    }

    /// The canonical text.
    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// Whether the value is negative.
    #[must_use]
    pub fn is_negative(&self) -> bool {
        self.0.starts_with('-')
    }

    /// Whether the value is zero.
    #[must_use]
    pub fn is_zero(&self) -> bool {
        self.0 == "0"
    }

    /// Number of fractional digits (there are no trailing zeros, so this is the exact scale).
    #[must_use]
    pub fn scale(&self) -> u32 {
        self.0
            .split_once('.')
            .map_or(0, |(_, frac)| u32::try_from(frac.len()).unwrap_or(u32::MAX))
    }

    /// Whether the value has no fractional part.
    #[must_use]
    pub fn is_integer(&self) -> bool {
        !self.0.contains('.')
    }

    /// The value as an exact `rust_decimal::Decimal`, or `None` when it does not fit 96 bits.
    #[must_use]
    pub fn to_decimal(&self) -> Option<Decimal> {
        Decimal::from_str_exact(&self.0).ok()
    }

    /// Exact comparison of two values, or `None` when either does not fit the decimal type.
    #[must_use]
    pub fn compare(&self, other: &Self) -> Option<Ordering> {
        Some(self.to_decimal()?.cmp(&other.to_decimal()?))
    }
}

impl fmt::Display for DecimalText {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

fn all_digits(text: &str) -> bool {
    !text.is_empty() && text.bytes().all(|b| b.is_ascii_digit())
}

/// A JSON integer part: `0`, or a digit 1 to 9 followed by digits.
fn valid_integer_part(text: &str) -> bool {
    all_digits(text) && (text == "0" || !text.starts_with('0'))
}

/// Exponents beyond this cannot move a 28-digit value into range.
const MAX_EXPONENT: i64 = 64;

fn parse_exponent(text: &str) -> Result<i64, NumberError> {
    let (negative, digits) = match text.strip_prefix('-') {
        Some(rest) => (true, rest),
        None => (false, text.strip_prefix('+').unwrap_or(text)),
    };
    if !all_digits(digits) {
        return Err(NumberError::NotANumber);
    }
    let magnitude: i64 = digits.trim_start_matches('0').parse::<i64>().unwrap_or(
        if digits.bytes().all(|b| b == b'0') {
            0
        } else {
            i64::MAX
        },
    );
    if magnitude > MAX_EXPONENT {
        return Err(NumberError::ExponentTooLarge);
    }
    Ok(if negative { -magnitude } else { magnitude })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn canon(token: &str) -> String {
        DecimalText::from_json_number(token).unwrap().to_string()
    }

    #[test]
    fn plain_and_trailing_zero_forms_become_minimal() {
        assert_eq!(canon("125.07"), "125.07");
        assert_eq!(canon("125.10"), "125.1");
        assert_eq!(canon("125.00"), "125");
        assert_eq!(canon("0"), "0");
        assert_eq!(canon("0.0"), "0");
        assert_eq!(canon("0.50"), "0.5");
        assert_eq!(canon("100"), "100");
        assert_eq!(canon("1000000"), "1000000");
        assert_eq!(canon("-3.25"), "-3.25");
    }

    #[test]
    fn exponents_shift_digits_without_a_float() {
        assert_eq!(canon("1e2"), "100");
        assert_eq!(canon("1.5E+3"), "1500");
        assert_eq!(canon("1e-5"), "0.00001");
        assert_eq!(canon("12.345e1"), "123.45");
        assert_eq!(canon("12.345e-1"), "1.2345");
        assert_eq!(canon("0.00120e2"), "0.12");
        assert_eq!(canon("1e0"), "1");
        assert_eq!(canon("0e5"), "0");
    }

    #[test]
    fn seventeen_digits_survive_exactly() {
        // A double holds about 15.95 digits; the text must not pass through one.
        assert_eq!(canon("0.12345678901234567"), "0.12345678901234567");
        assert_eq!(
            canon("123456789.12345678901234567"),
            "123456789.12345678901234567"
        );
        assert_eq!(canon("9007199254740993"), "9007199254740993");
    }

    #[test]
    fn limits_and_malformed_tokens_are_refused() {
        assert_eq!(
            DecimalText::from_json_number("-0"),
            Err(NumberError::NegativeZero)
        );
        assert_eq!(
            DecimalText::from_json_number("-0.0e3"),
            Err(NumberError::NegativeZero)
        );
        // 29 significant digits.
        assert_eq!(
            DecimalText::from_json_number("1.2345678901234567890123456789"),
            Err(NumberError::TooManyDigits)
        );
        assert_eq!(
            DecimalText::from_json_number("1e100"),
            Err(NumberError::ExponentTooLarge)
        );
        for bad in [
            "\"125.07\"",
            "",
            "+1",
            "01",
            "1.",
            ".5",
            "1e",
            "1e+",
            "NaN",
            "0x10",
            "1,5",
            "--1",
            "1.2.3",
        ] {
            assert_eq!(
                DecimalText::from_json_number(bad),
                Err(NumberError::NotANumber),
                "{bad}"
            );
        }
        // 28 fractional digits are the most.
        assert!(DecimalText::from_json_number("0.0000000000000000000000000001").is_ok());
        assert_eq!(
            DecimalText::from_json_number("0.00000000000000000000000000001"),
            Err(NumberError::TooManyDigits)
        );
    }

    #[test]
    fn scale_integer_and_exact_comparison() {
        let a = DecimalText::from_json_number("125.07").unwrap();
        let b = DecimalText::from_json_number("125.070").unwrap();
        let c = DecimalText::from_json_number("125.08").unwrap();
        assert_eq!(a, b);
        assert_eq!(a.scale(), 2);
        assert!(!a.is_integer());
        assert!(DecimalText::from_json_number("125").unwrap().is_integer());
        assert_eq!(a.compare(&c), Some(Ordering::Less));
        assert_eq!(c.compare(&a), Some(Ordering::Greater));
        assert_eq!(a.compare(&b), Some(Ordering::Equal));
        assert!(DecimalText::from_json_number("-1").unwrap().is_negative());
        assert!(DecimalText::from_json_number("0").unwrap().is_zero());
    }
}

//! Exact rational numbers of unbounded size, for derived evidence (OQ-02 section 3.6).
//!
//! The evaluator keeps its levels as [`crate::ratio::Ratio`], a fraction of two 128-bit integers.
//! That is enough for a price-grid decision and too small for evidence: a mean of ratios over
//! 250 sessions has a denominator that the product of 250 equities makes far wider than 128 bits.
//! Metrics, benchmarks and gates therefore use [`Q`], a fraction of two big integers. Every
//! operation computes the mathematical result. Nothing rounds except [`Q::to_fixed`], which
//! rounds once, half-even, when a value is written.
//!
//! No floating-point type appears here or in the callers: a decimal text is read digit by digit
//! into a fraction, and a fraction is written digit by digit from integers.
//!
//! `Q` is never used by the evaluator. The numerical result of a run does not depend on it.

use std::{cmp::Ordering, fmt, ops};

use num_bigint::{BigInt, Sign};
use rust_decimal::Decimal;
use thiserror::Error;

/// A failure of exact arithmetic or of reading a decimal.
#[derive(Clone, Debug, Error, PartialEq, Eq)]
pub enum ExactError {
    #[error("division by zero")]
    DivisionByZero,
    #[error("{0:?} is not a decimal in the wire grammar")]
    InvalidDecimal(String),
    #[error("scale {0} is larger than the 60 fractional digits this module writes")]
    ScaleTooLarge(u32),
}

/// Largest scale [`Q::to_fixed`] writes. The schemas allow at most 12.
const MAX_SCALE: u32 = 60;

/// An exact fraction `num / den`, always reduced, with a positive denominator. Zero is `0 / 1`.
///
/// Reduction is canonical, so equal values have equal fields and `==` agrees with the order.
#[derive(Clone, PartialEq, Eq, Hash)]
pub struct Q {
    num: BigInt,
    den: BigInt,
}

fn gcd(a: &BigInt, b: &BigInt) -> BigInt {
    let mut a = BigInt::from_biguint(Sign::Plus, a.magnitude().clone());
    let mut b = BigInt::from_biguint(Sign::Plus, b.magnitude().clone());
    while b.sign() != Sign::NoSign {
        let r = &a % &b;
        a = b;
        b = r;
    }
    a
}

fn pow10(scale: u32) -> BigInt {
    BigInt::from(10).pow(scale)
}

impl Q {
    /// The value zero.
    #[must_use]
    pub fn zero() -> Self {
        Self {
            num: BigInt::from(0),
            den: BigInt::from(1),
        }
    }

    /// The value one.
    #[must_use]
    pub fn one() -> Self {
        Self::from_int(1)
    }

    /// An integer.
    #[must_use]
    pub fn from_int(value: i64) -> Self {
        Self {
            num: BigInt::from(value),
            den: BigInt::from(1),
        }
    }

    /// An integer of any size.
    #[must_use]
    pub fn from_big(value: BigInt) -> Self {
        Self {
            num: value,
            den: BigInt::from(1),
        }
    }

    /// `num / den`, reduced.
    ///
    /// # Errors
    /// [`ExactError::DivisionByZero`] when `den` is zero.
    pub fn new(num: BigInt, den: BigInt) -> Result<Self, ExactError> {
        if den.sign() == Sign::NoSign {
            return Err(ExactError::DivisionByZero);
        }
        Ok(Self::normalise(num, den))
    }

    fn normalise(num: BigInt, den: BigInt) -> Self {
        if num.sign() == Sign::NoSign {
            return Self::zero();
        }
        let (num, den) = if den.sign() == Sign::Minus {
            (-num, -den)
        } else {
            (num, den)
        };
        let divisor = gcd(&num, &den);
        if divisor == BigInt::from(1) {
            Self { num, den }
        } else {
            Self {
                num: num / &divisor,
                den: den / &divisor,
            }
        }
    }

    /// The exact value of a decimal that the evaluator holds.
    #[must_use]
    pub fn from_decimal(value: &Decimal) -> Self {
        Self::normalise(BigInt::from(value.mantissa()), pow10(value.scale()))
    }

    /// Read decimal text in the wire grammar: an optional `-`, digits, and optionally `.` with
    /// digits. No plus sign, no exponent, no spaces. The value is exact.
    ///
    /// # Errors
    /// [`ExactError::InvalidDecimal`] for any other text.
    pub fn parse(text: &str) -> Result<Self, ExactError> {
        let bad = || ExactError::InvalidDecimal(text.to_owned());
        let (negative, body) = match text.strip_prefix('-') {
            Some(rest) => (true, rest),
            None => (false, text),
        };
        let (whole, fraction) = match body.split_once('.') {
            Some((whole, fraction)) => (whole, fraction),
            None => (body, ""),
        };
        let digits = |part: &str| part.bytes().all(|b| b.is_ascii_digit());
        if whole.is_empty() || !digits(whole) || !digits(fraction) {
            return Err(bad());
        }
        if body.contains('.') && fraction.is_empty() {
            return Err(bad());
        }
        let scale = u32::try_from(fraction.len()).map_err(|_| bad())?;
        let joined = format!("{whole}{fraction}");
        let magnitude = BigInt::parse_bytes(joined.as_bytes(), 10).ok_or_else(bad)?;
        let signed = if negative { -magnitude } else { magnitude };
        Ok(Self::normalise(signed, pow10(scale)))
    }

    /// Whether the value is zero.
    #[must_use]
    pub fn is_zero(&self) -> bool {
        self.num.sign() == Sign::NoSign
    }

    /// Whether the value is below zero.
    #[must_use]
    pub fn is_negative(&self) -> bool {
        self.num.sign() == Sign::Minus
    }

    /// Whether the value is above zero.
    #[must_use]
    pub fn is_positive(&self) -> bool {
        self.num.sign() == Sign::Plus
    }

    /// The value with its sign flipped.
    #[must_use]
    pub fn neg(&self) -> Self {
        Self {
            num: -self.num.clone(),
            den: self.den.clone(),
        }
    }

    /// The absolute value.
    #[must_use]
    pub fn abs(&self) -> Self {
        if self.is_negative() {
            self.neg()
        } else {
            self.clone()
        }
    }

    /// `self / other`.
    ///
    /// # Errors
    /// [`ExactError::DivisionByZero`] when `other` is zero.
    pub fn checked_div(&self, other: &Self) -> Result<Self, ExactError> {
        if other.is_zero() {
            return Err(ExactError::DivisionByZero);
        }
        Ok(Self::normalise(
            &self.num * &other.den,
            &self.den * &other.num,
        ))
    }

    /// The sum of `terms`, reduced once at the end. The running denominator is the product of the
    /// terms' denominators, so the sum costs one reduction, not one per term.
    pub fn sum<'a>(terms: impl IntoIterator<Item = &'a Self>) -> Self {
        let mut num = BigInt::from(0);
        let mut den = BigInt::from(1);
        for term in terms {
            num = &num * &term.den + &term.num * &den;
            den = &den * &term.den;
        }
        Self::normalise(num, den)
    }

    /// The value rounded once, half-even, to `scale` fractional digits and written as plain
    /// decimal text with exactly `scale` digits after the point (none for scale 0). A value that
    /// rounds to zero is written without a sign, so `-0.000000` never appears.
    ///
    /// # Errors
    /// [`ExactError::ScaleTooLarge`] above 60 fractional digits.
    pub fn to_fixed(&self, scale: u32) -> Result<String, ExactError> {
        if scale > MAX_SCALE {
            return Err(ExactError::ScaleTooLarge(scale));
        }
        let scaled = self.num.magnitude() * pow10(scale).magnitude();
        let den = self.den.magnitude();
        let quotient = &scaled / den;
        let remainder = &scaled % den;
        let twice = &remainder + &remainder;
        let one = num_bigint::BigUint::from(1_u8);
        let round_up = match twice.cmp(den) {
            Ordering::Greater => true,
            Ordering::Equal => (&quotient % 2_u8) == one,
            Ordering::Less => false,
        };
        let rounded = if round_up { quotient + one } else { quotient };
        let zero = rounded == num_bigint::BigUint::from(0_u8);
        let mut digits = rounded.to_string();
        let width = usize::try_from(scale).unwrap_or(0);
        if digits.len() <= width {
            digits = format!("{}{digits}", "0".repeat(width + 1 - digits.len()));
        }
        let split = digits.len() - width;
        let (whole, fraction) = digits.split_at(split);
        let sign = if self.is_negative() && !zero { "-" } else { "" };
        if width == 0 {
            Ok(format!("{sign}{whole}"))
        } else {
            Ok(format!("{sign}{whole}.{fraction}"))
        }
    }

    /// The value as an `i64`, when it is an integer that fits.
    #[must_use]
    pub fn to_i64(&self) -> Option<i64> {
        if self.den == BigInt::from(1) {
            i64::try_from(&self.num).ok()
        } else {
            None
        }
    }
}

impl PartialOrd for Q {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for Q {
    fn cmp(&self, other: &Self) -> Ordering {
        // Both denominators are positive, so cross-multiplication keeps the order.
        (&self.num * &other.den).cmp(&(&other.num * &self.den))
    }
}

impl fmt::Debug for Q {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}/{}", self.num, self.den)
    }
}

impl fmt::Display for Q {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        if self.den == BigInt::from(1) {
            write!(f, "{}", self.num)
        } else {
            write!(f, "{}/{}", self.num, self.den)
        }
    }
}

impl ops::Add for &Q {
    type Output = Q;

    fn add(self, other: &Q) -> Q {
        Q::normalise(
            &self.num * &other.den + &other.num * &self.den,
            &self.den * &other.den,
        )
    }
}

impl ops::Sub for &Q {
    type Output = Q;

    fn sub(self, other: &Q) -> Q {
        Q::normalise(
            &self.num * &other.den - &other.num * &self.den,
            &self.den * &other.den,
        )
    }
}

impl ops::Mul for &Q {
    type Output = Q;

    fn mul(self, other: &Q) -> Q {
        Q::normalise(&self.num * &other.num, &self.den * &other.den)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn q(text: &str) -> Q {
        Q::parse(text).unwrap()
    }

    #[test]
    fn reads_decimals_exactly() {
        assert_eq!(q("0.25"), Q::new(BigInt::from(1), BigInt::from(4)).unwrap());
        assert_eq!(q("-12.50").to_string(), "-25/2");
        assert_eq!(q("100").to_string(), "100");
        assert_eq!(q("000.5").to_string(), "1/2");
        for bad in [
            "", "-", ".5", "5.", "+1", "1e3", "1 ", "--1", "1.2.3", "0x1",
        ] {
            assert!(Q::parse(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn half_even_rounding_follows_the_digit_before_a_tie() {
        // 0.125 sits exactly between 0.12 and 0.13: the even digit is 2.
        assert_eq!(q("0.125").to_fixed(2).unwrap(), "0.12");
        assert_eq!(q("0.135").to_fixed(2).unwrap(), "0.14");
        assert_eq!(q("-0.125").to_fixed(2).unwrap(), "-0.12");
        assert_eq!(q("-0.135").to_fixed(2).unwrap(), "-0.14");
        // Just off a tie rounds to the nearer neighbour whatever its parity.
        assert_eq!(q("0.1251").to_fixed(2).unwrap(), "0.13");
        assert_eq!(q("0.1249").to_fixed(2).unwrap(), "0.12");
        assert_eq!(q("2.5").to_fixed(0).unwrap(), "2");
        assert_eq!(q("3.5").to_fixed(0).unwrap(), "4");
    }

    #[test]
    fn zero_never_carries_a_sign_and_digits_are_padded() {
        assert_eq!(q("-0.0000004").to_fixed(6).unwrap(), "0.000000");
        assert_eq!(q("-0.0000005").to_fixed(6).unwrap(), "0.000000");
        assert_eq!(q("-0.0000006").to_fixed(6).unwrap(), "-0.000001");
        assert_eq!(Q::zero().to_fixed(0).unwrap(), "0");
        assert_eq!(q("0.05").to_fixed(6).unwrap(), "0.050000");
        assert_eq!(q("123").to_fixed(2).unwrap(), "123.00");
        assert!(Q::zero().to_fixed(61).is_err());
    }

    #[test]
    fn arithmetic_is_exact_beyond_128_bits() {
        // 1/3 + 1/3 + 1/3 is exactly one, with no rounding on the way.
        let third = Q::one().checked_div(&Q::from_int(3)).unwrap();
        assert_eq!(&(&third + &third) + &third, Q::one());
        // A sum with a denominator far above 2^128 stays exact.
        let mut terms = Vec::new();
        for n in 1..=60_i64 {
            terms.push(Q::one().checked_div(&Q::from_int(n * n + 1)).unwrap());
        }
        let total = Q::sum(terms.iter());
        let mut stepwise = Q::zero();
        for term in &terms {
            stepwise = &stepwise + term;
        }
        assert_eq!(total, stepwise);
        // The denominator is above 2^128, which a 128-bit fraction cannot hold.
        assert!(total.to_string().len() > 80, "{total}");
    }

    #[test]
    fn division_by_zero_is_a_typed_error() {
        assert_eq!(
            Q::one().checked_div(&Q::zero()),
            Err(ExactError::DivisionByZero)
        );
        assert!(Q::new(BigInt::from(1), BigInt::from(0)).is_err());
    }

    #[test]
    fn decimals_from_the_evaluator_convert_exactly() {
        let value = Decimal::new(-12_345, 3);
        assert_eq!(Q::from_decimal(&value), q("-12.345"));
        assert_eq!(Q::from_decimal(&Decimal::new(500, 2)), Q::from_int(5));
    }
}

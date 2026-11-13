//! Exact rational numbers for every value that feeds a price-grid decision (OQ-02 sections 2.2
//! and 2.5).
//!
//! # What is exact
//!
//! A [`Ratio`] is a fraction of two signed 128-bit integers, always reduced, with a positive
//! denominator. `add`, `sub`, `mul` and `div` compute the mathematical result with no rounding.
//! A level that is `5 + 3 * (0.67 / 3)` is exactly `5.67`, so a high of `5.67` touches it, and
//! `6 * (5 / 6)` is exactly `5`. Comparison is exact as well, and never overflows.
//!
//! The evaluator, the levels held by a position (entry price, stop, target, scheduled stop,
//! snapshots), the split conversion of those levels, and every decision taken on them use this
//! type. Money, quantities, caps, fees, marks and ranks stay [`Decimal`] with the rounding rules
//! of OQ-02 section 2.5. A level meets the price grid in one place only: the fill price of a
//! touched level is `floor_to(price_scale)` of the exact level.
//!
//! # What happens on overflow
//!
//! The exactness domain is the set of fractions whose numerator and denominator both fit a
//! signed 128-bit integer (the numerator never equals `i128::MIN`, so its sign can be flipped).
//! Ordinary inputs fit. The S0 policy still admits extreme compositions that do not: a price near
//! 5 * 10^8 with 8 fractional digits, multiplied by a constant near 10^12 with 12 fractional
//! digits, needs more than 128 bits. A composition that does not fit is not rounded and does not
//! wrap: the operation returns the typed failure `ARITHMETIC_OVERFLOW`, which ends the run before
//! a completed result is produced. That is the explicit rejection OQ-02 section 2.5 asks for. The same failure reports a conversion that needs more than the 96 bits of a
//! [`Decimal`], and a value that has no canonical wire form (an integer too large for a decimal).
//! Division by zero is not decided here: the caller tests for zero first and reports the missing
//! value `DIV_BY_ZERO`, so a zero divisor reaching [`Ratio::div`] is an internal failure.
//!
//! # Display and the wire
//!
//! [`fmt::Display`] is canonical. A value that terminates within 28 fractional digits (and fits a
//! [`Decimal`]) prints as a normalised decimal, any other value as the reduced fraction `n/d`.
//! The text is independent of how the value was computed, so a failure message that prints a level
//! is byte-identical in an uninterrupted run and in a run restored from a checkpoint. The
//! checkpoint writes the same text (`Exact` in `common.schema.json`). A value shown in a result
//! goes through [`Ratio::to_display_decimal`] instead.

use std::{cmp::Ordering, fmt};

use openquant_contracts::exact;

use crate::{
    model::{Failure, FailureCode, Result},
    numeric::{Decimal, exact_string},
};

/// An exact fraction `numerator / denominator`.
///
/// Invariants, kept by every constructor and operation: the denominator is positive, the fraction
/// is reduced (`gcd(|numerator|, denominator) == 1`), zero is `0/1`, and the numerator is not
/// `i128::MIN`. Equal values therefore have equal fields, so `==` and `Hash` agree with the
/// numeric order.
#[derive(Clone, Copy, PartialEq, Eq, Hash)]
pub struct Ratio {
    num: i128,
    den: i128,
}

fn overflow(operation: &str) -> Failure {
    Failure::new(
        FailureCode::ArithmeticOverflow,
        format!("exact arithmetic overflow in {operation}"),
    )
}

fn gcd64(a: u64, b: u64) -> u64 {
    let (mut a, mut b) = (a, b);
    while b != 0 {
        (a, b) = (b, a % b);
    }
    a
}

/// Greatest common divisor. `gcd(0, n) == n`.
fn gcd(a: u128, b: u128) -> u128 {
    let (mut a, mut b) = (a, b);
    loop {
        if let (Ok(x), Ok(y)) = (u64::try_from(a), u64::try_from(b)) {
            return u128::from(gcd64(x, y));
        }
        if b == 0 {
            return a;
        }
        (a, b) = (b, a % b);
    }
}

/// `n / g` for a divisor that is known to be positive and to fit an `i128`.
///
/// Every caller passes a greatest common divisor of values that fit an `i128` and are not both
/// zero, so the divisor always fits and is positive. The final arm exists only to keep the
/// function total. It cannot run, and the differential test against exact rationals found no run.
fn divide(n: i128, g: u128) -> i128 {
    match i128::try_from(g) {
        Ok(g) if g > 0 => n / g,
        _ => n,
    }
}

fn pow10(scale: u32) -> Option<u128> {
    10_u128.checked_pow(scale)
}

/// `floor(r * m / d)` and the remainder, for `r < d`, `d > 0` and `m < 2^127`. No intermediate
/// value leaves 128 bits: the product is built one bit of `m` at a time.
fn mul_div(r: u128, m: u128, d: u128) -> (u128, u128) {
    if let Some(product) = r.checked_mul(m) {
        return (product / d, product % d);
    }
    let (mut quotient, mut remainder) = (0_u128, 0_u128);
    let mut bit = 128_u32;
    while bit > 0 {
        bit -= 1;
        quotient <<= 1;
        remainder <<= 1;
        if remainder >= d {
            remainder -= d;
            quotient += 1;
        }
        if (m >> bit) & 1 == 1 {
            remainder += r;
            if remainder >= d {
                remainder -= d;
                quotient += 1;
            }
        }
    }
    (quotient, remainder)
}

/// Order of `a/b` and `c/d` (`b > 0`, `d > 0`) by continued fractions: integer parts first, then
/// the reciprocals of the fractional parts. Only divisions are used, so nothing overflows.
fn compare_fractions(a: i128, b: i128, c: i128, d: i128) -> Ordering {
    let (mut a, mut b, mut c, mut d) = (a, b, c, d);
    loop {
        let (whole_left, rest_left) = (a.div_euclid(b), a.rem_euclid(b));
        let (whole_right, rest_right) = (c.div_euclid(d), c.rem_euclid(d));
        if whole_left != whole_right {
            return whole_left.cmp(&whole_right);
        }
        match (rest_left == 0, rest_right == 0) {
            (true, true) => return Ordering::Equal,
            (true, false) => return Ordering::Less,
            (false, true) => return Ordering::Greater,
            (false, false) => {}
        }
        // x = rest_left / b and y = rest_right / d lie in (0, 1), and x < y exactly when
        // 1 / y < 1 / x.
        (a, b, c, d) = (d, rest_right, b, rest_left);
    }
}

/// A floor on the `scale` grid with the remainder that was cut off.
struct Scaled {
    /// `floor(value * 10^scale)`.
    floor: i128,
    /// `value * 10^scale - floor`, as a fraction of `den`.
    remainder: u128,
    den: u128,
}

impl Ratio {
    pub const ZERO: Self = Self { num: 0, den: 1 };
    pub const ONE: Self = Self { num: 1, den: 1 };

    /// Reduce `num / den` for a positive `den` and a `num` that is not `i128::MIN`.
    fn reduced(num: i128, den: i128) -> Self {
        if num == 0 {
            return Self::ZERO;
        }
        let g = gcd(num.unsigned_abs(), den.unsigned_abs());
        if g == 1 {
            Self { num, den }
        } else {
            Self {
                num: divide(num, g),
                den: divide(den, g),
            }
        }
    }

    /// The fraction `num / den`, reduced.
    ///
    /// # Errors
    /// An internal failure for a zero denominator; `ARITHMETIC_OVERFLOW` when a term is
    /// `i128::MIN`, whose sign cannot be flipped.
    pub fn new(num: i128, den: i128) -> Result<Self> {
        if den == 0 {
            return Err(Failure::internal("zero denominator"));
        }
        if num == i128::MIN || den == i128::MIN {
            return Err(overflow("normalisation"));
        }
        Ok(if den < 0 {
            Self::reduced(-num, -den)
        } else {
            Self::reduced(num, den)
        })
    }

    /// A result of a checked computation: both terms present and the numerator not `i128::MIN`.
    fn checked(num: Option<i128>, den: Option<i128>, operation: &str) -> Result<Self> {
        match (num, den) {
            (Some(num), Some(den)) if num != i128::MIN => Ok(Self { num, den }),
            _ => Err(overflow(operation)),
        }
    }

    /// The exact value of a decimal. A decimal has at most 28 fractional digits and 96 bits of
    /// digits, so this never fails. `10^28` fits an `i128`, so the `unwrap_or(1)` below cannot
    /// run; it keeps the function total.
    #[must_use]
    pub fn from_decimal(value: Decimal) -> Self {
        let den = pow10(value.scale())
            .and_then(|power| i128::try_from(power).ok())
            .unwrap_or(1);
        Self::reduced(value.mantissa(), den)
    }

    /// The whole number `value`.
    #[must_use]
    pub const fn from_i64(value: i64) -> Self {
        Self {
            num: value as i128,
            den: 1,
        }
    }

    /// The whole number `value`.
    #[must_use]
    pub const fn from_u64(value: u64) -> Self {
        Self {
            num: value as i128,
            den: 1,
        }
    }

    #[must_use]
    pub const fn numerator(self) -> i128 {
        self.num
    }

    #[must_use]
    pub const fn denominator(self) -> i128 {
        self.den
    }

    #[must_use]
    pub const fn is_zero(self) -> bool {
        self.num == 0
    }

    #[must_use]
    pub const fn is_negative(self) -> bool {
        self.num < 0
    }

    #[must_use]
    pub const fn is_positive(self) -> bool {
        self.num > 0
    }

    /// The absolute value. The numerator is never `i128::MIN`, so this cannot overflow.
    #[must_use]
    pub const fn abs(self) -> Self {
        Self {
            num: self.num.abs(),
            den: self.den,
        }
    }

    /// The negation. The numerator is never `i128::MIN`, so this cannot overflow.
    #[must_use]
    pub const fn negated(self) -> Self {
        Self {
            num: -self.num,
            den: self.den,
        }
    }

    /// Exact sum.
    ///
    /// # Errors
    /// `ARITHMETIC_OVERFLOW` when a term of the result does not fit 128 bits.
    #[allow(clippy::should_implement_trait)]
    pub fn add(self, other: Self) -> Result<Self> {
        if other.num == 0 {
            return Ok(self);
        }
        if self.num == 0 {
            return Ok(other);
        }
        if self.den == other.den {
            // The denominators are equal, so only the numerators combine.
            return match self.num.checked_add(other.num) {
                Some(sum) if sum != i128::MIN => Ok(Self::reduced(sum, self.den)),
                _ => Err(overflow("addition")),
            };
        }
        let common = gcd(self.den.unsigned_abs(), other.den.unsigned_abs());
        if common == 1 {
            // Coprime denominators: the sum is already reduced.
            let num = self
                .num
                .checked_mul(other.den)
                .zip(other.num.checked_mul(self.den))
                .and_then(|(a, b)| a.checked_add(b));
            return Self::checked(num, self.den.checked_mul(other.den), "addition");
        }
        let left = divide(self.den, common);
        let right = divide(other.den, common);
        let total = self
            .num
            .checked_mul(right)
            .zip(other.num.checked_mul(left))
            .and_then(|(a, b)| a.checked_add(b))
            .ok_or_else(|| overflow("addition"))?;
        if total == 0 {
            return Ok(Self::ZERO);
        }
        let cancel = gcd(total.unsigned_abs(), common);
        Self::checked(
            Some(divide(total, cancel)),
            left.checked_mul(divide(other.den, cancel)),
            "addition",
        )
    }

    /// Exact difference.
    ///
    /// # Errors
    /// `ARITHMETIC_OVERFLOW` when a term of the result does not fit 128 bits.
    #[allow(clippy::should_implement_trait)]
    pub fn sub(self, other: Self) -> Result<Self> {
        self.add(other.negated())
    }

    /// Exact product.
    ///
    /// # Errors
    /// `ARITHMETIC_OVERFLOW` when a term of the result does not fit 128 bits.
    #[allow(clippy::should_implement_trait)]
    pub fn mul(self, other: Self) -> Result<Self> {
        if self.num == 0 || other.num == 0 {
            return Ok(Self::ZERO);
        }
        if other == Self::ONE {
            return Ok(self);
        }
        if self == Self::ONE {
            return Ok(other);
        }
        // Cross-cancel first: both operands are reduced, so the product then is too.
        let left = gcd(self.num.unsigned_abs(), other.den.unsigned_abs());
        let right = gcd(other.num.unsigned_abs(), self.den.unsigned_abs());
        let num = divide(self.num, left).checked_mul(divide(other.num, right));
        let den = divide(self.den, right).checked_mul(divide(other.den, left));
        Self::checked(num, den, "multiplication")
    }

    /// Exact quotient.
    ///
    /// # Errors
    /// `ARITHMETIC_OVERFLOW` when a term of the result does not fit 128 bits. A zero divisor is an
    /// internal failure: the caller decides the zero case before dividing.
    #[allow(clippy::should_implement_trait)]
    pub fn div(self, other: Self) -> Result<Self> {
        if other.num == 0 {
            return Err(Failure::internal("division by zero in exact arithmetic"));
        }
        let reciprocal = Self {
            num: if other.num < 0 { -other.den } else { other.den },
            den: other.num.abs(),
        };
        self.mul(reciprocal)
    }

    /// `floor(value * 10^scale)` with the remainder cut off.
    fn scaled(self, scale: u32) -> Result<Scaled> {
        if scale > Decimal::MAX_SCALE {
            return Err(overflow("a scale above 28"));
        }
        let power = pow10(scale).ok_or_else(|| overflow("a grid unit"))?;
        let den = u128::try_from(self.den).map_err(|_| overflow("a grid"))?;
        let rest = u128::try_from(self.num.rem_euclid(self.den)).map_err(|_| overflow("a grid"))?;
        let whole = self.num.div_euclid(self.den);
        let (digits, remainder) = mul_div(rest, power, den);
        let floor = i128::try_from(power)
            .ok()
            .zip(i128::try_from(digits).ok())
            .and_then(|(power, digits)| whole.checked_mul(power)?.checked_add(digits))
            .ok_or_else(|| overflow("a grid"))?;
        Ok(Scaled {
            floor,
            remainder,
            den,
        })
    }

    fn on_grid(mantissa: i128, scale: u32) -> Result<Decimal> {
        Decimal::try_from_i128_with_scale(mantissa, scale)
            .map_err(|_| overflow("conversion to a decimal"))
    }

    /// The largest multiple of `10^-scale` that does not exceed the value (round toward negative
    /// infinity), exactly.
    ///
    /// # Errors
    /// `ARITHMETIC_OVERFLOW` when the digits do not fit a [`Decimal`] or `scale` is above 28.
    pub fn floor_to(self, scale: u32) -> Result<Decimal> {
        Self::on_grid(self.scaled(scale)?.floor, scale)
    }

    /// The smallest multiple of `10^-scale` that is not below the value (round toward positive
    /// infinity), exactly.
    ///
    /// # Errors
    /// `ARITHMETIC_OVERFLOW` when the digits do not fit a [`Decimal`] or `scale` is above 28.
    pub fn ceil_to(self, scale: u32) -> Result<Decimal> {
        let scaled = self.scaled(scale)?;
        let up = i128::from(scaled.remainder != 0);
        let mantissa = scaled
            .floor
            .checked_add(up)
            .ok_or_else(|| overflow("a grid"))?;
        Self::on_grid(mantissa, scale)
    }

    /// The nearest multiple of `10^-scale`, a tie going to the even last digit.
    ///
    /// # Errors
    /// `ARITHMETIC_OVERFLOW` when the digits do not fit a [`Decimal`] or `scale` is above 28.
    pub fn half_even_to(self, scale: u32) -> Result<Decimal> {
        let scaled = self.scaled(scale)?;
        let twice = scaled.remainder.checked_mul(2);
        let up = match twice.map(|twice| twice.cmp(&scaled.den)) {
            Some(Ordering::Less) => false,
            Some(Ordering::Equal) => scaled.floor & 1 == 1,
            Some(Ordering::Greater) | None => true,
        };
        let mantissa = scaled
            .floor
            .checked_add(i128::from(up))
            .ok_or_else(|| overflow("a grid"))?;
        Self::on_grid(mantissa, scale)
    }

    /// The value as a normalised decimal, when it terminates within 28 fractional digits and its
    /// digits fit a [`Decimal`]; `None` otherwise.
    #[must_use]
    pub fn to_decimal_exact(self) -> Option<Decimal> {
        exact::terminating(self.num, self.den)
    }

    /// The value as a [`Decimal`] for display and for ranks: exact when it terminates, otherwise
    /// rounded half-even at the largest scale (at most 28) at which the digits still fit a
    /// [`Decimal`]. That is the precision the decimal division of earlier builds produced, so
    /// results that show a non-terminating value are unchanged.
    ///
    /// # Errors
    /// `ARITHMETIC_OVERFLOW` when the integer part alone does not fit a [`Decimal`].
    pub fn to_display_decimal(self) -> Result<Decimal> {
        if let Some(value) = self.to_decimal_exact() {
            return Ok(value);
        }
        // The integer part of the value has `digits` digits, so a scale above 29 - digits needs
        // more than 29 digits and cannot fit 96 bits.
        let whole = self.num.div_euclid(self.den).unsigned_abs();
        let digits = whole
            .checked_ilog10()
            .map_or(0, |log| log.saturating_add(1));
        let mut scale = Decimal::MAX_SCALE.min(29_u32.saturating_sub(digits));
        loop {
            if let Ok(value) = self.half_even_to(scale) {
                return Ok(value);
            }
            if scale == 0 {
                return Err(overflow("conversion to a decimal"));
            }
            scale -= 1;
        }
    }

    /// The canonical wire text: a normalised decimal when the value terminates within 28
    /// fractional digits, otherwise the reduced fraction `n/d` (`Exact` in
    /// `common.schema.json`).
    ///
    /// # Errors
    /// `ARITHMETIC_OVERFLOW` for an integer that does not fit a decimal: the wire has no form for
    /// it, because a fraction needs a denominator above 1.
    pub fn to_wire(self) -> Result<String> {
        exact::format(self.num, self.den).map_err(|error| overflow(&error.to_string()))
    }

    /// Read canonical wire text.
    ///
    /// # Errors
    /// `INVALID_DECIMAL` for text that breaks the grammar or the canonical rule (see
    /// [`openquant_contracts::exact::parse`]).
    pub fn from_wire(text: &str) -> Result<Self> {
        Ok(match exact::parse(text)? {
            exact::Exact::Decimal(value) => Self::from_decimal(value),
            exact::Exact::Fraction {
                numerator,
                denominator,
            } => Self {
                num: numerator,
                den: denominator,
            },
        })
    }
}

impl Ord for Ratio {
    fn cmp(&self, other: &Self) -> Ordering {
        if self.den == other.den {
            return self.num.cmp(&other.num);
        }
        match (
            self.num.checked_mul(other.den),
            other.num.checked_mul(self.den),
        ) {
            (Some(left), Some(right)) => left.cmp(&right),
            _ => compare_fractions(self.num, self.den, other.num, other.den),
        }
    }
}

impl PartialOrd for Ratio {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl From<Decimal> for Ratio {
    fn from(value: Decimal) -> Self {
        Self::from_decimal(value)
    }
}

impl From<i64> for Ratio {
    fn from(value: i64) -> Self {
        Self::from_i64(value)
    }
}

impl From<u64> for Ratio {
    fn from(value: u64) -> Self {
        Self::from_u64(value)
    }
}

impl fmt::Display for Ratio {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self.to_decimal_exact() {
            Some(value) => f.write_str(&exact_string(value)),
            None => write!(f, "{}/{}", self.num, self.den),
        }
    }
}

impl fmt::Debug for Ratio {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Ratio({}/{})", self.num, self.den)
    }
}

//! Exact decimal helpers. Every operation is checked: overflow is a typed failure, never a panic.
//!
//! Quantisation points are explicit (OQ-02 section 2.5): caps and quantities round down, fees
//! round up, sale levels round down, display values round half-even.

use rust_decimal::RoundingStrategy;
pub use rust_decimal::{Decimal, prelude::ToPrimitive};

use crate::model::{Failure, FailureCode, Result};

/// Largest accepted absolute price, in policy units.
pub const MAX_PRICE: i64 = 1_000_000_000;
/// Largest accepted volume.
pub const MAX_VOLUME: i64 = 1_000_000_000_000_000;
/// Largest accepted initial capital.
pub const MAX_CAPITAL: i64 = 1_000_000_000_000_000;

fn overflow(operation: &str) -> Failure {
    Failure::new(
        FailureCode::ArithmeticOverflow,
        format!("decimal overflow in {operation}"),
    )
}

/// Checked addition.
pub fn add(a: Decimal, b: Decimal) -> Result<Decimal> {
    a.checked_add(b).ok_or_else(|| overflow("addition"))
}

/// Checked subtraction.
pub fn sub(a: Decimal, b: Decimal) -> Result<Decimal> {
    a.checked_sub(b).ok_or_else(|| overflow("subtraction"))
}

/// Checked multiplication.
pub fn mul(a: Decimal, b: Decimal) -> Result<Decimal> {
    a.checked_mul(b).ok_or_else(|| overflow("multiplication"))
}

/// Checked division. The divisor must be non-zero; callers decide the zero outcome first.
pub fn div(a: Decimal, b: Decimal) -> Result<Decimal> {
    a.checked_div(b).ok_or_else(|| overflow("division"))
}

/// Checked addition that fails instead of rounding when the sum is not exactly representable.
///
/// Money paths use the `exact_*` operations so that an out-of-range value is a typed failure and
/// never a silently rounded amount.
pub fn exact_add(a: Decimal, b: Decimal) -> Result<Decimal> {
    let sum = a.checked_add(b).ok_or_else(|| overflow("addition"))?;
    if !a.is_zero() && !b.is_zero() && !sum.is_zero() && sum.scale() != a.scale().max(b.scale()) {
        return Err(overflow("addition (digits would be lost)"));
    }
    Ok(sum)
}

/// Checked subtraction that fails instead of rounding.
pub fn exact_sub(a: Decimal, b: Decimal) -> Result<Decimal> {
    let difference = a.checked_sub(b).ok_or_else(|| overflow("subtraction"))?;
    if !a.is_zero()
        && !b.is_zero()
        && !difference.is_zero()
        && difference.scale() != a.scale().max(b.scale())
    {
        return Err(overflow("subtraction (digits would be lost)"));
    }
    Ok(difference)
}

/// Checked multiplication that fails instead of rounding.
pub fn exact_mul(a: Decimal, b: Decimal) -> Result<Decimal> {
    let (a, b) = (a.normalize(), b.normalize());
    let product = a.checked_mul(b).ok_or_else(|| overflow("multiplication"))?;
    if !a.is_zero() && !b.is_zero() && product.scale() != a.scale().saturating_add(b.scale()) {
        return Err(overflow("multiplication (digits would be lost)"));
    }
    Ok(product)
}

/// `amount * bps / 10000`, exact. Dividing by ten thousand only moves the decimal point.
pub fn exact_bps_of(amount: Decimal, bps: Decimal) -> Result<Decimal> {
    let product = exact_mul(amount, bps)?;
    let scale = product
        .scale()
        .checked_add(4)
        .ok_or_else(|| overflow("basis points"))?;
    Decimal::try_from_i128_with_scale(product.mantissa(), scale)
        .map_err(|_| overflow("basis points"))
}

/// The unit of the grid at `scale` fractional digits: `10^-scale`.
pub fn grid_unit(scale: u32) -> Result<Decimal> {
    Decimal::try_from_i128_with_scale(1, scale).map_err(|_| overflow("grid unit"))
}

/// Largest multiple of the `scale` grid that does not exceed `a / divisor`, computed exactly.
///
/// The quotient is estimated, then corrected by exact multiplication, so a division that is not
/// representable never moves the result across a grid line.
pub fn floor_div_to_grid(a: Decimal, divisor: u64, scale: u32) -> Result<Decimal> {
    let divisor = Decimal::from(divisor);
    if divisor <= Decimal::ZERO {
        return Err(Failure::internal("division by zero in floor_div_to_grid"));
    }
    let unit = grid_unit(scale)?;
    let mut quotient = floor_to(div(a, divisor)?, scale);
    for _ in 0..4 {
        if exact_mul(quotient, divisor)? > a {
            quotient = exact_sub(quotient, unit)?;
        } else {
            break;
        }
    }
    for _ in 0..4 {
        let above = exact_add(quotient, unit)?;
        if exact_mul(above, divisor)? <= a {
            quotient = above;
        } else {
            return Ok(quotient);
        }
    }
    Err(overflow("floor division did not converge"))
}

/// Largest valid prefix of `text` that is at most `max_bytes` long and ends on a char boundary.
#[must_use]
pub fn truncate_on_boundary(text: &str, max_bytes: usize) -> &str {
    let mut end = max_bytes.min(text.len());
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    text.get(..end).unwrap_or("")
}

/// Round toward negative infinity at `scale` fractional digits.
#[must_use]
pub fn floor_to(value: Decimal, scale: u32) -> Decimal {
    value.round_dp_with_strategy(scale, RoundingStrategy::ToNegativeInfinity)
}

/// Round toward positive infinity at `scale` fractional digits.
#[must_use]
pub fn ceil_to(value: Decimal, scale: u32) -> Decimal {
    value.round_dp_with_strategy(scale, RoundingStrategy::ToPositiveInfinity)
}

/// Round half to even at `scale` fractional digits (display values only).
#[must_use]
pub fn half_even_to(value: Decimal, scale: u32) -> Decimal {
    value.round_dp_with_strategy(scale, RoundingStrategy::MidpointNearestEven)
}

/// Basis-point amount: `amount * bps / 10000`.
pub fn bps_of(amount: Decimal, bps: Decimal) -> Result<Decimal> {
    div(mul(amount, bps)?, Decimal::from(10_000))
}

/// Largest multiple of `lot` that does not exceed `quantity`. `lot` must be positive.
pub fn floor_to_lot(quantity: Decimal, lot: Decimal) -> Result<Decimal> {
    if lot <= Decimal::ZERO {
        return Err(Failure::new(
            FailureCode::UnsupportedPolicy,
            "lot_size must be positive".to_owned(),
        ));
    }
    mul(div(quantity, lot)?.floor(), lot)
}

/// Plain string with trailing zeros removed. Used for values that are not on a policy grid.
#[must_use]
pub fn exact_string(value: Decimal) -> String {
    let normalised = value.normalize();
    if normalised.is_zero() {
        "0".to_owned()
    } else {
        normalised.to_string()
    }
}

/// Plain string at exactly `scale` fractional digits. The value must already be on the grid.
pub fn fixed_string(value: Decimal, scale: u32) -> Result<String> {
    openquant_contracts::decimal::format(&value, scale)
        .map_err(|error| Failure::new(FailureCode::InvalidDecimal, error.to_string()))
}

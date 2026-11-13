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

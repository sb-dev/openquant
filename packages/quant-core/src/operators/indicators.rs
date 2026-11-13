//! Indicator mathematics on exact fractions (OQ-02 section 2.6).
//!
//! These are simple-mean definitions. Do not replace them with Wilder smoothing under the same
//! identifier. Nothing is rounded here: a mean over a window of values is the exact fraction, so
//! `3 * (0.67 / 3)` is `0.67`. The only failure is `ARITHMETIC_OVERFLOW` when a term of an
//! intermediate fraction does not fit 128 bits.

use crate::{
    model::{MissingReason, Result},
    ratio::Ratio,
};

/// Result of an indicator: a number or an explicit missing value.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome {
    Num(Ratio),
    Missing(MissingReason),
}

/// Simple mean of `values`. An empty slice has no mean.
pub fn mean(values: &[Ratio]) -> Result<Outcome> {
    if values.is_empty() {
        return Ok(Outcome::Missing(MissingReason::InsufficientHistory));
    }
    let mut sum = Ratio::ZERO;
    for value in values {
        sum = sum.add(*value)?;
    }
    Ok(Outcome::Num(sum.div(Ratio::from_u64(values.len() as u64))?))
}

/// RSI over consecutive prices (`window + 1` values for a window of `window` changes).
///
/// `100 * sum_gain / (sum_gain + sum_loss)`: algebraically `100 - 100 / (1 + mean_gain /
/// mean_loss)` and exact. Both sums zero is undefined.
pub fn rsi(prices: &[Ratio]) -> Result<Outcome> {
    let mut gains = Ratio::ZERO;
    let mut losses = Ratio::ZERO;
    for pair in prices.windows(2) {
        if let [previous, current] = pair {
            let change = current.sub(*previous)?;
            if change.is_positive() {
                gains = gains.add(change)?;
            } else {
                losses = losses.add(change.negated())?;
            }
        }
    }
    let total = gains.add(losses)?;
    if total.is_zero() {
        return Ok(Outcome::Missing(MissingReason::UndefinedFlat));
    }
    Ok(Outcome::Num(Ratio::from_u64(100).mul(gains)?.div(total)?))
}

/// True range of a bar given the previous close.
pub fn true_range(high: Ratio, low: Ratio, previous_close: Ratio) -> Result<Ratio> {
    let range = high.sub(low)?;
    let up = high.sub(previous_close)?.abs();
    let down = low.sub(previous_close)?.abs();
    Ok(range.max(up).max(down))
}

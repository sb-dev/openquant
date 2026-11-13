//! Indicator mathematics on decimals (OQ-02 section 2.6).
//!
//! These are simple-mean definitions. Do not replace them with Wilder smoothing under the same
//! identifier.

use crate::{
    model::{MissingReason, Result},
    numeric::{Decimal, add, div, mul, sub},
};

/// Result of an indicator: a number or an explicit missing value.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome {
    Num(Decimal),
    Missing(MissingReason),
}

/// Simple mean of `values`. An empty slice has no mean.
pub fn mean(values: &[Decimal]) -> Result<Outcome> {
    if values.is_empty() {
        return Ok(Outcome::Missing(MissingReason::InsufficientHistory));
    }
    let mut sum = Decimal::ZERO;
    for value in values {
        sum = add(sum, *value)?;
    }
    Ok(Outcome::Num(div(sum, Decimal::from(values.len() as u64))?))
}

/// RSI over consecutive prices (`window + 1` values for a window of `window` changes).
///
/// `100 * sum_gain / (sum_gain + sum_loss)`: algebraically `100 - 100 / (1 + mean_gain /
/// mean_loss)` but exact for terminating inputs. Both sums zero is undefined.
pub fn rsi(prices: &[Decimal]) -> Result<Outcome> {
    let mut gains = Decimal::ZERO;
    let mut losses = Decimal::ZERO;
    for pair in prices.windows(2) {
        if let [previous, current] = pair {
            let change = sub(*current, *previous)?;
            if change > Decimal::ZERO {
                gains = add(gains, change)?;
            } else {
                losses = add(losses, sub(Decimal::ZERO, change)?)?;
            }
        }
    }
    let total = add(gains, losses)?;
    if total.is_zero() {
        return Ok(Outcome::Missing(MissingReason::UndefinedFlat));
    }
    Ok(Outcome::Num(div(mul(Decimal::from(100), gains)?, total)?))
}

/// True range of a bar given the previous close.
pub fn true_range(high: Decimal, low: Decimal, previous_close: Decimal) -> Result<Decimal> {
    let range = sub(high, low)?;
    let up = sub(high, previous_close)?.abs();
    let down = sub(low, previous_close)?.abs();
    Ok(range.max(up).max(down))
}

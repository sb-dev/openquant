//! Wire formatting. Outputs never depend on how a `Decimal` was computed or stored, so an
//! uninterrupted run and a restored run print identical text.

use std::str::FromStr;

use openquant_contracts::generated as g;

use crate::{
    model::{Cursor, Failure, FailureCode, Result},
    numeric::{Decimal, exact_string, fixed_string, half_even_to},
    ratio::Ratio,
};

/// Scales of the registered policy.
#[derive(Clone, Copy, Debug)]
pub struct Fmt {
    pub price: u32,
    pub qty: u32,
    pub money: u32,
    pub diag: u32,
}

fn invalid(error: impl ToString) -> Failure {
    Failure::new(FailureCode::InvalidDecimal, error.to_string())
}

/// Wrap decimal text in the generated, pattern-checked type.
pub fn gdec(text: &str) -> Result<g::Decimal> {
    g::Decimal::from_str(text).map_err(invalid)
}

impl Fmt {
    /// A price on the price grid.
    pub fn price(&self, value: Decimal) -> Result<g::Decimal> {
        gdec(&fixed_string(value, self.price)?)
    }

    /// A quantity on the quantity grid.
    pub fn qty(&self, value: Decimal) -> Result<g::Decimal> {
        gdec(&fixed_string(value, self.qty)?)
    }

    /// A money amount on the money grid.
    pub fn money(&self, value: Decimal) -> Result<g::Decimal> {
        gdec(&fixed_string(value, self.money)?)
    }

    /// A price on the price grid when it is on the grid, otherwise the exact value.
    ///
    /// Trade records keep the as-filled price on the grid until a split moves it to a basis
    /// where it can be a non-terminating decimal.
    pub fn price_or_exact(&self, value: Decimal) -> Result<g::Decimal> {
        if value.normalize().scale() <= self.price {
            self.price(value)
        } else {
            self.exact(value)
        }
    }

    /// Exact value without trailing zeros (levels and snapshots that may be off-grid).
    pub fn exact(&self, value: Decimal) -> Result<g::Decimal> {
        gdec(&exact_string(value))
    }

    /// Display value rounded half-even to the diagnostic scale.
    pub fn diag(&self, value: Decimal) -> Result<g::Decimal> {
        gdec(&fixed_string(half_even_to(value, self.diag), self.diag)?)
    }

    /// Display value of an exact number, rounded half-even to the diagnostic scale. The rounding
    /// reads the exact value, never an earlier rounding of it.
    pub fn diag_exact(&self, value: Ratio) -> Result<g::Decimal> {
        gdec(&fixed_string(value.half_even_to(self.diag)?, self.diag)?)
    }

    /// An exact level or snapshot in a result: the exact decimal when it terminates, otherwise
    /// the exact value rounded to the most digits a decimal carries. A result shows values; the
    /// checkpoint keeps them exactly (see [`Fmt::wire`]).
    pub fn level(&self, value: Ratio) -> Result<g::Decimal> {
        self.exact(value.to_display_decimal()?)
    }

    /// Like [`Fmt::price_or_exact`] for an exact level.
    pub fn price_or_level(&self, value: Ratio) -> Result<g::Decimal> {
        self.price_or_exact(value.to_display_decimal()?)
    }

    /// An exact level or snapshot in a checkpoint, in its canonical form (`Exact`): a normalised
    /// decimal when the value terminates, otherwise a reduced fraction.
    pub fn wire(&self, value: Ratio) -> Result<g::Exact> {
        g::Exact::from_str(&value.to_wire()?).map_err(invalid)
    }
}

/// Parse a generated decimal exactly.
pub fn parse_decimal(value: &g::Decimal) -> Result<Decimal> {
    Decimal::from_str_exact(value.as_str()).map_err(invalid)
}

/// Parse a generated `Exact` value, enforcing the canonical rule: a fraction must be reduced, have
/// a denominator above 1, have no decimal form and fit 128 bits.
///
/// # Errors
/// `INVALID_DECIMAL` for any value that breaks the grammar or the canonical rule.
pub fn parse_exact(value: &g::Exact) -> Result<Ratio> {
    Ratio::from_wire(value.as_str())
}

/// Generated identifier from text.
pub fn ident(value: &str) -> Result<g::Identifier> {
    g::Identifier::from_str(value)
        .map_err(|e| Failure::new(FailureCode::InvalidInput, e.to_string()))
}

/// Generated session date from text.
pub fn session_date(value: &str) -> Result<g::SessionDate> {
    g::SessionDate::from_str(value)
        .map_err(|e| Failure::new(FailureCode::InvalidInput, e.to_string()))
}

/// Core cursor to wire cursor.
pub fn wire_cursor(cursor: &Cursor) -> Result<g::Cursor> {
    Ok(g::Cursor {
        session: session_date(&cursor.session)?,
        phase: cursor.phase,
    })
}

/// Wire cursor to core cursor.
#[must_use]
pub fn core_cursor(cursor: &g::Cursor) -> Cursor {
    Cursor {
        session: cursor.session.to_string(),
        phase: cursor.phase,
    }
}

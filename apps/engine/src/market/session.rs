//! The session probe: compare a daily bar with the regular-hours minute bars of its session.
//!
//! The profile declares regular-hours semantics for its daily bars (`session_basis`). A provider
//! default can differ, for example by including extended hours in the daily aggregate, so the
//! delivery probe compares the two for sample sessions before the profile is enabled and records
//! the result (OQ-05 section 7.1, pilot record). This module is the pure comparison. The probe
//! fetches the bars through the adapter and passes them here.

use rust_decimal::Decimal;

use super::{gate::Fact, provider::ProviderBar, time::Timestamp};

/// A field of a bar.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum BarField {
    Open,
    High,
    Low,
    Close,
    Volume,
}

impl BarField {
    const fn name(self) -> &'static str {
        match self {
            Self::Open => "open",
            Self::High => "high",
            Self::Low => "low",
            Self::Close => "close",
            Self::Volume => "volume",
        }
    }
}

/// The outcome of one comparison.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SessionProbe {
    /// The daily bar equals the aggregate of the minute bars in the regular session, field by field.
    Matches,
    /// The named fields differ.
    Differs(Vec<BarField>),
    /// No minute bar starts inside the regular session, so nothing was compared.
    NoMinutes,
}

impl SessionProbe {
    /// The gate fact this result establishes. Only an exact match verifies the session semantics.
    #[must_use]
    pub fn into_fact(self) -> Fact {
        match self {
            Self::Matches => Fact::Verified,
            Self::Differs(fields) => {
                let names: Vec<&str> = fields.iter().map(|field| field.name()).collect();
                Fact::Failed(format!(
                    "the daily bar differs from the regular-hours minute bars in {}",
                    names.join(", ")
                ))
            }
            Self::NoMinutes => Fact::Unverified,
        }
    }
}

/// Compare `daily` with the minute bars that start in `[open_at, close_at)`.
///
/// The aggregate takes the first open, the highest high, the lowest low, the last close and the
/// total volume. Minute bars outside the window, for example in extended hours, are ignored. The
/// comparison is exact, with no tolerance.
///
/// # Errors
/// A text when a value cannot be held exactly in the decimal type.
pub fn compare_daily_with_regular_minutes(
    daily: &ProviderBar,
    minutes: &[ProviderBar],
    open_at: Timestamp,
    close_at: Timestamp,
) -> Result<SessionProbe, &'static str> {
    let mut inside: Vec<&ProviderBar> = minutes
        .iter()
        .filter(|bar| bar.start >= open_at && bar.start < close_at)
        .collect();
    inside.sort_by_key(|bar| bar.start);
    let (Some(first), Some(last)) = (inside.first(), inside.last()) else {
        return Ok(SessionProbe::NoMinutes);
    };
    let value = |text: &super::number::DecimalText| text.to_decimal().ok_or("value out of range");
    let mut high = value(&first.high)?;
    let mut low = value(&first.low)?;
    let mut volume = Decimal::ZERO;
    for bar in &inside {
        high = high.max(value(&bar.high)?);
        low = low.min(value(&bar.low)?);
        volume = volume
            .checked_add(value(&bar.volume)?)
            .ok_or("volume overflow")?;
    }
    let mut differing = Vec::new();
    let mut check = |field,
                     aggregate: Decimal,
                     daily: &super::number::DecimalText|
     -> Result<(), &'static str> {
        if aggregate != value(daily)? {
            differing.push(field);
        }
        Ok(())
    };
    check(BarField::Open, value(&first.open)?, &daily.open)?;
    check(BarField::High, high, &daily.high)?;
    check(BarField::Low, low, &daily.low)?;
    check(BarField::Close, value(&last.close)?, &daily.close)?;
    check(BarField::Volume, volume, &daily.volume)?;
    Ok(if differing.is_empty() {
        SessionProbe::Matches
    } else {
        SessionProbe::Differs(differing)
    })
}

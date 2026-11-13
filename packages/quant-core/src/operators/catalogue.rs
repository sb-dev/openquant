//! The reviewed operator catalogue for `daily-long-only-seed@1`.
//!
//! Only operators the daily swing seed needs are present. Adding one is a reviewed code change
//! that bumps the compatibility version and the operator-set digest.

use crate::model::{Failure, FailureCode, Result};

/// The operator set a strategy artefact must name.
pub const OPERATOR_SET: &str = "daily-long-only-seed@1";

/// Operator identity. Evaluation matches on this enum, never on strings.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OpId {
    Const,
    BarField,
    Ref,
    Lag,
    Sma,
    RsiSimple,
    AtrSimple,
    Add,
    Sub,
    Mul,
    Div,
    Gt,
    Gte,
    Lt,
    Lte,
    And,
    Or,
    EntryPrice,
    Snapshot,
}

/// Where an expression is evaluated.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Scope {
    /// Indicators, entry condition, rank and snapshots: causal split-adjusted series.
    Signal,
    /// Stop and target levels: entry price and snapshots only.
    Level,
    /// Stop-adjustment trigger and new level: levels plus the raw current bar.
    Trigger,
}

/// Static facts about one operator.
#[derive(Clone, Copy, Debug)]
pub struct Descriptor {
    pub id: OpId,
    pub name: &'static str,
    pub version: u32,
    pub min_args: usize,
    pub max_args: usize,
    pub scopes: &'static [Scope],
    /// Warm-up, units and missing-value behaviour, in one line for review and the digest.
    pub semantics: &'static str,
}

const SIGNAL: &[Scope] = &[Scope::Signal];
const ALL_SCOPES: &[Scope] = &[Scope::Signal, Scope::Level, Scope::Trigger];
const LEVEL_UP: &[Scope] = &[Scope::Level, Scope::Trigger];

macro_rules! op {
    ($id:ident, $name:literal, $min:literal, $max:literal, $scopes:expr, $semantics:literal) => {
        Descriptor {
            id: OpId::$id,
            name: $name,
            version: 1,
            min_args: $min,
            max_args: $max,
            scopes: $scopes,
            semantics: $semantics,
        }
    };
}

/// All reviewed operators.
pub const CATALOGUE: &[Descriptor] = &[
    op!(
        Const,
        "const",
        0,
        0,
        ALL_SCOPES,
        "decimal constant with declared unit; warm-up 0"
    ),
    op!(
        BarField,
        "bar_field",
        0,
        0,
        &[Scope::Signal, Scope::Trigger],
        "OHLCV of the current completed bar; signal scope reads the split-adjusted causal series, trigger scope the raw bar; price units, volume shares; warm-up 0; absent bar is missing"
    ),
    op!(
        Ref,
        "ref",
        0,
        0,
        SIGNAL,
        "named indicator defined earlier in the list; unit and warm-up of the target"
    ),
    op!(
        Lag,
        "lag",
        1,
        1,
        SIGNAL,
        "value periods sessions earlier, 1..=60; missing when history is shorter"
    ),
    op!(
        Sma,
        "sma",
        1,
        1,
        SIGNAL,
        "simple mean over window values including the current bar, 1..=252; missing unless the full window exists"
    ),
    op!(
        RsiSimple,
        "rsi_simple",
        1,
        1,
        SIGNAL,
        "price input, points output; 100*sum_gain/(sum_gain+sum_loss) over window close changes, which equals 100-100/(1+mean_gain/mean_loss); needs window+1 values; both sums zero is missing(UNDEFINED_FLAT); no Wilder smoothing"
    ),
    op!(
        AtrSimple,
        "atr_simple",
        0,
        0,
        SIGNAL,
        "price output; simple mean over window of max(high-low,abs(high-previous_close),abs(low-previous_close)); needs window+1 bars"
    ),
    op!(Add, "add", 2, 2, ALL_SCOPES, "sum of equal units"),
    op!(Sub, "sub", 2, 2, ALL_SCOPES, "difference of equal units"),
    op!(
        Mul,
        "mul",
        2,
        2,
        ALL_SCOPES,
        "product where one factor is a ratio; result takes the other unit"
    ),
    op!(
        Div,
        "div",
        2,
        2,
        ALL_SCOPES,
        "equal units give a ratio; a ratio divisor keeps the dividend unit; zero divisor is missing(DIV_BY_ZERO)"
    ),
    op!(
        Gt,
        "gt",
        2,
        2,
        ALL_SCOPES,
        "strictly greater, equal numeric units, flag output"
    ),
    op!(
        Gte,
        "gte",
        2,
        2,
        ALL_SCOPES,
        "greater or equal, equal numeric units, flag output"
    ),
    op!(
        Lt,
        "lt",
        2,
        2,
        ALL_SCOPES,
        "strictly less, equal numeric units, flag output"
    ),
    op!(
        Lte,
        "lte",
        2,
        2,
        ALL_SCOPES,
        "less or equal, equal numeric units, flag output"
    ),
    op!(
        And,
        "and",
        2,
        8,
        ALL_SCOPES,
        "all flags true; any missing input makes the result missing"
    ),
    op!(
        Or,
        "or",
        2,
        8,
        ALL_SCOPES,
        "any flag true; any missing input makes the result missing"
    ),
    op!(
        EntryPrice,
        "entry_price",
        0,
        0,
        LEVEL_UP,
        "actual simulated fill price of the position, on the position's share basis"
    ),
    op!(
        Snapshot,
        "snapshot",
        0,
        0,
        LEVEL_UP,
        "value snapshotted at the signal session, converted for intervening splits"
    ),
];

/// Resolve `operator:<id>@<version>`.
///
/// # Errors
/// `UNSUPPORTED_OPERATOR` for an unknown id or a compatibility version this build lacks.
pub fn lookup(reference: &str) -> Result<&'static Descriptor> {
    let unsupported = |why: &str| {
        Failure::new(
            FailureCode::UnsupportedOperator,
            format!("{reference}: {why}"),
        )
    };
    let body = reference
        .strip_prefix("operator:")
        .ok_or_else(|| unsupported("not an operator reference"))?;
    let (name, version) = body
        .split_once('@')
        .ok_or_else(|| unsupported("missing compatibility version"))?;
    // Accept only the canonical spelling of a positive integer. `u32::from_str` would also take
    // a leading plus sign or leading zeros, which would give one operator several identities.
    let canonical = !version.starts_with('0') && version.bytes().all(|b| b.is_ascii_digit());
    if !canonical {
        return Err(unsupported(
            "compatibility version is not a canonical positive integer",
        ));
    }
    let version: u32 = version
        .parse()
        .map_err(|_| unsupported("compatibility version is not a number"))?;
    let descriptor = CATALOGUE
        .iter()
        .find(|descriptor| descriptor.name == name)
        .ok_or_else(|| unsupported("operator is not in the reviewed catalogue"))?;
    if descriptor.version != version {
        return Err(unsupported("unsupported compatibility version"));
    }
    Ok(descriptor)
}

/// Stable text listing every operator, its version, arity, scopes and semantics.
/// Its SHA-256 is the operator-set digest in the engine identity.
#[must_use]
pub fn catalogue_text() -> String {
    let mut out = String::from(OPERATOR_SET);
    out.push('\n');
    for descriptor in CATALOGUE {
        out.push_str(&format!(
            "{}@{} args={}..{} scopes={:?} {}\n",
            descriptor.name,
            descriptor.version,
            descriptor.min_args,
            descriptor.max_args,
            descriptor.scopes,
            descriptor.semantics
        ));
    }
    out
}

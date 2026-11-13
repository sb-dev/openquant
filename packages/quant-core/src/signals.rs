//! Signals at the close of a session (OQ-02 section 2.6).
//!
//! Signal inputs come from the causal series: bars up to the decision session, split-adjusted
//! with only the actions that were effective and available by that session. Volume adjusts
//! inversely. Dividends never adjust prices.

use crate::{
    data::RunInput,
    model::{Failure, FailureCode, Result},
    numeric::{Decimal, div, mul},
    operators::{Env, PriceBar, Value, compile::Node, eval::eval},
    strategy::ValidatedStrategy,
};

/// A split that has been applied by the decision session.
#[derive(Clone, Copy, Debug)]
pub struct AppliedSplit {
    pub effective_index: usize,
    pub new: u64,
    pub old: u64,
}

/// Evaluated signal inputs at one session.
#[derive(Clone, Debug)]
pub struct SignalEval {
    pub indicators: Vec<(String, Value)>,
    pub condition: Value,
    pub rank: Value,
    pub snapshots: Vec<(String, Value)>,
}

/// Build the causal series from the first processed session through `decision` (inclusive).
///
/// `deadline` is the instant by which signal inputs must be available. A bar that becomes
/// available later is future data for this decision.
///
/// # Errors
/// `FUTURE_DATA` for a bar available after `deadline`; `ARITHMETIC_OVERFLOW` on overflow.
pub fn build_series(
    input: &RunInput,
    decision: usize,
    splits: &[AppliedSplit],
    deadline: Option<&str>,
) -> Result<Vec<Option<PriceBar>>> {
    let mut series = Vec::with_capacity(decision.saturating_sub(input.first) + 1);
    for index in input.first..=decision {
        let Some(session) = input.sessions.get(index) else {
            return Err(Failure::internal("session index"));
        };
        let Some(bar) = input.bars.get(&session.date) else {
            series.push(None);
            continue;
        };
        if let Some(deadline) = deadline
            && bar.available_at.as_str() > deadline
        {
            return Err(Failure::new(
                FailureCode::FutureData,
                format!(
                    "bar {} becomes available at {} after the decision deadline {deadline}",
                    session.date, bar.available_at
                ),
            ));
        }
        let mut numerator = Decimal::ONE;
        let mut denominator = Decimal::ONE;
        for split in splits
            .iter()
            .filter(|s| s.effective_index > index && s.effective_index <= decision)
        {
            numerator = mul(numerator, Decimal::from(split.old))?;
            denominator = mul(denominator, Decimal::from(split.new))?;
        }
        let price =
            |value: Decimal| -> Result<Decimal> { div(mul(value, numerator)?, denominator) };
        series.push(Some(PriceBar {
            open: price(bar.open)?,
            high: price(bar.high)?,
            low: price(bar.low)?,
            close: price(bar.close)?,
            volume: div(mul(bar.volume, denominator)?, numerator)?,
        }));
    }
    Ok(series)
}

struct SignalEnv<'a> {
    series: &'a [Option<PriceBar>],
    strategy: &'a ValidatedStrategy,
}

impl Env for SignalEnv<'_> {
    fn bar(&self, at: usize) -> Option<&PriceBar> {
        self.series.get(at).and_then(Option::as_ref)
    }

    fn indicator(&self, index: usize) -> Option<&Node> {
        self.strategy.indicators.get(index).map(|i| &i.node)
    }

    fn entry_price(&self) -> Option<Decimal> {
        None
    }

    fn snapshot(&self, _name: &str) -> Option<Decimal> {
        None
    }
}

/// Evaluate indicators, entry condition, rank and snapshots at the last series index.
///
/// # Errors
/// `ARITHMETIC_OVERFLOW` on overflow or an internal inconsistency.
pub fn evaluate_signals(
    strategy: &ValidatedStrategy,
    series: &[Option<PriceBar>],
) -> Result<SignalEval> {
    let Some(at) = series.len().checked_sub(1) else {
        return Err(Failure::internal("empty series"));
    };
    let env = SignalEnv { series, strategy };
    let mut indicators = Vec::with_capacity(strategy.indicators.len());
    for item in &strategy.indicators {
        indicators.push((item.name.clone(), eval(&item.node, at, &env)?));
    }
    let condition = eval(&strategy.condition, at, &env)?;
    let rank = eval(&strategy.rank, at, &env)?;
    let mut snapshots = Vec::with_capacity(strategy.snapshots.len());
    for item in &strategy.snapshots {
        snapshots.push((item.name.clone(), eval(&item.node, at, &env)?));
    }
    Ok(SignalEval {
        indicators,
        condition,
        rank,
        snapshots,
    })
}

/// Environment for levels and triggers: one raw bar at index 0, the entry price and snapshots.
pub struct LevelEnv<'a> {
    pub bar: Option<PriceBar>,
    pub entry_price: Decimal,
    pub snapshots: &'a [(String, Decimal)],
}

impl Env for LevelEnv<'_> {
    fn bar(&self, at: usize) -> Option<&PriceBar> {
        if at == 0 { self.bar.as_ref() } else { None }
    }

    fn indicator(&self, _index: usize) -> Option<&Node> {
        None
    }

    fn entry_price(&self) -> Option<Decimal> {
        Some(self.entry_price)
    }

    fn snapshot(&self, name: &str) -> Option<Decimal> {
        self.snapshots
            .iter()
            .find(|(n, _)| n == name)
            .map(|(_, v)| *v)
    }
}

/// Evaluate a level or trigger expression (OQ-02 section 2.6 protection and break-even).
///
/// # Errors
/// `ARITHMETIC_OVERFLOW` on overflow or an internal inconsistency.
pub fn eval_position_expr(node: &Node, env: &LevelEnv<'_>) -> Result<Value> {
    eval(node, 0, env)
}

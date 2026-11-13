//! Signals at the close of a session (OQ-02 section 2.6).
//!
//! Signal inputs come from the causal series: bars up to the decision session, split-adjusted
//! with only the actions that were effective and available by that session. Volume adjusts
//! inversely. Dividends never adjust prices. The adjustment is exact: a price after a 3-for-1
//! split is a third of the raw price, not a 28-digit decimal.

use crate::{
    data::RunInput,
    model::{Failure, FailureCode, Result},
    numeric::Decimal,
    operators::{Env, PriceBar, Value, compile::Node, eval::eval},
    ratio::Ratio,
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
/// `FUTURE_DATA` for a bar available after `deadline`; `ARITHMETIC_OVERFLOW` when an exact value
/// does not fit 128 bits.
pub fn build_series(
    input: &RunInput,
    decision: usize,
    splits: &[AppliedSplit],
    deadline: Option<&str>,
) -> Result<Vec<Option<PriceBar>>> {
    if decision >= input.sessions.len() {
        return Err(Failure::internal("decision session index"));
    }
    let mut series = Vec::with_capacity(decision.saturating_sub(input.first).saturating_add(1));
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
        // Prices multiply by old/new for every split after the bar and by the product of the
        // splits, volume by the inverse.
        let mut prices = Ratio::ONE;
        for split in splits
            .iter()
            .filter(|s| s.effective_index > index && s.effective_index <= decision)
        {
            if split.old == 0 || split.new == 0 {
                // The schema bounds both terms from below by 1; a hand-built split can still
                // carry a zero, which divides by zero when it is applied.
                return Err(Failure::new(
                    FailureCode::ArithmeticOverflow,
                    format!(
                        "split {} for {} cannot be applied: a ratio term is zero",
                        split.new, split.old
                    ),
                ));
            }
            prices = prices.mul(Ratio::new(i128::from(split.old), i128::from(split.new))?)?;
        }
        let volumes = Ratio::ONE.div(prices)?;
        let price = |value: Decimal| Ratio::from(value).mul(prices);
        series.push(Some(PriceBar {
            open: price(bar.open)?,
            high: price(bar.high)?,
            low: price(bar.low)?,
            close: price(bar.close)?,
            volume: Ratio::from(bar.volume).mul(volumes)?,
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

    fn entry_price(&self) -> Option<Ratio> {
        None
    }

    fn snapshot(&self, _name: &str) -> Option<Ratio> {
        None
    }
}

/// Evaluate indicators, entry condition, rank and snapshots at the last series index.
///
/// # Errors
/// `ARITHMETIC_OVERFLOW` when an exact value does not fit 128 bits, or an internal inconsistency.
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
    pub entry_price: Ratio,
    pub snapshots: &'a [(String, Ratio)],
}

impl Env for LevelEnv<'_> {
    fn bar(&self, at: usize) -> Option<&PriceBar> {
        if at == 0 { self.bar.as_ref() } else { None }
    }

    fn indicator(&self, _index: usize) -> Option<&Node> {
        None
    }

    fn entry_price(&self) -> Option<Ratio> {
        Some(self.entry_price)
    }

    fn snapshot(&self, name: &str) -> Option<Ratio> {
        self.snapshots
            .iter()
            .find(|(n, _)| n == name)
            .map(|(_, v)| *v)
    }
}

/// Evaluate a level or trigger expression (OQ-02 section 2.6 protection and break-even).
///
/// # Errors
/// `ARITHMETIC_OVERFLOW` when an exact value does not fit 128 bits, or an internal inconsistency.
pub fn eval_position_expr(node: &Node, env: &LevelEnv<'_>) -> Result<Value> {
    eval(node, 0, env)
}

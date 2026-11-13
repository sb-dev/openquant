//! Evaluate compiled operator trees against an environment.
//!
//! One evaluator serves signal, level and trigger scopes; only the environment differs.
//! Missing values propagate explicitly. Nothing is substituted or approximated.

use super::{
    catalogue::OpId,
    compile::{Field, Node},
    indicators::{self, Outcome},
};
use crate::{
    model::{Failure, MissingReason, Result},
    numeric::Decimal,
    ratio::Ratio,
};

/// An evaluated value. Units are static and live on the [`Node`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Value {
    Num(Ratio),
    Flag(bool),
    Missing(MissingReason),
}

/// A bar in one price basis, with exact fractions: a split-adjusted price such as `100 / 3` is
/// not rounded to a decimal.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PriceBar {
    pub open: Ratio,
    pub high: Ratio,
    pub low: Ratio,
    pub close: Ratio,
    pub volume: Ratio,
}

impl PriceBar {
    /// A bar from decimal prices and volume, exactly.
    #[must_use]
    pub fn from_decimals(
        open: Decimal,
        high: Decimal,
        low: Decimal,
        close: Decimal,
        volume: Decimal,
    ) -> Self {
        Self {
            open: Ratio::from_decimal(open),
            high: Ratio::from_decimal(high),
            low: Ratio::from_decimal(low),
            close: Ratio::from_decimal(close),
            volume: Ratio::from_decimal(volume),
        }
    }

    #[must_use]
    pub fn field(&self, field: Field) -> Ratio {
        match field {
            Field::Open => self.open,
            Field::High => self.high,
            Field::Low => self.low,
            Field::Close => self.close,
            Field::Volume => self.volume,
        }
    }
}

/// What an expression may read.
pub trait Env {
    /// The bar at series index `at`, or `None` when the observation is absent.
    fn bar(&self, at: usize) -> Option<&PriceBar>;
    /// The compiled indicator at `index` (signal scope).
    fn indicator(&self, index: usize) -> Option<&Node>;
    /// The position's entry price (level and trigger scopes).
    fn entry_price(&self) -> Option<Ratio>;
    /// A named snapshot value (level and trigger scopes).
    fn snapshot(&self, name: &str) -> Option<Ratio>;
}

/// Evaluate `node` at series index `at`.
///
/// # Errors
/// `ARITHMETIC_OVERFLOW` when an exact intermediate value does not fit 128 bits, or an internal
/// inconsistency failure.
pub fn eval(node: &Node, at: usize, env: &dyn Env) -> Result<Value> {
    match node.op {
        OpId::Const => Ok(Value::Num(node.value)),
        OpId::BarField => Ok(env
            .bar(at)
            .map_or(Value::Missing(MissingReason::InsufficientHistory), |bar| {
                Value::Num(bar.field(node.field))
            })),
        OpId::Ref => {
            let target = env
                .indicator(node.index)
                .ok_or_else(|| Failure::internal("indicator reference"))?;
            eval(target, at, env)
        }
        OpId::Lag => match at.checked_sub(node.periods) {
            Some(earlier) => eval(arg(node, 0)?, earlier, env),
            None => Ok(Value::Missing(MissingReason::InsufficientHistory)),
        },
        OpId::Sma => match collect(arg(node, 0)?, at, node.window, env)? {
            Err(reason) => Ok(Value::Missing(reason)),
            Ok(values) => Ok(outcome(indicators::mean(&values)?)),
        },
        OpId::RsiSimple => match collect(arg(node, 0)?, at, node.window.saturating_add(1), env)? {
            Err(reason) => Ok(Value::Missing(reason)),
            Ok(prices) => Ok(outcome(indicators::rsi(&prices)?)),
        },
        OpId::AtrSimple => atr(node.window, at, env),
        OpId::EntryPrice => Ok(env
            .entry_price()
            .map_or(Value::Missing(MissingReason::UpstreamMissing), Value::Num)),
        OpId::Snapshot => Ok(env
            .snapshot(&node.name)
            .map_or(Value::Missing(MissingReason::UpstreamMissing), Value::Num)),
        OpId::Add | OpId::Sub | OpId::Mul | OpId::Div => arithmetic(node, at, env),
        OpId::Gt | OpId::Gte | OpId::Lt | OpId::Lte => comparison(node, at, env),
        OpId::And | OpId::Or => boolean(node, at, env),
    }
}

fn arg(node: &Node, index: usize) -> Result<&Node> {
    node.args
        .get(index)
        .ok_or_else(|| Failure::internal("missing argument"))
}

fn outcome(result: Outcome) -> Value {
    match result {
        Outcome::Num(value) => Value::Num(value),
        Outcome::Missing(reason) => Value::Missing(reason),
    }
}

/// Evaluate `node` at the `count` indices ending at `at`, oldest first.
fn collect(
    node: &Node,
    at: usize,
    count: usize,
    env: &dyn Env,
) -> Result<std::result::Result<Vec<Ratio>, MissingReason>> {
    let Some(start) = at.checked_add(1).and_then(|end| end.checked_sub(count)) else {
        return Ok(Err(MissingReason::InsufficientHistory));
    };
    let mut values = Vec::with_capacity(count);
    for index in start..=at {
        match eval(node, index, env)? {
            Value::Num(value) => values.push(value),
            Value::Missing(reason) => return Ok(Err(reason)),
            Value::Flag(_) => return Err(Failure::internal("flag in a numeric window")),
        }
    }
    Ok(Ok(values))
}

fn atr(window: usize, at: usize, env: &dyn Env) -> Result<Value> {
    let Some(start) = at.checked_sub(window) else {
        return Ok(Value::Missing(MissingReason::InsufficientHistory));
    };
    let mut ranges = Vec::with_capacity(window);
    // Each true range needs the bar and its predecessor: `window` ranges, `window + 1` bars.
    for index in start.saturating_add(1)..=at {
        let previous = index.checked_sub(1).and_then(|before| env.bar(before));
        let (Some(bar), Some(previous)) = (env.bar(index), previous) else {
            return Ok(Value::Missing(MissingReason::InsufficientHistory));
        };
        ranges.push(indicators::true_range(bar.high, bar.low, previous.close)?);
    }
    Ok(outcome(indicators::mean(&ranges)?))
}

/// Evaluate both arguments; return the first missing reason, else the two numbers.
fn operands(
    node: &Node,
    at: usize,
    env: &dyn Env,
) -> Result<std::result::Result<(Ratio, Ratio), MissingReason>> {
    let first = eval(arg(node, 0)?, at, env)?;
    let second = eval(arg(node, 1)?, at, env)?;
    match (first, second) {
        (Value::Missing(reason), _) | (_, Value::Missing(reason)) => Ok(Err(reason)),
        (Value::Num(a), Value::Num(b)) => Ok(Ok((a, b))),
        _ => Err(Failure::internal("non-numeric operand")),
    }
}

fn arithmetic(node: &Node, at: usize, env: &dyn Env) -> Result<Value> {
    let (a, b) = match operands(node, at, env)? {
        Ok(pair) => pair,
        Err(reason) => return Ok(Value::Missing(reason)),
    };
    Ok(Value::Num(match node.op {
        OpId::Add => a.add(b)?,
        OpId::Sub => a.sub(b)?,
        OpId::Mul => a.mul(b)?,
        _ => {
            if b.is_zero() {
                return Ok(Value::Missing(MissingReason::DivByZero));
            }
            a.div(b)?
        }
    }))
}

fn comparison(node: &Node, at: usize, env: &dyn Env) -> Result<Value> {
    let (a, b) = match operands(node, at, env)? {
        Ok(pair) => pair,
        Err(reason) => return Ok(Value::Missing(reason)),
    };
    Ok(Value::Flag(match node.op {
        OpId::Gt => a > b,
        OpId::Gte => a >= b,
        OpId::Lt => a < b,
        _ => a <= b,
    }))
}

fn boolean(node: &Node, at: usize, env: &dyn Env) -> Result<Value> {
    let mut missing = None;
    let mut flags = Vec::with_capacity(node.args.len());
    for child in &node.args {
        match eval(child, at, env)? {
            Value::Flag(flag) => flags.push(flag),
            Value::Missing(reason) => {
                missing.get_or_insert(reason);
            }
            Value::Num(_) => return Err(Failure::internal("number in a boolean operator")),
        }
    }
    if let Some(reason) = missing {
        return Ok(Value::Missing(reason));
    }
    Ok(Value::Flag(if node.op == OpId::And {
        flags.iter().all(|flag| *flag)
    } else {
        flags.iter().any(|flag| *flag)
    }))
}

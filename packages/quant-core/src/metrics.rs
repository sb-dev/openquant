//! Per-run metrics of derived evidence (OQ-02 section 3.6; decision D4 of the S1 pilot record).
//!
//! `compute_metrics` reads one `COMPLETED` numerical result and the run that produced it, and
//! writes the `evaluation-metrics/1` document. Only scored sessions count. Every value is
//! computed exactly as a fraction of big integers ([`crate::exact::Q`]) and rounded once,
//! half-even: ratios to the cohort policy's `metric_scale`, money to the run's `money_scale`.
//! Counts are integers. Nothing is compared with a tolerance.
//!
//! The functions of this module never run the evaluator and never change a result. The
//! definitions below are the ones in `method.txt`, which binds them to the method identity.
//!
//! * The series is `E0`, the initial capital, then the equity `E1..En` of the daily record of
//!   each scored session.
//! * `net_return = En / E0 - 1`.
//! * `max_drawdown` is the largest `(P - E) / P` over the scored sessions, where `P` is the
//!   highest equity of the series up to that session, `E0` included. A loss on the first scored
//!   session therefore counts against the initial capital. A series that never falls is zero.
//! * `worst_session_return` is the lowest `E(t) / E(t-1) - 1`. It can be positive.
//! * `turnover` is the total notional of the scored fills, buys and sells, over `E0`.
//! * `trade_count` is the number of trades that closed in the scored period. A position still
//!   open at the end is not counted.
//! * Execution cost is the fees of the scored fills plus the gap slippage. A gap-stop exit fills
//!   at the open reduced by the slippage allowance, so its slippage is
//!   `quantity * (open - fill price)`, measured against the open of the exit session. The
//!   schema describes it as measured "against the stop level"; that figure also contains the
//!   market's move between the stop and the open, which no cost model owns, and the stop is not
//!   recoverable exactly from the journal when it is off the price grid. The method text states
//!   this choice.
//! * `exposure` is the mean over the scored sessions of positions value over equity at the close.
//! * Buy-and-hold and the excess return come from [`crate::benchmark`]. The excess return is the
//!   strategy's exact net return minus the benchmark's exact net return, rounded once; it can
//!   differ by one unit of the last digit from the difference of the two published values.

use openquant_contracts::{
    generated::{self as g, Status},
    parse_value, payload_digest,
};
use serde_json::{Value, json};
use thiserror::Error;

use crate::{
    benchmark::{self, BuyAndHold},
    exact::{ExactError, Q},
    numeric::fixed_string,
    run::Run,
};

/// The role of a scored window (OQ-02 section 3.1).
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Window {
    Development,
    Validation,
    Holdout,
}

impl Window {
    /// The wire name.
    #[must_use]
    pub const fn wire(self) -> &'static str {
        match self {
            Self::Development => "DEVELOPMENT",
            Self::Validation => "VALIDATION",
            Self::Holdout => "HOLDOUT",
        }
    }

    /// The window of a wire name.
    #[must_use]
    pub fn from_wire(text: &str) -> Option<Self> {
        [Self::Development, Self::Validation, Self::Holdout]
            .into_iter()
            .find(|window| window.wire() == text)
    }
}

/// The cost scenario of a run.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Scenario {
    Base,
    CostStress,
}

impl Scenario {
    /// The wire name.
    #[must_use]
    pub const fn wire(self) -> &'static str {
        match self {
            Self::Base => "BASE",
            Self::CostStress => "COST_STRESS",
        }
    }

    /// The scenario of a wire name.
    #[must_use]
    pub fn from_wire(text: &str) -> Option<Self> {
        [Self::Base, Self::CostStress]
            .into_iter()
            .find(|scenario| scenario.wire() == text)
    }
}

/// The identity of a reviewed method text, as the envelopes carry it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MethodRef {
    pub name: String,
    pub version: String,
    /// `sha256:` and 64 lower-case hexadecimal digits.
    pub digest: String,
}

impl MethodRef {
    /// The `method` member of a derived payload.
    #[must_use]
    pub fn to_value(&self) -> Value {
        json!({"name": self.name, "version": self.version, "digest": self.digest})
    }
}

/// Why derived evidence could not be produced. Never a guess: no variant returns a number.
#[derive(Debug, Error)]
pub enum EvidenceError {
    /// Metrics exist only for a `COMPLETED` outcome.
    #[error("the run's outcome is {0}, not COMPLETED: there are no metrics")]
    NotCompleted(String),
    /// The result does not belong to the run it is read with.
    #[error("the result does not belong to this run: {0}")]
    IdentityMismatch(String),
    /// The result contradicts itself or the run: an internal inconsistency.
    #[error("the result is inconsistent: {0}")]
    Inconsistent(String),
    /// A ratio would divide by an equity that is not positive.
    #[error("the equity at {0} is not positive: a ratio over it is undefined")]
    NonPositiveEquity(String),
    #[error("exact arithmetic failed: {0}")]
    Exact(#[from] ExactError),
    /// The finished document failed its own schema. This is a defect of this module.
    #[error("the evidence document is invalid: {0}")]
    Contract(String),
}

/// What the caller supplies besides the run and its result.
#[derive(Clone, Debug)]
pub struct MetricsContext<'a> {
    pub run_id: &'a str,
    pub window: Window,
    pub scenario: Scenario,
    /// The policy currency, which money metrics carry.
    pub currency: &'a str,
    /// Fractional digits of every ratio (the cohort policy's `metric_scale`).
    pub metric_scale: u32,
    /// The cohort policy's approved uncertainty limitation, repeated verbatim.
    pub limitation: &'a str,
    pub method: &'a MethodRef,
}

/// The end of one scored session.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SessionPoint {
    pub equity: Q,
    pub positions_value: Q,
}

/// The figures that the equity series alone determines.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SeriesFigures {
    pub net_return: Q,
    pub max_drawdown: Q,
    pub worst_session_return: Q,
    pub exposure: Q,
}

fn positive(value: &Q, label: impl FnOnce() -> String) -> Result<(), EvidenceError> {
    if value.is_positive() {
        Ok(())
    } else {
        Err(EvidenceError::NonPositiveEquity(label()))
    }
}

/// `final / initial - 1`.
///
/// # Errors
/// [`EvidenceError::NonPositiveEquity`] when `initial` is not positive.
pub fn net_return(initial: &Q, last: &Q) -> Result<Q, EvidenceError> {
    positive(initial, || "the initial capital".to_owned())?;
    Ok(&last.checked_div(initial)? - &Q::one())
}

/// The largest fall from a running peak, as a fraction of that peak. The series starts at
/// `initial`, which is the first peak.
///
/// # Errors
/// [`EvidenceError::NonPositiveEquity`] when a value of the series is not positive.
pub fn max_drawdown(initial: &Q, equities: &[Q]) -> Result<Q, EvidenceError> {
    positive(initial, || "the initial capital".to_owned())?;
    let mut peak = initial.clone();
    let mut worst = Q::zero();
    for (index, equity) in equities.iter().enumerate() {
        positive(equity, || format!("scored session {}", index + 1))?;
        if *equity > peak {
            peak = equity.clone();
        }
        let drawdown = (&peak - equity).checked_div(&peak)?;
        if drawdown > worst {
            worst = drawdown;
        }
    }
    Ok(worst)
}

/// Net return, drawdown, worst session return and exposure of a scored series.
///
/// # Errors
/// [`EvidenceError::Inconsistent`] for an empty series and
/// [`EvidenceError::NonPositiveEquity`] for a value that is not positive.
pub fn series_figures(
    initial: &Q,
    points: &[SessionPoint],
) -> Result<SeriesFigures, EvidenceError> {
    let Some(last) = points.last() else {
        return Err(EvidenceError::Inconsistent(
            "no scored session has a daily record".to_owned(),
        ));
    };
    positive(initial, || "the initial capital".to_owned())?;
    let equities: Vec<Q> = points.iter().map(|p| p.equity.clone()).collect();
    let mut previous = initial.clone();
    let mut lowest: Option<Q> = None;
    let mut shares = Vec::with_capacity(points.len());
    for (index, point) in points.iter().enumerate() {
        positive(&point.equity, || format!("scored session {}", index + 1))?;
        let step = point.equity.checked_div(&previous)?;
        lowest = Some(match lowest {
            Some(current) if current <= step => current,
            _ => step,
        });
        shares.push(point.positions_value.checked_div(&point.equity)?);
        previous = point.equity.clone();
    }
    let count = i64::try_from(points.len())
        .map_err(|_| EvidenceError::Inconsistent("too many scored sessions".to_owned()))?;
    let worst = lowest.unwrap_or_else(Q::one);
    Ok(SeriesFigures {
        net_return: net_return(initial, &last.equity)?,
        max_drawdown: max_drawdown(initial, &equities)?,
        worst_session_return: &worst - &Q::one(),
        exposure: Q::sum(shares.iter()).checked_div(&Q::from_int(count))?,
    })
}

fn ratio(value: &Q, scale: u32) -> Result<Value, EvidenceError> {
    Ok(json!({"unit": "RATIO", "value": value.to_fixed(scale)?}))
}

fn money(value: &Q, scale: u32, currency: &str) -> Result<Value, EvidenceError> {
    Ok(json!({"unit": "MONEY", "currency": currency, "value": value.to_fixed(scale)?}))
}

fn text_q(text: &str) -> Result<Q, EvidenceError> {
    Q::parse(text).map_err(EvidenceError::from)
}

fn inconsistent(detail: impl Into<String>) -> EvidenceError {
    EvidenceError::Inconsistent(detail.into())
}

fn identity_mismatch(what: &str, result: &str, run: &str) -> EvidenceError {
    EvidenceError::IdentityMismatch(format!("{what} {result} differs from the run's {run}"))
}

/// The metrics of one completed run.
///
/// # Errors
/// [`EvidenceError::NotCompleted`] unless the outcome is `COMPLETED` (a `FAILED` or
/// `INSUFFICIENT` run has no metrics), [`EvidenceError::IdentityMismatch`] when the result's
/// strategy, input or engine digest is not the run's, [`EvidenceError::Inconsistent`] when the
/// journal does not fit the run, and [`EvidenceError::NonPositiveEquity`] when a ratio would
/// divide by an equity that is not positive.
pub fn compute_metrics(
    run: &Run,
    result: &g::EvaluationResult,
    ctx: &MetricsContext<'_>,
) -> Result<g::EvaluationMetrics, EvidenceError> {
    if result.outcome.status != Status::Completed {
        return Err(EvidenceError::NotCompleted(
            result.outcome.status.to_string(),
        ));
    }
    if result.strategy_hash.as_str() != run.strategy_hash {
        return Err(identity_mismatch(
            "strategy hash",
            result.strategy_hash.as_str(),
            &run.strategy_hash,
        ));
    }
    if result.input_hash.as_str() != run.input_hash {
        return Err(identity_mismatch(
            "input hash",
            result.input_hash.as_str(),
            &run.input_hash,
        ));
    }
    if result.engine_digest.as_str() != run.engine_digest {
        return Err(identity_mismatch(
            "engine digest",
            result.engine_digest.as_str(),
            &run.engine_digest,
        ));
    }
    let input = &run.input;
    let (first, scored, last) = (input.first, input.scored_start, input.last);
    let sessions = &input.sessions;
    let daily = &result.journal.daily;
    if daily.len() != last - first + 1 {
        return Err(inconsistent(format!(
            "{} daily records for {} processed sessions",
            daily.len(),
            last - first + 1
        )));
    }
    for (offset, record) in daily.iter().enumerate() {
        let expected = sessions.get(first + offset).map(|s| s.date.as_str());
        if expected != Some(record.session.as_str()) {
            return Err(inconsistent(format!(
                "daily record {offset} is for {} and the run's session is {expected:?}",
                record.session.as_str()
            )));
        }
    }
    let initial = Q::from_decimal(&input.initial_capital);
    let (warmup, scored_records) = daily.split_at(scored - first);
    for record in warmup {
        if text_q(record.equity.as_str())? != initial {
            return Err(inconsistent(format!(
                "the equity of warm-up session {} is {}, not the initial capital",
                record.session.as_str(),
                record.equity.as_str()
            )));
        }
    }
    let mut points = Vec::with_capacity(scored_records.len());
    for record in scored_records {
        points.push(SessionPoint {
            equity: text_q(record.equity.as_str())?,
            positions_value: text_q(record.positions_value.as_str())?,
        });
    }
    let figures = series_figures(&initial, &points)?;
    if let Some(last_point) = points.last()
        && last_point.equity != text_q(result.final_.equity.as_str())?
    {
        return Err(inconsistent(
            "the final equity differs from the last daily equity",
        ));
    }

    let scored_start = sessions
        .get(scored)
        .map(|s| s.date.as_str())
        .ok_or_else(|| inconsistent("the scored start is not a session"))?;
    let scored_end = sessions
        .get(last)
        .map(|s| s.date.as_str())
        .ok_or_else(|| inconsistent("the scored end is not a session"))?;
    let in_scored = |session: &str| session >= scored_start && session <= scored_end;

    let mut notional = Q::zero();
    let mut fees = Q::zero();
    let mut gap_slippage = Q::zero();
    for fill in &result.journal.fills {
        if !in_scored(fill.session.as_str()) {
            continue;
        }
        notional = &notional + &text_q(fill.notional.as_str())?;
        fees = &fees + &text_q(fill.fee.as_str())?;
        if fill.reason == g::FillRecordReason::GapStop {
            let open = input
                .bars
                .get(fill.session.as_str())
                .map(|bar| Q::from_decimal(&bar.open))
                .ok_or_else(|| {
                    inconsistent(format!(
                        "gap-stop fill on {} has no bar in the input",
                        fill.session.as_str()
                    ))
                })?;
            let slip = &text_q(fill.quantity.as_str())? * &(&open - &text_q(fill.price.as_str())?);
            if slip.is_negative() {
                return Err(inconsistent(format!(
                    "gap-stop fill on {} is above the open",
                    fill.session.as_str()
                )));
            }
            gap_slippage = &gap_slippage + &slip;
        }
    }
    let turnover = notional.checked_div(&initial)?;
    let trade_count = result
        .journal
        .trades
        .iter()
        .filter(|trade| {
            trade.exit_reason != g::TradeRecordExitReason::OpenAtEnd
                && trade
                    .exit_session
                    .as_ref()
                    .is_some_and(|s| in_scored(s.as_str()))
        })
        .count();
    let total_cost = &fees + &gap_slippage;

    let scale = ctx.metric_scale;
    let money_scale = input.policy.money_scale;
    let cash_excess = figures.net_return.clone();
    let buy_and_hold = match benchmark::buy_and_hold(run) {
        BuyAndHold::Unavailable { reason } => json!({"status": "INSUFFICIENT", "reason": reason}),
        BuyAndHold::Computed(path) => {
            let held_return = net_return(
                &initial,
                path.equities
                    .last()
                    .ok_or_else(|| inconsistent("the benchmark has no session"))?,
            )?;
            let held_drawdown = max_drawdown(&initial, &path.equities)?;
            json!({
                "status": "COMPUTED",
                "entry_session": path.entry_session,
                "quantity": fixed_string(path.quantity, input.policy.quantity_scale)
                    .map_err(|f| inconsistent(f.to_string()))?,
                "net_return": ratio(&held_return, scale)?,
                "max_drawdown": ratio(&held_drawdown, scale)?,
                "excess_return": ratio(&(&figures.net_return - &held_return), scale)?,
            })
        }
    };
    let document = json!({
        "schema_version": "evaluation-metrics/1",
        "run_id": ctx.run_id,
        "source": {
            "result_digest": payload_digest(result)
                .map_err(|e| EvidenceError::Contract(e.to_string()))?,
            "input_hash": run.input_hash,
            "strategy_hash": run.strategy_hash,
            "engine_digest": run.engine_digest,
        },
        "method": ctx.method.to_value(),
        "metric_scale": scale,
        "window": {
            "role": ctx.window.wire(),
            "cost_scenario": ctx.scenario.wire(),
            "scored": {"start": scored_start, "end": scored_end},
        },
        "strategy": {
            "net_return": ratio(&figures.net_return, scale)?,
            "max_drawdown": ratio(&figures.max_drawdown, scale)?,
            "worst_session_return": ratio(&figures.worst_session_return, scale)?,
            "turnover": ratio(&turnover, scale)?,
            "trade_count": {"unit": "COUNT", "value": trade_count},
            "scored_session_count": {"unit": "COUNT", "value": points.len()},
            "execution_cost": {
                "fees": money(&fees, money_scale, ctx.currency)?,
                "gap_slippage": money(&gap_slippage, money_scale, ctx.currency)?,
                "total": money(&total_cost, money_scale, ctx.currency)?,
            },
            "exposure": ratio(&figures.exposure, scale)?,
        },
        "benchmarks": {
            "buy_and_hold": buy_and_hold,
            "cash": {
                "net_return": ratio(&Q::zero(), scale)?,
                "excess_return": ratio(&cash_excess, scale)?,
            },
        },
        "uncertainty": {"status": "NOT_COMPUTED", "limitation": ctx.limitation},
    });
    parse_value::<g::EvaluationMetrics>(document)
        .map_err(|e| EvidenceError::Contract(e.to_string()))
}

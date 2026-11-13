//! After close: value holdings, schedule stop changes, then rank new entries and reserve their
//! caps for the next open (OQ-02 sections 2.4-2.6).

use openquant_contracts::generated as g;

use super::accounting::{position_view, positions_value, reserve};
use crate::{
    format::{ident, session_date},
    interfaces::MarketEvent,
    model::{Failure, FailureCode, Result, SkipReason},
    numeric::{Decimal, add, div, floor_to},
    operators::{PriceBar, Value},
    run::Run,
    signals::{AppliedSplit, LevelEnv, build_series, eval_position_expr, evaluate_signals},
    state::{Pending, Scheduled, State},
};

/// Run the after-close phase.
pub fn run(
    run: &Run,
    state: &mut State,
    event: &MarketEvent,
    notes: &mut Vec<String>,
) -> Result<()> {
    let date = event.cursor.session.clone();
    let Some(observation) = &event.observation else {
        if !state.positions.is_empty() {
            return Err(Failure::new(
                FailureCode::UnsupportedValuation,
                format!(
                    "a position is held but session {date} has no bar: valuation and settlement are unsupported"
                ),
            ));
        }
        push_daily(run, state, &date)?;
        return Ok(());
    };
    let (Some(open), Some(high), Some(low), Some(close), Some(volume)) = (
        observation.open,
        observation.high,
        observation.low,
        observation.close,
        observation.volume,
    ) else {
        return Err(Failure::internal("after-close observation is incomplete"));
    };
    let raw = PriceBar {
        open,
        high,
        low,
        close,
        volume,
    };
    for position in &mut state.positions {
        position.mark = close;
    }
    let next_session = if event.session_index < run.input.last {
        Some(run.session(event.session_index + 1)?.clone())
    } else {
        None
    };
    schedule_stop_changes(
        run,
        state,
        &raw,
        next_session.as_ref().map(|s| s.date.as_str()),
    )?;
    decide_entry(
        run,
        state,
        event,
        next_session.as_ref().map(|s| s.open_at.as_str()),
        notes,
    )?;
    // The daily record is the end-of-session state, after reservations for the next open.
    push_daily(run, state, &date)
}

fn push_daily(run: &Run, state: &mut State, date: &str) -> Result<()> {
    let value = positions_value(state)?;
    let receivables = state.receivables_total();
    let equity = add(
        add(add(state.cash_available, state.cash_reserved)?, receivables)?,
        value,
    )?;
    let mut positions = Vec::with_capacity(state.positions.len());
    for position in &state.positions {
        positions.push(position_view(run, position)?);
    }
    state.journal.daily.push(g::DailyRecord {
        cash_available: run.fmt.money(state.cash_available)?,
        cash_reserved: run.fmt.money(state.cash_reserved)?,
        equity: run.fmt.money(equity)?,
        positions,
        positions_value: run.fmt.money(value)?,
        receivables: run.fmt.money(receivables)?,
        session: session_date(date)?,
    });
    Ok(())
}

/// A one-time stop change is decided at the close and takes effect at the next session's
/// before-open phase. It applies to every surviving position, including one filled today.
fn schedule_stop_changes(
    run: &Run,
    state: &mut State,
    raw: &PriceBar,
    next_session: Option<&str>,
) -> Result<()> {
    let Some(next_session) = next_session else {
        return Ok(());
    };
    for position in &mut state.positions {
        for adjustment in &run.strategy.adjustments {
            if position.fired.contains(&adjustment.id) {
                continue;
            }
            let env = LevelEnv {
                bar: Some(raw.clone()),
                entry_price: position.entry_price,
                snapshots: &position.snapshots,
            };
            if eval_position_expr(&adjustment.trigger, &env)? != Value::Flag(true) {
                continue;
            }
            let level = match eval_position_expr(&adjustment.new_level, &env)? {
                Value::Num(level) if level > Decimal::ZERO => level,
                other => {
                    return Err(Failure::new(
                        FailureCode::InvalidLevel,
                        format!(
                            "{}: new stop level is invalid: {other:?}",
                            position.trade_id
                        ),
                    ));
                }
            };
            position.fired.push(adjustment.id.clone());
            position.scheduled = Some(Scheduled {
                level,
                effective_session: next_session.to_owned(),
            });
        }
    }
    Ok(())
}

fn applied_splits(run: &Run, state: &State) -> Result<Vec<AppliedSplit>> {
    let mut splits = Vec::new();
    for action in &run.input.actions {
        if let crate::data::ActionKind::Split { new, old } = &action.kind
            && state.applied.contains(&action.id)
        {
            splits.push(AppliedSplit {
                effective_index: run.index_of(&action.effective_session)?,
                new: *new,
                old: *old,
            });
        }
    }
    Ok(splits)
}

fn indicator_value(run: &Run, name: &str, value: Value) -> Result<g::IndicatorValue> {
    let (value, missing_reason) = match value {
        Value::Num(number) => (Some(run.fmt.diag(number)?), None),
        Value::Flag(flag) => (
            Some(crate::format::gdec(if flag { "1" } else { "0" })?),
            None,
        ),
        Value::Missing(reason) => (None, Some(reason)),
    };
    Ok(g::IndicatorValue {
        missing_reason,
        name: ident(name)?,
        value,
    })
}

fn decide_entry(
    run: &Run,
    state: &mut State,
    event: &MarketEvent,
    next_open: Option<&str>,
    notes: &mut Vec<String>,
) -> Result<()> {
    let date = event.cursor.session.clone();
    let splits = applied_splits(run, state)?;
    let series = build_series(&run.input, event.session_index, &splits, next_open)?;
    let signals = evaluate_signals(&run.strategy, &series)?;

    let condition = match signals.condition {
        Value::Flag(true) => g::SignalRecordCondition::True,
        Value::Flag(false) => g::SignalRecordCondition::False,
        Value::Missing(_) => g::SignalRecordCondition::Missing,
        Value::Num(_) => return Err(Failure::internal("entry condition is numeric")),
    };
    let mut indicators = Vec::new();
    for (name, value) in &signals.indicators {
        indicators.push(indicator_value(run, name, *value)?);
    }

    let mut decision = g::SignalRecordDecision::Skipped;
    let mut skip_reason = None;
    let mut rank_shown = None;
    let scored = event.session_index >= run.input.scored_start;
    if !scored {
        skip_reason = Some(SkipReason::NotScoredYet);
    } else if next_open.is_none() {
        skip_reason = Some(SkipReason::NoNextSession);
    } else if condition == g::SignalRecordCondition::Missing {
        skip_reason = Some(SkipReason::IndicatorUnavailable);
    } else if condition == g::SignalRecordCondition::False {
        decision = g::SignalRecordDecision::NoEntry;
    } else if state
        .positions
        .iter()
        .any(|p| p.instrument_id == run.input.instrument_id)
    {
        skip_reason = Some(SkipReason::Held);
    } else {
        let occupied = state.positions.len() + state.pending.len();
        let vacant = run.strategy.slots.saturating_sub(occupied);
        if let Value::Num(rank) = signals.rank {
            rank_shown = Some(run.fmt.diag(rank)?);
        }
        let snapshot_values: Option<Vec<(String, Decimal)>> = signals
            .snapshots
            .iter()
            .map(|(name, value)| match value {
                Value::Num(number) => Some((name.clone(), *number)),
                _ => None,
            })
            .collect();
        match (vacant, signals.rank, snapshot_values) {
            (0, _, _) => skip_reason = Some(SkipReason::NoVacantSlot),
            (_, Value::Num(rank), Some(snapshots)) => {
                let cap = floor_to(
                    div(state.cash_available, Decimal::from(vacant as u64))?,
                    run.input.policy.money_scale,
                );
                if cap <= Decimal::ZERO {
                    skip_reason = Some(SkipReason::CapBelowOneLot);
                } else {
                    let intent_id = format!("I-{date}-{}", run.input.instrument_id);
                    reserve(run, state, event, cap)?;
                    state.journal.entries.push(g::EntryRecord {
                        cap: run.fmt.money(cap)?,
                        fee: None,
                        fill_price: None,
                        intent_id: ident(&intent_id)?,
                        quantity: None,
                        rank: run.fmt.exact(rank)?,
                        reason: None,
                        signal_session: session_date(&date)?,
                        status: g::EntryRecordStatus::Reserved,
                    });
                    state.pending.push(Pending {
                        intent_id,
                        instrument_id: run.input.instrument_id.clone(),
                        signal_session: date.clone(),
                        rank,
                        cap,
                        snapshots,
                    });
                    decision = g::SignalRecordDecision::Enter;
                }
            }
            _ => skip_reason = Some(SkipReason::IndicatorUnavailable),
        }
    }
    if let Some(reason) = skip_reason {
        notes.push(format!("{date}: no entry ({reason:?})"));
    }
    state.journal.signals.push(g::SignalRecord {
        condition,
        decision,
        indicators,
        rank: rank_shown,
        session: session_date(&date)?,
        skip_reason,
    });
    Ok(())
}

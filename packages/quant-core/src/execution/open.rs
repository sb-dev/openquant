//! Open: existing-position gap exits first, then reserved entry intents in frozen rank order.
//! Entries resolve from the opening price. Nothing is re-ranked (OQ-02 section 2.5).

use openquant_contracts::generated as g;

use super::accounting::{Sale, fee_for, ledger, release, sell};
use crate::{
    format::{ident, session_date},
    interfaces::MarketEvent,
    model::{Failure, FailureCode, Result, SkipReason},
    numeric::{Decimal, add, bps_of, div, floor_to, floor_to_lot, mul, sub},
    operators::Value,
    run::Run,
    signals::{LevelEnv, eval_position_expr},
    state::{Pending, Position, State},
};

/// Run the open phase.
pub fn run(
    run: &Run,
    state: &mut State,
    event: &MarketEvent,
    notes: &mut Vec<String>,
) -> Result<()> {
    let Some(open) = event.observation.as_ref().and_then(|o| o.open) else {
        // A non-trading session cannot fill. Pending entries expire and release their cash.
        for pending in std::mem::take(&mut state.pending) {
            expire(run, state, event, &pending, notes)?;
        }
        return Ok(());
    };
    gap_exits(run, state, event, open, notes)?;
    entries(run, state, event, open, notes)
}

fn expire(
    run: &Run,
    state: &mut State,
    event: &MarketEvent,
    pending: &Pending,
    notes: &mut Vec<String>,
) -> Result<()> {
    release(run, state, event, pending.cap)?;
    set_entry_status(
        state,
        &pending.intent_id,
        g::EntryRecordStatus::Expired,
        Some(SkipReason::ExpiredNonTrading),
    )?;
    notes.push(format!(
        "{}: expired, session did not trade",
        pending.intent_id
    ));
    Ok(())
}

fn set_entry_status(
    state: &mut State,
    intent_id: &str,
    status: g::EntryRecordStatus,
    reason: Option<SkipReason>,
) -> Result<()> {
    let record = state
        .journal
        .entries
        .iter_mut()
        .find(|e| e.intent_id.as_str() == intent_id)
        .ok_or_else(|| Failure::internal("entry record"))?;
    record.status = status;
    record.reason = reason;
    Ok(())
}

/// Gap exits: through a stop fills at the open with adverse slippage; above a target fills at
/// the target before slippage.
fn gap_exits(
    run: &Run,
    state: &mut State,
    event: &MarketEvent,
    open: Decimal,
    notes: &mut Vec<String>,
) -> Result<()> {
    let policy = &run.input.policy;
    let mut exits = Vec::new();
    for (index, position) in state.positions.iter().enumerate() {
        if open <= position.stop {
            let adverse = mul(
                open,
                sub(
                    Decimal::ONE,
                    bps_of(Decimal::ONE, policy.gap_exit_slippage_bps)?,
                )?,
            )?;
            exits.push((
                index,
                Sale {
                    price: floor_to(adverse, policy.price_scale),
                    fill_reason: g::FillRecordReason::GapStop,
                    exit_reason: g::TradeRecordExitReason::GapStop,
                    ambiguous_bar: false,
                },
            ));
        } else if open >= position.target {
            exits.push((
                index,
                Sale {
                    price: floor_to(position.target, policy.price_scale),
                    fill_reason: g::FillRecordReason::GapTarget,
                    exit_reason: g::TradeRecordExitReason::GapTarget,
                    ambiguous_bar: false,
                },
            ));
        }
    }
    for (index, sale) in exits.into_iter().rev() {
        notes.push(format!("gap exit at open {open}: {:?}", sale.fill_reason));
        sell(run, state, event, index, &sale)?;
    }
    Ok(())
}

/// Largest lot multiple whose notional plus fee fits within `cap`.
fn quantity_for(run: &Run, cap: Decimal, open: Decimal) -> Result<Decimal> {
    let policy = &run.input.policy;
    let budget = sub(cap, policy.fixed_fee)?;
    if budget <= Decimal::ZERO {
        return Ok(Decimal::ZERO);
    }
    let unit_cost = mul(
        open,
        add(Decimal::ONE, bps_of(Decimal::ONE, policy.fee_bps)?)?,
    )?;
    let mut quantity = floor_to_lot(div(budget, unit_cost)?, policy.lot_size)?;
    while quantity > Decimal::ZERO {
        let notional = mul(quantity, open)?;
        if add(notional, fee_for(run, notional)?)? <= cap {
            break;
        }
        quantity = sub(quantity, policy.lot_size)?;
    }
    Ok(quantity.max(Decimal::ZERO))
}

fn entries(
    run: &Run,
    state: &mut State,
    event: &MarketEvent,
    open: Decimal,
    notes: &mut Vec<String>,
) -> Result<()> {
    let mut intents = std::mem::take(&mut state.pending);
    intents.sort_by(|a, b| {
        b.rank
            .cmp(&a.rank)
            .then_with(|| a.instrument_id.cmp(&b.instrument_id))
    });
    for pending in intents {
        let quantity = quantity_for(run, pending.cap, open)?;
        if quantity <= Decimal::ZERO {
            release(run, state, event, pending.cap)?;
            set_entry_status(
                state,
                &pending.intent_id,
                g::EntryRecordStatus::Skipped,
                Some(SkipReason::CapBelowOneLot),
            )?;
            notes.push(format!(
                "{}: cap {} buys less than one lot",
                pending.intent_id, pending.cap
            ));
            continue;
        }
        fill_entry(run, state, event, &pending, quantity, open)?;
    }
    Ok(())
}

fn fill_entry(
    run: &Run,
    state: &mut State,
    event: &MarketEvent,
    pending: &Pending,
    quantity: Decimal,
    open: Decimal,
) -> Result<()> {
    let env = LevelEnv {
        bar: None,
        entry_price: open,
        snapshots: &pending.snapshots,
    };
    let level = |node| match eval_position_expr(node, &env)? {
        Value::Num(value) => Ok(value),
        other => Err(Failure::new(
            FailureCode::InvalidLevel,
            format!("{}: level is not a number: {other:?}", pending.intent_id),
        )),
    };
    let stop = level(&run.strategy.stop)?;
    let target = level(&run.strategy.target)?;
    if !(Decimal::ZERO < stop && stop < open && open < target) {
        return Err(Failure::new(
            FailureCode::InvalidLevel,
            format!(
                "{}: levels must satisfy 0 < stop < entry < target, found stop {stop}, entry {open}, target {target}",
                pending.intent_id
            ),
        ));
    }
    let notional = mul(quantity, open)?;
    let fee = fee_for(run, notional)?;
    let total = add(notional, fee)?;
    release(run, state, event, pending.cap)?;
    state.cash_available = sub(state.cash_available, total)?;
    let seq = super::accounting::next_seq(state);
    let date = &event.cursor.session;
    state.journal.fills.push(g::FillRecord {
        ambiguous_bar: None,
        cash_delta: run.fmt.money(sub(Decimal::ZERO, total)?)?,
        fee: run.fmt.money(fee)?,
        intent_id: Some(ident(&pending.intent_id)?),
        notional: run.fmt.money(notional)?,
        phase: event.phase(),
        price: run.fmt.price(open)?,
        quantity: run.fmt.qty(quantity)?,
        reason: g::FillRecordReason::Entry,
        seq,
        session: session_date(date)?,
        side: g::FillRecordSide::Buy,
    });
    ledger(run, state, event, g::LedgerEntryKind::FillBuy, total)?;
    let trade_id = format!("T-{date}-{}", pending.instrument_id);
    state.journal.trades.push(g::TradeRecord {
        ambiguous_bar: false,
        entry_price: run.fmt.price(open)?,
        entry_session: session_date(date)?,
        exit_price: None,
        exit_reason: g::TradeRecordExitReason::OpenAtEnd,
        exit_session: None,
        quantity: run.fmt.qty(quantity)?,
        trade_id: ident(&trade_id)?,
    });
    let record = state
        .journal
        .entries
        .iter_mut()
        .find(|e| e.intent_id.as_str() == pending.intent_id)
        .ok_or_else(|| Failure::internal("entry record"))?;
    record.status = g::EntryRecordStatus::Filled;
    record.quantity = Some(run.fmt.qty(quantity)?);
    record.fill_price = Some(run.fmt.price(open)?);
    record.fee = Some(run.fmt.money(fee)?);
    state.positions.push(Position {
        instrument_id: pending.instrument_id.clone(),
        trade_id,
        entry_session: date.clone(),
        quantity,
        entry_price: open,
        snapshots: pending.snapshots.clone(),
        stop,
        target,
        mark: open,
        fired: Vec::new(),
        scheduled: None,
    });
    Ok(())
}

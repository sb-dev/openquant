//! Exact cash accounting: fees, reservations, fills and journal records.

use openquant_contracts::generated as g;

use crate::{
    format::{ident, session_date},
    interfaces::MarketEvent,
    model::{Failure, FailureCode, Result},
    numeric::{Decimal, add, bps_of, ceil_to, mul, sub},
    run::Run,
    state::{Position, State},
};

/// The fee for a fill: `ceil(fixed + bps * notional / 10000)` at the money scale.
///
/// Rounding up never understates cost and is monotone in notional, which the lot-fit search
/// needs.
pub fn fee_for(run: &Run, notional: Decimal) -> Result<Decimal> {
    let policy = &run.input.policy;
    let variable = bps_of(notional, policy.fee_bps)?;
    Ok(ceil_to(
        add(policy.fixed_fee, variable)?,
        policy.money_scale,
    ))
}

/// Take the next journal sequence number.
pub fn next_seq(state: &mut State) -> i64 {
    let seq = state.journal.next_seq;
    state.journal.next_seq = seq.saturating_add(1);
    seq
}

/// Append a cash ledger line with the balances after the change.
pub fn ledger(
    run: &Run,
    state: &mut State,
    event: &MarketEvent,
    kind: g::LedgerEntryKind,
    amount: Decimal,
) -> Result<()> {
    let seq = next_seq(state);
    let entry = g::LedgerEntry {
        amount: run.fmt.money(amount)?,
        available_after: run.fmt.money(state.cash_available)?,
        kind,
        phase: event.phase(),
        receivables_after: run.fmt.money(state.receivables_total())?,
        reserved_after: run.fmt.money(state.cash_reserved)?,
        seq,
        session: session_date(&event.cursor.session)?,
    };
    state.journal.cash_ledger.push(entry);
    Ok(())
}

/// Move `amount` from available cash into a reservation.
pub fn reserve(run: &Run, state: &mut State, event: &MarketEvent, amount: Decimal) -> Result<()> {
    if amount > state.cash_available {
        return Err(Failure::internal("reservation exceeds available cash"));
    }
    state.cash_available = sub(state.cash_available, amount)?;
    state.cash_reserved = add(state.cash_reserved, amount)?;
    ledger(run, state, event, g::LedgerEntryKind::Reserve, amount)
}

/// Return a reservation to available cash.
pub fn release(run: &Run, state: &mut State, event: &MarketEvent, amount: Decimal) -> Result<()> {
    if amount > state.cash_reserved {
        return Err(Failure::internal("release exceeds reserved cash"));
    }
    state.cash_reserved = sub(state.cash_reserved, amount)?;
    state.cash_available = add(state.cash_available, amount)?;
    ledger(run, state, event, g::LedgerEntryKind::Release, amount)
}

/// A sale of a whole position.
pub struct Sale {
    pub price: Decimal,
    pub fill_reason: g::FillRecordReason,
    pub exit_reason: g::TradeRecordExitReason,
    pub ambiguous_bar: bool,
}

/// Sell the whole position at `index`: credit proceeds net of fees, record the fill, close the
/// trade.
pub fn sell(
    run: &Run,
    state: &mut State,
    event: &MarketEvent,
    index: usize,
    sale: &Sale,
) -> Result<()> {
    if index >= state.positions.len() {
        return Err(Failure::internal("position index"));
    }
    let position = state.positions.remove(index);
    if sale.price <= Decimal::ZERO {
        return Err(Failure::new(
            FailureCode::InvalidLevel,
            format!("exit price {} is not positive", sale.price),
        ));
    }
    let notional = mul(position.quantity, sale.price)?;
    let fee = fee_for(run, notional)?;
    let proceeds = sub(notional, fee)?;
    state.cash_available = add(state.cash_available, proceeds)?;
    let seq = next_seq(state);
    state.journal.fills.push(g::FillRecord {
        ambiguous_bar: sale.ambiguous_bar.then_some(true),
        cash_delta: run.fmt.money(proceeds)?,
        fee: run.fmt.money(fee)?,
        intent_id: None,
        notional: run.fmt.money(notional)?,
        phase: event.phase(),
        price: run.fmt.price(sale.price)?,
        quantity: run.fmt.qty(position.quantity)?,
        reason: sale.fill_reason,
        seq,
        session: session_date(&event.cursor.session)?,
        side: g::FillRecordSide::Sell,
    });
    ledger(run, state, event, g::LedgerEntryKind::FillSell, proceeds)?;
    let trade = state
        .journal
        .trades
        .iter_mut()
        .find(|t| t.trade_id.as_str() == position.trade_id)
        .ok_or_else(|| Failure::internal("trade record for exit"))?;
    trade.exit_session = Some(session_date(&event.cursor.session)?);
    trade.exit_price = Some(run.fmt.price(sale.price)?);
    trade.exit_reason = sale.exit_reason;
    trade.ambiguous_bar = sale.ambiguous_bar;
    Ok(())
}

/// Wire view of a position.
pub fn position_view(run: &Run, position: &Position) -> Result<g::PositionView> {
    let mut snapshots = Vec::with_capacity(position.snapshots.len());
    for (name, value) in &position.snapshots {
        snapshots.push(g::SnapshotValue {
            name: ident(name)?,
            value: run.fmt.exact(*value)?,
        });
    }
    let scheduled_stop = match &position.scheduled {
        Some(s) => Some(g::ScheduledStop {
            effective_session: session_date(&s.effective_session)?,
            level: run.fmt.exact(s.level)?,
        }),
        None => None,
    };
    Ok(g::PositionView {
        entry_price: run.fmt.exact(position.entry_price)?,
        quantity: run.fmt.qty(position.quantity)?,
        scheduled_stop,
        snapshots,
        stop: run.fmt.exact(position.stop)?,
        target: run.fmt.exact(position.target)?,
        trade_id: ident(&position.trade_id)?,
    })
}

/// Total value of positions at their marks.
pub fn positions_value(state: &State) -> Result<Decimal> {
    let mut total = Decimal::ZERO;
    for position in &state.positions {
        total = add(total, mul(position.quantity, position.mark)?)?;
    }
    Ok(total)
}

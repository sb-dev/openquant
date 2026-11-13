//! Exact cash accounting: fees, reservations, fills and journal records.
//!
//! Every amount on a policy grid goes through the `exact_*` helpers, so an out-of-range value
//! is a typed `ARITHMETIC_OVERFLOW`, never a silently rounded amount.

use openquant_contracts::generated as g;

use crate::{
    format::{ident, session_date},
    interfaces::MarketEvent,
    model::{Failure, FailureCode, Result},
    numeric::{Decimal, ceil_to, exact_add, exact_bps_of, exact_mul, exact_sub, half_even_to, mul},
    run::Run,
    state::{Position, State},
};

/// The fee for a fill: `ceil(fixed + bps * notional / 10000)` at the money scale.
///
/// Rounding up never understates cost and is monotone in notional, which the lot-fit search
/// needs.
pub fn fee_for(run: &Run, notional: Decimal) -> Result<Decimal> {
    let policy = &run.input.policy;
    let variable = exact_bps_of(notional, policy.fee_bps)?;
    Ok(ceil_to(
        exact_add(policy.fixed_fee, variable)?,
        policy.money_scale,
    ))
}

/// Take the next journal sequence number.
pub fn next_seq(state: &mut State) -> i64 {
    let seq = state.journal.next_seq;
    state.journal.next_seq = seq.saturating_add(1);
    seq
}

/// Sum of receivables, checked.
pub fn receivables_total(state: &State) -> Result<Decimal> {
    let mut total = Decimal::ZERO;
    for receivable in &state.receivables {
        total = exact_add(total, receivable.amount)?;
    }
    Ok(total)
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
        receivables_after: run.fmt.money(receivables_total(state)?)?,
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
    state.cash_available = exact_sub(state.cash_available, amount)?;
    state.cash_reserved = exact_add(state.cash_reserved, amount)?;
    ledger(run, state, event, g::LedgerEntryKind::Reserve, amount)
}

/// Return a reservation to available cash.
pub fn release(run: &Run, state: &mut State, event: &MarketEvent, amount: Decimal) -> Result<()> {
    if amount > state.cash_reserved {
        return Err(Failure::internal("release exceeds reserved cash"));
    }
    state.cash_reserved = exact_sub(state.cash_reserved, amount)?;
    state.cash_available = exact_add(state.cash_available, amount)?;
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
///
/// # Errors
/// `INVALID_LEVEL` for a non-positive price; `UNSUPPORTED_POLICY` when the exit fee exceeds the
/// sale value by more than the available cash, which would leave cash negative.
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
    let notional = exact_mul(position.quantity, sale.price)?;
    let fee = fee_for(run, notional)?;
    let proceeds = exact_sub(notional, fee)?;
    let available = exact_add(state.cash_available, proceeds)?;
    if available < Decimal::ZERO {
        return Err(Failure::new(
            FailureCode::UnsupportedPolicy,
            format!(
                "the exit fee {fee} exceeds the sale value {notional} and the available cash {}: cash cannot go negative",
                state.cash_available
            ),
        ));
    }
    state.cash_available = available;
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

/// Value of the positions at their marks, on the money grid.
///
/// A mark that a split moved can be a non-terminating decimal, but the position value is
/// invariant under a split: `quantity * r * (mark / r)` equals `quantity * mark`, which is on the
/// grid. The product carries at most a 28-digit rounding error, far below half a money unit, so
/// rounding half-even to the money scale recovers the exact value.
pub fn positions_value(run: &Run, state: &State) -> Result<Decimal> {
    let mut total = Decimal::ZERO;
    for position in &state.positions {
        let value = mul(position.quantity, position.mark)?;
        total = exact_add(total, half_even_to(value, run.input.policy.money_scale))?;
    }
    Ok(total)
}

/// Equity: available cash, reservations, receivables and positions at their marks.
pub fn equity(run: &Run, state: &State) -> Result<Decimal> {
    let value = positions_value(run, state)?;
    let held = exact_add(state.cash_available, state.cash_reserved)?;
    exact_add(exact_add(held, receivables_total(state)?)?, value)
}

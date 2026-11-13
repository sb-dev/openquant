//! Corporate actions: splits and ordinary cash dividends (OQ-02 sections 2.5 and 2.6).
//!
//! Actions are applied at the before-open phase of their effective session, exactly once: the
//! identity of an applied action lives in the restorable state. Dividend receivables are paid
//! at the start of the handler for their payment session and phase.

use openquant_contracts::generated as g;

use super::accounting::ledger;
use crate::{
    data::{Action, ActionKind},
    format::{ident, session_date, wire_cursor},
    interfaces::MarketEvent,
    model::{Failure, FailureCode, Result, Unit},
    numeric::{Decimal, div, exact_add, exact_bps_of, exact_mul, exact_sub, floor_to, mul},
    run::Run,
    state::{Receivable, State},
};

/// Apply every action effective in this session that has not been applied yet.
///
/// # Errors
/// `FUTURE_DATA` for an action that becomes available after the session opens;
/// `UNSUPPORTED_CORPORATE_ACTION` for a kind S0 does not support; `FRACTIONAL_ENTITLEMENT` when
/// a split would leave a fractional share.
pub fn apply_effective(
    run: &Run,
    state: &mut State,
    event: &MarketEvent,
    notes: &mut Vec<String>,
) -> Result<()> {
    let date = event.cursor.session.as_str();
    let open_at = run.deadline(Some(run.session(event.session_index)?.open_at.as_str()));
    // A dividend entitlement is the quantity held at the start of this handler, before any
    // split of the same day.
    let held_before = held_quantity(state)?;
    for action in &run.input.actions {
        if action.effective_session != date || state.applied.contains(&action.id) {
            continue;
        }
        if action.available_at.as_str() > open_at {
            return Err(Failure::new(
                FailureCode::FutureData,
                format!(
                    "corporate action {} becomes available at {} after the deadline {open_at} for session {date}",
                    action.id, action.available_at
                ),
            ));
        }
        let kind = match &action.kind {
            ActionKind::Split { new, old } => {
                apply_split(run, state, action, *new, *old)?;
                notes.push(format!("{}: split {new} for {old} applied", action.id));
                g::ActionRecordKind::Split
            }
            ActionKind::CashDividend { .. } => {
                record_dividend(run, state, event, action, held_before, notes)?;
                g::ActionRecordKind::CashDividend
            }
            ActionKind::Unsupported { kind } => {
                return Err(Failure::new(
                    FailureCode::UnsupportedCorporateAction,
                    run.unsupported_action_detail(action, kind),
                ));
            }
        };
        state.applied.insert(action.id.clone());
        state.journal.corporate_actions.push(g::ActionRecord {
            action_id: ident(&action.id)?,
            applied_at: wire_cursor(&event.cursor)?,
            effective_session: session_date(&action.effective_session)?,
            kind,
        });
    }
    Ok(())
}

/// Total quantity of the instrument held now.
fn held_quantity(state: &State) -> Result<Decimal> {
    let mut total = Decimal::ZERO;
    for position in &state.positions {
        total = exact_add(total, position.quantity)?;
    }
    Ok(total)
}

fn unit_of_snapshot(run: &Run, name: &str) -> Result<Unit> {
    run.strategy
        .snapshots
        .iter()
        .find(|s| s.name == name)
        .map(|s| s.node.unit)
        .ok_or_else(|| Failure::internal("snapshot name is not declared by the strategy"))
}

/// Convert a value from the old share basis to the new one: prices divide by `r = new / old`.
fn per_share_down(value: Decimal, new: u64, old: u64) -> Result<Decimal> {
    div(mul(value, Decimal::from(old))?, Decimal::from(new))
}

/// Convert a share count: quantities multiply by `r`.
fn per_share_up(value: Decimal, new: u64, old: u64) -> Result<Decimal> {
    div(mul(value, Decimal::from(new))?, Decimal::from(old))
}

/// Convert snapshot values by unit: PRICE divides by `r`, SHARES multiplies by `r`, RATIO and
/// POINTS are unchanged.
pub fn convert_snapshots(
    run: &Run,
    snapshots: &mut [(String, Decimal)],
    new: u64,
    old: u64,
) -> Result<()> {
    for (name, value) in snapshots.iter_mut() {
        match unit_of_snapshot(run, name)? {
            Unit::Price => *value = per_share_down(*value, new, old)?,
            Unit::Shares => *value = per_share_up(*value, new, old)?,
            Unit::Ratio | Unit::Points | Unit::Flag => {}
        }
    }
    Ok(())
}

/// A split with ratio `r = new / old`: quantities multiply by `r`; entry price, stop, target,
/// mark, scheduled stop levels and price snapshots divide by `r`. Pending entry intents convert
/// their snapshots and keep their cap and rank.
fn apply_split(run: &Run, state: &mut State, action: &Action, new: u64, old: u64) -> Result<()> {
    // Check every entitlement first so a refusal leaves the state exactly as it was.
    let mut quantities = Vec::with_capacity(state.positions.len());
    for position in &state.positions {
        // A non-integral quotient of whole numbers up to 1000 cannot round to an integer at 28
        // digits, so `is_integer` decides the entitlement exactly.
        let converted = per_share_up(position.quantity, new, old)?;
        if !converted.is_integer() {
            return Err(Failure::new(
                FailureCode::FractionalEntitlement,
                run.fractional_detail(action, (new, old), position.quantity, converted),
            ));
        }
        quantities.push(converted);
    }
    for (position, quantity) in state.positions.iter_mut().zip(quantities) {
        position.quantity = quantity;
        position.entry_price = per_share_down(position.entry_price, new, old)?;
        position.stop = per_share_down(position.stop, new, old)?;
        position.target = per_share_down(position.target, new, old)?;
        position.mark = per_share_down(position.mark, new, old)?;
        if let Some(scheduled) = &mut position.scheduled {
            scheduled.level = per_share_down(scheduled.level, new, old)?;
        }
        convert_snapshots(run, &mut position.snapshots, new, old)?;
    }
    for pending in &mut state.pending {
        convert_snapshots(run, &mut pending.snapshots, new, old)?;
    }
    // The trade record follows the position's share basis, so that the quantity, entry price
    // and exit price of a trade always describe one basis. Fill records stay as traded.
    for position in &state.positions {
        let trade = state
            .journal
            .trades
            .iter_mut()
            .find(|t| t.trade_id.as_str() == position.trade_id)
            .ok_or_else(|| Failure::internal("trade record for a split"))?;
        trade.quantity = run.fmt.qty(position.quantity)?;
        trade.entry_price = run.fmt.price_or_exact(position.entry_price)?;
    }
    Ok(())
}

/// Record the entitlement of an ordinary cash dividend as a receivable on the ex-date.
fn record_dividend(
    run: &Run,
    state: &mut State,
    event: &MarketEvent,
    action: &Action,
    held_before: Decimal,
    notes: &mut Vec<String>,
) -> Result<()> {
    let ActionKind::CashDividend {
        amount_per_share,
        payment_session,
        payment_phase,
    } = &action.kind
    else {
        return Err(Failure::internal("dividend handler received another kind"));
    };
    let policy = &run.input.policy;
    let gross = exact_mul(held_before, *amount_per_share)?;
    let kept = exact_sub(
        Decimal::ONE,
        exact_bps_of(Decimal::ONE, policy.withholding_bps)?,
    )?;
    let amount = floor_to(exact_mul(gross, kept)?, policy.money_scale);
    if amount <= Decimal::ZERO {
        notes.push(format!(
            "{}: no entitlement (held {held_before} before the ex-date)",
            action.id
        ));
        return Ok(());
    }
    state.receivables.push(Receivable {
        action_id: action.id.clone(),
        amount,
        payment_session: payment_session.clone(),
        payment_phase: *payment_phase,
    });
    notes.push(format!("{}: receivable {amount}", action.id));
    ledger(
        run,
        state,
        event,
        g::LedgerEntryKind::DividendReceivable,
        amount,
    )
}

/// Pay every receivable that is due at this session and phase into available cash.
///
/// A payment cannot enlarge a reservation that is already frozen: reservations hold their own
/// cash, and this only adds to the available balance.
pub fn pay_due(
    run: &Run,
    state: &mut State,
    event: &MarketEvent,
    notes: &mut Vec<String>,
) -> Result<()> {
    let due_key = (event.cursor.session.clone(), event.cursor.phase);
    let mut index = 0;
    while let Some(receivable) = state.receivables.get(index) {
        let key = (receivable.payment_session.clone(), receivable.payment_phase);
        if key > due_key {
            index += 1;
            continue;
        }
        let paid = state.receivables.remove(index);
        state.cash_available = exact_add(state.cash_available, paid.amount)?;
        notes.push(format!("{}: paid {}", paid.action_id, paid.amount));
        ledger(
            run,
            state,
            event,
            g::LedgerEntryKind::DividendPayment,
            paid.amount,
        )?;
    }
    Ok(())
}

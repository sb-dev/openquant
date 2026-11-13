//! Open: existing-position gap exits first, then reserved entry intents in frozen rank order.
//! Entries resolve from the opening price. Nothing is re-ranked (OQ-02 section 2.5).

use openquant_contracts::generated as g;

use super::{
    accounting::{Sale, fee_for, ledger, next_seq, release, sell},
    corporate_actions::pay_due,
};
use crate::{
    format::{ident, session_date},
    interfaces::MarketEvent,
    model::{Failure, FailureCode, Result, SkipReason},
    numeric::{
        Decimal, div, exact_add, exact_bps_of, exact_mul, exact_sub, floor_to, floor_to_lot,
    },
    operators::Value,
    ratio::Ratio,
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
    pay_due(run, state, event, notes)?;
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
/// the target before slippage. Only positions held at the start of the session can gap. The tests
/// compare the open with the exact level, and the target fill is the exact level floored to the
/// price grid.
fn gap_exits(
    run: &Run,
    state: &mut State,
    event: &MarketEvent,
    open: Decimal,
    notes: &mut Vec<String>,
) -> Result<()> {
    let policy = &run.input.policy;
    let level_open = Ratio::from(open);
    let mut exits = Vec::new();
    for (index, position) in state.positions.iter().enumerate() {
        if level_open <= position.stop {
            let kept = exact_sub(
                Decimal::ONE,
                exact_bps_of(Decimal::ONE, policy.gap_exit_slippage_bps)?,
            )?;
            let adverse = exact_mul(open, kept)?;
            exits.push((
                index,
                Sale {
                    price: floor_to(adverse, policy.price_scale),
                    fill_reason: g::FillRecordReason::GapStop,
                    exit_reason: g::TradeRecordExitReason::GapStop,
                    ambiguous_bar: false,
                },
            ));
        } else if level_open >= position.target {
            exits.push((
                index,
                Sale {
                    price: position.target.floor_to(policy.price_scale)?,
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

/// Whether `quantity` at `open` with its fee fits within `cap`.
fn fits(run: &Run, quantity: Decimal, open: Decimal, cap: Decimal) -> Result<bool> {
    let notional = exact_mul(quantity, open)?;
    let total = exact_add(notional, fee_for(run, notional)?)?;
    Ok(total <= cap)
}

/// Most corrections the lot search may apply to its estimate. The estimate is within one lot
/// of the answer, so a larger distance means the arithmetic is out of range.
const MAX_LOT_STEPS: usize = 8;

/// Largest lot multiple whose notional plus fee fits within `cap`.
///
/// The fee rounds up, so the cost is monotone in the quantity. A division estimates the answer;
/// exact checks then move it to the true maximum, so a rounded quotient cannot change the lot.
fn quantity_for(run: &Run, cap: Decimal, open: Decimal) -> Result<Decimal> {
    let policy = &run.input.policy;
    let lot = policy.lot_size;
    let budget = exact_sub(cap, policy.fixed_fee)?;
    if budget <= Decimal::ZERO {
        return Ok(Decimal::ZERO);
    }
    let per_unit = exact_add(Decimal::ONE, exact_bps_of(Decimal::ONE, policy.fee_bps)?)?;
    let mut quantity = floor_to_lot(div(budget, exact_mul(open, per_unit)?)?, lot)?;
    let mut steps = 0;
    while quantity > Decimal::ZERO && !fits(run, quantity, open, cap)? {
        quantity = exact_sub(quantity, lot)?;
        steps += 1;
        if steps > MAX_LOT_STEPS {
            return Err(lot_search_failure());
        }
    }
    loop {
        let above = exact_add(quantity, lot)?;
        if !fits(run, above, open, cap)? {
            return Ok(quantity);
        }
        quantity = above;
        steps += 1;
        if steps > MAX_LOT_STEPS {
            return Err(lot_search_failure());
        }
    }
}

fn lot_search_failure() -> Failure {
    Failure::new(
        FailureCode::ArithmeticOverflow,
        "the lot search did not converge".to_owned(),
    )
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
    let entry = Ratio::from(open);
    let env = LevelEnv {
        bar: None,
        entry_price: entry,
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
    // The levels print in their canonical form, so the text is the same in a run restored from a
    // checkpoint as in an uninterrupted one.
    if !(Ratio::ZERO < stop && stop < entry && entry < target) {
        return Err(Failure::new(
            FailureCode::InvalidLevel,
            format!(
                "{}: levels must satisfy 0 < stop < entry < target, found stop {stop}, entry {entry}, target {target}",
                pending.intent_id
            ),
        ));
    }
    let notional = exact_mul(quantity, open)?;
    let fee = fee_for(run, notional)?;
    let total = exact_add(notional, fee)?;
    release(run, state, event, pending.cap)?;
    state.cash_available = exact_sub(state.cash_available, total)?;
    let seq = next_seq(state);
    let date = &event.cursor.session;
    state.journal.fills.push(g::FillRecord {
        ambiguous_bar: None,
        cash_delta: run.fmt.money(exact_sub(Decimal::ZERO, total)?)?,
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
        entry_price: entry,
        snapshots: pending.snapshots.clone(),
        stop,
        target,
        mark: open,
        fired: Vec::new(),
        scheduled: None,
    });
    Ok(())
}

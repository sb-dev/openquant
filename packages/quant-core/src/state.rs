//! Numerical state: cash, reservations, positions, pending entries, scheduled stops, applied
//! action identities and the journal. Everything a restore needs is here.

use std::{collections::BTreeSet, fmt};

use openquant_contracts::generated::Journal;

use crate::{
    model::{Cursor, Failure, FailureCode, Result},
    numeric::Decimal,
    ratio::Ratio,
};

/// A stop change decided at a close and effective at the start of a later session.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Scheduled {
    pub level: Ratio,
    pub effective_session: String,
}

/// An open long position on the current share basis.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Position {
    pub instrument_id: String,
    pub trade_id: String,
    pub entry_session: String,
    pub quantity: Decimal,
    /// Levels, snapshots and the scheduled stop are exact fractions: every decision on a level
    /// is taken on the exact value, and a split converts it without rounding.
    pub entry_price: Ratio,
    /// Values snapshotted at the signal session, in strategy order, with their units known to
    /// the strategy. Split conversion uses those units.
    pub snapshots: Vec<(String, Ratio)>,
    pub stop: Ratio,
    pub target: Ratio,
    /// Latest valuation price (last close, or entry price before the first close).
    pub mark: Decimal,
    pub fired: Vec<String>,
    pub scheduled: Option<Scheduled>,
}

/// A frozen entry intent. Cap and rank never change; snapshot values convert on a split.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Pending {
    pub intent_id: String,
    pub instrument_id: String,
    pub signal_session: String,
    pub rank: Decimal,
    pub cap: Decimal,
    pub snapshots: Vec<(String, Ratio)>,
}

/// A dividend entitlement recorded on the ex-date and not yet paid.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Receivable {
    pub action_id: String,
    pub amount: Decimal,
    pub payment_session: String,
    pub payment_phase: crate::model::Phase,
}

/// The complete restorable state of a run.
#[derive(Clone, Debug)]
pub struct State {
    /// The next event to process; `None` once the run has finished.
    pub next: Option<Cursor>,
    pub cash_available: Decimal,
    pub cash_reserved: Decimal,
    pub receivables: Vec<Receivable>,
    pub positions: Vec<Position>,
    pub pending: Vec<Pending>,
    pub applied: BTreeSet<String>,
    pub journal: Journal,
}

/// `ARITHMETIC_OVERFLOW` for one value that cannot be shown or written; `what` names the owner and
/// the field, and the text adds the canonical value. `what` formats only on failure.
fn renderable(value: Ratio, what: fmt::Arguments<'_>) -> Result<()> {
    value.check_renderable().map_err(|_| {
        Failure::new(
            FailureCode::ArithmeticOverflow,
            format!("{what} {value} has no decimal view that fits 96 bits"),
        )
    })
}

impl State {
    /// Check that every level the state holds can be shown in a result and written in a
    /// checkpoint: entry price, stop, target and snapshots of a position, its scheduled stop, and
    /// the snapshots of a pending entry.
    ///
    /// A level is an exact fraction of two 128-bit integers, and a result or a checkpoint carries
    /// it as a decimal of 96 bits (or as a fraction). A level with an integer part of 2^96 or
    /// more fits the first and not the second. `Run::step` makes this check after every event, so
    /// the failure ends the event that created the level, the last completed state is always
    /// renderable, and the run can report its own failure. `Run::restore` makes it for a state
    /// read from a checkpoint.
    ///
    /// # Errors
    /// `ARITHMETIC_OVERFLOW`, naming the position or the intent, the field and the value.
    pub fn check_renderable(&self) -> Result<()> {
        for position in &self.positions {
            let id = &position.instrument_id;
            renderable(
                position.entry_price,
                format_args!("position {id}: entry price"),
            )?;
            renderable(position.stop, format_args!("position {id}: stop"))?;
            renderable(position.target, format_args!("position {id}: target"))?;
            for (name, value) in &position.snapshots {
                renderable(*value, format_args!("position {id}: snapshot {name}"))?;
            }
            if let Some(scheduled) = &position.scheduled {
                renderable(
                    scheduled.level,
                    format_args!("position {id}: scheduled stop"),
                )?;
            }
        }
        for pending in &self.pending {
            let intent = &pending.intent_id;
            for (name, value) in &pending.snapshots {
                renderable(
                    *value,
                    format_args!("entry intent {intent}: snapshot {name}"),
                )?;
            }
        }
        Ok(())
    }
}

/// An empty journal.
#[must_use]
pub fn empty_journal() -> Journal {
    Journal {
        cash_ledger: Vec::new(),
        corporate_actions: Vec::new(),
        daily: Vec::new(),
        entries: Vec::new(),
        fills: Vec::new(),
        next_seq: 0,
        signals: Vec::new(),
        trades: Vec::new(),
    }
}

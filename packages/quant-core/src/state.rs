//! Numerical state: cash, reservations, positions, pending entries, scheduled stops, applied
//! action identities and the journal. Everything a restore needs is here.

use std::collections::BTreeSet;

use openquant_contracts::generated::Journal;

use crate::{model::Cursor, numeric::Decimal};

/// A stop change decided at a close and effective at the start of a later session.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Scheduled {
    pub level: Decimal,
    pub effective_session: String,
}

/// An open long position on the current share basis.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Position {
    pub instrument_id: String,
    pub trade_id: String,
    pub entry_session: String,
    pub quantity: Decimal,
    pub entry_price: Decimal,
    /// Values snapshotted at the signal session, in strategy order, with their units known to
    /// the strategy. Split conversion uses those units.
    pub snapshots: Vec<(String, Decimal)>,
    pub stop: Decimal,
    pub target: Decimal,
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
    pub snapshots: Vec<(String, Decimal)>,
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

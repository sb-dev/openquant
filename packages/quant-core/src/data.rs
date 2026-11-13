//! Runtime input: the validated, typed view of an `EvaluationInput`.
//!
//! Session dates and UTC timestamps are fixed-format strings, so string order equals time order.

use std::collections::BTreeMap;

use crate::{model::Phase, numeric::Decimal};

/// Execution policy with scales and cost parameters (OQ-02 section 2.5).
#[derive(Clone, Debug)]
pub struct Policy {
    pub price_scale: u32,
    pub quantity_scale: u32,
    pub money_scale: u32,
    pub diagnostic_scale: u32,
    pub lot_size: Decimal,
    pub fixed_fee: Decimal,
    pub fee_bps: Decimal,
    pub gap_exit_slippage_bps: Decimal,
    pub withholding_bps: Decimal,
}

/// One calendar session.
#[derive(Clone, Debug)]
pub struct SessionInfo {
    pub date: String,
    pub open_at: String,
    pub close_at: String,
}

/// A raw as-traded bar.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Bar {
    pub open: Decimal,
    pub high: Decimal,
    pub low: Decimal,
    pub close: Decimal,
    pub volume: Decimal,
    pub available_at: String,
}

/// What a corporate action does.
#[derive(Clone, Debug)]
pub enum ActionKind {
    Split {
        new: u64,
        old: u64,
    },
    CashDividend {
        amount_per_share: Decimal,
        payment_session: String,
        payment_phase: Phase,
    },
    /// A kind S0 does not support. It yields `INSUFFICIENT`, never a guessed adjustment.
    Unsupported {
        kind: String,
    },
}

/// A dated corporate action.
#[derive(Clone, Debug)]
pub struct Action {
    pub id: String,
    pub effective_session: String,
    pub available_at: String,
    pub kind: ActionKind,
}

/// A confirmed halt: dated evidence that the instrument did not trade in a session.
#[derive(Clone, Debug)]
pub struct Halt {
    pub id: String,
    pub effective_session: String,
    pub available_at: String,
}

/// The full evaluation input after conversion.
#[derive(Clone, Debug)]
pub struct RunInput {
    pub instrument_id: String,
    pub sessions: Vec<SessionInfo>,
    /// Bars keyed by session date. An absent key is a missing observation.
    pub bars: BTreeMap<String, Bar>,
    pub actions: Vec<Action>,
    pub halts: Vec<Halt>,
    /// Index into `sessions` of the first processed session (start of warm-up).
    pub first: usize,
    /// Index of the first session whose close may produce an entry.
    pub scored_start: usize,
    /// Index of the last processed session.
    pub last: usize,
    /// Latest instant at which any bar, action or halt may become available to the run.
    pub information_cutoff: String,
    pub initial_capital: Decimal,
    pub policy: Policy,
}

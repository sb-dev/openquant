//! Frozen interfaces between the evaluator, the execution phases and the harness.

use crate::{
    model::{Cursor, Phase},
    numeric::Decimal,
};

/// Observed prices for one event. Fields not yet knowable in the phase are `None`.
///
/// Open carries only `open`. DuringSession adds `high` and `low`. AfterClose adds `close` and
/// `volume`. A phase handler cannot read what is not populated (OQ-02 section 2.5).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Observation {
    pub open: Option<Decimal>,
    pub high: Option<Decimal>,
    pub low: Option<Decimal>,
    pub close: Option<Decimal>,
    pub volume: Option<Decimal>,
}

/// One market event: a session phase with the observation allowed in that phase.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MarketEvent {
    pub cursor: Cursor,
    pub session_index: usize,
    /// `None` when the session has no bar (a confirmed halt, or a missing observation).
    pub observation: Option<Observation>,
}

impl MarketEvent {
    #[must_use]
    pub fn phase(&self) -> Phase {
        self.cursor.phase
    }
}

/// A desired holding after the step (OQ-02 section 2.3).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TargetPosition {
    pub instrument_id: String,
    pub quantity: Decimal,
}

/// The result of one `step`.
#[derive(Clone, Debug)]
pub struct StepOutput {
    pub state: crate::state::State,
    pub target_positions: Vec<TargetPosition>,
    /// Human-readable notes about skips, expiries and ambiguous bars in this step.
    pub diagnostics: Vec<String>,
}

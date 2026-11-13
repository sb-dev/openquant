//! Shared vocabulary: phases, cursors and typed failures.
//!
//! Enumerations come from the schemas so the wire contract and the engine cannot diverge.

use std::fmt;

pub use openquant_contracts::generated::{
    FailureCode, MissingReason, Phase, SkipReason, Status, Unit,
};

/// All four phases of a session in processing order.
pub const PHASES: [Phase; 4] = [
    Phase::BeforeOpen,
    Phase::Open,
    Phase::DuringSession,
    Phase::AfterClose,
];

/// The status that reports a failure code (OQ-02 sections 2.5 and 3.2).
#[must_use]
pub fn status_of(code: FailureCode) -> Status {
    match code {
        FailureCode::UnsupportedSchemaVersion
        | FailureCode::SchemaViolation
        | FailureCode::InvalidDecimal
        | FailureCode::UnsupportedOperator
        | FailureCode::OperatorTypeMismatch
        | FailureCode::OperatorUnitMismatch
        | FailureCode::InvalidParameter
        | FailureCode::IdentityMismatch
        | FailureCode::CheckpointMismatch
        | FailureCode::UnsupportedPolicy
        | FailureCode::InvalidInput
        | FailureCode::FutureData
        | FailureCode::InvalidLevel
        | FailureCode::EventOutOfOrder
        | FailureCode::ArithmeticOverflow => Status::Failed,
        FailureCode::MissingRequiredBar
        | FailureCode::UnsupportedCorporateAction
        | FailureCode::FractionalEntitlement
        | FailureCode::UnsupportedValuation => Status::Insufficient,
    }
}

/// The next event to process: a session (by date) and a phase.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct Cursor {
    pub session: String,
    pub phase: Phase,
}

impl fmt::Display for Cursor {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}/{}", self.session, self.phase)
    }
}

/// An explicit failure or insufficient-evidence outcome.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Failure {
    pub code: FailureCode,
    pub detail: String,
    pub at: Option<Cursor>,
}

impl Failure {
    #[must_use]
    pub fn new(code: FailureCode, detail: String) -> Self {
        Self {
            code,
            detail,
            at: None,
        }
    }

    /// Attach the event where the failure happened, unless one is already set.
    #[must_use]
    pub fn at(mut self, cursor: Cursor) -> Self {
        if self.at.is_none() {
            self.at = Some(cursor);
        }
        self
    }

    #[must_use]
    pub fn status(&self) -> Status {
        status_of(self.code)
    }

    /// A broken internal invariant. It reports `INVALID_INPUT` so evaluation stays total.
    #[must_use]
    pub fn internal(detail: &str) -> Self {
        Self::new(
            FailureCode::InvalidInput,
            format!("internal inconsistency: {detail}"),
        )
    }
}

impl fmt::Display for Failure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code, self.detail)?;
        if let Some(at) = &self.at {
            write!(f, " (at {at})")?;
        }
        Ok(())
    }
}

impl std::error::Error for Failure {}

impl From<openquant_contracts::ContractError> for Failure {
    fn from(error: openquant_contracts::ContractError) -> Self {
        Self::new(error.failure_code(), error.to_string())
    }
}

pub type Result<T> = std::result::Result<T, Failure>;

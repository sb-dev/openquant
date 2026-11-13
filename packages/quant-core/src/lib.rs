//! The shared Rust core: typed operator interpreter, validation, signals, daily execution
//! phases and exact accounting (OQ-02 sections 2-3).
//!
//! One validator and one evaluator serve every Strategy Definition. Threshold and break-even
//! variants are differences in the definitions, never in this code.

mod checkpoint;
pub mod data;
pub mod execution;
pub mod format;
pub mod identity;
mod insufficient;
pub mod interfaces;
pub mod model;
pub mod numeric;
pub mod operators;
pub mod ratio;
pub mod result;
pub mod run;
pub mod signals;
pub mod state;
pub mod strategy;

use openquant_contracts::{EvaluationInput, EvaluationResult, StrategyArtefact, payload_digest};

pub use model::{Failure, FailureCode, Status};
pub use run::Run;
pub use state::State;
pub use strategy::{ValidatedStrategy, validate_strategy};

/// Evaluate a strategy against an input. Total: invalid strategies and inputs, unsupported
/// actions and missing data produce explicit failure or insufficient-evidence outcomes; this
/// function does not panic.
#[must_use]
pub fn evaluate(strategy: &StrategyArtefact, input: &EvaluationInput) -> Option<EvaluationResult> {
    match Run::prepare(strategy, input) {
        Ok(run) => {
            let state = run.initial_state().ok()?;
            let (state, failure) = run.run_to_end(state);
            run.result(&state, failure.as_ref()).ok()
        }
        Err(failure) => {
            let strategy_hash = payload_digest(strategy).ok()?;
            let input_hash = payload_digest(input).ok()?;
            result::early_failure(&strategy_hash, &input_hash, &failure).ok()
        }
    }
}

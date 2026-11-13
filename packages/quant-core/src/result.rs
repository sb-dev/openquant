//! Build the numerical result from a state and an optional terminal failure.

use openquant_contracts::generated as g;

use crate::{
    execution::accounting::{position_view, positions_value},
    format::wire_cursor,
    model::{Failure, Result, Status},
    numeric::{Decimal, add},
    run::Run,
    state::State,
};

const MAX_DETAIL: usize = 1000;

fn gdigest(text: &str) -> Result<g::Digest> {
    text.parse::<g::Digest>()
        .map_err(|e| Failure::new(crate::model::FailureCode::IdentityMismatch, e.to_string()))
}

impl Run {
    /// The numerical result as of the last completed event.
    ///
    /// # Errors
    /// A formatting failure if a value cannot be represented.
    pub fn result(&self, state: &State, failure: Option<&Failure>) -> Result<g::EvaluationResult> {
        let value = positions_value(state)?;
        let receivables = state.receivables_total();
        let equity = add(
            add(add(state.cash_available, state.cash_reserved)?, receivables)?,
            value,
        )?;
        let mut open_positions = Vec::new();
        for position in &state.positions {
            open_positions.push(position_view(self, position)?);
        }
        let outcome = match failure {
            None => g::Outcome {
                at: None,
                code: None,
                detail: None,
                status: Status::Completed,
            },
            Some(failure) => {
                let mut detail = failure.detail.clone();
                detail.truncate(MAX_DETAIL);
                g::Outcome {
                    at: failure.at.as_ref().map(wire_cursor).transpose()?,
                    code: Some(failure.code),
                    detail: g::OutcomeDetail::try_from(detail).ok(),
                    status: failure.status(),
                }
            }
        };
        Ok(g::EvaluationResult {
            engine: self.engine.clone(),
            engine_digest: gdigest(&self.engine_digest)?,
            final_: g::FinalState {
                cash_available: self.fmt.money(state.cash_available)?,
                cash_reserved: self.fmt.money(state.cash_reserved)?,
                equity: self.fmt.money(equity)?,
                open_positions,
                positions_value: self.fmt.money(value)?,
                receivables: self.fmt.money(receivables)?,
            },
            input_hash: gdigest(&self.input_hash)?,
            journal: state.journal.clone(),
            outcome,
            schema_version: g::EvaluationResultSchemaVersion::EvaluationResult1,
            strategy_hash: gdigest(&self.strategy_hash)?,
        })
    }
}

/// A zero state for failures that occur before a run can be prepared.
fn zero(money_scale: u32) -> Result<g::Decimal> {
    crate::format::gdec(&crate::numeric::fixed_string(Decimal::ZERO, money_scale)?)
}

/// Result for a failure before the run could start (invalid strategy, identity or input).
pub fn early_failure(
    strategy_hash: &str,
    input_hash: &str,
    failure: &Failure,
) -> Result<g::EvaluationResult> {
    let engine = crate::identity::engine_identity()?;
    let engine_digest = crate::identity::engine_digest(&engine)?;
    let zero = zero(2)?;
    let mut detail = failure.detail.clone();
    detail.truncate(MAX_DETAIL);
    Ok(g::EvaluationResult {
        engine,
        engine_digest: gdigest(&engine_digest)?,
        final_: g::FinalState {
            cash_available: zero.clone(),
            cash_reserved: zero.clone(),
            equity: zero.clone(),
            open_positions: Vec::new(),
            positions_value: zero.clone(),
            receivables: zero,
        },
        input_hash: gdigest(input_hash)?,
        journal: crate::state::empty_journal(),
        outcome: g::Outcome {
            at: failure.at.as_ref().map(wire_cursor).transpose()?,
            code: Some(failure.code),
            detail: g::OutcomeDetail::try_from(detail).ok(),
            status: failure.status(),
        },
        schema_version: g::EvaluationResultSchemaVersion::EvaluationResult1,
        strategy_hash: gdigest(strategy_hash)?,
    })
}

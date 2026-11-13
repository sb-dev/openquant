//! Before open: coverage, corporate actions applied exactly once, receivables paid, scheduled
//! stops activated on the resulting price basis (OQ-02 section 2.5).

use super::corporate_actions::{apply_effective, pay_due};
use crate::{
    interfaces::MarketEvent,
    model::{Failure, FailureCode, Result},
    run::Run,
    state::State,
};

/// Run the before-open phase.
pub fn run(
    run: &Run,
    state: &mut State,
    event: &MarketEvent,
    notes: &mut Vec<String>,
) -> Result<()> {
    let date = event.cursor.session.as_str();
    if !run.input.bars.contains_key(date) && !run.confirmed_halt(date) {
        return Err(Failure::new(
            FailureCode::MissingRequiredBar,
            run.missing_bar_detail(date),
        ));
    }
    apply_effective(run, state, event, notes)?;
    // Payment after the actions of the same handler; it cannot enlarge a frozen entry cap.
    pay_due(run, state, event, notes)?;
    for position in &mut state.positions {
        let due = position
            .scheduled
            .as_ref()
            .is_some_and(|s| s.effective_session.as_str() <= date);
        if due && let Some(scheduled) = position.scheduled.take() {
            notes.push(format!(
                "{}: stop {} -> {}",
                position.trade_id, position.stop, scheduled.level
            ));
            position.stop = scheduled.level;
        }
    }
    Ok(())
}

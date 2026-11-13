//! Before open: coverage, corporate actions applied exactly once, scheduled stops activated.

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
            format!("no bar and no confirmed halt for session {date}"),
        ));
    }
    if run
        .input
        .actions
        .iter()
        .any(|a| a.effective_session == date && !state.applied.contains(&a.id))
    {
        return Err(Failure::new(
            FailureCode::UnsupportedCorporateAction,
            format!("corporate actions effective {date} are not applied by this build yet"),
        ));
    }
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

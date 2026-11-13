//! During session: test the stops and targets active for the session, including protection on
//! positions filled at this open. A high-triggered stop change is not effective yet.
//!
//! A touch is decided on the exact level: a high equal to a level that is exactly on the price
//! grid touches it, whatever the path by which the level was computed. The fill price is the
//! exact level floored to the price grid.

use openquant_contracts::generated as g;

use super::{
    accounting::{Sale, sell},
    corporate_actions::pay_due,
};
use crate::{interfaces::MarketEvent, model::Result, ratio::Ratio, run::Run, state::State};

/// Run the during-session phase.
pub fn run(
    run: &Run,
    state: &mut State,
    event: &MarketEvent,
    notes: &mut Vec<String>,
) -> Result<()> {
    pay_due(run, state, event, notes)?;
    let Some(observation) = &event.observation else {
        return Ok(());
    };
    let (Some(high), Some(low)) = (observation.high, observation.low) else {
        return Ok(());
    };
    let price_scale = run.input.policy.price_scale;
    let (high, low) = (Ratio::from(high), Ratio::from(low));
    let mut exits = Vec::new();
    for (index, position) in state.positions.iter().enumerate() {
        let stop_hit = low <= position.stop;
        let target_hit = high >= position.target;
        // If both are touched and their order is unknown, the stop takes precedence.
        if stop_hit {
            exits.push((
                index,
                Sale {
                    price: position.stop.floor_to(price_scale)?,
                    fill_reason: g::FillRecordReason::Stop,
                    exit_reason: g::TradeRecordExitReason::Stop,
                    ambiguous_bar: target_hit,
                },
            ));
        } else if target_hit {
            exits.push((
                index,
                Sale {
                    price: position.target.floor_to(price_scale)?,
                    fill_reason: g::FillRecordReason::Target,
                    exit_reason: g::TradeRecordExitReason::Target,
                    ambiguous_bar: false,
                },
            ));
        }
    }
    for (index, sale) in exits.into_iter().rev() {
        if sale.ambiguous_bar {
            notes.push("ambiguous bar: stop and target both touched, stop applied".to_owned());
        }
        sell(run, state, event, index, &sale)?;
    }
    Ok(())
}

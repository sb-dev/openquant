//! `Run::step` does not trust the fields of the event it is given (OQ-02 section 2.3: `step` is a
//! function of the strategy, the prior state and the market event; the prior state is the only
//! carrier of progress).
//!
//! The scenario is F0-smoke. Its daily table is derived by hand in `f0_smoke.rs`: on 2026-01-12
//! nine shares bought at 102 are marked at the close of 105, so the end-of-day positions value is
//! 945.00 and equity is 4081.00 + 945.00 = 5026.00.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use openquant_contracts::{EvaluationInput, StrategyArtefact, parse};
use openquant_core::{
    Run, State,
    interfaces::MarketEvent,
    model::{PHASES, Phase},
    numeric::Decimal,
};

const FIXTURES: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures/s0");

fn f0() -> Run {
    let read = |path: &str| std::fs::read_to_string(format!("{FIXTURES}/{path}")).unwrap();
    let strategy: StrategyArtefact = parse(&read("cases/F0-smoke/strategy.json")).unwrap();
    let input: EvaluationInput = parse(&read("cases/F0-smoke/input.json")).unwrap();
    Run::prepare(&strategy, &input).unwrap()
}

/// The state before the event at `session`/`phase`, and that event as the run builds it.
fn before(run: &Run, session: &str, phase: Phase) -> (State, MarketEvent) {
    let events = run.events().unwrap();
    let cut = events
        .iter()
        .position(|e| e.cursor.session == session && e.cursor.phase == phase)
        .unwrap();
    let (state, failure) = run.run_events(run.initial_state().unwrap(), &events[..cut]);
    assert!(failure.is_none());
    (state, events[cut].clone())
}

fn code(run: &Run, state: &State, event: &MarketEvent) -> String {
    run.step(state, event)
        .err()
        .map_or_else(|| "ACCEPTED".to_owned(), |failure| failure.code.to_string())
}

#[test]
fn the_honest_after_close_event_marks_at_the_bar_close() {
    let run = f0();
    let (state, event) = before(&run, "2026-01-12", Phase::AfterClose);
    assert_eq!(state.positions[0].quantity, Decimal::from(9));
    let output = run.step(&state, &event).unwrap();
    let daily = output.state.journal.daily.last().unwrap();
    assert_eq!(daily.session.as_str(), "2026-01-12");
    assert_eq!(daily.equity.as_str(), "5026.00");
}

#[test]
fn a_forged_close_is_refused() {
    // The finding's forgery: close 1 instead of 105 would give equity 4090.00 (4081.00 + 9).
    let run = f0();
    let (state, mut event) = before(&run, "2026-01-12", Phase::AfterClose);
    event.observation.as_mut().unwrap().close = Some(Decimal::ONE);
    let failure = run.step(&state, &event).unwrap_err();
    assert_eq!(failure.code.to_string(), "INVALID_INPUT");
    assert_eq!(failure.at.as_ref(), Some(&event.cursor));
}

#[test]
fn a_forged_field_of_any_phase_is_refused() {
    let run = f0();
    for (phase, forge) in [
        (
            Phase::Open,
            (|o: &mut openquant_core::interfaces::Observation| o.open = Some(Decimal::ONE))
                as fn(&mut openquant_core::interfaces::Observation),
        ),
        (Phase::DuringSession, |o| o.high = Some(Decimal::from(500))),
        (Phase::DuringSession, |o| o.low = Some(Decimal::ONE)),
        (Phase::AfterClose, |o| o.volume = Some(Decimal::ONE)),
    ] {
        let (state, mut event) = before(&run, "2026-01-12", phase);
        forge(event.observation.as_mut().unwrap());
        assert_eq!(code(&run, &state, &event), "INVALID_INPUT", "{phase}");
    }
}

#[test]
fn an_observation_that_the_phase_does_not_allow_is_refused() {
    // A close in the open event would let the handler read what is not yet knowable.
    let run = f0();
    let (state, mut event) = before(&run, "2026-01-12", Phase::Open);
    event.observation.as_mut().unwrap().close = Some(Decimal::from(105));
    assert_eq!(code(&run, &state, &event), "INVALID_INPUT");

    // Nor may a before-open event carry a bar, or an event that should carry one lack it.
    let (state, mut event) = before(&run, "2026-01-12", Phase::BeforeOpen);
    event.observation = run
        .events()
        .unwrap()
        .iter()
        .find(|e| e.cursor.phase == Phase::AfterClose)
        .and_then(|e| e.observation.clone());
    assert_eq!(code(&run, &state, &event), "INVALID_INPUT");
    let (state, mut event) = before(&run, "2026-01-12", Phase::AfterClose);
    event.observation = None;
    assert_eq!(code(&run, &state, &event), "INVALID_INPUT");
}

#[test]
fn a_lowered_session_index_is_refused() {
    // The finding: lowering the index by two at 2026-01-12 AFTER_CLOSE made the next cursor
    // 2026-01-09 BEFORE_OPEN, so stepping would append the same sessions again.
    let run = f0();
    let (state, mut event) = before(&run, "2026-01-12", Phase::AfterClose);
    event.session_index -= 2;
    let failure = run.step(&state, &event).unwrap_err();
    assert_eq!(failure.code.to_string(), "INVALID_INPUT");
    assert!(
        failure.detail.contains("session index"),
        "{}",
        failure.detail
    );

    // The same forgery on the very first event of the run.
    let first = run.session(run.input.first).unwrap().date.clone();
    let (state, mut event) = before(&run, &first, Phase::BeforeOpen);
    assert_eq!(event.session_index, run.input.first);
    event.session_index += 1;
    assert_eq!(code(&run, &state, &event), "INVALID_INPUT");
}

#[test]
fn an_index_beyond_the_calendar_is_refused_without_overflow() {
    let run = f0();
    for phase in PHASES {
        let (state, mut event) = before(&run, "2026-01-12", phase);
        event.session_index = usize::MAX;
        assert_eq!(code(&run, &state, &event), "INVALID_INPUT", "{phase}");
    }
}

#[test]
fn events_built_by_the_run_are_all_accepted() {
    let run = f0();
    let events = run.events().unwrap();
    let (end, failure) = run.run_events(run.initial_state().unwrap(), &events);
    assert!(failure.is_none());
    assert!(end.next.is_none());
}

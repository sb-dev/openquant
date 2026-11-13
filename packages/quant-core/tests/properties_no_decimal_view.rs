//! Property: a run never holds a level that has no decimal view (OQ-02 section 2.5, "a level that
//! an implementation cannot hold exactly is rejected explicitly before the run reports
//! COMPLETED").
//!
//! A level, snapshot or scheduled stop whose integer part is 2^96 or more is exact in memory but
//! cannot be shown in a result or written in a checkpoint. The run must fail at the event that
//! would create it, so that the state after every completed event can be checkpointed and the
//! last state can always be reported.
//!
//! The generated runs put a chain of 0 to 5 factors K = 999999999999 (about 1e12), each a
//! multiplication or a division, on the target, on a snapshot of the close, or on both. The
//! chains cover products far below 2^96 (5 K^2 is about 5e24), products between 2^96 and the
//! 128-bit limit (5 K^3 is about 5e36, exact and not renderable), products beyond 128 bits,
//! quotients that put the target at or below the entry, and chains that cancel.
//!
//! The generators use a fixed seed and no failure-persistence file. A second test checks the
//! outcome of every chain against a table computed with Python's Fractions, so that the
//! generated space provably reaches all three outcomes and each is the right one.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

mod execution_support;

use execution_support::*;
use openquant_contracts::to_value;
use proptest::{
    prelude::*,
    test_runner::{Config, RngAlgorithm, RngSeed},
};
use serde_json::{Value, json};

fn config(cases: u32, seed: u64) -> ProptestConfig {
    Config {
        cases,
        failure_persistence: None,
        rng_algorithm: RngAlgorithm::ChaCha,
        rng_seed: RngSeed::Fixed(seed),
        max_shrink_iters: 256,
        ..Config::default()
    }
}

const K: &str = "999999999999";

fn op(name: &str, args: Vec<Value>) -> Value {
    json!({"op": format!("operator:{name}@1"), "args": args, "params": {}})
}

fn constant(value: &str) -> Value {
    json!({"op": "operator:const@1", "args": [], "params": {"value": value, "unit": "RATIO"}})
}

fn entry_price() -> Value {
    op("entry_price", vec![])
}

fn close() -> Value {
    json!({"op": "operator:bar_field@1", "args": [], "params": {"field": "CLOSE"}})
}

/// `base` with a factor K applied per character of `chain`, in order: `m` multiplies by K and
/// `d` divides by K.
fn apply(base: Value, chain: &str) -> Value {
    chain.chars().fold(base, |acc, step| {
        let name = if step == 'd' { "div" } else { "mul" };
        op(name, vec![acc, constant(K)])
    })
}

/// Entry at 5.00 on session 5 after a signal on session 4 (close 5.05, ATR over 3 sessions).
/// The target is `entry * chain` and the extra snapshot `big` is `close * chain`, when given.
fn chain_scenario(target: Option<&str>, snapshot: Option<&str>) -> Scenario {
    let quiet = || quiet_bar("5.00", "5.10", "4.90", "5.00");
    let mut scenario = Scenario::new(vec![
        quiet(),
        quiet(),
        quiet(),
        quiet(),
        signal_bar("5.00", "5.10", "4.90", "5.05"),
        quiet(),
        quiet(),
        quiet(),
    ])
    .atr_window(3);
    if let Some(chain) = target {
        scenario = scenario.target_expression(apply(entry_price(), chain));
    }
    if let Some(chain) = snapshot {
        scenario = scenario.snapshot_expression("big", apply(close(), chain));
    }
    scenario
}

/// What a run did, as far as the properties look at it.
#[derive(Debug, PartialEq, Eq)]
struct Seen {
    /// `COMPLETED`, or the failure code of a `FAILED` result.
    label: String,
    /// `session phase` of a failure.
    at: Option<String>,
}

/// Evaluate `scenario` and check every property. `Err` names the property that failed.
///
/// 1. `evaluate` returns a result.
/// 2. The status is COMPLETED, or FAILED with ARITHMETIC_OVERFLOW or INVALID_LEVEL.
/// 3. A checkpoint can be written for the initial state and for the state after every completed
///    event, stepping from the initial state until the first failure.
/// 4. The result can be built from the last state and the failure.
/// 5. The stepwise run and `evaluate` agree on the failure.
fn check(scenario: &Scenario) -> Result<Seen, String> {
    let strategy = scenario.strategy_artefact();
    let input = scenario.input();
    let result = openquant_core::evaluate(&strategy, &input)
        .ok_or_else(|| "evaluate returned no result".to_owned())?;
    let value = to_value(&result).map_err(|e| format!("result does not serialise: {e}"))?;
    let status = value
        .pointer("/outcome/status")
        .and_then(Value::as_str)
        .ok_or("the result has no status")?;
    let code = value.pointer("/outcome/code").and_then(Value::as_str);
    let label = match (status, code) {
        ("COMPLETED", None) => "COMPLETED".to_owned(),
        ("FAILED", Some(code @ ("ARITHMETIC_OVERFLOW" | "INVALID_LEVEL"))) => code.to_owned(),
        other => return Err(format!("unexpected outcome {other:?}")),
    };
    let at = value.pointer("/outcome/at").map(|at| {
        format!(
            "{} {}",
            at["session"].as_str().unwrap_or("?"),
            at["phase"].as_str().unwrap_or("?")
        )
    });

    let run = scenario.run();
    let events = run.events().map_err(|f| format!("events: {}", f.detail))?;
    let mut state = run
        .initial_state()
        .map_err(|f| format!("initial state: {}", f.detail))?;
    run.checkpoint(&state)
        .map_err(|f| format!("checkpoint of the initial state: {}", f.detail))?;
    let mut failure = None;
    for event in &events {
        match run.step(&state, event) {
            Ok(output) => {
                state = output.state;
                run.checkpoint(&state).map_err(|f| {
                    format!(
                        "no checkpoint after the completed event {}: {} {}",
                        event.cursor, f.code, f.detail
                    )
                })?;
            }
            Err(f) => {
                failure = Some(f);
                break;
            }
        }
    }
    run.result(&state, failure.as_ref())
        .map_err(|f| format!("no result for the last state: {} {}", f.code, f.detail))?;

    match (&failure, label.as_str()) {
        (None, "COMPLETED") => {}
        (Some(f), label) if f.code.to_string() == label => {}
        (failure, label) => {
            return Err(format!(
                "the stepwise run ended with {:?}, evaluate with {label}",
                failure.as_ref().map(|f| f.code.to_string())
            ));
        }
    }
    Ok(Seen { label, at })
}

// ---------------------------------------------------------------------------------------
// The outcome of every chain, from Python's Fractions
// ---------------------------------------------------------------------------------------
//
// Target: 5.00 with the chain applied step by step. A step whose reduced result does not fit two
// 128-bit integers is ARITHMETIC_OVERFLOW; a final target not above the entry 5.00 is
// INVALID_LEVEL; a final target of 2^96 or more has no decimal view, ARITHMETIC_OVERFLOW. The
// target is evaluated at the entry open (session 5), so every failure is there.
//
// Snapshot: the close of the signal session, 5.05, with the chain; the same overflow rules and
// no validity rule. The snapshot expression is evaluated at the close of every session (the
// closes are 5.00 before the signal session, so the third column is the session of the first
// close at which a step overflows, 0 or 4); a value of 2^96 or more that every step could hold
// fails at the close of the signal session, 4, where the entry intent that stores it is created.
// The third column is 0 and unused for a snapshot that completes.

const OK: &str = "COMPLETED";
const OVF: &str = "ARITHMETIC_OVERFLOW";
const INV: &str = "INVALID_LEVEL";

#[rustfmt::skip]
const TARGET: &[(&str, &str)] = &[
    ("", INV), ("m", OK), ("d", INV), ("mm", OK),
    ("md", INV), ("dm", INV), ("dd", INV), ("mmm", OVF),
    ("mmd", OK), ("mdm", OK), ("mdd", INV), ("dmm", OK),
    ("dmd", INV), ("ddm", INV), ("ddd", INV), ("mmmm", OVF),
    ("mmmd", OK), ("mmdm", OK), ("mmdd", INV), ("mdmm", OK),
    ("mdmd", INV), ("mddm", INV), ("mddd", INV), ("dmmm", OK),
    ("dmmd", INV), ("dmdm", INV), ("dmdd", INV), ("ddmm", INV),
    ("ddmd", INV), ("dddm", INV), ("dddd", OVF), ("mmmmm", OVF),
    ("mmmmd", OVF), ("mmmdm", OVF), ("mmmdd", OK), ("mmdmm", OVF),
    ("mmdmd", OK), ("mmddm", OK), ("mmddd", INV), ("mdmmm", OVF),
    ("mdmmd", OK), ("mdmdm", OK), ("mdmdd", INV), ("mddmm", OK),
    ("mddmd", INV), ("mdddm", INV), ("mdddd", INV), ("dmmmm", OVF),
    ("dmmmd", OK), ("dmmdm", OK), ("dmmdd", INV), ("dmdmm", OK),
    ("dmdmd", INV), ("dmddm", INV), ("dmddd", INV), ("ddmmm", OK),
    ("ddmmd", INV), ("ddmdm", INV), ("ddmdd", INV), ("dddmm", INV),
    ("dddmd", INV), ("ddddm", OVF), ("ddddd", OVF),
];

#[rustfmt::skip]
const SNAPSHOT: &[(&str, &str, usize)] = &[
    ("", OK, 0), ("m", OK, 0), ("d", OK, 0),
    ("mm", OK, 0), ("md", OK, 0), ("dm", OK, 0),
    ("dd", OK, 0), ("mmm", OVF, 4), ("mmd", OK, 0),
    ("mdm", OK, 0), ("mdd", OK, 0), ("dmm", OK, 0),
    ("dmd", OK, 0), ("ddm", OK, 0), ("ddd", OK, 0),
    ("mmmm", OVF, 0), ("mmmd", OK, 0), ("mmdm", OK, 0),
    ("mmdd", OK, 0), ("mdmm", OK, 0), ("mdmd", OK, 0),
    ("mddm", OK, 0), ("mddd", OK, 0), ("dmmm", OK, 0),
    ("dmmd", OK, 0), ("dmdm", OK, 0), ("dmdd", OK, 0),
    ("ddmm", OK, 0), ("ddmd", OK, 0), ("dddm", OK, 0),
    ("dddd", OVF, 0), ("mmmmm", OVF, 0), ("mmmmd", OVF, 0),
    ("mmmdm", OVF, 4), ("mmmdd", OK, 0), ("mmdmm", OVF, 4),
    ("mmdmd", OK, 0), ("mmddm", OK, 0), ("mmddd", OK, 0),
    ("mdmmm", OVF, 4), ("mdmmd", OK, 0), ("mdmdm", OK, 0),
    ("mdmdd", OK, 0), ("mddmm", OK, 0), ("mddmd", OK, 0),
    ("mdddm", OK, 0), ("mdddd", OK, 0), ("dmmmm", OVF, 4),
    ("dmmmd", OK, 0), ("dmmdm", OK, 0), ("dmmdd", OK, 0),
    ("dmdmm", OK, 0), ("dmdmd", OK, 0), ("dmddm", OK, 0),
    ("dmddd", OK, 0), ("ddmmm", OK, 0), ("ddmmd", OK, 0),
    ("ddmdm", OK, 0), ("ddmdd", OK, 0), ("dddmm", OK, 0),
    ("dddmd", OK, 0), ("ddddm", OVF, 0), ("ddddd", OVF, 0),
];

fn target_label(chain: &str) -> &'static str {
    TARGET
        .iter()
        .find(|(name, _)| *name == chain)
        .unwrap_or_else(|| panic!("no expected outcome for target chain {chain:?}"))
        .1
}

fn snapshot_label(chain: &str) -> &'static str {
    SNAPSHOT
        .iter()
        .find(|(name, _, _)| *name == chain)
        .unwrap_or_else(|| panic!("no expected outcome for snapshot chain {chain:?}"))
        .1
}

#[test]
fn every_chain_has_the_outcome_computed_independently_and_every_state_can_be_written() {
    let (mut completed, mut overflow, mut invalid) = (0, 0, 0);
    for &(chain, label) in TARGET {
        let seen = check(&chain_scenario(Some(chain), None))
            .unwrap_or_else(|property| panic!("target chain {chain:?}: {property}"));
        assert_eq!(seen.label, label, "target chain {chain:?}");
        let at = format!("{} OPEN", date(5));
        assert_eq!(
            seen.at.as_deref(),
            (label != OK).then_some(at.as_str()),
            "target chain {chain:?}"
        );
        match label {
            OK => completed += 1,
            OVF => overflow += 1,
            _ => invalid += 1,
        }
    }
    for &(chain, label, session) in SNAPSHOT {
        let seen = check(&chain_scenario(None, Some(chain)))
            .unwrap_or_else(|property| panic!("snapshot chain {chain:?}: {property}"));
        assert_eq!(seen.label, label, "snapshot chain {chain:?}");
        let at = format!("{} AFTER_CLOSE", date(session));
        assert_eq!(
            seen.at.as_deref(),
            (label != OK).then_some(at.as_str()),
            "snapshot chain {chain:?}"
        );
        match label {
            OK => completed += 1,
            _ => overflow += 1,
        }
    }
    // The chains reach all three outcomes, many times.
    assert!(completed >= 40 && overflow >= 10 && invalid >= 10);
}

// ---------------------------------------------------------------------------------------
// The property
// ---------------------------------------------------------------------------------------

/// A chain of 0 to 5 factors, one in three a division.
fn chain() -> impl Strategy<Value = String> {
    prop::collection::vec(prop::bool::weighted(0.33), 0..=5).prop_map(|steps| {
        steps
            .into_iter()
            .map(|divide| if divide { 'd' } else { 'm' })
            .collect()
    })
}

/// A chain on the target only, on the snapshot only, or on both.
fn placement() -> impl Strategy<Value = (Option<String>, Option<String>)> {
    (0_u8..3, chain(), chain()).prop_map(|(place, target, snapshot)| match place {
        0 => (Some(target), None),
        1 => (None, Some(snapshot)),
        _ => (Some(target), Some(snapshot)),
    })
}

proptest! {
    #![proptest_config(config(300, 0x0051_0006))]

    /// For every generated input the run completes or fails with ARITHMETIC_OVERFLOW or
    /// INVALID_LEVEL; a checkpoint can be written after every completed event; the last state can
    /// be reported. A run that would hold a level with no decimal view has failed before.
    #[test]
    fn no_completed_event_leaves_a_state_that_cannot_be_written((target, snapshot) in placement()) {
        let scenario = chain_scenario(target.as_deref(), snapshot.as_deref());
        let seen = match check(&scenario) {
            Ok(seen) => seen,
            Err(property) => return Err(TestCaseError::fail(property)),
        };
        // The outcome is the one computed independently: the snapshot is taken first, at the
        // close of the signal session, so it decides when it fails.
        let snapshot_wants = snapshot.as_deref().map_or(OK, snapshot_label);
        let target_wants = target.as_deref().map_or(OK, target_label);
        let want = if snapshot_wants == OK { target_wants } else { snapshot_wants };
        prop_assert_eq!(seen.label.as_str(), want);
    }
}

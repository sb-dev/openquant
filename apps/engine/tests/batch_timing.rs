//! The worst-case 400-session evaluate job, end to end through the worker, and its wall time.
//!
//! The case is the largest result that the S0 limits allow (`packages/quant-core/tests/
//! result_size_bound.rs`: 400 sessions, 32 indicators with 64-character names, 8 snapshots, 4
//! adjustments, 32 dividends, a trade every session). It is run as a REPLAY of a frozen input
//! through the claim, the reads, the evaluation, the schema check of the whole result, the
//! upload of 2.4 MB, the metrics and the submission. The test asserts the case is the worst one
//! and that it completes; it asserts no time, because a time depends on the machine. It prints the
//! times. `apps/engine/README.md` records them from a release build, and the visibility timeout
//! and the lease that the host derives from them.
//!
//! Run it for the numbers with:
//! `cargo test --release -p openquant-engine --test batch_timing -- --nocapture`

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

mod batch_support;

use std::time::{Duration, Instant};

use batch_support::{Harness, data::*, worker_handled};
use openquant_contracts::{
    EvaluationInput, StrategyArtefact, canonical_json, parse_value, payload_digest,
};
use openquant_core::Run;
use openquant_engine::batch::worker::Handled;
use serde_json::{Value, json};

const SESSIONS: usize = 400;

/// Consecutive calendar dates from 2001-01-01.
fn dates(count: usize) -> Vec<String> {
    let mut out = Vec::with_capacity(count);
    let (mut year, mut month, mut day) = (2001_u32, 1_u32, 1_u32);
    while out.len() < count {
        out.push(format!("{year:04}-{month:02}-{day:02}"));
        let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
        let length = match month {
            2 if leap => 29,
            2 => 28,
            4 | 6 | 9 | 11 => 30,
            _ => 31,
        };
        day += 1;
        if day > length {
            day = 1;
            month += 1;
            if month > 12 {
                month = 1;
                year += 1;
            }
        }
    }
    out
}

/// A name of the longest identifier, 64 characters, distinct by `index`.
fn long_name(prefix: &str, index: usize) -> String {
    let head = format!("{prefix}{index:02}");
    format!("{head}{}", "x".repeat(64 - head.len()))
}

fn op(name: &str, args: Vec<Value>, params: Value) -> Value {
    json!({"op": format!("operator:{name}@1"), "args": args, "params": params})
}

fn konst(value: &str, unit: &str) -> Value {
    op("const", vec![], json!({"value": value, "unit": unit}))
}

fn field(name: &str) -> Value {
    op("bar_field", vec![], json!({"field": name}))
}

/// The worst-case strategy: 32 indicators that divide the close by 3 (every value has every
/// place the diagnostic scale allows), 8 snapshots, 4 stop adjustments, and a stop just below the
/// entry so that a wide bar stops the position out the day it opens.
fn worst_strategy() -> Value {
    let third = op("div", vec![field("CLOSE"), konst("3", "RATIO")], json!({}));
    let indicators: Vec<Value> = (0..32)
        .map(|i| json!({"name": long_name("indicator", i), "expr": third.clone()}))
        .collect();
    let snapshots: Vec<Value> = (0..8)
        .map(|i| json!({"name": long_name("snapshot", i), "expr": third.clone()}))
        .collect();
    let entry = op("entry_price", vec![], json!({}));
    let share = |k: &str| op("mul", vec![konst(k, "RATIO"), entry.clone()], json!({}));
    let adjustments: Vec<Value> = (0..4)
        .map(|i| {
            json!({
                "id": long_name("adjustment", i),
                "trigger": op("gte", vec![field("HIGH"), entry.clone()], json!({})),
                "new_level": share(&format!("0.00000000{}", i + 2)),
                "effective": "NEXT_SESSION",
            })
        })
        .collect();
    json!({
        "schema_version": "strategy-artefact/1",
        "strategy_id": long_name("strategy", 0),
        "version": 1,
        "operator_set": "daily-long-only-seed@1",
        "contract": {
            "hypothesis": "Test only: the largest result.",
            "rationale": "Measures the time of the largest run at the S0 limits.",
            "intended_conditions": ["Synthetic sessions."],
            "benchmarks": ["None."],
            "assumptions": ["None."],
            "invalidation": ["Not a trading hypothesis."],
        },
        "definition": {
            "indicators": indicators,
            "entry": {
                "condition": op("gt", vec![field("CLOSE"), konst("0", "PRICE")], json!({})),
                "rank": third,
                "snapshots": snapshots,
            },
            "selection": {"slots": 100, "max_per_instrument": 1, "tie_break": "ASCENDING_INSTRUMENT_ID"},
            "sizing": {"method": "sizing:equal_cash_per_vacant_slot@1"},
            "exits": {
                "stop": share("0.999999999"),
                "target": share("1000"),
                "stop_adjustments": adjustments,
            },
            "execution": {"entry_fill": "NEXT_OPEN", "decision": "AFTER_CLOSE"},
        },
    })
}

/// The worst-case input: 400 sessions, 32 cash dividends, prices near the top of the range with
/// every place of price scale 8.
fn worst_input(strategy: &StrategyArtefact) -> Value {
    let days = dates(SESSIONS);
    let instrument = long_name("instrument", 0)[..51].to_owned();
    let sessions: Vec<Value> = days
        .iter()
        .map(|d| json!({"session": d, "open_at": format!("{d}T14:30:00Z"), "close_at": format!("{d}T21:00:00Z")}))
        .collect();
    let bars: Vec<Value> = days
        .iter()
        .enumerate()
        .map(|(i, d)| {
            let open = format!("{}.{:08}", 987_654_321 - i, 12_345_678 + i);
            json!({
                "session": d,
                "open": open,
                "high": "999999999.99999999",
                "low": "1.00000001",
                "close": format!("{}.{:08}", 987_654_322 - i, 87_654_321 - i),
                "volume": "999999999999999",
                "event_time": format!("{d}T21:00:00Z"),
                "available_at": format!("{d}T21:00:00Z"),
            })
        })
        .collect();
    let actions: Vec<Value> = (0..32)
        .map(|n| {
            let i = 15 + n * 12;
            json!({
                "kind": "CASH_DIVIDEND",
                "action_id": long_name("dividend", n),
                "effective_session": days[i],
                "available_at": format!("{}T12:00:00Z", days[i - 1]),
                "amount_per_share": "0.12345678",
                "payment_session": days[i + 3],
                "payment_phase": "OPEN",
            })
        })
        .collect();
    json!({
        "schema_version": "evaluation-input/1",
        "strategy_hash": payload_digest(strategy).unwrap(),
        "operator_set": "daily-long-only-seed@1",
        "seed": 0,
        "dataset": {"id": "result-size", "version": "1", "source": "SYNTHETIC", "licence": "Apache-2.0, generated for this repository"},
        "instruments": [{
            "instrument_id": instrument,
            "bars": bars,
            "corporate_actions": actions,
            "unplanned_events": [],
        }],
        "calendar": {"sessions": sessions},
        "windows": {
            "warmup_start": days[0],
            "scored_start": days[1],
            "scored_end": days[SESSIONS - 1],
            "information_cutoff": "2099-12-31T23:59:59Z",
        },
        "initial_capital": "999999999999999.999999999999",
        "policy": {
            "id": "daily-long-only-cash@1",
            "currency": "USD",
            "price_scale": 8,
            "quantity_scale": 4,
            "money_scale": 12,
            "diagnostic_scale": 12,
            "lot_size": "0.0001",
            "cost_model": {
                "id": "fixed_plus_bps@1",
                "fixed_fee_per_fill": "0.000000000001",
                "fee_bps": "1",
                "gap_exit_slippage_bps": "1",
            },
            "corporate_actions": {
                "id": "split_cash_dividend_ex_date@1",
                "fractional": "INSUFFICIENT",
                "withholding_bps": "1",
            },
        },
    })
}

fn median(times: &mut [Duration]) -> Duration {
    times.sort();
    times[times.len() / 2]
}

#[test]
fn the_worst_case_run_completes_through_the_worker_and_its_times_are_printed() {
    let strategy_value = worst_strategy();
    let strategy: StrategyArtefact =
        parse_value(strategy_value.clone()).expect("the strategy is valid");
    let input_value = worst_input(&strategy);
    let input: EvaluationInput = parse_value(input_value.clone()).expect("the input is valid");
    let case = S0Case {
        id: "WORST-400".to_owned(),
        strategy: strategy_value,
        input: input_value,
    };
    let repetitions: usize = std::env::var("OPENQUANT_TIMING_REPETITIONS")
        .ok()
        .and_then(|text| text.parse().ok())
        .unwrap_or(3);

    // The core alone: prepare, step to the end and write the result.
    let mut core = Vec::new();
    let mut result_bytes = 0;
    for _ in 0..repetitions {
        let started = Instant::now();
        let run = Run::prepare(&strategy, &input).unwrap();
        let (state, failure) = run.run_to_end(run.initial_state().unwrap());
        let result = run.result(&state, failure.as_ref()).unwrap();
        result_bytes = canonical_json(&serde_json::to_value(&result).unwrap())
            .unwrap()
            .len();
        core.push(started.elapsed());
        assert!(failure.is_none());
    }

    // The whole job: claim, three reads, evaluation, result check, uploads, metrics, submission and
    // acknowledgement, in the fake world (which copies each artefact once).
    let mut job = Vec::new();
    let mut uploaded = 0;
    for _ in 0..repetitions {
        let harness = Harness::new();
        let queued = harness.enqueue_replay(&case, "worst");
        let started = Instant::now();
        let polled = harness.poll();
        job.push(started.elapsed());
        let handled = worker_handled(&polled, &queued.message);
        assert!(
            matches!(handled, Handled::Completed { acked: true, .. }),
            "{handled:?}"
        );
        let world = harness.world();
        let body = &world.accepted_on("attempts.evaluation-submission")[0].body;
        assert_eq!(body["evaluation"]["status"], "COMPLETED");
        uploaded = body["evaluation"]["result"]["size_bytes"].as_u64().unwrap();
        let result: Value = serde_json::from_slice(
            &world.artefacts[body["evaluation"]["result"]["digest"].as_str().unwrap()],
        )
        .unwrap();
        assert_eq!(
            result["journal"]["signals"].as_array().unwrap().len(),
            SESSIONS
        );
        assert_eq!(
            result["journal"]["fills"].as_array().unwrap().len(),
            796,
            "a trade every session"
        );
        assert_eq!(result["journal"]["trades"].as_array().unwrap().len(), 398);
        assert_eq!(
            result["journal"]["corporate_actions"]
                .as_array()
                .unwrap()
                .len(),
            32
        );
    }
    assert_eq!(
        uploaded as usize, result_bytes,
        "the uploaded result is the result"
    );
    assert!(
        (2_000_000..=2_800_000).contains(&result_bytes),
        "the worst-case result measured {result_bytes} bytes"
    );
    println!(
        "worst case, {repetitions} repetitions, result {result_bytes} bytes:\n  core alone  min {:?}  median {:?}  max {:?}\n  whole job   min {:?}  median {:?}  max {:?}",
        core.iter().min().unwrap(),
        median(&mut core.clone()),
        core.iter().max().unwrap(),
        job.iter().min().unwrap(),
        median(&mut job.clone()),
        job.iter().max().unwrap(),
    );
}

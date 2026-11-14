//! The largest `evaluation-result/1` the S0 limits allow (OQ-05 section 7).
//!
//! The API checks a submitted result before it commits it as official. Whether it can parse the
//! whole result inside a Worker depends on how large a result the engine can produce. This test
//! builds inputs at the S0 limits, runs them through the core and measures the canonical bytes.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use openquant_contracts::{
    EvaluationInput, StrategyArtefact, canonical_json, parse_value, payload_digest, to_value,
};
use openquant_core::Run;
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

struct Shape {
    indicators: usize,
    snapshots: usize,
    adjustments: usize,
    halts: usize,
    dividends: usize,
    /// The stop is close below the entry, so a wide bar stops the position out the day it opens.
    churn: bool,
}

fn strategy(shape: &Shape) -> Value {
    // Every indicator divides the close by 3, so its value has every digit the diagnostic scale
    // allows.
    let third = op("div", vec![field("CLOSE"), konst("3", "RATIO")], json!({}));
    let indicators: Vec<Value> = (0..shape.indicators)
        .map(|i| json!({"name": long_name("indicator", i), "expr": third.clone()}))
        .collect();
    let snapshots: Vec<Value> = (0..shape.snapshots)
        .map(|i| json!({"name": long_name("snapshot", i), "expr": third.clone()}))
        .collect();
    let entry = op("entry_price", vec![], json!({}));
    let share = |k: &str| op("mul", vec![konst(k, "RATIO"), entry.clone()], json!({}));
    let stop_ratio = if shape.churn {
        "0.999999999"
    } else {
        "0.000000001"
    };
    let adjustments: Vec<Value> = (0..shape.adjustments)
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
            "rationale": "Measures the result size at the S0 limits.",
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
                "stop": share(stop_ratio),
                "target": share("1000"),
                "stop_adjustments": adjustments,
            },
            "execution": {"entry_fill": "NEXT_OPEN", "decision": "AFTER_CLOSE"},
        },
    })
}

fn input(shape: &Shape, strategy: &StrategyArtefact) -> Value {
    let days = dates(SESSIONS);
    let instrument = long_name("instrument", 0)[..51].to_owned();
    let halted: Vec<usize> = (0..shape.halts).map(|i| 20 + i * 11).collect();
    let sessions: Vec<Value> = days
        .iter()
        .map(|d| json!({"session": d, "open_at": format!("{d}T14:30:00Z"), "close_at": format!("{d}T21:00:00Z")}))
        .collect();
    let bars: Vec<Value> = days
        .iter()
        .enumerate()
        .filter(|(i, _)| !halted.contains(i))
        .map(|(i, d)| {
            // Prices near the top of the range with every fractional digit of price scale 8.
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
    let halts: Vec<Value> = halted
        .iter()
        .enumerate()
        .map(|(n, &i)| {
            json!({
                "event_id": long_name("halt", n),
                "kind": "CONFIRMED_HALT",
                "effective_session": days[i],
                "available_at": format!("{}T12:00:00Z", days[i - 1]),
            })
        })
        .collect();
    let actions: Vec<Value> = (0..shape.dividends)
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
            "unplanned_events": halts,
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

struct Measured {
    bytes: usize,
    status: Value,
    /// Records of each journal list, in the order of `JOURNAL`.
    records: Vec<usize>,
}

const JOURNAL: [&str; 7] = [
    "signals",
    "entries",
    "fills",
    "trades",
    "cash_ledger",
    "daily",
    "corporate_actions",
];

/// Run one shape through the core and measure its result in canonical JSON, the stored bytes.
fn measure(shape: &Shape) -> Measured {
    let strategy: StrategyArtefact = parse_value(strategy(shape)).expect("the strategy is valid");
    let input: EvaluationInput = parse_value(input(shape, &strategy)).expect("the input is valid");
    let run = Run::prepare(&strategy, &input).expect("the run prepares");
    let (state, failure) = run.run_to_end(run.initial_state().unwrap());
    let result = run.result(&state, failure.as_ref()).unwrap();
    let value = to_value(&result).unwrap();
    let records = JOURNAL
        .iter()
        .map(|key| value["journal"][key].as_array().unwrap().len())
        .collect();
    Measured {
        bytes: canonical_json(&value).unwrap().len(),
        status: value["outcome"]["status"].clone(),
        records,
    }
}

/// `RESULT_SCAN_LIMIT` of `packages/api-contracts/ts/src/result.ts`: the largest result the API
/// scans before it commits it. A test there checks that the two values agree.
const RESULT_SCAN_LIMIT: usize = 8 * 1024 * 1024;

/// The largest result found, 2,369,582 bytes when this test was written, which is about 4.5 times
/// the 512 KiB within which a Worker parses a whole result. A trade every session: the stop sits
/// just below the entry and every bar reaches down to it, so each session has an entry fill, an
/// exit fill and four ledger entries. Every signal record carries 32 indicators with 64-character
/// names, and these make up 61% of the bytes. Holding instead of trading gives larger daily
/// records but half the fills and trades, 2,202,744 bytes.
#[test]
fn the_largest_s0_result_is_at_most_half_the_result_scan_limit() {
    let largest = [
        Shape {
            indicators: 32,
            snapshots: 8,
            adjustments: 4,
            halts: 0,
            dividends: 32,
            churn: true,
        },
        Shape {
            indicators: 32,
            snapshots: 8,
            adjustments: 4,
            halts: 0,
            dividends: 32,
            churn: false,
        },
        Shape {
            indicators: 32,
            snapshots: 8,
            adjustments: 4,
            halts: 32,
            dividends: 32,
            churn: true,
        },
    ];
    let measured: Vec<Measured> = largest.iter().map(measure).collect();
    for result in &measured {
        assert_eq!(result.status, json!("COMPLETED"));
        assert!(
            result.bytes <= RESULT_SCAN_LIMIT / 2,
            "a result of {} bytes is more than half the scan limit",
            result.bytes
        );
    }
    // The trading shape reaches the S0 limits: a signal every session, an entry and an exit on
    // every session after the first, and 32 dividend records.
    assert_eq!(measured[0].records, [400, 398, 796, 398, 1592, 400, 32]);
    let bytes = measured[0].bytes;
    assert!(
        (2_000_000..=2_800_000).contains(&bytes),
        "the largest result measured {bytes} bytes; update the figure in OQ-05 section 7"
    );
}

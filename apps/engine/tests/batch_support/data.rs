//! Documents for the batch tests: S0 cases, a synthetic provider manifest at AAPL magnitude and
//! the identities that the tests hold as constants.
//!
//! The identity constants are copied from the golden tests of the core
//! (`packages/quant-core/tests/identity_golden.rs` and `method_golden.rs`), which computed them
//! outside the crate. A test that compared the worker's identity with the code under test would
//! prove nothing.

#![allow(
    dead_code,
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use std::{
    fs,
    path::{Path, PathBuf},
};

use openquant_contracts::{canonical_json, generated::DatasetManifest, parse};
use serde_json::{Value, json};

/// The engine digest (golden, computed with Python).
pub const ENGINE_DIGEST: &str =
    "sha256:7ceafb5e32e05c234b2a4cd2915946d4c6273ea9455d7b4f98821712555bb36a";
/// The method digest (golden, computed with Python).
pub const METHOD_DIGEST: &str =
    "sha256:f9ff643a1c197a0425a65bb38bc2dc53b0b1cc9f97ecdecea37690acedce0123";
pub const OPERATOR_SET: &str = "daily-long-only-seed@1";

pub fn repo() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

pub fn read_json(path: &Path) -> Value {
    serde_json::from_slice(&fs::read(path).unwrap_or_else(|e| panic!("{}: {e}", path.display())))
        .unwrap()
}

pub fn engine() -> Value {
    json!({"engine_digest": ENGINE_DIGEST, "operator_set": OPERATOR_SET})
}

pub fn method() -> Value {
    json!({"name": "openquant-evidence-methods", "version": "1", "digest": METHOD_DIGEST})
}

/// One S0 case: its strategy and input as parsed JSON.
pub struct S0Case {
    pub id: String,
    pub strategy: Value,
    pub input: Value,
}

pub fn s0_case(id: &str) -> S0Case {
    let dir = repo().join("fixtures/s0/cases").join(id);
    let file = read_json(&dir.join("case.json"));
    S0Case {
        id: id.to_owned(),
        strategy: read_json(&dir.join(file["strategy"].as_str().unwrap())),
        input: read_json(&dir.join(file["input"].as_str().unwrap())),
    }
}

/// The seed strategy artefact of the S0 fixtures.
pub fn seed(number: usize) -> Value {
    let name = [
        "seed-1-rsi30-breakeven-off.json",
        "seed-2-rsi32-breakeven-off.json",
        "seed-3-rsi30-breakeven-on.json",
        "seed-4-rsi32-breakeven-on.json",
    ][number - 1];
    read_json(&repo().join("fixtures/s0/strategies").join(name))
}

pub fn canonical(value: &Value) -> String {
    canonical_json(value).unwrap()
}

/// A decimal text with exactly `scale` fractional digits for `units` of 10^-scale.
pub fn price_text(units: i64, scale: u32) -> String {
    let factor = 10_i64.pow(scale);
    format!(
        "{}.{:0width$}",
        units / factor,
        units % factor,
        width = usize::try_from(scale).unwrap()
    )
}

/// Deterministic pseudo-random numbers (a linear congruential generator).
pub struct Lcg(u64);

impl Lcg {
    pub fn new(seed: u64) -> Self {
        Self(seed)
    }

    pub fn next(&mut self, bound: u64) -> u64 {
        self.0 = self
            .0
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
        (self.0 >> 33) % bound
    }
}

/// A calendar date from days since 2024-01-01 (a Monday), skipping weekends.
pub fn session_dates(count: usize) -> Vec<String> {
    let mut dates = Vec::new();
    let (mut year, mut month, mut day) = (2024_u32, 1_u32, 1_u32);
    let mut weekday = 0_u32; // 2024-01-01 is a Monday
    while dates.len() < count {
        if weekday < 5 {
            dates.push(format!("{year:04}-{month:02}-{day:02}"));
        }
        weekday = (weekday + 1) % 7;
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
    dates
}

/// One synthetic cash dividend: effective on session `ex`, paid on session `pay` (indices).
pub struct Dividend {
    pub ex: usize,
    pub pay: usize,
    pub amount: &'static str,
}

/// The path of the synthetic prices.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Shape {
    /// A random walk of daily steps of up to three dollars.
    Random,
    /// A steady climb of 40 cents a day with three sharp falls of four dollars every 17 sessions,
    /// so that the seed strategies see an RSI below 30 above their 50-session mean and trade.
    Cycles,
}

pub fn synthetic_manifest(sessions: usize, scale: u32, seed: u64, dividends: &[Dividend]) -> Value {
    synthetic_manifest_shaped(sessions, scale, seed, dividends, Shape::Random)
}

/// A valid `dataset-manifest/1` of `sessions` sessions of an invented instrument at AAPL's price
/// magnitude (about 190), with `scale` fractional places. The structure around the content comes
/// from the oracle-derived manifest of the market-data case `N-01-split`; the content is written
/// here.
pub fn synthetic_manifest_shaped(
    sessions: usize,
    scale: u32,
    seed: u64,
    dividends: &[Dividend],
    shape: Shape,
) -> Value {
    let template = read_json(&repo().join("fixtures/market-data/cases/N-01-split/expected.json"));
    let mut manifest = template["expect"]["manifest"].clone();
    let dates = session_dates(sessions);
    let unit = 10_i64.pow(scale);
    let mut rng = Lcg::new(seed);
    let mut previous_close = 190 * unit;
    let mut calendar = Vec::new();
    let mut bars = Vec::new();
    for (index, date) in dates.iter().enumerate() {
        // Cents to units of 10^-scale, with random places below the cent when the scale has them.
        let to_units = |rng: &mut Lcg, cents: i64| -> i64 {
            let below_cent = u64::try_from((unit / 100).max(1)).unwrap();
            cents * unit / 100 + i64::try_from(rng.next(below_cent)).unwrap()
        };
        let random_step = i64::try_from(rng.next(601)).unwrap() - 300; // -3.00 .. +3.00
        let step = match shape {
            Shape::Random => random_step,
            Shape::Cycles if index % 17 >= 14 => -400,
            Shape::Cycles => 40,
        };
        let gap = i64::try_from(rng.next(101)).unwrap() - 50; // -0.50 .. +0.50
        let open = (previous_close + to_units(&mut rng, gap)).max(unit);
        let close = (previous_close + to_units(&mut rng, step)).max(unit);
        let up = i64::try_from(rng.next(120)).unwrap();
        let down = i64::try_from(rng.next(120)).unwrap();
        let high = open.max(close) + to_units(&mut rng, up);
        let low = (open.min(close) - to_units(&mut rng, down)).max(1);
        let volume = 30_000_000 + rng.next(60_000_000);
        calendar.push(json!({
            "session": date,
            "open_at": format!("{date}T14:30:00Z"),
            "close_at": format!("{date}T21:00:00Z"),
        }));
        bars.push(json!({
            "session": date,
            "open": price_text(open, scale),
            "high": price_text(high, scale),
            "low": price_text(low, scale),
            "close": price_text(close, scale),
            "volume": volume.to_string(),
            "event_time": format!("{date}T21:00:00Z"),
            "available_at": format!("{date}T23:00:00Z"),
        }));
        previous_close = close;
    }
    let mut actions = Vec::new();
    let mut evidence = Vec::new();
    for (n, dividend) in dividends.iter().enumerate() {
        let id = format!("div-synth-{n:03}");
        actions.push(json!({
            "kind": "CASH_DIVIDEND",
            "action_id": id,
            "effective_session": dates[dividend.ex],
            "available_at": format!("{}T14:30:00Z", dates[dividend.ex]),
            "amount_per_share": dividend.amount,
            "payment_session": dates[dividend.pay],
            "payment_phase": "AFTER_CLOSE",
        }));
        evidence.push(json!({
            "action_id": id,
            "provider_record_id": format!("rec-synth-{n:03}"),
            "provider_field": "declaration_date",
            "provider_value": dates[dividend.ex.saturating_sub(5)],
        }));
    }
    manifest["dataset"] = json!({
        "id": "synth-aapl-1day-sip-raw",
        "version": format!("seed{seed}-s{scale}"),
        "source": "PROVIDER",
        "licence": "Synthetic values generated for this repository under Apache-2.0. Not provider data.",
    });
    manifest["coverage"] = json!({
        "requested": {"start": dates[0], "end": dates[sessions - 1]},
        "returned": {"start": dates[0], "end": dates[sessions - 1]},
        "completeness": "COMPLETE",
        "bar_count": sessions,
        "missing_sessions": [],
    });
    manifest["content"] = json!({
        "calendar": calendar,
        "bars": bars,
        "corporate_actions": actions,
        "unplanned_events": [],
        "action_evidence": evidence,
    });
    manifest["source_responses"] = json!([]);
    // The manifest must be a valid document: any slip in the generator fails here.
    let _: DatasetManifest = parse(&canonical(&manifest)).expect("the synthetic manifest is valid");
    manifest
}

/// The execution policy of the pilot (decision record) at `price_scale`.
pub fn execution_policy(price_scale: u32) -> Value {
    json!({
        "id": "daily-long-only-cash@1",
        "currency": "USD",
        "price_scale": price_scale,
        "quantity_scale": 0,
        "money_scale": price_scale.max(2),
        "diagnostic_scale": 4,
        "lot_size": "1",
        "cost_model": {
            "id": "fixed_plus_bps@1",
            "fixed_fee_per_fill": "0",
            "fee_bps": "5",
            "gap_exit_slippage_bps": "10",
        },
        "corporate_actions": {
            "id": "split_cash_dividend_ex_date@1",
            "fractional": "INSUFFICIENT",
            "withholding_bps": "0",
        },
    })
}

/// The cohort policy of the S1 pilot as the protocol fixtures give it.
pub fn cohort_policy() -> Value {
    read_json(&repo().join("fixtures/protocol/valid/cohort-policy.s1-pilot.json"))
}

/// Seed 1 with one more indicator, the mean over 20 sessions of close divided by open, and a
/// condition that reads it. The mean of ratios is the expression that the S0 record (interpretation
/// 27) measured to overflow the exact domain at prices near 100.
pub fn mean_of_ratios_strategy() -> Value {
    let mut strategy = seed(1);
    let op = |name: &str, args: Vec<Value>, params: Value| json!({"op": format!("operator:{name}@1"), "args": args, "params": params});
    let field = |name: &str| op("bar_field", vec![], json!({"field": name}));
    let ratio = op("div", vec![field("CLOSE"), field("OPEN")], json!({}));
    let mean = op("sma", vec![ratio], json!({"window": 20}));
    strategy["definition"]["indicators"]
        .as_array_mut()
        .unwrap()
        .push(json!({"name": "ratio_mean", "expr": mean}));
    let reads = op(
        "gt",
        vec![
            op("ref", vec![], json!({"name": "ratio_mean"})),
            op("const", vec![], json!({"value": "0", "unit": "RATIO"})),
        ],
        json!({}),
    );
    strategy["definition"]["entry"]["condition"]["args"]
        .as_array_mut()
        .unwrap()
        .push(reads);
    strategy
}

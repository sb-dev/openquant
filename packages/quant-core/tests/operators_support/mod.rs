//! Helpers shared by the operator, signal, variant, identity and property tests.
//!
//! `Frac` and the `reference` module compute expected values with exact integer fractions.
//! They share no code with the engine, so a defect in the engine's decimal arithmetic cannot
//! hide in both sides of a comparison. Prices are written in ticks of 0.01 and volumes in
//! whole shares.

#![allow(
    dead_code,
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use std::{cmp::Ordering, collections::BTreeMap};

use openquant_contracts::{StrategyArtefact, parse};
use openquant_core::{
    Failure, ValidatedStrategy,
    data::{Bar as RawBar, Policy, RunInput, SessionInfo},
    model::MissingReason,
    numeric::{Decimal, Ratio},
    operators::{PriceBar, Value},
    signals::{SignalEval, evaluate_signals},
    validate_strategy,
};
use serde_json::{Value as Json, json};

pub const FIXTURES: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures/s0");

pub const SEEDS: [&str; 5] = [
    "seed-1-rsi30-breakeven-off",
    "seed-2-rsi32-breakeven-off",
    "seed-3-rsi30-breakeven-on",
    "seed-4-rsi32-breakeven-on",
    "seed-5-rsi40-breakeven-off-data-only",
];

pub fn read_fixture(path: &str) -> String {
    std::fs::read_to_string(format!("{FIXTURES}/{path}")).unwrap_or_else(|e| panic!("{path}: {e}"))
}

pub fn seed_text(name: &str) -> String {
    read_fixture(&format!("strategies/{name}.json"))
}

pub fn seed_json(name: &str) -> Json {
    serde_json::from_str(&seed_text(name)).unwrap()
}

pub fn seed(name: &str) -> StrategyArtefact {
    parse(&seed_text(name)).unwrap()
}

// ---------------------------------------------------------------------------------------------
// Exact fractions
// ---------------------------------------------------------------------------------------------

fn gcd(a: i128, b: i128) -> i128 {
    let (mut a, mut b) = (a.abs(), b.abs());
    while b != 0 {
        (a, b) = (b, a % b);
    }
    a
}

fn mulc(a: i128, b: i128) -> i128 {
    a.checked_mul(b).expect("test fraction overflow")
}

/// A reduced fraction with a positive denominator.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Frac {
    n: i128,
    d: i128,
}

impl Frac {
    pub fn new(n: i128, d: i128) -> Self {
        assert!(d != 0, "zero denominator");
        let g = gcd(n, d).max(1);
        let sign = if d < 0 { -1 } else { 1 };
        Self {
            n: sign * (n / g),
            d: sign * (d / g),
        }
    }

    pub fn int(n: i128) -> Self {
        Self { n, d: 1 }
    }

    /// Price in ticks of 0.01.
    pub fn ticks(n: i128) -> Self {
        Self::new(n, 100)
    }

    pub fn from_decimal(value: Decimal) -> Self {
        Self::new(value.mantissa(), 10_i128.pow(value.scale()))
    }

    /// The engine's exact value as a fraction.
    pub fn from_ratio(value: Ratio) -> Self {
        Self::new(value.numerator(), value.denominator())
    }

    pub fn add(self, o: Self) -> Self {
        Self::new(mulc(self.n, o.d) + mulc(o.n, self.d), mulc(self.d, o.d))
    }

    pub fn sub(self, o: Self) -> Self {
        Self::new(mulc(self.n, o.d) - mulc(o.n, self.d), mulc(self.d, o.d))
    }

    pub fn mul(self, o: Self) -> Self {
        Self::new(mulc(self.n, o.n), mulc(self.d, o.d))
    }

    pub fn div(self, o: Self) -> Self {
        assert!(o.n != 0, "division by zero in the reference");
        Self::new(mulc(self.n, o.d), mulc(self.d, o.n))
    }

    pub fn abs(self) -> Self {
        Self {
            n: self.n.abs(),
            d: self.d,
        }
    }

    pub fn is_zero(self) -> bool {
        self.n == 0
    }

    pub fn cmp_to(self, o: Self) -> Ordering {
        mulc(self.n, o.d).cmp(&mulc(o.n, self.d))
    }

    /// True when the decimal expansion terminates (the denominator has only the factors 2 and 5).
    pub fn terminates(self) -> bool {
        let mut d = self.d;
        for p in [2, 5] {
            while d % p == 0 {
                d /= p;
            }
        }
        d == 1
    }

    /// Does `value` equal this fraction? The engine is exact, so every fraction must match
    /// exactly, terminating or not.
    pub fn matches(self, value: Ratio) -> bool {
        Self::from_ratio(value) == self
    }
}

// ---------------------------------------------------------------------------------------------
// Bars and series
// ---------------------------------------------------------------------------------------------

/// A bar in ticks of 0.01 with whole-share volume.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Bar {
    pub o: i64,
    pub h: i64,
    pub l: i64,
    pub c: i64,
    pub v: i64,
}

impl Bar {
    pub fn new(o: i64, h: i64, l: i64, c: i64, v: i64) -> Self {
        assert!(l <= o && l <= c && o <= h && c <= h, "inconsistent bar");
        Self { o, h, l, c, v }
    }

    /// A bar whose four prices equal `c`.
    pub fn flat(c: i64, v: i64) -> Self {
        Self::new(c, c, c, c, v)
    }

    pub fn price_bar(self) -> PriceBar {
        PriceBar::from_decimals(
            Decimal::new(self.o, 2),
            Decimal::new(self.h, 2),
            Decimal::new(self.l, 2),
            Decimal::new(self.c, 2),
            Decimal::from(self.v),
        )
    }
}

pub fn series_of(bars: &[Bar]) -> Vec<Option<PriceBar>> {
    bars.iter().map(|b| Some(b.price_bar())).collect()
}

pub fn flat_series(closes: &[i64]) -> Vec<Bar> {
    closes.iter().map(|c| Bar::flat(*c, 1000)).collect()
}

/// Deterministic generator for synthetic series (a fixed LCG; the seeds are written in the tests).
pub struct Lcg(pub u64);

impl Lcg {
    pub fn next_u64(&mut self) -> u64 {
        self.0 = self
            .0
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
        self.0 >> 33
    }

    /// Uniform-ish integer in `lo..=hi`.
    pub fn range(&mut self, lo: i64, hi: i64) -> i64 {
        let span = u64::try_from(hi - lo + 1).unwrap();
        lo + i64::try_from(self.next_u64() % span).unwrap()
    }
}

/// A mean-reverting random walk with gaps, wicks and varying volume. Always positive.
pub fn random_bars(seed: u64, count: usize) -> Vec<Bar> {
    let mut rng = Lcg(seed);
    let mut previous_close: i64 = 10_000;
    let mut out = Vec::with_capacity(count);
    for _ in 0..count {
        let gap = rng.range(-120, 120);
        let open = (previous_close + gap).max(100);
        let drift = (10_000 - previous_close) / 25;
        let close = (open + rng.range(-350, 350) + drift).max(100);
        let high = open.max(close) + rng.range(0, 180);
        let low = (open.min(close) - rng.range(0, 180)).max(1);
        out.push(Bar::new(open, high, low, close, rng.range(500, 3000)));
        previous_close = close;
    }
    out
}

// ---------------------------------------------------------------------------------------------
// Run inputs for the series builder
// ---------------------------------------------------------------------------------------------

/// Calendar date of session `index`: consecutive days starting at 2026-02-01 (no weekends or
/// holidays: the signal series is aligned by session, not by weekday). Valid for 335 sessions.
pub fn date_of(index: usize) -> String {
    const MONTHS: [(u32, usize); 11] = [
        (2, 28),
        (3, 31),
        (4, 30),
        (5, 31),
        (6, 30),
        (7, 31),
        (8, 31),
        (9, 30),
        (10, 31),
        (11, 30),
        (12, 31),
    ];
    let mut left = index;
    for (month, days) in MONTHS {
        if left < days {
            return format!("2026-{month:02}-{:02}", left + 1);
        }
        left -= days;
    }
    panic!("session index {index} is beyond the test calendar");
}

/// A `RunInput` with one raw bar per session (available five minutes after the close unless
/// `late` names another instant for that index), no actions, no halts, `first = 0`.
pub fn run_input(bars: &[Option<Bar>], late: &BTreeMap<usize, &str>) -> RunInput {
    let sessions: Vec<SessionInfo> = (0..bars.len())
        .map(|i| SessionInfo {
            date: date_of(i),
            open_at: format!("{}T14:30:00Z", date_of(i)),
            close_at: format!("{}T21:00:00Z", date_of(i)),
        })
        .collect();
    let mut raw = BTreeMap::new();
    for (i, bar) in bars.iter().enumerate() {
        if let Some(bar) = bar {
            let available_at = late
                .get(&i)
                .map_or_else(|| format!("{}T21:05:00Z", date_of(i)), |s| (*s).to_owned());
            raw.insert(
                date_of(i),
                RawBar {
                    open: Decimal::new(bar.o, 2),
                    high: Decimal::new(bar.h, 2),
                    low: Decimal::new(bar.l, 2),
                    close: Decimal::new(bar.c, 2),
                    volume: Decimal::from(bar.v),
                    available_at,
                },
            );
        }
    }
    RunInput {
        instrument_id: "XYZ".to_owned(),
        sessions,
        bars: raw,
        actions: vec![],
        halts: vec![],
        first: 0,
        scored_start: 0,
        last: bars.len().saturating_sub(1),
        information_cutoff: "2099-12-31T23:59:59Z".to_owned(),
        initial_capital: Decimal::from(1000),
        policy: Policy {
            price_scale: 2,
            quantity_scale: 0,
            money_scale: 4,
            diagnostic_scale: 8,
            lot_size: Decimal::ONE,
            fixed_fee: Decimal::ZERO,
            fee_bps: Decimal::ZERO,
            gap_exit_slippage_bps: Decimal::ZERO,
            withholding_bps: Decimal::ZERO,
        },
    }
}

// ---------------------------------------------------------------------------------------------
// Expression builders (JSON; they go through the same typed binding as any artefact)
// ---------------------------------------------------------------------------------------------

pub fn op(name: &str, args: Vec<Json>, params: Json) -> Json {
    json!({"op": format!("operator:{name}@1"), "args": args, "params": params})
}

pub fn field(name: &str) -> Json {
    op("bar_field", vec![], json!({"field": name}))
}

pub fn close() -> Json {
    field("CLOSE")
}

pub fn volume() -> Json {
    field("VOLUME")
}

pub fn cst(value: &str, unit: &str) -> Json {
    op("const", vec![], json!({"value": value, "unit": unit}))
}

pub fn rf(name: &str) -> Json {
    op("ref", vec![], json!({"name": name}))
}

pub fn snap(name: &str) -> Json {
    op("snapshot", vec![], json!({"name": name}))
}

pub fn entry_price() -> Json {
    op("entry_price", vec![], json!({}))
}

pub fn lag(arg: Json, periods: u64) -> Json {
    op("lag", vec![arg], json!({"periods": periods}))
}

pub fn sma(arg: Json, window: u64) -> Json {
    op("sma", vec![arg], json!({"window": window}))
}

pub fn rsi(arg: Json, window: u64) -> Json {
    op("rsi_simple", vec![arg], json!({"window": window}))
}

pub fn atr(window: u64) -> Json {
    op("atr_simple", vec![], json!({"window": window}))
}

pub fn bin(name: &str, a: Json, b: Json) -> Json {
    op(name, vec![a, b], json!({}))
}

pub fn and(args: Vec<Json>) -> Json {
    op("and", args, json!({}))
}

pub fn or(args: Vec<Json>) -> Json {
    op("or", args, json!({}))
}

/// A trivially true flag expression.
pub fn always() -> Json {
    bin("gt", cst("1", "POINTS"), cst("0", "POINTS"))
}

/// Replace the four history-dependent indicators of a seed artefact (`rsi14`, `sma50`,
/// `vol_sma20`, `atr14`) so that the close read as POINTS stands in for RSI, the trend mean is 0,
/// the volume mean 1 share and the ATR 1. The entry condition, the rank, the thresholds and the
/// floor stay exactly as published.
pub fn close_stands_for_rsi(artefact: &mut Json) {
    for item in artefact["definition"]["indicators"].as_array_mut().unwrap() {
        let replacement = match item["name"].as_str().unwrap() {
            "sma50" => Some(cst("0", "PRICE")),
            "vol_sma20" => Some(cst("1", "SHARES")),
            "atr14" => Some(cst("1", "PRICE")),
            "rsi14" => Some(bin(
                "mul",
                cst("1", "POINTS"),
                bin("div", close(), cst("1", "PRICE")),
            )),
            _ => None,
        };
        if let Some(replacement) = replacement {
            item["expr"] = replacement;
        }
    }
}

/// A definition under test, built on top of the seed artefact's contract and fixed rules.
#[derive(Clone)]
pub struct Def {
    pub indicators: Vec<(String, Json)>,
    pub condition: Json,
    pub rank: Json,
    pub snapshots: Vec<(String, Json)>,
    pub stop: Json,
    pub target: Json,
    pub adjustments: Vec<Json>,
}

impl Default for Def {
    fn default() -> Self {
        Self::new()
    }
}

impl Def {
    pub fn new() -> Self {
        Self {
            indicators: vec![],
            condition: always(),
            rank: cst("0", "POINTS"),
            snapshots: vec![],
            stop: bin("sub", entry_price(), cst("1", "PRICE")),
            target: bin("add", entry_price(), cst("1", "PRICE")),
            adjustments: vec![],
        }
    }

    pub fn indicator(mut self, name: &str, expr: Json) -> Self {
        self.indicators.push((name.to_owned(), expr));
        self
    }

    pub fn condition(mut self, expr: Json) -> Self {
        self.condition = expr;
        self
    }

    pub fn rank(mut self, expr: Json) -> Self {
        self.rank = expr;
        self
    }

    pub fn snapshot(mut self, name: &str, expr: Json) -> Self {
        self.snapshots.push((name.to_owned(), expr));
        self
    }

    pub fn stop(mut self, expr: Json) -> Self {
        self.stop = expr;
        self
    }

    pub fn target(mut self, expr: Json) -> Self {
        self.target = expr;
        self
    }

    pub fn adjustment(mut self, id: &str, trigger: Json, new_level: Json) -> Self {
        self.adjustments.push(json!({
            "id": id, "trigger": trigger, "new_level": new_level, "effective": "NEXT_SESSION"
        }));
        self
    }

    pub fn json(&self) -> Json {
        let named = |items: &[(String, Json)]| -> Vec<Json> {
            items
                .iter()
                .map(|(name, expr)| json!({"name": name, "expr": expr}))
                .collect()
        };
        let mut base = seed_json(SEEDS[0]);
        base["definition"]["indicators"] = Json::Array(named(&self.indicators));
        base["definition"]["entry"] = json!({
            "condition": self.condition,
            "rank": self.rank,
            "snapshots": named(&self.snapshots),
        });
        base["definition"]["exits"] = json!({
            "stop": self.stop,
            "target": self.target,
            "stop_adjustments": self.adjustments,
        });
        base
    }

    /// Typed binding without the JSON Schema range checks, so limits beyond the schema can be
    /// exercised. Patterns and enums are still enforced by the typed binding.
    pub fn artefact(&self) -> StrategyArtefact {
        serde_json::from_value(self.json()).expect("typed binding")
    }

    pub fn validate(&self) -> Result<ValidatedStrategy, Failure> {
        validate_strategy(&self.artefact())
    }

    pub fn validated(&self) -> ValidatedStrategy {
        self.validate()
            .unwrap_or_else(|failure| panic!("expected a valid definition: {failure}"))
    }

    /// The failure of an invalid definition.
    pub fn reject(&self) -> Failure {
        match self.validate() {
            Ok(_) => panic!("expected the definition to be rejected"),
            Err(failure) => failure,
        }
    }
}

/// Evaluate one expression as the indicator `x` of an otherwise trivial strategy.
pub struct Probe {
    strategy: ValidatedStrategy,
}

impl Probe {
    pub fn new(expr: Json) -> Self {
        Self {
            strategy: Def::new().indicator("x", expr).validated(),
        }
    }

    pub fn failure(expr: Json) -> Failure {
        Def::new().indicator("x", expr).reject()
    }

    /// Value of `x` at series index `t`, using only the series through `t`.
    pub fn at(&self, series: &[Option<PriceBar>], t: usize) -> Value {
        signals(&self.strategy, series, t)
            .indicators
            .into_iter()
            .find(|(name, _)| name == "x")
            .unwrap()
            .1
    }
}

/// Evaluate every signal output at index `t` of `series`.
pub fn signals(strategy: &ValidatedStrategy, series: &[Option<PriceBar>], t: usize) -> SignalEval {
    evaluate_signals(strategy, &series[..=t]).unwrap_or_else(|f| panic!("evaluation failed: {f}"))
}

pub fn indicator(eval: &SignalEval, name: &str) -> Value {
    eval.indicators
        .iter()
        .find(|(n, _)| n == name)
        .unwrap_or_else(|| panic!("no indicator {name}"))
        .1
}

pub fn snapshot_value(eval: &SignalEval, name: &str) -> Value {
    eval.snapshots
        .iter()
        .find(|(n, _)| n == name)
        .unwrap_or_else(|| panic!("no snapshot {name}"))
        .1
}

// ---------------------------------------------------------------------------------------------
// Expected values
// ---------------------------------------------------------------------------------------------

/// What a reference calculation says an operator must produce.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Exp {
    Num(Frac),
    Flag(bool),
    Missing(MissingReason),
}

impl Exp {
    pub fn history() -> Self {
        Self::Missing(MissingReason::InsufficientHistory)
    }

    pub fn flat() -> Self {
        Self::Missing(MissingReason::UndefinedFlat)
    }

    /// Does the engine value agree with this expectation?
    pub fn agrees(self, value: Value) -> bool {
        match (self, value) {
            (Self::Num(want), Value::Num(got)) => want.matches(got),
            (Self::Flag(want), Value::Flag(got)) => want == got,
            (Self::Missing(want), Value::Missing(got)) => want == got,
            _ => false,
        }
    }
}

#[track_caller]
pub fn assert_agrees(want: Exp, got: Value, what: &str) {
    assert!(
        want.agrees(got),
        "{what}: expected {want:?}, engine gave {got:?}"
    );
}

pub fn num(value: Value) -> Ratio {
    match value {
        Value::Num(n) => n,
        other => panic!("expected a number, got {other:?}"),
    }
}

pub mod reference {
    //! Independent definitions of the seed indicators (OQ-02 section 2.6) on exact fractions.

    use super::{Bar, Exp, Frac};

    /// The `count` bars ending at `t`, oldest first. `None` unless all exist.
    pub fn window(series: &[Option<Bar>], t: usize, count: usize) -> Option<Vec<Bar>> {
        let start = (t + 1).checked_sub(count)?;
        let slice = series.get(start..=t)?;
        slice.iter().copied().collect()
    }

    /// Simple mean of the closes over `w` bars including bar `t`, as a price.
    pub fn sma_close(series: &[Option<Bar>], t: usize, w: usize) -> Exp {
        match window(series, t, w) {
            None => Exp::history(),
            Some(bars) => {
                let sum: i128 = bars.iter().map(|b| i128::from(b.c)).sum();
                Exp::Num(Frac::new(sum, 100 * i128::try_from(w).unwrap()))
            }
        }
    }

    /// Simple mean of the volumes over `w` bars including bar `t`.
    pub fn sma_volume(series: &[Option<Bar>], t: usize, w: usize) -> Exp {
        match window(series, t, w) {
            None => Exp::history(),
            Some(bars) => {
                let sum: i128 = bars.iter().map(|b| i128::from(b.v)).sum();
                Exp::Num(Frac::new(sum, i128::try_from(w).unwrap()))
            }
        }
    }

    /// `100 * sum_gain / (sum_gain + sum_loss)` over `w` close changes; `w + 1` closes needed.
    pub fn rsi(series: &[Option<Bar>], t: usize, w: usize) -> Exp {
        let Some(bars) = window(series, t, w + 1) else {
            return Exp::history();
        };
        let (mut gain, mut loss) = (0_i128, 0_i128);
        for pair in bars.windows(2) {
            let change = i128::from(pair[1].c) - i128::from(pair[0].c);
            if change > 0 {
                gain += change;
            } else {
                loss -= change;
            }
        }
        if gain + loss == 0 {
            Exp::flat()
        } else {
            Exp::Num(Frac::new(100 * gain, gain + loss))
        }
    }

    /// The same value `k` sessions earlier.
    pub fn rsi_lagged(series: &[Option<Bar>], t: usize, w: usize, k: usize) -> Exp {
        match t.checked_sub(k) {
            None => Exp::history(),
            Some(earlier) => rsi(series, earlier, w),
        }
    }

    /// Simple mean over `w` true ranges; `w + 1` bars needed.
    pub fn atr(series: &[Option<Bar>], t: usize, w: usize) -> Exp {
        let Some(bars) = window(series, t, w + 1) else {
            return Exp::history();
        };
        let mut sum = 0_i128;
        for pair in bars.windows(2) {
            let (previous, bar) = (pair[0], pair[1]);
            let range = i128::from(bar.h) - i128::from(bar.l);
            let up = (i128::from(bar.h) - i128::from(previous.c)).abs();
            let down = (i128::from(bar.l) - i128::from(previous.c)).abs();
            sum += range.max(up).max(down);
        }
        Exp::Num(Frac::new(sum, 100 * i128::try_from(w).unwrap()))
    }
}

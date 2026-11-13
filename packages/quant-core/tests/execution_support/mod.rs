//! Shared builders for the execution, corporate-action, recovery, validation and property tests.
//!
//! A [`Scenario`] describes a reduced one-instrument run in plain data: a calendar of sessions,
//! raw bars, policy numbers, optional actions and halts, and a reduced strategy whose entry
//! signal is controlled by the bar volume (volume above 1000 signals). The strategy is the same
//! shape as `fixtures/s0/cases/F0-smoke/strategy.json`, so the numbers stay checkable by hand.
//!
//! Expected values in the tests are written out by hand, never produced by calling the engine.

#![allow(
    dead_code,
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use openquant_contracts::{
    Checkpoint, EvaluationInput, EvaluationResult, StrategyArtefact, canonical_json, parse,
    parse_value, payload_digest, to_value,
};
use openquant_core::{Failure, Run, State};
use serde_json::{Value, json};

/// Volume that signals an entry when it is above [`SIGNAL_THRESHOLD`].
pub const SIGNAL_VOLUME: &str = "2000";
/// Volume that does not signal.
pub const QUIET_VOLUME: &str = "1000";
pub const SIGNAL_THRESHOLD: &str = "1000";

/// Date of session `index`: consecutive calendar days from 2026-03-02.
pub fn date(index: usize) -> String {
    let months = [
        (3, 31),
        (4, 30),
        (5, 31),
        (6, 30),
        (7, 31),
        (8, 31),
        (9, 30),
    ];
    let mut day = 2 + index;
    for (month, length) in months {
        if day <= length {
            return format!("2026-{month:02}-{day:02}");
        }
        day -= length;
    }
    panic!("session index {index} is outside the test calendar");
}

pub fn open_at(index: usize) -> String {
    format!("{}T14:30:00Z", date(index))
}

pub fn close_at(index: usize) -> String {
    format!("{}T21:00:00Z", date(index))
}

/// One raw bar. `available_at` defaults to the close of its session.
#[derive(Clone, Debug)]
pub struct Bar {
    pub open: String,
    pub high: String,
    pub low: String,
    pub close: String,
    pub volume: String,
    pub available_at: Option<String>,
}

pub fn bar(open: &str, high: &str, low: &str, close: &str, volume: &str) -> Bar {
    Bar {
        open: open.to_owned(),
        high: high.to_owned(),
        low: low.to_owned(),
        close: close.to_owned(),
        volume: volume.to_owned(),
        available_at: None,
    }
}

/// A bar that signals an entry.
pub fn signal_bar(open: &str, high: &str, low: &str, close: &str) -> Bar {
    bar(open, high, low, close, SIGNAL_VOLUME)
}

/// A bar that does not signal.
pub fn quiet_bar(open: &str, high: &str, low: &str, close: &str) -> Bar {
    bar(open, high, low, close, QUIET_VOLUME)
}

#[derive(Clone, Debug)]
pub struct PolicyOpts {
    pub lot: String,
    pub fixed_fee: String,
    pub fee_bps: String,
    pub slippage_bps: String,
    pub withholding_bps: String,
    pub price_scale: u32,
    pub quantity_scale: u32,
    pub money_scale: u32,
}

impl Default for PolicyOpts {
    fn default() -> Self {
        Self {
            lot: "1".to_owned(),
            fixed_fee: "0.00".to_owned(),
            fee_bps: "0".to_owned(),
            slippage_bps: "0".to_owned(),
            withholding_bps: "0".to_owned(),
            price_scale: 2,
            quantity_scale: 0,
            money_scale: 2,
        }
    }
}

#[derive(Clone, Debug)]
pub struct StrategyOpts {
    pub slots: u64,
    pub atr_window: u64,
    pub stop_mult: String,
    pub target_mult: String,
    pub break_even: bool,
    /// New stop level of the break-even rule as `entry + k * ATR`; `None` is the entry price.
    pub break_even_multiple: Option<String>,
    /// The break-even rule fires when the high reaches `entry + k * ATR`; `None` is `k = 1`.
    pub break_even_trigger_multiple: Option<String>,
    /// Replaces the entry condition (the default is a volume above 1000 shares).
    pub condition: Option<Value>,
    /// Extra snapshots `(name, unit, kind)` where kind is `volume`, `close` or a constant.
    pub extra_snapshots: Vec<(String, String, String)>,
    /// Extra indicators `(name, kind)` where kind is `lag_close` or `lag_volume` (one session).
    pub extra_indicators: Vec<(String, String)>,
}

impl Default for StrategyOpts {
    fn default() -> Self {
        Self {
            slots: 5,
            atr_window: 1,
            stop_mult: "2".to_owned(),
            target_mult: "5".to_owned(),
            break_even: false,
            break_even_multiple: None,
            break_even_trigger_multiple: None,
            condition: None,
            extra_snapshots: Vec::new(),
            extra_indicators: Vec::new(),
        }
    }
}

/// A reduced one-instrument run in plain data.
#[derive(Clone, Debug)]
pub struct Scenario {
    pub bars: Vec<Option<Bar>>,
    pub scored_start: usize,
    pub last: usize,
    pub capital: String,
    pub policy: PolicyOpts,
    pub strategy: StrategyOpts,
    pub actions: Vec<Value>,
    pub halts: Vec<Value>,
    pub instrument: String,
    /// Latest instant at which evidence may become available. Far in the future by default.
    pub information_cutoff: String,
}

impl Scenario {
    /// A scenario of `bars.len()` sessions, scored from session 1 to the last one.
    pub fn new(bars: Vec<Bar>) -> Self {
        let last = bars.len() - 1;
        Self {
            bars: bars.into_iter().map(Some).collect(),
            scored_start: 1,
            last,
            capital: "5000.00".to_owned(),
            policy: PolicyOpts::default(),
            strategy: StrategyOpts::default(),
            actions: Vec::new(),
            halts: Vec::new(),
            instrument: "SYN".to_owned(),
            information_cutoff: "2099-12-31T23:59:59Z".to_owned(),
        }
    }

    /// Set the information cutoff of the run.
    pub fn information_cutoff(mut self, instant: &str) -> Self {
        self.information_cutoff = instant.to_owned();
        self
    }

    pub fn capital(mut self, capital: &str) -> Self {
        self.capital = capital.to_owned();
        self
    }

    pub fn lot(mut self, lot: &str) -> Self {
        self.policy.lot = lot.to_owned();
        self
    }

    pub fn fees(mut self, fixed: &str, bps: &str) -> Self {
        self.policy.fixed_fee = fixed.to_owned();
        self.policy.fee_bps = bps.to_owned();
        self
    }

    pub fn slippage(mut self, bps: &str) -> Self {
        self.policy.slippage_bps = bps.to_owned();
        self
    }

    pub fn withholding(mut self, bps: &str) -> Self {
        self.policy.withholding_bps = bps.to_owned();
        self
    }

    pub fn break_even(mut self, on: bool) -> Self {
        self.strategy.break_even = on;
        self
    }

    /// Break-even moves the stop to `entry + k * ATR` instead of the entry price.
    pub fn break_even_level(mut self, multiple: &str) -> Self {
        self.strategy.break_even = true;
        self.strategy.break_even_multiple = Some(multiple.to_owned());
        self
    }

    /// The break-even rule fires when the high reaches `entry + k * ATR`.
    pub fn break_even_trigger(mut self, multiple: &str) -> Self {
        self.strategy.break_even = true;
        self.strategy.break_even_trigger_multiple = Some(multiple.to_owned());
        self
    }

    /// Replace the entry condition by an expression over the signal scope.
    pub fn condition(mut self, expr: Value) -> Self {
        self.strategy.condition = Some(expr);
        self
    }

    pub fn atr_window(mut self, window: u64) -> Self {
        self.strategy.atr_window = window;
        self
    }

    pub fn multiples(mut self, stop: &str, target: &str) -> Self {
        self.strategy.stop_mult = stop.to_owned();
        self.strategy.target_mult = target.to_owned();
        self
    }

    pub fn snapshot(mut self, name: &str, unit: &str, kind: &str) -> Self {
        self.strategy
            .extra_snapshots
            .push((name.to_owned(), unit.to_owned(), kind.to_owned()));
        self
    }

    pub fn indicator(mut self, name: &str, kind: &str) -> Self {
        self.strategy
            .extra_indicators
            .push((name.to_owned(), kind.to_owned()));
        self
    }

    /// Set the availability time of the action `id`.
    pub fn action_available_at(mut self, id: &str, available_at: &str) -> Self {
        for action in &mut self.actions {
            if action["action_id"] == id {
                action["available_at"] = json!(available_at);
            }
        }
        self
    }

    /// A halt event with an explicit availability time. The session has no bar.
    pub fn halt_known_at(mut self, id: &str, index: usize, available_at: &str) -> Self {
        self.bars[index] = None;
        self.halts.push(json!({
            "event_id": id,
            "kind": "CONFIRMED_HALT",
            "effective_session": date(index),
            "available_at": available_at,
        }));
        self
    }

    pub fn scored_from(mut self, index: usize) -> Self {
        self.scored_start = index;
        self
    }

    pub fn without_bar(mut self, index: usize) -> Self {
        self.bars[index] = None;
        self
    }

    pub fn with_available_at(mut self, index: usize, available_at: &str) -> Self {
        if let Some(bar) = self.bars[index].as_mut() {
            bar.available_at = Some(available_at.to_owned());
        }
        self
    }

    pub fn split(mut self, id: &str, effective: usize, new: u64, old: u64) -> Self {
        self.actions.push(json!({
            "kind": "SPLIT",
            "action_id": id,
            "effective_session": date(effective),
            "available_at": format!("{}T12:00:00Z", date(effective - 1)),
            "ratio_new": new,
            "ratio_old": old,
        }));
        self
    }

    pub fn dividend(
        mut self,
        id: &str,
        effective: usize,
        amount: &str,
        payment_session: usize,
        payment_phase: &str,
    ) -> Self {
        self.actions.push(json!({
            "kind": "CASH_DIVIDEND",
            "action_id": id,
            "effective_session": date(effective),
            "available_at": format!("{}T12:00:00Z", date(effective - 1)),
            "amount_per_share": amount,
            "payment_session": date(payment_session),
            "payment_phase": payment_phase,
        }));
        self
    }

    pub fn unsupported(mut self, id: &str, kind: &str, effective: usize) -> Self {
        self.actions.push(json!({
            "kind": kind,
            "action_id": id,
            "effective_session": date(effective),
            "available_at": format!("{}T12:00:00Z", date(effective - 1)),
        }));
        self
    }

    /// A confirmed halt known before the session opens. The session has no bar.
    pub fn halt(mut self, id: &str, index: usize) -> Self {
        self.bars[index] = None;
        self.halts.push(json!({
            "event_id": id,
            "kind": "CONFIRMED_HALT",
            "effective_session": date(index),
            "available_at": format!("{}T12:00:00Z", date(index - 1)),
        }));
        self
    }

    /// The strategy artefact as JSON.
    pub fn strategy_value(&self) -> Value {
        let s = &self.strategy;
        let close = json!({"op": "operator:bar_field@1", "args": [], "params": {"field": "CLOSE"}});
        let volume =
            json!({"op": "operator:bar_field@1", "args": [], "params": {"field": "VOLUME"}});
        let konst = |value: &str, unit: &str| json!({"op": "operator:const@1", "args": [], "params": {"value": value, "unit": unit}});
        let entry_price = json!({"op": "operator:entry_price@1", "args": [], "params": {}});
        let snapshot =
            |name: &str| json!({"op": "operator:snapshot@1", "args": [], "params": {"name": name}});
        let mut snapshots = vec![json!({
            "name": "entry_atr",
            "expr": {"op": "operator:ref@1", "args": [], "params": {"name": "atr"}},
        })];
        for (name, unit, kind) in &s.extra_snapshots {
            let expr = match kind.as_str() {
                "volume" => volume.clone(),
                "close" => close.clone(),
                other => konst(other, unit),
            };
            snapshots.push(json!({"name": name, "expr": expr}));
        }
        let mut indicators = vec![json!({
            "name": "atr",
            "expr": {"op": "operator:atr_simple@1", "args": [], "params": {"window": s.atr_window}},
        })];
        for (name, kind) in &s.extra_indicators {
            let source = if kind == "lag_volume" {
                volume.clone()
            } else {
                close.clone()
            };
            indicators.push(json!({
                "name": name,
                "expr": {"op": "operator:lag@1", "args": [source], "params": {"periods": 1}},
            }));
        }
        let adjustments = if s.break_even {
            json!([{
                "id": "break_even",
                "trigger": {
                    "op": "operator:gte@1",
                    "args": [
                        {"op": "operator:bar_field@1", "args": [], "params": {"field": "HIGH"}},
                        match &s.break_even_trigger_multiple {
                            None => json!({"op": "operator:add@1", "args": [entry_price.clone(), snapshot("entry_atr")], "params": {}}),
                            Some(k) => json!({
                                "op": "operator:add@1",
                                "args": [entry_price.clone(), {
                                    "op": "operator:mul@1",
                                    "args": [konst(k, "RATIO"), snapshot("entry_atr")],
                                    "params": {},
                                }],
                                "params": {},
                            }),
                        },
                    ],
                    "params": {},
                },
                "new_level": match &s.break_even_multiple {
                    None => entry_price.clone(),
                    Some(k) => json!({
                        "op": "operator:add@1",
                        "args": [entry_price.clone(), {
                            "op": "operator:mul@1",
                            "args": [konst(k, "RATIO"), snapshot("entry_atr")],
                            "params": {},
                        }],
                        "params": {},
                    }),
                },
                "effective": "NEXT_SESSION",
            }])
        } else {
            json!([])
        };
        json!({
            "schema_version": "strategy-artefact/1",
            "strategy_id": "execution-test",
            "version": 1,
            "operator_set": "daily-long-only-seed@1",
            "contract": {
                "hypothesis": "Test only: enter when the volume is above 1000 shares.",
                "rationale": "Reduced strategy so execution numbers stay checkable by hand.",
                "intended_conditions": ["Synthetic sessions."],
                "benchmarks": ["None."],
                "assumptions": ["Costs come from the test policy."],
                "invalidation": ["Not a trading hypothesis."],
            },
            "definition": {
                "indicators": indicators,
                "entry": {
                    "condition": s.condition.clone().unwrap_or_else(|| json!({
                        "op": "operator:gt@1",
                        "args": [volume.clone(), konst(SIGNAL_THRESHOLD, "SHARES")],
                        "params": {},
                    })),
                    "rank": konst("1", "POINTS"),
                    "snapshots": snapshots,
                },
                "selection": {"slots": s.slots, "max_per_instrument": 1, "tie_break": "ASCENDING_INSTRUMENT_ID"},
                "sizing": {"method": "sizing:equal_cash_per_vacant_slot@1"},
                "exits": {
                    "stop": {
                        "op": "operator:sub@1",
                        "args": [entry_price.clone(), {
                            "op": "operator:mul@1",
                            "args": [konst(&s.stop_mult, "RATIO"), snapshot("entry_atr")],
                            "params": {},
                        }],
                        "params": {},
                    },
                    "target": {
                        "op": "operator:add@1",
                        "args": [entry_price.clone(), {
                            "op": "operator:mul@1",
                            "args": [konst(&s.target_mult, "RATIO"), snapshot("entry_atr")],
                            "params": {},
                        }],
                        "params": {},
                    },
                    "stop_adjustments": adjustments,
                },
                "execution": {"entry_fill": "NEXT_OPEN", "decision": "AFTER_CLOSE"},
            },
        })
    }

    pub fn strategy_artefact(&self) -> StrategyArtefact {
        parse_value(self.strategy_value()).expect("the test strategy is valid")
    }

    /// The evaluation input as JSON, bound to the strategy by hash.
    pub fn input_value(&self) -> Value {
        let hash = payload_digest(&self.strategy_artefact()).unwrap();
        let sessions: Vec<Value> = (0..self.bars.len())
            .map(|i| json!({"session": date(i), "open_at": open_at(i), "close_at": close_at(i)}))
            .collect();
        let bars: Vec<Value> = self
            .bars
            .iter()
            .enumerate()
            .filter_map(|(i, bar)| bar.as_ref().map(|b| (i, b)))
            .map(|(i, b)| {
                json!({
                    "session": date(i),
                    "open": b.open,
                    "high": b.high,
                    "low": b.low,
                    "close": b.close,
                    "volume": b.volume,
                    "event_time": close_at(i),
                    "available_at": b.available_at.clone().unwrap_or_else(|| close_at(i)),
                })
            })
            .collect();
        let p = &self.policy;
        json!({
            "schema_version": "evaluation-input/1",
            "strategy_hash": hash,
            "operator_set": "daily-long-only-seed@1",
            "seed": 0,
            "dataset": {"id": "execution-test", "version": "1", "source": "SYNTHETIC", "licence": "Apache-2.0, generated for this repository"},
            "instruments": [{
                "instrument_id": self.instrument,
                "bars": bars,
                "corporate_actions": self.actions,
                "unplanned_events": self.halts,
            }],
            "calendar": {"sessions": sessions},
            "windows": {"warmup_start": date(0), "scored_start": date(self.scored_start), "scored_end": date(self.last), "information_cutoff": self.information_cutoff},
            "initial_capital": self.capital,
            "policy": {
                "id": "daily-long-only-cash@1",
                "currency": "USD",
                "price_scale": p.price_scale,
                "quantity_scale": p.quantity_scale,
                "money_scale": p.money_scale,
                "diagnostic_scale": 4,
                "lot_size": p.lot,
                "cost_model": {
                    "id": "fixed_plus_bps@1",
                    "fixed_fee_per_fill": p.fixed_fee,
                    "fee_bps": p.fee_bps,
                    "gap_exit_slippage_bps": p.slippage_bps,
                },
                "corporate_actions": {
                    "id": "split_cash_dividend_ex_date@1",
                    "fractional": "INSUFFICIENT",
                    "withholding_bps": p.withholding_bps,
                },
            },
        })
    }

    pub fn input(&self) -> EvaluationInput {
        parse_value(self.input_value()).expect("the test input is valid")
    }

    pub fn run(&self) -> Run {
        Run::prepare(&self.strategy_artefact(), &self.input()).expect("the scenario prepares")
    }

    /// Evaluate to the end (or to the first failure).
    pub fn evaluate(&self) -> Outcome {
        let run = self.run();
        let (state, failure) = run.run_to_end(run.initial_state().unwrap());
        let result = run.result(&state, failure.as_ref()).unwrap();
        let value = to_value(&result).unwrap();
        Outcome {
            run,
            state,
            failure,
            result,
            value,
        }
    }
}

/// A finished (or failed) evaluation.
pub struct Outcome {
    pub run: Run,
    pub state: State,
    pub failure: Option<Failure>,
    pub result: EvaluationResult,
    pub value: Value,
}

impl Outcome {
    /// A value inside the result, by JSON pointer.
    pub fn at(&self, pointer: &str) -> &Value {
        self.value
            .pointer(pointer)
            .unwrap_or_else(|| panic!("no value at {pointer}"))
    }

    /// A string inside the result, by JSON pointer.
    pub fn text(&self, pointer: &str) -> &str {
        self.at(pointer)
            .as_str()
            .unwrap_or_else(|| panic!("{pointer} is not a string: {}", self.at(pointer)))
    }

    pub fn has(&self, pointer: &str) -> bool {
        self.value.pointer(pointer).is_some()
    }

    pub fn len(&self, pointer: &str) -> usize {
        self.at(pointer).as_array().expect("an array").len()
    }

    pub fn status(&self) -> &str {
        self.text("/outcome/status")
    }

    pub fn code(&self) -> &str {
        self.text("/outcome/code")
    }

    pub fn fills(&self) -> &Vec<Value> {
        self.at("/journal/fills").as_array().unwrap()
    }

    pub fn ledger(&self) -> &Vec<Value> {
        self.at("/journal/cash_ledger").as_array().unwrap()
    }

    pub fn daily(&self) -> &Vec<Value> {
        self.at("/journal/daily").as_array().unwrap()
    }

    pub fn signals(&self) -> &Vec<Value> {
        self.at("/journal/signals").as_array().unwrap()
    }

    pub fn entries(&self) -> &Vec<Value> {
        self.at("/journal/entries").as_array().unwrap()
    }

    pub fn trades(&self) -> &Vec<Value> {
        self.at("/journal/trades").as_array().unwrap()
    }

    /// The daily record of session `index`.
    pub fn daily_of(&self, index: usize) -> &Value {
        let wanted = date(index);
        self.daily()
            .iter()
            .find(|d| d["session"] == wanted.as_str())
            .unwrap_or_else(|| panic!("no daily record for {wanted}"))
    }

    /// The signal record of session `index`.
    pub fn signal_of(&self, index: usize) -> &Value {
        let wanted = date(index);
        self.signals()
            .iter()
            .find(|s| s["session"] == wanted.as_str())
            .unwrap_or_else(|| panic!("no signal record for {wanted}"))
    }

    /// Canonical result text: byte-identical for identical results.
    pub fn text_of_result(&self) -> String {
        canonical_json(&self.value).unwrap()
    }
}

/// Compare a decimal string with an expected decimal by value.
pub fn assert_dec(actual: &Value, expected: &str) {
    let actual = actual
        .as_str()
        .unwrap_or_else(|| panic!("{actual} is not a decimal string"));
    let a = openquant_contracts::decimal::parse(actual, 28).unwrap();
    let e = openquant_contracts::decimal::parse(expected, 28).unwrap();
    assert_eq!(a, e, "expected {expected}, found {actual}");
}

/// Compact description of a fill for readable assertions:
/// `session phase side quantity@price fee=… delta=… reason`.
pub fn fill_row(fill: &Value) -> String {
    format!(
        "{} {} {} {}@{} fee={} delta={} {}",
        fill["session"].as_str().unwrap(),
        fill["phase"].as_str().unwrap(),
        fill["side"].as_str().unwrap(),
        fill["quantity"].as_str().unwrap(),
        fill["price"].as_str().unwrap(),
        fill["fee"].as_str().unwrap(),
        fill["cash_delta"].as_str().unwrap(),
        fill["reason"].as_str().unwrap(),
    )
}

/// Compact description of a ledger line:
/// `session phase kind amount avail=… reserved=… receivable=…`.
pub fn ledger_row(line: &Value) -> String {
    format!(
        "{} {} {} {} avail={} reserved={} recv={}",
        line["session"].as_str().unwrap(),
        line["phase"].as_str().unwrap(),
        line["kind"].as_str().unwrap(),
        line["amount"].as_str().unwrap(),
        line["available_after"].as_str().unwrap(),
        line["reserved_after"].as_str().unwrap(),
        line["receivables_after"].as_str().unwrap(),
    )
}

/// Serialise a checkpoint, validate it against the shared schema and parse it back.
pub fn round_trip(run: &Run, state: &State) -> (String, Checkpoint) {
    let checkpoint = run.checkpoint(state).unwrap();
    let text = canonical_json(&to_value(&checkpoint).unwrap()).unwrap();
    let parsed: Checkpoint = parse(&text).unwrap();
    (text, parsed)
}

/// Run every event up to `cut` from the initial state.
pub fn state_after(run: &Run, cut: usize) -> State {
    let events = run.events().unwrap();
    let (state, failure) = run.run_events(run.initial_state().unwrap(), &events[..cut]);
    assert!(
        failure.is_none(),
        "the prefix of {cut} events must not fail"
    );
    state
}

/// Index in `run.events()` of the first event of session `index` at `phase`.
pub fn event_index(run: &Run, index: usize, phase: &str) -> usize {
    let wanted = date(index);
    run.events()
        .unwrap()
        .iter()
        .position(|e| e.cursor.session == wanted && e.cursor.phase.to_string() == phase)
        .unwrap_or_else(|| panic!("no event {wanted} {phase}"))
}

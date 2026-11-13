//! Property tests over random price paths and random action placements.
//!
//! The generators use a fixed seed and no failure-persistence file, so every run is the same
//! run. The checks are invariants of the accounting, not a second implementation of the engine:
//! the ledger is replayed from the starting capital line by line, fees and lot sizes are
//! re-derived from the policy numbers, and restore, determinism and causality are compared
//! across independent runs.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

mod execution_support;

use std::str::FromStr;

use execution_support::*;
use openquant_contracts::{EvaluationResult, canonical_json, parse, to_value};
use openquant_core::{Run, State};
use proptest::{
    prelude::*,
    test_runner::{Config, RngAlgorithm, RngSeed},
};
use rust_decimal::{Decimal, RoundingStrategy};
use serde_json::Value;

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

// ---------------------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------------------

#[derive(Clone, Debug)]
struct BarGen {
    gap: i64,
    up: i64,
    down: i64,
    frac: i64,
    signal: bool,
}

#[derive(Clone, Debug)]
struct Spec {
    start: i64,
    bars: Vec<BarGen>,
    capital: usize,
    slots: u64,
    fixed_fee: usize,
    fee_bps: usize,
    slippage: usize,
    lot: usize,
    withholding: usize,
    break_even: bool,
    multiples: usize,
    splits: Vec<(usize, usize)>,
    dividends: Vec<(usize, usize, usize, usize)>,
    halt: Option<usize>,
    missing: Option<usize>,
    unsupported: Option<usize>,
}

const CAPITALS: [&str; 4] = ["1000.00", "5000.00", "12345.67", "250000.00"];
const FIXED_FEES: [&str; 4] = ["0.00", "0.50", "1.00", "2.37"];
const FEE_BPS: [&str; 5] = ["0", "5", "10", "25", "33.5"];
const SLIPPAGE: [&str; 3] = ["0", "10", "33"];
const LOTS: [&str; 4] = ["1", "5", "10", "100"];
const WITHHOLDING: [&str; 3] = ["0", "1500", "3000"];
const MULTIPLES: [(&str, &str); 3] = [("2", "5"), ("1.5", "3"), ("2.5", "4")];
const RATIOS: [(u64, u64); 6] = [(2, 1), (3, 1), (3, 2), (1, 2), (5, 4), (4, 1)];
const AMOUNTS: [&str; 3] = ["0.05", "0.50", "1.00"];
const PHASES: [&str; 4] = ["BEFORE_OPEN", "OPEN", "DURING_SESSION", "AFTER_CLOSE"];

fn bar_gen() -> impl Strategy<Value = BarGen> {
    (
        -300i64..=300,
        20i64..=300,
        20i64..=300,
        0i64..=100,
        any::<bool>(),
    )
        .prop_map(|(gap, up, down, frac, signal)| BarGen {
            gap,
            up,
            down,
            frac,
            signal,
        })
}

fn spec_strategy(min_sessions: usize, max_sessions: usize) -> impl Strategy<Value = Spec> {
    (
        500i64..=50_000,
        prop::collection::vec(bar_gen(), min_sessions..=max_sessions),
        (0usize..CAPITALS.len(), 1u64..=5),
        (
            0usize..FIXED_FEES.len(),
            0usize..FEE_BPS.len(),
            0usize..SLIPPAGE.len(),
            0usize..LOTS.len(),
            0usize..WITHHOLDING.len(),
        ),
        (any::<bool>(), 0usize..MULTIPLES.len()),
        prop::collection::vec((2usize..1000, 0usize..RATIOS.len()), 0..=2),
        prop::collection::vec(
            (2usize..1000, 0usize..AMOUNTS.len(), 0usize..4, 0usize..4),
            0..=2,
        ),
        (
            prop::option::weighted(0.25, 1usize..1000),
            prop::option::weighted(0.1, 1usize..1000),
            prop::option::weighted(0.1, 2usize..1000),
        ),
    )
        .prop_map(
            |(
                start,
                bars,
                (capital, slots),
                (fixed_fee, fee_bps, slippage, lot, withholding),
                (break_even, multiples),
                splits,
                dividends,
                (halt, missing, unsupported),
            )| Spec {
                start,
                bars,
                capital,
                slots,
                fixed_fee,
                fee_bps,
                slippage,
                lot,
                withholding,
                break_even,
                multiples,
                splits,
                dividends,
                halt,
                missing,
                unsupported,
            },
        )
}

fn cents(value: i64) -> String {
    format!("{}.{:02}", value / 100, value % 100)
}

/// Build the scenario from a spec. Sessions index into the bars; a split scales every later
/// price by `old / new` (floored, at least one cent) so the path stays on one basis.
fn build(spec: &Spec) -> Scenario {
    let n = spec.bars.len();
    let mut previous_close = spec.start;
    let mut raw: Vec<(i64, i64, i64, i64, bool)> = Vec::with_capacity(n);
    for bar in &spec.bars {
        let open = (previous_close + previous_close * bar.gap / 10_000).max(1);
        let high = open + (open * bar.up / 10_000).max(1);
        let low = (open - (open * bar.down / 10_000).max(1)).max(1);
        let high = high.max(low + 1);
        let close = low + (high - low) * bar.frac / 100;
        raw.push((open, high, low, close, bar.signal));
        previous_close = close;
    }
    // Scale the path after each split.
    let splits: Vec<(usize, (u64, u64))> = spec
        .splits
        .iter()
        .map(|(session, ratio)| (1 + session % (n - 1), RATIOS[*ratio]))
        .collect();
    let mut bars = Vec::with_capacity(n);
    for (index, (open, high, low, close, signal)) in raw.into_iter().enumerate() {
        let (mut num, mut den) = (1i64, 1i64);
        for (session, (new, old)) in &splits {
            if index >= *session {
                num *= *old as i64;
                den *= *new as i64;
            }
        }
        let scale = |value: i64| (value * num / den).max(1);
        let (o, h, l, c) = (scale(open), scale(high), scale(low), scale(close));
        let volume = if signal { SIGNAL_VOLUME } else { QUIET_VOLUME };
        bars.push(bar(&cents(o), &cents(h), &cents(l), &cents(c), volume));
    }
    let mut scenario = Scenario::new(bars)
        .capital(CAPITALS[spec.capital])
        .fees(FIXED_FEES[spec.fixed_fee], FEE_BPS[spec.fee_bps])
        .slippage(SLIPPAGE[spec.slippage])
        .lot(LOTS[spec.lot])
        .withholding(WITHHOLDING[spec.withholding])
        .break_even(spec.break_even)
        .multiples(MULTIPLES[spec.multiples].0, MULTIPLES[spec.multiples].1);
    scenario.strategy.slots = spec.slots;
    for (i, (session, ratio)) in spec.splits.iter().enumerate() {
        let (new, old) = RATIOS[*ratio];
        scenario = scenario.split(&format!("SPLIT{i}"), 1 + session % (n - 1), new, old);
    }
    for (i, (session, amount, offset, phase)) in spec.dividends.iter().enumerate() {
        let ex = 1 + session % (n - 1);
        let payment = (ex + offset).min(n - 1);
        scenario = scenario.dividend(
            &format!("DIV{i}"),
            ex,
            AMOUNTS[*amount],
            payment,
            PHASES[*phase],
        );
    }
    if let Some(index) = spec.unsupported {
        scenario = scenario.unsupported("ODD0", "SPIN_OFF", 1 + index % (n - 1));
    }
    if let Some(index) = spec.missing {
        scenario = scenario.without_bar(1 + index % (n - 1));
    }
    if let Some(index) = spec.halt {
        scenario = scenario.halt("HALT0", 1 + index % (n - 1));
    }
    scenario
}

// ---------------------------------------------------------------------------------------
// Independent helpers
// ---------------------------------------------------------------------------------------

fn dec(value: &Value) -> Decimal {
    Decimal::from_str(value.as_str().unwrap()).unwrap()
}

/// `ceil(fixed + notional * bps / 10000)` at the money scale, re-derived from the policy text.
fn oracle_fee(scenario: &Scenario, notional: Decimal) -> Decimal {
    let fixed = Decimal::from_str(&scenario.policy.fixed_fee).unwrap();
    let bps = Decimal::from_str(&scenario.policy.fee_bps).unwrap();
    (fixed + notional * bps / Decimal::from(10_000)).round_dp_with_strategy(
        scenario.policy.money_scale,
        RoundingStrategy::ToPositiveInfinity,
    )
}

/// Replay the cash ledger from the starting capital and compare every line's balances.
/// Returns the final (available, reserved, receivables).
fn replay_ledger(capital: Decimal, ledger: &[Value]) -> (Decimal, Decimal, Decimal) {
    let (mut available, mut reserved, mut receivables) = (capital, Decimal::ZERO, Decimal::ZERO);
    for (i, line) in ledger.iter().enumerate() {
        let amount = dec(&line["amount"]);
        let kind = line["kind"].as_str().unwrap();
        // A sale whose fee exceeds its value is the only signed amount.
        assert!(
            amount > Decimal::ZERO || kind == "FILL_SELL",
            "line {i}: amounts are positive"
        );
        match kind {
            "RESERVE" => {
                available -= amount;
                reserved += amount;
            }
            "RELEASE" => {
                available += amount;
                reserved -= amount;
            }
            "FILL_BUY" => available -= amount,
            "FILL_SELL" => available += amount,
            "DIVIDEND_RECEIVABLE" => receivables += amount,
            "DIVIDEND_PAYMENT" => {
                available += amount;
                receivables -= amount;
            }
            other => panic!("unknown ledger kind {other}"),
        }
        assert_eq!(
            dec(&line["available_after"]),
            available,
            "line {i} available"
        );
        assert_eq!(dec(&line["reserved_after"]), reserved, "line {i} reserved");
        assert_eq!(
            dec(&line["receivables_after"]),
            receivables,
            "line {i} receivables"
        );
        assert!(
            available >= Decimal::ZERO && reserved >= Decimal::ZERO && receivables >= Decimal::ZERO,
            "line {i}: balances never go negative"
        );
    }
    (available, reserved, receivables)
}

/// Checks that hold at every event boundary of a run.
fn check_state(run: &Run, state: &State, scenario: &Scenario) {
    assert!(state.cash_available >= Decimal::ZERO, "cash never negative");
    assert!(state.cash_reserved >= Decimal::ZERO);
    let caps: Decimal = state.pending.iter().map(|p| p.cap).sum();
    assert_eq!(
        state.cash_reserved, caps,
        "reserved cash is the sum of the pending caps"
    );
    for pending in &state.pending {
        assert!(pending.cap > Decimal::ZERO);
    }
    for position in &state.positions {
        assert!(position.quantity > Decimal::ZERO, "quantities are positive");
        assert!(position.stop > Decimal::ZERO && position.stop < position.target);
        assert!(position.mark > Decimal::ZERO);
    }
    // One instrument: a slot is held by a position or a pending entry, never both.
    assert!(state.positions.len() + state.pending.len() <= 1);
    assert!(state.positions.len() + state.pending.len() <= scenario.strategy.slots as usize);
    let journal = &state.journal;
    assert_eq!(
        journal.next_seq as usize,
        journal.fills.len() + journal.cash_ledger.len()
    );
    // Every applied identity belongs to the input.
    for id in &state.applied {
        assert!(run.input.actions.iter().any(|a| &a.id == id));
    }
    for receivable in &state.receivables {
        assert!(receivable.amount > Decimal::ZERO);
    }
}

const ALLOWED_CODES: [&str; 6] = [
    "INVALID_LEVEL",
    "UNSUPPORTED_POLICY",
    "FRACTIONAL_ENTITLEMENT",
    "UNSUPPORTED_CORPORATE_ACTION",
    "MISSING_REQUIRED_BAR",
    "UNSUPPORTED_VALUATION",
];

fn check_result(scenario: &Scenario, out: &Outcome) {
    let capital = Decimal::from_str(&scenario.capital).unwrap();
    if out.status() != "COMPLETED" {
        assert!(
            ALLOWED_CODES.contains(&out.code()),
            "unexpected failure {}: {}",
            out.code(),
            out.text("/outcome/detail")
        );
        assert!(out.has("/outcome/at/session"), "a failure names its event");
    }

    // Ledger replay from the capital, line by line.
    let (available, reserved, receivables) = replay_ledger(capital, out.ledger());
    assert_eq!(dec(out.at("/final/cash_available")), available);
    assert_eq!(dec(out.at("/final/cash_reserved")), reserved);
    assert_eq!(dec(out.at("/final/receivables")), receivables);

    // Fills agree with the ledger, fees and lots agree with the policy.
    let lot = Decimal::from_str(&scenario.policy.lot).unwrap();
    let fill_lines: Vec<(bool, Decimal)> = out
        .ledger()
        .iter()
        .filter_map(|l| match l["kind"].as_str().unwrap() {
            "FILL_BUY" => Some((true, dec(&l["amount"]))),
            "FILL_SELL" => Some((false, dec(&l["amount"]))),
            _ => None,
        })
        .collect();
    assert_eq!(fill_lines.len(), out.fills().len());
    let mut cash_from_fills = Decimal::ZERO;
    for (fill, (is_buy, amount)) in out.fills().iter().zip(&fill_lines) {
        let quantity = dec(&fill["quantity"]);
        let price = dec(&fill["price"]);
        let notional = dec(&fill["notional"]);
        let fee = dec(&fill["fee"]);
        let delta = dec(&fill["cash_delta"]);
        assert!(quantity > Decimal::ZERO && price > Decimal::ZERO);
        assert_eq!(notional, quantity * price);
        assert_eq!(
            fee,
            oracle_fee(scenario, notional),
            "fee is ceil(fixed + bps)"
        );
        if *is_buy {
            assert_eq!(fill["side"], "BUY");
            assert_eq!(delta, -(notional + fee));
            assert_eq!(*amount, notional + fee);
            // Lot, cap and maximality, from the entry record of the intent.
            let intent = fill["intent_id"].as_str().unwrap();
            let entry = out
                .entries()
                .iter()
                .find(|e| e["intent_id"] == intent)
                .unwrap();
            let cap = dec(&entry["cap"]);
            assert!(
                notional + fee <= cap,
                "a fill never spends more than its cap"
            );
            // Lots are counted on the as-filled basis: the quantity is a lot multiple.
            assert_eq!((quantity / lot).fract(), Decimal::ZERO, "whole lots");
            let next = quantity + lot;
            let next_notional = next * price;
            assert!(
                next_notional + oracle_fee(scenario, next_notional) > cap,
                "one more lot would not fit the cap"
            );
        } else {
            assert_eq!(fill["side"], "SELL");
            assert_eq!(delta, notional - fee);
            assert_eq!(*amount, notional - fee);
        }
        cash_from_fills += delta;
    }

    // Per-day equity identity, and the final equity from fills and payments.
    for day in out.daily() {
        assert_eq!(
            dec(&day["equity"]),
            dec(&day["cash_available"])
                + dec(&day["cash_reserved"])
                + dec(&day["receivables"])
                + dec(&day["positions_value"])
        );
    }
    let payments: Decimal = out
        .ledger()
        .iter()
        .filter(|l| l["kind"] == "DIVIDEND_PAYMENT")
        .map(|l| dec(&l["amount"]))
        .sum();
    assert_eq!(
        dec(out.at("/final/equity")),
        capital
            + cash_from_fills
            + payments
            + dec(out.at("/final/receivables"))
            + dec(out.at("/final/positions_value")),
        "equity change is the fills, the payments and the valuation of what is held"
    );

    // Trades: closed trades have an exit, open ones are OPEN_AT_END; open trades are positions.
    let open_trades = out
        .trades()
        .iter()
        .filter(|t| t.get("exit_session").is_none())
        .count();
    assert_eq!(
        open_trades,
        out.at("/final/open_positions").as_array().unwrap().len()
    );
    for trade in out.trades() {
        assert!(dec(&trade["quantity"]) > Decimal::ZERO);
        let closed = trade.get("exit_session").is_some();
        assert_eq!(closed, trade["exit_reason"] != "OPEN_AT_END");
    }

    // The result is valid under the shared result schema.
    let text = out.text_of_result();
    let parsed: EvaluationResult = parse(&text).expect("schema-valid result");
    assert_eq!(canonical_json(&to_value(&parsed).unwrap()).unwrap(), text);
}

// ---------------------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------------------

proptest! {
    #![proptest_config(config(160, 0x0051_0001))]

    #[test]
    fn accounting_invariants_hold_at_every_event(spec in spec_strategy(8, 24)) {
        let scenario = build(&spec);
        let run = scenario.run();
        let events = run.events().unwrap();
        let mut state = run.initial_state().unwrap();
        let mut failure = None;
        for event in &events {
            match run.step(&state, event) {
                Ok(output) => {
                    state = output.state;
                    check_state(&run, &state, &scenario);
                }
                Err(f) => {
                    failure = Some(f);
                    break;
                }
            }
        }
        // The stepped run is the evaluated run.
        let out = scenario.evaluate();
        prop_assert_eq!(
            canonical_json(&to_value(&run.result(&state, failure.as_ref()).unwrap()).unwrap()).unwrap(),
            out.text_of_result()
        );
        check_result(&scenario, &out);
    }
}

proptest! {
    #![proptest_config(config(48, 0x0051_0002))]

    #[test]
    fn every_cut_point_restores_to_the_uninterrupted_result(spec in spec_strategy(8, 14)) {
        let scenario = build(&spec);
        let run = scenario.run();
        let events = run.events().unwrap();
        let (end, failure) = run.run_to_end(run.initial_state().unwrap());
        let expected = canonical_json(&to_value(&run.result(&end, failure.as_ref()).unwrap()).unwrap()).unwrap();
        let completed = match &end.next {
            None => events.len(),
            Some(next) => events.iter().position(|e| &e.cursor == next).unwrap(),
        };
        for cut in 0..=completed {
            let prefix = state_after(&run, cut);
            let (_, checkpoint) = round_trip(&run, &prefix);
            let restored = run.restore(&checkpoint).unwrap();
            let (state, again) = run.run_events(restored, &events[cut..]);
            let text = canonical_json(&to_value(&run.result(&state, again.as_ref()).unwrap()).unwrap()).unwrap();
            prop_assert_eq!(&text, &expected, "cut {}", cut);
        }
    }
}

proptest! {
    #![proptest_config(config(80, 0x0051_0003))]

    #[test]
    fn evaluation_is_deterministic(spec in spec_strategy(6, 20)) {
        let scenario = build(&spec);
        let first = scenario.evaluate().text_of_result();
        let second = scenario.evaluate().text_of_result();
        prop_assert_eq!(first, second);
    }
}

proptest! {
    #![proptest_config(config(60, 0x0051_0004))]

    /// Changing every bar after session `t + 1` leaves the signals through `t`, and the daily
    /// records, fills and ledger lines through `t + 1`, unchanged: no decision looks ahead.
    #[test]
    fn later_bars_never_change_earlier_records(
        spec in spec_strategy(10, 18),
        other in spec_strategy(10, 18),
        cut in 2usize..8,
    ) {
        let original = build(&spec);
        let n = original.bars.len();
        let cut = cut.min(n - 3);
        let replacement = build(&other);
        let mut changed = original.clone();
        for index in (cut + 2)..n {
            // Only bars present in both scenarios and not halted are replaced; the rest stay.
            if let (Some(_), Some(new)) = (&changed.bars[index], replacement.bars.get(index).cloned().flatten()) {
                changed.bars[index] = Some(new);
            }
        }
        let a = original.evaluate();
        let b = changed.evaluate();
        let through = |value: &Value, key: &str, limit: usize| -> Vec<Value> {
            value
                .as_array()
                .unwrap()
                .iter()
                .filter(|r| r[key].as_str().unwrap() <= date(limit).as_str())
                .cloned()
                .collect()
        };
        prop_assert_eq!(
            through(a.at("/journal/signals"), "session", cut),
            through(b.at("/journal/signals"), "session", cut)
        );
        for section in ["daily", "fills", "cash_ledger"] {
            let pointer = format!("/journal/{section}");
            prop_assert_eq!(
                through(a.at(&pointer), "session", cut + 1),
                through(b.at(&pointer), "session", cut + 1),
                "{} through session {}", section, cut + 1
            );
        }
    }
}

// ---------------------------------------------------------------------------------------
// Extreme values
// ---------------------------------------------------------------------------------------

#[derive(Clone, Debug)]
struct Extreme {
    price_scale: u32,
    quantity_scale: u32,
    extra_money_scale: u32,
    prices: Vec<(u64, u64, u64, u64)>,
    capital_digits: u32,
    lot_units: u64,
    fixed_fee_units: u64,
    fee_bps: u32,
    slippage_bps: u32,
    split: Option<(usize, usize)>,
    dividend: Option<(usize, u32)>,
}

fn extreme() -> impl Strategy<Value = Extreme> {
    (
        0u32..=8,
        0u32..=4,
        0u32..=4,
        prop::collection::vec(
            (
                1u64..=1_000_000_000_000_000,
                0u64..=40,
                0u64..=40,
                0u64..=100,
            ),
            6..=10,
        ),
        1u32..=15,
        1u64..=1000,
        0u64..=100_000,
        0u32..=5000,
        0u32..=5000,
        prop::option::of((2usize..9, 0usize..RATIOS.len())),
        prop::option::of((2usize..9, 0u32..1_000_000)),
    )
        .prop_map(
            |(
                price_scale,
                quantity_scale,
                extra_money_scale,
                prices,
                capital_digits,
                lot_units,
                fixed_fee_units,
                fee_bps,
                slippage_bps,
                split,
                dividend,
            )| Extreme {
                price_scale,
                quantity_scale,
                extra_money_scale,
                prices,
                capital_digits,
                lot_units,
                fixed_fee_units,
                fee_bps,
                slippage_bps,
                split,
                dividend,
            },
        )
}

/// A decimal string for `units * 10^-scale`, with no exponent and no trailing-zero surprises.
fn units(value: u64, scale: u32) -> String {
    if scale == 0 {
        return value.to_string();
    }
    let divisor = 10u64.pow(scale);
    format!(
        "{}.{:0width$}",
        value / divisor,
        value % divisor,
        width = scale as usize
    )
}

fn build_extreme(x: &Extreme) -> Scenario {
    let max_units = |scale: u32| 1_000_000_000u64.saturating_mul(10u64.pow(scale));
    let n = x.prices.len();
    let mut bars = Vec::new();
    let mut previous = 1u64;
    for (i, (base, up, down, frac)) in x.prices.iter().enumerate() {
        let cap = max_units(x.price_scale).max(1);
        let open = (base % cap).max(1);
        let high = (open + open.saturating_mul(*up) / 100).min(cap).max(open);
        let low = (open - open.saturating_mul(*down) / 100).max(1).min(open);
        let close = low + (high - low) * frac / 100;
        let _ = previous;
        previous = close;
        let signal = i % 2 == 1;
        bars.push(bar(
            &units(open, x.price_scale),
            &units(high, x.price_scale),
            &units(low, x.price_scale),
            &units(close, x.price_scale),
            if signal { SIGNAL_VOLUME } else { QUIET_VOLUME },
        ));
    }
    let mut scenario = Scenario::new(bars);
    scenario.policy.price_scale = x.price_scale;
    scenario.policy.quantity_scale = x.quantity_scale;
    let money_scale = (x.price_scale + x.quantity_scale + x.extra_money_scale).min(12);
    scenario.policy.money_scale = money_scale.max(x.price_scale + x.quantity_scale);
    scenario.policy.lot = units(x.lot_units, x.quantity_scale);
    scenario.policy.fixed_fee = units(x.fixed_fee_units, scenario.policy.money_scale.min(6));
    scenario.policy.fee_bps = x.fee_bps.to_string();
    scenario.policy.slippage_bps = x.slippage_bps.to_string();
    scenario.capital = format!("{}{}", 1, "0".repeat(x.capital_digits as usize - 1))
        + &if scenario.policy.money_scale == 0 {
            String::new()
        } else {
            format!(".{}", "0".repeat(scenario.policy.money_scale as usize))
        };
    if let Some((session, ratio)) = x.split {
        let (new, old) = RATIOS[ratio];
        scenario = scenario.split("SPLIT0", session.min(n - 1), new, old);
    }
    if let Some((session, amount)) = x.dividend {
        let ex = session.min(n - 1);
        scenario = scenario.dividend(
            "DIV0",
            ex,
            &units(u64::from(amount), 6),
            (ex + 1).min(n - 1),
            "OPEN",
        );
    }
    scenario
}

proptest! {
    #![proptest_config(config(250, 0x0051_0005))]

    /// Any valid input, including prices up to 1e9, scales up to 8 and capital up to 1e15,
    /// produces a result: a completed run or a typed failure. Nothing panics, and the result is
    /// valid under the shared schema.
    #[test]
    fn extreme_prices_and_scales_never_panic(x in extreme()) {
        let scenario = build_extreme(&x);
        let strategy = scenario.strategy_artefact();
        let input = scenario.input();
        prop_assert!(
            Run::prepare(&strategy, &input).is_ok(),
            "the generated input must reach the engine"
        );
        let result = openquant_core::evaluate(&strategy, &input);
        let result = result.expect("a valid input always yields a result");
        let text = canonical_json(&to_value(&result).unwrap()).unwrap();
        let parsed: Result<EvaluationResult, _> = parse(&text);
        prop_assert!(parsed.is_ok(), "{:?}", parsed.err());
        if result.outcome.status != openquant_core::Status::Completed {
            // A failure is explicit and located.
            prop_assert!(result.outcome.code.is_some());
        }
    }
}

// ---------------------------------------------------------------------------------------
// Coverage guard
// ---------------------------------------------------------------------------------------

/// The generators must reach the interesting parts of the engine; otherwise the properties above
/// would pass vacuously. Counts over a fixed sample of generated runs.
#[test]
fn the_generators_reach_every_phase_of_the_engine() {
    use proptest::strategy::ValueTree;
    use proptest::test_runner::TestRunner;

    let mut runner = TestRunner::new(config(1, 0x0051_00ff));
    let strategy = spec_strategy(8, 24);
    let mut counts = std::collections::BTreeMap::<String, usize>::new();
    let samples = 300;
    for _ in 0..samples {
        let spec = strategy.new_tree(&mut runner).unwrap().current();
        let out = build(&spec).evaluate();
        let mut hit = |key: &str| *counts.entry(key.to_owned()).or_default() += 1;
        hit("runs");
        hit(match out.status() {
            "COMPLETED" => "completed",
            "FAILED" => "failed",
            _ => "insufficient",
        });
        if !out.fills().is_empty() {
            hit("with fills");
        }
        for fill in out.fills() {
            match fill["reason"].as_str().unwrap() {
                "ENTRY" => hit("entry fills"),
                "STOP" => hit("stop exits"),
                "TARGET" => hit("target exits"),
                "GAP_STOP" => hit("gap stop exits"),
                "GAP_TARGET" => hit("gap target exits"),
                _ => {}
            }
        }
        if out.fills().iter().any(|f| f.get("ambiguous_bar").is_some()) {
            hit("ambiguous bars");
        }
        for entry in out.entries() {
            match entry["status"].as_str().unwrap() {
                "SKIPPED" => hit("skipped entries"),
                "EXPIRED" => hit("expired entries"),
                _ => {}
            }
        }
        for action in out.at("/journal/corporate_actions").as_array().unwrap() {
            match action["kind"].as_str().unwrap() {
                "SPLIT" => hit("applied splits"),
                _ => hit("applied dividends"),
            }
        }
        if out
            .ledger()
            .iter()
            .any(|l| l["kind"] == "DIVIDEND_RECEIVABLE")
        {
            hit("dividend receivables");
        }
        if out.ledger().iter().any(|l| l["kind"] == "DIVIDEND_PAYMENT") {
            hit("dividend payments");
        }
        let scheduled = out.daily().iter().any(|d| {
            d["positions"]
                .as_array()
                .unwrap()
                .iter()
                .any(|p| p.get("scheduled_stop").is_some())
        });
        if scheduled {
            hit("scheduled stops");
        }
        if out.has("/outcome/code") {
            hit(&format!("code {}", out.code()));
        }
    }
    eprintln!("coverage over {samples} generated runs: {counts:#?}");
    let seen = |key: &str| counts.get(key).copied().unwrap_or(0);
    for (key, minimum) in [
        ("completed", 40),
        ("with fills", 100),
        ("stop exits", 5),
        ("target exits", 5),
        ("gap stop exits", 3),
        ("gap target exits", 1),
        ("ambiguous bars", 1),
        ("skipped entries", 5),
        ("applied splits", 20),
        ("dividend receivables", 20),
        ("dividend payments", 15),
        ("scheduled stops", 10),
        ("expired entries", 1),
    ] {
        assert!(
            seen(key) >= minimum,
            "the generators reached `{key}` only {} times in {samples} runs (need {minimum})",
            seen(key)
        );
    }
}

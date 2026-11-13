//! Every failure path of the shared validator (OQ-02 section 2.2: "validate lookback bounds, data
//! types, units, instrument references, resource limits, and unavailable operators").
//!
//! Each case changes one thing in an otherwise valid definition and states the failure code that
//! the plan's outcome taxonomy assigns. Valid neighbours are checked too, so a rejection cannot
//! come from an unrelated problem.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

mod operators_support;

use openquant_core::model::Unit;
use operators_support::*;
use serde_json::{Value as Json, json};

fn code(def: &Def) -> String {
    def.reject().code.to_string()
}

fn detail(def: &Def) -> String {
    def.reject().detail
}

fn indicator_def(expr: Json) -> Def {
    Def::new().indicator("x", expr)
}

fn unit_of_x(expr: Json) -> Unit {
    indicator_def(expr).validated().indicators[0].node.unit
}

// ---------------------------------------------------------------------------------------------
// Operator ids and compatibility versions
// ---------------------------------------------------------------------------------------------

#[test]
fn an_unknown_operator_is_reported_with_its_json_path_wherever_it_appears() {
    let bad = || op("ema", vec![close()], json!({"window": 5}));
    let cases: Vec<(Def, &str)> = vec![
        (indicator_def(bad()), "/definition/indicators/0/expr"),
        (
            indicator_def(bin("add", close(), bad())),
            "/definition/indicators/0/expr/args/1",
        ),
        (Def::new().condition(bad()), "/definition/entry/condition"),
        (Def::new().rank(bad()), "/definition/entry/rank"),
        (
            Def::new().snapshot("s", bad()),
            "/definition/entry/snapshots/0/expr",
        ),
        (Def::new().stop(bad()), "/definition/exits/stop"),
        (Def::new().target(bad()), "/definition/exits/target"),
        (
            Def::new().adjustment("a", bad(), entry_price()),
            "/definition/exits/stop_adjustments/0/trigger",
        ),
        (
            Def::new().adjustment("a", always(), bad()),
            "/definition/exits/stop_adjustments/0/new_level",
        ),
    ];
    for (def, path) in cases {
        let failure = def.reject();
        assert_eq!(failure.code.to_string(), "UNSUPPORTED_OPERATOR", "{path}");
        assert!(
            failure.detail.starts_with(path),
            "{path}: {}",
            failure.detail
        );
    }
}

// ---------------------------------------------------------------------------------------------
// Types and units
// ---------------------------------------------------------------------------------------------

#[test]
fn flags_cannot_be_used_as_numbers_and_numbers_cannot_be_used_as_flags() {
    let flag = || always();
    let cases: Vec<(&str, Json)> = vec![
        ("add flags", bin("add", flag(), flag())),
        ("sub flag", bin("sub", close(), flag())),
        ("mul flag", bin("mul", flag(), cst("2", "RATIO"))),
        ("div flag", bin("div", flag(), flag())),
        ("gt flags", bin("gt", flag(), flag())),
        ("lte flag and number", bin("lte", close(), flag())),
        ("and numbers", and(vec![close(), close()])),
        ("or number and flag", or(vec![flag(), close()])),
        ("lag of flag", lag(flag(), 1)),
        ("sma of flag", sma(flag(), 3)),
        ("rsi of flag", rsi(flag(), 3)),
    ];
    for (name, expr) in cases {
        assert_eq!(
            code(&indicator_def(expr)),
            "OPERATOR_TYPE_MISMATCH",
            "{name}"
        );
    }
}

#[test]
fn the_condition_must_be_a_flag_the_rank_numeric_and_snapshots_numeric() {
    assert_eq!(
        code(&Def::new().condition(close())),
        "OPERATOR_TYPE_MISMATCH"
    );
    assert_eq!(
        code(&Def::new().condition(cst("1", "POINTS"))),
        "OPERATOR_TYPE_MISMATCH"
    );
    assert!(detail(&Def::new().condition(close())).starts_with("/definition/entry/condition"));
    assert_eq!(code(&Def::new().rank(always())), "OPERATOR_TYPE_MISMATCH");
    assert!(detail(&Def::new().rank(always())).starts_with("/definition/entry/rank"));
    assert_eq!(
        code(&Def::new().snapshot("s", always())),
        "OPERATOR_TYPE_MISMATCH"
    );
    // Any numeric unit is a valid rank; any flag is a valid condition.
    for unit in ["PRICE", "SHARES", "RATIO", "POINTS"] {
        Def::new().rank(cst("1", unit)).validated();
    }
    Def::new()
        .condition(and(vec![always(), always()]))
        .validated();
}

#[test]
fn units_must_agree_for_sums_comparisons_products_and_quotients() {
    let price = close;
    let shares = volume;
    let points = || cst("5", "POINTS");
    let ratio = || cst("2", "RATIO");
    let cases: Vec<(&str, Json)> = vec![
        ("price + shares", bin("add", price(), shares())),
        ("price - points", bin("sub", price(), points())),
        ("points + ratio", bin("add", points(), ratio())),
        ("price > shares", bin("gt", price(), shares())),
        ("points <= price", bin("lte", points(), price())),
        ("price < ratio", bin("lt", price(), ratio())),
        ("price * price", bin("mul", price(), price())),
        ("price * shares", bin("mul", price(), shares())),
        ("points * price", bin("mul", points(), price())),
        ("price / shares", bin("div", price(), shares())),
        ("shares / price", bin("div", shares(), price())),
        ("points / price", bin("div", points(), price())),
        ("ratio / price", bin("div", ratio(), price())),
        // RSI is defined on prices only.
        ("rsi of volume", rsi(volume(), 14)),
        ("rsi of points", rsi(points(), 14)),
        ("rsi of ratio", rsi(ratio(), 14)),
        ("rsi of rsi", rsi(rsi(close(), 14), 14)),
    ];
    for (name, expr) in cases {
        let def = indicator_def(expr);
        assert_eq!(code(&def), "OPERATOR_UNIT_MISMATCH", "{name}");
        assert!(
            detail(&def).starts_with("/definition/indicators/0/expr"),
            "{name}"
        );
    }
}

#[test]
fn valid_unit_combinations_have_the_documented_result_units() {
    let price = close;
    let shares = volume;
    let points = || cst("5", "POINTS");
    let ratio = || cst("2", "RATIO");
    let cases: Vec<(&str, Json, Unit)> = vec![
        ("price + price", bin("add", price(), price()), Unit::Price),
        (
            "shares - shares",
            bin("sub", shares(), shares()),
            Unit::Shares,
        ),
        (
            "points + points",
            bin("add", points(), points()),
            Unit::Points,
        ),
        ("price * ratio", bin("mul", price(), ratio()), Unit::Price),
        ("ratio * price", bin("mul", ratio(), price()), Unit::Price),
        ("ratio * ratio", bin("mul", ratio(), ratio()), Unit::Ratio),
        (
            "points * ratio",
            bin("mul", points(), ratio()),
            Unit::Points,
        ),
        ("price / price", bin("div", price(), price()), Unit::Ratio),
        (
            "shares / shares",
            bin("div", shares(), shares()),
            Unit::Ratio,
        ),
        ("price / ratio", bin("div", price(), ratio()), Unit::Price),
        ("ratio / ratio", bin("div", ratio(), ratio()), Unit::Ratio),
        ("price > price", bin("gt", price(), price()), Unit::Flag),
        (
            "points <= points",
            bin("lte", points(), points()),
            Unit::Flag,
        ),
        ("rsi", rsi(price(), 14), Unit::Points),
        ("atr", atr(14), Unit::Price),
        ("sma of shares", sma(shares(), 5), Unit::Shares),
        ("lag of points", lag(rsi(price(), 14), 2), Unit::Points),
        ("and", and(vec![always(), always()]), Unit::Flag),
        ("bar volume", volume(), Unit::Shares),
        ("bar open", field("OPEN"), Unit::Price),
    ];
    for (name, expr, unit) in cases {
        assert_eq!(unit_of_x(expr), unit, "{name}");
    }
}

#[test]
fn levels_and_new_stop_levels_must_be_prices() {
    // A flag is the wrong type, any other unit the wrong unit.
    assert_eq!(code(&Def::new().stop(always())), "OPERATOR_TYPE_MISMATCH");
    assert_eq!(code(&Def::new().target(always())), "OPERATOR_TYPE_MISMATCH");
    for unit in ["RATIO", "POINTS", "SHARES"] {
        let level = cst("1", unit);
        assert_eq!(
            code(&Def::new().stop(level.clone())),
            "OPERATOR_UNIT_MISMATCH",
            "{unit}"
        );
        assert_eq!(
            code(&Def::new().target(level.clone())),
            "OPERATOR_UNIT_MISMATCH",
            "{unit}"
        );
        assert_eq!(
            code(&Def::new().adjustment("a", always(), level)),
            "OPERATOR_UNIT_MISMATCH",
            "{unit}"
        );
    }
    assert_eq!(
        code(&Def::new().adjustment("a", always(), always())),
        "OPERATOR_TYPE_MISMATCH"
    );
    // Prices pass: the seed forms and a constant.
    Def::new()
        .stop(cst("1", "PRICE"))
        .target(bin("mul", entry_price(), cst("2", "RATIO")))
        .validated();
    // A snapshot of the wrong unit cannot form a price level.
    let def = Def::new().snapshot("points", cst("3", "POINTS")).stop(bin(
        "sub",
        entry_price(),
        snap("points"),
    ));
    assert_eq!(code(&def), "OPERATOR_UNIT_MISMATCH");
}

#[test]
fn a_trigger_must_be_a_flag() {
    let def = Def::new().adjustment("a", entry_price(), entry_price());
    assert_eq!(code(&def), "OPERATOR_TYPE_MISMATCH");
    assert!(detail(&def).starts_with("/definition/exits/stop_adjustments/0/trigger"));
}

// ---------------------------------------------------------------------------------------------
// Scopes
// ---------------------------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Place {
    Signal,
    Level,
    Trigger,
}

/// Put `expr` where a given scope compiles it. Names `a` (indicator) and `s` (snapshot) exist.
fn place(scope: Place, expr: Json) -> Def {
    match scope {
        Place::Signal => Def::new()
            .indicator("a", close())
            .snapshot("s", close())
            .indicator("x", expr),
        Place::Level => Def::new().snapshot("s", close()).stop(expr),
        Place::Trigger => Def::new()
            .snapshot("s", close())
            .adjustment("t", expr, entry_price()),
    }
}

/// A valid use of the named operator whose children are legal in `scope`.
fn template(name: &str, scope: Place) -> Json {
    let leaf = || {
        if scope == Place::Level {
            entry_price()
        } else {
            close()
        }
    };
    match name {
        "const" => cst("1", "PRICE"),
        "bar_field" => close(),
        "ref" => rf("a"),
        "lag" => lag(leaf(), 1),
        "sma" => sma(leaf(), 2),
        "rsi_simple" => rsi(leaf(), 2),
        "atr_simple" => atr(2),
        "add" | "sub" | "gt" | "gte" | "lt" | "lte" | "div" => bin(name, leaf(), leaf()),
        "mul" => bin("mul", leaf(), cst("2", "RATIO")),
        "and" | "or" => op(name, vec![always(), always()], json!({})),
        "entry_price" => entry_price(),
        "snapshot" => snap("s"),
        other => panic!("no template for {other}"),
    }
}

#[test]
fn every_operator_is_allowed_only_in_its_declared_scopes() {
    // (operator, allowed in Signal, Level, Trigger) written from the plan, not from the catalogue.
    let table: [(&str, [bool; 3]); 19] = [
        ("const", [true, true, true]),
        ("bar_field", [true, false, true]),
        ("ref", [true, false, false]),
        ("lag", [true, false, false]),
        ("sma", [true, false, false]),
        ("rsi_simple", [true, false, false]),
        ("atr_simple", [true, false, false]),
        ("add", [true, true, true]),
        ("sub", [true, true, true]),
        ("mul", [true, true, true]),
        ("div", [true, true, true]),
        ("gt", [true, true, true]),
        ("gte", [true, true, true]),
        ("lt", [true, true, true]),
        ("lte", [true, true, true]),
        ("and", [true, true, true]),
        ("or", [true, true, true]),
        ("entry_price", [false, true, true]),
        ("snapshot", [false, true, true]),
    ];
    for (name, allowed) in table {
        for (scope, allowed) in [Place::Signal, Place::Level, Place::Trigger]
            .into_iter()
            .zip(allowed)
        {
            let result = place(scope, template(name, scope)).validate();
            let scope_error = match &result {
                Err(failure) => {
                    failure.detail.contains("scope")
                        && failure.code.to_string() == "OPERATOR_TYPE_MISMATCH"
                }
                Ok(_) => false,
            };
            assert_eq!(scope_error, !allowed, "{name} in {scope:?}: {result:?}");
            if allowed && let Err(failure) = &result {
                // The only acceptable failure of a scope-legal template is the level or trigger
                // typing of the whole expression, never an operator problem.
                assert!(
                    failure.detail.contains("a level must be a PRICE")
                        || failure.detail.contains("a trigger must be a FLAG"),
                    "{name} in {scope:?}: {failure}"
                );
            }
        }
    }
}

#[test]
fn position_expressions_can_read_only_what_the_position_holds() {
    // Entry price and a defined snapshot form levels; the raw bar is allowed in triggers only.
    Def::new()
        .snapshot("s", atr(5))
        .stop(bin("sub", entry_price(), snap("s")))
        .adjustment(
            "be",
            bin("gte", field("HIGH"), bin("add", entry_price(), snap("s"))),
            entry_price(),
        )
        .validated();
    // History operators are not available in levels or triggers.
    let level = Def::new().stop(lag(entry_price(), 1));
    assert_eq!(code(&level), "OPERATOR_TYPE_MISMATCH");
    let trigger = Def::new().adjustment(
        "t",
        bin("gt", sma(field("HIGH"), 2), cst("1", "PRICE")),
        entry_price(),
    );
    assert_eq!(code(&trigger), "OPERATOR_TYPE_MISMATCH");
    // The stop cannot read the bar: it is evaluated once at the fill, not per session.
    let stop = Def::new().stop(field("LOW"));
    assert_eq!(code(&stop), "OPERATOR_TYPE_MISMATCH");
    // Signals cannot read the position.
    for expr in [entry_price(), snap("s")] {
        let def = Def::new()
            .snapshot("s", close())
            .condition(bin("gt", expr, cst("0", "PRICE")));
        assert_eq!(code(&def), "OPERATOR_TYPE_MISMATCH");
    }
}

// ---------------------------------------------------------------------------------------------
// Parameters and arity
// ---------------------------------------------------------------------------------------------

/// (operator, parameters it accepts). Independent of `compile.rs`.
const ACCEPTED_PARAMS: [(&str, &[&str]); 19] = [
    ("const", &["value", "unit"]),
    ("bar_field", &["field"]),
    ("ref", &["name"]),
    ("lag", &["periods"]),
    ("sma", &["window"]),
    ("rsi_simple", &["window"]),
    ("atr_simple", &["window"]),
    ("add", &[]),
    ("sub", &[]),
    ("mul", &[]),
    ("div", &[]),
    ("gt", &[]),
    ("gte", &[]),
    ("lt", &[]),
    ("lte", &[]),
    ("and", &[]),
    ("or", &[]),
    ("entry_price", &[]),
    ("snapshot", &["name"]),
];

fn scope_for(name: &str) -> Place {
    if name == "entry_price" || name == "snapshot" {
        Place::Level
    } else {
        Place::Signal
    }
}

fn sample_param(key: &str) -> Json {
    match key {
        "window" => json!(5),
        "periods" => json!(2),
        "field" => json!("CLOSE"),
        "value" => json!("1"),
        "unit" => json!("PRICE"),
        "name" => json!("a"),
        other => panic!("{other}"),
    }
}

#[test]
fn a_stray_parameter_is_rejected_and_a_missing_one_is_required() {
    let all = ["window", "periods", "field", "value", "unit", "name"];
    for (name, accepted) in ACCEPTED_PARAMS {
        let scope = scope_for(name);
        let valid = template(name, scope);
        place(scope, valid.clone()).validated();
        // Add each parameter the operator does not take.
        for key in all.iter().filter(|k| !accepted.contains(k)) {
            let mut expr = valid.clone();
            expr["params"][key] = sample_param(key);
            let def = place(scope, expr);
            let failure = def.reject();
            assert_eq!(
                failure.code.to_string(),
                "INVALID_PARAMETER",
                "{name} + {key}"
            );
            assert!(
                failure
                    .detail
                    .contains(&format!("parameter {key} is not accepted")),
                "{name} + {key}: {failure}"
            );
        }
        // Remove each parameter the operator needs.
        for key in accepted {
            let mut expr = valid.clone();
            expr["params"].as_object_mut().unwrap().remove(*key);
            let failure = place(scope, expr).reject();
            assert_eq!(
                failure.code.to_string(),
                "INVALID_PARAMETER",
                "{name} - {key}"
            );
            assert!(
                failure
                    .detail
                    .contains(&format!("parameter {key} is required")),
                "{name} - {key}: {failure}"
            );
        }
    }
}

#[test]
fn wrong_argument_counts_are_rejected_for_every_operator() {
    let spare = || cst("1", "PRICE");
    for (name, min, max) in [
        ("const", 0, 0),
        ("bar_field", 0, 0),
        ("ref", 0, 0),
        ("lag", 1, 1),
        ("sma", 1, 1),
        ("rsi_simple", 1, 1),
        ("atr_simple", 0, 0),
        ("add", 2, 2),
        ("sub", 2, 2),
        ("mul", 2, 2),
        ("div", 2, 2),
        ("gt", 2, 2),
        ("gte", 2, 2),
        ("lt", 2, 2),
        ("lte", 2, 2),
        ("and", 2, 8),
        ("or", 2, 8),
        ("entry_price", 0, 0),
        ("snapshot", 0, 0),
    ] {
        let scope = scope_for(name);
        let valid = template(name, scope);
        let args = valid["args"].as_array().unwrap().clone();
        assert!((min..=max).contains(&args.len()), "{name}: template arity");
        let mut wrong: Vec<Vec<Json>> = Vec::new();
        if min > 0 {
            wrong.push(args[..min - 1].to_vec());
        }
        let mut too_many = args.clone();
        while too_many.len() <= max {
            too_many.push(spare());
        }
        wrong.push(too_many);
        for new_args in wrong {
            let count = new_args.len();
            let mut expr = valid.clone();
            expr["args"] = Json::Array(new_args);
            let failure = place(scope, expr).reject();
            assert_eq!(
                failure.code.to_string(),
                "INVALID_PARAMETER",
                "{name} with {count} args"
            );
            assert!(failure.detail.contains("arguments"), "{name}: {failure}");
        }
    }
}

#[test]
fn window_and_lag_bounds_are_enforced_at_their_edges() {
    // window 1..=252, periods 1..=60. Zero cannot be bound by the typed schema.
    for window in [1, 2, 252] {
        indicator_def(sma(close(), window)).validated();
        indicator_def(rsi(close(), window)).validated();
        indicator_def(atr(window)).validated();
    }
    for window in [253, 1000, 1001, u64::MAX] {
        for expr in [sma(close(), window), rsi(close(), window), atr(window)] {
            let failure = indicator_def(expr).reject();
            assert_eq!(
                failure.code.to_string(),
                "INVALID_PARAMETER",
                "window {window}"
            );
            assert!(
                failure.detail.contains("exceeds the limit 252"),
                "{failure}"
            );
        }
    }
    for periods in [1, 2, 60] {
        indicator_def(lag(close(), periods)).validated();
    }
    for periods in [61, 252, 1000, u64::MAX] {
        let failure = indicator_def(lag(close(), periods)).reject();
        assert_eq!(
            failure.code.to_string(),
            "INVALID_PARAMETER",
            "periods {periods}"
        );
        assert!(failure.detail.contains("exceeds the limit 60"), "{failure}");
    }
}

#[test]
fn constants_are_bounded_and_never_flags() {
    for value in [
        "0",
        "1",
        "-5",
        "0.5",
        "-0.000000000001",
        "999999999999.999999999999",
    ] {
        indicator_def(cst(value, "PRICE")).validated();
    }
    indicator_def(cst("1000000000000", "PRICE")).validated();
    indicator_def(cst("-1000000000000", "PRICE")).validated();
    indicator_def(cst("0.123456789012", "PRICE")).validated();
    for (value, why) in [
        ("1000000000001", "above 1e12"),
        ("-1000000000001", "below -1e12"),
        ("0.1234567890123", "13 fractional digits"),
        ("79228162514264337593543950335", "largest decimal mantissa"),
    ] {
        let failure = indicator_def(cst(value, "PRICE")).reject();
        assert_eq!(failure.code.to_string(), "INVALID_PARAMETER", "{why}");
    }
    // A decimal that the arithmetic type cannot hold at all is an INVALID_DECIMAL.
    let failure = indicator_def(cst("100000000000000000000000000000000", "PRICE")).reject();
    assert_eq!(failure.code.to_string(), "INVALID_DECIMAL");
    // A constant is a number: FLAG is not a unit for it.
    let failure = indicator_def(cst("1", "FLAG")).reject();
    assert_eq!(failure.code.to_string(), "INVALID_PARAMETER");
    assert!(failure.detail.contains("FLAG"));
}

// ---------------------------------------------------------------------------------------------
// Names and references
// ---------------------------------------------------------------------------------------------

#[test]
fn names_must_be_unique_within_indicators_snapshots_and_adjustments() {
    let dup_indicators = Def::new().indicator("a", close()).indicator("a", volume());
    let failure = dup_indicators.reject();
    assert_eq!(failure.code.to_string(), "INVALID_PARAMETER");
    assert!(failure.detail.contains("duplicate name"), "{failure}");
    assert!(failure.detail.starts_with("/definition/indicators"));

    let dup_snapshots = Def::new().snapshot("s", close()).snapshot("s", close());
    let failure = dup_snapshots.reject();
    assert_eq!(failure.code.to_string(), "INVALID_PARAMETER");
    assert!(failure.detail.starts_with("/definition/entry/snapshots"));

    let dup_adjustments = Def::new()
        .adjustment("t", always(), entry_price())
        .adjustment("t", always(), entry_price());
    let failure = dup_adjustments.reject();
    assert_eq!(failure.code.to_string(), "INVALID_PARAMETER");
    assert!(
        failure
            .detail
            .starts_with("/definition/exits/stop_adjustments")
    );

    // The same name in different namespaces is fine.
    Def::new()
        .indicator("a", close())
        .snapshot("a", close())
        .stop(bin("sub", entry_price(), snap("a")))
        .validated();
    // Differences in case are different names.
    Def::new()
        .indicator("a", close())
        .indicator("A", close())
        .validated();
}

#[test]
fn references_must_name_an_earlier_indicator() {
    // Unknown, defined later, self-referencing and cyclic definitions are all rejected, which is
    // what keeps the reference graph acyclic.
    let unknown = indicator_def(rf("missing"));
    let failure = unknown.reject();
    assert_eq!(failure.code.to_string(), "INVALID_PARAMETER");
    assert!(
        failure.detail.contains("unknown or later-defined"),
        "{failure}"
    );

    let later = Def::new()
        .indicator("first", rf("second"))
        .indicator("second", close());
    assert_eq!(code(&later), "INVALID_PARAMETER");

    let selfish = Def::new().indicator("loop", bin("add", rf("loop"), close()));
    assert_eq!(code(&selfish), "INVALID_PARAMETER");

    let cycle = Def::new().indicator("a", rf("b")).indicator("b", rf("a"));
    assert_eq!(code(&cycle), "INVALID_PARAMETER");

    // Earlier definitions are fine, including through several levels.
    Def::new()
        .indicator("a", close())
        .indicator("b", bin("add", rf("a"), rf("a")))
        .indicator("c", sma(rf("b"), 3))
        .condition(bin("gt", rf("c"), rf("a")))
        .validated();

    // A snapshot name is not an indicator, and an indicator name is not a snapshot.
    let def = Def::new()
        .snapshot("s", close())
        .condition(bin("gt", rf("s"), close()));
    assert_eq!(code(&def), "INVALID_PARAMETER");
    let def = Def::new()
        .indicator("a", close())
        .stop(bin("sub", entry_price(), snap("a")));
    let failure = def.reject();
    assert_eq!(failure.code.to_string(), "INVALID_PARAMETER");
    assert!(failure.detail.contains("unknown snapshot"), "{failure}");
}

// ---------------------------------------------------------------------------------------------
// Resource limits
// ---------------------------------------------------------------------------------------------

/// A PRICE expression with exactly `nodes` nodes and a small depth.
fn tree_with_nodes(nodes: usize) -> Json {
    if nodes == 1 {
        return cst("1", "PRICE");
    }
    if nodes.is_multiple_of(2) {
        return lag(tree_with_nodes(nodes - 1), 1);
    }
    let rest = nodes - 1;
    let (mut a, mut b) = (rest / 2, rest - rest / 2);
    if a % 2 == 0 {
        (a, b) = (a - 1, b + 1);
    }
    bin("add", tree_with_nodes(a), tree_with_nodes(b))
}

fn count_nodes(expr: &Json) -> usize {
    1 + expr["args"]
        .as_array()
        .unwrap()
        .iter()
        .map(count_nodes)
        .sum::<usize>()
}

#[test]
fn an_expression_may_have_at_most_128_nodes() {
    for nodes in [1, 2, 127, 128] {
        let expr = tree_with_nodes(nodes);
        assert_eq!(count_nodes(&expr), nodes);
        indicator_def(expr).validated();
    }
    for nodes in [129, 130, 400] {
        let expr = tree_with_nodes(nodes);
        assert_eq!(count_nodes(&expr), nodes);
        let failure = indicator_def(expr).reject();
        assert_eq!(
            failure.code.to_string(),
            "INVALID_PARAMETER",
            "{nodes} nodes"
        );
        assert!(failure.detail.contains("more than 128 nodes"), "{failure}");
    }
    // The limit is per expression: two full expressions in one definition are fine.
    Def::new()
        .indicator("a", tree_with_nodes(128))
        .indicator("b", tree_with_nodes(128))
        .condition(bin("gt", rf("a"), rf("b")))
        .validated();
}

/// `add(add(... add(leaf, leaf) ...), leaf)` with `adds` nested additions.
fn nested_adds(adds: usize) -> Json {
    let mut expr = cst("1", "PRICE");
    for _ in 0..adds {
        expr = bin("add", expr, cst("1", "PRICE"));
    }
    expr
}

#[test]
fn an_expression_may_be_at_most_16_levels_deep() {
    // k nested additions have k + 1 levels (the innermost operands are leaves).
    indicator_def(nested_adds(15)).validated();
    for adds in [16, 17, 40, 200] {
        let failure = indicator_def(nested_adds(adds)).reject();
        assert_eq!(
            failure.code.to_string(),
            "INVALID_PARAMETER",
            "{adds} additions"
        );
        assert!(failure.detail.contains("deeper than 16"), "{failure}");
    }
}

#[test]
fn the_evaluation_cost_limit_stops_exponential_reference_chains() {
    // a = SMA252(close) costs 253 node visits per evaluation; each level adds(ref, ref) of the
    // previous one doubles that: cost(b_k+1) = 2 * cost(b_k) + 3 -> b9 = 131,069, b10 = 262,141.
    let chain = |levels: usize| {
        let mut def = Def::new().indicator("b0", sma(close(), 252));
        for level in 1..=levels {
            let previous = format!("b{}", level - 1);
            def = def.indicator(
                &format!("b{level}"),
                bin("add", rf(&previous), rf(&previous)),
            );
        }
        def
    };
    chain(9).validated();
    let failure = chain(10).reject();
    assert_eq!(failure.code.to_string(), "INVALID_PARAMETER");
    assert!(
        failure
            .detail
            .contains("evaluation cost 262141 exceeds the limit 200000"),
        "{failure}"
    );
    assert!(
        failure.detail.starts_with("/definition/indicators/10/expr"),
        "{failure}"
    );
}

#[test]
fn the_seed_definitions_cost_431_node_evaluations_per_decision() {
    // Hand derivation (leaf 1; operator = children + 1; sma = arg * window + 1; rsi = arg *
    // (window + 1) + 1; atr = 2 * window + 1; ref = target + 1):
    //   indicators: sma50 51, vol_sma20 21, rsi14 16, atr14 29, rsi_floor 1, weak_threshold 1,
    //               rsi_lag1 18, rsi_lag2 18                                      = 155
    //   condition:  and(54 + or(22 + 22 + 1) + 20 + 24 + 32 + 24) + 1               = 200
    //   rank:       add(mul(50, div(volume 1, ref 22) = 24) = 26, sub(100, ref 17) = 19) + 1 = 46
    //   snapshot:   ref atr14                                                        = 30
    for name in SEEDS {
        let strategy = seed_validated(name);
        assert_eq!(strategy.cost, 155 + 200 + 46 + 30, "{name}");
        assert_eq!(strategy.cost, 431);
    }
}

#[test]
fn the_cost_of_a_whole_decision_is_limited() {
    // b0 = SMA252(close) costs 253; b_k = ref(b_{k-1}) + ref(b_{k-1}) doubles it. Chain b0..b9
    // costs 261,858 together; every further indicator `ref(b9) + 1` costs 131,070 + 1 + 1 =
    // 131,072; the default condition costs 3 and the default rank 1.
    //   261,858 + 3 + 1 + n * 131,072 -> n = 5: 917,222 (allowed), n = 6: 1,048,294 (over 1e6)
    let build = |extra: usize| {
        let mut def = Def::new().indicator("b0", sma(close(), 252));
        for k in 1..=9 {
            let previous = format!("b{}", k - 1);
            def = def.indicator(&format!("b{k}"), bin("add", rf(&previous), rf(&previous)));
        }
        for k in 0..extra {
            def = def.indicator(&format!("c{k}"), bin("add", rf("b9"), cst("1", "PRICE")));
        }
        def
    };
    assert_eq!(build(5).validated().cost, 917_222);
    let failure = build(6).reject();
    assert_eq!(failure.code.to_string(), "INVALID_PARAMETER");
    assert_eq!(
        failure.detail,
        "/definition: one decision needs 1048294 node evaluations, more than the limit 1000000"
    );
}

#[test]
fn nested_rolling_means_multiply_their_cost() {
    // Two levels cost 252 * 253 + 1 = 63,757, inside the cost limit; the history they need
    // (251 + 251 sessions) is what stops them.
    let failure = indicator_def(sma(sma(close(), 252), 252)).reject();
    assert_eq!(failure.code.to_string(), "INVALID_PARAMETER");
    assert!(failure.detail.contains("more history"), "{failure}");
    // A third level would cost about 16 million visits per decision: the cost check stops it
    // first, at the expression itself.
    let triple = sma(sma(sma(close(), 252), 252), 252);
    let failure = indicator_def(triple).reject();
    assert_eq!(failure.code.to_string(), "INVALID_PARAMETER");
    assert!(failure.detail.contains("evaluation cost"), "{failure}");
    assert!(
        failure.detail.starts_with("/definition/indicators/0/expr"),
        "{failure}"
    );
}

#[test]
fn total_lookback_is_limited_to_400_sessions() {
    // sma(close, 252) needs 251 earlier sessions; sma of that over n adds n - 1: 251 + 149 = 400.
    indicator_def(sma(sma(close(), 252), 150)).validated();
    let failure = indicator_def(sma(sma(close(), 252), 151)).reject();
    assert_eq!(failure.code.to_string(), "INVALID_PARAMETER");
    assert!(failure.detail.contains("more history"), "{failure}");
    // Lags count: RSI 252 needs 252 sessions, 60 more from the lag gives 312.
    indicator_def(lag(rsi(close(), 252), 60)).validated();
    // A long lookback in a snapshot or the rank counts too.
    let long = || sma(sma(close(), 252), 151);
    assert_eq!(code(&Def::new().rank(long())), "INVALID_PARAMETER");
    assert_eq!(code(&Def::new().snapshot("s", long())), "INVALID_PARAMETER");
    assert_eq!(
        code(&Def::new().condition(bin("gt", long(), cst("0", "PRICE")))),
        "INVALID_PARAMETER"
    );
}

#[test]
fn reference_chains_are_limited_in_evaluation_depth_so_the_stack_cannot_be_exhausted() {
    // Every link wraps a reference to the previous indicator in `adds` additions. A reference
    // adds the depth of its target, so the evaluation depth of i0..i4 is 1, 17, 33, 49 and
    // 50 + adds. The evaluator recurses once per level; before this limit existed, a chain of 32
    // links of 16 levels overflowed a 2 MiB thread stack in a debug build.
    let chain = |last_adds: usize| {
        let mut def = Def::new().indicator("i0", close());
        for k in 1..5 {
            let adds = if k == 4 { last_adds } else { 15 };
            let mut expr = rf(&format!("i{}", k - 1));
            for _ in 0..adds {
                expr = bin("add", expr, cst("1", "PRICE"));
            }
            def = def.indicator(&format!("i{k}"), expr);
        }
        def
    };
    // Depth exactly 64 is accepted and evaluates: i4 = close + 3 * 15 + 14 = 10 + 59.
    let strategy = chain(14).validated();
    assert_eq!(strategy.indicators[4].node.depth, 64);
    let series = series_of(&flat_series(&[1000; 3]));
    let eval = signals(&strategy, &series, 2);
    assert_agrees(Exp::Num(Frac::int(10 + 59)), indicator(&eval, "i4"), "i4");
    // One level more is rejected at the expression that exceeds it.
    let failure = chain(15).reject();
    assert_eq!(failure.code.to_string(), "INVALID_PARAMETER");
    assert!(
        failure.detail.starts_with("/definition/indicators/4/expr"),
        "{failure}"
    );
    assert!(failure.detail.contains("evaluation depth 65"), "{failure}");
    // The longest chain the schema could otherwise describe (32 indicators of 16 levels) is
    // rejected, not run.
    let mut def = Def::new().indicator("i0", close());
    for k in 1..32 {
        let mut expr = rf(&format!("i{}", k - 1));
        for _ in 0..15 {
            expr = bin("add", expr, cst("1", "PRICE"));
        }
        def = def.indicator(&format!("i{k}"), expr);
    }
    assert_eq!(code(&def), "INVALID_PARAMETER");
}

#[test]
fn very_deep_input_is_rejected_without_exhausting_the_stack() {
    // 60 levels of nesting in the input: compilation stops at level 17 and never descends further.
    let failure = indicator_def(nested_adds(60)).reject();
    assert!(failure.detail.contains("deeper than 16"));
}

// ---------------------------------------------------------------------------------------------
// Whole-definition behaviour
// ---------------------------------------------------------------------------------------------

#[test]
fn the_first_problem_in_document_order_is_the_one_reported() {
    // Indicators are compiled before the condition, the condition before the rank.
    let def = Def::new()
        .indicator("x", bin("add", close(), volume()))
        .condition(close())
        .rank(always());
    assert_eq!(code(&def), "OPERATOR_UNIT_MISMATCH");
    let def = Def::new().condition(close()).rank(always());
    assert_eq!(code(&def), "OPERATOR_TYPE_MISMATCH");
    assert!(detail(&def).starts_with("/definition/entry/condition"));
    // Within an expression the parent is checked before its children.
    let def = indicator_def(op(
        "gt",
        vec![op("ema", vec![], json!({})), close()],
        json!({"window": 3}),
    ));
    assert_eq!(code(&def), "INVALID_PARAMETER");
}

#[test]
fn a_valid_definition_reports_its_hash_slots_and_lookback() {
    let strategy = seed_validated(SEEDS[0]);
    assert_eq!(strategy.slots, 5);
    assert_eq!(strategy.indicators.len(), 8);
    assert_eq!(strategy.snapshots.len(), 1);
    assert_eq!(strategy.adjustments.len(), 0);
    // sma50 needs 49 earlier sessions; lag2(rsi14) needs 14 + 2 = 16; the maximum is 49.
    assert_eq!(strategy.max_lookback, 49);
    assert!(strategy.hash.starts_with("sha256:"));
    let with_break_even = seed_validated(SEEDS[2]);
    assert_eq!(with_break_even.adjustments.len(), 1);
    assert_eq!(with_break_even.adjustments[0].id, "break_even");
}

fn seed_validated(name: &str) -> openquant_core::ValidatedStrategy {
    openquant_core::validate_strategy(&seed(name)).unwrap()
}

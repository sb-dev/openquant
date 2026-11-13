//! The seed variants are data (OQ-06 section 8, "Definition execution"): thresholds 30/32 and
//! break-even off/on are differences between versioned definitions with distinct identities, not
//! separate Rust strategies or evaluator modes.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

mod operators_support;

use std::{cmp::Ordering, collections::BTreeSet, fs, path::Path};

use openquant_contracts::payload_digest;
use openquant_core::{
    ValidatedStrategy,
    numeric::{Decimal, Ratio},
    operators::{PriceBar, Value},
    signals::{LevelEnv, eval_position_expr, evaluate_signals},
    validate_strategy,
};
use operators_support::*;
use serde_json::Value as Json;

/// The parent of each variant in `SEEDS` order, from the plan: v1 is the root, v2 and v3 derive
/// from v1, v4 from v2 (adding break-even to the threshold-32 variant) and v5 from v1.
const PARENT: [Option<usize>; 5] = [None, Some(0), Some(0), Some(1), Some(0)];

/// The threshold of each variant, in RSI points.
const THRESHOLD: [i128; 5] = [30, 32, 30, 32, 40];

fn validated(name: &str) -> ValidatedStrategy {
    validate_strategy(&seed(name)).unwrap_or_else(|f| panic!("{name}: {f}"))
}

// ---------------------------------------------------------------------------------------------
// One validator, distinct identities, honest lineage
// ---------------------------------------------------------------------------------------------

#[test]
fn the_five_artefacts_validate_through_one_validator_with_distinct_hashes() {
    let mut hashes = BTreeSet::new();
    for (index, name) in SEEDS.iter().enumerate() {
        let artefact = seed(name);
        let strategy = validated(name);
        assert_eq!(strategy.hash, payload_digest(&artefact).unwrap(), "{name}");
        assert_eq!(strategy.strategy_id, "daily-swing-seed");
        assert_eq!(strategy.version, index as u64 + 1, "{name}");
        assert_eq!(strategy.slots, 5, "{name}");
        assert!(
            hashes.insert(strategy.hash.clone()),
            "{name}: duplicate hash"
        );
    }
    assert_eq!(hashes.len(), 5);
}

#[test]
fn every_variant_has_the_same_structure_and_differs_only_in_data() {
    let base = validated(SEEDS[0]);
    for name in SEEDS {
        let other = validated(name);
        let names = |s: &ValidatedStrategy| -> Vec<String> {
            s.indicators.iter().map(|i| i.name.clone()).collect()
        };
        assert_eq!(names(&other), names(&base), "{name}");
        assert_eq!(other.max_lookback, base.max_lookback, "{name}");
        assert_eq!(other.condition.cost, base.condition.cost, "{name}");
        assert_eq!(other.rank.cost, base.rank.cost, "{name}");
        assert_eq!(other.stop.cost, base.stop.cost, "{name}");
        assert_eq!(other.target.cost, base.target.cost, "{name}");
        assert_eq!(
            other
                .snapshots
                .iter()
                .map(|s| s.name.clone())
                .collect::<Vec<_>>(),
            vec!["entry_atr".to_owned()]
        );
    }
    let adjustments: Vec<usize> = SEEDS
        .iter()
        .map(|n| validated(n).adjustments.len())
        .collect();
    assert_eq!(adjustments, [0, 0, 1, 1, 0]);
}

#[test]
fn parent_hashes_match_the_content_of_the_parent_artefact() {
    let hashes: Vec<String> = SEEDS
        .iter()
        .map(|n| payload_digest(&seed(n)).unwrap())
        .collect();
    for (index, name) in SEEDS.iter().enumerate() {
        let artefact = seed(name);
        match (PARENT[index], artefact.parent.as_ref()) {
            (None, None) => {}
            (Some(parent), Some(declared)) => {
                assert_eq!(declared.hash.to_string(), hashes[parent], "{name}");
                // And it names no other artefact.
                assert_eq!(
                    hashes
                        .iter()
                        .filter(|h| **h == declared.hash.to_string())
                        .count(),
                    1
                );
            }
            (expected, found) => panic!("{name}: expected parent {expected:?}, found {found:?}"),
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Declared changes against a computed leaf difference
// ---------------------------------------------------------------------------------------------

/// The minimal differing subtrees of two JSON values: objects and equal-length arrays are
/// compared member by member; a missing member, a different array length or a different scalar is
/// one change at that path.
fn changes(path: &str, a: &Json, b: &Json, out: &mut Vec<(String, Json, Json)>) {
    match (a, b) {
        (Json::Object(x), Json::Object(y)) => {
            let keys: BTreeSet<&String> = x.keys().chain(y.keys()).collect();
            for key in keys {
                let child = format!("{path}/{key}");
                match (x.get(key), y.get(key)) {
                    (Some(l), Some(r)) => changes(&child, l, r, out),
                    (l, r) => out.push((
                        child,
                        l.cloned().unwrap_or(Json::Null),
                        r.cloned().unwrap_or(Json::Null),
                    )),
                }
            }
        }
        (Json::Array(x), Json::Array(y)) if x.len() == y.len() => {
            for (index, (l, r)) in x.iter().zip(y).enumerate() {
                changes(&format!("{path}/{index}"), l, r, out);
            }
        }
        _ => {
            if a != b {
                out.push((path.to_owned(), a.clone(), b.clone()));
            }
        }
    }
}

/// How a changed value is written in a declared change: a string as itself, an empty list as
/// `[]`, a list of named rules as their ids, anything else as JSON.
fn render(value: &Json) -> String {
    match value {
        Json::String(text) => text.clone(),
        Json::Array(items) if items.is_empty() => "[]".to_owned(),
        Json::Array(items) => items
            .iter()
            .map(|item| {
                item["id"]
                    .as_str()
                    .map_or_else(|| item.to_string(), str::to_owned)
            })
            .collect::<Vec<_>>()
            .join(","),
        other => other.to_string(),
    }
}

/// An artefact without the fields that identify the version rather than describe it.
fn body(name: &str) -> Json {
    let mut value = seed_json(name);
    let object = value.as_object_mut().unwrap();
    object.remove("version");
    object.remove("parent");
    value
}

#[test]
fn declared_changes_are_exactly_the_leaf_differences_to_the_parent() {
    for (index, name) in SEEDS.iter().enumerate() {
        let Some(parent) = PARENT[index] else {
            assert!(seed_json(name).get("parent").is_none(), "{name}");
            continue;
        };
        let mut computed = Vec::new();
        changes("", &body(SEEDS[parent]), &body(name), &mut computed);
        let computed: BTreeSet<(String, String, String)> = computed
            .iter()
            .map(|(path, from, to)| (path.clone(), render(from), render(to)))
            .collect();
        let declared: BTreeSet<(String, String, String)> = seed_json(name)["parent"]["changes"]
            .as_array()
            .unwrap()
            .iter()
            .map(|c| {
                (
                    c["path"].as_str().unwrap().to_owned(),
                    c["from"].as_str().unwrap().to_owned(),
                    c["to"].as_str().unwrap().to_owned(),
                )
            })
            .collect();
        assert!(!computed.is_empty(), "{name} differs from its parent");
        assert_eq!(
            declared, computed,
            "{name}: declared changes vs computed differences"
        );
    }
}

#[test]
fn the_expected_differences_are_threshold_and_break_even_only() {
    // Written from the plan: v2 = v1 with threshold 32; v3 = v1 with the break-even rule;
    // v4 = v2 with the break-even rule; v5 = v1 with threshold 40.
    let one_change = |parent: usize, child: usize| -> Vec<(String, String, String)> {
        let mut out = Vec::new();
        changes("", &body(SEEDS[parent]), &body(SEEDS[child]), &mut out);
        out.iter()
            .map(|(p, f, t)| (p.clone(), render(f), render(t)))
            .collect()
    };
    let threshold = "/definition/indicators/5/expr/params/value";
    let rule = "/definition/exits/stop_adjustments";
    let expect =
        |path: &str, from: &str, to: &str| vec![(path.to_owned(), from.to_owned(), to.to_owned())];
    assert_eq!(one_change(0, 1), expect(threshold, "30", "32"));
    assert_eq!(one_change(0, 2), expect(rule, "[]", "break_even"));
    assert_eq!(one_change(1, 3), expect(rule, "[]", "break_even"));
    assert_eq!(one_change(0, 4), expect(threshold, "30", "40"));
    // The indicator at that path really is the weakness threshold.
    assert_eq!(
        seed_json(SEEDS[0])["definition"]["indicators"][5]["name"],
        "weak_threshold"
    );
    // v4 combines both changes relative to v1.
    let both = one_change(0, 3);
    assert_eq!(both.len(), 2);
    assert!(both.contains(&expect(threshold, "30", "32")[0]));
    assert!(both.contains(&expect(rule, "[]", "break_even")[0]));
}

#[test]
fn a_wrongly_declared_change_would_be_caught() {
    // Negative control for the comparison above: a child that lies about its parent differs.
    let mut computed = Vec::new();
    changes("", &body(SEEDS[0]), &body(SEEDS[3]), &mut computed);
    assert_eq!(
        computed.len(),
        2,
        "v4 against v1 has two differences, not the one v4 declares"
    );
    let declared = seed_json(SEEDS[3])["parent"]["changes"]
        .as_array()
        .unwrap()
        .len();
    assert_eq!(declared, 1);
}

// ---------------------------------------------------------------------------------------------
// No variant-specific code
// ---------------------------------------------------------------------------------------------

fn rust_files(dir: &Path, out: &mut Vec<std::path::PathBuf>) {
    for entry in fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            rust_files(&path, out);
        } else if path.extension().is_some_and(|e| e == "rs") {
            out.push(path);
        }
    }
}

/// The code of a Rust source file without comment text.
fn code_only(text: &str) -> String {
    text.lines()
        .map(|line| {
            let trimmed = line.trim_start();
            if trimmed.starts_with("//") {
                ""
            } else {
                line.split_once(" //").map_or(line, |(code, _)| code)
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

#[test]
fn no_variant_specific_name_appears_in_the_shared_core_or_contracts() {
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
    let mut files = Vec::new();
    rust_files(&manifest.join("src"), &mut files);
    rust_files(&manifest.join("../api-contracts/rust/src"), &mut files);
    files.push(manifest.join("../api-contracts/rust/build.rs"));
    assert!(files.len() > 15, "scanned too little: {}", files.len());
    // Names that exist only in the seed definitions, and the identities of the variants. The
    // core must reach them through data (indicator names come from the artefact), never by name.
    let forbidden = [
        "weak_threshold",
        "rsi_floor",
        "rsi_lag",
        "break_even",
        "breakeven",
        "break-even",
        "daily-swing-seed",
        "entry_atr",
        "sma50",
        "vol_sma20",
        "rsi14",
        "atr14",
        "rsi30",
        "rsi32",
        "rsi40",
        "seed-1",
        "seed-2",
        "seed-3",
        "seed-4",
        "seed-5",
    ];
    for file in &files {
        let text = fs::read_to_string(file).unwrap();
        let code = code_only(&text);
        for word in forbidden {
            assert!(
                !code.contains(word),
                "{} refers to {word:?}: variants must differ in data only",
                file.display()
            );
        }
    }
}

#[test]
fn a_new_threshold_is_data_not_code() {
    // Build artefacts with other thresholds by editing one constant. They validate through the
    // same validator, get their own hashes and change decisions as the rule says.
    let mut hashes = BTreeSet::new();
    hashes.insert(validated(SEEDS[0]).hash);
    let values = [2900, 3000, 3100, 3300, 3500, 3999, 4000, 4100];
    for threshold in [20_i64, 25, 31, 33, 35, 38, 45, 50] {
        let mut value = seed_json(SEEDS[0]);
        value["definition"]["indicators"][5]["expr"]["params"]["value"] =
            Json::String(threshold.to_string());
        // The published definition with only the threshold constant changed.
        let strategy = validate_strategy(&serde_json::from_value(value.clone()).unwrap()).unwrap();
        assert!(
            hashes.insert(strategy.hash.clone()),
            "threshold {threshold}"
        );
        // Evaluate it with the close standing in for RSI.
        close_stands_for_rsi(&mut value);
        let strategy = validate_strategy(&serde_json::from_value(value).unwrap()).unwrap();
        for x2 in values {
            for x1 in values {
                let series = series_of(&flat_series(&[x2, x1, 3100]));
                let want = x2 <= threshold * 100 || x1 <= threshold * 100;
                assert_eq!(
                    evaluate_signals(&strategy, &series).unwrap().condition,
                    Value::Flag(want),
                    "threshold {threshold}: {x2} {x1}"
                );
            }
        }
    }
    assert_eq!(hashes.len(), 9);
}

// ---------------------------------------------------------------------------------------------
// Real indicators, all five artefacts, against an independent reference
// ---------------------------------------------------------------------------------------------

fn compare(a: Exp, b: Exp, test: fn(Ordering) -> bool) -> Exp {
    match (a, b) {
        (Exp::Missing(reason), _) | (_, Exp::Missing(reason)) => Exp::Missing(reason),
        (Exp::Num(x), Exp::Num(y)) => Exp::Flag(test(x.cmp_to(y))),
        other => panic!("{other:?}"),
    }
}

fn greater(a: Exp, b: Exp) -> Exp {
    compare(a, b, |o| o == Ordering::Greater)
}

fn at_most(a: Exp, b: Exp) -> Exp {
    compare(a, b, |o| o != Ordering::Greater)
}

/// `and` / `or` with strict missing propagation: the first missing operand names the reason.
fn combine(children: &[Exp], all: bool) -> Exp {
    let mut flags = Vec::new();
    for child in children {
        match child {
            Exp::Missing(reason) => return Exp::Missing(*reason),
            Exp::Flag(flag) => flags.push(*flag),
            Exp::Num(_) => panic!("number in a Boolean"),
        }
    }
    Exp::Flag(if all {
        flags.iter().all(|f| *f)
    } else {
        flags.iter().any(|f| *f)
    })
}

/// The seed entry condition (OQ-02 section 2.6) from the reference indicators.
fn reference_condition(series: &[Option<Bar>], t: usize, threshold: i128) -> Exp {
    let bar = series[t].unwrap();
    let close = Exp::Num(Frac::ticks(i128::from(bar.c)));
    let volume = Exp::Num(Frac::int(i128::from(bar.v)));
    let weak = Exp::Num(Frac::int(threshold));
    let floor = Exp::Num(Frac::int(30));
    let zero = Exp::Num(Frac::int(0));
    let sma50 = reference::sma_close(series, t, 50);
    let volume_mean = reference::sma_volume(series, t, 20);
    let rsi = reference::rsi(series, t, 14);
    let lag1 = reference::rsi_lagged(series, t, 14, 1);
    let lag2 = reference::rsi_lagged(series, t, 14, 2);
    let atr = reference::atr(series, t, 14);
    combine(
        &[
            greater(close, sma50),
            combine(&[at_most(lag2, weak), at_most(lag1, weak)], false),
            greater(rsi, floor),
            greater(volume, volume_mean),
            greater(atr, zero),
            greater(volume_mean, zero),
        ],
        true,
    )
}

#[test]
fn all_five_artefacts_follow_the_reference_condition_on_real_indicators() {
    let strategies: Vec<ValidatedStrategy> = SEEDS.iter().map(|n| validated(n)).collect();
    let mut true_count = [0_usize; 5];
    let mut only_32 = 0; // threshold 32 enters where threshold 30 does not
    let mut only_40 = 0; // threshold 40 enters where threshold 32 does not
    let mut checked = 0;
    for seed in [1_u64, 2, 3, 4] {
        let bars = random_bars(seed * 7_919, 2_500);
        let reference: Vec<Option<Bar>> = bars.iter().copied().map(Some).collect();
        let series: Vec<Option<PriceBar>> = series_of(&bars);
        for t in 0..bars.len() {
            let mut engine = Vec::new();
            for (index, strategy) in strategies.iter().enumerate() {
                let value = evaluate_signals(strategy, &series[..=t]).unwrap().condition;
                let want = reference_condition(&reference, t, THRESHOLD[index]);
                assert_agrees(
                    want,
                    value,
                    &format!("seed {seed} t={t} variant {}", index + 1),
                );
                true_count[index] += usize::from(value == Value::Flag(true));
                engine.push(value);
            }
            // Break-even is not an entry rule: variants 1 and 3, and 2 and 4, decide alike.
            assert_eq!(engine[0], engine[2], "t={t}");
            assert_eq!(engine[1], engine[3], "t={t}");
            only_32 +=
                usize::from(engine[1] == Value::Flag(true) && engine[0] == Value::Flag(false));
            only_40 +=
                usize::from(engine[4] == Value::Flag(true) && engine[1] == Value::Flag(false));
            // A larger threshold never removes an entry.
            if engine[0] == Value::Flag(true) {
                assert_eq!(engine[1], Value::Flag(true));
            }
            if engine[1] == Value::Flag(true) {
                assert_eq!(engine[4], Value::Flag(true));
            }
            checked += 1;
        }
    }
    assert_eq!(checked, 10_000); // The comparison is not vacuous: entries happen, and the variants really differ.
    assert!(true_count[0] > 10, "{true_count:?}");
    assert!(
        only_32 > 0,
        "no session separates threshold 30 from 32: {true_count:?}"
    );
    assert!(
        only_40 > 0,
        "no session separates threshold 32 from 40: {true_count:?}"
    );
    assert_eq!(true_count[0], true_count[2]);
    assert_eq!(true_count[1], true_count[3]);
}

// ---------------------------------------------------------------------------------------------
// Levels and break-even: evaluated from the artefacts' own expressions
// ---------------------------------------------------------------------------------------------

fn dec(text: &str) -> Ratio {
    Ratio::from(Decimal::from_str_exact(text).unwrap())
}

fn raw_bar(high: &str) -> PriceBar {
    PriceBar {
        open: dec("90"),
        high: dec(high),
        low: dec("80"),
        close: dec("95"),
        volume: dec("1000"),
    }
}

#[test]
fn stop_and_target_levels_use_two_and_five_entry_atr_in_every_variant() {
    // OQ-06: entry 100, entry ATR 4 -> stop 92, target 120; after a 2-for-1 split entry 50 and
    // ATR 2 -> stop 46, target 60.
    for (entry, atr, stop, target) in [("100", "4", "92", "120"), ("50", "2", "46", "60")] {
        for name in SEEDS {
            let strategy = validated(name);
            let snapshots = vec![("entry_atr".to_owned(), dec(atr))];
            let env = LevelEnv {
                bar: None,
                entry_price: dec(entry),
                snapshots: &snapshots,
            };
            assert_eq!(
                eval_position_expr(&strategy.stop, &env).unwrap(),
                Value::Num(dec(stop)),
                "{name}: stop"
            );
            assert_eq!(
                eval_position_expr(&strategy.target, &env).unwrap(),
                Value::Num(dec(target)),
                "{name}: target"
            );
        }
    }
    // A snapshot that does not terminate: entry 100, ATR 14/3 -> stop 100 - 28/3 = 272/3, exactly.
    let atr = Ratio::new(14, 3).unwrap();
    let strategy = validated(SEEDS[0]);
    let snapshots = vec![("entry_atr".to_owned(), atr)];
    let env = LevelEnv {
        bar: None,
        entry_price: dec("100"),
        snapshots: &snapshots,
    };
    let Value::Num(stop) = eval_position_expr(&strategy.stop, &env).unwrap() else {
        panic!("stop");
    };
    assert!(Frac::new(272, 3).matches(stop), "{stop}");
    let Value::Num(target) = eval_position_expr(&strategy.target, &env).unwrap() else {
        panic!("target");
    };
    assert!(Frac::new(100 * 3 + 70, 3).matches(target), "{target}");
    // Without the snapshot the level is missing, never a guess.
    let env = LevelEnv {
        bar: None,
        entry_price: dec("100"),
        snapshots: &[],
    };
    assert!(matches!(
        eval_position_expr(&strategy.stop, &env).unwrap(),
        Value::Missing(_)
    ));
}

#[test]
fn break_even_triggers_when_the_high_reaches_entry_plus_one_atr_and_moves_to_entry() {
    for name in [SEEDS[2], SEEDS[3]] {
        let strategy = validated(name);
        assert_eq!(strategy.adjustments.len(), 1, "{name}");
        let adjustment = &strategy.adjustments[0];
        assert_eq!(adjustment.id, "break_even");
        // (entry, ATR, high, expected trigger): the comparison is inclusive.
        for (entry, atr, high, fires) in [
            ("100", "4", "104", true),
            ("100", "4", "103.99", false),
            ("100", "4", "104.01", true),
            ("100", "4", "110", true),
            ("100", "4", "100", false),
            ("50", "2", "52", true),
            ("50", "2", "51.99", false),
        ] {
            let snapshots = vec![("entry_atr".to_owned(), dec(atr))];
            let env = LevelEnv {
                bar: Some(raw_bar(high)),
                entry_price: dec(entry),
                snapshots: &snapshots,
            };
            assert_eq!(
                eval_position_expr(&adjustment.trigger, &env).unwrap(),
                Value::Flag(fires),
                "{name}: entry {entry} ATR {atr} high {high}"
            );
            // The new level is the entry price, on the position's own basis.
            assert_eq!(
                eval_position_expr(&adjustment.new_level, &env).unwrap(),
                Value::Num(dec(entry))
            );
        }
        // Without a bar the trigger is unavailable, not false and not true.
        let snapshots = vec![("entry_atr".to_owned(), dec("4"))];
        let env = LevelEnv {
            bar: None,
            entry_price: dec("100"),
            snapshots: &snapshots,
        };
        assert!(matches!(
            eval_position_expr(&adjustment.trigger, &env).unwrap(),
            Value::Missing(_)
        ));
    }
    // The variants without the rule have nothing to evaluate.
    for name in [SEEDS[0], SEEDS[1], SEEDS[4]] {
        assert!(validated(name).adjustments.is_empty(), "{name}");
    }
}

#[test]
fn the_break_even_trigger_reads_the_raw_bar_not_the_signal_series() {
    // The trigger evaluates on the raw current bar passed in the environment; a different bar
    // gives a different answer with the same position data.
    let strategy = validated(SEEDS[2]);
    let adjustment = &strategy.adjustments[0];
    let snapshots = vec![("entry_atr".to_owned(), dec("4"))];
    let fires = |high: &str| {
        let env = LevelEnv {
            bar: Some(raw_bar(high)),
            entry_price: dec("100"),
            snapshots: &snapshots,
        };
        eval_position_expr(&adjustment.trigger, &env).unwrap()
    };
    assert_eq!(fires("104"), Value::Flag(true));
    assert_eq!(fires("103"), Value::Flag(false));
}

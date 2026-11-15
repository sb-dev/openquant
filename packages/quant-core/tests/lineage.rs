//! Strategy lineage and the checks of the `validate` job (OQ-02 sections 3.1 and 4; OQ-03 section 3).
//!
//! The leaf difference is checked against the reference function of `variants_seed.rs`, which
//! derived the declared changes of the five S0 seeds before this module existed, copied here so
//! that the two stay independent. The classification by dependency is checked on the seeds and on
//! small revisions built from them, each named by what it must prove.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

mod evidence_support;
mod operators_support;

use std::collections::BTreeSet;

use evidence_support::test_method;
use openquant_contracts::{StrategyArtefact, generated as g, parse, payload_digest, to_value};
use openquant_core::lineage::{
    DeclaredChange, Outcome, Scope, ValidationContext, check_revision, check_seed, classify,
    leaf_changes, render, validation_result,
};
use operators_support::{SEEDS, seed, seed_json};
use serde_json::{Value, json};

const WARMUP: usize = 60;

/// The longest lookback of the seeds, derived by hand from the operators: the 50-session mean
/// reads the decision session and the 49 sessions before it, and the lagged 14-session RSI needs
/// 14 + 2 sessions of history, so the longest history is 49 sessions.
const LOOKBACK: usize = 49;

// --- The reference leaf difference, as `variants_seed.rs` writes it -----------------------------

fn reference_changes(path: &str, a: &Value, b: &Value, out: &mut Vec<(String, Value, Value)>) {
    match (a, b) {
        (Value::Object(x), Value::Object(y)) => {
            let keys: BTreeSet<&String> = x.keys().chain(y.keys()).collect();
            for key in keys {
                let child = format!("{path}/{key}");
                match (x.get(key), y.get(key)) {
                    (Some(l), Some(r)) => reference_changes(&child, l, r, out),
                    (l, r) => out.push((
                        child,
                        l.cloned().unwrap_or(Value::Null),
                        r.cloned().unwrap_or(Value::Null),
                    )),
                }
            }
        }
        (Value::Array(x), Value::Array(y)) if x.len() == y.len() => {
            for (index, (l, r)) in x.iter().zip(y).enumerate() {
                reference_changes(&format!("{path}/{index}"), l, r, out);
            }
        }
        _ => {
            if a != b {
                out.push((path.to_owned(), a.clone(), b.clone()));
            }
        }
    }
}

fn reference_render(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Array(items) if items.is_empty() => "[]".to_owned(),
        Value::Array(items) => items
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

fn body(value: &Value) -> Value {
    let mut value = value.clone();
    let object = value.as_object_mut().unwrap();
    for key in ["strategy_id", "version", "parent"] {
        object.remove(key);
    }
    value
}

fn reference(parent: &Value, child: &Value) -> Vec<DeclaredChange> {
    let mut out = Vec::new();
    reference_changes("", &body(parent), &body(child), &mut out);
    out.into_iter()
        .map(|(path, from, to)| DeclaredChange {
            path,
            from: reference_render(&from),
            to: reference_render(&to),
        })
        .collect()
}

// --- Builders ----------------------------------------------------------------------------------

fn artefact(value: &Value) -> StrategyArtefact {
    parse(&value.to_string()).unwrap_or_else(|e| panic!("{e}: {value}"))
}

/// A child of `parent` with `edit` applied. Its parent hash is the digest of the parent and its
/// declared changes are the reference leaf difference, so the revision is honest unless a test
/// overrides that.
fn revise(parent: &Value, edit: impl FnOnce(&mut Value)) -> (StrategyArtefact, StrategyArtefact) {
    let mut child = parent.clone();
    child["version"] = json!(parent["version"].as_u64().unwrap() + 1);
    edit(&mut child);
    let hash = payload_digest(&artefact(parent)).unwrap();
    // A change that renders longer than the 256 characters of a declaration cannot be declared
    // honestly (a finding in the report); the schema refuses the artefact unless the text is cut,
    // so the builder cuts it and the revision is then a lineage mismatch by construction.
    let cut = |text: &str| text.chars().take(256).collect::<String>();
    let changes: Vec<Value> = reference(parent, &child)
        .iter()
        .map(|c| json!({"path": cut(&c.path), "from": cut(&c.from), "to": cut(&c.to)}))
        .collect();
    child["parent"] = json!({"hash": hash, "changes": changes});
    (artefact(parent), artefact(&child))
}

fn base() -> Value {
    seed_json(SEEDS[0])
}

fn indicator<'a>(value: &'a mut Value, name: &str) -> &'a mut Value {
    value["definition"]["indicators"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|i| i["name"] == name)
        .unwrap_or_else(|| panic!("indicator {name}"))
}

fn scope_of(parent: &Value, edit: impl FnOnce(&mut Value)) -> Scope {
    let (p, c) = revise(parent, edit);
    classify(&p, &c).unwrap().1
}

fn codes(outcome: &Outcome) -> Vec<&'static str> {
    match outcome {
        Outcome::Invalid(diagnostics) => diagnostics.iter().map(|d| d.code).collect(),
        other => panic!("expected diagnostics, got {other:?}"),
    }
}

fn check(parent: &Value, edit: impl FnOnce(&mut Value)) -> Outcome {
    let (p, c) = revise(parent, edit);
    check_revision(&p, &c, WARMUP).unwrap()
}

// --- The five seeds ----------------------------------------------------------------------------

#[test]
fn the_leaf_difference_equals_the_reference_for_every_ordered_pair_of_seeds() {
    let values: Vec<Value> = SEEDS.iter().map(|name| seed_json(name)).collect();
    let artefacts: Vec<StrategyArtefact> = SEEDS.iter().map(|name| seed(name)).collect();
    let mut pairs = 0;
    for (i, parent) in artefacts.iter().enumerate() {
        for (j, child) in artefacts.iter().enumerate() {
            let computed: Vec<DeclaredChange> = leaf_changes(parent, child)
                .unwrap()
                .iter()
                .map(|c| DeclaredChange {
                    path: c.path.clone(),
                    from: render(&c.from),
                    to: render(&c.to),
                })
                .collect();
            assert_eq!(
                computed,
                reference(&values[i], &values[j]),
                "{} to {}",
                SEEDS[i],
                SEEDS[j]
            );
            assert_eq!(computed.is_empty(), i == j);
            pairs += 1;
        }
    }
    assert_eq!(pairs, 25);
}

#[test]
fn the_declared_changes_of_the_seeds_are_the_computed_ones_and_their_scope_is_the_rule_they_change()
{
    // v2 changes the weakness threshold (an entry rule), v3 adds break-even (an exit rule), v4 adds
    // break-even to v2 (an exit rule) and v5 changes the threshold of v1 (an entry rule).
    let parents = [None, Some(0), Some(0), Some(1), Some(0)];
    let scopes = [
        None,
        Some("ENTRY"),
        Some("EXIT"),
        Some("EXIT"),
        Some("ENTRY"),
    ];
    for (index, name) in SEEDS.iter().enumerate() {
        let child = seed(name);
        let Some(parent) = parents[index] else {
            assert_eq!(
                check_seed(&child, WARMUP),
                Outcome::ValidSeed {
                    max_lookback: LOOKBACK,
                    warmup: WARMUP
                }
            );
            continue;
        };
        let outcome = check_revision(&seed(SEEDS[parent]), &child, WARMUP).unwrap();
        match outcome {
            Outcome::ValidRevision {
                max_lookback,
                warmup,
                changes,
                scope,
            } => {
                assert_eq!((max_lookback, warmup), (LOOKBACK, WARMUP), "{name}");
                assert_eq!(Some(scope), scopes[index], "{name}");
                let declared = seed_json(name)["parent"]["changes"]
                    .as_array()
                    .unwrap()
                    .clone();
                let declared: Vec<DeclaredChange> = declared
                    .iter()
                    .map(|c| DeclaredChange {
                        path: c["path"].as_str().unwrap().to_owned(),
                        from: c["from"].as_str().unwrap().to_owned(),
                        to: c["to"].as_str().unwrap().to_owned(),
                    })
                    .collect();
                assert_eq!(changes, declared, "{name}");
            }
            other => panic!("{name}: {other:?}"),
        }
    }
}

#[test]
fn a_revision_that_changes_the_entry_and_the_exit_is_not_a_controlled_revision() {
    // v4 differs from v1 in the threshold (entry) and in break-even (exit).
    let (parent, mut child) = (seed_json(SEEDS[0]), seed_json(SEEDS[3]));
    let hash = payload_digest(&artefact(&parent)).unwrap();
    let changes: Vec<Value> = reference(&parent, &child)
        .iter()
        .map(|c| json!({"path": c.path, "from": c.from, "to": c.to}))
        .collect();
    assert_eq!(changes.len(), 2);
    child["parent"] = json!({"hash": hash, "changes": changes});
    let outcome = check_revision(&artefact(&parent), &artefact(&child), WARMUP).unwrap();
    assert_eq!(codes(&outcome), ["REVISION_SCOPE"]);
    let Outcome::Invalid(diagnostics) = outcome else {
        unreachable!()
    };
    assert_eq!(diagnostics[0].pointer, "");
    assert!(
        diagnostics[0]
            .detail
            .contains("entry rule and the exit rules"),
        "{}",
        diagnostics[0].detail
    );
}

// --- Classification by dependency --------------------------------------------------------------

#[test]
fn a_changed_indicator_counts_for_every_rule_that_references_it() {
    let parent = base();
    // `weak_threshold` is read by the entry condition only.
    assert_eq!(
        scope_of(
            &parent,
            |v| indicator(v, "weak_threshold")["expr"]["params"]["value"] = json!("32")
        ),
        Scope::Entry
    );
    // `rsi14` is read by the entry condition and the entry rank, and by other indicators.
    assert_eq!(
        scope_of(
            &parent,
            |v| indicator(v, "rsi14")["expr"]["params"]["window"] = json!(10)
        ),
        Scope::Entry
    );
    // `atr14` is read by the entry condition and, through the snapshot entry_atr, by the stop
    // and the target: the fixture case of the contract layer.
    assert_eq!(
        scope_of(
            &parent,
            |v| indicator(v, "atr14")["expr"]["params"]["window"] = json!(10)
        ),
        Scope::Both
    );
}

#[test]
fn a_change_under_a_rule_affects_that_rule() {
    let parent = base();
    type Edit = Box<dyn FnOnce(&mut Value)>;
    let entry: [(&str, Edit); 2] = [
        (
            "condition",
            Box::new(|v| {
                v["definition"]["entry"]["condition"]["args"][0]["args"][1]["params"]["name"] =
                    json!("vol_sma20");
            }),
        ),
        (
            "rank",
            Box::new(|v| {
                v["definition"]["entry"]["rank"]["args"][0]["args"][0]["params"]["value"] =
                    json!("40");
            }),
        ),
    ];
    for (label, edit) in entry {
        assert_eq!(scope_of(&parent, edit), Scope::Entry, "{label}");
    }
    let exits: [(&str, Edit); 2] = [
        (
            "stop multiple",
            Box::new(|v| {
                v["definition"]["exits"]["stop"]["args"][1]["args"][0]["params"]["value"] =
                    json!("3");
            }),
        ),
        (
            "target multiple",
            Box::new(|v| {
                v["definition"]["exits"]["target"]["args"][1]["args"][0]["params"]["value"] =
                    json!("4");
            }),
        ),
    ];
    for (label, edit) in exits {
        assert_eq!(scope_of(&parent, edit), Scope::Exit, "{label}");
    }
}

#[test]
fn an_exit_rule_that_adds_a_stop_adjustment_changes_the_exits_only() {
    // The seed with break-even is the parent; removing the adjustment is an exit change.
    let parent = seed_json(SEEDS[2]);
    let scope = scope_of(&parent, |v| {
        v["definition"]["exits"]["stop_adjustments"] = json!([])
    });
    assert_eq!(scope, Scope::Exit);
}

#[test]
fn a_snapshot_changes_the_entry_by_location_and_the_exits_that_name_it() {
    let parent = base();
    let scope = scope_of(&parent, |v| {
        v["definition"]["entry"]["snapshots"][0]["expr"] = json!({
            "op": "operator:mul@1",
            "args": [
                {"op": "operator:ref@1", "args": [], "params": {"name": "atr14"}},
                {"op": "operator:const@1", "args": [], "params": {"value": "1", "unit": "RATIO"}}
            ],
            "params": {}
        });
    });
    assert_eq!(scope, Scope::Both, "the stop and the target name entry_atr");
    // A snapshot that no exit names changes the entry rule only.
    let scope = scope_of(&parent, |v| {
        v["definition"]["entry"]["snapshots"]
            .as_array_mut()
            .unwrap()
            .push(json!({
                "name": "spare_atr",
                "expr": {"op": "operator:ref@1", "args": [], "params": {"name": "atr14"}}
            }));
    });
    assert_eq!(scope, Scope::Entry);
}

#[test]
fn an_indicator_reached_only_through_another_indicator_counts_transitively() {
    // x -> y -> the entry rank. Changing x affects the entry rule and nothing else.
    let mut parent = base();
    parent["definition"]["indicators"].as_array_mut().unwrap().push(json!({
        "name": "x", "expr": {"op": "operator:const@1", "args": [], "params": {"value": "7", "unit": "POINTS"}}
    }));
    parent["definition"]["indicators"]
        .as_array_mut()
        .unwrap()
        .push(json!({
            "name": "y", "expr": {"op": "operator:add@1", "args": [
                {"op": "operator:ref@1", "args": [], "params": {"name": "x"}},
                {"op": "operator:const@1", "args": [], "params": {"value": "1", "unit": "POINTS"}}
            ], "params": {}}
        }));
    let rank = parent["definition"]["entry"]["rank"].clone();
    parent["definition"]["entry"]["rank"] = json!({"op": "operator:add@1", "args": [
        rank,
        {"op": "operator:ref@1", "args": [], "params": {"name": "y"}}
    ], "params": {}});
    assert_eq!(
        scope_of(&parent, |v| indicator(v, "x")["expr"]["params"]["value"] =
            json!("9")),
        Scope::Entry
    );
}

#[test]
fn an_indicator_that_no_rule_references_is_outside_a_controlled_revision() {
    let mut parent = base();
    parent["definition"]["indicators"].as_array_mut().unwrap().push(json!({
        "name": "spare", "expr": {"op": "operator:const@1", "args": [], "params": {"value": "7", "unit": "POINTS"}}
    }));
    let scope = scope_of(&parent, |v| {
        indicator(v, "spare")["expr"]["params"]["value"] = json!("8")
    });
    assert_eq!(
        scope,
        Scope::Outside("/definition/indicators/8/expr/params/value".to_owned())
    );
    // An added indicator that nothing uses.
    let scope = scope_of(&base(), |v| {
        v["definition"]["indicators"].as_array_mut().unwrap().push(json!({
            "name": "spare", "expr": {"op": "operator:const@1", "args": [], "params": {"value": "7", "unit": "POINTS"}}
        }));
    });
    assert_eq!(scope, Scope::Outside("/definition/indicators".to_owned()));
}

#[test]
fn a_removed_indicator_still_counts_for_the_rules_that_used_it() {
    // The parent reads `atr14` through the snapshot. The child drops the indicator and gives the
    // snapshot a constant: the removal affects the exits through the parent's references, and the
    // snapshot change affects the entry by location, so the revision changes both.
    let scope = scope_of(&base(), |v| {
        v["definition"]["indicators"]
            .as_array_mut()
            .unwrap()
            .retain(|i| i["name"] != "atr14");
        v["definition"]["entry"]["snapshots"][0]["expr"] = json!({"op": "operator:const@1", "args": [], "params": {"value": "2", "unit": "PRICE"}});
    });
    assert_eq!(scope, Scope::Both);
}

#[test]
fn selection_and_the_contract_text_are_outside_a_controlled_revision() {
    let parent = base();
    type Edit = Box<dyn FnOnce(&mut Value)>;
    let edits: [(&str, Edit, &str); 3] = [
        (
            "slots",
            Box::new(|v| v["definition"]["selection"]["slots"] = json!(4)),
            "/definition/selection/slots",
        ),
        (
            "hypothesis",
            Box::new(|v| v["contract"]["hypothesis"] = json!("A new hypothesis.")),
            "/contract/hypothesis",
        ),
        (
            "benchmarks",
            Box::new(|v| v["contract"]["benchmarks"] = json!(["cash"])),
            "/contract/benchmarks/0",
        ),
    ];
    for (label, edit, path) in edits {
        assert_eq!(
            scope_of(&parent, edit),
            Scope::Outside(path.to_owned()),
            "{label}"
        );
    }
}

#[test]
fn a_revision_with_no_change_is_empty() {
    let parent = base();
    assert_eq!(scope_of(&parent, |_| {}), Scope::Empty);
    let outcome = check(&parent, |_| {});
    assert_eq!(codes(&outcome), ["REVISION_SCOPE"]);
}

// --- Diagnostics --------------------------------------------------------------------------------

#[test]
fn a_change_outside_the_rules_names_its_path_and_a_mixed_revision_reports_the_first_outside_path() {
    let parent = base();
    let outcome = check(&parent, |v| {
        v["definition"]["exits"]["stop"]["args"][1]["args"][0]["params"]["value"] = json!("3");
        v["definition"]["selection"]["slots"] = json!(4);
    });
    let Outcome::Invalid(diagnostics) = outcome else {
        panic!("{outcome:?}")
    };
    assert_eq!(diagnostics.len(), 1);
    assert_eq!(diagnostics[0].code, "REVISION_SCOPE");
    assert_eq!(diagnostics[0].pointer, "/definition/selection/slots");
    assert!(
        diagnostics[0].detail.contains("/definition/exits/stop"),
        "{}",
        diagnostics[0].detail
    );
}

#[test]
fn declared_changes_that_differ_from_the_computed_ones_are_a_lineage_mismatch() {
    let parent = base();
    let (p, c) = revise(&parent, |v| {
        v["definition"]["exits"]["stop"]["args"][1]["args"][0]["params"]["value"] = json!("3");
        v["definition"]["exits"]["target"]["args"][1]["args"][0]["params"]["value"] = json!("4");
    });
    type Edit = Box<dyn FnOnce(&mut Value)>;
    let edits: [(&str, Edit); 4] = [
        (
            "too few",
            Box::new(|v| {
                v["parent"]["changes"].as_array_mut().unwrap().pop();
            }),
        ),
        (
            "invented",
            Box::new(|v| {
                v["parent"]["changes"]
                    .as_array_mut()
                    .unwrap()
                    .push(json!({"path": "/definition/sizing/method", "from": "a", "to": "b"}));
            }),
        ),
        (
            "wrong value",
            Box::new(|v| v["parent"]["changes"][0]["to"] = json!("9")),
        ),
        (
            "duplicated",
            Box::new(|v| {
                let first = v["parent"]["changes"][0].clone();
                v["parent"]["changes"].as_array_mut().unwrap().push(first);
            }),
        ),
    ];
    for (label, edit) in edits {
        let mut value = to_value(&c).unwrap();
        edit(&mut value);
        let outcome = check_revision(&p, &artefact(&value), WARMUP).unwrap();
        assert_eq!(codes(&outcome), ["LINEAGE_MISMATCH"], "{label}");
        let Outcome::Invalid(d) = outcome else {
            unreachable!()
        };
        assert_eq!(d[0].pointer, "/parent/changes", "{label}");
    }
}

#[test]
fn a_change_that_renders_longer_than_the_declaration_allows_is_a_lineage_mismatch() {
    // Five more snapshots render as the JSON of five elements, far above the 256 characters of a
    // declared change. The proposer can declare only a cut text, which is not the computed change.
    let parent = base();
    let edit = |v: &mut Value| {
        for n in 1..=5 {
            v["definition"]["entry"]["snapshots"]
                .as_array_mut()
                .unwrap()
                .push(json!({
                    "name": format!("spare_atr_{n}"),
                    "expr": {"op": "operator:ref@1", "args": [], "params": {"name": "atr14"}}
                }));
        }
    };
    let mut child = parent.clone();
    child["version"] = json!(2);
    edit(&mut child);
    let computed = reference(&parent, &child);
    assert_eq!(computed.len(), 1);
    assert!(
        computed[0].to.chars().count() > 256,
        "the case must render long"
    );
    let cut = |text: &str| text.chars().take(256).collect::<String>();
    child["parent"] = json!({
        "hash": payload_digest(&artefact(&parent)).unwrap(),
        "changes": [{"path": computed[0].path, "from": cut(&computed[0].from), "to": cut(&computed[0].to)}],
    });
    let outcome = check_revision(&artefact(&parent), &artefact(&child), WARMUP).unwrap();
    assert_eq!(codes(&outcome), ["LINEAGE_MISMATCH"]);
    let Outcome::Invalid(d) = outcome else {
        unreachable!()
    };
    assert_eq!(d[0].pointer, "/definition/entry/snapshots");
    assert!(
        d[0].detail.contains("cannot be declared"),
        "{}",
        d[0].detail
    );
}

#[test]
fn the_parent_hash_must_be_the_digest_of_the_parent() {
    let parent = base();
    let (p, c) = revise(&parent, |v| {
        v["definition"]["exits"]["stop"]["args"][1]["args"][0]["params"]["value"] = json!("3");
    });
    let mut value = to_value(&c).unwrap();
    value["parent"]["hash"] = json!(format!("sha256:{}", "0".repeat(64)));
    let outcome = check_revision(&p, &artefact(&value), WARMUP).unwrap();
    assert_eq!(codes(&outcome), ["IDENTITY_MISMATCH"]);
    let Outcome::Invalid(d) = outcome else {
        unreachable!()
    };
    assert_eq!(d[0].pointer, "/parent/hash");
    // A revision without a parent member.
    let mut orphan = to_value(&c).unwrap();
    orphan.as_object_mut().unwrap().remove("parent");
    let outcome = check_revision(&p, &artefact(&orphan), WARMUP).unwrap();
    assert!(codes(&outcome).contains(&"LINEAGE_MISMATCH"));
}

#[test]
fn the_lookback_must_fit_the_warmup() {
    let parent = base();
    let (p, c) = revise(&parent, |v| {
        v["definition"]["exits"]["stop"]["args"][1]["args"][0]["params"]["value"] = json!("3");
    });
    // The longest lookback of the seed is 49 sessions: a warm-up of 49 fits and 48 does not.
    assert!(matches!(
        check_revision(&p, &c, LOOKBACK).unwrap(),
        Outcome::ValidRevision { .. }
    ));
    let outcome = check_revision(&p, &c, LOOKBACK - 1).unwrap();
    assert_eq!(codes(&outcome), ["LOOKBACK_EXCEEDS_WARMUP"]);
    let Outcome::Invalid(d) = outcome else {
        unreachable!()
    };
    assert!(
        d[0].detail.contains("49") && d[0].detail.contains("48"),
        "{}",
        d[0].detail
    );
    // A seed has the same rule.
    assert_eq!(
        codes(&check_seed(&seed(SEEDS[0]), LOOKBACK - 1)),
        ["LOOKBACK_EXCEEDS_WARMUP"]
    );
}

#[test]
fn the_shared_validator_decides_the_definition_and_its_code_is_reported_with_its_pointer() {
    let parent = base();
    let outcome = check(&parent, |v| {
        v["definition"]["entry"]["rank"]["op"] = json!("operator:median@1");
    });
    let Outcome::Invalid(diagnostics) = outcome else {
        panic!("{outcome:?}")
    };
    assert_eq!(diagnostics[0].code, "UNSUPPORTED_OPERATOR");
    assert!(
        diagnostics[0].pointer.starts_with('/'),
        "{:?}",
        diagnostics[0]
    );
    // The checks are reported in order: a bad draft can break several at once.
    let outcome = check(&parent, |v| {
        v["definition"]["entry"]["rank"]["op"] = json!("operator:median@1");
        v["definition"]["selection"]["slots"] = json!(4);
    });
    let listed = codes(&outcome);
    assert_eq!(listed.first(), Some(&"UNSUPPORTED_OPERATOR"));
    assert!(listed.contains(&"REVISION_SCOPE"));
}

#[test]
fn a_seed_has_no_parent() {
    let child = seed(SEEDS[1]);
    assert_eq!(codes(&check_seed(&child, WARMUP)), ["LINEAGE_MISMATCH"]);
}

// --- validation-result/1 -------------------------------------------------------------------------

fn context<'a>(
    method: &'a openquant_core::metrics::MethodRef,
    parent: Option<&'a str>,
) -> ValidationContext<'a> {
    ValidationContext {
        job_id: "job-validate-1",
        attempt: json!({"attempt_id": "att-validate-1-1", "ownership_revision": 1}),
        executable: json!({"name": "engine-batch", "version": "0.0.0", "digest": format!("sha256:{}", "cd".repeat(32))}),
        engine_digest: "sha256:7ceafb5e32e05c234b2a4cd2915946d4c6273ea9455d7b4f98821712555bb36a",
        method,
        draft_digest: "sha256:3b2b013c84fb0f64657822298593f8bc24a520c76023b8f18c61ee0e00abb046",
        parent_hash: parent,
        duration: json!({"label": "observed", "milliseconds": 5}),
    }
}

#[test]
fn every_verdict_becomes_a_schema_valid_validation_result() {
    let method = test_method();
    let parent_hash = payload_digest(&seed(SEEDS[0])).unwrap();
    // A valid seed.
    let verdict = check_seed(&seed(SEEDS[0]), WARMUP);
    let result = validation_result(&context(&method, None), &verdict).unwrap();
    let value = to_value(&result).unwrap();
    assert_eq!(
        value["outcome"],
        json!({"status": "VALID", "max_lookback_sessions": LOOKBACK, "warmup_sessions": 60})
    );
    assert!(value.get("parent_hash").is_none());
    // A valid revision, whose computed changes equal the declared ones.
    let verdict = check_revision(&seed(SEEDS[0]), &seed(SEEDS[1]), WARMUP).unwrap();
    let result = validation_result(&context(&method, Some(&parent_hash)), &verdict).unwrap();
    let value = to_value(&result).unwrap();
    assert_eq!(value["outcome"]["status"], "VALID");
    assert_eq!(value["outcome"]["change_scope"], "ENTRY");
    assert_eq!(
        value["outcome"]["computed_changes"],
        seed_json(SEEDS[1])["parent"]["changes"]
    );
    assert_eq!(value["parent_hash"], parent_hash);
    // An invalid revision.
    let verdict = check(&base(), |_| {});
    let result = validation_result(&context(&method, Some(&parent_hash)), &verdict).unwrap();
    let value = to_value(&result).unwrap();
    assert_eq!(value["outcome"]["status"], "INVALID");
    assert_eq!(value["outcome"]["diagnostics"][0]["code"], "REVISION_SCOPE");
    // The finished result parses as the contract.
    parse::<g::ValidationResult>(&value.to_string()).unwrap();
}

#[test]
fn a_verdict_of_the_wrong_form_is_refused() {
    let method = test_method();
    let seed_verdict = check_seed(&seed(SEEDS[0]), WARMUP);
    assert!(validation_result(&context(&method, Some("sha256:00")), &seed_verdict).is_err());
    let revision = check_revision(&seed(SEEDS[0]), &seed(SEEDS[1]), WARMUP).unwrap();
    assert!(validation_result(&context(&method, None), &revision).is_err());
}

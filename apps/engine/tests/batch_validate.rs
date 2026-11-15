//! The `validate` job through the worker: the shared strategy validator, the cohort warm-up and the
//! lineage checks of a revision (OQ-02 sections 3.1 and 4; OQ-05 section 4).
//!
//! The drafts are the five S0 seed artefacts, whose declared changes the S0 fixtures derived
//! independently, and small edits of them. The leaf difference used to declare a change is a second
//! implementation written here, so the worker's recomputation is checked against it.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

mod batch_support;

use std::collections::BTreeSet;

use batch_support::{Harness, data::*, worker_handled};
use openquant_contracts::{
    canonical::digest_bytes, generated::StrategyArtefact, parse, payload_digest,
};
use openquant_engine::batch::worker::Handled;
use serde_json::{Value, json};

const RESULT: &str = "attempts.validation-result";

/// The longest lookback of the seeds, derived by hand: the 50-session mean reads the decision
/// session and the 49 sessions before it, and the lagged 14-session RSI needs fewer.
const LOOKBACK: u64 = 49;
/// The warm-up of the pilot cohort policy.
const WARMUP: u64 = 60;

fn leaf_changes(path: &str, a: &Value, b: &Value, out: &mut Vec<(String, Value, Value)>) {
    match (a, b) {
        (Value::Object(x), Value::Object(y)) => {
            let keys: BTreeSet<&String> = x.keys().chain(y.keys()).collect();
            for key in keys {
                let child = format!("{path}/{key}");
                match (x.get(key), y.get(key)) {
                    (Some(l), Some(r)) => leaf_changes(&child, l, r, out),
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
                leaf_changes(&format!("{path}/{index}"), l, r, out);
            }
        }
        _ => {
            if a != b {
                out.push((path.to_owned(), a.clone(), b.clone()));
            }
        }
    }
}

/// How a changed value is declared: text as it is, a list as its ids, anything else as JSON.
fn rendered(value: &Value) -> String {
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

fn hash_of(artefact: &Value) -> String {
    let typed: StrategyArtefact = parse(&artefact.to_string()).unwrap();
    payload_digest(&typed).unwrap()
}

/// `child` as a revision of `parent`: it names the parent's hash and declares the leaf difference.
fn revision_of(parent: &Value, child: &Value) -> Value {
    let body = |value: &Value| {
        let mut value = value.clone();
        for key in ["strategy_id", "version", "parent"] {
            value.as_object_mut().unwrap().remove(key);
        }
        value
    };
    let mut changes = Vec::new();
    leaf_changes("", &body(parent), &body(child), &mut changes);
    let mut revised = child.clone();
    revised["parent"] = json!({
        "hash": hash_of(parent),
        "changes": changes.iter().map(|(path, from, to)| json!({
            "path": path, "from": rendered(from), "to": rendered(to),
        })).collect::<Vec<_>>(),
    });
    revised
}

fn validate(draft: &Value, parent: Option<&Value>, tag: &str) -> Value {
    let harness = Harness::new();
    let job = harness.enqueue_validate(draft, parent, tag);
    let handled = worker_handled(&harness.poll(), &job.message);
    assert!(
        matches!(handled, Handled::Completed { acked: true, .. }),
        "{tag}: {handled:?}\n{}",
        harness.log_text()
    );
    let world = harness.world();
    let accepted = world.accepted_on(RESULT);
    assert_eq!(accepted.len(), 1, "{tag}");
    accepted[0].body.clone()
}

fn diagnostics(result: &Value) -> Vec<(String, String)> {
    result["outcome"]["diagnostics"]
        .as_array()
        .unwrap_or_else(|| panic!("no diagnostics in {result}"))
        .iter()
        .map(|d| {
            (
                d["code"].as_str().unwrap().to_owned(),
                d["pointer"].as_str().unwrap().to_owned(),
            )
        })
        .collect()
}

#[test]
fn a_seed_is_valid_with_its_longest_lookback_and_the_cohort_warmup() {
    let draft = seed(1);
    let result = validate(&draft, None, "seed");
    assert_eq!(result["outcome"]["status"], "VALID");
    assert_eq!(result["outcome"]["max_lookback_sessions"], LOOKBACK);
    assert_eq!(result["outcome"]["warmup_sessions"], WARMUP);
    assert!(
        result.get("parent_hash").is_none(),
        "the seed form has no parent"
    );
    // The result names the draft by the digest of its stored bytes and carries the identities.
    assert_eq!(
        result["draft_digest"],
        digest_bytes(canonical(&draft).as_bytes())
    );
    assert_eq!(result["draft_digest"], hash_of(&draft));
    assert_eq!(result["engine_digest"], ENGINE_DIGEST);
    assert_eq!(result["method"]["digest"], METHOD_DIGEST);
    assert_eq!(result["executable"]["name"], "engine-batch");
    assert_eq!(result["duration"]["label"], "observed");
}

#[test]
fn each_s0_revision_is_valid_with_the_scope_of_the_rule_it_changes() {
    // seed 2 changes the weakness threshold (an entry rule); seed 3 adds break-even (an exit
    // rule); seed 4 adds break-even to seed 2 (an exit rule). Their declared changes are the ones
    // that the S0 fixtures derived.
    let cases = [(2, 1, "ENTRY"), (3, 1, "EXIT"), (4, 2, "EXIT")];
    for (child, parent, scope) in cases {
        let (parent_artefact, draft) = (seed(parent), seed(child));
        let result = validate(&draft, Some(&parent_artefact), &format!("rev{child}"));
        assert_eq!(
            result["outcome"]["status"], "VALID",
            "seed {child}: {result}"
        );
        assert_eq!(result["outcome"]["change_scope"], scope, "seed {child}");
        assert_eq!(result["outcome"]["max_lookback_sessions"], LOOKBACK);
        assert_eq!(result["parent_hash"], hash_of(&parent_artefact));
        assert_eq!(
            result["outcome"]["computed_changes"], draft["parent"]["changes"],
            "seed {child}: the computed difference is the declared one"
        );
    }
}

#[test]
fn a_revision_that_changes_entry_and_exit_is_refused_with_revision_scope() {
    // Seed 4 differs from seed 1 in the threshold (entry) and in break-even (exit).
    let (parent, child) = (seed(1), seed(4));
    let draft = revision_of(&parent, &child);
    assert_eq!(
        draft["parent"]["changes"].as_array().unwrap().len(),
        2,
        "two honest changes"
    );
    let result = validate(&draft, Some(&parent), "both");
    assert_eq!(result["outcome"]["status"], "INVALID");
    assert_eq!(
        diagnostics(&result),
        vec![("REVISION_SCOPE".to_owned(), String::new())]
    );
    let detail = result["outcome"]["diagnostics"][0]["detail"]
        .as_str()
        .unwrap();
    assert!(detail.contains("entry rule and the exit rules"), "{detail}");
}

#[test]
fn a_change_outside_entry_and_exit_is_refused_with_revision_scope_at_its_pointer() {
    // A different slot count of the selection rule is neither an entry nor an exit change.
    let parent = seed(1);
    let mut child = parent.clone();
    child["definition"]["selection"]["slots"] = json!(3);
    child["version"] = json!(2);
    let draft = revision_of(&parent, &child);
    let result = validate(&draft, Some(&parent), "selection");
    assert_eq!(result["outcome"]["status"], "INVALID");
    assert_eq!(
        diagnostics(&result),
        vec![(
            "REVISION_SCOPE".to_owned(),
            "/definition/selection/slots".to_owned()
        )]
    );
}

#[test]
fn a_revision_that_changes_nothing_is_not_a_controlled_revision() {
    let parent = seed(1);
    let mut child = parent.clone();
    child["version"] = json!(2);
    // The honest declaration of "no change" is an empty list, which the contract does not allow
    // an artefact to carry, so the draft declares one change that is not there.
    child["parent"] = json!({"hash": hash_of(&parent), "changes": [
        {"path": "/definition/selection/slots", "from": "5", "to": "5"},
    ]});
    let result = validate(&child, Some(&parent), "nothing");
    assert_eq!(result["outcome"]["status"], "INVALID");
    let codes: Vec<String> = diagnostics(&result).into_iter().map(|(c, _)| c).collect();
    assert!(codes.contains(&"REVISION_SCOPE".to_owned()), "{codes:?}");
    assert!(
        codes.contains(&"LINEAGE_MISMATCH".to_owned()),
        "the declared change is not real: {codes:?}"
    );
}

#[test]
fn a_declaration_that_differs_from_the_recomputed_difference_is_a_lineage_mismatch() {
    let (parent, child) = (seed(1), seed(2));
    let mut draft = child.clone();
    draft["parent"]["changes"][0]["to"] = json!("99");
    let result = validate(&draft, Some(&parent), "lineage");
    assert_eq!(result["outcome"]["status"], "INVALID");
    assert_eq!(
        diagnostics(&result),
        vec![("LINEAGE_MISMATCH".to_owned(), "/parent/changes".to_owned())]
    );
}

#[test]
fn a_draft_that_names_another_parent_than_the_one_given_is_an_identity_mismatch() {
    let (parent, child) = (seed(1), seed(2));
    // Seed 2 declares seed 1 as its parent: given seed 3 as the parent, the hash differs.
    let wrong_parent = seed(3);
    let result = validate(&child, Some(&wrong_parent), "identity");
    assert_eq!(result["outcome"]["status"], "INVALID");
    assert!(
        diagnostics(&result).contains(&("IDENTITY_MISMATCH".to_owned(), "/parent/hash".to_owned()))
    );
    let _ = parent;
}

#[test]
fn a_seed_that_names_a_parent_and_a_revision_that_does_not_are_lineage_mismatches() {
    let result = validate(&seed(2), None, "orphan");
    assert_eq!(result["outcome"]["status"], "INVALID");
    assert_eq!(
        diagnostics(&result),
        vec![("LINEAGE_MISMATCH".to_owned(), "/parent".to_owned())]
    );

    let result = validate(&seed(1), Some(&seed(2)), "no-parent-named");
    assert_eq!(result["outcome"]["status"], "INVALID");
    assert!(diagnostics(&result).contains(&("LINEAGE_MISMATCH".to_owned(), "/parent".to_owned())));
}

#[test]
fn a_lookback_longer_than_the_warmup_is_refused_with_the_numbers() {
    // A 62-session mean reads the decision session and 61 before it: longer than 60.
    let mut draft = seed(1);
    draft["definition"]["indicators"][0]["expr"]["params"]["window"] = json!(62);
    let result = validate(&draft, None, "lookback");
    assert_eq!(result["outcome"]["status"], "INVALID");
    assert_eq!(
        diagnostics(&result),
        vec![("LOOKBACK_EXCEEDS_WARMUP".to_owned(), String::new())]
    );
    let detail = result["outcome"]["diagnostics"][0]["detail"]
        .as_str()
        .unwrap();
    assert!(
        detail.contains("61 sessions") && detail.contains("60 sessions"),
        "{detail}"
    );
    // At the limit it passes: a 61-session mean has lookback 60.
    let mut at_limit = seed(1);
    at_limit["definition"]["indicators"][0]["expr"]["params"]["window"] = json!(61);
    let result = validate(&at_limit, None, "at-limit");
    assert_eq!(result["outcome"]["status"], "VALID");
    assert_eq!(result["outcome"]["max_lookback_sessions"], 60);
}

#[test]
fn a_definition_that_the_shared_validator_refuses_is_invalid_with_its_code_and_pointer() {
    let mut draft = seed(1);
    draft["definition"]["indicators"][0]["expr"]["op"] = json!("operator:nonexistent@1");
    let result = validate(&draft, None, "operator");
    assert_eq!(result["outcome"]["status"], "INVALID");
    let found = diagnostics(&result);
    assert_eq!(found.len(), 1, "{found:?}");
    assert_eq!(found[0].0, "UNSUPPORTED_OPERATOR");
    assert!(
        found[0].1.starts_with("/definition/indicators/0"),
        "{found:?}"
    );
}

#[test]
fn a_draft_that_is_not_a_strategy_artefact_is_invalid_with_the_contract_code() {
    let harness = Harness::new();
    // Not an artefact at all.
    let mut broken = seed(1);
    broken.as_object_mut().unwrap().remove("definition");
    let job = harness.enqueue_validate(&broken, None, "broken");
    let handled = worker_handled(&harness.poll(), &job.message);
    assert!(
        matches!(handled, Handled::Completed { acked: true, .. }),
        "{handled:?}"
    );
    let result = harness.world().accepted_on(RESULT)[0].body.clone();
    assert_eq!(result["outcome"]["status"], "INVALID");
    assert_eq!(
        result["outcome"]["diagnostics"][0]["code"],
        "SCHEMA_VIOLATION"
    );
    assert!(
        !result["outcome"]["diagnostics"][0]["detail"]
            .as_str()
            .unwrap()
            .is_empty()
    );

    // Another schema version.
    let mut other = seed(1);
    other["schema_version"] = json!("strategy-artefact/2");
    let job = harness.enqueue_validate(&other, None, "version");
    let handled = worker_handled(&harness.poll(), &job.message);
    assert!(
        matches!(handled, Handled::Completed { acked: true, .. }),
        "{handled:?}"
    );
    let accepted = harness
        .world()
        .accepted_on(RESULT)
        .into_iter()
        .map(|a| a.body.clone())
        .collect::<Vec<_>>();
    assert_eq!(
        accepted[1]["outcome"]["diagnostics"][0]["code"],
        "UNSUPPORTED_SCHEMA_VERSION"
    );
}

#[test]
fn a_draft_stored_in_a_form_that_is_not_canonical_is_an_identity_mismatch() {
    let harness = Harness::new();
    let draft = seed(1);
    let policy_ref = harness.world().store_json(&cohort_policy());
    // The same document with whitespace and the original key order: its bytes hash to another
    // digest than its payload does.
    let pretty = serde_json::to_vec_pretty(&draft).unwrap();
    let draft_ref = harness.world().store(&pretty);
    let dispatch = batch_support::dispatch_value(
        "job-validate-pretty",
        "att-validate-pretty-1",
        1,
        json!({"kind": "validate", "draft": draft_ref, "cohort_policy": policy_ref}),
    );
    let message = harness.world().enqueue(&dispatch);
    let handled = worker_handled(&harness.poll(), &message);
    assert!(
        matches!(handled, Handled::Completed { acked: true, .. }),
        "{handled:?}"
    );
    let result = harness.world().accepted_on(RESULT)[0].body.clone();
    assert_eq!(result["outcome"]["status"], "INVALID");
    assert_eq!(
        result["outcome"]["diagnostics"][0]["code"],
        "IDENTITY_MISMATCH"
    );
    assert_eq!(result["draft_digest"], digest_bytes(&pretty));
}

#[test]
fn a_draft_that_the_attempt_cannot_read_ends_the_job_without_a_result() {
    let harness = Harness::new();
    let job = harness.enqueue_validate(&seed(1), None, "unreadable");
    let digest = job.request.clone();
    let _ = digest;
    // The API refuses to serve the draft: no verdict can be written about what was not read.
    let draft_digest = hash_of(&seed(1));
    harness.world().unreadable.insert(draft_digest);
    let handled = worker_handled(&harness.poll(), &job.message);
    let Handled::Abandoned { reason } = handled else {
        panic!("{handled:?}");
    };
    assert!(reason.contains("NOT_FOUND"), "{reason}");
    assert!(harness.world().accepted.is_empty());
    assert!(!harness.world().is_acked(&job.message));
}

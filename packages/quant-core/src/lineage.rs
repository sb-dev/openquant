//! Strategy lineage and the derived checks of the `validate` job (OQ-02 sections 3.1 and 4;
//! OQ-03 section 3).
//!
//! A controlled revision changes entry rules or exit rules, not both. The proposer declares its
//! rule differences in `parent.changes`; this module recomputes them from the two artefacts, at the
//! level of the changed definition leaves, classifies them by dependency and reports the
//! diagnostics of `validation-result/1`. The TypeScript parse of the proposer's result compares the
//! same declared differences; the shared fixtures show that both agree.
//!
//! # Leaf differences
//!
//! Both artefacts are compared as JSON without the members that identify the version
//! (`strategy_id`, `version`, `parent`). Objects are compared member by member, arrays of equal
//! length element by element; a missing member, a different length or a different scalar is one
//! change at its path. A changed value is written as text the way a declared change writes it:
//! a string as itself, an empty array as `[]`, an array of named rules as their ids joined by
//! `,`, anything else as its JSON text. A declared change holds at most 256 characters
//! (`strategy-artefact/1`), so a change that renders longer cannot be declared and the revision
//! reports `LINEAGE_MISMATCH`.
//!
//! # Classification by dependency
//!
//! * A change under `/definition/entry` affects the entry rule, and one under `/definition/exits`
//!   the exit rules.
//! * A changed indicator affects every rule that references it, directly or through other
//!   indicators. The entry rule reads indicators through `operator:ref@1`. The exit rules read no
//!   indicator: they read the snapshots of the entry rule through `operator:snapshot@1`, and a
//!   snapshot expression reads indicators. So an indicator that a snapshot reads also affects every
//!   exit rule that names the snapshot. A change to a snapshot expression affects the entry rule by
//!   location and the exit rules that name it.
//! * A change to selection, sizing or execution, to an indicator that no rule references, or
//!   anywhere outside the definition (the operator set, the contract text) is outside a
//!   controlled revision.
//!
//! References are read from both artefacts, so a removed indicator still counts for the rules that
//! used to reference it.

use std::collections::{BTreeMap, BTreeSet};

use openquant_contracts::{
    StrategyArtefact, generated as g, parse_value, payload_digest, to_value,
};
use serde_json::{Value, json};
use thiserror::Error;

use crate::{metrics::MethodRef, numeric::truncate_on_boundary, strategy::validate_strategy};

const MAX_FIELD: usize = 256;
const MAX_DETAIL: usize = 1000;
const MAX_DIAGNOSTICS: usize = 64;

/// A failure of the lineage module itself, not a verdict on a draft.
#[derive(Debug, Error)]
pub enum LineageError {
    #[error("an artefact could not be read as JSON: {0}")]
    Json(String),
    #[error("the validation result failed its own schema: {0}")]
    Contract(String),
}

/// One difference between two artefacts.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LeafChange {
    /// JSON Pointer of the changed leaf or subtree.
    pub path: String,
    pub from: Value,
    pub to: Value,
}

/// A change as `strategy-artefact/1` declares it.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct DeclaredChange {
    pub path: String,
    pub from: String,
    pub to: String,
}

fn artefact_value(artefact: &StrategyArtefact) -> Result<Value, LineageError> {
    to_value(artefact).map_err(|e| LineageError::Json(e.to_string()))
}

/// The artefact as compared: without the members that identify the version.
fn body(artefact: &StrategyArtefact) -> Result<Value, LineageError> {
    let mut value = artefact_value(artefact)?;
    if let Some(object) = value.as_object_mut() {
        for key in ["strategy_id", "version", "parent"] {
            object.remove(key);
        }
    }
    Ok(value)
}

fn walk(path: &str, a: &Value, b: &Value, out: &mut Vec<LeafChange>) {
    match (a, b) {
        (Value::Object(x), Value::Object(y)) => {
            let keys: BTreeSet<&String> = x.keys().chain(y.keys()).collect();
            for key in keys {
                let child = format!("{path}/{key}");
                match (x.get(key), y.get(key)) {
                    (Some(l), Some(r)) => walk(&child, l, r, out),
                    (l, r) => out.push(LeafChange {
                        path: child,
                        from: l.cloned().unwrap_or(Value::Null),
                        to: r.cloned().unwrap_or(Value::Null),
                    }),
                }
            }
        }
        (Value::Array(x), Value::Array(y)) if x.len() == y.len() => {
            for (index, (l, r)) in x.iter().zip(y).enumerate() {
                walk(&format!("{path}/{index}"), l, r, out);
            }
        }
        _ => {
            if a != b {
                out.push(LeafChange {
                    path: path.to_owned(),
                    from: a.clone(),
                    to: b.clone(),
                });
            }
        }
    }
}

/// The leaf differences between a parent and a child, in path order.
///
/// # Errors
/// [`LineageError::Json`] if an artefact cannot be read as JSON.
pub fn leaf_changes(
    parent: &StrategyArtefact,
    child: &StrategyArtefact,
) -> Result<Vec<LeafChange>, LineageError> {
    let mut out = Vec::new();
    walk("", &body(parent)?, &body(child)?, &mut out);
    Ok(out)
}

/// How a changed value is written in a declared change.
#[must_use]
pub fn render(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Array(items) if items.is_empty() => "[]".to_owned(),
        Value::Array(items) => items
            .iter()
            .map(|item| {
                item.get("id")
                    .and_then(Value::as_str)
                    .map_or_else(|| item.to_string(), str::to_owned)
            })
            .collect::<Vec<_>>()
            .join(","),
        other => other.to_string(),
    }
}

/// The rules a change affects.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Affects {
    pub entry: bool,
    pub exit: bool,
}

impl Affects {
    fn outside(self) -> bool {
        !self.entry && !self.exit
    }
}

/// One leaf change with the rules it affects.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Classified {
    pub change: LeafChange,
    pub affects: Affects,
}

/// The scope of a revision.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Scope {
    /// Every change affects only the entry rule.
    Entry,
    /// Every change affects only the exit rules.
    Exit,
    /// A revision with no change.
    Empty,
    /// The changes affect both rules.
    Both,
    /// A change is outside a controlled revision; the first such path.
    Outside(String),
}

/// The references of one definition that classification needs.
struct Graph {
    /// Indicators that the entry rule reads, directly, through other indicators or through the
    /// expressions of its snapshots.
    entry_indicators: BTreeSet<String>,
    /// Snapshots that an exit rule names.
    exit_snapshots: BTreeSet<String>,
    /// Indicators that an exit rule reads through the snapshots it names.
    exit_indicators: BTreeSet<String>,
}

/// A definition and what it references.
struct Side {
    definition: Value,
    graph: Graph,
}

fn collect(expr: &Value, operator: &str, out: &mut BTreeSet<String>) {
    if let Some(object) = expr.as_object() {
        if object.get("op").and_then(Value::as_str) == Some(operator)
            && let Some(name) = object
                .get("params")
                .and_then(|p| p.get("name"))
                .and_then(Value::as_str)
        {
            out.insert(name.to_owned());
        }
        if let Some(args) = object.get("args").and_then(Value::as_array) {
            for arg in args {
                collect(arg, operator, out);
            }
        }
    }
}

fn named(items: Option<&Value>) -> Vec<(String, &Value)> {
    items
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(|item| {
                    Some((
                        item.get("name")?.as_str()?.to_owned(),
                        item.get("expr").unwrap_or(&Value::Null),
                    ))
                })
                .collect()
        })
        .unwrap_or_default()
}

fn closure(
    start: BTreeSet<String>,
    reads: &BTreeMap<String, BTreeSet<String>>,
) -> BTreeSet<String> {
    let mut seen = start.clone();
    let mut stack: Vec<String> = start.into_iter().collect();
    while let Some(name) = stack.pop() {
        for next in reads.get(&name).into_iter().flatten() {
            if seen.insert(next.clone()) {
                stack.push(next.clone());
            }
        }
    }
    seen
}

impl Side {
    fn new(definition: Value) -> Self {
        let mut reads = BTreeMap::new();
        for (name, expr) in named(definition.get("indicators")) {
            let mut direct = BTreeSet::new();
            collect(expr, "operator:ref@1", &mut direct);
            reads.insert(name, direct);
        }
        let entry = definition.get("entry").unwrap_or(&Value::Null);
        let mut entry_direct = BTreeSet::new();
        for key in ["condition", "rank"] {
            collect(
                entry.get(key).unwrap_or(&Value::Null),
                "operator:ref@1",
                &mut entry_direct,
            );
        }
        let mut snapshot_reads: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
        for (name, expr) in named(entry.get("snapshots")) {
            let mut direct = BTreeSet::new();
            collect(expr, "operator:ref@1", &mut direct);
            entry_direct.extend(direct.iter().cloned());
            snapshot_reads.insert(name, direct);
        }
        let exits = definition.get("exits").unwrap_or(&Value::Null);
        let mut exit_snapshots = BTreeSet::new();
        for key in ["stop", "target"] {
            collect(
                exits.get(key).unwrap_or(&Value::Null),
                "operator:snapshot@1",
                &mut exit_snapshots,
            );
        }
        let adjustments = exits
            .get("stop_adjustments")
            .and_then(Value::as_array)
            .map(Vec::as_slice)
            .unwrap_or_default();
        for adjustment in adjustments {
            for key in ["trigger", "new_level"] {
                collect(
                    adjustment.get(key).unwrap_or(&Value::Null),
                    "operator:snapshot@1",
                    &mut exit_snapshots,
                );
            }
        }
        let exit_direct: BTreeSet<String> = exit_snapshots
            .iter()
            .filter_map(|snapshot| snapshot_reads.get(snapshot))
            .flatten()
            .cloned()
            .collect();
        let graph = Graph {
            entry_indicators: closure(entry_direct, &reads),
            exit_indicators: closure(exit_direct, &reads),
            exit_snapshots,
        };
        Self { definition, graph }
    }

    /// The names of the elements of a list of named expressions, all of them or the one at
    /// `index`.
    fn names(&self, list: &[&str], index: Option<usize>) -> BTreeSet<String> {
        let node = list
            .iter()
            .try_fold(&self.definition, |node, key| node.get(*key));
        node.and_then(Value::as_array)
            .map(Vec::as_slice)
            .unwrap_or_default()
            .iter()
            .enumerate()
            .filter(|(i, _)| index.is_none_or(|wanted| *i == wanted))
            .filter_map(|(_, item)| item.get("name").and_then(Value::as_str).map(str::to_owned))
            .collect()
    }

    /// The expression of each named element.
    fn expressions(&self, list: &[&str]) -> BTreeMap<String, Value> {
        let node = list
            .iter()
            .try_fold(&self.definition, |node, key| node.get(*key));
        named(node)
            .into_iter()
            .map(|(name, expr)| (name, expr.clone()))
            .collect()
    }
}

/// The names that a change to a list of named expressions touches: the element at `index`, in
/// either artefact, or for a change of the whole list the names that exist on one side only and
/// the names whose expression differs.
fn touched(parent: &Side, child: &Side, list: &[&str], index: Option<usize>) -> BTreeSet<String> {
    let mut names = parent.names(list, index);
    names.extend(child.names(list, index));
    if index.is_some() {
        return names;
    }
    let (before, after) = (parent.expressions(list), child.expressions(list));
    names
        .into_iter()
        .filter(|name| before.get(name) != after.get(name))
        .collect()
}

fn classify_change(change: &LeafChange, parent: &Side, child: &Side) -> Affects {
    let tokens: Vec<&str> = change.path.split('/').skip(1).collect();
    let (Some(&"definition"), Some(&section)) = (tokens.first(), tokens.get(1)) else {
        return Affects::default();
    };
    let rest = tokens.get(2..).unwrap_or_default();
    let mut affects = Affects::default();
    match section {
        "exits" => affects.exit = true,
        "entry" => {
            affects.entry = true;
            if rest.first() == Some(&"snapshots") {
                let index = rest.get(1).and_then(|t| t.parse::<usize>().ok());
                let names = touched(parent, child, &["entry", "snapshots"], index);
                affects.exit = [parent, child]
                    .iter()
                    .any(|side| names.iter().any(|n| side.graph.exit_snapshots.contains(n)));
            }
        }
        "indicators" => {
            let index = rest.first().and_then(|t| t.parse::<usize>().ok());
            let names = touched(parent, child, &["indicators"], index);
            for side in [parent, child] {
                affects.entry |= names
                    .iter()
                    .any(|n| side.graph.entry_indicators.contains(n));
                affects.exit |= names.iter().any(|n| side.graph.exit_indicators.contains(n));
            }
        }
        _ => {}
    }
    affects
}

fn scope_of(changes: &[Classified]) -> Scope {
    if changes.is_empty() {
        return Scope::Empty;
    }
    if let Some(outside) = changes.iter().find(|c| c.affects.outside()) {
        return Scope::Outside(outside.change.path.clone());
    }
    let entry = changes.iter().any(|c| c.affects.entry);
    let exit = changes.iter().any(|c| c.affects.exit);
    match (entry, exit) {
        (true, false) => Scope::Entry,
        (false, true) => Scope::Exit,
        _ => Scope::Both,
    }
}

/// Classify the differences between a parent and a child by the rules they affect.
///
/// # Errors
/// [`LineageError::Json`] if an artefact cannot be read as JSON.
pub fn classify(
    parent: &StrategyArtefact,
    child: &StrategyArtefact,
) -> Result<(Vec<Classified>, Scope), LineageError> {
    let definition = |artefact: &StrategyArtefact| -> Result<Side, LineageError> {
        Ok(Side::new(
            artefact_value(artefact)?
                .get("definition")
                .cloned()
                .unwrap_or(Value::Null),
        ))
    };
    let (before, after) = (definition(parent)?, definition(child)?);
    let classified: Vec<Classified> = leaf_changes(parent, child)?
        .into_iter()
        .map(|change| {
            let affects = classify_change(&change, &before, &after);
            Classified { change, affects }
        })
        .collect();
    let scope = scope_of(&classified);
    Ok((classified, scope))
}

// -------------------------------------------------------------------------------------------
// The validate job's checks
// -------------------------------------------------------------------------------------------

/// A diagnostic of `validation-result/1`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Diagnostic {
    /// One of the codes of the schema.
    pub code: &'static str,
    /// JSON Pointer into the artefact, or empty.
    pub pointer: String,
    pub detail: String,
}

fn diagnostic(code: &'static str, pointer: &str, detail: &str) -> Diagnostic {
    Diagnostic {
        code,
        pointer: truncate_on_boundary(pointer, MAX_FIELD).to_owned(),
        detail: truncate_on_boundary(detail, MAX_DETAIL).to_owned(),
    }
}

/// The verdict of a `validate` job on a draft.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Outcome {
    ValidSeed {
        max_lookback: usize,
        warmup: usize,
    },
    ValidRevision {
        max_lookback: usize,
        warmup: usize,
        /// The declared changes, which equal the computed ones.
        changes: Vec<DeclaredChange>,
        /// `ENTRY` or `EXIT`.
        scope: &'static str,
    },
    /// The diagnostics, at most 64.
    Invalid(Vec<Diagnostic>),
}

/// The codes of the schema that the shared validator can return as they are.
const VALIDATOR_CODES: [&str; 7] = [
    "UNSUPPORTED_SCHEMA_VERSION",
    "SCHEMA_VIOLATION",
    "INVALID_DECIMAL",
    "UNSUPPORTED_OPERATOR",
    "OPERATOR_TYPE_MISMATCH",
    "OPERATOR_UNIT_MISMATCH",
    "INVALID_PARAMETER",
];

fn validator_diagnostic(failure: &crate::Failure) -> Diagnostic {
    let code = failure.code.to_string();
    // The validator writes its detail as `<pointer>: <message>`.
    let (pointer, message) = match failure.detail.split_once(": ") {
        Some((pointer, message)) if pointer.starts_with('/') => (pointer, message),
        _ => ("", failure.detail.as_str()),
    };
    match VALIDATOR_CODES.iter().find(|known| **known == code) {
        Some(known) => diagnostic(known, pointer, message),
        None => diagnostic("SCHEMA_VIOLATION", pointer, &format!("{code}: {message}")),
    }
}

fn lookback(
    artefact: &StrategyArtefact,
    warmup: usize,
    diagnostics: &mut Vec<Diagnostic>,
) -> usize {
    match validate_strategy(artefact) {
        Ok(strategy) => {
            if strategy.max_lookback > warmup {
                diagnostics.push(diagnostic(
                    "LOOKBACK_EXCEEDS_WARMUP",
                    "",
                    &format!(
                        "The longest lookback is {} sessions; the cohort warm-up is {warmup} sessions.",
                        strategy.max_lookback
                    ),
                ));
            }
            strategy.max_lookback
        }
        Err(failure) => {
            diagnostics.push(validator_diagnostic(&failure));
            0
        }
    }
}

fn declared_changes(artefact: &Value) -> Vec<DeclaredChange> {
    artefact
        .get("parent")
        .and_then(|p| p.get("changes"))
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default()
        .iter()
        .filter_map(|c| {
            Some(DeclaredChange {
                path: c.get("path")?.as_str()?.to_owned(),
                from: c.get("from")?.as_str()?.to_owned(),
                to: c.get("to")?.as_str()?.to_owned(),
            })
        })
        .collect()
}

fn finish(diagnostics: Vec<Diagnostic>, valid: impl FnOnce() -> Outcome) -> Outcome {
    if diagnostics.is_empty() {
        valid()
    } else {
        Outcome::Invalid(diagnostics.into_iter().take(MAX_DIAGNOSTICS).collect())
    }
}

/// Validate a seed draft against the cohort warm-up.
///
/// A seed has no parent, so it has no rule changes and no change scope.
#[must_use]
pub fn check_seed(seed: &StrategyArtefact, warmup: usize) -> Outcome {
    let mut diagnostics = Vec::new();
    if let Ok(value) = artefact_value(seed)
        && value.get("parent").is_some()
    {
        diagnostics.push(diagnostic(
            "LINEAGE_MISMATCH",
            "/parent",
            "A seed has no parent.",
        ));
    }
    let max_lookback = lookback(seed, warmup, &mut diagnostics);
    finish(diagnostics, || Outcome::ValidSeed {
        max_lookback,
        warmup,
    })
}

fn scope_detail(changes: &[Classified]) -> String {
    let name = |affects: Affects| match (affects.entry, affects.exit) {
        (true, true) => "the entry rule and the exit rules",
        (true, false) => "the entry rule",
        (false, true) => "the exit rules",
        (false, false) => "no rule of a controlled revision",
    };
    let listed: Vec<String> = changes
        .iter()
        .map(|c| format!("{} affects {}", c.change.path, name(c.affects)))
        .collect();
    listed.join("; ")
}

/// Validate a revision draft against its parent and the cohort warm-up: the identity of the
/// parent, the shared validator, the lookback, the declared rule differences and the scope.
///
/// # Errors
/// [`LineageError::Json`] if an artefact cannot be read as JSON.
pub fn check_revision(
    parent: &StrategyArtefact,
    child: &StrategyArtefact,
    warmup: usize,
) -> Result<Outcome, LineageError> {
    let mut diagnostics = Vec::new();
    let child_value = artefact_value(child)?;
    match child_value
        .get("parent")
        .and_then(|p| p.get("hash"))
        .and_then(Value::as_str)
    {
        None => diagnostics.push(diagnostic(
            "LINEAGE_MISMATCH",
            "/parent",
            "A revision names its parent.",
        )),
        Some(named) => {
            let actual = payload_digest(parent).map_err(|e| LineageError::Json(e.to_string()))?;
            if named != actual {
                diagnostics.push(diagnostic(
                    "IDENTITY_MISMATCH",
                    "/parent/hash",
                    &format!(
                        "The draft names the parent {named}; the digest of the parent is {actual}."
                    ),
                ));
            }
        }
    }
    let max_lookback = lookback(child, warmup, &mut diagnostics);
    let (classified, scope) = classify(parent, child)?;
    let computed: Vec<DeclaredChange> = classified
        .iter()
        .map(|c| DeclaredChange {
            path: c.change.path.clone(),
            from: render(&c.change.from),
            to: render(&c.change.to),
        })
        .collect();
    let declared = declared_changes(&child_value);
    if let Some(long) = computed.iter().find(|c| {
        c.path.chars().count() > MAX_FIELD
            || c.from.chars().count() > MAX_FIELD
            || c.to.chars().count() > MAX_FIELD
    }) {
        diagnostics.push(diagnostic(
            "LINEAGE_MISMATCH",
            &long.path,
            &format!(
                "The change at {} renders longer than {MAX_FIELD} characters and cannot be declared.",
                long.path
            ),
        ));
    } else {
        let computed_set: BTreeSet<&DeclaredChange> = computed.iter().collect();
        let declared_set: BTreeSet<&DeclaredChange> = declared.iter().collect();
        if computed_set != declared_set || declared.len() != declared_set.len() {
            let paths = |a: &BTreeSet<&DeclaredChange>, b: &BTreeSet<&DeclaredChange>| {
                a.difference(b)
                    .map(|c| c.path.clone())
                    .collect::<Vec<_>>()
                    .join(", ")
            };
            diagnostics.push(diagnostic(
                "LINEAGE_MISMATCH",
                "/parent/changes",
                &format!(
                    "The declared changes list {} leaves; the computed difference from the parent has {}. Computed and not declared: [{}]. Declared and not computed: [{}].",
                    declared.len(),
                    computed.len(),
                    paths(&computed_set, &declared_set),
                    paths(&declared_set, &computed_set),
                ),
            ));
        }
    }
    let scope_name = match &scope {
        Scope::Entry => Some("ENTRY"),
        Scope::Exit => Some("EXIT"),
        Scope::Empty => {
            diagnostics.push(diagnostic(
                "REVISION_SCOPE",
                "",
                "The revision changes nothing. A controlled revision changes entry rules or exit rules.",
            ));
            None
        }
        Scope::Both => {
            diagnostics.push(diagnostic(
                "REVISION_SCOPE",
                "",
                &format!(
                    "The changes affect the entry rule and the exit rules ({}). A controlled revision changes entry rules or exit rules, not both.",
                    scope_detail(&classified)
                ),
            ));
            None
        }
        Scope::Outside(path) => {
            diagnostics.push(diagnostic(
                "REVISION_SCOPE",
                path,
                &format!(
                    "The change at {path} is outside a controlled revision ({}). Only entry rules or exit rules may change.",
                    scope_detail(&classified)
                ),
            ));
            None
        }
    };
    Ok(finish(diagnostics, || Outcome::ValidRevision {
        max_lookback,
        warmup,
        changes: declared,
        scope: scope_name.unwrap_or("ENTRY"),
    }))
}

/// The envelope around the verdict of one `validate` attempt.
#[derive(Clone, Debug)]
pub struct ValidationContext<'a> {
    pub job_id: &'a str,
    /// `{"attempt_id", "ownership_revision"}`.
    pub attempt: Value,
    /// `{"name", "version", "digest"}` of the executable that ran.
    pub executable: Value,
    pub engine_digest: &'a str,
    pub method: &'a MethodRef,
    /// The digest of the draft the job read.
    pub draft_digest: &'a str,
    /// The Strategy Version hash of the parent: the revision form; `None` is the seed form.
    pub parent_hash: Option<&'a str>,
    /// The measured duration, as `connected-common` states it.
    pub duration: Value,
}

/// Build the `validation-result/1` of a verdict.
///
/// # Errors
/// [`LineageError::Contract`] when the verdict does not fit the form (a seed outcome with a parent,
/// a revision outcome without one) or the finished document fails its schema.
pub fn validation_result(
    context: &ValidationContext<'_>,
    outcome: &Outcome,
) -> Result<g::ValidationResult, LineageError> {
    let wrong_form =
        || LineageError::Contract("the verdict does not fit the seed or revision form".to_owned());
    let body = match outcome {
        Outcome::ValidSeed {
            max_lookback,
            warmup,
        } => {
            if context.parent_hash.is_some() {
                return Err(wrong_form());
            }
            json!({"status": "VALID", "max_lookback_sessions": max_lookback, "warmup_sessions": warmup})
        }
        Outcome::ValidRevision {
            max_lookback,
            warmup,
            changes,
            scope,
        } => {
            if context.parent_hash.is_none() {
                return Err(wrong_form());
            }
            json!({
                "status": "VALID",
                "max_lookback_sessions": max_lookback,
                "warmup_sessions": warmup,
                "computed_changes": changes
                    .iter()
                    .map(|c| json!({"path": c.path, "from": c.from, "to": c.to}))
                    .collect::<Vec<_>>(),
                "change_scope": scope,
            })
        }
        Outcome::Invalid(diagnostics) => json!({
            "status": "INVALID",
            "diagnostics": diagnostics
                .iter()
                .map(|d| json!({"code": d.code, "pointer": d.pointer, "detail": d.detail}))
                .collect::<Vec<_>>(),
        }),
    };
    let mut document = json!({
        "schema_version": "validation-result/1",
        "job_id": context.job_id,
        "attempt": context.attempt,
        "executable": context.executable,
        "engine_digest": context.engine_digest,
        "method": context.method.to_value(),
        "draft_digest": context.draft_digest,
        "outcome": body,
        "duration": context.duration,
    });
    if let (Some(parent), Some(object)) = (context.parent_hash, document.as_object_mut()) {
        object.insert("parent_hash".to_owned(), Value::String(parent.to_owned()));
    }
    parse_value::<g::ValidationResult>(document).map_err(|e| LineageError::Contract(e.to_string()))
}

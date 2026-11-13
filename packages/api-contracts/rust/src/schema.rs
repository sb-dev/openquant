//! Runtime validation against the shared JSON Schemas.

use std::{collections::BTreeMap, sync::OnceLock};

use jsonschema::{Registry, ValidationError, Validator, error::ValidationErrorKind};
use serde_json::{Value, json};

use crate::{
    Contract,
    error::{ContractError, SchemaViolation},
    limits,
};

const SOURCES: &[(&str, &str)] = &[
    (
        "urn:openquant:schema:common:1",
        include_str!("../../schemas/common.schema.json"),
    ),
    (
        "urn:openquant:schema:strategy-artefact:1",
        include_str!("../../schemas/strategy-artefact.schema.json"),
    ),
    (
        "urn:openquant:schema:evaluation-input:1",
        include_str!("../../schemas/evaluation-input.schema.json"),
    ),
    (
        "urn:openquant:schema:evaluation-result:1",
        include_str!("../../schemas/evaluation-result.schema.json"),
    ),
    (
        "urn:openquant:schema:checkpoint:1",
        include_str!("../../schemas/checkpoint.schema.json"),
    ),
];

/// Violations listed individually. Later ones are counted and summarised in one marker entry.
const MAX_REPORTED_VIOLATIONS: usize = 20;

/// Longest message kept. A message can echo the offending value, which can be the whole payload.
const MAX_MESSAGE_BYTES: usize = 1024;

/// The decimal grammar in `common.schema.json`. A pattern failure with this expression means a
/// malformed decimal string rather than another kind of schema violation.
const DECIMAL_PATTERN: &str =
    r"^(?:0(?:\.[0-9]+)?|-?[1-9][0-9]*(?:\.[0-9]+)?|-0\.[0-9]*[1-9][0-9]*)$";

/// The `Exact` grammar in `common.schema.json`: the decimal grammar or a fraction `n/d`. A
/// pattern failure with this expression is a malformed value of the same kind.
const EXACT_PATTERN: &str = r"^(?:0(?:\.[0-9]+)?|-?[1-9][0-9]*(?:\.[0-9]+)?|-0\.[0-9]*[1-9][0-9]*|-?[1-9][0-9]*/[1-9][0-9]*)$";

type Validators = BTreeMap<&'static str, Validator>;

fn build() -> Result<Validators, String> {
    let mut registry = Registry::new();
    for (id, text) in SOURCES {
        let value: Value = serde_json::from_str(text).map_err(|e| format!("{id}: {e}"))?;
        registry = registry.add(*id, value).map_err(|e| format!("{id}: {e}"))?;
    }
    let registry = registry.prepare().map_err(|e| format!("prepare: {e}"))?;
    let mut validators = BTreeMap::new();
    for contract in Contract::ALL {
        let id = contract.schema_id();
        let validator = jsonschema::options()
            .with_registry(&registry)
            .build(&json!({ "$ref": id }))
            .map_err(|e| format!("{id}: {e}"))?;
        validators.insert(id, validator);
    }
    Ok(validators)
}

fn validators() -> Result<&'static Validators, ContractError> {
    static CELL: OnceLock<Result<Validators, String>> = OnceLock::new();
    CELL.get_or_init(build)
        .as_ref()
        .map_err(|message| ContractError::Registry(message.clone()))
}

fn bounded(mut message: String) -> String {
    if message.len() > MAX_MESSAGE_BYTES {
        let mut end = MAX_MESSAGE_BYTES;
        while !message.is_char_boundary(end) {
            end = end.saturating_sub(1);
        }
        message.truncate(end);
        message.push('…');
    }
    message
}

fn is_decimal_grammar(error: &ValidationError<'_>) -> bool {
    matches!(
        error.kind(),
        ValidationErrorKind::Pattern { pattern }
            if pattern == DECIMAL_PATTERN || pattern == EXACT_PATTERN
    )
}

fn violation(error: &ValidationError<'_>) -> SchemaViolation {
    SchemaViolation {
        pointer: error.instance_path().to_string(),
        message: bounded(error.to_string()),
        decimal_grammar: is_decimal_grammar(error),
    }
}

/// List the first violations and summarise the rest, classifying all of them.
///
/// The marker entry that stands for the unlisted violations is decimal-grammar only when every
/// one of them is. [`ContractError::failure_code`] therefore reads the same answer from the capped
/// list as it would from the full one.
fn collect(
    validator: &Validator,
    value: &Value,
    first: &ValidationError<'_>,
) -> Vec<SchemaViolation> {
    let mut listed = Vec::new();
    let mut omitted = 0_usize;
    let mut omitted_all_decimal = true;
    for error in validator.iter_errors(value) {
        if listed.len() < MAX_REPORTED_VIOLATIONS {
            listed.push(violation(&error));
        } else {
            omitted = omitted.saturating_add(1);
            omitted_all_decimal &= is_decimal_grammar(&error);
        }
    }
    if listed.is_empty() {
        // The first-error check rejected the document, so never turn that into success.
        listed.push(violation(first));
    }
    if omitted > 0 {
        listed.push(SchemaViolation {
            pointer: String::new(),
            message: format!("{omitted} further violation(s) not listed"),
            decimal_grammar: omitted_all_decimal,
        });
    }
    listed
}

/// Check the version tag, then validate the whole payload against its schema.
///
/// A valid document costs one pass and no allocation. An invalid one is diagnosed in full only
/// while it stays within the structural limits in the `limits` module. A larger one reports the
/// limit it exceeds and its first violation, which is at most two [`SchemaViolation`]s.
///
/// # Errors
/// Returns [`ContractError::UnsupportedVersion`], [`ContractError::MissingVersion`] or
/// [`ContractError::Schema`].
pub fn validate(contract: Contract, value: &Value) -> Result<(), ContractError> {
    let expected = contract.version_tag();
    match value.get("schema_version") {
        Some(Value::String(found)) if found == expected => {}
        Some(Value::String(found)) => {
            return Err(ContractError::UnsupportedVersion {
                found: found.clone(),
                expected: expected.to_owned(),
            });
        }
        _ => return Err(ContractError::MissingVersion),
    }
    let validator = validators()?
        .get(contract.schema_id())
        .ok_or_else(|| ContractError::Registry(format!("no validator for {contract:?}")))?;
    // One error is cheap whatever the size of the document.
    let Err(first) = validator.validate(value) else {
        return Ok(());
    };
    if let Some(excess) = limits::first_excess(value) {
        return Err(ContractError::Schema(vec![excess, violation(&first)]));
    }
    Err(ContractError::Schema(collect(validator, value, &first)))
}

#[cfg(test)]
mod tests {
    use super::{MAX_MESSAGE_BYTES, bounded};

    #[test]
    fn long_messages_are_cut_on_a_character_boundary() {
        // A four-byte character at each of the four alignments around the cut.
        for padding in 0..4 {
            let text = format!("{}{}", "a".repeat(padding), "😀".repeat(1_000));
            let cut = bounded(text);
            assert!(cut.ends_with('…'));
            assert!(cut.len() <= MAX_MESSAGE_BYTES + '…'.len_utf8());
        }
        assert_eq!(bounded("short".to_owned()), "short");
        let exact = "b".repeat(MAX_MESSAGE_BYTES);
        assert_eq!(bounded(exact.clone()), exact);
    }
}

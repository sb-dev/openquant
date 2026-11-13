//! Runtime validation against the shared JSON Schemas.

use std::{collections::BTreeMap, sync::OnceLock};

use jsonschema::{Registry, Validator, error::ValidationErrorKind};
use serde_json::{Value, json};

use crate::{
    Contract,
    error::{ContractError, SchemaViolation},
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

const MAX_REPORTED_VIOLATIONS: usize = 20;

/// The decimal grammar in `common.schema.json`. A pattern failure with this expression means a
/// malformed decimal string rather than another kind of schema violation.
const DECIMAL_PATTERN: &str =
    r"^(?:0(?:\.[0-9]+)?|-?[1-9][0-9]*(?:\.[0-9]+)?|-0\.[0-9]*[1-9][0-9]*)$";

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

/// Check the version tag, then validate the whole payload against its schema.
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
    let violations: Vec<SchemaViolation> = validator
        .iter_errors(value)
        .take(MAX_REPORTED_VIOLATIONS)
        .map(|error| SchemaViolation {
            pointer: error.instance_path().to_string(),
            message: error.to_string(),
            decimal_grammar: matches!(
                error.kind(),
                ValidationErrorKind::Pattern { pattern } if pattern == DECIMAL_PATTERN
            ),
        })
        .collect();
    if violations.is_empty() {
        Ok(())
    } else {
        Err(ContractError::Schema(violations))
    }
}

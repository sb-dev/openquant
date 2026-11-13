//! Shared S0 contracts: generated Rust bindings, runtime validation, canonical JSON and digests.
//!
//! The schemas in `packages/api-contracts/schemas` are the single source. Bindings are generated
//! from them at build time. Every payload passes the JSON Schema first, then the strict typed
//! binding, so unsupported versions, unknown fields and malformed decimals are rejected twice.

pub mod canonical;
pub mod decimal;
pub mod error;
pub mod exact;
mod limits;
mod schema;
pub mod strict;

use serde::{Serialize, de::DeserializeOwned};
use serde_json::Value;

pub use canonical::{canonical_json, digest, digest_bytes};
pub use error::{ContractError, SchemaViolation};
pub use schema::validate;
pub use strict::parse_json;

/// Types emitted by typify from the schemas. Not hand-edited and not committed.
///
/// Every workspace lint applies to this module except `unwrap_used`: typify compiles each
/// `pattern` once, in a `LazyLock`, with `Regex::new("<constant>").unwrap()`. Removing the allow
/// reports exactly those seven unwraps and nothing else, so a panic, an index or a float operation
/// in newly generated code still fails `cargo clippy -- -D warnings`.
#[allow(clippy::unwrap_used)]
pub mod generated {
    include!(concat!(env!("OUT_DIR"), "/generated.rs"));
}

pub use generated::{Checkpoint, EvaluationInput, EvaluationResult, FailureCode, StrategyArtefact};

/// The four S0 wire contracts.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Contract {
    StrategyArtefact,
    EvaluationInput,
    EvaluationResult,
    Checkpoint,
}

impl Contract {
    pub const ALL: [Self; 4] = [
        Self::StrategyArtefact,
        Self::EvaluationInput,
        Self::EvaluationResult,
        Self::Checkpoint,
    ];

    /// Schema `$id` of the contract root.
    #[must_use]
    pub const fn schema_id(self) -> &'static str {
        match self {
            Self::StrategyArtefact => "urn:openquant:schema:strategy-artefact:1",
            Self::EvaluationInput => "urn:openquant:schema:evaluation-input:1",
            Self::EvaluationResult => "urn:openquant:schema:evaluation-result:1",
            Self::Checkpoint => "urn:openquant:schema:checkpoint:1",
        }
    }

    /// The only `schema_version` value this build accepts.
    #[must_use]
    pub const fn version_tag(self) -> &'static str {
        match self {
            Self::StrategyArtefact => "strategy-artefact/1",
            Self::EvaluationInput => "evaluation-input/1",
            Self::EvaluationResult => "evaluation-result/1",
            Self::Checkpoint => "checkpoint/1",
        }
    }
}

/// A generated root type bound to its contract.
pub trait Payload: Serialize + DeserializeOwned {
    const CONTRACT: Contract;
}

impl Payload for StrategyArtefact {
    const CONTRACT: Contract = Contract::StrategyArtefact;
}
impl Payload for EvaluationInput {
    const CONTRACT: Contract = Contract::EvaluationInput;
}
impl Payload for EvaluationResult {
    const CONTRACT: Contract = Contract::EvaluationResult;
}
impl Payload for Checkpoint {
    const CONTRACT: Contract = Contract::Checkpoint;
}

/// Parse text, validate it against the schema, then bind it to the typed payload.
///
/// # Errors
/// Returns [`ContractError`] describing the first rejecting layer.
pub fn parse<T: Payload>(text: &str) -> Result<T, ContractError> {
    parse_value(parse_json(text)?)
}

/// Validate a parsed value, then bind it to the typed payload.
///
/// # Errors
/// Returns [`ContractError`] describing the first rejecting layer.
pub fn parse_value<T: Payload>(value: Value) -> Result<T, ContractError> {
    validate(T::CONTRACT, &value)?;
    serde_json::from_value(value).map_err(|e| ContractError::Binding(e.to_string()))
}

/// Serialise a typed payload to a JSON value.
///
/// # Errors
/// Returns [`ContractError::Binding`] if serialisation fails.
pub fn to_value<T: Payload>(payload: &T) -> Result<Value, ContractError> {
    serde_json::to_value(payload).map_err(|e| ContractError::Binding(e.to_string()))
}

/// Identity digest of a typed payload (SHA-256 of its canonical JSON).
///
/// # Errors
/// Returns [`ContractError`] if the payload cannot be serialised or canonicalised.
pub fn payload_digest<T: Payload>(payload: &T) -> Result<String, ContractError> {
    digest(&to_value(payload)?)
}

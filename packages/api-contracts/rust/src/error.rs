//! Typed errors for payload parsing, validation and canonicalisation.

use crate::generated::FailureCode;

/// One schema violation with the JSON pointer of the offending value.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SchemaViolation {
    pub pointer: String,
    pub message: String,
    /// True when the value failed the shared decimal-string grammar.
    pub decimal_grammar: bool,
}

/// Why a payload was rejected.
#[derive(Debug, thiserror::Error)]
pub enum ContractError {
    #[error("payload is not valid JSON: {0}")]
    Json(String),
    #[error("payload exceeds {limit} bytes")]
    TooLarge { limit: usize },
    #[error("duplicate object key: {0}")]
    DuplicateKey(String),
    #[error("floating-point number is not allowed: use an integer or a decimal string")]
    FloatNumber,
    #[error("missing or non-string schema_version")]
    MissingVersion,
    #[error("unsupported schema_version {found:?}; expected {expected:?}")]
    UnsupportedVersion { found: String, expected: String },
    /// At most 20 violations, then one entry without a pointer that stands for all later ones and
    /// is decimal-grammar only if every one of them is. A document beyond the structural limits
    /// holds the limit it exceeds, then its first violation.
    #[error("payload violates the schema at {} location(s)", .0.len())]
    Schema(Vec<SchemaViolation>),
    #[error("invalid decimal {value:?}: {reason}")]
    Decimal { value: String, reason: String },
    #[error("payload does not match the generated binding: {0}")]
    Binding(String),
    #[error("cannot canonicalise payload: {0}")]
    Canonical(String),
    #[error("schema registry failure: {0}")]
    Registry(String),
}

impl ContractError {
    /// The shared failure code that reports this error.
    #[must_use]
    pub fn failure_code(&self) -> FailureCode {
        match self {
            Self::UnsupportedVersion { .. } => FailureCode::UnsupportedSchemaVersion,
            Self::Decimal { .. } => FailureCode::InvalidDecimal,
            Self::Schema(violations)
                if !violations.is_empty() && violations.iter().all(|v| v.decimal_grammar) =>
            {
                FailureCode::InvalidDecimal
            }
            Self::Json(_)
            | Self::TooLarge { .. }
            | Self::DuplicateKey(_)
            | Self::FloatNumber
            | Self::MissingVersion
            | Self::Schema(_)
            | Self::Binding(_)
            | Self::Canonical(_)
            | Self::Registry(_) => FailureCode::SchemaViolation,
        }
    }
}

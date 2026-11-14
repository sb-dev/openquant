//! Shared contracts: generated Rust bindings, runtime validation, canonical JSON and digests.
//!
//! The schemas in `packages/api-contracts/schemas` are the single source. Bindings are generated
//! from them at build time. Every payload passes the JSON Schema first, then the strict typed
//! binding, so unsupported versions, unknown fields and malformed decimals are rejected twice.
//!
//! There are two contract sets (OQ-05 section 7). [`Contract`] holds the engine-scope contracts.
//! Their version tags are part of engine identity. [`Envelope`] holds the S1 connected envelopes.
//! They are outside engine identity (OQ-02 section 7), so adding one never changes it.

pub mod canonical;
pub mod decimal;
pub mod error;
pub mod exact;
mod limits;
mod schema;
pub mod strict;

use std::fmt;

use serde::{Serialize, de::DeserializeOwned};
use serde_json::Value;

pub use canonical::{canonical_json, digest, digest_bytes};
pub use error::{ContractError, SchemaViolation};
pub use schema::validate;
pub use strict::parse_json;

/// Types emitted by typify from the schemas. Not hand-edited and not committed.
///
/// Every workspace lint applies to this module except two:
///
/// - `unwrap_used`: typify compiles each `pattern` once, in a `LazyLock`, with
///   `Regex::new("<constant>").unwrap()`. Removing the allow reports exactly those eighteen
///   unwraps and nothing else.
/// - `large_enum_variant`: a root `oneOf` becomes an enum that holds each form by value. The
///   request forms of `command/1` and `evaluation-request/1` are much larger than their other
///   forms. Boxing them would need a hand-edited binding, and these values are parsed once per
///   request, so the size costs nothing that matters.
///
/// A panic, an index or a float operation in newly generated code still fails
/// `cargo clippy -- -D warnings`.
#[allow(clippy::unwrap_used, clippy::large_enum_variant)]
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

/// The S1 connected envelopes, in the order OQ-05 section 7 lists them.
///
/// They are a contract set separate from [`Contract`] and outside engine identity: engine
/// identity reads only [`Contract::ALL`].
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Envelope {
    EvaluationPlan,
    EvaluationRequest,
    EvaluationSubmission,
    JobDispatch,
    AttemptClaim,
    Command,
    ResearchProfile,
    CohortPolicy,
    DatasetManifest,
    RetrievalRequest,
    RetrievalResult,
    ValidationResult,
    EvaluationMetrics,
    GateReport,
    AgentDispatch,
    AgentAttemptResult,
    ApiError,
    ReleaseManifest,
}

impl Envelope {
    pub const ALL: [Self; 18] = [
        Self::EvaluationPlan,
        Self::EvaluationRequest,
        Self::EvaluationSubmission,
        Self::JobDispatch,
        Self::AttemptClaim,
        Self::Command,
        Self::ResearchProfile,
        Self::CohortPolicy,
        Self::DatasetManifest,
        Self::RetrievalRequest,
        Self::RetrievalResult,
        Self::ValidationResult,
        Self::EvaluationMetrics,
        Self::GateReport,
        Self::AgentDispatch,
        Self::AgentAttemptResult,
        Self::ApiError,
        Self::ReleaseManifest,
    ];

    /// Schema `$id` of the envelope root.
    #[must_use]
    pub const fn schema_id(self) -> &'static str {
        match self {
            Self::EvaluationPlan => "urn:openquant:schema:evaluation-plan:1",
            Self::EvaluationRequest => "urn:openquant:schema:evaluation-request:1",
            Self::EvaluationSubmission => "urn:openquant:schema:evaluation-submission:1",
            Self::JobDispatch => "urn:openquant:schema:job-dispatch:1",
            Self::AttemptClaim => "urn:openquant:schema:attempt-claim:1",
            Self::Command => "urn:openquant:schema:command:1",
            Self::ResearchProfile => "urn:openquant:schema:research-profile:1",
            Self::CohortPolicy => "urn:openquant:schema:cohort-policy:1",
            Self::DatasetManifest => "urn:openquant:schema:dataset-manifest:1",
            Self::RetrievalRequest => "urn:openquant:schema:retrieval-request:1",
            Self::RetrievalResult => "urn:openquant:schema:retrieval-result:1",
            Self::ValidationResult => "urn:openquant:schema:validation-result:1",
            Self::EvaluationMetrics => "urn:openquant:schema:evaluation-metrics:1",
            Self::GateReport => "urn:openquant:schema:gate-report:1",
            Self::AgentDispatch => "urn:openquant:schema:agent-dispatch:1",
            Self::AgentAttemptResult => "urn:openquant:schema:agent-attempt-result:1",
            Self::ApiError => "urn:openquant:schema:api-error:1",
            Self::ReleaseManifest => "urn:openquant:schema:release-manifest:1",
        }
    }

    /// The only `schema_version` value this build accepts. Every form of a multi-form envelope
    /// carries the same tag.
    #[must_use]
    pub const fn version_tag(self) -> &'static str {
        match self {
            Self::EvaluationPlan => "evaluation-plan/1",
            Self::EvaluationRequest => "evaluation-request/1",
            Self::EvaluationSubmission => "evaluation-submission/1",
            Self::JobDispatch => "job-dispatch/1",
            Self::AttemptClaim => "attempt-claim/1",
            Self::Command => "command/1",
            Self::ResearchProfile => "research-profile/1",
            Self::CohortPolicy => "cohort-policy/1",
            Self::DatasetManifest => "dataset-manifest/1",
            Self::RetrievalRequest => "retrieval-request/1",
            Self::RetrievalResult => "retrieval-result/1",
            Self::ValidationResult => "validation-result/1",
            Self::EvaluationMetrics => "evaluation-metrics/1",
            Self::GateReport => "gate-report/1",
            Self::AgentDispatch => "agent-dispatch/1",
            Self::AgentAttemptResult => "agent-attempt-result/1",
            Self::ApiError => "api-error/1",
            Self::ReleaseManifest => "release-manifest/1",
        }
    }
}

mod sealed {
    /// Chooses the runtime schema registry. Only this crate implements it.
    pub trait Sealed {
        /// True for the engine-scope contracts. Their registry holds the engine-scope schemas
        /// only, so no envelope schema can change how an engine payload validates.
        const ENGINE_SCOPE: bool;
    }

    impl Sealed for super::Contract {
        const ENGINE_SCOPE: bool = true;
    }

    impl Sealed for super::Envelope {
        const ENGINE_SCOPE: bool = false;
    }
}

/// A contract that [`validate`] accepts: an engine contract ([`Contract`]) or an envelope
/// ([`Envelope`]). Sealed: no other type implements it.
pub trait ContractKind: Copy + fmt::Debug + sealed::Sealed {
    /// Schema `$id` of the contract root.
    fn schema_id(self) -> &'static str;

    /// The only `schema_version` value this build accepts.
    fn version_tag(self) -> &'static str;

    /// The contract name that the protocol manifest uses: the version tag without `/<n>`.
    fn name(self) -> &'static str {
        let tag = self.version_tag();
        tag.split_once('/').map_or(tag, |(name, _)| name)
    }
}

// In both impls, `Self::schema_id` and `Self::version_tag` name the inherent `const fn`s, which
// take precedence over the trait methods, so the calls do not recurse.
impl ContractKind for Contract {
    fn schema_id(self) -> &'static str {
        Self::schema_id(self)
    }

    fn version_tag(self) -> &'static str {
        Self::version_tag(self)
    }
}

impl ContractKind for Envelope {
    fn schema_id(self) -> &'static str {
        Self::schema_id(self)
    }

    fn version_tag(self) -> &'static str {
        Self::version_tag(self)
    }
}

/// A contract of either set, chosen at run time, for example from a protocol manifest entry.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum AnyContract {
    Engine(Contract),
    Envelope(Envelope),
}

impl AnyContract {
    /// Every contract: the engine contracts in [`Contract::ALL`] order, then the envelopes in
    /// [`Envelope::ALL`] order.
    pub fn all() -> impl Iterator<Item = Self> {
        Contract::ALL
            .into_iter()
            .map(Self::Engine)
            .chain(Envelope::ALL.into_iter().map(Self::Envelope))
    }

    /// The contract that the protocol manifest calls `name`, if this build knows it.
    #[must_use]
    pub fn from_name(name: &str) -> Option<Self> {
        Self::all().find(|contract| contract.name() == name)
    }

    /// The contract name that the protocol manifest uses.
    #[must_use]
    pub fn name(self) -> &'static str {
        match self {
            Self::Engine(contract) => ContractKind::name(contract),
            Self::Envelope(envelope) => ContractKind::name(envelope),
        }
    }

    /// Run the whole contract layer on `text` and return the identity digest of the payload.
    ///
    /// The layer is the one [`parse`] runs: strict JSON, the version tag, the schema with the
    /// decimal classification and structural limits, then the typed binding. The digest is
    /// [`payload_digest`] of the bound payload. Semantic checks are not part of this layer.
    ///
    /// # Errors
    /// Returns [`ContractError`] describing the first rejecting layer.
    pub fn parse_digest(self, text: &str) -> Result<String, ContractError> {
        use generated as g;
        fn run<T: Payload>(text: &str) -> Result<String, ContractError> {
            payload_digest(&parse::<T>(text)?)
        }
        match self {
            Self::Engine(Contract::StrategyArtefact) => run::<StrategyArtefact>(text),
            Self::Engine(Contract::EvaluationInput) => run::<EvaluationInput>(text),
            Self::Engine(Contract::EvaluationResult) => run::<EvaluationResult>(text),
            Self::Engine(Contract::Checkpoint) => run::<Checkpoint>(text),
            Self::Envelope(Envelope::EvaluationPlan) => run::<g::EvaluationPlan>(text),
            Self::Envelope(Envelope::EvaluationRequest) => run::<g::EvaluationRequest>(text),
            Self::Envelope(Envelope::EvaluationSubmission) => run::<g::EvaluationSubmission>(text),
            Self::Envelope(Envelope::JobDispatch) => run::<g::JobDispatch>(text),
            Self::Envelope(Envelope::AttemptClaim) => run::<g::AttemptClaim>(text),
            Self::Envelope(Envelope::Command) => run::<g::Command>(text),
            Self::Envelope(Envelope::ResearchProfile) => run::<g::ResearchProfile>(text),
            Self::Envelope(Envelope::CohortPolicy) => run::<g::CohortPolicy>(text),
            Self::Envelope(Envelope::DatasetManifest) => run::<g::DatasetManifest>(text),
            Self::Envelope(Envelope::RetrievalRequest) => run::<g::RetrievalRequest>(text),
            Self::Envelope(Envelope::RetrievalResult) => run::<g::RetrievalResult>(text),
            Self::Envelope(Envelope::ValidationResult) => run::<g::ValidationResult>(text),
            Self::Envelope(Envelope::EvaluationMetrics) => run::<g::EvaluationMetrics>(text),
            Self::Envelope(Envelope::GateReport) => run::<g::GateReport>(text),
            Self::Envelope(Envelope::AgentDispatch) => run::<g::AgentDispatch>(text),
            Self::Envelope(Envelope::AgentAttemptResult) => run::<g::AgentAttemptResult>(text),
            Self::Envelope(Envelope::ApiError) => run::<g::ApiError>(text),
            Self::Envelope(Envelope::ReleaseManifest) => run::<g::ReleaseManifest>(text),
        }
    }
}

/// A generated root type bound to its contract.
pub trait Payload: Serialize + DeserializeOwned {
    /// [`Contract`] for an engine payload, [`Envelope`] for an envelope.
    type Kind: ContractKind;
    const CONTRACT: Self::Kind;
}

impl Payload for StrategyArtefact {
    type Kind = Contract;
    const CONTRACT: Contract = Contract::StrategyArtefact;
}
impl Payload for EvaluationInput {
    type Kind = Contract;
    const CONTRACT: Contract = Contract::EvaluationInput;
}
impl Payload for EvaluationResult {
    type Kind = Contract;
    const CONTRACT: Contract = Contract::EvaluationResult;
}
impl Payload for Checkpoint {
    type Kind = Contract;
    const CONTRACT: Contract = Contract::Checkpoint;
}

/// Binds each generated envelope root to its [`Envelope`].
macro_rules! envelope_payloads {
    ($($name:ident),+ $(,)?) => {
        $(
            impl Payload for generated::$name {
                type Kind = Envelope;
                const CONTRACT: Envelope = Envelope::$name;
            }
        )+
    };
}

envelope_payloads!(
    EvaluationPlan,
    EvaluationRequest,
    EvaluationSubmission,
    JobDispatch,
    AttemptClaim,
    Command,
    ResearchProfile,
    CohortPolicy,
    DatasetManifest,
    RetrievalRequest,
    RetrievalResult,
    ValidationResult,
    EvaluationMetrics,
    GateReport,
    AgentDispatch,
    AgentAttemptResult,
    ApiError,
    ReleaseManifest,
);

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

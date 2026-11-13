//! Engine and payload identities.
//!
//! The result carries a deterministic engine identity (crate version, operator-set digest,
//! schema versions). The source revision and command belong to the local report only, so
//! repeated evaluations agree byte for byte.

use openquant_contracts::{Contract, canonical, digest_bytes, generated::EngineIdentity};
use serde_json::json;

use crate::{
    model::{Failure, FailureCode, Result},
    operators::catalogue::catalogue_text,
};

/// Name of this engine in identities.
pub const ENGINE_NAME: &str = "openquant-core";

/// Identity of the operator set implemented by this build.
#[must_use]
pub fn operator_set_digest() -> String {
    digest_bytes(catalogue_text().as_bytes())
}

/// The engine identity of this build.
pub fn engine_identity() -> Result<EngineIdentity> {
    let versions: Vec<&str> = Contract::ALL.iter().map(|c| c.version_tag()).collect();
    serde_json::from_value(json!({
        "name": ENGINE_NAME,
        "version": env!("CARGO_PKG_VERSION"),
        "operator_set_digest": operator_set_digest(),
        "schema_versions": versions,
    }))
    .map_err(|e| Failure::new(FailureCode::SchemaViolation, e.to_string()))
}

/// Digest of an engine identity.
pub fn engine_digest(identity: &EngineIdentity) -> Result<String> {
    let value = serde_json::to_value(identity)
        .map_err(|e| Failure::new(FailureCode::SchemaViolation, e.to_string()))?;
    Ok(canonical::digest(&value)?)
}

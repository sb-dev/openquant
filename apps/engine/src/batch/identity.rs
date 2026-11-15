//! The identities that the batch binary states: the executable that ran, the engine and the
//! method (OQ-02 section 7, OQ-05 sections 4 and 7).

use std::{fs, io};

use openquant_contracts::{canonical::digest_bytes, generated::ExecutableIdentity};
use openquant_core::{
    identity::{engine_digest, engine_identity},
    method::method_identity,
    metrics::MethodRef,
};
use serde_json::{Value, json};

/// The name of the executable in claims and results.
pub const EXECUTABLE_NAME: &str = "engine-batch";

/// The operator set of this build.
pub const OPERATOR_SET: &str = openquant_core::operators::OPERATOR_SET;

/// The executable that actually runs: its name, its version and the SHA-256 of its own bytes.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExecutableId {
    pub name: String,
    pub version: String,
    /// `sha256:` and 64 lower-case hexadecimal digits.
    pub digest: String,
}

impl ExecutableId {
    /// Measure the running executable: the digest is the hash of the file that the process runs.
    ///
    /// # Errors
    /// The I/O error when the executable cannot be found or read.
    pub fn measure() -> io::Result<Self> {
        let path = std::env::current_exe()?;
        let bytes = fs::read(path)?;
        Ok(Self {
            name: EXECUTABLE_NAME.to_owned(),
            version: env!("CARGO_PKG_VERSION").to_owned(),
            digest: digest_bytes(&bytes),
        })
    }

    /// The `ExecutableIdentity` object of the contracts.
    #[must_use]
    pub fn to_value(&self) -> Value {
        json!({"name": self.name, "version": self.version, "digest": self.digest})
    }

    /// The typed identity, for the market module.
    ///
    /// # Errors
    /// A message when a field does not fit the identifier pattern.
    pub fn to_contract(&self) -> Result<ExecutableIdentity, String> {
        serde_json::from_value(self.to_value()).map_err(|e| e.to_string())
    }
}

/// The engine digest of this build.
///
/// # Errors
/// A message when the engine identity cannot be built.
pub fn running_engine_digest() -> Result<String, String> {
    let identity = engine_identity().map_err(|f| f.detail)?;
    engine_digest(&identity).map_err(|f| f.detail)
}

/// The method identity of this build.
#[must_use]
pub fn running_method() -> MethodRef {
    method_identity()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_running_executable_is_measured_by_its_own_bytes() {
        let id = ExecutableId::measure().unwrap();
        assert_eq!(id.name, EXECUTABLE_NAME);
        assert!(
            id.digest.starts_with("sha256:") && id.digest.len() == 71,
            "{}",
            id.digest
        );
        assert!(id.to_contract().is_ok());
    }

    #[test]
    fn the_engine_and_the_method_are_the_core_s() {
        assert!(running_engine_digest().unwrap().starts_with("sha256:"));
        assert_eq!(running_method().name, "openquant-evidence-methods");
    }
}

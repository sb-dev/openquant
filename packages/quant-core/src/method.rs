//! The method identity of derived evidence (OQ-02 section 7; OQ-05 section 7).
//!
//! Engine identity covers the numerical evaluation: the engine version, the operator set and the
//! versions of the engine-scope contracts. Everything derived from a result (validation, metrics,
//! benchmarks, audits, gates and lineage) has its own identity: the digest of a reviewed method
//! text. The text is `method.txt`. It defines every formula, rounding rule, reason code and
//! classification of this crate's derived evidence, so a change to what the code computes is a
//! change to the text and therefore to the digest.
//!
//! A golden test (`tests/method_golden.rs`) holds the text transcribed by hand and its digest
//! computed outside the crate. A change to the text fails the test until both are updated, and an
//! update is an explicit compatibility decision: earlier evidence was derived under the old
//! method. This module is independent of `identity`: it reads none of the inputs of the engine
//! identity and changes none of them.

use openquant_contracts::digest_bytes;

use crate::metrics::MethodRef;

/// The name of the method in envelopes.
pub const METHOD_NAME: &str = "openquant-evidence-methods";

/// The version of the method in envelopes. It names the text; the digest binds its content.
pub const METHOD_VERSION: &str = "1";

/// The reviewed method text.
#[must_use]
pub fn method_text() -> &'static str {
    include_str!("method.txt")
}

/// `sha256:` and the SHA-256 of the method text.
#[must_use]
pub fn method_digest() -> String {
    digest_bytes(method_text().as_bytes())
}

/// The method identity that derived payloads carry.
#[must_use]
pub fn method_identity() -> MethodRef {
    MethodRef {
        name: METHOD_NAME.to_owned(),
        version: METHOD_VERSION.to_owned(),
        digest: method_digest(),
    }
}

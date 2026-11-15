//! Rejecting an invalid envelope costs memory and time that do not follow its violations.
//!
//! The first version of the validity pass called the validator's `validate`. For a failing `oneOf`
//! at or near the root, which `command/1`, `job-dispatch/1`, `evaluation-request/1` and other
//! envelopes have, `validate` collects and copies the errors of every branch before it returns the
//! first one. A body of 3 MB of empty objects then peaked at 1.5 to 2.7 GB. `schema::validate` now
//! decides validity with `is_valid`, which collects no error, and reports a document beyond a
//! structural limit with the limit and one generic entry, whatever it holds. The engine contracts
//! have a `oneOf` only at a leaf (a corporate action), so `validation_limits.rs` never saw the cost.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use std::{
    fs,
    time::{Duration, Instant},
};

use openquant_contracts::{ContractError, Envelope, FailureCode, SchemaViolation, validate};
use serde_json::{Value, json};

/// Empty objects in the hostile array. At 3 bytes each the body is 1.5 MB, far below the byte
/// limits. Before the fix this many peaked at about 1.4 GB, and the bound below is 128 MiB.
const EMPTY_OBJECTS: usize = 500_000;
const MEMORY_BOUND_KIB: u64 = 128 * 1024;

fn fixture(text: &str) -> Value {
    serde_json::from_str(text).unwrap()
}

fn violations_of(error: ContractError) -> Vec<SchemaViolation> {
    match error {
        ContractError::Schema(violations) => violations,
        other => panic!("expected a schema rejection, got {other:?}"),
    }
}

/// The peak resident set of this process in KiB, where the platform reports it.
fn peak_resident_kib() -> Option<u64> {
    let status = fs::read_to_string("/proc/self/status").ok()?;
    let line = status.lines().find(|line| line.starts_with("VmHWM:"))?;
    line.split_whitespace().nth(1)?.parse().ok()
}

fn hostile_array() -> Value {
    Value::Array(vec![json!({}); EMPTY_OBJECTS])
}

/// Reject `document` as `envelope` and check what the rejection costs and says. This file holds one
/// test, so the peak of the process is the peak of that rejection and of building its document.
fn reject_within_bounds(envelope: Envelope, document: &Value, pointer: &str) {
    // Build the validators on a valid body, so the registry is not part of the measurement.
    let valid = match envelope {
        Envelope::JobDispatch => fixture(include_str!(
            "../../../../fixtures/protocol/valid/job-dispatch.assess.json"
        )),
        Envelope::Command => fixture(include_str!(
            "../../../../fixtures/protocol/valid/command.create-mission.json"
        )),
        other => panic!("no valid body for {other:?}"),
    };
    validate(envelope, &valid).unwrap();

    let before = peak_resident_kib();
    let started = Instant::now();
    let error = validate(envelope, document).unwrap_err();
    let elapsed = started.elapsed();
    let after = peak_resident_kib();

    // Measured in a debug build: about 0.1 s now, and several seconds before the fix.
    assert!(
        elapsed < Duration::from_secs(3),
        "rejecting {EMPTY_OBJECTS} empty objects as {envelope:?} took {elapsed:?}"
    );
    if let (Some(before), Some(after)) = (before, after) {
        assert!(
            after.saturating_sub(before) < MEMORY_BOUND_KIB,
            "rejecting it as {envelope:?} grew the peak resident set by {} KiB",
            after.saturating_sub(before)
        );
    }
    assert_eq!(error.failure_code(), FailureCode::SchemaViolation);
    let violations = violations_of(error);
    // The limit that the array exceeds, then the generic entry: no violation was built.
    assert_eq!(violations.len(), 2, "{violations:?}");
    assert_eq!(violations[0].pointer, pointer);
    assert!(violations[0].message.contains("items"), "{violations:?}");
    assert!(violations[1].pointer.is_empty(), "{violations:?}");
    assert!(violations[1].message.contains("rejected"), "{violations:?}");
    assert!(
        violations.iter().all(|v| !v.decimal_grammar),
        "{violations:?}"
    );
}

#[test]
fn envelopes_with_a_failing_one_of_are_rejected_within_bounds() {
    let mut dispatch = fixture(include_str!(
        "../../../../fixtures/protocol/valid/job-dispatch.assess.json"
    ));
    dispatch["inputs"]["runs"] = hostile_array();
    reject_within_bounds(Envelope::JobDispatch, &dispatch, "/inputs/runs");

    let mut command = fixture(include_str!(
        "../../../../fixtures/protocol/valid/command.create-mission.json"
    ));
    command["payload"]["mission"]["junk"] = hostile_array();
    reject_within_bounds(Envelope::Command, &command, "/payload/mission/junk");
}

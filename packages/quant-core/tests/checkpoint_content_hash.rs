//! A stored checkpoint is trusted only after its content hash matches (OQ-05 section 7: "The
//! evaluate job checks the content hash of a checkpoint it fetches").
//!
//! `Run::restore` checks identities, cursor and consistency. It cannot detect an edit that keeps
//! the state consistent, so the batch host hashes the stored bytes first. These tests change the
//! stored bytes in every way that matters and check that none reaches `restore`.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

mod execution_support;

use execution_support::*;
use openquant_contracts::{canonical_json, digest_bytes, to_value};
use openquant_core::{FailureCode, Run, State};

/// Eight sessions with an open position, a receivable, a split and a scheduled stop, cut in the
/// middle of the run so the checkpoint holds real state.
fn scenario() -> Scenario {
    Scenario::new(vec![
        quiet_bar("100", "101", "99", "100"),
        signal_bar("100", "104", "100", "102"),
        quiet_bar("100", "103", "99", "101"),
        quiet_bar("102", "105", "101", "103"),
        quiet_bar("51", "53", "50.5", "52"),
        quiet_bar("52", "54", "51", "53"),
        quiet_bar("53", "55", "52", "54"),
        quiet_bar("54", "56", "53", "55"),
    ])
    .break_even(true)
    .split("SPLIT1", 4, 2, 1)
    .dividend("DIV1", 3, "0.20", 5, "OPEN")
}

/// The canonical bytes of the checkpoint after `cut` events, and their digest.
fn stored(run: &Run, cut: usize) -> (State, Vec<u8>, String) {
    let state = state_after(run, cut);
    let text = canonical_json(&to_value(&run.checkpoint(&state).unwrap()).unwrap()).unwrap();
    let bytes = text.into_bytes();
    let digest = digest_bytes(&bytes);
    (state, bytes, digest)
}

fn code(error: Result<State, openquant_core::Failure>) -> FailureCode {
    error
        .expect_err("the stored checkpoint must be refused")
        .code
}

#[test]
fn the_stored_bytes_restore_to_the_same_state_as_the_parsed_checkpoint() {
    let run = scenario().run();
    let events = run.events().unwrap();
    for cut in [0, 7, 15, 23, events.len()] {
        let (state, bytes, digest) = stored(&run, cut);
        let restored = run.restore_stored(&bytes, &digest).unwrap();
        // The restored state continues exactly as the uninterrupted one.
        let (a, fa) = run.run_events(restored, &events[cut..]);
        let (b, fb) = run.run_events(state, &events[cut..]);
        assert_eq!(fa.is_none(), fb.is_none());
        assert_eq!(
            canonical_json(&to_value(&run.result(&a, fa.as_ref()).unwrap()).unwrap()).unwrap(),
            canonical_json(&to_value(&run.result(&b, fb.as_ref()).unwrap()).unwrap()).unwrap(),
            "cut {cut}"
        );
    }
}

#[test]
fn one_changed_byte_is_refused_before_the_body_is_read() {
    let run = scenario().run();
    let (_, bytes, digest) = stored(&run, 15);
    // Flip every byte in turn at a spread of positions: each change, valid JSON or not, stops at
    // the hash and never reaches the parser or `restore`.
    let step = (bytes.len() / 40).max(1);
    for position in (0..bytes.len()).step_by(step) {
        let mut edited = bytes.clone();
        edited[position] ^= 0x01;
        assert_eq!(
            code(run.restore_stored(&edited, &digest)),
            FailureCode::CheckpointMismatch,
            "byte {position}"
        );
    }
}

#[test]
fn an_edit_that_keeps_the_state_consistent_is_caught_by_the_hash_alone() {
    // The scheduled stop of the position is not checked by `restore`: no journal line states it
    // (see `validate_state`). The edited document is a valid checkpoint that restores, but its
    // bytes no longer hash to the stored digest, so the host refuses it.
    let run = scenario().run();
    let (_, bytes, digest) = stored(&run, 15);
    let mut value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    let position = &mut value["state"]["positions"][0];
    let stop = position["stop"].as_str().unwrap().to_owned();
    assert_ne!(stop, "1", "the edit must change the stop");
    position["stop"] = serde_json::Value::String("1".to_owned());
    let edited = canonical_json(&value).unwrap().into_bytes();
    // The edit is invisible to `restore`...
    let checkpoint = openquant_contracts::parse(std::str::from_utf8(&edited).unwrap()).unwrap();
    assert!(run.restore(&checkpoint).is_ok());
    // ...and visible to the hash.
    assert_eq!(
        code(run.restore_stored(&edited, &digest)),
        FailureCode::CheckpointMismatch
    );
}

#[test]
fn a_truncated_body_and_an_empty_body_are_refused_by_the_hash() {
    let run = scenario().run();
    let (_, bytes, digest) = stored(&run, 15);
    for length in [0, 1, bytes.len() / 2, bytes.len() - 1] {
        assert_eq!(
            code(run.restore_stored(&bytes[..length], &digest)),
            FailureCode::CheckpointMismatch,
            "length {length}"
        );
    }
    let mut longer = bytes.clone();
    longer.push(b'\n');
    assert_eq!(
        code(run.restore_stored(&longer, &digest)),
        FailureCode::CheckpointMismatch
    );
}

#[test]
fn a_re_serialised_body_has_another_hash() {
    let run = scenario().run();
    let (_, bytes, digest) = stored(&run, 15);
    // The same document written with other whitespace is the same JSON and another byte string.
    let value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    let pretty = serde_json::to_vec_pretty(&value).unwrap();
    assert_ne!(pretty, bytes);
    assert_eq!(
        code(run.restore_stored(&pretty, &digest)),
        FailureCode::CheckpointMismatch
    );
    // Stored under its own digest, it restores: the host trusts the digest it was given.
    assert!(run.restore_stored(&pretty, &digest_bytes(&pretty)).is_ok());
}

#[test]
fn a_wrong_or_malformed_expected_digest_is_refused() {
    let run = scenario().run();
    let (_, bytes, digest) = stored(&run, 15);
    let (_, other_bytes, other_digest) = stored(&run, 23);
    assert_ne!(digest, other_digest);
    for expected in [
        other_digest.as_str(),
        "",
        "sha256:",
        "not a digest",
        &digest.to_uppercase(),
        &digest[7..],
    ] {
        assert_eq!(
            code(run.restore_stored(&bytes, expected)),
            FailureCode::CheckpointMismatch,
            "{expected:?}"
        );
    }
    // The other checkpoint is a different state, not a corrupted one: it restores under its own
    // digest, so the refusal above was the hash and nothing else.
    assert!(run.restore_stored(&other_bytes, &other_digest).is_ok());
}

#[test]
fn a_matching_hash_over_something_that_is_not_a_checkpoint_gives_the_parse_code() {
    let run = scenario().run();
    for (name, body, expected) in [
        ("not json", b"{".to_vec(), FailureCode::SchemaViolation),
        (
            "not utf-8",
            vec![0xff, 0xfe, 0x7b],
            FailureCode::SchemaViolation,
        ),
        ("empty object", b"{}".to_vec(), FailureCode::SchemaViolation),
        (
            "wrong version",
            br#"{"schema_version":"checkpoint/2"}"#.to_vec(),
            FailureCode::UnsupportedSchemaVersion,
        ),
        (
            "a result instead of a checkpoint",
            canonical_json(&to_value(&run.evaluate_result()).unwrap())
                .unwrap()
                .into_bytes(),
            FailureCode::UnsupportedSchemaVersion,
        ),
    ] {
        let digest = digest_bytes(&body);
        assert_eq!(code(run.restore_stored(&body, &digest)), expected, "{name}");
    }
}

#[test]
fn a_checkpoint_of_another_run_passes_the_hash_and_fails_the_identity_check() {
    let run = scenario().run();
    let other = scenario().capital("7000.00").run();
    let (_, bytes, digest) = stored(&other, 15);
    // The hash is right for these bytes. `restore` then refuses them: the input differs.
    assert_eq!(
        code(run.restore_stored(&bytes, &digest)),
        FailureCode::CheckpointMismatch
    );
}

/// The result of a complete evaluation, as a helper for the not-a-checkpoint case.
trait EvaluateResult {
    fn evaluate_result(&self) -> openquant_contracts::EvaluationResult;
}

impl EvaluateResult for Run {
    fn evaluate_result(&self) -> openquant_contracts::EvaluationResult {
        let (state, failure) = self.run_to_end(self.initial_state().unwrap());
        self.result(&state, failure.as_ref()).unwrap()
    }
}

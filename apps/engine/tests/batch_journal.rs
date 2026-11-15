//! The optional checkpoint journal of a long evaluation: a new attempt of a run resumes from a
//! checkpoint of an earlier one only after `Run::restore_stored` has checked the content hash
//! (OQ-05 sections 4 and 7).
//!
//! A crash in the middle of the stepping is made by the fake world: every input read takes 20
//! seconds of the fake clock, so each chunk of events probes the attempt, and the process dies at a
//! chosen probe. The result of the resumed attempt must be the byte-for-byte result of an
//! uninterrupted run.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

mod batch_support;

use std::{
    fs,
    path::{Path, PathBuf},
    sync::atomic::{AtomicUsize, Ordering},
};

use batch_support::{Action, BacktestSpec, Harness, data::*, worker_handled};
use openquant_engine::batch::{config::ENV_SCRATCH_DIR, worker::Handled};
use serde_json::Value;

const SUBMISSION: &str = "attempts.evaluation-submission";

fn scratch() -> PathBuf {
    static COUNTER: AtomicUsize = AtomicUsize::new(0);
    let dir = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(format!(
        "batch-journal-{}-{}",
        std::process::id(),
        COUNTER.fetch_add(1, Ordering::SeqCst)
    ));
    let _ = fs::remove_dir_all(&dir);
    dir
}

fn files(dir: &Path) -> Vec<String> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut names: Vec<String> = entries
        .map(|e| e.unwrap().file_name().into_string().unwrap())
        .collect();
    names.sort();
    names
}

/// A harness with a journal, a long lease and a clock that moves 20 seconds at every input read.
fn harness_with_journal(dir: &Path) -> Harness {
    let mut harness = Harness::new();
    harness.set(ENV_SCRATCH_DIR, dir.to_str().unwrap());
    let mut world = harness.world();
    world.lease_seconds = 3_600;
    world.tick_on_input = 20;
    drop(world);
    harness
}

fn result_digest(harness: &Harness) -> Value {
    harness.world().accepted_on(SUBMISSION).last().unwrap().body["evaluation"]["result"]["digest"]
        .clone()
}

/// The uninterrupted result digest of the 300-session run: the reference.
fn reference_digest() -> Value {
    let manifest = synthetic_manifest(300, 2, 26, &[]);
    let strategy = seed(1);
    let harness = Harness::new();
    let spec = BacktestSpec::new(&manifest, &strategy, "run-journal", "att-reference-1");
    let job = harness.enqueue_backtest(&spec);
    let handled = worker_handled(&harness.poll(), &job.message);
    assert!(
        matches!(&handled, Handled::Completed { summary, .. } if !summary.contains("resumed")),
        "{handled:?}"
    );
    result_digest(&harness)
}

#[test]
fn a_crash_in_the_stepping_is_resumed_from_a_checkpoint_and_gives_the_same_result() {
    let reference = reference_digest();
    let dir = scratch();
    let harness = harness_with_journal(&dir);
    let manifest = synthetic_manifest(300, 2, 26, &[]);
    let strategy = seed(1);
    let first = harness.enqueue_backtest(&BacktestSpec::new(
        &manifest,
        &strategy,
        "run-journal",
        "att-journal-1",
    ));
    // Three reads open the job and each later read is the probe of one chunk, so the thirteenth
    // read is the probe of the tenth chunk: nine chunks are done, and a checkpoint was written
    // after the fourth and the eighth.
    harness.world().on("attempts.input", 13, Action::Crash);
    assert!(
        harness.poll_catching().is_none(),
        "the process died in the stepping"
    );
    assert_eq!(
        files(&dir)
            .iter()
            .filter(|n| n.ends_with(".checkpoint.json"))
            .count(),
        1,
        "one checkpoint body: {:?}",
        files(&dir)
    );
    assert_eq!(
        files(&dir)
            .iter()
            .filter(|n| n.ends_with(".checkpoint.sha256"))
            .count(),
        1
    );
    assert!(harness.world().accepted.is_empty());

    // The queue redelivers the old message: refused. Recovery fences the attempt and dispatches a
    // new one of the same run.
    harness.time.advance(4_000);
    assert!(matches!(
        worker_handled(&harness.poll(), &first.message),
        Handled::NotClaimable { .. }
    ));
    harness.world().fence(&first.attempt_id);
    let second = harness.enqueue_backtest(&BacktestSpec::new(
        &manifest,
        &strategy,
        "run-journal",
        "att-journal-2",
    ));
    let reads_before = harness.world().requests_with("attempts.input");
    let handled = worker_handled(&harness.poll(), &second.message);
    let Handled::Completed {
        summary,
        acked: true,
    } = handled
    else {
        panic!("{handled:?}\n{}", harness.log_text());
    };
    assert!(
        summary.contains("resumed from a checkpoint at 2024-"),
        "{summary}"
    );
    assert_eq!(
        result_digest(&harness),
        reference,
        "the resumed run is the uninterrupted run"
    );
    // The resumed attempt stepped fewer chunks than a whole run: 300 sessions of four phases are
    // 1,200 events, 40 chunks of 30, and 8 chunks were already done.
    let reads_after = harness.world().requests_with("attempts.input");
    assert_eq!(
        reads_after - reads_before,
        3 + 32 + 1,
        "3 opening reads, 32 probes, the cohort policy"
    );
    assert!(
        files(&dir).is_empty(),
        "the journal is cleared once the result is committed"
    );
}

#[test]
fn a_checkpoint_that_fails_its_content_hash_is_never_trusted() {
    let reference = reference_digest();
    let dir = scratch();
    let harness = harness_with_journal(&dir);
    let manifest = synthetic_manifest(300, 2, 26, &[]);
    let strategy = seed(1);
    let first = harness.enqueue_backtest(&BacktestSpec::new(
        &manifest,
        &strategy,
        "run-journal",
        "att-journal-1",
    ));
    harness.world().on("attempts.input", 13, Action::Crash);
    assert!(harness.poll_catching().is_none());
    // One byte appended: the whitespace changes nothing that a parse would notice, so only the
    // content hash can see it.
    let body = fs::read_dir(&dir)
        .unwrap()
        .map(|e| e.unwrap().path())
        .find(|p| p.to_string_lossy().ends_with(".checkpoint.json"))
        .unwrap();
    let mut bytes = fs::read(&body).unwrap();
    bytes.push(b' ');
    fs::write(&body, bytes).unwrap();

    harness.time.advance(4_000);
    assert!(matches!(
        worker_handled(&harness.poll(), &first.message),
        Handled::NotClaimable { .. }
    ));
    harness.world().fence(&first.attempt_id);
    let second = harness.enqueue_backtest(&BacktestSpec::new(
        &manifest,
        &strategy,
        "run-journal",
        "att-journal-2",
    ));
    let handled = worker_handled(&harness.poll(), &second.message);
    let Handled::Completed {
        summary,
        acked: true,
    } = handled
    else {
        panic!("{handled:?}");
    };
    assert!(
        !summary.contains("resumed"),
        "the damaged checkpoint was refused: {summary}"
    );
    assert_eq!(
        result_digest(&harness),
        reference,
        "the run started again and gave the same result"
    );
    assert!(files(&dir).is_empty());
}

#[test]
fn the_checkpoint_of_another_run_is_never_found() {
    let dir = scratch();
    let harness = harness_with_journal(&dir);
    let manifest = synthetic_manifest(300, 2, 26, &[]);
    let strategy = seed(1);
    harness.enqueue_backtest(&BacktestSpec::new(
        &manifest,
        &strategy,
        "run-journal-a",
        "att-a-1",
    ));
    harness.world().on("attempts.input", 13, Action::Crash);
    assert!(harness.poll_catching().is_none());
    assert_eq!(files(&dir).len(), 2);
    // A different run on the same disk: its key differs, so it starts from the first event.
    let other = harness.enqueue_backtest(&BacktestSpec::new(
        &manifest,
        &strategy,
        "run-journal-b",
        "att-b-1",
    ));
    let handled = worker_handled(&harness.poll(), &other.message);
    let Handled::Completed { summary, .. } = handled else {
        panic!("{handled:?}");
    };
    assert!(!summary.contains("resumed"), "{summary}");
    // The checkpoint of the run that died is still there, untouched.
    assert_eq!(files(&dir).len(), 2);
}

#[test]
fn without_a_scratch_directory_nothing_is_written() {
    let harness = Harness::new();
    let manifest = synthetic_manifest(300, 2, 26, &[]);
    let strategy = seed(1);
    let job = harness.enqueue_backtest(&BacktestSpec::new(
        &manifest,
        &strategy,
        "run-journal-off",
        "att-off-1",
    ));
    assert!(matches!(
        worker_handled(&harness.poll(), &job.message),
        Handled::Completed { .. }
    ));
    assert!(harness.config().scratch_dir.is_none());
}

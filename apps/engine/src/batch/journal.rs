//! An optional local crash-recovery journal for a long evaluation (OQ-05 sections 4 and 5).
//!
//! "Long evaluations must be bounded or checkpointed to fit the documented visibility window."
//! A worst-case run takes seconds, so the journal is off unless `OPENQUANT_SCRATCH_DIR` names a
//! directory. It is scratch space on the Machine's disk (a Fly root disk is ephemeral), not a
//! second record: the API never reads it, and the official result is still the one that the
//! worker submits.
//!
//! The journal holds, for one run, the latest checkpoint of the shared core and its content hash.
//! A new attempt of the same run on the same disk reads the hash file, hands the bytes and the
//! hash to `Run::restore_stored`, which checks the hash before it parses a byte and then checks the
//! strategy, input and engine identities and the cursor. Anything wrong (a missing file, a damaged
//! body, a hash that does not match, a checkpoint of another run) means the evaluation starts from
//! the first event, and the stale files are removed. A resumed run reaches the same state as an
//! uninterrupted one: the core's tests restore from every phase boundary and compare.

use std::{
    fs,
    path::{Path, PathBuf},
};

use openquant_contracts::{canonical::digest_bytes, canonical_json, to_value};
use openquant_core::{Run, State};

/// A checkpoint is written after this many chunks of events (one chunk is `CHUNK_EVENTS`).
pub const CHUNKS_PER_CHECKPOINT: usize = 4;

/// The journal of one run.
#[derive(Clone, Debug)]
pub struct Journal {
    body: PathBuf,
    hash: PathBuf,
}

impl Journal {
    /// The journal of the run that this attempt evaluates, under `dir`. The key binds the run, the
    /// input, the strategy and the engine, so a journal of another run is never found.
    #[must_use]
    pub fn for_run(dir: &Path, run_id: &str, run: &Run) -> Self {
        let key = digest_bytes(
            format!(
                "{run_id}|{}|{}|{}",
                run.input_hash, run.strategy_hash, run.engine_digest
            )
            .as_bytes(),
        );
        let stem = key.trim_start_matches("sha256:");
        Self {
            body: dir.join(format!("{stem}.checkpoint.json")),
            hash: dir.join(format!("{stem}.checkpoint.sha256")),
        }
    }

    /// The state that the journal holds, after the content hash check. `None` when there is no
    /// usable checkpoint; an unusable one is removed.
    #[must_use]
    pub fn resume(&self, run: &Run) -> Option<State> {
        let expected = fs::read_to_string(&self.hash).ok()?;
        let bytes = fs::read(&self.body).ok()?;
        match run.restore_stored(&bytes, expected.trim()) {
            Ok(state) => Some(state),
            Err(_) => {
                self.clear();
                None
            }
        }
    }

    /// Write the checkpoint of `state`. Best effort: a failure leaves the journal as it was.
    pub fn save(&self, run: &Run, state: &State) {
        let Ok(checkpoint) = run.checkpoint(state) else {
            return;
        };
        let Ok(value) = to_value(&checkpoint) else {
            return;
        };
        let Ok(text) = canonical_json(&value) else {
            return;
        };
        if let Some(parent) = self.body.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let body_tmp = self.body.with_extension("json.tmp");
        let hash_tmp = self.hash.with_extension("sha256.tmp");
        // The body first, then its hash: a crash between the two leaves a hash that does not match
        // the body, which `resume` refuses.
        let written = fs::write(&body_tmp, text.as_bytes())
            .and_then(|()| fs::rename(&body_tmp, &self.body))
            .and_then(|()| fs::write(&hash_tmp, digest_bytes(text.as_bytes())))
            .and_then(|()| fs::rename(&hash_tmp, &self.hash));
        if written.is_err() {
            let _ = fs::remove_file(&body_tmp);
            let _ = fs::remove_file(&hash_tmp);
        }
    }

    /// Remove the journal: the run was submitted, or its checkpoint was refused.
    pub fn clear(&self) {
        let _ = fs::remove_file(&self.body);
        let _ = fs::remove_file(&self.hash);
    }

    /// The path of the checkpoint body, for a test.
    #[must_use]
    pub fn body_path(&self) -> &Path {
        &self.body
    }
}

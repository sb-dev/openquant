//! Helpers shared by the integration tests of the S0 harness.

#![allow(
    dead_code,
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use std::{
    fs,
    path::{Path, PathBuf},
};

use openquant_engine::{
    case::{Case, load_case},
    report::Header,
};

/// The committed S0 fixtures.
pub fn fixtures() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/s0")
}

/// Load one committed case by id.
pub fn load(id: &str) -> Case {
    let dir = fixtures().join("cases").join(id);
    load_case(&dir).unwrap_or_else(|e| panic!("cannot load case {id}: {e}"))
}

/// An empty directory below the cargo test directory, unique per name.
pub fn fresh_dir(name: &str) -> PathBuf {
    let dir = Path::new(env!("CARGO_TARGET_TMPDIR"))
        .join("s0-harness")
        .join(name);
    if dir.exists() {
        fs::remove_dir_all(&dir).expect("clear the test directory");
    }
    fs::create_dir_all(&dir).expect("create the test directory");
    dir
}

/// Copy the files of one directory (case directories hold no subdirectories).
pub fn copy_files(from: &Path, to: &Path) {
    fs::create_dir_all(to).expect("create the target directory");
    for entry in fs::read_dir(from).expect("read the source directory") {
        let entry = entry.expect("directory entry");
        fs::copy(entry.path(), to.join(entry.file_name())).expect("copy a file");
    }
}

/// A report header with recognisable values.
pub fn header() -> Header {
    Header {
        source_revision: "REVISION-MARKER".to_owned(),
        command: "COMMAND-MARKER".to_owned(),
        toolchain: "TOOLCHAIN-MARKER".to_owned(),
        fixtures: "fixtures/s0".to_owned(),
        filter: None,
        coverage_problems: Vec::new(),
    }
}

/// Every file below `root` as (relative path, bytes), sorted by path.
pub fn tree(root: &Path) -> Vec<(String, Vec<u8>)> {
    fn walk(dir: &Path, root: &Path, out: &mut Vec<(String, Vec<u8>)>) {
        let mut entries: Vec<_> = fs::read_dir(dir)
            .expect("read a directory")
            .map(|e| e.expect("directory entry").path())
            .collect();
        entries.sort();
        for path in entries {
            if path.is_dir() {
                walk(&path, root, out);
            } else {
                let relative = path
                    .strip_prefix(root)
                    .expect("below the root")
                    .to_string_lossy()
                    .into_owned();
                out.push((relative, fs::read(&path).expect("read a file")));
            }
        }
    }
    let mut out = Vec::new();
    walk(root, root, &mut out);
    out
}

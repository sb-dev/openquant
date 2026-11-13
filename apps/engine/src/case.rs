//! Fixture case loading.
//!
//! A case directory holds `case.json`, the strategy and input payloads, `expected.json` and
//! `derivation.md`. See `fixtures/s0/README.md` for the formats.

use std::{
    fs,
    path::{Path, PathBuf},
};

use serde::Deserialize;
use serde_json::Value;

/// `case.json`.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CaseFile {
    pub id: String,
    pub title: String,
    /// Names of the OQ-06 section 8 acceptance rows this case demonstrates.
    pub covers: Vec<String>,
    pub strategy: String,
    pub input: String,
    pub expected: String,
    pub derivation: String,
    /// Restore from every phase boundary and compare with uninterrupted execution.
    #[serde(default)]
    pub restore_every_cut: bool,
}

/// A loaded case.
#[derive(Clone, Debug)]
pub struct Case {
    pub dir: PathBuf,
    pub file: CaseFile,
    pub strategy_text: String,
    pub input_text: String,
    pub expected: Value,
    pub derivation: String,
}

fn read(path: &Path) -> Result<String, String> {
    fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))
}

/// Load one case directory.
///
/// # Errors
/// A readable message naming the file that is missing or malformed.
pub fn load_case(dir: &Path) -> Result<Case, String> {
    let file: CaseFile = serde_json::from_str(&read(&dir.join("case.json"))?)
        .map_err(|e| format!("{}/case.json: {e}", dir.display()))?;
    let expected: Value = serde_json::from_str(&read(&dir.join(&file.expected))?)
        .map_err(|e| format!("{}/{}: {e}", dir.display(), file.expected))?;
    Ok(Case {
        strategy_text: read(&dir.join(&file.strategy))?,
        input_text: read(&dir.join(&file.input))?,
        derivation: read(&dir.join(&file.derivation))?,
        expected,
        file,
        dir: dir.to_path_buf(),
    })
}

/// Load every case under `root/cases`, sorted by id.
///
/// # Errors
/// A readable message for the first unreadable case.
pub fn load_cases(root: &Path) -> Result<Vec<Case>, String> {
    let mut dirs: Vec<PathBuf> = fs::read_dir(root.join("cases"))
        .map_err(|e| format!("{}/cases: {e}", root.display()))?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.is_dir())
        .collect();
    dirs.sort();
    let mut cases = Vec::new();
    for dir in dirs {
        cases.push(load_case(&dir)?);
    }
    Ok(cases)
}

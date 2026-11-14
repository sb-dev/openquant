//! `contracts-report`: run every protocol fixture through the Rust contract layer and write the
//! verdicts, for the TypeScript parity test (OQ-05 section 7).
//!
//! Usage: `cargo run --locked -p openquant-contracts --bin contracts-report -- --out DIR [--fixtures DIR]`
//!
//! It reads `<fixtures>/protocol/manifest.json` (default `fixtures`) and writes
//! `<out>/report.json`:
//!
//! ```json
//! {"schema":"contracts-report/1","manifest_sha256":"<hex>","entries":[
//!   {"path":"…","contract":"…","expect":"…","verdict":"accepted","digest":"sha256:…"},
//!   {"path":"…","contract":"…","expect":"…","verdict":"rejected","code":"SCHEMA_VIOLATION"}]}
//! ```
//!
//! The verdict is the contract layer's only: strict JSON, the version tag, the schema with the
//! decimal and `Exact` classification and the structural limits, then the typed binding. Core
//! semantics are never run, so a `semantic_invalid` fixture is `accepted`. Entries keep manifest
//! order. `manifest_sha256` is the lower-case hex SHA-256 of the manifest file bytes.
//!
//! Exit status: 0 when the report is written. 2 for a usage error, an I/O error, a malformed
//! manifest or an entry whose contract this build does not know.

use std::{
    path::{Path, PathBuf},
    process::ExitCode,
};

use openquant_contracts::{AnyContract, digest_bytes};
use serde::Serialize;
use serde_json::Value;

const USAGE: &str = "usage: contracts-report --out DIR [--fixtures DIR]";

/// Identifies the report format. The TypeScript parity test reads it.
const REPORT_SCHEMA: &str = "contracts-report/1";

#[derive(Debug, Serialize)]
struct Report {
    schema: &'static str,
    manifest_sha256: String,
    entries: Vec<Entry>,
}

#[derive(Debug, Serialize)]
struct Entry {
    path: String,
    contract: String,
    expect: String,
    verdict: Verdict,
    #[serde(skip_serializing_if = "Option::is_none")]
    code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    digest: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
enum Verdict {
    Accepted,
    Rejected,
}

struct Args {
    fixtures: PathBuf,
    out: PathBuf,
}

fn parse_args(raw: &[String]) -> Result<Args, String> {
    let mut fixtures = PathBuf::from("fixtures");
    let mut out = None;
    let mut iter = raw.iter();
    while let Some(flag) = iter.next() {
        let value = iter.next().ok_or_else(|| format!("{flag} needs a value"))?;
        match flag.as_str() {
            "--fixtures" => fixtures = PathBuf::from(value),
            "--out" => out = Some(PathBuf::from(value)),
            other => return Err(format!("unknown flag {other}")),
        }
    }
    let out = out.ok_or("--out is required")?;
    Ok(Args { fixtures, out })
}

fn text_field(entry: &Value, position: usize, name: &str) -> Result<String, String> {
    entry
        .get(name)
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| format!("manifest entry {position}: `{name}` is missing or not a string"))
}

/// Run one manifest entry through the contract layer.
fn check(fixtures: &Path, entry: &Value, position: usize) -> Result<Entry, String> {
    let path = text_field(entry, position, "path")?;
    let contract = text_field(entry, position, "contract")?;
    let expect = text_field(entry, position, "expect")?;
    let kind = AnyContract::from_name(&contract)
        .ok_or_else(|| format!("{path}: unknown contract {contract:?}"))?;
    let file = fixtures.join(&path);
    let text = std::fs::read_to_string(&file).map_err(|e| format!("{}: {e}", file.display()))?;
    let (verdict, code, digest) = match kind.parse_digest(&text) {
        Ok(digest) => (Verdict::Accepted, None, Some(digest)),
        Err(error) => (
            Verdict::Rejected,
            Some(error.failure_code().to_string()),
            None,
        ),
    };
    Ok(Entry {
        path,
        contract,
        expect,
        verdict,
        code,
        digest,
    })
}

/// Build the report for `<fixtures>/protocol/manifest.json`.
fn report(fixtures: &Path) -> Result<Report, String> {
    let manifest_path = fixtures.join("protocol/manifest.json");
    let bytes =
        std::fs::read(&manifest_path).map_err(|e| format!("{}: {e}", manifest_path.display()))?;
    let manifest: Value =
        serde_json::from_slice(&bytes).map_err(|e| format!("{}: {e}", manifest_path.display()))?;
    let listed = manifest
        .get("entries")
        .and_then(Value::as_array)
        .ok_or_else(|| format!("{}: no entries list", manifest_path.display()))?;
    let entries = listed
        .iter()
        .enumerate()
        .map(|(position, entry)| check(fixtures, entry, position))
        .collect::<Result<Vec<_>, _>>()?;
    let hash = digest_bytes(&bytes);
    let manifest_sha256 = hash.strip_prefix("sha256:").unwrap_or(&hash).to_owned();
    Ok(Report {
        schema: REPORT_SCHEMA,
        manifest_sha256,
        entries,
    })
}

fn write(out: &Path, report: &Report) -> Result<PathBuf, String> {
    std::fs::create_dir_all(out).map_err(|e| format!("{}: {e}", out.display()))?;
    let mut text = serde_json::to_string_pretty(report).map_err(|e| e.to_string())?;
    text.push('\n');
    let file = out.join("report.json");
    std::fs::write(&file, text).map_err(|e| format!("{}: {e}", file.display()))?;
    Ok(file)
}

fn main() -> ExitCode {
    let raw: Vec<String> = std::env::args().skip(1).collect();
    if raw.iter().any(|a| a == "--help" || a == "-h") {
        println!("{USAGE}");
        return ExitCode::SUCCESS;
    }
    let args = match parse_args(&raw) {
        Ok(args) => args,
        Err(message) => {
            eprintln!("error: {message}\n{USAGE}");
            return ExitCode::from(2);
        }
    };
    let written = report(&args.fixtures).and_then(|report| {
        let file = write(&args.out, &report)?;
        Ok((report, file))
    });
    match written {
        Ok((report, file)) => {
            let accepted = report
                .entries
                .iter()
                .filter(|e| e.verdict == Verdict::Accepted)
                .count();
            println!(
                "{} entries, {} accepted, {} rejected. Report: {}",
                report.entries.len(),
                accepted,
                report.entries.len().saturating_sub(accepted),
                file.display()
            );
            ExitCode::SUCCESS
        }
        Err(message) => {
            eprintln!("error: {message}");
            ExitCode::from(2)
        }
    }
}

#[cfg(test)]
#[allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]
mod tests {
    use std::path::{Path, PathBuf};

    use openquant_contracts::{digest, parse_json};
    use serde_json::{Value, json};

    use super::{Verdict, check, parse_args, report};

    fn fixtures() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../fixtures")
    }

    /// The contract layer's verdict agrees with every manifest expectation: `valid` and
    /// `semantic_invalid` are accepted, `schema_invalid` is rejected with the manifest code.
    #[test]
    fn every_verdict_matches_the_manifest_expectation() {
        let report = report(&fixtures()).unwrap();
        let manifest: Value = serde_json::from_str(
            &std::fs::read_to_string(fixtures().join("protocol/manifest.json")).unwrap(),
        )
        .unwrap();
        let listed = manifest["entries"].as_array().unwrap();
        assert_eq!(report.entries.len(), listed.len());
        let mut problems = Vec::new();
        for (entry, listed) in report.entries.iter().zip(listed) {
            assert_eq!(entry.path, listed["path"], "entries keep manifest order");
            let wanted = match entry.expect.as_str() {
                "valid" | "semantic_invalid" => (Verdict::Accepted, None),
                "schema_invalid" => (
                    Verdict::Rejected,
                    Some(listed["code"].as_str().unwrap().to_owned()),
                ),
                other => panic!("{}: unrecognised expect {other:?}", entry.path),
            };
            if (entry.verdict, entry.code.clone()) != wanted {
                problems.push(format!(
                    "{}: expected {wanted:?}, found ({:?}, {:?})",
                    entry.path, entry.verdict, entry.code
                ));
            }
            match entry.verdict {
                Verdict::Accepted => {
                    let text = std::fs::read_to_string(fixtures().join(&entry.path)).unwrap();
                    assert_eq!(
                        entry.digest.as_deref(),
                        Some(digest(&parse_json(&text).unwrap()).unwrap().as_str()),
                        "{}: the digest is the canonical digest of the parsed payload",
                        entry.path
                    );
                }
                Verdict::Rejected => assert_eq!(entry.digest, None, "{}", entry.path),
            }
        }
        assert!(problems.is_empty(), "{problems:#?}");
    }

    #[test]
    fn the_report_has_the_shared_format() {
        let report = report(&fixtures()).unwrap();
        let value = serde_json::to_value(&report).unwrap();
        assert_eq!(value["schema"], "contracts-report/1");
        let hash = value["manifest_sha256"].as_str().unwrap();
        assert!(
            hash.len() == 64
                && hash
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)),
            "{hash}"
        );
        let keys = |entry: &Value| {
            let mut keys: Vec<String> = entry.as_object().unwrap().keys().cloned().collect();
            keys.sort();
            keys
        };
        for entry in value["entries"].as_array().unwrap() {
            let expected: &[&str] = if entry["verdict"] == "accepted" {
                &["contract", "digest", "expect", "path", "verdict"]
            } else {
                assert_eq!(entry["verdict"], "rejected");
                &["code", "contract", "expect", "path", "verdict"]
            };
            assert_eq!(keys(entry), expected, "{entry}");
        }
    }

    #[test]
    fn an_unknown_contract_or_a_missing_file_is_an_error() {
        let entry = |contract: &str, path: &str| json!({"path": path, "contract": contract, "expect": "valid"});
        let error =
            check(&fixtures(), &entry("strategy", "protocol/manifest.json"), 0).unwrap_err();
        assert!(error.contains("unknown contract \"strategy\""), "{error}");
        let error = check(&fixtures(), &entry("checkpoint", "protocol/none.json"), 3).unwrap_err();
        assert!(error.contains("none.json"), "{error}");
        let error = check(&fixtures(), &json!({"contract": "checkpoint"}), 7).unwrap_err();
        assert!(error.contains("manifest entry 7: `path`"), "{error}");
        assert!(report(Path::new("/nonexistent-fixtures")).is_err());
    }

    #[test]
    fn out_is_required_and_flags_need_values() {
        let args =
            |raw: &[&str]| parse_args(&raw.iter().map(|s| (*s).to_owned()).collect::<Vec<_>>());
        assert!(args(&[]).is_err());
        assert!(args(&["--out"]).is_err());
        assert!(args(&["--out", "x", "--other", "y"]).is_err());
        let parsed = args(&["--out", "x"]).unwrap();
        assert_eq!(parsed.out, PathBuf::from("x"));
        assert_eq!(parsed.fixtures, PathBuf::from("fixtures"));
    }
}

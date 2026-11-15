//! The `engine-batch` binary: its usage, its configuration errors and its exit codes. The binary
//! runs with an empty environment plus the variables of each test, and none of these tests reaches
//! a network: a configuration error ends the process first, `--check-config` ends it after the
//! configuration is read, and a stop file ends the worker before its first pull.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use std::{
    fs,
    path::PathBuf,
    process::{Command, Output},
};

const BIN: &str = env!("CARGO_BIN_EXE_engine-batch");

const COMPLETE: [(&str, &str); 6] = [
    ("OPENQUANT_ENVIRONMENT", "STAGING"),
    ("OPENQUANT_API_URL", "https://api.openquant.example"),
    (
        "OPENQUANT_API_TOKEN",
        "synthetic-api-token-secret-value-0001",
    ),
    ("OPENQUANT_QUEUE_ACCOUNT_ID", "acct0123"),
    ("OPENQUANT_QUEUE_ID", "queue0123"),
    (
        "OPENQUANT_QUEUE_TOKEN",
        "synthetic-queue-token-secret-value-0001",
    ),
];

fn run(args: &[&str], env: &[(&str, &str)]) -> Output {
    Command::new(BIN)
        .args(args)
        .env_clear()
        .envs(env.iter().copied())
        .output()
        .expect("the binary runs")
}

fn text(bytes: &[u8]) -> String {
    String::from_utf8(bytes.to_vec()).unwrap()
}

#[test]
fn help_prints_the_usage_and_exits_zero() {
    for flag in ["--help", "-h"] {
        let output = run(&[flag], &[]);
        assert_eq!(output.status.code(), Some(0), "{flag}");
        let usage = text(&output.stdout);
        assert!(
            usage.contains("usage: engine-batch") && usage.contains("OPENQUANT_QUEUE_TOKEN"),
            "{usage}"
        );
        assert!(
            usage.contains("OPENQUANT_MARKET_RETRIEVAL") && usage.contains("enabled"),
            "{usage}"
        );
    }
}

#[test]
fn an_unknown_argument_is_a_usage_error() {
    for args in [
        &["--frobnicate"][..],
        &["--check-config", "extra"][..],
        &["run"][..],
    ] {
        let output = run(args, &COMPLETE);
        assert_eq!(output.status.code(), Some(2), "{args:?}");
        assert!(
            text(&output.stderr).contains("usage: engine-batch"),
            "{args:?}"
        );
        assert!(output.stdout.is_empty());
    }
}

#[test]
fn a_missing_variable_fails_closed_and_names_the_variable_only() {
    // With nothing set, the first variable that is needed is named.
    let output = run(&["--check-config"], &[]);
    assert_eq!(output.status.code(), Some(2));
    assert!(
        text(&output.stderr).contains("OPENQUANT_ENVIRONMENT is not set"),
        "{}",
        text(&output.stderr)
    );
    // With each required variable left out in turn, that variable is named.
    for (missing, _) in COMPLETE {
        let env: Vec<(&str, &str)> = COMPLETE
            .iter()
            .copied()
            .filter(|(name, _)| *name != missing)
            .collect();
        let output = run(&["--check-config"], &env);
        assert_eq!(output.status.code(), Some(2), "{missing}");
        let stderr = text(&output.stderr);
        assert!(stderr.contains(missing), "{missing}: {stderr}");
        for (_, value) in COMPLETE {
            assert!(
                !stderr.contains(value),
                "{missing}: a value is in the error"
            );
        }
        assert!(text(&output.stdout).is_empty());
    }
}

#[test]
fn an_invalid_value_is_refused_without_being_printed() {
    let mut env = COMPLETE.to_vec();
    env[1] = (
        "OPENQUANT_API_URL",
        "http://user:swordfish@api.openquant.example",
    );
    let output = run(&["--check-config"], &env);
    assert_eq!(output.status.code(), Some(2));
    let stderr = text(&output.stderr);
    assert!(
        stderr.contains("OPENQUANT_API_URL") && stderr.contains("https://"),
        "{stderr}"
    );
    assert!(!stderr.contains("swordfish"), "{stderr}");
}

#[test]
fn a_complete_configuration_is_accepted_and_nothing_secret_is_printed() {
    let output = run(&["--check-config"], &COMPLETE);
    assert_eq!(output.status.code(), Some(0), "{}", text(&output.stderr));
    assert_eq!(text(&output.stdout), "configuration ok\n");
    let everything = text(&output.stdout) + &text(&output.stderr);
    for (_, value) in COMPLETE {
        assert!(!everything.contains(value));
    }
}

#[test]
fn a_stop_file_ends_the_worker_before_its_first_pull() {
    let dir = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join("batch-cli");
    fs::create_dir_all(&dir).unwrap();
    let stop = dir.join(format!("stop-{}", std::process::id()));
    fs::write(&stop, b"stop").unwrap();
    let mut env = COMPLETE.to_vec();
    env.push(("OPENQUANT_STOP_FILE", stop.to_str().unwrap()));
    // Two workers are started and both stop at once; the API and the queue are never contacted
    // (their hosts do not exist), so a pull would fail the test by hanging or by an error line.
    env.push(("OPENQUANT_CONCURRENCY", "2"));
    let output = run(&[], &env);
    assert_eq!(output.status.code(), Some(0), "{}", text(&output.stderr));
    let stderr = text(&output.stderr);
    assert!(
        stderr.contains("starting in STAGING with 2 worker(s)"),
        "{stderr}"
    );
    assert!(!stderr.contains("pull failed"), "{stderr}");
    for (name, value) in COMPLETE {
        if name.ends_with("_TOKEN") {
            assert!(!stderr.contains(value), "a credential is in the log");
        }
    }
    fs::remove_file(stop).unwrap();
}

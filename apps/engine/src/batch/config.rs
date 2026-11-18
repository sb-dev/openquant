//! Configuration of the batch binary: environment variables, read once, fail closed.
//!
//! Nothing here has a default for a credential, an environment or a host. A missing or invalid
//! variable stops the process before it pulls a message, and the error names the variable, never
//! its value. Provider retrieval is off unless `OPENQUANT_MARKET_RETRIEVAL` is exactly `enabled`
//! (the gate of `market::gate`) and the recorded probe evidence says every fact is verified.

use std::{fmt, fs, path::PathBuf, time::Duration};

use serde::Deserialize;

use super::{egress::Origin, secret::Secret};
use crate::market::{
    gate::{Fact, ProviderEvidence, RetrievalSwitch},
    http::Credentials,
    normalise::UseConstraints,
};

/// The environment of the deployment (`DeploymentEnvironment`).
pub const ENV_ENVIRONMENT: &str = "OPENQUANT_ENVIRONMENT";
/// The `https://` origin of the application API.
pub const ENV_API_URL: &str = "OPENQUANT_API_URL";
/// The credential of the `batch` service principal.
pub const ENV_API_TOKEN: &str = "OPENQUANT_API_TOKEN";
/// The Cloudflare account that owns the queue.
pub const ENV_QUEUE_ACCOUNT: &str = "OPENQUANT_QUEUE_ACCOUNT_ID";
/// The queue identifier.
pub const ENV_QUEUE_ID: &str = "OPENQUANT_QUEUE_ID";
/// The minimum-scope Queues consumer token (pull and acknowledge).
pub const ENV_QUEUE_TOKEN: &str = "OPENQUANT_QUEUE_TOKEN";
/// The Alpaca key id of a paper account.
pub const ENV_ALPACA_KEY_ID: &str = "OPENQUANT_ALPACA_KEY_ID";
/// The Alpaca secret of a paper account.
pub const ENV_ALPACA_SECRET: &str = "OPENQUANT_ALPACA_SECRET";
/// The recorded probe evidence (JSON) that the gate reads.
pub const ENV_PROVIDER_EVIDENCE: &str = "OPENQUANT_PROVIDER_EVIDENCE_FILE";
/// Attempts that run at the same time, 1 or 2.
pub const ENV_CONCURRENCY: &str = "OPENQUANT_CONCURRENCY";
/// The visibility timeout of a pulled message, in seconds.
pub const ENV_VISIBILITY: &str = "OPENQUANT_VISIBILITY_SECONDS";
/// A file whose existence asks the worker to stop after its current job.
pub const ENV_STOP_FILE: &str = "OPENQUANT_STOP_FILE";
/// A directory for the optional local checkpoint journal of a long evaluation. Off when unset.
pub const ENV_SCRATCH_DIR: &str = "OPENQUANT_SCRATCH_DIR";
/// Test only: the loopback port that every allowlisted host resolves to (see [`LoopbackTest`]).
pub const ENV_TEST_LOOPBACK_PORT: &str = "OPENQUANT_TEST_LOOPBACK_PORT";
/// Test only: the absolute path of the one DER certificate authority that the loopback wire trusts.
pub const ENV_TEST_LOOPBACK_ROOT: &str = "OPENQUANT_TEST_LOOPBACK_ROOT";

/// Whether this build accepts the test-only loopback variables: debug builds only. A release build,
/// which is what a Machine image runs, refuses to start when either variable is set.
pub const LOOPBACK_TEST_BUILD: bool = cfg!(debug_assertions);

/// The most attempts that run at the same time (the cohort policy of the pilot).
pub const MAX_CONCURRENCY: usize = 2;

/// Seconds the worker keeps before a lease ends: it stops work and submits nothing after
/// `lease_expires_at` minus this margin.
pub const LEASE_MARGIN_SECONDS: i64 = 30;

/// The per-attempt timeouts of the batch jobs that this host is built for, in seconds. The cohort
/// policy owns the real values (`limits.job_timeouts`); these are the values that the README
/// derives from the measured worst case, and that the default visibility timeout below follows.
///
/// - `evaluate`: the worst 400-session run took at most 2.55 s in a release build on the
///   development machine (median 2.36 s). Twenty times that for a slower shared CPU is 51 s, rounded
///   up to 60 s, and 60 s more for the reads, the uploads and the start: 120 s.
/// - `assess`: the same rule over the seven runs of the pilot candidate: 120 s.
/// - `validate`: milliseconds of compute and four reads: 60 s.
/// - `retrieve`: bounded by the provider, not by compute. The request carries its own deadline and
///   at most 60 provider requests; the decision record's 10 minutes stay.
pub const PROPOSED_TIMEOUT_SECONDS: [(&str, u64); 4] = [
    ("retrieve", 600),
    ("validate", 60),
    ("evaluate", 120),
    ("assess", 120),
];

/// What the API adds to a timeout to make a lease (`apps/api` claim: `LEASE_GRACE_SECONDS`).
pub const LEASE_GRACE_SECONDS: u64 = 60;

/// Time between a pull and the claim of its message, allowed on top of the lease.
pub const PULL_TO_CLAIM_SLACK_SECONDS: u64 = 60;

/// The longest lease of the proposed timeouts plus the slack between a pull and its claim.
#[must_use]
pub fn derived_visibility_seconds() -> u64 {
    let longest = PROPOSED_TIMEOUT_SECONDS
        .iter()
        .map(|(_, seconds)| *seconds)
        .max()
        .unwrap_or(0);
    longest + LEASE_GRACE_SECONDS + PULL_TO_CLAIM_SLACK_SECONDS
}

/// The visibility timeout of a pulled message when the configuration does not set one: 600 + 60 +
/// 60, which `derived_visibility_seconds` computes and a test pins. It must exceed the longest
/// lease, because a pull does not know the kind of the message: the queue then does not hand a
/// message to a second worker while the first still holds a valid lease. The recovery task of the
/// API, not the queue, decides what happens to an attempt whose lease ended.
pub const DEFAULT_VISIBILITY_SECONDS: u64 = 720;

/// The least and the largest visibility timeout the configuration accepts.
pub const MIN_VISIBILITY_SECONDS: u64 = 60;
pub const MAX_VISIBILITY_SECONDS: u64 = 43_200;

/// Why the configuration is unusable. It names the variable, never its value.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ConfigError {
    Missing(&'static str),
    Invalid { name: &'static str, reason: String },
}

impl fmt::Display for ConfigError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Missing(name) => write!(f, "the variable {name} is not set"),
            Self::Invalid { name, reason } => write!(f, "the variable {name} is invalid: {reason}"),
        }
    }
}

impl std::error::Error for ConfigError {}

/// What the recorded probes established. The file is written by the delivery step, never by this
/// binary.
#[derive(Clone, Debug)]
pub struct EvidenceRecord {
    pub evidence: ProviderEvidence,
    pub constraints: UseConstraints,
    pub licence: String,
}

/// The test-only loopback mode of the connected end-to-end test (OQ-06 section 8). Every host of the
/// egress allowlist resolves to `127.0.0.1:port` and the wire trusts only the certificate authority
/// in `root_der`. The allowlist itself is unchanged: a host, method or path outside it is still
/// refused before any I/O, and the wire is still HTTPS only and follows no redirect. It exists only
/// in a debug build, only in `DEVELOPMENT`, and only when both variables are set.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LoopbackTest {
    pub port: u16,
    pub root_der: PathBuf,
}

/// Read the two test-only variables. `allowed` is [`LOOPBACK_TEST_BUILD`] in the binary.
///
/// # Errors
/// [`ConfigError`] when a variable is set in a build or environment that refuses it, when only one
/// is set, or when a value is not a port or an absolute path.
pub fn loopback_test(
    lookup: &dyn Fn(&str) -> Option<String>,
    environment: &str,
    allowed: bool,
) -> Result<Option<LoopbackTest>, ConfigError> {
    let port = optional(lookup, ENV_TEST_LOOPBACK_PORT);
    let root = optional(lookup, ENV_TEST_LOOPBACK_ROOT);
    if port.is_none() && root.is_none() {
        return Ok(None);
    }
    let name = if port.is_some() {
        ENV_TEST_LOOPBACK_PORT
    } else {
        ENV_TEST_LOOPBACK_ROOT
    };
    if !allowed {
        return Err(invalid(
            name,
            "it is a test-only variable and this build does not accept it",
        ));
    }
    if environment != "DEVELOPMENT" {
        return Err(invalid(
            name,
            "it is a test-only variable and is refused outside DEVELOPMENT",
        ));
    }
    let port = port.ok_or(ConfigError::Missing(ENV_TEST_LOOPBACK_PORT))?;
    let root = root.ok_or(ConfigError::Missing(ENV_TEST_LOOPBACK_ROOT))?;
    let port = match port.parse::<u16>() {
        Ok(n) if n > 0 => n,
        _ => {
            return Err(invalid(
                ENV_TEST_LOOPBACK_PORT,
                "it must be a port from 1 to 65535",
            ));
        }
    };
    let root_der = PathBuf::from(root);
    if !root_der.is_absolute() {
        return Err(invalid(
            ENV_TEST_LOOPBACK_ROOT,
            "it must be an absolute path",
        ));
    }
    Ok(Some(LoopbackTest { port, root_der }))
}

/// The configuration of one batch process.
#[derive(Clone, Debug)]
pub struct Config {
    pub environment: String,
    pub api: Origin,
    pub api_token: Secret,
    pub queue_account_id: String,
    pub queue_id: String,
    pub queue_token: Secret,
    pub market_switch: RetrievalSwitch,
    pub alpaca: Option<Credentials>,
    pub evidence_file: Option<PathBuf>,
    pub concurrency: usize,
    pub visibility: Duration,
    pub stop_file: Option<PathBuf>,
    pub scratch_dir: Option<PathBuf>,
    /// Test only, debug builds only: see [`LoopbackTest`].
    pub loopback: Option<LoopbackTest>,
}

fn required(
    lookup: &dyn Fn(&str) -> Option<String>,
    name: &'static str,
) -> Result<String, ConfigError> {
    match lookup(name) {
        Some(value) if !value.is_empty() => Ok(value),
        _ => Err(ConfigError::Missing(name)),
    }
}

fn optional(lookup: &dyn Fn(&str) -> Option<String>, name: &'static str) -> Option<String> {
    lookup(name).filter(|value| !value.is_empty())
}

fn invalid(name: &'static str, reason: &str) -> ConfigError {
    ConfigError::Invalid {
        name,
        reason: reason.to_owned(),
    }
}

impl Config {
    /// Read the configuration through `lookup` (the environment, or a map in a test).
    ///
    /// # Errors
    /// [`ConfigError`] for the first missing or invalid variable.
    pub fn from_lookup(lookup: &dyn Fn(&str) -> Option<String>) -> Result<Self, ConfigError> {
        let environment = required(lookup, ENV_ENVIRONMENT)?;
        if !["DEVELOPMENT", "STAGING", "PRODUCTION"].contains(&environment.as_str()) {
            return Err(invalid(
                ENV_ENVIRONMENT,
                "it must be DEVELOPMENT, STAGING or PRODUCTION",
            ));
        }
        let api = Origin::parse(&required(lookup, ENV_API_URL)?)
            .map_err(|error| invalid(ENV_API_URL, &error.to_string()))?;
        let queue_account_id = required(lookup, ENV_QUEUE_ACCOUNT)?;
        let queue_id = required(lookup, ENV_QUEUE_ID)?;
        let plain = |text: &str| {
            !text.is_empty()
                && text.len() <= 64
                && text
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        };
        if !plain(&queue_account_id) {
            return Err(invalid(ENV_QUEUE_ACCOUNT, "it is not a plain token"));
        }
        if !plain(&queue_id) {
            return Err(invalid(ENV_QUEUE_ID, "it is not a plain token"));
        }
        let api_token = required(lookup, ENV_API_TOKEN)?;
        let queue_token = required(lookup, ENV_QUEUE_TOKEN)?;
        for (name, token) in [(ENV_API_TOKEN, &api_token), (ENV_QUEUE_TOKEN, &queue_token)] {
            if token.len() < 16 || token.bytes().any(|b| b.is_ascii_control() || b == b' ') {
                return Err(invalid(name, "it is not a bearer token"));
            }
        }
        let alpaca = match (
            optional(lookup, ENV_ALPACA_KEY_ID),
            optional(lookup, ENV_ALPACA_SECRET),
        ) {
            (Some(id), Some(secret)) => Some(Credentials::new(id, secret)),
            (None, None) => None,
            (Some(_), None) => return Err(ConfigError::Missing(ENV_ALPACA_SECRET)),
            (None, Some(_)) => return Err(ConfigError::Missing(ENV_ALPACA_KEY_ID)),
        };
        let concurrency = match optional(lookup, ENV_CONCURRENCY) {
            None => 1,
            Some(text) => match text.parse::<usize>() {
                Ok(n) if (1..=MAX_CONCURRENCY).contains(&n) => n,
                _ => return Err(invalid(ENV_CONCURRENCY, "it must be 1 or 2")),
            },
        };
        let visibility_seconds = match optional(lookup, ENV_VISIBILITY) {
            None => DEFAULT_VISIBILITY_SECONDS,
            Some(text) => match text.parse::<u64>() {
                Ok(n) if (MIN_VISIBILITY_SECONDS..=MAX_VISIBILITY_SECONDS).contains(&n) => n,
                _ => {
                    return Err(invalid(
                        ENV_VISIBILITY,
                        "it must be a number of seconds from 60 to 43200",
                    ));
                }
            },
        };
        let loopback = loopback_test(lookup, &environment, LOOPBACK_TEST_BUILD)?;
        Ok(Self {
            environment,
            api,
            api_token: Secret::new(api_token),
            queue_account_id,
            queue_id,
            queue_token: Secret::new(queue_token),
            market_switch: RetrievalSwitch::from_config(lookup),
            alpaca,
            evidence_file: optional(lookup, ENV_PROVIDER_EVIDENCE).map(PathBuf::from),
            concurrency,
            visibility: Duration::from_secs(visibility_seconds),
            stop_file: optional(lookup, ENV_STOP_FILE).map(PathBuf::from),
            scratch_dir: optional(lookup, ENV_SCRATCH_DIR).map(PathBuf::from),
            loopback,
        })
    }

    /// Read the configuration from the process environment.
    ///
    /// # Errors
    /// [`ConfigError`] for the first missing or invalid variable.
    pub fn from_env() -> Result<Self, ConfigError> {
        Self::from_lookup(&|name| std::env::var(name).ok())
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct EvidenceFile {
    schema: String,
    facts: Facts,
    constraints: ConstraintsFile,
    licence: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Facts {
    paper_authority: FactFile,
    no_live_authority: FactFile,
    data_entitlement: FactFile,
    session_semantics: FactFile,
    egress_refusals: FactFile,
    declaration_field: FactFile,
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum FactFile {
    /// The text `verified`.
    Text(String),
    /// `{"failed": "what the probe saw"}`.
    Failed { failed: String },
}

impl FactFile {
    fn fact(&self) -> Fact {
        match self {
            Self::Text(text) if text == "verified" => Fact::Verified,
            Self::Text(_) => Fact::Unverified,
            Self::Failed { failed } => Fact::Failed(failed.clone()),
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ConstraintsFile {
    redistribution_permitted: bool,
    retain_raw: bool,
    terms_ref: String,
}

/// The tag of the evidence file.
pub const EVIDENCE_SCHEMA: &str = "provider-evidence/1";

impl EvidenceRecord {
    /// Read the recorded evidence from JSON text. Anything other than the exact word `verified`
    /// leaves a fact unverified.
    ///
    /// # Errors
    /// A message when the text is not a valid `provider-evidence/1` document.
    pub fn from_json(text: &str) -> Result<Self, String> {
        let file: EvidenceFile =
            serde_json::from_str(text).map_err(|e| format!("not a provider evidence file: {e}"))?;
        if file.schema != EVIDENCE_SCHEMA {
            return Err(format!("the schema is not {EVIDENCE_SCHEMA}"));
        }
        Ok(Self {
            evidence: ProviderEvidence {
                paper_authority: file.facts.paper_authority.fact(),
                no_live_authority: file.facts.no_live_authority.fact(),
                data_entitlement: file.facts.data_entitlement.fact(),
                session_semantics: file.facts.session_semantics.fact(),
                egress_refusals: file.facts.egress_refusals.fact(),
                declaration_field: file.facts.declaration_field.fact(),
            },
            constraints: UseConstraints {
                redistribution_permitted: file.constraints.redistribution_permitted,
                retain_raw: file.constraints.retain_raw,
                terms_ref: file.constraints.terms_ref,
            },
            licence: file.licence,
        })
    }

    /// Read the evidence file named by the configuration. No file, or a file that cannot be read
    /// or parsed, gives `None`: the gate then finds every fact unverified.
    #[must_use]
    pub fn load(config: &Config) -> Option<Self> {
        let path = config.evidence_file.as_ref()?;
        let text = fs::read_to_string(path).ok()?;
        Self::from_json(&text).ok()
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::*;

    fn base() -> BTreeMap<&'static str, String> {
        BTreeMap::from([
            (ENV_ENVIRONMENT, "STAGING".to_owned()),
            (ENV_API_URL, "https://api.openquant.example".to_owned()),
            (ENV_API_TOKEN, "synthetic-api-token-0123456789".to_owned()),
            (ENV_QUEUE_ACCOUNT, "acct0123".to_owned()),
            (ENV_QUEUE_ID, "queue0123".to_owned()),
            (
                ENV_QUEUE_TOKEN,
                "synthetic-queue-token-0123456789".to_owned(),
            ),
        ])
    }

    fn read(map: &BTreeMap<&'static str, String>) -> Result<Config, ConfigError> {
        Config::from_lookup(&|name| map.get(name).cloned())
    }

    #[test]
    fn a_complete_configuration_reads() {
        let config = read(&base()).unwrap();
        assert_eq!(config.environment, "STAGING");
        assert_eq!(config.api.host(), "api.openquant.example");
        assert_eq!(config.concurrency, 1);
        assert_eq!(
            config.visibility,
            Duration::from_secs(DEFAULT_VISIBILITY_SECONDS)
        );
        assert_eq!(config.market_switch, RetrievalSwitch::Off);
        assert!(config.alpaca.is_none());
        // No secret appears in the printed configuration.
        let text = format!("{config:?}");
        assert!(
            !text.contains("synthetic-api-token") && !text.contains("synthetic-queue-token"),
            "{text}"
        );
    }

    #[test]
    fn the_default_visibility_outlasts_every_lease_and_every_job_fits_its_lease() {
        assert_eq!(DEFAULT_VISIBILITY_SECONDS, 720, "600 + 60 + 60");
        assert_eq!(DEFAULT_VISIBILITY_SECONDS, derived_visibility_seconds());
        for (kind, timeout) in PROPOSED_TIMEOUT_SECONDS {
            let lease = timeout + LEASE_GRACE_SECONDS;
            assert!(
                DEFAULT_VISIBILITY_SECONDS >= lease + PULL_TO_CLAIM_SLACK_SECONDS,
                "{kind}"
            );
            // The worker stops `LEASE_MARGIN_SECONDS` before the lease ends: the whole timeout
            // still fits in front of that deadline.
            let work_seconds = lease - u64::try_from(LEASE_MARGIN_SECONDS).unwrap();
            assert!(
                work_seconds >= timeout,
                "{kind}: {work_seconds} < {timeout}"
            );
        }
        const { assert!(DEFAULT_VISIBILITY_SECONDS >= MIN_VISIBILITY_SECONDS) };
        const { assert!(DEFAULT_VISIBILITY_SECONDS <= MAX_VISIBILITY_SECONDS) };
    }

    #[test]
    fn each_required_variable_is_required_and_an_error_names_only_the_variable() {
        for name in [
            ENV_ENVIRONMENT,
            ENV_API_URL,
            ENV_API_TOKEN,
            ENV_QUEUE_ACCOUNT,
            ENV_QUEUE_ID,
            ENV_QUEUE_TOKEN,
        ] {
            let mut map = base();
            map.remove(name);
            assert_eq!(read(&map).unwrap_err(), ConfigError::Missing(name));
            map.insert(name, String::new());
            assert_eq!(read(&map).unwrap_err(), ConfigError::Missing(name));
        }
    }

    #[test]
    fn invalid_values_are_refused_without_printing_them() {
        let cases: [(&'static str, &str); 7] = [
            (ENV_ENVIRONMENT, "staging"),
            (ENV_API_URL, "http://api.openquant.example"),
            (ENV_API_URL, "https://user:secret-pw@api.openquant.example"),
            (ENV_QUEUE_ID, "queue/../x"),
            (ENV_API_TOKEN, "short"),
            (ENV_CONCURRENCY, "3"),
            (ENV_VISIBILITY, "5"),
        ];
        for (name, value) in cases {
            let mut map = base();
            map.insert(name, value.to_owned());
            let error = read(&map).unwrap_err();
            assert!(
                matches!(&error, ConfigError::Invalid { name: n, .. } if *n == name),
                "{name}"
            );
            let text = error.to_string();
            assert!(
                text.contains(name) && !text.contains("secret-pw") && !text.contains("queue/../x"),
                "{text}"
            );
        }
    }

    #[test]
    fn the_loopback_test_variables_are_refused_in_a_release_build_and_outside_development() {
        let map = |entries: &[(&'static str, &str)]| -> BTreeMap<&'static str, String> {
            entries.iter().map(|(k, v)| (*k, (*v).to_owned())).collect()
        };
        let both = map(&[
            (ENV_TEST_LOOPBACK_PORT, "8443"),
            (ENV_TEST_LOOPBACK_ROOT, "/tmp/root.der"),
        ]);
        let check = |entries: &BTreeMap<&'static str, String>, environment: &str, allowed: bool| {
            loopback_test(&|name| entries.get(name).cloned(), environment, allowed)
        };
        // Neither variable: no loopback, in every build and environment.
        for allowed in [true, false] {
            for environment in ["DEVELOPMENT", "STAGING", "PRODUCTION"] {
                assert_eq!(check(&BTreeMap::new(), environment, allowed), Ok(None));
            }
        }
        // A debug build in DEVELOPMENT with both: the loopback mode.
        assert_eq!(
            check(&both, "DEVELOPMENT", true),
            Ok(Some(LoopbackTest {
                port: 8443,
                root_der: PathBuf::from("/tmp/root.der"),
            }))
        );
        // A release build refuses either variable, in every environment.
        for environment in ["DEVELOPMENT", "STAGING", "PRODUCTION"] {
            for one in [ENV_TEST_LOOPBACK_PORT, ENV_TEST_LOOPBACK_ROOT] {
                let only = map(&[(one, both[one].as_str())]);
                assert!(
                    matches!(check(&only, environment, false), Err(ConfigError::Invalid { name, .. }) if name == one),
                    "{one} in {environment}"
                );
            }
            assert!(check(&both, environment, false).is_err(), "{environment}");
        }
        // A debug build refuses them outside DEVELOPMENT.
        for environment in ["STAGING", "PRODUCTION"] {
            assert!(
                matches!(
                    check(&both, environment, true),
                    Err(ConfigError::Invalid { .. })
                ),
                "{environment}"
            );
        }
        // Both or neither, a real port and an absolute path.
        assert_eq!(
            check(
                &map(&[(ENV_TEST_LOOPBACK_PORT, "8443")]),
                "DEVELOPMENT",
                true
            ),
            Err(ConfigError::Missing(ENV_TEST_LOOPBACK_ROOT))
        );
        assert_eq!(
            check(
                &map(&[(ENV_TEST_LOOPBACK_ROOT, "/tmp/root.der")]),
                "DEVELOPMENT",
                true
            ),
            Err(ConfigError::Missing(ENV_TEST_LOOPBACK_PORT))
        );
        for (name, value) in [
            (ENV_TEST_LOOPBACK_PORT, "0"),
            (ENV_TEST_LOOPBACK_PORT, "65536"),
            (ENV_TEST_LOOPBACK_PORT, "x"),
            (ENV_TEST_LOOPBACK_ROOT, "root.der"),
        ] {
            let mut entries = both.clone();
            entries.insert(name, value.to_owned());
            assert!(
                matches!(check(&entries, "DEVELOPMENT", true), Err(ConfigError::Invalid { name: n, .. }) if n == name),
                "{name}={value}"
            );
        }
        // The configuration reads them with the build's own switch. `base` is STAGING, so even this
        // debug build refuses them there.
        let mut staging = base();
        staging.extend(both.clone());
        assert!(matches!(read(&staging), Err(ConfigError::Invalid { .. })));
        assert_eq!(read(&base()).unwrap().loopback, None);
        assert_eq!(LOOPBACK_TEST_BUILD, cfg!(debug_assertions));
    }

    #[test]
    fn only_the_exact_word_enabled_switches_retrieval_on() {
        for (value, expected) in [
            ("enabled", RetrievalSwitch::On),
            ("ENABLED", RetrievalSwitch::Off),
            ("true", RetrievalSwitch::Off),
            ("1", RetrievalSwitch::Off),
            (" enabled", RetrievalSwitch::Off),
            ("", RetrievalSwitch::Off),
        ] {
            let mut map = base();
            map.insert(crate::market::gate::ENABLE_VARIABLE, value.to_owned());
            assert_eq!(read(&map).unwrap().market_switch, expected, "{value:?}");
        }
    }

    #[test]
    fn the_alpaca_pair_is_both_or_neither() {
        let mut map = base();
        map.insert(ENV_ALPACA_KEY_ID, "synthetic-key-id".to_owned());
        assert_eq!(
            read(&map).unwrap_err(),
            ConfigError::Missing(ENV_ALPACA_SECRET)
        );
        map.insert(ENV_ALPACA_SECRET, "synthetic-secret".to_owned());
        assert!(read(&map).unwrap().alpaca.is_some());
    }

    #[test]
    fn evidence_reads_exactly_and_unknown_text_is_unverified() {
        let text = r#"{"schema":"provider-evidence/1","facts":{"paper_authority":"verified","no_live_authority":"verified","data_entitlement":"verified","session_semantics":{"failed":"daily bars include extended hours"},"egress_refusals":"VERIFIED","declaration_field":"verified"},"constraints":{"redistribution_permitted":false,"retain_raw":true,"terms_ref":"terms"},"licence":"synthetic"}"#;
        let record = EvidenceRecord::from_json(text).unwrap();
        assert_eq!(record.evidence.paper_authority, Fact::Verified);
        assert_eq!(
            record.evidence.session_semantics,
            Fact::Failed("daily bars include extended hours".to_owned())
        );
        assert_eq!(record.evidence.egress_refusals, Fact::Unverified);
        assert!(record.constraints.retain_raw);
        assert!(EvidenceRecord::from_json("{}").is_err());
        assert!(EvidenceRecord::from_json(&text.replace("provider-evidence/1", "x")).is_err());
        assert!(
            EvidenceRecord::from_json(&text.replace("\"licence\"", "\"extra\":1,\"licence\""))
                .is_err()
        );
    }
}

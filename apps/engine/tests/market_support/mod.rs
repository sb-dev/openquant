//! Helpers shared by the integration tests of the market adapter, the normaliser, the gate and the
//! retrieval sequence.
//!
//! A fixture case (`fixtures/market-data/cases/<id>`) holds a full `retrieval-request/1`, the
//! provider responses as bytes and the expected outcome that `oracle/oracle.py` derived. The
//! scripted transport below plays the responses in order and checks each request the adapter
//! builds against the request the oracle expected, so a wrong path, query or page token fails at
//! the call that made it. Nothing here reads the environment, the clock or the network.

#![allow(
    dead_code,
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use std::{
    cell::{Cell, RefCell},
    collections::VecDeque,
    fs,
    path::{Path, PathBuf},
    rc::Rc,
};

use openquant_contracts::{
    canonical::digest_bytes,
    generated::{DatasetManifest, ExecutableIdentity, RetrievalRequest},
    parse, payload_digest,
};
use openquant_engine::market::{
    alpaca::{AlpacaAdapter, EGRESS_RULES},
    error::ErrorClass,
    gate::{Fact, ProviderEvidence, RetrievalPermit, RetrievalSwitch, decide},
    http::{
        Credentials, Host, HttpRequest, HttpResponse, HttpTransport, TransportError,
        TransportLimits,
    },
    normalise::{Snapshot, UseConstraints},
    provider::{CallContext, CallRecord, Cancellation, Clock, Limits, Sleeper, SourceBody},
    retrieve::{HostIdentity, RetrieveError, limits_from_request, retrieve_snapshot},
    time::Timestamp,
};
use serde_json::{Value, json};

/// A synthetic key pair. Not a credential: the fake transport proves it receives it.
pub const KEY_ID: &str = "synthetic-key-id-7f3a";
pub const SECRET: &str = "synthetic-secret-91c4d2";

/// The committed market-data fixtures.
pub fn fixtures() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/market-data")
}

/// The rule text that the normaliser's transformation digest covers.
pub fn rules_path() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("src/market/rules.txt")
}

/// What the oracle expected of one request of the script.
#[derive(Clone, Debug)]
pub struct Expect {
    pub host: String,
    pub path: String,
    pub query: Vec<(String, String)>,
}

/// What the scripted transport answers.
#[derive(Clone, Debug)]
pub enum Reply {
    Response {
        status: u16,
        headers: Vec<(String, String)>,
        body: Vec<u8>,
    },
    Transport(TransportError),
}

/// One request of the script and its answer.
#[derive(Clone, Debug)]
pub struct Step {
    pub expect: Option<Expect>,
    pub reply: Reply,
}

impl Step {
    /// A step that accepts any request and answers 200 with `body`.
    pub fn ok(body: &str) -> Self {
        Self::status(200, body)
    }

    /// A step that accepts any request and answers `status` with `body`.
    pub fn status(status: u16, body: &str) -> Self {
        Self {
            expect: None,
            reply: Reply::Response {
                status,
                headers: Vec::new(),
                body: body.as_bytes().to_vec(),
            },
        }
    }

    /// The same step with one more header.
    pub fn with_header(mut self, name: &str, value: &str) -> Self {
        if let Reply::Response { headers, .. } = &mut self.reply {
            headers.push((name.to_owned(), value.to_owned()));
        }
        self
    }
}

/// A fixture case.
#[derive(Clone, Debug)]
pub struct Case {
    pub id: String,
    pub now: Timestamp,
    pub request: Value,
    pub host: Value,
    pub steps: Vec<Step>,
    pub expected: Value,
    pub derivation: String,
}

fn read(path: &Path) -> Vec<u8> {
    fs::read(path).unwrap_or_else(|e| panic!("cannot read {}: {e}", path.display()))
}

fn read_json(path: &Path) -> Value {
    serde_json::from_slice(&read(path)).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

fn string(value: &Value) -> String {
    value.as_str().expect("a string").to_owned()
}

impl Case {
    /// Load one committed case by id.
    pub fn load(id: &str) -> Self {
        let dir = fixtures().join("cases").join(id);
        let file = read_json(&dir.join("case.json"));
        assert_eq!(file["id"], id, "the directory name is the case id");
        let steps = file["script"]
            .as_array()
            .expect("a script")
            .iter()
            .map(|step| {
                let expect = &step["expect"];
                let reply = &step["reply"];
                Step {
                    expect: Some(Expect {
                        host: string(&expect["host"]),
                        path: string(&expect["path"]),
                        query: expect["query"]
                            .as_array()
                            .expect("a query")
                            .iter()
                            .map(|pair| (string(&pair[0]), string(&pair[1])))
                            .collect(),
                    }),
                    reply: if let Some(kind) = reply.get("transport_error") {
                        Reply::Transport(match kind.as_str().expect("a kind") {
                            "timeout" => TransportError::Timeout,
                            "connection" => TransportError::Connection,
                            "egress_refused" => TransportError::EgressRefused,
                            "body_too_large" => TransportError::BodyTooLarge,
                            other => panic!("unknown transport error {other}"),
                        })
                    } else {
                        Reply::Response {
                            status: u16::try_from(reply["status"].as_u64().expect("a status"))
                                .unwrap(),
                            headers: reply["headers"]
                                .as_array()
                                .expect("headers")
                                .iter()
                                .map(|pair| (string(&pair[0]), string(&pair[1])))
                                .collect(),
                            body: read(&dir.join(string(&reply["body"]))),
                        }
                    },
                }
            })
            .collect();
        Self {
            id: id.to_owned(),
            now: Timestamp::parse(file["now"].as_str().unwrap()).unwrap(),
            request: file["request"].clone(),
            host: file["host"].clone(),
            steps,
            expected: read_json(&dir.join(string(&file["expected"]))),
            derivation: String::from_utf8(read(&dir.join(string(&file["derivation"])))).unwrap(),
        }
    }

    /// Replace the body of the answer of step `index`, keeping its status and headers.
    pub fn replace_body(&mut self, index: usize, body: &str) {
        match &mut self.steps[index].reply {
            Reply::Response { body: old, .. } => *old = body.as_bytes().to_vec(),
            Reply::Transport(_) => panic!("step {index} has no body"),
        }
    }

    /// The text of the body of step `index`.
    pub fn body(&self, index: usize) -> String {
        match &self.steps[index].reply {
            Reply::Response { body, .. } => String::from_utf8(body.clone()).unwrap(),
            Reply::Transport(_) => panic!("step {index} has no body"),
        }
    }

    /// Drop the expectation of every request, so a changed request is not a failure.
    pub fn without_expectations(&mut self) {
        for step in &mut self.steps {
            step.expect = None;
        }
    }
}

/// The identifiers of the cases listed in `cases/index.json`.
pub fn indexed_case_ids() -> Vec<String> {
    let index = read_json(&fixtures().join("cases/index.json"));
    index["cases"]
        .as_array()
        .expect("a case list")
        .iter()
        .map(string)
        .collect()
}

/// The names of the case directories.
pub fn directory_case_ids() -> Vec<String> {
    let mut ids: Vec<String> = fs::read_dir(fixtures().join("cases"))
        .unwrap()
        .map(|entry| entry.unwrap())
        .filter(|entry| entry.path().is_dir())
        .map(|entry| entry.file_name().into_string().unwrap())
        .collect();
    ids.sort();
    ids
}

// ---- fakes --------------------------------------------------------------------------------------

/// A shared flag that a test sets to cancel the retrieval.
#[derive(Clone, Debug, Default)]
pub struct CancelFlag(Rc<Cell<bool>>);

impl CancelFlag {
    pub fn set(&self) {
        self.0.set(true);
    }
}

impl Cancellation for CancelFlag {
    fn is_cancelled(&self) -> bool {
        self.0.get()
    }
}

/// A clock that moves only when the sleeper sleeps.
pub struct SimClock(Cell<i64>);

impl SimClock {
    pub fn at(now: Timestamp) -> Self {
        Self(Cell::new(now.epoch_seconds()))
    }
}

impl Clock for SimClock {
    fn now(&self) -> Timestamp {
        Timestamp::from_epoch_seconds(self.0.get())
    }
}

/// Records every wait and moves the clock by it.
pub struct SimSleeper<'a> {
    clock: &'a SimClock,
    pub waits: RefCell<Vec<u64>>,
}

impl<'a> SimSleeper<'a> {
    pub fn new(clock: &'a SimClock) -> Self {
        Self {
            clock,
            waits: RefCell::new(Vec::new()),
        }
    }
}

impl Sleeper for SimSleeper<'_> {
    fn sleep(&self, seconds: u64) {
        self.waits.borrow_mut().push(seconds);
        self.clock
            .0
            .set(self.clock.0.get() + i64::try_from(seconds).unwrap());
    }
}

/// A request that reached the transport, with the credentials it carried.
#[derive(Clone, Debug)]
pub struct Seen {
    pub request: HttpRequest,
    pub key_id: String,
    pub secret: String,
}

/// Plays the script in order and checks every request against what the oracle expected.
pub struct ScriptedTransport {
    steps: RefCell<VecDeque<Step>>,
    seen: RefCell<Vec<Seen>>,
    cancel_at: Option<(usize, CancelFlag)>,
}

impl ScriptedTransport {
    pub fn new(steps: Vec<Step>) -> Self {
        Self {
            steps: RefCell::new(steps.into()),
            seen: RefCell::new(Vec::new()),
            cancel_at: None,
        }
    }

    /// Set `flag` while answering request number `count` (1-based).
    pub fn cancel_while_answering(mut self, count: usize, flag: &CancelFlag) -> Self {
        self.cancel_at = Some((count, flag.clone()));
        self
    }

    pub fn seen(&self) -> Vec<Seen> {
        self.seen.borrow().clone()
    }

    pub fn unconsumed(&self) -> usize {
        self.steps.borrow().len()
    }
}

impl HttpTransport for ScriptedTransport {
    fn get(
        &self,
        request: &HttpRequest,
        credentials: &Credentials,
        _limits: TransportLimits,
    ) -> Result<HttpResponse, TransportError> {
        self.seen.borrow_mut().push(Seen {
            request: request.clone(),
            key_id: credentials.key_id().to_owned(),
            secret: credentials.secret().to_owned(),
        });
        let count = self.seen.borrow().len();
        assert!(
            EGRESS_RULES.iter().any(|rule| rule.allows(request)),
            "request {count} is outside the egress allowlist: {request:?}"
        );
        let step = self
            .steps
            .borrow_mut()
            .pop_front()
            .unwrap_or_else(|| panic!("request {count} has no scripted answer: {request:?}"));
        if let Some(expect) = &step.expect {
            let host = match request.host {
                Host::Data => "data",
                Host::Paper => "paper",
            };
            assert_eq!(host, expect.host, "request {count}: host");
            assert_eq!(request.path, expect.path, "request {count}: path");
            assert_eq!(request.query, expect.query, "request {count}: query");
        }
        if let Some((at, flag)) = &self.cancel_at
            && *at == count
        {
            flag.set();
        }
        match step.reply {
            Reply::Transport(error) => Err(error),
            Reply::Response {
                status,
                headers,
                body,
            } => Ok(HttpResponse {
                status,
                headers,
                body,
            }),
        }
    }
}

// ---- running a case -------------------------------------------------------------------------------

/// A permit from a gate whose switch is on and whose evidence is all verified.
pub fn open_permit() -> RetrievalPermit {
    let evidence = ProviderEvidence {
        paper_authority: Fact::Verified,
        no_live_authority: Fact::Verified,
        data_entitlement: Fact::Verified,
        session_semantics: Fact::Verified,
        egress_refusals: Fact::Verified,
        declaration_field: Fact::Verified,
    };
    decide(RetrievalSwitch::On, &evidence).expect("every fact is verified")
}

/// What a run of a case produced.
pub struct Run {
    pub result: Result<Snapshot, RetrieveError>,
    pub calls: Vec<CallRecord>,
    pub sources: Vec<SourceBody>,
    pub waits: Vec<u64>,
    pub seen: Vec<Seen>,
    pub unconsumed: usize,
    pub end: Timestamp,
}

/// Run `retrieve_snapshot` over the scripted answers of `case`.
pub fn run_case(case: &Case) -> Run {
    run_with(case, &CancelFlag::default(), None, None)
}

/// Run with a cancellation flag, an optional request on which a test sets it and optional limits.
pub fn run_with(
    case: &Case,
    cancel: &CancelFlag,
    cancel_while_answering: Option<usize>,
    limits: Option<Limits>,
) -> Run {
    let text = serde_json::to_string(&case.request).unwrap();
    let request: RetrievalRequest = parse(&text).expect("the request parses");
    let executable: ExecutableIdentity =
        serde_json::from_value(case.host["executable"].clone()).unwrap();
    let constraints = UseConstraints {
        redistribution_permitted: case.host["constraints"]["redistribution_permitted"]
            .as_bool()
            .unwrap(),
        retain_raw: case.host["constraints"]["retain_raw"].as_bool().unwrap(),
        terms_ref: string(&case.host["constraints"]["terms_ref"]),
    };
    let licence = string(&case.host["licence"]);
    let adapter_version = string(&case.host["adapter_version"]);
    let host = HostIdentity {
        executable: &executable,
        adapter_version: &adapter_version,
        constraints: &constraints,
        licence: &licence,
    };
    let mut transport = ScriptedTransport::new(case.steps.clone());
    if let Some(count) = cancel_while_answering {
        transport = transport.cancel_while_answering(count, cancel);
    }
    let adapter = AlpacaAdapter::new(transport, Credentials::new(KEY_ID, SECRET));
    let clock = SimClock::at(case.now);
    let sleeper = SimSleeper::new(&clock);
    let limits = limits.unwrap_or_else(|| limits_from_request(&request).expect("limits"));
    let permit = open_permit();
    let mut cx = CallContext::new(limits, &clock, &sleeper, cancel);
    let result = retrieve_snapshot(&permit, &adapter, &request, &host, &mut cx);
    Run {
        result,
        calls: cx.calls().to_vec(),
        sources: cx.sources().to_vec(),
        waits: sleeper.waits.borrow().clone(),
        seen: adapter.transport().seen(),
        unconsumed: adapter.transport().unconsumed(),
        end: clock.now(),
    }
}

/// The JSON of one call record, in the shape of the expectation.
pub fn call_json(call: &CallRecord) -> Value {
    json!({
        "sequence": call.sequence,
        "operation": call.operation.name(),
        "started_at": call.started_at.to_string(),
        "http_status": call.http_status,
        "error": call.error.map(ErrorClass::wire_name),
        "retry_after_seconds": call.retry_after_seconds,
    })
}

/// The first place where two JSON values differ, as a path and the two values.
pub fn first_difference(actual: &Value, expected: &Value, path: &str) -> Option<String> {
    match (actual, expected) {
        (Value::Object(a), Value::Object(e)) => {
            for key in e.keys().chain(a.keys()) {
                match (a.get(key), e.get(key)) {
                    (Some(x), Some(y)) => {
                        if let Some(found) = first_difference(x, y, &format!("{path}/{key}")) {
                            return Some(found);
                        }
                    }
                    (x, y) => return Some(format!("{path}/{key}: actual {x:?}, expected {y:?}")),
                }
            }
            None
        }
        (Value::Array(a), Value::Array(e)) => {
            for (index, (x, y)) in a.iter().zip(e).enumerate() {
                if let Some(found) = first_difference(x, y, &format!("{path}/{index}")) {
                    return Some(found);
                }
            }
            (a.len() != e.len())
                .then(|| format!("{path}: actual length {}, expected {}", a.len(), e.len()))
        }
        _ => (actual != expected).then(|| format!("{path}: actual {actual}, expected {expected}")),
    }
}

/// Fail with the first difference when two values are not equal.
pub fn assert_json_eq(what: &str, actual: &Value, expected: &Value) {
    if let Some(found) = first_difference(actual, expected, "") {
        panic!("{what} differs at {found}");
    }
}

/// Every JSON number in `value` is an integer: no float is ever written.
pub fn assert_no_float(value: &Value) {
    match value {
        Value::Number(n) => assert!(n.is_i64() || n.is_u64(), "a non-integer number {n}"),
        Value::Array(items) => items.iter().for_each(assert_no_float),
        Value::Object(map) => map.values().for_each(assert_no_float),
        _ => {}
    }
}

/// Run one committed case and compare everything with the oracle's expectation.
pub fn check_case(id: &str) {
    let case = Case::load(id);
    assert!(
        case.derivation.starts_with(&format!("# {id}:")),
        "{id}: derivation.md names the case"
    );
    let expected = &case.expected["expect"];
    let run = run_case(&case);

    // The billed calls, the waits and the requests.
    let calls: Vec<Value> = run.calls.iter().map(call_json).collect();
    assert_json_eq(
        &format!("{id}: calls"),
        &Value::Array(calls),
        &expected["calls"],
    );
    assert_eq!(
        run.waits,
        expected["sleeps"]
            .as_array()
            .unwrap()
            .iter()
            .map(|wait| wait.as_u64().unwrap())
            .collect::<Vec<_>>(),
        "{id}: waits"
    );
    assert_eq!(
        run.seen.len() as u64,
        expected["requests"].as_u64().unwrap(),
        "{id}: requests"
    );
    assert_eq!(run.unconsumed, 0, "{id}: every scripted answer was used");
    for seen in &run.seen {
        assert_eq!(
            (seen.key_id.as_str(), seen.secret.as_str()),
            (KEY_ID, SECRET),
            "{id}: credentials"
        );
    }

    match expected["outcome"].as_str().unwrap() {
        "snapshot" => {
            let snapshot = run
                .result
                .unwrap_or_else(|e| panic!("{id}: expected a snapshot, got {e}"));
            assert_json_eq(
                &format!("{id}: manifest"),
                &snapshot.manifest,
                &expected["manifest"],
            );
            assert_eq!(
                snapshot.digest,
                expected["digest"].as_str().unwrap(),
                "{id}: digest"
            );
            assert_eq!(
                u64::from(snapshot.price_scale),
                expected["price_scale"].as_u64().unwrap(),
                "{id}: price_scale"
            );
            assert_eq!(
                u64::from(snapshot.money_scale),
                expected["money_scale"].as_u64().unwrap(),
                "{id}: money_scale"
            );
            assert_eq!(
                snapshot.overflow_evidence_required,
                expected["overflow_evidence_required"].as_bool().unwrap(),
                "{id}: overflow evidence"
            );
            assert_no_float(&snapshot.manifest);
            // The stored bytes are the canonical text of the manifest and hash to its digest.
            assert_eq!(
                serde_json::from_str::<Value>(&snapshot.canonical_json).unwrap(),
                snapshot.manifest,
                "{id}: canonical text"
            );
            assert_eq!(
                digest_bytes(snapshot.canonical_json.as_bytes()),
                snapshot.digest,
                "{id}: digest of the bytes"
            );
            let typed: DatasetManifest =
                parse(&snapshot.canonical_json).unwrap_or_else(|e| panic!("{id}: {e}"));
            assert_eq!(
                payload_digest(&typed).unwrap(),
                snapshot.digest,
                "{id}: typed digest"
            );
            // One source body per listed response, with the digest of its exact bytes.
            let listed = snapshot.manifest["source_responses"].as_array().unwrap();
            assert_eq!(run.sources.len(), listed.len(), "{id}: source bodies");
            for (body, entry) in run.sources.iter().zip(listed) {
                assert_eq!(
                    digest_bytes(&body.bytes),
                    entry["content_digest"].as_str().unwrap(),
                    "{id}: source digest"
                );
                assert_eq!(
                    u64::from(body.sequence),
                    entry["sequence"].as_u64().unwrap(),
                    "{id}: source sequence"
                );
            }
        }
        "blocked" => {
            let Err(RetrieveError::Blocked(block)) = run.result else {
                panic!(
                    "{id}: expected a blocked profile, got {:?}",
                    run.result.map(|s| s.digest)
                );
            };
            let want = &expected["block"];
            assert_eq!(
                block.code(),
                want["code"].as_str().unwrap(),
                "{id}: block code ({block})"
            );
            assert_eq!(
                block.subject(),
                want["subject"].as_str().unwrap(),
                "{id}: block subject"
            );
            assert_eq!(
                block.class().wire_name(),
                want["class"].as_str().unwrap(),
                "{id}: class"
            );
            assert!(
                !RetrieveError::Blocked(block).retryable(),
                "{id}: a block is never retried"
            );
        }
        "error" => {
            let Err(error) = run.result else {
                panic!("{id}: expected an error");
            };
            let want = &expected["error"];
            assert_eq!(
                error.code(),
                want["code"].as_str().unwrap(),
                "{id}: error code ({error})"
            );
            assert_eq!(
                error.class().wire_name(),
                want["class"].as_str().unwrap(),
                "{id}: class"
            );
            assert_eq!(
                error.retryable(),
                want["retryable"].as_bool().unwrap(),
                "{id}: retryable"
            );
            assert_eq!(
                error.retry_after_seconds(),
                want["retry_after_seconds"].as_u64(),
                "{id}: retry hint"
            );
            if let Some(text) = want.get("reason_contains") {
                let shown = error.to_string();
                assert!(
                    shown.contains(text.as_str().unwrap()),
                    "{id}: `{shown}` mentions `{text}`"
                );
            }
        }
        other => panic!("{id}: unknown outcome {other}"),
    }
}

/// One test per case id, each running `check_case`.
#[macro_export]
macro_rules! case_tests {
    ($($name:ident => $id:literal),* $(,)?) => {
        $(
            #[test]
            fn $name() {
                $crate::market_support::check_case($id);
            }
        )*
    };
}

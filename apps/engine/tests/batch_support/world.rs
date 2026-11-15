//! A fake Cloudflare queue, a fake application API and a fake market-data provider, behind the
//! batch host's [`Wire`].
//!
//! The fake API is built from `packages/api-contracts/routes/v1.json`: a request that matches no
//! route is a 404, a route whose credentials do not include the batch principal is a 403, and every
//! body of a contract route is parsed with `openquant_contracts` before it is accepted. A body that
//! breaks its contract panics the test with the route and the error, because a worker that sends
//! one is defective. Every error body is itself checked against `api-error/1`.
//!
//! The fake lives behind the real egress module and the real queue and API clients: the worker
//! under test is the production code, and only the wire is replaced. A request that reaches the
//! wire for a host outside the allowlist panics, which would mean that the egress module let it
//! through.

#![allow(
    dead_code,
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    fs,
    path::Path,
    sync::{
        Arc, Mutex,
        atomic::{AtomicI64, AtomicU64, Ordering},
    },
};

use openquant_contracts::{
    AnyContract, Envelope, canonical::digest_bytes, canonical_json, parse, parse_json, validate,
};
use openquant_engine::{
    batch::{
        clock::Time,
        wire::{Method, Wire, WireError, WireRequest, WireResponse},
    },
    market::{
        http::{Host, HttpRequest},
        time::Timestamp,
    },
};
use serde_json::{Value, json};

/// A clock that moves only when a test or a sleep moves it.
pub struct FakeTime {
    epoch: AtomicI64,
    monotonic_ms: AtomicU64,
    sleeps: Mutex<Vec<u64>>,
}

impl FakeTime {
    pub fn at(timestamp: &str) -> Arc<Self> {
        Arc::new(Self {
            epoch: AtomicI64::new(Timestamp::parse(timestamp).unwrap().epoch_seconds()),
            monotonic_ms: AtomicU64::new(0),
            sleeps: Mutex::new(Vec::new()),
        })
    }

    pub fn advance(&self, seconds: i64) {
        self.epoch.fetch_add(seconds, Ordering::SeqCst);
        self.monotonic_ms
            .fetch_add(u64::try_from(seconds).unwrap() * 1000, Ordering::SeqCst);
    }

    pub fn sleeps(&self) -> Vec<u64> {
        self.sleeps.lock().unwrap().clone()
    }

    pub fn epoch(&self) -> i64 {
        self.epoch.load(Ordering::SeqCst)
    }
}

impl Time for FakeTime {
    fn now(&self) -> Timestamp {
        Timestamp::from_epoch_seconds(self.epoch())
    }

    fn monotonic_ms(&self) -> u64 {
        self.monotonic_ms.load(Ordering::SeqCst)
    }

    fn sleep_ms(&self, milliseconds: u64) {
        self.sleeps.lock().unwrap().push(milliseconds);
        self.epoch.fetch_add(
            i64::try_from(milliseconds / 1000).unwrap(),
            Ordering::SeqCst,
        );
        self.monotonic_ms.fetch_add(milliseconds, Ordering::SeqCst);
    }
}

/// What a test does when a given request arrives, before the fake handles it.
#[derive(Clone, Debug)]
pub enum Action {
    /// The process dies: the wire call unwinds with a [`Crash`] and nothing is handled.
    Crash,
    /// Every attempt of the world is cancelled by the mission.
    CancelAttempts,
    /// Every claimed attempt of the world is fenced: a newer attempt of the same work exists, so
    /// late calls get `STALE_OWNERSHIP`.
    FenceAttempts,
    /// The clock moves forward.
    Advance(i64),
    /// The request is lost: the wire fails with this error and nothing is handled.
    Lose(WireError),
    /// The server answers this error code instead of handling the request.
    Refuse { status: u16, code: String },
}

/// The payload of the unwind that stands for a dead process.
#[derive(Debug)]
pub struct Crash;

#[derive(Clone, Debug)]
struct Hook {
    key: String,
    nth: usize,
    action: Action,
}

/// One request that reached the wire.
#[derive(Clone, Debug)]
pub struct Seen {
    pub key: String,
    pub method: Method,
    pub host: String,
    pub path: String,
    pub query: Vec<(String, String)>,
    pub status: u16,
    pub body_bytes: usize,
    /// The names of the headers (never their values).
    pub header_names: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AttemptState {
    Pending,
    Claimed,
    Completed,
    Cancelled,
    Expired,
}

#[derive(Clone, Debug)]
pub struct Attempt {
    pub state: AttemptState,
    pub ownership_revision: u64,
    pub dispatch_digest: String,
    pub capability: Option<String>,
    pub lease_expires: Option<i64>,
    pub worker_id: Option<String>,
    pub executable: Option<Value>,
    /// A newer attempt of the same work exists: late calls get STALE_OWNERSHIP.
    pub fenced: bool,
    pub claims: usize,
}

/// A result that the fake API accepted.
#[derive(Clone, Debug)]
pub struct Accepted {
    pub route: String,
    pub attempt_id: String,
    pub digest: String,
    pub body: Value,
}

#[derive(Clone, Debug)]
struct Message {
    id: String,
    body: Value,
    visible_at: i64,
    lease: Option<String>,
    attempts: u32,
    acked: bool,
}

#[derive(Clone, Debug)]
struct Route {
    id: String,
    method: String,
    template: Vec<String>,
    auth: Vec<Value>,
    request: Value,
    max_body_bytes: Option<usize>,
    success_status: u16,
}

/// A provider response: status, headers and body.
pub type ProviderAnswer = (u16, Vec<(String, String)>, Vec<u8>);

/// One scripted provider answer: the request that the adapter must make and what comes back.
pub struct ProviderStep {
    pub host: Host,
    pub path: String,
    pub query: Vec<(String, String)>,
    /// A response (status, headers, body) or a wire failure.
    pub reply: Result<ProviderAnswer, WireError>,
}

/// The state of the fake services.
pub struct World {
    pub time: Arc<FakeTime>,
    routes: Vec<Route>,
    error_status: BTreeMap<String, u16>,
    pub api_host: String,
    pub queue_account: String,
    pub queue_id: String,
    pub service_token: String,
    pub queue_token: String,
    pub provider_key_id: String,
    pub provider_secret: String,
    queue: Vec<Message>,
    pub next_message: u64,
    next_lease: u64,
    pub attempts: BTreeMap<String, Attempt>,
    pub artefacts: BTreeMap<String, Vec<u8>>,
    /// Digests that the API refuses to serve to an attempt (NOT_FOUND).
    pub unreadable: BTreeSet<String>,
    pub accepted: Vec<Accepted>,
    pub lease_seconds: i64,
    pub execution_enabled: bool,
    /// Serve the message body as a JSON object instead of a string.
    pub body_as_object: bool,
    pub seen: Vec<Seen>,
    pub provider: VecDeque<ProviderStep>,
    hooks: Vec<Hook>,
    counts: BTreeMap<String, usize>,
    pub acks: usize,
    pub retries: Vec<(String, u64)>,
    /// The clock at each pull, in epoch seconds.
    pub pull_times: Vec<i64>,
    pub diagnostics: u64,
    /// A wire failure that the scripted provider asks for.
    provider_failure: Option<WireError>,
    /// Seconds that the clock moves forward at every read of an input.
    pub tick_on_input: i64,
}

fn read_routes(path: &Path) -> (Vec<Route>, BTreeMap<String, u16>) {
    let manifest: Value = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
    let routes = manifest["routes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|route| Route {
            id: route["id"].as_str().unwrap().to_owned(),
            method: route["method"].as_str().unwrap().to_owned(),
            template: route["path"]
                .as_str()
                .unwrap()
                .trim_start_matches('/')
                .split('/')
                .map(str::to_owned)
                .collect(),
            auth: route["auth"].as_array().unwrap().clone(),
            request: route["request"].clone(),
            max_body_bytes: route["max_body_bytes"]
                .as_u64()
                .map(|n| usize::try_from(n).unwrap()),
            success_status: u16::try_from(route["success_status"].as_u64().unwrap()).unwrap(),
        })
        .collect();
    let statuses = manifest["error_status"]
        .as_object()
        .unwrap()
        .iter()
        .map(|(code, status)| {
            (
                code.clone(),
                u16::try_from(status.as_u64().unwrap()).unwrap(),
            )
        })
        .collect();
    (routes, statuses)
}

fn response(status: u16, body: Vec<u8>) -> WireResponse {
    WireResponse {
        status,
        headers: vec![("content-type".to_owned(), "application/json".to_owned())],
        body,
    }
}

impl World {
    pub fn new(time: Arc<FakeTime>) -> Self {
        let path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../packages/api-contracts/routes/v1.json");
        let (routes, error_status) = read_routes(&path);
        Self {
            time,
            routes,
            error_status,
            api_host: "api.openquant.example".to_owned(),
            queue_account: "acct0123".to_owned(),
            queue_id: "queue0123".to_owned(),
            service_token: "synthetic-batch-service-credential-0001".to_owned(),
            queue_token: "synthetic-queue-consumer-token-0001".to_owned(),
            provider_key_id: "synthetic-key-id-7f3a".to_owned(),
            provider_secret: "synthetic-secret-91c4d2".to_owned(),
            queue: Vec::new(),
            next_message: 1,
            next_lease: 1,
            attempts: BTreeMap::new(),
            artefacts: BTreeMap::new(),
            unreadable: BTreeSet::new(),
            accepted: Vec::new(),
            lease_seconds: 660,
            execution_enabled: true,
            body_as_object: false,
            seen: Vec::new(),
            provider: VecDeque::new(),
            hooks: Vec::new(),
            counts: BTreeMap::new(),
            acks: 0,
            retries: Vec::new(),
            pull_times: Vec::new(),
            diagnostics: 0,
            provider_failure: None,
            tick_on_input: 0,
        }
    }

    /// Run `action` when the `nth` (1-based) request with `key` arrives. The key is a route id
    /// (`attempts.artefact`), `queue.pull`, `queue.ack`, or `provider`.
    pub fn on(&mut self, key: &str, nth: usize, action: Action) {
        self.hooks.push(Hook {
            key: key.to_owned(),
            nth,
            action,
        });
    }

    /// Store an artefact as if an earlier job had uploaded it, and return its reference.
    pub fn store(&mut self, bytes: &[u8]) -> Value {
        let digest = digest_bytes(bytes);
        self.artefacts.insert(digest.clone(), bytes.to_vec());
        json!({"digest": digest, "media_type": "application/json", "size_bytes": bytes.len()})
    }

    /// Store a contract document in canonical form.
    pub fn store_json(&mut self, value: &Value) -> Value {
        let text = canonical_json(value).unwrap();
        self.store(text.as_bytes())
    }

    /// Put a `job-dispatch/1` on the queue and create its pending attempt.
    pub fn enqueue(&mut self, dispatch: &Value) -> String {
        let parsed: openquant_contracts::generated::JobDispatch =
            parse(&dispatch.to_string()).unwrap();
        let digest = openquant_contracts::payload_digest(&parsed).unwrap();
        let attempt = &dispatch["attempt"];
        self.attempts.insert(
            attempt["attempt_id"].as_str().unwrap().to_owned(),
            Attempt {
                state: AttemptState::Pending,
                ownership_revision: attempt["ownership_revision"].as_u64().unwrap(),
                dispatch_digest: digest,
                capability: None,
                lease_expires: None,
                worker_id: None,
                executable: None,
                fenced: false,
                claims: 0,
            },
        );
        let id = format!("msg-{}", self.next_message);
        self.next_message += 1;
        self.queue.push(Message {
            id: id.clone(),
            body: dispatch.clone(),
            visible_at: self.time.epoch(),
            lease: None,
            attempts: 0,
            acked: false,
        });
        id
    }

    /// Put a message that is not a dispatch on the queue.
    pub fn enqueue_raw(&mut self, body: Value) -> String {
        let id = format!("msg-{}", self.next_message);
        self.next_message += 1;
        self.queue.push(Message {
            id: id.clone(),
            body,
            visible_at: self.time.epoch(),
            lease: None,
            attempts: 0,
            acked: false,
        });
        id
    }

    /// Messages that are still on the queue (not acknowledged).
    pub fn queued(&self) -> Vec<String> {
        self.queue
            .iter()
            .filter(|m| !m.acked)
            .map(|m| m.id.clone())
            .collect()
    }

    pub fn is_acked(&self, id: &str) -> bool {
        self.queue.iter().any(|m| m.id == id && m.acked)
    }

    pub fn delivery_count(&self, id: &str) -> u32 {
        self.queue
            .iter()
            .find(|m| m.id == id)
            .map_or(0, |m| m.attempts)
    }

    /// The results of one route that the API accepted.
    pub fn accepted_on(&self, route: &str) -> Vec<&Accepted> {
        self.accepted.iter().filter(|a| a.route == route).collect()
    }

    pub fn requests_with(&self, key: &str) -> usize {
        self.seen.iter().filter(|s| s.key == key).count()
    }

    pub fn provider_requests(&self) -> usize {
        self.requests_with("provider")
    }

    /// Fence an attempt: a newer attempt of the same work exists.
    pub fn fence(&mut self, attempt_id: &str) {
        if let Some(attempt) = self.attempts.get_mut(attempt_id) {
            attempt.fenced = true;
            if attempt.state == AttemptState::Claimed {
                attempt.state = AttemptState::Expired;
            }
        }
    }

    fn diagnostic(&mut self) -> String {
        self.diagnostics += 1;
        format!("diag-{}", self.diagnostics)
    }

    fn api_error(&mut self, code: &str, message: &str, retry_safe: bool) -> WireResponse {
        let status = *self
            .error_status
            .get(code)
            .unwrap_or_else(|| panic!("unknown code {code}"));
        let body = json!({
            "schema_version": "api-error/1",
            "code": code,
            "message": message,
            "state_changed": "NONE",
            "retry_safe": retry_safe,
            "diagnostic_ref": self.diagnostic(),
        });
        validate(Envelope::ApiError, &body).unwrap();
        response(status, serde_json::to_vec(&body).unwrap())
    }

    fn match_route(
        &self,
        method: Method,
        path: &str,
    ) -> Option<(&Route, BTreeMap<String, String>)> {
        let parts: Vec<&str> = path.trim_start_matches('/').split('/').collect();
        for route in &self.routes {
            if route.method != method.as_str() || route.template.len() != parts.len() {
                continue;
            }
            let mut params = BTreeMap::new();
            let mut matched = true;
            for (template, part) in route.template.iter().zip(&parts) {
                if let Some(name) = template.strip_prefix('{').and_then(|t| t.strip_suffix('}')) {
                    params.insert(name.to_owned(), (*part).to_owned());
                } else if template != part {
                    matched = false;
                    break;
                }
            }
            if matched {
                return Some((route, params));
            }
        }
        None
    }

    fn bearer(request: &WireRequest<'_>) -> Option<String> {
        request
            .headers
            .iter()
            .find(|(name, _)| *name == "authorization")
            .and_then(|(_, value)| value.expose().strip_prefix("Bearer ").map(str::to_owned))
    }

    fn header(request: &WireRequest<'_>, name: &str) -> Option<String> {
        request
            .headers
            .iter()
            .find(|(n, _)| *n == name)
            .map(|(_, value)| value.expose().to_owned())
    }

    /// The key that names a request for hooks.
    fn key_of(&self, request: &WireRequest<'_>) -> String {
        if request.host == self.api_host {
            return self
                .match_route(request.method, request.path)
                .map_or_else(|| "api.unknown".to_owned(), |(route, _)| route.id.clone());
        }
        if request.host == "api.cloudflare.com" {
            return if request.path.ends_with("/pull") {
                "queue.pull".to_owned()
            } else {
                "queue.ack".to_owned()
            };
        }
        "provider".to_owned()
    }

    /// Handle one request. `Err(Crash)` stands for a dead process.
    pub fn handle(
        &mut self,
        request: &WireRequest<'_>,
    ) -> Result<Result<WireResponse, WireError>, Crash> {
        let key = self.key_of(request);
        let count = {
            let entry = self.counts.entry(key.clone()).or_insert(0);
            *entry += 1;
            *entry
        };
        let mut reply: Option<Result<WireResponse, WireError>> = None;
        let hooks: Vec<Hook> = self
            .hooks
            .iter()
            .filter(|h| h.key == key && h.nth == count)
            .cloned()
            .collect();
        for hook in hooks {
            match hook.action {
                Action::Crash => {
                    self.record(&key, request, 0);
                    return Err(Crash);
                }
                Action::CancelAttempts => {
                    for attempt in self.attempts.values_mut() {
                        if attempt.state == AttemptState::Claimed {
                            attempt.state = AttemptState::Cancelled;
                        }
                    }
                }
                Action::FenceAttempts => {
                    let claimed: Vec<String> = self
                        .attempts
                        .iter()
                        .filter(|(_, attempt)| attempt.state == AttemptState::Claimed)
                        .map(|(id, _)| id.clone())
                        .collect();
                    for id in claimed {
                        self.fence(&id);
                    }
                }
                Action::Advance(seconds) => self.time.advance(seconds),
                Action::Lose(error) => reply = Some(Err(error)),
                Action::Refuse { status, code } => {
                    let mut answer = self.api_error(&code, "refused by the test", false);
                    answer.status = status;
                    reply = Some(Ok(answer));
                }
            }
        }
        let reply = match reply {
            Some(reply) => reply,
            None => {
                let answer = self.route(&key, request);
                match self.provider_failure.take() {
                    Some(error) => Err(error),
                    None => Ok(answer),
                }
            }
        };
        // The real wire stops reading a body above the limit it was given.
        let reply = match reply {
            Ok(answer) if answer.body.len() as u64 > request.max_response_bytes => {
                Err(WireError::BodyTooLarge)
            }
            other => other,
        };
        let status = reply.as_ref().map_or(0, |r| r.status);
        self.record(&key, request, status);
        Ok(reply)
    }

    fn record(&mut self, key: &str, request: &WireRequest<'_>, status: u16) {
        self.seen.push(Seen {
            key: key.to_owned(),
            method: request.method,
            host: request.host.to_owned(),
            path: request.path.to_owned(),
            query: request.query.to_vec(),
            status,
            body_bytes: request.body.len(),
            header_names: request
                .headers
                .iter()
                .map(|(n, _)| (*n).to_owned())
                .collect(),
        });
    }

    fn route(&mut self, key: &str, request: &WireRequest<'_>) -> WireResponse {
        if request.host == self.api_host {
            return self.api(request);
        }
        if request.host == "api.cloudflare.com" {
            return self.queue_call(key, request);
        }
        if request.host == "data.alpaca.markets" || request.host == "paper-api.alpaca.markets" {
            return self.provider_call(request);
        }
        panic!(
            "a request to {} reached the wire: the egress module let it through",
            request.host
        );
    }

    // ---- the queue ---------------------------------------------------------------------------

    fn queue_call(&mut self, key: &str, request: &WireRequest<'_>) -> WireResponse {
        let queue_path = format!(
            "/client/v4/accounts/{}/queues/{}/messages/{}",
            self.queue_account,
            self.queue_id,
            if key == "queue.pull" { "pull" } else { "ack" }
        );
        assert_eq!(request.path, queue_path, "the queue path");
        assert_eq!(request.method, Method::Post);
        if Self::bearer(request).as_deref() != Some(self.queue_token.as_str()) {
            return response(401, br#"{"success":false,"errors":[{"code":10000,"message":"Authentication error"}],"messages":[],"result":null}"#.to_vec());
        }
        assert_eq!(
            Self::header(request, "content-type").as_deref(),
            Some("application/json")
        );
        let body: Value = serde_json::from_slice(request.body).unwrap();
        let now = self.time.epoch();
        if key == "queue.pull" {
            self.pull_times.push(now);
            let batch = usize::try_from(body["batch_size"].as_u64().expect("batch_size")).unwrap();
            let visibility =
                i64::try_from(body["visibility_timeout_ms"].as_u64().expect("visibility")).unwrap()
                    / 1000;
            let mut messages = Vec::new();
            let mut lease_counter = self.next_lease;
            for message in &mut self.queue {
                if messages.len() >= batch {
                    break;
                }
                if message.acked || message.visible_at > now {
                    continue;
                }
                let lease = format!("lease-{lease_counter}-{}", message.id);
                lease_counter += 1;
                message.lease = Some(lease.clone());
                message.visible_at = now + visibility;
                message.attempts += 1;
                let text = canonical_json(&message.body).unwrap();
                messages.push(json!({
                    "id": message.id,
                    "lease_id": lease,
                    "body": if self.body_as_object { message.body.clone() } else { Value::String(text) },
                    "attempts": message.attempts,
                    "timestamp_ms": now * 1000,
                    "metadata": {},
                }));
            }
            self.next_lease = lease_counter;
            let backlog = self.queue.iter().filter(|m| !m.acked).count();
            let answer = json!({
                "success": true, "errors": [], "messages": [],
                "result": {"message_backlog_count": backlog, "messages": messages},
            });
            return response(200, serde_json::to_vec(&answer).unwrap());
        }
        let mut ack_count = 0;
        let mut retry_count = 0;
        for ack in body["acks"].as_array().expect("acks") {
            let lease = ack["lease_id"].as_str().expect("lease_id");
            for message in &mut self.queue {
                if message.lease.as_deref() == Some(lease) && !message.acked {
                    message.acked = true;
                    ack_count += 1;
                    self.acks += 1;
                }
            }
        }
        for retry in body["retries"].as_array().expect("retries") {
            let lease = retry["lease_id"].as_str().expect("lease_id");
            let delay = retry["delay_seconds"].as_u64().expect("delay_seconds");
            for message in &mut self.queue {
                if message.lease.as_deref() == Some(lease) && !message.acked {
                    message.lease = None;
                    message.visible_at = now + i64::try_from(delay).unwrap();
                    retry_count += 1;
                    self.retries.push((message.id.clone(), delay));
                }
            }
        }
        let answer = json!({
            "success": true, "errors": [], "messages": [],
            "result": {"ackCount": ack_count, "retryCount": retry_count, "warnings": []},
        });
        response(200, serde_json::to_vec(&answer).unwrap())
    }

    // ---- the API -----------------------------------------------------------------------------

    fn authorised(
        &self,
        route: &Route,
        token: Option<&str>,
        attempt_id: Option<&str>,
    ) -> Option<&'static str> {
        let token = token?;
        for entry in &route.auth {
            let principals = entry["principals"].as_array();
            let batch = principals.is_some_and(|p| p.iter().any(|v| v == "batch"));
            match entry["kind"].as_str() {
                Some("service") if batch && token == self.service_token => return Some("service"),
                Some("attempt") if batch => {
                    let capability = attempt_id
                        .and_then(|id| self.attempts.get(id))
                        .and_then(|a| a.capability.as_deref());
                    if capability == Some(token) {
                        return Some("attempt");
                    }
                }
                _ => {}
            }
        }
        None
    }

    fn api(&mut self, request: &WireRequest<'_>) -> WireResponse {
        assert!(request.path.starts_with("/v1/"), "{}", request.path);
        let Some((route, params)) = self.match_route(request.method, request.path) else {
            return self.api_error("NOT_FOUND", "no such route", false);
        };
        let route = route.clone();
        let attempt_id = params.get("attempt_id").cloned();
        let token = Self::bearer(request);
        let Some(kind) = self.authorised(&route, token.as_deref(), attempt_id.as_deref()) else {
            return self.api_error(
                "FORBIDDEN",
                "this credential may not call this route",
                false,
            );
        };
        if let Some(limit) = route.max_body_bytes
            && request.body.len() > limit
        {
            return self.api_error(
                "LIMIT_EXCEEDED",
                "the body is above the limit of the route",
                false,
            );
        }
        let attempt_id = attempt_id.expect("every batch route has an attempt in its path");
        if kind == "attempt" {
            let result_route = !matches!(route.id.as_str(), "attempts.input" | "attempts.artefact");
            if let Some(refusal) = self.liveness(&attempt_id, result_route) {
                return refusal;
            }
        }
        match route.id.as_str() {
            "attempts.claim" => self.claim(&attempt_id, request),
            "attempts.input" => self.input(&attempt_id, &params["digest"]),
            "attempts.artefact" => self.artefact(&params["digest"], request),
            _ => self.result(&route, &attempt_id, request),
        }
    }

    /// The state check of every route that takes the capability. A capability lives as long as
    /// the lease of a claimed attempt. A completed attempt answers a repeated submission with the
    /// stored result (in `result`) and refuses everything else.
    fn liveness(&mut self, attempt_id: &str, result_route: bool) -> Option<WireResponse> {
        let now = self.time.epoch();
        let attempt = self.attempts.get_mut(attempt_id)?;
        if attempt.state == AttemptState::Claimed
            && attempt.lease_expires.is_some_and(|end| now >= end)
        {
            attempt.state = AttemptState::Expired;
        }
        let state = attempt.state.clone();
        let fenced = attempt.fenced;
        match state {
            AttemptState::Claimed | AttemptState::Pending => None,
            AttemptState::Completed if result_route => None,
            AttemptState::Completed => {
                Some(self.api_error("LEASE_EXPIRED", "the lease was released", false))
            }
            AttemptState::Expired if fenced => {
                Some(self.api_error("STALE_OWNERSHIP", "a newer attempt exists", false))
            }
            AttemptState::Expired => {
                Some(self.api_error("LEASE_EXPIRED", "the lease has ended", false))
            }
            AttemptState::Cancelled => {
                Some(self.api_error("STALE_OWNERSHIP", "the attempt was cancelled", false))
            }
        }
    }

    fn claim(&mut self, attempt_id: &str, request: &WireRequest<'_>) -> WireResponse {
        let text = std::str::from_utf8(request.body).unwrap();
        let claim: Value = parse_json(text).unwrap();
        AnyContract::Envelope(Envelope::AttemptClaim)
            .parse_digest(text)
            .unwrap_or_else(|e| panic!("the claim breaks attempt-claim/1: {e}"));
        assert_eq!(claim["form"], "claim");
        if claim["attempt"]["attempt_id"] != attempt_id {
            return self.api_error(
                "SCHEMA_VIOLATION",
                "the attempt of the body is not the attempt of the path",
                false,
            );
        }
        if !self.execution_enabled {
            return self.api_error(
                "EXECUTION_DISABLED",
                "research execution is disabled",
                false,
            );
        }
        let Some(attempt) = self.attempts.get(attempt_id).cloned() else {
            return self.api_error("NOT_FOUND", "the attempt does not exist", false);
        };
        if claim["attempt"]["ownership_revision"].as_u64() != Some(attempt.ownership_revision) {
            return self.api_error(
                "STALE_OWNERSHIP",
                "the ownership revision is not current",
                false,
            );
        }
        if attempt.state != AttemptState::Pending {
            return self.api_error(
                "ATTEMPT_NOT_CLAIMABLE",
                &format!("the attempt is {:?}: it cannot be claimed", attempt.state),
                false,
            );
        }
        if claim["dispatch_digest"] != attempt.dispatch_digest {
            return self.api_error(
                "IDENTITY_MISMATCH",
                "the dispatch digest is not the digest of the message",
                false,
            );
        }
        let now = self.time.epoch();
        let end = now + self.lease_seconds;
        let capability = format!(
            "cap-{attempt_id}-{:0>32}",
            self.attempts.len() * 1000 + attempt.claims + 1
        );
        let entry = self.attempts.get_mut(attempt_id).unwrap();
        entry.state = AttemptState::Claimed;
        entry.capability = Some(capability.clone());
        entry.lease_expires = Some(end);
        entry.worker_id = claim["worker_id"].as_str().map(str::to_owned);
        entry.executable = Some(claim["executable"].clone());
        entry.claims += 1;
        let grant = json!({
            "schema_version": "attempt-claim/1",
            "form": "grant",
            "attempt": claim["attempt"],
            "granted_at": Timestamp::from_epoch_seconds(now).to_string(),
            "lease_expires_at": Timestamp::from_epoch_seconds(end).to_string(),
            "capability": {"token": capability},
        });
        validate(Envelope::AttemptClaim, &grant).unwrap();
        response(200, serde_json::to_vec(&grant).unwrap())
    }

    fn input(&mut self, _attempt_id: &str, digest: &str) -> WireResponse {
        // A test that needs the clock to move while a job works makes each read take a while.
        if self.tick_on_input > 0 {
            let seconds = self.tick_on_input;
            self.time.advance(seconds);
        }
        if self.unreadable.contains(digest) {
            return self.api_error("NOT_FOUND", "this attempt has no such input", false);
        }
        match self.artefacts.get(digest) {
            Some(bytes) => {
                let mut answer = response(200, bytes.clone());
                answer.headers = vec![
                    ("content-type".to_owned(), "application/json".to_owned()),
                    ("x-content-digest".to_owned(), digest.to_owned()),
                ];
                answer
            }
            None => self.api_error("NOT_FOUND", "this attempt has no such input", false),
        }
    }

    fn artefact(&mut self, digest: &str, request: &WireRequest<'_>) -> WireResponse {
        if digest_bytes(request.body) != digest {
            return self.api_error(
                "DIGEST_MISMATCH",
                "the uploaded bytes do not hash to the digest of the path",
                false,
            );
        }
        assert!(
            Self::header(request, "content-type").is_some_and(|t| t.contains('/')),
            "an artefact upload names its media type"
        );
        self.artefacts
            .insert(digest.to_owned(), request.body.to_vec());
        response(204, Vec::new())
    }

    fn result(
        &mut self,
        route: &Route,
        attempt_id: &str,
        request: &WireRequest<'_>,
    ) -> WireResponse {
        let contract = route.request["contract"].as_str().expect("a contract body");
        let text = std::str::from_utf8(request.body).expect("a result body is UTF-8");
        AnyContract::from_name(contract)
            .expect("a known contract")
            .parse_digest(text)
            .unwrap_or_else(|e| panic!("a body sent to {} breaks {contract}: {e}", route.id));
        let body: Value = parse_json(text).unwrap();
        assert_eq!(
            canonical_json(&body).unwrap(),
            text,
            "a body sent to {} is canonical JSON",
            route.id
        );
        if body["attempt"]["attempt_id"] != attempt_id {
            return self.api_error(
                "SCHEMA_VIOLATION",
                "the attempt of the body is not the attempt of the path",
                false,
            );
        }
        let digest = digest_bytes(request.body);
        let attempt = self.attempts.get(attempt_id).unwrap().clone();
        if attempt.state == AttemptState::Completed {
            return if self
                .accepted
                .iter()
                .any(|a| a.attempt_id == attempt_id && a.digest == digest)
            {
                response(route.success_status, Vec::new())
            } else {
                self.api_error(
                    "ATTEMPT_NOT_CLAIMABLE",
                    "the attempt already has a different result",
                    false,
                )
            };
        }
        // Every artefact that the result cites was uploaded, with the size it states.
        for cited in references_in(&body) {
            let stored = self.artefacts.get(cited.0.as_str());
            if stored.map(Vec::len) != Some(cited.1) {
                return self.api_error(
                    "IDENTITY_MISMATCH",
                    "a cited artefact is not an uploaded artefact of this size",
                    false,
                );
            }
        }
        self.accepted.push(Accepted {
            route: route.id.clone(),
            attempt_id: attempt_id.to_owned(),
            digest,
            body,
        });
        self.attempts.get_mut(attempt_id).unwrap().state = AttemptState::Completed;
        response(route.success_status, Vec::new())
    }

    // ---- the provider ------------------------------------------------------------------------

    fn provider_call(&mut self, request: &WireRequest<'_>) -> WireResponse {
        assert_eq!(request.method, Method::Get);
        assert_eq!(
            Self::header(request, "apca-api-key-id").as_deref(),
            Some(self.provider_key_id.as_str())
        );
        assert_eq!(
            Self::header(request, "apca-api-secret-key").as_deref(),
            Some(self.provider_secret.as_str())
        );
        let host = if request.host == "data.alpaca.markets" {
            Host::Data
        } else {
            Host::Paper
        };
        let step = self.provider.pop_front().unwrap_or_else(|| {
            panic!(
                "the provider has no scripted answer for {}{}",
                request.host, request.path
            )
        });
        let seen = HttpRequest {
            host,
            path: request.path.to_owned(),
            query: request.query.to_vec(),
        };
        assert_eq!(seen.host, step.host, "provider host of {}", request.path);
        assert_eq!(seen.path, step.path, "provider path");
        assert_eq!(seen.query, step.query, "provider query of {}", request.path);
        match step.reply {
            Ok((status, headers, body)) => WireResponse {
                status,
                headers,
                body,
            },
            Err(error) => {
                self.provider_failure = Some(error);
                response(0, Vec::new())
            }
        }
    }
}

/// Every artefact reference of a document: objects with exactly `digest`, `media_type` and
/// `size_bytes`.
pub fn references_in(value: &Value) -> Vec<(String, usize)> {
    let mut found = Vec::new();
    fn walk(value: &Value, found: &mut Vec<(String, usize)>) {
        match value {
            Value::Object(map) => {
                if map.len() == 3
                    && let (Some(d), Some(_), Some(s)) = (
                        map.get("digest").and_then(Value::as_str),
                        map.get("media_type").and_then(Value::as_str),
                        map.get("size_bytes").and_then(Value::as_u64),
                    )
                {
                    found.push((d.to_owned(), usize::try_from(s).unwrap()));
                    return;
                }
                for child in map.values() {
                    walk(child, found);
                }
            }
            Value::Array(items) => items.iter().for_each(|item| walk(item, found)),
            _ => {}
        }
    }
    walk(value, &mut found);
    found
}

/// The wire of the fake world.
pub struct FakeWire(pub Arc<Mutex<World>>);

impl Wire for FakeWire {
    fn send(&self, request: &WireRequest<'_>) -> Result<WireResponse, WireError> {
        let outcome = {
            let mut world = self
                .0
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            world.handle(request)
        };
        match outcome {
            Ok(reply) => reply,
            Err(crash) => std::panic::resume_unwind(Box::new(crash)),
        }
    }
}

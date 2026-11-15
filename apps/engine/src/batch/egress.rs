//! The egress module: the only way the batch binary sends a request (OQ-05 section 5, D16).
//!
//! Every request goes through [`Egress::send`]. It checks the request against a [`Policy`], an
//! allowlist of exact host, method and path (with the query keys of the rule), before any
//! connection is made, counts it against the budget of its class, hands it to the [`Wire`] and
//! refuses any redirect. HTTPS is not a setting: the wire builds `https://` URLs only, and
//! [`Origin::parse`] refuses every other scheme in configuration.
//!
//! A refusal never reaches the network. A redirect is refused after the exchange: the target is
//! never requested, and only its host name is recorded. Credentials are added here, from a typed
//! [`Auth`], and never appear in a log entry or an error.
//!
//! The market adapter reaches the provider through the [`HttpTransport`] implementation of
//! [`Egress`], so its requests pass the same checks as the queue and API requests.

use std::{
    collections::BTreeMap,
    fmt,
    sync::{Arc, Mutex, PoisonError},
    time::Duration,
};

use super::{
    secret::Secret,
    wire::{Method, Wire, WireError, WireRequest},
};
use crate::market::{
    alpaca::{EGRESS_RULES, Segment as MarketSegment, is_symbol},
    http::{
        Credentials, Host, HttpRequest, HttpResponse, HttpTransport, TransportError,
        TransportLimits,
    },
};

/// The Cloudflare API host of the Queues pull and acknowledgement paths.
pub const CLOUDFLARE_HOST: &str = "api.cloudflare.com";

/// Query keys the market endpoints use. Any other key is refused.
pub const MARKET_QUERY_KEYS: [&str; 9] = [
    "adjustment",
    "end",
    "feed",
    "limit",
    "page_token",
    "sort",
    "start",
    "symbols",
    "timeframe",
];

const KIB: usize = 1024;
const MIB: usize = 1024 * KIB;

/// The class of a request. Each class has its own request budget.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Class {
    /// A market-data provider request.
    Provider,
    /// A Cloudflare Queues request.
    Queue,
    /// An application API request.
    Api,
}

/// How a path parameter is checked. No kind admits `/`, `%`, `.` alone or `..`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ParamKind {
    /// `[A-Za-z0-9][A-Za-z0-9._:-]{0,63}`, the identifier of the contracts.
    Identifier,
    /// `sha256:` and 64 lower-case hexadecimal digits.
    Digest,
    /// A ticker symbol.
    Symbol,
}

impl ParamKind {
    fn accepts(self, text: &str) -> bool {
        match self {
            Self::Identifier => {
                let mut chars = text.chars();
                text.len() <= 64
                    && chars.next().is_some_and(|c| c.is_ascii_alphanumeric())
                    && chars
                        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | ':' | '-'))
            }
            Self::Digest => text.strip_prefix("sha256:").is_some_and(|hex| {
                hex.len() == 64 && hex.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
            }),
            Self::Symbol => is_symbol(text),
        }
    }
}

/// One segment of a path.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Segment {
    Literal(String),
    Param { name: String, kind: ParamKind },
}

impl Segment {
    fn literal(text: &str) -> Self {
        Self::Literal(text.to_owned())
    }

    fn param(name: &str, kind: ParamKind) -> Self {
        Self::Param {
            name: name.to_owned(),
            kind,
        }
    }

    fn accepts(&self, text: &str) -> bool {
        match self {
            Self::Literal(literal) => text == literal,
            Self::Param { kind, .. } => kind.accepts(text),
        }
    }
}

/// One allowed host, method and path, with the query keys it may carry.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Rule {
    /// The route id of the manifest, or a name for the provider and queue paths.
    pub id: String,
    pub class: Class,
    /// Lower-case DNS name, no port: every request goes to port 443.
    pub host: String,
    pub method: Method,
    pub path: Vec<Segment>,
    /// The query keys the request may carry. Empty means no query.
    pub query_keys: Vec<String>,
    /// The largest request body.
    pub max_request_bytes: usize,
    /// The largest response body.
    pub max_response_bytes: u64,
}

impl Rule {
    /// The path as a template: `/v1/attempts/{attempt_id}/claim`.
    #[must_use]
    pub fn template(&self) -> String {
        let mut text = String::new();
        for segment in &self.path {
            text.push('/');
            match segment {
                Segment::Literal(literal) => text.push_str(literal),
                Segment::Param { name, .. } => {
                    text.push('{');
                    text.push_str(name);
                    text.push('}');
                }
            }
        }
        text
    }

    fn path_matches(&self, path: &str) -> bool {
        let Some(rest) = path.strip_prefix('/') else {
            return false;
        };
        let mut parts = rest.split('/');
        for segment in &self.path {
            match parts.next() {
                Some(part) if segment.accepts(part) => {}
                _ => return false,
            }
        }
        parts.next().is_none()
    }
}

/// Why a request was refused.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Refusal {
    /// No rule has this host.
    Host,
    /// The host has no rule for this method.
    Method,
    /// The host and method have no rule for this path.
    Path,
    /// The query carries a key that the rule does not list. Only the key is kept.
    Query { key: String },
    /// The request body is larger than the rule allows.
    RequestTooLarge { limit_bytes: usize },
    /// The budget of the class is spent.
    Budget { class: Class, limit: u32 },
    /// The server answered with a redirect. `to_host` is the host of an absolute target.
    Redirect {
        status: u16,
        to_host: Option<String>,
    },
}

impl fmt::Display for Refusal {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Host => f.write_str("the host is not on the egress allowlist"),
            Self::Method => f.write_str("the method is not allowed for this host"),
            Self::Path => f.write_str("the path is not allowed for this host and method"),
            Self::Query { key } => write!(f, "the query key `{key}` is not allowed for this path"),
            Self::RequestTooLarge { limit_bytes } => {
                write!(
                    f,
                    "the request body is above the limit of {limit_bytes} bytes"
                )
            }
            Self::Budget { class, limit } => {
                write!(
                    f,
                    "the request budget of {limit} for {class:?} requests is spent"
                )
            }
            Self::Redirect {
                status,
                to_host: Some(host),
            } => write!(
                f,
                "a redirect ({status}) to {host} is refused and not followed"
            ),
            Self::Redirect {
                status,
                to_host: None,
            } => write!(f, "a redirect ({status}) is refused and not followed"),
        }
    }
}

/// Why a request produced no response.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum EgressError {
    /// The policy or the budget refused the request, or the server redirected.
    Refused(Refusal),
    /// The wire produced no response.
    Wire(WireError),
}

impl fmt::Display for EgressError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Refused(refusal) => write!(f, "egress refused: {refusal}"),
            Self::Wire(error) => write!(f, "egress failed: {error}"),
        }
    }
}

impl std::error::Error for EgressError {}

/// The allowlist.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Policy {
    rules: Vec<Rule>,
}

/// A host, method and path as the caller states them.
#[derive(Clone, Copy, Debug)]
pub struct Target<'a> {
    pub method: Method,
    pub host: &'a str,
    pub path: &'a str,
    pub query: &'a [(String, String)],
}

impl Policy {
    /// A policy of exactly these rules.
    #[must_use]
    pub const fn new(rules: Vec<Rule>) -> Self {
        Self { rules }
    }

    /// The rules, in order.
    #[must_use]
    pub fn rules(&self) -> &[Rule] {
        &self.rules
    }

    /// The rule that allows `target`.
    ///
    /// # Errors
    /// The first check that failed: host, method, path, then the query keys.
    pub fn check(&self, target: &Target<'_>) -> Result<&Rule, Refusal> {
        let on_host: Vec<&Rule> = self
            .rules
            .iter()
            .filter(|rule| rule.host == target.host)
            .collect();
        if on_host.is_empty() {
            return Err(Refusal::Host);
        }
        let with_method: Vec<&Rule> = on_host
            .into_iter()
            .filter(|rule| rule.method == target.method)
            .collect();
        if with_method.is_empty() {
            return Err(Refusal::Method);
        }
        let rule = with_method
            .into_iter()
            .find(|rule| rule.path_matches(target.path))
            .ok_or(Refusal::Path)?;
        for (key, _) in target.query {
            if !rule.query_keys.iter().any(|allowed| allowed == key) {
                return Err(Refusal::Query { key: key.clone() });
            }
        }
        Ok(rule)
    }

    /// The rules of the batch binary: the provider reads, the queue paths and the batch routes of
    /// the application API (OQ-05 section 5).
    ///
    /// # Errors
    /// [`OriginError::Queue`] when the account or queue id is not a plain token.
    pub fn batch(
        api: &Origin,
        queue_account_id: &str,
        queue_id: &str,
    ) -> Result<Self, OriginError> {
        let mut rules = market_rules();
        rules.extend(queue_rules(queue_account_id, queue_id)?);
        rules.extend(api_rules(api));
        Ok(Self::new(rules))
    }
}

fn market_rules() -> Vec<Rule> {
    EGRESS_RULES
        .iter()
        .map(|rule| {
            let path: Vec<Segment> = rule
                .path
                .iter()
                .map(|segment| match segment {
                    MarketSegment::Literal(text) => Segment::literal(text),
                    MarketSegment::Symbol => Segment::param("symbol", ParamKind::Symbol),
                })
                .collect();
            let id = format!(
                "provider{}",
                path.iter()
                    .map(|segment| match segment {
                        Segment::Literal(text) => format!(".{text}"),
                        Segment::Param { .. } => String::new(),
                    })
                    .collect::<String>()
            );
            Rule {
                id: format!("{id}@{}", rule.host.name()),
                class: Class::Provider,
                host: rule.host.name().to_owned(),
                method: Method::Get,
                path,
                query_keys: MARKET_QUERY_KEYS
                    .iter()
                    .map(|key| (*key).to_owned())
                    .collect(),
                max_request_bytes: 0,
                max_response_bytes: 256 * 1024 * 1024,
            }
        })
        .collect()
}

fn queue_rules(account: &str, queue: &str) -> Result<Vec<Rule>, OriginError> {
    let plain = |text: &str| {
        !text.is_empty()
            && text.len() <= 64
            && text
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    };
    if !plain(account) || !plain(queue) {
        return Err(OriginError::Queue);
    }
    let path = |last: &str| -> Vec<Segment> {
        [
            "client", "v4", "accounts", account, "queues", queue, "messages", last,
        ]
        .iter()
        .map(|text| Segment::literal(text))
        .collect()
    };
    let rule = |id: &str, last: &str| Rule {
        id: id.to_owned(),
        class: Class::Queue,
        host: CLOUDFLARE_HOST.to_owned(),
        method: Method::Post,
        path: path(last),
        query_keys: Vec::new(),
        max_request_bytes: 64 * KIB,
        max_response_bytes: 4 * MIB as u64,
    };
    Ok(vec![rule("queue.pull", "pull"), rule("queue.ack", "ack")])
}

/// The batch-callable routes of `routes/v1.json`, on the configured API host. A test reads the
/// manifest and requires this list to equal its routes that a batch credential or an attempt
/// capability of the batch principal may call.
fn api_rules(origin: &Origin) -> Vec<Rule> {
    let attempt = || Segment::param("attempt_id", ParamKind::Identifier);
    let route = |id: &str, method: Method, tail: Vec<Segment>, request: usize, response: usize| {
        let mut path = vec![
            Segment::literal("v1"),
            Segment::literal("attempts"),
            attempt(),
        ];
        path.extend(tail);
        Rule {
            id: id.to_owned(),
            class: Class::Api,
            host: origin.host().to_owned(),
            method,
            path,
            query_keys: Vec::new(),
            max_request_bytes: request,
            max_response_bytes: response as u64,
        }
    };
    let result_route =
        |id: &str, name: &str| route(id, Method::Post, vec![Segment::literal(name)], 4 * MIB, MIB);
    vec![
        route(
            "attempts.claim",
            Method::Post,
            vec![Segment::literal("claim")],
            4 * MIB,
            MIB,
        ),
        route(
            "attempts.input",
            Method::Get,
            vec![
                Segment::literal("inputs"),
                Segment::param("digest", ParamKind::Digest),
            ],
            0,
            16 * MIB,
        ),
        route(
            "attempts.artefact",
            Method::Put,
            vec![
                Segment::literal("artefacts"),
                Segment::param("digest", ParamKind::Digest),
            ],
            16 * MIB,
            MIB,
        ),
        result_route("attempts.retrieval-result", "retrieval-result"),
        result_route("attempts.validation-result", "validation-result"),
        result_route("attempts.evaluation-submission", "evaluation-submission"),
        result_route("attempts.gate-report", "gate-report"),
    ]
}

/// Why an origin or a queue identifier was refused at configuration time.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OriginError {
    /// The URL does not start with `https://`.
    NotHttps,
    /// The URL carries user information.
    Userinfo,
    /// The URL carries a port. Every request goes to port 443.
    Port,
    /// The URL has a path, a query or a fragment. An origin is a host.
    NotAnOrigin,
    /// The host is an IP address or has no registrable name.
    NotADomainName,
    /// The host is not a plain lower-case DNS name.
    Malformed,
    /// A queue account or queue identifier is not a plain token.
    Queue,
}

impl fmt::Display for OriginError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::NotHttps => "the URL is not an https:// URL",
            Self::Userinfo => "the URL carries user information",
            Self::Port => "the URL carries a port; every request goes to port 443",
            Self::NotAnOrigin => "the URL is not a bare origin: it has a path, query or fragment",
            Self::NotADomainName => "the host is an IP address or a name without a dot",
            Self::Malformed => "the host is not a plain lower-case DNS name",
            Self::Queue => "the queue account or queue identifier is not a plain token",
        })
    }
}

impl std::error::Error for OriginError {}

/// The host of the application API. Only an `https://` URL of a plain DNS name makes one.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Origin {
    host: String,
}

impl Origin {
    /// Read `https://<host>` (a single trailing `/` is allowed).
    ///
    /// # Errors
    /// [`OriginError`] for any other scheme, user information, a port, a path, an IP address or a
    /// host that is not a lower-case DNS name.
    pub fn parse(text: &str) -> Result<Self, OriginError> {
        let rest = text.strip_prefix("https://").ok_or(OriginError::NotHttps)?;
        let host = rest.strip_suffix('/').unwrap_or(rest);
        if host.contains('@') {
            return Err(OriginError::Userinfo);
        }
        if host.contains(':') {
            return Err(OriginError::Port);
        }
        if host.contains(['/', '?', '#', '\\']) {
            return Err(OriginError::NotAnOrigin);
        }
        let labels: Vec<&str> = host.split('.').collect();
        let plain_label = |label: &str| {
            !label.is_empty()
                && label.len() <= 63
                && !label.starts_with('-')
                && !label.ends_with('-')
                && label
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        };
        if host.len() > 253 || !labels.iter().all(|label| plain_label(label)) {
            return Err(OriginError::Malformed);
        }
        if labels.len() < 2 || host.bytes().all(|b| b.is_ascii_digit() || b == b'.') {
            return Err(OriginError::NotADomainName);
        }
        Ok(Self {
            host: host.to_owned(),
        })
    }

    /// The lower-case DNS name.
    #[must_use]
    pub fn host(&self) -> &str {
        &self.host
    }
}

/// The credential of a request. It is written into a header here and nowhere else.
#[derive(Clone, Copy)]
pub enum Auth<'a> {
    None,
    /// `Authorization: Bearer <secret>`.
    Bearer(&'a Secret),
    /// The two Alpaca key headers.
    AlpacaKeys(&'a Credentials),
}

impl fmt::Debug for Auth<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::None => "Auth::None",
            Self::Bearer(_) => "Auth::Bearer(<redacted>)",
            Self::AlpacaKeys(_) => "Auth::AlpacaKeys(<redacted>)",
        })
    }
}

/// One request.
#[derive(Clone, Copy, Debug)]
pub struct Request<'a> {
    pub target: Target<'a>,
    pub auth: Auth<'a>,
    pub content_type: Option<&'a str>,
    pub body: &'a [u8],
    pub timeout: Duration,
    /// The response body limit of this call; the rule's limit applies as well.
    pub max_response_bytes: u64,
}

/// A response that passed the checks.
#[derive(Clone, PartialEq, Eq)]
pub struct Response {
    pub status: u16,
    /// Header names in lower case.
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl Response {
    /// The value of the header `name` (lower case).
    #[must_use]
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.as_str())
    }
}

impl fmt::Debug for Response {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Response")
            .field("status", &self.status)
            .field("body_bytes", &self.body.len())
            .finish_non_exhaustive()
    }
}

/// What happened to one request. Never a URL, a query value, a header or a body.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Outcome {
    Sent {
        status: u16,
        request_bytes: usize,
        response_bytes: usize,
    },
    Failed(WireError),
    Refused(Refusal),
}

/// One line of the egress log.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LogEntry {
    /// The rule id, absent when no rule matched.
    pub rule: Option<String>,
    pub class: Option<Class>,
    pub method: Method,
    pub host: String,
    pub outcome: Outcome,
}

#[derive(Debug, Default)]
struct State {
    used: BTreeMap<Class, u32>,
    limits: BTreeMap<Class, u32>,
    log: Vec<LogEntry>,
}

/// The egress module. It is cheap: a job builds its own, with its own budgets, over the shared
/// policy and wire.
pub struct Egress {
    policy: Arc<Policy>,
    wire: Arc<dyn Wire>,
    state: Mutex<State>,
}

impl fmt::Debug for Egress {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Egress")
            .field("rules", &self.policy.rules.len())
            .finish_non_exhaustive()
    }
}

fn host_of_location(value: &str) -> Option<String> {
    let rest = value
        .strip_prefix("https://")
        .or_else(|| value.strip_prefix("http://"))?;
    let authority = rest.split(['/', '?', '#']).next()?;
    let host = authority.rsplit('@').next()?;
    let host = host.split(':').next()?;
    if host.is_empty() || host.len() > 253 || !host.is_ascii() {
        return None;
    }
    Some(host.to_ascii_lowercase())
}

impl Egress {
    /// An egress over `policy` and `wire` with no request limit.
    #[must_use]
    pub fn new(policy: Arc<Policy>, wire: Arc<dyn Wire>) -> Self {
        Self {
            policy,
            wire,
            state: Mutex::new(State::default()),
        }
    }

    /// The same egress with at most `max_requests` requests of `class`, retries included.
    #[must_use]
    pub fn with_limit(self, class: Class, max_requests: u32) -> Self {
        self.lock().limits.insert(class, max_requests);
        self
    }

    /// Set the request limit of `class` after the fact, for a job that learns its limit from its
    /// request.
    pub fn set_limit(&self, class: Class, max_requests: u32) {
        self.lock().limits.insert(class, max_requests);
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Requests of `class` that reached the wire, failed ones included: what was billed.
    #[must_use]
    pub fn requests(&self, class: Class) -> u32 {
        self.lock().used.get(&class).copied().unwrap_or(0)
    }

    /// Every request so far, in order, with its outcome.
    #[must_use]
    pub fn log(&self) -> Vec<LogEntry> {
        self.lock().log.clone()
    }

    /// The refusals so far, in order.
    #[must_use]
    pub fn refusals(&self) -> Vec<Refusal> {
        self.lock()
            .log
            .iter()
            .filter_map(|entry| match &entry.outcome {
                Outcome::Refused(refusal) => Some(refusal.clone()),
                _ => None,
            })
            .collect()
    }

    fn record(&self, entry: LogEntry) {
        self.lock().log.push(entry);
    }

    fn refuse(&self, request: &Request<'_>, rule: Option<&Rule>, refusal: Refusal) -> EgressError {
        self.record(LogEntry {
            rule: rule.map(|r| r.id.clone()),
            class: rule.map(|r| r.class),
            method: request.target.method,
            host: request.target.host.to_owned(),
            outcome: Outcome::Refused(refusal.clone()),
        });
        EgressError::Refused(refusal)
    }

    /// Reserve one request of `class`.
    fn reserve(&self, class: Class) -> Result<(), Refusal> {
        let mut state = self.lock();
        let used = state.used.get(&class).copied().unwrap_or(0);
        if let Some(limit) = state.limits.get(&class).copied()
            && used >= limit
        {
            return Err(Refusal::Budget { class, limit });
        }
        state.used.insert(class, used.saturating_add(1));
        Ok(())
    }

    /// Check, send and check the answer.
    ///
    /// # Errors
    /// [`EgressError::Refused`] before any I/O for a request outside the policy, a body above the
    /// limit or a spent budget, and after the exchange for a redirect; [`EgressError::Wire`] when
    /// no response arrived.
    pub fn send(&self, request: &Request<'_>) -> Result<Response, EgressError> {
        let rule = match self.policy.check(&request.target) {
            Ok(rule) => rule,
            Err(refusal) => return Err(self.refuse(request, None, refusal)),
        };
        if request.body.len() > rule.max_request_bytes {
            return Err(self.refuse(
                request,
                Some(rule),
                Refusal::RequestTooLarge {
                    limit_bytes: rule.max_request_bytes,
                },
            ));
        }
        if let Err(refusal) = self.reserve(rule.class) {
            return Err(self.refuse(request, Some(rule), refusal));
        }
        let mut headers: Vec<(&'static str, Secret)> = vec![(
            "accept",
            Secret::new("application/json, application/octet-stream"),
        )];
        if let Some(content_type) = request.content_type {
            headers.push(("content-type", Secret::new(content_type)));
        }
        match request.auth {
            Auth::None => {}
            Auth::Bearer(secret) => headers.push((
                "authorization",
                Secret::new(format!("Bearer {}", secret.expose())),
            )),
            Auth::AlpacaKeys(credentials) => {
                headers.push(("apca-api-key-id", Secret::new(credentials.key_id())));
                headers.push(("apca-api-secret-key", Secret::new(credentials.secret())));
            }
        }
        let wire_request = WireRequest {
            method: request.target.method,
            host: request.target.host,
            path: request.target.path,
            query: request.target.query,
            headers,
            body: request.body,
            timeout: request.timeout,
            max_response_bytes: request.max_response_bytes.min(rule.max_response_bytes),
        };
        let entry = |outcome| LogEntry {
            rule: Some(rule.id.clone()),
            class: Some(rule.class),
            method: request.target.method,
            host: request.target.host.to_owned(),
            outcome,
        };
        let response = match self.wire.send(&wire_request) {
            Ok(response) => response,
            Err(error) => {
                self.record(entry(Outcome::Failed(error)));
                return Err(EgressError::Wire(error));
            }
        };
        if (300..400).contains(&response.status) {
            let to_host = response
                .headers
                .iter()
                .find(|(name, _)| name == "location")
                .and_then(|(_, value)| host_of_location(value));
            let refusal = Refusal::Redirect {
                status: response.status,
                to_host,
            };
            self.record(entry(Outcome::Refused(refusal.clone())));
            return Err(EgressError::Refused(refusal));
        }
        self.record(entry(Outcome::Sent {
            status: response.status,
            request_bytes: request.body.len(),
            response_bytes: response.body.len(),
        }));
        Ok(Response {
            status: response.status,
            headers: response.headers,
            body: response.body,
        })
    }
}

/// The market adapters send through the egress module: GET, the Alpaca key headers, the provider
/// class and budget.
impl HttpTransport for Egress {
    fn get(
        &self,
        request: &HttpRequest,
        credentials: &Credentials,
        limits: TransportLimits,
    ) -> Result<HttpResponse, TransportError> {
        let host = match request.host {
            Host::Data | Host::Paper => request.host.name(),
        };
        let outgoing = Request {
            target: Target {
                method: Method::Get,
                host,
                path: &request.path,
                query: &request.query,
            },
            auth: Auth::AlpacaKeys(credentials),
            content_type: None,
            body: &[],
            timeout: limits.timeout,
            max_response_bytes: limits.max_response_bytes,
        };
        match self.send(&outgoing) {
            Ok(response) => Ok(HttpResponse {
                status: response.status,
                headers: response.headers,
                body: response.body,
            }),
            // The exchange happened and was billed: the adapter records the status that the
            // provider answered and classifies a 3xx as a refused redirect. The target is not
            // passed on: no header, no body.
            Err(EgressError::Refused(Refusal::Redirect { status, .. })) => Ok(HttpResponse {
                status,
                headers: Vec::new(),
                body: Vec::new(),
            }),
            Err(EgressError::Refused(_)) => Err(TransportError::EgressRefused),
            Err(EgressError::Wire(WireError::Timeout)) => Err(TransportError::Timeout),
            Err(EgressError::Wire(WireError::Connection)) => Err(TransportError::Connection),
            Err(EgressError::Wire(WireError::BodyTooLarge)) => Err(TransportError::BodyTooLarge),
        }
    }
}

/// A borrowed egress is a transport too, so an adapter can hold a reference.
impl HttpTransport for &Egress {
    fn get(
        &self,
        request: &HttpRequest,
        credentials: &Credentials,
        limits: TransportLimits,
    ) -> Result<HttpResponse, TransportError> {
        (**self).get(request, credentials, limits)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn origin() -> Origin {
        Origin::parse("https://api.openquant.example").unwrap()
    }

    fn target<'a>(
        method: Method,
        host: &'a str,
        path: &'a str,
        query: &'a [(String, String)],
    ) -> Target<'a> {
        Target {
            method,
            host,
            path,
            query,
        }
    }

    #[test]
    fn an_origin_is_an_https_dns_name_and_nothing_else() {
        assert!(Origin::parse("https://api.example.com").is_ok());
        assert!(Origin::parse("https://api.example.com/").is_ok());
        assert_eq!(
            Origin::parse("http://api.example.com"),
            Err(OriginError::NotHttps)
        );
        assert_eq!(Origin::parse("api.example.com"), Err(OriginError::NotHttps));
        assert_eq!(
            Origin::parse("HTTPS://api.example.com"),
            Err(OriginError::NotHttps)
        );
        assert_eq!(
            Origin::parse("https://u:p@api.example.com"),
            Err(OriginError::Userinfo)
        );
        assert_eq!(
            Origin::parse("https://api.example.com:8443"),
            Err(OriginError::Port)
        );
        assert_eq!(
            Origin::parse("https://api.example.com/v1"),
            Err(OriginError::NotAnOrigin)
        );
        assert_eq!(
            Origin::parse("https://api.example.com?x=1"),
            Err(OriginError::NotAnOrigin)
        );
        assert_eq!(
            Origin::parse("https://127.0.0.1"),
            Err(OriginError::NotADomainName)
        );
        assert_eq!(
            Origin::parse("https://localhost"),
            Err(OriginError::NotADomainName)
        );
        assert_eq!(
            Origin::parse("https://API.example.com"),
            Err(OriginError::Malformed)
        );
        assert_eq!(
            Origin::parse("https://api.example.com."),
            Err(OriginError::Malformed)
        );
        assert_eq!(
            Origin::parse("https://-a.example.com"),
            Err(OriginError::Malformed)
        );
    }

    #[test]
    fn the_policy_checks_host_method_path_and_query_in_that_order() {
        let policy = Policy::batch(&origin(), "acct1", "queue1").unwrap();
        let none: Vec<(String, String)> = Vec::new();
        let ok = |t: Target<'_>| policy.check(&t).map(|rule| rule.id.clone());
        assert_eq!(
            ok(target(
                Method::Post,
                "api.openquant.example",
                "/v1/attempts/a-1/claim",
                &none
            )),
            Ok("attempts.claim".to_owned())
        );
        assert_eq!(
            ok(target(
                Method::Get,
                "evil.example",
                "/v1/attempts/a-1/claim",
                &none
            )),
            Err(Refusal::Host)
        );
        assert_eq!(
            ok(target(
                Method::Get,
                "api.openquant.example",
                "/v1/attempts/a-1/claim",
                &none
            )),
            Err(Refusal::Path)
        );
        assert_eq!(
            ok(target(
                Method::Put,
                "api.cloudflare.com",
                "/client/v4/accounts/acct1/queues/queue1/messages/pull",
                &none
            )),
            Err(Refusal::Method)
        );
        for path in [
            "/v1/attempts/../claim",
            "/v1/attempts/a%2F1/claim",
            "/v1/attempts//claim",
            "/v1/attempts/a-1/claim/",
            "/v1/attempts/a-1/claim/extra",
            "v1/attempts/a-1/claim",
            "/v1/attempts/./claim",
        ] {
            assert_eq!(
                ok(target(Method::Post, "api.openquant.example", path, &none)),
                Err(Refusal::Path),
                "{path}"
            );
        }
        let query = vec![("x".to_owned(), "1".to_owned())];
        assert_eq!(
            ok(target(
                Method::Post,
                "api.openquant.example",
                "/v1/attempts/a-1/claim",
                &query
            )),
            Err(Refusal::Query {
                key: "x".to_owned()
            })
        );
        // The account and queue of the configuration are literal segments.
        assert_eq!(
            ok(target(
                Method::Post,
                "api.cloudflare.com",
                "/client/v4/accounts/other/queues/queue1/messages/ack",
                &none
            )),
            Err(Refusal::Path)
        );
        assert_eq!(
            ok(target(
                Method::Post,
                "api.cloudflare.com",
                "/client/v4/accounts/acct1/queues/queue1/messages/ack",
                &none
            )),
            Ok("queue.ack".to_owned())
        );
    }

    #[test]
    fn a_digest_parameter_is_a_sha256_digest() {
        let digest = format!("sha256:{}", "ab".repeat(32));
        assert!(ParamKind::Digest.accepts(&digest));
        for bad in [
            "sha256:AB",
            &format!("sha256:{}", "AB".repeat(32)),
            &format!("sha256:{}", "ab".repeat(31)),
            &format!("sha512:{}", "ab".repeat(32)),
            "..",
        ] {
            assert!(!ParamKind::Digest.accepts(bad), "{bad}");
        }
        assert!(ParamKind::Identifier.accepts("run-1.a:b_c"));
        assert!(!ParamKind::Identifier.accepts("."));
        assert!(!ParamKind::Identifier.accepts(".."));
        assert!(!ParamKind::Identifier.accepts("a/b"));
        assert!(!ParamKind::Identifier.accepts(&"a".repeat(65)));
    }

    #[test]
    fn a_location_header_gives_only_a_host() {
        assert_eq!(
            host_of_location("https://User:pw@Evil.Example:8443/path?q=1"),
            Some("evil.example".to_owned())
        );
        assert_eq!(
            host_of_location("http://other.example/x"),
            Some("other.example".to_owned())
        );
        assert_eq!(host_of_location("/relative"), None);
        assert_eq!(host_of_location("https:///x"), None);
    }
}

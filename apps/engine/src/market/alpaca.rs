//! The Alpaca adapter: endpoints, pagination and response parsing.
//!
//! Endpoint paths, query names and response shapes below follow Alpaca's public API reference as
//! last known. They are NOT verified against a live response: no credential exists in this
//! repository and no provider call is allowed from it. The bounded provider probe of the delivery
//! step is the first real check, and the parsers fail with a typed `MalformedResponse` rather than
//! guess when a response differs.
//!
//! Numbers keep their exact text: bar prices and volumes are read as raw JSON tokens
//! ([`RawValue`]) and turned into canonical decimal strings by digit shifting. No float exists
//! anywhere in the read path.

use std::{
    collections::{BTreeMap, BTreeSet},
    fmt,
    marker::PhantomData,
};

use serde::{
    Deserialize, Deserializer,
    de::{MapAccess, Visitor},
};
use serde_json::value::RawValue;

use super::{
    error::{Operation, ProviderError},
    http::{Credentials, Host, HttpRequest, HttpTransport},
    number::DecimalText,
    provider::{
        ActionQuery, AssetRecord, BarQuery, CalendarRow, CallContext, Capabilities, DateRange,
        Feed, MarketDataProvider, ProviderAction, ProviderActionKind, ProviderBar,
    },
    time::{Date, LocalTime, Timestamp},
};

/// The adapter name in capability references: `provider:alpaca/<operation>@1`.
pub const PROVIDER: &str = "alpaca";

/// Most bars one page may hold, as requested.
const BARS_PAGE_LIMIT: &str = "10000";

/// Most corporate-action records one page may hold, as requested.
const ACTIONS_PAGE_LIMIT: &str = "1000";

/// What this adapter supplies.
pub const CAPABILITIES: Capabilities = Capabilities {
    provider: PROVIDER,
    operations: &Operation::ALL,
    market: "US_EQUITIES",
    feeds: &[Feed::Sip, Feed::Iex],
    timeframes: &["1Day", "1Min"],
    adjustments: &["RAW"],
    session_bases: &["REGULAR_HOURS"],
    time_precision: "seconds",
    revision_limitation: "The provider states no revision history or as-of view; a snapshot \
        retrieved now can hold later corrections, and an end time is a constraint, not a guarantee.",
};

/// One segment of an egress path pattern.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Segment {
    /// The segment equals this text.
    Literal(&'static str),
    /// The segment is a ticker symbol (`[A-Z][A-Z0-9.]{0,9}`).
    Symbol,
}

/// One host, method and path combination the adapter uses. The egress module of the batch host
/// allows these and nothing else (OQ-05 section 5). The method is always GET.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct EgressRule {
    pub host: Host,
    pub path: &'static [Segment],
}

impl EgressRule {
    /// Whether `request` is a request this rule allows.
    #[must_use]
    pub fn allows(&self, request: &HttpRequest) -> bool {
        if request.host != self.host {
            return false;
        }
        let Some(rest) = request.path.strip_prefix('/') else {
            return false;
        };
        let mut parts = rest.split('/');
        for segment in self.path {
            let Some(part) = parts.next() else {
                return false;
            };
            let matches = match segment {
                Segment::Literal(text) => part == *text,
                Segment::Symbol => is_symbol(part),
            };
            if !matches {
                return false;
            }
        }
        parts.next().is_none()
    }
}

/// The host and path allowlist of this adapter.
pub const EGRESS_RULES: [EgressRule; 4] = [
    EgressRule {
        host: Host::Data,
        path: &[
            Segment::Literal("v2"),
            Segment::Literal("stocks"),
            Segment::Symbol,
            Segment::Literal("bars"),
        ],
    },
    EgressRule {
        host: Host::Data,
        path: &[
            Segment::Literal("v1"),
            Segment::Literal("corporate-actions"),
        ],
    },
    EgressRule {
        host: Host::Paper,
        path: &[Segment::Literal("v2"), Segment::Literal("calendar")],
    },
    EgressRule {
        host: Host::Paper,
        path: &[
            Segment::Literal("v2"),
            Segment::Literal("assets"),
            Segment::Symbol,
        ],
    },
];

/// Whether `text` is a ticker symbol as the instrument mapping contract allows it.
#[must_use]
pub fn is_symbol(text: &str) -> bool {
    let mut chars = text.chars();
    text.len() <= 10
        && chars.next().is_some_and(|c| c.is_ascii_uppercase())
        && chars.all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '.')
}

/// The Alpaca market-data adapter over an [`HttpTransport`].
pub struct AlpacaAdapter<T> {
    transport: T,
    credentials: Credentials,
}

impl<T> AlpacaAdapter<T> {
    /// An adapter that sends its requests through `transport` with `credentials`.
    #[must_use]
    pub const fn new(transport: T, credentials: Credentials) -> Self {
        Self {
            transport,
            credentials,
        }
    }

    /// The transport, for a test that reads what it recorded.
    #[must_use]
    pub const fn transport(&self) -> &T {
        &self.transport
    }
}

/// Prints the adapter without its credentials or its transport.
impl<T> fmt::Debug for AlpacaAdapter<T> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("AlpacaAdapter")
            .field("credentials", &self.credentials)
            .finish_non_exhaustive()
    }
}

fn require_symbol(symbol: &str) -> Result<(), ProviderError> {
    if is_symbol(symbol) {
        Ok(())
    } else {
        Err(ProviderError::InvalidRequest {
            reason: "symbol is not a ticker symbol".to_owned(),
        })
    }
}

fn pair(name: &str, value: impl Into<String>) -> (String, String) {
    (name.to_owned(), value.into())
}

impl<T: HttpTransport> AlpacaAdapter<T> {
    fn fetch(
        &self,
        cx: &mut CallContext<'_>,
        operation: Operation,
        request: &HttpRequest,
    ) -> Result<Vec<u8>, ProviderError> {
        cx.send(&self.transport, &self.credentials, operation, request)
    }

    /// One request and its parse. A body that does not parse leaves its call in the log, marked
    /// failed, because the request was billed and returned nothing the snapshot can use.
    fn fetch_parse<P>(
        &self,
        cx: &mut CallContext<'_>,
        operation: Operation,
        request: &HttpRequest,
        parse: impl FnOnce(&[u8]) -> Result<P, ProviderError>,
    ) -> Result<P, ProviderError> {
        let body = self.fetch(cx, operation, request)?;
        parse(&body).inspect_err(|error| cx.reject_last(error))
    }

    /// Follow `next_page_token` until it ends. A token seen twice is a malformed response, and a
    /// budget that ends before the last page is `RequestLimitReached`, never a short result.
    fn paged<P>(
        &self,
        cx: &mut CallContext<'_>,
        operation: Operation,
        base: &HttpRequest,
        mut page: impl FnMut(&[u8]) -> Result<(P, Option<String>), ProviderError>,
    ) -> Result<Vec<P>, ProviderError> {
        let mut pages = Vec::new();
        let mut seen: BTreeSet<String> = BTreeSet::new();
        let mut token: Option<String> = None;
        loop {
            let mut request = base.clone();
            if let Some(token) = &token {
                request.query.push(pair("page_token", token.as_str()));
            }
            let (parsed, next) = self.fetch_parse(cx, operation, &request, |body| {
                let (parsed, next) = page(body)?;
                if next
                    .as_ref()
                    .is_some_and(|next| next.is_empty() || !seen.insert(next.clone()))
                {
                    return Err(ProviderError::malformed(
                        operation,
                        "the page token is empty or repeats an earlier one",
                    ));
                }
                Ok((parsed, next))
            })?;
            pages.push(parsed);
            match next {
                None => return Ok(pages),
                Some(next) => token = Some(next),
            }
        }
    }

    fn bars(
        &self,
        cx: &mut CallContext<'_>,
        operation: Operation,
        timeframe: &str,
        query: &BarQuery,
    ) -> Result<Vec<ProviderBar>, ProviderError> {
        require_symbol(&query.symbol)?;
        if query.start > query.end {
            return Err(ProviderError::InvalidRequest {
                reason: "bar range ends before it starts".to_owned(),
            });
        }
        let feed = match query.feed {
            Feed::Sip => "sip",
            Feed::Iex => "iex",
        };
        let base = HttpRequest {
            host: Host::Data,
            path: format!("/v2/stocks/{}/bars", query.symbol),
            query: vec![
                pair("timeframe", timeframe),
                pair("start", query.start.to_string()),
                pair("end", query.end.to_string()),
                pair("limit", BARS_PAGE_LIMIT),
                pair("adjustment", "raw"),
                pair("feed", feed),
                pair("sort", "asc"),
            ],
        };
        let mut last: Option<Timestamp> = None;
        let pages = self.paged(cx, operation, &base, |body| {
            let (bars, next) = parse_bars_page(operation, body, query)?;
            for bar in &bars {
                if last.is_some_and(|previous| bar.start < previous) {
                    return Err(ProviderError::malformed(
                        operation,
                        "bars are not in ascending order",
                    ));
                }
                last = Some(bar.start);
            }
            Ok((bars, next))
        })?;
        Ok(pages.into_iter().flatten().collect())
    }
}

impl<T: HttpTransport> MarketDataProvider for AlpacaAdapter<T> {
    fn capabilities(&self) -> &Capabilities {
        &CAPABILITIES
    }

    fn asset(&self, cx: &mut CallContext<'_>, symbol: &str) -> Result<AssetRecord, ProviderError> {
        require_symbol(symbol)?;
        let request = HttpRequest {
            host: Host::Paper,
            path: format!("/v2/assets/{symbol}"),
            query: Vec::new(),
        };
        let wire: WireAsset = self.fetch_parse(cx, Operation::Asset, &request, |body| {
            parse_json(Operation::Asset, body)
        })?;
        Ok(AssetRecord {
            id: wire.id,
            symbol: wire.symbol,
            class: wire.class,
            status: wire.status,
        })
    }

    fn calendar(
        &self,
        cx: &mut CallContext<'_>,
        range: DateRange,
    ) -> Result<Vec<CalendarRow>, ProviderError> {
        if range.start > range.end {
            return Err(ProviderError::InvalidRequest {
                reason: "calendar range ends before it starts".to_owned(),
            });
        }
        let request = HttpRequest {
            host: Host::Paper,
            path: "/v2/calendar".to_owned(),
            query: vec![
                pair("start", range.start.to_string()),
                pair("end", range.end.to_string()),
            ],
        };
        self.fetch_parse(cx, Operation::Calendar, &request, |body| {
            parse_calendar(body, range)
        })
    }

    fn daily_bars(
        &self,
        cx: &mut CallContext<'_>,
        query: &BarQuery,
    ) -> Result<Vec<ProviderBar>, ProviderError> {
        self.bars(cx, Operation::DailyBars, "1Day", query)
    }

    fn minute_bars(
        &self,
        cx: &mut CallContext<'_>,
        query: &BarQuery,
    ) -> Result<Vec<ProviderBar>, ProviderError> {
        self.bars(cx, Operation::MinuteBars, "1Min", query)
    }

    fn corporate_actions(
        &self,
        cx: &mut CallContext<'_>,
        query: &ActionQuery,
    ) -> Result<Vec<ProviderAction>, ProviderError> {
        require_symbol(&query.symbol)?;
        if query.range.start > query.range.end {
            return Err(ProviderError::InvalidRequest {
                reason: "corporate-action range ends before it starts".to_owned(),
            });
        }
        let base = HttpRequest {
            host: Host::Data,
            path: "/v1/corporate-actions".to_owned(),
            query: vec![
                pair("symbols", query.symbol.as_str()),
                pair("start", query.range.start.to_string()),
                pair("end", query.range.end.to_string()),
                pair("limit", ACTIONS_PAGE_LIMIT),
            ],
        };
        let pages = self.paged(cx, Operation::CorporateActions, &base, |body| {
            parse_actions_page(body, &query.symbol)
        })?;
        Ok(pages.into_iter().flatten().collect())
    }
}

// ---- wire shapes ------------------------------------------------------------------------------

/// A JSON object read as an ordered list of its members, refusing a duplicate key. serde's map
/// types keep the last of two equal keys, which would let a provider hide a value.
struct StrictMap<T>(Vec<(String, T)>);

impl<'de, T: Deserialize<'de>> Deserialize<'de> for StrictMap<T> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct Members<T>(PhantomData<T>);
        impl<'de, T: Deserialize<'de>> Visitor<'de> for Members<T> {
            type Value = StrictMap<T>;

            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("a JSON object")
            }

            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
                let mut seen = BTreeSet::new();
                let mut members = Vec::new();
                while let Some(key) = map.next_key::<String>()? {
                    if !seen.insert(key.clone()) {
                        return Err(serde::de::Error::custom("duplicate field"));
                    }
                    members.push((key, map.next_value::<T>()?));
                }
                Ok(StrictMap(members))
            }
        }
        deserializer.deserialize_map(Members(PhantomData))
    }
}

#[derive(Deserialize)]
struct WireAsset {
    id: String,
    symbol: String,
    class: String,
    status: String,
}

#[derive(Deserialize)]
struct WireCalendarRow {
    date: String,
    open: String,
    close: String,
}

#[derive(Deserialize)]
struct WireBarsPage<'a> {
    #[serde(borrow)]
    bars: &'a RawValue,
    next_page_token: Option<String>,
}

#[derive(Deserialize)]
struct WireBar<'a> {
    t: String,
    #[serde(borrow)]
    o: &'a RawValue,
    #[serde(borrow)]
    h: &'a RawValue,
    #[serde(borrow)]
    l: &'a RawValue,
    #[serde(borrow)]
    c: &'a RawValue,
    #[serde(borrow)]
    v: &'a RawValue,
}

#[derive(Deserialize)]
struct WireActionsPage<'a> {
    #[serde(borrow)]
    corporate_actions: &'a RawValue,
    next_page_token: Option<String>,
}

/// Why a body did not parse, without any of its content beyond a field name.
fn json_reason(error: &serde_json::Error) -> String {
    let message = error.to_string();
    let named = ["missing field", "duplicate field"]
        .iter()
        .any(|prefix| message.starts_with(prefix));
    if named {
        let first = message.split(" at line ").next().unwrap_or("");
        format!("invalid JSON: {first}")
    } else {
        format!(
            "invalid JSON ({:?} at line {} column {})",
            error.classify(),
            error.line(),
            error.column()
        )
    }
}

fn parse_json<'a, V: Deserialize<'a>>(
    operation: Operation,
    body: &'a [u8],
) -> Result<V, ProviderError> {
    serde_json::from_slice(body).map_err(|e| ProviderError::malformed(operation, json_reason(&e)))
}

fn parse_raw<'a, V: Deserialize<'a>>(
    operation: Operation,
    raw: &'a RawValue,
) -> Result<V, ProviderError> {
    serde_json::from_str(raw.get())
        .map_err(|e| ProviderError::malformed(operation, json_reason(&e)))
}

fn number(operation: Operation, what: &str, raw: &RawValue) -> Result<DecimalText, ProviderError> {
    DecimalText::from_json_number(raw.get())
        .map_err(|e| ProviderError::malformed_number(operation, what, e))
}

fn parse_bars_page(
    operation: Operation,
    body: &[u8],
    query: &BarQuery,
) -> Result<(Vec<ProviderBar>, Option<String>), ProviderError> {
    let page: WireBarsPage<'_> = parse_json(operation, body)?;
    let wire: Option<Vec<WireBar<'_>>> = parse_raw(operation, page.bars)?;
    let mut bars = Vec::new();
    for bar in wire.unwrap_or_default() {
        let start = Timestamp::parse(&bar.t)
            .map_err(|e| ProviderError::malformed_time(operation, "bar time", e))?;
        if start < query.start || start > query.end {
            return Err(ProviderError::malformed(
                operation,
                "a bar lies outside the requested range",
            ));
        }
        bars.push(ProviderBar {
            start,
            open: number(operation, "open", bar.o)?,
            high: number(operation, "high", bar.h)?,
            low: number(operation, "low", bar.l)?,
            close: number(operation, "close", bar.c)?,
            volume: number(operation, "volume", bar.v)?,
        });
    }
    Ok((bars, page.next_page_token))
}

fn parse_calendar(body: &[u8], range: DateRange) -> Result<Vec<CalendarRow>, ProviderError> {
    let operation = Operation::Calendar;
    let wire: Vec<WireCalendarRow> = parse_json(operation, body)?;
    let mut rows: Vec<CalendarRow> = Vec::with_capacity(wire.len());
    for row in wire {
        let date = Date::parse(&row.date)
            .map_err(|e| ProviderError::malformed_time(operation, "calendar date", e))?;
        let open = LocalTime::parse(&row.open)
            .map_err(|e| ProviderError::malformed_time(operation, "session open", e))?;
        let close = LocalTime::parse(&row.close)
            .map_err(|e| ProviderError::malformed_time(operation, "session close", e))?;
        if date < range.start || date > range.end {
            return Err(ProviderError::malformed(
                operation,
                "a session lies outside the requested range",
            ));
        }
        if date.is_weekend() {
            return Err(ProviderError::malformed(
                operation,
                "a session falls on a weekend",
            ));
        }
        if open >= close {
            return Err(ProviderError::malformed(
                operation,
                "a session closes before it opens",
            ));
        }
        if rows.last().is_some_and(|previous| previous.date >= date) {
            return Err(ProviderError::malformed(
                operation,
                "calendar dates are not strictly ascending",
            ));
        }
        rows.push(CalendarRow { date, open, close });
    }
    Ok(rows)
}

/// The text of a scalar field, or `None` for `null` and for a nested value.
fn scalar_text(
    operation: Operation,
    name: &str,
    raw: &RawValue,
) -> Result<Option<String>, ProviderError> {
    let text = raw.get().trim();
    match text.as_bytes().first() {
        Some(b'"') => serde_json::from_str::<String>(text).map(Some).map_err(|e| {
            ProviderError::malformed(operation, format!("{name}: {}", json_reason(&e)))
        }),
        Some(b't') => Ok(Some("true".to_owned())),
        Some(b'f') => Ok(Some("false".to_owned())),
        Some(b'n' | b'{' | b'[') | None => Ok(None),
        Some(_) => number(operation, name, raw).map(|n| Some(n.to_string())),
    }
}

/// The actions of one page. A list name maps onto a kind: `forward_splits`, `reverse_splits`,
/// `cash_dividends`, or any other name for a type the profile has no rule for.
fn parse_actions_page(
    body: &[u8],
    symbol: &str,
) -> Result<(Vec<ProviderAction>, Option<String>), ProviderError> {
    let operation = Operation::CorporateActions;
    let page: WireActionsPage<'_> = parse_json(operation, body)?;
    let lists: Option<StrictMap<Option<Vec<StrictMap<&RawValue>>>>> =
        parse_raw(operation, page.corporate_actions)?;
    let mut actions = Vec::new();
    for (type_name, records) in lists.map(|map| map.0).unwrap_or_default() {
        for record in records.unwrap_or_default() {
            actions.push(build_action(&type_name, &record.0, symbol)?);
        }
    }
    Ok((actions, page.next_page_token))
}

/// One action from the members of its record. Numbers must be JSON numbers, booleans JSON booleans
/// and dates JSON strings: a quoted number is never coerced.
fn build_action(
    type_name: &str,
    record: &[(String, &RawValue)],
    symbol: &str,
) -> Result<ProviderAction, ProviderError> {
    let operation = Operation::CorporateActions;
    let raw = |name: &str| {
        record
            .iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| *value)
    };
    let required = |name: &str| {
        raw(name)
            .ok_or_else(|| ProviderError::malformed(operation, format!("a record has no {name}")))
    };
    let decimal = |name: &str| -> Result<DecimalText, ProviderError> {
        number(operation, name, required(name)?)
    };
    let flag = |name: &str| -> Result<bool, ProviderError> {
        match required(name)?.get().trim() {
            "true" => Ok(true),
            "false" => Ok(false),
            _ => Err(ProviderError::malformed(
                operation,
                format!("{name} is not a boolean"),
            )),
        }
    };
    let string = |name: &str| -> Result<String, ProviderError> {
        serde_json::from_str::<String>(required(name)?.get())
            .map_err(|_| ProviderError::malformed(operation, format!("{name} is not a string")))
    };
    let date_field = |name: &str| -> Result<Date, ProviderError> {
        Date::parse(&string(name)?).map_err(|e| ProviderError::malformed_time(operation, name, e))
    };
    let record_symbol = if raw("symbol").is_some() {
        string("symbol")?
    } else {
        symbol.to_owned()
    };
    if record_symbol != symbol {
        return Err(ProviderError::malformed(
            operation,
            "a record belongs to another symbol than the one requested",
        ));
    }
    let (kind, ex_date) = match type_name {
        "forward_splits" | "reverse_splits" => (
            ProviderActionKind::Split {
                reverse: type_name == "reverse_splits",
                new_rate: decimal("new_rate")?,
                old_rate: decimal("old_rate")?,
            },
            date_field("ex_date")?,
        ),
        "cash_dividends" => (
            ProviderActionKind::CashDividend {
                rate: decimal("rate")?,
                special: flag("special")?,
                foreign: flag("foreign")?,
            },
            date_field("ex_date")?,
        ),
        other => {
            let date = if raw("ex_date").is_some() {
                date_field("ex_date")?
            } else {
                date_field("process_date")?
            };
            (
                ProviderActionKind::Other {
                    type_name: other.to_owned(),
                },
                date,
            )
        }
    };
    // Every scalar member by name, for the profile's evidence fields.
    let mut fields = BTreeMap::new();
    for (name, value) in record {
        if let Some(text) = scalar_text(operation, name, value)? {
            fields.insert(name.clone(), text);
        }
    }
    Ok(ProviderAction {
        kind,
        symbol: record_symbol,
        ex_date,
        record_id: fields.get("id").cloned(),
        fields,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn symbols_follow_the_instrument_contract() {
        for good in ["A", "AAPL", "BRK.B", "ABCDEFGHIJ", "X1"] {
            assert!(is_symbol(good), "{good}");
        }
        for bad in [
            "",
            "aapl",
            "1A",
            "A/B",
            "ABCDEFGHIJK",
            "A B",
            "../x",
            "A%2F",
        ] {
            assert!(!is_symbol(bad), "{bad}");
        }
    }

    #[test]
    fn egress_rules_allow_exactly_the_adapter_paths() {
        let get = |host, path: &str| HttpRequest {
            host,
            path: path.to_owned(),
            query: Vec::new(),
        };
        let allowed = |request: &HttpRequest| EGRESS_RULES.iter().any(|rule| rule.allows(request));
        assert!(allowed(&get(Host::Data, "/v2/stocks/AAPL/bars")));
        assert!(allowed(&get(Host::Data, "/v1/corporate-actions")));
        assert!(allowed(&get(Host::Paper, "/v2/calendar")));
        assert!(allowed(&get(Host::Paper, "/v2/assets/AAPL")));
        // Wrong host for the path, extra and missing segments, a traversal and an order endpoint.
        assert!(!allowed(&get(Host::Paper, "/v2/stocks/AAPL/bars")));
        assert!(!allowed(&get(Host::Data, "/v2/calendar")));
        assert!(!allowed(&get(Host::Data, "/v2/stocks/AAPL/bars/extra")));
        assert!(!allowed(&get(Host::Data, "/v2/stocks/AAPL")));
        assert!(!allowed(&get(Host::Data, "/v2/stocks/../bars")));
        assert!(!allowed(&get(Host::Paper, "/v2/orders")));
        assert!(!allowed(&get(Host::Paper, "/v2/account")));
        assert!(!allowed(&get(Host::Data, "v2/stocks/AAPL/bars")));
    }
}

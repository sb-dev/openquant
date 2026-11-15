//! The `MarketDataProvider` interface and the call accounting around it (OQ-05 section 7.1).
//!
//! An adapter returns typed provider data. It does not decide limits. [`CallContext`] enforces
//! them outside the adapter: the request budget is reserved before any I/O, a cancelled or late
//! retrieval stops, only a classified transient failure is retried within `max_retries`, and a
//! `Retry-After` hint is honoured. Every attempt, failed or retried, is one recorded call, and every
//! successful response is kept as a source body so that its bytes can be hashed and retained.

use std::{collections::BTreeMap, time::Duration};

use super::{
    error::{ErrorClass, Operation, ProviderError},
    http::{
        Credentials, HttpRequest, HttpResponse, HttpTransport, TransportError, TransportLimits,
    },
    number::DecimalText,
    time::{Date, LocalTime, Timestamp},
};

/// Longest `Retry-After` the adapter preserves, in seconds.
pub const MAX_RETRY_AFTER_SECONDS: u64 = 86_400;

/// Longest pause between two attempts that the backoff itself chooses, in seconds.
const MAX_BACKOFF_SECONDS: u64 = 60;

/// Source of the current time. A fake advances it in tests.
pub trait Clock {
    fn now(&self) -> Timestamp;
}

/// Waits between attempts. A fake records the waits in tests.
pub trait Sleeper {
    fn sleep(&self, seconds: u64);
}

/// Tells the retrieval to stop.
pub trait Cancellation {
    fn is_cancelled(&self) -> bool;
}

/// Bounds of one retrieval, enforced by [`CallContext`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Limits {
    /// Most provider requests, retries and pages included.
    pub max_requests: u32,
    /// Most retries of one request after a transient failure.
    pub max_retries: u32,
    pub request_timeout: Duration,
    pub max_response_bytes: u64,
    /// No request starts, and no wait ends, after this instant.
    pub deadline: Timestamp,
}

/// One provider request that was made, successful or not.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CallRecord {
    /// 1-based, in the order the requests were made.
    pub sequence: u32,
    pub operation: Operation,
    pub started_at: Timestamp,
    /// Absent when no response arrived.
    pub http_status: Option<u16>,
    /// Present when the call failed.
    pub error: Option<ErrorClass>,
    /// The provider's `Retry-After`, when a 429 carried one.
    pub retry_after_seconds: Option<u64>,
}

impl CallRecord {
    /// Whether the call produced a usable response.
    #[must_use]
    pub const fn succeeded(&self) -> bool {
        self.error.is_none()
    }
}

/// The bytes of one successful provider response.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SourceBody {
    /// The sequence of the call that received it.
    pub sequence: u32,
    pub operation: Operation,
    pub received_at: Timestamp,
    pub bytes: Vec<u8>,
}

/// The request budget, the clock and the record of one retrieval.
pub struct CallContext<'a> {
    limits: Limits,
    clock: &'a dyn Clock,
    sleeper: &'a dyn Sleeper,
    cancellation: &'a dyn Cancellation,
    calls: Vec<CallRecord>,
    sources: Vec<SourceBody>,
}

impl<'a> CallContext<'a> {
    /// A context with an empty call log.
    #[must_use]
    pub fn new(
        limits: Limits,
        clock: &'a dyn Clock,
        sleeper: &'a dyn Sleeper,
        cancellation: &'a dyn Cancellation,
    ) -> Self {
        Self {
            limits,
            clock,
            sleeper,
            cancellation,
            calls: Vec::new(),
            sources: Vec::new(),
        }
    }

    /// The limits of this retrieval.
    #[must_use]
    pub const fn limits(&self) -> &Limits {
        &self.limits
    }

    /// The current time of the context's clock.
    #[must_use]
    pub fn now(&self) -> Timestamp {
        self.clock.now()
    }

    /// Every request made so far, in order.
    #[must_use]
    pub fn calls(&self) -> &[CallRecord] {
        &self.calls
    }

    /// The bytes of every successful response so far, in order.
    #[must_use]
    pub fn sources(&self) -> &[SourceBody] {
        &self.sources
    }

    /// Requests made so far. Billed usage: a failed request counts too.
    #[must_use]
    pub fn requests_made(&self) -> usize {
        self.calls.len()
    }

    /// Send one request through `transport` and return the body of the successful response.
    ///
    /// The budget is checked before the request goes out. A transient failure is retried within
    /// `max_retries`, after a wait of the larger of the backoff and the provider's `Retry-After`.
    /// A wait that would pass the deadline is not made: the failure is returned as it stands.
    ///
    /// # Errors
    /// The [`ProviderError`] of the last attempt, [`ProviderError::Cancelled`],
    /// [`ProviderError::DeadlineExceeded`] or [`ProviderError::RequestLimitReached`].
    pub(crate) fn send(
        &mut self,
        transport: &dyn HttpTransport,
        credentials: &Credentials,
        operation: Operation,
        request: &HttpRequest,
    ) -> Result<Vec<u8>, ProviderError> {
        let mut retries: u32 = 0;
        loop {
            self.admit()?;
            let sequence = u32::try_from(self.calls.len() + 1).unwrap_or(u32::MAX);
            let started_at = self.clock.now();
            let transport_limits = TransportLimits {
                timeout: self.limits.request_timeout,
                max_response_bytes: self.limits.max_response_bytes,
            };
            let reply = transport.get(request, credentials, transport_limits);
            let received_at = self.clock.now();
            let (http_status, outcome) = match reply {
                Ok(response) => {
                    let status = response.status;
                    (Some(status), self.classify(response, received_at))
                }
                Err(error) => (None, Err(transport_error(error))),
            };
            let error = outcome.as_ref().err();
            self.calls.push(CallRecord {
                sequence,
                operation,
                started_at,
                http_status,
                error: error.map(ProviderError::class),
                retry_after_seconds: error.and_then(ProviderError::retry_after_seconds),
            });
            let error = match outcome {
                Ok(bytes) => {
                    self.sources.push(SourceBody {
                        sequence,
                        operation,
                        received_at,
                        bytes: bytes.clone(),
                    });
                    return Ok(bytes);
                }
                Err(error) => error,
            };
            // No retry without budget: the failure stands, and no wait is spent on a request that
            // would be refused.
            let used = u64::try_from(self.calls.len()).unwrap_or(u64::MAX);
            if !error.retryable()
                || retries >= self.limits.max_retries
                || used >= u64::from(self.limits.max_requests)
            {
                return Err(error);
            }
            let wait = error
                .retry_after_seconds()
                .unwrap_or(0)
                .max(backoff_seconds(retries));
            let resume = self
                .clock
                .now()
                .add_seconds(i64::try_from(wait).unwrap_or(i64::MAX));
            if resume > self.limits.deadline {
                return Err(error);
            }
            self.sleeper.sleep(wait);
            retries += 1;
        }
    }

    /// Mark the last call as failed because its body was unusable, and drop that body. Only
    /// called right after a call that succeeded at the HTTP level: the response was billed but
    /// carries nothing the snapshot can use.
    pub(crate) fn reject_last(&mut self, error: &ProviderError) {
        if let Some(call) = self.calls.last_mut() {
            call.error = Some(error.class());
        }
        self.sources.pop();
    }

    /// Reserve one request: refuse when cancelled, late or out of budget.
    fn admit(&self) -> Result<(), ProviderError> {
        if self.cancellation.is_cancelled() {
            return Err(ProviderError::Cancelled);
        }
        if self.clock.now() > self.limits.deadline {
            return Err(ProviderError::DeadlineExceeded);
        }
        let used = u64::try_from(self.calls.len()).unwrap_or(u64::MAX);
        if used >= u64::from(self.limits.max_requests) {
            return Err(ProviderError::RequestLimitReached {
                max_requests: self.limits.max_requests,
            });
        }
        Ok(())
    }

    /// Turn a response into its body, or into the error its status code means.
    fn classify(&self, response: HttpResponse, now: Timestamp) -> Result<Vec<u8>, ProviderError> {
        match response.status {
            200..=299 => {
                let size = u64::try_from(response.body.len()).unwrap_or(u64::MAX);
                if size > self.limits.max_response_bytes {
                    Err(ProviderError::ResponseTooLarge {
                        limit_bytes: self.limits.max_response_bytes,
                    })
                } else {
                    Ok(response.body)
                }
            }
            status @ 300..=399 => Err(ProviderError::RedirectRefused { status }),
            401 => Err(ProviderError::Authentication),
            403 => Err(ProviderError::Permission),
            404 => Err(ProviderError::NotFound),
            429 => Err(ProviderError::RateLimited {
                retry_after_seconds: response
                    .header("retry-after")
                    .and_then(|value| parse_retry_after(value, now)),
            }),
            status @ (408 | 500..=599) => Err(ProviderError::Server { status }),
            status @ 400..=499 => Err(ProviderError::BadRequest { status }),
            status => Err(ProviderError::UnexpectedStatus { status }),
        }
    }
}

/// Prints the counts, never a body.
impl std::fmt::Debug for CallContext<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CallContext")
            .field("limits", &self.limits)
            .field("calls", &self.calls.len())
            .field("sources", &self.sources.len())
            .finish_non_exhaustive()
    }
}

fn transport_error(error: TransportError) -> ProviderError {
    match error {
        TransportError::Timeout => ProviderError::Timeout,
        TransportError::Connection => ProviderError::Connection,
        TransportError::EgressRefused => ProviderError::EgressRefused,
        TransportError::BodyTooLarge => ProviderError::ResponseTooLarge { limit_bytes: 0 },
    }
}

/// Pause before retry number `retries + 1` (0-based): 1, 2, 4 ... seconds up to a minute. There is
/// no jitter, so a replay with the same clock waits the same way.
fn backoff_seconds(retries: u32) -> u64 {
    1_u64
        .checked_shl(retries)
        .unwrap_or(MAX_BACKOFF_SECONDS)
        .min(MAX_BACKOFF_SECONDS)
}

/// `Retry-After` as delay seconds or as an HTTP date, capped at one day. A date in the past is a
/// delay of zero. Anything else is no hint.
fn parse_retry_after(value: &str, now: Timestamp) -> Option<u64> {
    let value = value.trim();
    if !value.is_empty() && value.bytes().all(|b| b.is_ascii_digit()) {
        let seconds = value.parse::<u64>().unwrap_or(u64::MAX);
        return Some(seconds.min(MAX_RETRY_AFTER_SECONDS));
    }
    let at = parse_http_date(value)?;
    let delay = at.seconds_since(now).max(0);
    Some(
        u64::try_from(delay)
            .unwrap_or(0)
            .min(MAX_RETRY_AFTER_SECONDS),
    )
}

/// An IMF-fixdate such as `Sun, 06 Nov 1994 08:49:37 GMT`.
fn parse_http_date(value: &str) -> Option<Timestamp> {
    const MONTHS: [&str; 12] = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    let mut parts = value.split(' ');
    let weekday = parts.next()?;
    let day = parts.next()?;
    let month = parts.next()?;
    let year = parts.next()?;
    let time = parts.next()?;
    let zone = parts.next()?;
    if parts.next().is_some() || zone != "GMT" || !weekday.ends_with(',') || weekday.len() != 4 {
        return None;
    }
    let month = MONTHS.iter().position(|name| *name == month)?;
    let date = Date::new(
        year.parse().ok()?,
        i64::try_from(month + 1).ok()?,
        day.parse().ok()?,
    )
    .ok()?;
    let (hour, rest) = time.split_once(':')?;
    let (minute, second) = rest.split_once(':')?;
    let (hour, minute, second): (i64, i64, i64) = (
        hour.parse().ok()?,
        minute.parse().ok()?,
        second.parse().ok()?,
    );
    if !(0..24).contains(&hour) || !(0..60).contains(&minute) || !(0..60).contains(&second) {
        return None;
    }
    Some(
        date.start_of_day_utc()
            .add_seconds(hour * 3600 + minute * 60 + second),
    )
}

/// A market-data feed. The profile selects it explicitly; there is no default.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Feed {
    Sip,
    Iex,
}

impl Feed {
    /// The upper-case name used by the contracts.
    #[must_use]
    pub const fn contract_name(self) -> &'static str {
        match self {
            Self::Sip => "SIP",
            Self::Iex => "IEX",
        }
    }

    /// The feed named by a contract value (`SIP` or `IEX`).
    #[must_use]
    pub fn from_contract_name(name: &str) -> Option<Self> {
        match name {
            "SIP" => Some(Self::Sip),
            "IEX" => Some(Self::Iex),
            _ => None,
        }
    }
}

/// Inclusive calendar date range.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DateRange {
    pub start: Date,
    pub end: Date,
}

/// A request for bars of one symbol between two instants (both inclusive).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BarQuery {
    pub symbol: String,
    pub feed: Feed,
    pub start: Timestamp,
    pub end: Timestamp,
}

/// A request for the corporate actions of one symbol.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ActionQuery {
    pub symbol: String,
    pub range: DateRange,
}

/// The provider's record of one asset.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AssetRecord {
    pub id: String,
    pub symbol: String,
    pub class: String,
    pub status: String,
}

/// One trading day of the provider's calendar, in New York local time.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CalendarRow {
    pub date: Date,
    pub open: LocalTime,
    pub close: LocalTime,
}

/// One provider bar. Prices and volume keep the exact text of the response.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProviderBar {
    /// The bar's start instant as the provider stamps it.
    pub start: Timestamp,
    pub open: DecimalText,
    pub high: DecimalText,
    pub low: DecimalText,
    pub close: DecimalText,
    pub volume: DecimalText,
}

/// The kind of a provider corporate action, with the values the normaliser needs.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ProviderActionKind {
    /// A forward or reverse split, as the provider's `new_rate` and `old_rate`.
    Split {
        reverse: bool,
        new_rate: DecimalText,
        old_rate: DecimalText,
    },
    /// A cash dividend. `special` and `foreign` are the provider's flags.
    CashDividend {
        rate: DecimalText,
        special: bool,
        foreign: bool,
    },
    /// Any other action type, named by the provider's list name.
    Other { type_name: String },
}

/// One provider corporate action. `fields` holds every scalar field of the record by name, so a
/// profile can name the provider field that evidences an availability date.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProviderAction {
    pub kind: ProviderActionKind,
    pub symbol: String,
    pub ex_date: Date,
    /// The provider's own record id, when the record has one.
    pub record_id: Option<String>,
    pub fields: BTreeMap<String, String>,
}

/// What an adapter declares it can supply (OQ-05 section 7.1, capabilities).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Capabilities {
    /// The adapter name used in capability references.
    pub provider: &'static str,
    pub operations: &'static [Operation],
    pub market: &'static str,
    pub feeds: &'static [Feed],
    pub timeframes: &'static [&'static str],
    pub adjustments: &'static [&'static str],
    pub session_bases: &'static [&'static str],
    pub time_precision: &'static str,
    /// What the provider does not tell about revisions and as-of history.
    pub revision_limitation: &'static str,
}

/// The financial semantics a request asks for, as contract strings.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RequestedSemantics<'a> {
    pub market: &'a str,
    pub feed: &'a str,
    pub timeframe: &'a str,
    pub adjustment: &'a str,
    pub session_basis: &'a str,
}

impl Capabilities {
    /// The operations named by `references`, in order.
    ///
    /// # Errors
    /// [`ProviderError::UnsupportedCapability`] for a reference that is not an operation of this
    /// provider.
    pub fn resolve_operations(&self, references: &[&str]) -> Result<Vec<Operation>, ProviderError> {
        references
            .iter()
            .map(|reference| {
                Operation::from_capability_ref(self.provider, reference)
                    .filter(|operation| self.operations.contains(operation))
                    .ok_or_else(|| ProviderError::UnsupportedCapability {
                        what: format!("operation {reference}"),
                    })
            })
            .collect()
    }

    /// Reject semantics the adapter does not provide. A provider default never stands in for a
    /// declared value.
    ///
    /// # Errors
    /// [`ProviderError::UnsupportedCapability`] naming the first unsupported setting.
    pub fn check_semantics(&self, semantics: &RequestedSemantics<'_>) -> Result<(), ProviderError> {
        let unsupported = |what: &str, value: &str| ProviderError::UnsupportedCapability {
            what: format!("{what} {value}"),
        };
        if semantics.market != self.market {
            return Err(unsupported("market", semantics.market));
        }
        if !Feed::from_contract_name(semantics.feed).is_some_and(|feed| self.feeds.contains(&feed))
        {
            return Err(unsupported("feed", semantics.feed));
        }
        if !self.timeframes.contains(&semantics.timeframe) {
            return Err(unsupported("timeframe", semantics.timeframe));
        }
        if !self.adjustments.contains(&semantics.adjustment) {
            return Err(unsupported("adjustment", semantics.adjustment));
        }
        if !self.session_bases.contains(&semantics.session_basis) {
            return Err(unsupported("session basis", semantics.session_basis));
        }
        Ok(())
    }
}

/// Market data behind one adapter. Provider SDKs, authentication, endpoint conventions and
/// pagination stay inside the implementation. Every call goes through the [`CallContext`], which
/// owns the limits.
pub trait MarketDataProvider {
    /// What this adapter supplies.
    fn capabilities(&self) -> &Capabilities;

    /// The provider's record of `symbol`.
    ///
    /// # Errors
    /// [`ProviderError`] as classified by the call context and the response parser.
    fn asset(&self, cx: &mut CallContext<'_>, symbol: &str) -> Result<AssetRecord, ProviderError>;

    /// The trading calendar between two dates, inclusive.
    ///
    /// # Errors
    /// [`ProviderError`] as classified by the call context and the response parser.
    fn calendar(
        &self,
        cx: &mut CallContext<'_>,
        range: DateRange,
    ) -> Result<Vec<CalendarRow>, ProviderError>;

    /// Raw daily bars, in ascending order of their start.
    ///
    /// # Errors
    /// [`ProviderError`] as classified by the call context and the response parser.
    fn daily_bars(
        &self,
        cx: &mut CallContext<'_>,
        query: &BarQuery,
    ) -> Result<Vec<ProviderBar>, ProviderError>;

    /// Raw minute bars, in ascending order of their start. Used by the session probe.
    ///
    /// # Errors
    /// [`ProviderError`] as classified by the call context and the response parser.
    fn minute_bars(
        &self,
        cx: &mut CallContext<'_>,
        query: &BarQuery,
    ) -> Result<Vec<ProviderBar>, ProviderError>;

    /// The corporate actions of one symbol, every type the provider lists.
    ///
    /// # Errors
    /// [`ProviderError`] as classified by the call context and the response parser.
    fn corporate_actions(
        &self,
        cx: &mut CallContext<'_>,
        query: &ActionQuery,
    ) -> Result<Vec<ProviderAction>, ProviderError>;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retry_after_accepts_seconds_and_http_dates() {
        let now = Timestamp::parse("2026-11-14T10:00:00Z").unwrap();
        assert_eq!(parse_retry_after("3", now), Some(3));
        assert_eq!(parse_retry_after(" 120 ", now), Some(120));
        assert_eq!(parse_retry_after("0", now), Some(0));
        assert_eq!(
            parse_retry_after("999999999999", now),
            Some(MAX_RETRY_AFTER_SECONDS)
        );
        assert_eq!(
            parse_retry_after("Sat, 14 Nov 2026 10:00:30 GMT", now),
            Some(30)
        );
        // A date in the past is no wait at all.
        assert_eq!(
            parse_retry_after("Sat, 14 Nov 2026 09:00:00 GMT", now),
            Some(0)
        );
        for bad in [
            "",
            "-1",
            "1.5",
            "soon",
            "Sat, 14 Nov 2026 10:00:30 UTC",
            "14 Nov 2026 10:00:30 GMT",
            "Sat, 31 Nov 2026 10:00:30 GMT",
        ] {
            assert_eq!(parse_retry_after(bad, now), None, "{bad:?}");
        }
    }

    #[test]
    fn backoff_doubles_to_a_minute() {
        let waits: Vec<u64> = (0..8).map(backoff_seconds).collect();
        assert_eq!(waits, [1, 2, 4, 8, 16, 32, 60, 60]);
        assert_eq!(backoff_seconds(200), 60);
    }

    #[test]
    fn capabilities_reject_unsupported_semantics_explicitly() {
        const CAPS: Capabilities = Capabilities {
            provider: "alpaca",
            operations: &[Operation::DailyBars, Operation::Asset],
            market: "US_EQUITIES",
            feeds: &[Feed::Sip, Feed::Iex],
            timeframes: &["1Day", "1Min"],
            adjustments: &["RAW"],
            session_bases: &["REGULAR_HOURS"],
            time_precision: "seconds",
            revision_limitation: "none stated",
        };
        let ok = RequestedSemantics {
            market: "US_EQUITIES",
            feed: "SIP",
            timeframe: "1Day",
            adjustment: "RAW",
            session_basis: "REGULAR_HOURS",
        };
        assert_eq!(CAPS.check_semantics(&ok), Ok(()));
        for (changed, what) in [
            (
                RequestedSemantics {
                    market: "EU_EQUITIES",
                    ..ok
                },
                "market",
            ),
            (RequestedSemantics { feed: "OTC", ..ok }, "feed"),
            (
                RequestedSemantics {
                    timeframe: "1Hour",
                    ..ok
                },
                "timeframe",
            ),
            (
                RequestedSemantics {
                    adjustment: "SPLIT",
                    ..ok
                },
                "adjustment",
            ),
            (
                RequestedSemantics {
                    session_basis: "EXTENDED_HOURS",
                    ..ok
                },
                "session basis",
            ),
        ] {
            match CAPS.check_semantics(&changed) {
                Err(ProviderError::UnsupportedCapability { what: text }) => {
                    assert!(text.starts_with(what), "{text}");
                }
                other => panic!("{what}: {other:?}"),
            }
        }
        assert_eq!(
            CAPS.resolve_operations(&["provider:alpaca/daily_bars@1", "provider:alpaca/asset@1"]),
            Ok(vec![Operation::DailyBars, Operation::Asset])
        );
        // A known operation that this provider does not declare, and an unknown one.
        assert!(
            CAPS.resolve_operations(&["provider:alpaca/calendar@1"])
                .is_err()
        );
        assert!(
            CAPS.resolve_operations(&["provider:massive/daily_bars@1"])
                .is_err()
        );
    }
}

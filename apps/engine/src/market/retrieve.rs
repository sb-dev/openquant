//! One snapshot retrieval: the sequence of provider calls behind the gate, then the normaliser.
//!
//! The job wrapper, the queue, the claim, the upload and the `retrieval-result/1` assembly belong
//! to the batch host. This function takes a [`RetrievalPermit`] from the gate, a provider and a
//! [`CallContext`] and returns the frozen snapshot or a typed failure. The call context keeps the
//! call log and the source bodies, also when the retrieval fails, so every billed request is
//! recorded.

use std::{fmt, time::Duration};

use openquant_contracts::{
    ContractError,
    generated::{ExecutableIdentity, RetrievalRequest},
    payload_digest,
};

use super::{
    error::{ErrorClass, Operation, ProviderError},
    gate::RetrievalPermit,
    normalise::{NormaliserInput, ProfileBlock, Provenance, Snapshot, UseConstraints, normalise},
    provider::{
        ActionQuery, BarQuery, CallContext, DateRange, Feed, Limits, MarketDataProvider,
        RequestedSemantics,
    },
    time::{Date, Timestamp},
};

/// Days of provider calendar requested beyond the range end, so that a dividend payable shortly
/// after the scored end still has its payment session.
pub const CALENDAR_LOOKAHEAD_DAYS: i64 = 45;

/// Days added on both sides of the range when asking for corporate actions. The provider's filter
/// field is not verified, so the request is widened and the normaliser keeps the actions whose
/// ex-date lies in the range.
pub const ACTION_WINDOW_DAYS: i64 = 31;

/// The operations a snapshot needs.
const REQUIRED: [Operation; 4] = [
    Operation::Asset,
    Operation::Calendar,
    Operation::DailyBars,
    Operation::CorporateActions,
];

/// What the host adds to the request: its identity, the recorded terms and the licence text.
pub struct HostIdentity<'a> {
    pub executable: &'a ExecutableIdentity,
    pub adapter_version: &'a str,
    pub constraints: &'a UseConstraints,
    pub licence: &'a str,
}

/// Why a retrieval produced no snapshot.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RetrieveError {
    /// A provider call or the request failed.
    Provider(ProviderError),
    /// The data cannot meet the profile's rules.
    Blocked(ProfileBlock),
}

impl RetrieveError {
    /// The `retrieval-result/1` class.
    #[must_use]
    pub const fn class(&self) -> ErrorClass {
        match self {
            Self::Provider(error) => error.class(),
            Self::Blocked(block) => block.class(),
        }
    }

    /// A stable machine-readable name of the failure.
    #[must_use]
    pub const fn code(&self) -> &'static str {
        match self {
            Self::Provider(error) => error.code(),
            Self::Blocked(block) => block.code(),
        }
    }

    /// Whether a retry may help. A block never does: the same data gives the same answer.
    #[must_use]
    pub const fn retryable(&self) -> bool {
        match self {
            Self::Provider(error) => error.retryable(),
            Self::Blocked(_) => false,
        }
    }

    /// The provider's retry hint, when there is one.
    #[must_use]
    pub const fn retry_after_seconds(&self) -> Option<u64> {
        match self {
            Self::Provider(error) => error.retry_after_seconds(),
            Self::Blocked(_) => None,
        }
    }
}

impl fmt::Display for RetrieveError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Provider(error) => write!(f, "{error}"),
            Self::Blocked(block) => write!(f, "{block}"),
        }
    }
}

impl std::error::Error for RetrieveError {}

impl From<ProviderError> for RetrieveError {
    fn from(error: ProviderError) -> Self {
        Self::Provider(error)
    }
}

impl From<ProfileBlock> for RetrieveError {
    fn from(block: ProfileBlock) -> Self {
        Self::Blocked(block)
    }
}

fn invalid(reason: &str) -> RetrieveError {
    RetrieveError::Provider(ProviderError::InvalidRequest {
        reason: reason.to_owned(),
    })
}

/// The limits and the deadline that a retrieval request carries.
///
/// # Errors
/// [`ProviderError::InvalidRequest`] when a limit or the deadline cannot be read.
pub fn limits_from_request(request: &RetrievalRequest) -> Result<Limits, ProviderError> {
    let bad = |reason: &str| ProviderError::InvalidRequest {
        reason: reason.to_owned(),
    };
    Ok(Limits {
        max_requests: u32::try_from(request.limits.max_requests.get())
            .map_err(|_| bad("max_requests"))?,
        max_retries: u32::try_from(request.limits.max_retries).map_err(|_| bad("max_retries"))?,
        request_timeout: Duration::from_secs(request.limits.request_timeout_seconds.get()),
        max_response_bytes: request.limits.max_response_bytes.get(),
        deadline: Timestamp::parse(&request.deadline).map_err(|_| bad("deadline"))?,
    })
}

/// Retrieve and freeze one snapshot.
///
/// The calls run in a fixed order: the asset record, the calendar, the daily bars and the
/// corporate actions. A failed call ends the retrieval; nothing partial is returned as complete.
/// The request ends at the earlier of its range end and the context clock minus the profile's
/// minimum end age, so a bar that is still forming is never requested.
///
/// # Errors
/// [`RetrieveError::Provider`] for a failed call, an unsupported operation or semantic, or an
/// invalid request; [`RetrieveError::Blocked`] when the normaliser blocks the profile.
pub fn retrieve_snapshot(
    _permit: &RetrievalPermit,
    provider: &dyn MarketDataProvider,
    request: &RetrievalRequest,
    host: &HostIdentity<'_>,
    cx: &mut CallContext<'_>,
) -> Result<Snapshot, RetrieveError> {
    let capabilities = provider.capabilities();
    let references: Vec<&str> = request.operations.iter().map(|op| op.as_str()).collect();
    let listed = capabilities.resolve_operations(&references)?;
    for needed in REQUIRED {
        if !listed.contains(&needed) {
            return Err(RetrieveError::Provider(
                ProviderError::UnsupportedCapability {
                    what: format!("the request does not list the {needed} operation"),
                },
            ));
        }
    }
    let semantics = &request.semantics;
    let feed_name = semantics.feed.to_string();
    capabilities.check_semantics(&RequestedSemantics {
        market: capabilities.market,
        feed: &feed_name,
        timeframe: &semantics.timeframe.to_string(),
        adjustment: &semantics.adjustment.to_string(),
        session_basis: &semantics.session_basis.to_string(),
    })?;
    let feed = Feed::from_contract_name(&feed_name).ok_or_else(|| invalid("feed"))?;

    let range = DateRange {
        start: Date::parse(&request.range.start).map_err(|_| invalid("range start"))?,
        end: Date::parse(&request.range.end).map_err(|_| invalid("range end"))?,
    };
    if range.start > range.end {
        return Err(invalid("the range ends before it starts"));
    }
    let end_age = semantics.minimum_end_age_minutes.max(0).saturating_mul(60);
    let newest = cx.now().add_seconds(-end_age);
    let range_end_instant = range.end.start_of_day_utc().add_seconds(86_399);
    let end = range_end_instant.min(newest);
    let start = range.start.start_of_day_utc();
    if end < start {
        return Err(invalid("the range ends after the newest allowed data"));
    }

    let symbol = request.instrument.symbol.to_string();
    let asset = provider.asset(cx, &symbol)?;
    let calendar = provider.calendar(
        cx,
        DateRange {
            start: range.start,
            end: range.end.add_days(CALENDAR_LOOKAHEAD_DAYS),
        },
    )?;
    let bars = provider.daily_bars(
        cx,
        &BarQuery {
            symbol: symbol.clone(),
            feed,
            start,
            end,
        },
    )?;
    let actions = provider.corporate_actions(
        cx,
        &ActionQuery {
            symbol,
            range: DateRange {
                start: range.start.add_days(-ACTION_WINDOW_DAYS),
                end: range.end.add_days(ACTION_WINDOW_DAYS),
            },
        },
    )?;

    let request_digest = payload_digest(request)
        .map_err(|e: ContractError| invalid(&format!("the request cannot be digested: {e}")))?;
    let provenance = Provenance {
        job_id: request.job_id.to_string(),
        attempt_id: request.attempt.attempt_id.to_string(),
        request_digest,
        retrieved_at: cx.now(),
    };
    let sources = cx.sources().to_vec();
    let snapshot = normalise(&NormaliserInput {
        semantics,
        instrument: &request.instrument,
        profile: &request.profile,
        executable: host.executable,
        range,
        asset: &asset,
        calendar: &calendar,
        bars: &bars,
        actions: &actions,
        sources: &sources,
        adapter_version: host.adapter_version,
        provenance: &provenance,
        constraints: host.constraints,
        licence: host.licence,
    })?;
    Ok(snapshot)
}

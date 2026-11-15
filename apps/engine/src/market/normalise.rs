//! The normaliser: provider data in, `dataset-manifest/1` out (OQ-05 sections 7 and 7.1).
//!
//! A pure function. It applies the rules of `rules.txt`, whose SHA-256 is the transformation
//! digest of the manifest, and writes the availability time of every bar and corporate action
//! under the research profile's declared rules. Where a rule needs evidence that the provider data
//! does not hold, it blocks the profile: it never substitutes a fixed offset, the record date, the
//! process date or the retrieval time, and it never drops an action (OQ-02 section 1.1).
//!
//! All arithmetic is on integers and exact decimal text. No float is created.

use std::collections::BTreeMap;

use openquant_contracts::{
    Envelope,
    canonical::{canonical_json, digest, digest_bytes},
    generated::{DataSemantics, ExecutableIdentity, InstrumentMapping, RecordRef},
    validate,
};
use openquant_core::numeric::{MAX_PRICE, MAX_VOLUME};
use rust_decimal::Decimal;
use serde_json::{Value, json};

use super::{
    error::{ErrorClass, Operation},
    number::{DecimalText, MAX_PRICE_SCALE},
    provider::{
        AssetRecord, CalendarRow, DateRange, ProviderAction, ProviderActionKind, ProviderBar,
        SourceBody,
    },
    time::{Date, LocalTime, Timestamp, eastern_to_utc, session_from_midnight},
};

/// The reviewed rule text. Its digest is the transformation identity.
pub const RULES: &str = include_str!("rules.txt");

/// Name of the transformation in `source.transformation`.
pub const TRANSFORMATION_NAME: &str = "alpaca-daily-normaliser";

/// Version of the transformation in `source.transformation`.
pub const TRANSFORMATION_VERSION: &str = "1";

/// Most cash dividends the core accepts per run is 32; a manifest holds up to 128 actions.
const MAX_ACTIONS: usize = 128;
const MAX_CALENDAR: usize = 2000;
const MAX_SOURCE_RESPONSES: usize = 256;

/// The most fractional digits of a dividend amount, as the core reads it.
const MAX_AMOUNT_SCALE: u32 = 8;

/// The provider asset class of a US-listed equity.
const EQUITY_CLASS: &str = "us_equity";

/// The provider name in the manifest and in instrument identifiers.
const ID_PROVIDER: &str = "alpaca";

/// The SHA-256 digest of the rule text.
#[must_use]
pub fn rules_digest() -> String {
    digest_bytes(RULES.as_bytes())
}

/// Why the profile cannot use this data. A block is never retried: the same data gives the same
/// answer. The profile stays blocked until its inputs or its rules change.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ProfileBlock {
    /// The provider asset record disagrees with the instrument mapping.
    InstrumentMismatch { field: &'static str },
    /// The provider calendar cannot be converted to UTC.
    CalendarInvalid { reason: String },
    /// A bar is not stamped with the start of a session day.
    BarNotAtSessionStart { stamp: String },
    /// A bar falls on a date that is not a calendar session.
    BarOnNonSession { session: String },
    /// Two different bars for one session.
    ConflictingDuplicateBar { session: String },
    /// A bar breaks a price, volume or ordering rule.
    InvalidBar {
        session: String,
        reason: &'static str,
    },
    /// An action has no evidence of its availability: the profile field is missing or unreadable.
    ActionNotEvidenced { action_id: String, field: String },
    /// The declaration date is not strictly before the ex-date.
    ActionDeclaredNotBeforeExDate { action_id: String, field: String },
    /// The ex-date is not a calendar session.
    ActionExDateNotSession { action_id: String },
    /// The payable date is not a calendar session (or the provider calendar does not reach it).
    PayableDateNotSession { action_id: String },
    /// The payable date is before the ex-date.
    PayableBeforeExDate { action_id: String },
    /// An action type with no availability rule in the profile.
    UnsupportedActionType { type_name: String },
    /// A split ratio that is not a ratio of integers from 1 to 1000.
    UnrepresentableSplitRatio { action_id: String },
    /// A dividend amount that is not positive or has more than 8 fractional digits.
    InvalidActionValue {
        action_id: String,
        reason: &'static str,
    },
    /// The prices need more than 4 fractional digits.
    PriceScaleAboveLimit { scale: u32 },
    /// A list is longer than the manifest allows.
    LimitExceeded { what: &'static str, limit: usize },
    /// The manifest the rules produced is not a valid `dataset-manifest/1`. A defect.
    InvalidManifest { reason: String },
}

impl ProfileBlock {
    /// The `retrieval-result/1` class of this block. Missing evidence is unavailable data, a
    /// semantic the profile cannot hold is an unsupported capability, and a data defect is a
    /// malformed response. A block is never retryable.
    #[must_use]
    pub const fn class(&self) -> ErrorClass {
        match self {
            Self::ActionNotEvidenced { .. }
            | Self::ActionDeclaredNotBeforeExDate { .. }
            | Self::ActionExDateNotSession { .. }
            | Self::PayableDateNotSession { .. }
            | Self::PayableBeforeExDate { .. }
            | Self::InstrumentMismatch { .. } => ErrorClass::UnavailableData,
            Self::UnsupportedActionType { .. }
            | Self::UnrepresentableSplitRatio { .. }
            | Self::InvalidActionValue { .. }
            | Self::PriceScaleAboveLimit { .. }
            | Self::LimitExceeded { .. } => ErrorClass::UnsupportedCapability,
            Self::CalendarInvalid { .. }
            | Self::BarNotAtSessionStart { .. }
            | Self::BarOnNonSession { .. }
            | Self::ConflictingDuplicateBar { .. }
            | Self::InvalidBar { .. }
            | Self::InvalidManifest { .. } => ErrorClass::MalformedResponse,
        }
    }
}

impl ProfileBlock {
    /// A stable machine-readable name of the block, for records and tests.
    #[must_use]
    pub const fn code(&self) -> &'static str {
        match self {
            Self::InstrumentMismatch { .. } => "INSTRUMENT_MISMATCH",
            Self::CalendarInvalid { .. } => "CALENDAR_INVALID",
            Self::BarNotAtSessionStart { .. } => "BAR_NOT_AT_SESSION_START",
            Self::BarOnNonSession { .. } => "BAR_ON_NON_SESSION",
            Self::ConflictingDuplicateBar { .. } => "CONFLICTING_DUPLICATE_BAR",
            Self::InvalidBar { .. } => "INVALID_BAR",
            Self::ActionNotEvidenced { .. } => "ACTION_NOT_EVIDENCED",
            Self::ActionDeclaredNotBeforeExDate { .. } => "ACTION_DECLARED_NOT_BEFORE_EX_DATE",
            Self::ActionExDateNotSession { .. } => "ACTION_EX_DATE_NOT_SESSION",
            Self::PayableDateNotSession { .. } => "PAYABLE_DATE_NOT_SESSION",
            Self::PayableBeforeExDate { .. } => "PAYABLE_BEFORE_EX_DATE",
            Self::UnsupportedActionType { .. } => "UNSUPPORTED_ACTION_TYPE",
            Self::UnrepresentableSplitRatio { .. } => "UNREPRESENTABLE_SPLIT_RATIO",
            Self::InvalidActionValue { .. } => "INVALID_ACTION_VALUE",
            Self::PriceScaleAboveLimit { .. } => "PRICE_SCALE_ABOVE_LIMIT",
            Self::LimitExceeded { .. } => "LIMIT_EXCEEDED",
            Self::InvalidManifest { .. } => "INVALID_MANIFEST",
        }
    }

    /// What the block is about: the action id, the session, the stamp, the type or the field.
    #[must_use]
    pub fn subject(&self) -> String {
        match self {
            Self::InstrumentMismatch { field } => (*field).to_owned(),
            Self::CalendarInvalid { reason } | Self::InvalidManifest { reason } => reason.clone(),
            Self::BarNotAtSessionStart { stamp } => stamp.clone(),
            Self::BarOnNonSession { session }
            | Self::ConflictingDuplicateBar { session }
            | Self::InvalidBar { session, .. } => session.clone(),
            Self::ActionNotEvidenced { action_id, .. }
            | Self::ActionDeclaredNotBeforeExDate { action_id, .. }
            | Self::ActionExDateNotSession { action_id }
            | Self::PayableDateNotSession { action_id }
            | Self::PayableBeforeExDate { action_id }
            | Self::UnrepresentableSplitRatio { action_id }
            | Self::InvalidActionValue { action_id, .. } => action_id.clone(),
            Self::UnsupportedActionType { type_name } => type_name.clone(),
            Self::PriceScaleAboveLimit { scale } => scale.to_string(),
            Self::LimitExceeded { what, .. } => (*what).to_owned(),
        }
    }
}

impl std::fmt::Display for ProfileBlock {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InstrumentMismatch { field } => {
                write!(
                    f,
                    "profile blocked: the asset record disagrees with the instrument ({field})"
                )
            }
            Self::CalendarInvalid { reason } => {
                write!(f, "profile blocked: calendar invalid ({reason})")
            }
            Self::BarNotAtSessionStart { stamp } => {
                write!(
                    f,
                    "profile blocked: bar stamp {stamp} is not a session start"
                )
            }
            Self::BarOnNonSession { session } => {
                write!(
                    f,
                    "profile blocked: bar on {session}, which is not a calendar session"
                )
            }
            Self::ConflictingDuplicateBar { session } => {
                write!(f, "profile blocked: conflicting bars for {session}")
            }
            Self::InvalidBar { session, reason } => {
                write!(f, "profile blocked: bar {session} invalid ({reason})")
            }
            Self::ActionNotEvidenced { action_id, field } => write!(
                f,
                "profile blocked: action {action_id} has no readable {field}, so its availability is not evidenced"
            ),
            Self::ActionDeclaredNotBeforeExDate { action_id, field } => write!(
                f,
                "profile blocked: action {action_id} has {field} on or after its ex-date"
            ),
            Self::ActionExDateNotSession { action_id } => {
                write!(
                    f,
                    "profile blocked: action {action_id} has its ex-date on a non-session"
                )
            }
            Self::PayableDateNotSession { action_id } => {
                write!(
                    f,
                    "profile blocked: action {action_id} is payable on a non-session"
                )
            }
            Self::PayableBeforeExDate { action_id } => {
                write!(
                    f,
                    "profile blocked: action {action_id} is payable before its ex-date"
                )
            }
            Self::UnsupportedActionType { type_name } => {
                write!(
                    f,
                    "profile blocked: action type {type_name} has no availability rule"
                )
            }
            Self::UnrepresentableSplitRatio { action_id } => {
                write!(
                    f,
                    "profile blocked: split {action_id} is not a ratio of integers from 1 to 1000"
                )
            }
            Self::InvalidActionValue { action_id, reason } => {
                write!(f, "profile blocked: action {action_id} invalid ({reason})")
            }
            Self::PriceScaleAboveLimit { scale } => write!(
                f,
                "profile blocked: prices need {scale} fractional digits, above the limit of {MAX_PRICE_SCALE}"
            ),
            Self::LimitExceeded { what, limit } => {
                write!(f, "profile blocked: more than {limit} {what}")
            }
            Self::InvalidManifest { reason } => {
                write!(f, "normaliser defect: manifest invalid ({reason})")
            }
        }
    }
}

impl std::error::Error for ProfileBlock {}

/// Use and retention constraints from the recorded provider terms.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UseConstraints {
    pub redistribution_permitted: bool,
    pub retain_raw: bool,
    pub terms_ref: String,
}

/// The retrieval attempt behind a snapshot.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Provenance {
    pub job_id: String,
    pub attempt_id: String,
    /// Digest of the `retrieval-request/1` that asked for this snapshot.
    pub request_digest: String,
    pub retrieved_at: Timestamp,
}

/// Everything the normaliser reads.
pub struct NormaliserInput<'a> {
    pub semantics: &'a DataSemantics,
    pub instrument: &'a InstrumentMapping,
    pub profile: &'a RecordRef,
    pub executable: &'a ExecutableIdentity,
    /// The calendar range the request asked for.
    pub range: DateRange,
    pub asset: &'a AssetRecord,
    pub calendar: &'a [CalendarRow],
    pub bars: &'a [ProviderBar],
    pub actions: &'a [ProviderAction],
    /// The responses that the data came from, in call order.
    pub sources: &'a [SourceBody],
    /// The adapter version recorded in `source.adapter`.
    pub adapter_version: &'a str,
    pub provenance: &'a Provenance,
    pub constraints: &'a UseConstraints,
    /// The dataset licence text.
    pub licence: &'a str,
}

/// A frozen snapshot: the manifest and what the caller needs to use it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Snapshot {
    /// The `dataset-manifest/1` document.
    pub manifest: Value,
    /// Its canonical JSON text, the bytes that are stored and hashed.
    pub canonical_json: String,
    /// The identity digest of the manifest.
    pub digest: String,
    /// The smallest price scale that holds every price exactly.
    pub price_scale: u32,
    /// The larger of 2 and `price_scale`.
    pub money_scale: u32,
    /// True for a scale of 3 or 4: the S1 overflow test for AAPL-magnitude data must pass at the
    /// chosen scale before the profile may use it.
    pub overflow_evidence_required: bool,
}

/// One calendar session in UTC.
#[derive(Clone, Copy)]
struct Session {
    open_at: Timestamp,
    close_at: Timestamp,
}

/// One validated bar.
#[derive(Clone, PartialEq, Eq)]
struct Bar {
    /// Close of the bar's session: its event time, and the start of its data-ready delay.
    close_at: Timestamp,
    open: DecimalText,
    high: DecimalText,
    low: DecimalText,
    close: DecimalText,
    volume: DecimalText,
}

/// Apply the rules of `rules.txt` to provider data.
///
/// # Errors
/// [`ProfileBlock`] when the data cannot meet a rule of the profile.
pub fn normalise(input: &NormaliserInput<'_>) -> Result<Snapshot, ProfileBlock> {
    check_instrument(input)?;
    let sessions = convert_calendar(input.calendar)?;
    let (bars, price_scale) = convert_bars(input, &sessions)?;
    let (actions, evidence, last_payment) = convert_actions(input, &sessions)?;

    // The snapshot calendar: the requested range, extended to the latest payment session.
    let calendar_end = last_payment.map_or(input.range.end, |payment| payment.max(input.range.end));
    let calendar: Vec<Value> = sessions
        .iter()
        .filter(|(date, _)| **date >= input.range.start && **date <= calendar_end)
        .map(|(date, session)| {
            json!({
                "session": date.to_string(),
                "open_at": session.open_at.to_string(),
                "close_at": session.close_at.to_string(),
            })
        })
        .collect();
    if calendar.len() > MAX_CALENDAR {
        return Err(ProfileBlock::LimitExceeded {
            what: "calendar sessions",
            limit: MAX_CALENDAR,
        });
    }

    let delay = input.semantics.bar_availability.delay_minutes;
    let bar_values: Vec<Value> = bars
        .iter()
        .map(|(date, bar)| {
            let close_at = bar.close_at;
            json!({
                "session": date.to_string(),
                "open": bar.open.as_str(),
                "high": bar.high.as_str(),
                "low": bar.low.as_str(),
                "close": bar.close.as_str(),
                "volume": bar.volume.as_str(),
                "event_time": close_at.to_string(),
                "available_at": close_at.add_seconds(delay * 60).to_string(),
            })
        })
        .collect();

    let expected: Vec<Date> = sessions
        .keys()
        .copied()
        .filter(|date| *date >= input.range.start && *date <= input.range.end)
        .collect();
    let missing: Vec<String> = expected
        .iter()
        .filter(|date| !bars.contains_key(*date))
        .map(Date::to_string)
        .collect();
    let completeness = if bars.is_empty() {
        "NO_OBSERVATIONS"
    } else if missing.is_empty() {
        "COMPLETE"
    } else {
        "PARTIAL"
    };
    let mut coverage = json!({
        "requested": {
            "start": input.range.start.to_string(),
            "end": input.range.end.to_string(),
        },
        "completeness": completeness,
        "bar_count": bars.len(),
        "missing_sessions": missing,
    });
    if let (Some(first), Some(last), Some(object)) = (
        bars.keys().next(),
        bars.keys().next_back(),
        coverage.as_object_mut(),
    ) {
        object.insert(
            "returned".to_owned(),
            json!({ "start": first.to_string(), "end": last.to_string() }),
        );
    }

    let content = json!({
        "calendar": calendar,
        "bars": bar_values,
        "corporate_actions": actions,
        "unplanned_events": [],
        "action_evidence": evidence,
    });
    let content_digest = digest(&content).map_err(manifest_defect)?;
    let version_hex = content_digest
        .strip_prefix("sha256:")
        .unwrap_or(&content_digest);

    let source_responses = source_responses(input)?;
    let manifest = json!({
        "schema_version": "dataset-manifest/1",
        "dataset": {
            "id": dataset_id(input),
            "version": format!("c{}", version_hex.get(..16).unwrap_or(version_hex)),
            "source": "PROVIDER",
            "licence": input.licence,
        },
        "instrument": serde_json::to_value(input.instrument).map_err(defect)?,
        "source": {
            "provider": ID_PROVIDER,
            "feed": input.semantics.feed.to_string(),
            "adapter": { "name": ID_PROVIDER, "version": input.adapter_version },
            "transformation": {
                "name": TRANSFORMATION_NAME,
                "version": TRANSFORMATION_VERSION,
                "digest": rules_digest(),
            },
            "executable": serde_json::to_value(input.executable).map_err(defect)?,
            "profile": serde_json::to_value(input.profile).map_err(defect)?,
        },
        "semantics": serde_json::to_value(input.semantics).map_err(defect)?,
        "coverage": coverage,
        "retrieval": {
            "job_id": input.provenance.job_id,
            "attempt_id": input.provenance.attempt_id,
            "request_digest": input.provenance.request_digest,
            "retrieved_at": input.provenance.retrieved_at.to_string(),
        },
        "content": content,
        "source_responses": source_responses,
        "constraints": {
            "redistribution": if input.constraints.redistribution_permitted { "PERMITTED" } else { "NOT_PERMITTED" },
            "raw_retention": if input.constraints.retain_raw { "RETAIN" } else { "DO_NOT_RETAIN" },
            "terms_ref": input.constraints.terms_ref,
        },
    });
    validate(Envelope::DatasetManifest, &manifest).map_err(manifest_defect)?;
    let canonical = canonical_json(&manifest).map_err(manifest_defect)?;
    let manifest_digest = digest(&manifest).map_err(manifest_defect)?;
    Ok(Snapshot {
        manifest,
        canonical_json: canonical,
        digest: manifest_digest,
        price_scale,
        money_scale: price_scale.max(2),
        overflow_evidence_required: price_scale >= 3,
    })
}

fn defect(error: serde_json::Error) -> ProfileBlock {
    ProfileBlock::InvalidManifest {
        reason: error.to_string(),
    }
}

fn manifest_defect(error: openquant_contracts::ContractError) -> ProfileBlock {
    ProfileBlock::InvalidManifest {
        reason: error.to_string(),
    }
}

fn check_instrument(input: &NormaliserInput<'_>) -> Result<(), ProfileBlock> {
    let mismatch = |field| Err(ProfileBlock::InstrumentMismatch { field });
    if input.asset.id != *input.instrument.provider_asset_id {
        return mismatch("id");
    }
    if input.asset.symbol != *input.instrument.symbol {
        return mismatch("symbol");
    }
    if input.asset.class != EQUITY_CLASS {
        return mismatch("class");
    }
    if *input.instrument.provider != ID_PROVIDER {
        return mismatch("provider");
    }
    if *input.instrument.instrument_id != format!("{ID_PROVIDER}:{}", input.asset.id) {
        return mismatch("instrument_id");
    }
    Ok(())
}

/// Provider calendar rows to UTC sessions by date.
fn convert_calendar(rows: &[CalendarRow]) -> Result<BTreeMap<Date, Session>, ProfileBlock> {
    let mut sessions = BTreeMap::new();
    for row in rows {
        let convert = |time: LocalTime| {
            eastern_to_utc(row.date, time).map_err(|e| ProfileBlock::CalendarInvalid {
                reason: format!("{}: {e}", row.date),
            })
        };
        let session = Session {
            open_at: convert(row.open)?,
            close_at: convert(row.close)?,
        };
        if session.open_at >= session.close_at || sessions.insert(row.date, session).is_some() {
            return Err(ProfileBlock::CalendarInvalid {
                reason: format!("{}: empty or repeated session", row.date),
            });
        }
    }
    Ok(sessions)
}

fn bar_error(session: Date, reason: &'static str) -> ProfileBlock {
    ProfileBlock::InvalidBar {
        session: session.to_string(),
        reason,
    }
}

/// Validate every bar, merge identical duplicates and find the price scale.
fn convert_bars(
    input: &NormaliserInput<'_>,
    sessions: &BTreeMap<Date, Session>,
) -> Result<(BTreeMap<Date, Bar>, u32), ProfileBlock> {
    let max_price = Decimal::from(MAX_PRICE);
    let max_volume = Decimal::from(MAX_VOLUME);
    let mut bars: BTreeMap<Date, Bar> = BTreeMap::new();
    for raw in input.bars {
        let session =
            session_from_midnight(raw.start).map_err(|_| ProfileBlock::BarNotAtSessionStart {
                stamp: raw.start.to_string(),
            })?;
        let Some(times) = sessions.get(&session) else {
            return Err(ProfileBlock::BarOnNonSession {
                session: session.to_string(),
            });
        };
        let price = |text: &DecimalText| -> Result<Decimal, ProfileBlock> {
            let value = text
                .to_decimal()
                .ok_or_else(|| bar_error(session, "price out of range"))?;
            if value <= Decimal::ZERO || value > max_price {
                return Err(bar_error(
                    session,
                    "price must be positive and at most 1000000000",
                ));
            }
            Ok(value)
        };
        let (open, high, low, close) = (
            price(&raw.open)?,
            price(&raw.high)?,
            price(&raw.low)?,
            price(&raw.close)?,
        );
        if high < low || high < open || high < close || low > open || low > close {
            return Err(bar_error(session, "violates low <= open, close <= high"));
        }
        if !raw.volume.is_integer() || raw.volume.is_negative() {
            return Err(bar_error(session, "volume must be a non-negative integer"));
        }
        let volume = raw
            .volume
            .to_decimal()
            .ok_or_else(|| bar_error(session, "volume out of range"))?;
        if volume > max_volume {
            return Err(bar_error(session, "volume above 1000000000000000"));
        }
        let bar = Bar {
            close_at: times.close_at,
            open: raw.open.clone(),
            high: raw.high.clone(),
            low: raw.low.clone(),
            close: raw.close.clone(),
            volume: raw.volume.clone(),
        };
        match bars.get(&session) {
            Some(existing) if *existing == bar => {}
            Some(_) => {
                return Err(ProfileBlock::ConflictingDuplicateBar {
                    session: session.to_string(),
                });
            }
            None => {
                bars.insert(session, bar);
            }
        }
    }
    if bars.len() > MAX_CALENDAR {
        return Err(ProfileBlock::LimitExceeded {
            what: "bars",
            limit: MAX_CALENDAR,
        });
    }
    let scale = bars
        .values()
        .flat_map(|bar| [&bar.open, &bar.high, &bar.low, &bar.close])
        .map(DecimalText::scale)
        .max()
        .unwrap_or(0);
    if scale > MAX_PRICE_SCALE {
        return Err(ProfileBlock::PriceScaleAboveLimit { scale });
    }
    Ok((bars, scale))
}

/// The kind rank that orders actions of one day: splits before dividends before anything else.
fn kind_rank(kind: &ProviderActionKind) -> u8 {
    match kind {
        ProviderActionKind::Split { .. } => 0,
        ProviderActionKind::CashDividend { .. } => 1,
        ProviderActionKind::Other { .. } => 2,
    }
}

fn gcd(a: u128, b: u128) -> u128 {
    if b == 0 { a } else { gcd(b, a % b) }
}

/// `new_rate` and `old_rate` as the lowest integer ratio, each from 1 to 1000.
fn split_ratio(new_rate: &DecimalText, old_rate: &DecimalText) -> Option<(u32, u32)> {
    let new = new_rate.to_decimal()?;
    let old = old_rate.to_decimal()?;
    if new <= Decimal::ZERO || old <= Decimal::ZERO {
        return None;
    }
    let scale = new.scale().max(old.scale());
    let lift = |value: Decimal| -> Option<u128> {
        let mantissa = u128::try_from(value.mantissa()).ok()?;
        mantissa.checked_mul(10_u128.checked_pow(scale - value.scale())?)
    };
    let (new, old) = (lift(new)?, lift(old)?);
    let divisor = gcd(new, old);
    let (new, old) = (
        u32::try_from(new / divisor).ok()?,
        u32::try_from(old / divisor).ok()?,
    );
    ((1..=1000).contains(&new) && (1..=1000).contains(&old)).then_some((new, old))
}

type ActionOutput = (Vec<Value>, Vec<Value>, Option<Date>);

/// Keep, order and convert the actions whose ex-date lies in the requested range.
fn convert_actions(
    input: &NormaliserInput<'_>,
    sessions: &BTreeMap<Date, Session>,
) -> Result<ActionOutput, ProfileBlock> {
    let mut kept: Vec<&ProviderAction> = input
        .actions
        .iter()
        .filter(|action| action.ex_date >= input.range.start && action.ex_date <= input.range.end)
        .collect();
    kept.sort_by(|a, b| {
        (a.ex_date, kind_rank(&a.kind), &a.record_id, &a.fields).cmp(&(
            b.ex_date,
            kind_rank(&b.kind),
            &b.record_id,
            &b.fields,
        ))
    });
    if kept.len() > MAX_ACTIONS {
        return Err(ProfileBlock::LimitExceeded {
            what: "corporate actions",
            limit: MAX_ACTIONS,
        });
    }
    let symbol = input.instrument.symbol.to_lowercase();
    let mut actions = Vec::new();
    let mut evidence = Vec::new();
    let mut last_payment: Option<Date> = None;
    let mut counts: BTreeMap<(Date, &'static str), u32> = BTreeMap::new();
    for action in kept {
        let (prefix, rule) = match &action.kind {
            ProviderActionKind::Split { .. } => ("split", &input.semantics.split_availability),
            ProviderActionKind::CashDividend { .. } => {
                ("div", &input.semantics.dividend_availability)
            }
            ProviderActionKind::Other { type_name } => {
                return Err(ProfileBlock::UnsupportedActionType {
                    type_name: type_name.clone(),
                });
            }
        };
        let ordinal = counts.entry((action.ex_date, prefix)).or_insert(0);
        *ordinal += 1;
        let suffix = if *ordinal > 1 {
            format!("-{ordinal}")
        } else {
            String::new()
        };
        let action_id = format!("{prefix}-{symbol}-{}{suffix}", action.ex_date);

        let Some(session) = sessions.get(&action.ex_date) else {
            return Err(ProfileBlock::ActionExDateNotSession { action_id });
        };
        let field: &str = &rule.provider_field;
        let declared = action.fields.get(field).map(String::as_str);
        let Some(declared_date) = declared.and_then(|text| Date::parse(text).ok()) else {
            return Err(ProfileBlock::ActionNotEvidenced {
                action_id,
                field: field.to_owned(),
            });
        };
        if declared_date >= action.ex_date {
            return Err(ProfileBlock::ActionDeclaredNotBeforeExDate {
                action_id,
                field: field.to_owned(),
            });
        }
        let available_at = session.open_at.to_string();
        let ex_date = action.ex_date.to_string();
        let value = match &action.kind {
            ProviderActionKind::Split {
                new_rate, old_rate, ..
            } => {
                let (ratio_new, ratio_old) = split_ratio(new_rate, old_rate).ok_or_else(|| {
                    ProfileBlock::UnrepresentableSplitRatio {
                        action_id: action_id.clone(),
                    }
                })?;
                json!({
                    "kind": "SPLIT",
                    "action_id": action_id,
                    "effective_session": ex_date,
                    "available_at": available_at,
                    "ratio_new": ratio_new,
                    "ratio_old": ratio_old,
                })
            }
            ProviderActionKind::CashDividend {
                special,
                foreign,
                rate,
            } => {
                if *special || *foreign {
                    json!({
                        "kind": "SPECIAL_DISTRIBUTION",
                        "action_id": action_id,
                        "effective_session": ex_date,
                        "available_at": available_at,
                    })
                } else {
                    let invalid = |reason| ProfileBlock::InvalidActionValue {
                        action_id: action_id.clone(),
                        reason,
                    };
                    if rate.is_negative() || rate.is_zero() {
                        return Err(invalid("amount must be positive"));
                    }
                    if rate.scale() > MAX_AMOUNT_SCALE {
                        return Err(invalid("amount has more than 8 fractional digits"));
                    }
                    let payment = payment_session(input, action, &action_id, sessions)?;
                    last_payment = Some(last_payment.map_or(payment, |latest| latest.max(payment)));
                    json!({
                        "kind": "CASH_DIVIDEND",
                        "action_id": action_id,
                        "effective_session": ex_date,
                        "available_at": available_at,
                        "amount_per_share": rate.as_str(),
                        "payment_session": payment.to_string(),
                        "payment_phase": "AFTER_CLOSE",
                    })
                }
            }
            ProviderActionKind::Other { .. } => continue,
        };
        let record_id = action
            .record_id
            .clone()
            .filter(|id| is_identifier(id))
            .unwrap_or_else(|| format!("{ID_PROVIDER}:{action_id}"));
        evidence.push(json!({
            "action_id": action_id,
            "provider_record_id": record_id,
            "provider_field": field,
            "provider_value": declared.unwrap_or_default(),
        }));
        actions.push(value);
    }
    Ok((actions, evidence, last_payment))
}

/// The payment session of a regular cash dividend under the profile's payment rule.
fn payment_session(
    input: &NormaliserInput<'_>,
    action: &ProviderAction,
    action_id: &str,
    sessions: &BTreeMap<Date, Session>,
) -> Result<Date, ProfileBlock> {
    let field: &str = &input.semantics.dividend_payment.provider_field;
    let not_session = || ProfileBlock::PayableDateNotSession {
        action_id: action_id.to_owned(),
    };
    let payable = action
        .fields
        .get(field)
        .and_then(|text| Date::parse(text).ok())
        .ok_or_else(not_session)?;
    if !sessions.contains_key(&payable) {
        return Err(not_session());
    }
    if payable < action.ex_date {
        return Err(ProfileBlock::PayableBeforeExDate {
            action_id: action_id.to_owned(),
        });
    }
    Ok(payable)
}

/// `^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$`
fn is_identifier(text: &str) -> bool {
    let mut chars = text.chars();
    text.len() <= 64
        && chars.next().is_some_and(|c| c.is_ascii_alphanumeric())
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | ':' | '-'))
}

fn dataset_id(input: &NormaliserInput<'_>) -> String {
    let compact = |date: Date| date.to_string().replace('-', "");
    format!(
        "{ID_PROVIDER}-{}-1day-raw-{}-{}-{}",
        input.instrument.symbol.to_lowercase(),
        input.semantics.feed.to_string().to_lowercase(),
        compact(input.range.start),
        compact(input.range.end),
    )
}

fn source_responses(input: &NormaliserInput<'_>) -> Result<Vec<Value>, ProfileBlock> {
    if input.sources.len() > MAX_SOURCE_RESPONSES {
        return Err(ProfileBlock::LimitExceeded {
            what: "source responses",
            limit: MAX_SOURCE_RESPONSES,
        });
    }
    Ok(input
        .sources
        .iter()
        .map(|source| {
            let content_digest = digest_bytes(&source.bytes);
            let mut value = json!({
                "sequence": source.sequence,
                "operation": Operation::capability_ref(source.operation, ID_PROVIDER),
                "received_at": source.received_at.to_string(),
                "content_digest": content_digest,
            });
            if input.constraints.retain_raw
                && let Some(object) = value.as_object_mut()
            {
                object.insert(
                    "stored".to_owned(),
                    json!({
                        "digest": content_digest,
                        "media_type": "application/json",
                        "size_bytes": source.bytes.len(),
                    }),
                );
            }
            value
        })
        .collect())
}

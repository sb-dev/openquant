//! A prepared run: validated strategy plus converted input, stepping one event at a time.
//!
//! `step(strategy, prior_state, market_event) -> next_state, target_positions, diagnostics`
//! (OQ-02 section 2.3). Historical replay is a loop over the events of the calendar.

use std::collections::BTreeMap;

use openquant_contracts::{
    EvaluationInput, StrategyArtefact,
    decimal::parse as parse_decimal_str,
    generated::{self as g, CorporateAction},
    payload_digest,
};

use crate::{
    data::{Action, ActionKind, Bar, Halt, Policy, RunInput, SessionInfo},
    execution,
    format::{Fmt, core_cursor},
    identity::{engine_digest, engine_identity},
    interfaces::{MarketEvent, Observation, StepOutput, TargetPosition},
    model::{Cursor, Failure, FailureCode, PHASES, Phase, Result},
    numeric::{Decimal, MAX_CAPITAL, MAX_PRICE, MAX_VOLUME},
    operators::OPERATOR_SET,
    state::{State, empty_journal},
    strategy::{ValidatedStrategy, validate_strategy},
};

/// A strategy bound to one input, ready to step.
#[derive(Clone, Debug)]
pub struct Run {
    pub strategy: ValidatedStrategy,
    pub input: RunInput,
    pub strategy_hash: String,
    pub input_hash: String,
    pub engine: g::EngineIdentity,
    pub engine_digest: String,
    pub fmt: Fmt,
}

fn invalid(detail: String) -> Failure {
    Failure::new(FailureCode::InvalidInput, detail)
}

fn policy_failure(detail: &str) -> Failure {
    Failure::new(FailureCode::UnsupportedPolicy, detail.to_owned())
}

/// Largest scales the shared schema allows. A policy built without the schema is held to them
/// as well, so the grid arithmetic below stays within the range it was reviewed for.
const MAX_PRICE_SCALE: u32 = 8;
const MAX_QUANTITY_SCALE: u32 = 8;
const MAX_MONEY_SCALE: u32 = 12;
const MAX_DIAGNOSTIC_SCALE: u32 = 12;

/// Longest instrument id that keeps `T-<date>-<id>` and `I-<date>-<id>` within the 64
/// characters of an identifier: the prefix and date take 13.
const MAX_INSTRUMENT_ID_LEN: usize = 51;

fn digits(text: &str, start: usize, end: usize) -> Option<u32> {
    text.get(start..end)?.parse().ok()
}

/// Whether `text` (`YYYY-MM-DD`) names a real calendar date.
fn valid_date(text: &str) -> bool {
    let (Some(year), Some(month), Some(day)) =
        (digits(text, 0, 4), digits(text, 5, 7), digits(text, 8, 10))
    else {
        return false;
    };
    let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
    let days = match month {
        2 if leap => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        _ => return false,
    };
    (1..=days).contains(&day)
}

/// Whether `text` (`YYYY-MM-DDTHH:MM:SSZ`) names a real UTC instant.
fn valid_timestamp(text: &str) -> bool {
    let (Some(hour), Some(minute), Some(second)) = (
        digits(text, 11, 13),
        digits(text, 14, 16),
        digits(text, 17, 19),
    ) else {
        return false;
    };
    text.get(..10).is_some_and(valid_date) && hour < 24 && minute < 60 && second < 60
}

fn check_timestamp(text: &str, what: &str) -> Result<()> {
    if valid_timestamp(text) {
        Ok(())
    } else {
        Err(invalid(format!("{what} {text} is not a real UTC instant")))
    }
}

fn check_date(text: &str, what: &str) -> Result<()> {
    if valid_date(text) {
        Ok(())
    } else {
        Err(invalid(format!(
            "{what} {text} is not a real calendar date"
        )))
    }
}

fn parse(value: &g::Decimal, scale: u32, what: &str) -> Result<Decimal> {
    parse_decimal_str(value.as_str(), scale)
        .map_err(|e| Failure::new(FailureCode::InvalidDecimal, format!("{what}: {e}")))
}

fn scale_of(value: i64, what: &str) -> Result<u32> {
    u32::try_from(value).map_err(|_| policy_failure(&format!("{what} out of range")))
}

fn convert_policy(policy: &g::ExecutionPolicy) -> Result<Policy> {
    let price_scale = scale_of(policy.price_scale, "price_scale")?;
    let quantity_scale = scale_of(policy.quantity_scale, "quantity_scale")?;
    let money_scale = scale_of(policy.money_scale, "money_scale")?;
    let diagnostic_scale = scale_of(policy.diagnostic_scale, "diagnostic_scale")?;
    for (value, limit, what) in [
        (price_scale, MAX_PRICE_SCALE, "price_scale"),
        (quantity_scale, MAX_QUANTITY_SCALE, "quantity_scale"),
        (money_scale, MAX_MONEY_SCALE, "money_scale"),
        (diagnostic_scale, MAX_DIAGNOSTIC_SCALE, "diagnostic_scale"),
    ] {
        if value > limit {
            return Err(policy_failure(&format!("{what} {value} exceeds {limit}")));
        }
    }
    if price_scale.saturating_add(quantity_scale) > money_scale {
        return Err(policy_failure(
            "money_scale must be at least price_scale + quantity_scale so notional is exact",
        ));
    }
    let lot_size = parse(&policy.lot_size, quantity_scale, "lot_size")?;
    if lot_size <= Decimal::ZERO {
        return Err(policy_failure("lot_size must be positive"));
    }
    let ten_thousand = Decimal::from(10_000);
    let nonnegative = |value: Decimal, what: &str| -> Result<Decimal> {
        if value < Decimal::ZERO {
            Err(policy_failure(&format!("{what} must not be negative")))
        } else {
            Ok(value)
        }
    };
    let fixed_fee = nonnegative(
        parse(
            &policy.cost_model.fixed_fee_per_fill,
            money_scale,
            "fixed_fee_per_fill",
        )?,
        "fixed_fee_per_fill",
    )?;
    let fee_bps = nonnegative(parse(&policy.cost_model.fee_bps, 4, "fee_bps")?, "fee_bps")?;
    let slip = nonnegative(
        parse(
            &policy.cost_model.gap_exit_slippage_bps,
            4,
            "gap_exit_slippage_bps",
        )?,
        "gap_exit_slippage_bps",
    )?;
    let withholding = nonnegative(
        parse(
            &policy.corporate_actions.withholding_bps,
            4,
            "withholding_bps",
        )?,
        "withholding_bps",
    )?;
    if fee_bps >= ten_thousand || slip >= ten_thousand || withholding > ten_thousand {
        return Err(policy_failure("basis points must be below 10000"));
    }
    Ok(Policy {
        price_scale,
        quantity_scale,
        money_scale,
        diagnostic_scale,
        lot_size,
        fixed_fee,
        fee_bps,
        gap_exit_slippage_bps: slip,
        withholding_bps: withholding,
    })
}

fn convert_bars(
    instrument: &g::InstrumentInput,
    sessions: &[SessionInfo],
    policy: &Policy,
) -> Result<BTreeMap<String, Bar>> {
    let mut bars = BTreeMap::new();
    let max_price = Decimal::from(MAX_PRICE);
    for raw in &instrument.bars {
        let date = raw.session.to_string();
        if !sessions.iter().any(|s| s.date == date) {
            return Err(invalid(format!("bar {date} is not on the calendar")));
        }
        let price = |value: &g::Decimal, what: &str| -> Result<Decimal> {
            let parsed = parse(value, policy.price_scale, &format!("{date} {what}"))?;
            if parsed <= Decimal::ZERO || parsed > max_price {
                return Err(invalid(format!(
                    "{date} {what} must be positive and bounded"
                )));
            }
            Ok(parsed)
        };
        let open = price(&raw.open, "open")?;
        let high = price(&raw.high, "high")?;
        let low = price(&raw.low, "low")?;
        let close = price(&raw.close, "close")?;
        let volume = parse(
            &raw.volume,
            policy.quantity_scale,
            &format!("{date} volume"),
        )?;
        if volume < Decimal::ZERO || volume > Decimal::from(MAX_VOLUME) {
            return Err(invalid(format!(
                "{date} volume must be non-negative and bounded"
            )));
        }
        if high < low || high < open || high < close || low > open || low > close {
            return Err(invalid(format!(
                "{date} bar violates low <= open,close <= high"
            )));
        }
        let event_time = raw.event_time.to_string();
        let available_at = raw.available_at.to_string();
        check_timestamp(&event_time, &format!("{date} event_time"))?;
        check_timestamp(&available_at, &format!("{date} available_at"))?;
        if available_at < event_time {
            return Err(invalid(format!(
                "{date} bar is available at {available_at} before its event time {event_time}"
            )));
        }
        let bar = Bar {
            open,
            high,
            low,
            close,
            volume,
            available_at,
        };
        if bars.insert(date.clone(), bar).is_some() {
            return Err(invalid(format!("duplicate bar for {date}")));
        }
    }
    Ok(bars)
}

fn convert_actions(
    instrument: &g::InstrumentInput,
    sessions: &[SessionInfo],
) -> Result<Vec<Action>> {
    let mut actions: Vec<Action> = Vec::new();
    for raw in &instrument.corporate_actions {
        let (id, effective, available, kind) = match raw {
            CorporateAction::SplitAction(a) => (
                a.action_id.to_string(),
                a.effective_session.to_string(),
                a.available_at.to_string(),
                ActionKind::Split {
                    new: a.ratio_new.get(),
                    old: a.ratio_old.get(),
                },
            ),
            CorporateAction::CashDividendAction(a) => (
                a.action_id.to_string(),
                a.effective_session.to_string(),
                a.available_at.to_string(),
                ActionKind::CashDividend {
                    amount_per_share: parse(&a.amount_per_share, 8, "amount_per_share")?,
                    payment_session: a.payment_session.to_string(),
                    payment_phase: a.payment_phase,
                },
            ),
            CorporateAction::UnsupportedAction(a) => (
                a.action_id.to_string(),
                a.effective_session.to_string(),
                a.available_at.to_string(),
                ActionKind::Unsupported {
                    kind: a.kind.to_string(),
                },
            ),
        };
        if !sessions.iter().any(|s| s.date == effective) {
            return Err(invalid(format!(
                "action {id} is effective on a non-session date"
            )));
        }
        check_timestamp(&available, &format!("action {id} available_at"))?;
        if actions.iter().any(|a| a.id == id) {
            return Err(invalid(format!("duplicate action id {id}")));
        }
        if let ActionKind::CashDividend {
            amount_per_share,
            payment_session,
            ..
        } = &kind
        {
            if *amount_per_share < Decimal::ZERO {
                return Err(invalid(format!("action {id} has a negative amount")));
            }
            if !sessions.iter().any(|s| s.date == *payment_session) {
                return Err(invalid(format!(
                    "action {id} pays on {payment_session}, which is not a calendar session"
                )));
            }
            if *payment_session < effective {
                return Err(invalid(format!(
                    "action {id} pays on {payment_session}, before its ex-date {effective}"
                )));
            }
        }
        actions.push(Action {
            id,
            effective_session: effective,
            available_at: available,
            kind,
        });
    }
    Ok(actions)
}

fn convert_halts(instrument: &g::InstrumentInput, sessions: &[SessionInfo]) -> Result<Vec<Halt>> {
    let mut halts: Vec<Halt> = Vec::new();
    for raw in &instrument.unplanned_events {
        let halt = Halt {
            id: raw.event_id.to_string(),
            effective_session: raw.effective_session.to_string(),
            available_at: raw.available_at.to_string(),
        };
        if !sessions.iter().any(|s| s.date == halt.effective_session) {
            return Err(invalid(format!(
                "event {} is effective on a non-session date",
                halt.id
            )));
        }
        check_timestamp(
            &halt.available_at,
            &format!("event {} available_at", halt.id),
        )?;
        if halts.iter().any(|h| h.id == halt.id) {
            return Err(invalid(format!("duplicate event id {}", halt.id)));
        }
        halts.push(halt);
    }
    Ok(halts)
}

fn convert_sessions(calendar: &g::CalendarSpec) -> Result<Vec<SessionInfo>> {
    let mut sessions: Vec<SessionInfo> = Vec::new();
    for raw in &calendar.sessions {
        let session = SessionInfo {
            date: raw.session.to_string(),
            open_at: raw.open_at.to_string(),
            close_at: raw.close_at.to_string(),
        };
        check_date(&session.date, "session")?;
        check_timestamp(
            &session.open_at,
            &format!("session {} open_at", session.date),
        )?;
        check_timestamp(
            &session.close_at,
            &format!("session {} close_at", session.date),
        )?;
        if session.open_at >= session.close_at {
            return Err(invalid(format!(
                "session {} opens at or after it closes",
                session.date
            )));
        }
        if let Some(previous) = sessions.last()
            && (session.date <= previous.date || session.open_at <= previous.close_at)
        {
            return Err(invalid(format!(
                "calendar must be strictly ascending without overlap at {}",
                session.date
            )));
        }
        sessions.push(session);
    }
    Ok(sessions)
}

fn session_index(sessions: &[SessionInfo], date: &g::SessionDate, what: &str) -> Result<usize> {
    sessions
        .iter()
        .position(|s| s.date == date.as_str())
        .ok_or_else(|| {
            invalid(format!(
                "{what} {} is not a calendar session",
                date.as_str()
            ))
        })
}

impl Run {
    /// Bind a strategy to an input.
    ///
    /// # Errors
    /// A typed [`Failure`] for an invalid strategy, mismatched identity, unsupported policy or
    /// invalid input.
    pub fn prepare(artefact: &StrategyArtefact, input: &EvaluationInput) -> Result<Self> {
        let strategy = validate_strategy(artefact)?;
        let input_hash = payload_digest(input)?;
        if input.strategy_hash.as_str() != strategy.hash {
            return Err(Failure::new(
                FailureCode::IdentityMismatch,
                format!(
                    "input binds strategy {} but the supplied strategy is {}",
                    input.strategy_hash.as_str(),
                    strategy.hash
                ),
            ));
        }
        if input.operator_set.to_string() != OPERATOR_SET {
            return Err(Failure::new(
                FailureCode::UnsupportedOperator,
                "the input names an unsupported operator set".to_owned(),
            ));
        }
        let policy = convert_policy(&input.policy)?;
        let initial_capital = parse(
            &input.initial_capital,
            policy.money_scale,
            "initial_capital",
        )?;
        if initial_capital <= Decimal::ZERO || initial_capital > Decimal::from(MAX_CAPITAL) {
            return Err(invalid(
                "initial_capital must be positive and bounded".to_owned(),
            ));
        }
        let sessions = convert_sessions(&input.calendar)?;
        let [instrument] = &input.instruments;
        let bars = convert_bars(instrument, &sessions, &policy)?;
        let actions = convert_actions(instrument, &sessions)?;
        if instrument.instrument_id.as_str().len() > MAX_INSTRUMENT_ID_LEN {
            return Err(invalid(format!(
                "instrument_id is longer than {MAX_INSTRUMENT_ID_LEN} characters, so trade and intent ids would not fit an identifier"
            )));
        }
        let halts = convert_halts(instrument, &sessions)?;
        let information_cutoff = input.windows.information_cutoff.to_string();
        check_timestamp(&information_cutoff, "windows.information_cutoff")?;
        for halt in &halts {
            let confirmed = sessions
                .iter()
                .find(|s| s.date == halt.effective_session)
                .is_some_and(|s| {
                    halt.available_at <= s.open_at && halt.available_at <= information_cutoff
                });
            if confirmed && bars.contains_key(&halt.effective_session) {
                return Err(invalid(format!(
                    "a bar is supplied for {}, a session with confirmed halt {}",
                    halt.effective_session, halt.id
                )));
            }
        }
        let first = session_index(&sessions, &input.windows.warmup_start, "warmup_start")?;
        let scored_start = session_index(&sessions, &input.windows.scored_start, "scored_start")?;
        let last = session_index(&sessions, &input.windows.scored_end, "scored_end")?;
        if !(first <= scored_start && scored_start <= last) {
            return Err(invalid(
                "windows must satisfy warmup_start <= scored_start <= scored_end".to_owned(),
            ));
        }
        let engine = engine_identity()?;
        let engine_digest = engine_digest(&engine)?;
        let fmt = Fmt {
            price: policy.price_scale,
            qty: policy.quantity_scale,
            money: policy.money_scale,
            diag: policy.diagnostic_scale,
        };
        Ok(Self {
            strategy_hash: strategy.hash.clone(),
            strategy,
            input: RunInput {
                instrument_id: instrument.instrument_id.to_string(),
                sessions,
                bars,
                actions,
                halts,
                first,
                scored_start,
                last,
                information_cutoff,
                initial_capital,
                policy,
            },
            input_hash,
            engine,
            engine_digest,
            fmt,
        })
    }

    /// State before the first event.
    pub fn initial_state(&self) -> Result<State> {
        let first = self.session(self.input.first)?;
        Ok(State {
            next: Some(Cursor {
                session: first.date.clone(),
                phase: Phase::BeforeOpen,
            }),
            cash_available: self.input.initial_capital,
            cash_reserved: Decimal::ZERO,
            receivables: Vec::new(),
            positions: Vec::new(),
            pending: Vec::new(),
            applied: std::collections::BTreeSet::new(),
            journal: empty_journal(),
        })
    }

    /// Session by calendar index.
    pub fn session(&self, index: usize) -> Result<&SessionInfo> {
        self.input
            .sessions
            .get(index)
            .ok_or_else(|| Failure::internal("session index out of range"))
    }

    /// Calendar index of a session date.
    pub fn index_of(&self, date: &str) -> Result<usize> {
        self.input
            .sessions
            .iter()
            .position(|s| s.date == date)
            .ok_or_else(|| Failure::internal("unknown session date"))
    }

    /// Whether dated evidence confirms the session as a halt that was known at its open.
    #[must_use]
    pub fn confirmed_halt(&self, date: &str) -> bool {
        let open_at = self
            .input
            .sessions
            .iter()
            .find(|s| s.date == date)
            .map_or("", |s| s.open_at.as_str());
        let open_at = self.deadline(Some(open_at));
        self.input
            .halts
            .iter()
            .any(|h| h.effective_session == date && h.available_at.as_str() <= open_at)
    }

    /// The latest instant at which evidence may become available for a decision bound.
    ///
    /// This is the earlier of `bound` (for example the next session open) and the information
    /// cutoff. With no bound, such as at the final session, the cutoff alone applies, so no
    /// availability check is skipped.
    #[must_use]
    pub fn deadline<'a>(&'a self, bound: Option<&'a str>) -> &'a str {
        let cutoff = self.input.information_cutoff.as_str();
        match bound {
            Some(bound) if bound < cutoff => bound,
            _ => cutoff,
        }
    }

    /// Every event of the run in processing order.
    pub fn events(&self) -> Result<Vec<MarketEvent>> {
        let mut events = Vec::new();
        for index in self.input.first..=self.input.last {
            let session = self.session(index)?;
            let bar = self.input.bars.get(&session.date);
            for phase in PHASES {
                let observation = bar.and_then(|bar| match phase {
                    Phase::BeforeOpen => None,
                    Phase::Open => Some(Observation {
                        open: Some(bar.open),
                        ..Observation::default()
                    }),
                    Phase::DuringSession => Some(Observation {
                        open: Some(bar.open),
                        high: Some(bar.high),
                        low: Some(bar.low),
                        ..Observation::default()
                    }),
                    Phase::AfterClose => Some(Observation {
                        open: Some(bar.open),
                        high: Some(bar.high),
                        low: Some(bar.low),
                        close: Some(bar.close),
                        volume: Some(bar.volume),
                    }),
                });
                events.push(MarketEvent {
                    cursor: Cursor {
                        session: session.date.clone(),
                        phase,
                    },
                    session_index: index,
                    observation,
                });
            }
        }
        Ok(events)
    }

    fn following(&self, event: &MarketEvent) -> Result<Option<Cursor>> {
        let current = PHASES
            .iter()
            .position(|p| *p == event.phase())
            .ok_or_else(|| Failure::internal("phase"))?;
        if let Some(phase) = PHASES.get(current + 1) {
            return Ok(Some(Cursor {
                session: event.cursor.session.clone(),
                phase: *phase,
            }));
        }
        if event.session_index >= self.input.last {
            return Ok(None);
        }
        let next = self.session(event.session_index + 1)?;
        Ok(Some(Cursor {
            session: next.date.clone(),
            phase: Phase::BeforeOpen,
        }))
    }

    /// Process one event. The prior state is not changed; a failure discards the event.
    ///
    /// # Errors
    /// `EVENT_OUT_OF_ORDER` unless the event is the state's next event, or any phase failure.
    pub fn step(&self, prior: &State, event: &MarketEvent) -> Result<StepOutput> {
        if prior.next.as_ref() != Some(&event.cursor) {
            return Err(Failure::new(
                FailureCode::EventOutOfOrder,
                format!(
                    "expected {}, received {}",
                    prior
                        .next
                        .as_ref()
                        .map_or_else(|| "no further event".to_owned(), ToString::to_string),
                    event.cursor
                ),
            ));
        }
        let mut state = prior.clone();
        let mut notes = Vec::new();
        let outcome = match event.phase() {
            Phase::BeforeOpen => execution::before_open::run(self, &mut state, event, &mut notes),
            Phase::Open => execution::open::run(self, &mut state, event, &mut notes),
            Phase::DuringSession => execution::session::run(self, &mut state, event, &mut notes),
            Phase::AfterClose => execution::after_close::run(self, &mut state, event, &mut notes),
        };
        outcome.map_err(|failure| failure.at(event.cursor.clone()))?;
        state.next = self.following(event)?;
        let target_positions = state
            .positions
            .iter()
            .map(|p| TargetPosition {
                instrument_id: p.instrument_id.clone(),
                quantity: p.quantity,
            })
            .collect();
        Ok(StepOutput {
            state,
            target_positions,
            diagnostics: notes,
        })
    }

    /// Process `events` in order, stopping at the first failure. The returned state is the state
    /// after the last completed event.
    pub fn run_events(&self, mut state: State, events: &[MarketEvent]) -> (State, Option<Failure>) {
        for event in events {
            match self.step(&state, event) {
                Ok(output) => state = output.state,
                Err(failure) => return (state, Some(failure)),
            }
        }
        (state, None)
    }

    /// Process every remaining event from `state`.
    pub fn run_to_end(&self, state: State) -> (State, Option<Failure>) {
        let events = match self.events() {
            Ok(events) => events,
            Err(failure) => return (state, Some(failure)),
        };
        let remaining: Vec<MarketEvent> = match &state.next {
            None => Vec::new(),
            Some(next) => events
                .into_iter()
                .skip_while(|event| &event.cursor != next)
                .collect(),
        };
        self.run_events(state, &remaining)
    }

    /// Wire cursor for the state's next event.
    #[must_use]
    pub fn wire_next(&self, state: &State) -> Option<Cursor> {
        state.next.clone()
    }

    /// Core cursor from a wire cursor.
    #[must_use]
    pub fn cursor_from_wire(cursor: &g::Cursor) -> Cursor {
        core_cursor(cursor)
    }
}

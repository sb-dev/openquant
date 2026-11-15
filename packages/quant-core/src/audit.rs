//! The two audits of a completed run that the correctness gates read: accounting reconciliation
//! and signal and data timing (OQ-02 section 3.2; decision D18 of the S1 pilot record).
//!
//! Both read the numerical result and the run that produced it. They do not run the evaluator and
//! they use exact arithmetic with a tolerance of zero. Each returns the first difference it finds
//! as text, so a reader knows what to look at; the gate report carries only the verdict, because
//! `gate-report/1` has no field for the detail.
//!
//! Reconciliation. The journal must agree with itself and with the run's capital:
//!
//! 1. Every fill: `notional = quantity * price`, a buy has `cash_delta = -(notional + fee)`, a sell
//!    has `cash_delta = notional - fee`, and no fee is negative.
//! 2. The cash ledger, replayed from `(capital, 0, 0)` line by line with the effect of its kind
//!    (reserve, release, buy, sell, dividend receivable, dividend payment), reproduces the three
//!    balances that every line states, and its sequence numbers rise.
//! 3. The buy and sell lines of the ledger are the fills, in order, with the same session and
//!    amount.
//! 4. The last ledger line states the final balances.
//! 5. Every daily record and the final state satisfy
//!    `equity = available + reserved + receivables + positions value`. Each daily record also
//!    states the balances of the ledger as it stood at the close of its session, and a positions
//!    value equal to the quantity of its positions times the close of the session.
//! 6. Conservation: capital plus the cash deltas of the fills plus the dividend payments equals
//!    available plus reserved cash at the end, and receivables recorded less payments equals the
//!    final receivables.
//!
//! Timing. Every entry fill is in the open phase of the first session after the signal session of
//! its intent. A stop or target fill is during the session, and a gap fill is at the open. Every
//! corporate action is applied before the open of its effective session. Every bar the run used was
//! available by the earlier of the next session's open and the information cutoff, and every
//! action by the earlier of the open of its effective session and the cutoff. A completed run has
//! passed the core's own availability checks; this audit repeats them from the input, so the gate
//! does not rest on the core alone.

use std::collections::BTreeMap;

use openquant_contracts::generated::{
    self as g, FillRecordReason, FillRecordSide, LedgerEntryKind,
};

use crate::{
    exact::{ExactError, Q},
    metrics::EvidenceError,
    model::Phase,
    run::Run,
};

/// The verdict of one audit.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Check {
    Pass,
    /// The first difference found, for the reader.
    Fail(String),
}

impl Check {
    /// Whether the audit passed.
    #[must_use]
    pub fn passed(&self) -> bool {
        matches!(self, Self::Pass)
    }
}

/// The audits of one completed run.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RunChecks {
    pub reconciliation: Check,
    pub timing: Check,
}

/// Audit a completed run.
///
/// # Errors
/// [`EvidenceError::NotCompleted`] unless the outcome is `COMPLETED`, and
/// [`EvidenceError::IdentityMismatch`] when the result is not the run's.
pub fn audit_run(run: &Run, result: &g::EvaluationResult) -> Result<RunChecks, EvidenceError> {
    if result.outcome.status != g::Status::Completed {
        return Err(EvidenceError::NotCompleted(
            result.outcome.status.to_string(),
        ));
    }
    if result.strategy_hash.as_str() != run.strategy_hash
        || result.input_hash.as_str() != run.input_hash
        || result.engine_digest.as_str() != run.engine_digest
    {
        return Err(EvidenceError::IdentityMismatch(
            "the result's strategy, input or engine digest is not the run's".to_owned(),
        ));
    }
    Ok(RunChecks {
        reconciliation: verdict(reconcile(run, result)),
        timing: verdict(timing(run, result)),
    })
}

fn verdict(outcome: Result<(), String>) -> Check {
    match outcome {
        Ok(()) => Check::Pass,
        Err(detail) => Check::Fail(detail),
    }
}

fn read(text: &str, what: &str) -> Result<Q, String> {
    Q::parse(text).map_err(|e: ExactError| format!("{what} {text:?} is not a decimal: {e}"))
}

/// Balances of the cash ledger: available, reserved and receivables.
#[derive(Clone, Debug, PartialEq, Eq)]
struct Balances {
    available: Q,
    reserved: Q,
    receivables: Q,
}

fn same(label: &str, expected: &Q, stated: &Q, at: &str) -> Result<(), String> {
    if expected == stated {
        Ok(())
    } else {
        Err(format!(
            "{at}: {label} is {stated}, the ledger gives {expected}"
        ))
    }
}

fn reconcile(run: &Run, result: &g::EvaluationResult) -> Result<(), String> {
    let journal = &result.journal;
    let capital = Q::from_decimal(&run.input.initial_capital);
    let mut cash_deltas = Q::zero();
    for fill in &journal.fills {
        let at = format!("fill {} on {}", fill.seq, fill.session.as_str());
        let (quantity, price) = (
            read(fill.quantity.as_str(), "quantity")?,
            read(fill.price.as_str(), "price")?,
        );
        let (notional, fee) = (
            read(fill.notional.as_str(), "notional")?,
            read(fill.fee.as_str(), "fee")?,
        );
        let delta = read(fill.cash_delta.as_str(), "cash_delta")?;
        same("notional", &(&quantity * &price), &notional, &at)?;
        if fee.is_negative() {
            return Err(format!("{at}: the fee {fee} is negative"));
        }
        let expected = match fill.side {
            FillRecordSide::Buy => &(&Q::zero() - &notional) - &fee,
            FillRecordSide::Sell => &notional - &fee,
        };
        same("cash_delta", &expected, &delta, &at)?;
        cash_deltas = &cash_deltas + &delta;
    }

    let mut balances = Balances {
        available: capital.clone(),
        reserved: Q::zero(),
        receivables: Q::zero(),
    };
    let mut after_session: BTreeMap<&str, Balances> = BTreeMap::new();
    let mut payments = Q::zero();
    let mut recorded = Q::zero();
    let mut last_seq: Option<i64> = None;
    let mut trades = journal.fills.iter();
    for line in &journal.cash_ledger {
        let at = format!("ledger line {} on {}", line.seq, line.session.as_str());
        if last_seq.is_some_and(|previous| line.seq <= previous) {
            return Err(format!("{at}: the sequence number does not rise"));
        }
        last_seq = Some(line.seq);
        let amount = read(line.amount.as_str(), "amount")?;
        if amount.is_negative() {
            return Err(format!("{at}: the amount {amount} is negative"));
        }
        match line.kind {
            LedgerEntryKind::Reserve => {
                balances.available = &balances.available - &amount;
                balances.reserved = &balances.reserved + &amount;
            }
            LedgerEntryKind::Release => {
                balances.reserved = &balances.reserved - &amount;
                balances.available = &balances.available + &amount;
            }
            LedgerEntryKind::FillBuy | LedgerEntryKind::FillSell => {
                let buy = line.kind == LedgerEntryKind::FillBuy;
                balances.available = if buy {
                    &balances.available - &amount
                } else {
                    &balances.available + &amount
                };
                let Some(fill) = trades.next() else {
                    return Err(format!("{at}: a trade line has no fill"));
                };
                let delta = read(fill.cash_delta.as_str(), "cash_delta")?;
                let side_ok = (fill.side == FillRecordSide::Buy) == buy;
                if !side_ok
                    || fill.session.as_str() != line.session.as_str()
                    || delta.abs() != amount
                {
                    return Err(format!(
                        "{at}: it is not the fill {} of the journal",
                        fill.seq
                    ));
                }
            }
            LedgerEntryKind::DividendReceivable => {
                balances.receivables = &balances.receivables + &amount;
                recorded = &recorded + &amount;
            }
            LedgerEntryKind::DividendPayment => {
                balances.receivables = &balances.receivables - &amount;
                balances.available = &balances.available + &amount;
                payments = &payments + &amount;
            }
        }
        same(
            "available after",
            &balances.available,
            &read(line.available_after.as_str(), "available_after")?,
            &at,
        )?;
        same(
            "reserved after",
            &balances.reserved,
            &read(line.reserved_after.as_str(), "reserved_after")?,
            &at,
        )?;
        same(
            "receivables after",
            &balances.receivables,
            &read(line.receivables_after.as_str(), "receivables_after")?,
            &at,
        )?;
        after_session.insert(line.session.as_str(), balances.clone());
    }
    if let Some(fill) = trades.next() {
        return Err(format!("fill {} has no ledger line", fill.seq));
    }

    let state = &result.final_;
    let finals = Balances {
        available: read(state.cash_available.as_str(), "final available")?,
        reserved: read(state.cash_reserved.as_str(), "final reserved")?,
        receivables: read(state.receivables.as_str(), "final receivables")?,
    };
    if balances != finals {
        return Err(format!(
            "the final balances {finals:?} differ from the last ledger line {balances:?}"
        ));
    }
    same(
        "cash conserved: capital + fill cash + dividends paid",
        &(&(&capital + &cash_deltas) + &payments),
        &(&finals.available + &finals.reserved),
        "the end of the run",
    )?;
    same(
        "receivables conserved: recorded - paid",
        &(&recorded - &payments),
        &finals.receivables,
        "the end of the run",
    )?;

    let final_value = read(state.positions_value.as_str(), "final positions value")?;
    let final_equity = read(state.equity.as_str(), "final equity")?;
    same(
        "final equity",
        &(&(&(&finals.available + &finals.reserved) + &finals.receivables) + &final_value),
        &final_equity,
        "the final state",
    )?;

    let sessions = &run.input;
    for record in &journal.daily {
        let at = format!("daily record {}", record.session.as_str());
        let available = read(record.cash_available.as_str(), "cash_available")?;
        let reserved = read(record.cash_reserved.as_str(), "cash_reserved")?;
        let receivables = read(record.receivables.as_str(), "receivables")?;
        let value = read(record.positions_value.as_str(), "positions_value")?;
        let equity = read(record.equity.as_str(), "equity")?;
        same(
            "equity",
            &(&(&(&available + &reserved) + &receivables) + &value),
            &equity,
            &at,
        )?;
        let ledger = after_session
            .range(..=record.session.as_str())
            .next_back()
            .map_or_else(
                || Balances {
                    available: capital.clone(),
                    reserved: Q::zero(),
                    receivables: Q::zero(),
                },
                |(_, balances)| balances.clone(),
            );
        same("cash_available", &ledger.available, &available, &at)?;
        same("cash_reserved", &ledger.reserved, &reserved, &at)?;
        same("receivables", &ledger.receivables, &receivables, &at)?;
        let mut held = Q::zero();
        for position in &record.positions {
            held = &held + &read(position.quantity.as_str(), "position quantity")?;
        }
        match sessions.bars.get(record.session.as_str()) {
            Some(bar) => same(
                "positions_value",
                &(&held * &Q::from_decimal(&bar.close)),
                &value,
                &at,
            )?,
            None if held.is_zero() && value.is_zero() => {}
            None => {
                return Err(format!(
                    "{at}: positions are valued on a session without a bar"
                ));
            }
        }
    }
    Ok(())
}

fn timing(run: &Run, result: &g::EvaluationResult) -> Result<(), String> {
    let input = &run.input;
    let index_of = |date: &str| input.sessions.iter().position(|s| s.date == date);
    let journal = &result.journal;
    for fill in &journal.fills {
        let at = format!("fill {} on {}", fill.seq, fill.session.as_str());
        let (wanted, label) = match fill.reason {
            FillRecordReason::Entry => (Phase::Open, "an entry"),
            FillRecordReason::GapStop | FillRecordReason::GapTarget => (Phase::Open, "a gap exit"),
            FillRecordReason::Stop | FillRecordReason::Target => {
                (Phase::DuringSession, "a stop or target")
            }
        };
        if fill.phase != wanted {
            return Err(format!(
                "{at}: {label} is in phase {}, not {wanted}",
                fill.phase
            ));
        }
        if fill.reason == FillRecordReason::Entry {
            let signal = journal
                .entries
                .iter()
                .find(|entry| Some(&entry.intent_id) == fill.intent_id.as_ref())
                .ok_or_else(|| format!("{at}: the entry has no intent record"))?;
            let (Some(signalled), Some(filled)) = (
                index_of(signal.signal_session.as_str()),
                index_of(fill.session.as_str()),
            ) else {
                return Err(format!(
                    "{at}: the signal or fill session is not on the calendar"
                ));
            };
            if filled != signalled + 1 {
                return Err(format!(
                    "{at}: the signal was on {}, so the fill belongs to the next session",
                    signal.signal_session.as_str()
                ));
            }
        }
    }
    for record in &journal.corporate_actions {
        let at = format!("action {}", record.action_id.as_str());
        if record.applied_at.phase != Phase::BeforeOpen
            || record.applied_at.session.as_str() != record.effective_session.as_str()
        {
            return Err(format!(
                "{at}: applied at {} {}, not before the open of {}",
                record.applied_at.session.as_str(),
                record.applied_at.phase,
                record.effective_session.as_str()
            ));
        }
    }
    let cutoff = input.information_cutoff.as_str();
    let earlier = |bound: &str| {
        if bound < cutoff {
            bound.to_owned()
        } else {
            cutoff.to_owned()
        }
    };
    for index in input.first..=input.last {
        let Some(session) = input.sessions.get(index) else {
            return Err("the run's window leaves the calendar".to_owned());
        };
        if let Some(bar) = input.bars.get(&session.date) {
            let deadline = match input.sessions.get(index + 1).filter(|_| index < input.last) {
                Some(next) => earlier(&next.open_at),
                None => cutoff.to_owned(),
            };
            if bar.available_at > deadline {
                return Err(format!(
                    "the bar of {} became available at {}, after {deadline}",
                    session.date, bar.available_at
                ));
            }
        }
    }
    for action in &input.actions {
        let Some(index) = index_of(&action.effective_session) else {
            continue;
        };
        if index < input.first || index > input.last {
            continue;
        }
        let open = input
            .sessions
            .get(index)
            .map_or(cutoff, |s| s.open_at.as_str());
        let deadline = earlier(open);
        if action.available_at > deadline {
            return Err(format!(
                "action {} became available at {}, after {deadline}",
                action.id, action.available_at
            ));
        }
    }
    Ok(())
}

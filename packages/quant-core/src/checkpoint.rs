//! Serialise and restore numerical state through the shared checkpoint schema.
//!
//! A checkpoint binds the strategy, input and engine identities and the event cursor to cash,
//! reservations, positions, pending entries, scheduled stops, receivables and applied action
//! identities (OQ-06 section 8, S0).

use std::collections::BTreeSet;

use openquant_contracts::generated as g;

use crate::{
    data::ActionKind,
    execution::accounting::{positions_value, receivables_total},
    format::{core_cursor, ident, parse_decimal, session_date, wire_cursor},
    model::{Failure, FailureCode, PHASES, Phase, Result},
    numeric::Decimal,
    run::Run,
    state::{Pending, Position, Receivable, Scheduled, State},
};

/// A restored state that this engine could not have produced.
fn bad(what: &str) -> Failure {
    Failure::new(
        FailureCode::CheckpointMismatch,
        format!("checkpoint state is inconsistent: {what}"),
    )
}

/// Cash and receivables at one point of the journal.
#[derive(Clone, Copy, Debug)]
struct Balances {
    available: Decimal,
    reserved: Decimal,
    receivables: Decimal,
}

impl Balances {
    /// The first balance that differs from `other`, compared by value.
    fn difference(&self, other: &Self) -> Option<&'static str> {
        if self.available != other.available {
            Some("available cash")
        } else if self.reserved != other.reserved {
            Some("reserved cash")
        } else if self.receivables != other.receivables {
            Some("receivables")
        } else {
            None
        }
    }
}

/// A decimal stored in the journal.
fn stored(value: &g::Decimal) -> Result<Decimal> {
    parse_decimal(value).map_err(|_| bad("unreadable journal amount"))
}

/// The balances a ledger line states after its change.
fn ledger_balances(line: &g::LedgerEntry) -> Result<Balances> {
    Ok(Balances {
        available: stored(&line.available_after)?,
        reserved: stored(&line.reserved_after)?,
        receivables: stored(&line.receivables_after)?,
    })
}

fn snapshots_to_wire(run: &Run, snapshots: &[(String, Decimal)]) -> Result<Vec<g::SnapshotValue>> {
    snapshots
        .iter()
        .map(|(name, value)| {
            Ok(g::SnapshotValue {
                name: ident(name)?,
                value: run.fmt.exact(*value)?,
            })
        })
        .collect()
}

fn snapshots_from_wire(snapshots: &[g::SnapshotValue]) -> Result<Vec<(String, Decimal)>> {
    snapshots
        .iter()
        .map(|s| Ok((s.name.to_string(), parse_decimal(&s.value)?)))
        .collect()
}

impl Run {
    /// Serialise `state`.
    ///
    /// # Errors
    /// A formatting failure if a value cannot be represented.
    pub fn checkpoint(&self, state: &State) -> Result<g::Checkpoint> {
        let fmt = &self.fmt;
        let mut positions = Vec::new();
        for p in &state.positions {
            let scheduled_stop = match &p.scheduled {
                Some(s) => Some(g::ScheduledStop {
                    effective_session: session_date(&s.effective_session)?,
                    level: fmt.exact(s.level)?,
                }),
                None => None,
            };
            positions.push(g::PositionSnapshot {
                entry_price: fmt.exact(p.entry_price)?,
                entry_session: session_date(&p.entry_session)?,
                fired_adjustments: p.fired.iter().map(|f| ident(f)).collect::<Result<_>>()?,
                instrument_id: ident(&p.instrument_id)?,
                mark: fmt.exact(p.mark)?,
                quantity: fmt.qty(p.quantity)?,
                scheduled_stop,
                snapshots: snapshots_to_wire(self, &p.snapshots)?,
                stop: fmt.exact(p.stop)?,
                target: fmt.exact(p.target)?,
                trade_id: ident(&p.trade_id)?,
            });
        }
        let mut pending_entries = Vec::new();
        for p in &state.pending {
            pending_entries.push(g::PendingSnapshot {
                cap: fmt.money(p.cap)?,
                instrument_id: ident(&p.instrument_id)?,
                intent_id: ident(&p.intent_id)?,
                rank: fmt.exact(p.rank)?,
                signal_session: session_date(&p.signal_session)?,
                snapshots: snapshots_to_wire(self, &p.snapshots)?,
            });
        }
        let mut receivables = Vec::new();
        for r in &state.receivables {
            receivables.push(g::ReceivableSnapshot {
                action_id: ident(&r.action_id)?,
                amount: fmt.money(r.amount)?,
                payment_phase: r.payment_phase,
                payment_session: session_date(&r.payment_session)?,
            });
        }
        let applied_action_ids = state
            .applied
            .iter()
            .map(|id| ident(id))
            .collect::<Result<Vec<_>>>()?;
        Ok(g::Checkpoint {
            engine_digest: gdigest(&self.engine_digest)?,
            input_hash: gdigest(&self.input_hash)?,
            next_event: state.next.as_ref().map(wire_cursor).transpose()?,
            schema_version: g::CheckpointSchemaVersion::Checkpoint1,
            state: g::StateSnapshot {
                applied_action_ids,
                cash_available: fmt.money(state.cash_available)?,
                cash_reserved: fmt.money(state.cash_reserved)?,
                journal: state.journal.clone(),
                pending_entries,
                positions,
                receivables,
            },
            strategy_hash: gdigest(&self.strategy_hash)?,
        })
    }

    /// Restore state from a checkpoint after checking every bound identity.
    ///
    /// # Errors
    /// `CHECKPOINT_MISMATCH` when strategy, input or engine identity or the cursor does not
    /// belong to this run.
    pub fn restore(&self, checkpoint: &g::Checkpoint) -> Result<State> {
        let mismatch = |what: &str| {
            Failure::new(
                FailureCode::CheckpointMismatch,
                format!("checkpoint {what} does not match this run"),
            )
        };
        if checkpoint.strategy_hash.as_str() != self.strategy_hash {
            return Err(mismatch("strategy hash"));
        }
        if checkpoint.input_hash.as_str() != self.input_hash {
            return Err(mismatch("input hash"));
        }
        if checkpoint.engine_digest.as_str() != self.engine_digest {
            return Err(mismatch("engine digest"));
        }
        let next = checkpoint.next_event.as_ref().map(core_cursor);
        if let Some(cursor) = &next {
            let known = (self.input.first..=self.input.last).any(|index| {
                self.input
                    .sessions
                    .get(index)
                    .is_some_and(|s| s.date == cursor.session)
            }) && PHASES.contains(&cursor.phase);
            if !known {
                return Err(mismatch("event cursor"));
            }
        }
        let snap = &checkpoint.state;
        let mut positions = Vec::new();
        for p in &snap.positions {
            positions.push(Position {
                entry_price: parse_decimal(&p.entry_price)?,
                entry_session: p.entry_session.to_string(),
                fired: p.fired_adjustments.iter().map(|f| f.to_string()).collect(),
                instrument_id: p.instrument_id.to_string(),
                mark: parse_decimal(&p.mark)?,
                quantity: parse_decimal(&p.quantity)?,
                scheduled: match &p.scheduled_stop {
                    Some(s) => Some(Scheduled {
                        effective_session: s.effective_session.to_string(),
                        level: parse_decimal(&s.level)?,
                    }),
                    None => None,
                },
                snapshots: snapshots_from_wire(&p.snapshots)?,
                stop: parse_decimal(&p.stop)?,
                target: parse_decimal(&p.target)?,
                trade_id: p.trade_id.to_string(),
            });
        }
        let mut pending = Vec::new();
        for p in &snap.pending_entries {
            pending.push(Pending {
                cap: parse_decimal(&p.cap)?,
                instrument_id: p.instrument_id.to_string(),
                intent_id: p.intent_id.to_string(),
                rank: parse_decimal(&p.rank)?,
                signal_session: p.signal_session.to_string(),
                snapshots: snapshots_from_wire(&p.snapshots)?,
            });
        }
        let mut receivables = Vec::new();
        for r in &snap.receivables {
            receivables.push(Receivable {
                action_id: r.action_id.to_string(),
                amount: parse_decimal(&r.amount)?,
                payment_phase: r.payment_phase,
                payment_session: r.payment_session.to_string(),
            });
        }
        let state = State {
            applied: snap
                .applied_action_ids
                .iter()
                .map(|id| id.to_string())
                .collect::<BTreeSet<_>>(),
            cash_available: parse_decimal(&snap.cash_available)?,
            cash_reserved: parse_decimal(&snap.cash_reserved)?,
            journal: snap.journal.clone(),
            next,
            pending,
            positions,
            receivables,
        };
        self.validate_state(&state)?;
        Ok(state)
    }

    /// Reject a restored state that this engine could not have produced at its cursor.
    ///
    /// The identities already match, so the state belongs to this strategy and input. These
    /// checks catch a damaged or edited payload before it is run. What is checked:
    ///
    /// - applied-action identities against the cursor (a split would apply twice or never);
    /// - the daily record count, the journal sequence number against its fills and ledger
    ///   lines, non-negative cash, reserved cash against the sum of the pending caps, open trade
    ///   records against the positions, snapshot and adjustment names, and receivables against
    ///   the declared dividends and their payment time;
    /// - balances against the journal (`check_journal_balances`): available cash,
    ///   reserved cash and receivables against the last cash ledger line (or the initial
    ///   capital when the ledger is empty); every daily record against the ledger as it stood at
    ///   the close of its session and against its own equity sum; each position against its
    ///   open trade record; and, at a before-open cursor or after the last event, the positions
    ///   value against the last daily record.
    ///
    /// What is not checked, because the stored data cannot decide it exactly: a stop, target,
    /// scheduled stop, snapshot, fired adjustment or pending rank at any cursor, a mark inside a
    /// session (no journal line states them), the amount of the last ledger line, the
    /// intermediate ledger lines, fills and signal records, and the daily positions. A checkpoint whose
    /// edits keep all of the above consistent is not detected here. Beyond these consistency
    /// checks, integrity of a stored checkpoint relies on the content hash it is stored with
    /// (docs/specs/05, R2), which is not part of S0.
    fn validate_state(&self, state: &State) -> Result<()> {
        let (cursor_index, phase) = match &state.next {
            Some(cursor) => (
                self.index_of(&cursor.session)
                    .map_err(|_| bad("event cursor"))?,
                Some(cursor.phase),
            ),
            None => (self.input.last.saturating_add(1), None),
        };
        // Actions applied at or before the cursor, and no others.
        let mut expected = BTreeSet::new();
        for action in &self.input.actions {
            let index = self.index_of(&action.effective_session)?;
            let started = index == cursor_index && phase.is_some_and(|p| p != Phase::BeforeOpen);
            if index >= self.input.first && (index < cursor_index || started) {
                expected.insert(action.id.clone());
            }
        }
        if state.applied != expected {
            return Err(bad("applied action identities do not match the cursor"));
        }
        let processed = cursor_index.saturating_sub(self.input.first);
        if state.journal.daily.len() != processed {
            return Err(bad("daily records do not match the cursor"));
        }
        let journal = &state.journal;
        let lines = journal
            .fills
            .len()
            .saturating_add(journal.cash_ledger.len());
        if usize::try_from(journal.next_seq).ok() != Some(lines) {
            return Err(bad("journal sequence does not match its records"));
        }
        if state.cash_available < Decimal::ZERO || state.cash_reserved < Decimal::ZERO {
            return Err(bad("negative cash"));
        }
        let mut reserved = Decimal::ZERO;
        for pending in &state.pending {
            if pending.cap <= Decimal::ZERO {
                return Err(bad("non-positive entry cap"));
            }
            reserved = reserved
                .checked_add(pending.cap)
                .ok_or_else(|| bad("entry caps overflow"))?;
            let reserved_record = journal.entries.iter().any(|e| {
                e.intent_id.as_str() == pending.intent_id
                    && e.status == g::EntryRecordStatus::Reserved
            });
            if !reserved_record {
                return Err(bad("pending entry without a reserved entry record"));
            }
            self.check_snapshot_names(&pending.snapshots)
                .map_err(|_| bad("pending snapshot names"))?;
        }
        if reserved != state.cash_reserved {
            return Err(bad("reserved cash is not the sum of the pending caps"));
        }
        if !state.pending.is_empty() && !matches!(phase, Some(Phase::BeforeOpen | Phase::Open)) {
            return Err(bad("pending entries outside the window before an open"));
        }
        let open_trades = journal
            .trades
            .iter()
            .filter(|t| t.exit_session.is_none())
            .count();
        if open_trades != state.positions.len() {
            return Err(bad("open trade records do not match the positions"));
        }
        for position in &state.positions {
            if position.quantity <= Decimal::ZERO {
                return Err(bad("non-positive position quantity"));
            }
            if position.instrument_id != self.input.instrument_id {
                return Err(bad("position instrument"));
            }
            let open_record = journal
                .trades
                .iter()
                .find(|t| t.trade_id.as_str() == position.trade_id && t.exit_session.is_none());
            let Some(open_record) = open_record else {
                return Err(bad("position without an open trade record"));
            };
            // The trade record follows the position's share basis, split included, so the
            // two always agree at an event boundary.
            let agrees = parse_decimal(&open_record.quantity).ok() == Some(position.quantity)
                && parse_decimal(&open_record.entry_price).ok() == Some(position.entry_price)
                && open_record.entry_session.as_str() == position.entry_session;
            if !agrees {
                return Err(bad("position does not match its open trade record"));
            }
            self.check_snapshot_names(&position.snapshots)
                .map_err(|_| bad("position snapshot names"))?;
            if position
                .fired
                .iter()
                .any(|id| !self.strategy.adjustments.iter().any(|a| &a.id == id))
            {
                return Err(bad("fired adjustment is not declared by the strategy"));
            }
        }
        for receivable in &state.receivables {
            // A receivable is paid at the first event at or after its payment time, so one that
            // is still waiting must be due at or after the cursor, or after the run ends.
            let overdue = match &state.next {
                Some(cursor) => {
                    (
                        receivable.payment_session.as_str(),
                        receivable.payment_phase,
                    ) < (cursor.session.as_str(), cursor.phase)
                }
                None => self
                    .session(self.input.last)
                    .map_or(true, |last| receivable.payment_session <= last.date),
            };
            if overdue {
                return Err(bad("receivable is overdue at the cursor"));
            }
            let declared = self.input.actions.iter().any(|a| {
                a.id == receivable.action_id
                    && matches!(
                        &a.kind,
                        ActionKind::CashDividend { payment_session, payment_phase, .. }
                            if *payment_session == receivable.payment_session
                                && *payment_phase == receivable.payment_phase
                    )
            });
            if !declared || receivable.amount <= Decimal::ZERO {
                return Err(bad("receivable does not match a declared dividend"));
            }
        }
        self.check_journal_balances(state, phase)
    }

    /// Cross-check the balances of a restored state against the journal.
    ///
    /// Every cash change appends a ledger line with the balances after it, and the line is the
    /// last thing a handler does to the balances, so at any event boundary the last ledger
    /// line states the state's balances exactly. An empty ledger means no cash has moved, so
    /// the balances are the opening ones. A daily record is pushed after the last ledger line
    /// of its session, so it equals the ledger as it stood at that session's close. Its equity
    /// is the sum of its other money fields. After a close (a before-open cursor, or the end of
    /// the run) nothing has changed since the last daily record, so the positions value must
    /// equal its stored value as well. Inside a session a mark has no journal line, so it is
    /// not checked.
    fn check_journal_balances(&self, state: &State, phase: Option<Phase>) -> Result<()> {
        let journal = &state.journal;
        let opening = Balances {
            available: self.input.initial_capital,
            reserved: Decimal::ZERO,
            receivables: Decimal::ZERO,
        };
        let held = Balances {
            available: state.cash_available,
            reserved: state.cash_reserved,
            receivables: receivables_total(state).map_err(|_| bad("receivables overflow"))?,
        };
        let tail = match journal.cash_ledger.last() {
            Some(line) => ledger_balances(line)?,
            None => opening,
        };
        if let Some(what) = held.difference(&tail) {
            return Err(bad(&format!(
                "{what} does not match the last cash ledger line"
            )));
        }
        let mut lines = journal.cash_ledger.iter().peekable();
        let mut at_close = opening;
        for (offset, daily) in journal.daily.iter().enumerate() {
            let session = self
                .session(self.input.first.saturating_add(offset))
                .map_err(|_| bad("daily record without a calendar session"))?;
            if daily.session.as_str() != session.date {
                return Err(bad("daily record is not for its calendar session"));
            }
            while let Some(line) = lines.next_if(|l| l.session.as_str() <= session.date.as_str()) {
                at_close = ledger_balances(line)?;
            }
            let recorded = Balances {
                available: stored(&daily.cash_available)?,
                reserved: stored(&daily.cash_reserved)?,
                receivables: stored(&daily.receivables)?,
            };
            if let Some(what) = recorded.difference(&at_close) {
                return Err(bad(&format!(
                    "daily {what} for {} does not match the cash ledger at its close",
                    session.date
                )));
            }
            let value = stored(&daily.positions_value)?;
            let sum = [
                recorded.available,
                recorded.reserved,
                recorded.receivables,
                value,
            ]
            .into_iter()
            .try_fold(Decimal::ZERO, Decimal::checked_add)
            .ok_or_else(|| bad("daily equity overflow"))?;
            if sum != stored(&daily.equity)? {
                return Err(bad(&format!(
                    "daily equity for {} is not the sum of its parts",
                    session.date
                )));
            }
        }
        if matches!(phase, None | Some(Phase::BeforeOpen))
            && let Some(last) = journal.daily.last()
        {
            let value = positions_value(self, state).map_err(|_| bad("positions value"))?;
            if value != stored(&last.positions_value)? {
                return Err(bad("positions do not match the last daily record"));
            }
        }
        Ok(())
    }

    /// Snapshot names must be the strategy's, in its order.
    fn check_snapshot_names(&self, snapshots: &[(String, Decimal)]) -> Result<()> {
        let matches = snapshots.len() == self.strategy.snapshots.len()
            && snapshots
                .iter()
                .zip(&self.strategy.snapshots)
                .all(|((name, _), declared)| *name == declared.name);
        if matches {
            Ok(())
        } else {
            Err(Failure::internal("snapshot names"))
        }
    }
}

fn gdigest(text: &str) -> Result<g::Digest> {
    text.parse::<g::Digest>()
        .map_err(|e| Failure::new(FailureCode::IdentityMismatch, e.to_string()))
}

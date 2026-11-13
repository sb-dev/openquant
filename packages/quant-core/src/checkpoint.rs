//! Serialise and restore numerical state through the shared checkpoint schema.
//!
//! A checkpoint binds the strategy, input and engine identities and the event cursor to cash,
//! reservations, positions, pending entries, scheduled stops, receivables and applied action
//! identities (OQ-06 section 8, S0).

use std::collections::BTreeSet;

use openquant_contracts::generated as g;

use crate::{
    data::ActionKind,
    format::{core_cursor, ident, parse_decimal, session_date, wire_cursor},
    model::{Failure, FailureCode, PHASES, Phase, Result},
    numeric::Decimal,
    run::Run,
    state::{Pending, Position, Receivable, Scheduled, State},
};

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
    /// checks catch a damaged or edited payload before it is run: applied-action identities
    /// that disagree with the cursor would apply a split twice or never, and balances that
    /// disagree with the journal would make the continued run inconsistent.
    fn validate_state(&self, state: &State) -> Result<()> {
        let bad = |what: &str| {
            Failure::new(
                FailureCode::CheckpointMismatch,
                format!("checkpoint state is inconsistent: {what}"),
            )
        };
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
                .any(|t| t.trade_id.as_str() == position.trade_id && t.exit_session.is_none());
            if !open_record {
                return Err(bad("position without an open trade record"));
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

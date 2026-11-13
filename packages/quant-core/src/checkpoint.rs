//! Serialise and restore numerical state through the shared checkpoint schema.
//!
//! A checkpoint binds the strategy, input and engine identities and the event cursor to cash,
//! reservations, positions, pending entries, scheduled stops, receivables and applied action
//! identities (OQ-06 section 8, S0).

use std::collections::BTreeSet;

use openquant_contracts::generated as g;

use crate::{
    format::{core_cursor, ident, parse_decimal, session_date, wire_cursor},
    model::{Failure, FailureCode, PHASES, Result},
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
        Ok(State {
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
        })
    }
}

fn gdigest(text: &str) -> Result<g::Digest> {
    text.parse::<g::Digest>()
        .map_err(|e| Failure::new(FailureCode::IdentityMismatch, e.to_string()))
}

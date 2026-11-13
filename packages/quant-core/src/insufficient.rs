//! Details of `INSUFFICIENT` outcomes: the instrument, the event, the missing evidence and the
//! affected period (OQ-02 section 2.5; OQ-06 section 8, "Unplanned non-trading events").
//!
//! The details are free text in `outcome.detail`, which the result schema limits to 1000
//! characters; the result builder cuts a longer text on a character boundary. Each text names
//! the instrument and the dates before the list of halt identifiers, which comes last, so a cut
//! can only shorten that list, and only when about a dozen identifiers of the longest length
//! are named at once. The other texts are far below the limit.
//!
//! Each detail names these facts, and the fixtures check them as substrings:
//!
//! - `MISSING_REQUIRED_BAR`: the instrument and the session with no bar.
//! - `UNSUPPORTED_VALUATION`: the instrument, the first unvalued session, the final session of
//!   the scored window, and the `event_id` of every confirmed halt of that session.
//! - `UNSUPPORTED_CORPORATE_ACTION` and `FRACTIONAL_ENTITLEMENT`: the instrument, the
//!   `action_id` and the effective session.

use crate::{data::Action, data::Halt, numeric::Decimal, run::Run};

fn ids<'a>(halts: impl Iterator<Item = &'a Halt>) -> String {
    halts.map(|h| h.id.as_str()).collect::<Vec<_>>().join(", ")
}

impl Run {
    /// Date of the final session of the scored window (`windows.scored_end`).
    #[must_use]
    pub fn scored_end(&self) -> &str {
        self.input
            .sessions
            .get(self.input.last)
            .map_or("", |s| s.date.as_str())
    }

    /// The halts that dated evidence confirms for the session: known at its open, and within
    /// the information cutoff. In input order.
    #[must_use]
    pub fn confirmed_halts(&self, date: &str) -> Vec<&Halt> {
        let open_at = self
            .index_of(date)
            .ok()
            .and_then(|index| self.input.sessions.get(index))
            .map_or("", |s| s.open_at.as_str());
        let open_at = self.deadline(Some(open_at));
        self.input
            .halts
            .iter()
            .filter(|h| h.effective_session == date && h.available_at.as_str() <= open_at)
            .collect()
    }

    /// `MISSING_REQUIRED_BAR`: a session has neither a bar nor a halt confirmed by its open.
    pub(crate) fn missing_bar_detail(&self, date: &str) -> String {
        let instrument = &self.input.instrument_id;
        let end = self.scored_end();
        let late = self
            .input
            .halts
            .iter()
            .filter(|h| h.effective_session == date)
            .collect::<Vec<_>>();
        let late = if late.is_empty() {
            String::new()
        } else {
            format!(
                "; halt evidence {} was not available in time to confirm it",
                ids(late.into_iter())
            )
        };
        format!(
            "instrument {instrument}: no bar for session {date} and no halt confirmed by its open, so the evidence for that session is missing; the run stops at {date} and sessions {date} to {end} are not evaluated{late}"
        )
    }

    /// `UNSUPPORTED_VALUATION`: a position is held through a session without a bar.
    pub(crate) fn unsupported_valuation_detail(&self, date: &str) -> String {
        let instrument = &self.input.instrument_id;
        let end = self.scored_end();
        let halts = self.confirmed_halts(date);
        let cause = if halts.is_empty() {
            "no confirmed halt is recorded for it".to_owned()
        } else {
            format!(
                "confirmed halt(s) covering {date}: {}",
                ids(halts.into_iter())
            )
        };
        format!(
            "instrument {instrument}: a position is held and session {date} has no bar, so no valuation, settlement or liquidation price is supported; first unvalued session {date}, and sessions {date} to {end} (the end of the scored window) are not valued; {cause}"
        )
    }

    /// `UNSUPPORTED_CORPORATE_ACTION`: an action of a kind the policy has no semantics for.
    pub(crate) fn unsupported_action_detail(&self, action: &Action, kind: &str) -> String {
        let instrument = &self.input.instrument_id;
        let (id, date, end) = (&action.id, &action.effective_session, self.scored_end());
        format!(
            "instrument {instrument}: corporate action {id} of kind {kind} effective {date} has no declared semantics in this policy; the run stops before the open of {date}, so sessions {date} to {end} are not evaluated"
        )
    }

    /// `FRACTIONAL_ENTITLEMENT`: a split that would leave a fractional number of shares.
    pub(crate) fn fractional_detail(
        &self,
        action: &Action,
        ratio: (u64, u64),
        held: Decimal,
        converted: Decimal,
    ) -> String {
        let instrument = &self.input.instrument_id;
        let (id, date, end) = (&action.id, &action.effective_session, self.scored_end());
        let (new, old) = ratio;
        format!(
            "instrument {instrument}: split {id} ({new} for {old}) effective {date} would leave {converted} shares from {held}, and fractional entitlements are not supported; the run stops before the open of {date}, so sessions {date} to {end} are not evaluated"
        )
    }
}

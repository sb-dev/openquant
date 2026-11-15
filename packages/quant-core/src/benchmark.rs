//! The same-stock buy-and-hold benchmark of one run (OQ-02 section 3.6; decision D4 of the S1
//! pilot record).
//!
//! The benchmark buys the largest whole-lot quantity whose notional plus the run's fee fits the
//! initial capital, at the open of the first session of the scored window that has a bar. It pays
//! the run's cost model on that one fill, holds with the run's corporate-action handling, is
//! marked at each close and is never sold. The cash benchmark holds the initial capital and earns
//! nothing; it needs no path.
//!
//! The benchmark reuses the evaluator's own rules instead of restating them. The lot search is
//! `quantity_for` and the fee is `fee_for`, so a stress run's fee changes the quantity exactly as
//! it changes an entry. A cash dividend is credited by `dividend_entitlement`, the function that
//! the evaluator's dividend handler calls. A split multiplies the quantity by `new / old` and must
//! stay a whole number, as in the core. The benchmark checks nothing else about the data: it is
//! computed for a run that completed, whose availability and coverage checks have passed.
//!
//! A benchmark that cannot be built is [`BuyAndHold::Unavailable`] with a reason, never a guess:
//! no bar at all in the scored window, no affordable lot, a fractional entitlement after a split,
//! an unsupported action, a session without a bar while the position is held, or an arithmetic
//! failure of the lot search. Gates that depend on it are then `INSUFFICIENT`.

use crate::{
    data::ActionKind,
    exact::Q,
    execution::{accounting::fee_for, corporate_actions::dividend_entitlement, open::quantity_for},
    model::Failure,
    numeric::{Decimal, exact_mul, exact_sub, truncate_on_boundary},
    run::Run,
};

/// Reason text when the scored window has no session with a bar.
pub const REASON_NO_BAR: &str = "no session of the scored window has a bar";
/// Reason text when not even one lot is affordable at the first fillable open.
pub const REASON_NO_LOT: &str = "no whole lot is affordable at the first fillable open";

const MAX_REASON: usize = 1000;

/// A computed buy-and-hold path.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HoldPath {
    /// The session of the buy, at its open.
    pub entry_session: String,
    /// Shares bought at the open of the entry session, before any later split.
    pub quantity: Decimal,
    /// Equity at the close of every session from the scored start to the scored end: the initial
    /// capital before the buy, then cash, dividend entitlements and the holding at the close.
    pub equities: Vec<Q>,
}

/// The benchmark of one run.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum BuyAndHold {
    Computed(HoldPath),
    /// The benchmark has no value. `reason` is shown to readers.
    Unavailable {
        reason: String,
    },
}

fn unavailable(reason: impl Into<String>) -> BuyAndHold {
    let reason: String = reason.into();
    BuyAndHold::Unavailable {
        reason: truncate_on_boundary(&reason, MAX_REASON).to_owned(),
    }
}

fn failed(what: &str, failure: &Failure) -> BuyAndHold {
    unavailable(format!("{what}: {} ({})", failure.code, failure.detail))
}

/// Build the buy-and-hold path of `run`.
#[must_use]
pub fn buy_and_hold(run: &Run) -> BuyAndHold {
    let input = &run.input;
    let capital = input.initial_capital;
    let buy_index = (input.scored_start..=input.last).find(|index| {
        input
            .sessions
            .get(*index)
            .is_some_and(|s| input.bars.contains_key(&s.date))
    });
    let Some(buy_index) = buy_index else {
        return unavailable(REASON_NO_BAR);
    };
    let Some(buy_session) = input.sessions.get(buy_index) else {
        return unavailable(REASON_NO_BAR);
    };
    let Some(buy_bar) = input.bars.get(&buy_session.date) else {
        return unavailable(REASON_NO_BAR);
    };
    let open = buy_bar.open;
    let mut quantity = match quantity_for(run, capital, open) {
        Ok(quantity) => quantity,
        Err(failure) => return failed("the lot search failed", &failure),
    };
    if quantity <= Decimal::ZERO {
        return unavailable(REASON_NO_LOT);
    }
    let bought = quantity;
    let cash = match buy_cash(run, capital, quantity, open) {
        Ok(cash) => cash,
        Err(failure) => return failed("the cost of the buy overflows", &failure),
    };
    let cash = Q::from_decimal(&cash);
    let mut entitlements = Q::zero();
    let mut equities = Vec::new();
    let before_buy = Q::from_decimal(&capital);
    for _ in input.scored_start..buy_index {
        equities.push(before_buy.clone());
    }
    for index in buy_index..=input.last {
        let Some(session) = input.sessions.get(index) else {
            return unavailable("the calendar ends before the scored window does");
        };
        if index > buy_index {
            // Actions take effect before the open, on the quantity held at its start. A split of
            // the same day does not change the entitlement of a dividend of the same day.
            let held_before = quantity;
            for action in &input.actions {
                if action.effective_session != session.date {
                    continue;
                }
                match &action.kind {
                    ActionKind::Split { new, old } => match split_quantity(quantity, *new, *old) {
                        Some(next) => quantity = next,
                        None => {
                            return unavailable(format!(
                                "a {new} for {old} split {} on {} leaves a fractional share count",
                                action.id, session.date
                            ));
                        }
                    },
                    ActionKind::CashDividend {
                        amount_per_share, ..
                    } => {
                        match dividend_entitlement(&input.policy, held_before, *amount_per_share) {
                            Ok(amount) => {
                                entitlements = &entitlements + &Q::from_decimal(&amount);
                            }
                            Err(failure) => {
                                return failed("a dividend entitlement overflows", &failure);
                            }
                        }
                    }
                    ActionKind::Unsupported { kind } => {
                        return unavailable(format!(
                            "corporate action {} of kind {kind} on {} is not supported",
                            action.id, session.date
                        ));
                    }
                }
            }
        }
        let Some(bar) = input.bars.get(&session.date) else {
            return unavailable(format!("no bar to value the position at {}", session.date));
        };
        let holding = &Q::from_decimal(&quantity) * &Q::from_decimal(&bar.close);
        equities.push(&(&cash + &entitlements) + &holding);
    }
    BuyAndHold::Computed(HoldPath {
        entry_session: buy_session.date.clone(),
        quantity: bought,
        equities,
    })
}

/// Cash after the buy: the capital less the notional and the fee.
fn buy_cash(
    run: &Run,
    capital: Decimal,
    quantity: Decimal,
    open: Decimal,
) -> Result<Decimal, Failure> {
    let notional = exact_mul(quantity, open)?;
    let fee = fee_for(run, notional)?;
    exact_sub(exact_sub(capital, notional)?, fee)
}

/// The shares after a split, or `None` when the result is not a whole number.
fn split_quantity(quantity: Decimal, new: u64, old: u64) -> Option<Decimal> {
    let scaled = quantity.checked_mul(Decimal::from(new))?;
    let converted = scaled.checked_div(Decimal::from(old))?;
    converted.is_integer().then_some(converted)
}

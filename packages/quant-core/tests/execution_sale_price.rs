//! A sale whose floored price is not positive (OQ-02 sections 2.5-2.6).
//!
//! The gap price of a stop exit is `floor_to(price_scale)` of `open * (1 - slippage)`. Near the
//! smallest price unit that floor can be 0.00: the sale is then refused with `INVALID_LEVEL`
//! instead of crediting nothing for a position, and the event is discarded like any other
//! failure. A floored price of one price unit is a sale.
//!
//! Every expected number is derived by hand beside its assertion.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

mod execution_support;

use execution_support::*;

/// Bars at 0.06 with a true range of 0.02, a signal at session 4 and an entry at the open of
/// session 5, then a flat session 5 and a gap open at session 6.
///
/// ATR 0.02 (window 1), entry 0.06: stop 0.06 - 2 * 0.02 = 0.02, target 0.06 + 5 * 0.02 = 0.16.
/// Cap 5000.00 / 5 slots = 1000.00 buys floor(1000.00 / 0.06) = 16666 shares for 999.96, so cash
/// after the entry is 4000.04. Session 5 is flat at 0.06 and touches nothing. Gap slippage
/// 5000 bps keeps half of the open.
fn gap_through_the_stop(gap_open: &str) -> Scenario {
    let quiet = || quiet_bar("0.06", "0.07", "0.05", "0.06");
    Scenario::new(vec![
        quiet(),
        quiet(),
        quiet(),
        quiet(),
        signal_bar("0.06", "0.07", "0.05", "0.06"),
        quiet_bar("0.06", "0.06", "0.06", "0.06"),
        quiet_bar(gap_open, gap_open, gap_open, gap_open),
    ])
    .slippage("5000")
}

#[test]
fn a_gap_sale_that_floors_to_one_price_unit_is_a_sale() {
    // Open 0.02 <= stop 0.02: a gap exit. 0.02 * (1 - 0.50) = 0.01 exactly, floor 0.01.
    // 16666 * 0.01 = 166.66, no fee, cash 4000.04 + 166.66 = 4166.70.
    let out = gap_through_the_stop("0.02").evaluate();
    assert_eq!(out.status(), "COMPLETED");
    assert_eq!(
        fill_row(&out.fills()[0]),
        format!(
            "{} OPEN BUY 16666@0.06 fee=0.00 delta=-999.96 ENTRY",
            date(5)
        )
    );
    assert_eq!(
        fill_row(&out.fills()[1]),
        format!(
            "{} OPEN SELL 16666@0.01 fee=0.00 delta=166.66 GAP_STOP",
            date(6)
        )
    );
    assert_eq!(out.trades()[0]["exit_reason"], "GAP_STOP");
    assert_dec(&out.trades()[0]["exit_price"], "0.01");
    assert_dec(&out.daily_of(6)["cash_available"], "4166.70");
}

#[test]
fn a_gap_sale_that_floors_to_zero_is_an_invalid_level_and_the_event_is_discarded() {
    // Open 0.01 <= stop 0.02: a gap exit. 0.01 * (1 - 0.50) = 0.005, floor 0.00: not a price.
    let out = gap_through_the_stop("0.01").evaluate();
    assert_eq!(out.status(), "FAILED");
    assert_eq!(out.code(), "INVALID_LEVEL");
    assert_eq!(out.text("/outcome/at/session"), date(6));
    assert_eq!(out.text("/outcome/at/phase"), "OPEN");
    assert_eq!(
        out.text("/outcome/detail"),
        "exit price 0.00 is not positive"
    );
    // Only the entry is journaled. The position is still held at the last completed state, with
    // the cash of the entry, and the trade is still open.
    assert_eq!(out.fills().len(), 1);
    assert_eq!(out.trades().len(), 1);
    assert_eq!(out.trades()[0]["exit_reason"], "OPEN_AT_END");
    assert!(out.trades()[0].get("exit_price").is_none());
    assert_eq!(out.len("/final/open_positions"), 1);
    assert_dec(out.at("/final/open_positions/0/quantity"), "16666");
    assert_dec(&out.daily_of(5)["cash_available"], "4000.04");
    // The same input runs the same way when restored from every cut before the failure.
    let events = out.run.events().unwrap();
    let failing = event_index(&out.run, 6, "OPEN");
    for cut in 0..=failing {
        let prefix = state_after(&out.run, cut);
        let (_, checkpoint) = round_trip(&out.run, &prefix);
        let restored = out.run.restore(&checkpoint).unwrap();
        let (_, failure) = out.run.run_events(restored, &events[cut..]);
        let failure = failure.expect("the sale still fails");
        assert_eq!(failure.code.to_string(), "INVALID_LEVEL", "cut {cut}");
        assert_eq!(
            failure.detail, "exit price 0.00 is not positive",
            "cut {cut}"
        );
    }
}

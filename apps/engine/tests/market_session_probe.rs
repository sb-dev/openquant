//! The session probe: a daily bar against the regular-hours minute bars of its session.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use openquant_engine::market::{
    gate::Fact,
    number::DecimalText,
    provider::ProviderBar,
    session::{BarField, SessionProbe, compare_daily_with_regular_minutes},
    time::Timestamp,
};

type Change = fn(&mut ProviderBar);

fn number(text: &str) -> DecimalText {
    DecimalText::from_json_number(text).unwrap()
}

fn bar(start: &str, o: &str, h: &str, l: &str, c: &str, v: &str) -> ProviderBar {
    ProviderBar {
        start: Timestamp::parse(start).unwrap(),
        open: number(o),
        high: number(h),
        low: number(l),
        close: number(c),
        volume: number(v),
    }
}

/// The regular session of Monday 2024-03-04: 14:30Z to 21:00Z in standard time.
fn window() -> (Timestamp, Timestamp) {
    (
        Timestamp::parse("2024-03-04T14:30:00Z").unwrap(),
        Timestamp::parse("2024-03-04T21:00:00Z").unwrap(),
    )
}

/// Three minute bars inside the session, by hand: first open 100.00, high 102.50, low 99.25,
/// last close 101.75, volume 1000 + 2500 + 500 = 4000.
fn minutes() -> Vec<ProviderBar> {
    vec![
        bar(
            "2024-03-04T14:30:00Z",
            "100.00",
            "101",
            "99.5",
            "100.5",
            "1000",
        ),
        bar(
            "2024-03-04T15:00:00Z",
            "100.5",
            "102.5",
            "99.25",
            "101",
            "2500",
        ),
        bar(
            "2024-03-04T20:59:00Z",
            "101",
            "101.8",
            "100.9",
            "101.75",
            "500",
        ),
    ]
}

fn daily() -> ProviderBar {
    bar(
        "2024-03-04T05:00:00Z",
        "100",
        "102.5",
        "99.25",
        "101.75",
        "4000",
    )
}

fn compare(daily: &ProviderBar, minutes: &[ProviderBar]) -> SessionProbe {
    let (open, close) = window();
    compare_daily_with_regular_minutes(daily, minutes, open, close).unwrap()
}

#[test]
fn a_daily_bar_equal_to_its_minutes_matches() {
    assert_eq!(compare(&daily(), &minutes()), SessionProbe::Matches);
}

#[test]
fn the_comparison_is_by_value_not_by_text() {
    let mut same = daily();
    same.open = number("1e2");
    same.volume = number("4000.0");
    assert_eq!(compare(&same, &minutes()), SessionProbe::Matches);
}

#[test]
fn each_field_that_differs_is_named() {
    let cases: [(Change, BarField); 5] = [
        (|b| b.open = number("100.01"), BarField::Open),
        (|b| b.high = number("102.51"), BarField::High),
        (|b| b.low = number("99.24"), BarField::Low),
        (|b| b.close = number("101.7500001"), BarField::Close),
        (|b| b.volume = number("4001"), BarField::Volume),
    ];
    for (change, field) in cases {
        let mut changed = daily();
        change(&mut changed);
        assert_eq!(
            compare(&changed, &minutes()),
            SessionProbe::Differs(vec![field]),
            "{field:?}"
        );
    }
    let mut all = daily();
    all.open = number("1");
    all.close = number("1");
    assert_eq!(
        compare(&all, &minutes()),
        SessionProbe::Differs(vec![BarField::Open, BarField::Close])
    );
}

#[test]
fn minute_bars_outside_the_regular_session_are_ignored() {
    // Pre-market and after-hours bars have prices and volume of their own. A daily bar that includes
    // them would differ; one that excludes them matches the regular session alone.
    let mut with_extended = minutes();
    with_extended.insert(
        0,
        bar("2024-03-04T13:00:00Z", "98", "110", "90", "99", "9000"),
    );
    with_extended.push(bar(
        "2024-03-04T21:00:00Z",
        "101.75",
        "120",
        "101",
        "119",
        "7000",
    ));
    assert_eq!(compare(&daily(), &with_extended), SessionProbe::Matches);
    let mut including = daily();
    including.volume = number("20000");
    assert_eq!(
        compare(&including, &with_extended),
        SessionProbe::Differs(vec![BarField::Volume])
    );
}

#[test]
fn the_window_is_closed_at_the_open_and_open_at_the_close() {
    // A bar that starts exactly at the close belongs to the next phase; one at the open is inside.
    let at_close = vec![bar("2024-03-04T21:00:00Z", "5", "5", "5", "5", "5")];
    assert_eq!(compare(&daily(), &at_close), SessionProbe::NoMinutes);
    let at_open = vec![bar(
        "2024-03-04T14:30:00Z",
        "100",
        "102.5",
        "99.25",
        "101.75",
        "4000",
    )];
    assert_eq!(compare(&daily(), &at_open), SessionProbe::Matches);
}

#[test]
fn minute_bars_are_taken_in_time_order_whatever_the_input_order() {
    let mut shuffled = minutes();
    shuffled.reverse();
    assert_eq!(compare(&daily(), &shuffled), SessionProbe::Matches);
}

#[test]
fn no_minute_bar_in_the_session_compares_nothing() {
    assert_eq!(compare(&daily(), &[]), SessionProbe::NoMinutes);
    let outside = vec![bar("2024-03-04T13:00:00Z", "1", "1", "1", "1", "1")];
    assert_eq!(compare(&daily(), &outside), SessionProbe::NoMinutes);
    assert_eq!(SessionProbe::NoMinutes.into_fact(), Fact::Unverified);
}

#[test]
fn only_an_exact_match_verifies_the_session_semantics() {
    assert_eq!(SessionProbe::Matches.into_fact(), Fact::Verified);
    let mut changed = daily();
    changed.close = number("101.80");
    let fact = compare(&changed, &minutes()).into_fact();
    match fact {
        Fact::Failed(text) => assert!(text.contains("close"), "{text}"),
        other => panic!("{other:?}"),
    }
}

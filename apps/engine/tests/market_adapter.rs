//! The Alpaca adapter: requests, pagination, typed errors, retries, the request budget and the
//! secrecy of the credentials.
//!
//! The `E-*` cases play scripted provider failures through the whole retrieval and compare the call
//! log, the waits and the typed error with the oracle. The other tests drive the adapter directly
//! with small inline bodies, so each rule is pinned where it lives. The expected requests are
//! written out by hand from the endpoint list in `alpaca.rs`, not read back from the adapter.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

mod market_support;

use market_support::{
    CancelFlag, KEY_ID, SECRET, ScriptedTransport, SimClock, SimSleeper, Step, check_case,
};
use openquant_engine::market::{
    alpaca::{AlpacaAdapter, CAPABILITIES, EGRESS_RULES},
    error::{ErrorClass, Operation, ProviderError},
    http::{Credentials, Host, HttpRequest, TransportError},
    provider::{
        ActionQuery, BarQuery, CallContext, DateRange, Feed, Limits, MarketDataProvider,
        ProviderActionKind,
    },
    time::{Date, Timestamp},
};
use std::time::Duration;

const NOW: &str = "2026-11-14T10:00:00Z";
const ASSET: &str = r#"{"id":"00000000-0000-4000-8000-000000000001","class":"us_equity","symbol":"SYNTH","status":"active","name":"Synthetic","tradable":true}"#;
const CALENDAR: &str = r#"[{"date":"2024-03-04","open":"09:30","close":"16:00","session_open":"0400"},{"date":"2024-03-05","open":"09:30","close":"16:00"}]"#;
const BAR: &str = r#"{"t":"2024-03-04T05:00:00Z","o":100.10,"h":101,"l":99.5,"c":100.5,"v":1000,"n":3,"vw":100.2}"#;

fn bars_page(items: &[&str], token: Option<&str>) -> String {
    let token = token.map_or("null".to_owned(), |t| format!("\"{t}\""));
    format!(
        r#"{{"bars":[{}],"symbol":"SYNTH","next_page_token":{token}}}"#,
        items.join(",")
    )
}

fn bar_at(stamp: &str) -> String {
    format!(r#"{{"t":"{stamp}","o":100,"h":101,"l":99,"c":100.5,"v":1000}}"#)
}

fn limits(max_requests: u32, max_retries: u32) -> Limits {
    Limits {
        max_requests,
        max_retries,
        request_timeout: Duration::from_secs(30),
        max_response_bytes: 1 << 20,
        deadline: Timestamp::parse("2026-11-14T10:15:00Z").unwrap(),
    }
}

/// An adapter over `steps`, a context with the given budget and the pieces a test reads.
macro_rules! rig {
    ($steps:expr, $max_requests:expr, $max_retries:expr => $adapter:ident, $cx:ident, $sleeper:ident, $cancel:ident) => {
        let clock = SimClock::at(Timestamp::parse(NOW).unwrap());
        let $sleeper = SimSleeper::new(&clock);
        let $cancel = CancelFlag::default();
        let $adapter = AlpacaAdapter::new(
            ScriptedTransport::new($steps),
            Credentials::new(KEY_ID, SECRET),
        );
        let mut $cx = CallContext::new(
            limits($max_requests, $max_retries),
            &clock,
            &$sleeper,
            &$cancel,
        );
    };
}

fn bar_query() -> BarQuery {
    BarQuery {
        symbol: "SYNTH".to_owned(),
        feed: Feed::Sip,
        start: Timestamp::parse("2024-03-04T00:00:00Z").unwrap(),
        end: Timestamp::parse("2024-03-05T23:59:59Z").unwrap(),
    }
}

fn range() -> DateRange {
    DateRange {
        start: Date::parse("2024-03-04").unwrap(),
        end: Date::parse("2024-03-08").unwrap(),
    }
}

fn pairs(items: &[(&str, &str)]) -> Vec<(String, String)> {
    items
        .iter()
        .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
        .collect()
}

case_tests! {
    e01_401 => "E-01-401",
    e02_403 => "E-02-403",
    e03_429_then_ok => "E-03-429-then-ok",
    e04_429_exhausted => "E-04-429-exhausted",
    e05_503_then_ok => "E-05-503-then-ok",
    e06_redirect => "E-06-redirect",
    e07_malformed_json => "E-07-malformed-json",
    e08_truncated_body => "E-08-truncated-body",
    e09_wrong_shape => "E-09-wrong-shape",
    e10_repeated_token => "E-10-repeated-token",
    e11_quoted_number => "E-11-quoted-number",
    e12_duplicate_key => "E-12-duplicate-key",
    e13_budget_ends_mid_pagination => "E-13-budget-ends-mid-pagination",
    e14_retry_after_past_deadline => "E-14-retry-after-past-deadline",
    e15_response_too_large => "E-15-response-too-large",
    e16_egress_refused => "E-16-egress-refused",
}

#[test]
fn the_error_cases_are_all_run() {
    let ids: Vec<String> = market_support::indexed_case_ids()
        .into_iter()
        .filter(|id| id.starts_with("E-"))
        .collect();
    assert_eq!(ids.len(), 16);
    for (index, id) in ids.iter().enumerate() {
        assert!(id.starts_with(&format!("E-{:02}-", index + 1)), "{id}");
    }
    check_case("E-01-401");
}

#[test]
fn the_five_endpoints_build_the_requests_the_provider_reference_names() {
    let steps = vec![
        Step::ok(ASSET),
        Step::ok(CALENDAR),
        Step::ok(&bars_page(&[BAR], None)),
        Step::ok(&bars_page(&[], None)),
        Step::ok(r#"{"corporate_actions":{},"next_page_token":null}"#),
    ];
    rig!(steps, 10, 0 => adapter, cx, sleeper, cancel);
    adapter.asset(&mut cx, "SYNTH").unwrap();
    adapter.calendar(&mut cx, range()).unwrap();
    adapter.daily_bars(&mut cx, &bar_query()).unwrap();
    let iex = BarQuery {
        feed: Feed::Iex,
        ..bar_query()
    };
    adapter.minute_bars(&mut cx, &iex).unwrap();
    adapter
        .corporate_actions(
            &mut cx,
            &ActionQuery {
                symbol: "SYNTH".to_owned(),
                range: range(),
            },
        )
        .unwrap();
    let seen = adapter.transport().seen();
    let requests: Vec<_> = seen
        .iter()
        .map(|s| {
            (
                s.request.host,
                s.request.path.as_str(),
                s.request.query.clone(),
            )
        })
        .collect();
    assert_eq!(
        requests,
        vec![
            (Host::Paper, "/v2/assets/SYNTH", vec![]),
            (
                Host::Paper,
                "/v2/calendar",
                pairs(&[("start", "2024-03-04"), ("end", "2024-03-08")])
            ),
            (
                Host::Data,
                "/v2/stocks/SYNTH/bars",
                pairs(&[
                    ("timeframe", "1Day"),
                    ("start", "2024-03-04T00:00:00Z"),
                    ("end", "2024-03-05T23:59:59Z"),
                    ("limit", "10000"),
                    ("adjustment", "raw"),
                    ("feed", "sip"),
                    ("sort", "asc"),
                ])
            ),
            (
                Host::Data,
                "/v2/stocks/SYNTH/bars",
                pairs(&[
                    ("timeframe", "1Min"),
                    ("start", "2024-03-04T00:00:00Z"),
                    ("end", "2024-03-05T23:59:59Z"),
                    ("limit", "10000"),
                    ("adjustment", "raw"),
                    ("feed", "iex"),
                    ("sort", "asc"),
                ])
            ),
            (
                Host::Data,
                "/v1/corporate-actions",
                pairs(&[
                    ("symbols", "SYNTH"),
                    ("start", "2024-03-04"),
                    ("end", "2024-03-08"),
                    ("limit", "1000"),
                ])
            ),
        ]
    );
    // Every request is inside the egress allowlist, and none carries a credential in its target.
    for item in &seen {
        assert!(
            EGRESS_RULES.iter().any(|rule| rule.allows(&item.request)),
            "{:?}",
            item.request
        );
        let target = format!("{:?}", item.request);
        assert!(!target.contains(KEY_ID) && !target.contains(SECRET));
    }
    assert_eq!(cx.requests_made(), 5);
}

#[test]
fn a_symbol_that_is_not_a_ticker_is_refused_before_any_request() {
    for symbol in [
        "",
        "aapl",
        "../v2/account",
        "A/B",
        "AAPL?x=1",
        "A B",
        "ABCDEFGHIJK",
    ] {
        rig!(vec![], 10, 0 => adapter, cx, sleeper, cancel);
        let query = BarQuery {
            symbol: symbol.to_owned(),
            ..bar_query()
        };
        assert!(
            matches!(
                adapter.asset(&mut cx, symbol),
                Err(ProviderError::InvalidRequest { .. })
            ),
            "{symbol}"
        );
        assert!(matches!(
            adapter.daily_bars(&mut cx, &query),
            Err(ProviderError::InvalidRequest { .. })
        ));
        assert!(matches!(
            adapter.minute_bars(&mut cx, &query),
            Err(ProviderError::InvalidRequest { .. })
        ));
        let actions = ActionQuery {
            symbol: symbol.to_owned(),
            range: range(),
        };
        assert!(matches!(
            adapter.corporate_actions(&mut cx, &actions),
            Err(ProviderError::InvalidRequest { .. })
        ));
        assert!(
            adapter.transport().seen().is_empty(),
            "{symbol}: no request left the adapter"
        );
        assert_eq!(cx.requests_made(), 0);
    }
}

#[test]
fn a_range_that_ends_before_it_starts_is_refused_before_any_request() {
    rig!(vec![], 10, 0 => adapter, cx, sleeper, cancel);
    let backwards = DateRange {
        start: range().end,
        end: range().start,
    };
    assert!(adapter.calendar(&mut cx, backwards).is_err());
    let query = BarQuery {
        start: bar_query().end,
        end: bar_query().start,
        ..bar_query()
    };
    assert!(adapter.daily_bars(&mut cx, &query).is_err());
    assert!(
        adapter
            .corporate_actions(
                &mut cx,
                &ActionQuery {
                    symbol: "SYNTH".to_owned(),
                    range: backwards
                }
            )
            .is_err()
    );
    assert!(adapter.transport().seen().is_empty());
}

/// Run one failing answer and return the error, the number of requests and the waits.
fn fail_with(step: Step, max_retries: u32) -> (ProviderError, usize, Vec<u64>) {
    let steps = vec![step.clone(), step.clone(), step.clone(), step];
    rig!(steps, 10, max_retries => adapter, cx, sleeper, cancel);
    let error = adapter.asset(&mut cx, "SYNTH").unwrap_err();
    let waits = sleeper.waits.borrow().clone();
    (error, adapter.transport().seen().len(), waits)
}

#[test]
fn the_status_codes_map_to_typed_errors_and_only_transient_ones_are_retried() {
    // (status, error code, class, retried)
    let table = [
        (401, "AUTHENTICATION", ErrorClass::Authentication, false),
        (403, "PERMISSION", ErrorClass::Permission, false),
        (404, "NOT_FOUND", ErrorClass::UnavailableData, false),
        (400, "BAD_REQUEST", ErrorClass::UnsupportedCapability, false),
        (422, "BAD_REQUEST", ErrorClass::UnsupportedCapability, false),
        (301, "REDIRECT_REFUSED", ErrorClass::EgressRefused, false),
        (302, "REDIRECT_REFUSED", ErrorClass::EgressRefused, false),
        (307, "REDIRECT_REFUSED", ErrorClass::EgressRefused, false),
        (308, "REDIRECT_REFUSED", ErrorClass::EgressRefused, false),
        (
            100,
            "UNEXPECTED_STATUS",
            ErrorClass::MalformedResponse,
            false,
        ),
        (408, "SERVER", ErrorClass::UnavailableData, true),
        (429, "RATE_LIMITED", ErrorClass::RateLimited, true),
        (500, "SERVER", ErrorClass::UnavailableData, true),
        (502, "SERVER", ErrorClass::UnavailableData, true),
        (503, "SERVER", ErrorClass::UnavailableData, true),
        (504, "SERVER", ErrorClass::UnavailableData, true),
    ];
    for (status, code, class, retried) in table {
        let (error, requests, waits) = fail_with(Step::status(status, "{}"), 2);
        assert_eq!(
            (error.code(), error.class()),
            (code, class),
            "status {status}"
        );
        assert_eq!(error.retryable(), retried, "status {status}");
        // Two retries after the first attempt, or no retry at all.
        assert_eq!(requests, if retried { 3 } else { 1 }, "status {status}");
        assert_eq!(
            waits,
            if retried { vec![1, 2] } else { vec![] },
            "status {status}"
        );
    }
}

#[test]
fn a_transport_failure_is_classified_and_only_a_transient_one_is_retried() {
    let table = [
        (
            TransportError::Timeout,
            "TIMEOUT",
            ErrorClass::Timeout,
            true,
        ),
        (
            TransportError::Connection,
            "CONNECTION",
            ErrorClass::UnavailableData,
            true,
        ),
        (
            TransportError::EgressRefused,
            "EGRESS_REFUSED",
            ErrorClass::EgressRefused,
            false,
        ),
        (
            TransportError::BodyTooLarge,
            "RESPONSE_TOO_LARGE",
            ErrorClass::MalformedResponse,
            false,
        ),
    ];
    for (failure, code, class, retried) in table {
        let step = Step {
            expect: None,
            reply: market_support::Reply::Transport(failure),
        };
        let (error, requests, _) = fail_with(step, 1);
        assert_eq!(
            (error.code(), error.class(), error.retryable()),
            (code, class, retried),
            "{failure}"
        );
        assert_eq!(requests, if retried { 2 } else { 1 }, "{failure}");
    }
}

#[test]
fn retry_after_in_seconds_is_preserved_in_the_error_and_waited_for() {
    let rate = Step::status(429, "").with_header("retry-after", "7");
    let (error, requests, waits) = fail_with(rate, 1);
    assert_eq!(
        error,
        ProviderError::RateLimited {
            retry_after_seconds: Some(7)
        }
    );
    assert_eq!((requests, waits), (2, vec![7]));
}

#[test]
fn retry_after_as_an_http_date_is_a_delay_from_the_clock() {
    // The clock is 10:00:00Z; the date is nine seconds later.
    let rate = Step::status(429, "").with_header("retry-after", "Sat, 14 Nov 2026 10:00:09 GMT");
    rig!(vec![rate, Step::ok(ASSET)], 10, 1 => adapter, cx, sleeper, cancel);
    adapter.asset(&mut cx, "SYNTH").unwrap();
    assert_eq!(*sleeper.waits.borrow(), vec![9]);
    assert_eq!(
        cx.calls()[0].retry_after_seconds,
        Some(9),
        "the hint is preserved in the call log"
    );
    assert_eq!(cx.calls()[1].started_at.to_string(), "2026-11-14T10:00:09Z");
    // A date in the past is no wait beyond the backoff.
    let past = Step::status(429, "").with_header("retry-after", "Sat, 14 Nov 2026 09:00:00 GMT");
    let (error, _, waits) = fail_with(past, 1);
    assert_eq!(error.retry_after_seconds(), Some(0));
    assert_eq!(waits, vec![1]);
}

#[test]
fn retry_after_is_capped_at_a_day_and_never_waited_for_past_the_deadline() {
    let rate = Step::status(429, "").with_header("retry-after", "999999");
    let (error, requests, waits) = fail_with(rate, 3);
    assert_eq!(error.retry_after_seconds(), Some(86_400));
    assert_eq!(
        (requests, waits),
        (1, vec![]),
        "a day is past the 15 minute deadline"
    );
}

#[test]
fn an_unreadable_retry_after_falls_back_to_the_backoff_and_keeps_no_hint() {
    for text in ["soon", "-5", "1.5", ""] {
        let rate = Step::status(429, "").with_header("retry-after", text);
        let (error, _, waits) = fail_with(rate, 1);
        assert_eq!(error.retry_after_seconds(), None, "{text:?}");
        assert_eq!(waits, vec![1], "{text:?}");
    }
}

#[test]
fn the_backoff_doubles_and_the_retries_stop_at_max_retries() {
    let (error, requests, waits) = fail_with(Step::status(503, ""), 3);
    assert_eq!(error, ProviderError::Server { status: 503 });
    assert_eq!((requests, waits), (4, vec![1, 2, 4]));
}

#[test]
fn a_retry_that_succeeds_returns_the_data_and_records_both_calls() {
    let steps = vec![Step::status(503, ""), Step::ok(ASSET)];
    rig!(steps, 10, 2 => adapter, cx, sleeper, cancel);
    let asset = adapter.asset(&mut cx, "SYNTH").unwrap();
    assert_eq!(
        (asset.symbol.as_str(), asset.class.as_str()),
        ("SYNTH", "us_equity")
    );
    let statuses: Vec<(Option<u16>, Option<ErrorClass>)> = cx
        .calls()
        .iter()
        .map(|c| (c.http_status, c.error))
        .collect();
    assert_eq!(
        statuses,
        vec![
            (Some(503), Some(ErrorClass::UnavailableData)),
            (Some(200), None)
        ]
    );
    assert_eq!(cx.sources().len(), 1, "only the successful body is kept");
}

#[test]
fn the_budget_is_reserved_before_any_io_and_a_failed_attempt_counts() {
    // Two requests are allowed. A third is refused before the transport is touched.
    rig!(vec![Step::ok(ASSET), Step::ok(ASSET), Step::ok(ASSET)], 2, 0 => adapter, cx, sleeper, cancel);
    adapter.asset(&mut cx, "SYNTH").unwrap();
    adapter.asset(&mut cx, "SYNTH").unwrap();
    assert_eq!(
        adapter.asset(&mut cx, "SYNTH"),
        Err(ProviderError::RequestLimitReached { max_requests: 2 })
    );
    assert_eq!(adapter.transport().seen().len(), 2);
    assert_eq!(adapter.transport().unconsumed(), 1);
    // A failed attempt and its retry use the same budget. When the budget is gone the transient
    // failure stands (it is the cause) and no wait is spent on a request that would be refused.
    rig!(vec![Step::status(503, ""), Step::status(503, ""), Step::ok(ASSET)], 2, 5 => adapter, cx, sleeper, cancel);
    assert_eq!(
        adapter.asset(&mut cx, "SYNTH"),
        Err(ProviderError::Server { status: 503 })
    );
    assert_eq!(cx.calls().len(), 2);
    assert_eq!(adapter.transport().seen().len(), 2);
    assert_eq!(
        *sleeper.waits.borrow(),
        vec![1],
        "one wait for the one retry that was allowed"
    );
    assert_eq!(adapter.transport().unconsumed(), 1);
}

#[test]
fn a_cancelled_retrieval_makes_no_request() {
    rig!(vec![Step::ok(ASSET)], 10, 0 => adapter, cx, sleeper, cancel);
    cancel.set();
    assert_eq!(
        adapter.asset(&mut cx, "SYNTH"),
        Err(ProviderError::Cancelled)
    );
    assert!(adapter.transport().seen().is_empty());
    assert!(cx.calls().is_empty());
    assert!(!ProviderError::Cancelled.retryable());
    assert_eq!(ProviderError::Cancelled.class(), ErrorClass::Cancelled);
}

#[test]
fn cancellation_between_pages_stops_the_chain_and_returns_no_partial_data() {
    let steps = vec![
        Step::ok(&bars_page(&[BAR], Some("tok-2"))),
        Step::ok(&bars_page(&[&bar_at("2024-03-05T05:00:00Z")], None)),
    ];
    let cancel = CancelFlag::default();
    let clock = SimClock::at(Timestamp::parse(NOW).unwrap());
    let sleeper = SimSleeper::new(&clock);
    let transport = ScriptedTransport::new(steps).cancel_while_answering(1, &cancel);
    let adapter = AlpacaAdapter::new(transport, Credentials::new(KEY_ID, SECRET));
    let mut cx = CallContext::new(limits(10, 0), &clock, &sleeper, &cancel);
    assert_eq!(
        adapter.daily_bars(&mut cx, &bar_query()),
        Err(ProviderError::Cancelled)
    );
    assert_eq!(adapter.transport().seen().len(), 1);
    assert_eq!(adapter.transport().unconsumed(), 1);
}

#[test]
fn nothing_starts_after_the_deadline() {
    let clock = SimClock::at(Timestamp::parse(NOW).unwrap());
    let sleeper = SimSleeper::new(&clock);
    let cancel = CancelFlag::default();
    let adapter = AlpacaAdapter::new(
        ScriptedTransport::new(vec![Step::ok(ASSET)]),
        Credentials::new(KEY_ID, SECRET),
    );
    let late = Limits {
        deadline: Timestamp::parse("2026-11-14T09:59:59Z").unwrap(),
        ..limits(10, 0)
    };
    let mut cx = CallContext::new(late, &clock, &sleeper, &cancel);
    assert_eq!(
        adapter.asset(&mut cx, "SYNTH"),
        Err(ProviderError::DeadlineExceeded)
    );
    assert!(adapter.transport().seen().is_empty());
    assert_eq!(ProviderError::DeadlineExceeded.class(), ErrorClass::Timeout);
}

#[test]
fn pages_are_followed_in_order_with_their_tokens_and_each_is_one_call() {
    let day = |n: u32| bar_at(&format!("2024-03-{n:02}T05:00:00Z"));
    let steps = vec![
        Step::ok(&bars_page(&[&day(4)], Some("t2"))),
        Step::ok(&bars_page(&[&day(5)], Some("t3"))),
        Step::ok(&bars_page(&[&day(6)], None)),
    ];
    rig!(steps, 10, 0 => adapter, cx, sleeper, cancel);
    let query = BarQuery {
        end: Timestamp::parse("2024-03-08T23:59:59Z").unwrap(),
        ..bar_query()
    };
    let bars = adapter.daily_bars(&mut cx, &query).unwrap();
    let starts: Vec<String> = bars.iter().map(|b| b.start.to_string()).collect();
    assert_eq!(
        starts,
        [
            "2024-03-04T05:00:00Z",
            "2024-03-05T05:00:00Z",
            "2024-03-06T05:00:00Z"
        ]
    );
    let tokens: Vec<Option<&str>> = adapter
        .transport()
        .seen()
        .iter()
        .map(|s| s.request.query_value("page_token").map(str::to_owned))
        .collect::<Vec<_>>()
        .iter()
        .map(|t| t.as_deref().map(|_| "set"))
        .collect();
    assert_eq!(tokens, vec![None, Some("set"), Some("set")]);
    let sent: Vec<String> = adapter
        .transport()
        .seen()
        .iter()
        .filter_map(|s| s.request.query_value("page_token").map(str::to_owned))
        .collect();
    assert_eq!(sent, ["t2", "t3"]);
    assert_eq!((cx.requests_made(), cx.sources().len()), (3, 3));
}

#[test]
fn an_empty_or_repeated_token_is_a_malformed_response_and_its_call_is_marked_failed() {
    for (first, second) in [(Some(""), None), (Some("again"), Some("again"))] {
        let steps = vec![
            Step::ok(&bars_page(&[BAR], first)),
            Step::ok(&bars_page(&[&bar_at("2024-03-05T05:00:00Z")], second)),
        ];
        rig!(steps, 10, 0 => adapter, cx, sleeper, cancel);
        let error = adapter.daily_bars(&mut cx, &bar_query()).unwrap_err();
        assert_eq!(error.code(), "MALFORMED_RESPONSE", "{first:?} {second:?}");
        let last = cx.calls().last().unwrap();
        assert_eq!(last.error, Some(ErrorClass::MalformedResponse));
        assert!(
            cx.sources().len() < cx.calls().len(),
            "the unusable body is not kept as a source"
        );
    }
}

#[test]
fn an_empty_result_is_not_an_error_but_a_missing_member_is() {
    for body in [
        r#"{"bars":null,"symbol":"SYNTH","next_page_token":null}"#,
        r#"{"bars":[],"symbol":"SYNTH","next_page_token":null}"#,
        r#"{"bars":[]}"#,
    ] {
        rig!(vec![Step::ok(body)], 10, 0 => adapter, cx, sleeper, cancel);
        assert_eq!(
            adapter.daily_bars(&mut cx, &bar_query()).unwrap(),
            vec![],
            "{body}"
        );
    }
    for body in [
        r#"{}"#,
        r#"{"symbol":"SYNTH"}"#,
        r#"[]"#,
        r#"null"#,
        r#""bars""#,
        "",
    ] {
        rig!(vec![Step::ok(body)], 10, 0 => adapter, cx, sleeper, cancel);
        assert_eq!(
            adapter
                .daily_bars(&mut cx, &bar_query())
                .unwrap_err()
                .code(),
            "MALFORMED_RESPONSE",
            "{body:?}"
        );
    }
}

#[test]
fn unknown_fields_are_ignored_and_numbers_keep_their_exact_text() {
    // A provider adds fields over time; the adapter reads what it needs and nothing is coerced.
    let body = r#"{"bars":[{"t":"2024-03-04T05:00:00Z","o":123456789.12345678901234567,"h":1E3,"l":0.0000001,"c":100.10,"v":1.5e3,"n":7,"vw":1.0,"x":{"y":[1,2]}}],"next_page_token":null,"extra":true}"#;
    rig!(vec![Step::ok(body)], 10, 0 => adapter, cx, sleeper, cancel);
    let bars = adapter.daily_bars(&mut cx, &bar_query()).unwrap();
    let bar = &bars[0];
    assert_eq!(bar.open.as_str(), "123456789.12345678901234567");
    assert_eq!(bar.high.as_str(), "1000");
    assert_eq!(bar.low.as_str(), "0.0000001");
    assert_eq!(bar.close.as_str(), "100.1");
    assert_eq!(bar.volume.as_str(), "1500");
}

#[test]
fn a_number_that_is_not_a_json_number_is_a_malformed_response() {
    for field in [
        r#""o":"100.00""#,
        r#""o":null"#,
        r#""o":true"#,
        r#""o":[100]"#,
        r#""o":-0"#,
        r#""o":1e999"#,
        r#""o":0x10"#,
    ] {
        let body = format!(
            r#"{{"bars":[{{"t":"2024-03-04T05:00:00Z",{field},"h":101,"l":99,"c":100,"v":1}}],"next_page_token":null}}"#
        );
        rig!(vec![Step::ok(&body)], 10, 0 => adapter, cx, sleeper, cancel);
        assert_eq!(
            adapter
                .daily_bars(&mut cx, &bar_query())
                .unwrap_err()
                .code(),
            "MALFORMED_RESPONSE",
            "{field}"
        );
    }
}

#[test]
fn bars_outside_the_range_or_out_of_order_are_malformed() {
    let outside = [
        bars_page(&[&bar_at("2024-03-03T05:00:00Z")], None),
        bars_page(&[&bar_at("2024-03-06T05:00:00Z")], None),
    ];
    for body in outside {
        rig!(vec![Step::ok(&body)], 10, 0 => adapter, cx, sleeper, cancel);
        assert_eq!(
            adapter
                .daily_bars(&mut cx, &bar_query())
                .unwrap_err()
                .code(),
            "MALFORMED_RESPONSE",
            "{body}"
        );
    }
    let unordered = bars_page(
        &[
            &bar_at("2024-03-05T05:00:00Z"),
            &bar_at("2024-03-04T05:00:00Z"),
        ],
        None,
    );
    rig!(vec![Step::ok(&unordered)], 10, 0 => adapter, cx, sleeper, cancel);
    assert!(adapter.daily_bars(&mut cx, &bar_query()).is_err());
    // Out of order across a page boundary.
    let pages = vec![
        Step::ok(&bars_page(&[&bar_at("2024-03-05T05:00:00Z")], Some("t2"))),
        Step::ok(&bars_page(&[&bar_at("2024-03-04T05:00:00Z")], None)),
    ];
    rig!(pages, 10, 0 => adapter, cx, sleeper, cancel);
    assert!(adapter.daily_bars(&mut cx, &bar_query()).is_err());
    // A bar time that is not an instant at second precision in UTC.
    for stamp in [
        "2024-03-04T05:00:00",
        "2024-03-04T05:00:00+00:00",
        "2024-03-04T05:00:00.5Z",
        "yesterday",
    ] {
        rig!(vec![Step::ok(&bars_page(&[&bar_at(stamp)], None))], 10, 0 => adapter, cx, sleeper, cancel);
        assert!(
            adapter.daily_bars(&mut cx, &bar_query()).is_err(),
            "{stamp}"
        );
    }
}

#[test]
fn minute_bars_keep_any_time_of_day_within_the_range() {
    let body = bars_page(
        &[
            &bar_at("2024-03-04T14:30:00Z"),
            &bar_at("2024-03-04T14:31:00Z"),
        ],
        None,
    );
    rig!(vec![Step::ok(&body)], 10, 0 => adapter, cx, sleeper, cancel);
    let bars = adapter.minute_bars(&mut cx, &bar_query()).unwrap();
    assert_eq!(bars.len(), 2);
    assert_eq!(cx.calls()[0].operation, Operation::MinuteBars);
}

#[test]
fn the_calendar_rejects_weekends_disorder_and_impossible_sessions() {
    let row = |date: &str, open: &str, close: &str| {
        format!(r#"{{"date":"{date}","open":"{open}","close":"{close}"}}"#)
    };
    let bad = [
        format!("[{}]", row("2024-03-09", "09:30", "16:00")),
        format!(
            "[{},{}]",
            row("2024-03-05", "09:30", "16:00"),
            row("2024-03-04", "09:30", "16:00")
        ),
        format!(
            "[{},{}]",
            row("2024-03-04", "09:30", "16:00"),
            row("2024-03-04", "09:30", "16:00")
        ),
        format!("[{}]", row("2024-03-04", "16:00", "09:30")),
        format!("[{}]", row("2024-03-04", "09:30", "09:30")),
        format!("[{}]", row("2024-03-11", "09:30", "16:00")),
        format!("[{}]", row("2024-03-04", "9:30", "16:00")),
        format!("[{}]", row("2024-03-04", "09:30", "25:00")),
        format!("[{}]", row("2024-3-4", "09:30", "16:00")),
        r#"{"calendar":[]}"#.to_owned(),
    ];
    for body in bad {
        rig!(vec![Step::ok(&body)], 10, 0 => adapter, cx, sleeper, cancel);
        assert_eq!(
            adapter.calendar(&mut cx, range()).unwrap_err().code(),
            "MALFORMED_RESPONSE",
            "{body}"
        );
    }
    rig!(vec![Step::ok(CALENDAR)], 10, 0 => adapter, cx, sleeper, cancel);
    let rows = adapter.calendar(&mut cx, range()).unwrap();
    assert_eq!(rows.len(), 2);
    rig!(vec![Step::ok("[]")], 10, 0 => adapter, cx, sleeper, cancel);
    assert!(adapter.calendar(&mut cx, range()).unwrap().is_empty());
}

#[test]
fn the_asset_record_needs_its_identity_fields() {
    for body in [
        r#"{"id":"x"}"#,
        r#"{"id":1,"class":"us_equity","symbol":"SYNTH","status":"active"}"#,
        "[]",
    ] {
        rig!(vec![Step::ok(body)], 10, 0 => adapter, cx, sleeper, cancel);
        assert_eq!(
            adapter.asset(&mut cx, "SYNTH").unwrap_err().code(),
            "MALFORMED_RESPONSE",
            "{body}"
        );
    }
}

fn actions_body(lists: &str) -> String {
    format!(r#"{{"corporate_actions":{{{lists}}},"next_page_token":null}}"#)
}

const DIVIDEND: &str = r#"{"id":"ca-1","symbol":"SYNTH","rate":0.25,"special":false,"foreign":false,"process_date":"2024-03-06","ex_date":"2024-03-06","record_date":"2024-03-07","payable_date":"2024-03-08","declaration_date":"2024-03-01"}"#;

#[test]
fn corporate_actions_keep_every_type_and_every_scalar_field() {
    let split = r#"{"symbol":"SYNTH","new_rate":4,"old_rate":1,"process_date":"2024-03-05","ex_date":"2024-03-05"}"#;
    let spin = r#"{"symbol":"SYNTH","ex_date":"2024-03-07","new_symbol":"OTHER","nested":{"a":1}}"#;
    let name = r#"{"old_symbol":"SYNTH","new_symbol":"SYN2","process_date":"2024-03-04"}"#;
    let body = actions_body(&format!(
        r#""forward_splits":[{split}],"cash_dividends":[{DIVIDEND}],"spin_offs":[{spin}],"name_changes":[{name}],"empty":[],"nothing":null"#
    ));
    rig!(vec![Step::ok(&body)], 10, 0 => adapter, cx, sleeper, cancel);
    let actions = adapter
        .corporate_actions(
            &mut cx,
            &ActionQuery {
                symbol: "SYNTH".to_owned(),
                range: range(),
            },
        )
        .unwrap();
    assert_eq!(actions.len(), 4);
    let kinds: Vec<&ProviderActionKind> = actions.iter().map(|a| &a.kind).collect();
    assert!(matches!(
        kinds[0],
        ProviderActionKind::Split { reverse: false, .. }
    ));
    assert!(matches!(
        kinds[1],
        ProviderActionKind::CashDividend {
            special: false,
            foreign: false,
            ..
        }
    ));
    assert!(
        matches!(kinds[2], ProviderActionKind::Other { type_name } if type_name == "spin_offs")
    );
    assert!(
        matches!(kinds[3], ProviderActionKind::Other { type_name } if type_name == "name_changes")
    );
    let dividend = &actions[1];
    assert_eq!(dividend.ex_date.to_string(), "2024-03-06");
    assert_eq!(dividend.record_id.as_deref(), Some("ca-1"));
    assert_eq!(
        dividend.fields.get("declaration_date").map(String::as_str),
        Some("2024-03-01")
    );
    assert_eq!(
        dividend.fields.get("rate").map(String::as_str),
        Some("0.25")
    );
    assert!(
        !actions[2].fields.contains_key("nested"),
        "a nested value is not a scalar field"
    );
    assert!(actions[3].fields.contains_key("new_symbol"));
}

#[test]
fn corporate_action_records_are_read_strictly() {
    let bad = [
        // A record of another symbol.
        DIVIDEND.replace("\"SYNTH\"", "\"OTHER\""),
        // A missing required member, a quoted number, a quoted boolean, a numeric date.
        DIVIDEND.replace("\"special\":false,", ""),
        DIVIDEND.replace("\"rate\":0.25", "\"rate\":\"0.25\""),
        DIVIDEND.replace("\"foreign\":false", "\"foreign\":\"false\""),
        DIVIDEND.replace("\"ex_date\":\"2024-03-06\"", "\"ex_date\":20240306"),
        DIVIDEND.replace(",\"ex_date\":\"2024-03-06\"", ""),
        DIVIDEND.replace("\"ex_date\":\"2024-03-06\"", "\"ex_date\":\"2024-02-30\""),
        // A duplicate key inside a record.
        DIVIDEND.replace("\"rate\":0.25", "\"rate\":0.25,\"rate\":0.26"),
    ];
    for record in bad {
        let body = actions_body(&format!(r#""cash_dividends":[{record}]"#));
        rig!(vec![Step::ok(&body)], 10, 0 => adapter, cx, sleeper, cancel);
        let result = adapter.corporate_actions(
            &mut cx,
            &ActionQuery {
                symbol: "SYNTH".to_owned(),
                range: range(),
            },
        );
        assert_eq!(result.unwrap_err().code(), "MALFORMED_RESPONSE", "{record}");
    }
    // A repeated list name is a duplicate key as well.
    let twice = actions_body(&format!(
        r#""cash_dividends":[{DIVIDEND}],"cash_dividends":[]"#
    ));
    rig!(vec![Step::ok(&twice)], 10, 0 => adapter, cx, sleeper, cancel);
    let query = ActionQuery {
        symbol: "SYNTH".to_owned(),
        range: range(),
    };
    assert!(adapter.corporate_actions(&mut cx, &query).is_err());
}

#[test]
fn no_error_log_or_debug_output_ever_holds_a_credential() {
    // The provider echoes the key in its error bodies and its redirect target: nothing may repeat it.
    let echo = format!(r#"{{"message":"key {KEY_ID} secret {SECRET} rejected"}}"#);
    let failures = vec![
        Step::status(401, &echo),
        Step::status(403, &echo),
        Step::status(429, &echo)
            .with_header("retry-after", "3")
            .with_header("x-key", KEY_ID),
        Step::status(503, &echo),
        Step::status(302, &echo).with_header(
            "location",
            &format!("https://example.invalid/?k={KEY_ID}&s={SECRET}"),
        ),
        Step::status(404, &echo),
        Step::status(400, &echo),
        Step::ok(&echo),
        Step::ok(&format!("not json {SECRET}")),
        Step::ok(&format!(r#"{{"id":"{KEY_ID}","class":"x"}}"#)),
    ];
    let mut shown = Vec::new();
    for step in failures {
        rig!(vec![step.clone(), step], 10, 1 => adapter, cx, sleeper, cancel);
        let result = adapter.asset(&mut cx, "SYNTH");
        shown.push(format!("{result:?}"));
        if let Err(error) = &result {
            shown.push(error.to_string());
        }
        shown.push(format!("{:?}", cx.calls()));
        shown.push(format!("{cx:?}"));
        shown.push(format!("{adapter:?} {:#?}", adapter));
        shown.push(format!(
            "{:?}",
            adapter
                .transport()
                .seen()
                .iter()
                .map(|s| s.request.clone())
                .collect::<Vec<_>>()
        ));
        // The transport did receive the credentials: the check below is not vacuous.
        assert!(
            adapter
                .transport()
                .seen()
                .iter()
                .all(|s| s.key_id == KEY_ID && s.secret == SECRET)
        );
        assert!(!adapter.transport().seen().is_empty());
    }
    let credentials = Credentials::new(KEY_ID, SECRET);
    shown.push(format!("{credentials:?} {credentials} {credentials:#?}"));
    for text in shown {
        assert!(
            !text.contains(KEY_ID) && !text.contains(SECRET),
            "a credential leaked: {text}"
        );
        assert!(!text.contains("rejected"), "a response body leaked: {text}");
    }
}

#[test]
fn the_capabilities_name_the_five_operations_and_the_profile_semantics() {
    assert_eq!(CAPABILITIES.provider, "alpaca");
    assert_eq!(CAPABILITIES.operations.len(), 5);
    assert_eq!(CAPABILITIES.feeds, &[Feed::Sip, Feed::Iex]);
    assert_eq!(CAPABILITIES.timeframes, &["1Day", "1Min"]);
    assert_eq!(CAPABILITIES.adjustments, &["RAW"]);
    assert_eq!(CAPABILITIES.session_bases, &["REGULAR_HOURS"]);
    assert_eq!(CAPABILITIES.time_precision, "seconds");
    assert!(
        CAPABILITIES
            .revision_limitation
            .contains("no revision history")
    );
    let adapter = AlpacaAdapter::new(
        ScriptedTransport::new(vec![]),
        Credentials::new(KEY_ID, SECRET),
    );
    assert_eq!(adapter.capabilities(), &CAPABILITIES);
    // The names that the profile and the retrieval request use resolve to these operations.
    let refs = [
        "provider:alpaca/daily_bars@1",
        "provider:alpaca/minute_bars@1",
        "provider:alpaca/corporate_actions@1",
        "provider:alpaca/calendar@1",
        "provider:alpaca/asset@1",
    ];
    assert_eq!(CAPABILITIES.resolve_operations(&refs).unwrap().len(), 5);
    assert!(
        CAPABILITIES
            .resolve_operations(&["provider:alpaca/quotes@1"])
            .is_err()
    );
}

#[test]
fn a_success_with_an_empty_status_204_body_is_not_a_snapshot() {
    rig!(vec![Step::status(204, "")], 10, 0 => adapter, cx, sleeper, cancel);
    assert_eq!(
        adapter.asset(&mut cx, "SYNTH").unwrap_err().code(),
        "MALFORMED_RESPONSE"
    );
    assert_eq!(cx.calls()[0].error, Some(ErrorClass::MalformedResponse));
    assert_eq!(cx.calls()[0].http_status, Some(204));
}

#[test]
fn an_http_request_can_be_read_by_its_query_name() {
    let request = HttpRequest {
        host: Host::Data,
        path: "/p".to_owned(),
        query: pairs(&[("a", "1"), ("a", "2"), ("b", "3")]),
    };
    assert_eq!(request.query_value("a"), Some("1"));
    assert_eq!(request.query_value("b"), Some("3"));
    assert_eq!(request.query_value("c"), None);
}

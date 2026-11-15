//! One snapshot retrieval end to end over the scripted provider: the call sequence, the budget, the
//! hashes of the source bytes, and the rule that the gate stands in front of every provider call.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

mod market_support;

use std::fs;

use market_support::{
    CancelFlag, Case, KEY_ID, Reply, SECRET, ScriptedTransport, SimClock, SimSleeper, fixtures,
    run_case, run_with,
};
use openquant_contracts::{
    canonical::digest_bytes,
    generated::{ExecutableIdentity, RetrievalRequest},
    parse,
};
use openquant_engine::market::{
    alpaca::AlpacaAdapter,
    error::ErrorClass,
    gate::{Fact, ProviderEvidence, RetrievalSwitch, decide},
    http::{Credentials, TransportError},
    normalise::UseConstraints,
    provider::CallContext,
    retrieve::{HostIdentity, RetrieveError, limits_from_request, retrieve_snapshot},
    time::Timestamp,
};
use serde_json::json;

fn error_of(case: &Case) -> RetrieveError {
    match run_case(case).result {
        Err(error) => error,
        Ok(snapshot) => panic!("{}: expected a failure, got {}", case.id, snapshot.digest),
    }
}

#[test]
fn the_calls_run_in_a_fixed_order_and_every_response_is_hashed_by_its_exact_bytes() {
    let case = Case::load("N-09-pages");
    let run = run_case(&case);
    let snapshot = run.result.unwrap();
    let operations: Vec<&str> = run.calls.iter().map(|c| c.operation.name()).collect();
    assert_eq!(
        operations,
        [
            "asset",
            "calendar",
            "daily_bars",
            "daily_bars",
            "daily_bars",
            "corporate_actions",
            "corporate_actions"
        ]
    );
    // Every listed digest is the SHA-256 of the committed response file, read here from disk.
    let dir = fixtures().join("cases/N-09-pages/responses");
    let mut files: Vec<_> = fs::read_dir(&dir)
        .unwrap()
        .map(|e| e.unwrap().path())
        .collect();
    files.sort();
    assert_eq!(files.len(), 7);
    let listed = snapshot.manifest["source_responses"]
        .as_array()
        .unwrap()
        .clone();
    for (index, (file, entry)) in files.iter().zip(&listed).enumerate() {
        let bytes = fs::read(file).unwrap();
        assert_eq!(
            entry["content_digest"],
            digest_bytes(&bytes),
            "response {}",
            index + 1
        );
        assert_eq!(
            entry["stored"]["size_bytes"],
            bytes.len(),
            "response {}",
            index + 1
        );
        assert_eq!(entry["stored"]["media_type"], "application/json");
        assert_eq!(entry["sequence"], index + 1);
    }
    // Operation names in the manifest are the capability references of the profile.
    let names: Vec<&str> = listed
        .iter()
        .map(|e| e["operation"].as_str().unwrap())
        .collect();
    assert_eq!(names[0], "provider:alpaca/asset@1");
    assert_eq!(names[2], "provider:alpaca/daily_bars@1");
    assert_eq!(names[6], "provider:alpaca/corporate_actions@1");
}

#[test]
fn the_requests_widen_the_calendar_and_the_action_window_as_documented() {
    // Hand-computed from the range 2024-12-02 to 2024-12-13: the calendar runs 45 days past the end
    // (2025-01-27) and the action window 31 days before the start (2024-11-01) and after the end
    // (2025-01-13). The scripted answers check each request as well.
    let case = Case::load("N-11-payable-after-end");
    let run = run_case(&case);
    assert!(run.result.is_ok());
    let calendar = &run.seen[1].request;
    assert_eq!(calendar.query_value("start"), Some("2024-12-02"));
    assert_eq!(calendar.query_value("end"), Some("2025-01-27"));
    let actions = &run.seen[3].request;
    assert_eq!(actions.query_value("start"), Some("2024-11-01"));
    assert_eq!(actions.query_value("end"), Some("2025-01-13"));
    assert_eq!(actions.query_value("symbols"), Some("SYNTH"));
}

#[test]
fn the_end_of_the_bar_request_is_the_requested_end_or_fifteen_minutes_ago() {
    let end = |id: &str| {
        let run = run_case(&Case::load(id));
        assert!(run.result.is_ok(), "{id}");
        run.seen[2].request.query_value("end").unwrap().to_owned()
    };
    // The range ends long ago: the end of its last day.
    assert_eq!(end("N-02-cash-dividend"), "2025-02-14T23:59:59Z");
    // The range ends today and the request is made at 21:10Z: 21:10 minus 15 minutes.
    assert_eq!(end("N-16-end-age"), "2026-11-13T20:55:00Z");
}

#[test]
fn a_failure_returns_no_snapshot_and_keeps_every_billed_call() {
    let case = Case::load("E-13-budget-ends-mid-pagination");
    let run = run_case(&case);
    let error = run.result.unwrap_err();
    assert_eq!(error.code(), "REQUEST_LIMIT_REACHED");
    assert_eq!(error.class(), ErrorClass::UnavailableData);
    assert!(!error.retryable());
    assert_eq!(run.calls.len(), 4, "all four billed calls are recorded");
    assert_eq!(run.sources.len(), 4);
}

#[test]
fn the_budget_of_the_request_bounds_the_whole_retrieval() {
    let mut case = Case::load("N-02-cash-dividend");
    case.request["limits"]["max_requests"] = json!(3);
    let run = run_case(&case);
    assert_eq!(run.result.unwrap_err().code(), "REQUEST_LIMIT_REACHED");
    assert_eq!(run.seen.len(), 3);
    assert_eq!(
        run.unconsumed, 1,
        "the corporate-actions read never went out"
    );
}

#[test]
fn a_request_that_does_not_list_a_needed_operation_is_refused_before_any_call() {
    for drop in ["asset", "calendar", "daily_bars", "corporate_actions"] {
        let mut case = Case::load("N-02-cash-dividend");
        let reference = format!("provider:alpaca/{drop}@1");
        let operations: Vec<_> = case.request["operations"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|op| op.as_str() != Some(reference.as_str()))
            .cloned()
            .collect();
        assert_eq!(operations.len(), 3);
        case.request["operations"] = json!(operations);
        let run = run_case(&case);
        let error = run.result.unwrap_err();
        assert_eq!(error.code(), "UNSUPPORTED_CAPABILITY", "{drop}");
        assert!(error.to_string().contains(drop), "{error}");
        assert!(run.seen.is_empty(), "{drop}: no request was made");
    }
    // An operation that the adapter does not have is refused as well.
    let mut case = Case::load("N-02-cash-dividend");
    case.request["operations"]
        .as_array_mut()
        .unwrap()
        .push(json!("provider:alpaca/quotes@1"));
    let run = run_case(&case);
    assert_eq!(run.result.unwrap_err().code(), "UNSUPPORTED_CAPABILITY");
    assert!(run.seen.is_empty());
}

#[test]
fn a_range_that_cannot_be_requested_is_refused_before_any_call() {
    // The range ends before it starts.
    let mut backwards = Case::load("N-02-cash-dividend");
    backwards.request["range"] = json!({"start": "2025-02-14", "end": "2025-02-03"});
    // The range ends after the newest data that the profile allows: the request is made at
    // 00:10Z on 2026-11-14 and the range is that day.
    let mut too_new = Case::load("N-16-end-age");
    too_new.request["range"] = json!({"start": "2026-11-14", "end": "2026-11-14"});
    too_new.now = Timestamp::parse("2026-11-14T00:10:00Z").unwrap();
    too_new.request["deadline"] = json!("2026-11-14T00:25:00Z");
    // The range is outside the years that the Eastern rule covers.
    let mut ancient = Case::load("N-02-cash-dividend");
    ancient.request["range"] = json!({"start": "1999-01-04", "end": "1999-01-08"});
    for case in [backwards, too_new, ancient] {
        let run = run_case(&case);
        assert_eq!(run.result.unwrap_err().code(), "INVALID_REQUEST");
        assert!(run.seen.is_empty());
    }
}

#[test]
fn a_transient_failure_late_in_the_chain_is_retried_and_a_timeout_is_a_timeout() {
    // The calendar read times out once, then succeeds.
    let mut case = Case::load("N-03-holiday");
    case.without_expectations();
    case.steps.insert(
        1,
        market_support::Step {
            expect: None,
            reply: Reply::Transport(TransportError::Timeout),
        },
    );
    let run = run_case(&case);
    assert!(run.result.is_ok());
    assert_eq!(run.waits, vec![1]);
    assert_eq!(run.calls[1].error, Some(ErrorClass::Timeout));
    assert_eq!(run.calls[1].http_status, None);
    // With no retry allowed the timeout is the retrieval's failure, retryable by the job policy.
    case.request["limits"]["max_retries"] = json!(0);
    let run = run_case(&case);
    let error = run.result.unwrap_err();
    assert_eq!(
        (error.code(), error.class(), error.retryable()),
        ("TIMEOUT", ErrorClass::Timeout, true)
    );
    assert_eq!(run.calls.len(), 2);
}

#[test]
fn the_limits_of_the_request_become_the_limits_of_the_context() {
    let case = Case::load("N-02-cash-dividend");
    let request: RetrievalRequest = parse(&serde_json::to_string(&case.request).unwrap()).unwrap();
    let limits = limits_from_request(&request).unwrap();
    assert_eq!(limits.max_requests, 30);
    assert_eq!(limits.max_retries, 2);
    assert_eq!(limits.request_timeout.as_secs(), 30);
    assert_eq!(limits.max_response_bytes, 1_048_576);
    assert_eq!(limits.deadline.to_string(), "2026-11-14T10:15:00Z");
}

#[test]
fn a_permit_can_serve_several_retrievals_and_a_block_stands_in_front_of_all_of_them() {
    // The pattern of the batch host: decide first, retrieve only with the permit in hand.
    let case = Case::load("N-03-holiday");
    let text = serde_json::to_string(&case.request).unwrap();
    let request: RetrievalRequest = parse(&text).unwrap();
    let executable: ExecutableIdentity =
        serde_json::from_value(case.host["executable"].clone()).unwrap();
    let constraints = UseConstraints {
        redistribution_permitted: false,
        retain_raw: true,
        terms_ref: "t".to_owned(),
    };
    let host = HostIdentity {
        executable: &executable,
        adapter_version: "1",
        constraints: &constraints,
        licence: "l",
    };
    let try_retrieve = |switch: RetrievalSwitch, evidence: &ProviderEvidence| {
        let adapter = AlpacaAdapter::new(
            ScriptedTransport::new(case.steps.clone()),
            Credentials::new(KEY_ID, SECRET),
        );
        let clock = SimClock::at(case.now);
        let sleeper = SimSleeper::new(&clock);
        let cancel = CancelFlag::default();
        let result = decide(switch, evidence).map(|permit| {
            let mut cx = CallContext::new(
                limits_from_request(&request).unwrap(),
                &clock,
                &sleeper,
                &cancel,
            );
            retrieve_snapshot(&permit, &adapter, &request, &host, &mut cx).map(|s| s.digest)
        });
        (result, adapter.transport().seen().len())
    };
    let open = ProviderEvidence {
        paper_authority: Fact::Verified,
        no_live_authority: Fact::Verified,
        data_entitlement: Fact::Verified,
        session_semantics: Fact::Verified,
        egress_refusals: Fact::Verified,
        declaration_field: Fact::Verified,
    };
    // Open gate: the whole chain of four calls runs.
    let (result, requests) = try_retrieve(RetrievalSwitch::On, &open);
    assert!(matches!(result, Ok(Ok(_))));
    assert_eq!(requests, 4);
    // Closed by the switch, closed by one unverified fact: not one request leaves.
    for (switch, evidence) in [
        (RetrievalSwitch::Off, open.clone()),
        (
            RetrievalSwitch::On,
            ProviderEvidence {
                egress_refusals: Fact::Unverified,
                ..open.clone()
            },
        ),
        (
            RetrievalSwitch::On,
            ProviderEvidence {
                no_live_authority: Fact::Failed("accepted".to_owned()),
                ..open.clone()
            },
        ),
        (RetrievalSwitch::Off, ProviderEvidence::default()),
    ] {
        let (result, requests) = try_retrieve(switch, &evidence);
        assert!(result.is_err());
        assert_eq!(requests, 0, "a blocked gate sends no request");
    }
}

#[test]
fn a_cancelled_retrieval_stops_at_the_next_request_and_returns_no_snapshot() {
    let case = Case::load("N-09-pages");
    let cancel = CancelFlag::default();
    let run = run_with(&case, &cancel, Some(3), None);
    assert_eq!(run.result.unwrap_err().code(), "CANCELLED");
    assert_eq!(
        run.calls.len(),
        3,
        "the request in flight finished, the next one never started"
    );
    assert_eq!(run.unconsumed, 4);
}

#[test]
fn an_unreadable_response_is_not_a_blocked_profile_and_a_block_is_not_retried() {
    // A malformed body is a provider failure (class MALFORMED_RESPONSE), a bad calendar row too.
    let error = error_of(&Case::load("E-09-wrong-shape"));
    assert!(matches!(error, RetrieveError::Provider(_)));
    // The profile block of missing evidence is never retried and carries no retry hint.
    let blocked = error_of(&Case::load("B-01-dividend-field-missing"));
    assert!(matches!(blocked, RetrieveError::Blocked(_)));
    assert!(!blocked.retryable());
    assert_eq!(blocked.retry_after_seconds(), None);
    assert_eq!(blocked.class(), ErrorClass::UnavailableData);
    assert!(blocked.to_string().contains("declaration_date"));
    // A rate limit keeps the provider's hint for the job's recovery.
    let limited = error_of(&Case::load("E-04-429-exhausted"));
    assert_eq!(
        (limited.retryable(), limited.retry_after_seconds()),
        (true, Some(2))
    );
}

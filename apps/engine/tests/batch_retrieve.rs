//! The `retrieve` job through the worker: the enablement gate, the provider requests over the
//! egress module, the snapshot and the result (OQ-05 section 7.1; OQ-02 sections 1.1, 2.5, 2.6).
//!
//! All 47 market-data fixture cases run through the worker. Each case is a full
//! `retrieval-request/1`, the provider's answers as bytes and the outcome that an independent
//! oracle (`fixtures/market-data/oracle/oracle.py`) derived. The fake provider plays the answers
//! behind the real egress module, and the test compares the retrieval result that the worker
//! submitted with the oracle's outcome: the status, the manifest (byte for byte), every call and
//! the number of provider requests, which must equal the number the egress module counted.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

mod batch_support;
mod market_support;

use std::collections::VecDeque;

use batch_support::{Action, Harness, ProviderStep, data::*, worker_handled};
use market_support::{Case, Reply, indexed_case_ids};
use openquant_contracts::canonical::digest_bytes;
use openquant_engine::{
    batch::{config, identity::ExecutableId, wire::WireError, worker::Handled},
    market::{
        gate::ENABLE_VARIABLE,
        http::{Host, TransportError},
    },
};
use serde_json::{Value, json};

const RESULT: &str = "attempts.retrieval-result";

fn provider_script(case: &Case) -> VecDeque<ProviderStep> {
    case.steps
        .iter()
        .map(|step| {
            let expect = step.expect.as_ref().expect("an expected request");
            let reply = match &step.reply {
                Reply::Response {
                    status,
                    headers,
                    body,
                } => Ok((*status, headers.clone(), body.clone())),
                Reply::Transport(TransportError::Timeout) => Err(WireError::Timeout),
                Reply::Transport(TransportError::Connection) => Err(WireError::Connection),
                Reply::Transport(TransportError::BodyTooLarge) => Err(WireError::BodyTooLarge),
                // The egress module refuses a redirect: the fake provider redirects.
                Reply::Transport(TransportError::EgressRefused) => Ok((
                    302,
                    vec![(
                        "location".to_owned(),
                        "https://elsewhere.example/x".to_owned(),
                    )],
                    Vec::new(),
                )),
            };
            ProviderStep {
                host: if expect.host == "data" {
                    Host::Data
                } else {
                    Host::Paper
                },
                path: expect.path.clone(),
                query: expect.query.clone(),
                reply,
            }
        })
        .collect()
}

/// A harness for `case` with the gate open: switch on, every fact verified, a credential set.
fn open_harness(case: &Case) -> Harness {
    let mut harness = Harness::starting_at(&case.now.to_string());
    harness.executable = ExecutableId {
        name: case.host["executable"]["name"].as_str().unwrap().to_owned(),
        version: case.host["executable"]["version"]
            .as_str()
            .unwrap()
            .to_owned(),
        digest: case.host["executable"]["digest"]
            .as_str()
            .unwrap()
            .to_owned(),
    };
    assert_eq!(
        case.host["adapter_version"], "1",
        "the worker records adapter version 1"
    );
    let (key, secret) = {
        let mut world = harness.world();
        // A long lease, so that the lease does not change what a fixture case means.
        world.lease_seconds = 3_600;
        world.provider = provider_script(case);
        (world.provider_key_id.clone(), world.provider_secret.clone())
    };
    harness.set(ENABLE_VARIABLE, "enabled");
    harness.set(config::ENV_ALPACA_KEY_ID, &key);
    harness.set(config::ENV_ALPACA_SECRET, &secret);
    let constraints = json!({
        "redistribution_permitted": case.host["constraints"]["redistribution_permitted"],
        "retain_raw": case.host["constraints"]["retain_raw"],
        "terms_ref": case.host["constraints"]["terms_ref"],
    });
    harness.record_evidence_with(true, constraints, case.host["licence"].as_str().unwrap());
    harness
}

fn operation_ref(name: &str) -> String {
    format!("provider:alpaca/{name}@1")
}

#[test]
fn every_market_data_case_gives_the_result_that_the_oracle_derived() {
    let ids = indexed_case_ids();
    assert_eq!(ids.len(), 47);
    let (mut snapshots, mut blocks, mut errors) = (0, 0, 0);
    for id in &ids {
        let case = Case::load(id);
        let harness = open_harness(&case);
        let job = harness.enqueue_retrieve(&case.request, id);
        let handled = worker_handled(&harness.poll(), &job.message);
        assert!(
            matches!(handled, Handled::Completed { acked: true, .. }),
            "{id}: {handled:?}\n{}",
            harness.log_text()
        );
        let world = harness.world();
        let accepted = world.accepted_on(RESULT);
        assert_eq!(accepted.len(), 1, "{id}");
        let result = &accepted[0].body;
        let expect = &case.expected["expect"];

        // The calls: the same sequence, operation, time, status and error as the oracle's.
        let calls = result["calls"].as_array().unwrap();
        let wanted = expect["calls"].as_array().unwrap();
        assert_eq!(calls.len(), wanted.len(), "{id}: calls");
        for (call, want) in calls.iter().zip(wanted) {
            assert_eq!(call["sequence"], want["sequence"], "{id}");
            assert_eq!(
                call["operation"],
                operation_ref(want["operation"].as_str().unwrap()),
                "{id}"
            );
            assert_eq!(call["started_at"], want["started_at"], "{id}");
            // The oracle played these two at the adapter's transport seam. The real wire stops
            // reading a body above the limit and reports no response (E-15 has no status here,
            // where the oracle has its 200), and the fake provider stands for a refusal by a
            // redirect that the egress module refuses after the exchange (E-16 shows its 302,
            // where the oracle has none). The class, the count and the retry flag still agree.
            if !matches!(
                id.as_str(),
                "E-15-response-too-large" | "E-16-egress-refused"
            ) {
                assert_eq!(
                    call.get("http_status"),
                    want["http_status"].as_u64().map(Value::from).as_ref(),
                    "{id}"
                );
            }
            assert_eq!(
                call.get("error"),
                want["error"].as_str().map(Value::from).as_ref(),
                "{id}"
            );
            assert_eq!(
                call["result"],
                if want["error"].is_null() {
                    "SUCCEEDED"
                } else {
                    "FAILED"
                },
                "{id}"
            );
        }
        // The count in the result is the count of the oracle, of the egress module and of the wire.
        let requests = expect["requests"].as_u64().unwrap();
        assert_eq!(
            result["usage"]["provider_requests"],
            json!({"label": "observed", "count": requests}),
            "{id}"
        );
        assert_eq!(
            world.provider_requests() as u64,
            requests,
            "{id}: the wire saw {requests} provider requests"
        );
        assert_eq!(
            world.provider.len(),
            0,
            "{id}: every scripted answer was used"
        );

        let outcome = &result["outcome"];
        match expect["outcome"].as_str().unwrap() {
            "snapshot" => {
                snapshots += 1;
                let manifest = &expect["manifest"];
                assert_eq!(
                    outcome["status"], manifest["coverage"]["completeness"],
                    "{id}"
                );
                assert_eq!(
                    outcome["manifest"]["digest"], expect["digest"],
                    "{id}: the manifest digest"
                );
                let stored = world
                    .artefacts
                    .get(expect["digest"].as_str().unwrap())
                    .expect("the manifest was uploaded");
                assert_eq!(
                    std::str::from_utf8(stored).unwrap(),
                    canonical(manifest),
                    "{id}: the manifest bytes"
                );
                assert_eq!(outcome["manifest"]["size_bytes"], stored.len(), "{id}");
                // Every raw response that the manifest lists as stored was uploaded first, with the
                // bytes of the provider's answer.
                for source in manifest["source_responses"].as_array().unwrap() {
                    if let Some(kept) = source.get("stored") {
                        let bytes = world
                            .artefacts
                            .get(kept["digest"].as_str().unwrap())
                            .expect("a kept response");
                        assert_eq!(digest_bytes(bytes), source["content_digest"], "{id}");
                    }
                }
            }
            kind => {
                assert_eq!(outcome["status"], "FAILED", "{id}");
                let (class, retryable, after) = if kind == "blocked" {
                    blocks += 1;
                    (expect["block"]["class"].clone(), json!(false), Value::Null)
                } else {
                    errors += 1;
                    (
                        expect["error"]["class"].clone(),
                        expect["error"]["retryable"].clone(),
                        expect["error"]["retry_after_seconds"].clone(),
                    )
                };
                assert_eq!(outcome["error"], class, "{id}");
                assert_eq!(outcome["retryable"], retryable, "{id}");
                assert_eq!(
                    outcome.get("retry_after_seconds").unwrap_or(&Value::Null),
                    &after,
                    "{id}"
                );
                let detail = outcome["detail"].as_str().unwrap();
                assert!(!detail.is_empty() && detail.chars().count() <= 1000, "{id}");
                // Nothing was retained for a retrieval that failed.
                assert!(
                    world.accepted_on(RESULT)[0].body["outcome"]
                        .get("manifest")
                        .is_none(),
                    "{id}"
                );
            }
        }
        // No credential in the result or in the log.
        let text = serde_json::to_string(result).unwrap() + &harness.log_text();
        assert!(
            !text.contains(&world.provider_secret) && !text.contains(&world.provider_key_id),
            "{id}"
        );
    }
    assert_eq!((snapshots, blocks, errors), (18, 15, 14));
}

#[test]
fn a_gate_that_is_off_makes_no_provider_request_and_says_why() {
    // The switch is not `enabled`: nothing is retrieved, whatever the evidence says.
    for value in [None, Some("true"), Some("ENABLED"), Some("1")] {
        let case = Case::load("N-01-split");
        let mut harness = open_harness(&case);
        match value {
            Some(text) => harness.set(ENABLE_VARIABLE, text),
            None => {
                harness.vars.remove(ENABLE_VARIABLE);
            }
        }
        let job = harness.enqueue_retrieve(&case.request, "off");
        let handled = worker_handled(&harness.poll(), &job.message);
        assert!(
            matches!(handled, Handled::Completed { acked: true, .. }),
            "{value:?}: {handled:?}"
        );
        let world = harness.world();
        assert_eq!(
            world.provider_requests(),
            0,
            "{value:?}: the provider was not called"
        );
        assert_eq!(
            world.provider.len(),
            4,
            "{value:?}: no scripted answer was used"
        );
        let result = &world.accepted_on(RESULT)[0].body;
        let outcome = &result["outcome"];
        assert_eq!(outcome["status"], "FAILED");
        assert_eq!(outcome["error"], "UNSUPPORTED_CAPABILITY");
        assert_eq!(outcome["retryable"], false);
        assert!(
            outcome["detail"].as_str().unwrap().contains("not enabled"),
            "{outcome}"
        );
        assert_eq!(result["calls"], json!([]));
        assert_eq!(
            result["usage"]["provider_requests"],
            json!({"label": "observed", "count": 0})
        );
    }
}

#[test]
fn an_unverified_or_failed_fact_blocks_retrieval_even_when_the_switch_is_on() {
    let case = Case::load("N-01-split");
    // No evidence file at all: all six facts are unverified.
    let mut harness = open_harness(&case);
    harness.vars.remove(config::ENV_PROVIDER_EVIDENCE);
    let job = harness.enqueue_retrieve(&case.request, "none");
    assert!(matches!(
        worker_handled(&harness.poll(), &job.message),
        Handled::Completed { .. }
    ));
    {
        let world = harness.world();
        assert_eq!(world.provider_requests(), 0);
        let detail = world.accepted_on(RESULT)[0].body["outcome"]["detail"]
            .as_str()
            .unwrap()
            .to_owned();
        for fact in [
            "paper account authority",
            "absence of live order authority",
            "data entitlement",
            "session semantics",
            "egress refusals",
            "declaration-date field",
        ] {
            assert!(detail.contains(fact), "{fact} is named in: {detail}");
        }
    }
    // One probe failed: the other five are verified and the one failure is named.
    let mut harness = open_harness(&case);
    harness.record_evidence_with(
        false,
        json!({"redistribution_permitted": false, "retain_raw": true, "terms_ref": "t"}),
        "licence",
    );
    let job = harness.enqueue_retrieve(&case.request, "failed");
    assert!(matches!(
        worker_handled(&harness.poll(), &job.message),
        Handled::Completed { .. }
    ));
    let world = harness.world();
    assert_eq!(world.provider_requests(), 0);
    let detail = world.accepted_on(RESULT)[0].body["outcome"]["detail"]
        .as_str()
        .unwrap();
    assert!(
        detail.contains("declaration-date field") && detail.contains("absent from a real response"),
        "{detail}"
    );
    assert!(!detail.contains("paper account authority"), "{detail}");
}

#[test]
fn an_open_gate_without_a_credential_makes_no_provider_request() {
    let case = Case::load("N-01-split");
    let mut harness = open_harness(&case);
    harness.vars.remove(config::ENV_ALPACA_KEY_ID);
    harness.vars.remove(config::ENV_ALPACA_SECRET);
    let job = harness.enqueue_retrieve(&case.request, "nokey");
    assert!(matches!(
        worker_handled(&harness.poll(), &job.message),
        Handled::Completed { .. }
    ));
    let world = harness.world();
    assert_eq!(world.provider_requests(), 0);
    let outcome = &world.accepted_on(RESULT)[0].body["outcome"];
    assert_eq!(outcome["error"], "AUTHENTICATION");
    assert_eq!(outcome["retryable"], false);
}

#[test]
fn a_provider_that_redirects_is_an_egress_refusal_that_is_never_retried_or_followed() {
    let case = Case::load("N-01-split");
    let harness = open_harness(&case);
    {
        let mut world = harness.world();
        // The first answer is a redirect to another host. A second redirect step would only be
        // used if the worker retried or followed; it is not.
        let step = &mut world.provider[0];
        step.reply = Ok((
            302,
            vec![(
                "location".to_owned(),
                "https://data.evil.example/v2/stocks/SYNTH/bars".to_owned(),
            )],
            Vec::new(),
        ));
    }
    let job = harness.enqueue_retrieve(&case.request, "redirect");
    assert!(matches!(
        worker_handled(&harness.poll(), &job.message),
        Handled::Completed { .. }
    ));
    let world = harness.world();
    assert_eq!(
        world.provider_requests(),
        1,
        "the redirect target was not requested"
    );
    assert_eq!(world.provider.len(), 3);
    let outcome = &world.accepted_on(RESULT)[0].body["outcome"];
    assert_eq!(outcome["error"], "EGRESS_REFUSED");
    assert_eq!(outcome["retryable"], false);
    assert!(
        !outcome["detail"].as_str().unwrap().contains("evil"),
        "no target in the detail"
    );
}

#[test]
fn a_request_that_the_egress_allowlist_would_refuse_never_reaches_the_provider() {
    // A fixture case whose adapter request uses a path outside the allowlist cannot be built by
    // the adapter; this test proves the converse for the host: the fake provider panics on any
    // host outside the three it serves, and the worker never sends one. The request count of the
    // 47 cases above is the proof; here the live host is named explicitly.
    let case = Case::load("N-01-split");
    let harness = open_harness(&case);
    let job = harness.enqueue_retrieve(&case.request, "hosts");
    assert!(matches!(
        worker_handled(&harness.poll(), &job.message),
        Handled::Completed { .. }
    ));
    let world = harness.world();
    let hosts: std::collections::BTreeSet<&str> = world
        .seen
        .iter()
        .filter(|s| s.key == "provider")
        .map(|s| s.host.as_str())
        .collect();
    assert_eq!(
        hosts,
        ["data.alpaca.markets", "paper-api.alpaca.markets"]
            .into_iter()
            .collect()
    );
    assert!(
        !hosts.contains("api.alpaca.markets"),
        "the live trading host is never contacted"
    );
}

#[test]
fn a_cancelled_retrieval_stops_and_submits_nothing() {
    let case = Case::load("N-09-pages");
    let harness = open_harness(&case);
    // The mission is cancelled while the second provider request is answered. The next API call
    // finds it, and the retrieval makes no further provider request.
    harness.world().on("provider", 2, Action::CancelAttempts);
    let job = harness.enqueue_retrieve(&case.request, "cancel");
    let handled = worker_handled(&harness.poll(), &job.message);
    let Handled::Abandoned { .. } = handled else {
        panic!("{handled:?}");
    };
    let world = harness.world();
    assert!(world.accepted.is_empty());
    assert!(!world.is_acked(&job.message));
}

#[test]
fn the_snapshot_and_its_kept_responses_are_uploaded_before_the_result_is_submitted() {
    let case = Case::load("N-09-pages");
    let harness = open_harness(&case);
    let job = harness.enqueue_retrieve(&case.request, "order");
    assert!(matches!(
        worker_handled(&harness.poll(), &job.message),
        Handled::Completed { .. }
    ));
    let world = harness.world();
    let keys: Vec<&str> = world.seen.iter().map(|s| s.key.as_str()).collect();
    let uploads: Vec<usize> = keys
        .iter()
        .enumerate()
        .filter(|(_, k)| **k == "attempts.artefact")
        .map(|(i, _)| i)
        .collect();
    let submit = keys.iter().position(|k| *k == RESULT).unwrap();
    // Seven raw responses and the manifest.
    assert_eq!(uploads.len(), 8, "{keys:?}");
    assert!(uploads.iter().all(|i| *i < submit));
    let last_provider = keys.iter().rposition(|k| *k == "provider").unwrap();
    assert!(
        uploads.iter().all(|i| *i > last_provider),
        "uploads follow the retrieval"
    );
    assert_eq!(world.requests_with("queue.ack"), 1);
}

#[test]
fn the_job_without_raw_retention_uploads_the_manifest_alone() {
    let case = Case::load("N-01-split");
    let mut harness = open_harness(&case);
    harness.record_evidence_with(
        true,
        json!({"redistribution_permitted": false, "retain_raw": false, "terms_ref": "terms"}),
        case.host["licence"].as_str().unwrap(),
    );
    let job = harness.enqueue_retrieve(&case.request, "noraw");
    assert!(matches!(
        worker_handled(&harness.poll(), &job.message),
        Handled::Completed { .. }
    ));
    let world = harness.world();
    assert_eq!(
        world.requests_with("attempts.artefact"),
        1,
        "only the manifest"
    );
    let manifest_digest = world.accepted_on(RESULT)[0].body["outcome"]["manifest"]["digest"]
        .as_str()
        .unwrap()
        .to_owned();
    let manifest: Value = serde_json::from_slice(&world.artefacts[&manifest_digest]).unwrap();
    assert!(
        manifest["source_responses"]
            .as_array()
            .unwrap()
            .iter()
            .all(|s| s.get("stored").is_none())
    );
    assert_eq!(manifest["constraints"]["raw_retention"], "DO_NOT_RETAIN");
}

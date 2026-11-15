//! The worker protocol (OQ-05 section 4): claim before work, upload before submit, acknowledge
//! only after the result is committed, and what happens when anything goes wrong in between.
//!
//! The worker, the queue client, the API client and the egress module are the production code.
//! Only the wire is replaced, by a fake queue and a fake API built from `routes/v1.json`
//! (`tests/batch_support/world.rs`). A "crash" is an unwind out of the wire call: the process
//! stops at that request and nothing after it happens.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

mod batch_support;

use std::{sync::Arc, thread, time::Duration};

use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use batch_support::{Action, AttemptState, Harness, data::*, worker_handled};
use openquant_engine::batch::{
    wire::WireError,
    worker::{Handled, Polled, WorkerError},
};
use serde_json::json;

const SUBMISSION: &str = "attempts.evaluation-submission";

fn small_case() -> S0Case {
    s0_case("ENT-01-v1")
}

#[test]
fn a_job_is_claimed_uploaded_submitted_and_only_then_acknowledged() {
    let harness = Harness::new();
    let job = harness.enqueue_replay(&small_case(), "order");
    let handled = worker_handled(&harness.poll(), &job.message);
    assert!(
        matches!(handled, Handled::Completed { acked: true, .. }),
        "{handled:?}"
    );
    let world = harness.world();
    let order: Vec<&str> = world.seen.iter().map(|s| s.key.as_str()).collect();
    // Pull, claim, the three inputs, the uploads (result, metrics), the submission, the acknowledgement.
    assert_eq!(order.first(), Some(&"queue.pull"));
    assert_eq!(order.get(1), Some(&"attempts.claim"));
    assert!(
        order[2..5].iter().all(|k| *k == "attempts.input"),
        "{order:?}"
    );
    let upload_start = order
        .iter()
        .position(|k| *k == "attempts.artefact")
        .unwrap();
    let submit = order.iter().position(|k| *k == SUBMISSION).unwrap();
    let ack = order.iter().position(|k| *k == "queue.ack").unwrap();
    assert!(upload_start < submit && submit < ack, "{order:?}");
    assert_eq!(order.last(), Some(&"queue.ack"));
    assert!(
        order[upload_start..submit]
            .iter()
            .all(|k| *k == "attempts.artefact")
    );
    assert!(world.is_acked(&job.message));
    assert_eq!(world.queued(), Vec::<String>::new());
    // The claim carried the identity of the executable and a worker id, no secret.
    let attempt = &world.attempts[&job.attempt_id];
    assert_eq!(attempt.state, AttemptState::Completed);
    assert_eq!(attempt.executable.as_ref().unwrap()["name"], "engine-batch");
    assert!(
        attempt
            .worker_id
            .as_deref()
            .unwrap()
            .starts_with("test-worker-")
    );
}

#[test]
fn a_lost_acknowledgement_and_the_redelivery_give_one_result() {
    let harness = Harness::new();
    let job = harness.enqueue_replay(&small_case(), "lost-ack");
    harness
        .world()
        .on("queue.ack", 1, Action::Lose(WireError::Timeout));
    let handled = worker_handled(&harness.poll(), &job.message);
    assert!(
        matches!(handled, Handled::Completed { acked: false, .. }),
        "{handled:?}"
    );
    assert_eq!(harness.world().accepted_on(SUBMISSION).len(), 1);
    assert_eq!(
        harness.world().queued(),
        vec![job.message.clone()],
        "the message is still there"
    );

    // Nothing comes back before the visibility timeout of 720 seconds ends.
    assert_eq!(harness.poll(), Polled::Idle);
    harness.time.advance(719);
    assert_eq!(harness.poll(), Polled::Idle, "719 seconds after the pull");
    harness.time.advance(2);
    let handled = worker_handled(&harness.poll(), &job.message);
    assert!(
        matches!(&handled, Handled::NotClaimable { code, acked: true } if code == "ATTEMPT_NOT_CLAIMABLE"),
        "{handled:?}"
    );
    let world = harness.world();
    assert_eq!(
        world.accepted_on(SUBMISSION).len(),
        1,
        "one official result"
    );
    assert_eq!(world.delivery_count(&job.message), 2);
    assert_eq!(world.queued(), Vec::<String>::new());
    // The redelivery read nothing and wrote nothing.
    assert_eq!(world.requests_with("attempts.input"), 3);
    assert_eq!(world.requests_with(SUBMISSION), 1);
}

#[test]
fn a_crash_before_an_upload_leaves_the_message_and_a_new_attempt_completes_the_run() {
    let harness = Harness::new();
    let case = small_case();
    let first = harness.enqueue_replay(&case, "crash");
    harness.world().on("attempts.artefact", 1, Action::Crash);
    assert!(
        harness.poll_catching().is_none(),
        "the process died at the upload"
    );
    {
        let world = harness.world();
        assert!(world.accepted.is_empty(), "nothing was committed");
        assert_eq!(
            world.queued(),
            vec![first.message.clone()],
            "the message was not acknowledged"
        );
        assert_eq!(
            world.attempts[&first.attempt_id].state,
            AttemptState::Claimed
        );
    }
    // The queue redelivers after the visibility timeout. The claim is refused: recovery owns it.
    harness.time.advance(1_300);
    let handled = worker_handled(&harness.poll(), &first.message);
    assert!(
        matches!(handled, Handled::NotClaimable { acked: true, .. }),
        "{handled:?}"
    );
    // Recovery fences the lost attempt and dispatches a new attempt of the same run.
    harness.world().fence(&first.attempt_id);
    let second = harness.enqueue_replay_attempt(&case, "crash", 2);
    assert_eq!(second.job_id, first.job_id, "the same logical run");
    let handled = worker_handled(&harness.poll(), &second.message);
    assert!(
        matches!(handled, Handled::Completed { acked: true, .. }),
        "{handled:?}"
    );
    let world = harness.world();
    let results = world.accepted_on(SUBMISSION);
    assert_eq!(results.len(), 1, "one official result for the run");
    assert_eq!(results[0].attempt_id, second.attempt_id);
}

#[test]
fn a_lease_that_ends_before_an_upload_leaves_no_result_and_no_acknowledgement() {
    let harness = Harness::new();
    let job = harness.enqueue_replay(&small_case(), "expiry");
    // The lease is 660 seconds. The clock jumps past it before the first upload.
    harness
        .world()
        .on("attempts.artefact", 1, Action::Advance(700));
    let handled = worker_handled(&harness.poll(), &job.message);
    let Handled::Abandoned { reason } = handled else {
        panic!("{handled:?}\n{}", harness.log_text());
    };
    assert!(
        reason.contains("no longer ours") && reason.contains("LEASE_EXPIRED"),
        "{reason}"
    );
    let world = harness.world();
    assert!(world.accepted.is_empty());
    assert_eq!(
        world.requests_with(SUBMISSION),
        0,
        "no submission after the lease ended"
    );
    assert!(!world.is_acked(&job.message));
    assert_eq!(world.attempts[&job.attempt_id].state, AttemptState::Expired);
}

#[test]
fn a_lease_too_short_to_work_in_is_given_up_before_any_input_is_read() {
    let harness = Harness::new();
    let job = harness.enqueue_replay(&small_case(), "short");
    // The worker stops 30 seconds before the lease ends: a 20 second lease leaves nothing.
    harness.world().lease_seconds = 20;
    let handled = worker_handled(&harness.poll(), &job.message);
    let Handled::Abandoned { reason } = handled else {
        panic!("{handled:?}");
    };
    assert!(reason.contains("lease is about to end"), "{reason}");
    let world = harness.world();
    assert_eq!(world.requests_with("attempts.input"), 0);
    assert_eq!(world.requests_with("attempts.artefact"), 0);
    assert!(world.accepted.is_empty());
}

#[test]
fn a_cancelled_attempt_is_dropped_on_the_next_call_without_a_result() {
    let harness = Harness::new();
    let job = harness.enqueue_replay(&small_case(), "cancel");
    // The mission is cancelled while the third input (the frozen input) is being read.
    harness
        .world()
        .on("attempts.input", 3, Action::CancelAttempts);
    let handled = worker_handled(&harness.poll(), &job.message);
    let Handled::Abandoned { reason } = handled else {
        panic!("{handled:?}");
    };
    assert!(reason.contains("STALE_OWNERSHIP"), "{reason}");
    let world = harness.world();
    assert_eq!(
        world.attempts[&job.attempt_id].state,
        AttemptState::Cancelled
    );
    assert_eq!(
        world.requests_with("attempts.artefact"),
        0,
        "no upload after the cancellation"
    );
    assert_eq!(world.requests_with(SUBMISSION), 0);
    assert!(
        !world.is_acked(&job.message),
        "an abandoned job is not acknowledged"
    );
}

#[test]
fn a_long_job_probes_its_attempt_and_stops_when_it_was_cancelled() {
    let harness = Harness::new();
    let job = harness.enqueue_replay(&small_case(), "probe");
    {
        let mut world = harness.world();
        // 25 seconds pass while the third input is read, then the job steps the evaluator: its
        // first chunk finds that 20 seconds passed since the last probe and reads an input again.
        // That fourth read finds the attempt cancelled.
        world.on("attempts.input", 3, Action::Advance(25));
        world.on("attempts.input", 4, Action::CancelAttempts);
    }
    let handled = worker_handled(&harness.poll(), &job.message);
    let Handled::Abandoned { reason } = handled else {
        panic!("{handled:?}");
    };
    assert!(reason.contains("STALE_OWNERSHIP"), "{reason}");
    let world = harness.world();
    assert_eq!(
        world.requests_with("attempts.input"),
        4,
        "the probe is one more input read"
    );
    assert_eq!(
        world.requests_with("attempts.artefact"),
        0,
        "the result was never uploaded"
    );
    assert!(world.accepted.is_empty());
}

#[test]
fn a_claim_for_an_attempt_that_is_not_pending_is_acknowledged_and_does_nothing() {
    let harness = Harness::new();
    let job = harness.enqueue_replay(&small_case(), "claimed");
    harness
        .world()
        .attempts
        .get_mut(&job.attempt_id)
        .unwrap()
        .state = AttemptState::Claimed;
    let handled = worker_handled(&harness.poll(), &job.message);
    assert!(
        matches!(&handled, Handled::NotClaimable { code, acked: true } if code == "ATTEMPT_NOT_CLAIMABLE"),
        "{handled:?}"
    );
    let world = harness.world();
    assert_eq!(world.requests_with("attempts.input"), 0);
    assert!(world.is_acked(&job.message));
}

#[test]
fn a_stale_ownership_revision_at_the_claim_is_acknowledged() {
    let harness = Harness::new();
    let job = harness.enqueue_replay(&small_case(), "stale");
    harness.world().on(
        "attempts.claim",
        1,
        Action::Refuse {
            status: 409,
            code: "STALE_OWNERSHIP".to_owned(),
        },
    );
    let handled = worker_handled(&harness.poll(), &job.message);
    assert!(
        matches!(&handled, Handled::NotClaimable { code, acked: true } if code == "STALE_OWNERSHIP"),
        "{handled:?}"
    );
}

#[test]
fn other_claim_refusals_give_the_message_back_with_a_delay() {
    for (code, status, delay) in [
        ("EXECUTION_DISABLED", 409, 300),
        ("IDENTITY_MISMATCH", 422, 300),
        ("NOT_FOUND", 404, 300),
        ("UNAVAILABLE", 503, 30),
    ] {
        let harness = Harness::new();
        let job = harness.enqueue_replay(&small_case(), "refused");
        harness.world().on(
            "attempts.claim",
            1,
            Action::Refuse {
                status,
                code: code.to_owned(),
            },
        );
        let handled = worker_handled(&harness.poll(), &job.message);
        assert!(
            matches!(&handled, Handled::ClaimRefused { code: c, retried: true } if c == code),
            "{code}: {handled:?}"
        );
        let world = harness.world();
        assert_eq!(world.retries, vec![(job.message.clone(), delay)], "{code}");
        assert!(!world.is_acked(&job.message), "{code}");
        assert_eq!(
            world.requests_with("attempts.input"),
            0,
            "{code}: no input is read after a refused claim"
        );
    }
}

#[test]
fn execution_disabled_is_a_switch_of_the_deployment_and_nothing_runs() {
    let harness = Harness::new();
    let job = harness.enqueue_replay(&small_case(), "disabled");
    harness.world().execution_enabled = false;
    let handled = worker_handled(&harness.poll(), &job.message);
    assert!(
        matches!(&handled, Handled::ClaimRefused { code, .. } if code == "EXECUTION_DISABLED"),
        "{handled:?}"
    );
    assert_eq!(harness.world().requests_with("attempts.input"), 0);
    assert!(harness.world().accepted.is_empty());
}

#[test]
fn a_rate_limited_claim_is_repeated_because_the_api_says_nothing_changed() {
    let harness = Harness::new();
    let job = harness.enqueue_replay(&small_case(), "rate");
    harness.world().on(
        "attempts.claim",
        1,
        Action::Refuse {
            status: 429,
            code: "RATE_LIMITED".to_owned(),
        },
    );
    let handled = worker_handled(&harness.poll(), &job.message);
    assert!(
        matches!(handled, Handled::Completed { acked: true, .. }),
        "{handled:?}"
    );
    assert_eq!(harness.world().requests_with("attempts.claim"), 2);
    assert_eq!(
        harness.time.sleeps(),
        vec![500],
        "one bounded wait between the two claims"
    );
}

#[test]
fn a_refused_credential_stops_the_worker_instead_of_looping() {
    let harness = Harness::new();
    let job = harness.enqueue_replay(&small_case(), "denied");
    let _ = job;
    harness.world().on(
        "attempts.claim",
        1,
        Action::Refuse {
            status: 401,
            code: "UNAUTHENTICATED".to_owned(),
        },
    );
    let error = harness.worker().poll_once().unwrap_err();
    assert_eq!(
        error,
        WorkerError::Unauthorized("the batch credential".to_owned())
    );

    // The same for a queue token that the queue refuses.
    let mut harness = Harness::new();
    harness.set(
        "OPENQUANT_QUEUE_TOKEN",
        "a-queue-token-that-the-queue-refuses",
    );
    let error = harness.worker().poll_once().unwrap_err();
    assert_eq!(
        error,
        WorkerError::Unauthorized("the queue token".to_owned())
    );
}

#[test]
fn a_message_that_is_not_a_dispatch_is_given_back_with_a_long_delay_and_never_acknowledged() {
    let harness = Harness::new();
    let id = harness.world().enqueue_raw(json!({"hello": "world"}));
    let handled = worker_handled(&harness.poll(), &id);
    assert!(
        matches!(&handled, Handled::Poison { code, retried: true } if !code.contains("QUEUE")),
        "{handled:?}"
    );
    let world = harness.world();
    assert_eq!(world.retries, vec![(id.clone(), 3_600)]);
    assert!(!world.is_acked(&id));
    assert_eq!(
        world.requests_with("attempts.claim"),
        0,
        "nothing was claimed for a poison message"
    );
}

#[test]
fn a_message_for_another_environment_is_not_claimed() {
    let mut harness = Harness::new();
    harness.set("OPENQUANT_ENVIRONMENT", "DEVELOPMENT");
    let job = harness.enqueue_replay(&small_case(), "env");
    let handled = worker_handled(&harness.poll(), &job.message);
    assert_eq!(handled, Handled::WrongEnvironment { retried: true });
    assert_eq!(harness.world().requests_with("attempts.claim"), 0);
    assert_eq!(harness.world().retries, vec![(job.message, 300)]);
}

/// The pull-consumer documentation of Cloudflare Queues (1 July 2026): a `json` or `bytes` body
/// arrives base64-encoded (RFC 4648), a `text` body as a plain UTF-8 string, and a pull consumer
/// cannot decode `v8`. The content type is `metadata["CF-Content-Type"]` in its example.
#[test]
fn a_base64_json_dispatch_with_its_content_type_is_decoded_and_run() {
    let harness = Harness::new();
    let job = harness.enqueue_replay(&small_case(), "base64");
    let text = harness.world().message_text(&job.message);
    harness.world().serve_as(
        &job.message,
        Some("json"),
        json!(BASE64.encode(text.as_bytes())),
    );
    let handled = worker_handled(&harness.poll(), &job.message);
    assert!(
        matches!(handled, Handled::Completed { acked: true, .. }),
        "{handled:?}"
    );
}

#[test]
fn a_text_dispatch_is_read_as_plain_utf8_and_run() {
    let harness = Harness::new();
    let job = harness.enqueue_replay(&small_case(), "text");
    let text = harness.world().message_text(&job.message);
    harness
        .world()
        .serve_as(&job.message, Some("text"), json!(text));
    let handled = worker_handled(&harness.poll(), &job.message);
    assert!(
        matches!(handled, Handled::Completed { acked: true, .. }),
        "{handled:?}"
    );
}

/// Serve a dispatch as `content_type` with `body`, poll once and return the poison code. The
/// message is given back with the poison delay, never claimed or acknowledged, and the log names
/// the content type and none of the body.
fn poison_code(content_type: Option<&str>, body: impl FnOnce(&str) -> String) -> String {
    let harness = Harness::new();
    let job = harness.enqueue_replay(&small_case(), "poison");
    let served = body(&harness.world().message_text(&job.message));
    harness
        .world()
        .serve_as(&job.message, content_type, json!(served));
    let handled = worker_handled(&harness.poll(), &job.message);
    let Handled::Poison {
        code,
        retried: true,
    } = handled
    else {
        panic!("{handled:?}");
    };
    let world = harness.world();
    assert_eq!(world.retries, vec![(job.message.clone(), 3_600)]);
    assert!(!world.is_acked(&job.message));
    assert_eq!(world.requests_with("attempts.claim"), 0);
    let log = harness.log_text();
    assert!(!log.contains(&served), "{log}");
    if code.contains("QUEUE") {
        let named = content_type.unwrap_or("(none)");
        assert!(log.contains(&format!("content type {named}")), "{log}");
    }
    code
}

#[test]
fn a_body_that_cannot_be_decoded_or_is_not_a_dispatch_is_poison() {
    // Not base64: the plain JSON text served as json, and a URL-safe alphabet.
    assert_eq!(
        poison_code(Some("json"), str::to_owned),
        "MALFORMED_QUEUE_BODY"
    );
    assert_eq!(
        poison_code(Some("json"), |text| {
            let mut encoded = BASE64.encode(text);
            encoded.replace_range(0..1, "-");
            encoded
        }),
        "MALFORMED_QUEUE_BODY"
    );
    // Base64 of bytes that are not UTF-8.
    assert_eq!(
        poison_code(Some("json"), |text| {
            let mut bytes = vec![0xff, 0xfe];
            bytes.extend_from_slice(text.as_bytes());
            BASE64.encode(bytes)
        }),
        "MALFORMED_QUEUE_BODY"
    );
    // Base64 of valid UTF-8 that is not a valid dispatch: the contract failure code.
    let code = poison_code(Some("json"), |text| {
        BASE64.encode(text.replace("job-dispatch/1", "job-dispatch/9"))
    });
    assert!(!code.contains("QUEUE"), "{code}");
    // v8 and a missing content type cannot be decoded by a pull consumer.
    assert_eq!(
        poison_code(Some("v8"), |text| BASE64.encode(text)),
        "UNSUPPORTED_QUEUE_ENCODING"
    );
    assert_eq!(
        poison_code(None, |text| BASE64.encode(text)),
        "UNSUPPORTED_QUEUE_ENCODING"
    );
}

#[test]
fn a_transient_api_failure_is_retried_within_the_bound_and_a_final_one_is_not() {
    // One 503 on the first artefact upload: the upload is repeated after a wait.
    let harness = Harness::new();
    let job = harness.enqueue_replay(&small_case(), "transient");
    harness.world().on(
        "attempts.artefact",
        1,
        Action::Refuse {
            status: 503,
            code: "UNAVAILABLE".to_owned(),
        },
    );
    let handled = worker_handled(&harness.poll(), &job.message);
    assert!(
        matches!(handled, Handled::Completed { acked: true, .. }),
        "{handled:?}"
    );
    assert_eq!(harness.time.sleeps(), vec![500]);

    // The API keeps refusing the submission with a final answer: the job ends without a result and
    // the message stays.
    let harness = Harness::new();
    let job = harness.enqueue_replay(&small_case(), "final");
    harness.world().on(
        SUBMISSION,
        1,
        Action::Refuse {
            status: 422,
            code: "IDENTITY_MISMATCH".to_owned(),
        },
    );
    let handled = worker_handled(&harness.poll(), &job.message);
    assert!(
        matches!(&handled, Handled::Abandoned { reason } if reason.contains("IDENTITY_MISMATCH")),
        "{handled:?}"
    );
    assert_eq!(
        harness.world().requests_with(SUBMISSION),
        1,
        "a final refusal is not repeated"
    );
    assert!(!harness.world().is_acked(&job.message));
}

#[test]
fn a_request_for_another_engine_or_method_is_refused_without_a_submission() {
    // The fixture request of the contracts carries a method digest that is not the running one:
    // the API would refuse any submission, so the worker does not make one.
    let harness = Harness::new();
    let case = small_case();
    let job = harness.enqueue_replay(&case, "engine");
    {
        // Rewrite the stored request with another engine digest. The stored bytes are keyed by
        // their digest, so a new request, dispatch and attempt are queued.
        let mut world = harness.world();
        let mut request = job.request.clone();
        request["engine"]["engine_digest"] = json!(format!("sha256:{}", "0".repeat(64)));
        request["run_id"] = json!("run-s0-engine-b");
        request["attempt"] = json!({"attempt_id": "att-s0-engine-b-1", "ownership_revision": 1});
        let request_ref = world.store_json(&request);
        let dispatch = batch_support::dispatch_value(
            "run-s0-engine-b",
            "att-s0-engine-b-1",
            1,
            json!({"kind": "evaluate", "request": request_ref}),
        );
        world.enqueue(&dispatch);
    }
    // The first message is the valid one; take it, then the other.
    let first = harness.poll();
    assert!(matches!(first, Polled::Message { .. }));
    let Polled::Message { handled, .. } = harness.poll() else {
        panic!("no second message");
    };
    let Handled::Abandoned { reason } = handled else {
        panic!("{handled:?}");
    };
    assert!(reason.contains("another engine digest"), "{reason}");
    assert_eq!(
        harness.world().accepted_on(SUBMISSION).len(),
        1,
        "only the valid request has a result"
    );
}

#[test]
fn an_empty_queue_is_polled_with_a_growing_pause_and_the_loop_stops_on_request() {
    let harness = Harness::new();
    let worker = Arc::new(harness.worker());
    let stop = worker.stop_flag();
    let runner = {
        let worker = Arc::clone(&worker);
        thread::spawn(move || worker.run())
    };
    // The fake clock moves only when the worker sleeps, so the gaps between pulls are exact.
    for _ in 0..2_000 {
        if harness.world().pull_times.len() >= 9 {
            break;
        }
        thread::sleep(Duration::from_millis(5));
    }
    stop.stop();
    runner.join().unwrap().unwrap();
    let times = harness.world().pull_times.clone();
    assert!(times.len() >= 9, "{times:?}");
    let gaps: Vec<i64> = times.windows(2).map(|w| w[1] - w[0]).take(8).collect();
    assert_eq!(
        gaps,
        vec![1, 2, 4, 8, 16, 30, 30, 30],
        "the pause doubles up to 30 seconds"
    );
}

#[test]
fn a_stop_request_ends_the_loop_after_the_current_message() {
    let harness = Harness::new();
    let job = harness.enqueue_replay(&small_case(), "stop");
    let second = harness.enqueue_replay(&s0_case("ENT-01-v2"), "stop-two");
    let worker = harness.worker();
    let stop = worker.stop_flag();
    stop.stop();
    worker.run().unwrap();
    assert_eq!(
        harness.world().requests_with("queue.pull"),
        0,
        "a stopped worker pulls nothing"
    );
    let _ = (job, second);
}

#[test]
fn no_credential_appears_in_the_log() {
    let harness = Harness::new();
    let job = harness.enqueue_replay(&small_case(), "log");
    let _ = harness.poll();
    let _ = job;
    let log = harness.log_text();
    assert!(log.contains("claimed") && log.contains("done"), "{log}");
    let world = harness.world();
    for secret in [&world.service_token, &world.queue_token] {
        assert!(!log.contains(secret.as_str()), "a credential is in the log");
    }
    let capability = world
        .attempts
        .values()
        .filter_map(|a| a.capability.clone())
        .next()
        .unwrap();
    assert!(!log.contains(&capability), "the capability is in the log");
}

//! The `retrieve` job: one bounded market-data retrieval (OQ-05 section 7.1; OQ-02 sections 1.1,
//! 2.5 and 2.6).
//!
//! The job reads its `retrieval-request/1`, asks the enablement gate and, only when the gate says
//! yes, runs the retrieval sequence of the market module over the egress module. Every provider
//! request goes through the egress allowlist and is counted; the count in the result is the
//! count the egress module made. A snapshot is uploaded (raw responses first when the terms permit
//! retention, then the manifest) and the result names the manifest. A failure, a block of the
//! gate, a missing credential and an empty snapshot are all results, never abandoned jobs, so
//! the run that depends on them is blocked with a reason instead of waiting.

use std::cell::RefCell;

use openquant_contracts::{Envelope, generated as g, payload_digest, validate};
use serde_json::{Value, json};

use super::{Abandoned, JSON_MEDIA_TYPE, JobContext, JobResult, Submitted, clip};
use crate::{
    batch::{
        api::ResultRoute,
        clock::{TimeClock, TimeSleeper},
        egress::Class,
    },
    market::{
        alpaca::AlpacaAdapter,
        error::ErrorClass,
        gate::{ProviderEvidence, decide},
        provider::{CallContext, CallRecord, Cancellation, MarketDataProvider},
        retrieve::{HostIdentity, limits_from_request, retrieve_snapshot},
    },
};

/// The version of the Alpaca adapter that the manifest records as `source.adapter`.
pub const ADAPTER_VERSION: &str = "1";

/// The provider id in capability references: `provider:alpaca/<operation>@1`.
const PROVIDER: &str = "alpaca";

/// Tells the retrieval to stop when the attempt was lost.
///
/// The retrieval asks before every provider request, retries and pages included. Each question is
/// the job's liveness probe ([`JobContext::heartbeat`]): it fails at once when an earlier call
/// marked the attempt lost or the lease is about to end, and once every
/// [`super::PROBE_INTERVAL_SECONDS`] it reads the request again, which an attempt that was
/// cancelled, fenced or expired cannot do. Without it a retrieval makes no API call until its first
/// upload, so a lost attempt would go on spending the provider budget until then.
struct Lost<'a> {
    cx: &'a JobContext<'a>,
    probe_digest: &'a str,
    /// Why the probe stopped the retrieval, for the job to return.
    stopped: RefCell<Option<Abandoned>>,
}

impl<'a> Lost<'a> {
    fn new(cx: &'a JobContext<'a>, probe_digest: &'a str) -> Self {
        Self {
            cx,
            probe_digest,
            stopped: RefCell::new(None),
        }
    }

    /// The abandonment that stopped the retrieval, once.
    fn take(&self) -> Option<Abandoned> {
        self.stopped.borrow_mut().take()
    }
}

impl Cancellation for Lost<'_> {
    fn is_cancelled(&self) -> bool {
        if self.stopped.borrow().is_some() {
            return true;
        }
        match self.cx.heartbeat(self.probe_digest) {
            Ok(()) => false,
            Err(abandoned) => {
                *self.stopped.borrow_mut() = Some(abandoned);
                true
            }
        }
    }
}

fn call_value(call: &CallRecord) -> Value {
    let mut value = json!({
        "sequence": call.sequence,
        "operation": call.operation.capability_ref(PROVIDER),
        "started_at": call.started_at.to_string(),
        "result": if call.succeeded() { "SUCCEEDED" } else { "FAILED" },
    });
    if let Some(object) = value.as_object_mut() {
        if let Some(status) = call.http_status {
            object.insert("http_status".to_owned(), json!(status));
        }
        if let Some(error) = call.error {
            object.insert("error".to_owned(), json!(error.wire_name()));
        }
    }
    value
}

struct Report<'a> {
    cx: &'a JobContext<'a>,
    request_digest: &'a str,
    started_at: String,
}

impl Report<'_> {
    fn submit(&self, outcome: Value, calls: &[CallRecord], requests: u32) -> Result<(), Abandoned> {
        let document = json!({
            "schema_version": "retrieval-result/1",
            "job_id": self.cx.dispatch.job_id.as_str(),
            "attempt": self.cx.attempt(),
            "request_digest": self.request_digest,
            "executable": self.cx.executable.to_value(),
            "outcome": outcome,
            "calls": calls.iter().map(call_value).collect::<Vec<_>>(),
            "usage": {
                "provider_requests": {"label": "observed", "count": requests},
                "provider_credits": {"label": "unknown", "reason": "the provider reports no credit usage"},
                "duration": self.cx.duration(),
            },
            "started_at": self.started_at,
            "finished_at": self.cx.time.now().to_string(),
        });
        validate(Envelope::RetrievalResult, &document).map_err(|e| {
            Abandoned::Internal(format!("the retrieval result breaks its schema: {e}"))
        })?;
        self.cx.submit(ResultRoute::Retrieval, &document)
    }

    fn failure(
        &self,
        class: ErrorClass,
        retryable: bool,
        retry_after: Option<u64>,
        detail: &str,
        calls: &[CallRecord],
        requests: u32,
    ) -> Result<(), Abandoned> {
        let mut outcome = json!({
            "status": "FAILED",
            "error": class.wire_name(),
            "retryable": retryable,
            "detail": clip(detail, 1000),
        });
        if let (Some(seconds), Some(object)) = (retry_after, outcome.as_object_mut()) {
            object.insert("retry_after_seconds".to_owned(), json!(seconds));
        }
        self.submit(outcome, calls, requests)
    }
}

/// Run one `retrieve` job.
///
/// # Errors
/// [`Abandoned`] when the request cannot be read or does not bind to the dispatch, the lease is
/// ending, the attempt was lost or an upload or the submission fails.
pub fn run(cx: &JobContext<'_>, inputs: &g::RetrieveJobInputs) -> JobResult {
    let request_digest = inputs.request.digest.as_str();
    let request: g::RetrievalRequest = cx.fetch_contract(request_digest, "retrieval request")?;
    if payload_digest(&request).map_err(|e| Abandoned::Internal(e.to_string()))? != request_digest {
        return Err(Abandoned::Unfit(
            "the stored retrieval request is not in canonical form".to_owned(),
        ));
    }
    if request.job_id.as_str() != cx.dispatch.job_id.as_str()
        || request.attempt != cx.dispatch.attempt
        || request.environment.to_string() != cx.config.environment
    {
        return Err(Abandoned::Unfit(
            "the retrieval request does not bind to the dispatch".to_owned(),
        ));
    }
    let report = Report {
        cx,
        request_digest,
        started_at: cx.time.now().to_string(),
    };

    // The gate comes first: a blocked retrieval makes no provider request.
    let unverified = ProviderEvidence::default();
    let evidence = cx.evidence.map_or(&unverified, |record| &record.evidence);
    let permit = match decide(cx.config.market_switch, evidence) {
        Ok(permit) => permit,
        Err(blocked) => {
            report.failure(
                ErrorClass::UnsupportedCapability,
                false,
                None,
                &blocked.to_string(),
                &[],
                0,
            )?;
            return Ok(Submitted {
                summary: "retrieval-result FAILED (gate blocked, no provider request)".to_owned(),
            });
        }
    };
    let (Some(record), Some(credentials)) = (cx.evidence, cx.config.alpaca.clone()) else {
        report.failure(
            ErrorClass::Authentication,
            false,
            None,
            "no provider credential or recorded terms are configured",
            &[],
            0,
        )?;
        return Ok(Submitted {
            summary: "retrieval-result FAILED (no provider credential)".to_owned(),
        });
    };

    let mut limits = limits_from_request(&request)
        .map_err(|e| Abandoned::Unfit(format!("the retrieval limits cannot be read: {e}")))?;
    // No provider request after the lease ends, whatever the request's own deadline says.
    limits.deadline = limits.deadline.min(cx.deadline);
    cx.egress.set_limit(Class::Provider, limits.max_requests);
    let executable = cx.executable.to_contract().map_err(Abandoned::Internal)?;
    let host = HostIdentity {
        executable: &executable,
        adapter_version: ADAPTER_VERSION,
        constraints: &record.constraints,
        licence: &record.licence,
    };
    let adapter = AlpacaAdapter::new(cx.egress, credentials);
    let clock = TimeClock(cx.time);
    let sleeper = TimeSleeper(cx.time);
    let lost = Lost::new(cx, request_digest);
    let mut calls = CallContext::new(limits, &clock, &sleeper, &lost);
    let outcome = retrieve_snapshot(
        &permit,
        &adapter as &dyn MarketDataProvider,
        &request,
        &host,
        &mut calls,
    );
    let requests = u32::try_from(calls.requests_made()).unwrap_or(u32::MAX);
    // A probe that found the attempt lost stopped the retrieval: nothing is reported or uploaded,
    // and the job ends with the reason the probe found.
    if let Some(stopped) = lost.take() {
        return Err(stopped);
    }
    if cx.cancel.is_cancelled() {
        return Err(Abandoned::Cancelled);
    }
    match outcome {
        Err(error) => {
            report.failure(
                error.class(),
                error.retryable(),
                error.retry_after_seconds(),
                &error.to_string(),
                calls.calls(),
                requests,
            )?;
            Ok(Submitted {
                summary: format!("retrieval-result FAILED {}", error.code()),
            })
        }
        Ok(snapshot) => {
            // The raw responses first, when the recorded terms let the host keep them.
            let stored: Vec<(u64, String)> = snapshot
                .manifest
                .pointer("/source_responses")
                .and_then(Value::as_array)
                .map(|list| {
                    list.iter()
                        .filter_map(|entry| {
                            Some((
                                entry.get("sequence")?.as_u64()?,
                                entry.pointer("/stored/digest")?.as_str()?.to_owned(),
                            ))
                        })
                        .collect()
                })
                .unwrap_or_default();
            for (sequence, expected) in stored {
                let body = calls
                    .sources()
                    .iter()
                    .find(|source| u64::from(source.sequence) == sequence)
                    .ok_or_else(|| {
                        Abandoned::Internal(format!("response {sequence} was not kept"))
                    })?;
                let uploaded = cx.upload(JSON_MEDIA_TYPE, &body.bytes)?;
                if uploaded.get("digest").and_then(Value::as_str) != Some(expected.as_str()) {
                    return Err(Abandoned::Internal(format!(
                        "response {sequence} does not hash to its manifest entry"
                    )));
                }
            }
            let manifest_ref = cx.upload(JSON_MEDIA_TYPE, snapshot.canonical_json.as_bytes())?;
            if manifest_ref.get("digest").and_then(Value::as_str) != Some(snapshot.digest.as_str())
            {
                return Err(Abandoned::Internal(
                    "the manifest does not hash to its identity digest".to_owned(),
                ));
            }
            let status = snapshot
                .manifest
                .pointer("/coverage/completeness")
                .and_then(Value::as_str)
                .unwrap_or("COMPLETE")
                .to_owned();
            report.submit(
                json!({"status": status, "manifest": manifest_ref}),
                calls.calls(),
                requests,
            )?;
            Ok(Submitted {
                summary: format!("retrieval-result {status}"),
            })
        }
    }
}

//! The `validate` job: the shared strategy validator and the lineage checks on a draft
//! (OQ-02 sections 3.1 and 4; OQ-05 section 4).
//!
//! The job reads the draft, its parent when it has one and the cohort policy, validates the draft
//! with the same validator that the evaluator uses, checks that the longest lookback fits the
//! cohort warm-up and, for a revision, recomputes the leaf difference from the parent and
//! classifies its scope by dependency (`REVISION_SCOPE`, `LINEAGE_MISMATCH`). The verdict is a
//! `validation-result/1`: `VALID` or `INVALID` both complete the job, and only a `VALID` result
//! registers the draft. A draft that does not even parse is an `INVALID` verdict with the contract
//! code, never an abandoned job.

use openquant_contracts::{
    ContractError, StrategyArtefact, generated as g, parse, payload_digest, to_value,
};
use openquant_core::lineage::{
    Diagnostic, Outcome, ValidationContext, check_revision, check_seed, validation_result,
};

use super::{Abandoned, JobContext, JobResult, Submitted, clip};
use crate::batch::{
    api::ResultRoute,
    identity::{running_engine_digest, running_method},
};

/// A contract code that a draft can fail with before the validator runs.
fn contract_code(error: &ContractError) -> &'static str {
    match error.failure_code().to_string().as_str() {
        "UNSUPPORTED_SCHEMA_VERSION" => "UNSUPPORTED_SCHEMA_VERSION",
        "INVALID_DECIMAL" => "INVALID_DECIMAL",
        _ => "SCHEMA_VIOLATION",
    }
}

fn unparsed(error: &ContractError) -> Outcome {
    let pointer = match error {
        ContractError::Schema(violations) => violations
            .first()
            .map(|v| clip(&v.pointer, 256))
            .unwrap_or_default(),
        _ => String::new(),
    };
    Outcome::Invalid(vec![Diagnostic {
        code: contract_code(error),
        pointer,
        detail: clip(&error.to_string(), 1000),
    }])
}

/// Run one `validate` job.
///
/// # Errors
/// [`Abandoned`] when an input cannot be read, the policy is not a cohort policy or the verdict
/// cannot be written.
pub fn run(cx: &JobContext<'_>, inputs: &g::ValidateJobInputs) -> JobResult {
    let policy_bytes = cx.fetch(inputs.cohort_policy.digest.as_str())?;
    let policy: g::CohortPolicy = super::parse_document(&policy_bytes, "cohort policy")?;
    let policy_value =
        to_value(&policy).map_err(|e| Abandoned::Internal(format!("cohort policy: {e}")))?;
    let warmup = policy_value
        .pointer("/conditions/windows/warmup_sessions")
        .and_then(serde_json::Value::as_u64)
        .and_then(|n| usize::try_from(n).ok())
        .ok_or_else(|| Abandoned::Unfit("the cohort policy states no warm-up".to_owned()))?;

    let draft_ref = &inputs.draft;
    let draft_bytes = cx.fetch(draft_ref.digest.as_str())?;
    let parent = match &inputs.parent {
        Some(parent_ref) => {
            let bytes = cx.fetch(parent_ref.digest.as_str())?;
            let parent: StrategyArtefact = super::parse_document(&bytes, "parent strategy")?;
            Some((parent_ref.digest.as_str().to_owned(), parent))
        }
        None => None,
    };

    let draft_text = std::str::from_utf8(&draft_bytes).ok();
    let outcome = match draft_text.map(parse::<StrategyArtefact>) {
        None => Outcome::Invalid(vec![Diagnostic {
            code: "SCHEMA_VIOLATION",
            pointer: String::new(),
            detail: "The draft is not UTF-8 text.".to_owned(),
        }]),
        Some(Err(error)) => unparsed(&error),
        Some(Ok(draft)) => {
            let actual = payload_digest(&draft)
                .map_err(|e| Abandoned::Internal(format!("draft digest: {e}")))?;
            if actual == draft_ref.digest.as_str() {
                match &parent {
                    Some((_, parent)) => check_revision(parent, &draft, warmup)
                        .map_err(|e| Abandoned::Internal(format!("lineage: {e}")))?,
                    None => check_seed(&draft, warmup),
                }
            } else {
                Outcome::Invalid(vec![Diagnostic {
                    code: "IDENTITY_MISMATCH",
                    pointer: String::new(),
                    detail: clip(
                        &format!(
                            "The stored draft is not in canonical form: its bytes hash to {} and its payload digest is {actual}.",
                            draft_ref.digest.as_str()
                        ),
                        1000,
                    ),
                }])
            }
        }
    };

    let engine_digest = running_engine_digest().map_err(Abandoned::Internal)?;
    let method = running_method();
    let context = ValidationContext {
        job_id: cx.dispatch.job_id.as_str(),
        attempt: cx.attempt(),
        executable: cx.executable.to_value(),
        engine_digest: &engine_digest,
        method: &method,
        draft_digest: draft_ref.digest.as_str(),
        parent_hash: parent.as_ref().map(|(hash, _)| hash.as_str()),
        duration: cx.duration(),
    };
    let result = validation_result(&context, &outcome)
        .map_err(|e| Abandoned::Internal(format!("validation result: {e}")))?;
    let document =
        to_value(&result).map_err(|e| Abandoned::Internal(format!("validation result: {e}")))?;
    let status = document
        .pointer("/outcome/status")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("?")
        .to_owned();
    cx.submit(ResultRoute::Validation, &document)?;
    Ok(Submitted {
        summary: format!("validation-result {status}"),
    })
}

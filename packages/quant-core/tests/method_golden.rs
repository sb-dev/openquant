//! Golden identity of the method text of derived evidence (OQ-02 section 7).
//!
//! The method text defines every formula, rounding rule, gate rule, reason code and lineage
//! classification of the derived evidence. Its SHA-256 is the method identity that metrics,
//! benchmarks, gates and validation results carry. These tests make a change to the text visible:
//! if one fails, the change is either a mistake or a decision. For a decision, update the text
//! below and the digest together with the compatibility note, and explain the changed numbers in
//! the change description. Engine identity is separate and must not move with it.
//!
//! The digest below was computed outside the crate with Python's `hashlib.sha256(text.encode())`
//! over the literal written here (see `fixtures/s1/metrics/README.md`).

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use openquant_contracts::{Contract, digest_bytes};
use openquant_core::{
    identity::{ENGINE_NAME, engine_digest, engine_identity},
    method::{METHOD_NAME, METHOD_VERSION, method_digest, method_identity, method_text},
};

/// The reviewed method text.
const EXPECTED_TEXT: &str = r#"openquant-evidence-methods version 1
Derived evidence of the S1 pilot: metrics, benchmarks, audits, gates, lineage and stored checkpoints.
The engine identity covers the numerical evaluation. This text is the method identity of everything derived from a result. Any change to it changes the method digest and needs an explicit compatibility decision (OQ-02 section 7).

ARITHMETIC
All arithmetic is exact. A value is a fraction of unbounded integers. Nothing is rounded before the end.
A value is rounded once, half to even, when it is written. A ratio is rounded to the metric_scale of the cohort policy. A money amount is rounded to the money_scale of the run and carries the currency of the policy. A count is an integer.
A value that rounds to zero is written without a sign. Comparison tolerance is zero.
A decimal text is read digit by digit: an optional minus sign, digits and an optional fraction. No exponent, no plus sign, no floating-point number.

METRICS
Input: one numerical result with outcome COMPLETED and the run that produced it. Only scored sessions count: the sessions from scored_start to scored_end of the run.
Refusal: an outcome that is not COMPLETED has no metrics. A result whose strategy hash, input hash or engine digest is not the run's is refused. A journal that does not fit the run is refused as inconsistent: a number of daily records that is not the number of processed sessions, a daily record for another session, a warm-up equity that is not the initial capital, a final equity that differs from the last daily equity, a gap-stop fill without a bar or above the open. An equity that is not positive is refused, because a ratio over it is undefined. Nothing is guessed.
series: E0 is the initial capital. E1 to En are the equity of the daily record of each scored session. n is the number of scored sessions.
net_return = En / E0 - 1.
max_drawdown = the largest (P - E) / P over t = 1 to n, where P is the highest of E0 to Et and E is the equity of session t. A loss on the first scored session counts against the initial capital. A series that never falls has a drawdown of zero.
worst_session_return = the lowest E(t) / E(t-1) - 1 over t = 1 to n, with E(0) = E0. It can be positive.
turnover = the sum of the notional of the fills of scored sessions, buys and sells, over E0.
trade_count = the number of trades whose exit session is a scored session and whose exit reason is not OPEN_AT_END. A position open at the end is not counted.
scored_session_count = n.
execution_cost.fees = the sum of the fee of the fills of scored sessions.
execution_cost.gap_slippage = the sum, over the GAP_STOP fills of scored sessions, of quantity * (open of the session of the fill - fill price). It is measured against the open, which is exactly recoverable from the result and the input; a stop level is not, when it is off the price grid.
execution_cost.total = fees + gap_slippage.
exposure = the mean over the scored sessions of positions_value(t) / equity(t).
excess_return (buy-and-hold) = the exact net_return of the strategy minus the exact net_return of the benchmark, rounded once. It can differ by one unit of the last digit from the difference of the two published values.
cash benchmark: net_return is zero and excess_return is the net_return of the strategy.
uncertainty: NOT_COMPUTED, with the limitation text of the cohort policy repeated verbatim.

BENCHMARK
The buy-and-hold benchmark runs on the same run: its cost model, its scenario and its corporate-action handling.
entry: the first session from scored_start to scored_end that has a bar. The buy is at the open of that session.
quantity: the largest multiple of the lot size whose notional plus the fee of the run's cost model fits the initial capital. The fee is the fixed fee plus fee_bps of the notional, rounded up to the money scale. The search is the evaluator's own lot search.
cash after the buy: the initial capital minus the notional minus the fee.
Before the buy session the equity is the initial capital. At the close of each session from the buy session to scored_end, equity = cash after the buy + dividend entitlements recorded so far + quantity * close.
corporate actions take effect before the open of their effective session, after the buy session only, on the quantity held at the start of the session. A split multiplies the quantity by new / old, and the result must be a whole number. A cash dividend is credited as the evaluator credits it: held * amount_per_share, less withholding_bps, rounded down to the money scale, counted in equity from the ex-date. A payment moves the amount from receivables to cash and does not change equity, so a payment after the scored end leaves the amount in equity at the final mark. A dividend of the buy session pays nothing. A dividend and a split of one day: the dividend counts the quantity before the split.
net_return and max_drawdown: as for the strategy, over the series E0 and the equity of each scored session. The position is never sold.
unavailable: the benchmark has no value, with a reason, and every gate that depends on it is INSUFFICIENT. The reasons are: "no session of the scored window has a bar"; "no whole lot is affordable at the first fillable open"; a lot search that overflows; a split that leaves a fractional share count; a corporate action of a kind that is not supported; "no bar to value the position at <date>".

AUDITS
Both audits read a COMPLETED result with its run, in exact arithmetic with zero tolerance. A difference fails the audit and is reported as text for the job log.
accounting reconciliation: every fill has notional = quantity * price, a buy has cash_delta = -(notional + fee), a sell has cash_delta = notional - fee, and no fee is negative. The cash ledger, replayed from the initial capital with no reserved cash and no receivables, reproduces the three balances that each line states: RESERVE moves cash from available to reserved, RELEASE back, FILL_BUY lowers and FILL_SELL raises available cash, DIVIDEND_RECEIVABLE raises receivables, DIVIDEND_PAYMENT moves receivables to available cash. Sequence numbers rise. The FILL_BUY and FILL_SELL lines are the fills, in order, with the same session and amount. The last line states the final balances. Every daily record and the final state satisfy equity = available + reserved + receivables + positions value. Each daily record states the balances of the ledger at the close of its session and a positions value equal to the quantity of its positions times the close of its session. The initial capital plus the cash of the fills plus the dividends paid equals available plus reserved cash at the end, and the receivables recorded less the dividends paid equal the final receivables.
signal and data timing: an entry fill is in phase OPEN of the first calendar session after the signal session of its intent. A STOP or TARGET fill is in phase DURING_SESSION and a GAP_STOP or GAP_TARGET fill in phase OPEN. Every corporate action is applied in phase BEFORE_OPEN of its effective session. Every bar of the run was available by the earlier of the open of the next session and the information cutoff, and by the cutoff alone at the last session. Every corporate action effective in the run was available by the earlier of the open of its effective session and the cutoff.

GATES
The cohort policy lists each gate once. NOT_APPLICABLE is reported NOT_APPLICABLE and RECORDED_INSUFFICIENT is reported INSUFFICIENT, each with reason code POLICY_RECORDED and the policy reason. REQUIRED is evaluated. A required gate with no reviewed method is an error, never a pass. A required gate repeats the limitation of the policy exactly when the policy records one, whatever its result.
evidence: a gate cites the digest of the submission of each run it read, and the digest of the validation result or the dataset manifest where it reads those. Every cited digest is among the inputs of the report.
threshold gates: EXCESS_OVER_BUY_AND_HOLD, WALK_FORWARD, MINIMUM_TRADE_COUNT and COST_STRESS. For each threshold and each window it lists, the regular run of that window and cost scenario is read; a deterministic repeat is never used. The metric is read from the published metrics document: net_return, max_drawdown, worst_session_return, turnover, trade_count, scored_session_count, exposure and buy_and_hold_return as published, execution_cost as the published total, excess_return_over_buy_and_hold as the published excess. It is compared exactly with the threshold: GREATER_THAN, AT_LEAST, LESS_THAN or AT_MOST. Every threshold must hold in every window. Nothing is averaged across windows. Each comparison is one observation.
precedence: a measured failure decides the gate by below_threshold, FAIL, or INSUFFICIENT with reason code BELOW_THRESHOLD, even when another window lacks evidence, because a threshold that provably fails cannot be rescued. Otherwise missing evidence makes the gate INSUFFICIENT with the code that names it. Otherwise the gate passes.
missing evidence, by code: RUN_MISSING for a run that was not written or did not report, or an evidence list without a run of the window; RUN_FAILED for a run that failed or never prepared; OUTSIDE_ENGINE_DOMAIN for ARITHMETIC_OVERFLOW; RUN_INSUFFICIENT for a run that ended INSUFFICIENT and has no metrics; METRICS_UNAVAILABLE for a completed run without a metrics document; BENCHMARK_UNAVAILABLE for a benchmark without a value.
DEFINITION_VALIDATION: FAIL when the validate job found the draft invalid, or when a run FAILED with a candidate defect: INVALID_LEVEL, UNSUPPORTED_OPERATOR, OPERATOR_TYPE_MISMATCH, OPERATOR_UNIT_MISMATCH or INVALID_PARAMETER. An operator code means that the definition does not validate in the engine. INVALID_LEVEL means that its exit rules give a level that breaks 0 < stop < entry < target on the data, which no static check can see. PASS with a valid result and no such run. INSUFFICIENT, code VALIDATION_FAILED, without a validation result.
mapping of a failed run: a candidate defect fails DEFINITION_VALIDATION only. Every gate that needs the run is INSUFFICIENT with RUN_FAILED, because a failed run has no ledger to reconcile, no timing to audit and no result to repeat, and a gate is not failed without evidence of a defect. Any other failure code is a platform defect and every gate that needs the run is INSUFFICIENT with RUN_FAILED. ARITHMETIC_OVERFLOW gives OUTSIDE_ENGINE_DOMAIN.
DETERMINISTIC_REPLAY: a run that repeats a base run is compared with it. Equal result digests PASS, different digests FAIL. No repeat, a missing base, or a run without a result is INSUFFICIENT.
ACCOUNTING_RECONCILIATION and SIGNAL_DATA_TIMING: every run of the evidence is audited. A failed audit of any run is FAIL. A run without a result is INSUFFICIENT. All audits passing is PASS.
POINT_IN_TIME_DATA: FAIL when the manifest has a bar or a corporate action without an availability time. INSUFFICIENT when a run failed with FUTURE_DATA, which the platform must explain, or when no manifest was read. PASS otherwise, with the limitation of the policy.
BASE_COST_MODEL: the policy of the input of every run equals the execution policy of the cohort for its scenario, decimals compared by value. A BASE run carries the policy as it is. A COST_STRESS run carries it with each cost component that the cohort names multiplied exactly by the multiplier and nothing else changed. A difference is FAIL.

LINEAGE
The leaf difference between a parent and a child compares both artefacts without strategy_id, version and parent. Objects are compared member by member and arrays of equal length element by element. A missing member, a different length or a different scalar is one change at its path. A changed value is written as a string as itself, an empty array as [], an array of named rules as their ids joined by a comma, anything else as its JSON text.
A declared change holds at most 256 characters in each field. A change that renders longer cannot be declared and is a LINEAGE_MISMATCH. Declared and computed changes are compared as sets.
classification by dependency: a change under /definition/entry affects the entry rule and a change under /definition/exits the exit rules. A changed indicator affects every rule that references it, directly or through other indicators. The entry rule reads indicators with operator:ref@1. The exit rules read the snapshots of the entry rule with operator:snapshot@1, and a snapshot expression reads indicators, so an indicator that a snapshot reads also affects every exit rule that names the snapshot, and a changed snapshot affects the entry rule by location and the exit rules that name it. References of both artefacts count, so a removed indicator still counts. A change to selection, sizing or execution, to an indicator that no rule references, or outside the definition is outside a controlled revision.
scope: ENTRY when every change affects only the entry rule, EXIT when every change affects only the exit rules. A revision with no change, with changes that affect both, or with a change outside a controlled revision is INVALID with REVISION_SCOPE. The pointer is the path of the first change outside, or empty.
checks of the validate job, in this order: a revision names its parent and the hash it names is the digest of the parent (IDENTITY_MISMATCH); the shared validator accepts the draft (its failure code); the longest lookback fits the warm-up (LOOKBACK_EXCEEDS_WARMUP); the declared changes equal the computed changes (LINEAGE_MISMATCH); the scope is ENTRY or EXIT (REVISION_SCOPE). A seed has no parent, no rule changes and no change scope.

STORED CHECKPOINT
A checkpoint is read from stored bytes only when the SHA-256 digest of the bytes equals the digest it is stored under. Then the bytes are parsed strictly and restored with every identity, cursor and consistency check of the engine. A body whose digest differs is never parsed.
"#;

/// SHA-256 of `EXPECTED_TEXT`, computed with Python `hashlib.sha256(text.encode()).hexdigest()`.
const METHOD_DIGEST: &str =
    "sha256:f9ff643a1c197a0425a65bb38bc2dc53b0b1cc9f97ecdecea37690acedce0123";

/// The engine digest golden of `tests/identity_golden.rs`, repeated so that a change to the
/// method text can never be mistaken for, or hidden by, a change to the engine.
const ENGINE_DIGEST: &str =
    "sha256:7ceafb5e32e05c234b2a4cd2915946d4c6273ea9455d7b4f98821712555bb36a";

#[test]
fn the_method_text_is_the_reviewed_text() {
    assert_eq!(method_text(), EXPECTED_TEXT);
}

#[test]
fn the_method_digest_is_the_golden_digest() {
    assert_eq!(method_digest(), METHOD_DIGEST);
    assert_eq!(digest_bytes(EXPECTED_TEXT.as_bytes()), METHOD_DIGEST);
}

#[test]
fn the_identity_carries_the_name_version_and_digest() {
    let identity = method_identity();
    assert_eq!(identity.name, "openquant-evidence-methods");
    assert_eq!(identity.name, METHOD_NAME);
    assert_eq!(identity.version, "1");
    assert_eq!(identity.version, METHOD_VERSION);
    assert_eq!(identity.digest, METHOD_DIGEST);
}

#[test]
fn method_identity_is_not_engine_identity() {
    let engine = engine_identity().unwrap();
    let digest = engine_digest(&engine).unwrap();
    assert_eq!(
        digest, ENGINE_DIGEST,
        "the engine digest must not move with the method text"
    );
    assert_ne!(digest, METHOD_DIGEST);
    assert_eq!(engine.name.as_str(), ENGINE_NAME);
    // The engine identity lists the four engine-scope contracts and no envelope or method.
    assert_eq!(Contract::ALL.len(), 4);
    assert_eq!(engine.schema_versions.len(), 4);
}

#[test]
fn the_text_names_every_gate_the_cohort_suite_lists() {
    // The cohort policy lists 17 gates; every gate with a reviewed method has a rule in the text.
    for gate in [
        "DEFINITION_VALIDATION",
        "DETERMINISTIC_REPLAY",
        "ACCOUNTING_RECONCILIATION",
        "SIGNAL_DATA_TIMING",
        "POINT_IN_TIME_DATA",
        "BASE_COST_MODEL",
        "EXCESS_OVER_BUY_AND_HOLD",
        "WALK_FORWARD",
        "MINIMUM_TRADE_COUNT",
        "COST_STRESS",
    ] {
        assert!(
            EXPECTED_TEXT.contains(gate),
            "{gate} has no rule in the method text"
        );
    }
}

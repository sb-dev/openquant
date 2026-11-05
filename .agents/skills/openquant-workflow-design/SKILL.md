---
name: openquant-workflow-design
description: Design or review OpenQuant ResearchWorkflow and EvaluationWorkflow, recurring research schedules, durable attempts, transactional outbox dispatch, leases, cancellation, recovery, and workflow failure tests.
---

# OpenQuant workflow design

Read `AGENTS.md`, OQ-05 §§3–5 in `docs/specs/05-system-architecture-and-data-spec.md`, and OQ-03 §5 in `docs/specs/03-model-backed-execution-spec.md`. Resolve paths from the repository root. This skill designs product workflows; it does not start scheduled jobs or live trading.


Use `openquant-service-integrations` and OQ-05 §7.1 for provider adapters. Freeze the research profile and source evidence for each cycle. Enforce retrieval budgets and cutoff restrictions in code; preserve partial, missing and unknown evidence. Use OQ-02 §1.1 for watchlist membership and source identity.

## Define one outcome

State the trigger, logical run identity, authoritative records, completion condition, budget dimensions, and operator-visible result. Declare candidate, experiment, compute, LLM-spend, and revision limits, or identify which are outside this slice. Define budget units explicitly. Separate research completion, gate results, and promotion decisions. A mission can complete with no eligible candidate.

For recurring watchlist research, specify the watchlist version, calendar, timezone, due slot, data cutoff, and catch-up policy. Do not assume a watchlist schema or API already exists. Put new semantics in their owning specification before implementing them. Deduplicate repeated schedule triggers by logical slot.

## Map each transition

Produce a compact table with current state, event, precondition/revision, durable write, external effect, retry rule, and recovery action. Include cancelled, failed, blocked, and unknown outcomes where the contract needs them; do not silently add them to existing enums.

Keep coordination in Cloudflare Workflows and native/model execution on Fly.io. Use `ResearchWorkflow` for proposals, independent critique, and bounded revisions. Use `EvaluationWorkflow` for frozen manifests, engine work, and official evidence. Keep ordinary approvals as guarded commands. For cohort criticism, define candidate-hash binding, per-candidate coverage, and partial completion. Do not assume one critic invocation covers every candidate unless the contract supports it.

Persist the run, budget reservation, and outbox entry in one transaction. Assume delivery can repeat. Distinguish logical run, execution attempt, application lease/revision, and queue receipt. Only the current application owner may complete an attempt.

Submit the existing agent attempt by authenticated HTTPS. Require a durable claim before tool startup. Return acceptance promptly and poll stored status with bounds. Resolve a lost dispatch response under the same ID before spawning another process.

Keep one HTTP-pull queue for batch engine work. Acknowledge only after the terminal result commits. Bound or checkpoint work against the verified queue visibility contract. Do not use queue visibility as the sole ownership fence. Keep live orders, halts, and raw ticks off this queue.

Upload immutable artefacts, then validate identity, hashes, schema, and ownership before committing evidence. Notify after commit. Recovery must find unissued outbox work and expired attempts without a connected terminal.

## Test the failure paths

Cover duplicate schedules, duplicate delivery, lost acceptance responses, death after claim, budget exhaustion, cancellation racing with completion, lease expiry, stale-owner completion, upload-before-commit failure, and notify-after-commit failure. For each, state the durable state and next safe action.

Reuse one recorded attempt when resolving ambiguity. Create a new attempt and reservation only when policy permits fresh execution. Lease expiry does not prove process termination or release reserved spend. Retain unknown cost conservatively. Verify termination or isolation and remaining budget before retrying. Demonstrate that overlapping calls cannot exceed the budget and stale workers cannot replace evidence.

Use official Cloudflare documentation to verify current API methods and limits before coding. Use installed `wrangler`, `workers-best-practices`, and `durable-objects` only where their responsibility applies. Do not add Temporal, n8n, Agents SDK, or another queue to satisfy a generic workflow example.

## Deliver

Provide the transition table, affected paths, recovery rules, and smallest end-to-end test. Cite owning sections. Label provider assumptions and untested deployment behaviour explicitly.

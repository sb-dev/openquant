---
name: ml4t-agent-tool-contracts
description: Define typed and bounded research tools with provenance and policy enforcement outside the model. Use when exposing provider retrieval or evidence to agents.
---

# Research tool contracts

Read OQ-03 §§1 and 4 and OQ-05 §§7.1 and 9 in `docs/specs/`. Tools are application boundaries. Skill text cannot enforce access or budgets.

## Specify each tool

Declare the operation, strict input/output schema, required capability, caller/run/attempt scope, permitted instruments/sources, cutoff, result-size bound, deadline, budget reservation and cancellation behaviour. Reject unknown mandatory semantics. Use task-specific verbs rather than a generic shell, URL fetch or database tool.

Validate in host code before I/O. Check account entitlements and shared limits. Restrict URLs and redirects to permitted public targets; reject internal addresses. Credentials stay in the adapter host. Sources, filenames and returned text cannot change role instructions, permissions or tool choice policy.

Return typed outcomes distinguishing no result, partial retrieval, unsupported capability, unavailable data and execution failure. Include provenance, timing precision, hashes/references, usage and unresolved cost. A valid response is not acceptance of its financial claims.

Record redacted request identity, status, duration, usage and result size. Never log raw secret-bearing URLs, complete sensitive queries or source payloads by default. Provider retries remain bounded and billed attempts remain visible. A lost response does not prove no cost was incurred.

## Verify

Test malformed/extra fields, identity mismatch, denied sources, date cutoff violations, hidden holdout access, private URL/redirect targets, injected instructions, oversized output, cancellation and unknown usage. Ensure only the guarded API can accept evidence. Proposers and critics cannot overwrite official numbers or enlarge their allowances.

Adapted from ML4T skills at revision `691857537a0c8befc11dc2f2ad7a458b7c7e801c`. Original Apache-2.0 licence and attribution remain in `.claude/third-party/ml4t/skills`. OpenQuant adaptation: 2026-11-05.

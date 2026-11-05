---
name: ml4t-fetch-data
description: Retrieve financial data through bounded provider adapters and validate coverage, semantics and provenance. Use when implementing or reviewing financial data ingestion.
---

# Fetch financial data

Read OQ-02 §1.1 and OQ-05 §7.1 in `docs/specs/` before changing OpenQuant retrieval. Resolve paths from the repository root. Use this as development guidance; product agents receive a separately reviewed bundle.

## Freeze the request

Identify provider/feed, account entitlements, stable instrument mapping, date range, cutoff, session/calendar, currency, interval and adjustment policy. Declare history, completeness and freshness requirements before retrieval. An as-of parameter does not prove historical availability.

Implement the provider interface in its owning host. Keep provider-specific fields, authentication and pagination inside the adapter. Use OpenQuant wire schemas and decimal rules. Python/ML4T libraries are not required dependencies.

## Fetch and preserve

1. Reserve request/credit budget and enforce the shared provider/account rate limit.
2. Bound pages, result size, elapsed time, retries and concurrency. Validate pagination targets. Honour retry hints for transient errors. Do not retry authentication or unsupported-capability failures as transient errors. A retry needs its own allowance while any unresolved billed usage stays reserved.
3. Distinguish no observations, incomplete history, partial retrieval, entitlement failure and malformed response. A successful HTTP status does not prove coverage.
4. Preserve permitted source bytes, request semantics, source IDs, timestamps and precision, usage, adapter/transformation version and hashes. Redact credentials from records and logs.
5. Normalize once at the adapter boundary, validate before freezing the dataset, and return a manifest. Corrections create new snapshots. A cached result must match all semantic inputs and access scope.

## Preserve financial meaning

Separate raw execution prices from derived signals/returns. State split and dividend treatment and apply each adjustment once. Never choose `adj_close` unconditionally or treat split-adjusted bars as total return. Use instrument/session calendars to classify gaps. Repeated prices can be valid; investigate before marking a feed stale. Do not silently forward-fill executable prices or combine providers.

## Verify

Exercise pagination, truncation, empty/partial results, bad schema, cancellation, timeout, rate limits and exhausted budgets. Compare independently specified transformations. Use permitted fixtures offline and bounded live probes separately. Report documented capability, fixture behaviour and actual service access as different evidence.

Adapted from ML4T skills at revision `691857537a0c8befc11dc2f2ad7a458b7c7e801c`. Original Apache-2.0 licence and attribution remain in `.claude/third-party/ml4t/skills`. OpenQuant adaptation: 2026-11-05.

---
name: ml4t-validate-data
description: Validate financial data for schema errors, missing sessions, duplicates, corporate actions and provenance before research or evaluation.
---

# Validate financial data

Read OQ-02 §§1.1 and 3 and OQ-05 §7 in `docs/specs/`. Validate with OpenQuant contracts; do not adopt a second Python schema or numerical engine.

## Check the dataset

1. Verify schema/version, stable instrument identity, units, currency, timezone/session, observation order and requested versus returned coverage.
2. Check finite values, precision, high/low relationships and open/close bounds where the instrument/bar contract requires them. Keep decimal transformations consistent with the Rust core.
3. Detect duplicate identities. Identical retransmissions may be deduplicated under a declared rule; conflicting observations require explicit revision handling. Preserve the originals and the decision.
4. Compare expected sessions with observed bars. Distinguish holidays, early closes, halts, no qualifying trades, missing pages and source outages. Never infer completeness solely from row count.
5. Check declared split/dividend adjustments against corporate-action records. Investigate extreme moves and repeated prices; neither is automatically a data error. Do not erase valid adverse returns or invent delisting proceeds.
6. Check event, publication, availability and retrieval times separately. Preserve unknown times and timestamp precision. Exclude evidence that cannot satisfy the registered cutoff policy.

## Decide and record

Separate invalid structure from quality findings needing investigation. Apply predeclared thresholds and explain exclusions. Missing required evidence cannot pass. Do not repair an official dataset silently; produce a new version with provenance. Forward-fill is allowed only for explicitly defined derived features with freshness limits, never as invented trades, fills or executable prices.

## Verify

Use small independent fixtures for split/dividend treatment, valid large moves, halts, conflicting duplicates, missing sessions and revised records. Run validation on every new snapshot. Report findings and affected research eligibility. A provider agreement check is not an independent numerical baseline.

Adapted from ML4T skills at revision `691857537a0c8befc11dc2f2ad7a458b7c7e801c`. Original Apache-2.0 licence and attribution remain in `.claude/third-party/ml4t/skills`. OpenQuant adaptation: 2026-11-05.

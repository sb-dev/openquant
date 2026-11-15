# E-03-429-then-ok: HTTP 429 with Retry-After: wait, retry once, then succeed

Synthetic, Alpaca-shaped data on an invented instrument. Derived by hand; the oracle asserts the values marked below.

## Derivation

1. The first asset call answers 429 with `Retry-After: 3`. The wait is the larger of the first backoff (1 s) and 3 s: 3 s. The clock moves 3 s and the same request is sent again.
2. Two asset calls are billed: call 1 failed (RATE_LIMITED, retry hint 3) and call 2 succeeded. Every later call is one more. The source response of the asset has sequence 2 and received_at 10:00:03Z.

## Expected outcome

The manifest is in `expected.json`; its digest is `sha256:947f7edcf1792da85e2a2625fccb063e4459f7077ad685734b28da263c6f987f`.
Coverage: COMPLETE, 5 bars. Price scale 2, money scale 2.

Hand-derived values, asserted by the oracle:

- asset source sequence: `2`
- asset source received_at: `"2026-11-14T10:00:03Z"`
- retrieved_at: `"2026-11-14T10:00:03Z"`

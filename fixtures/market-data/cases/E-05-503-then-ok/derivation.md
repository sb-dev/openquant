# E-05-503-then-ok: HTTP 503 is transient: backoff and retry

Synthetic, Alpaca-shaped data on an invented instrument. Derived by hand; the oracle asserts the values marked below.

## Derivation

1. The first bar request answers 503. No Retry-After, so the wait is the first backoff, 1 s. The retry succeeds.
2. The calls are: asset (1), calendar (2), bars 503 (3), bars ok (4), actions (5). The bars and actions responses carry received_at 10:00:01Z.

## Expected outcome

The manifest is in `expected.json`; its digest is `sha256:3c24add78f335534c39c2d8538ba36613eef74ad7f7b7d3524ed7be5b60ce6c1`.
Coverage: COMPLETE, 5 bars. Price scale 2, money scale 2.

Hand-derived values, asserted by the oracle:

- bars source sequence: `4`
- actions source received_at: `"2026-11-14T10:00:01Z"`

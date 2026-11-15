# E-16-egress-refused: An egress refusal is a policy failure and is never retried

Synthetic, Alpaca-shaped data on an invented instrument. Derived by hand; the oracle asserts the values marked below.

## Derivation

1. The transport reports that the egress allowlist refused the request. It is a configuration failure, not a transient one: one call, no retry.

## Expected outcome

The retrieval fails with `EGRESS_REFUSED` (class EGRESS_REFUSED, retryable false).
Billed calls: 1. Waits: none.

# E-06-redirect: A redirect is refused, even to the same host

Synthetic, Alpaca-shaped data on an invented instrument. Derived by hand; the oracle asserts the values marked below.

## Derivation

1. HTTP 302 with a Location on the same host. The egress policy follows no redirect: the call fails with class EGRESS_REFUSED, not retried (retrieval-result/1 rejects a retryable egress refusal).

## Expected outcome

The retrieval fails with `REDIRECT_REFUSED` (class EGRESS_REFUSED, retryable false).
Billed calls: 1. Waits: none.

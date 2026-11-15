# E-01-401: HTTP 401 is an authentication failure and is not retried

Synthetic, Alpaca-shaped data on an invented instrument. Derived by hand; the oracle asserts the values marked below.

## Derivation

1. The first call, the asset read, answers 401. Authentication is never retried: one call is made and one is billed.
2. The retrieval fails with class AUTHENTICATION, retryable false (retrieval-result/1 forces false for this class).

## Expected outcome

The retrieval fails with `AUTHENTICATION` (class AUTHENTICATION, retryable false).
Billed calls: 1. Waits: none.

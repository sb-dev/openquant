# E-02-403: HTTP 403 is a permission failure and is not retried

Synthetic, Alpaca-shaped data on an invented instrument. Derived by hand; the oracle asserts the values marked below.

## Derivation

1. The asset and the calendar succeed (calls 1 and 2). The bar request, call 3, answers 403: the key has no entitlement for the feed. Not retried; the profile does not fall back to another feed.

## Expected outcome

The retrieval fails with `PERMISSION` (class PERMISSION, retryable false).
Billed calls: 3. Waits: none.

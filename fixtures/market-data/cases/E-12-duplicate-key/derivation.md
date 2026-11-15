# E-12-duplicate-key: A duplicate JSON key is a malformed response

Synthetic, Alpaca-shaped data on an invented instrument. Derived by hand; the oracle asserts the values marked below.

## Derivation

1. The asset record repeats the key `id` with two values. The last value must not silently win: the response is malformed.

## Expected outcome

The retrieval fails with `MALFORMED_RESPONSE` (class MALFORMED_RESPONSE, retryable false).
Billed calls: 1. Waits: none.

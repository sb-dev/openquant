# E-07-malformed-json: A body that is not JSON is a malformed response

Synthetic, Alpaca-shaped data on an invented instrument. Derived by hand; the oracle asserts the values marked below.

## Derivation

1. HTTP 200 with an HTML body. The call was made and billed but it did not return a usable response, so the call log marks it MALFORMED_RESPONSE. Not retried.

## Expected outcome

The retrieval fails with `MALFORMED_RESPONSE` (class MALFORMED_RESPONSE, retryable false).
Billed calls: 1. Waits: none.

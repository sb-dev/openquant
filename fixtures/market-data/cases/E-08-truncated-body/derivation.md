# E-08-truncated-body: A truncated JSON body is a malformed response

Synthetic, Alpaca-shaped data on an invented instrument. Derived by hand; the oracle asserts the values marked below.

## Derivation

1. The bar response is cut off after 120 bytes. The JSON ends inside a value, so it is a malformed response and no partial bars are used.

## Expected outcome

The retrieval fails with `MALFORMED_RESPONSE` (class MALFORMED_RESPONSE, retryable false).
Billed calls: 3. Waits: none.

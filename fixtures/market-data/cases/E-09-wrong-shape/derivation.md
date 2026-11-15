# E-09-wrong-shape: A JSON body of the wrong shape is a malformed response

Synthetic, Alpaca-shaped data on an invented instrument. Derived by hand; the oracle asserts the values marked below.

## Derivation

1. The bar response is valid JSON but has no `bars` member. A missing field is a malformed response, not an empty result (an empty result is `bars: null` or `[]`).

## Expected outcome

The retrieval fails with `MALFORMED_RESPONSE` (class MALFORMED_RESPONSE, retryable false).
Billed calls: 3. Waits: none.

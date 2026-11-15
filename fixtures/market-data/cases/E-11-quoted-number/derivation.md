# E-11-quoted-number: A price sent as a quoted string is a malformed response

Synthetic, Alpaca-shaped data on an invented instrument. Derived by hand; the oracle asserts the values marked below.

## Derivation

1. The first bar's open is the string "100.00" instead of the number 100.00. The adapter reads numbers only; a quoted number is never coerced.

## Expected outcome

The retrieval fails with `MALFORMED_RESPONSE` (class MALFORMED_RESPONSE, retryable false).
Billed calls: 3. Waits: none.

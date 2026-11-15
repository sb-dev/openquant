# E-15-response-too-large: A response above the size limit is refused

Synthetic, Alpaca-shaped data on an invented instrument. Derived by hand; the oracle asserts the values marked below.

## Derivation

1. max_response_bytes is 100. The asset record is larger, so the response is refused without being parsed.

## Expected outcome

The retrieval fails with `RESPONSE_TOO_LARGE` (class MALFORMED_RESPONSE, retryable false).
Billed calls: 1. Waits: none.

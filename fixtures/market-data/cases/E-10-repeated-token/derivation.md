# E-10-repeated-token: A page token that repeats is a malformed response

Synthetic, Alpaca-shaped data on an invented instrument. Derived by hand; the oracle asserts the values marked below.

## Derivation

1. Page 1 returns next_page_token `tok-loop`. Page 2, requested with it, returns the same token. Following it again would loop, so the retrieval fails; the budget would otherwise be spent on the loop.

## Expected outcome

The retrieval fails with `MALFORMED_RESPONSE` (class MALFORMED_RESPONSE, retryable false).
Billed calls: 4. Waits: none.

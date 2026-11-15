# E-04-429-exhausted: HTTP 429 until the retries are used up

Synthetic, Alpaca-shaped data on an invented instrument. Derived by hand; the oracle asserts the values marked below.

## Derivation

1. max_retries is 2, so the request is tried 3 times. Each 429 says `Retry-After: 2`; each wait is max(backoff, 2): backoff is 1 s then 2 s, so 2 s and 2 s.
2. The third 429 is returned with its hint preserved: 3 calls billed, waits [2, 2], and the error stays retryable for the job's attempt policy.

## Expected outcome

The retrieval fails with `RATE_LIMITED` (class RATE_LIMITED, retryable true).
Billed calls: 3. Waits: [2, 2].

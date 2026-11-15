# E-14-retry-after-past-deadline: A Retry-After beyond the deadline is not waited for

Synthetic, Alpaca-shaped data on an invented instrument. Derived by hand; the oracle asserts the values marked below.

## Derivation

1. The request is made at 10:00:00Z with the deadline at 10:15:00Z. The 429 carries an HTTP date, 10:20:00Z: a wait of 1200 s, which would end after the deadline.
2. The wait is not made and no second request goes out. The error keeps the hint, 1200 s, for the job's recovery policy.

## Expected outcome

The retrieval fails with `RATE_LIMITED` (class RATE_LIMITED, retryable true).
Billed calls: 1. Waits: none.

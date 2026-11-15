# E-13-budget-ends-mid-pagination: The request budget ends while bar pages remain

Synthetic, Alpaca-shaped data on an invented instrument. Derived by hand; the oracle asserts the values marked below.

## Derivation

1. max_requests is 4. Calls 1 and 2 read the asset and the calendar, calls 3 and 4 read two bar pages, and page 2 names a third. The fifth request is refused before any I/O.
2. A retrieval that stops here is partial and never complete: no manifest is returned. All 4 billed calls are recorded.

## Expected outcome

The retrieval fails with `REQUEST_LIMIT_REACHED` (class UNAVAILABLE_DATA, retryable false).
Billed calls: 4. Waits: none.

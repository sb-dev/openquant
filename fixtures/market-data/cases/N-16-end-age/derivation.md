# N-16-end-age: The request ends 15 minutes before it is made

Synthetic, Alpaca-shaped data on an invented instrument. Derived by hand; the oracle asserts the values marked below.

## Derivation

1. The request is made at 2026-11-13T21:10:00Z. The profile requires an end at least 15 minutes old: 21:10 minus 15 minutes is 20:55:00Z, earlier than the end of the requested day 23:59:59Z. The bar request ends at 2026-11-13T20:55:00Z.
2. November 2026 is standard time (daylight time ended on 1 November): the Friday bar is stamped 05:00Z, which is before 20:55Z, so it is inside the request. Its close is 21:00Z and it is available at 23:00Z.

## Expected outcome

The manifest is in `expected.json`; its digest is `sha256:2533aa453b96ccdd91b90b5b910e4e775544fab4d4049827053b0f7afb17b924`.
Coverage: COMPLETE, 5 bars. Price scale 2, money scale 2.

Hand-derived values, asserted by the oracle:

- Friday available_at: `"2026-11-13T23:00:00Z"`
- retrieved_at: `"2026-11-13T21:10:00Z"`

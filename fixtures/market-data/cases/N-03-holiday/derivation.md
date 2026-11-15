# N-03-holiday: A market holiday omitted by the provider calendar

Synthetic, Alpaca-shaped data on an invented instrument. Derived by hand; the oracle asserts the values marked below.

## Derivation

1. Monday 2024-01-15 is Martin Luther King Jr. Day. The provider calendar has no row for it and the provider has no bar for it.
2. The range 8 to 19 January has 10 weekdays, so 9 sessions. All 9 have a bar: COMPLETE, nothing missing.

## Expected outcome

The manifest is in `expected.json`; its digest is `sha256:6497e56cf417c6e0af8435fd851e004b8e8daeda1211566aaf4fcd8731959de2`.
Coverage: COMPLETE, 9 bars. Price scale 2, money scale 2.

Hand-derived values, asserted by the oracle:

- calendar sessions: `9`
- bar_count: `9`
- completeness: `"COMPLETE"`
- missing: `[]`

# N-10-empty: An empty bar response and no corporate actions

Synthetic, Alpaca-shaped data on an invented instrument. Derived by hand; the oracle asserts the values marked below.

## Derivation

1. The provider answers `bars: null` and an empty corporate_actions object. This is no observations, not a failure.
2. The calendar holds the 5 weekdays 3 to 7 June 2024; none has a bar. `returned` is absent, bar_count is 0 and all 5 sessions are missing.

## Expected outcome

The manifest is in `expected.json`; its digest is `sha256:55a1433de4a4206225b0256f97605e907c92a9d5091ec5fffd71731afca22434`.
Coverage: NO_OBSERVATIONS, 0 bars. Price scale 0, money scale 2.

Hand-derived values, asserted by the oracle:

- completeness: `"NO_OBSERVATIONS"`
- returned: `false`
- missing: `5`

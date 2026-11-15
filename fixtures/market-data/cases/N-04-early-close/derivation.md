# N-04-early-close: An early close: the data-ready delay runs from the early close

Synthetic, Alpaca-shaped data on an invented instrument. Derived by hand; the oracle asserts the values marked below.

## Derivation

1. Thursday 2024-11-28 is Thanksgiving (omitted). Friday 2024-11-29 closes at 13:00 local.
2. On 29 November New York is on standard time: 13:00 EST = 18:00Z, so `close_at` is 2024-11-29T18:00:00Z, not 21:00Z.
3. `available_at` = early close + 120 minutes = 20:00Z. A normal day, 2024-11-27, closes at 16:00 EST = 21:00Z and is available at 23:00Z.

## Expected outcome

The manifest is in `expected.json`; its digest is `sha256:b27029b49997b2dec29e6c8438b8707862eb915af921bf8d939d9035c4663df2`.
Coverage: COMPLETE, 4 bars. Price scale 2, money scale 2.

Hand-derived values, asserted by the oracle:

- early close_at: `"2024-11-29T18:00:00Z"`
- early-close bar available_at: `"2024-11-29T20:00:00Z"`
- normal bar available_at: `"2024-11-27T23:00:00Z"`
- sessions: `["2024-11-25", "2024-11-26", "2024-11-27", "2024-11-29"]`

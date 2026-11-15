# N-06-dst-autumn: Daylight saving ends on Sunday 2024-11-03

Synthetic, Alpaca-shaped data on an invented instrument. Derived by hand; the oracle asserts the values marked below.

## Derivation

1. US daylight time ends on the first Sunday of November: 2024-11-03. Friday 1 November is EDT (UTC-4), Monday 4 November is EST (UTC-5).
2. Friday 1 November: open 09:30 EDT = 13:30Z, close 16:00 EDT = 20:00Z, bar stamp 04:00Z, available 22:00Z.
3. Monday 4 November: open 09:30 EST = 14:30Z, close 16:00 EST = 21:00Z, bar stamp 05:00Z, available 23:00Z.

## Expected outcome

The manifest is in `expected.json`; its digest is `sha256:2bb77766c7614ba87c4421a11b6d616f5b9ff62715380efddecbe053c346864f`.
Coverage: COMPLETE, 3 bars. Price scale 2, money scale 2.

Hand-derived values, asserted by the oracle:

- close_at 1 November: `"2024-11-01T20:00:00Z"`
- available_at 1 November: `"2024-11-01T22:00:00Z"`
- open_at 4 November: `"2024-11-04T14:30:00Z"`
- available_at 4 November: `"2024-11-04T23:00:00Z"`

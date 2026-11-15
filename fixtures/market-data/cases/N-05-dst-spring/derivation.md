# N-05-dst-spring: Daylight saving starts on Sunday 2024-03-10

Synthetic, Alpaca-shaped data on an invented instrument. Derived by hand; the oracle asserts the values marked below.

## Derivation

1. US daylight time starts on the second Sunday of March: 2024-03-10. Friday 8 March is still EST (UTC-5), Monday 11 March is EDT (UTC-4).
2. Friday 8 March: open 09:30 EST = 14:30Z, close 16:00 EST = 21:00Z, bar stamp 05:00Z, available 23:00Z.
3. Monday 11 March: open 09:30 EDT = 13:30Z, close 16:00 EDT = 20:00Z, bar stamp 04:00Z, available 22:00Z.
4. Tuesday 12 March is the same as the 11th.

## Expected outcome

The manifest is in `expected.json`; its digest is `sha256:a57c1cd832ff969e2ef737169bc84154df18b90b38bd889134d1305967337e61`.
Coverage: COMPLETE, 3 bars. Price scale 2, money scale 2.

Hand-derived values, asserted by the oracle:

- open_at 8 March: `"2024-03-08T14:30:00Z"`
- close_at 8 March: `"2024-03-08T21:00:00Z"`
- available_at 8 March: `"2024-03-08T23:00:00Z"`
- open_at 11 March: `"2024-03-11T13:30:00Z"`
- close_at 11 March: `"2024-03-11T20:00:00Z"`
- available_at 11 March: `"2024-03-11T22:00:00Z"`

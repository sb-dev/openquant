# N-01-split: A 4-for-1 forward split, evidenced by its declaration date

Synthetic, Alpaca-shaped data on an invented instrument. Derived by hand; the oracle asserts the values marked below.

## Derivation

1. The range 2024-02-26 to 2024-03-08 holds 10 sessions: 26 to 29 February (4, 2024 is a leap year), 1 March (1) and 4 to 8 March (5).
2. The split is declared on 2024-02-28, strictly before its ex-date 2024-03-04, so the rule holds and `available_at` is the open of 2024-03-04.
3. In March 2024 New York is on standard time until 10 March: 09:30 is 14:30Z, 16:00 is 21:00Z.
4. The 2024-03-01 bar closes at 21:00Z and is available 120 minutes later, 23:00Z.
5. 4 new shares for 1 old share reduce to 4 and 1.

## Expected outcome

The manifest is in `expected.json`; its digest is `sha256:3b57959e067799a19d82b63e0958c2775032c9fb71dd29b0fa9717a8d8461093`.
Coverage: COMPLETE, 10 bars. Price scale 2, money scale 2.

Hand-derived values, asserted by the oracle:

- split `available_at`: `"2024-03-04T14:30:00Z"`
- ratio_new: `4`
- ratio_old: `1`
- bar_count: `10`
- available_at of the 2024-03-01 bar: `"2024-03-01T23:00:00Z"`

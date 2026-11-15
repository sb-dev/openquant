# N-11-payable-after-end: A dividend payable after the requested range end

Synthetic, Alpaca-shaped data on an invented instrument. Derived by hand; the oracle asserts the values marked below.

## Derivation

1. The ex-date 2024-12-12 is inside the range, the payable date 2024-12-16 (Monday) is after the range end 2024-12-13.
2. The snapshot calendar extends to the payment session: it holds the 10 sessions of the range and 2024-12-16, 11 in all. The provider calendar response ran further (to 45 days after the end) and is trimmed.
3. December is standard time: the ex-date opens at 14:30Z.

## Expected outcome

The manifest is in `expected.json`; its digest is `sha256:460029435e2be3cc9647eec3d6b061a63c0e41eb09a412aa60563b09c563943e`.
Coverage: COMPLETE, 10 bars. Price scale 2, money scale 2.

Hand-derived values, asserted by the oracle:

- calendar sessions: `11`
- last session: `"2024-12-16"`
- payment_session: `"2024-12-16"`
- requested end: `"2024-12-13"`
- bar_count: `10`

# N-13-special-dividend: A special cash dividend is kept as an unsupported distribution

Synthetic, Alpaca-shaped data on an invented instrument. Derived by hand; the oracle asserts the values marked below.

## Derivation

1. The provider marks the dividend special. The core cannot value a special distribution, so the action is kept (never dropped) as SPECIAL_DISTRIBUTION and makes the affected evidence INSUFFICIENT later.
2. Its availability still follows the dividend rule: declared 2024-06-04, before the ex-date 2024-06-10, so `available_at` is the open of 10 June: 09:30 EDT = 13:30Z.
3. A SPECIAL_DISTRIBUTION carries no amount or payment fields.

## Expected outcome

The manifest is in `expected.json`; its digest is `sha256:5eb9764457dff65a17e409d6f81f837d32c696604ead49e857b0ad03402c40e8`.
Coverage: COMPLETE, 10 bars. Price scale 2, money scale 2.

Hand-derived values, asserted by the oracle:

- kind: `"SPECIAL_DISTRIBUTION"`
- available_at: `"2024-06-10T13:30:00Z"`

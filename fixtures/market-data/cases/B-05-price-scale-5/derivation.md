# B-05-price-scale-5: Prices with five fractional digits block the profile

Synthetic, Alpaca-shaped data on an invented instrument. Derived by hand; the oracle asserts the values marked below.

## Derivation

1. The open 100.12345 needs 5 fractional digits. Prices are never rounded to fit; a scale above 4 blocks the profile.

## Expected outcome

The profile is blocked: `PRICE_SCALE_ABOVE_LIMIT` (subject `5`, class UNSUPPORTED_CAPABILITY). No manifest is produced.

# B-13-dividend-amount-precision: A dividend amount with nine fractional digits blocks the profile

Synthetic, Alpaca-shaped data on an invented instrument. Derived by hand; the oracle asserts the values marked below.

## Derivation

1. The core reads an amount with at most 8 fractional digits. 0.123456789 has 9 and is never rounded: the profile is blocked.

## Expected outcome

The profile is blocked: `INVALID_ACTION_VALUE` (subject `div-synth-2024-03-08`, class UNSUPPORTED_CAPABILITY). No manifest is produced.

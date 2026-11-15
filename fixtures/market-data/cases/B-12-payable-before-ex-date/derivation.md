# B-12-payable-before-ex-date: A payable date before the ex-date blocks the profile

Synthetic, Alpaca-shaped data on an invented instrument. Derived by hand; the oracle asserts the values marked below.

## Derivation

1. The payable date 2024-03-07 is a session but before the ex-date 2024-03-08. The core refuses a payment before the ex-date, so the profile is blocked.

## Expected outcome

The profile is blocked: `PAYABLE_BEFORE_EX_DATE` (subject `div-synth-2024-03-08`, class UNAVAILABLE_DATA). No manifest is produced.

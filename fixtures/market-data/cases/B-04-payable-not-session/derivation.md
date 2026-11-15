# B-04-payable-not-session: A payable date on a Saturday blocks the profile

Synthetic, Alpaca-shaped data on an invented instrument. Derived by hand; the oracle asserts the values marked below.

## Derivation

1. 2024-03-09 is a Saturday, so it is not a calendar session. No other session replaces it: the profile is blocked.

## Expected outcome

The profile is blocked: `PAYABLE_DATE_NOT_SESSION` (subject `div-synth-2024-03-08`, class UNAVAILABLE_DATA). No manifest is produced.

# B-02-dividend-declared-on-ex-date: A dividend declared on its ex-date blocks the profile

Synthetic, Alpaca-shaped data on an invented instrument. Derived by hand; the oracle asserts the values marked below.

## Derivation

1. The declaration date 2024-03-08 equals the ex-date. The bound holds only for a date strictly before the ex-date, so the profile is blocked.

## Expected outcome

The profile is blocked: `ACTION_DECLARED_NOT_BEFORE_EX_DATE` (subject `div-synth-2024-03-08`, class UNAVAILABLE_DATA). No manifest is produced.

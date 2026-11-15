# B-03-split-declared-after-ex-date: A split declared after its ex-date blocks the profile

Synthetic, Alpaca-shaped data on an invented instrument. Derived by hand; the oracle asserts the values marked below.

## Derivation

1. The declaration date 2024-03-07 is after the ex-date 2024-03-06. The action would not have been known at its open, so the profile is blocked.

## Expected outcome

The profile is blocked: `ACTION_DECLARED_NOT_BEFORE_EX_DATE` (subject `split-synth-2024-03-06`, class UNAVAILABLE_DATA). No manifest is produced.

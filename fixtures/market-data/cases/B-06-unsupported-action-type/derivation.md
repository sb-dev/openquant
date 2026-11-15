# B-06-unsupported-action-type: A spin-off has no availability rule and blocks the profile

Synthetic, Alpaca-shaped data on an invented instrument. Derived by hand; the oracle asserts the values marked below.

## Derivation

1. The profile declares availability rules for splits and cash dividends only. A spin-off in the range has none, so the profile is blocked rather than the action dropped.

## Expected outcome

The profile is blocked: `UNSUPPORTED_ACTION_TYPE` (subject `spin_offs`, class UNSUPPORTED_CAPABILITY). No manifest is produced.

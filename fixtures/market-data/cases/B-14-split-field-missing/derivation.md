# B-14-split-field-missing: A split without a declaration date blocks the profile

Synthetic, Alpaca-shaped data on an invented instrument. Derived by hand; the oracle asserts the values marked below.

## Derivation

1. The split record has no `declaration_date`. Splits follow the same rule as dividends, so the profile is blocked.

## Expected outcome

The profile is blocked: `ACTION_NOT_EVIDENCED` (subject `split-synth-2024-03-06`, class UNAVAILABLE_DATA). No manifest is produced.

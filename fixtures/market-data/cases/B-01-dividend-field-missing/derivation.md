# B-01-dividend-field-missing: A dividend without a declaration date blocks the profile

Synthetic, Alpaca-shaped data on an invented instrument. Derived by hand; the oracle asserts the values marked below.

## Derivation

1. The profile names `declaration_date` as the field that evidences a dividend's availability. The provider record has no such field.
2. Without evidence the availability is unknown. The rule is BLOCK_PROFILE: no fixed offset, record date, process date or retrieval time replaces it. No manifest is produced.

## Expected outcome

The profile is blocked: `ACTION_NOT_EVIDENCED` (subject `div-synth-2024-03-08`, class UNAVAILABLE_DATA). No manifest is produced.

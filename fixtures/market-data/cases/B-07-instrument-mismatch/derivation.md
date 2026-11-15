# B-07-instrument-mismatch: An asset record with another id blocks the profile

Synthetic, Alpaca-shaped data on an invented instrument. Derived by hand; the oracle asserts the values marked below.

## Derivation

1. The mapping says the asset id is 00000000-0000-4000-8000-000000000001; the provider record has another id. Identity comes from the asset id, so a mismatch blocks the profile.

## Expected outcome

The profile is blocked: `INSTRUMENT_MISMATCH` (subject `id`, class UNAVAILABLE_DATA). No manifest is produced.

# B-08-conflicting-duplicate-bar: Two different bars for one session block the profile

Synthetic, Alpaca-shaped data on an invented instrument. Derived by hand; the oracle asserts the values marked below.

## Derivation

1. The provider returns two bars for 2024-03-06 whose volumes differ. Only an identical retransmission is merged; a conflict needs explicit revision handling, so the profile is blocked.

## Expected outcome

The profile is blocked: `CONFLICTING_DUPLICATE_BAR` (subject `2024-03-06`, class MALFORMED_RESPONSE). No manifest is produced.

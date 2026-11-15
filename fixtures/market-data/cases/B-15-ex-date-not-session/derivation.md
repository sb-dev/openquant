# B-15-ex-date-not-session: An ex-date on a market holiday blocks the profile

Synthetic, Alpaca-shaped data on an invented instrument. Derived by hand; the oracle asserts the values marked below.

## Derivation

1. The ex-date 2024-01-15 is a holiday and not a calendar session, but the core needs the effective session on the calendar. The profile is blocked.

## Expected outcome

The profile is blocked: `ACTION_EX_DATE_NOT_SESSION` (subject `div-synth-2024-01-15`, class UNAVAILABLE_DATA). No manifest is produced.

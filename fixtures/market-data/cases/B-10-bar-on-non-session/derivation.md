# B-10-bar-on-non-session: A bar on a market holiday blocks the profile

Synthetic, Alpaca-shaped data on an invented instrument. Derived by hand; the oracle asserts the values marked below.

## Derivation

1. Monday 2024-01-15 is a holiday: the calendar has no session for it, yet the provider returns a bar. The data contradicts the calendar, so the profile is blocked.

## Expected outcome

The profile is blocked: `BAR_ON_NON_SESSION` (subject `2024-01-15`, class MALFORMED_RESPONSE). No manifest is produced.

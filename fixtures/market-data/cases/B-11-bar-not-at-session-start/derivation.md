# B-11-bar-not-at-session-start: A bar stamped at midnight UTC blocks the profile

Synthetic, Alpaca-shaped data on an invented instrument. Derived by hand; the oracle asserts the values marked below.

## Derivation

1. A daily bar is stamped with local midnight in New York: 05:00Z on 2024-03-05. A stamp of 00:00Z is another instant, so the session cannot be read from it.

## Expected outcome

The profile is blocked: `BAR_NOT_AT_SESSION_START` (subject `2024-03-05T00:00:00Z`, class MALFORMED_RESPONSE). No manifest is produced.

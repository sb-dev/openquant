# N-07-unscheduled-closure-listed: An unscheduled closure: the calendar lists the session, no bar exists

Synthetic, Alpaca-shaped data on an invented instrument. Derived by hand; the oracle asserts the values marked below.

## Derivation

1. 2025-01-09 was a one-day closure announced at short notice. This provider calendar still lists it as a session, but the provider returns no bar.
2. The expected sessions are the 5 weekdays 6 to 10 January. The missing session is 2025-01-09: coverage is PARTIAL, bar_count 4.
3. An absent bar alone does not establish a halt, so `unplanned_events` stays empty.

## Expected outcome

The manifest is in `expected.json`; its digest is `sha256:beef380863ad53a3c460fe4904752c3c1b21c0ed5db76106970c330394487e06`.
Coverage: PARTIAL, 4 bars. Price scale 2, money scale 2.

Hand-derived values, asserted by the oracle:

- completeness: `"PARTIAL"`
- missing: `["2025-01-09"]`
- bar_count: `4`
- unplanned events: `[]`

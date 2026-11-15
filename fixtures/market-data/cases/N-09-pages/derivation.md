# N-09-pages: Three bar pages and two corporate-action pages

Synthetic, Alpaca-shaped data on an invented instrument. Derived by hand; the oracle asserts the values marked below.

## Derivation

1. The 15 sessions 1 to 19 April 2024 arrive in pages of 6, 6 and 3 bars, linked by next_page_token. Every page is one call and one source response.
2. The dividend (ex 10 April, declared 2 April, payable 12 April) is on page 1 of the actions and the 3-for-2 split (ex 15 April, declared 3 April) on page 2.
3. April is daylight time (UTC-4): 09:30 EDT = 13:30Z. Both actions are available at the open of their ex-date.

## Expected outcome

The manifest is in `expected.json`; its digest is `sha256:6e90b41decaa02f7a75971d7bd1ce59c959777c836aa2456df8755375060093c`.
Coverage: COMPLETE, 15 bars. Price scale 2, money scale 2.

Hand-derived values, asserted by the oracle:

- bar_count: `15`
- calls: `7`
- dividend available_at: `"2024-04-10T13:30:00Z"`
- split available_at: `"2024-04-15T13:30:00Z"`
- split ratio: `[3, 2]`

# N-02-cash-dividend: A cash dividend with ex-date and payment inside a rising run

Synthetic, Alpaca-shaped data on an invented instrument. Derived by hand; the oracle asserts the values marked below.

## Derivation

1. The dividend is declared on 2025-02-04, seven days before the ex-date 2025-02-11 (a Tuesday): evidenced.
2. February is standard time: the ex-date opens at 09:30 EST = 14:30Z, so `available_at` is 2025-02-11T14:30:00Z.
3. The payable date 2025-02-13 is a Thursday and a calendar session, two sessions after the ex-date (12 and 13 February). The payment phase is AFTER_CLOSE.
4. The rate 0.25 is kept as the exact text. The bars rise by 0.50 a session, so a position held across 11 February sees the ex-date inside its holding period and the benchmark window.

## Expected outcome

The manifest is in `expected.json`; its digest is `sha256:2f36e8e0581d1c477a9e57ffaabcd4ea798d7976f02b21ab74a848e1e5fd7236`.
Coverage: COMPLETE, 10 bars. Price scale 2, money scale 2.

Hand-derived values, asserted by the oracle:

- dividend `available_at`: `"2025-02-11T14:30:00Z"`
- payment_session: `"2025-02-13"`
- amount_per_share: `"0.25"`
- evidence value: `"2025-02-04"`

# N-12-price-scale-3: Prices that need three fractional digits

Synthetic, Alpaca-shaped data on an invented instrument. Derived by hand; the oracle asserts the values marked below.

## Derivation

1. The most precise prices are 100.125, 99.875 and 102.125: three fractional digits. The smallest scale that holds every price exactly is 3, so price_scale is 3 and money_scale is max(2, 3) = 3.
2. A scale of 3 or 4 is accepted only after the S1 overflow test passes at that scale: overflow_evidence_required is true.
3. Tokens keep their exact value and become minimal decimal text: 100.250 is 100.25, 1.00250e2 is 100.25, 1.2e6 is 1200000, 102 is 102.

## Expected outcome

The manifest is in `expected.json`; its digest is `sha256:92a3ed56c6011afd336bd55a37651f68bbb66514a9255b75810b6870d49f714b`.
Coverage: COMPLETE, 5 bars. Price scale 3, money scale 3.

Hand-derived values, asserted by the oracle:

- open of 7 May: `"100.25"`
- volume of 7 May: `"1200000"`
- high of 6 May: `"101.5"`

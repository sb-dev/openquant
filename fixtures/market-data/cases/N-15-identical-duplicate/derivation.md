# N-15-identical-duplicate: An identical retransmitted bar is merged

Synthetic, Alpaca-shaped data on an invented instrument. Derived by hand; the oracle asserts the values marked below.

## Derivation

1. The provider response lists the 2024-07-09 bar twice with identical values. An identical retransmission is merged into one bar under the declared rule. A differing duplicate would block the profile (B-08).
2. bar_count is 5, not 6.

## Expected outcome

The manifest is in `expected.json`; its digest is `sha256:4e76933b189d19da4b46630ec2f42b452934d85bcacd52a565f5f3e8be46d9d7`.
Coverage: COMPLETE, 5 bars. Price scale 2, money scale 2.

Hand-derived values, asserted by the oracle:

- bar_count: `5`

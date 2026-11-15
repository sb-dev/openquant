# N-14-ratios-and-ids: Split ratios reduce to integers and same-day dividends get distinct ids

Synthetic, Alpaca-shaped data on an invented instrument. Derived by hand; the oracle asserts the values marked below.

## Derivation

1. A 1.5-for-1 split is 15/10, which reduces to 3 for 2. A 1-for-20 reverse split stays 1 and 20.
2. Two dividends share the ex-date 2024-05-08. Actions are ordered by ex-date, then splits before dividends, then provider id: split ca-0031, dividend ca-0033 (rate 0.05), dividend ca-0034 (rate 0.10).
3. The second dividend of the day gets the suffix -2: `div-synth-2024-05-08` is ca-0033 and `div-synth-2024-05-08-2` is ca-0034.

## Expected outcome

The manifest is in `expected.json`; its digest is `sha256:2123d1b61a1d846da5718e219bbc278da8c666a17df29ae85ab73a1958c4f92c`.
Coverage: COMPLETE, 10 bars. Price scale 2, money scale 2.

Hand-derived values, asserted by the oracle:

- ids in order: `["split-synth-2024-05-08", "div-synth-2024-05-08", "div-synth-2024-05-08-2", "split-synth-2024-05-15"]`
- first ratio: `[3, 2]`
- reverse ratio: `[1, 20]`
- amounts: `["0.05", "0.1"]`

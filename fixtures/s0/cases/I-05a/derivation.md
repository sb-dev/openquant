# I-05a: Excess price scale is rejected as an invalid decimal

Origin: derived by `fixtures/s0/oracle/oracle.py` from OQ-02 sections 2.1 to 2.6 and the declared policy semantics; the oracle uses exact rational arithmetic and never reads the Rust engine. Status: not individually hand-checked. Covers: Invalid inputs.

## Design

A bar's open is 50.001 while the policy price scale is 2. The decimal string matches the grammar but exceeds the declared scale; preparation rejects it with INVALID_DECIMAL instead of rounding it.

## Inputs

- Strategy: `strategy.json` (strategy hash `sha256:1b72f5d5c78e573697190e89081e7f271c6d001fe6586b4eb954f537eea3baa3`).
- Input hash binding in `input.json`: `sha256:1b72f5d5c78e573697190e89081e7f271c6d001fe6586b4eb954f537eea3baa3`.
- Policy: price scale 2, quantity scale 0, money scale 2, diagnostic scale 4, lot size 1; fixed fee 1.00 per fill, 10 bps, gap-exit slippage 0 bps; dividend withholding 0 bps.
- Windows: warm-up from 2026-01-05, scored from 2026-01-08, run ends after 2026-01-14; 8 calendar sessions, 8 bars; initial capital 5000.00.

| Session | Open | High | Low | Close | Volume |
| --- | --- | --- | --- | --- | --- |
| 2026-01-05 | 50 | 51 | 49 | 50 | 1000 |
| 2026-01-06 | 50 | 51 | 49 | 50 | 1000 |
| 2026-01-07 | 50.001 | 51 | 49 | 50 | 1000 |
| 2026-01-08 | 50 | 51 | 49 | 50 | 1000 |
| 2026-01-09 | 50 | 51.5 | 49.5 | 51 | 1000 |
| 2026-01-12 | 50 | 51 | 49 | 50 | 1000 |
| 2026-01-13 | 50 | 51 | 49 | 50 | 1000 |
| 2026-01-14 | 50 | 51 | 49 | 50 | 1000 |

## Expected result

Rejected before evaluation: status FAILED, code INVALID_DECIMAL. No journal is produced.

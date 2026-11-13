# I-04a: Unsupported operator id is rejected before evaluation

Origin: derived by `fixtures/s0/oracle/oracle.py` from OQ-02 sections 2.1 to 2.6 and the declared policy semantics; the oracle uses exact rational arithmetic and never reads the Rust engine. Status: not individually hand-checked. Covers: Invalid inputs, Definition execution.

## Design

The strategy is schema-valid: `operator:ema@1` matches the operator reference pattern. The operator set daily-long-only-seed@1 has no exponential mean (and Wilder-style smoothing must not be hidden under another identifier), so the shared validator rejects it with UNSUPPORTED_OPERATOR before any bar is read. No journal is produced.

## Inputs

- Strategy: `strategy.json` (strategy hash `sha256:44b09a1dcf045add82687eddbb7abb9a73315ba6b7765df5710cfdcc74f1ef59`).
- Input hash binding in `input.json`: `sha256:44b09a1dcf045add82687eddbb7abb9a73315ba6b7765df5710cfdcc74f1ef59`.
- Policy: price scale 2, quantity scale 0, money scale 2, diagnostic scale 4, lot size 1; fixed fee 1.00 per fill, 10 bps, gap-exit slippage 0 bps; dividend withholding 0 bps.
- Windows: warm-up from 2026-01-05, scored from 2026-01-08, run ends after 2026-01-14; 8 calendar sessions, 8 bars; initial capital 5000.00.

| Session | Open | High | Low | Close | Volume |
| --- | --- | --- | --- | --- | --- |
| 2026-01-05 | 50 | 51 | 49 | 50 | 1000 |
| 2026-01-06 | 50 | 51 | 49 | 50 | 1000 |
| 2026-01-07 | 50 | 51 | 49 | 50 | 1000 |
| 2026-01-08 | 50 | 51 | 49 | 50 | 1000 |
| 2026-01-09 | 50 | 51.5 | 49.5 | 51 | 1000 |
| 2026-01-12 | 50 | 51 | 49 | 50 | 1000 |
| 2026-01-13 | 50 | 51 | 49 | 50 | 1000 |
| 2026-01-14 | 50 | 51 | 49 | 50 | 1000 |

## Expected result

Rejected before evaluation: status FAILED, code UNSUPPORTED_OPERATOR. No journal is produced.

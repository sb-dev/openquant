# I-08: Hash mismatch between input and strategy

Origin: derived by `fixtures/s0/oracle/oracle.py` from OQ-02 sections 2.1 to 2.6 and the declared policy semantics; the oracle uses exact rational arithmetic and never reads the Rust engine. Status: not individually hand-checked. Covers: Invalid inputs, Shared payloads.

## Design

The input binds the hash of a different strategy artefact (the same artefact with version 2). The strategy file's own hash differs, so the identity check fails with IDENTITY_MISMATCH before any evaluation.

## Inputs

- Strategy: `strategy.json` (strategy hash `sha256:0e0ccd0bf180d1a47d3d07599bb59f175e82dfe44516e82880bd1ba4ec489360`).
- Input hash binding in `input.json`: `sha256:c9363dedae82281f8c4d5b6cf94c3795f190da9566fba84d41ecb41cc25829d5`.
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

Rejected before evaluation: status FAILED, code IDENTITY_MISMATCH. No journal is produced.

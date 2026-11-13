# I-01: Future data: a bar used by a decision becomes available after the next open

Origin: derived by `fixtures/s0/oracle/oracle.py` from OQ-02 sections 2.1 to 2.6 and the declared policy semantics; the oracle uses exact rational arithmetic and never reads the Rust engine. Status: not individually hand-checked. Covers: Invalid inputs.

## Design

Eight sessions as X-01, except that the bar of index 4 (the signal session) has available_at 15:30 on the next day, one hour after the next open at 14:30. The decision at the close of index 4 would use a bar that is not known before the intended fill, which would be a retroactive fill. The run fails with FAILED FUTURE_DATA at AFTER_CLOSE of index 4 and keeps the journal through the close of index 3 (signals and daily records for indices 0 to 3; no entry, no reservation).

## Inputs

- Strategy: `strategy.json` (strategy hash `sha256:0ca3355e161bff2e17c780b93368945ccb6ff7f644ae3adef8f9cc22ece8d91e`).
- Input hash binding in `input.json`: `sha256:0ca3355e161bff2e17c780b93368945ccb6ff7f644ae3adef8f9cc22ece8d91e`.
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

## Step-by-step derivation

### 2026-01-05

- AFTER_CLOSE: Signal: condition MISSING, decision SKIPPED (NOT_SCORED_YET).
- AFTER_CLOSE: Daily record: equity = available 5000.00 + reserved 0.00 + receivables 0.00 + positions 0.00 = 5000.00.

### 2026-01-06

- AFTER_CLOSE: Signal: condition MISSING, decision SKIPPED (NOT_SCORED_YET).
- AFTER_CLOSE: Daily record: equity = available 5000.00 + reserved 0.00 + receivables 0.00 + positions 0.00 = 5000.00.

### 2026-01-07

- AFTER_CLOSE: Signal: condition FALSE, decision SKIPPED (NOT_SCORED_YET).
- AFTER_CLOSE: Daily record: equity = available 5000.00 + reserved 0.00 + receivables 0.00 + positions 0.00 = 5000.00.

### 2026-01-08

- AFTER_CLOSE: Indicator sma3 = mean of the last 3 close values (indices 1..3): sum 150 / 3 = 50 -> 50.0000
- AFTER_CLOSE: Indicator atr3: true ranges (indices 1..3) sum to 6; ATR = 6 / 3 = 2 -> 2.0000
- AFTER_CLOSE: Signal: condition FALSE, decision NO_ENTRY.
- AFTER_CLOSE: Daily record: equity = available 5000.00 + reserved 0.00 + receivables 0.00 + positions 0.00 = 5000.00.

### 2026-01-09

- AFTER_CLOSE: FAILURE FAILED FUTURE_DATA: the bar of 2026-01-09 is available at 2026-01-12T15:30:00Z, after the next open 2026-01-12T14:30:00Z. Journal kept through the last completed event.

### Outcome

The run stops with status FAILED, code FUTURE_DATA at 2026-01-09 AFTER_CLOSE. The expected journal is the journal through the last completed event.

# I-11: An information cutoff before the next open binds the decision

Origin: derived by `fixtures/s0/oracle/oracle.py` from OQ-02 sections 2.1 to 2.6 and the declared policy semantics; the oracle uses exact rational arithmetic and never reads the Rust engine. Status: not individually hand-checked. Covers: Invalid inputs.

## Design

Eight sessions as X-01. The bar of index 4 (the signal session) becomes available at 22:00 on its own day, well before the next open (14:30 on the next day), so a deadline of the next open alone would accept it. The information cutoff is 21:30 on that day, earlier than the bar's availability. The deadline of a decision is the earlier of the next open and the cutoff, so the run fails with FAILED FUTURE_DATA at AFTER_CLOSE of index 4 and keeps the journal through the close of index 3.

## Inputs

- Strategy: `strategy.json` (strategy hash `sha256:3ec872ce0fbf03b512c20007c4c1a41c82371d72b2578d33808db94cdbef58fe`).
- Input hash binding in `input.json`: `sha256:3ec872ce0fbf03b512c20007c4c1a41c82371d72b2578d33808db94cdbef58fe`.
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

- AFTER_CLOSE: FAILURE FAILED FUTURE_DATA: the bar of 2026-01-09 is available at 2026-01-09T22:00:00Z, after the deadline 2026-01-09T21:30:00Z (the earlier of the next open and the information cutoff 2026-01-09T21:30:00Z; the final session has only the cutoff). Journal kept through the last completed event.

### Outcome

The run stops with status FAILED, code FUTURE_DATA at 2026-01-09 AFTER_CLOSE. The expected journal is the journal through the last completed event.

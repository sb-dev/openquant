# G-07b: Grid tie: a stop of exactly 0 = 7 - 6 * 7/6 is an invalid level (ATR6 rounds above)

Origin: derived by `fixtures/s0/oracle/oracle.py` from OQ-02 sections 2.1 to 2.6 and the declared policy semantics; the oracle uses exact rational arithmetic and never reads the Rust engine. Status: hand-checked (see the last section). Covers: Invalid inputs, Entry and exit phases.

## Design

10 sessions at price 7.00. The ATR6 window of the signal bar has true-range sum 7.00, so ATR6 = 7/6 has no finite decimal form while the stop 6 * ATR6 below the entry price 7.00 is exactly 0, which breaks 0 < stop. The run must fail with INVALID_LEVEL at the entry open, and nothing is filled.

## Inputs

- Strategy: `strategy.json` (strategy hash `sha256:a96f94765c3b4e4e6567e4707dc2ae3e0d020b55fa89c6947e4506135cdc5e06`).
- Input hash binding in `input.json`: `sha256:a96f94765c3b4e4e6567e4707dc2ae3e0d020b55fa89c6947e4506135cdc5e06`.
- Policy: price scale 2, quantity scale 0, money scale 2, diagnostic scale 4, lot size 1; fixed fee 1.00 per fill, 0 bps, gap-exit slippage 100 bps; dividend withholding 0 bps.
- Windows: warm-up from 2026-01-05, scored from 2026-01-08, run ends after 2026-01-16; 10 calendar sessions, 10 bars; initial capital 5000.00.

| Session | Open | High | Low | Close | Volume |
| --- | --- | --- | --- | --- | --- |
| 2026-01-05 | 7 | 7.5 | 6.5 | 7 | 1000 |
| 2026-01-06 | 7 | 7.5 | 6.5 | 7 | 1000 |
| 2026-01-07 | 7 | 7.5 | 6.5 | 7 | 1000 |
| 2026-01-08 | 7 | 7.5 | 6.5 | 7 | 1000 |
| 2026-01-09 | 7 | 7.5 | 6.5 | 7 | 1000 |
| 2026-01-12 | 7 | 7.5 | 6.5 | 7 | 1000 |
| 2026-01-13 | 7 | 7.5 | 6.5 | 7 | 1000 |
| 2026-01-14 | 7 | 8 | 6 | 7.05 | 1000 |
| 2026-01-15 | 7 | 7.5 | 6.5 | 7 | 1000 |
| 2026-01-16 | 7 | 7.5 | 6.5 | 7 | 1000 |

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

- AFTER_CLOSE: Signal: condition FALSE, decision NO_ENTRY.
- AFTER_CLOSE: Daily record: equity = available 5000.00 + reserved 0.00 + receivables 0.00 + positions 0.00 = 5000.00.

### 2026-01-09

- AFTER_CLOSE: Signal: condition FALSE, decision NO_ENTRY.
- AFTER_CLOSE: Daily record: equity = available 5000.00 + reserved 0.00 + receivables 0.00 + positions 0.00 = 5000.00.

### 2026-01-12

- AFTER_CLOSE: Signal: condition FALSE, decision NO_ENTRY.
- AFTER_CLOSE: Daily record: equity = available 5000.00 + reserved 0.00 + receivables 0.00 + positions 0.00 = 5000.00.

### 2026-01-13

- AFTER_CLOSE: Signal: condition FALSE, decision NO_ENTRY.
- AFTER_CLOSE: Daily record: equity = available 5000.00 + reserved 0.00 + receivables 0.00 + positions 0.00 = 5000.00.

### 2026-01-14

- AFTER_CLOSE: Indicator sma3 = mean of the last 3 close values (indices 5..7): sum 21.05 / 3 = 421/60 -> 7.0167
- AFTER_CLOSE: Indicator atr6: true ranges (indices 2..7) sum to 7; ATR = 7 / 6 = 7/6 -> 1.1667
- AFTER_CLOSE: Decision: condition TRUE, not held, vacant slots 5 - 0 - 0 = 5. cap = floor(available 5000.00 / 5) = 1000.00.
- AFTER_CLOSE: Reserve 1000.00: available -> 4000.00, reserved -> 1000.00; rank 1.0000; snapshots entry_atr=7/6.
- AFTER_CLOSE: Signal: condition TRUE, decision ENTER.
- AFTER_CLOSE: Daily record: equity = available 4000.00 + reserved 1000.00 + receivables 0.00 + positions 0.00 = 5000.00.

### 2026-01-15

- OPEN: FAILURE FAILED INVALID_LEVEL: stop 0, entry 7.00, target 28/3 violate 0 < stop < entry < target. Journal kept through the last completed event.

### Journal sequence numbers

Fills and ledger lines share one counter: 0 RESERVE.

### Outcome

The run stops with status FAILED, code INVALID_LEVEL at 2026-01-15 OPEN. The expected journal is the journal through the last completed event.

## Hand check

1. ATR6 window, indices 2 to 7 (six bars). Indices 2 to 6 are (7, 7.50, 6.50, 7) after a close of 7: max(1.00, 0.50, 0.50) = 1.00 each, 5.00 in total. Index 7 is (7, 8.00, 6.00, 7.05) after a close of 7: max(2.00, 1.00, 1.00) = 2.00. The sum is 7.00.
2. ATR6 = 7.00 / 6 = 7/6 = 1.1666... It has no finite decimal form. The close 7.05 is above SMA3 = (7.00 + 7.00 + 7.05) / 3, so the close of index 7 creates an entry intent: cap = floor(5000.00 / 5) = 1000.00, reserved (available 4000.00, reserved 1000.00).
3. Index 8 opens at 7.00. Sizing with the fee of 1.00 per fill: 143 shares cost 1001.00 + 1.00 > 1000.00; 142 shares cost 994.00 + 1.00 = 995.00 <= 1000.00, so the quantity is 142. Sizing succeeds, so the levels are validated.
4. Levels. Stop = 7.00 - 6 * ATR6 = 7.00 - 6 * 7/6 = 7.00 - 7.00 = 0 exactly; target = 7.00 + 2 * ATR6 is above the entry. The rule 0 < stop < entry < target fails because the stop is not above 0: the run ends with FAILED INVALID_LEVEL at OPEN of index 8. The whole OPEN event is rolled back (the declared policy for an invalid level): there is no BUY fill, the reservation made at the close of index 7 stays in the journal (entry RESERVED, one RESERVE line of 1000.00, cash reserved 1000.00) and index 9 is never processed.
5. ATR6 rounded to finitely many digits is above 7/6 (1.1666... rounds up), so 6 * ATR6 is above 7 and a stop computed from it is a small negative number, which a level check rejects as well. A rounded computation reaches the same outcome in this direction; the case pins that the exact stop 0 is rejected here too.

The oracle asserts these hand-derived values against its own output (a disagreement stops the run and is resolved by re-reading the specification, never by copying a value):

- `outcome.status` = `FAILED` (the level check fails)
- `outcome.code` = `INVALID_LEVEL` (the stop 0 is not above 0)
- `outcome.at.session` = `2026-01-15` (the entry session)
- `outcome.at.phase` = `OPEN` (the entry fill)
- `signals.7.decision` = `ENTER` (close above SMA3)
- `entries.0.status` = `RESERVED` (never filled)
- `entries.0.cap` = `1000.00` (floor(5000.00 / 5))
- `cash_ledger.0.kind` = `RESERVE` (the only journal line)
- `daily.7.cash_reserved` = `1000.00` (reserved at the close of index 7)
- `daily.7.cash_available` = `4000.00` (5000.00 - 1000.00)

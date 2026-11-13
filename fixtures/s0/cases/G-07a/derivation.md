# G-07a: Grid tie: a stop of exactly 0 = 5 - 6 * 5/6 is an invalid level (ATR6 rounds below)

Origin: derived by `fixtures/s0/oracle/oracle.py` from OQ-02 sections 2.1 to 2.6 and the declared policy semantics; the oracle uses exact rational arithmetic and never reads the Rust engine. Status: hand-checked (see the last section). Covers: Invalid inputs, Entry and exit phases.

## Design

10 sessions at price 5.00. The ATR6 window of the signal bar has true-range sum 5.00, so ATR6 = 5/6 has no finite decimal form while the stop 6 * ATR6 below the entry price 5.00 is exactly 0, which breaks 0 < stop. The run must fail with INVALID_LEVEL at the entry open, and nothing is filled.

## Inputs

- Strategy: `strategy.json` (strategy hash `sha256:303ced6d99867689badd9424dfb694c99ac260ddf6ad96ed3aa66c1036711eef`).
- Input hash binding in `input.json`: `sha256:303ced6d99867689badd9424dfb694c99ac260ddf6ad96ed3aa66c1036711eef`.
- Policy: price scale 2, quantity scale 0, money scale 2, diagnostic scale 4, lot size 1; fixed fee 1.00 per fill, 0 bps, gap-exit slippage 100 bps; dividend withholding 0 bps.
- Windows: warm-up from 2026-01-05, scored from 2026-01-08, run ends after 2026-01-16; 10 calendar sessions, 10 bars; initial capital 5000.00.

| Session | Open | High | Low | Close | Volume |
| --- | --- | --- | --- | --- | --- |
| 2026-01-05 | 5 | 5.4 | 4.6 | 5 | 1000 |
| 2026-01-06 | 5 | 5.4 | 4.6 | 5 | 1000 |
| 2026-01-07 | 5 | 5.4 | 4.6 | 5 | 1000 |
| 2026-01-08 | 5 | 5.4 | 4.6 | 5 | 1000 |
| 2026-01-09 | 5 | 5.4 | 4.6 | 5 | 1000 |
| 2026-01-12 | 5 | 5.4 | 4.6 | 5 | 1000 |
| 2026-01-13 | 5 | 5.4 | 4.6 | 5 | 1000 |
| 2026-01-14 | 5 | 5.5 | 4.5 | 5.05 | 1000 |
| 2026-01-15 | 5 | 5.4 | 4.6 | 5 | 1000 |
| 2026-01-16 | 5 | 5.4 | 4.6 | 5 | 1000 |

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

- AFTER_CLOSE: Indicator sma3 = mean of the last 3 close values (indices 5..7): sum 15.05 / 3 = 301/60 -> 5.0167
- AFTER_CLOSE: Indicator atr6: true ranges (indices 2..7) sum to 5; ATR = 5 / 6 = 5/6 -> 0.8333
- AFTER_CLOSE: Decision: condition TRUE, not held, vacant slots 5 - 0 - 0 = 5. cap = floor(available 5000.00 / 5) = 1000.00.
- AFTER_CLOSE: Reserve 1000.00: available -> 4000.00, reserved -> 1000.00; rank 1.0000; snapshots entry_atr=5/6.
- AFTER_CLOSE: Signal: condition TRUE, decision ENTER.
- AFTER_CLOSE: Daily record: equity = available 4000.00 + reserved 1000.00 + receivables 0.00 + positions 0.00 = 5000.00.

### 2026-01-15

- OPEN: FAILURE FAILED INVALID_LEVEL: stop 0, entry 5.00, target 20/3 violate 0 < stop < entry < target. Journal kept through the last completed event.

### Journal sequence numbers

Fills and ledger lines share one counter: 0 RESERVE.

### Outcome

The run stops with status FAILED, code INVALID_LEVEL at 2026-01-15 OPEN. The expected journal is the journal through the last completed event.

## Hand check

1. ATR6 window, indices 2 to 7 (six bars). Indices 2 to 6 are (5, 5.40, 4.60, 5) after a close of 5: max(0.80, 0.40, 0.40) = 0.80 each, 4.00 in total. Index 7 is (5, 5.50, 4.50, 5.05) after a close of 5: max(1.00, 0.50, 0.50) = 1.00. The sum is 5.00.
2. ATR6 = 5.00 / 6 = 5/6 = 0.8333... It has no finite decimal form. The close 5.05 is above SMA3 = (5.00 + 5.00 + 5.05) / 3, so the close of index 7 creates an entry intent: cap = floor(5000.00 / 5) = 1000.00, reserved (available 4000.00, reserved 1000.00).
3. Index 8 opens at 5.00. Sizing with the fee of 1.00 per fill: 200 shares cost 1000.00 + 1.00 = 1001.00 > 1000.00; 199 shares cost 995.00 + 1.00 = 996.00 <= 1000.00, so the quantity is 199. Sizing succeeds, so the levels are validated.
4. Levels. Stop = 5.00 - 6 * ATR6 = 5.00 - 6 * 5/6 = 5.00 - 5.00 = 0 exactly; target = 5.00 + 2 * ATR6 is above the entry. The rule 0 < stop < entry < target fails because the stop is not above 0: the run ends with FAILED INVALID_LEVEL at OPEN of index 8. The whole OPEN event is rolled back (the declared policy for an invalid level): there is no BUY fill, the reservation made at the close of index 7 stays in the journal (entry RESERVED, one RESERVE line of 1000.00, cash reserved 1000.00) and index 9 is never processed.
5. ATR6 rounded to finitely many digits is below 5/6 (0.8333...), so 6 * ATR6 is below 5 and a stop computed from it is a small positive number: a level check applied to that number would accept it. The exact stop is 0 and must be rejected.

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

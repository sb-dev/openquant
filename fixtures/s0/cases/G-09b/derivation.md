# G-09b: Grid tie: entry signal 3 * SMA3 >= 6.02 holds at the exact sum 6.02 (SMA3 rounds above)

Origin: derived by `fixtures/s0/oracle/oracle.py` from OQ-02 sections 2.1 to 2.6 and the declared policy semantics; the oracle uses exact rational arithmetic and never reads the Rust engine. Status: hand-checked (see the last section). Covers: Entry variants, Entry and exit phases.

## Design

8 sessions. The entry condition is gte(3 * SMA3(close), 6.02). The three closes of the signal session sum to 6.02, so SMA3 = 602/300 = 2.0066... has no finite decimal form while 3 * SMA3 = 6.02 is a price on the grid. A mean rounded to finitely many digits lies above 602/300 (its digits end in 7), so 3 times it is above 6.02 and a greater-or-equal comparison still holds: a >= test is not misjudged in this direction (G-09c uses <=). The case pins the entry at the exact sum in the other direction.

## Inputs

- Strategy: `strategy.json` (strategy hash `sha256:1cbebf89e4ac7c5b401e67a62636e77bcd6db823115e5ff6b7f7a7a6f0c07f9b`).
- Input hash binding in `input.json`: `sha256:1cbebf89e4ac7c5b401e67a62636e77bcd6db823115e5ff6b7f7a7a6f0c07f9b`.
- Policy: price scale 2, quantity scale 0, money scale 2, diagnostic scale 4, lot size 1; fixed fee 1.00 per fill, 0 bps, gap-exit slippage 100 bps; dividend withholding 0 bps.
- Windows: warm-up from 2026-01-05, scored from 2026-01-08, run ends after 2026-01-14; 8 calendar sessions, 8 bars; initial capital 5000.00.

| Session | Open | High | Low | Close | Volume |
| --- | --- | --- | --- | --- | --- |
| 2026-01-05 | 2 | 2.1 | 1.9 | 2 | 1000 |
| 2026-01-06 | 2 | 2.1 | 1.9 | 2 | 1000 |
| 2026-01-07 | 2 | 2.1 | 1.9 | 2 | 1000 |
| 2026-01-08 | 2 | 2.1 | 1.9 | 2 | 1000 |
| 2026-01-09 | 2 | 2.1 | 1.9 | 2.02 | 1000 |
| 2026-01-12 | 2 | 2.1 | 1.9 | 2 | 1000 |
| 2026-01-13 | 2 | 2.1 | 1.9 | 2 | 1000 |
| 2026-01-14 | 2 | 2.1 | 1.9 | 2 | 1000 |

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

- AFTER_CLOSE: Indicator sma3 = mean of the last 3 close values (indices 1..3): sum 6 / 3 = 2 -> 2.0000
- AFTER_CLOSE: Indicator atr3: true ranges (indices 1..3) sum to 0.6; ATR = 0.6 / 3 = 0.2 -> 0.2000
- AFTER_CLOSE: Signal: condition FALSE, decision NO_ENTRY.
- AFTER_CLOSE: Daily record: equity = available 5000.00 + reserved 0.00 + receivables 0.00 + positions 0.00 = 5000.00.

### 2026-01-09

- AFTER_CLOSE: Indicator sma3 = mean of the last 3 close values (indices 2..4): sum 6.02 / 3 = 301/150 -> 2.0067
- AFTER_CLOSE: Indicator atr3: true ranges (indices 2..4) sum to 0.6; ATR = 0.6 / 3 = 0.2 -> 0.2000
- AFTER_CLOSE: Decision: condition TRUE, not held, vacant slots 5 - 0 - 0 = 5. cap = floor(available 5000.00 / 5) = 1000.00.
- AFTER_CLOSE: Reserve 1000.00: available -> 4000.00, reserved -> 1000.00; rank 1.0000; snapshots entry_atr=0.2.
- AFTER_CLOSE: Signal: condition TRUE, decision ENTER.
- AFTER_CLOSE: Daily record: equity = available 4000.00 + reserved 1000.00 + receivables 0.00 + positions 0.00 = 5000.00.

### 2026-01-12

- OPEN: Size intent I-2026-01-09-SYN: cap 1000.00, open 2.00, lot 1, fee(n) = ceil(1 + n * 0/10000). Largest lot multiple that fits: q=500: 1000.00 + fee 1.00 = 1001.00 > cap 1000.00; q=499: 998.00 + fee 1.00 = 999.00 <= cap 1000.00.
- OPEN: Levels from the signal-session snapshots (entry_atr=0.2): stop 1.6, target 3; need 0 < stop < entry 2.00 < target.
- OPEN: Release cap 1000.00 (available 5000.00), buy 499 at 2.00: notional 998.00, fee 1.00, debit 999.00; available -> 4001.00.
- DURING_SESSION: Touch test for T-2026-01-12-SYN: low 1.90 > stop 1.6 -> False; high 2.10 < target 3 -> False.
- AFTER_CLOSE: Indicator sma3 = mean of the last 3 close values (indices 3..5): sum 6.02 / 3 = 301/150 -> 2.0067
- AFTER_CLOSE: Indicator atr3: true ranges (indices 3..5) sum to 0.6; ATR = 0.6 / 3 = 0.2 -> 0.2000
- AFTER_CLOSE: Signal: condition TRUE, decision SKIPPED (HELD).
- AFTER_CLOSE: Daily record: equity = available 4001.00 + reserved 0.00 + receivables 0.00 + positions 998.00 = 4999.00.

### 2026-01-13

- DURING_SESSION: Touch test for T-2026-01-12-SYN: low 1.90 > stop 1.6 -> False; high 2.10 < target 3 -> False.
- AFTER_CLOSE: Indicator sma3 = mean of the last 3 close values (indices 4..6): sum 6.02 / 3 = 301/150 -> 2.0067
- AFTER_CLOSE: Indicator atr3: true ranges (indices 4..6) sum to 0.6; ATR = 0.6 / 3 = 0.2 -> 0.2000
- AFTER_CLOSE: Signal: condition TRUE, decision SKIPPED (HELD).
- AFTER_CLOSE: Daily record: equity = available 4001.00 + reserved 0.00 + receivables 0.00 + positions 998.00 = 4999.00.

### 2026-01-14

- DURING_SESSION: Touch test for T-2026-01-12-SYN: low 1.90 > stop 1.6 -> False; high 2.10 < target 3 -> False.
- AFTER_CLOSE: Signal: condition FALSE, decision SKIPPED (NO_NEXT_SESSION).
- AFTER_CLOSE: Daily record: equity = available 4001.00 + reserved 0.00 + receivables 0.00 + positions 998.00 = 4999.00.
- AFTER_CLOSE: End of run: no forced liquidation; 1 open trade(s) valued at the last close.

### Journal sequence numbers

Fills and ledger lines share one counter: 0 RESERVE, 1 RELEASE, 2 BUY fill, 3 FILL_BUY.

### Outcome

The run completes. Open trades stay OPEN_AT_END and are valued at the last close.

## Hand check

1. The entry condition is 3 * SMA3(close) >= 6.02. SMA3 is the mean of the last three closes, so 3 * SMA3 is their sum.
2. Closes by index: 2.00, 2.00, 2.00, 2.00, 2.02, 2.00, 2.00, 2.00. At index 3 the last three closes sum to 6.00, so 3 * SMA3 = 6.00 < 6.02: FALSE, no entry.
3. At index 4 the three closes (indices 2, 3, 4) sum to 6.02 exactly. Their mean is 602/300 = 2.0066..., which has no finite decimal form, and 3 * mean = 6.02 exactly, so 6.02 >= 6.02 holds by equality: the condition is TRUE and the close of index 4 creates an entry intent (cap = floor(5000.00 / 5) = 1000.00). A mean rounded to finitely many digits lies above 602/300 (its digits end in 7), so 3 times it is above 6.02 and a greater-or-equal comparison still holds: a >= test is not misjudged in this direction (G-09c uses <=). The case pins the entry at the exact sum in the other direction.
4. Entry. Index 5 opens at 2.00. Quantity 499 (500 shares: 1000.00 + 1.00 = 1001.00 > 1000.00; 499 shares: 998.00 + 1.00 = 999.00 <= 1000.00). Available 5000.00 - 999.00 = 4001.00.
5. ATR3 = (0.20 + 0.20 + 0.20) / 3 = 0.20 exactly. Stop = 2.00 - 2 * 0.20 = 1.60; target = 2.00 + 5 * 0.20 = 3.00. No later bar touches them.
6. Indices 5 and 6 sum to 6.02 again: TRUE while held (SKIPPED, HELD). Index 7 sums to 6.00: FALSE. The position is open at the end and is valued at the last close 2.00: 4001.00 + 499 * 2.00 = 4999.00.

The oracle asserts these hand-derived values against its own output (a disagreement stops the run and is resolved by re-reading the specification, never by copying a value):

- `signals.4.condition` = `TRUE` (the sum equals 6.02)
- `signals.4.decision` = `ENTER` (condition TRUE, not held)
- `entries.0.cap` = `1000.00` (floor(5000.00 / 5))
- `entries.0.quantity` = `499` (500 shares: 1000.00 + 1.00 = 1001.00 > 1000.00; 499 shares: 998.00 + 1.00 = 999.00 <= 1000.00)
- `fills.0.price` = `2.00` (the open of index 5)
- `daily.5.cash_available` = `4001.00` (5000.00 - the entry cost)
- `final.equity` = `4999.00` (see step 6)

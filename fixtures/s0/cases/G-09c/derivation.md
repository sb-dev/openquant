# G-09c: Grid tie: entry signal 3 * SMA3 <= 6.02 holds at the exact sum 6.02 (SMA3 rounds above)

Origin: derived by `fixtures/s0/oracle/oracle.py` from OQ-02 sections 2.1 to 2.6 and the declared policy semantics; the oracle uses exact rational arithmetic and never reads the Rust engine. Status: hand-checked (see the last section). Covers: Entry variants, Entry and exit phases.

## Design

8 sessions. The entry condition is lte(3 * SMA3(close), 6.02). The three closes of the signal session sum to 6.02, so SMA3 = 602/300 = 2.0066... has no finite decimal form while 3 * SMA3 = 6.02 is a price on the grid. A mean rounded to finitely many digits lies above 602/300, so 3 times it is above 6.02 and a less-or-equal comparison made after the rounding would say false and miss the entry.

## Inputs

- Strategy: `strategy.json` (strategy hash `sha256:2c71dfa0a8c28dcbc45aa0cfcca088c6d1926d11fa5228d4b616b50090d65e88`).
- Input hash binding in `input.json`: `sha256:2c71dfa0a8c28dcbc45aa0cfcca088c6d1926d11fa5228d4b616b50090d65e88`.
- Policy: price scale 2, quantity scale 0, money scale 2, diagnostic scale 4, lot size 1; fixed fee 1.00 per fill, 0 bps, gap-exit slippage 100 bps; dividend withholding 0 bps.
- Windows: warm-up from 2026-01-05, scored from 2026-01-08, run ends after 2026-01-14; 8 calendar sessions, 8 bars; initial capital 5000.00.

| Session | Open | High | Low | Close | Volume |
| --- | --- | --- | --- | --- | --- |
| 2026-01-05 | 2.05 | 2.15 | 1.95 | 2.05 | 1000 |
| 2026-01-06 | 2.05 | 2.15 | 1.95 | 2.05 | 1000 |
| 2026-01-07 | 2.05 | 2.15 | 1.95 | 2.05 | 1000 |
| 2026-01-08 | 2.05 | 2.15 | 1.95 | 2.05 | 1000 |
| 2026-01-09 | 2.05 | 2.1 | 1.9 | 1.92 | 1000 |
| 2026-01-12 | 1.95 | 2.15 | 1.85 | 2.1 | 1000 |
| 2026-01-13 | 2.1 | 2.2 | 2 | 2.1 | 1000 |
| 2026-01-14 | 2.1 | 2.2 | 2 | 2.1 | 1000 |

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

- AFTER_CLOSE: Indicator sma3 = mean of the last 3 close values (indices 1..3): sum 6.15 / 3 = 2.05 -> 2.0500
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

- OPEN: Size intent I-2026-01-09-SYN: cap 1000.00, open 1.95, lot 1, fee(n) = ceil(1 + n * 0/10000). Largest lot multiple that fits: q=512: 998.40 + fee 1.00 = 999.40 <= cap 1000.00.
- OPEN: Levels from the signal-session snapshots (entry_atr=0.2): stop 1.55, target 2.95; need 0 < stop < entry 1.95 < target.
- OPEN: Release cap 1000.00 (available 5000.00), buy 512 at 1.95: notional 998.40, fee 1.00, debit 999.40; available -> 4000.60.
- DURING_SESSION: Touch test for T-2026-01-12-SYN: low 1.85 > stop 1.55 -> False; high 2.15 < target 2.95 -> False.
- AFTER_CLOSE: Signal: condition FALSE, decision NO_ENTRY.
- AFTER_CLOSE: Daily record: equity = available 4000.60 + reserved 0.00 + receivables 0.00 + positions 1075.20 = 5075.80.

### 2026-01-13

- DURING_SESSION: Touch test for T-2026-01-12-SYN: low 2.00 > stop 1.55 -> False; high 2.20 < target 2.95 -> False.
- AFTER_CLOSE: Signal: condition FALSE, decision NO_ENTRY.
- AFTER_CLOSE: Daily record: equity = available 4000.60 + reserved 0.00 + receivables 0.00 + positions 1075.20 = 5075.80.

### 2026-01-14

- DURING_SESSION: Touch test for T-2026-01-12-SYN: low 2.00 > stop 1.55 -> False; high 2.20 < target 2.95 -> False.
- AFTER_CLOSE: Signal: condition FALSE, decision SKIPPED (NO_NEXT_SESSION).
- AFTER_CLOSE: Daily record: equity = available 4000.60 + reserved 0.00 + receivables 0.00 + positions 1075.20 = 5075.80.
- AFTER_CLOSE: End of run: no forced liquidation; 1 open trade(s) valued at the last close.

### Journal sequence numbers

Fills and ledger lines share one counter: 0 RESERVE, 1 RELEASE, 2 BUY fill, 3 FILL_BUY.

### Outcome

The run completes. Open trades stay OPEN_AT_END and are valued at the last close.

## Hand check

1. The entry condition is 3 * SMA3(close) <= 6.02. SMA3 is the mean of the last three closes, so 3 * SMA3 is their sum.
2. Closes by index: 2.05, 2.05, 2.05, 2.05, 1.92, 2.10, 2.10, 2.10. At index 3 the last three closes sum to 6.15, so 3 * SMA3 = 6.15 > 6.02: FALSE, no entry. The ATR3 window holds the flat bars (2.05, 2.15, 1.95, 2.05) with true range 0.20 and the signal bar (2.05, 2.10, 1.90, 1.92) with true range max(0.20, 0.05, 0.15) = 0.20.
3. At index 4 the three closes (indices 2, 3, 4) sum to 6.02 exactly. Their mean is 602/300 = 2.0066..., which has no finite decimal form, and 3 * mean = 6.02 exactly, so 6.02 <= 6.02 holds by equality: the condition is TRUE and the close of index 4 creates an entry intent (cap = floor(5000.00 / 5) = 1000.00). A mean rounded to finitely many digits lies above 602/300, so 3 times it is above 6.02 and a less-or-equal comparison made after the rounding would say false and miss the entry.
4. Entry. Index 5 opens at 1.95. Quantity 512 (513 shares: 1000.35 + 1.00 > 1000.00; 512 shares: 998.40 + 1.00 = 999.40 <= 1000.00). Available 5000.00 - 999.40 = 4000.60.
5. ATR3 = (0.20 + 0.20 + 0.20) / 3 = 0.20 exactly. Stop = 1.95 - 2 * 0.20 = 1.55; target = 1.95 + 5 * 0.20 = 2.95. No later bar touches them.
6. Index 5 sums to 2.05 + 1.92 + 2.10 = 6.07 > 6.02: FALSE, and later sums are larger. The position is open at the end and is valued at the last close 2.10: 4000.60 + 512 * 2.10 = 4000.60 + 1075.20 = 5075.80.

The oracle asserts these hand-derived values against its own output (a disagreement stops the run and is resolved by re-reading the specification, never by copying a value):

- `signals.4.condition` = `TRUE` (the sum equals 6.02)
- `signals.4.decision` = `ENTER` (condition TRUE, not held)
- `entries.0.cap` = `1000.00` (floor(5000.00 / 5))
- `entries.0.quantity` = `512` (513 shares: 1000.35 + 1.00 > 1000.00; 512 shares: 998.40 + 1.00 = 999.40 <= 1000.00)
- `fills.0.price` = `1.95` (the open of index 5)
- `daily.5.cash_available` = `4000.60` (5000.00 - the entry cost)
- `final.equity` = `5075.80` (see step 6)

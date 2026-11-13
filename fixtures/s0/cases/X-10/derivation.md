# X-10: Exit, then a fresh close signal, then re-entry at the next open

Origin: derived by `fixtures/s0/oracle/oracle.py` from OQ-02 sections 2.1 to 2.6 and the declared policy semantics; the oracle uses exact rational arithmetic and never reads the Rust engine. Status: hand-checked (see the last section). Covers: Entry and exit phases, Cash and quantities.

## Design

Ten sessions. The first position hits its target during index 7; the close of index 7 produces a new entry decision that uses the cash from the exit; the new position is filled at the open of index 8 at 58.00, which differs from both the exit price and the signal close.

## Inputs

- Strategy: `strategy.json` (strategy hash `sha256:f807a3375fe9e4faf95194eaca682b4bc393d71ae93eb7985cba7ec4768f0f4c`).
- Input hash binding in `input.json`: `sha256:f807a3375fe9e4faf95194eaca682b4bc393d71ae93eb7985cba7ec4768f0f4c`.
- Policy: price scale 2, quantity scale 0, money scale 2, diagnostic scale 4, lot size 1; fixed fee 1.00 per fill, 0 bps, gap-exit slippage 0 bps; dividend withholding 0 bps.
- Windows: warm-up from 2026-01-05, scored from 2026-01-08, run ends after 2026-01-16; 10 calendar sessions, 10 bars; initial capital 5000.00.

| Session | Open | High | Low | Close | Volume |
| --- | --- | --- | --- | --- | --- |
| 2026-01-05 | 50 | 51 | 49 | 50 | 1000 |
| 2026-01-06 | 50 | 51 | 49 | 50 | 1000 |
| 2026-01-07 | 50 | 51 | 49 | 50 | 1000 |
| 2026-01-08 | 50 | 51 | 49 | 50 | 1000 |
| 2026-01-09 | 50 | 51.5 | 49.5 | 51 | 1000 |
| 2026-01-12 | 50 | 51 | 49 | 50 | 1000 |
| 2026-01-13 | 50 | 51 | 49 | 50 | 1000 |
| 2026-01-14 | 50 | 61 | 50 | 60 | 1000 |
| 2026-01-15 | 58 | 59 | 57 | 58 | 1000 |
| 2026-01-16 | 58 | 59 | 57 | 58 | 1000 |

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

- AFTER_CLOSE: Indicator sma3 = mean of the last 3 close values (indices 2..4): sum 151 / 3 = 151/3 -> 50.3333
- AFTER_CLOSE: Indicator atr3: true ranges (indices 2..4) sum to 6; ATR = 6 / 3 = 2 -> 2.0000
- AFTER_CLOSE: Decision: condition TRUE, not held, vacant slots 5 - 0 - 0 = 5. cap = floor(available 5000.00 / 5) = 1000.00.
- AFTER_CLOSE: Reserve 1000.00: available -> 4000.00, reserved -> 1000.00; rank 1.0000; snapshots entry_atr=2.
- AFTER_CLOSE: Signal: condition TRUE, decision ENTER.
- AFTER_CLOSE: Daily record: equity = available 4000.00 + reserved 1000.00 + receivables 0.00 + positions 0.00 = 5000.00.

### 2026-01-12

- OPEN: Size intent I-2026-01-09-SYN: cap 1000.00, open 50.00, lot 1, fee(n) = ceil(1 + n * 0/10000). Largest lot multiple that fits: q=20: 1000.00 + fee 1.00 = 1001.00 > cap 1000.00; q=19: 950.00 + fee 1.00 = 951.00 <= cap 1000.00.
- OPEN: Levels from the signal-session snapshots (entry_atr=2): stop 46, target 60; need 0 < stop < entry 50.00 < target.
- OPEN: Release cap 1000.00 (available 5000.00), buy 19 at 50.00: notional 950.00, fee 1.00, debit 951.00; available -> 4049.00.
- DURING_SESSION: Touch test for T-2026-01-12-SYN: low 49.00 > stop 46 -> False; high 51.00 < target 60 -> False.
- AFTER_CLOSE: Signal: condition FALSE, decision NO_ENTRY.
- AFTER_CLOSE: Daily record: equity = available 4049.00 + reserved 0.00 + receivables 0.00 + positions 950.00 = 4999.00.

### 2026-01-13

- DURING_SESSION: Touch test for T-2026-01-12-SYN: low 49.00 > stop 46 -> False; high 51.00 < target 60 -> False.
- AFTER_CLOSE: Signal: condition FALSE, decision NO_ENTRY.
- AFTER_CLOSE: Daily record: equity = available 4049.00 + reserved 0.00 + receivables 0.00 + positions 950.00 = 4999.00.

### 2026-01-14

- DURING_SESSION: Touch test for T-2026-01-12-SYN: low 50.00 > stop 46 -> False; high 61.00 >= target 60 -> True.
- DURING_SESSION: Sell 19 at 60.00 (TARGET): notional 19 * 60.00 = 1140.00; fee = ceil(1 + 1140.00 * 0/10000) = 1.00; proceeds 1140.00 - 1.00 = 1139.00; available -> 5188.00.
- AFTER_CLOSE: Indicator sma3 = mean of the last 3 close values (indices 5..7): sum 160 / 3 = 160/3 -> 53.3333
- AFTER_CLOSE: Indicator atr3: true ranges (indices 5..7) sum to 15; ATR = 15 / 3 = 5 -> 5.0000
- AFTER_CLOSE: Decision: condition TRUE, not held, vacant slots 5 - 0 - 0 = 5. cap = floor(available 5188.00 / 5) = 1037.60.
- AFTER_CLOSE: Reserve 1037.60: available -> 4150.40, reserved -> 1037.60; rank 1.0000; snapshots entry_atr=5.
- AFTER_CLOSE: Signal: condition TRUE, decision ENTER.
- AFTER_CLOSE: Daily record: equity = available 4150.40 + reserved 1037.60 + receivables 0.00 + positions 0.00 = 5188.00.

### 2026-01-15

- OPEN: Size intent I-2026-01-14-SYN: cap 1037.60, open 58.00, lot 1, fee(n) = ceil(1 + n * 0/10000). Largest lot multiple that fits: q=17: 986.00 + fee 1.00 = 987.00 <= cap 1037.60.
- OPEN: Levels from the signal-session snapshots (entry_atr=5): stop 48, target 83; need 0 < stop < entry 58.00 < target.
- OPEN: Release cap 1037.60 (available 5188.00), buy 17 at 58.00: notional 986.00, fee 1.00, debit 987.00; available -> 4201.00.
- DURING_SESSION: Touch test for T-2026-01-15-SYN: low 57.00 > stop 48 -> False; high 59.00 < target 83 -> False.
- AFTER_CLOSE: Indicator sma3 = mean of the last 3 close values (indices 6..8): sum 168 / 3 = 56 -> 56.0000
- AFTER_CLOSE: Indicator atr3: true ranges (indices 6..8) sum to 16; ATR = 16 / 3 = 16/3 -> 5.3333
- AFTER_CLOSE: Signal: condition TRUE, decision SKIPPED (HELD).
- AFTER_CLOSE: Daily record: equity = available 4201.00 + reserved 0.00 + receivables 0.00 + positions 986.00 = 5187.00.

### 2026-01-16

- DURING_SESSION: Touch test for T-2026-01-15-SYN: low 57.00 > stop 48 -> False; high 59.00 < target 83 -> False.
- AFTER_CLOSE: Signal: condition FALSE, decision SKIPPED (NO_NEXT_SESSION).
- AFTER_CLOSE: Daily record: equity = available 4201.00 + reserved 0.00 + receivables 0.00 + positions 986.00 = 5187.00.
- AFTER_CLOSE: End of run: no forced liquidation; 1 open trade(s) valued at the last close.

### Journal sequence numbers

Fills and ledger lines share one counter: 0 RESERVE, 1 RELEASE, 2 BUY fill, 3 FILL_BUY, 4 SELL fill, 5 FILL_SELL, 6 RESERVE, 7 RELEASE, 8 BUY fill, 9 FILL_BUY.

### Outcome

The run completes. Open trades stay OPEN_AT_END and are valued at the last close.

## Hand check

- First trade: cap 1000.00, open 50.00, 19 shares, available 4049.00. Index 7: bar (50, 61, 50, 60). The target 60 is touched
  (high 61): TARGET at 60.00, proceeds 19 * 60.00 - 1.00 = 1139.00, available 5188.00.
- The same close (index 7) is a fresh decision: SMA3 = (50 + 50 + 60) / 3 = 53.3333 < close 60, so the condition is TRUE and
  the instrument is no longer held. True ranges of indices 5, 6, 7 are 2, 2, 11 (high - low = 11, |61 - 50| = 11), so ATR3 =
  15 / 3 = 5. Cap = floor(5188.00 / 5) = 1037.60. This is reserved at the close, not filled at it.
- Next open (index 8) is 58.00: 17 shares (986.00 + 1.00 = 987.00 <= 1037.60; 18 shares 1044.00 + 1.00 > 1037.60). Levels from
  the signal-session ATR 5: stop 58 - 10 = 48, target 58 + 25 = 83. Available 5188.00 - 987.00 = 4201.00.

The oracle asserts these hand-derived values against its own output (a disagreement stops the run and is resolved by re-reading the specification, never by copying a value):

- `fills.1.reason` = `TARGET` (high 61 >= target 60)
- `fills.1.price` = `60.00` (target level)
- `entries.1.cap` = `1037.60` (floor(5188.00 / 5): proceeds already in cash at the close)
- `entries.1.quantity` = `17` (17 * 58.00 + 1.00 = 987.00 <= 1037.60; 18 shares 1045.00)
- `fills.2.session` = `2026-01-15` (re-entry at the NEXT session's open)
- `fills.2.price` = `58.00` (the next open, not the close 60 and not the exit price)
- `daily.8.positions.0.stop` = `48` (58 - 2 * 5, ATR from the signal session index 7)
- `daily.8.positions.0.target` = `83` (58 + 5 * 5)
- `final.cash_available` = `4201.00` (5188.00 - 987.00)

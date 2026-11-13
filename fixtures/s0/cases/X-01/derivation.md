# X-01: Next-open entry: cap 1000, fee 1.00 + 10 bps, 19 shares, cash 4048.05

Origin: derived by `fixtures/s0/oracle/oracle.py` from OQ-02 sections 2.1 to 2.6 and the declared policy semantics; the oracle uses exact rational arithmetic and never reads the Rust engine. Status: hand-checked (see the last section). Covers: Cash and quantities, Entry and exit phases.

## Design

Eight sessions. Capital 5000.00, five slots, lot 1, fee 1.00 fixed plus 10 bps. A single close signal at index 4 reserves the cap, the fill happens at the next open and never at the signal close. The fee rounding up (ceil) makes 20 shares unaffordable although 20 * 50.00 = 1000.00 equals the cap.

## Inputs

- Strategy: `strategy.json` (strategy hash `sha256:3302430bca6f9088e1355c3c36534ce31c00f3c1082c3f5d3cd2c35c960473b9`).
- Input hash binding in `input.json`: `sha256:3302430bca6f9088e1355c3c36534ce31c00f3c1082c3f5d3cd2c35c960473b9`.
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

- OPEN: Size intent I-2026-01-09-SYN: cap 1000.00, open 50.00, lot 1, fee(n) = ceil(1 + n * 10/10000). Largest lot multiple that fits: q=20: 1000.00 + fee 2.00 = 1002.00 > cap 1000.00; q=19: 950.00 + fee 1.95 = 951.95 <= cap 1000.00.
- OPEN: Levels from the signal-session snapshots (entry_atr=2): stop 46, target 60; need 0 < stop < entry 50.00 < target.
- OPEN: Release cap 1000.00 (available 5000.00), buy 19 at 50.00: notional 950.00, fee 1.95, debit 951.95; available -> 4048.05.
- DURING_SESSION: Touch test for T-2026-01-12-SYN: low 49.00 > stop 46 -> False; high 51.00 < target 60 -> False.
- AFTER_CLOSE: Signal: condition FALSE, decision NO_ENTRY.
- AFTER_CLOSE: Daily record: equity = available 4048.05 + reserved 0.00 + receivables 0.00 + positions 950.00 = 4998.05.

### 2026-01-13

- DURING_SESSION: Touch test for T-2026-01-12-SYN: low 49.00 > stop 46 -> False; high 51.00 < target 60 -> False.
- AFTER_CLOSE: Signal: condition FALSE, decision NO_ENTRY.
- AFTER_CLOSE: Daily record: equity = available 4048.05 + reserved 0.00 + receivables 0.00 + positions 950.00 = 4998.05.

### 2026-01-14

- DURING_SESSION: Touch test for T-2026-01-12-SYN: low 49.00 > stop 46 -> False; high 51.00 < target 60 -> False.
- AFTER_CLOSE: Signal: condition FALSE, decision SKIPPED (NO_NEXT_SESSION).
- AFTER_CLOSE: Daily record: equity = available 4048.05 + reserved 0.00 + receivables 0.00 + positions 950.00 = 4998.05.
- AFTER_CLOSE: End of run: no forced liquidation; 1 open trade(s) valued at the last close.

### Journal sequence numbers

Fills and ledger lines share one counter: 0 RESERVE, 1 RELEASE, 2 BUY fill, 3 FILL_BUY.

### Outcome

The run completes. Open trades stay OPEN_AT_END and are valued at the last close.

## Hand check

- Signal at index 4 (2026-01-09): SMA3 = (50 + 50 + 51) / 3 = 50.3333, close 51 > 50.3333. True ranges of indices 2, 3, 4
  are 2, 2, 2, so ATR3 = 2. Not held, five vacant slots: cap = floor(5000.00 / 5) = 1000.00. Reserve: available
  4000.00, reserved 1000.00.
- Next open (2026-01-12) is 50.00. fee(n) = ceil(1.00 + n * 10 / 10000). Quantity 20: notional 1000.00, fee =
  ceil(1.00 + 1.00) = 2.00, total 1002.00 > 1000.00, rejected. Quantity 19: notional 950.00, fee = ceil(1.00 + 0.95) =
  1.95, total 951.95 <= 1000.00, accepted. The cap is released (available 5000.00) and 951.95 debited: 4048.05.
- Levels: stop 50 - 2 * 2 = 46, target 50 + 5 * 2 = 60. No later bar touches them. Equity 4048.05 + 19 * 50 = 4998.05.

The oracle asserts these hand-derived values against its own output (a disagreement stops the run and is resolved by re-reading the specification, never by copying a value):

- `entries.0.cap` = `1000.00` (floor(5000.00 / 5))
- `entries.0.quantity` = `19` (950.00 + 1.95 = 951.95 <= 1000.00; 20 shares: 1000.00 + 2.00 = 1002.00 > 1000.00)
- `entries.0.fee` = `1.95` (ceil(1.00 + 950.00 * 10 / 10000))
- `fills.0.cash_delta` = `-951.95` (-(950.00 + 1.95))
- `cash_ledger.2.available_after` = `4048.05` (5000.00 - 951.95)
- `daily.5.equity` = `4998.05` (4048.05 + 19 * 50.00)
- `daily.5.positions.0.stop` = `46` (50 - 2 * 2)
- `daily.5.positions.0.target` = `60` (50 + 5 * 2)
- `final.equity` = `4998.05` (no price change)

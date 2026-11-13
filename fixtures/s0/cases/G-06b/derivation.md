# G-06b: Grid tie: gap through the stop, the open 4.33 equals the stop 5 - 3 * 0.67/3 exactly, slippage applies

Origin: derived by `fixtures/s0/oracle/oracle.py` from OQ-02 sections 2.1 to 2.6 and the declared policy semantics; the oracle uses exact rational arithmetic and never reads the Rust engine. Status: hand-checked (see the last section). Covers: Entry and exit phases, Cash and quantities.

## Design

9 sessions. Indices 0 to 3 are flat bars; the signal bar (index 4) makes the true-range sum 0.67, so ATR3 = 0.67 / 3 has no finite decimal form while 3 * ATR3 = 0.67 is a price on the grid. The mirror of G-06. A stop computed from a rounded ATR3 lies one unit of the last digit above 4.33; the open is a gap either way and the fill is the same, so only the stored level differs. The case pins the other direction.

## Inputs

- Strategy: `strategy.json` (strategy hash `sha256:b185f9e87454260e8371ad7f4d8ff8f4c217dd0375c3757ed722ebb2625bc852`).
- Input hash binding in `input.json`: `sha256:b185f9e87454260e8371ad7f4d8ff8f4c217dd0375c3757ed722ebb2625bc852`.
- Policy: price scale 2, quantity scale 0, money scale 2, diagnostic scale 4, lot size 1; fixed fee 1.00 per fill, 0 bps, gap-exit slippage 100 bps; dividend withholding 0 bps.
- Windows: warm-up from 2026-01-05, scored from 2026-01-08, run ends after 2026-01-15; 9 calendar sessions, 9 bars; initial capital 5000.00.

| Session | Open | High | Low | Close | Volume |
| --- | --- | --- | --- | --- | --- |
| 2026-01-05 | 5 | 5.1 | 4.9 | 5 | 1000 |
| 2026-01-06 | 5 | 5.1 | 4.9 | 5 | 1000 |
| 2026-01-07 | 5 | 5.1 | 4.9 | 5 | 1000 |
| 2026-01-08 | 5 | 5.1 | 4.9 | 5 | 1000 |
| 2026-01-09 | 5 | 5.17 | 4.9 | 5.05 | 1000 |
| 2026-01-12 | 5 | 5.1 | 4.9 | 5 | 1000 |
| 2026-01-13 | 4.4 | 4.4 | 4.34 | 4.35 | 1000 |
| 2026-01-14 | 4.33 | 4.4 | 4.3 | 4.35 | 1000 |
| 2026-01-15 | 4.35 | 4.4 | 4.3 | 4.35 | 1000 |

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

- AFTER_CLOSE: Indicator sma3 = mean of the last 3 close values (indices 2..4): sum 15.05 / 3 = 301/60 -> 5.0167
- AFTER_CLOSE: Indicator atr3: true ranges (indices 2..4) sum to 0.67; ATR = 0.67 / 3 = 67/300 -> 0.2233
- AFTER_CLOSE: Decision: condition TRUE, not held, vacant slots 5 - 0 - 0 = 5. cap = floor(available 5000.00 / 5) = 1000.00.
- AFTER_CLOSE: Reserve 1000.00: available -> 4000.00, reserved -> 1000.00; rank 1.0000; snapshots entry_atr=67/300.
- AFTER_CLOSE: Signal: condition TRUE, decision ENTER.
- AFTER_CLOSE: Daily record: equity = available 4000.00 + reserved 1000.00 + receivables 0.00 + positions 0.00 = 5000.00.

### 2026-01-12

- OPEN: Size intent I-2026-01-09-SYN: cap 1000.00, open 5.00, lot 1, fee(n) = ceil(1 + n * 0/10000). Largest lot multiple that fits: q=200: 1000.00 + fee 1.00 = 1001.00 > cap 1000.00; q=199: 995.00 + fee 1.00 = 996.00 <= cap 1000.00.
- OPEN: Levels from the signal-session snapshots (entry_atr=67/300): stop 4.33, target 5.67; need 0 < stop < entry 5.00 < target.
- OPEN: Release cap 1000.00 (available 5000.00), buy 199 at 5.00: notional 995.00, fee 1.00, debit 996.00; available -> 4004.00.
- DURING_SESSION: Touch test for T-2026-01-12-SYN: low 4.90 > stop 4.33 -> False; high 5.10 < target 5.67 -> False.
- AFTER_CLOSE: Signal: condition FALSE, decision NO_ENTRY.
- AFTER_CLOSE: Daily record: equity = available 4004.00 + reserved 0.00 + receivables 0.00 + positions 995.00 = 4999.00.

### 2026-01-13

- DURING_SESSION: Touch test for T-2026-01-12-SYN: low 4.34 > stop 4.33 -> False; high 4.40 < target 5.67 -> False.
- AFTER_CLOSE: Signal: condition FALSE, decision NO_ENTRY.
- AFTER_CLOSE: Daily record: equity = available 4004.00 + reserved 0.00 + receivables 0.00 + positions 865.65 = 4869.65.

### 2026-01-14

- OPEN: Gap: open 4.33 <= stop 4.33. Price = floor(4.33 * (1 - 100/10000)) = 4.28.
- OPEN: Sell 199 at 4.28 (GAP_STOP): notional 199 * 4.28 = 851.72; fee = ceil(1 + 851.72 * 0/10000) = 1.00; proceeds 851.72 - 1.00 = 850.72; available -> 4854.72.
- AFTER_CLOSE: Signal: condition FALSE, decision NO_ENTRY.
- AFTER_CLOSE: Daily record: equity = available 4854.72 + reserved 0.00 + receivables 0.00 + positions 0.00 = 4854.72.

### 2026-01-15

- AFTER_CLOSE: Signal: condition FALSE, decision SKIPPED (NO_NEXT_SESSION).
- AFTER_CLOSE: Daily record: equity = available 4854.72 + reserved 0.00 + receivables 0.00 + positions 0.00 = 4854.72.
- AFTER_CLOSE: End of run: no forced liquidation; 0 open trade(s) valued at the last close.

### Journal sequence numbers

Fills and ledger lines share one counter: 0 RESERVE, 1 RELEASE, 2 BUY fill, 3 FILL_BUY, 4 SELL fill, 5 FILL_SELL.

### Outcome

The run completes. Open trades stay OPEN_AT_END and are valued at the last close.

## Hand check

1. ATR3 window, indices 2, 3, 4. Indices 2 and 3 are (5, 5.10, 4.90, 5) after a close of 5: max(0.20, 0.10, 0.10) = 0.20 each. Index 4 is (5, 5.17, 4.90, 5.05) after a close of 5: max(5.17 - 4.90, 5.17 - 5, 5 - 4.90) = max(0.27, 0.17, 0.10) = 0.27. The sum is 0.20 + 0.20 + 0.27 = 0.67.
2. ATR3 = 0.67 / 3 = 67/300 = 0.2233... It has no finite decimal form, because 67 cents is not a multiple of 3 cents. The close 5.05 is above SMA3 = (5 + 5 + 5.05) / 3 = 5.0166..., so the close of index 4 creates an entry intent: cap = floor(5000.00 / 5) = 1000.00, reserved.
3. Entry. Index 5 opens at 5.00 and the fee is 1.00 per fill. 200 shares cost 1000.00 + 1.00 = 1001.00 > 1000.00; 199 shares cost 995.00 + 1.00 = 996.00 <= 1000.00. Quantity 199; available 5000.00 - 996.00 = 4004.00.
4. Levels. Stop = 5 - 3 * (0.67 / 3) = 5 - 0.67 = 4.33. Target = 5 + 3 * (0.67 / 3) = 5 + 0.67 = 5.67. The multiplier 3 cancels the divisor 3, so both levels are exact prices on the grid although ATR3 is not. An ATR3 rounded to finitely many digits lies below its exact value, so a level computed from it lies above the exact stop and below the exact target, by about one unit of its last digit. The expectation states both exact levels in the daily positions and omits the ATR snapshot (no finite decimal form).
5. Index 6 (4.40, 4.40, 4.34, 4.35): the open 4.40 is above the stop 4.33 (no gap); the low 4.34 > 4.33, one tick above the stop: no touch.
6. Index 7 opens at 4.33 <= the stop 4.33 by equality: a gap through the stop, GAP_STOP at OPEN. The fill is the open less slippage, floored to the price scale: 4.33 * (1 - 100/10000) = 4.33 * 0.99 = 4.2867, floored to 2 decimals = 4.28. It is neither the stop level nor the nearest price. Notional 199 * 4.28 = 851.72; fee 1.00; proceeds 850.72; available 4004.00 + 850.72 = 4854.72.
7. The closes of indices 7 and 8 (4.35) are not above SMA3, so no new entry arises. The run ends with no position.

The oracle asserts these hand-derived values against its own output (a disagreement stops the run and is resolved by re-reading the specification, never by copying a value):

- `entries.0.cap` = `1000.00` (floor(5000.00 / 5))
- `entries.0.quantity` = `199` (200 shares 1001.00 > 1000.00; 199 shares 996.00)
- `cash_ledger.0.amount` = `1000.00` (the reserved cap)
- `daily.5.cash_available` = `4004.00` (5000.00 - 996.00)
- `daily.5.positions.0.stop` = `4.33` (5 - 3 * (0.67 / 3))
- `daily.5.positions.0.target` = `5.67` (5 + 3 * (0.67 / 3))
- `fills.1.notional` = `851.72` (199 * the exit price)
- `fills.1.fee` = `1.00` (fixed fee)
- `fills.1.cash_delta` = `850.72` (notional - 1.00)
- `final.cash_available` = `4854.72` (4004.00 + the proceeds)
- `fills.1.session` = `2026-01-14` (index 7)
- `fills.1.reason` = `GAP_STOP` (open == stop)
- `fills.1.phase` = `OPEN` (a gap exit happens at the open)
- `fills.1.price` = `4.28` (floor(4.33 * 0.99))
- `trades.0.exit_price` = `4.28` (the exit price)

# G-12b: Off-grid stop 137/3: an open at 45.67 = ceil(stop) is no gap, the intraday touch fills at 45.66

Origin: derived by `fixtures/s0/oracle/oracle.py` from OQ-02 sections 2.1 to 2.6 and the declared policy semantics; the oracle uses exact rational arithmetic and never reads the Rust engine. Status: hand-checked (see the last section). Covers: Entry and exit phases, Cash and quantities.

## Design

8 sessions. ATR3 is 13/6 at the signal, so the stop is 137/3 = 45.6666... and the target 365/6 (as in X-14). The policy declares 150 bps of slippage for a gap through a stop. Index 6 opens at 45.67 with a low of 45.67 and index 7 opens at 45.67 again, the grid price equal to ceil(137/3) but above the exact stop: neither open is a gap, and the low of index 7 touches the stop. The exit is an intraday STOP touch at DURING_SESSION filled at floor(137/3) = 45.66 without slippage. A gap test against the ceiled stop (open <= 45.67) would sell at the open of index 6 as GAP_STOP with the 150 bps of slippage.

## Inputs

- Strategy: `strategy.json` (strategy hash `sha256:95ac7b73e7e8d85f1f17ab7bc73f0a2705bd05aa37aeac0fd2c6840c0eb3b0b5`).
- Input hash binding in `input.json`: `sha256:95ac7b73e7e8d85f1f17ab7bc73f0a2705bd05aa37aeac0fd2c6840c0eb3b0b5`.
- Policy: price scale 2, quantity scale 0, money scale 2, diagnostic scale 4, lot size 1; fixed fee 1.00 per fill, 0 bps, gap-exit slippage 150 bps; dividend withholding 0 bps.
- Windows: warm-up from 2026-01-05, scored from 2026-01-08, run ends after 2026-01-14; 8 calendar sessions, 8 bars; initial capital 5000.00.

| Session | Open | High | Low | Close | Volume |
| --- | --- | --- | --- | --- | --- |
| 2026-01-05 | 50 | 51 | 49 | 50 | 1000 |
| 2026-01-06 | 50 | 51 | 49 | 50 | 1000 |
| 2026-01-07 | 50 | 51 | 49 | 50 | 1000 |
| 2026-01-08 | 50 | 51 | 49 | 50 | 1000 |
| 2026-01-09 | 50 | 52 | 49.5 | 51 | 1000 |
| 2026-01-12 | 50 | 51 | 49 | 50 | 1000 |
| 2026-01-13 | 45.67 | 45.7 | 45.67 | 45.68 | 1000 |
| 2026-01-14 | 45.67 | 45.7 | 45.66 | 45.68 | 1000 |

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
- AFTER_CLOSE: Indicator atr3: true ranges (indices 2..4) sum to 6.5; ATR = 6.5 / 3 = 13/6 -> 2.1667
- AFTER_CLOSE: Decision: condition TRUE, not held, vacant slots 5 - 0 - 0 = 5. cap = floor(available 5000.00 / 5) = 1000.00.
- AFTER_CLOSE: Reserve 1000.00: available -> 4000.00, reserved -> 1000.00; rank 1.0000; snapshots entry_atr=13/6.
- AFTER_CLOSE: Signal: condition TRUE, decision ENTER.
- AFTER_CLOSE: Daily record: equity = available 4000.00 + reserved 1000.00 + receivables 0.00 + positions 0.00 = 5000.00.

### 2026-01-12

- OPEN: Size intent I-2026-01-09-SYN: cap 1000.00, open 50.00, lot 1, fee(n) = ceil(1 + n * 0/10000). Largest lot multiple that fits: q=20: 1000.00 + fee 1.00 = 1001.00 > cap 1000.00; q=19: 950.00 + fee 1.00 = 951.00 <= cap 1000.00.
- OPEN: Levels from the signal-session snapshots (entry_atr=13/6): stop 137/3, target 365/6; need 0 < stop < entry 50.00 < target.
- OPEN: Release cap 1000.00 (available 5000.00), buy 19 at 50.00: notional 950.00, fee 1.00, debit 951.00; available -> 4049.00.
- DURING_SESSION: Touch test for T-2026-01-12-SYN: low 49.00 > stop 137/3 -> False; high 51.00 < target 365/6 -> False.
- AFTER_CLOSE: Signal: condition FALSE, decision NO_ENTRY.
- AFTER_CLOSE: Daily record: equity = available 4049.00 + reserved 0.00 + receivables 0.00 + positions 950.00 = 4999.00.

### 2026-01-13

- DURING_SESSION: Touch test for T-2026-01-12-SYN: low 45.67 > stop 137/3 -> False; high 45.70 < target 365/6 -> False.
- AFTER_CLOSE: Signal: condition FALSE, decision NO_ENTRY.
- AFTER_CLOSE: Daily record: equity = available 4049.00 + reserved 0.00 + receivables 0.00 + positions 867.92 = 4916.92.

### 2026-01-14

- DURING_SESSION: Touch test for T-2026-01-12-SYN: low 45.66 <= stop 137/3 -> True; high 45.70 < target 365/6 -> False.
- DURING_SESSION: Sell 19 at 45.66 (STOP): notional 19 * 45.66 = 867.54; fee = ceil(1 + 867.54 * 0/10000) = 1.00; proceeds 867.54 - 1.00 = 866.54; available -> 4915.54.
- AFTER_CLOSE: Signal: condition FALSE, decision SKIPPED (NO_NEXT_SESSION).
- AFTER_CLOSE: Daily record: equity = available 4915.54 + reserved 0.00 + receivables 0.00 + positions 0.00 = 4915.54.
- AFTER_CLOSE: End of run: no forced liquidation; 0 open trade(s) valued at the last close.

### Journal sequence numbers

Fills and ledger lines share one counter: 0 RESERVE, 1 RELEASE, 2 BUY fill, 3 FILL_BUY, 4 SELL fill, 5 FILL_SELL.

### Outcome

The run completes. Open trades stay OPEN_AT_END and are valued at the last close.

## Hand check

1. ATR3 window, indices 2, 3, 4. Indices 2 and 3 are (50, 51, 49, 50) after a close of 50: max(2, 1, 1) = 2 each. Index 4 is (50, 52, 49.50, 51) after a close of 50: max(52 - 49.50, 52 - 50, 50 - 49.50) = max(2.50, 2.00, 0.50) = 2.50. The sum is 2 + 2 + 2.50 = 6.50 and ATR3 = 6.50 / 3 = 13/6 = 2.1666..., which has no finite decimal form. The close 51 is above SMA3 = (50 + 50 + 51) / 3 = 151/3 = 50.3333...: entry intent, cap = floor(5000.00 / 5) = 1000.00, reserved.
2. Entry. Index 5 opens at 50.00 and the fee is 1.00 per fill (0 bps). 20 shares cost 1000.00 + 1.00 = 1001.00 > 1000.00; 19 shares cost 950.00 + 1.00 = 951.00 <= 1000.00. Quantity 19; available 5000.00 - 951.00 = 4049.00.
3. Levels. Stop = 50 - 2 * 13/6 = 50 - 13/3 = 137/3 = 45.6666..., that is 45 + 2/3; target = 50 + 5 * 13/6 = 50 + 65/6 = 365/6 = 60.8333... The stop has no finite decimal form (its denominator 3 is neither 2 nor 5), so it lies strictly between the grid prices 45.66 and 45.67: floor(137/3) = 45.66 and ceil(137/3) = 45.67. The expectation omits both levels and the ATR snapshot in the daily positions.
4. Index 6 (45.67, 45.70, 45.67, 45.68): the open 45.67 > 137/3 = 45.6666...: no gap through the stop. A test against the ceiled stop (open <= 45.67) would call it a gap and sell at floor(45.67 * 0.985) = floor(44.98495) = 44.98. The low 45.67 > 137/3: no touch. The high 45.70 is far below the target 365/6. The position is held. The close 45.68 is below SMA3 = (51 + 50 + 45.68) / 3 = 48.8933..., so no entry arises.
5. Index 7 (45.67, 45.70, 45.66, 45.68): the open 45.67 > 137/3 again: no gap, so there is no GAP_STOP at OPEN. The low 45.66 <= 137/3 = 45.6666...: the stop is touched during the session, STOP at DURING_SESSION (the high 45.70 is below the target, so the bar is not ambiguous). The fill is the level floored to the price scale: floor(137/3) = 45.66, before costs and without slippage: the policy's 150 bps apply to a gap through a stop only, and an intraday touch is not one (a gap fill would be 44.98). Notional 19 * 45.66 = 867.54; fee 1.00; proceeds 866.54; available 4049.00 + 866.54 = 4915.54.
6. Index 7 is the last session, so its close creates no intent. The run ends with no position.

The oracle asserts these hand-derived values against its own output (a disagreement stops the run and is resolved by re-reading the specification, never by copying a value):

- `entries.0.cap` = `1000.00` (floor(5000.00 / 5))
- `entries.0.quantity` = `19` (20 shares 1001.00 > 1000.00; 19 shares 951.00)
- `cash_ledger.0.amount` = `1000.00` (the reserved cap)
- `daily.5.cash_available` = `4049.00` (5000.00 - 951.00)
- `daily.6.positions.0.quantity` = `19` (the position is still held at the close of index 6)
- `signals.6.decision` = `NO_ENTRY` (the close 45.68 is below SMA3)
- `signals.7.skip_reason` = `NO_NEXT_SESSION` (index 7 is the last session)
- `fills.1.session` = `2026-01-14` (index 7)
- `fills.1.reason` = `STOP` (see the derivation)
- `fills.1.phase` = `DURING_SESSION` (see the derivation)
- `fills.1.quantity` = `19` (the whole position)
- `fills.1.price` = `45.66` (see the derivation)
- `fills.1.notional` = `867.54` (19 * the exit price)
- `fills.1.fee` = `1.00` (fixed fee, 0 bps)
- `fills.1.cash_delta` = `866.54` (notional - 1.00)
- `trades.0.exit_price` = `45.66` (the exit price)
- `final.cash_available` = `4915.54` (4049.00 + the proceeds)
- `final.equity` = `4915.54` (nothing is held)

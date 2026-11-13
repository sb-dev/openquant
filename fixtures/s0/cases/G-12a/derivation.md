# G-12a: Off-grid target 367/6: an open at 61.16 = floor(target) is no gap, the intraday touch fills at 61.16

Origin: derived by `fixtures/s0/oracle/oracle.py` from OQ-02 sections 2.1 to 2.6 and the declared policy semantics; the oracle uses exact rational arithmetic and never reads the Rust engine. Status: hand-checked (see the last section). Covers: Entry and exit phases, Cash and quantities.

## Design

8 sessions. ATR3 is 67/30 at the signal, so the target is 367/6 = 61.1666... and the stop 683/15 (as in X-12). Index 6 opens at 61.16 with a high of 61.16 and index 7 opens at 61.16 again, the grid price equal to floor(367/6) but below the exact target: neither open is a gap, and the high of index 7 touches the target. The exit is an intraday TARGET touch at DURING_SESSION filled at 61.16. A gap test against the floored target (open >= 61.16) would sell at the open of index 6 as GAP_TARGET.

## Inputs

- Strategy: `strategy.json` (strategy hash `sha256:ef1d5a4d8d167f959f74e55fbeb05e61c11ba3d1b914e68401689fede4f725b2`).
- Input hash binding in `input.json`: `sha256:ef1d5a4d8d167f959f74e55fbeb05e61c11ba3d1b914e68401689fede4f725b2`.
- Policy: price scale 2, quantity scale 0, money scale 2, diagnostic scale 4, lot size 1; fixed fee 1.00 per fill, 0 bps, gap-exit slippage 150 bps; dividend withholding 0 bps.
- Windows: warm-up from 2026-01-05, scored from 2026-01-08, run ends after 2026-01-14; 8 calendar sessions, 8 bars; initial capital 5000.00.

| Session | Open | High | Low | Close | Volume |
| --- | --- | --- | --- | --- | --- |
| 2026-01-05 | 50 | 51 | 49 | 50 | 1000 |
| 2026-01-06 | 50 | 51 | 49 | 50 | 1000 |
| 2026-01-07 | 50 | 51 | 49 | 50 | 1000 |
| 2026-01-08 | 50 | 51 | 49 | 50 | 1000 |
| 2026-01-09 | 50 | 52.2 | 49.5 | 51 | 1000 |
| 2026-01-12 | 50 | 51 | 49 | 50 | 1000 |
| 2026-01-13 | 61.16 | 61.16 | 61.1 | 61.16 | 1000 |
| 2026-01-14 | 61.16 | 61.17 | 61.15 | 61.17 | 1000 |

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
- AFTER_CLOSE: Indicator atr3: true ranges (indices 2..4) sum to 6.7; ATR = 6.7 / 3 = 67/30 -> 2.2333
- AFTER_CLOSE: Decision: condition TRUE, not held, vacant slots 5 - 0 - 0 = 5. cap = floor(available 5000.00 / 5) = 1000.00.
- AFTER_CLOSE: Reserve 1000.00: available -> 4000.00, reserved -> 1000.00; rank 1.0000; snapshots entry_atr=67/30.
- AFTER_CLOSE: Signal: condition TRUE, decision ENTER.
- AFTER_CLOSE: Daily record: equity = available 4000.00 + reserved 1000.00 + receivables 0.00 + positions 0.00 = 5000.00.

### 2026-01-12

- OPEN: Size intent I-2026-01-09-SYN: cap 1000.00, open 50.00, lot 1, fee(n) = ceil(1 + n * 0/10000). Largest lot multiple that fits: q=20: 1000.00 + fee 1.00 = 1001.00 > cap 1000.00; q=19: 950.00 + fee 1.00 = 951.00 <= cap 1000.00.
- OPEN: Levels from the signal-session snapshots (entry_atr=67/30): stop 683/15, target 367/6; need 0 < stop < entry 50.00 < target.
- OPEN: Release cap 1000.00 (available 5000.00), buy 19 at 50.00: notional 950.00, fee 1.00, debit 951.00; available -> 4049.00.
- DURING_SESSION: Touch test for T-2026-01-12-SYN: low 49.00 > stop 683/15 -> False; high 51.00 < target 367/6 -> False.
- AFTER_CLOSE: Signal: condition FALSE, decision NO_ENTRY.
- AFTER_CLOSE: Daily record: equity = available 4049.00 + reserved 0.00 + receivables 0.00 + positions 950.00 = 4999.00.

### 2026-01-13

- DURING_SESSION: Touch test for T-2026-01-12-SYN: low 61.10 > stop 683/15 -> False; high 61.16 < target 367/6 -> False.
- AFTER_CLOSE: Indicator sma3 = mean of the last 3 close values (indices 4..6): sum 162.16 / 3 = 4054/75 -> 54.0533
- AFTER_CLOSE: Indicator atr3: true ranges (indices 4..6) sum to 15.86; ATR = 15.86 / 3 = 793/150 -> 5.2867
- AFTER_CLOSE: Signal: condition TRUE, decision SKIPPED (HELD).
- AFTER_CLOSE: Daily record: equity = available 4049.00 + reserved 0.00 + receivables 0.00 + positions 1162.04 = 5211.04.

### 2026-01-14

- DURING_SESSION: Touch test for T-2026-01-12-SYN: low 61.15 > stop 683/15 -> False; high 61.17 >= target 367/6 -> True.
- DURING_SESSION: Sell 19 at 61.16 (TARGET): notional 19 * 61.16 = 1162.04; fee = ceil(1 + 1162.04 * 0/10000) = 1.00; proceeds 1162.04 - 1.00 = 1161.04; available -> 5210.04.
- AFTER_CLOSE: Indicator sma3 = mean of the last 3 close values (indices 5..7): sum 172.33 / 3 = 17233/300 -> 57.4433
- AFTER_CLOSE: Indicator atr3: true ranges (indices 5..7) sum to 13.18; ATR = 13.18 / 3 = 659/150 -> 4.3933
- AFTER_CLOSE: Signal: condition TRUE, decision SKIPPED (NO_NEXT_SESSION).
- AFTER_CLOSE: Daily record: equity = available 5210.04 + reserved 0.00 + receivables 0.00 + positions 0.00 = 5210.04.
- AFTER_CLOSE: End of run: no forced liquidation; 0 open trade(s) valued at the last close.

### Journal sequence numbers

Fills and ledger lines share one counter: 0 RESERVE, 1 RELEASE, 2 BUY fill, 3 FILL_BUY, 4 SELL fill, 5 FILL_SELL.

### Outcome

The run completes. Open trades stay OPEN_AT_END and are valued at the last close.

## Hand check

1. ATR3 window, indices 2, 3, 4. Indices 2 and 3 are (50, 51, 49, 50) after a close of 50: max(2, 1, 1) = 2 each. Index 4 is (50, 52.20, 49.50, 51) after a close of 50: max(52.20 - 49.50, 52.20 - 50, 50 - 49.50) = max(2.70, 2.20, 0.50) = 2.70. The sum is 2 + 2 + 2.70 = 6.70 and ATR3 = 6.70 / 3 = 67/30 = 2.2333..., which has no finite decimal form. The close 51 is above SMA3 = (50 + 50 + 51) / 3 = 151/3 = 50.3333...: entry intent, cap = floor(5000.00 / 5) = 1000.00, reserved.
2. Entry. Index 5 opens at 50.00 and the fee is 1.00 per fill (0 bps). 20 shares cost 1000.00 + 1.00 = 1001.00 > 1000.00; 19 shares cost 950.00 + 1.00 = 951.00 <= 1000.00. Quantity 19; available 5000.00 - 951.00 = 4049.00.
3. Levels. Stop = 50 - 2 * 67/30 = 50 - 67/15 = 683/15 = 45.5333...; target = 50 + 5 * 67/30 = 50 + 67/6 = 367/6 = 61.1666..., that is 61 + 1/6. The target has no finite decimal form (its denominator 6 has the prime factor 3), so it lies strictly between the grid prices 61.16 and 61.17: floor(367/6) = 61.16 and ceil(367/6) = 61.17. The expectation omits both levels and the ATR snapshot in the daily positions.
4. Index 6 (61.16, 61.16, 61.10, 61.16): the open 61.16 < 367/6 = 61.1666...: no gap above the target. A test against the floored target (open >= 61.16) would call it a gap and sell at this open. The high 61.16 < 367/6: no touch. The low 61.10 is above the stop 683/15. The position is held. The close 61.16 is above SMA3 = (51 + 50 + 61.16) / 3 = 54.0533..., which creates no intent because the instrument is held.
5. Index 7 (61.16, 61.17, 61.15, 61.17): the open 61.16 < 367/6 again: no gap, so there is no GAP_TARGET at OPEN. The low 61.15 is above the stop. The high 61.17 >= 367/6 = 61.1666...: the target is touched during the session, TARGET at DURING_SESSION. The fill is the level floored to the price scale: floor(367/6) = 61.16, before costs and without slippage (the policy's 150 bps apply to a gap through a stop only). Notional 19 * 61.16 = 1162.04; fee 1.00; proceeds 1161.04; available 4049.00 + 1161.04 = 5210.04.
6. Index 7 is the last session, so its close creates no intent. The run ends with no position.

The oracle asserts these hand-derived values against its own output (a disagreement stops the run and is resolved by re-reading the specification, never by copying a value):

- `entries.0.cap` = `1000.00` (floor(5000.00 / 5))
- `entries.0.quantity` = `19` (20 shares 1001.00 > 1000.00; 19 shares 951.00)
- `cash_ledger.0.amount` = `1000.00` (the reserved cap)
- `daily.5.cash_available` = `4049.00` (5000.00 - 951.00)
- `daily.6.positions.0.quantity` = `19` (the position is still held at the close of index 6)
- `signals.6.decision` = `SKIPPED` (held: the condition is TRUE)
- `signals.7.skip_reason` = `NO_NEXT_SESSION` (index 7 is the last session)
- `fills.1.session` = `2026-01-14` (index 7)
- `fills.1.reason` = `TARGET` (see the derivation)
- `fills.1.phase` = `DURING_SESSION` (see the derivation)
- `fills.1.quantity` = `19` (the whole position)
- `fills.1.price` = `61.16` (see the derivation)
- `fills.1.notional` = `1162.04` (19 * the exit price)
- `fills.1.fee` = `1.00` (fixed fee, 0 bps)
- `fills.1.cash_delta` = `1161.04` (notional - 1.00)
- `trades.0.exit_price` = `61.16` (the exit price)
- `final.cash_available` = `5210.04` (4049.00 + the proceeds)
- `final.equity` = `5210.04` (nothing is held)
- `signals.6.skip_reason` = `HELD` (the condition is TRUE while the instrument is held)

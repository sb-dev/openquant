# X-08: Equality boundaries: low = stop, high = target, open = stop, open = target

Origin: derived by `fixtures/s0/oracle/oracle.py` from OQ-02 sections 2.1 to 2.6 and the declared policy semantics; the oracle uses exact rational arithmetic and never reads the Rust engine. Status: hand-checked (see the last section). Covers: Entry and exit phases, Cash and quantities.

## Design

Twenty-six sessions, four consecutive trades each ending on an exact equality: a bar whose low equals the stop (touch), a bar whose high equals the target (touch), an open equal to the stop (gap exit with slippage) and an open equal to the target (gap exit at the target).

## Inputs

- Strategy: `strategy.json` (strategy hash `sha256:eb0172513f9d8b2d7eea6e23507c97afafaf2a642e84c6c399a01475a9d83a29`).
- Input hash binding in `input.json`: `sha256:eb0172513f9d8b2d7eea6e23507c97afafaf2a642e84c6c399a01475a9d83a29`.
- Policy: price scale 2, quantity scale 0, money scale 2, diagnostic scale 4, lot size 1; fixed fee 1.00 per fill, 0 bps, gap-exit slippage 100 bps; dividend withholding 0 bps.
- Windows: warm-up from 2026-01-05, scored from 2026-01-08, run ends after 2026-02-09; 26 calendar sessions, 26 bars; initial capital 5000.00.

| Session | Open | High | Low | Close | Volume |
| --- | --- | --- | --- | --- | --- |
| 2026-01-05 | 50 | 51 | 49 | 50 | 1000 |
| 2026-01-06 | 50 | 51 | 49 | 50 | 1000 |
| 2026-01-07 | 50 | 51 | 49 | 50 | 1000 |
| 2026-01-08 | 50 | 51 | 49 | 50 | 1000 |
| 2026-01-09 | 50 | 51.5 | 49.5 | 51 | 1000 |
| 2026-01-12 | 50 | 51 | 49 | 50 | 1000 |
| 2026-01-13 | 50 | 51 | 46 | 48 | 1000 |
| 2026-01-14 | 48 | 49 | 47 | 48 | 1000 |
| 2026-01-15 | 48 | 49 | 47 | 48 | 1000 |
| 2026-01-16 | 48 | 49 | 47 | 48 | 1000 |
| 2026-01-19 | 48 | 49.5 | 47.5 | 49 | 1000 |
| 2026-01-20 | 48 | 49 | 47 | 48 | 1000 |
| 2026-01-21 | 48 | 58 | 47 | 48 | 1000 |
| 2026-01-22 | 48 | 49 | 47 | 48 | 1000 |
| 2026-01-23 | 48 | 49 | 47 | 48 | 1000 |
| 2026-01-26 | 48 | 49 | 47 | 48 | 1000 |
| 2026-01-27 | 48 | 49.5 | 47.5 | 49 | 1000 |
| 2026-01-28 | 48 | 49 | 47 | 48 | 1000 |
| 2026-01-29 | 44 | 45 | 43 | 44 | 1000 |
| 2026-01-30 | 44 | 45 | 43 | 44 | 1000 |
| 2026-02-02 | 44 | 45 | 43 | 44 | 1000 |
| 2026-02-03 | 44 | 45 | 43 | 44 | 1000 |
| 2026-02-04 | 44 | 45.5 | 43.5 | 45 | 1000 |
| 2026-02-05 | 44 | 45 | 43 | 44 | 1000 |
| 2026-02-06 | 54 | 55 | 44 | 44 | 1000 |
| 2026-02-09 | 44 | 45 | 43 | 44 | 1000 |

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

- DURING_SESSION: Touch test for T-2026-01-12-SYN: low 46.00 <= stop 46 -> True; high 51.00 < target 60 -> False.
- DURING_SESSION: Sell 19 at 46.00 (STOP): notional 19 * 46.00 = 874.00; fee = ceil(1 + 874.00 * 0/10000) = 1.00; proceeds 874.00 - 1.00 = 873.00; available -> 4922.00.
- AFTER_CLOSE: Signal: condition FALSE, decision NO_ENTRY.
- AFTER_CLOSE: Daily record: equity = available 4922.00 + reserved 0.00 + receivables 0.00 + positions 0.00 = 4922.00.

### 2026-01-14

- AFTER_CLOSE: Signal: condition FALSE, decision NO_ENTRY.
- AFTER_CLOSE: Daily record: equity = available 4922.00 + reserved 0.00 + receivables 0.00 + positions 0.00 = 4922.00.

### 2026-01-15

- AFTER_CLOSE: Signal: condition FALSE, decision NO_ENTRY.
- AFTER_CLOSE: Daily record: equity = available 4922.00 + reserved 0.00 + receivables 0.00 + positions 0.00 = 4922.00.

### 2026-01-16

- AFTER_CLOSE: Signal: condition FALSE, decision NO_ENTRY.
- AFTER_CLOSE: Daily record: equity = available 4922.00 + reserved 0.00 + receivables 0.00 + positions 0.00 = 4922.00.

### 2026-01-19

- AFTER_CLOSE: Indicator sma3 = mean of the last 3 close values (indices 8..10): sum 145 / 3 = 145/3 -> 48.3333
- AFTER_CLOSE: Indicator atr3: true ranges (indices 8..10) sum to 6; ATR = 6 / 3 = 2 -> 2.0000
- AFTER_CLOSE: Decision: condition TRUE, not held, vacant slots 5 - 0 - 0 = 5. cap = floor(available 4922.00 / 5) = 984.40.
- AFTER_CLOSE: Reserve 984.40: available -> 3937.60, reserved -> 984.40; rank 1.0000; snapshots entry_atr=2.
- AFTER_CLOSE: Signal: condition TRUE, decision ENTER.
- AFTER_CLOSE: Daily record: equity = available 3937.60 + reserved 984.40 + receivables 0.00 + positions 0.00 = 4922.00.

### 2026-01-20

- OPEN: Size intent I-2026-01-19-SYN: cap 984.40, open 48.00, lot 1, fee(n) = ceil(1 + n * 0/10000). Largest lot multiple that fits: q=20: 960.00 + fee 1.00 = 961.00 <= cap 984.40.
- OPEN: Levels from the signal-session snapshots (entry_atr=2): stop 44, target 58; need 0 < stop < entry 48.00 < target.
- OPEN: Release cap 984.40 (available 4922.00), buy 20 at 48.00: notional 960.00, fee 1.00, debit 961.00; available -> 3961.00.
- DURING_SESSION: Touch test for T-2026-01-20-SYN: low 47.00 > stop 44 -> False; high 49.00 < target 58 -> False.
- AFTER_CLOSE: Signal: condition FALSE, decision NO_ENTRY.
- AFTER_CLOSE: Daily record: equity = available 3961.00 + reserved 0.00 + receivables 0.00 + positions 960.00 = 4921.00.

### 2026-01-21

- DURING_SESSION: Touch test for T-2026-01-20-SYN: low 47.00 > stop 44 -> False; high 58.00 >= target 58 -> True.
- DURING_SESSION: Sell 20 at 58.00 (TARGET): notional 20 * 58.00 = 1160.00; fee = ceil(1 + 1160.00 * 0/10000) = 1.00; proceeds 1160.00 - 1.00 = 1159.00; available -> 5120.00.
- AFTER_CLOSE: Signal: condition FALSE, decision NO_ENTRY.
- AFTER_CLOSE: Daily record: equity = available 5120.00 + reserved 0.00 + receivables 0.00 + positions 0.00 = 5120.00.

### 2026-01-22

- AFTER_CLOSE: Signal: condition FALSE, decision NO_ENTRY.
- AFTER_CLOSE: Daily record: equity = available 5120.00 + reserved 0.00 + receivables 0.00 + positions 0.00 = 5120.00.

### 2026-01-23

- AFTER_CLOSE: Signal: condition FALSE, decision NO_ENTRY.
- AFTER_CLOSE: Daily record: equity = available 5120.00 + reserved 0.00 + receivables 0.00 + positions 0.00 = 5120.00.

### 2026-01-26

- AFTER_CLOSE: Signal: condition FALSE, decision NO_ENTRY.
- AFTER_CLOSE: Daily record: equity = available 5120.00 + reserved 0.00 + receivables 0.00 + positions 0.00 = 5120.00.

### 2026-01-27

- AFTER_CLOSE: Indicator sma3 = mean of the last 3 close values (indices 14..16): sum 145 / 3 = 145/3 -> 48.3333
- AFTER_CLOSE: Indicator atr3: true ranges (indices 14..16) sum to 6; ATR = 6 / 3 = 2 -> 2.0000
- AFTER_CLOSE: Decision: condition TRUE, not held, vacant slots 5 - 0 - 0 = 5. cap = floor(available 5120.00 / 5) = 1024.00.
- AFTER_CLOSE: Reserve 1024.00: available -> 4096.00, reserved -> 1024.00; rank 1.0000; snapshots entry_atr=2.
- AFTER_CLOSE: Signal: condition TRUE, decision ENTER.
- AFTER_CLOSE: Daily record: equity = available 4096.00 + reserved 1024.00 + receivables 0.00 + positions 0.00 = 5120.00.

### 2026-01-28

- OPEN: Size intent I-2026-01-27-SYN: cap 1024.00, open 48.00, lot 1, fee(n) = ceil(1 + n * 0/10000). Largest lot multiple that fits: q=21: 1008.00 + fee 1.00 = 1009.00 <= cap 1024.00.
- OPEN: Levels from the signal-session snapshots (entry_atr=2): stop 44, target 58; need 0 < stop < entry 48.00 < target.
- OPEN: Release cap 1024.00 (available 5120.00), buy 21 at 48.00: notional 1008.00, fee 1.00, debit 1009.00; available -> 4111.00.
- DURING_SESSION: Touch test for T-2026-01-28-SYN: low 47.00 > stop 44 -> False; high 49.00 < target 58 -> False.
- AFTER_CLOSE: Signal: condition FALSE, decision NO_ENTRY.
- AFTER_CLOSE: Daily record: equity = available 4111.00 + reserved 0.00 + receivables 0.00 + positions 1008.00 = 5119.00.

### 2026-01-29

- OPEN: Gap: open 44.00 <= stop 44. Price = floor(44.00 * (1 - 100/10000)) = 43.56.
- OPEN: Sell 21 at 43.56 (GAP_STOP): notional 21 * 43.56 = 914.76; fee = ceil(1 + 914.76 * 0/10000) = 1.00; proceeds 914.76 - 1.00 = 913.76; available -> 5024.76.
- AFTER_CLOSE: Signal: condition FALSE, decision NO_ENTRY.
- AFTER_CLOSE: Daily record: equity = available 5024.76 + reserved 0.00 + receivables 0.00 + positions 0.00 = 5024.76.

### 2026-01-30

- AFTER_CLOSE: Signal: condition FALSE, decision NO_ENTRY.
- AFTER_CLOSE: Daily record: equity = available 5024.76 + reserved 0.00 + receivables 0.00 + positions 0.00 = 5024.76.

### 2026-02-02

- AFTER_CLOSE: Signal: condition FALSE, decision NO_ENTRY.
- AFTER_CLOSE: Daily record: equity = available 5024.76 + reserved 0.00 + receivables 0.00 + positions 0.00 = 5024.76.

### 2026-02-03

- AFTER_CLOSE: Signal: condition FALSE, decision NO_ENTRY.
- AFTER_CLOSE: Daily record: equity = available 5024.76 + reserved 0.00 + receivables 0.00 + positions 0.00 = 5024.76.

### 2026-02-04

- AFTER_CLOSE: Indicator sma3 = mean of the last 3 close values (indices 20..22): sum 133 / 3 = 133/3 -> 44.3333
- AFTER_CLOSE: Indicator atr3: true ranges (indices 20..22) sum to 6; ATR = 6 / 3 = 2 -> 2.0000
- AFTER_CLOSE: Decision: condition TRUE, not held, vacant slots 5 - 0 - 0 = 5. cap = floor(available 5024.76 / 5) = 1004.95.
- AFTER_CLOSE: Reserve 1004.95: available -> 4019.81, reserved -> 1004.95; rank 1.0000; snapshots entry_atr=2.
- AFTER_CLOSE: Signal: condition TRUE, decision ENTER.
- AFTER_CLOSE: Daily record: equity = available 4019.81 + reserved 1004.95 + receivables 0.00 + positions 0.00 = 5024.76.

### 2026-02-05

- OPEN: Size intent I-2026-02-04-SYN: cap 1004.95, open 44.00, lot 1, fee(n) = ceil(1 + n * 0/10000). Largest lot multiple that fits: q=22: 968.00 + fee 1.00 = 969.00 <= cap 1004.95.
- OPEN: Levels from the signal-session snapshots (entry_atr=2): stop 40, target 54; need 0 < stop < entry 44.00 < target.
- OPEN: Release cap 1004.95 (available 5024.76), buy 22 at 44.00: notional 968.00, fee 1.00, debit 969.00; available -> 4055.76.
- DURING_SESSION: Touch test for T-2026-02-05-SYN: low 43.00 > stop 40 -> False; high 45.00 < target 54 -> False.
- AFTER_CLOSE: Signal: condition FALSE, decision NO_ENTRY.
- AFTER_CLOSE: Daily record: equity = available 4055.76 + reserved 0.00 + receivables 0.00 + positions 968.00 = 5023.76.

### 2026-02-06

- OPEN: Gap: open 54.00 >= target 54. Fill at the target level 54.00, no slippage.
- OPEN: Sell 22 at 54.00 (GAP_TARGET): notional 22 * 54.00 = 1188.00; fee = ceil(1 + 1188.00 * 0/10000) = 1.00; proceeds 1188.00 - 1.00 = 1187.00; available -> 5242.76.
- AFTER_CLOSE: Signal: condition FALSE, decision NO_ENTRY.
- AFTER_CLOSE: Daily record: equity = available 5242.76 + reserved 0.00 + receivables 0.00 + positions 0.00 = 5242.76.

### 2026-02-09

- AFTER_CLOSE: Signal: condition FALSE, decision SKIPPED (NO_NEXT_SESSION).
- AFTER_CLOSE: Daily record: equity = available 5242.76 + reserved 0.00 + receivables 0.00 + positions 0.00 = 5242.76.
- AFTER_CLOSE: End of run: no forced liquidation; 0 open trade(s) valued at the last close.

### Journal sequence numbers

Fills and ledger lines share one counter: 0 RESERVE, 1 RELEASE, 2 BUY fill, 3 FILL_BUY, 4 SELL fill, 5 FILL_SELL, 6 RESERVE, 7 RELEASE, 8 BUY fill, 9 FILL_BUY, 10 SELL fill, 11 FILL_SELL, 12 RESERVE, 13 RELEASE, 14 BUY fill, 15 FILL_BUY, 16 SELL fill, 17 FILL_SELL, 18 RESERVE, 19 RELEASE, 20 BUY fill, 21 FILL_BUY, 22 SELL fill, 23 FILL_SELL.

### Outcome

The run completes. Open trades stay OPEN_AT_END and are valued at the last close.

## Hand check

Four trades, fee 1.00 fixed, no bps, gap slippage 100 bps. Levels: stop = entry - 2 * 2, target = entry + 5 * 2 (ATR 2
at every signal).

1. A: cap 1000.00, open 50.00, 19 shares (950 + 1 = 951 <= 1000; 20 shares 1001 > 1000). Available 4049.00. Stop 46,
   target 60. Bar index 6: open 50, low exactly 46 = stop: a touch (low <= stop), STOP at 46.00 (no gap: open 50 > 46).
   Proceeds 19 * 46 - 1 = 873.00, available 4922.00.
2. B: cap floor(4922.00 / 5) = 984.40, open 48.00, 20 shares (960 + 1 = 961). Available 3961.00. Stop 44, target 58. Bar
   index 12: open 48, high exactly 58 = target: TARGET at 58.00. Proceeds 20 * 58 - 1 = 1159.00, available 5120.00.
3. C: cap 5120.00 / 5 = 1024.00, open 48.00, 21 shares (1008 + 1 = 1009). Available 4111.00. Stop 44. Bar index 18 opens at
   exactly 44 = stop: open <= stop is a gap exit: price floor(44.00 * 0.99) = 43.56. Proceeds 21 * 43.56 - 1 = 913.76,
   available 5024.76.
4. D: cap floor(5024.76 / 5) = 1004.95, open 44.00, 22 shares (968 + 1 = 969; 23 shares 1013). Available 4055.76. Target
   54. Bar index 24 opens at exactly 54 = target: open >= target is a gap exit at the target level 54.00. Proceeds 22 * 54 -
   1 = 1187.00, available 5242.76.

The oracle asserts these hand-derived values against its own output (a disagreement stops the run and is resolved by re-reading the specification, never by copying a value):

- `fills.1.reason` = `STOP` (low 46 == stop 46 touches)
- `fills.1.price` = `46.00` (stop level)
- `fills.3.reason` = `TARGET` (high 58 == target 58 touches)
- `fills.3.price` = `58.00` (target level)
- `fills.5.reason` = `GAP_STOP` (open 44 == stop 44 is a gap exit)
- `fills.5.price` = `43.56` (44.00 * 0.99)
- `fills.7.reason` = `GAP_TARGET` (open 54 == target 54 is a gap exit)
- `fills.7.price` = `54.00` (target level)
- `entries.0.quantity` = `19` (cap 1000.00: 950.00 + 1.00)
- `entries.1.cap` = `984.40` (floor(4922.00 / 5))
- `entries.1.quantity` = `20` (960.00 + 1.00 <= 984.40)
- `entries.2.cap` = `1024.00` (5120.00 / 5)
- `entries.2.quantity` = `21` (1008.00 + 1.00 <= 1024.00)
- `entries.3.cap` = `1004.95` (floor(5024.76 / 5))
- `entries.3.quantity` = `22` (968.00 + 1.00 <= 1004.95)
- `final.cash_available` = `5242.76` (see the cash chain)

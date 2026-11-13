# SEM-04b: Seed exact boundary for threshold 32: RSI equal to 32 and just above 32

Origin: derived by `fixtures/s0/oracle/oracle.py` from OQ-02 sections 2.1 to 2.6 and the declared policy semantics; the oracle uses exact rational arithmetic and never reads the Rust engine. Status: hand-checked (see the last section). Covers: Seed semantics, Entry variants.

## Design

104 sessions, seed variant 2 (threshold 32). (1) index 56, RSI 32.5, 33, 33: both lagged values exceed 32, so weakness fails and the decision is NO_ENTRY; (2) index 96, RSI 32, 33, 33: RSI(t-2) is exactly 32, which satisfies `<= 32`; the floor holds (33 > 30), so ENTER. Companion of SEM-04, which covers the threshold 30 boundary and the strict current floor.

## Inputs

- Strategy: `../../strategies/seed-2-rsi32-breakeven-off.json` (strategy hash `sha256:ab5f48cdc451feb20a105cfc26fe8f969bb7f1f2c4d2ed7dfdf8390aeb106889`).
- Input hash binding in `input.json`: `sha256:ab5f48cdc451feb20a105cfc26fe8f969bb7f1f2c4d2ed7dfdf8390aeb106889`.
- Policy: price scale 2, quantity scale 0, money scale 2, diagnostic scale 4, lot size 1; fixed fee 1.00 per fill, 0 bps, gap-exit slippage 0 bps; dividend withholding 0 bps.
- Windows: warm-up from 2026-01-05, scored from 2026-03-16, run ends after 2026-05-28; 104 calendar sessions, 104 bars; initial capital 10000.00.

Closes by session index (index: close): 0: 100, 1: 100.5, 2: 101, 3: 101.5, 4: 102, 5: 102.5, 6: 103, 7: 103.5, 8: 104, 9: 104.5, 10: 105, 11: 105.5, 12: 106, 13: 106.5, 14: 107, 15: 107.5, 16: 108, 17: 108.5, 18: 109, 19: 109.5, 20: 110, 21: 110.5, 22: 111, 23: 111.5, 24: 112, 25: 112.5, 26: 113, 27: 113.5, 28: 114, 29: 114.5, 30: 115, 31: 115.5, 32: 116, 33: 116.5, 34: 117, 35: 117.5, 36: 118, 37: 118.5, 38: 119, 39: 119.5, 40: 120, 41: 119.95, 42: 119.95, 43: 118.83, 44: 119.65, 45: 118.53, 46: 119.34, 47: 118.22, 48: 119.03, 49: 117.91, 50: 118.72, 51: 117.61, 52: 116.5, 53: 116.5, 54: 116.5, 55: 116.55, 56: 116.55, 57: 117.55, 58: 118.55, 59: 119.55, 60: 120.55, 61: 121.55, 62: 122.55, 63: 123.55, 64: 124.55, 65: 125.55, 66: 126.55, 67: 127.55, 68: 128.55, 69: 129.55, 70: 130.55, 71: 131.55, 72: 132.55, 73: 133.55, 74: 134.55, 75: 135.55, 76: 136.55, 77: 137.55, 78: 138.55, 79: 139.55, 80: 140.55, 81: 140.45, 82: 140.45, 83: 139.33, 84: 140.13, 85: 139.01, 86: 139.81, 87: 138.69, 88: 139.49, 89: 138.37, 90: 139.17, 91: 138.06, 92: 136.95, 93: 136.95, 94: 136.95, 95: 137.05, 96: 137.05, 97: 137.05, 98: 137.05, 99: 137.05, 100: 137.05, 101: 137.05, 102: 137.05, 103: 137.05.

Volumes by session index: 0: 1000, 1: 1000, 2: 1000, 3: 1000, 4: 1000, 5: 1000, 6: 1000, 7: 1000, 8: 1000, 9: 1000, 10: 1000, 11: 1000, 12: 1000, 13: 1000, 14: 1000, 15: 1000, 16: 1000, 17: 1000, 18: 1000, 19: 1000, 20: 1000, 21: 1000, 22: 1000, 23: 1000, 24: 1000, 25: 1000, 26: 1000, 27: 1000, 28: 1000, 29: 1000, 30: 1000, 31: 1000, 32: 1000, 33: 1000, 34: 1000, 35: 1000, 36: 1000, 37: 1000, 38: 1000, 39: 1000, 40: 1000, 41: 1000, 42: 1000, 43: 1000, 44: 1000, 45: 1000, 46: 1000, 47: 1000, 48: 1000, 49: 1000, 50: 1000, 51: 1000, 52: 1000, 53: 1000, 54: 1000, 55: 1000, 56: 6000, 57: 1000, 58: 1000, 59: 1000, 60: 1000, 61: 1000, 62: 1000, 63: 1000, 64: 1000, 65: 1000, 66: 1000, 67: 1000, 68: 1000, 69: 1000, 70: 1000, 71: 1000, 72: 1000, 73: 1000, 74: 1000, 75: 1000, 76: 1000, 77: 1000, 78: 1000, 79: 1000, 80: 1000, 81: 1000, 82: 1000, 83: 1000, 84: 1000, 85: 1000, 86: 1000, 87: 1000, 88: 1000, 89: 1000, 90: 1000, 91: 1000, 92: 1000, 93: 1000, 94: 1000, 95: 1000, 96: 6000, 97: 1000, 98: 1000, 99: 1000, 100: 1000, 101: 1000, 102: 1000, 103: 1000.

Session index to date: index 0 is 2026-01-05, index 103 is 2026-05-28.

## Step-by-step derivation

### 2026-03-24

- AFTER_CLOSE: Indicator sma50 = mean of the last 50 close values (indices 7..56): sum 5689.84 / 50 = 113.7968 -> 113.7968
- AFTER_CLOSE: Indicator vol_sma20 = mean of the last 20 volume values (indices 37..56): sum 25000 / 20 = 1250 -> 1250.0000
- AFTER_CLOSE: Indicator rsi14: over the 14 changes (indices 43..56) gains sum 3.3, losses sum 6.7; RSI = 100 * 3.3 / (3.3 + 6.7) = 33 -> 33.0000
- AFTER_CLOSE: Indicator atr14: true ranges (indices 43..56) sum to 28; ATR = 28 / 14 = 2 -> 2.0000
- AFTER_CLOSE: Indicator rsi_floor = const 30
- AFTER_CLOSE: Indicator weak_threshold = const 32
- AFTER_CLOSE: Indicator rsi_lag1 = rsi_simple evaluated 1 session(s) earlier = 33 -> 33.0000
- AFTER_CLOSE: Indicator rsi_lag2 = rsi_simple evaluated 2 session(s) earlier = 32.5 -> 32.5000
- AFTER_CLOSE: Seed clauses (OQ-02 2.6): close 116.55 > sma50 113.7968: True; rsi_lag2 32.5000 <= 32 or rsi_lag1 33.0000 <= 32: False; rsi14 33.0000 > 30: True; volume 6000 > vol_sma20 1250.0000: True; atr14 2.0000 > 0: True; vol_sma20 1250.0000 > 0: True. Rank = 50 * (6000 / 1250) + (100 - 33) = 307.
- AFTER_CLOSE: Signal: condition FALSE, decision NO_ENTRY.
- AFTER_CLOSE: Daily record: equity = available 10000.00 + reserved 0.00 + receivables 0.00 + positions 0.00 = 10000.00.

### 2026-05-19

- AFTER_CLOSE: Indicator sma50 = mean of the last 50 close values (indices 47..96): sum 6489.2 / 50 = 129.784 -> 129.7840
- AFTER_CLOSE: Indicator vol_sma20 = mean of the last 20 volume values (indices 77..96): sum 25000 / 20 = 1250 -> 1250.0000
- AFTER_CLOSE: Indicator rsi14: over the 14 changes (indices 83..96) gains sum 3.3, losses sum 6.7; RSI = 100 * 3.3 / (3.3 + 6.7) = 33 -> 33.0000
- AFTER_CLOSE: Indicator atr14: true ranges (indices 83..96) sum to 28; ATR = 28 / 14 = 2 -> 2.0000
- AFTER_CLOSE: Indicator rsi_floor = const 30
- AFTER_CLOSE: Indicator weak_threshold = const 32
- AFTER_CLOSE: Indicator rsi_lag1 = rsi_simple evaluated 1 session(s) earlier = 33 -> 33.0000
- AFTER_CLOSE: Indicator rsi_lag2 = rsi_simple evaluated 2 session(s) earlier = 32 -> 32.0000
- AFTER_CLOSE: Seed clauses (OQ-02 2.6): close 137.05 > sma50 129.7840: True; rsi_lag2 32.0000 <= 32 or rsi_lag1 33.0000 <= 32: True; rsi14 33.0000 > 30: True; volume 6000 > vol_sma20 1250.0000: True; atr14 2.0000 > 0: True; vol_sma20 1250.0000 > 0: True. Rank = 50 * (6000 / 1250) + (100 - 33) = 307.
- AFTER_CLOSE: Decision: condition TRUE, not held, vacant slots 5 - 0 - 0 = 5. cap = floor(available 10000.00 / 5) = 2000.00.
- AFTER_CLOSE: Reserve 2000.00: available -> 8000.00, reserved -> 2000.00; rank 307.0000; snapshots entry_atr=2.
- AFTER_CLOSE: Signal: condition TRUE, decision ENTER.
- AFTER_CLOSE: Daily record: equity = available 8000.00 + reserved 2000.00 + receivables 0.00 + positions 0.00 = 10000.00.

### 2026-05-20

- OPEN: Size intent I-2026-05-19-SYN: cap 2000.00, open 137.05, lot 1, fee(n) = ceil(1 + n * 0/10000). Largest lot multiple that fits: q=14: 1918.70 + fee 1.00 = 1919.70 <= cap 2000.00.
- OPEN: Levels from the signal-session snapshots (entry_atr=2): stop 133.05, target 147.05; need 0 < stop < entry 137.05 < target.
- OPEN: Release cap 2000.00 (available 10000.00), buy 14 at 137.05: notional 1918.70, fee 1.00, debit 1919.70; available -> 8080.30.
- DURING_SESSION: Touch test for T-2026-05-20-SYN: low 136.05 > stop 133.05 -> False; high 138.05 < target 147.05 -> False.
- AFTER_CLOSE: Signal: condition FALSE, decision NO_ENTRY.
- AFTER_CLOSE: Daily record: equity = available 8080.30 + reserved 0.00 + receivables 0.00 + positions 1918.70 = 9999.00.

### 2026-05-21

- DURING_SESSION: Touch test for T-2026-05-20-SYN: low 136.05 > stop 133.05 -> False; high 138.05 < target 147.05 -> False.
- AFTER_CLOSE: Signal: condition FALSE, decision NO_ENTRY.
- AFTER_CLOSE: Daily record: equity = available 8080.30 + reserved 0.00 + receivables 0.00 + positions 1918.70 = 9999.00.

### 2026-05-22

- DURING_SESSION: Touch test for T-2026-05-20-SYN: low 136.05 > stop 133.05 -> False; high 138.05 < target 147.05 -> False.
- AFTER_CLOSE: Signal: condition FALSE, decision NO_ENTRY.
- AFTER_CLOSE: Daily record: equity = available 8080.30 + reserved 0.00 + receivables 0.00 + positions 1918.70 = 9999.00.

### 2026-05-25

- DURING_SESSION: Touch test for T-2026-05-20-SYN: low 136.05 > stop 133.05 -> False; high 138.05 < target 147.05 -> False.
- AFTER_CLOSE: Signal: condition FALSE, decision NO_ENTRY.
- AFTER_CLOSE: Daily record: equity = available 8080.30 + reserved 0.00 + receivables 0.00 + positions 1918.70 = 9999.00.

### 2026-05-26

- DURING_SESSION: Touch test for T-2026-05-20-SYN: low 136.05 > stop 133.05 -> False; high 138.05 < target 147.05 -> False.
- AFTER_CLOSE: Signal: condition FALSE, decision NO_ENTRY.
- AFTER_CLOSE: Daily record: equity = available 8080.30 + reserved 0.00 + receivables 0.00 + positions 1918.70 = 9999.00.

### 2026-05-27

- DURING_SESSION: Touch test for T-2026-05-20-SYN: low 136.05 > stop 133.05 -> False; high 138.05 < target 147.05 -> False.
- AFTER_CLOSE: Signal: condition FALSE, decision NO_ENTRY.
- AFTER_CLOSE: Daily record: equity = available 8080.30 + reserved 0.00 + receivables 0.00 + positions 1918.70 = 9999.00.

### 2026-05-28

- DURING_SESSION: Touch test for T-2026-05-20-SYN: low 136.05 > stop 133.05 -> False; high 138.05 < target 147.05 -> False.
- AFTER_CLOSE: Signal: condition FALSE, decision SKIPPED (NO_NEXT_SESSION).
- AFTER_CLOSE: Daily record: equity = available 8080.30 + reserved 0.00 + receivables 0.00 + positions 1918.70 = 9999.00.
- AFTER_CLOSE: End of run: no forced liquidation; 1 open trade(s) valued at the last close.

### Journal sequence numbers

Fills and ledger lines share one counter: 0 RESERVE, 1 RELEASE, 2 BUY fill, 3 FILL_BUY.

### Outcome

The run completes. Open trades stay OPEN_AT_END and are valued at the last close.

## Hand check

RSI = 10 * G with total movement 10.00. Index 96 (32, 33, 33): RSI(94) has gains 3.20 and losses 6.80, the ratio 8:17, so RSI is
exactly 32 and `32 <= 32` holds; RSI(96) = 33 > 30; the other clauses hold, rank = 240 + (100 - 33) = 307: ENTER. Index 56
(32.5, 33, 33): RSI(54) = 32.5 and RSI(55) = 33 both exceed 32: weakness fails, NO_ENTRY.

The oracle asserts these hand-derived values against its own output (a disagreement stops the run and is resolved by re-reading the specification, never by copying a value):

- `signals.2.indicators.7.value` = `32.5` (RSI(t-2) at index 54)
- `signals.2.decision` = `NO_ENTRY` (32.5 > 32 and 33 > 32)
- `signals.5.indicators.7.value` = `32` (RSI(t-2) at index 94: gains 3.20, losses 6.80 (8:17), exactly 32)
- `signals.5.decision` = `ENTER` (32 <= 32 satisfies weakness)
- `signals.5.rank` = `307` (50 * 4.8 + (100 - 33))

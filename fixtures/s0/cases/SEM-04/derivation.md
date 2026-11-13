# SEM-04: Seed exact boundaries for threshold 30: RSI equal to 30 and just above 30

Origin: derived by `fixtures/s0/oracle/oracle.py` from OQ-02 sections 2.1 to 2.6 and the declared policy semantics; the oracle uses exact rational arithmetic and never reads the Rust engine. Status: hand-checked (see the last section). Covers: Seed semantics, Entry variants.

## Design

144 sessions, seed variant 1 (threshold 30). Three volume-spike sessions, each with a designed RSI14 path (total movement 10.00 in every window, so RSI = 10 * sum of gains, an exact ratio such as 3:7): (1) index 56, RSI 28, 29, 30: weakness holds (28 <= 30) but the strict floor RSI(t) > 30 fails at exactly 30, so NO_ENTRY; (2) index 96, RSI 30.5, 30.5, 31: the lagged values are just above the threshold (30.5 > 30), so weakness fails and the decision is NO_ENTRY; (3) index 136, RSI 30, 31, 31: RSI(t-2) is exactly 30, which satisfies `<= 30`, and the floor holds at 31, so ENTER. All other clauses hold at each of the three sessions, so only the boundary decides. The closes rise by 1.00 per session between the events so that the close is back above SMA50 each time, and the spikes are more than 20 sessions apart so each volume mean excludes the previous spike.

## Inputs

- Strategy: `../../strategies/seed-1-rsi30-breakeven-off.json` (strategy hash `sha256:77cfdc1ca253a3d35c5ea6b8091ff58d2b1bf8346a636cae29a79ec2f927dc78`).
- Input hash binding in `input.json`: `sha256:77cfdc1ca253a3d35c5ea6b8091ff58d2b1bf8346a636cae29a79ec2f927dc78`.
- Policy: price scale 2, quantity scale 0, money scale 2, diagnostic scale 4, lot size 1; fixed fee 1.00 per fill, 0 bps, gap-exit slippage 0 bps; dividend withholding 0 bps.
- Windows: warm-up from 2026-01-05, scored from 2026-03-16, run ends after 2026-07-23; 144 calendar sessions, 144 bars; initial capital 10000.00.

Closes by session index (index: close): 0: 100, 1: 100.5, 2: 101, 3: 101.5, 4: 102, 5: 102.5, 6: 103, 7: 103.5, 8: 104, 9: 104.5, 10: 105, 11: 105.5, 12: 106, 13: 106.5, 14: 107, 15: 107.5, 16: 108, 17: 108.5, 18: 109, 19: 109.5, 20: 110, 21: 110.5, 22: 111, 23: 111.5, 24: 112, 25: 112.5, 26: 113, 27: 113.5, 28: 114, 29: 114.5, 30: 115, 31: 115.5, 32: 116, 33: 116.5, 34: 117, 35: 117.5, 36: 118, 37: 118.5, 38: 119, 39: 119.5, 40: 120, 41: 119.9, 42: 119.8, 43: 118.63, 44: 119.33, 45: 118.16, 46: 118.86, 47: 117.69, 48: 118.39, 49: 117.22, 50: 117.92, 51: 116.76, 52: 115.6, 53: 115.6, 54: 115.6, 55: 115.7, 56: 115.8, 57: 116.8, 58: 117.8, 59: 118.8, 60: 119.8, 61: 120.8, 62: 121.8, 63: 122.8, 64: 123.8, 65: 124.8, 66: 125.8, 67: 126.8, 68: 127.8, 69: 128.8, 70: 129.8, 71: 130.8, 72: 131.8, 73: 132.8, 74: 133.8, 75: 134.8, 76: 135.8, 77: 136.8, 78: 137.8, 79: 138.8, 80: 139.8, 81: 139.8, 82: 139.75, 83: 138.6, 84: 139.37, 85: 138.22, 86: 138.98, 87: 137.83, 88: 138.59, 89: 137.44, 90: 138.2, 91: 137.05, 92: 135.9, 93: 135.9, 94: 135.9, 95: 135.9, 96: 135.95, 97: 136.95, 98: 137.95, 99: 138.95, 100: 139.95, 101: 140.95, 102: 141.95, 103: 142.95, 104: 143.95, 105: 144.95, 106: 145.95, 107: 146.95, 108: 147.95, 109: 148.95, 110: 149.95, 111: 150.95, 112: 151.95, 113: 152.95, 114: 153.95, 115: 154.95, 116: 155.95, 117: 156.95, 118: 157.95, 119: 158.95, 120: 159.95, 121: 159.85, 122: 159.85, 123: 158.7, 124: 159.45, 125: 158.3, 126: 159.05, 127: 157.9, 128: 158.65, 129: 157.5, 130: 158.25, 131: 157.1, 132: 155.95, 133: 155.95, 134: 155.95, 135: 156.05, 136: 156.05, 137: 156.05, 138: 156.05, 139: 156.05, 140: 156.05, 141: 156.05, 142: 156.05, 143: 156.05.

Volumes by session index: 0: 1000, 1: 1000, 2: 1000, 3: 1000, 4: 1000, 5: 1000, 6: 1000, 7: 1000, 8: 1000, 9: 1000, 10: 1000, 11: 1000, 12: 1000, 13: 1000, 14: 1000, 15: 1000, 16: 1000, 17: 1000, 18: 1000, 19: 1000, 20: 1000, 21: 1000, 22: 1000, 23: 1000, 24: 1000, 25: 1000, 26: 1000, 27: 1000, 28: 1000, 29: 1000, 30: 1000, 31: 1000, 32: 1000, 33: 1000, 34: 1000, 35: 1000, 36: 1000, 37: 1000, 38: 1000, 39: 1000, 40: 1000, 41: 1000, 42: 1000, 43: 1000, 44: 1000, 45: 1000, 46: 1000, 47: 1000, 48: 1000, 49: 1000, 50: 1000, 51: 1000, 52: 1000, 53: 1000, 54: 1000, 55: 1000, 56: 6000, 57: 1000, 58: 1000, 59: 1000, 60: 1000, 61: 1000, 62: 1000, 63: 1000, 64: 1000, 65: 1000, 66: 1000, 67: 1000, 68: 1000, 69: 1000, 70: 1000, 71: 1000, 72: 1000, 73: 1000, 74: 1000, 75: 1000, 76: 1000, 77: 1000, 78: 1000, 79: 1000, 80: 1000, 81: 1000, 82: 1000, 83: 1000, 84: 1000, 85: 1000, 86: 1000, 87: 1000, 88: 1000, 89: 1000, 90: 1000, 91: 1000, 92: 1000, 93: 1000, 94: 1000, 95: 1000, 96: 6000, 97: 1000, 98: 1000, 99: 1000, 100: 1000, 101: 1000, 102: 1000, 103: 1000, 104: 1000, 105: 1000, 106: 1000, 107: 1000, 108: 1000, 109: 1000, 110: 1000, 111: 1000, 112: 1000, 113: 1000, 114: 1000, 115: 1000, 116: 1000, 117: 1000, 118: 1000, 119: 1000, 120: 1000, 121: 1000, 122: 1000, 123: 1000, 124: 1000, 125: 1000, 126: 1000, 127: 1000, 128: 1000, 129: 1000, 130: 1000, 131: 1000, 132: 1000, 133: 1000, 134: 1000, 135: 1000, 136: 6000, 137: 1000, 138: 1000, 139: 1000, 140: 1000, 141: 1000, 142: 1000, 143: 1000.

Session index to date: index 0 is 2026-01-05, index 143 is 2026-07-23.

## Step-by-step derivation

### 2026-03-24

- AFTER_CLOSE: Indicator sma50 = mean of the last 50 close values (indices 7..56): sum 5680.46 / 50 = 113.6092 -> 113.6092
- AFTER_CLOSE: Indicator vol_sma20 = mean of the last 20 volume values (indices 37..56): sum 25000 / 20 = 1250 -> 1250.0000
- AFTER_CLOSE: Indicator rsi14: over the 14 changes (indices 43..56) gains sum 3, losses sum 7; RSI = 100 * 3 / (3 + 7) = 30 -> 30.0000
- AFTER_CLOSE: Indicator atr14: true ranges (indices 43..56) sum to 28; ATR = 28 / 14 = 2 -> 2.0000
- AFTER_CLOSE: Indicator rsi_floor = const 30
- AFTER_CLOSE: Indicator weak_threshold = const 30
- AFTER_CLOSE: Indicator rsi_lag1 = rsi_simple evaluated 1 session(s) earlier = 29 -> 29.0000
- AFTER_CLOSE: Indicator rsi_lag2 = rsi_simple evaluated 2 session(s) earlier = 28 -> 28.0000
- AFTER_CLOSE: Seed clauses (OQ-02 2.6): close 115.8 > sma50 113.6092: True; rsi_lag2 28.0000 <= 30 or rsi_lag1 29.0000 <= 30: True; rsi14 30.0000 > 30: False; volume 6000 > vol_sma20 1250.0000: True; atr14 2.0000 > 0: True; vol_sma20 1250.0000 > 0: True. Rank = 50 * (6000 / 1250) + (100 - 30) = 310.
- AFTER_CLOSE: Signal: condition FALSE, decision NO_ENTRY.
- AFTER_CLOSE: Daily record: equity = available 10000.00 + reserved 0.00 + receivables 0.00 + positions 0.00 = 10000.00.

### 2026-05-19

- AFTER_CLOSE: Indicator sma50 = mean of the last 50 close values (indices 47..96): sum 6448.86 / 50 = 128.9772 -> 128.9772
- AFTER_CLOSE: Indicator vol_sma20 = mean of the last 20 volume values (indices 77..96): sum 25000 / 20 = 1250 -> 1250.0000
- AFTER_CLOSE: Indicator rsi14: over the 14 changes (indices 83..96) gains sum 3.1, losses sum 6.9; RSI = 100 * 3.1 / (3.1 + 6.9) = 31 -> 31.0000
- AFTER_CLOSE: Indicator atr14: true ranges (indices 83..96) sum to 28; ATR = 28 / 14 = 2 -> 2.0000
- AFTER_CLOSE: Indicator rsi_floor = const 30
- AFTER_CLOSE: Indicator weak_threshold = const 30
- AFTER_CLOSE: Indicator rsi_lag1 = rsi_simple evaluated 1 session(s) earlier = 30.5 -> 30.5000
- AFTER_CLOSE: Indicator rsi_lag2 = rsi_simple evaluated 2 session(s) earlier = 30.5 -> 30.5000
- AFTER_CLOSE: Seed clauses (OQ-02 2.6): close 135.95 > sma50 128.9772: True; rsi_lag2 30.5000 <= 30 or rsi_lag1 30.5000 <= 30: False; rsi14 31.0000 > 30: True; volume 6000 > vol_sma20 1250.0000: True; atr14 2.0000 > 0: True; vol_sma20 1250.0000 > 0: True. Rank = 50 * (6000 / 1250) + (100 - 31) = 309.
- AFTER_CLOSE: Signal: condition FALSE, decision NO_ENTRY.
- AFTER_CLOSE: Daily record: equity = available 10000.00 + reserved 0.00 + receivables 0.00 + positions 0.00 = 10000.00.

### 2026-07-14

- AFTER_CLOSE: Indicator sma50 = mean of the last 50 close values (indices 87..136): sum 7456.01 / 50 = 149.1202 -> 149.1202
- AFTER_CLOSE: Indicator vol_sma20 = mean of the last 20 volume values (indices 117..136): sum 25000 / 20 = 1250 -> 1250.0000
- AFTER_CLOSE: Indicator rsi14: over the 14 changes (indices 123..136) gains sum 3.1, losses sum 6.9; RSI = 100 * 3.1 / (3.1 + 6.9) = 31 -> 31.0000
- AFTER_CLOSE: Indicator atr14: true ranges (indices 123..136) sum to 28; ATR = 28 / 14 = 2 -> 2.0000
- AFTER_CLOSE: Indicator rsi_floor = const 30
- AFTER_CLOSE: Indicator weak_threshold = const 30
- AFTER_CLOSE: Indicator rsi_lag1 = rsi_simple evaluated 1 session(s) earlier = 31 -> 31.0000
- AFTER_CLOSE: Indicator rsi_lag2 = rsi_simple evaluated 2 session(s) earlier = 30 -> 30.0000
- AFTER_CLOSE: Seed clauses (OQ-02 2.6): close 156.05 > sma50 149.1202: True; rsi_lag2 30.0000 <= 30 or rsi_lag1 31.0000 <= 30: True; rsi14 31.0000 > 30: True; volume 6000 > vol_sma20 1250.0000: True; atr14 2.0000 > 0: True; vol_sma20 1250.0000 > 0: True. Rank = 50 * (6000 / 1250) + (100 - 31) = 309.
- AFTER_CLOSE: Decision: condition TRUE, not held, vacant slots 5 - 0 - 0 = 5. cap = floor(available 10000.00 / 5) = 2000.00.
- AFTER_CLOSE: Reserve 2000.00: available -> 8000.00, reserved -> 2000.00; rank 309.0000; snapshots entry_atr=2.
- AFTER_CLOSE: Signal: condition TRUE, decision ENTER.
- AFTER_CLOSE: Daily record: equity = available 8000.00 + reserved 2000.00 + receivables 0.00 + positions 0.00 = 10000.00.

### 2026-07-15

- OPEN: Size intent I-2026-07-14-SYN: cap 2000.00, open 156.05, lot 1, fee(n) = ceil(1 + n * 0/10000). Largest lot multiple that fits: q=12: 1872.60 + fee 1.00 = 1873.60 <= cap 2000.00.
- OPEN: Levels from the signal-session snapshots (entry_atr=2): stop 152.05, target 166.05; need 0 < stop < entry 156.05 < target.
- OPEN: Release cap 2000.00 (available 10000.00), buy 12 at 156.05: notional 1872.60, fee 1.00, debit 1873.60; available -> 8126.40.
- DURING_SESSION: Touch test for T-2026-07-15-SYN: low 155.05 > stop 152.05 -> False; high 157.05 < target 166.05 -> False.
- AFTER_CLOSE: Signal: condition FALSE, decision NO_ENTRY.
- AFTER_CLOSE: Daily record: equity = available 8126.40 + reserved 0.00 + receivables 0.00 + positions 1872.60 = 9999.00.

### 2026-07-16

- DURING_SESSION: Touch test for T-2026-07-15-SYN: low 155.05 > stop 152.05 -> False; high 157.05 < target 166.05 -> False.
- AFTER_CLOSE: Signal: condition FALSE, decision NO_ENTRY.
- AFTER_CLOSE: Daily record: equity = available 8126.40 + reserved 0.00 + receivables 0.00 + positions 1872.60 = 9999.00.

### 2026-07-17

- DURING_SESSION: Touch test for T-2026-07-15-SYN: low 155.05 > stop 152.05 -> False; high 157.05 < target 166.05 -> False.
- AFTER_CLOSE: Signal: condition FALSE, decision NO_ENTRY.
- AFTER_CLOSE: Daily record: equity = available 8126.40 + reserved 0.00 + receivables 0.00 + positions 1872.60 = 9999.00.

### 2026-07-20

- DURING_SESSION: Touch test for T-2026-07-15-SYN: low 155.05 > stop 152.05 -> False; high 157.05 < target 166.05 -> False.
- AFTER_CLOSE: Signal: condition FALSE, decision NO_ENTRY.
- AFTER_CLOSE: Daily record: equity = available 8126.40 + reserved 0.00 + receivables 0.00 + positions 1872.60 = 9999.00.

### 2026-07-21

- DURING_SESSION: Touch test for T-2026-07-15-SYN: low 155.05 > stop 152.05 -> False; high 157.05 < target 166.05 -> False.
- AFTER_CLOSE: Signal: condition FALSE, decision NO_ENTRY.
- AFTER_CLOSE: Daily record: equity = available 8126.40 + reserved 0.00 + receivables 0.00 + positions 1872.60 = 9999.00.

### 2026-07-22

- DURING_SESSION: Touch test for T-2026-07-15-SYN: low 155.05 > stop 152.05 -> False; high 157.05 < target 166.05 -> False.
- AFTER_CLOSE: Signal: condition FALSE, decision NO_ENTRY.
- AFTER_CLOSE: Daily record: equity = available 8126.40 + reserved 0.00 + receivables 0.00 + positions 1872.60 = 9999.00.

### 2026-07-23

- DURING_SESSION: Touch test for T-2026-07-15-SYN: low 155.05 > stop 152.05 -> False; high 157.05 < target 166.05 -> False.
- AFTER_CLOSE: Signal: condition FALSE, decision SKIPPED (NO_NEXT_SESSION).
- AFTER_CLOSE: Daily record: equity = available 8126.40 + reserved 0.00 + receivables 0.00 + positions 1872.60 = 9999.00.
- AFTER_CLOSE: End of run: no forced liquidation; 1 open trade(s) valued at the last close.

### Journal sequence numbers

Fills and ledger lines share one counter: 0 RESERVE, 1 RELEASE, 2 BUY fill, 3 FILL_BUY.

### Outcome

The run completes. Open trades stay OPEN_AT_END and are valued at the last close.

## Hand check

RSI = 100 * G / (G + L) with G + L = 10.00 in every designed window, so RSI = 10 * G, a ratio of integers in cents.

- Index 56 (28, 29, 30): the window at index 56 holds gains 3.00 and losses 7.00 (ratio 3:7, RSI exactly 30). Weakness: RSI(54) =
  28 <= 30 holds. Floor: RSI(56) = 30 > 30 is false. Every other clause holds (close above SMA50, volume 6000 > 1250, ATR 2 > 0,
  mean 1250 > 0), so the condition is FALSE and the decision NO_ENTRY: only the strict floor decides.
- Index 96 (30.5, 30.5, 31): RSI(94) = RSI(95) = 30.5 (gains 3.05, losses 6.95), both above 30, so `RSI(t-2) <= 30 or RSI(t-1) <=
  30` is false: NO_ENTRY. RSI(96) = 31 passes the floor.
- Index 136 (30, 31, 31): RSI(134) = 100 * 3.00 / 10.00 = 30 exactly, `30 <= 30` holds; RSI(136) = 31 > 30 holds: ENTER, rank
  = 50 * (6000 / 1250) + (100 - 31) = 240 + 69 = 309.

The oracle asserts these hand-derived values against its own output (a disagreement stops the run and is resolved by re-reading the specification, never by copying a value):

- `signals.2.indicators.7.value` = `28` (RSI(t-2) at index 54)
- `signals.2.indicators.2.value` = `30` (RSI(t) = 100 * 3.00 / 10.00 exactly)
- `signals.2.decision` = `NO_ENTRY` (strict floor RSI > 30 fails at exactly 30)
- `signals.5.indicators.7.value` = `30.5` (RSI(t-2) at index 94)
- `signals.5.decision` = `NO_ENTRY` (30.5 > 30 and 30.5 > 30: weakness fails)
- `signals.8.indicators.7.value` = `30` (RSI(t-2) at index 134, exactly 30)
- `signals.8.decision` = `ENTER` (30 <= 30 satisfies weakness; floor 31 > 30)
- `signals.8.rank` = `309` (50 * 4.8 + (100 - 31))

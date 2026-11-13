# SEM-01: Seed indicators on irregular synthetic OHLCV (72 sessions)

Origin: derived by `fixtures/s0/oracle/oracle.py` from OQ-02 sections 2.1 to 2.6 and the declared policy semantics; the oracle uses exact rational arithmetic and never reads the Rust engine. Status: hand-checked (see the last section). Covers: Seed semantics.

## Design

72 sessions of irregular synthetic OHLCV for seed variant 1 (threshold 30, break-even off). Rises are 0.10 to 0.90 per session (fixed LCG), ranges 1.50 to 3.30 plus a tuned bar, volumes 850 to 1150 with a volume spike at the signal session. The 16 closes before the signal session are designed so that the weak-RSI path reaches the entry condition. The listed signal sessions cover the first valid session of every indicator (indices 14 for RSI14 and ATR14, 15 for the first lagged RSI, 16 for the second, 19 for the volume mean, 49 for SMA50), the sessions around the signal session and the last session. Indicator values are the exact rational results rounded half-even to four decimals; the ATR14 sum at the signal session is tuned to a multiple of 14 cents so that stop and target are exact two-decimal prices.

## Inputs

- Strategy: `../../strategies/seed-1-rsi30-breakeven-off.json` (strategy hash `sha256:77cfdc1ca253a3d35c5ea6b8091ff58d2b1bf8346a636cae29a79ec2f927dc78`).
- Input hash binding in `input.json`: `sha256:77cfdc1ca253a3d35c5ea6b8091ff58d2b1bf8346a636cae29a79ec2f927dc78`.
- Policy: price scale 2, quantity scale 0, money scale 2, diagnostic scale 4, lot size 1; fixed fee 1.00 per fill, 0 bps, gap-exit slippage 0 bps; dividend withholding 0 bps.
- Windows: warm-up from 2026-01-05, scored from 2026-03-16, run ends after 2026-04-14; 72 calendar sessions, 72 bars; initial capital 10000.00.

Closes by session index (index: close): 0: 100, 1: 100.86, 2: 101.01, 3: 101.9, 4: 102.25, 5: 102.38, 6: 102.75, 7: 103.39, 8: 103.68, 9: 104.55, 10: 104.72, 11: 105.49, 12: 106.38, 13: 106.57, 14: 107.23, 15: 108.12, 16: 108.75, 17: 109.47, 18: 109.61, 19: 109.81, 20: 110.43, 21: 110.57, 22: 111.21, 23: 111.82, 24: 112.2, 25: 113.05, 26: 113.26, 27: 113.8, 28: 114.13, 29: 114.66, 30: 115.22, 31: 115.95, 32: 116.63, 33: 117.16, 34: 117.37, 35: 117.89, 36: 118.67, 37: 119.57, 38: 119.92, 39: 120.35, 40: 120.46, 41: 120.59, 42: 121.24, 43: 120.64, 44: 120.34, 45: 119.27, 46: 119.81, 47: 118.74, 48: 119.28, 49: 118.21, 50: 118.75, 51: 117.68, 52: 118.22, 53: 117.16, 54: 117.7, 55: 116.64, 56: 116.64, 57: 117.24, 58: 117.54, 59: 117.54, 60: 117.54, 61: 117.54, 62: 117.54, 63: 117.54, 64: 117.54, 65: 117.54, 66: 117.54, 67: 117.54, 68: 117.54, 69: 117.54, 70: 117.54, 71: 117.54.

Volumes by session index: 0: 882, 1: 920, 2: 1130, 3: 912, 4: 1048, 5: 978, 6: 928, 7: 876, 8: 935, 9: 1086, 10: 971, 11: 993, 12: 997, 13: 1028, 14: 854, 15: 886, 16: 986, 17: 850, 18: 1097, 19: 1076, 20: 1069, 21: 967, 22: 1141, 23: 1097, 24: 864, 25: 959, 26: 1035, 27: 851, 28: 1061, 29: 1132, 30: 956, 31: 997, 32: 1139, 33: 886, 34: 1036, 35: 1032, 36: 1096, 37: 941, 38: 1086, 39: 921, 40: 1131, 41: 1123, 42: 957, 43: 1008, 44: 1045, 45: 1033, 46: 1130, 47: 1058, 48: 1017, 49: 1116, 50: 974, 51: 1051, 52: 975, 53: 1050, 54: 976, 55: 1129, 56: 965, 57: 981, 58: 2300, 59: 969, 60: 900, 61: 1012, 62: 952, 63: 892, 64: 981, 65: 898, 66: 869, 67: 1103, 68: 887, 69: 894, 70: 1111, 71: 900.

Session index to date: index 0 is 2026-01-05, index 71 is 2026-04-14.

## Step-by-step derivation

### 2026-01-23

- AFTER_CLOSE: Indicator sma50 = missing (INSUFFICIENT_HISTORY)
- AFTER_CLOSE: Indicator vol_sma20 = missing (INSUFFICIENT_HISTORY)
- AFTER_CLOSE: Indicator rsi14: over the 14 changes (indices 1..14) gains sum 7.23, losses sum 0; RSI = 100 * 7.23 / (7.23 + 0) = 100 -> 100.0000
- AFTER_CLOSE: Indicator atr14: true ranges (indices 1..14) sum to 30.76; ATR = 30.76 / 14 = 769/350 -> 2.1971
- AFTER_CLOSE: Indicator rsi_floor = const 30
- AFTER_CLOSE: Indicator weak_threshold = const 30
- AFTER_CLOSE: Indicator rsi_lag1 = missing (INSUFFICIENT_HISTORY)
- AFTER_CLOSE: Indicator rsi_lag2 = missing (INSUFFICIENT_HISTORY)
- AFTER_CLOSE: Seed clauses: at least one referenced indicator is missing, so the condition is MISSING.
- AFTER_CLOSE: Signal: condition MISSING, decision SKIPPED (NOT_SCORED_YET).
- AFTER_CLOSE: Daily record: equity = available 10000.00 + reserved 0.00 + receivables 0.00 + positions 0.00 = 10000.00.

### 2026-01-26

- AFTER_CLOSE: Indicator sma50 = missing (INSUFFICIENT_HISTORY)
- AFTER_CLOSE: Indicator vol_sma20 = missing (INSUFFICIENT_HISTORY)
- AFTER_CLOSE: Indicator rsi14: over the 14 changes (indices 2..15) gains sum 7.26, losses sum 0; RSI = 100 * 7.26 / (7.26 + 0) = 100 -> 100.0000
- AFTER_CLOSE: Indicator atr14: true ranges (indices 2..15) sum to 30.99; ATR = 30.99 / 14 = 3099/1400 -> 2.2136
- AFTER_CLOSE: Indicator rsi_floor = const 30
- AFTER_CLOSE: Indicator weak_threshold = const 30
- AFTER_CLOSE: Indicator rsi_lag1 = rsi_simple evaluated 1 session(s) earlier = 100 -> 100.0000
- AFTER_CLOSE: Indicator rsi_lag2 = missing (INSUFFICIENT_HISTORY)
- AFTER_CLOSE: Seed clauses: at least one referenced indicator is missing, so the condition is MISSING.
- AFTER_CLOSE: Signal: condition MISSING, decision SKIPPED (NOT_SCORED_YET).
- AFTER_CLOSE: Daily record: equity = available 10000.00 + reserved 0.00 + receivables 0.00 + positions 0.00 = 10000.00.

### 2026-01-27

- AFTER_CLOSE: Indicator sma50 = missing (INSUFFICIENT_HISTORY)
- AFTER_CLOSE: Indicator vol_sma20 = missing (INSUFFICIENT_HISTORY)
- AFTER_CLOSE: Indicator rsi14: over the 14 changes (indices 3..16) gains sum 7.74, losses sum 0; RSI = 100 * 7.74 / (7.74 + 0) = 100 -> 100.0000
- AFTER_CLOSE: Indicator atr14: true ranges (indices 3..16) sum to 31.19; ATR = 31.19 / 14 = 3119/1400 -> 2.2279
- AFTER_CLOSE: Indicator rsi_floor = const 30
- AFTER_CLOSE: Indicator weak_threshold = const 30
- AFTER_CLOSE: Indicator rsi_lag1 = rsi_simple evaluated 1 session(s) earlier = 100 -> 100.0000
- AFTER_CLOSE: Indicator rsi_lag2 = rsi_simple evaluated 2 session(s) earlier = 100 -> 100.0000
- AFTER_CLOSE: Seed clauses: at least one referenced indicator is missing, so the condition is MISSING.
- AFTER_CLOSE: Signal: condition MISSING, decision SKIPPED (NOT_SCORED_YET).
- AFTER_CLOSE: Daily record: equity = available 10000.00 + reserved 0.00 + receivables 0.00 + positions 0.00 = 10000.00.

### 2026-01-30

- AFTER_CLOSE: Indicator sma50 = missing (INSUFFICIENT_HISTORY)
- AFTER_CLOSE: Indicator vol_sma20 = mean of the last 20 volume values (indices 0..19): sum 19433 / 20 = 971.65 -> 971.6500
- AFTER_CLOSE: Indicator rsi14: over the 14 changes (indices 6..19) gains sum 7.43, losses sum 0; RSI = 100 * 7.43 / (7.43 + 0) = 100 -> 100.0000
- AFTER_CLOSE: Indicator atr14: true ranges (indices 6..19) sum to 31.06; ATR = 31.06 / 14 = 1553/700 -> 2.2186
- AFTER_CLOSE: Indicator rsi_floor = const 30
- AFTER_CLOSE: Indicator weak_threshold = const 30
- AFTER_CLOSE: Indicator rsi_lag1 = rsi_simple evaluated 1 session(s) earlier = 100 -> 100.0000
- AFTER_CLOSE: Indicator rsi_lag2 = rsi_simple evaluated 2 session(s) earlier = 100 -> 100.0000
- AFTER_CLOSE: Seed clauses: at least one referenced indicator is missing, so the condition is MISSING.
- AFTER_CLOSE: Signal: condition MISSING, decision SKIPPED (NOT_SCORED_YET).
- AFTER_CLOSE: Daily record: equity = available 10000.00 + reserved 0.00 + receivables 0.00 + positions 0.00 = 10000.00.

### 2026-03-12

- AFTER_CLOSE: Indicator sma50 = missing (INSUFFICIENT_HISTORY)
- AFTER_CLOSE: Indicator vol_sma20 = mean of the last 20 volume values (indices 29..48): sum 20724 / 20 = 1036.2 -> 1036.2000
- AFTER_CLOSE: Indicator rsi14: over the 14 changes (indices 35..48) gains sum 4.95, losses sum 3.04; RSI = 100 * 4.95 / (4.95 + 3.04) = 49500/799 -> 61.9524
- AFTER_CLOSE: Indicator atr14: true ranges (indices 35..48) sum to 35.87; ATR = 35.87 / 14 = 3587/1400 -> 2.5621
- AFTER_CLOSE: Indicator rsi_floor = const 30
- AFTER_CLOSE: Indicator weak_threshold = const 30
- AFTER_CLOSE: Indicator rsi_lag1 = rsi_simple evaluated 1 session(s) earlier = 23100/383 -> 60.3133
- AFTER_CLOSE: Indicator rsi_lag2 = rsi_simple evaluated 2 session(s) earlier = 12875/178 -> 72.3315
- AFTER_CLOSE: Seed clauses: at least one referenced indicator is missing, so the condition is MISSING.
- AFTER_CLOSE: Signal: condition MISSING, decision SKIPPED (NOT_SCORED_YET).
- AFTER_CLOSE: Daily record: equity = available 10000.00 + reserved 0.00 + receivables 0.00 + positions 0.00 = 10000.00.

### 2026-03-13

- AFTER_CLOSE: Indicator sma50 = mean of the last 50 close values (indices 0..49): sum 5601.36 / 50 = 112.0272 -> 112.0272
- AFTER_CLOSE: Indicator vol_sma20 = mean of the last 20 volume values (indices 30..49): sum 20708 / 20 = 1035.4 -> 1035.4000
- AFTER_CLOSE: Indicator rsi14: over the 14 changes (indices 36..49) gains sum 4.43, losses sum 4.11; RSI = 100 * 4.43 / (4.43 + 4.11) = 22150/427 -> 51.8735
- AFTER_CLOSE: Indicator atr14: true ranges (indices 36..49) sum to 36.36; ATR = 36.36 / 14 = 909/350 -> 2.5971
- AFTER_CLOSE: Indicator rsi_floor = const 30
- AFTER_CLOSE: Indicator weak_threshold = const 30
- AFTER_CLOSE: Indicator rsi_lag1 = rsi_simple evaluated 1 session(s) earlier = 49500/799 -> 61.9524
- AFTER_CLOSE: Indicator rsi_lag2 = rsi_simple evaluated 2 session(s) earlier = 23100/383 -> 60.3133
- AFTER_CLOSE: Seed clauses (OQ-02 2.6): close 118.21 > sma50 112.0272: True; rsi_lag2 60.3133 <= 30 or rsi_lag1 61.9524 <= 30: False; rsi14 51.8735 > 30: True; volume 1116 > vol_sma20 1035.4000: True; atr14 2.5971 > 0: True; vol_sma20 1035.4000 > 0: True. Rank = 50 * (1116 / 1035.4) + (100 - 22150/427) = 7274850/71309.
- AFTER_CLOSE: Signal: condition FALSE, decision SKIPPED (NOT_SCORED_YET).
- AFTER_CLOSE: Daily record: equity = available 10000.00 + reserved 0.00 + receivables 0.00 + positions 0.00 = 10000.00.

### 2026-03-24

- AFTER_CLOSE: Indicator sma50 = mean of the last 50 close values (indices 7..56): sum 5713 / 50 = 114.26 -> 114.2600
- AFTER_CLOSE: Indicator vol_sma20 = mean of the last 20 volume values (indices 37..56): sum 20686 / 20 = 1034.3 -> 1034.3000
- AFTER_CLOSE: Indicator rsi14: over the 14 changes (indices 43..56) gains sum 2.7, losses sum 7.3; RSI = 100 * 2.7 / (2.7 + 7.3) = 27 -> 27.0000
- AFTER_CLOSE: Indicator atr14: true ranges (indices 43..56) sum to 35.49; ATR = 35.49 / 14 = 2.535 -> 2.5350
- AFTER_CLOSE: Indicator rsi_floor = const 30
- AFTER_CLOSE: Indicator weak_threshold = const 30
- AFTER_CLOSE: Indicator rsi_lag1 = rsi_simple evaluated 1 session(s) earlier = 6700/213 -> 31.4554
- AFTER_CLOSE: Indicator rsi_lag2 = rsi_simple evaluated 2 session(s) earlier = 2900/81 -> 35.8025
- AFTER_CLOSE: Seed clauses (OQ-02 2.6): close 116.64 > sma50 114.2600: True; rsi_lag2 35.8025 <= 30 or rsi_lag1 31.4554 <= 30: False; rsi14 27.0000 > 30: False; volume 965 > vol_sma20 1034.3000: False; atr14 2.5350 > 0: True; vol_sma20 1034.3000 > 0: True. Rank = 50 * (965 / 1034.3) + (100 - 27) = 1237539/10343.
- AFTER_CLOSE: Signal: condition FALSE, decision NO_ENTRY.
- AFTER_CLOSE: Daily record: equity = available 10000.00 + reserved 0.00 + receivables 0.00 + positions 0.00 = 10000.00.

### 2026-03-25

- AFTER_CLOSE: Indicator sma50 = mean of the last 50 close values (indices 8..57): sum 5726.85 / 50 = 114.537 -> 114.5370
- AFTER_CLOSE: Indicator vol_sma20 = mean of the last 20 volume values (indices 38..57): sum 20726 / 20 = 1036.3 -> 1036.3000
- AFTER_CLOSE: Indicator rsi14: over the 14 changes (indices 44..57) gains sum 3.3, losses sum 6.7; RSI = 100 * 3.3 / (3.3 + 6.7) = 33 -> 33.0000
- AFTER_CLOSE: Indicator atr14: true ranges (indices 44..57) sum to 34.94; ATR = 34.94 / 14 = 1747/700 -> 2.4957
- AFTER_CLOSE: Indicator rsi_floor = const 30
- AFTER_CLOSE: Indicator weak_threshold = const 30
- AFTER_CLOSE: Indicator rsi_lag1 = rsi_simple evaluated 1 session(s) earlier = 27 -> 27.0000
- AFTER_CLOSE: Indicator rsi_lag2 = rsi_simple evaluated 2 session(s) earlier = 6700/213 -> 31.4554
- AFTER_CLOSE: Seed clauses (OQ-02 2.6): close 117.24 > sma50 114.5370: True; rsi_lag2 31.4554 <= 30 or rsi_lag1 27.0000 <= 30: True; rsi14 33.0000 > 30: True; volume 981 > vol_sma20 1036.3000: False; atr14 2.4957 > 0: True; vol_sma20 1036.3000 > 0: True. Rank = 50 * (981 / 1036.3) + (100 - 33) = 1184821/10363.
- AFTER_CLOSE: Signal: condition FALSE, decision NO_ENTRY.
- AFTER_CLOSE: Daily record: equity = available 10000.00 + reserved 0.00 + receivables 0.00 + positions 0.00 = 10000.00.

### 2026-03-26

- AFTER_CLOSE: Indicator sma50 = mean of the last 50 close values (indices 9..58): sum 5740.71 / 50 = 114.8142 -> 114.8142
- AFTER_CLOSE: Indicator vol_sma20 = mean of the last 20 volume values (indices 39..58): sum 21940 / 20 = 1097 -> 1097.0000
- AFTER_CLOSE: Indicator rsi14: over the 14 changes (indices 45..58) gains sum 3.6, losses sum 6.4; RSI = 100 * 3.6 / (3.6 + 6.4) = 36 -> 36.0000
- AFTER_CLOSE: Indicator atr14: true ranges (indices 45..58) sum to 33.6; ATR = 33.6 / 14 = 2.4 -> 2.4000
- AFTER_CLOSE: Indicator rsi_floor = const 30
- AFTER_CLOSE: Indicator weak_threshold = const 30
- AFTER_CLOSE: Indicator rsi_lag1 = rsi_simple evaluated 1 session(s) earlier = 33 -> 33.0000
- AFTER_CLOSE: Indicator rsi_lag2 = rsi_simple evaluated 2 session(s) earlier = 27 -> 27.0000
- AFTER_CLOSE: Seed clauses (OQ-02 2.6): close 117.54 > sma50 114.8142: True; rsi_lag2 27.0000 <= 30 or rsi_lag1 33.0000 <= 30: True; rsi14 36.0000 > 30: True; volume 2300 > vol_sma20 1097.0000: True; atr14 2.4000 > 0: True; vol_sma20 1097.0000 > 0: True. Rank = 50 * (2300 / 1097) + (100 - 36) = 185208/1097.
- AFTER_CLOSE: Decision: condition TRUE, not held, vacant slots 5 - 0 - 0 = 5. cap = floor(available 10000.00 / 5) = 2000.00.
- AFTER_CLOSE: Reserve 2000.00: available -> 8000.00, reserved -> 2000.00; rank 168.8314; snapshots entry_atr=2.4.
- AFTER_CLOSE: Signal: condition TRUE, decision ENTER.
- AFTER_CLOSE: Daily record: equity = available 8000.00 + reserved 2000.00 + receivables 0.00 + positions 0.00 = 10000.00.

### 2026-03-27

- OPEN: Size intent I-2026-03-26-SYN: cap 2000.00, open 117.54, lot 1, fee(n) = ceil(1 + n * 0/10000). Largest lot multiple that fits: q=17: 1998.18 + fee 1.00 = 1999.18 <= cap 2000.00.
- OPEN: Levels from the signal-session snapshots (entry_atr=2.4): stop 112.74, target 129.54; need 0 < stop < entry 117.54 < target.
- OPEN: Release cap 2000.00 (available 10000.00), buy 17 at 117.54: notional 1998.18, fee 1.00, debit 1999.18; available -> 8000.82.
- DURING_SESSION: Touch test for T-2026-03-27-SYN: low 116.68 > stop 112.74 -> False; high 118.40 < target 129.54 -> False.
- AFTER_CLOSE: Signal: condition FALSE, decision NO_ENTRY.
- AFTER_CLOSE: Daily record: equity = available 8000.82 + reserved 0.00 + receivables 0.00 + positions 1998.18 = 9999.00.

### 2026-03-30

- DURING_SESSION: Touch test for T-2026-03-27-SYN: low 116.07 > stop 112.74 -> False; high 119.00 < target 129.54 -> False.
- AFTER_CLOSE: Signal: condition FALSE, decision NO_ENTRY.
- AFTER_CLOSE: Daily record: equity = available 8000.82 + reserved 0.00 + receivables 0.00 + positions 1998.18 = 9999.00.

### 2026-03-31

- DURING_SESSION: Touch test for T-2026-03-27-SYN: low 116.41 > stop 112.74 -> False; high 118.66 < target 129.54 -> False.
- AFTER_CLOSE: Signal: condition FALSE, decision NO_ENTRY.
- AFTER_CLOSE: Daily record: equity = available 8000.82 + reserved 0.00 + receivables 0.00 + positions 1998.18 = 9999.00.

### 2026-04-01

- DURING_SESSION: Touch test for T-2026-03-27-SYN: low 116.21 > stop 112.74 -> False; high 118.87 < target 129.54 -> False.
- AFTER_CLOSE: Signal: condition FALSE, decision NO_ENTRY.
- AFTER_CLOSE: Daily record: equity = available 8000.82 + reserved 0.00 + receivables 0.00 + positions 1998.18 = 9999.00.

### 2026-04-02

- DURING_SESSION: Touch test for T-2026-03-27-SYN: low 116.62 > stop 112.74 -> False; high 118.45 < target 129.54 -> False.
- AFTER_CLOSE: Signal: condition FALSE, decision NO_ENTRY.
- AFTER_CLOSE: Daily record: equity = available 8000.82 + reserved 0.00 + receivables 0.00 + positions 1998.18 = 9999.00.

### 2026-04-03

- DURING_SESSION: Touch test for T-2026-03-27-SYN: low 116.40 > stop 112.74 -> False; high 118.68 < target 129.54 -> False.
- AFTER_CLOSE: Signal: condition FALSE, decision NO_ENTRY.
- AFTER_CLOSE: Daily record: equity = available 8000.82 + reserved 0.00 + receivables 0.00 + positions 1998.18 = 9999.00.

### 2026-04-06

- DURING_SESSION: Touch test for T-2026-03-27-SYN: low 115.90 > stop 112.74 -> False; high 119.18 < target 129.54 -> False.
- AFTER_CLOSE: Signal: condition FALSE, decision NO_ENTRY.
- AFTER_CLOSE: Daily record: equity = available 8000.82 + reserved 0.00 + receivables 0.00 + positions 1998.18 = 9999.00.

### 2026-04-07

- DURING_SESSION: Touch test for T-2026-03-27-SYN: low 116.70 > stop 112.74 -> False; high 118.37 < target 129.54 -> False.
- AFTER_CLOSE: Signal: condition FALSE, decision NO_ENTRY.
- AFTER_CLOSE: Daily record: equity = available 8000.82 + reserved 0.00 + receivables 0.00 + positions 1998.18 = 9999.00.

### 2026-04-08

- DURING_SESSION: Touch test for T-2026-03-27-SYN: low 116.25 > stop 112.74 -> False; high 118.82 < target 129.54 -> False.
- AFTER_CLOSE: Signal: condition FALSE, decision NO_ENTRY.
- AFTER_CLOSE: Daily record: equity = available 8000.82 + reserved 0.00 + receivables 0.00 + positions 1998.18 = 9999.00.

### 2026-04-09

- DURING_SESSION: Touch test for T-2026-03-27-SYN: low 116.69 > stop 112.74 -> False; high 118.38 < target 129.54 -> False.
- AFTER_CLOSE: Signal: condition FALSE, decision NO_ENTRY.
- AFTER_CLOSE: Daily record: equity = available 8000.82 + reserved 0.00 + receivables 0.00 + positions 1998.18 = 9999.00.

### 2026-04-10

- DURING_SESSION: Touch test for T-2026-03-27-SYN: low 116.50 > stop 112.74 -> False; high 118.57 < target 129.54 -> False.
- AFTER_CLOSE: Signal: condition FALSE, decision NO_ENTRY.
- AFTER_CLOSE: Daily record: equity = available 8000.82 + reserved 0.00 + receivables 0.00 + positions 1998.18 = 9999.00.

### 2026-04-13

- DURING_SESSION: Touch test for T-2026-03-27-SYN: low 116.41 > stop 112.74 -> False; high 118.67 < target 129.54 -> False.
- AFTER_CLOSE: Signal: condition FALSE, decision NO_ENTRY.
- AFTER_CLOSE: Daily record: equity = available 8000.82 + reserved 0.00 + receivables 0.00 + positions 1998.18 = 9999.00.

### 2026-04-14

- DURING_SESSION: Touch test for T-2026-03-27-SYN: low 116.08 > stop 112.74 -> False; high 119.00 < target 129.54 -> False.
- AFTER_CLOSE: Signal: condition FALSE, decision SKIPPED (NO_NEXT_SESSION).
- AFTER_CLOSE: Daily record: equity = available 8000.82 + reserved 0.00 + receivables 0.00 + positions 1998.18 = 9999.00.
- AFTER_CLOSE: End of run: no forced liquidation; 1 open trade(s) valued at the last close.

### Journal sequence numbers

Fills and ledger lines share one counter: 0 RESERVE, 1 RELEASE, 2 BUY fill, 3 FILL_BUY.

### Outcome

The run completes. Open trades stay OPEN_AT_END and are valued at the last close.

## Hand check

- The three RSI values around the signal come from the designed window (total movement 10.00 in every window, RSI = 10 * gains):
  gains 2.70 / losses 7.30 give 27, 3.30 / 6.70 give 33, 3.60 / 6.40 give 36. The lagged values at the signal session are therefore
  RSI(t-2) = 27 and RSI(t-1) = 33, with RSI(t) = 36: weak by 27 <= 30, floor 36 > 30, a genuine upward move from the dip.
- The ATR14 window sum is tuned to 33.60 (a multiple of 14 cents), so ATR14 = 2.40. Sizing: cap = floor(10000.00 / 5) = 2000.00; the
  next open is 117.54, 2000.00 / 117.54 = 17.01, and 17 shares cost 1998.18 + 1.00 = 1999.18 <= 2000.00 while 18 shares cost 2115.72 +
  1.00. Levels: stop 117.54 - 4.80 = 112.74, target 117.54 + 12.00 = 129.54.
- Every listed indicator value was additionally recomputed with a separate integer-cents script (not oracle.py) and agrees to four
  decimals: SMA50, volume SMA20, RSI14, ATR14, RSI lag 1 and lag 2.

The oracle asserts these hand-derived values against its own output (a disagreement stops the run and is resolved by re-reading the specification, never by copying a value):

- `signals.8.indicators.2.value` = `27` (designed window: gains 2.70, losses 7.30)
- `signals.9.indicators.2.value` = `33` (gains 3.30, losses 6.70)
- `signals.10.indicators.2.value` = `36` (gains 3.60, losses 6.40)
- `signals.10.indicators.3.value` = `2.4` (ATR14 sum 33.60 / 14, tuned to a whole number of cents)
- `signals.10.decision` = `ENTER` (weak via 27 <= 30, floor 36 > 30, trend and volume hold)
- `entries.0.quantity` = `17` (2000.00 / 117.54 = 17.01; 17 * 117.54 + 1.00 = 1999.18 <= 2000.00)
- `fills.0.cash_delta` = `-1999.18` (-(17 * 117.54 + 1.00))
- `final.open_positions.0.stop` = `112.74` (117.54 - 2 * 2.40)
- `final.open_positions.0.target` = `129.54` (117.54 + 5 * 2.40)

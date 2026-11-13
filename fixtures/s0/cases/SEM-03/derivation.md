# SEM-03: Seed warm-up: first valid session of every indicator

Origin: derived by `fixtures/s0/oracle/oracle.py` from OQ-02 sections 2.1 to 2.6 and the declared policy semantics; the oracle uses exact rational arithmetic and never reads the Rust engine. Status: hand-checked (see the last section). Covers: Seed semantics.

## Design

56 sessions. Close changes repeat the period-5 pattern +0.40, -0.20, +0.10, -0.30, +0.50 and the ranges cycle 1.50, 2.00, 2.50 by index mod 3, so every window has a distinct hand-checkable value. Expected first valid indices (0-based): RSI14 and ATR14 at 14 (the 15th bar: 14 changes need 15 closes), the first lagged RSI at 15, the second at 16 (the 17th bar), the volume mean at 19 (the 20th bar), SMA50 at 49 (the 50th bar). Index 13 has no RSI14 or ATR14, index 48 has no SMA50. The scored window starts at index 50 so every listed session before it is NOT_SCORED_YET; the condition is still evaluated and reported.

## Inputs

- Strategy: `../../strategies/seed-1-rsi30-breakeven-off.json` (strategy hash `sha256:77cfdc1ca253a3d35c5ea6b8091ff58d2b1bf8346a636cae29a79ec2f927dc78`).
- Input hash binding in `input.json`: `sha256:77cfdc1ca253a3d35c5ea6b8091ff58d2b1bf8346a636cae29a79ec2f927dc78`.
- Policy: price scale 2, quantity scale 0, money scale 2, diagnostic scale 4, lot size 1; fixed fee 1.00 per fill, 0 bps, gap-exit slippage 0 bps; dividend withholding 0 bps.
- Windows: warm-up from 2026-01-05, scored from 2026-03-16, run ends after 2026-03-23; 56 calendar sessions, 56 bars; initial capital 10000.00.

Closes by session index (index: close): 0: 100, 1: 100.4, 2: 100.2, 3: 100.3, 4: 100, 5: 100.5, 6: 100.9, 7: 100.7, 8: 100.8, 9: 100.5, 10: 101, 11: 101.4, 12: 101.2, 13: 101.3, 14: 101, 15: 101.5, 16: 101.9, 17: 101.7, 18: 101.8, 19: 101.5, 20: 102, 21: 102.4, 22: 102.2, 23: 102.3, 24: 102, 25: 102.5, 26: 102.9, 27: 102.7, 28: 102.8, 29: 102.5, 30: 103, 31: 103.4, 32: 103.2, 33: 103.3, 34: 103, 35: 103.5, 36: 103.9, 37: 103.7, 38: 103.8, 39: 103.5, 40: 104, 41: 104.4, 42: 104.2, 43: 104.3, 44: 104, 45: 104.5, 46: 104.9, 47: 104.7, 48: 104.8, 49: 104.5, 50: 105, 51: 105.4, 52: 105.2, 53: 105.3, 54: 105, 55: 105.5.

Volumes by session index: 0: 1000, 1: 1010, 2: 1020, 3: 1030, 4: 1040, 5: 1050, 6: 1060, 7: 1000, 8: 1010, 9: 1020, 10: 1030, 11: 1040, 12: 1050, 13: 1060, 14: 1000, 15: 1010, 16: 1020, 17: 1030, 18: 1040, 19: 1050, 20: 1060, 21: 1000, 22: 1010, 23: 1020, 24: 1030, 25: 1040, 26: 1050, 27: 1060, 28: 1000, 29: 1010, 30: 1020, 31: 1030, 32: 1040, 33: 1050, 34: 1060, 35: 1000, 36: 1010, 37: 1020, 38: 1030, 39: 1040, 40: 1050, 41: 1060, 42: 1000, 43: 1010, 44: 1020, 45: 1030, 46: 1040, 47: 1050, 48: 1060, 49: 1000, 50: 1010, 51: 1020, 52: 1030, 53: 1040, 54: 1050, 55: 1060.

Session index to date: index 0 is 2026-01-05, index 55 is 2026-03-23.

## Step-by-step derivation

### 2026-01-22

- AFTER_CLOSE: Indicator sma50 = missing (INSUFFICIENT_HISTORY)
- AFTER_CLOSE: Indicator vol_sma20 = missing (INSUFFICIENT_HISTORY)
- AFTER_CLOSE: Indicator rsi14 = missing (INSUFFICIENT_HISTORY)
- AFTER_CLOSE: Indicator atr14 = missing (INSUFFICIENT_HISTORY)
- AFTER_CLOSE: Indicator rsi_floor = const 30
- AFTER_CLOSE: Indicator weak_threshold = const 30
- AFTER_CLOSE: Indicator rsi_lag1 = missing (INSUFFICIENT_HISTORY)
- AFTER_CLOSE: Indicator rsi_lag2 = missing (INSUFFICIENT_HISTORY)
- AFTER_CLOSE: Seed clauses: at least one referenced indicator is missing, so the condition is MISSING.
- AFTER_CLOSE: Signal: condition MISSING, decision SKIPPED (NOT_SCORED_YET).
- AFTER_CLOSE: Daily record: equity = available 10000.00 + reserved 0.00 + receivables 0.00 + positions 0.00 = 10000.00.

### 2026-01-23

- AFTER_CLOSE: Indicator sma50 = missing (INSUFFICIENT_HISTORY)
- AFTER_CLOSE: Indicator vol_sma20 = missing (INSUFFICIENT_HISTORY)
- AFTER_CLOSE: Indicator rsi14: over the 14 changes (indices 1..14) gains sum 2.5, losses sum 1.5; RSI = 100 * 2.5 / (2.5 + 1.5) = 62.5 -> 62.5000
- AFTER_CLOSE: Indicator atr14: true ranges (indices 1..14) sum to 28.5; ATR = 28.5 / 14 = 57/28 -> 2.0357
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
- AFTER_CLOSE: Indicator rsi14: over the 14 changes (indices 2..15) gains sum 2.6, losses sum 1.5; RSI = 100 * 2.6 / (2.6 + 1.5) = 2600/41 -> 63.4146
- AFTER_CLOSE: Indicator atr14: true ranges (indices 2..15) sum to 28; ATR = 28 / 14 = 2 -> 2.0000
- AFTER_CLOSE: Indicator rsi_floor = const 30
- AFTER_CLOSE: Indicator weak_threshold = const 30
- AFTER_CLOSE: Indicator rsi_lag1 = rsi_simple evaluated 1 session(s) earlier = 62.5 -> 62.5000
- AFTER_CLOSE: Indicator rsi_lag2 = missing (INSUFFICIENT_HISTORY)
- AFTER_CLOSE: Seed clauses: at least one referenced indicator is missing, so the condition is MISSING.
- AFTER_CLOSE: Signal: condition MISSING, decision SKIPPED (NOT_SCORED_YET).
- AFTER_CLOSE: Daily record: equity = available 10000.00 + reserved 0.00 + receivables 0.00 + positions 0.00 = 10000.00.

### 2026-01-27

- AFTER_CLOSE: Indicator sma50 = missing (INSUFFICIENT_HISTORY)
- AFTER_CLOSE: Indicator vol_sma20 = missing (INSUFFICIENT_HISTORY)
- AFTER_CLOSE: Indicator rsi14: over the 14 changes (indices 3..16) gains sum 3, losses sum 1.3; RSI = 100 * 3 / (3 + 1.3) = 3000/43 -> 69.7674
- AFTER_CLOSE: Indicator atr14: true ranges (indices 3..16) sum to 27.5; ATR = 27.5 / 14 = 55/28 -> 1.9643
- AFTER_CLOSE: Indicator rsi_floor = const 30
- AFTER_CLOSE: Indicator weak_threshold = const 30
- AFTER_CLOSE: Indicator rsi_lag1 = rsi_simple evaluated 1 session(s) earlier = 2600/41 -> 63.4146
- AFTER_CLOSE: Indicator rsi_lag2 = rsi_simple evaluated 2 session(s) earlier = 62.5 -> 62.5000
- AFTER_CLOSE: Seed clauses: at least one referenced indicator is missing, so the condition is MISSING.
- AFTER_CLOSE: Signal: condition MISSING, decision SKIPPED (NOT_SCORED_YET).
- AFTER_CLOSE: Daily record: equity = available 10000.00 + reserved 0.00 + receivables 0.00 + positions 0.00 = 10000.00.

### 2026-01-30

- AFTER_CLOSE: Indicator sma50 = missing (INSUFFICIENT_HISTORY)
- AFTER_CLOSE: Indicator vol_sma20 = mean of the last 20 volume values (indices 0..19): sum 20570 / 20 = 1028.5 -> 1028.5000
- AFTER_CLOSE: Indicator rsi14: over the 14 changes (indices 6..19) gains sum 2.5, losses sum 1.5; RSI = 100 * 2.5 / (2.5 + 1.5) = 62.5 -> 62.5000
- AFTER_CLOSE: Indicator atr14: true ranges (indices 6..19) sum to 27.5; ATR = 27.5 / 14 = 55/28 -> 1.9643
- AFTER_CLOSE: Indicator rsi_floor = const 30
- AFTER_CLOSE: Indicator weak_threshold = const 30
- AFTER_CLOSE: Indicator rsi_lag1 = rsi_simple evaluated 1 session(s) earlier = 500/7 -> 71.4286
- AFTER_CLOSE: Indicator rsi_lag2 = rsi_simple evaluated 2 session(s) earlier = 725/11 -> 65.9091
- AFTER_CLOSE: Seed clauses: at least one referenced indicator is missing, so the condition is MISSING.
- AFTER_CLOSE: Signal: condition MISSING, decision SKIPPED (NOT_SCORED_YET).
- AFTER_CLOSE: Daily record: equity = available 10000.00 + reserved 0.00 + receivables 0.00 + positions 0.00 = 10000.00.

### 2026-03-12

- AFTER_CLOSE: Indicator sma50 = missing (INSUFFICIENT_HISTORY)
- AFTER_CLOSE: Indicator vol_sma20 = mean of the last 20 volume values (indices 29..48): sum 20630 / 20 = 1031.5 -> 1031.5000
- AFTER_CLOSE: Indicator rsi14: over the 14 changes (indices 35..48) gains sum 3, losses sum 1.2; RSI = 100 * 3 / (3 + 1.2) = 500/7 -> 71.4286
- AFTER_CLOSE: Indicator atr14: true ranges (indices 35..48) sum to 28; ATR = 28 / 14 = 2 -> 2.0000
- AFTER_CLOSE: Indicator rsi_floor = const 30
- AFTER_CLOSE: Indicator weak_threshold = const 30
- AFTER_CLOSE: Indicator rsi_lag1 = rsi_simple evaluated 1 session(s) earlier = 725/11 -> 65.9091
- AFTER_CLOSE: Indicator rsi_lag2 = rsi_simple evaluated 2 session(s) earlier = 3000/43 -> 69.7674
- AFTER_CLOSE: Seed clauses: at least one referenced indicator is missing, so the condition is MISSING.
- AFTER_CLOSE: Signal: condition MISSING, decision SKIPPED (NOT_SCORED_YET).
- AFTER_CLOSE: Daily record: equity = available 10000.00 + reserved 0.00 + receivables 0.00 + positions 0.00 = 10000.00.

### 2026-03-13

- AFTER_CLOSE: Indicator sma50 = mean of the last 50 close values (indices 0..49): sum 5121.5 / 50 = 102.43 -> 102.4300
- AFTER_CLOSE: Indicator vol_sma20 = mean of the last 20 volume values (indices 30..49): sum 20620 / 20 = 1031 -> 1031.0000
- AFTER_CLOSE: Indicator rsi14: over the 14 changes (indices 36..49) gains sum 2.5, losses sum 1.5; RSI = 100 * 2.5 / (2.5 + 1.5) = 62.5 -> 62.5000
- AFTER_CLOSE: Indicator atr14: true ranges (indices 36..49) sum to 27.5; ATR = 27.5 / 14 = 55/28 -> 1.9643
- AFTER_CLOSE: Indicator rsi_floor = const 30
- AFTER_CLOSE: Indicator weak_threshold = const 30
- AFTER_CLOSE: Indicator rsi_lag1 = rsi_simple evaluated 1 session(s) earlier = 500/7 -> 71.4286
- AFTER_CLOSE: Indicator rsi_lag2 = rsi_simple evaluated 2 session(s) earlier = 725/11 -> 65.9091
- AFTER_CLOSE: Seed clauses (OQ-02 2.6): close 104.5 > sma50 102.4300: True; rsi_lag2 65.9091 <= 30 or rsi_lag1 71.4286 <= 30: False; rsi14 62.5000 > 30: True; volume 1000 > vol_sma20 1031.0000: False; atr14 1.9643 > 0: True; vol_sma20 1031.0000 > 0: True. Rank = 50 * (1000 / 1031) + (100 - 62.5) = 177325/2062.
- AFTER_CLOSE: Signal: condition FALSE, decision SKIPPED (NOT_SCORED_YET).
- AFTER_CLOSE: Daily record: equity = available 10000.00 + reserved 0.00 + receivables 0.00 + positions 0.00 = 10000.00.

### 2026-03-23

- AFTER_CLOSE: Signal: condition FALSE, decision SKIPPED (NO_NEXT_SESSION).
- AFTER_CLOSE: Daily record: equity = available 10000.00 + reserved 0.00 + receivables 0.00 + positions 0.00 = 10000.00.
- AFTER_CLOSE: End of run: no forced liquidation; 0 open trade(s) valued at the last close.

### Outcome

The run completes. Open trades stay OPEN_AT_END and are valued at the last close.

## Hand check

The close changes repeat +0.40, -0.20, +0.10, -0.30, +0.50 (period 5, sum +0.50). The range of bar j is 1.50, 2.00, 2.50 for
j mod 3 = 0, 1, 2; every bar opens at the previous close and moves less than its range, so TR(j) = range(j).

- RSI14 at index 14 uses changes c1..c14 = (+.4 -.2 +.1 -.3 +.5) twice then +.4 -.2 +.1 -.3: gains 2 * 1.0 + 0.5 = 2.50,
  losses 2 * 0.5 + 0.5 = 1.50. RSI = 100 * 2.50 / 4.00 = 62.5. At index 13 only 13 changes exist: INSUFFICIENT_HISTORY.
- ATR14 at index 14 averages TR(1..14): j mod 3 = 1 (j = 1, 4, 7, 10, 13) gives five 2.00 = 10.0, j mod 3 = 2 (2, 5, 8, 11, 14)
  five 2.50 = 12.5, j mod 3 = 0 (3, 6, 9, 12) four 1.50 = 6.0. Sum 28.5, ATR = 28.5 / 14 = 2.035714... -> 2.0357.
- RSI14 at index 15 drops c1 (+0.40) and adds c15 = +0.50: gains 2.60, losses 1.50, RSI = 100 * 2.6 / 4.1 = 63.4146. The lagged
  values: lag1 at index 15 = RSI at 14 = 62.5 (first valid lag1; at index 14 it is INSUFFICIENT_HISTORY), lag2 at index 16 =
  RSI at 14 = 62.5 (first valid lag2, the 17th bar; at index 15 it is INSUFFICIENT_HISTORY).
- Volume j = 1000 + 10 * (j mod 7). Indices 0..19 hold two full cycles (sum of j mod 7 = 21 each) plus j mod 7 = 0..5 (sum 15):
  20 * 1000 + 10 * 57 = 20570; mean 1028.5 at index 19 (the 20th bar); index 18 has only 19 values.
- Closes: for j = 5k + r, close = 100 + 0.5k + p(r) with p = 0, .4, .2, .3, 0. Indices 0..49 sum to 10 * 5 * 100 + 2.5 * (0 + 1 + ...
  + 9) + 10 * 0.9 = 5000 + 112.5 + 9 = 5121.5, SMA50 = 5121.5 / 50 = 102.43 at index 49 (the 50th bar); index 48 has 49 closes.

The oracle asserts these hand-derived values against its own output (a disagreement stops the run and is resolved by re-reading the specification, never by copying a value):

- `signals.1.indicators.2.missing_reason` = `INSUFFICIENT_HISTORY` (index 13 has only 13 changes)
- `signals.1.indicators.3.missing_reason` = `INSUFFICIENT_HISTORY` (index 13 has only 13 true ranges)
- `signals.2.indicators.2.value` = `62.5` (RSI14 at index 14: gains 2.50, losses 1.50)
- `signals.2.indicators.3.value` = `2.0357` (ATR14 at index 14: 28.5 / 14)
- `signals.2.indicators.6.missing_reason` = `INSUFFICIENT_HISTORY` (lag 1 needs index 13's RSI)
- `signals.3.indicators.2.value` = `63.4146` (RSI14 at index 15: gains 2.60, losses 1.50)
- `signals.3.indicators.6.value` = `62.5` (lag 1 at index 15 is RSI14 at index 14)
- `signals.3.indicators.7.missing_reason` = `INSUFFICIENT_HISTORY` (lag 2 at index 15 needs index 13)
- `signals.4.indicators.7.value` = `62.5` (lag 2 at index 16 is RSI14 at index 14)
- `signals.6.indicators.1.missing_reason` = `INSUFFICIENT_HISTORY` (volume mean at index 18 has 19 values)
- `signals.7.indicators.1.value` = `1028.5` (20570 / 20 at index 19)
- `signals.10.indicators.0.missing_reason` = `INSUFFICIENT_HISTORY` (SMA50 at index 48 has 49 closes)
- `signals.11.indicators.0.value` = `102.43` (5121.5 / 50 at index 49)

# DEF-02-v1: Definition execution with a gap through the scheduled stop (threshold 30, break-even off)

Origin: derived by `fixtures/s0/oracle/oracle.py` from OQ-02 sections 2.1 to 2.6 and the declared policy semantics; the oracle uses exact rational arithmetic and never reads the Rust engine. Status: hand-checked (see the last section). Covers: Definition execution, Entry and exit phases.

## Design

64 sessions; signal data as ENT-02 (RSI 31, 31, 31), so only the threshold 32 variants (2 and 4) enter, at the index 57 open at 116.20 (ATR 2.00: stop 112.20, target 126.20, break-even trigger high >= 118.20). Index 58 triggers break-even (high 118.70) for variant 4. Index 59 opens at 115.20, below the scheduled stop 116.20 (now active) but above the original stop 112.20: variant 4 exits at the open as GAP_STOP with 50 bps adverse slippage, floor(115.20 * 0.995) = 114.62; variant 2 keeps the position and its original stop 112.20 is touched at index 61 (low 111.70): STOP fill at 112.20. Variants 1 and 3 never enter. This case runs variant v1 (threshold 30, break-even off): does not enter.

## Inputs

- Strategy: `../../strategies/seed-1-rsi30-breakeven-off.json` (strategy hash `sha256:77cfdc1ca253a3d35c5ea6b8091ff58d2b1bf8346a636cae29a79ec2f927dc78`).
- Input hash binding in `input.json`: `sha256:77cfdc1ca253a3d35c5ea6b8091ff58d2b1bf8346a636cae29a79ec2f927dc78`.
- Policy: price scale 2, quantity scale 0, money scale 2, diagnostic scale 4, lot size 1; fixed fee 1.00 per fill, 0 bps, gap-exit slippage 50 bps; dividend withholding 0 bps.
- Windows: warm-up from 2026-01-05, scored from 2026-03-16, run ends after 2026-04-02; 64 calendar sessions, 64 bars; initial capital 10000.00.

Closes by session index (index: close): 0: 100, 1: 100.5, 2: 101, 3: 101.5, 4: 102, 5: 102.5, 6: 103, 7: 103.5, 8: 104, 9: 104.5, 10: 105, 11: 105.5, 12: 106, 13: 106.5, 14: 107, 15: 107.5, 16: 108, 17: 108.5, 18: 109, 19: 109.5, 20: 110, 21: 110.5, 22: 111, 23: 111.5, 24: 112, 25: 112.5, 26: 113, 27: 113.5, 28: 114, 29: 114.5, 30: 115, 31: 115.5, 32: 116, 33: 116.5, 34: 117, 35: 117.5, 36: 118, 37: 118.5, 38: 119, 39: 119.5, 40: 120, 41: 120, 42: 120, 43: 118.85, 44: 119.63, 45: 118.48, 46: 119.26, 47: 118.11, 48: 118.88, 49: 117.73, 50: 118.5, 51: 117.35, 52: 116.2, 53: 116.2, 54: 116.2, 55: 116.2, 56: 116.2, 57: 116.2, 58: 117.2, 59: 114.7, 60: 114.7, 61: 112.2, 62: 112.2, 63: 112.2.

Volumes by session index: 0: 1000, 1: 1000, 2: 1000, 3: 1000, 4: 1000, 5: 1000, 6: 1000, 7: 1000, 8: 1000, 9: 1000, 10: 1000, 11: 1000, 12: 1000, 13: 1000, 14: 1000, 15: 1000, 16: 1000, 17: 1000, 18: 1000, 19: 1000, 20: 1000, 21: 1000, 22: 1000, 23: 1000, 24: 1000, 25: 1000, 26: 1000, 27: 1000, 28: 1000, 29: 1000, 30: 1000, 31: 1000, 32: 1000, 33: 1000, 34: 1000, 35: 1000, 36: 1000, 37: 1000, 38: 1000, 39: 1000, 40: 1000, 41: 1000, 42: 1000, 43: 1000, 44: 1000, 45: 1000, 46: 1000, 47: 1000, 48: 1000, 49: 1000, 50: 1000, 51: 1000, 52: 1000, 53: 1000, 54: 1000, 55: 1000, 56: 6000, 57: 1000, 58: 1000, 59: 1000, 60: 1000, 61: 1000, 62: 1000, 63: 1000.

Session index to date: index 0 is 2026-01-05, index 63 is 2026-04-02.

## Step-by-step derivation

### 2026-03-25

- AFTER_CLOSE: Indicator sma50 = mean of the last 50 close values (indices 8..57): sum 5699.99 / 50 = 113.9998 -> 113.9998
- AFTER_CLOSE: Indicator vol_sma20 = mean of the last 20 volume values (indices 38..57): sum 25000 / 20 = 1250 -> 1250.0000
- AFTER_CLOSE: Indicator rsi14: over the 14 changes (indices 44..57) gains sum 3.1, losses sum 5.75; RSI = 100 * 3.1 / (3.1 + 5.75) = 6200/177 -> 35.0282
- AFTER_CLOSE: Indicator atr14: true ranges (indices 44..57) sum to 28; ATR = 28 / 14 = 2 -> 2.0000
- AFTER_CLOSE: Indicator rsi_floor = const 30
- AFTER_CLOSE: Indicator weak_threshold = const 30
- AFTER_CLOSE: Indicator rsi_lag1 = rsi_simple evaluated 1 session(s) earlier = 31 -> 31.0000
- AFTER_CLOSE: Indicator rsi_lag2 = rsi_simple evaluated 2 session(s) earlier = 31 -> 31.0000
- AFTER_CLOSE: Seed clauses (OQ-02 2.6): close 116.2 > sma50 113.9998: True; rsi_lag2 31.0000 <= 30 or rsi_lag1 31.0000 <= 30: False; rsi14 35.0282 > 30: True; volume 1000 > vol_sma20 1250.0000: False; atr14 2.0000 > 0: True; vol_sma20 1250.0000 > 0: True. Rank = 50 * (1000 / 1250) + (100 - 6200/177) = 18580/177.
- AFTER_CLOSE: Signal: condition FALSE, decision NO_ENTRY.
- AFTER_CLOSE: Daily record: equity = available 10000.00 + reserved 0.00 + receivables 0.00 + positions 0.00 = 10000.00.

### 2026-03-26

- AFTER_CLOSE: Indicator sma50 = mean of the last 50 close values (indices 9..58): sum 5713.19 / 50 = 114.2638 -> 114.2638
- AFTER_CLOSE: Indicator vol_sma20 = mean of the last 20 volume values (indices 39..58): sum 25000 / 20 = 1250 -> 1250.0000
- AFTER_CLOSE: Indicator rsi14: over the 14 changes (indices 45..58) gains sum 3.32, losses sum 5.75; RSI = 100 * 3.32 / (3.32 + 5.75) = 33200/907 -> 36.6042
- AFTER_CLOSE: Indicator atr14: true ranges (indices 45..58) sum to 29; ATR = 29 / 14 = 29/14 -> 2.0714
- AFTER_CLOSE: Indicator rsi_floor = const 30
- AFTER_CLOSE: Indicator weak_threshold = const 30
- AFTER_CLOSE: Indicator rsi_lag1 = rsi_simple evaluated 1 session(s) earlier = 6200/177 -> 35.0282
- AFTER_CLOSE: Indicator rsi_lag2 = rsi_simple evaluated 2 session(s) earlier = 31 -> 31.0000
- AFTER_CLOSE: Seed clauses (OQ-02 2.6): close 117.2 > sma50 114.2638: True; rsi_lag2 31.0000 <= 30 or rsi_lag1 35.0282 <= 30: False; rsi14 36.6042 > 30: True; volume 1000 > vol_sma20 1250.0000: False; atr14 2.0714 > 0: True; vol_sma20 1250.0000 > 0: True. Rank = 50 * (1000 / 1250) + (100 - 33200/907) = 93780/907.
- AFTER_CLOSE: Signal: condition FALSE, decision NO_ENTRY.
- AFTER_CLOSE: Daily record: equity = available 10000.00 + reserved 0.00 + receivables 0.00 + positions 0.00 = 10000.00.

### 2026-03-27

- AFTER_CLOSE: Indicator sma50 = mean of the last 50 close values (indices 10..59): sum 5723.39 / 50 = 114.4678 -> 114.4678
- AFTER_CLOSE: Indicator vol_sma20 = mean of the last 20 volume values (indices 40..59): sum 25000 / 20 = 1250 -> 1250.0000
- AFTER_CLOSE: Indicator rsi14: over the 14 changes (indices 46..59) gains sum 3.32, losses sum 7.1; RSI = 100 * 3.32 / (3.32 + 7.1) = 16600/521 -> 31.8618
- AFTER_CLOSE: Indicator atr14: true ranges (indices 46..59) sum to 30; ATR = 30 / 14 = 15/7 -> 2.1429
- AFTER_CLOSE: Indicator rsi_floor = const 30
- AFTER_CLOSE: Indicator weak_threshold = const 30
- AFTER_CLOSE: Indicator rsi_lag1 = rsi_simple evaluated 1 session(s) earlier = 33200/907 -> 36.6042
- AFTER_CLOSE: Indicator rsi_lag2 = rsi_simple evaluated 2 session(s) earlier = 6200/177 -> 35.0282
- AFTER_CLOSE: Seed clauses (OQ-02 2.6): close 114.7 > sma50 114.4678: True; rsi_lag2 35.0282 <= 30 or rsi_lag1 36.6042 <= 30: False; rsi14 31.8618 > 30: True; volume 1000 > vol_sma20 1250.0000: False; atr14 2.1429 > 0: True; vol_sma20 1250.0000 > 0: True. Rank = 50 * (1000 / 1250) + (100 - 16600/521) = 56340/521.
- AFTER_CLOSE: Signal: condition FALSE, decision NO_ENTRY.
- AFTER_CLOSE: Daily record: equity = available 10000.00 + reserved 0.00 + receivables 0.00 + positions 0.00 = 10000.00.

### 2026-03-30

- AFTER_CLOSE: Indicator sma50 = mean of the last 50 close values (indices 11..60): sum 5733.09 / 50 = 114.6618 -> 114.6618
- AFTER_CLOSE: Indicator vol_sma20 = mean of the last 20 volume values (indices 41..60): sum 25000 / 20 = 1250 -> 1250.0000
- AFTER_CLOSE: Indicator rsi14: over the 14 changes (indices 47..60) gains sum 2.54, losses sum 7.1; RSI = 100 * 2.54 / (2.54 + 7.1) = 6350/241 -> 26.3485
- AFTER_CLOSE: Indicator atr14: true ranges (indices 47..60) sum to 30; ATR = 30 / 14 = 15/7 -> 2.1429
- AFTER_CLOSE: Indicator rsi_floor = const 30
- AFTER_CLOSE: Indicator weak_threshold = const 30
- AFTER_CLOSE: Indicator rsi_lag1 = rsi_simple evaluated 1 session(s) earlier = 16600/521 -> 31.8618
- AFTER_CLOSE: Indicator rsi_lag2 = rsi_simple evaluated 2 session(s) earlier = 33200/907 -> 36.6042
- AFTER_CLOSE: Seed clauses (OQ-02 2.6): close 114.7 > sma50 114.6618: True; rsi_lag2 36.6042 <= 30 or rsi_lag1 31.8618 <= 30: False; rsi14 26.3485 > 30: False; volume 1000 > vol_sma20 1250.0000: False; atr14 2.1429 > 0: True; vol_sma20 1250.0000 > 0: True. Rank = 50 * (1000 / 1250) + (100 - 6350/241) = 27390/241.
- AFTER_CLOSE: Signal: condition FALSE, decision NO_ENTRY.
- AFTER_CLOSE: Daily record: equity = available 10000.00 + reserved 0.00 + receivables 0.00 + positions 0.00 = 10000.00.

### 2026-03-31

- AFTER_CLOSE: Indicator sma50 = mean of the last 50 close values (indices 12..61): sum 5739.79 / 50 = 114.7958 -> 114.7958
- AFTER_CLOSE: Indicator vol_sma20 = mean of the last 20 volume values (indices 42..61): sum 25000 / 20 = 1250 -> 1250.0000
- AFTER_CLOSE: Indicator rsi14: over the 14 changes (indices 48..61) gains sum 2.54, losses sum 8.45; RSI = 100 * 2.54 / (2.54 + 8.45) = 25400/1099 -> 23.1119
- AFTER_CLOSE: Indicator atr14: true ranges (indices 48..61) sum to 31.5; ATR = 31.5 / 14 = 2.25 -> 2.2500
- AFTER_CLOSE: Indicator rsi_floor = const 30
- AFTER_CLOSE: Indicator weak_threshold = const 30
- AFTER_CLOSE: Indicator rsi_lag1 = rsi_simple evaluated 1 session(s) earlier = 6350/241 -> 26.3485
- AFTER_CLOSE: Indicator rsi_lag2 = rsi_simple evaluated 2 session(s) earlier = 16600/521 -> 31.8618
- AFTER_CLOSE: Seed clauses (OQ-02 2.6): close 112.2 > sma50 114.7958: False; rsi_lag2 31.8618 <= 30 or rsi_lag1 26.3485 <= 30: True; rsi14 23.1119 > 30: False; volume 1000 > vol_sma20 1250.0000: False; atr14 2.2500 > 0: True; vol_sma20 1250.0000 > 0: True. Rank = 50 * (1000 / 1250) + (100 - 25400/1099) = 128460/1099.
- AFTER_CLOSE: Signal: condition FALSE, decision NO_ENTRY.
- AFTER_CLOSE: Daily record: equity = available 10000.00 + reserved 0.00 + receivables 0.00 + positions 0.00 = 10000.00.

### 2026-04-02

- AFTER_CLOSE: Signal: condition FALSE, decision SKIPPED (NO_NEXT_SESSION).
- AFTER_CLOSE: Daily record: equity = available 10000.00 + reserved 0.00 + receivables 0.00 + positions 0.00 = 10000.00.
- AFTER_CLOSE: End of run: no forced liquidation; 0 open trade(s) valued at the last close.

### Outcome

The run completes. Open trades stay OPEN_AT_END and are valued at the last close.

## Hand check

- Entry as ENT-02 (threshold 32 variants only): close at index 56 is 116.20, 17 shares cost 1975.40 + 1.00 = 1976.40, cash 8023.60. Stop
  112.20, target 126.20, break-even trigger high >= 118.20. Variants 1 and 3 (threshold 30) never enter: cash stays 10000.00.
- Index 58 high 118.70 >= 118.20 triggers break-even (variant 4): scheduled stop 116.20 effective index 59.
- Index 59 opens at 115.20. Variant 4: 115.20 <= 116.20 is a gap through the activated stop: price floor(115.20 * (1 - 50/10000)) =
  floor(114.624) = 114.62; proceeds 17 * 114.62 - 1.00 = 1947.54; cash 8023.60 + 1947.54 = 9971.14. Variant 2: the stop is 112.20, the
  open 115.20 is above it and the low 114.20 does not touch it; the position survives and index 61 (low 111.70 <= 112.20) fills
  STOP at 112.20: proceeds 17 * 112.20 - 1.00 = 1906.40; cash 9930.00.

The oracle asserts these hand-derived values against its own output (a disagreement stops the run and is resolved by re-reading the specification, never by copying a value):

- `final.cash_available` = `10000.00` (threshold 30 never enters (31 > 30 at both lags))

# ENT-02-v1: RSI 31, 31, 31 at t-2, t-1, t, variant v1 (threshold 30, break-even off)

Origin: derived by `fixtures/s0/oracle/oracle.py` from OQ-02 sections 2.1 to 2.6 and the declared policy semantics; the oracle uses exact rational arithmetic and never reads the Rust engine. Status: hand-checked (see the last section). Covers: Entry variants, Definition execution.

## Design

64 sessions with the designed RSI14 window 31, 31, 31 at indices 54, 55, 56 and a volume spike at index 56. Threshold 30 variants cannot enter (31 > 30 at both lags); threshold 32 variants can. This case runs variant v1 (threshold 30, break-even off). Its input differs from the sibling cases only in the strategy hash; the bars are identical. Expected at the signal session: NO_ENTRY.

## Inputs

- Strategy: `../../strategies/seed-1-rsi30-breakeven-off.json` (strategy hash `sha256:77cfdc1ca253a3d35c5ea6b8091ff58d2b1bf8346a636cae29a79ec2f927dc78`).
- Input hash binding in `input.json`: `sha256:77cfdc1ca253a3d35c5ea6b8091ff58d2b1bf8346a636cae29a79ec2f927dc78`.
- Policy: price scale 2, quantity scale 0, money scale 2, diagnostic scale 4, lot size 1; fixed fee 1.00 per fill, 0 bps, gap-exit slippage 0 bps; dividend withholding 0 bps.
- Windows: warm-up from 2026-01-05, scored from 2026-03-16, run ends after 2026-04-02; 64 calendar sessions, 64 bars; initial capital 10000.00.

Closes by session index (index: close): 0: 100, 1: 100.5, 2: 101, 3: 101.5, 4: 102, 5: 102.5, 6: 103, 7: 103.5, 8: 104, 9: 104.5, 10: 105, 11: 105.5, 12: 106, 13: 106.5, 14: 107, 15: 107.5, 16: 108, 17: 108.5, 18: 109, 19: 109.5, 20: 110, 21: 110.5, 22: 111, 23: 111.5, 24: 112, 25: 112.5, 26: 113, 27: 113.5, 28: 114, 29: 114.5, 30: 115, 31: 115.5, 32: 116, 33: 116.5, 34: 117, 35: 117.5, 36: 118, 37: 118.5, 38: 119, 39: 119.5, 40: 120, 41: 120, 42: 120, 43: 118.85, 44: 119.63, 45: 118.48, 46: 119.26, 47: 118.11, 48: 118.88, 49: 117.73, 50: 118.5, 51: 117.35, 52: 116.2, 53: 116.2, 54: 116.2, 55: 116.2, 56: 116.2, 57: 116.2, 58: 116.2, 59: 116.2, 60: 116.2, 61: 116.2, 62: 116.2, 63: 116.2.

Volumes by session index: 0: 1000, 1: 1000, 2: 1000, 3: 1000, 4: 1000, 5: 1000, 6: 1000, 7: 1000, 8: 1000, 9: 1000, 10: 1000, 11: 1000, 12: 1000, 13: 1000, 14: 1000, 15: 1000, 16: 1000, 17: 1000, 18: 1000, 19: 1000, 20: 1000, 21: 1000, 22: 1000, 23: 1000, 24: 1000, 25: 1000, 26: 1000, 27: 1000, 28: 1000, 29: 1000, 30: 1000, 31: 1000, 32: 1000, 33: 1000, 34: 1000, 35: 1000, 36: 1000, 37: 1000, 38: 1000, 39: 1000, 40: 1000, 41: 1000, 42: 1000, 43: 1000, 44: 1000, 45: 1000, 46: 1000, 47: 1000, 48: 1000, 49: 1000, 50: 1000, 51: 1000, 52: 1000, 53: 1000, 54: 1000, 55: 1000, 56: 6000, 57: 1000, 58: 1000, 59: 1000, 60: 1000, 61: 1000, 62: 1000, 63: 1000.

Session index to date: index 0 is 2026-01-05, index 63 is 2026-04-02.

## Step-by-step derivation

### 2026-03-20

- AFTER_CLOSE: Indicator sma50 = mean of the last 50 close values (indices 5..54): sum 5660.39 / 50 = 113.2078 -> 113.2078
- AFTER_CLOSE: Indicator vol_sma20 = mean of the last 20 volume values (indices 35..54): sum 20000 / 20 = 1000 -> 1000.0000
- AFTER_CLOSE: Indicator rsi14: over the 14 changes (indices 41..54) gains sum 3.1, losses sum 6.9; RSI = 100 * 3.1 / (3.1 + 6.9) = 31 -> 31.0000
- AFTER_CLOSE: Indicator atr14: true ranges (indices 41..54) sum to 28; ATR = 28 / 14 = 2 -> 2.0000
- AFTER_CLOSE: Indicator rsi_floor = const 30
- AFTER_CLOSE: Indicator weak_threshold = const 30
- AFTER_CLOSE: Indicator rsi_lag1 = rsi_simple evaluated 1 session(s) earlier = 240/7 -> 34.2857
- AFTER_CLOSE: Indicator rsi_lag2 = rsi_simple evaluated 2 session(s) earlier = 410/11 -> 37.2727
- AFTER_CLOSE: Seed clauses (OQ-02 2.6): close 116.2 > sma50 113.2078: True; rsi_lag2 37.2727 <= 30 or rsi_lag1 34.2857 <= 30: False; rsi14 31.0000 > 30: True; volume 1000 > vol_sma20 1000.0000: False; atr14 2.0000 > 0: True; vol_sma20 1000.0000 > 0: True. Rank = 50 * (1000 / 1000) + (100 - 31) = 119.
- AFTER_CLOSE: Signal: condition FALSE, decision NO_ENTRY.
- AFTER_CLOSE: Daily record: equity = available 10000.00 + reserved 0.00 + receivables 0.00 + positions 0.00 = 10000.00.

### 2026-03-23

- AFTER_CLOSE: Indicator sma50 = mean of the last 50 close values (indices 6..55): sum 5674.09 / 50 = 113.4818 -> 113.4818
- AFTER_CLOSE: Indicator vol_sma20 = mean of the last 20 volume values (indices 36..55): sum 20000 / 20 = 1000 -> 1000.0000
- AFTER_CLOSE: Indicator rsi14: over the 14 changes (indices 42..55) gains sum 3.1, losses sum 6.9; RSI = 100 * 3.1 / (3.1 + 6.9) = 31 -> 31.0000
- AFTER_CLOSE: Indicator atr14: true ranges (indices 42..55) sum to 28; ATR = 28 / 14 = 2 -> 2.0000
- AFTER_CLOSE: Indicator rsi_floor = const 30
- AFTER_CLOSE: Indicator weak_threshold = const 30
- AFTER_CLOSE: Indicator rsi_lag1 = rsi_simple evaluated 1 session(s) earlier = 31 -> 31.0000
- AFTER_CLOSE: Indicator rsi_lag2 = rsi_simple evaluated 2 session(s) earlier = 240/7 -> 34.2857
- AFTER_CLOSE: Seed clauses (OQ-02 2.6): close 116.2 > sma50 113.4818: True; rsi_lag2 34.2857 <= 30 or rsi_lag1 31.0000 <= 30: False; rsi14 31.0000 > 30: True; volume 1000 > vol_sma20 1000.0000: False; atr14 2.0000 > 0: True; vol_sma20 1000.0000 > 0: True. Rank = 50 * (1000 / 1000) + (100 - 31) = 119.
- AFTER_CLOSE: Signal: condition FALSE, decision NO_ENTRY.
- AFTER_CLOSE: Daily record: equity = available 10000.00 + reserved 0.00 + receivables 0.00 + positions 0.00 = 10000.00.

### 2026-03-24

- AFTER_CLOSE: Indicator sma50 = mean of the last 50 close values (indices 7..56): sum 5687.29 / 50 = 113.7458 -> 113.7458
- AFTER_CLOSE: Indicator vol_sma20 = mean of the last 20 volume values (indices 37..56): sum 25000 / 20 = 1250 -> 1250.0000
- AFTER_CLOSE: Indicator rsi14: over the 14 changes (indices 43..56) gains sum 3.1, losses sum 6.9; RSI = 100 * 3.1 / (3.1 + 6.9) = 31 -> 31.0000
- AFTER_CLOSE: Indicator atr14: true ranges (indices 43..56) sum to 28; ATR = 28 / 14 = 2 -> 2.0000
- AFTER_CLOSE: Indicator rsi_floor = const 30
- AFTER_CLOSE: Indicator weak_threshold = const 30
- AFTER_CLOSE: Indicator rsi_lag1 = rsi_simple evaluated 1 session(s) earlier = 31 -> 31.0000
- AFTER_CLOSE: Indicator rsi_lag2 = rsi_simple evaluated 2 session(s) earlier = 31 -> 31.0000
- AFTER_CLOSE: Seed clauses (OQ-02 2.6): close 116.2 > sma50 113.7458: True; rsi_lag2 31.0000 <= 30 or rsi_lag1 31.0000 <= 30: False; rsi14 31.0000 > 30: True; volume 6000 > vol_sma20 1250.0000: True; atr14 2.0000 > 0: True; vol_sma20 1250.0000 > 0: True. Rank = 50 * (6000 / 1250) + (100 - 31) = 309.
- AFTER_CLOSE: Signal: condition FALSE, decision NO_ENTRY.
- AFTER_CLOSE: Daily record: equity = available 10000.00 + reserved 0.00 + receivables 0.00 + positions 0.00 = 10000.00.

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

### 2026-04-02

- AFTER_CLOSE: Signal: condition FALSE, decision SKIPPED (NO_NEXT_SESSION).
- AFTER_CLOSE: Daily record: equity = available 10000.00 + reserved 0.00 + receivables 0.00 + positions 0.00 = 10000.00.
- AFTER_CLOSE: End of run: no forced liquidation; 0 open trade(s) valued at the last close.

### Outcome

The run completes. Open trades stay OPEN_AT_END and are valued at the last close.

## Hand check

Window arithmetic, by hand. The 16 designed changes c41..c56 are 0, 0, then the 12 fillers -1.15, +0.78, -1.15, +0.78,
-1.15, +0.77, -1.15, +0.77, -1.15, -1.15, 0, 0, then 0, 0. Every window of 14 changes ending at index 54, 55 or 56
holds gains 3.10 and losses 6.90: RSI = 100 * 3.10 / 10.00 = 31 at all three sessions (31, 31, 31).

- Threshold 30 (variants 1 and 3): RSI(t-2) = 31 > 30 and RSI(t-1) = 31 > 30, so weakness fails: NO_ENTRY.
- Threshold 32 (variants 2 and 4): 31 <= 32 holds, the floor 31 > 30 holds, the trend and volume clauses are the
  same as in ENT-01: ENTER with rank 309 at the next open.
- Close at t: the changes sum to -3.80 (3.10 - 6.90), so the close is 120.00 - 3.80 = 116.20 and the entry price is
  116.20. Cap 2000.00: 17 * 116.20 = 1975.40, plus fee 1.00 = 1976.40 <= 2000.00; 18 shares would cost 2091.60 + 1.00.

The oracle asserts these hand-derived values against its own output (a disagreement stops the run and is resolved by re-reading the specification, never by copying a value):

- `signals.7.condition` = `FALSE` (weakness)
- `signals.7.decision` = `NO_ENTRY` (threshold decides)
- `signals.7.indicators.2.value` = `31` (RSI(t))
- `signals.7.indicators.6.value` = `31` (RSI(t-1))
- `signals.7.indicators.7.value` = `31` (RSI(t-2))

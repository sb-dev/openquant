# SEM-02: Zero and undefined seed inputs: flat, gain-only, loss-only, zero ATR, zero volume mean

Origin: derived by `fixtures/s0/oracle/oracle.py` from OQ-02 sections 2.1 to 2.6 and the declared policy semantics; the oracle uses exact rational arithmetic and never reads the Rust engine. Status: not individually hand-checked. Covers: Seed semantics.

## Design

111 sessions in five segments for seed variant 1; volumes are 1000 to index 30, 0 for indices 31 to 70 and 500 afterwards. Indices 0 to 34 rise by 0.50 per session (every RSI14 window holds gains only: RSI 100). Indices 35 to 50 are the designed RSI window 29, 31, 31 at 48, 49, 50, but the 20 volumes ending at index 50 are 0 from index 31, so the volume mean is 0 and the entry is blocked by the volume clauses alone (volume 0 is not above a mean of 0; the mean is not positive). Indices 51 to 70 repeat the last close with a 2.00 range: once 14 zero changes fill the window (index 64 onward) RSI14 is missing with UNDEFINED_FLAT while ATR14 stays 2.00. Indices 71 to 90 have open = high = low = close: from index 84 the 14 true ranges are all 0, so ATR14 is 0 (zero ATR can only occur with flat closes, so RSI14 is also UNDEFINED_FLAT there). Indices 91 to 110 fall by 0.50 per session: the RSI14 window holds losses only (RSI 0), which satisfies weakness but fails the strict current floor 30. Any missing referenced indicator makes the condition MISSING and the decision SKIPPED INDICATOR_UNAVAILABLE (OQ-02 2.6: entry requires all referenced indicator values). INSUFFICIENT_HISTORY appears at index 13 (RSI14, ATR14), 18 (volume mean) and the lagged RSI values.

## Inputs

- Strategy: `../../strategies/seed-1-rsi30-breakeven-off.json` (strategy hash `sha256:77cfdc1ca253a3d35c5ea6b8091ff58d2b1bf8346a636cae29a79ec2f927dc78`).
- Input hash binding in `input.json`: `sha256:77cfdc1ca253a3d35c5ea6b8091ff58d2b1bf8346a636cae29a79ec2f927dc78`.
- Policy: price scale 2, quantity scale 0, money scale 2, diagnostic scale 4, lot size 1; fixed fee 1.00 per fill, 0 bps, gap-exit slippage 0 bps; dividend withholding 0 bps.
- Windows: warm-up from 2026-01-05, scored from 2026-03-16, run ends after 2026-06-08; 111 calendar sessions, 111 bars; initial capital 10000.00.

Closes by session index (index: close): 0: 100, 1: 100.5, 2: 101, 3: 101.5, 4: 102, 5: 102.5, 6: 103, 7: 103.5, 8: 104, 9: 104.5, 10: 105, 11: 105.5, 12: 106, 13: 106.5, 14: 107, 15: 107.5, 16: 108, 17: 108.5, 18: 109, 19: 109.5, 20: 110, 21: 110.5, 22: 111, 23: 111.5, 24: 112, 25: 112.5, 26: 113, 27: 113.5, 28: 114, 29: 114.5, 30: 115, 31: 115.5, 32: 116, 33: 116.5, 34: 117, 35: 116.8, 36: 116.8, 37: 115.65, 38: 116.38, 39: 115.23, 40: 115.96, 41: 114.81, 42: 115.53, 43: 114.38, 44: 115.1, 45: 113.95, 46: 112.8, 47: 112.8, 48: 112.8, 49: 113, 50: 113, 51: 113, 52: 113, 53: 113, 54: 113, 55: 113, 56: 113, 57: 113, 58: 113, 59: 113, 60: 113, 61: 113, 62: 113, 63: 113, 64: 113, 65: 113, 66: 113, 67: 113, 68: 113, 69: 113, 70: 113, 71: 113, 72: 113, 73: 113, 74: 113, 75: 113, 76: 113, 77: 113, 78: 113, 79: 113, 80: 113, 81: 113, 82: 113, 83: 113, 84: 113, 85: 113, 86: 113, 87: 113, 88: 113, 89: 113, 90: 113, 91: 112.5, 92: 112, 93: 111.5, 94: 111, 95: 110.5, 96: 110, 97: 109.5, 98: 109, 99: 108.5, 100: 108, 101: 107.5, 102: 107, 103: 106.5, 104: 106, 105: 105.5, 106: 105, 107: 104.5, 108: 104, 109: 103.5, 110: 103.

Volumes by session index: 0: 1000, 1: 1000, 2: 1000, 3: 1000, 4: 1000, 5: 1000, 6: 1000, 7: 1000, 8: 1000, 9: 1000, 10: 1000, 11: 1000, 12: 1000, 13: 1000, 14: 1000, 15: 1000, 16: 1000, 17: 1000, 18: 1000, 19: 1000, 20: 1000, 21: 1000, 22: 1000, 23: 1000, 24: 1000, 25: 1000, 26: 1000, 27: 1000, 28: 1000, 29: 1000, 30: 1000, 31: 0, 32: 0, 33: 0, 34: 0, 35: 0, 36: 0, 37: 0, 38: 0, 39: 0, 40: 0, 41: 0, 42: 0, 43: 0, 44: 0, 45: 0, 46: 0, 47: 0, 48: 0, 49: 0, 50: 0, 51: 0, 52: 0, 53: 0, 54: 0, 55: 0, 56: 0, 57: 0, 58: 0, 59: 0, 60: 0, 61: 0, 62: 0, 63: 0, 64: 0, 65: 0, 66: 0, 67: 0, 68: 0, 69: 0, 70: 0, 71: 500, 72: 500, 73: 500, 74: 500, 75: 500, 76: 500, 77: 500, 78: 500, 79: 500, 80: 500, 81: 500, 82: 500, 83: 500, 84: 500, 85: 500, 86: 500, 87: 500, 88: 500, 89: 500, 90: 500, 91: 500, 92: 500, 93: 500, 94: 500, 95: 500, 96: 500, 97: 500, 98: 500, 99: 500, 100: 500, 101: 500, 102: 500, 103: 500, 104: 500, 105: 500, 106: 500, 107: 500, 108: 500, 109: 500, 110: 500.

Session index to date: index 0 is 2026-01-05, index 110 is 2026-06-08.

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
- AFTER_CLOSE: Indicator rsi14: over the 14 changes (indices 1..14) gains sum 7, losses sum 0; RSI = 100 * 7 / (7 + 0) = 100 -> 100.0000
- AFTER_CLOSE: Indicator atr14: true ranges (indices 1..14) sum to 28; ATR = 28 / 14 = 2 -> 2.0000
- AFTER_CLOSE: Indicator rsi_floor = const 30
- AFTER_CLOSE: Indicator weak_threshold = const 30
- AFTER_CLOSE: Indicator rsi_lag1 = missing (INSUFFICIENT_HISTORY)
- AFTER_CLOSE: Indicator rsi_lag2 = missing (INSUFFICIENT_HISTORY)
- AFTER_CLOSE: Seed clauses: at least one referenced indicator is missing, so the condition is MISSING.
- AFTER_CLOSE: Signal: condition MISSING, decision SKIPPED (NOT_SCORED_YET).
- AFTER_CLOSE: Daily record: equity = available 10000.00 + reserved 0.00 + receivables 0.00 + positions 0.00 = 10000.00.

### 2026-03-13

- AFTER_CLOSE: Indicator sma50 = mean of the last 50 close values (indices 0..49): sum 5519.49 / 50 = 110.3898 -> 110.3898
- AFTER_CLOSE: Indicator vol_sma20 = mean of the last 20 volume values (indices 30..49): sum 1000 / 20 = 50 -> 50.0000
- AFTER_CLOSE: Indicator rsi14: over the 14 changes (indices 36..49) gains sum 3.1, losses sum 6.9; RSI = 100 * 3.1 / (3.1 + 6.9) = 31 -> 31.0000
- AFTER_CLOSE: Indicator atr14: true ranges (indices 36..49) sum to 28; ATR = 28 / 14 = 2 -> 2.0000
- AFTER_CLOSE: Indicator rsi_floor = const 30
- AFTER_CLOSE: Indicator weak_threshold = const 30
- AFTER_CLOSE: Indicator rsi_lag1 = rsi_simple evaluated 1 session(s) earlier = 29 -> 29.0000
- AFTER_CLOSE: Indicator rsi_lag2 = rsi_simple evaluated 2 session(s) earlier = 680/21 -> 32.3810
- AFTER_CLOSE: Seed clauses (OQ-02 2.6): close 113 > sma50 110.3898: True; rsi_lag2 32.3810 <= 30 or rsi_lag1 29.0000 <= 30: True; rsi14 31.0000 > 30: True; volume 0 > vol_sma20 50.0000: False; atr14 2.0000 > 0: True; vol_sma20 50.0000 > 0: True. Rank = 50 * (0 / 50) + (100 - 31) = 69.
- AFTER_CLOSE: Signal: condition FALSE, decision SKIPPED (NOT_SCORED_YET).
- AFTER_CLOSE: Daily record: equity = available 10000.00 + reserved 0.00 + receivables 0.00 + positions 0.00 = 10000.00.

### 2026-03-16

- AFTER_CLOSE: Indicator sma50 = mean of the last 50 close values (indices 1..50): sum 5532.49 / 50 = 110.6498 -> 110.6498
- AFTER_CLOSE: Indicator vol_sma20 = mean of the last 20 volume values (indices 31..50): sum 0 / 20 = 0 -> 0.0000
- AFTER_CLOSE: Indicator rsi14: over the 14 changes (indices 37..50) gains sum 3.1, losses sum 6.9; RSI = 100 * 3.1 / (3.1 + 6.9) = 31 -> 31.0000
- AFTER_CLOSE: Indicator atr14: true ranges (indices 37..50) sum to 28; ATR = 28 / 14 = 2 -> 2.0000
- AFTER_CLOSE: Indicator rsi_floor = const 30
- AFTER_CLOSE: Indicator weak_threshold = const 30
- AFTER_CLOSE: Indicator rsi_lag1 = rsi_simple evaluated 1 session(s) earlier = 31 -> 31.0000
- AFTER_CLOSE: Indicator rsi_lag2 = rsi_simple evaluated 2 session(s) earlier = 29 -> 29.0000
- AFTER_CLOSE: Seed clauses (OQ-02 2.6): close 113 > sma50 110.6498: True; rsi_lag2 29.0000 <= 30 or rsi_lag1 31.0000 <= 30: True; rsi14 31.0000 > 30: True; volume 0 > vol_sma20 0.0000: False; atr14 2.0000 > 0: True; vol_sma20 0.0000 > 0: False.
- AFTER_CLOSE: Signal: condition FALSE, decision NO_ENTRY.
- AFTER_CLOSE: Daily record: equity = available 10000.00 + reserved 0.00 + receivables 0.00 + positions 0.00 = 10000.00.

### 2026-04-03

- AFTER_CLOSE: Indicator sma50 = mean of the last 50 close values (indices 15..64): sum 5661.99 / 50 = 113.2398 -> 113.2398
- AFTER_CLOSE: Indicator vol_sma20 = mean of the last 20 volume values (indices 45..64): sum 0 / 20 = 0 -> 0.0000
- AFTER_CLOSE: Indicator rsi14 = missing (UNDEFINED_FLAT)
- AFTER_CLOSE: Indicator atr14: true ranges (indices 51..64) sum to 28; ATR = 28 / 14 = 2 -> 2.0000
- AFTER_CLOSE: Indicator rsi_floor = const 30
- AFTER_CLOSE: Indicator weak_threshold = const 30
- AFTER_CLOSE: Indicator rsi_lag1 = missing (UNDEFINED_FLAT)
- AFTER_CLOSE: Indicator rsi_lag2 = rsi_simple evaluated 2 session(s) earlier = 100 -> 100.0000
- AFTER_CLOSE: Seed clauses: at least one referenced indicator is missing, so the condition is MISSING.
- AFTER_CLOSE: Signal: condition MISSING, decision SKIPPED (INDICATOR_UNAVAILABLE).
- AFTER_CLOSE: Daily record: equity = available 10000.00 + reserved 0.00 + receivables 0.00 + positions 0.00 = 10000.00.

### 2026-05-01

- AFTER_CLOSE: Indicator sma50 = mean of the last 50 close values (indices 35..84): sum 5676.99 / 50 = 113.5398 -> 113.5398
- AFTER_CLOSE: Indicator vol_sma20 = mean of the last 20 volume values (indices 65..84): sum 7000 / 20 = 350 -> 350.0000
- AFTER_CLOSE: Indicator rsi14 = missing (UNDEFINED_FLAT)
- AFTER_CLOSE: Indicator atr14: true ranges (indices 71..84) sum to 0; ATR = 0 / 14 = 0 -> 0.0000
- AFTER_CLOSE: Indicator rsi_floor = const 30
- AFTER_CLOSE: Indicator weak_threshold = const 30
- AFTER_CLOSE: Indicator rsi_lag1 = missing (UNDEFINED_FLAT)
- AFTER_CLOSE: Indicator rsi_lag2 = missing (UNDEFINED_FLAT)
- AFTER_CLOSE: Seed clauses: at least one referenced indicator is missing, so the condition is MISSING.
- AFTER_CLOSE: Signal: condition MISSING, decision SKIPPED (INDICATOR_UNAVAILABLE).
- AFTER_CLOSE: Daily record: equity = available 10000.00 + reserved 0.00 + receivables 0.00 + positions 0.00 = 10000.00.

### 2026-05-12

- AFTER_CLOSE: Indicator sma50 = mean of the last 50 close values (indices 42..91): sum 5655.86 / 50 = 113.1172 -> 113.1172
- AFTER_CLOSE: Indicator vol_sma20 = mean of the last 20 volume values (indices 72..91): sum 10000 / 20 = 500 -> 500.0000
- AFTER_CLOSE: Indicator rsi14: over the 14 changes (indices 78..91) gains sum 0, losses sum 0.5; RSI = 100 * 0 / (0 + 0.5) = 0 -> 0.0000
- AFTER_CLOSE: Indicator atr14: true ranges (indices 78..91) sum to 2; ATR = 2 / 14 = 1/7 -> 0.1429
- AFTER_CLOSE: Indicator rsi_floor = const 30
- AFTER_CLOSE: Indicator weak_threshold = const 30
- AFTER_CLOSE: Indicator rsi_lag1 = missing (UNDEFINED_FLAT)
- AFTER_CLOSE: Indicator rsi_lag2 = missing (UNDEFINED_FLAT)
- AFTER_CLOSE: Seed clauses: at least one referenced indicator is missing, so the condition is MISSING.
- AFTER_CLOSE: Signal: condition MISSING, decision SKIPPED (INDICATOR_UNAVAILABLE).
- AFTER_CLOSE: Daily record: equity = available 10000.00 + reserved 0.00 + receivables 0.00 + positions 0.00 = 10000.00.

### 2026-06-08

- AFTER_CLOSE: Signal: condition FALSE, decision SKIPPED (NO_NEXT_SESSION).
- AFTER_CLOSE: Daily record: equity = available 10000.00 + reserved 0.00 + receivables 0.00 + positions 0.00 = 10000.00.
- AFTER_CLOSE: End of run: no forced liquidation; 0 open trade(s) valued at the last close.

### Outcome

The run completes. Open trades stay OPEN_AT_END and are valued at the last close.

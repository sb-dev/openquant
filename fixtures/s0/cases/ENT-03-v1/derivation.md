# ENT-03-v1: RSI 36, 36, 36: data-only threshold 40 variant against thresholds 30 and 32 (threshold 30, break-even off)

Origin: derived by `fixtures/s0/oracle/oracle.py` from OQ-02 sections 2.1 to 2.6 and the declared policy semantics; the oracle uses exact rational arithmetic and never reads the Rust engine. Status: not individually hand-checked. Covers: Entry variants, Definition execution.

## Design

64 sessions with the designed RSI14 window 36, 36, 36 (gains 3.60, losses 6.40 in every window) and a volume spike at index 56. Variant 5 differs from variant 1 only in the data of one constant (40 against 30) and enters; the sibling cases ENT-03-v1 and ENT-03-v2 run the same bars with thresholds 30 and 32 and do not (36 > 32). This case runs variant v1 (threshold 30, break-even off): NO_ENTRY at the signal session. No code path differs between the variants.

## Inputs

- Strategy: `../../strategies/seed-1-rsi30-breakeven-off.json` (strategy hash `sha256:77cfdc1ca253a3d35c5ea6b8091ff58d2b1bf8346a636cae29a79ec2f927dc78`).
- Input hash binding in `input.json`: `sha256:77cfdc1ca253a3d35c5ea6b8091ff58d2b1bf8346a636cae29a79ec2f927dc78`.
- Policy: price scale 2, quantity scale 0, money scale 2, diagnostic scale 4, lot size 1; fixed fee 1.00 per fill, 0 bps, gap-exit slippage 0 bps; dividend withholding 0 bps.
- Windows: warm-up from 2026-01-05, scored from 2026-03-16, run ends after 2026-04-02; 64 calendar sessions, 64 bars; initial capital 10000.00.

Closes by session index (index: close): 0: 100, 1: 100.5, 2: 101, 3: 101.5, 4: 102, 5: 102.5, 6: 103, 7: 103.5, 8: 104, 9: 104.5, 10: 105, 11: 105.5, 12: 106, 13: 106.5, 14: 107, 15: 107.5, 16: 108, 17: 108.5, 18: 109, 19: 109.5, 20: 110, 21: 110.5, 22: 111, 23: 111.5, 24: 112, 25: 112.5, 26: 113, 27: 113.5, 28: 114, 29: 114.5, 30: 115, 31: 115.5, 32: 116, 33: 116.5, 34: 117, 35: 117.5, 36: 118, 37: 118.5, 38: 119, 39: 119.5, 40: 120, 41: 120, 42: 120, 43: 118.93, 44: 119.83, 45: 118.76, 46: 119.66, 47: 118.59, 48: 119.49, 49: 118.42, 50: 119.32, 51: 118.26, 52: 117.2, 53: 117.2, 54: 117.2, 55: 117.2, 56: 117.2, 57: 117.2, 58: 117.2, 59: 117.2, 60: 117.2, 61: 117.2, 62: 117.2, 63: 117.2.

Volumes by session index: 0: 1000, 1: 1000, 2: 1000, 3: 1000, 4: 1000, 5: 1000, 6: 1000, 7: 1000, 8: 1000, 9: 1000, 10: 1000, 11: 1000, 12: 1000, 13: 1000, 14: 1000, 15: 1000, 16: 1000, 17: 1000, 18: 1000, 19: 1000, 20: 1000, 21: 1000, 22: 1000, 23: 1000, 24: 1000, 25: 1000, 26: 1000, 27: 1000, 28: 1000, 29: 1000, 30: 1000, 31: 1000, 32: 1000, 33: 1000, 34: 1000, 35: 1000, 36: 1000, 37: 1000, 38: 1000, 39: 1000, 40: 1000, 41: 1000, 42: 1000, 43: 1000, 44: 1000, 45: 1000, 46: 1000, 47: 1000, 48: 1000, 49: 1000, 50: 1000, 51: 1000, 52: 1000, 53: 1000, 54: 1000, 55: 1000, 56: 6000, 57: 1000, 58: 1000, 59: 1000, 60: 1000, 61: 1000, 62: 1000, 63: 1000.

Session index to date: index 0 is 2026-01-05, index 63 is 2026-04-02.

## Step-by-step derivation

### 2026-03-24

- AFTER_CLOSE: Indicator sma50 = mean of the last 50 close values (indices 7..56): sum 5696.76 / 50 = 113.9352 -> 113.9352
- AFTER_CLOSE: Indicator vol_sma20 = mean of the last 20 volume values (indices 37..56): sum 25000 / 20 = 1250 -> 1250.0000
- AFTER_CLOSE: Indicator rsi14: over the 14 changes (indices 43..56) gains sum 3.6, losses sum 6.4; RSI = 100 * 3.6 / (3.6 + 6.4) = 36 -> 36.0000
- AFTER_CLOSE: Indicator atr14: true ranges (indices 43..56) sum to 28; ATR = 28 / 14 = 2 -> 2.0000
- AFTER_CLOSE: Indicator rsi_floor = const 30
- AFTER_CLOSE: Indicator weak_threshold = const 30
- AFTER_CLOSE: Indicator rsi_lag1 = rsi_simple evaluated 1 session(s) earlier = 36 -> 36.0000
- AFTER_CLOSE: Indicator rsi_lag2 = rsi_simple evaluated 2 session(s) earlier = 36 -> 36.0000
- AFTER_CLOSE: Seed clauses (OQ-02 2.6): close 117.2 > sma50 113.9352: True; rsi_lag2 36.0000 <= 30 or rsi_lag1 36.0000 <= 30: False; rsi14 36.0000 > 30: True; volume 6000 > vol_sma20 1250.0000: True; atr14 2.0000 > 0: True; vol_sma20 1250.0000 > 0: True. Rank = 50 * (6000 / 1250) + (100 - 36) = 304.
- AFTER_CLOSE: Signal: condition FALSE, decision NO_ENTRY.
- AFTER_CLOSE: Daily record: equity = available 10000.00 + reserved 0.00 + receivables 0.00 + positions 0.00 = 10000.00.

### 2026-04-02

- AFTER_CLOSE: Signal: condition FALSE, decision SKIPPED (NO_NEXT_SESSION).
- AFTER_CLOSE: Daily record: equity = available 10000.00 + reserved 0.00 + receivables 0.00 + positions 0.00 = 10000.00.
- AFTER_CLOSE: End of run: no forced liquidation; 0 open trade(s) valued at the last close.

### Outcome

The run completes. Open trades stay OPEN_AT_END and are valued at the last close.

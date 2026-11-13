# ENT-01-v1: RSI 29, 31, 31 at t-2, t-1, t, variant v1 (threshold 30, break-even off)

Origin: derived by `fixtures/s0/oracle/oracle.py` from OQ-02 sections 2.1 to 2.6 and the declared policy semantics; the oracle uses exact rational arithmetic and never reads the Rust engine. Status: hand-checked (see the last section). Covers: Entry variants, Definition execution.

## Design

64 sessions with the designed RSI14 window 29, 31, 31 at indices 54, 55, 56 and a volume spike at index 56 (6000 against 1000). The current RSI of 31 was already above 30 one session earlier, so there is no upward crossing at t; the entry holds because RSI(t-2) = 29 satisfies weakness for both thresholds (29 <= 30 and 29 <= 32). The position then sits quietly (every later bar stays within entry +/- 1.00), so break-even never triggers and all four variants have the same trade. This case runs variant v1 (threshold 30, break-even off). Its input differs from the sibling cases only in the strategy hash; the bars are identical. Expected at the signal session: ENTER.

## Inputs

- Strategy: `../../strategies/seed-1-rsi30-breakeven-off.json` (strategy hash `sha256:77cfdc1ca253a3d35c5ea6b8091ff58d2b1bf8346a636cae29a79ec2f927dc78`).
- Input hash binding in `input.json`: `sha256:77cfdc1ca253a3d35c5ea6b8091ff58d2b1bf8346a636cae29a79ec2f927dc78`.
- Policy: price scale 2, quantity scale 0, money scale 2, diagnostic scale 4, lot size 1; fixed fee 1.00 per fill, 0 bps, gap-exit slippage 0 bps; dividend withholding 0 bps.
- Windows: warm-up from 2026-01-05, scored from 2026-03-16, run ends after 2026-04-02; 64 calendar sessions, 64 bars; initial capital 10000.00.

Closes by session index (index: close): 0: 100, 1: 100.5, 2: 101, 3: 101.5, 4: 102, 5: 102.5, 6: 103, 7: 103.5, 8: 104, 9: 104.5, 10: 105, 11: 105.5, 12: 106, 13: 106.5, 14: 107, 15: 107.5, 16: 108, 17: 108.5, 18: 109, 19: 109.5, 20: 110, 21: 110.5, 22: 111, 23: 111.5, 24: 112, 25: 112.5, 26: 113, 27: 113.5, 28: 114, 29: 114.5, 30: 115, 31: 115.5, 32: 116, 33: 116.5, 34: 117, 35: 117.5, 36: 118, 37: 118.5, 38: 119, 39: 119.5, 40: 120, 41: 119.8, 42: 119.8, 43: 118.65, 44: 119.38, 45: 118.23, 46: 118.96, 47: 117.81, 48: 118.53, 49: 117.38, 50: 118.1, 51: 116.95, 52: 115.8, 53: 115.8, 54: 115.8, 55: 116, 56: 116, 57: 116, 58: 116, 59: 116, 60: 116, 61: 116, 62: 116, 63: 116.

Volumes by session index: 0: 1000, 1: 1000, 2: 1000, 3: 1000, 4: 1000, 5: 1000, 6: 1000, 7: 1000, 8: 1000, 9: 1000, 10: 1000, 11: 1000, 12: 1000, 13: 1000, 14: 1000, 15: 1000, 16: 1000, 17: 1000, 18: 1000, 19: 1000, 20: 1000, 21: 1000, 22: 1000, 23: 1000, 24: 1000, 25: 1000, 26: 1000, 27: 1000, 28: 1000, 29: 1000, 30: 1000, 31: 1000, 32: 1000, 33: 1000, 34: 1000, 35: 1000, 36: 1000, 37: 1000, 38: 1000, 39: 1000, 40: 1000, 41: 1000, 42: 1000, 43: 1000, 44: 1000, 45: 1000, 46: 1000, 47: 1000, 48: 1000, 49: 1000, 50: 1000, 51: 1000, 52: 1000, 53: 1000, 54: 1000, 55: 1000, 56: 6000, 57: 1000, 58: 1000, 59: 1000, 60: 1000, 61: 1000, 62: 1000, 63: 1000.

Session index to date: index 0 is 2026-01-05, index 63 is 2026-04-02.

## Step-by-step derivation

### 2026-03-20

- AFTER_CLOSE: Indicator sma50 = mean of the last 50 close values (indices 5..54): sum 5655.99 / 50 = 113.1198 -> 113.1198
- AFTER_CLOSE: Indicator vol_sma20 = mean of the last 20 volume values (indices 35..54): sum 20000 / 20 = 1000 -> 1000.0000
- AFTER_CLOSE: Indicator rsi14: over the 14 changes (indices 41..54) gains sum 2.9, losses sum 7.1; RSI = 100 * 2.9 / (2.9 + 7.1) = 29 -> 29.0000
- AFTER_CLOSE: Indicator atr14: true ranges (indices 41..54) sum to 28; ATR = 28 / 14 = 2 -> 2.0000
- AFTER_CLOSE: Indicator rsi_floor = const 30
- AFTER_CLOSE: Indicator weak_threshold = const 30
- AFTER_CLOSE: Indicator rsi_lag1 = rsi_simple evaluated 1 session(s) earlier = 680/21 -> 32.3810
- AFTER_CLOSE: Indicator rsi_lag2 = rsi_simple evaluated 2 session(s) earlier = 390/11 -> 35.4545
- AFTER_CLOSE: Seed clauses (OQ-02 2.6): close 115.8 > sma50 113.1198: True; rsi_lag2 35.4545 <= 30 or rsi_lag1 32.3810 <= 30: False; rsi14 29.0000 > 30: False; volume 1000 > vol_sma20 1000.0000: False; atr14 2.0000 > 0: True; vol_sma20 1000.0000 > 0: True. Rank = 50 * (1000 / 1000) + (100 - 29) = 121.
- AFTER_CLOSE: Signal: condition FALSE, decision NO_ENTRY.
- AFTER_CLOSE: Daily record: equity = available 10000.00 + reserved 0.00 + receivables 0.00 + positions 0.00 = 10000.00.

### 2026-03-23

- AFTER_CLOSE: Indicator sma50 = mean of the last 50 close values (indices 6..55): sum 5669.49 / 50 = 113.3898 -> 113.3898
- AFTER_CLOSE: Indicator vol_sma20 = mean of the last 20 volume values (indices 36..55): sum 20000 / 20 = 1000 -> 1000.0000
- AFTER_CLOSE: Indicator rsi14: over the 14 changes (indices 42..55) gains sum 3.1, losses sum 6.9; RSI = 100 * 3.1 / (3.1 + 6.9) = 31 -> 31.0000
- AFTER_CLOSE: Indicator atr14: true ranges (indices 42..55) sum to 28; ATR = 28 / 14 = 2 -> 2.0000
- AFTER_CLOSE: Indicator rsi_floor = const 30
- AFTER_CLOSE: Indicator weak_threshold = const 30
- AFTER_CLOSE: Indicator rsi_lag1 = rsi_simple evaluated 1 session(s) earlier = 29 -> 29.0000
- AFTER_CLOSE: Indicator rsi_lag2 = rsi_simple evaluated 2 session(s) earlier = 680/21 -> 32.3810
- AFTER_CLOSE: Seed clauses (OQ-02 2.6): close 116 > sma50 113.3898: True; rsi_lag2 32.3810 <= 30 or rsi_lag1 29.0000 <= 30: True; rsi14 31.0000 > 30: True; volume 1000 > vol_sma20 1000.0000: False; atr14 2.0000 > 0: True; vol_sma20 1000.0000 > 0: True. Rank = 50 * (1000 / 1000) + (100 - 31) = 119.
- AFTER_CLOSE: Signal: condition FALSE, decision NO_ENTRY.
- AFTER_CLOSE: Daily record: equity = available 10000.00 + reserved 0.00 + receivables 0.00 + positions 0.00 = 10000.00.

### 2026-03-24

- AFTER_CLOSE: Indicator sma50 = mean of the last 50 close values (indices 7..56): sum 5682.49 / 50 = 113.6498 -> 113.6498
- AFTER_CLOSE: Indicator vol_sma20 = mean of the last 20 volume values (indices 37..56): sum 25000 / 20 = 1250 -> 1250.0000
- AFTER_CLOSE: Indicator rsi14: over the 14 changes (indices 43..56) gains sum 3.1, losses sum 6.9; RSI = 100 * 3.1 / (3.1 + 6.9) = 31 -> 31.0000
- AFTER_CLOSE: Indicator atr14: true ranges (indices 43..56) sum to 28; ATR = 28 / 14 = 2 -> 2.0000
- AFTER_CLOSE: Indicator rsi_floor = const 30
- AFTER_CLOSE: Indicator weak_threshold = const 30
- AFTER_CLOSE: Indicator rsi_lag1 = rsi_simple evaluated 1 session(s) earlier = 31 -> 31.0000
- AFTER_CLOSE: Indicator rsi_lag2 = rsi_simple evaluated 2 session(s) earlier = 29 -> 29.0000
- AFTER_CLOSE: Seed clauses (OQ-02 2.6): close 116 > sma50 113.6498: True; rsi_lag2 29.0000 <= 30 or rsi_lag1 31.0000 <= 30: True; rsi14 31.0000 > 30: True; volume 6000 > vol_sma20 1250.0000: True; atr14 2.0000 > 0: True; vol_sma20 1250.0000 > 0: True. Rank = 50 * (6000 / 1250) + (100 - 31) = 309.
- AFTER_CLOSE: Decision: condition TRUE, not held, vacant slots 5 - 0 - 0 = 5. cap = floor(available 10000.00 / 5) = 2000.00.
- AFTER_CLOSE: Reserve 2000.00: available -> 8000.00, reserved -> 2000.00; rank 309.0000; snapshots entry_atr=2.
- AFTER_CLOSE: Signal: condition TRUE, decision ENTER.
- AFTER_CLOSE: Daily record: equity = available 8000.00 + reserved 2000.00 + receivables 0.00 + positions 0.00 = 10000.00.

### 2026-03-25

- OPEN: Size intent I-2026-03-24-SYN: cap 2000.00, open 116.00, lot 1, fee(n) = ceil(1 + n * 0/10000). Largest lot multiple that fits: q=17: 1972.00 + fee 1.00 = 1973.00 <= cap 2000.00.
- OPEN: Levels from the signal-session snapshots (entry_atr=2): stop 112, target 126; need 0 < stop < entry 116.00 < target.
- OPEN: Release cap 2000.00 (available 10000.00), buy 17 at 116.00: notional 1972.00, fee 1.00, debit 1973.00; available -> 8027.00.
- DURING_SESSION: Touch test for T-2026-03-25-SYN: low 115.00 > stop 112 -> False; high 117.00 < target 126 -> False.
- AFTER_CLOSE: Indicator sma50 = mean of the last 50 close values (indices 8..57): sum 5694.99 / 50 = 113.8998 -> 113.8998
- AFTER_CLOSE: Indicator vol_sma20 = mean of the last 20 volume values (indices 38..57): sum 25000 / 20 = 1250 -> 1250.0000
- AFTER_CLOSE: Indicator rsi14: over the 14 changes (indices 44..57) gains sum 3.1, losses sum 5.75; RSI = 100 * 3.1 / (3.1 + 5.75) = 6200/177 -> 35.0282
- AFTER_CLOSE: Indicator atr14: true ranges (indices 44..57) sum to 28; ATR = 28 / 14 = 2 -> 2.0000
- AFTER_CLOSE: Indicator rsi_floor = const 30
- AFTER_CLOSE: Indicator weak_threshold = const 30
- AFTER_CLOSE: Indicator rsi_lag1 = rsi_simple evaluated 1 session(s) earlier = 31 -> 31.0000
- AFTER_CLOSE: Indicator rsi_lag2 = rsi_simple evaluated 2 session(s) earlier = 31 -> 31.0000
- AFTER_CLOSE: Seed clauses (OQ-02 2.6): close 116 > sma50 113.8998: True; rsi_lag2 31.0000 <= 30 or rsi_lag1 31.0000 <= 30: False; rsi14 35.0282 > 30: True; volume 1000 > vol_sma20 1250.0000: False; atr14 2.0000 > 0: True; vol_sma20 1250.0000 > 0: True. Rank = 50 * (1000 / 1250) + (100 - 6200/177) = 18580/177.
- AFTER_CLOSE: Signal: condition FALSE, decision NO_ENTRY.
- AFTER_CLOSE: Daily record: equity = available 8027.00 + reserved 0.00 + receivables 0.00 + positions 1972.00 = 9999.00.

### 2026-03-26

- DURING_SESSION: Touch test for T-2026-03-25-SYN: low 115.00 > stop 112 -> False; high 117.00 < target 126 -> False.
- AFTER_CLOSE: Signal: condition FALSE, decision NO_ENTRY.
- AFTER_CLOSE: Daily record: equity = available 8027.00 + reserved 0.00 + receivables 0.00 + positions 1972.00 = 9999.00.

### 2026-03-27

- DURING_SESSION: Touch test for T-2026-03-25-SYN: low 115.00 > stop 112 -> False; high 117.00 < target 126 -> False.
- AFTER_CLOSE: Signal: condition FALSE, decision NO_ENTRY.
- AFTER_CLOSE: Daily record: equity = available 8027.00 + reserved 0.00 + receivables 0.00 + positions 1972.00 = 9999.00.

### 2026-03-30

- DURING_SESSION: Touch test for T-2026-03-25-SYN: low 115.00 > stop 112 -> False; high 117.00 < target 126 -> False.
- AFTER_CLOSE: Signal: condition FALSE, decision NO_ENTRY.
- AFTER_CLOSE: Daily record: equity = available 8027.00 + reserved 0.00 + receivables 0.00 + positions 1972.00 = 9999.00.

### 2026-03-31

- DURING_SESSION: Touch test for T-2026-03-25-SYN: low 115.00 > stop 112 -> False; high 117.00 < target 126 -> False.
- AFTER_CLOSE: Signal: condition FALSE, decision NO_ENTRY.
- AFTER_CLOSE: Daily record: equity = available 8027.00 + reserved 0.00 + receivables 0.00 + positions 1972.00 = 9999.00.

### 2026-04-01

- DURING_SESSION: Touch test for T-2026-03-25-SYN: low 115.00 > stop 112 -> False; high 117.00 < target 126 -> False.
- AFTER_CLOSE: Signal: condition FALSE, decision NO_ENTRY.
- AFTER_CLOSE: Daily record: equity = available 8027.00 + reserved 0.00 + receivables 0.00 + positions 1972.00 = 9999.00.

### 2026-04-02

- DURING_SESSION: Touch test for T-2026-03-25-SYN: low 115.00 > stop 112 -> False; high 117.00 < target 126 -> False.
- AFTER_CLOSE: Signal: condition FALSE, decision SKIPPED (NO_NEXT_SESSION).
- AFTER_CLOSE: Daily record: equity = available 8027.00 + reserved 0.00 + receivables 0.00 + positions 1972.00 = 9999.00.
- AFTER_CLOSE: End of run: no forced liquidation; 1 open trade(s) valued at the last close.

### Journal sequence numbers

Fills and ledger lines share one counter: 0 RESERVE, 1 RELEASE, 2 BUY fill, 3 FILL_BUY.

### Outcome

The run completes. Open trades stay OPEN_AT_END and are valued at the last close.

## Hand check

Window arithmetic, by hand. The closes rise by 0.50 per session to index 40 (close 120.00). The 16 designed
changes c41..c56 are, in order: -0.20, 0, then the 12 fillers -1.15, +0.73, -1.15, +0.73, -1.15, +0.72, -1.15, +0.72,
-1.15, -1.15, 0, 0, then +0.20, 0. The closes from index 41 are 119.80, 119.80, 118.65, 119.38, 118.23, 118.96,
117.81, 118.53, 117.38, 118.10, 116.95, 115.80, 115.80, 115.80, 116.00, 116.00.

- RSI14 at index 54 uses c41..c54: gains 0.73 + 0.73 + 0.72 + 0.72 = 2.90, losses 0.20 + 6 * 1.15 = 7.10. RSI = 100 *
  2.90 / (2.90 + 7.10) = 29.
- Index 55 drops c41 (loss 0.20) and adds +0.20: gains 3.10, losses 6.90, RSI = 31.
- Index 56 drops c42 (0) and adds c56 (0): RSI = 31. So RSI(t-2), RSI(t-1), RSI(t) = 29, 31, 31 and there is no
  upward crossing at t (31 was already above 30 at t-1).
- SMA50 at index 56: indices 7..40 are an arithmetic progression with 34 terms from 103.50 to 120.00, sum 34 *
  111.75 = 3799.50; indices 41..56 sum to 1882.99; total 5682.49; 5682.49 / 50 = 113.6498. Close 116.00 > 113.6498.
- vol_sma20 = (19 * 1000 + 6000) / 20 = 1250; volume 6000 > 1250. ATR14 = 2.00 because every bar has open = previous
  close and range 2.00. Rank = 50 * (6000 / 1250) + (100 - 31) = 50 * 4.8 + 69 = 309.
- Cap = floor(10000.00 / 5) = 2000.00. Entry at the next open 116.00: 17 * 116.00 = 1972.00 plus fee 1.00 = 1973.00;
  18 shares would cost 2088.00 + 1.00 > 2000.00. Levels (ATR 2): stop 112, target 126.

The oracle asserts these hand-derived values against its own output (a disagreement stops the run and is resolved by re-reading the specification, never by copying a value):

- `signals.7.decision` = `ENTER` (weak via RSI(t-2)=29<=thr, floor 31>30, volume 6000>1250)
- `signals.7.condition` = `TRUE` (no crossing at t is needed)
- `signals.7.rank` = `309` (50*4.8 + (100-31))
- `signals.7.indicators.0.value` = `113.6498` (hand sum of closes / RSI windows, see below)
- `signals.7.indicators.1.value` = `1250` (hand sum of closes / RSI windows, see below)
- `signals.7.indicators.2.value` = `31` (hand sum of closes / RSI windows, see below)
- `signals.7.indicators.3.value` = `2` (hand sum of closes / RSI windows, see below)
- `signals.7.indicators.6.value` = `31` (hand sum of closes / RSI windows, see below)
- `signals.7.indicators.7.value` = `29` (hand sum of closes / RSI windows, see below)
- `entries.0.cap` = `2000.00` (10000.00 / 5 vacant slots)
- `entries.0.quantity` = `17` (17*116 + 1.00 = 1973.00 <= 2000.00; 18*116 + 1.00 = 2089.00 > 2000.00)
- `fills.0.price` = `116.00` (close at t is the next open: 120.00 - 4.00)
- `fills.0.cash_delta` = `-1973.00` (-(17*116.00 + 1.00))

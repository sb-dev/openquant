# DEF-01-v3: Definition execution, break-even on: scheduled stop, activation and exit (threshold 30, break-even on)

Origin: derived by `fixtures/s0/oracle/oracle.py` from OQ-02 sections 2.1 to 2.6 and the declared policy semantics; the oracle uses exact rational arithmetic and never reads the Rust engine. Status: hand-checked (see the last section). Covers: Definition execution, Entry and exit phases.

## Design

64 sessions; signal data as ENT-01 (RSI 29, 31, 31, volume spike at index 56), so all four variants enter at the index 57 open at 116.00 with ATR 2.00: stop 112, target 126, break-even trigger high >= 118. The bars after the entry are explicit. Index 58 has high 118.50 (>= 118): at its close a break-even variant fires once and schedules the new stop 116 (the entry price) effective index 59 before the open; the active stop is still 112 at index 58 even though the bar's low 115.50 is below 116, so a high-triggered change is not effective in its own session. Index 59 has low 115.50 <= 116: variants with break-even exit there at the stop 116.00 (a loss of fees only); variants without it keep the position (stop 112) and reach the target 126 at index 61 (high 127). This case runs variant v3 (threshold 30, break-even on). On and off differ only through the strategy definition; the bars are identical. Variants 1 and 2 (and variants 3 and 4) give identical results because both thresholds admit this entry.

## Inputs

- Strategy: `../../strategies/seed-3-rsi30-breakeven-on.json` (strategy hash `sha256:2e917d22052a0a33251dfe88029788e590f08f4c1d3901b5b956cb4c51fc88e9`).
- Input hash binding in `input.json`: `sha256:2e917d22052a0a33251dfe88029788e590f08f4c1d3901b5b956cb4c51fc88e9`.
- Policy: price scale 2, quantity scale 0, money scale 2, diagnostic scale 4, lot size 1; fixed fee 1.00 per fill, 0 bps, gap-exit slippage 0 bps; dividend withholding 0 bps.
- Windows: warm-up from 2026-01-05, scored from 2026-03-16, run ends after 2026-04-02; 64 calendar sessions, 64 bars; initial capital 10000.00.

Closes by session index (index: close): 0: 100, 1: 100.5, 2: 101, 3: 101.5, 4: 102, 5: 102.5, 6: 103, 7: 103.5, 8: 104, 9: 104.5, 10: 105, 11: 105.5, 12: 106, 13: 106.5, 14: 107, 15: 107.5, 16: 108, 17: 108.5, 18: 109, 19: 109.5, 20: 110, 21: 110.5, 22: 111, 23: 111.5, 24: 112, 25: 112.5, 26: 113, 27: 113.5, 28: 114, 29: 114.5, 30: 115, 31: 115.5, 32: 116, 33: 116.5, 34: 117, 35: 117.5, 36: 118, 37: 118.5, 38: 119, 39: 119.5, 40: 120, 41: 119.8, 42: 119.8, 43: 118.65, 44: 119.38, 45: 118.23, 46: 118.96, 47: 117.81, 48: 118.53, 49: 117.38, 50: 118.1, 51: 116.95, 52: 115.8, 53: 115.8, 54: 115.8, 55: 116, 56: 116, 57: 116, 58: 117, 59: 116, 60: 116, 61: 125, 62: 125, 63: 125.

Volumes by session index: 0: 1000, 1: 1000, 2: 1000, 3: 1000, 4: 1000, 5: 1000, 6: 1000, 7: 1000, 8: 1000, 9: 1000, 10: 1000, 11: 1000, 12: 1000, 13: 1000, 14: 1000, 15: 1000, 16: 1000, 17: 1000, 18: 1000, 19: 1000, 20: 1000, 21: 1000, 22: 1000, 23: 1000, 24: 1000, 25: 1000, 26: 1000, 27: 1000, 28: 1000, 29: 1000, 30: 1000, 31: 1000, 32: 1000, 33: 1000, 34: 1000, 35: 1000, 36: 1000, 37: 1000, 38: 1000, 39: 1000, 40: 1000, 41: 1000, 42: 1000, 43: 1000, 44: 1000, 45: 1000, 46: 1000, 47: 1000, 48: 1000, 49: 1000, 50: 1000, 51: 1000, 52: 1000, 53: 1000, 54: 1000, 55: 1000, 56: 6000, 57: 1000, 58: 1000, 59: 1000, 60: 1000, 61: 1000, 62: 1000, 63: 1000.

Session index to date: index 0 is 2026-01-05, index 63 is 2026-04-02.

## Step-by-step derivation

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
- AFTER_CLOSE: Stop adjustment break_even for T-2026-03-25-SYN: trigger (raw high 117.00 vs entry 116 + snapshot) = False.
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

- DURING_SESSION: Touch test for T-2026-03-25-SYN: low 115.50 > stop 112 -> False; high 118.50 < target 126 -> False.
- AFTER_CLOSE: Stop adjustment break_even for T-2026-03-25-SYN: trigger (raw high 118.50 vs entry 116 + snapshot) = True.
- AFTER_CLOSE: Fired once: new stop level 116 scheduled, effective 2026-03-27 before the open; the current stop 112 stays active until then.
- AFTER_CLOSE: Indicator sma50 = mean of the last 50 close values (indices 9..58): sum 5707.99 / 50 = 114.1598 -> 114.1598
- AFTER_CLOSE: Indicator vol_sma20 = mean of the last 20 volume values (indices 39..58): sum 25000 / 20 = 1250 -> 1250.0000
- AFTER_CLOSE: Indicator rsi14: over the 14 changes (indices 45..58) gains sum 3.37, losses sum 5.75; RSI = 100 * 3.37 / (3.37 + 5.75) = 8425/228 -> 36.9518
- AFTER_CLOSE: Indicator atr14: true ranges (indices 45..58) sum to 29; ATR = 29 / 14 = 29/14 -> 2.0714
- AFTER_CLOSE: Indicator rsi_floor = const 30
- AFTER_CLOSE: Indicator weak_threshold = const 30
- AFTER_CLOSE: Indicator rsi_lag1 = rsi_simple evaluated 1 session(s) earlier = 6200/177 -> 35.0282
- AFTER_CLOSE: Indicator rsi_lag2 = rsi_simple evaluated 2 session(s) earlier = 31 -> 31.0000
- AFTER_CLOSE: Seed clauses (OQ-02 2.6): close 117 > sma50 114.1598: True; rsi_lag2 31.0000 <= 30 or rsi_lag1 35.0282 <= 30: False; rsi14 36.9518 > 30: True; volume 1000 > vol_sma20 1250.0000: False; atr14 2.0714 > 0: True; vol_sma20 1250.0000 > 0: True. Rank = 50 * (1000 / 1250) + (100 - 8425/228) = 23495/228.
- AFTER_CLOSE: Signal: condition FALSE, decision NO_ENTRY.
- AFTER_CLOSE: Daily record: equity = available 8027.00 + reserved 0.00 + receivables 0.00 + positions 1989.00 = 10016.00.

### 2026-03-27

- BEFORE_OPEN: Activate the scheduled stop of T-2026-03-25-SYN: stop 112 -> 116 (effective 2026-03-27).
- DURING_SESSION: Touch test for T-2026-03-25-SYN: low 115.50 <= stop 116 -> True; high 117.00 < target 126 -> False.
- DURING_SESSION: Sell 17 at 116.00 (STOP): notional 17 * 116.00 = 1972.00; fee = ceil(1 + 1972.00 * 0/10000) = 1.00; proceeds 1972.00 - 1.00 = 1971.00; available -> 9998.00.
- AFTER_CLOSE: Indicator sma50 = mean of the last 50 close values (indices 10..59): sum 5719.49 / 50 = 114.3898 -> 114.3898
- AFTER_CLOSE: Indicator vol_sma20 = mean of the last 20 volume values (indices 40..59): sum 25000 / 20 = 1250 -> 1250.0000
- AFTER_CLOSE: Indicator rsi14: over the 14 changes (indices 46..59) gains sum 3.37, losses sum 5.6; RSI = 100 * 3.37 / (3.37 + 5.6) = 33700/897 -> 37.5697
- AFTER_CLOSE: Indicator atr14: true ranges (indices 46..59) sum to 28.5; ATR = 28.5 / 14 = 57/28 -> 2.0357
- AFTER_CLOSE: Indicator rsi_floor = const 30
- AFTER_CLOSE: Indicator weak_threshold = const 30
- AFTER_CLOSE: Indicator rsi_lag1 = rsi_simple evaluated 1 session(s) earlier = 8425/228 -> 36.9518
- AFTER_CLOSE: Indicator rsi_lag2 = rsi_simple evaluated 2 session(s) earlier = 6200/177 -> 35.0282
- AFTER_CLOSE: Seed clauses (OQ-02 2.6): close 116 > sma50 114.3898: True; rsi_lag2 35.0282 <= 30 or rsi_lag1 36.9518 <= 30: False; rsi14 37.5697 > 30: True; volume 1000 > vol_sma20 1250.0000: False; atr14 2.0357 > 0: True; vol_sma20 1250.0000 > 0: True. Rank = 50 * (1000 / 1250) + (100 - 33700/897) = 91880/897.
- AFTER_CLOSE: Signal: condition FALSE, decision NO_ENTRY.
- AFTER_CLOSE: Daily record: equity = available 9998.00 + reserved 0.00 + receivables 0.00 + positions 0.00 = 9998.00.

### 2026-03-30

- AFTER_CLOSE: Indicator sma50 = mean of the last 50 close values (indices 11..60): sum 5730.49 / 50 = 114.6098 -> 114.6098
- AFTER_CLOSE: Indicator vol_sma20 = mean of the last 20 volume values (indices 41..60): sum 25000 / 20 = 1250 -> 1250.0000
- AFTER_CLOSE: Indicator rsi14: over the 14 changes (indices 47..60) gains sum 2.64, losses sum 5.6; RSI = 100 * 2.64 / (2.64 + 5.6) = 3300/103 -> 32.0388
- AFTER_CLOSE: Indicator atr14: true ranges (indices 47..60) sum to 28.5; ATR = 28.5 / 14 = 57/28 -> 2.0357
- AFTER_CLOSE: Indicator rsi_floor = const 30
- AFTER_CLOSE: Indicator weak_threshold = const 30
- AFTER_CLOSE: Indicator rsi_lag1 = rsi_simple evaluated 1 session(s) earlier = 33700/897 -> 37.5697
- AFTER_CLOSE: Indicator rsi_lag2 = rsi_simple evaluated 2 session(s) earlier = 8425/228 -> 36.9518
- AFTER_CLOSE: Seed clauses (OQ-02 2.6): close 116 > sma50 114.6098: True; rsi_lag2 36.9518 <= 30 or rsi_lag1 37.5697 <= 30: False; rsi14 32.0388 > 30: True; volume 1000 > vol_sma20 1250.0000: False; atr14 2.0357 > 0: True; vol_sma20 1250.0000 > 0: True. Rank = 50 * (1000 / 1250) + (100 - 3300/103) = 11120/103.
- AFTER_CLOSE: Signal: condition FALSE, decision NO_ENTRY.
- AFTER_CLOSE: Daily record: equity = available 9998.00 + reserved 0.00 + receivables 0.00 + positions 0.00 = 9998.00.

### 2026-03-31

- AFTER_CLOSE: Indicator sma50 = mean of the last 50 close values (indices 12..61): sum 5749.99 / 50 = 114.9998 -> 114.9998
- AFTER_CLOSE: Indicator vol_sma20 = mean of the last 20 volume values (indices 42..61): sum 25000 / 20 = 1250 -> 1250.0000
- AFTER_CLOSE: Indicator rsi14: over the 14 changes (indices 48..61) gains sum 11.64, losses sum 4.45; RSI = 100 * 11.64 / (11.64 + 4.45) = 116400/1609 -> 72.3431
- AFTER_CLOSE: Indicator atr14: true ranges (indices 48..61) sum to 38.5; ATR = 38.5 / 14 = 2.75 -> 2.7500
- AFTER_CLOSE: Indicator rsi_floor = const 30
- AFTER_CLOSE: Indicator weak_threshold = const 30
- AFTER_CLOSE: Indicator rsi_lag1 = rsi_simple evaluated 1 session(s) earlier = 3300/103 -> 32.0388
- AFTER_CLOSE: Indicator rsi_lag2 = rsi_simple evaluated 2 session(s) earlier = 33700/897 -> 37.5697
- AFTER_CLOSE: Seed clauses (OQ-02 2.6): close 125 > sma50 114.9998: True; rsi_lag2 37.5697 <= 30 or rsi_lag1 32.0388 <= 30: False; rsi14 72.3431 > 30: True; volume 1000 > vol_sma20 1250.0000: False; atr14 2.7500 > 0: True; vol_sma20 1250.0000 > 0: True. Rank = 50 * (1000 / 1250) + (100 - 116400/1609) = 108860/1609.
- AFTER_CLOSE: Signal: condition FALSE, decision NO_ENTRY.
- AFTER_CLOSE: Daily record: equity = available 9998.00 + reserved 0.00 + receivables 0.00 + positions 0.00 = 9998.00.

### 2026-04-02

- AFTER_CLOSE: Signal: condition FALSE, decision SKIPPED (NO_NEXT_SESSION).
- AFTER_CLOSE: Daily record: equity = available 9998.00 + reserved 0.00 + receivables 0.00 + positions 0.00 = 9998.00.
- AFTER_CLOSE: End of run: no forced liquidation; 0 open trade(s) valued at the last close.

### Journal sequence numbers

Fills and ledger lines share one counter: 0 RESERVE, 1 RELEASE, 2 BUY fill, 3 FILL_BUY, 4 SELL fill, 5 FILL_SELL.

### Outcome

The run completes. Open trades stay OPEN_AT_END and are valued at the last close.

## Hand check

- Entry as ENT-01: close at index 56 is 116.00, so the next open is 116.00; cap 2000.00; 17 shares cost 1972.00 + 1.00 = 1973.00 (cash
  8027.00). ATR 2.00: stop 112.00, target 126.00, break-even trigger high >= 116.00 + 2.00 = 118.00.
- Index 58 bar (116, 118.5, 115.5, 117): high 118.50 >= 118.00. A break-even variant fires at the close and schedules the new stop 116.00
  (the entry price), effective index 59 before the open; the daily record of index 58 shows stop 112 and the scheduled stop. The same
  bar's low 115.50 is below 116 but above 112, so nothing exits that session: a high-triggered change is not effective at once.
- Index 59 bar (116.5, 117, 115.5, 116): the activated stop 116 is touched (low 115.50 <= 116): STOP at 116.00 (open 116.50 > 116, no
  gap). Proceeds 17 * 116.00 - 1.00 = 1971.00; cash 8027.00 + 1971.00 = 9998.00 (the fixed fees are the whole loss).
- Without break-even the stop stays 112 and index 61 (high 127 >= 126) fills the TARGET at 126.00: proceeds 17 * 126.00 - 1.00 = 2141.00,
  cash 10168.00.

The oracle asserts these hand-derived values against its own output (a disagreement stops the run and is resolved by re-reading the specification, never by copying a value):

- `daily.58.positions.0.stop` = `112` (still the original stop in the trigger session)
- `daily.58.positions.0.scheduled_stop.level` = `116` (the entry price)
- `daily.58.positions.0.scheduled_stop.effective_session` = `2026-03-27` (next session)
- `fills.1.reason` = `STOP` (activated stop 116 touched by low 115.50)
- `fills.1.price` = `116.00` (stop level)
- `fills.1.session` = `2026-03-27` (index 59)
- `fills.1.cash_delta` = `1971.00` (17 * 116.00 - 1.00)
- `final.cash_available` = `9998.00` (10000.00 - 1973.00 + 1971.00)

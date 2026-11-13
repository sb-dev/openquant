# X-12: Intraday target touch at an off-grid level fills at the level floored to the price scale

Origin: derived by `fixtures/s0/oracle/oracle.py` from OQ-02 sections 2.1 to 2.6 and the declared policy semantics; the oracle uses exact rational arithmetic and never reads the Rust engine. Status: hand-checked (see the last section). Covers: Entry and exit phases, Cash and quantities.

## Design

Eight sessions. ATR3 is 67/30 at the signal, so the target is 367/6 = 61.1666... and the stop 683/15. One bar falls 0.0067 short of the target and is not a touch; the next bar touches it and the fill is the target floored to the price scale, 61.16 (a nearest or upward rounding would give 61.17).

## Inputs

- Strategy: `strategy.json` (strategy hash `sha256:09a7a828ee4bf5154f2f753649f2ea8d588ba1171e41c121b30ae95a3d667168`).
- Input hash binding in `input.json`: `sha256:09a7a828ee4bf5154f2f753649f2ea8d588ba1171e41c121b30ae95a3d667168`.
- Policy: price scale 2, quantity scale 0, money scale 2, diagnostic scale 4, lot size 1; fixed fee 1.00 per fill, 10 bps, gap-exit slippage 100 bps; dividend withholding 0 bps.
- Windows: warm-up from 2026-01-05, scored from 2026-01-08, run ends after 2026-01-14; 8 calendar sessions, 8 bars; initial capital 5000.00.

| Session | Open | High | Low | Close | Volume |
| --- | --- | --- | --- | --- | --- |
| 2026-01-05 | 50 | 51 | 49 | 50 | 1000 |
| 2026-01-06 | 50 | 51 | 49 | 50 | 1000 |
| 2026-01-07 | 50 | 51 | 49 | 50 | 1000 |
| 2026-01-08 | 50 | 51 | 49 | 50 | 1000 |
| 2026-01-09 | 50 | 52.2 | 49.5 | 51 | 1000 |
| 2026-01-12 | 50 | 51 | 49 | 50 | 1000 |
| 2026-01-13 | 50 | 61.16 | 49.5 | 60 | 1000 |
| 2026-01-14 | 60 | 61.17 | 59 | 61 | 1000 |

## Step-by-step derivation

### 2026-01-05

- AFTER_CLOSE: Signal: condition MISSING, decision SKIPPED (NOT_SCORED_YET).
- AFTER_CLOSE: Daily record: equity = available 5000.00 + reserved 0.00 + receivables 0.00 + positions 0.00 = 5000.00.

### 2026-01-06

- AFTER_CLOSE: Signal: condition MISSING, decision SKIPPED (NOT_SCORED_YET).
- AFTER_CLOSE: Daily record: equity = available 5000.00 + reserved 0.00 + receivables 0.00 + positions 0.00 = 5000.00.

### 2026-01-07

- AFTER_CLOSE: Signal: condition FALSE, decision SKIPPED (NOT_SCORED_YET).
- AFTER_CLOSE: Daily record: equity = available 5000.00 + reserved 0.00 + receivables 0.00 + positions 0.00 = 5000.00.

### 2026-01-08

- AFTER_CLOSE: Signal: condition FALSE, decision NO_ENTRY.
- AFTER_CLOSE: Daily record: equity = available 5000.00 + reserved 0.00 + receivables 0.00 + positions 0.00 = 5000.00.

### 2026-01-09

- AFTER_CLOSE: Indicator sma3 = mean of the last 3 close values (indices 2..4): sum 151 / 3 = 151/3 -> 50.3333
- AFTER_CLOSE: Indicator atr3: true ranges (indices 2..4) sum to 6.7; ATR = 6.7 / 3 = 67/30 -> 2.2333
- AFTER_CLOSE: Decision: condition TRUE, not held, vacant slots 5 - 0 - 0 = 5. cap = floor(available 5000.00 / 5) = 1000.00.
- AFTER_CLOSE: Reserve 1000.00: available -> 4000.00, reserved -> 1000.00; rank 1.0000; snapshots entry_atr=67/30.
- AFTER_CLOSE: Signal: condition TRUE, decision ENTER.
- AFTER_CLOSE: Daily record: equity = available 4000.00 + reserved 1000.00 + receivables 0.00 + positions 0.00 = 5000.00.

### 2026-01-12

- OPEN: Size intent I-2026-01-09-SYN: cap 1000.00, open 50.00, lot 1, fee(n) = ceil(1 + n * 10/10000). Largest lot multiple that fits: q=20: 1000.00 + fee 2.00 = 1002.00 > cap 1000.00; q=19: 950.00 + fee 1.95 = 951.95 <= cap 1000.00.
- OPEN: Levels from the signal-session snapshots (entry_atr=67/30): stop 683/15, target 367/6; need 0 < stop < entry 50.00 < target.
- OPEN: Release cap 1000.00 (available 5000.00), buy 19 at 50.00: notional 950.00, fee 1.95, debit 951.95; available -> 4048.05.
- DURING_SESSION: Touch test for T-2026-01-12-SYN: low 49.00 > stop 683/15 -> False; high 51.00 < target 367/6 -> False.
- AFTER_CLOSE: Signal: condition FALSE, decision NO_ENTRY.
- AFTER_CLOSE: Daily record: equity = available 4048.05 + reserved 0.00 + receivables 0.00 + positions 950.00 = 4998.05.

### 2026-01-13

- DURING_SESSION: Touch test for T-2026-01-12-SYN: low 49.50 > stop 683/15 -> False; high 61.16 < target 367/6 -> False.
- AFTER_CLOSE: Indicator sma3 = mean of the last 3 close values (indices 4..6): sum 161 / 3 = 161/3 -> 53.6667
- AFTER_CLOSE: Indicator atr3: true ranges (indices 4..6) sum to 16.36; ATR = 16.36 / 3 = 409/75 -> 5.4533
- AFTER_CLOSE: Signal: condition TRUE, decision SKIPPED (HELD).
- AFTER_CLOSE: Daily record: equity = available 4048.05 + reserved 0.00 + receivables 0.00 + positions 1140.00 = 5188.05.

### 2026-01-14

- DURING_SESSION: Touch test for T-2026-01-12-SYN: low 59.00 > stop 683/15 -> False; high 61.17 >= target 367/6 -> True.
- DURING_SESSION: Sell 19 at 61.16 (TARGET): notional 19 * 61.16 = 1162.04; fee = ceil(1 + 1162.04 * 10/10000) = 2.17; proceeds 1162.04 - 2.17 = 1159.87; available -> 5207.92.
- AFTER_CLOSE: Indicator sma3 = mean of the last 3 close values (indices 5..7): sum 171 / 3 = 57 -> 57.0000
- AFTER_CLOSE: Indicator atr3: true ranges (indices 5..7) sum to 15.83; ATR = 15.83 / 3 = 1583/300 -> 5.2767
- AFTER_CLOSE: Signal: condition TRUE, decision SKIPPED (NO_NEXT_SESSION).
- AFTER_CLOSE: Daily record: equity = available 5207.92 + reserved 0.00 + receivables 0.00 + positions 0.00 = 5207.92.
- AFTER_CLOSE: End of run: no forced liquidation; 0 open trade(s) valued at the last close.

### Journal sequence numbers

Fills and ledger lines share one counter: 0 RESERVE, 1 RELEASE, 2 BUY fill, 3 FILL_BUY, 4 SELL fill, 5 FILL_SELL.

### Outcome

The run completes. Open trades stay OPEN_AT_END and are valued at the last close.

## Hand check

- Signal at index 4 (2026-01-09): close 51 > SMA3 = (50 + 50 + 51) / 3 = 151/3. True ranges of indices 2, 3, 4: 2, 2 and
  max(52.2 - 49.5, 52.2 - 50, 50 - 49.5) = max(2.7, 2.2, 0.5) = 2.7, sum 6.7, so ATR3 = 6.7 / 3 = 67/30 = 2.2333..., which has
  no finite decimal form.
- Entry as X-01: cap floor(5000.00 / 5) = 1000.00, open 50.00, 19 shares, fee 1.95, available 4048.05.
- Levels: stop = 50 - 2 * 67/30 = 683/15 = 45.5333...; target = 50 + 5 * 67/30 = 367/6 = 61.1666... Neither is a price on the grid
  of 0.01. The expectation does not state these two levels in the daily positions (no finite decimal form); it states the fills.
- Index 6 (50, 61.16, 49.5, 60): high 61.16 < 367/6 = 61.1666..., so the target is not touched. A level rounded to the grid
  before the test (floor 61.16) would be touched here, so the exact level is what is compared.
- Index 7 (60, 61.17, 59, 61): open 60 is below the target (no gap), low 59 is above the stop, high 61.17 >= 61.1666...: TARGET.
  The fill is at the level, floored to the price scale: floor(61.1666...) = 61.16. Rounding to nearest or up would give 61.17.
  Notional 19 * 61.16 = 1162.04. Fee = ceil(1.00 + 1162.04 * 10 / 10000) = ceil(1.00 + 1.16204) = 2.17. Proceeds 1162.04 - 2.17 =
  1159.87. Available 4048.05 + 1159.87 = 5207.92. The policy's 100 bps of slippage applies to a gap through a stop only, so it
  is not applied to this intraday fill.
- Index 7 is the last session: no next open, so the close creates no entry intent.

The oracle asserts these hand-derived values against its own output (a disagreement stops the run and is resolved by re-reading the specification, never by copying a value):

- `entries.0.quantity` = `19` (950.00 + 1.95 = 951.95 <= 1000.00; 20 shares 1000.00 + 2.00 > 1000.00)
- `fills.1.session` = `2026-01-14` (index 7: the bar of index 6 stops 0.0067 short of the target)
- `fills.1.reason` = `TARGET` (high 61.17 >= 367/6)
- `fills.1.price` = `61.16` (floor(367/6) = floor(61.1666...) to the price scale 2)
- `fills.1.notional` = `1162.04` (19 * 61.16)
- `fills.1.fee` = `2.17` (ceil(1.00 + 1162.04 * 10 / 10000) = ceil(2.16204))
- `fills.1.cash_delta` = `1159.87` (1162.04 - 2.17)
- `trades.0.exit_price` = `61.16` (the exit price)
- `final.cash_available` = `5207.92` (4048.05 + 1159.87)
- `final.equity` = `5207.92` (nothing held)

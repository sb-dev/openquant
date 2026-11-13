# X-13: Gap above an off-grid target fills at the target floored to the price scale, without slippage

Origin: derived by `fixtures/s0/oracle/oracle.py` from OQ-02 sections 2.1 to 2.6 and the declared policy semantics; the oracle uses exact rational arithmetic and never reads the Rust engine. Status: hand-checked (see the last section). Covers: Entry and exit phases, Cash and quantities.

## Design

Nine sessions. ATR3 is 32/15 at the signal, so the target is 182/3 = 60.6666... The next bar opens at 63. The exit is a gap exit at the target level, floored to the price scale (60.66), before costs and without the slippage that the policy declares for gaps through a stop.

## Inputs

- Strategy: `strategy.json` (strategy hash `sha256:34e6f59a1c874b310e85c5c5086fd1e4cbd6aa108e9db2f05845c3fcb40197ac`).
- Input hash binding in `input.json`: `sha256:34e6f59a1c874b310e85c5c5086fd1e4cbd6aa108e9db2f05845c3fcb40197ac`.
- Policy: price scale 2, quantity scale 0, money scale 2, diagnostic scale 4, lot size 1; fixed fee 1.00 per fill, 10 bps, gap-exit slippage 100 bps; dividend withholding 0 bps.
- Windows: warm-up from 2026-01-05, scored from 2026-01-08, run ends after 2026-01-15; 9 calendar sessions, 9 bars; initial capital 5000.00.

| Session | Open | High | Low | Close | Volume |
| --- | --- | --- | --- | --- | --- |
| 2026-01-05 | 50 | 51 | 49 | 50 | 1000 |
| 2026-01-06 | 50 | 51 | 49 | 50 | 1000 |
| 2026-01-07 | 50 | 51 | 49 | 50 | 1000 |
| 2026-01-08 | 50 | 51 | 49 | 50 | 1000 |
| 2026-01-09 | 50 | 52 | 49.6 | 51 | 1000 |
| 2026-01-12 | 50 | 51 | 49 | 50 | 1000 |
| 2026-01-13 | 63 | 64 | 50 | 50 | 1000 |
| 2026-01-14 | 50 | 51 | 49 | 50 | 1000 |
| 2026-01-15 | 50 | 51 | 49 | 50 | 1000 |

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
- AFTER_CLOSE: Indicator atr3: true ranges (indices 2..4) sum to 6.4; ATR = 6.4 / 3 = 32/15 -> 2.1333
- AFTER_CLOSE: Decision: condition TRUE, not held, vacant slots 5 - 0 - 0 = 5. cap = floor(available 5000.00 / 5) = 1000.00.
- AFTER_CLOSE: Reserve 1000.00: available -> 4000.00, reserved -> 1000.00; rank 1.0000; snapshots entry_atr=32/15.
- AFTER_CLOSE: Signal: condition TRUE, decision ENTER.
- AFTER_CLOSE: Daily record: equity = available 4000.00 + reserved 1000.00 + receivables 0.00 + positions 0.00 = 5000.00.

### 2026-01-12

- OPEN: Size intent I-2026-01-09-SYN: cap 1000.00, open 50.00, lot 1, fee(n) = ceil(1 + n * 10/10000). Largest lot multiple that fits: q=20: 1000.00 + fee 2.00 = 1002.00 > cap 1000.00; q=19: 950.00 + fee 1.95 = 951.95 <= cap 1000.00.
- OPEN: Levels from the signal-session snapshots (entry_atr=32/15): stop 686/15, target 182/3; need 0 < stop < entry 50.00 < target.
- OPEN: Release cap 1000.00 (available 5000.00), buy 19 at 50.00: notional 950.00, fee 1.95, debit 951.95; available -> 4048.05.
- DURING_SESSION: Touch test for T-2026-01-12-SYN: low 49.00 > stop 686/15 -> False; high 51.00 < target 182/3 -> False.
- AFTER_CLOSE: Signal: condition FALSE, decision NO_ENTRY.
- AFTER_CLOSE: Daily record: equity = available 4048.05 + reserved 0.00 + receivables 0.00 + positions 950.00 = 4998.05.

### 2026-01-13

- OPEN: Gap: open 63.00 >= target 182/3. Fill at the target level 60.66, no slippage.
- OPEN: Sell 19 at 60.66 (GAP_TARGET): notional 19 * 60.66 = 1152.54; fee = ceil(1 + 1152.54 * 10/10000) = 2.16; proceeds 1152.54 - 2.16 = 1150.38; available -> 5198.43.
- AFTER_CLOSE: Signal: condition FALSE, decision NO_ENTRY.
- AFTER_CLOSE: Daily record: equity = available 5198.43 + reserved 0.00 + receivables 0.00 + positions 0.00 = 5198.43.

### 2026-01-14

- AFTER_CLOSE: Signal: condition FALSE, decision NO_ENTRY.
- AFTER_CLOSE: Daily record: equity = available 5198.43 + reserved 0.00 + receivables 0.00 + positions 0.00 = 5198.43.

### 2026-01-15

- AFTER_CLOSE: Signal: condition FALSE, decision SKIPPED (NO_NEXT_SESSION).
- AFTER_CLOSE: Daily record: equity = available 5198.43 + reserved 0.00 + receivables 0.00 + positions 0.00 = 5198.43.
- AFTER_CLOSE: End of run: no forced liquidation; 0 open trade(s) valued at the last close.

### Journal sequence numbers

Fills and ledger lines share one counter: 0 RESERVE, 1 RELEASE, 2 BUY fill, 3 FILL_BUY, 4 SELL fill, 5 FILL_SELL.

### Outcome

The run completes. Open trades stay OPEN_AT_END and are valued at the last close.

## Hand check

- Signal at index 4: close 51 > SMA3 = 151/3. True ranges of indices 2, 3, 4: 2, 2 and max(52 - 49.6, 52 - 50, 50 - 49.6) =
  max(2.4, 2.0, 0.4) = 2.4, sum 6.4, so ATR3 = 6.4 / 3 = 32/15 = 2.1333...
- Entry as X-01: 19 shares at 50.00, fee 1.95, available 4048.05.
- Levels: stop = 50 - 2 * 32/15 = 686/15 = 45.7333...; target = 50 + 5 * 32/15 = 182/3 = 60.6666...
- Index 6 opens at 63, which is above the target 182/3: gap above the target. Per OQ-02 section 2.5 the fill is at the target
  level before costs, not at the open and not with the 100 bps gap slippage of the policy. The level is not on the price grid, so it is
  floored to the price scale: floor(60.6666...) = 60.66 (rounding to nearest or up would give 60.67). Notional 19 * 60.66 = 1152.54.
  Fee = ceil(1.00 + 1152.54 * 10 / 10000) = ceil(1.00 + 1.15254) = 2.16. Proceeds 1152.54 - 2.16 = 1150.38. Available 4048.05 +
  1150.38 = 5198.43.
- The bar closes at 50 (below SMA3), so no new signal arises.

The oracle asserts these hand-derived values against its own output (a disagreement stops the run and is resolved by re-reading the specification, never by copying a value):

- `entries.0.quantity` = `19` (950.00 + 1.95 = 951.95 <= 1000.00; 20 shares 1000.00 + 2.00 > 1000.00)
- `fills.1.session` = `2026-01-13` (index 6: the open gaps above the target)
- `fills.1.reason` = `GAP_TARGET` (open 63 >= 182/3)
- `fills.1.price` = `60.66` (floor(182/3) = floor(60.6666...) to the price scale 2; not the open 63, no slippage)
- `fills.1.notional` = `1152.54` (19 * 60.66)
- `fills.1.fee` = `2.16` (ceil(1.00 + 1152.54 * 10 / 10000) = ceil(2.15254))
- `fills.1.cash_delta` = `1150.38` (1152.54 - 2.16)
- `trades.0.exit_price` = `60.66` (the exit price)
- `final.cash_available` = `5198.43` (4048.05 + 1150.38)

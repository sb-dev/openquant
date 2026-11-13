# X-14: Intraday stop touch at an off-grid level fills at the level floored to the price scale

Origin: derived by `fixtures/s0/oracle/oracle.py` from OQ-02 sections 2.1 to 2.6 and the declared policy semantics; the oracle uses exact rational arithmetic and never reads the Rust engine. Status: hand-checked (see the last section). Covers: Entry and exit phases, Cash and quantities.

## Design

Nine sessions. ATR3 is 13/6 at the signal, so the stop is 137/3 = 45.6666... and the target 365/6. One bar stays 0.0033 above the stop and is not a touch; the next bar touches it and the fill is the stop floored to the price scale, 45.66 (a nearest or upward rounding would give 45.67).

## Inputs

- Strategy: `strategy.json` (strategy hash `sha256:8a59b4d2e29568d3c684bf4e1e2f2214fa549db187829ef920474d9bb642a545`).
- Input hash binding in `input.json`: `sha256:8a59b4d2e29568d3c684bf4e1e2f2214fa549db187829ef920474d9bb642a545`.
- Policy: price scale 2, quantity scale 0, money scale 2, diagnostic scale 4, lot size 1; fixed fee 1.00 per fill, 10 bps, gap-exit slippage 100 bps; dividend withholding 0 bps.
- Windows: warm-up from 2026-01-05, scored from 2026-01-08, run ends after 2026-01-15; 9 calendar sessions, 9 bars; initial capital 5000.00.

| Session | Open | High | Low | Close | Volume |
| --- | --- | --- | --- | --- | --- |
| 2026-01-05 | 50 | 51 | 49 | 50 | 1000 |
| 2026-01-06 | 50 | 51 | 49 | 50 | 1000 |
| 2026-01-07 | 50 | 51 | 49 | 50 | 1000 |
| 2026-01-08 | 50 | 51 | 49 | 50 | 1000 |
| 2026-01-09 | 50 | 52 | 49.5 | 51 | 1000 |
| 2026-01-12 | 50 | 51 | 49 | 50 | 1000 |
| 2026-01-13 | 50 | 51 | 45.67 | 48 | 1000 |
| 2026-01-14 | 48 | 49 | 45.66 | 47 | 1000 |
| 2026-01-15 | 47 | 48 | 46 | 47 | 1000 |

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
- AFTER_CLOSE: Indicator atr3: true ranges (indices 2..4) sum to 6.5; ATR = 6.5 / 3 = 13/6 -> 2.1667
- AFTER_CLOSE: Decision: condition TRUE, not held, vacant slots 5 - 0 - 0 = 5. cap = floor(available 5000.00 / 5) = 1000.00.
- AFTER_CLOSE: Reserve 1000.00: available -> 4000.00, reserved -> 1000.00; rank 1.0000; snapshots entry_atr=13/6.
- AFTER_CLOSE: Signal: condition TRUE, decision ENTER.
- AFTER_CLOSE: Daily record: equity = available 4000.00 + reserved 1000.00 + receivables 0.00 + positions 0.00 = 5000.00.

### 2026-01-12

- OPEN: Size intent I-2026-01-09-SYN: cap 1000.00, open 50.00, lot 1, fee(n) = ceil(1 + n * 10/10000). Largest lot multiple that fits: q=20: 1000.00 + fee 2.00 = 1002.00 > cap 1000.00; q=19: 950.00 + fee 1.95 = 951.95 <= cap 1000.00.
- OPEN: Levels from the signal-session snapshots (entry_atr=13/6): stop 137/3, target 365/6; need 0 < stop < entry 50.00 < target.
- OPEN: Release cap 1000.00 (available 5000.00), buy 19 at 50.00: notional 950.00, fee 1.95, debit 951.95; available -> 4048.05.
- DURING_SESSION: Touch test for T-2026-01-12-SYN: low 49.00 > stop 137/3 -> False; high 51.00 < target 365/6 -> False.
- AFTER_CLOSE: Signal: condition FALSE, decision NO_ENTRY.
- AFTER_CLOSE: Daily record: equity = available 4048.05 + reserved 0.00 + receivables 0.00 + positions 950.00 = 4998.05.

### 2026-01-13

- DURING_SESSION: Touch test for T-2026-01-12-SYN: low 45.67 > stop 137/3 -> False; high 51.00 < target 365/6 -> False.
- AFTER_CLOSE: Signal: condition FALSE, decision NO_ENTRY.
- AFTER_CLOSE: Daily record: equity = available 4048.05 + reserved 0.00 + receivables 0.00 + positions 912.00 = 4960.05.

### 2026-01-14

- DURING_SESSION: Touch test for T-2026-01-12-SYN: low 45.66 <= stop 137/3 -> True; high 49.00 < target 365/6 -> False.
- DURING_SESSION: Sell 19 at 45.66 (STOP): notional 19 * 45.66 = 867.54; fee = ceil(1 + 867.54 * 10/10000) = 1.87; proceeds 867.54 - 1.87 = 865.67; available -> 4913.72.
- AFTER_CLOSE: Signal: condition FALSE, decision NO_ENTRY.
- AFTER_CLOSE: Daily record: equity = available 4913.72 + reserved 0.00 + receivables 0.00 + positions 0.00 = 4913.72.

### 2026-01-15

- AFTER_CLOSE: Signal: condition FALSE, decision SKIPPED (NO_NEXT_SESSION).
- AFTER_CLOSE: Daily record: equity = available 4913.72 + reserved 0.00 + receivables 0.00 + positions 0.00 = 4913.72.
- AFTER_CLOSE: End of run: no forced liquidation; 0 open trade(s) valued at the last close.

### Journal sequence numbers

Fills and ledger lines share one counter: 0 RESERVE, 1 RELEASE, 2 BUY fill, 3 FILL_BUY, 4 SELL fill, 5 FILL_SELL.

### Outcome

The run completes. Open trades stay OPEN_AT_END and are valued at the last close.

## Hand check

- Signal at index 4: close 51 > SMA3 = 151/3. True ranges of indices 2, 3, 4: 2, 2 and max(52 - 49.5, 52 - 50, 50 - 49.5) =
  max(2.5, 2.0, 0.5) = 2.5, sum 6.5, so ATR3 = 6.5 / 3 = 13/6 = 2.1666...
- Entry as X-01: 19 shares at 50.00, fee 1.95, available 4048.05.
- Levels: stop = 50 - 2 * 13/6 = 137/3 = 45.6666...; target = 50 + 5 * 13/6 = 365/6 = 60.8333...
- Index 6 (50, 51, 45.67, 48): low 45.67 > 137/3 = 45.6666..., so the stop is not touched. A level rounded to nearest before the
  test (45.67) would be touched here, so the exact level is what is compared. High 51 is far below the target.
- Index 7 (48, 49, 45.66, 47): open 48 is above the stop (no gap), low 45.66 <= 45.6666...: STOP. The fill is at the level, floored
  to the price scale: floor(45.6666...) = 45.66 (rounding to nearest or up would give 45.67). Notional 19 * 45.66 = 867.54. Fee =
  ceil(1.00 + 867.54 * 10 / 10000) = ceil(1.00 + 0.86754) = 1.87. Proceeds 867.54 - 1.87 = 865.67. Available 4048.05 + 865.67 =
  4913.72. The high 49 does not touch the target, so the bar is not ambiguous. No slippage applies to an intraday fill.
- Later closes (48, 47, 47) stay below their SMA3, so no new signal arises.

The oracle asserts these hand-derived values against its own output (a disagreement stops the run and is resolved by re-reading the specification, never by copying a value):

- `entries.0.quantity` = `19` (950.00 + 1.95 = 951.95 <= 1000.00; 20 shares 1000.00 + 2.00 > 1000.00)
- `fills.1.session` = `2026-01-14` (index 7: the bar of index 6 stops 0.0033 above the stop)
- `fills.1.reason` = `STOP` (low 45.66 <= 137/3)
- `fills.1.price` = `45.66` (floor(137/3) = floor(45.6666...) to the price scale 2)
- `fills.1.notional` = `867.54` (19 * 45.66)
- `fills.1.fee` = `1.87` (ceil(1.00 + 867.54 * 10 / 10000) = ceil(1.86754))
- `fills.1.cash_delta` = `865.67` (867.54 - 1.87)
- `trades.0.exit_price` = `45.66` (the exit price)
- `final.cash_available` = `4913.72` (4048.05 + 865.67)

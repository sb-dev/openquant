# X-05: Gap through the stop: fill at the open less slippage, not at the stop

Origin: derived by `fixtures/s0/oracle/oracle.py` from OQ-02 sections 2.1 to 2.6 and the declared policy semantics; the oracle uses exact rational arithmetic and never reads the Rust engine. Status: hand-checked (see the last section). Covers: Entry and exit phases, Cash and quantities.

## Design

Nine sessions. The held position's stop is 46; the next bar opens at 44.37. Slippage is 100 bps on gap-through-stop exits; sell prices floor to the price scale.

## Inputs

- Strategy: `strategy.json` (strategy hash `sha256:2bed2fc9380dc6969cd02a849bddd8f58b96c68169067408d4304b684de6e536`).
- Input hash binding in `input.json`: `sha256:2bed2fc9380dc6969cd02a849bddd8f58b96c68169067408d4304b684de6e536`.
- Policy: price scale 2, quantity scale 0, money scale 2, diagnostic scale 4, lot size 1; fixed fee 1.00 per fill, 10 bps, gap-exit slippage 100 bps; dividend withholding 0 bps.
- Windows: warm-up from 2026-01-05, scored from 2026-01-08, run ends after 2026-01-15; 9 calendar sessions, 9 bars; initial capital 5000.00.

| Session | Open | High | Low | Close | Volume |
| --- | --- | --- | --- | --- | --- |
| 2026-01-05 | 50 | 51 | 49 | 50 | 1000 |
| 2026-01-06 | 50 | 51 | 49 | 50 | 1000 |
| 2026-01-07 | 50 | 51 | 49 | 50 | 1000 |
| 2026-01-08 | 50 | 51 | 49 | 50 | 1000 |
| 2026-01-09 | 50 | 51.5 | 49.5 | 51 | 1000 |
| 2026-01-12 | 50 | 51 | 49 | 50 | 1000 |
| 2026-01-13 | 44.37 | 45 | 43 | 44 | 1000 |
| 2026-01-14 | 44 | 45 | 43 | 44 | 1000 |
| 2026-01-15 | 44 | 45 | 43 | 44 | 1000 |

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
- AFTER_CLOSE: Indicator atr3: true ranges (indices 2..4) sum to 6; ATR = 6 / 3 = 2 -> 2.0000
- AFTER_CLOSE: Decision: condition TRUE, not held, vacant slots 5 - 0 - 0 = 5. cap = floor(available 5000.00 / 5) = 1000.00.
- AFTER_CLOSE: Reserve 1000.00: available -> 4000.00, reserved -> 1000.00; rank 1.0000; snapshots entry_atr=2.
- AFTER_CLOSE: Signal: condition TRUE, decision ENTER.
- AFTER_CLOSE: Daily record: equity = available 4000.00 + reserved 1000.00 + receivables 0.00 + positions 0.00 = 5000.00.

### 2026-01-12

- OPEN: Size intent I-2026-01-09-SYN: cap 1000.00, open 50.00, lot 1, fee(n) = ceil(1 + n * 10/10000). Largest lot multiple that fits: q=20: 1000.00 + fee 2.00 = 1002.00 > cap 1000.00; q=19: 950.00 + fee 1.95 = 951.95 <= cap 1000.00.
- OPEN: Levels from the signal-session snapshots (entry_atr=2): stop 46, target 60; need 0 < stop < entry 50.00 < target.
- OPEN: Release cap 1000.00 (available 5000.00), buy 19 at 50.00: notional 950.00, fee 1.95, debit 951.95; available -> 4048.05.
- DURING_SESSION: Touch test for T-2026-01-12-SYN: low 49.00 > stop 46 -> False; high 51.00 < target 60 -> False.
- AFTER_CLOSE: Signal: condition FALSE, decision NO_ENTRY.
- AFTER_CLOSE: Daily record: equity = available 4048.05 + reserved 0.00 + receivables 0.00 + positions 950.00 = 4998.05.

### 2026-01-13

- OPEN: Gap: open 44.37 <= stop 46. Price = floor(44.37 * (1 - 100/10000)) = 43.92.
- OPEN: Sell 19 at 43.92 (GAP_STOP): notional 19 * 43.92 = 834.48; fee = ceil(1 + 834.48 * 10/10000) = 1.84; proceeds 834.48 - 1.84 = 832.64; available -> 4880.69.
- AFTER_CLOSE: Signal: condition FALSE, decision NO_ENTRY.
- AFTER_CLOSE: Daily record: equity = available 4880.69 + reserved 0.00 + receivables 0.00 + positions 0.00 = 4880.69.

### 2026-01-14

- AFTER_CLOSE: Signal: condition FALSE, decision NO_ENTRY.
- AFTER_CLOSE: Daily record: equity = available 4880.69 + reserved 0.00 + receivables 0.00 + positions 0.00 = 4880.69.

### 2026-01-15

- AFTER_CLOSE: Signal: condition FALSE, decision SKIPPED (NO_NEXT_SESSION).
- AFTER_CLOSE: Daily record: equity = available 4880.69 + reserved 0.00 + receivables 0.00 + positions 0.00 = 4880.69.
- AFTER_CLOSE: End of run: no forced liquidation; 0 open trade(s) valued at the last close.

### Journal sequence numbers

Fills and ledger lines share one counter: 0 RESERVE, 1 RELEASE, 2 BUY fill, 3 FILL_BUY, 4 SELL fill, 5 FILL_SELL.

### Outcome

The run completes. Open trades stay OPEN_AT_END and are valued at the last close.

## Hand check

- Entry as X-01: 19 shares at 50.00, fee 1.95, available 4048.05, stop 46, target 60.
- Index 6 opens at 44.37, below the stop 46 (open <= stop): a gap through the stop. The fill is at the opening price less
  adverse slippage, not at the stop: 44.37 * (1 - 100/10000) = 44.37 * 0.99 = 43.9263, floored to the price scale 2:
  43.92. Notional 19 * 43.92 = 834.48. Fee = ceil(1.00 + 834.48 * 10/10000) = ceil(1.00 + 0.83448) = 1.84. Proceeds
  834.48 - 1.84 = 832.64. Available 4048.05 + 832.64 = 4880.69.

The oracle asserts these hand-derived values against its own output (a disagreement stops the run and is resolved by re-reading the specification, never by copying a value):

- `fills.1.price` = `43.92` (floor(44.37 * 0.99) = floor(43.9263))
- `fills.1.reason` = `GAP_STOP` (open 44.37 <= stop 46)
- `fills.1.notional` = `834.48` (19 * 43.92)
- `fills.1.fee` = `1.84` (ceil(1.00 + 834.48 * 10 / 10000) = ceil(1.83448))
- `fills.1.cash_delta` = `832.64` (834.48 - 1.84)
- `final.cash_available` = `4880.69` (4048.05 + 832.64)
- `trades.0.exit_price` = `43.92` (the exit price)

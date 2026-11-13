# X-03: Fee rounds up: one share less when ceil pushes the total over the cap

Origin: derived by `fixtures/s0/oracle/oracle.py` from OQ-02 sections 2.1 to 2.6 and the declared policy semantics; the oracle uses exact rational arithmetic and never reads the Rust engine. Status: hand-checked (see the last section). Covers: Cash and quantities.

## Design

Eight sessions at price 49.00. The fee is rounded up to the money scale, so a total that would fit with an unrounded or nearest-rounded fee exceeds the cap by one cent and the quantity drops from 20 to 19. X-01 shows the same effect with q=20 costing 1002.00 against a cap of 1000.00; this case isolates the sub-cent ceil.

## Inputs

- Strategy: `strategy.json` (strategy hash `sha256:a2624e4b0748e0553c25c3715f3a222eee11e9a75bc950209d585a088925b311`).
- Input hash binding in `input.json`: `sha256:a2624e4b0748e0553c25c3715f3a222eee11e9a75bc950209d585a088925b311`.
- Policy: price scale 2, quantity scale 0, money scale 2, diagnostic scale 4, lot size 1; fixed fee 19.90 per fill, 0.05 bps, gap-exit slippage 0 bps; dividend withholding 0 bps.
- Windows: warm-up from 2026-01-05, scored from 2026-01-08, run ends after 2026-01-14; 8 calendar sessions, 8 bars; initial capital 4999.50.

| Session | Open | High | Low | Close | Volume |
| --- | --- | --- | --- | --- | --- |
| 2026-01-05 | 49 | 50 | 48 | 49 | 1000 |
| 2026-01-06 | 49 | 50 | 48 | 49 | 1000 |
| 2026-01-07 | 49 | 50 | 48 | 49 | 1000 |
| 2026-01-08 | 49 | 50 | 48 | 49 | 1000 |
| 2026-01-09 | 49 | 50.5 | 48.5 | 50 | 1000 |
| 2026-01-12 | 49 | 50 | 48 | 49 | 1000 |
| 2026-01-13 | 49 | 50 | 48 | 49 | 1000 |
| 2026-01-14 | 49 | 50 | 48 | 49 | 1000 |

## Step-by-step derivation

### 2026-01-05

- AFTER_CLOSE: Signal: condition MISSING, decision SKIPPED (NOT_SCORED_YET).
- AFTER_CLOSE: Daily record: equity = available 4999.50 + reserved 0.00 + receivables 0.00 + positions 0.00 = 4999.50.

### 2026-01-06

- AFTER_CLOSE: Signal: condition MISSING, decision SKIPPED (NOT_SCORED_YET).
- AFTER_CLOSE: Daily record: equity = available 4999.50 + reserved 0.00 + receivables 0.00 + positions 0.00 = 4999.50.

### 2026-01-07

- AFTER_CLOSE: Signal: condition FALSE, decision SKIPPED (NOT_SCORED_YET).
- AFTER_CLOSE: Daily record: equity = available 4999.50 + reserved 0.00 + receivables 0.00 + positions 0.00 = 4999.50.

### 2026-01-08

- AFTER_CLOSE: Signal: condition FALSE, decision NO_ENTRY.
- AFTER_CLOSE: Daily record: equity = available 4999.50 + reserved 0.00 + receivables 0.00 + positions 0.00 = 4999.50.

### 2026-01-09

- AFTER_CLOSE: Indicator sma3 = mean of the last 3 close values (indices 2..4): sum 148 / 3 = 148/3 -> 49.3333
- AFTER_CLOSE: Indicator atr3: true ranges (indices 2..4) sum to 6; ATR = 6 / 3 = 2 -> 2.0000
- AFTER_CLOSE: Decision: condition TRUE, not held, vacant slots 5 - 0 - 0 = 5. cap = floor(available 4999.50 / 5) = 999.90.
- AFTER_CLOSE: Reserve 999.90: available -> 3999.60, reserved -> 999.90; rank 1.0000; snapshots entry_atr=2.
- AFTER_CLOSE: Signal: condition TRUE, decision ENTER.
- AFTER_CLOSE: Daily record: equity = available 3999.60 + reserved 999.90 + receivables 0.00 + positions 0.00 = 4999.50.

### 2026-01-12

- OPEN: Size intent I-2026-01-09-SYN: cap 999.90, open 49.00, lot 1, fee(n) = ceil(19.9 + n * 0.05/10000). Largest lot multiple that fits: q=20: 980.00 + fee 19.91 = 999.91 > cap 999.90; q=19: 931.00 + fee 19.91 = 950.91 <= cap 999.90.
- OPEN: Levels from the signal-session snapshots (entry_atr=2): stop 45, target 59; need 0 < stop < entry 49.00 < target.
- OPEN: Release cap 999.90 (available 4999.50), buy 19 at 49.00: notional 931.00, fee 19.91, debit 950.91; available -> 4048.59.
- DURING_SESSION: Touch test for T-2026-01-12-SYN: low 48.00 > stop 45 -> False; high 50.00 < target 59 -> False.
- AFTER_CLOSE: Signal: condition FALSE, decision NO_ENTRY.
- AFTER_CLOSE: Daily record: equity = available 4048.59 + reserved 0.00 + receivables 0.00 + positions 931.00 = 4979.59.

### 2026-01-13

- DURING_SESSION: Touch test for T-2026-01-12-SYN: low 48.00 > stop 45 -> False; high 50.00 < target 59 -> False.
- AFTER_CLOSE: Signal: condition FALSE, decision NO_ENTRY.
- AFTER_CLOSE: Daily record: equity = available 4048.59 + reserved 0.00 + receivables 0.00 + positions 931.00 = 4979.59.

### 2026-01-14

- DURING_SESSION: Touch test for T-2026-01-12-SYN: low 48.00 > stop 45 -> False; high 50.00 < target 59 -> False.
- AFTER_CLOSE: Signal: condition FALSE, decision SKIPPED (NO_NEXT_SESSION).
- AFTER_CLOSE: Daily record: equity = available 4048.59 + reserved 0.00 + receivables 0.00 + positions 931.00 = 4979.59.
- AFTER_CLOSE: End of run: no forced liquidation; 1 open trade(s) valued at the last close.

### Journal sequence numbers

Fills and ledger lines share one counter: 0 RESERVE, 1 RELEASE, 2 BUY fill, 3 FILL_BUY.

### Outcome

The run completes. Open trades stay OPEN_AT_END and are valued at the last close.

## Hand check

- Capital 4999.50, five slots: cap = floor(999.90) = 999.90. Open 49.00, fixed fee 19.90, fee 0.05 bps.
- 20 shares: notional 980.00, raw fee = 19.90 + 980.00 * 0.05 / 10000 = 19.90 + 0.0049 = 19.9049, ceil to cents =
  19.91, total 999.91 > 999.90. Rejected by one cent. (Rounding to nearest or down would give a fee of 19.90, total
  999.90 <= cap, and wrongly buy 20 shares.)
- 19 shares: notional 931.00, raw fee 19.904655, ceil 19.91, total 950.91 <= 999.90. Accepted.
- Cash: 4999.50 - 999.90 = 3999.60 reserved, released to 4999.50, debit 950.91 gives 4048.59.

The oracle asserts these hand-derived values against its own output (a disagreement stops the run and is resolved by re-reading the specification, never by copying a value):

- `entries.0.cap` = `999.90` (floor(4999.50 / 5))
- `entries.0.quantity` = `19` (20 shares: 980.00 + ceil(19.9049) = 999.91 > 999.90)
- `entries.0.fee` = `19.91` (ceil(19.90 + 931.00 * 0.05 / 10000) = ceil(19.904655))
- `fills.0.cash_delta` = `-950.91` (-(931.00 + 19.91))
- `final.cash_available` = `4048.59` (4999.50 - 950.91)

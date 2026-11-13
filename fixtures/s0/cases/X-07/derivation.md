# X-07: Dual touch: the stop wins and the bar is flagged ambiguous

Origin: derived by `fixtures/s0/oracle/oracle.py` from OQ-02 sections 2.1 to 2.6 and the declared policy semantics; the oracle uses exact rational arithmetic and never reads the Rust engine. Status: hand-checked (see the last section). Covers: Entry and exit phases.

## Design

Nine sessions. After the X-01 entry, one bar spans both the stop (46) and the target (60) without gapping.

## Inputs

- Strategy: `strategy.json` (strategy hash `sha256:8055f33100f24f5412cb08601326b10849616aeb277fd9af956fd4f25b941b5b`).
- Input hash binding in `input.json`: `sha256:8055f33100f24f5412cb08601326b10849616aeb277fd9af956fd4f25b941b5b`.
- Policy: price scale 2, quantity scale 0, money scale 2, diagnostic scale 4, lot size 1; fixed fee 1.00 per fill, 10 bps, gap-exit slippage 0 bps; dividend withholding 0 bps.
- Windows: warm-up from 2026-01-05, scored from 2026-01-08, run ends after 2026-01-15; 9 calendar sessions, 9 bars; initial capital 5000.00.

| Session | Open | High | Low | Close | Volume |
| --- | --- | --- | --- | --- | --- |
| 2026-01-05 | 50 | 51 | 49 | 50 | 1000 |
| 2026-01-06 | 50 | 51 | 49 | 50 | 1000 |
| 2026-01-07 | 50 | 51 | 49 | 50 | 1000 |
| 2026-01-08 | 50 | 51 | 49 | 50 | 1000 |
| 2026-01-09 | 50 | 51.5 | 49.5 | 51 | 1000 |
| 2026-01-12 | 50 | 51 | 49 | 50 | 1000 |
| 2026-01-13 | 50 | 61 | 45 | 50 | 1000 |
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

- DURING_SESSION: Touch test for T-2026-01-12-SYN: low 45.00 <= stop 46 -> True; high 61.00 >= target 60 -> True.
- DURING_SESSION: Both touched: the stop takes precedence; ambiguous_bar recorded.
- DURING_SESSION: Sell 19 at 46.00 (STOP): notional 19 * 46.00 = 874.00; fee = ceil(1 + 874.00 * 10/10000) = 1.88; proceeds 874.00 - 1.88 = 872.12; available -> 4920.17.
- AFTER_CLOSE: Signal: condition FALSE, decision NO_ENTRY.
- AFTER_CLOSE: Daily record: equity = available 4920.17 + reserved 0.00 + receivables 0.00 + positions 0.00 = 4920.17.

### 2026-01-14

- AFTER_CLOSE: Signal: condition FALSE, decision NO_ENTRY.
- AFTER_CLOSE: Daily record: equity = available 4920.17 + reserved 0.00 + receivables 0.00 + positions 0.00 = 4920.17.

### 2026-01-15

- AFTER_CLOSE: Signal: condition FALSE, decision SKIPPED (NO_NEXT_SESSION).
- AFTER_CLOSE: Daily record: equity = available 4920.17 + reserved 0.00 + receivables 0.00 + positions 0.00 = 4920.17.
- AFTER_CLOSE: End of run: no forced liquidation; 0 open trade(s) valued at the last close.

### Journal sequence numbers

Fills and ledger lines share one counter: 0 RESERVE, 1 RELEASE, 2 BUY fill, 3 FILL_BUY, 4 SELL fill, 5 FILL_SELL.

### Outcome

The run completes. Open trades stay OPEN_AT_END and are valued at the last close.

## Hand check

- Entry as X-01 (19 shares at 50.00, stop 46, target 60). Index 6 opens at 50 (no gap), low 45 <= 46 touches the stop and
  high 61 >= 60 touches the target. The order is unknown, so the stop takes precedence and the bar is recorded as ambiguous.
  Fill at the stop level 46.00: notional 19 * 46.00 = 874.00, fee = ceil(1.00 + 0.874) = 1.88, proceeds 872.12.
  Available 4048.05 + 872.12 = 4920.17.

The oracle asserts these hand-derived values against its own output (a disagreement stops the run and is resolved by re-reading the specification, never by copying a value):

- `fills.1.price` = `46.00` (stop level)
- `fills.1.reason` = `STOP` (stop takes precedence)
- `fills.1.ambiguous_bar` = `True` (both touched)
- `fills.1.fee` = `1.88` (ceil(1.00 + 874.00 * 10 / 10000) = ceil(1.874))
- `fills.1.cash_delta` = `872.12` (874.00 - 1.88)
- `trades.0.ambiguous_bar` = `True` (recorded on the trade)
- `final.cash_available` = `4920.17` (4048.05 + 872.12)

# G-08a: Grid tie: break-even trigger high >= 5 + 3 * ATR3 fires at exactly 5.68 (ATR3 = 0.68/3)

Origin: derived by `fixtures/s0/oracle/oracle.py` from OQ-02 sections 2.1 to 2.6 and the declared policy semantics; the oracle uses exact rational arithmetic and never reads the Rust engine. Status: hand-checked (see the last section). Covers: Entry and exit phases, Definition execution.

## Design

9 sessions. The break-even trigger of this variant is high >= entry_price + 3 * entry_atr, so with ATR3 = 0.68/3 the trigger level is the grid price 5.68 although ATR3 has no finite decimal form. One bar stays one tick below it (no trigger) and the next bar's high equals it (trigger). A rounded ATR3 lies above its exact value: a trigger level computed from it lies one unit of the last digit above 5.68, so a high of exactly 5.68 would miss the trigger and the position would keep its old stop.

## Inputs

- Strategy: `strategy.json` (strategy hash `sha256:5d9d00fa059647777fc3776737322779a75b2d35b0bd07df60bd5f2115cfe350`).
- Input hash binding in `input.json`: `sha256:5d9d00fa059647777fc3776737322779a75b2d35b0bd07df60bd5f2115cfe350`.
- Policy: price scale 2, quantity scale 0, money scale 2, diagnostic scale 4, lot size 1; fixed fee 1.00 per fill, 0 bps, gap-exit slippage 100 bps; dividend withholding 0 bps.
- Windows: warm-up from 2026-01-05, scored from 2026-01-08, run ends after 2026-01-15; 9 calendar sessions, 9 bars; initial capital 5000.00.

| Session | Open | High | Low | Close | Volume |
| --- | --- | --- | --- | --- | --- |
| 2026-01-05 | 5 | 5.1 | 4.9 | 5 | 1000 |
| 2026-01-06 | 5 | 5.1 | 4.9 | 5 | 1000 |
| 2026-01-07 | 5 | 5.1 | 4.9 | 5 | 1000 |
| 2026-01-08 | 5 | 5.1 | 4.9 | 5 | 1000 |
| 2026-01-09 | 5 | 5.18 | 4.9 | 5.05 | 1000 |
| 2026-01-12 | 5 | 5.67 | 4.9 | 5 | 1000 |
| 2026-01-13 | 5 | 5.68 | 4.9 | 5 | 1000 |
| 2026-01-14 | 5.2 | 5.3 | 4.95 | 5 | 1000 |
| 2026-01-15 | 5 | 5.1 | 4.9 | 5 | 1000 |

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

- AFTER_CLOSE: Indicator sma3 = mean of the last 3 close values (indices 2..4): sum 15.05 / 3 = 301/60 -> 5.0167
- AFTER_CLOSE: Indicator atr3: true ranges (indices 2..4) sum to 0.68; ATR = 0.68 / 3 = 17/75 -> 0.2267
- AFTER_CLOSE: Decision: condition TRUE, not held, vacant slots 5 - 0 - 0 = 5. cap = floor(available 5000.00 / 5) = 1000.00.
- AFTER_CLOSE: Reserve 1000.00: available -> 4000.00, reserved -> 1000.00; rank 1.0000; snapshots entry_atr=17/75.
- AFTER_CLOSE: Signal: condition TRUE, decision ENTER.
- AFTER_CLOSE: Daily record: equity = available 4000.00 + reserved 1000.00 + receivables 0.00 + positions 0.00 = 5000.00.

### 2026-01-12

- OPEN: Size intent I-2026-01-09-SYN: cap 1000.00, open 5.00, lot 1, fee(n) = ceil(1 + n * 0/10000). Largest lot multiple that fits: q=200: 1000.00 + fee 1.00 = 1001.00 > cap 1000.00; q=199: 995.00 + fee 1.00 = 996.00 <= cap 1000.00.
- OPEN: Levels from the signal-session snapshots (entry_atr=17/75): stop 341/75, target 92/15; need 0 < stop < entry 5.00 < target.
- OPEN: Release cap 1000.00 (available 5000.00), buy 199 at 5.00: notional 995.00, fee 1.00, debit 996.00; available -> 4004.00.
- DURING_SESSION: Touch test for T-2026-01-12-SYN: low 4.90 > stop 341/75 -> False; high 5.67 < target 92/15 -> False.
- AFTER_CLOSE: Stop adjustment break_even for T-2026-01-12-SYN: trigger (raw high 5.67 vs entry 5 + snapshot) = False.
- AFTER_CLOSE: Signal: condition FALSE, decision NO_ENTRY.
- AFTER_CLOSE: Daily record: equity = available 4004.00 + reserved 0.00 + receivables 0.00 + positions 995.00 = 4999.00.

### 2026-01-13

- DURING_SESSION: Touch test for T-2026-01-12-SYN: low 4.90 > stop 341/75 -> False; high 5.68 < target 92/15 -> False.
- AFTER_CLOSE: Stop adjustment break_even for T-2026-01-12-SYN: trigger (raw high 5.68 vs entry 5 + snapshot) = True.
- AFTER_CLOSE: Fired once: new stop level 5 scheduled, effective 2026-01-14 before the open; the current stop 341/75 stays active until then.
- AFTER_CLOSE: Indicator sma3 = mean of the last 3 close values (indices 4..6): sum 15.05 / 3 = 301/60 -> 5.0167
- AFTER_CLOSE: Indicator atr3: true ranges (indices 4..6) sum to 1.83; ATR = 1.83 / 3 = 0.61 -> 0.6100
- AFTER_CLOSE: Signal: condition FALSE, decision NO_ENTRY.
- AFTER_CLOSE: Daily record: equity = available 4004.00 + reserved 0.00 + receivables 0.00 + positions 995.00 = 4999.00.

### 2026-01-14

- BEFORE_OPEN: Activate the scheduled stop of T-2026-01-12-SYN: stop 341/75 -> 5 (effective 2026-01-14).
- DURING_SESSION: Touch test for T-2026-01-12-SYN: low 4.95 <= stop 5 -> True; high 5.30 < target 92/15 -> False.
- DURING_SESSION: Sell 199 at 5.00 (STOP): notional 199 * 5.00 = 995.00; fee = ceil(1 + 995.00 * 0/10000) = 1.00; proceeds 995.00 - 1.00 = 994.00; available -> 4998.00.
- AFTER_CLOSE: Signal: condition FALSE, decision NO_ENTRY.
- AFTER_CLOSE: Daily record: equity = available 4998.00 + reserved 0.00 + receivables 0.00 + positions 0.00 = 4998.00.

### 2026-01-15

- AFTER_CLOSE: Signal: condition FALSE, decision SKIPPED (NO_NEXT_SESSION).
- AFTER_CLOSE: Daily record: equity = available 4998.00 + reserved 0.00 + receivables 0.00 + positions 0.00 = 4998.00.
- AFTER_CLOSE: End of run: no forced liquidation; 0 open trade(s) valued at the last close.

### Journal sequence numbers

Fills and ledger lines share one counter: 0 RESERVE, 1 RELEASE, 2 BUY fill, 3 FILL_BUY, 4 SELL fill, 5 FILL_SELL.

### Outcome

The run completes. Open trades stay OPEN_AT_END and are valued at the last close.

## Hand check

1. ATR3 window as in G-02: the true ranges of indices 2, 3, 4 are 0.20, 0.20 and 0.28, so the sum is 0.68 and ATR3 = 0.68 / 3 (no finite decimal form). The close 5.05 is above SMA3 = 5.0166..., so the close of index 4 creates an entry intent (cap 1000.00). Index 5 opens at 5.00: quantity 199 (996.00 with the fee), available 4004.00.
2. Levels. Stop = 5 - 2 * (0.68 / 3) = 341/75 = 4.5466... and target = 5 + 5 * (0.68 / 3) = 92/15 = 6.1333...; both are off the grid, so the expectation omits them. The break-even rule fires when high >= entry + 3 * entry_atr = 5 + 3 * (0.68 / 3) = 5 + 0.68 = 5.68, an exact price on the grid, and then moves the stop to the entry price 5.00 effective at the next session.
3. Index 5 (5, 5.67, 4.90, 5), the entry session: the high 5.67 < 5.68, one tick below the trigger: no trigger. The low 4.90 is above the stop and the high is below the target.
4. Index 6 (5, 5.68, 4.90, 5): the high 5.68 >= 5.68 by equality: the trigger holds at the close and the stop is scheduled once, at the level 5.00 (the entry price), effective at index 7 (2026-01-14). The stop in force during index 6 is still the original one, so the daily record of index 6 shows the scheduled stop 5 effective 2026-01-14.
5. Index 7 (5.20, 5.30, 4.95, 5): BEFORE_OPEN activates the stop 5.00. The open 5.20 is above 5.00 (no gap); the low 4.95 <= 5.00: STOP at floor(5.00) = 5.00, before costs. Notional 199 * 5.00 = 995.00; fee 1.00; proceeds 994.00; available 4004.00 + 994.00 = 4998.00.
6. The close of index 7 equals SMA3 = 5.00 (not above it), so no new entry arises. The run ends with no position.

The oracle asserts these hand-derived values against its own output (a disagreement stops the run and is resolved by re-reading the specification, never by copying a value):

- `entries.0.quantity` = `199` (996.00 with the fee)
- `daily.5.cash_available` = `4004.00` (5000.00 - 996.00)
- `daily.6.positions.0.scheduled_stop.level` = `5` (the entry price)
- `daily.6.positions.0.scheduled_stop.effective_session` = `2026-01-14` (next session)
- `fills.1.session` = `2026-01-14` (index 7)
- `fills.1.reason` = `STOP` (the activated stop 5.00 is touched by the low 4.95)
- `fills.1.price` = `5.00` (floor(5.00))
- `fills.1.cash_delta` = `994.00` (995.00 - 1.00)
- `final.cash_available` = `4998.00` (4004.00 + 994.00)

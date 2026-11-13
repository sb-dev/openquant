# C-01a: 2-for-1 split on a held position with a scheduled stop (10 sh @ 100 become 20 sh @ 50)

Origin: derived by `fixtures/s0/oracle/oracle.py` from OQ-02 sections 2.1 to 2.6 and the declared policy semantics; the oracle uses exact rational arithmetic and never reads the Rust engine. Status: hand-checked (see the last section). Covers: Split across an ex-date.

## Design

Nine sessions at ATR 4, zero costs, whole lots. The position (10 shares at 100, stop 92, target 120, ATR 4) schedules its break-even stop 100 at the close of index 6; a 2-for-1 split is effective at the next session. All quantities, prices, snapshots and the scheduled level convert once.

## Inputs

- Strategy: `strategy.json` (strategy hash `sha256:f94e7754fd11e4fd2e2faac1a22a075a416db92531eb0e30fb802fd1117f8c12`).
- Input hash binding in `input.json`: `sha256:f94e7754fd11e4fd2e2faac1a22a075a416db92531eb0e30fb802fd1117f8c12`.
- Policy: price scale 2, quantity scale 0, money scale 2, diagnostic scale 4, lot size 1; fixed fee 0 per fill, 0 bps, gap-exit slippage 0 bps; dividend withholding 0 bps.
- Windows: warm-up from 2026-01-05, scored from 2026-01-08, run ends after 2026-01-15; 9 calendar sessions, 9 bars; initial capital 5000.00.
- Corporate action: `{"action_id": "SPLIT-2-1", "available_at": "2026-01-14T06:00:00Z", "effective_session": "2026-01-14", "kind": "SPLIT", "ratio_new": 2, "ratio_old": 1}`.

| Session | Open | High | Low | Close | Volume |
| --- | --- | --- | --- | --- | --- |
| 2026-01-05 | 100 | 102 | 98 | 100 | 1000 |
| 2026-01-06 | 100 | 102 | 98 | 100 | 1000 |
| 2026-01-07 | 100 | 102 | 98 | 100 | 1000 |
| 2026-01-08 | 100 | 102 | 98 | 100 | 1000 |
| 2026-01-09 | 100 | 103 | 99 | 101 | 1000 |
| 2026-01-12 | 100 | 102 | 98 | 100 | 1000 |
| 2026-01-13 | 100 | 104 | 99 | 102 | 1000 |
| 2026-01-14 | 51 | 52 | 50.5 | 51.5 | 1000 |
| 2026-01-15 | 51.5 | 52.5 | 51 | 52 | 1000 |

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

- AFTER_CLOSE: Indicator sma3 = mean of the last 3 close values (indices 2..4): sum 301 / 3 = 301/3 -> 100.3333
- AFTER_CLOSE: Indicator atr3: true ranges (indices 2..4) sum to 12; ATR = 12 / 3 = 4 -> 4.0000
- AFTER_CLOSE: Decision: condition TRUE, not held, vacant slots 5 - 0 - 0 = 5. cap = floor(available 5000.00 / 5) = 1000.00.
- AFTER_CLOSE: Reserve 1000.00: available -> 4000.00, reserved -> 1000.00; rank 1.0000; snapshots entry_atr=4.
- AFTER_CLOSE: Signal: condition TRUE, decision ENTER.
- AFTER_CLOSE: Daily record: equity = available 4000.00 + reserved 1000.00 + receivables 0.00 + positions 0.00 = 5000.00.

### 2026-01-12

- OPEN: Size intent I-2026-01-09-SYN: cap 1000.00, open 100.00, lot 1, fee(n) = ceil(0 + n * 0/10000). Largest lot multiple that fits: q=10: 1000.00 + fee 0.00 = 1000.00 <= cap 1000.00.
- OPEN: Levels from the signal-session snapshots (entry_atr=4): stop 92, target 120; need 0 < stop < entry 100.00 < target.
- OPEN: Release cap 1000.00 (available 5000.00), buy 10 at 100.00: notional 1000.00, fee 0.00, debit 1000.00; available -> 4000.00.
- DURING_SESSION: Touch test for T-2026-01-12-SYN: low 98.00 > stop 92 -> False; high 102.00 < target 120 -> False.
- AFTER_CLOSE: Stop adjustment break_even for T-2026-01-12-SYN: trigger (raw high 102.00 vs entry 100 + snapshot) = False.
- AFTER_CLOSE: Signal: condition FALSE, decision NO_ENTRY.
- AFTER_CLOSE: Daily record: equity = available 4000.00 + reserved 0.00 + receivables 0.00 + positions 1000.00 = 5000.00.

### 2026-01-13

- DURING_SESSION: Touch test for T-2026-01-12-SYN: low 99.00 > stop 92 -> False; high 104.00 < target 120 -> False.
- AFTER_CLOSE: Stop adjustment break_even for T-2026-01-12-SYN: trigger (raw high 104.00 vs entry 100 + snapshot) = True.
- AFTER_CLOSE: Fired once: new stop level 100 scheduled, effective 2026-01-14 before the open; the current stop 92 stays active until then.
- AFTER_CLOSE: Indicator sma3 = mean of the last 3 close values (indices 4..6): sum 303 / 3 = 101 -> 101.0000
- AFTER_CLOSE: Indicator atr3: true ranges (indices 4..6) sum to 13; ATR = 13 / 3 = 13/3 -> 4.3333
- AFTER_CLOSE: Signal: condition TRUE, decision SKIPPED (HELD).
- AFTER_CLOSE: Daily record: equity = available 4000.00 + reserved 0.00 + receivables 0.00 + positions 1020.00 = 5020.00.

### 2026-01-14

- BEFORE_OPEN: Split SPLIT-2-1: ratio r = 2/1 = 2, applied exactly once.
- BEFORE_OPEN: Position T-2026-01-12-SYN: quantity 10 * 2 = 20; entry 100 / 2 = 50; stop 92 -> 46; target 120 -> 60; snapshots entry_atr=4 -> entry_atr=2; scheduled stop 100 -> 50.
- BEFORE_OPEN: Activate the scheduled stop of T-2026-01-12-SYN: stop 46 -> 50 (effective 2026-01-14).
- DURING_SESSION: Touch test for T-2026-01-12-SYN: low 50.50 > stop 50 -> False; high 52.00 < target 60 -> False.
- AFTER_CLOSE: Indicator sma3 = mean of the last 3 close values (indices 5..7): sum 152.5 / 3 = 305/6 -> 50.8333
- AFTER_CLOSE: Indicator atr3: true ranges (indices 5..7) sum to 6; ATR = 6 / 3 = 2 -> 2.0000
- AFTER_CLOSE: Signal: condition TRUE, decision SKIPPED (HELD).
- AFTER_CLOSE: Daily record: equity = available 4000.00 + reserved 0.00 + receivables 0.00 + positions 1030.00 = 5030.00.

### 2026-01-15

- DURING_SESSION: Touch test for T-2026-01-12-SYN: low 51.00 > stop 50 -> False; high 52.50 < target 60 -> False.
- AFTER_CLOSE: Indicator sma3 = mean of the last 3 close values (indices 6..8): sum 154.5 / 3 = 51.5 -> 51.5000
- AFTER_CLOSE: Indicator atr3: true ranges (indices 6..8) sum to 5.5; ATR = 5.5 / 3 = 11/6 -> 1.8333
- AFTER_CLOSE: Signal: condition TRUE, decision SKIPPED (NO_NEXT_SESSION).
- AFTER_CLOSE: Daily record: equity = available 4000.00 + reserved 0.00 + receivables 0.00 + positions 1040.00 = 5040.00.
- AFTER_CLOSE: End of run: no forced liquidation; 1 open trade(s) valued at the last close.

### Journal sequence numbers

Fills and ledger lines share one counter: 0 RESERVE, 1 RELEASE, 2 BUY fill, 3 FILL_BUY.

### Outcome

The run completes. Open trades stay OPEN_AT_END and are valued at the last close.

## Hand check

- Index 4 signal: SMA3 = (100 + 100 + 101) / 3 = 100.3333 < 101, ATR3 = (4 + 4 + 4) / 3 = 4. Cap = 5000.00 / 5 = 1000.00. Zero
  costs, lot 1: open 100.00 buys 1000.00 / 100.00 = 10 shares. Stop 100 - 2 * 4 = 92, target 100 + 5 * 4 = 120.
- Index 6 bar high 104 >= entry 100 + ATR 4: break-even fires at the close; the scheduled stop 100 is effective at index 7. The
  daily record of index 6 shows quantity 10, entry 100, stop 92, target 120, ATR 4, scheduled stop 100 (effective 2026-01-14).
- Index 7 BEFORE_OPEN, 2-for-1 split (r = 2, applied exactly once): quantity 10 * 2 = 20, entry 100 / 2 = 50, ATR 4 / 2 = 2,
  stop 92 / 2 = 46, target 120 / 2 = 60, scheduled stop 100 / 2 = 50. The scheduled stop then activates on the new basis, so
  the active stop of index 7 is 50 (the converted original stop 46 is replaced). C-01c shows the same conversion with the
  stop 46 and the scheduled stop 50 visible together.
- Raw bar index 7 (51, 52, 50.5, 51.5): open 51 > stop 50 (no gap), low 50.5 > 50, high 52 < 60. Close 51.5: positions
  20 * 51.50 = 1030.00, equity 4000.00 + 1030.00 = 5030.00.

The oracle asserts these hand-derived values against its own output (a disagreement stops the run and is resolved by re-reading the specification, never by copying a value):

- `entries.0.quantity` = `10` (cap 1000.00 / 100.00, zero costs)
- `daily.6.positions.0.quantity` = `10` (before the split)
- `daily.6.positions.0.entry_price` = `100` (fill at the open)
- `daily.6.positions.0.stop` = `92` (100 - 2 * 4)
- `daily.6.positions.0.target` = `120` (100 + 5 * 4)
- `daily.6.positions.0.snapshots.0.value` = `4` (ATR at the signal session)
- `daily.6.positions.0.scheduled_stop.level` = `100` (break-even level, trigger high 104 >= 100 + 4)
- `daily.6.positions.0.scheduled_stop.effective_session` = `2026-01-14` (next session = the ex-date)
- `daily.7.positions.0.quantity` = `20` (10 * 2)
- `daily.7.positions.0.entry_price` = `50` (100 / 2)
- `daily.7.positions.0.stop` = `50` (scheduled 100 / 2, activated after the split on the new basis)
- `daily.7.positions.0.target` = `60` (120 / 2)
- `daily.7.positions.0.snapshots.0.value` = `2` (4 / 2)
- `corporate_actions.0.applied_at.phase` = `BEFORE_OPEN` (applied once at the ex-date)
- `daily.7.equity` = `5030.00` (4000.00 + 20 * 51.50)

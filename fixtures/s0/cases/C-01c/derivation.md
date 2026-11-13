# C-01c: 2-for-1 split: stop 46, target 60, ATR 2 and scheduled stop 50 visible together

Origin: derived by `fixtures/s0/oracle/oracle.py` from OQ-02 sections 2.1 to 2.6 and the declared policy semantics; the oracle uses exact rational arithmetic and never reads the Rust engine. Status: hand-checked (see the last section). Covers: Split across an ex-date.

## Design

Nine sessions. As C-01a, but the break-even trigger fires on the ex-date bar (post-split basis), so the converted stop 46 and target 60 are visible next to the new scheduled stop 50.

## Inputs

- Strategy: `strategy.json` (strategy hash `sha256:5d1f4618ec59c6c7095ab93b99392625136768fb9b0bb572a598e291bebeab93`).
- Input hash binding in `input.json`: `sha256:5d1f4618ec59c6c7095ab93b99392625136768fb9b0bb572a598e291bebeab93`.
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
| 2026-01-13 | 100 | 103 | 99 | 101 | 1000 |
| 2026-01-14 | 51 | 52.5 | 50.5 | 51.5 | 1000 |
| 2026-01-15 | 51.5 | 52 | 51 | 51.5 | 1000 |

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

- DURING_SESSION: Touch test for T-2026-01-12-SYN: low 99.00 > stop 92 -> False; high 103.00 < target 120 -> False.
- AFTER_CLOSE: Stop adjustment break_even for T-2026-01-12-SYN: trigger (raw high 103.00 vs entry 100 + snapshot) = False.
- AFTER_CLOSE: Indicator sma3 = mean of the last 3 close values (indices 4..6): sum 302 / 3 = 302/3 -> 100.6667
- AFTER_CLOSE: Indicator atr3: true ranges (indices 4..6) sum to 12; ATR = 12 / 3 = 4 -> 4.0000
- AFTER_CLOSE: Signal: condition TRUE, decision SKIPPED (HELD).
- AFTER_CLOSE: Daily record: equity = available 4000.00 + reserved 0.00 + receivables 0.00 + positions 1010.00 = 5010.00.

### 2026-01-14

- BEFORE_OPEN: Split SPLIT-2-1: ratio r = 2/1 = 2, applied exactly once.
- BEFORE_OPEN: Position T-2026-01-12-SYN: quantity 10 * 2 = 20; entry 100 / 2 = 50; stop 92 -> 46; target 120 -> 60; snapshots entry_atr=4 -> entry_atr=2; scheduled stop none -> none.
- DURING_SESSION: Touch test for T-2026-01-12-SYN: low 50.50 > stop 46 -> False; high 52.50 < target 60 -> False.
- AFTER_CLOSE: Stop adjustment break_even for T-2026-01-12-SYN: trigger (raw high 52.50 vs entry 50 + snapshot) = True.
- AFTER_CLOSE: Fired once: new stop level 50 scheduled, effective 2026-01-15 before the open; the current stop 46 stays active until then.
- AFTER_CLOSE: Indicator sma3 = mean of the last 3 close values (indices 5..7): sum 152 / 3 = 152/3 -> 50.6667
- AFTER_CLOSE: Indicator atr3: true ranges (indices 5..7) sum to 6; ATR = 6 / 3 = 2 -> 2.0000
- AFTER_CLOSE: Signal: condition TRUE, decision SKIPPED (HELD).
- AFTER_CLOSE: Daily record: equity = available 4000.00 + reserved 0.00 + receivables 0.00 + positions 1030.00 = 5030.00.

### 2026-01-15

- BEFORE_OPEN: Activate the scheduled stop of T-2026-01-12-SYN: stop 46 -> 50 (effective 2026-01-15).
- DURING_SESSION: Touch test for T-2026-01-12-SYN: low 51.00 > stop 50 -> False; high 52.00 < target 60 -> False.
- AFTER_CLOSE: Indicator sma3 = mean of the last 3 close values (indices 6..8): sum 153.5 / 3 = 307/6 -> 51.1667
- AFTER_CLOSE: Indicator atr3: true ranges (indices 6..8) sum to 5; ATR = 5 / 3 = 5/3 -> 1.6667
- AFTER_CLOSE: Signal: condition TRUE, decision SKIPPED (NO_NEXT_SESSION).
- AFTER_CLOSE: Daily record: equity = available 4000.00 + reserved 0.00 + receivables 0.00 + positions 1030.00 = 5030.00.
- AFTER_CLOSE: End of run: no forced liquidation; 1 open trade(s) valued at the last close.

### Journal sequence numbers

Fills and ledger lines share one counter: 0 RESERVE, 1 RELEASE, 2 BUY fill, 3 FILL_BUY.

### Outcome

The run completes. Open trades stay OPEN_AT_END and are valued at the last close.

## Hand check

- Same entry as C-01a: 10 shares at 100, stop 92, target 120, ATR 4. Index 6 high is 103 < 104, so nothing is scheduled.
- Index 7 BEFORE_OPEN, 2-for-1 split: 20 shares, entry 50, ATR 2, stop 92 / 2 = 46, target 120 / 2 = 60. No scheduled stop exists
  to convert, so the active stop stays 46.
- Index 7 raw bar (51, 52.5, 50.5, 51.5): high 52.5 >= entry 50 + ATR 2 = 52: break-even fires on the post-split basis at the close;
  the scheduled stop is the new entry price 50, effective index 8. The record of index 7 shows quantity 20, entry 50, stop
  46, target 60, ATR 2 and scheduled stop 50 together, the combination stated in OQ-06.

The oracle asserts these hand-derived values against its own output (a disagreement stops the run and is resolved by re-reading the specification, never by copying a value):

- `daily.6.positions.0.stop` = `92` (no trigger yet: high 103 < 104)
- `daily.7.positions.0.quantity` = `20` (10 * 2)
- `daily.7.positions.0.entry_price` = `50` (100 / 2)
- `daily.7.positions.0.stop` = `46` (92 / 2)
- `daily.7.positions.0.target` = `60` (120 / 2)
- `daily.7.positions.0.snapshots.0.value` = `2` (4 / 2)
- `daily.7.positions.0.scheduled_stop.level` = `50` (trigger on the raw post-split bar: high 52.5 >= 50 + 2)
- `daily.7.positions.0.scheduled_stop.effective_session` = `2026-01-15` (next session)

# X-09b: Break-even on on identical bars: scheduled stop 50, exit at 50.00

Origin: derived by `fixtures/s0/oracle/oracle.py` from OQ-02 sections 2.1 to 2.6 and the declared policy semantics; the oracle uses exact rational arithmetic and never reads the Rust engine. Status: hand-checked (see the last section). Covers: Entry and exit phases, Definition execution.

## Design

Nine sessions. The entry is at 50.00 with ATR 2 (stop 46, target 60, break-even trigger high >= 52). Index 6 reaches 52.00, index 7 dips to 49.50 and index 8 rallies through the target. The bars are identical to the sibling case X-09a; only the strategy hash and the strategy differ.

## Inputs

- Strategy: `strategy.json` (strategy hash `sha256:4abb93e196a5a941486318152f4846f4e829c4d9f98efa6eb285e62c28c07e57`).
- Input hash binding in `input.json`: `sha256:4abb93e196a5a941486318152f4846f4e829c4d9f98efa6eb285e62c28c07e57`.
- Policy: price scale 2, quantity scale 0, money scale 2, diagnostic scale 4, lot size 1; fixed fee 1.00 per fill, 0 bps, gap-exit slippage 0 bps; dividend withholding 0 bps.
- Windows: warm-up from 2026-01-05, scored from 2026-01-08, run ends after 2026-01-15; 9 calendar sessions, 9 bars; initial capital 5000.00.

| Session | Open | High | Low | Close | Volume |
| --- | --- | --- | --- | --- | --- |
| 2026-01-05 | 50 | 51 | 49 | 50 | 1000 |
| 2026-01-06 | 50 | 51 | 49 | 50 | 1000 |
| 2026-01-07 | 50 | 51 | 49 | 50 | 1000 |
| 2026-01-08 | 50 | 51 | 49 | 50 | 1000 |
| 2026-01-09 | 50 | 51.5 | 49.5 | 51 | 1000 |
| 2026-01-12 | 50 | 51 | 49 | 50 | 1000 |
| 2026-01-13 | 50 | 52 | 49.5 | 51 | 1000 |
| 2026-01-14 | 50.5 | 51 | 49.5 | 50.2 | 1000 |
| 2026-01-15 | 51 | 61 | 50.5 | 59 | 1000 |

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

- OPEN: Size intent I-2026-01-09-SYN: cap 1000.00, open 50.00, lot 1, fee(n) = ceil(1 + n * 0/10000). Largest lot multiple that fits: q=20: 1000.00 + fee 1.00 = 1001.00 > cap 1000.00; q=19: 950.00 + fee 1.00 = 951.00 <= cap 1000.00.
- OPEN: Levels from the signal-session snapshots (entry_atr=2): stop 46, target 60; need 0 < stop < entry 50.00 < target.
- OPEN: Release cap 1000.00 (available 5000.00), buy 19 at 50.00: notional 950.00, fee 1.00, debit 951.00; available -> 4049.00.
- DURING_SESSION: Touch test for T-2026-01-12-SYN: low 49.00 > stop 46 -> False; high 51.00 < target 60 -> False.
- AFTER_CLOSE: Stop adjustment break_even for T-2026-01-12-SYN: trigger (raw high 51.00 vs entry 50 + snapshot) = False.
- AFTER_CLOSE: Signal: condition FALSE, decision NO_ENTRY.
- AFTER_CLOSE: Daily record: equity = available 4049.00 + reserved 0.00 + receivables 0.00 + positions 950.00 = 4999.00.

### 2026-01-13

- DURING_SESSION: Touch test for T-2026-01-12-SYN: low 49.50 > stop 46 -> False; high 52.00 < target 60 -> False.
- AFTER_CLOSE: Stop adjustment break_even for T-2026-01-12-SYN: trigger (raw high 52.00 vs entry 50 + snapshot) = True.
- AFTER_CLOSE: Fired once: new stop level 50 scheduled, effective 2026-01-14 before the open; the current stop 46 stays active until then.
- AFTER_CLOSE: Indicator sma3 = mean of the last 3 close values (indices 4..6): sum 152 / 3 = 152/3 -> 50.6667
- AFTER_CLOSE: Indicator atr3: true ranges (indices 4..6) sum to 6.5; ATR = 6.5 / 3 = 13/6 -> 2.1667
- AFTER_CLOSE: Signal: condition TRUE, decision SKIPPED (HELD).
- AFTER_CLOSE: Daily record: equity = available 4049.00 + reserved 0.00 + receivables 0.00 + positions 969.00 = 5018.00.

### 2026-01-14

- BEFORE_OPEN: Activate the scheduled stop of T-2026-01-12-SYN: stop 46 -> 50 (effective 2026-01-14).
- DURING_SESSION: Touch test for T-2026-01-12-SYN: low 49.50 <= stop 50 -> True; high 51.00 < target 60 -> False.
- DURING_SESSION: Sell 19 at 50.00 (STOP): notional 19 * 50.00 = 950.00; fee = ceil(1 + 950.00 * 0/10000) = 1.00; proceeds 950.00 - 1.00 = 949.00; available -> 4998.00.
- AFTER_CLOSE: Signal: condition FALSE, decision NO_ENTRY.
- AFTER_CLOSE: Daily record: equity = available 4998.00 + reserved 0.00 + receivables 0.00 + positions 0.00 = 4998.00.

### 2026-01-15

- AFTER_CLOSE: Indicator sma3 = mean of the last 3 close values (indices 6..8): sum 160.2 / 3 = 53.4 -> 53.4000
- AFTER_CLOSE: Indicator atr3: true ranges (indices 6..8) sum to 14.8; ATR = 14.8 / 3 = 74/15 -> 4.9333
- AFTER_CLOSE: Signal: condition TRUE, decision SKIPPED (NO_NEXT_SESSION).
- AFTER_CLOSE: Daily record: equity = available 4998.00 + reserved 0.00 + receivables 0.00 + positions 0.00 = 4998.00.
- AFTER_CLOSE: End of run: no forced liquidation; 0 open trade(s) valued at the last close.

### Journal sequence numbers

Fills and ledger lines share one counter: 0 RESERVE, 1 RELEASE, 2 BUY fill, 3 FILL_BUY, 4 SELL fill, 5 FILL_SELL.

### Outcome

The run completes. Open trades stay OPEN_AT_END and are valued at the last close.

## Hand check

- Entry as X-01 without bps: cap 1000.00, open 50.00, 19 shares (950 + 1 = 951), available 4049.00, ATR 2, stop 46, target 60.
- Index 6: high 52.00 = entry + ATR (50 + 2): the trigger high >= entry + entry_ATR holds at the close. The stop moves once to
  the entry price 50, effective index 7 before the open. The stop is still 46 for index 6 itself: the bar's low 49.50 is below
  the new level 50 but above 46, and there is no exit (a high-triggered change is never effective in its own session).
- Index 7: BEFORE_OPEN activates stop 50. Open 50.50 > 50 (no gap), low 49.50 <= 50: STOP at 50.00. Proceeds 19 * 50.00 - 1.00
  = 949.00, available 4049.00 + 949.00 = 4998.00 (the round trip costs the two fixed fees).

The oracle asserts these hand-derived values against its own output (a disagreement stops the run and is resolved by re-reading the specification, never by copying a value):

- `daily.6.positions.0.scheduled_stop.level` = `50` (entry price)
- `daily.6.positions.0.scheduled_stop.effective_session` = `2026-01-14` (next session)
- `daily.6.positions.0.stop` = `46` (still the original stop in the trigger session)
- `fills.1.reason` = `STOP` (activated stop 50 touched by low 49.5)
- `fills.1.price` = `50.00` (break-even stop at the entry price)
- `fills.1.session` = `2026-01-14` (index 7)
- `fills.1.cash_delta` = `949.00` (19 * 50.00 - 1.00)
- `final.cash_available` = `4998.00` (5000.00 - 951.00 + 949.00)

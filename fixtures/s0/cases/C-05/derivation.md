# C-05: Split and dividend on the same day: entitlement on the pre-split quantity

Origin: derived by `fixtures/s0/oracle/oracle.py` from OQ-02 sections 2.1 to 2.6 and the declared policy semantics; the oracle uses exact rational arithmetic and never reads the Rust engine. Status: hand-checked (see the last section). Covers: Split across an ex-date, Cash dividend.

## Design

Nine sessions. A 2-for-1 split and a 1.00 dividend share the ex-date of index 7.

## Inputs

- Strategy: `strategy.json` (strategy hash `sha256:b40932b1b2df4ce6e2f79aaff8ce5ebf166513e97a8d8105eefe7ef95976986c`).
- Input hash binding in `input.json`: `sha256:b40932b1b2df4ce6e2f79aaff8ce5ebf166513e97a8d8105eefe7ef95976986c`.
- Policy: price scale 2, quantity scale 0, money scale 2, diagnostic scale 4, lot size 1; fixed fee 0 per fill, 0 bps, gap-exit slippage 0 bps; dividend withholding 0 bps.
- Windows: warm-up from 2026-01-05, scored from 2026-01-08, run ends after 2026-01-15; 9 calendar sessions, 9 bars; initial capital 5000.00.
- Corporate action: `{"action_id": "ACT-1-SPLIT", "available_at": "2026-01-14T06:00:00Z", "effective_session": "2026-01-14", "kind": "SPLIT", "ratio_new": 2, "ratio_old": 1}`.
- Corporate action: `{"action_id": "ACT-2-DIV", "amount_per_share": "1.00", "available_at": "2026-01-14T06:00:00Z", "effective_session": "2026-01-14", "kind": "CASH_DIVIDEND", "payment_phase": "BEFORE_OPEN", "payment_session": "2026-01-15"}`.

| Session | Open | High | Low | Close | Volume |
| --- | --- | --- | --- | --- | --- |
| 2026-01-05 | 100 | 102 | 98 | 100 | 1000 |
| 2026-01-06 | 100 | 102 | 98 | 100 | 1000 |
| 2026-01-07 | 100 | 102 | 98 | 100 | 1000 |
| 2026-01-08 | 100 | 102 | 98 | 100 | 1000 |
| 2026-01-09 | 100 | 103 | 99 | 101 | 1000 |
| 2026-01-12 | 100 | 102 | 98 | 100 | 1000 |
| 2026-01-13 | 100 | 103 | 99 | 101 | 1000 |
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
- AFTER_CLOSE: Signal: condition FALSE, decision NO_ENTRY.
- AFTER_CLOSE: Daily record: equity = available 4000.00 + reserved 0.00 + receivables 0.00 + positions 1000.00 = 5000.00.

### 2026-01-13

- DURING_SESSION: Touch test for T-2026-01-12-SYN: low 99.00 > stop 92 -> False; high 103.00 < target 120 -> False.
- AFTER_CLOSE: Indicator sma3 = mean of the last 3 close values (indices 4..6): sum 302 / 3 = 302/3 -> 100.6667
- AFTER_CLOSE: Indicator atr3: true ranges (indices 4..6) sum to 12; ATR = 12 / 3 = 4 -> 4.0000
- AFTER_CLOSE: Signal: condition TRUE, decision SKIPPED (HELD).
- AFTER_CLOSE: Daily record: equity = available 4000.00 + reserved 0.00 + receivables 0.00 + positions 1010.00 = 5010.00.

### 2026-01-14

- BEFORE_OPEN: Split ACT-1-SPLIT: ratio r = 2/1 = 2, applied exactly once.
- BEFORE_OPEN: Position T-2026-01-12-SYN: quantity 10 * 2 = 20; entry 100 / 2 = 50; stop 92 -> 46; target 120 -> 60; snapshots entry_atr=4 -> entry_atr=2; scheduled stop none -> none.
- BEFORE_OPEN: Dividend ACT-2-DIV: entitled quantity (held at the start of BEFORE_OPEN, before any split) 10 * 1 per share * (1 - 0/10000) = 10; floor to money scale -> 10.00.
- BEFORE_OPEN: Receivable 10.00 due at 2026-01-15 BEFORE_OPEN; counts in equity, not in available cash.
- DURING_SESSION: Touch test for T-2026-01-12-SYN: low 50.50 > stop 46 -> False; high 52.00 < target 60 -> False.
- AFTER_CLOSE: Indicator sma3 = mean of the last 3 close values (indices 5..7): sum 152 / 3 = 152/3 -> 50.6667
- AFTER_CLOSE: Indicator atr3: true ranges (indices 5..7) sum to 5.5; ATR = 5.5 / 3 = 11/6 -> 1.8333
- AFTER_CLOSE: Signal: condition TRUE, decision SKIPPED (HELD).
- AFTER_CLOSE: Daily record: equity = available 4000.00 + reserved 0.00 + receivables 10.00 + positions 1030.00 = 5040.00.

### 2026-01-15

- BEFORE_OPEN: Pay receivable of action ACT-2-DIV: available += 10.00 -> 4010.00, receivables -> 0.00.
- DURING_SESSION: Touch test for T-2026-01-12-SYN: low 51.00 > stop 46 -> False; high 52.50 < target 60 -> False.
- AFTER_CLOSE: Indicator sma3 = mean of the last 3 close values (indices 6..8): sum 154 / 3 = 154/3 -> 51.3333
- AFTER_CLOSE: Indicator atr3: true ranges (indices 6..8) sum to 5; ATR = 5 / 3 = 5/3 -> 1.6667
- AFTER_CLOSE: Signal: condition TRUE, decision SKIPPED (NO_NEXT_SESSION).
- AFTER_CLOSE: Daily record: equity = available 4010.00 + reserved 0.00 + receivables 0.00 + positions 1040.00 = 5050.00.
- AFTER_CLOSE: End of run: no forced liquidation; 1 open trade(s) valued at the last close.

### Journal sequence numbers

Fills and ledger lines share one counter: 0 RESERVE, 1 RELEASE, 2 BUY fill, 3 FILL_BUY, 4 DIVIDEND_RECEIVABLE, 5 DIVIDEND_PAYMENT.

### Outcome

The run completes. Open trades stay OPEN_AT_END and are valued at the last close.

## Hand check

- 10 shares at 100.00 held (available 4000.00). Index 7 BEFORE_OPEN carries two actions on the same ex-date: the 2-for-1 split and a
  1.00 per share dividend. The dividend entitlement uses the quantity held at the start of BEFORE_OPEN, before the split: 10 shares *
  1.00 = 10.00 (not 20.00). After the split: 20 shares at 50, stop 46, target 60, ATR 2.
- Index 7 close 51.5: positions 20 * 51.50 = 1030.00, receivable 10.00, available 4000.00: equity 5040.00. Index 8 BEFORE_OPEN pays
  10.00: available 4010.00; close 52: equity 4010.00 + 1040.00 = 5050.00.

The oracle asserts these hand-derived values against its own output (a disagreement stops the run and is resolved by re-reading the specification, never by copying a value):

- `daily.6.receivables` = `0.00` (before the ex-date)
- `daily.7.receivables` = `10.00` (10 pre-split shares * 1.00, not 20 post-split shares)
- `daily.7.positions.0.quantity` = `20` (10 * 2)
- `daily.7.cash_available` = `4000.00` (dividend unpaid)
- `daily.7.equity` = `5040.00` (4000.00 + 10.00 + 20 * 51.50)
- `daily.8.cash_available` = `4010.00` (paid at BEFORE_OPEN of index 8)
- `corporate_actions.0.action_id` = `ACT-1-SPLIT` (input order)
- `corporate_actions.1.action_id` = `ACT-2-DIV` (input order)

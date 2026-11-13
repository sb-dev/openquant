# C-04a: Dividend payment timing: BEFORE_OPEN of session 01-13

Origin: derived by `fixtures/s0/oracle/oracle.py` from OQ-02 sections 2.1 to 2.6 and the declared policy semantics; the oracle uses exact rational arithmetic and never reads the Rust engine. Status: hand-checked (see the last section). Covers: Cash dividend, Cash and quantities.

## Design

Eight sessions. 20 shares are held over the ex-date (index 6), when the target is also hit and the close raises a new entry signal. Payment at BEFORE_OPEN of the ex-date itself: the receivable is created and paid in one event.

## Inputs

- Strategy: `strategy.json` (strategy hash `sha256:eee3f8fe77657868eb8956c309fab8d226ec8160fa59c82ec9344188b5dc0e03`).
- Input hash binding in `input.json`: `sha256:eee3f8fe77657868eb8956c309fab8d226ec8160fa59c82ec9344188b5dc0e03`.
- Policy: price scale 2, quantity scale 0, money scale 2, diagnostic scale 4, lot size 1; fixed fee 0 per fill, 0 bps, gap-exit slippage 0 bps; dividend withholding 0 bps.
- Windows: warm-up from 2026-01-05, scored from 2026-01-08, run ends after 2026-01-14; 8 calendar sessions, 8 bars; initial capital 5000.00.
- Corporate action: `{"action_id": "DIV-1", "amount_per_share": "1.00", "available_at": "2026-01-13T06:00:00Z", "effective_session": "2026-01-13", "kind": "CASH_DIVIDEND", "payment_phase": "BEFORE_OPEN", "payment_session": "2026-01-13"}`.

| Session | Open | High | Low | Close | Volume |
| --- | --- | --- | --- | --- | --- |
| 2026-01-05 | 50 | 51 | 49 | 50 | 1000 |
| 2026-01-06 | 50 | 51 | 49 | 50 | 1000 |
| 2026-01-07 | 50 | 51 | 49 | 50 | 1000 |
| 2026-01-08 | 50 | 51 | 49 | 50 | 1000 |
| 2026-01-09 | 50 | 51.5 | 49.5 | 51 | 1000 |
| 2026-01-12 | 50 | 51 | 49 | 50 | 1000 |
| 2026-01-13 | 50 | 60 | 49 | 59 | 1000 |
| 2026-01-14 | 52.2 | 54 | 50 | 52 | 1000 |

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

- OPEN: Size intent I-2026-01-09-SYN: cap 1000.00, open 50.00, lot 1, fee(n) = ceil(0 + n * 0/10000). Largest lot multiple that fits: q=20: 1000.00 + fee 0.00 = 1000.00 <= cap 1000.00.
- OPEN: Levels from the signal-session snapshots (entry_atr=2): stop 46, target 60; need 0 < stop < entry 50.00 < target.
- OPEN: Release cap 1000.00 (available 5000.00), buy 20 at 50.00: notional 1000.00, fee 0.00, debit 1000.00; available -> 4000.00.
- DURING_SESSION: Touch test for T-2026-01-12-SYN: low 49.00 > stop 46 -> False; high 51.00 < target 60 -> False.
- AFTER_CLOSE: Signal: condition FALSE, decision NO_ENTRY.
- AFTER_CLOSE: Daily record: equity = available 4000.00 + reserved 0.00 + receivables 0.00 + positions 1000.00 = 5000.00.

### 2026-01-13

- BEFORE_OPEN: Dividend DIV-1: entitled quantity (held at the start of BEFORE_OPEN, before any split) 20 * 1 per share * (1 - 0/10000) = 20; floor to money scale -> 20.00.
- BEFORE_OPEN: Receivable 20.00 due at 2026-01-13 BEFORE_OPEN; counts in equity, not in available cash.
- BEFORE_OPEN: Pay receivable of action DIV-1: available += 20.00 -> 4020.00, receivables -> 0.00.
- DURING_SESSION: Touch test for T-2026-01-12-SYN: low 49.00 > stop 46 -> False; high 60.00 >= target 60 -> True.
- DURING_SESSION: Sell 20 at 60.00 (TARGET): notional 20 * 60.00 = 1200.00; fee = ceil(0 + 1200.00 * 0/10000) = 0.00; proceeds 1200.00 - 0.00 = 1200.00; available -> 5220.00.
- AFTER_CLOSE: Indicator sma3 = mean of the last 3 close values (indices 4..6): sum 160 / 3 = 160/3 -> 53.3333
- AFTER_CLOSE: Indicator atr3: true ranges (indices 4..6) sum to 15; ATR = 15 / 3 = 5 -> 5.0000
- AFTER_CLOSE: Decision: condition TRUE, not held, vacant slots 5 - 0 - 0 = 5. cap = floor(available 5220.00 / 5) = 1044.00.
- AFTER_CLOSE: Reserve 1044.00: available -> 4176.00, reserved -> 1044.00; rank 1.0000; snapshots entry_atr=5.
- AFTER_CLOSE: Signal: condition TRUE, decision ENTER.
- AFTER_CLOSE: Daily record: equity = available 4176.00 + reserved 1044.00 + receivables 0.00 + positions 0.00 = 5220.00.

### 2026-01-14

- OPEN: Size intent I-2026-01-13-SYN: cap 1044.00, open 52.20, lot 1, fee(n) = ceil(0 + n * 0/10000). Largest lot multiple that fits: q=20: 1044.00 + fee 0.00 = 1044.00 <= cap 1044.00.
- OPEN: Levels from the signal-session snapshots (entry_atr=5): stop 42.2, target 77.2; need 0 < stop < entry 52.20 < target.
- OPEN: Release cap 1044.00 (available 5220.00), buy 20 at 52.20: notional 1044.00, fee 0.00, debit 1044.00; available -> 4176.00.
- DURING_SESSION: Touch test for T-2026-01-14-SYN: low 50.00 > stop 42.2 -> False; high 54.00 < target 77.2 -> False.
- AFTER_CLOSE: Signal: condition FALSE, decision SKIPPED (NO_NEXT_SESSION).
- AFTER_CLOSE: Daily record: equity = available 4176.00 + reserved 0.00 + receivables 0.00 + positions 1040.00 = 5216.00.
- AFTER_CLOSE: End of run: no forced liquidation; 1 open trade(s) valued at the last close.

### Journal sequence numbers

Fills and ledger lines share one counter: 0 RESERVE, 1 RELEASE, 2 BUY fill, 3 FILL_BUY, 4 DIVIDEND_RECEIVABLE, 5 DIVIDEND_PAYMENT, 6 SELL fill, 7 FILL_SELL, 8 RESERVE, 9 RELEASE, 10 BUY fill, 11 FILL_BUY.

### Outcome

The run completes. Open trades stay OPEN_AT_END and are valued at the last close.

## Hand check

- 20 shares bought at 50.00 (available 4000.00). Index 6 (ex-date, 1.00 per share, payment at BEFORE_OPEN of the same session,
  after the actions are applied): receivable 20.00 created and paid in the same event, available 4020.00. The bar (50, 60, 49, 59)
  touches the target 60 (high == target): TARGET at 60.00, +1200.00, available 5220.00. The close is a fresh signal (SMA3 =
  (51 + 50 + 59) / 3 = 53.3333; ATR3 = (2 + 2 + 11) / 3 = 5): cap = floor(5220.00 / 5) = 1044.00.
- Index 7 open 52.20: 20 shares cost 20 * 52.20 = 1044.00 <= 1044.00 (zero costs): quantity 20. Available 5220.00 - 1044.00 = 4176.00.

The oracle asserts these hand-derived values against its own output (a disagreement stops the run and is resolved by re-reading the specification, never by copying a value):

- `cash_ledger.3.kind` = `DIVIDEND_RECEIVABLE` (ex-date index 6)
- `entries.1.cap` = `1044.00` (payment at BEFORE_OPEN of the ex-date is already cash at the close: floor(5220.00 / 5))
- `entries.1.quantity` = `20` (largest whole share count with notional <= cap at open 52.20)
- `final.cash_available` = `4176.00` (see the chain below)

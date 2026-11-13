# C-03: Cash dividend: receivable 20 on the ex-date, equity unchanged, cash +20 at payment

Origin: derived by `fixtures/s0/oracle/oracle.py` from OQ-02 sections 2.1 to 2.6 and the declared policy semantics; the oracle uses exact rational arithmetic and never reads the Rust engine. Status: hand-checked (see the last section). Covers: Cash dividend.

## Design

Nine sessions. 20 shares are held over the ex-date of a 1.00 dividend payable at the next BEFORE_OPEN; the raw price moves from 50 to 49.

## Inputs

- Strategy: `strategy.json` (strategy hash `sha256:dcfc9b4a4ab04306d60b9d99d2cd20834e6fc175e27d38162493f3687eb3b58e`).
- Input hash binding in `input.json`: `sha256:dcfc9b4a4ab04306d60b9d99d2cd20834e6fc175e27d38162493f3687eb3b58e`.
- Policy: price scale 2, quantity scale 0, money scale 2, diagnostic scale 4, lot size 1; fixed fee 0 per fill, 0 bps, gap-exit slippage 0 bps; dividend withholding 0 bps.
- Windows: warm-up from 2026-01-05, scored from 2026-01-08, run ends after 2026-01-15; 9 calendar sessions, 9 bars; initial capital 5000.00.
- Corporate action: `{"action_id": "DIV-1", "amount_per_share": "1.00", "available_at": "2026-01-13T06:00:00Z", "effective_session": "2026-01-13", "kind": "CASH_DIVIDEND", "payment_phase": "BEFORE_OPEN", "payment_session": "2026-01-14"}`.

| Session | Open | High | Low | Close | Volume |
| --- | --- | --- | --- | --- | --- |
| 2026-01-05 | 50 | 51 | 49 | 50 | 1000 |
| 2026-01-06 | 50 | 51 | 49 | 50 | 1000 |
| 2026-01-07 | 50 | 51 | 49 | 50 | 1000 |
| 2026-01-08 | 50 | 51 | 49 | 50 | 1000 |
| 2026-01-09 | 50 | 51.5 | 49.5 | 51 | 1000 |
| 2026-01-12 | 50 | 51 | 49 | 50 | 1000 |
| 2026-01-13 | 49 | 50 | 48 | 49 | 1000 |
| 2026-01-14 | 49 | 50 | 48 | 49 | 1000 |
| 2026-01-15 | 49 | 50 | 48 | 49 | 1000 |

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
- BEFORE_OPEN: Receivable 20.00 due at 2026-01-14 BEFORE_OPEN; counts in equity, not in available cash.
- DURING_SESSION: Touch test for T-2026-01-12-SYN: low 48.00 > stop 46 -> False; high 50.00 < target 60 -> False.
- AFTER_CLOSE: Signal: condition FALSE, decision NO_ENTRY.
- AFTER_CLOSE: Daily record: equity = available 4000.00 + reserved 0.00 + receivables 20.00 + positions 980.00 = 5000.00.

### 2026-01-14

- BEFORE_OPEN: Pay receivable of action DIV-1: available += 20.00 -> 4020.00, receivables -> 0.00.
- DURING_SESSION: Touch test for T-2026-01-12-SYN: low 48.00 > stop 46 -> False; high 50.00 < target 60 -> False.
- AFTER_CLOSE: Signal: condition FALSE, decision NO_ENTRY.
- AFTER_CLOSE: Daily record: equity = available 4020.00 + reserved 0.00 + receivables 0.00 + positions 980.00 = 5000.00.

### 2026-01-15

- DURING_SESSION: Touch test for T-2026-01-12-SYN: low 48.00 > stop 46 -> False; high 50.00 < target 60 -> False.
- AFTER_CLOSE: Signal: condition FALSE, decision SKIPPED (NO_NEXT_SESSION).
- AFTER_CLOSE: Daily record: equity = available 4020.00 + reserved 0.00 + receivables 0.00 + positions 980.00 = 5000.00.
- AFTER_CLOSE: End of run: no forced liquidation; 1 open trade(s) valued at the last close.

### Journal sequence numbers

Fills and ledger lines share one counter: 0 RESERVE, 1 RELEASE, 2 BUY fill, 3 FILL_BUY, 4 DIVIDEND_RECEIVABLE, 5 DIVIDEND_PAYMENT.

### Outcome

The run completes. Open trades stay OPEN_AT_END and are valued at the last close.

## Hand check

- Entry: cap 1000.00, open 50.00, zero costs: 20 shares, available 4000.00, equity at the close 4000.00 + 20 * 50 = 5000.00. Stop 46,
  target 60.
- Index 6 is the ex-date of a 1.00 per share dividend (no withholding), payable at BEFORE_OPEN of index 7. Entitled quantity (held at
  the start of BEFORE_OPEN) 20: receivable = floor(20 * 1.00 * (1 - 0)) = 20.00. The raw price falls 50 to 49 (close 49). Equity at
  index 6: available 4000.00 + receivable 20.00 + 20 * 49.00 = 980.00 = 5000.00, unchanged. Available cash is still 4000.00.
- Index 7 BEFORE_OPEN pays the receivable: available 4020.00, receivable 0.00. Equity 4020.00 + 980.00 = 5000.00. Stop 46 and target
  60 never change (the dividend does not touch raw price levels or the quantity).

The oracle asserts these hand-derived values against its own output (a disagreement stops the run and is resolved by re-reading the specification, never by copying a value):

- `daily.5.cash_available` = `4000.00` (5000.00 - 20 * 50.00)
- `daily.6.receivables` = `20.00` (20 shares * 1.00)
- `daily.6.cash_available` = `4000.00` (cash unchanged until payment)
- `daily.6.positions_value` = `980.00` (20 * 49.00)
- `daily.6.equity` = `5000.00` (4000.00 + 20.00 + 980.00 = the pre-ex-date equity)
- `daily.6.positions.0.stop` = `46` (raw level unchanged)
- `daily.6.positions.0.target` = `60` (raw level unchanged)
- `daily.7.cash_available` = `4020.00` (paid at BEFORE_OPEN of index 7)
- `daily.7.receivables` = `0.00` (paid)
- `daily.7.equity` = `5000.00` (4020.00 + 980.00)
- `cash_ledger.3.kind` = `DIVIDEND_RECEIVABLE` (ex-date)
- `cash_ledger.3.amount` = `20.00` (receivable)
- `cash_ledger.4.kind` = `DIVIDEND_PAYMENT` (payment)

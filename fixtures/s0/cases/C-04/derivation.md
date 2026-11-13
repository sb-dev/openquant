# C-04: Ex-date buyer receives no dividend entitlement

Origin: derived by `fixtures/s0/oracle/oracle.py` from OQ-02 sections 2.1 to 2.6 and the declared policy semantics; the oracle uses exact rational arithmetic and never reads the Rust engine. Status: hand-checked (see the last section). Covers: Cash dividend.

## Design

Nine sessions (nine bars: indices 0 to 8). The intent from the close of index 4 fills at the open of the ex-date, so the buyer holds nothing at the entitlement boundary.

## Inputs

- Strategy: `strategy.json` (strategy hash `sha256:147d38ea37442eca54a7d69f02d6463b88f5b366c7082eb6bba8c615bd8e45e4`).
- Input hash binding in `input.json`: `sha256:147d38ea37442eca54a7d69f02d6463b88f5b366c7082eb6bba8c615bd8e45e4`.
- Policy: price scale 2, quantity scale 0, money scale 2, diagnostic scale 4, lot size 1; fixed fee 0 per fill, 0 bps, gap-exit slippage 0 bps; dividend withholding 0 bps.
- Windows: warm-up from 2026-01-05, scored from 2026-01-08, run ends after 2026-01-15; 9 calendar sessions, 9 bars; initial capital 5000.00.
- Corporate action: `{"action_id": "DIV-1", "amount_per_share": "1.00", "available_at": "2026-01-12T06:00:00Z", "effective_session": "2026-01-12", "kind": "CASH_DIVIDEND", "payment_phase": "BEFORE_OPEN", "payment_session": "2026-01-13"}`.

| Session | Open | High | Low | Close | Volume |
| --- | --- | --- | --- | --- | --- |
| 2026-01-05 | 50 | 51 | 49 | 50 | 1000 |
| 2026-01-06 | 50 | 51 | 49 | 50 | 1000 |
| 2026-01-07 | 50 | 51 | 49 | 50 | 1000 |
| 2026-01-08 | 50 | 51 | 49 | 50 | 1000 |
| 2026-01-09 | 50 | 51.5 | 49.5 | 51 | 1000 |
| 2026-01-12 | 50 | 51 | 49 | 50 | 1000 |
| 2026-01-13 | 50 | 51 | 49 | 50 | 1000 |
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

- BEFORE_OPEN: Dividend DIV-1: entitled quantity (held at the start of BEFORE_OPEN, before any split) 0 * 1 per share * (1 - 0/10000) = 0; floor to money scale -> 0.00.
- BEFORE_OPEN: No entitlement: no receivable and no ledger line.
- OPEN: Size intent I-2026-01-09-SYN: cap 1000.00, open 50.00, lot 1, fee(n) = ceil(0 + n * 0/10000). Largest lot multiple that fits: q=20: 1000.00 + fee 0.00 = 1000.00 <= cap 1000.00.
- OPEN: Levels from the signal-session snapshots (entry_atr=2): stop 46, target 60; need 0 < stop < entry 50.00 < target.
- OPEN: Release cap 1000.00 (available 5000.00), buy 20 at 50.00: notional 1000.00, fee 0.00, debit 1000.00; available -> 4000.00.
- DURING_SESSION: Touch test for T-2026-01-12-SYN: low 49.00 > stop 46 -> False; high 51.00 < target 60 -> False.
- AFTER_CLOSE: Signal: condition FALSE, decision NO_ENTRY.
- AFTER_CLOSE: Daily record: equity = available 4000.00 + reserved 0.00 + receivables 0.00 + positions 1000.00 = 5000.00.

### 2026-01-13

- DURING_SESSION: Touch test for T-2026-01-12-SYN: low 49.00 > stop 46 -> False; high 51.00 < target 60 -> False.
- AFTER_CLOSE: Signal: condition FALSE, decision NO_ENTRY.
- AFTER_CLOSE: Daily record: equity = available 4000.00 + reserved 0.00 + receivables 0.00 + positions 1000.00 = 5000.00.

### 2026-01-14

- DURING_SESSION: Touch test for T-2026-01-12-SYN: low 49.00 > stop 46 -> False; high 51.00 < target 60 -> False.
- AFTER_CLOSE: Signal: condition FALSE, decision NO_ENTRY.
- AFTER_CLOSE: Daily record: equity = available 4000.00 + reserved 0.00 + receivables 0.00 + positions 1000.00 = 5000.00.

### 2026-01-15

- DURING_SESSION: Touch test for T-2026-01-12-SYN: low 49.00 > stop 46 -> False; high 51.00 < target 60 -> False.
- AFTER_CLOSE: Signal: condition FALSE, decision SKIPPED (NO_NEXT_SESSION).
- AFTER_CLOSE: Daily record: equity = available 4000.00 + reserved 0.00 + receivables 0.00 + positions 1000.00 = 5000.00.
- AFTER_CLOSE: End of run: no forced liquidation; 1 open trade(s) valued at the last close.

### Journal sequence numbers

Fills and ledger lines share one counter: 0 RESERVE, 1 RELEASE, 2 BUY fill, 3 FILL_BUY.

### Outcome

The run completes. Open trades stay OPEN_AT_END and are valued at the last close.

## Hand check

- The signal at index 4 reserves 1000.00; the entry fills at the OPEN of index 5, which is the ex-date of a 1.00 dividend. The
  entitled quantity is the quantity held at the start of BEFORE_OPEN of the ex-date: 0 (the entry fills later, at OPEN). Receivable =
  floor(0 * 1.00) = 0.00: no receivable and no ledger line. The action is still recorded as applied at BEFORE_OPEN of index 5.
- Available stays 4000.00 (5000.00 - 20 * 50.00) at every later close, equity 5000.00.

The oracle asserts these hand-derived values against its own output (a disagreement stops the run and is resolved by re-reading the specification, never by copying a value):

- `fills.0.session` = `2026-01-12` (the entry fills at the open of the ex-date)
- `daily.5.receivables` = `0.00` (an ex-date buyer is not entitled)
- `final.receivables` = `0.00` (still none)
- `final.cash_available` = `4000.00` (no dividend cash)

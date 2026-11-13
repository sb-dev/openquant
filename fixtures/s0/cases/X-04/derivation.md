# X-04: Cap below one lot: skipped, reservation released, no backfill, leftover cash reused

Origin: derived by `fixtures/s0/oracle/oracle.py` from OQ-02 sections 2.1 to 2.6 and the declared policy semantics; the oracle uses exact rational arithmetic and never reads the Rust engine. Status: hand-checked (see the last section). Covers: Cash and quantities.

## Design

Fourteen sessions with initial capital 400.00. The first intent cannot afford one share at the open and is skipped with its reservation released; the second signal, at a lower price, finds the released cash available and buys one share.

## Inputs

- Strategy: `strategy.json` (strategy hash `sha256:2375a8e7f2e0aded49774ec51611741145c3eca96d34354d86c9f7bc9eeb41c3`).
- Input hash binding in `input.json`: `sha256:2375a8e7f2e0aded49774ec51611741145c3eca96d34354d86c9f7bc9eeb41c3`.
- Policy: price scale 2, quantity scale 0, money scale 2, diagnostic scale 4, lot size 1; fixed fee 1.00 per fill, 0 bps, gap-exit slippage 0 bps; dividend withholding 0 bps.
- Windows: warm-up from 2026-01-05, scored from 2026-01-08, run ends after 2026-01-22; 14 calendar sessions, 14 bars; initial capital 400.00.

| Session | Open | High | Low | Close | Volume |
| --- | --- | --- | --- | --- | --- |
| 2026-01-05 | 85 | 86 | 84 | 85 | 1000 |
| 2026-01-06 | 85 | 86 | 84 | 85 | 1000 |
| 2026-01-07 | 85 | 86 | 84 | 85 | 1000 |
| 2026-01-08 | 85 | 86 | 84 | 85 | 1000 |
| 2026-01-09 | 85 | 86.5 | 84.5 | 86 | 1000 |
| 2026-01-12 | 85 | 86 | 84 | 85 | 1000 |
| 2026-01-13 | 85 | 85 | 83 | 83 | 1000 |
| 2026-01-14 | 83 | 83 | 81 | 81 | 1000 |
| 2026-01-15 | 81 | 81 | 79 | 79 | 1000 |
| 2026-01-16 | 79 | 79 | 77 | 77 | 1000 |
| 2026-01-19 | 77 | 77 | 75 | 75 | 1000 |
| 2026-01-20 | 75 | 77 | 75 | 77 | 1000 |
| 2026-01-21 | 75 | 76 | 74 | 75 | 1000 |
| 2026-01-22 | 75 | 76 | 74 | 75 | 1000 |

## Step-by-step derivation

### 2026-01-05

- AFTER_CLOSE: Signal: condition MISSING, decision SKIPPED (NOT_SCORED_YET).
- AFTER_CLOSE: Daily record: equity = available 400.00 + reserved 0.00 + receivables 0.00 + positions 0.00 = 400.00.

### 2026-01-06

- AFTER_CLOSE: Signal: condition MISSING, decision SKIPPED (NOT_SCORED_YET).
- AFTER_CLOSE: Daily record: equity = available 400.00 + reserved 0.00 + receivables 0.00 + positions 0.00 = 400.00.

### 2026-01-07

- AFTER_CLOSE: Signal: condition FALSE, decision SKIPPED (NOT_SCORED_YET).
- AFTER_CLOSE: Daily record: equity = available 400.00 + reserved 0.00 + receivables 0.00 + positions 0.00 = 400.00.

### 2026-01-08

- AFTER_CLOSE: Signal: condition FALSE, decision NO_ENTRY.
- AFTER_CLOSE: Daily record: equity = available 400.00 + reserved 0.00 + receivables 0.00 + positions 0.00 = 400.00.

### 2026-01-09

- AFTER_CLOSE: Indicator sma3 = mean of the last 3 close values (indices 2..4): sum 256 / 3 = 256/3 -> 85.3333
- AFTER_CLOSE: Indicator atr3: true ranges (indices 2..4) sum to 6; ATR = 6 / 3 = 2 -> 2.0000
- AFTER_CLOSE: Decision: condition TRUE, not held, vacant slots 5 - 0 - 0 = 5. cap = floor(available 400.00 / 5) = 80.00.
- AFTER_CLOSE: Reserve 80.00: available -> 320.00, reserved -> 80.00; rank 1.0000; snapshots entry_atr=2.
- AFTER_CLOSE: Signal: condition TRUE, decision ENTER.
- AFTER_CLOSE: Daily record: equity = available 320.00 + reserved 80.00 + receivables 0.00 + positions 0.00 = 400.00.

### 2026-01-12

- OPEN: Size intent I-2026-01-09-SYN: cap 80.00, open 85.00, lot 1, fee(n) = ceil(1 + n * 0/10000). Largest lot multiple that fits: .
- OPEN: Quantity 0: SKIPPED CAP_BELOW_ONE_LOT. Reservation 80.00 released, no backfill; available -> 400.00.
- AFTER_CLOSE: Signal: condition FALSE, decision NO_ENTRY.
- AFTER_CLOSE: Daily record: equity = available 400.00 + reserved 0.00 + receivables 0.00 + positions 0.00 = 400.00.

### 2026-01-13

- AFTER_CLOSE: Signal: condition FALSE, decision NO_ENTRY.
- AFTER_CLOSE: Daily record: equity = available 400.00 + reserved 0.00 + receivables 0.00 + positions 0.00 = 400.00.

### 2026-01-14

- AFTER_CLOSE: Signal: condition FALSE, decision NO_ENTRY.
- AFTER_CLOSE: Daily record: equity = available 400.00 + reserved 0.00 + receivables 0.00 + positions 0.00 = 400.00.

### 2026-01-15

- AFTER_CLOSE: Signal: condition FALSE, decision NO_ENTRY.
- AFTER_CLOSE: Daily record: equity = available 400.00 + reserved 0.00 + receivables 0.00 + positions 0.00 = 400.00.

### 2026-01-16

- AFTER_CLOSE: Signal: condition FALSE, decision NO_ENTRY.
- AFTER_CLOSE: Daily record: equity = available 400.00 + reserved 0.00 + receivables 0.00 + positions 0.00 = 400.00.

### 2026-01-19

- AFTER_CLOSE: Signal: condition FALSE, decision NO_ENTRY.
- AFTER_CLOSE: Daily record: equity = available 400.00 + reserved 0.00 + receivables 0.00 + positions 0.00 = 400.00.

### 2026-01-20

- AFTER_CLOSE: Indicator sma3 = mean of the last 3 close values (indices 9..11): sum 229 / 3 = 229/3 -> 76.3333
- AFTER_CLOSE: Indicator atr3: true ranges (indices 9..11) sum to 6; ATR = 6 / 3 = 2 -> 2.0000
- AFTER_CLOSE: Decision: condition TRUE, not held, vacant slots 5 - 0 - 0 = 5. cap = floor(available 400.00 / 5) = 80.00.
- AFTER_CLOSE: Reserve 80.00: available -> 320.00, reserved -> 80.00; rank 1.0000; snapshots entry_atr=2.
- AFTER_CLOSE: Signal: condition TRUE, decision ENTER.
- AFTER_CLOSE: Daily record: equity = available 320.00 + reserved 80.00 + receivables 0.00 + positions 0.00 = 400.00.

### 2026-01-21

- OPEN: Size intent I-2026-01-20-SYN: cap 80.00, open 75.00, lot 1, fee(n) = ceil(1 + n * 0/10000). Largest lot multiple that fits: q=1: 75.00 + fee 1.00 = 76.00 <= cap 80.00.
- OPEN: Levels from the signal-session snapshots (entry_atr=2): stop 71, target 85; need 0 < stop < entry 75.00 < target.
- OPEN: Release cap 80.00 (available 400.00), buy 1 at 75.00: notional 75.00, fee 1.00, debit 76.00; available -> 324.00.
- DURING_SESSION: Touch test for T-2026-01-21-SYN: low 74.00 > stop 71 -> False; high 76.00 < target 85 -> False.
- AFTER_CLOSE: Signal: condition FALSE, decision NO_ENTRY.
- AFTER_CLOSE: Daily record: equity = available 324.00 + reserved 0.00 + receivables 0.00 + positions 75.00 = 399.00.

### 2026-01-22

- DURING_SESSION: Touch test for T-2026-01-21-SYN: low 74.00 > stop 71 -> False; high 76.00 < target 85 -> False.
- AFTER_CLOSE: Signal: condition FALSE, decision SKIPPED (NO_NEXT_SESSION).
- AFTER_CLOSE: Daily record: equity = available 324.00 + reserved 0.00 + receivables 0.00 + positions 75.00 = 399.00.
- AFTER_CLOSE: End of run: no forced liquidation; 1 open trade(s) valued at the last close.

### Journal sequence numbers

Fills and ledger lines share one counter: 0 RESERVE, 1 RELEASE, 2 RESERVE, 3 RELEASE, 4 BUY fill, 5 FILL_BUY.

### Outcome

The run completes. Open trades stay OPEN_AT_END and are valued at the last close.

## Hand check

- Capital 400.00: cap = floor(400.00 / 5) = 80.00 at both closes. First signal (index 4, close 86 > SMA3 85.3333): open
  85.00, one share costs 85.00 + 1.00 = 86.00 > 80.00, so quantity 0: SKIPPED CAP_BELOW_ONE_LOT. The reservation of
  80.00 is released (available back to 400.00) and nothing else is bought (no backfill).
- Prices then fall by 2 per session to 75 (close below SMA3, no signals). At index 11 the close 77 > SMA3 (77 + 75 +
  77) / 3 = 76.3333: second signal, ATR3 = 2. Available is 400.00 again, so cap = 80.00 (not 64.00, which would be the
  cap had the first reservation not been released). Open 75.00: 75.00 + 1.00 = 76.00 <= 80.00, 2 shares = 151.00 > 80.00:
  quantity 1. Cash 400.00 - 76.00 = 324.00.

The oracle asserts these hand-derived values against its own output (a disagreement stops the run and is resolved by re-reading the specification, never by copying a value):

- `entries.0.cap` = `80.00` (floor(400.00 / 5))
- `entries.0.status` = `SKIPPED` (85.00 + 1.00 > 80.00)
- `entries.0.reason` = `CAP_BELOW_ONE_LOT` (no whole lot fits)
- `cash_ledger.1.available_after` = `400.00` (reservation released in full)
- `entries.1.cap` = `80.00` (the released cash is available again at the next close)
- `entries.1.quantity` = `1` (75.00 + 1.00 = 76.00 <= 80.00; 2 shares 151.00 > 80.00)
- `final.cash_available` = `324.00` (400.00 - 76.00)

# X-11: An intraday exit does not fund an opening entry; the next cap uses the cash at the next close

Origin: derived by `fixtures/s0/oracle/oracle.py` from OQ-02 sections 2.1 to 2.6 and the declared policy semantics; the oracle uses exact rational arithmetic and never reads the Rust engine. Status: hand-checked (see the last section). Covers: Entry and exit phases, Cash and quantities.

## Design

Eight sessions. The opening entry is filled with the cap frozen at the previous close; the position is stopped out intraday in the same session; the proceeds first appear in the cash that the next close reserves.

## Inputs

- Strategy: `strategy.json` (strategy hash `sha256:74613c408439ec8d807db8554e0258c26700ca6b5878a16718de05733a0a326d`).
- Input hash binding in `input.json`: `sha256:74613c408439ec8d807db8554e0258c26700ca6b5878a16718de05733a0a326d`.
- Policy: price scale 2, quantity scale 0, money scale 2, diagnostic scale 4, lot size 1; fixed fee 1.00 per fill, 0 bps, gap-exit slippage 0 bps; dividend withholding 0 bps.
- Windows: warm-up from 2026-01-05, scored from 2026-01-08, run ends after 2026-01-14; 8 calendar sessions, 8 bars; initial capital 5000.00.

| Session | Open | High | Low | Close | Volume |
| --- | --- | --- | --- | --- | --- |
| 2026-01-05 | 50 | 51 | 49 | 50 | 1000 |
| 2026-01-06 | 50 | 51 | 49 | 50 | 1000 |
| 2026-01-07 | 50 | 51 | 49 | 50 | 1000 |
| 2026-01-08 | 50 | 51 | 49 | 50 | 1000 |
| 2026-01-09 | 50 | 51.5 | 49.5 | 51 | 1000 |
| 2026-01-12 | 50 | 53 | 45 | 52 | 1000 |
| 2026-01-13 | 51 | 52 | 50 | 51 | 1000 |
| 2026-01-14 | 51 | 52 | 50 | 51 | 1000 |

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
- DURING_SESSION: Touch test for T-2026-01-12-SYN: low 45.00 <= stop 46 -> True; high 53.00 < target 60 -> False.
- DURING_SESSION: Sell 19 at 46.00 (STOP): notional 19 * 46.00 = 874.00; fee = ceil(1 + 874.00 * 0/10000) = 1.00; proceeds 874.00 - 1.00 = 873.00; available -> 4922.00.
- AFTER_CLOSE: Indicator sma3 = mean of the last 3 close values (indices 3..5): sum 153 / 3 = 51 -> 51.0000
- AFTER_CLOSE: Indicator atr3: true ranges (indices 3..5) sum to 12; ATR = 12 / 3 = 4 -> 4.0000
- AFTER_CLOSE: Decision: condition TRUE, not held, vacant slots 5 - 0 - 0 = 5. cap = floor(available 4922.00 / 5) = 984.40.
- AFTER_CLOSE: Reserve 984.40: available -> 3937.60, reserved -> 984.40; rank 1.0000; snapshots entry_atr=4.
- AFTER_CLOSE: Signal: condition TRUE, decision ENTER.
- AFTER_CLOSE: Daily record: equity = available 3937.60 + reserved 984.40 + receivables 0.00 + positions 0.00 = 4922.00.

### 2026-01-13

- OPEN: Size intent I-2026-01-12-SYN: cap 984.40, open 51.00, lot 1, fee(n) = ceil(1 + n * 0/10000). Largest lot multiple that fits: q=19: 969.00 + fee 1.00 = 970.00 <= cap 984.40.
- OPEN: Levels from the signal-session snapshots (entry_atr=4): stop 43, target 71; need 0 < stop < entry 51.00 < target.
- OPEN: Release cap 984.40 (available 4922.00), buy 19 at 51.00: notional 969.00, fee 1.00, debit 970.00; available -> 3952.00.
- DURING_SESSION: Touch test for T-2026-01-13-SYN: low 50.00 > stop 43 -> False; high 52.00 < target 71 -> False.
- AFTER_CLOSE: Signal: condition FALSE, decision NO_ENTRY.
- AFTER_CLOSE: Daily record: equity = available 3952.00 + reserved 0.00 + receivables 0.00 + positions 969.00 = 4921.00.

### 2026-01-14

- DURING_SESSION: Touch test for T-2026-01-13-SYN: low 50.00 > stop 43 -> False; high 52.00 < target 71 -> False.
- AFTER_CLOSE: Signal: condition FALSE, decision SKIPPED (NO_NEXT_SESSION).
- AFTER_CLOSE: Daily record: equity = available 3952.00 + reserved 0.00 + receivables 0.00 + positions 969.00 = 4921.00.
- AFTER_CLOSE: End of run: no forced liquidation; 1 open trade(s) valued at the last close.

### Journal sequence numbers

Fills and ledger lines share one counter: 0 RESERVE, 1 RELEASE, 2 BUY fill, 3 FILL_BUY, 4 SELL fill, 5 FILL_SELL, 6 RESERVE, 7 RELEASE, 8 BUY fill, 9 FILL_BUY.

### Outcome

The run completes. Open trades stay OPEN_AT_END and are valued at the last close.

## Hand check

- Signal at index 4: cap floor(5000.00 / 5) = 1000.00, frozen at the close. Open 50.00: 19 shares (950.00 + 1.00). The opening
  entry is sized from this cap alone: it cannot use cash from the exit that happens later in the same session.
- Index 5 bar (50, 53, 45, 52): the new position is protected during its own session; low 45 <= stop 46 and high 53 < target
  60, so STOP at 46.00 with proceeds 19 * 46.00 - 1.00 = 873.00. Available 4049.00 + 873.00 = 4922.00.
- The close of index 5 is a fresh decision (SMA3 = (50 + 51 + 52) / 3 = 51 < 52; true ranges 2, 2, 8 give ATR3 = 4). The new
  cap uses the cash available at that close: floor(4922.00 / 5) = 984.40. Next open 51.00: 19 shares cost 969.00 + 1.00 = 970.00.

The oracle asserts these hand-derived values against its own output (a disagreement stops the run and is resolved by re-reading the specification, never by copying a value):

- `entries.0.cap` = `1000.00` (cash at the first close: 5000.00 / 5)
- `entries.0.quantity` = `19` (950.00 + 1.00 <= 1000.00)
- `fills.1.reason` = `STOP` (newly filled position protected in its own session: low 45 <= 46)
- `fills.1.price` = `46.00` (stop level)
- `fills.1.cash_delta` = `873.00` (19 * 46.00 - 1.00)
- `entries.1.cap` = `984.40` (floor((5000.00 - 951.00 + 873.00 = 4922.00) / 5))
- `entries.1.quantity` = `19` (19 * 51 + 1 = 970.00 <= 984.40; 20 shares 1021.00)
- `daily.5.cash_reserved` = `984.40` (second reservation at the close of index 5)
- `daily.5.equity` = `4922.00` (5000.00 - 2 * 1.00 fees - 19 * 4.00 loss = 4922.00)

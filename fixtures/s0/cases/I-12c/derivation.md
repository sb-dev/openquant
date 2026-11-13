# I-12c: Control: a target of about 5e24 is below 2^96, so the run holds the position to the end and completes

Origin: derived by `fixtures/s0/oracle/oracle.py` from OQ-02 sections 2.1 to 2.6 and the declared policy semantics; the oracle uses exact rational arithmetic and never reads the Rust engine. Status: hand-checked (see the last section). Covers: Invalid inputs.

## Design

Eight sessions on the bars of G-10 to G-13b. The target is entry_price * K * K with K = 999999999999: 5 * K^2 = 4999999999990000000000005, about 5 * 10^24 and below 2^96. It has a decimal view and a checkpoint form, so the run completes: 199 shares are bought at the open of index 5 and held to the end, and the final open position states the target 4999999999990000000000005. The control of I-12a: the same expression with one factor K fewer.

## Inputs

- Strategy: `strategy.json` (strategy hash `sha256:dd38b65e40eca9e7f07753121bb7b84dbf89ddfae691ecfe339fa1ff413bbdc0`).
- Input hash binding in `input.json`: `sha256:dd38b65e40eca9e7f07753121bb7b84dbf89ddfae691ecfe339fa1ff413bbdc0`.
- Policy: price scale 2, quantity scale 0, money scale 2, diagnostic scale 4, lot size 1; fixed fee 1.00 per fill, 0 bps, gap-exit slippage 0 bps; dividend withholding 0 bps.
- Windows: warm-up from 2026-01-05, scored from 2026-01-08, run ends after 2026-01-14; 8 calendar sessions, 8 bars; initial capital 5000.00.

| Session | Open | High | Low | Close | Volume |
| --- | --- | --- | --- | --- | --- |
| 2026-01-05 | 5 | 5.1 | 4.9 | 5 | 1000 |
| 2026-01-06 | 5 | 5.1 | 4.9 | 5 | 1000 |
| 2026-01-07 | 5 | 5.1 | 4.9 | 5 | 1000 |
| 2026-01-08 | 5 | 5.1 | 4.9 | 5 | 1000 |
| 2026-01-09 | 5 | 5.16 | 4.9 | 5.05 | 1000 |
| 2026-01-12 | 5 | 5.1 | 4.9 | 5 | 1000 |
| 2026-01-13 | 5 | 5.1 | 4.9 | 5 | 1000 |
| 2026-01-14 | 5 | 5.1 | 4.9 | 5 | 1000 |

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
- AFTER_CLOSE: Indicator atr3: true ranges (indices 2..4) sum to 0.66; ATR = 0.66 / 3 = 0.22 -> 0.2200
- AFTER_CLOSE: Decision: condition TRUE, not held, vacant slots 5 - 0 - 0 = 5. cap = floor(available 5000.00 / 5) = 1000.00.
- AFTER_CLOSE: Reserve 1000.00: available -> 4000.00, reserved -> 1000.00; rank 1.0000; snapshots entry_atr=0.22.
- AFTER_CLOSE: Signal: condition TRUE, decision ENTER.
- AFTER_CLOSE: Daily record: equity = available 4000.00 + reserved 1000.00 + receivables 0.00 + positions 0.00 = 5000.00.

### 2026-01-12

- OPEN: Size intent I-2026-01-09-SYN: cap 1000.00, open 5.00, lot 1, fee(n) = ceil(1 + n * 0/10000). Largest lot multiple that fits: q=200: 1000.00 + fee 1.00 = 1001.00 > cap 1000.00; q=199: 995.00 + fee 1.00 = 996.00 <= cap 1000.00.
- OPEN: Levels from the signal-session snapshots (entry_atr=0.22): stop 4.56, target 4999999999990000000000005; need 0 < stop < entry 5.00 < target.
- OPEN: Release cap 1000.00 (available 5000.00), buy 199 at 5.00: notional 995.00, fee 1.00, debit 996.00; available -> 4004.00.
- DURING_SESSION: Touch test for T-2026-01-12-SYN: low 4.90 > stop 4.56 -> False; high 5.10 < target 4999999999990000000000005 -> False.
- AFTER_CLOSE: Signal: condition FALSE, decision NO_ENTRY.
- AFTER_CLOSE: Daily record: equity = available 4004.00 + reserved 0.00 + receivables 0.00 + positions 995.00 = 4999.00.

### 2026-01-13

- DURING_SESSION: Touch test for T-2026-01-12-SYN: low 4.90 > stop 4.56 -> False; high 5.10 < target 4999999999990000000000005 -> False.
- AFTER_CLOSE: Signal: condition FALSE, decision NO_ENTRY.
- AFTER_CLOSE: Daily record: equity = available 4004.00 + reserved 0.00 + receivables 0.00 + positions 995.00 = 4999.00.

### 2026-01-14

- DURING_SESSION: Touch test for T-2026-01-12-SYN: low 4.90 > stop 4.56 -> False; high 5.10 < target 4999999999990000000000005 -> False.
- AFTER_CLOSE: Signal: condition FALSE, decision SKIPPED (NO_NEXT_SESSION).
- AFTER_CLOSE: Daily record: equity = available 4004.00 + reserved 0.00 + receivables 0.00 + positions 995.00 = 4999.00.
- AFTER_CLOSE: End of run: no forced liquidation; 1 open trade(s) valued at the last close.

### Journal sequence numbers

Fills and ledger lines share one counter: 0 RESERVE, 1 RELEASE, 2 BUY fill, 3 FILL_BUY.

### Outcome

The run completes. Open trades stay OPEN_AT_END and are valued at the last close.

## Hand check

1. ATR3 window, indices 2, 3, 4. Indices 2 and 3 are (5, 5.10, 4.90, 5): true range max(0.20, 0.10, 0.10) = 0.20 each. Index 4 is (5, 5.16, 4.90, 5.05): max(0.26, 0.16, 0.10) = 0.26. The sum is 0.66 and ATR3 = 0.66 / 3 = 0.22 exactly. The close 5.05 is above SMA3 = (5 + 5 + 5.05) / 3 = 5.0166...: entry intent with cap floor(5000.00 / 5) = 1000.00.
2. The constant K = 999999999999 = 10^12 - 1 is a RATIO constant. K * K = 10^24 - 2 * 10^12 + 1 = 999999999998000000000001 and K * K * K = 10^36 - 3 * 10^24 + 3 * 10^12 - 1 = 999999999997000000000002999999999999. The limit is 2^96 = 79228162514264337593543950336, about 7.92 * 10^28: a level, snapshot or scheduled stop whose integer part is 2^96 or more has no decimal view and no checkpoint form, and a run never holds one (OQ-02 section 2.5).
3. The signal at the close of index 4 reserves 1000.00 (available 4000.00, reserved 1000.00).
4. Index 5 opens at 5.00 with a fixed fee of 1.00 and no bps fee: 200 shares cost 1000.00 + 1.00 = 1001.00 > 1000.00; 199 shares cost 995.00 + 1.00 = 996.00 <= 1000.00. Quantity 199; the reservation is released (available 5000.00) and 996.00 is debited: available 4004.00, reserved 0.00.
5. Levels. The target is entry_price * K * K = 5 * 999999999998000000000001 = 4999999999990000000000005, about 5 * 10^24. That is below 2^96 = 79228162514264337593543950336 (about 7.92 * 10^28), so it has a decimal view and a checkpoint form and the run holds it. The stop is 5 - 2 * 0.22 = 4.56. The level check 0 < 4.56 < 5.00 < 4999999999990000000000005 holds.
6. Indices 5, 6 and 7 are (5, 5.10, 4.90, 5): the open 5.00 is above the stop and below the target (no gap), the low 4.90 is above 4.56 and the high 5.10 is below 4999999999990000000000005 (no touch). The position is held to the end and stays open (OPEN_AT_END). Value at the last close: 199 * 5.00 = 995.00; equity 4004.00 + 995.00 = 4999.00. The final open position states the stop 4.56 and the target 4999999999990000000000005.

The oracle asserts these hand-derived values against its own output (a disagreement stops the run and is resolved by re-reading the specification, never by copying a value):

- `outcome.status` = `COMPLETED` (every level is below 2^96)
- `entries.0.quantity` = `199` (200 shares 1001.00 > 1000.00; 199 shares 996.00)
- `fills.0.cash_delta` = `-996.00` (-(995.00 + 1.00))
- `daily.5.cash_available` = `4004.00` (5000.00 - 996.00)
- `daily.5.positions.0.stop` = `4.56` (5 - 2 * 0.22)
- `daily.5.positions.0.target` = `4999999999990000000000005` (5 * K * K)
- `trades.0.exit_reason` = `OPEN_AT_END` (no exit touched)
- `final.cash_available` = `4004.00` (5000.00 - 996.00)
- `final.positions_value` = `995.00` (199 * 5.00)
- `final.equity` = `4999.00` (4004.00 + 995.00)
- `final.open_positions.0.quantity` = `199` (held to the end)
- `final.open_positions.0.stop` = `4.56` (5 - 2 * 0.22)
- `final.open_positions.0.target` = `4999999999990000000000005` (5 * K * K, below 2^96)

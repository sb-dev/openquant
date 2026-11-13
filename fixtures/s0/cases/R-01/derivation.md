# R-01: Rich replay: three trades, a break-even stop, a 2-for-1 split on a pending entry and a taxed dividend

Origin: derived by `fixtures/s0/oracle/oracle.py` from OQ-02 sections 2.1 to 2.6 and the declared policy semantics; the oracle uses exact rational arithmetic and never reads the Rust engine. Status: hand-checked (see the last section). Covers: Local replay, Split across an ex-date, Cash dividend, Entry and exit phases, Shared payloads.

## Design

Twenty sessions with costs 1.00 fixed + 10 bps, 50 bps gap slippage and 10 percent dividend withholding. Trade 1 (index 5) schedules a break-even stop at the close of index 6 and is stopped at the entry price at index 7. Trade 2 (index 12) hits its target at index 13, whose close raises a new entry (ATR 10) that is pending across the 2-for-1 split of index 14: the snapshot becomes 5, the cap and rank stay fixed, the raw open is 52.00 and trade 3 is sized from the cap. Trade 3 fires its break-even rule at the close of index 16 (scheduled stop effective at index 17), goes ex-dividend at index 17 (0.333 per share, withholding 1000 bps, floor to cents, payable at OPEN of index 18) and stays open at the end. The replay harness restores from every cut point, including cuts inside the pending-entry window, with a scheduled stop, with a receivable outstanding and after the split was applied at BEFORE_OPEN, and compares the result to this uninterrupted derivation.

## Inputs

- Strategy: `strategy.json` (strategy hash `sha256:c97f31955e671836a670a22128c1edbf07d8c60191f3df8312e6ee389e349dae`).
- Input hash binding in `input.json`: `sha256:c97f31955e671836a670a22128c1edbf07d8c60191f3df8312e6ee389e349dae`.
- Policy: price scale 2, quantity scale 0, money scale 2, diagnostic scale 4, lot size 1; fixed fee 1.00 per fill, 10 bps, gap-exit slippage 50 bps; dividend withholding 1000 bps.
- Windows: warm-up from 2026-01-05, scored from 2026-01-08, run ends after 2026-01-30; 20 calendar sessions, 20 bars; initial capital 10000.00.
- Corporate action: `{"action_id": "SPLIT-2-1", "available_at": "2026-01-23T06:00:00Z", "effective_session": "2026-01-23", "kind": "SPLIT", "ratio_new": 2, "ratio_old": 1}`.
- Corporate action: `{"action_id": "DIV-1", "amount_per_share": "0.333", "available_at": "2026-01-28T06:00:00Z", "effective_session": "2026-01-28", "kind": "CASH_DIVIDEND", "payment_phase": "OPEN", "payment_session": "2026-01-29"}`.
- Note on the policy: withholding 1000 bps = 10 percent.

| Session | Open | High | Low | Close | Volume |
| --- | --- | --- | --- | --- | --- |
| 2026-01-05 | 100 | 102 | 98 | 100 | 1000 |
| 2026-01-06 | 100 | 102 | 98 | 100 | 1000 |
| 2026-01-07 | 100 | 102 | 98 | 100 | 1000 |
| 2026-01-08 | 100 | 102 | 98 | 100 | 1000 |
| 2026-01-09 | 100 | 103 | 99 | 101 | 1000 |
| 2026-01-12 | 100 | 102 | 98 | 100 | 1000 |
| 2026-01-13 | 100 | 104 | 99 | 102 | 1000 |
| 2026-01-14 | 101 | 102 | 99.5 | 100.5 | 1000 |
| 2026-01-15 | 100 | 102 | 98 | 100 | 1000 |
| 2026-01-16 | 100 | 102 | 98 | 100 | 1000 |
| 2026-01-19 | 100 | 102 | 98 | 100 | 1000 |
| 2026-01-20 | 100 | 103 | 99 | 101 | 1000 |
| 2026-01-21 | 100 | 102 | 98 | 100 | 1000 |
| 2026-01-22 | 100 | 121 | 99 | 105 | 1000 |
| 2026-01-23 | 52 | 54 | 51 | 53 | 1000 |
| 2026-01-26 | 53 | 55 | 52 | 54 | 1000 |
| 2026-01-27 | 54 | 57 | 53 | 56 | 1000 |
| 2026-01-28 | 56 | 58 | 54 | 57 | 1000 |
| 2026-01-29 | 57 | 58 | 55 | 56 | 1000 |
| 2026-01-30 | 56 | 57 | 55 | 56 | 1000 |

## Step-by-step derivation

### 2026-01-05

- AFTER_CLOSE: Signal: condition MISSING, decision SKIPPED (NOT_SCORED_YET).
- AFTER_CLOSE: Daily record: equity = available 10000.00 + reserved 0.00 + receivables 0.00 + positions 0.00 = 10000.00.

### 2026-01-06

- AFTER_CLOSE: Signal: condition MISSING, decision SKIPPED (NOT_SCORED_YET).
- AFTER_CLOSE: Daily record: equity = available 10000.00 + reserved 0.00 + receivables 0.00 + positions 0.00 = 10000.00.

### 2026-01-07

- AFTER_CLOSE: Signal: condition FALSE, decision SKIPPED (NOT_SCORED_YET).
- AFTER_CLOSE: Daily record: equity = available 10000.00 + reserved 0.00 + receivables 0.00 + positions 0.00 = 10000.00.

### 2026-01-08

- AFTER_CLOSE: Signal: condition FALSE, decision NO_ENTRY.
- AFTER_CLOSE: Daily record: equity = available 10000.00 + reserved 0.00 + receivables 0.00 + positions 0.00 = 10000.00.

### 2026-01-09

- AFTER_CLOSE: Indicator sma3 = mean of the last 3 close values (indices 2..4): sum 301 / 3 = 301/3 -> 100.3333
- AFTER_CLOSE: Indicator atr3: true ranges (indices 2..4) sum to 12; ATR = 12 / 3 = 4 -> 4.0000
- AFTER_CLOSE: Decision: condition TRUE, not held, vacant slots 5 - 0 - 0 = 5. cap = floor(available 10000.00 / 5) = 2000.00.
- AFTER_CLOSE: Reserve 2000.00: available -> 8000.00, reserved -> 2000.00; rank 1.0000; snapshots entry_atr=4.
- AFTER_CLOSE: Signal: condition TRUE, decision ENTER.
- AFTER_CLOSE: Daily record: equity = available 8000.00 + reserved 2000.00 + receivables 0.00 + positions 0.00 = 10000.00.

### 2026-01-12

- OPEN: Size intent I-2026-01-09-SYN: cap 2000.00, open 100.00, lot 1, fee(n) = ceil(1 + n * 10/10000). Largest lot multiple that fits: q=20: 2000.00 + fee 3.00 = 2003.00 > cap 2000.00; q=19: 1900.00 + fee 2.90 = 1902.90 <= cap 2000.00.
- OPEN: Levels from the signal-session snapshots (entry_atr=4): stop 92, target 120; need 0 < stop < entry 100.00 < target.
- OPEN: Release cap 2000.00 (available 10000.00), buy 19 at 100.00: notional 1900.00, fee 2.90, debit 1902.90; available -> 8097.10.
- DURING_SESSION: Touch test for T-2026-01-12-SYN: low 98.00 > stop 92 -> False; high 102.00 < target 120 -> False.
- AFTER_CLOSE: Stop adjustment break_even for T-2026-01-12-SYN: trigger (raw high 102.00 vs entry 100 + snapshot) = False.
- AFTER_CLOSE: Signal: condition FALSE, decision NO_ENTRY.
- AFTER_CLOSE: Daily record: equity = available 8097.10 + reserved 0.00 + receivables 0.00 + positions 1900.00 = 9997.10.

### 2026-01-13

- DURING_SESSION: Touch test for T-2026-01-12-SYN: low 99.00 > stop 92 -> False; high 104.00 < target 120 -> False.
- AFTER_CLOSE: Stop adjustment break_even for T-2026-01-12-SYN: trigger (raw high 104.00 vs entry 100 + snapshot) = True.
- AFTER_CLOSE: Fired once: new stop level 100 scheduled, effective 2026-01-14 before the open; the current stop 92 stays active until then.
- AFTER_CLOSE: Indicator sma3 = mean of the last 3 close values (indices 4..6): sum 303 / 3 = 101 -> 101.0000
- AFTER_CLOSE: Indicator atr3: true ranges (indices 4..6) sum to 13; ATR = 13 / 3 = 13/3 -> 4.3333
- AFTER_CLOSE: Signal: condition TRUE, decision SKIPPED (HELD).
- AFTER_CLOSE: Daily record: equity = available 8097.10 + reserved 0.00 + receivables 0.00 + positions 1938.00 = 10035.10.

### 2026-01-14

- BEFORE_OPEN: Activate the scheduled stop of T-2026-01-12-SYN: stop 92 -> 100 (effective 2026-01-14).
- DURING_SESSION: Touch test for T-2026-01-12-SYN: low 99.50 <= stop 100 -> True; high 102.00 < target 120 -> False.
- DURING_SESSION: Sell 19 at 100.00 (STOP): notional 19 * 100.00 = 1900.00; fee = ceil(1 + 1900.00 * 10/10000) = 2.90; proceeds 1900.00 - 2.90 = 1897.10; available -> 9994.20.
- AFTER_CLOSE: Signal: condition FALSE, decision NO_ENTRY.
- AFTER_CLOSE: Daily record: equity = available 9994.20 + reserved 0.00 + receivables 0.00 + positions 0.00 = 9994.20.

### 2026-01-15

- AFTER_CLOSE: Signal: condition FALSE, decision NO_ENTRY.
- AFTER_CLOSE: Daily record: equity = available 9994.20 + reserved 0.00 + receivables 0.00 + positions 0.00 = 9994.20.

### 2026-01-16

- AFTER_CLOSE: Signal: condition FALSE, decision NO_ENTRY.
- AFTER_CLOSE: Daily record: equity = available 9994.20 + reserved 0.00 + receivables 0.00 + positions 0.00 = 9994.20.

### 2026-01-19

- AFTER_CLOSE: Signal: condition FALSE, decision NO_ENTRY.
- AFTER_CLOSE: Daily record: equity = available 9994.20 + reserved 0.00 + receivables 0.00 + positions 0.00 = 9994.20.

### 2026-01-20

- AFTER_CLOSE: Indicator sma3 = mean of the last 3 close values (indices 9..11): sum 301 / 3 = 301/3 -> 100.3333
- AFTER_CLOSE: Indicator atr3: true ranges (indices 9..11) sum to 12; ATR = 12 / 3 = 4 -> 4.0000
- AFTER_CLOSE: Decision: condition TRUE, not held, vacant slots 5 - 0 - 0 = 5. cap = floor(available 9994.20 / 5) = 1998.84.
- AFTER_CLOSE: Reserve 1998.84: available -> 7995.36, reserved -> 1998.84; rank 1.0000; snapshots entry_atr=4.
- AFTER_CLOSE: Signal: condition TRUE, decision ENTER.
- AFTER_CLOSE: Daily record: equity = available 7995.36 + reserved 1998.84 + receivables 0.00 + positions 0.00 = 9994.20.

### 2026-01-21

- OPEN: Size intent I-2026-01-20-SYN: cap 1998.84, open 100.00, lot 1, fee(n) = ceil(1 + n * 10/10000). Largest lot multiple that fits: q=19: 1900.00 + fee 2.90 = 1902.90 <= cap 1998.84.
- OPEN: Levels from the signal-session snapshots (entry_atr=4): stop 92, target 120; need 0 < stop < entry 100.00 < target.
- OPEN: Release cap 1998.84 (available 9994.20), buy 19 at 100.00: notional 1900.00, fee 2.90, debit 1902.90; available -> 8091.30.
- DURING_SESSION: Touch test for T-2026-01-21-SYN: low 98.00 > stop 92 -> False; high 102.00 < target 120 -> False.
- AFTER_CLOSE: Stop adjustment break_even for T-2026-01-21-SYN: trigger (raw high 102.00 vs entry 100 + snapshot) = False.
- AFTER_CLOSE: Signal: condition FALSE, decision NO_ENTRY.
- AFTER_CLOSE: Daily record: equity = available 8091.30 + reserved 0.00 + receivables 0.00 + positions 1900.00 = 9991.30.

### 2026-01-22

- DURING_SESSION: Touch test for T-2026-01-21-SYN: low 99.00 > stop 92 -> False; high 121.00 >= target 120 -> True.
- DURING_SESSION: Sell 19 at 120.00 (TARGET): notional 19 * 120.00 = 2280.00; fee = ceil(1 + 2280.00 * 10/10000) = 3.28; proceeds 2280.00 - 3.28 = 2276.72; available -> 10368.02.
- AFTER_CLOSE: Indicator sma3 = mean of the last 3 close values (indices 11..13): sum 306 / 3 = 102 -> 102.0000
- AFTER_CLOSE: Indicator atr3: true ranges (indices 11..13) sum to 30; ATR = 30 / 3 = 10 -> 10.0000
- AFTER_CLOSE: Decision: condition TRUE, not held, vacant slots 5 - 0 - 0 = 5. cap = floor(available 10368.02 / 5) = 2073.60.
- AFTER_CLOSE: Reserve 2073.60: available -> 8294.42, reserved -> 2073.60; rank 1.0000; snapshots entry_atr=10.
- AFTER_CLOSE: Signal: condition TRUE, decision ENTER.
- AFTER_CLOSE: Daily record: equity = available 8294.42 + reserved 2073.60 + receivables 0.00 + positions 0.00 = 10368.02.

### 2026-01-23

- BEFORE_OPEN: Split SPLIT-2-1: ratio r = 2/1 = 2, applied exactly once.
- BEFORE_OPEN: Pending intent I-2026-01-22-SYN: snapshots entry_atr=10 -> entry_atr=5; cap 2073.60 and rank unchanged.
- OPEN: Size intent I-2026-01-22-SYN: cap 2073.60, open 52.00, lot 1, fee(n) = ceil(1 + n * 10/10000). Largest lot multiple that fits: q=39: 2028.00 + fee 3.03 = 2031.03 <= cap 2073.60.
- OPEN: Levels from the signal-session snapshots (entry_atr=5): stop 42, target 77; need 0 < stop < entry 52.00 < target.
- OPEN: Release cap 2073.60 (available 10368.02), buy 39 at 52.00: notional 2028.00, fee 3.03, debit 2031.03; available -> 8336.99.
- DURING_SESSION: Touch test for T-2026-01-23-SYN: low 51.00 > stop 42 -> False; high 54.00 < target 77 -> False.
- AFTER_CLOSE: Stop adjustment break_even for T-2026-01-23-SYN: trigger (raw high 54.00 vs entry 52 + snapshot) = False.
- AFTER_CLOSE: Indicator sma3 = mean of the last 3 close values (indices 12..14): sum 155.5 / 3 = 311/6 -> 51.8333
- AFTER_CLOSE: Indicator atr3: true ranges (indices 12..14) sum to 16; ATR = 16 / 3 = 16/3 -> 5.3333
- AFTER_CLOSE: Signal: condition TRUE, decision SKIPPED (HELD).
- AFTER_CLOSE: Daily record: equity = available 8336.99 + reserved 0.00 + receivables 0.00 + positions 2067.00 = 10403.99.

### 2026-01-26

- DURING_SESSION: Touch test for T-2026-01-23-SYN: low 52.00 > stop 42 -> False; high 55.00 < target 77 -> False.
- AFTER_CLOSE: Stop adjustment break_even for T-2026-01-23-SYN: trigger (raw high 55.00 vs entry 52 + snapshot) = False.
- AFTER_CLOSE: Indicator sma3 = mean of the last 3 close values (indices 13..15): sum 159.5 / 3 = 319/6 -> 53.1667
- AFTER_CLOSE: Indicator atr3: true ranges (indices 13..15) sum to 17; ATR = 17 / 3 = 17/3 -> 5.6667
- AFTER_CLOSE: Signal: condition TRUE, decision SKIPPED (HELD).
- AFTER_CLOSE: Daily record: equity = available 8336.99 + reserved 0.00 + receivables 0.00 + positions 2106.00 = 10442.99.

### 2026-01-27

- DURING_SESSION: Touch test for T-2026-01-23-SYN: low 53.00 > stop 42 -> False; high 57.00 < target 77 -> False.
- AFTER_CLOSE: Stop adjustment break_even for T-2026-01-23-SYN: trigger (raw high 57.00 vs entry 52 + snapshot) = True.
- AFTER_CLOSE: Fired once: new stop level 52 scheduled, effective 2026-01-28 before the open; the current stop 42 stays active until then.
- AFTER_CLOSE: Indicator sma3 = mean of the last 3 close values (indices 14..16): sum 163 / 3 = 163/3 -> 54.3333
- AFTER_CLOSE: Indicator atr3: true ranges (indices 14..16) sum to 10; ATR = 10 / 3 = 10/3 -> 3.3333
- AFTER_CLOSE: Signal: condition TRUE, decision SKIPPED (HELD).
- AFTER_CLOSE: Daily record: equity = available 8336.99 + reserved 0.00 + receivables 0.00 + positions 2184.00 = 10520.99.

### 2026-01-28

- BEFORE_OPEN: Dividend DIV-1: entitled quantity (held at the start of BEFORE_OPEN, before any split) 39 * 0.333 per share * (1 - 1000/10000) = 11.6883; floor to money scale -> 11.68.
- BEFORE_OPEN: Receivable 11.68 due at 2026-01-29 OPEN; counts in equity, not in available cash.
- BEFORE_OPEN: Activate the scheduled stop of T-2026-01-23-SYN: stop 42 -> 52 (effective 2026-01-28).
- DURING_SESSION: Touch test for T-2026-01-23-SYN: low 54.00 > stop 52 -> False; high 58.00 < target 77 -> False.
- AFTER_CLOSE: Indicator sma3 = mean of the last 3 close values (indices 15..17): sum 167 / 3 = 167/3 -> 55.6667
- AFTER_CLOSE: Indicator atr3: true ranges (indices 15..17) sum to 11; ATR = 11 / 3 = 11/3 -> 3.6667
- AFTER_CLOSE: Signal: condition TRUE, decision SKIPPED (HELD).
- AFTER_CLOSE: Daily record: equity = available 8336.99 + reserved 0.00 + receivables 11.68 + positions 2223.00 = 10571.67.

### 2026-01-29

- OPEN: Pay receivable of action DIV-1: available += 11.68 -> 8348.67, receivables -> 0.00.
- DURING_SESSION: Touch test for T-2026-01-23-SYN: low 55.00 > stop 52 -> False; high 58.00 < target 77 -> False.
- AFTER_CLOSE: Signal: condition FALSE, decision NO_ENTRY.
- AFTER_CLOSE: Daily record: equity = available 8348.67 + reserved 0.00 + receivables 0.00 + positions 2184.00 = 10532.67.

### 2026-01-30

- DURING_SESSION: Touch test for T-2026-01-23-SYN: low 55.00 > stop 52 -> False; high 57.00 < target 77 -> False.
- AFTER_CLOSE: Signal: condition FALSE, decision SKIPPED (NO_NEXT_SESSION).
- AFTER_CLOSE: Daily record: equity = available 8348.67 + reserved 0.00 + receivables 0.00 + positions 2184.00 = 10532.67.
- AFTER_CLOSE: End of run: no forced liquidation; 1 open trade(s) valued at the last close.

### Journal sequence numbers

Fills and ledger lines share one counter: 0 RESERVE, 1 RELEASE, 2 BUY fill, 3 FILL_BUY, 4 SELL fill, 5 FILL_SELL, 6 RESERVE, 7 RELEASE, 8 BUY fill, 9 FILL_BUY, 10 SELL fill, 11 FILL_SELL, 12 RESERVE, 13 RELEASE, 14 BUY fill, 15 FILL_BUY, 16 DIVIDEND_RECEIVABLE, 17 DIVIDEND_PAYMENT.

### Outcome

The run completes. Open trades stay OPEN_AT_END and are valued at the last close.

## Hand check

Trade 1. Signal at index 4: ATR 4, cap = floor(10000.00 / 5) = 2000.00. Open 100.00, fee(n) = ceil(1.00 + n * 10/10000): 20 shares cost
2000.00 + 3.00 > 2000.00; 19 shares cost 1900.00 + ceil(2.90) = 1902.90. Cash 8097.10. Index 6 high 104 >= 100 + 4: scheduled stop 100,
effective index 7. Index 7 opens at 101 (above 100), low 99.50 touches 100: STOP at 100.00, proceeds 1900.00 - 2.90 = 1897.10, cash 9994.20.

Trade 2. Signal at index 11: cap = floor(9994.20 / 5) = 1998.84; 19 shares again (1902.90). Cash 8091.30. Index 13 high 121 >= 120: TARGET
at 120.00, proceeds 2280.00 - ceil(1.00 + 2.28) = 2276.72, cash 10368.02. The close of index 13 is a new signal (SMA3 = (101 + 100 + 105) / 3 = 102
< 105; true ranges 4, 4, 22 give ATR 10): cap = floor(10368.02 / 5) = floor(2073.604) = 2073.60.

Trade 3. Index 14 is the ex-date of a 2-for-1 split: the pending snapshot becomes 10 / 2 = 5; cap 2073.60 and rank 1 are unchanged. Raw
open 52.00: 39 shares (2028.00 + ceil(1.00 + 2.028) = 2031.03 <= 2073.60; 40 shares 2080.00 > cap). Stop 52 - 10 = 42, target 52 + 25 = 77.
Cash 10368.02 - 2031.03 = 8336.99. Index 16 high 57 >= 52 + 5: scheduled stop 52, effective index 17. Index 17 is ex-dividend 0.333 per
share with 10 percent withholding: receivable floor(39 * 0.333 * 0.9) = floor(11.6883) = 11.68, paid at OPEN of index 18: cash 8348.67. The
position stays open: 39 * 56.00 = 2184.00, final equity 10532.67.

The oracle asserts these hand-derived values against its own output (a disagreement stops the run and is resolved by re-reading the specification, never by copying a value):

- `entries.0.cap` = `2000.00` (floor(10000.00 / 5))
- `entries.0.quantity` = `19` (19 * 100 + ceil(1.00 + 1.90) = 1902.90 <= 2000.00; 20 shares 2000.00 + 3.00 > 2000.00)
- `fills.1.reason` = `STOP` (break-even stop 100 touched at index 7)
- `fills.1.cash_delta` = `1897.10` (1900.00 - ceil(1.00 + 1.90) = 1900.00 - 2.90)
- `entries.1.cap` = `1998.84` (floor(9994.20 / 5))
- `fills.3.reason` = `TARGET` (high 121 >= 120 at index 13)
- `fills.3.cash_delta` = `2276.72` (2280.00 - ceil(1.00 + 2.28) = 2280.00 - 3.28)
- `entries.2.cap` = `2073.60` (floor(10368.02 / 5), frozen across the split)
- `entries.2.quantity` = `39` (39 * 52.00 + ceil(1.00 + 2.028) = 2031.03 <= 2073.60; 40 shares 2080.00 > 2073.60)
- `fills.4.cash_delta` = `-2031.03` (-(2028.00 + 3.03))
- `daily.14.positions.0.snapshots.0.value` = `5` (signal ATR 10 / 2)
- `daily.14.positions.0.stop` = `42` (52 - 2 * 5)
- `daily.14.positions.0.target` = `77` (52 + 5 * 5)
- `daily.16.positions.0.scheduled_stop.level` = `52` (break-even at the close of index 16)
- `daily.17.receivables` = `11.68` (floor(39 * 0.333 * 0.9) = floor(11.6883))
- `daily.17.positions.0.stop` = `52` (scheduled stop activated at BEFORE_OPEN of index 17)
- `daily.18.cash_available` = `8348.67` (8336.99 + 11.68 paid at OPEN of index 18)
- `final.equity` = `10532.67` (8348.67 + 39 * 56.00)

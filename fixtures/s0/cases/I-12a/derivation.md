# I-12a: Level with no decimal view: a target of about 5e36 fails the run at the entry open, the event is discarded

Origin: derived by `fixtures/s0/oracle/oracle.py` from OQ-02 sections 2.1 to 2.6 and the declared policy semantics; the oracle uses exact rational arithmetic and never reads the Rust engine. Status: hand-checked (see the last section). Covers: Invalid inputs.

## Design

Eight sessions on the bars of G-10 to G-13b (ATR3 = 0.22 exactly). The target is entry_price * K * K * K with the RATIO constant K = 999999999999: 5 * K^3 = 4999999999985000000000014999999999995, about 5 * 10^36 and at least 2^96. The value is exact as a fraction but has no decimal view and no checkpoint form, so the run fails with FAILED ARITHMETIC_OVERFLOW at OPEN of index 5, before any fill. The whole event is discarded: the journal keeps the reservation made at the close of index 4 (entry RESERVED, one RESERVE line) and no fill.

## Inputs

- Strategy: `strategy.json` (strategy hash `sha256:f3d5c2403937a6f87946d713ee2dfa2a6565d03e7331de4e6a23d91d5d9dfd08`).
- Input hash binding in `input.json`: `sha256:f3d5c2403937a6f87946d713ee2dfa2a6565d03e7331de4e6a23d91d5d9dfd08`.
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

- OPEN: FAILURE FAILED ARITHMETIC_OVERFLOW: the target of T-2026-01-12-SYN is 4999999999985000000000014999999999995, whose integer part is 79228162514264337593543950336 (2**96) or more: no decimal view and no checkpoint form, so the event is discarded. Journal kept through the last completed event.

### Journal sequence numbers

Fills and ledger lines share one counter: 0 RESERVE.

### Outcome

The run stops with status FAILED, code ARITHMETIC_OVERFLOW at 2026-01-12 OPEN. The expected journal is the journal through the last completed event.

## Hand check

1. ATR3 window, indices 2, 3, 4. Indices 2 and 3 are (5, 5.10, 4.90, 5): true range max(0.20, 0.10, 0.10) = 0.20 each. Index 4 is (5, 5.16, 4.90, 5.05): max(0.26, 0.16, 0.10) = 0.26. The sum is 0.66 and ATR3 = 0.66 / 3 = 0.22 exactly. The close 5.05 is above SMA3 = (5 + 5 + 5.05) / 3 = 5.0166...: entry intent with cap floor(5000.00 / 5) = 1000.00.
2. The constant K = 999999999999 = 10^12 - 1 is a RATIO constant. K * K = 10^24 - 2 * 10^12 + 1 = 999999999998000000000001 and K * K * K = 10^36 - 3 * 10^24 + 3 * 10^12 - 1 = 999999999997000000000002999999999999. The limit is 2^96 = 79228162514264337593543950336, about 7.92 * 10^28: a level, snapshot or scheduled stop whose integer part is 2^96 or more has no decimal view and no checkpoint form, and a run never holds one (OQ-02 section 2.5).
3. The signal at the close of index 4 holds the snapshot entry_atr = 0.22 and reserves 1000.00 (available 4000.00, reserved 1000.00, ledger line 0 RESERVE). Nothing here is large yet.
4. Index 5 opens at 5.00. The target is entry_price * K * K * K = 5 * 999999999997000000000002999999999999 = 4999999999985000000000014999999999995, about 5 * 10^36. That is at least 2^96 = 79228162514264337593543950336 (5 * 10^36 / 7.92 * 10^28 is about 6.3 * 10^7), so it has no decimal view and no checkpoint form. The stop is 5 - 2 * 0.22 = 4.56. The level check 0 < 4.56 < 5.00 < 4999999999985000000000014999999999995 holds, so this is not INVALID_LEVEL; the position would still hold the target.
5. The OPEN event of index 5 would leave that target in the state, so the run fails with FAILED ARITHMETIC_OVERFLOW at OPEN of index 5. The whole event is discarded, as for INVALID_LEVEL in I-03: no fill, no release, no debit, no ledger line. The journal keeps the close of index 4: entry I-2026-01-09-SYN stays RESERVED (cap 1000.00), the ledger has the one RESERVE line (seq 0, available 4000.00, reserved 1000.00), there is no fill, and the daily records stop at index 4 (cash 4000.00, reserved 1000.00, no position).

The oracle asserts these hand-derived values against its own output (a disagreement stops the run and is resolved by re-reading the specification, never by copying a value):

- `outcome.status` = `FAILED` (the target has no decimal view)
- `outcome.code` = `ARITHMETIC_OVERFLOW` (5 * K^3 >= 2^96)
- `outcome.at.session` = `2026-01-12` (the entry open, index 5)
- `outcome.at.phase` = `OPEN` (the event that creates the level)
- `entries.0.status` = `RESERVED` (the failed OPEN event is discarded)
- `entries.0.cap` = `1000.00` (floor(5000.00 / 5))
- `cash_ledger.0.kind` = `RESERVE` (the only ledger line)
- `cash_ledger.0.available_after` = `4000.00` (5000.00 - 1000.00)
- `cash_ledger.0.reserved_after` = `1000.00` (the reservation stays)
- `daily.4.cash_available` = `4000.00` (the last daily record is index 4)
- `daily.4.cash_reserved` = `1000.00` (the reservation stays)

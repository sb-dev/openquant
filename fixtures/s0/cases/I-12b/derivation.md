# I-12b: Snapshot with no decimal view: a snapshot of about 5e36 fails the run at the signal close, the event is discarded

Origin: derived by `fixtures/s0/oracle/oracle.py` from OQ-02 sections 2.1 to 2.6 and the declared policy semantics; the oracle uses exact rational arithmetic and never reads the Rust engine. Status: hand-checked (see the last section). Covers: Invalid inputs.

## Design

Eight sessions on the bars of G-10 to G-13b. The default exits (stop 2 * ATR, target 5 * ATR) and one extra entry snapshot, big = close * K * K * K with K = 999999999999 (unit PRICE). At the signal close of index 4, big = 5.05 * K^3, about 5.05 * 10^36 and at least 2^96: it has no decimal view and no checkpoint form, so the run fails with FAILED ARITHMETIC_OVERFLOW at AFTER_CLOSE of index 4. The whole event is discarded: the journal keeps only indices 0 to 3 (no entry record, no reservation, no ledger line).

## Inputs

- Strategy: `strategy.json` (strategy hash `sha256:2b35e38a892f8a3783397ee9196cfeaf909ede3a1a1187fb89c958e4af33d26c`).
- Input hash binding in `input.json`: `sha256:2b35e38a892f8a3783397ee9196cfeaf909ede3a1a1187fb89c958e4af33d26c`.
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

- AFTER_CLOSE: Indicator sma3 = mean of the last 3 close values (indices 1..3): sum 15 / 3 = 5 -> 5.0000
- AFTER_CLOSE: Indicator atr3: true ranges (indices 1..3) sum to 0.6; ATR = 0.6 / 3 = 0.2 -> 0.2000
- AFTER_CLOSE: Signal: condition FALSE, decision NO_ENTRY.
- AFTER_CLOSE: Daily record: equity = available 5000.00 + reserved 0.00 + receivables 0.00 + positions 0.00 = 5000.00.

### 2026-01-09

- AFTER_CLOSE: FAILURE FAILED ARITHMETIC_OVERFLOW: the snapshot big of intent I-2026-01-09-SYN is 5049999999984850000000015149999999994.95, whose integer part is 79228162514264337593543950336 (2**96) or more: no decimal view and no checkpoint form, so the event is discarded. Journal kept through the last completed event.

### Outcome

The run stops with status FAILED, code ARITHMETIC_OVERFLOW at 2026-01-09 AFTER_CLOSE. The expected journal is the journal through the last completed event.

## Hand check

1. ATR3 window, indices 2, 3, 4. Indices 2 and 3 are (5, 5.10, 4.90, 5): true range max(0.20, 0.10, 0.10) = 0.20 each. Index 4 is (5, 5.16, 4.90, 5.05): max(0.26, 0.16, 0.10) = 0.26. The sum is 0.66 and ATR3 = 0.66 / 3 = 0.22 exactly. The close 5.05 is above SMA3 = (5 + 5 + 5.05) / 3 = 5.0166...: entry intent with cap floor(5000.00 / 5) = 1000.00.
2. The constant K = 999999999999 = 10^12 - 1 is a RATIO constant. K * K = 10^24 - 2 * 10^12 + 1 = 999999999998000000000001 and K * K * K = 10^36 - 3 * 10^24 + 3 * 10^12 - 1 = 999999999997000000000002999999999999. The limit is 2^96 = 79228162514264337593543950336, about 7.92 * 10^28: a level, snapshot or scheduled stop whose integer part is 2^96 or more has no decimal view and no checkpoint form, and a run never holds one (OQ-02 section 2.5).
3. The entry snapshots are entry_atr = ATR3 and big = close * K * K * K, taken at the signal session. At indices 0 to 3 the condition is MISSING or FALSE (close 5 is not above SMA3 = 5), so no snapshot is taken and no value is held; the sessions complete.
4. At the close of index 4 the condition is TRUE and big = 5.05 * 999999999997000000000002999999999999 = 100999999999697000000000302999999999899 / 20 = 5049999999984850000000015149999999994.95, about 5.05 * 10^36 and at least 2^96 = 79228162514264337593543950336. The AFTER_CLOSE event of index 4 would leave that snapshot in the entry intent, so the run fails with FAILED ARITHMETIC_OVERFLOW at AFTER_CLOSE of index 4.
5. The whole event is discarded: no signal record and no daily record for index 4, no entry record, no reservation (available stays 5000.00, reserved 0.00) and no ledger line. The journal keeps indices 0 to 3: four signal records, four daily records of 5000.00 in cash, no entry, no fill and no ledger line.

The oracle asserts these hand-derived values against its own output (a disagreement stops the run and is resolved by re-reading the specification, never by copying a value):

- `outcome.status` = `FAILED` (the snapshot has no decimal view)
- `outcome.code` = `ARITHMETIC_OVERFLOW` (5.05 * K^3 >= 2^96)
- `outcome.at.session` = `2026-01-09` (the signal session, index 4)
- `outcome.at.phase` = `AFTER_CLOSE` (the event that takes the snapshot)
- `signals.3.session` = `2026-01-08` (the last completed signal is index 3)
- `signals.3.decision` = `NO_ENTRY` (close 5 is not above SMA3 = 5)
- `daily.3.cash_available` = `5000.00` (no reservation was made)
- `daily.3.cash_reserved` = `0.00` (no reservation was made)

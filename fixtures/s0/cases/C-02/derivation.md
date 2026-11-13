# C-02: Fractional entitlement: 3-for-2 split on 7 shares is INSUFFICIENT

Origin: derived by `fixtures/s0/oracle/oracle.py` from OQ-02 sections 2.1 to 2.6 and the declared policy semantics; the oracle uses exact rational arithmetic and never reads the Rust engine. Status: hand-checked (see the last section). Covers: Split across an ex-date, Invalid inputs.

## Design

Nine sessions. The entry buys 7 shares at 142.00 (cap 1000.00: 994.00 + 1.00 = 995.00; 8 shares cost 1136.00 + 1.00). At the ex-date of a 3-for-2 split, 7 * 3 / 2 = 10.5 shares: a fractional entitlement with no declared cash-in-lieu. The run stops at BEFORE_OPEN of the ex-date with INSUFFICIENT FRACTIONAL_ENTITLEMENT; the action is not recorded as applied and the journal keeps everything through the close of index 6.

## Inputs

- Strategy: `strategy.json` (strategy hash `sha256:403bd951e256f09c8fdc5140badfefbc1d2514b65380d6259066d8f25d0653f2`).
- Input hash binding in `input.json`: `sha256:403bd951e256f09c8fdc5140badfefbc1d2514b65380d6259066d8f25d0653f2`.
- Policy: price scale 2, quantity scale 0, money scale 2, diagnostic scale 4, lot size 1; fixed fee 1.00 per fill, 0 bps, gap-exit slippage 0 bps; dividend withholding 0 bps.
- Windows: warm-up from 2026-01-05, scored from 2026-01-08, run ends after 2026-01-15; 9 calendar sessions, 9 bars; initial capital 5000.00.
- Corporate action: `{"action_id": "SPLIT-3-2", "available_at": "2026-01-14T06:00:00Z", "effective_session": "2026-01-14", "kind": "SPLIT", "ratio_new": 3, "ratio_old": 2}`.

| Session | Open | High | Low | Close | Volume |
| --- | --- | --- | --- | --- | --- |
| 2026-01-05 | 142 | 144 | 140 | 142 | 1000 |
| 2026-01-06 | 142 | 144 | 140 | 142 | 1000 |
| 2026-01-07 | 142 | 144 | 140 | 142 | 1000 |
| 2026-01-08 | 142 | 144 | 140 | 142 | 1000 |
| 2026-01-09 | 142 | 145 | 141 | 143 | 1000 |
| 2026-01-12 | 142 | 144 | 140 | 142 | 1000 |
| 2026-01-13 | 142 | 144 | 140 | 142 | 1000 |
| 2026-01-14 | 95 | 97 | 93 | 95 | 1000 |
| 2026-01-15 | 95 | 97 | 93 | 95 | 1000 |

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

- AFTER_CLOSE: Indicator sma3 = mean of the last 3 close values (indices 2..4): sum 427 / 3 = 427/3 -> 142.3333
- AFTER_CLOSE: Indicator atr3: true ranges (indices 2..4) sum to 12; ATR = 12 / 3 = 4 -> 4.0000
- AFTER_CLOSE: Decision: condition TRUE, not held, vacant slots 5 - 0 - 0 = 5. cap = floor(available 5000.00 / 5) = 1000.00.
- AFTER_CLOSE: Reserve 1000.00: available -> 4000.00, reserved -> 1000.00; rank 1.0000; snapshots entry_atr=4.
- AFTER_CLOSE: Signal: condition TRUE, decision ENTER.
- AFTER_CLOSE: Daily record: equity = available 4000.00 + reserved 1000.00 + receivables 0.00 + positions 0.00 = 5000.00.

### 2026-01-12

- OPEN: Size intent I-2026-01-09-SYN: cap 1000.00, open 142.00, lot 1, fee(n) = ceil(1 + n * 0/10000). Largest lot multiple that fits: q=7: 994.00 + fee 1.00 = 995.00 <= cap 1000.00.
- OPEN: Levels from the signal-session snapshots (entry_atr=4): stop 134, target 162; need 0 < stop < entry 142.00 < target.
- OPEN: Release cap 1000.00 (available 5000.00), buy 7 at 142.00: notional 994.00, fee 1.00, debit 995.00; available -> 4005.00.
- DURING_SESSION: Touch test for T-2026-01-12-SYN: low 140.00 > stop 134 -> False; high 144.00 < target 162 -> False.
- AFTER_CLOSE: Signal: condition FALSE, decision NO_ENTRY.
- AFTER_CLOSE: Daily record: equity = available 4005.00 + reserved 0.00 + receivables 0.00 + positions 994.00 = 4999.00.

### 2026-01-13

- DURING_SESSION: Touch test for T-2026-01-12-SYN: low 140.00 > stop 134 -> False; high 144.00 < target 162 -> False.
- AFTER_CLOSE: Signal: condition FALSE, decision NO_ENTRY.
- AFTER_CLOSE: Daily record: equity = available 4005.00 + reserved 0.00 + receivables 0.00 + positions 994.00 = 4999.00.

### 2026-01-14

- BEFORE_OPEN: FAILURE INSUFFICIENT FRACTIONAL_ENTITLEMENT: split SPLIT-3-2: quantity 7 * 3 / 2 = 10.5 is not a whole share. Journal kept through the last completed event.

### Journal sequence numbers

Fills and ledger lines share one counter: 0 RESERVE, 1 RELEASE, 2 BUY fill, 3 FILL_BUY.

### Outcome

The run stops with status INSUFFICIENT, code FRACTIONAL_ENTITLEMENT at 2026-01-14 BEFORE_OPEN. The expected journal is the journal through the last completed event.

### Detail expectation

OQ-02 section 2.5 requires an INSUFFICIENT result to report the instrument, the event, the missing evidence and the affected period. `outcome.detail` must contain each of these strings (`expect.outcome_detail_includes`): `SYN`, `SPLIT-3-2`, `2026-01-14`. They come from the case input only: the instrument id, the id of the split and its effective session date. The expectation fixes the facts the text must name, not its wording.

## Hand check

- Cap 1000.00, open 142.00, fee 1.00: 7 shares = 994.00 + 1.00 = 995.00 <= 1000.00; 8 shares = 1136.00 + 1.00 > 1000.00. The split multiplies 7 by 3/2 = 10.5, which is not a whole share, so the evidence is insufficient; nothing is rounded.

The oracle asserts these hand-derived values against its own output (a disagreement stops the run and is resolved by re-reading the specification, never by copying a value):

- `fills.0.quantity` = `7` (7 * 142.00 + 1.00 = 995.00 <= 1000.00)
- `outcome.at.phase` = `BEFORE_OPEN` (the failing event)

# C-01b: Split on a pending entry: cap 1000 buys 20 shares at raw open 50, ATR 4 becomes 2

Origin: derived by `fixtures/s0/oracle/oracle.py` from OQ-02 sections 2.1 to 2.6 and the declared policy semantics; the oracle uses exact rational arithmetic and never reads the Rust engine. Status: hand-checked (see the last section). Covers: Split across an ex-date.

## Design

Eight sessions. The close of index 4 reserves 1000.00; the 2-for-1 split is effective at index 5, before the intended fill. The entry is sized from the frozen cap at the new raw open.

## Inputs

- Strategy: `strategy.json` (strategy hash `sha256:cf735f849711138c3de84a38954571a752765cd72c8194e2d82e6aa3b1ea0042`).
- Input hash binding in `input.json`: `sha256:cf735f849711138c3de84a38954571a752765cd72c8194e2d82e6aa3b1ea0042`.
- Policy: price scale 2, quantity scale 0, money scale 2, diagnostic scale 4, lot size 1; fixed fee 0 per fill, 0 bps, gap-exit slippage 0 bps; dividend withholding 0 bps.
- Windows: warm-up from 2026-01-05, scored from 2026-01-08, run ends after 2026-01-14; 8 calendar sessions, 8 bars; initial capital 5000.00.
- Corporate action: `{"action_id": "SPLIT-2-1", "available_at": "2026-01-12T06:00:00Z", "effective_session": "2026-01-12", "kind": "SPLIT", "ratio_new": 2, "ratio_old": 1}`.

| Session | Open | High | Low | Close | Volume |
| --- | --- | --- | --- | --- | --- |
| 2026-01-05 | 100 | 102 | 98 | 100 | 1000 |
| 2026-01-06 | 100 | 102 | 98 | 100 | 1000 |
| 2026-01-07 | 100 | 102 | 98 | 100 | 1000 |
| 2026-01-08 | 100 | 102 | 98 | 100 | 1000 |
| 2026-01-09 | 100 | 103 | 99 | 101 | 1000 |
| 2026-01-12 | 50 | 52 | 48 | 50 | 1000 |
| 2026-01-13 | 50 | 52 | 48 | 50 | 1000 |
| 2026-01-14 | 50 | 52 | 48 | 50 | 1000 |

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

- AFTER_CLOSE: Indicator sma3 = mean of the last 3 close values (indices 2..4): sum 301 / 3 = 301/3 -> 100.3333
- AFTER_CLOSE: Indicator atr3: true ranges (indices 2..4) sum to 12; ATR = 12 / 3 = 4 -> 4.0000
- AFTER_CLOSE: Decision: condition TRUE, not held, vacant slots 5 - 0 - 0 = 5. cap = floor(available 5000.00 / 5) = 1000.00.
- AFTER_CLOSE: Reserve 1000.00: available -> 4000.00, reserved -> 1000.00; rank 1.0000; snapshots entry_atr=4.
- AFTER_CLOSE: Signal: condition TRUE, decision ENTER.
- AFTER_CLOSE: Daily record: equity = available 4000.00 + reserved 1000.00 + receivables 0.00 + positions 0.00 = 5000.00.

### 2026-01-12

- BEFORE_OPEN: Split SPLIT-2-1: ratio r = 2/1 = 2, applied exactly once.
- BEFORE_OPEN: Pending intent I-2026-01-09-SYN: snapshots entry_atr=4 -> entry_atr=2; cap 1000.00 and rank unchanged.
- OPEN: Size intent I-2026-01-09-SYN: cap 1000.00, open 50.00, lot 1, fee(n) = ceil(0 + n * 0/10000). Largest lot multiple that fits: q=20: 1000.00 + fee 0.00 = 1000.00 <= cap 1000.00.
- OPEN: Levels from the signal-session snapshots (entry_atr=2): stop 46, target 60; need 0 < stop < entry 50.00 < target.
- OPEN: Release cap 1000.00 (available 5000.00), buy 20 at 50.00: notional 1000.00, fee 0.00, debit 1000.00; available -> 4000.00.
- DURING_SESSION: Touch test for T-2026-01-12-SYN: low 48.00 > stop 46 -> False; high 52.00 < target 60 -> False.
- AFTER_CLOSE: Indicator sma3 = mean of the last 3 close values (indices 3..5): sum 150.5 / 3 = 301/6 -> 50.1667
- AFTER_CLOSE: Indicator atr3: true ranges (indices 3..5) sum to 8; ATR = 8 / 3 = 8/3 -> 2.6667
- AFTER_CLOSE: Signal: condition FALSE, decision NO_ENTRY.
- AFTER_CLOSE: Daily record: equity = available 4000.00 + reserved 0.00 + receivables 0.00 + positions 1000.00 = 5000.00.

### 2026-01-13

- DURING_SESSION: Touch test for T-2026-01-12-SYN: low 48.00 > stop 46 -> False; high 52.00 < target 60 -> False.
- AFTER_CLOSE: Signal: condition FALSE, decision NO_ENTRY.
- AFTER_CLOSE: Daily record: equity = available 4000.00 + reserved 0.00 + receivables 0.00 + positions 1000.00 = 5000.00.

### 2026-01-14

- DURING_SESSION: Touch test for T-2026-01-12-SYN: low 48.00 > stop 46 -> False; high 52.00 < target 60 -> False.
- AFTER_CLOSE: Signal: condition FALSE, decision SKIPPED (NO_NEXT_SESSION).
- AFTER_CLOSE: Daily record: equity = available 4000.00 + reserved 0.00 + receivables 0.00 + positions 1000.00 = 5000.00.
- AFTER_CLOSE: End of run: no forced liquidation; 1 open trade(s) valued at the last close.

### Journal sequence numbers

Fills and ledger lines share one counter: 0 RESERVE, 1 RELEASE, 2 BUY fill, 3 FILL_BUY.

### Outcome

The run completes. Open trades stay OPEN_AT_END and are valued at the last close.

## Hand check

- Index 4 signal: ATR3 = 4, rank 1, cap = floor(5000.00 / 5) = 1000.00 (reserved: available 4000.00, reserved 1000.00).
- Index 5 is the ex-date of a 2-for-1 split. BEFORE_OPEN converts the pending snapshot: entry_ATR 4 / 2 = 2; the cap 1000.00 and
  the rank 1 are unchanged.
- Raw open 50.00: with zero costs and lot 1, 1000.00 / 50.00 = 20 shares. Levels from the converted snapshot: stop 50 - 2 * 2 =
  46, target 50 + 5 * 2 = 60. Equity at the close (50): 4000.00 + 20 * 50.00 = 5000.00.

The oracle asserts these hand-derived values against its own output (a disagreement stops the run and is resolved by re-reading the specification, never by copying a value):

- `entries.0.rank` = `1` (frozen rank)
- `entries.0.cap` = `1000.00` (frozen cap)
- `entries.0.quantity` = `20` (1000.00 / raw open 50.00, zero costs)
- `fills.0.price` = `50.00` (raw open on the post-split basis)
- `daily.4.cash_reserved` = `1000.00` (reserved at the signal close)
- `daily.5.positions.0.snapshots.0.value` = `2` (signal ATR 4 / 2)
- `daily.5.positions.0.stop` = `46` (50 - 2 * 2)
- `daily.5.positions.0.target` = `60` (50 + 5 * 2)
- `daily.5.equity` = `5000.00` (4000.00 + 20 * 50.00)

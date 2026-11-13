# X-02a: Lot size 10 rounds the quantity down

Origin: derived by `fixtures/s0/oracle/oracle.py` from OQ-02 sections 2.1 to 2.6 and the declared policy semantics; the oracle uses exact rational arithmetic and never reads the Rust engine. Status: hand-checked (see the last section). Covers: Cash and quantities.

## Design

Eight sessions at price 36.00 with ATR 2.00. Lot size 10: the quantity is the largest lot multiple whose notional plus fee fits the frozen cap; it is never rounded to the nearest lot.

## Inputs

- Strategy: `strategy.json` (strategy hash `sha256:4249401d04d03a1874511a5f7218bfd588e0892fa6f9a0c6e4e9c0b4b1727054`).
- Input hash binding in `input.json`: `sha256:4249401d04d03a1874511a5f7218bfd588e0892fa6f9a0c6e4e9c0b4b1727054`.
- Policy: price scale 2, quantity scale 0, money scale 2, diagnostic scale 4, lot size 10; fixed fee 1.00 per fill, 0 bps, gap-exit slippage 0 bps; dividend withholding 0 bps.
- Windows: warm-up from 2026-01-05, scored from 2026-01-08, run ends after 2026-01-14; 8 calendar sessions, 8 bars; initial capital 5000.00.

| Session | Open | High | Low | Close | Volume |
| --- | --- | --- | --- | --- | --- |
| 2026-01-05 | 36 | 37 | 35 | 36 | 1000 |
| 2026-01-06 | 36 | 37 | 35 | 36 | 1000 |
| 2026-01-07 | 36 | 37 | 35 | 36 | 1000 |
| 2026-01-08 | 36 | 37 | 35 | 36 | 1000 |
| 2026-01-09 | 36 | 37.5 | 35.5 | 37 | 1000 |
| 2026-01-12 | 36 | 37 | 35 | 36 | 1000 |
| 2026-01-13 | 36 | 37 | 35 | 36 | 1000 |
| 2026-01-14 | 36 | 37 | 35 | 36 | 1000 |

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

- AFTER_CLOSE: Indicator sma3 = mean of the last 3 close values (indices 2..4): sum 109 / 3 = 109/3 -> 36.3333
- AFTER_CLOSE: Indicator atr3: true ranges (indices 2..4) sum to 6; ATR = 6 / 3 = 2 -> 2.0000
- AFTER_CLOSE: Decision: condition TRUE, not held, vacant slots 5 - 0 - 0 = 5. cap = floor(available 5000.00 / 5) = 1000.00.
- AFTER_CLOSE: Reserve 1000.00: available -> 4000.00, reserved -> 1000.00; rank 1.0000; snapshots entry_atr=2.
- AFTER_CLOSE: Signal: condition TRUE, decision ENTER.
- AFTER_CLOSE: Daily record: equity = available 4000.00 + reserved 1000.00 + receivables 0.00 + positions 0.00 = 5000.00.

### 2026-01-12

- OPEN: Size intent I-2026-01-09-SYN: cap 1000.00, open 36.00, lot 10, fee(n) = ceil(1 + n * 0/10000). Largest lot multiple that fits: q=20: 720.00 + fee 1.00 = 721.00 <= cap 1000.00.
- OPEN: Levels from the signal-session snapshots (entry_atr=2): stop 32, target 46; need 0 < stop < entry 36.00 < target.
- OPEN: Release cap 1000.00 (available 5000.00), buy 20 at 36.00: notional 720.00, fee 1.00, debit 721.00; available -> 4279.00.
- DURING_SESSION: Touch test for T-2026-01-12-SYN: low 35.00 > stop 32 -> False; high 37.00 < target 46 -> False.
- AFTER_CLOSE: Signal: condition FALSE, decision NO_ENTRY.
- AFTER_CLOSE: Daily record: equity = available 4279.00 + reserved 0.00 + receivables 0.00 + positions 720.00 = 4999.00.

### 2026-01-13

- DURING_SESSION: Touch test for T-2026-01-12-SYN: low 35.00 > stop 32 -> False; high 37.00 < target 46 -> False.
- AFTER_CLOSE: Signal: condition FALSE, decision NO_ENTRY.
- AFTER_CLOSE: Daily record: equity = available 4279.00 + reserved 0.00 + receivables 0.00 + positions 720.00 = 4999.00.

### 2026-01-14

- DURING_SESSION: Touch test for T-2026-01-12-SYN: low 35.00 > stop 32 -> False; high 37.00 < target 46 -> False.
- AFTER_CLOSE: Signal: condition FALSE, decision SKIPPED (NO_NEXT_SESSION).
- AFTER_CLOSE: Daily record: equity = available 4279.00 + reserved 0.00 + receivables 0.00 + positions 720.00 = 4999.00.
- AFTER_CLOSE: End of run: no forced liquidation; 1 open trade(s) valued at the last close.

### Journal sequence numbers

Fills and ledger lines share one counter: 0 RESERVE, 1 RELEASE, 2 BUY fill, 3 FILL_BUY.

### Outcome

The run completes. Open trades stay OPEN_AT_END and are valued at the last close.

## Hand check

- Cap = floor(5000.00 / 5) = 1000.00. Open 36.00, lot 10, fee 1.00 fixed: one lot costs 360.00 + 1.00. 2 lots = 720.00 +
  1.00 = 721.00 <= 1000.00; 3 lots = 1080.00 + 1.00 > 1000.00. 1000.00 / 360.00 = 2.78 lots rounds DOWN to 2 lots (20
  shares), not to the nearest 3. Cash 5000.00 - 721.00 = 4279.00.

The oracle asserts these hand-derived values against its own output (a disagreement stops the run and is resolved by re-reading the specification, never by copying a value):

- `entries.0.quantity` = `20` (2.77 lots of 10 round down to 2 lots)
- `fills.0.cash_delta` = `-721.00` (-(20 * 36.00 + 1.00))
- `final.cash_available` = `4279.00` (5000.00 - 721.00)

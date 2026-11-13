# G-13: Split round trip off the grid: stop touched at exactly 4.78 after a 17-for-2 split and its reverse

Origin: derived by `fixtures/s0/oracle/oracle.py` from OQ-02 sections 2.1 to 2.6 and the declared policy semantics; the oracle uses exact rational arithmetic and never reads the Rust engine. Status: hand-checked (see the last section). Covers: Split across an ex-date, Entry and exit phases.

## Design

12 sessions with zero fees. ATR3 = 0.22 is exact, so the stop 4.78 and the target 6.10 are on the grid before the splits. A 17-for-2 split at index 6 and its reverse at index 8 convert the quantity (200, 1700, 200 shares) and divide then multiply every level by 17/2. Between the splits the stop is 239/425 and the target 61/85, which have no finite decimal form (the denominators contain the prime factor 17), and the levels must still come back exactly. The ratio is a third one beside the 3-for-1 and 7-for-2 of G-10 to G-11b: a ratio whose conversion happens to round-trip under a rounded computation would not pin the rule. The stop is touched at exactly 4.78 after a 17-for-2 split and its reverse. The converted stop 239/425 is off the grid, and a stop that was divided and multiplied again with finitely many digits comes back one unit of the last digit off 4.78; if it comes back below, a low of exactly 4.78 misses it.

## Inputs

- Strategy: `strategy.json` (strategy hash `sha256:ddbc53cd94ee124549fe69e26a0200d1ac4e820f2ea24fb0a158999df697329b`).
- Input hash binding in `input.json`: `sha256:ddbc53cd94ee124549fe69e26a0200d1ac4e820f2ea24fb0a158999df697329b`.
- Policy: price scale 2, quantity scale 0, money scale 2, diagnostic scale 4, lot size 1; fixed fee 0 per fill, 0 bps, gap-exit slippage 100 bps; dividend withholding 0 bps.
- Windows: warm-up from 2026-01-05, scored from 2026-01-08, run ends after 2026-01-20; 12 calendar sessions, 12 bars; initial capital 5000.00.
- Corporate action: `{"action_id": "SPLIT-17-2", "available_at": "2026-01-13T06:00:00Z", "effective_session": "2026-01-13", "kind": "SPLIT", "ratio_new": 17, "ratio_old": 2}`.
- Corporate action: `{"action_id": "SPLIT-2-17", "available_at": "2026-01-15T06:00:00Z", "effective_session": "2026-01-15", "kind": "SPLIT", "ratio_new": 2, "ratio_old": 17}`.
- Note on the policy: the fixed fee is 0, so quantity and cash are whole numbers.

| Session | Open | High | Low | Close | Volume |
| --- | --- | --- | --- | --- | --- |
| 2026-01-05 | 5 | 5.1 | 4.9 | 5 | 1000 |
| 2026-01-06 | 5 | 5.1 | 4.9 | 5 | 1000 |
| 2026-01-07 | 5 | 5.1 | 4.9 | 5 | 1000 |
| 2026-01-08 | 5 | 5.1 | 4.9 | 5 | 1000 |
| 2026-01-09 | 5 | 5.16 | 4.9 | 5.05 | 1000 |
| 2026-01-12 | 5 | 5.1 | 4.9 | 5 | 1000 |
| 2026-01-13 | 0.59 | 0.65 | 0.57 | 0.59 | 1000 |
| 2026-01-14 | 0.59 | 0.65 | 0.57 | 0.58 | 1000 |
| 2026-01-15 | 5 | 5.1 | 4.9 | 5 | 1000 |
| 2026-01-16 | 5 | 6.09 | 4.79 | 5 | 1000 |
| 2026-01-19 | 5 | 5.1 | 4.78 | 4.85 | 1000 |
| 2026-01-20 | 5 | 5.1 | 4.9 | 5 | 1000 |

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

- OPEN: Size intent I-2026-01-09-SYN: cap 1000.00, open 5.00, lot 1, fee(n) = ceil(0 + n * 0/10000). Largest lot multiple that fits: q=200: 1000.00 + fee 0.00 = 1000.00 <= cap 1000.00.
- OPEN: Levels from the signal-session snapshots (entry_atr=0.22): stop 4.78, target 6.1; need 0 < stop < entry 5.00 < target.
- OPEN: Release cap 1000.00 (available 5000.00), buy 200 at 5.00: notional 1000.00, fee 0.00, debit 1000.00; available -> 4000.00.
- DURING_SESSION: Touch test for T-2026-01-12-SYN: low 4.90 > stop 4.78 -> False; high 5.10 < target 6.1 -> False.
- AFTER_CLOSE: Signal: condition FALSE, decision NO_ENTRY.
- AFTER_CLOSE: Daily record: equity = available 4000.00 + reserved 0.00 + receivables 0.00 + positions 1000.00 = 5000.00.

### 2026-01-13

- BEFORE_OPEN: Split SPLIT-17-2: ratio r = 17/2 = 8.5, applied exactly once.
- BEFORE_OPEN: Position T-2026-01-12-SYN: quantity 200 * 8.5 = 1700; entry 5 / 8.5 = 10/17; stop 4.78 -> 239/425; target 6.1 -> 61/85; snapshots entry_atr=0.22 -> entry_atr=11/425; scheduled stop none -> none.
- DURING_SESSION: Touch test for T-2026-01-12-SYN: low 0.57 > stop 239/425 -> False; high 0.65 < target 61/85 -> False.
- AFTER_CLOSE: Indicator sma3 = mean of the last 3 close values (indices 4..6): sum 3013/1700 / 3 = 3013/5100 -> 0.5908
- AFTER_CLOSE: Indicator atr3: true ranges (indices 4..6) sum to 57/425; ATR = 57/425 / 3 = 19/425 -> 0.0447
- AFTER_CLOSE: Signal: condition FALSE, decision NO_ENTRY.
- AFTER_CLOSE: Daily record: equity = available 4000.00 + reserved 0.00 + receivables 0.00 + positions 1003.00 = 5003.00.

### 2026-01-14

- DURING_SESSION: Touch test for T-2026-01-12-SYN: low 0.57 > stop 239/425 -> False; high 0.65 < target 61/85 -> False.
- AFTER_CLOSE: Signal: condition FALSE, decision NO_ENTRY.
- AFTER_CLOSE: Daily record: equity = available 4000.00 + reserved 0.00 + receivables 0.00 + positions 986.00 = 4986.00.

### 2026-01-15

- BEFORE_OPEN: Split SPLIT-2-17: ratio r = 2/17 = 2/17, applied exactly once.
- BEFORE_OPEN: Position T-2026-01-12-SYN: quantity 1700 * 2/17 = 200; entry 10/17 / 2/17 = 5; stop 239/425 -> 4.78; target 61/85 -> 6.1; snapshots entry_atr=11/425 -> entry_atr=0.22; scheduled stop none -> none.
- DURING_SESSION: Touch test for T-2026-01-12-SYN: low 4.90 > stop 4.78 -> False; high 5.10 < target 6.1 -> False.
- AFTER_CLOSE: Indicator sma3 = mean of the last 3 close values (indices 6..8): sum 14.945 / 3 = 2989/600 -> 4.9817
- AFTER_CLOSE: Indicator atr3: true ranges (indices 6..8) sum to 1.56; ATR = 1.56 / 3 = 0.52 -> 0.5200
- AFTER_CLOSE: Signal: condition TRUE, decision SKIPPED (HELD).
- AFTER_CLOSE: Daily record: equity = available 4000.00 + reserved 0.00 + receivables 0.00 + positions 1000.00 = 5000.00.

### 2026-01-16

- DURING_SESSION: Touch test for T-2026-01-12-SYN: low 4.79 > stop 4.78 -> False; high 6.09 < target 6.1 -> False.
- AFTER_CLOSE: Indicator sma3 = mean of the last 3 close values (indices 7..9): sum 14.93 / 3 = 1493/300 -> 4.9767
- AFTER_CLOSE: Indicator atr3: true ranges (indices 7..9) sum to 2.18; ATR = 2.18 / 3 = 109/150 -> 0.7267
- AFTER_CLOSE: Signal: condition TRUE, decision SKIPPED (HELD).
- AFTER_CLOSE: Daily record: equity = available 4000.00 + reserved 0.00 + receivables 0.00 + positions 1000.00 = 5000.00.

### 2026-01-19

- DURING_SESSION: Touch test for T-2026-01-12-SYN: low 4.78 <= stop 4.78 -> True; high 5.10 < target 6.1 -> False.
- DURING_SESSION: Sell 200 at 4.78 (STOP): notional 200 * 4.78 = 956.00; fee = ceil(0 + 956.00 * 0/10000) = 0.00; proceeds 956.00 - 0.00 = 956.00; available -> 4956.00.
- AFTER_CLOSE: Indicator sma3 = mean of the last 3 close values (indices 8..10): sum 14.85 / 3 = 4.95 -> 4.9500
- AFTER_CLOSE: Indicator atr3: true ranges (indices 8..10) sum to 1.82; ATR = 1.82 / 3 = 91/150 -> 0.6067
- AFTER_CLOSE: Signal: condition FALSE, decision NO_ENTRY.
- AFTER_CLOSE: Daily record: equity = available 4956.00 + reserved 0.00 + receivables 0.00 + positions 0.00 = 4956.00.

### 2026-01-20

- AFTER_CLOSE: Indicator sma3 = mean of the last 3 close values (indices 9..11): sum 14.85 / 3 = 4.95 -> 4.9500
- AFTER_CLOSE: Indicator atr3: true ranges (indices 9..11) sum to 1.87; ATR = 1.87 / 3 = 187/300 -> 0.6233
- AFTER_CLOSE: Signal: condition TRUE, decision SKIPPED (NO_NEXT_SESSION).
- AFTER_CLOSE: Daily record: equity = available 4956.00 + reserved 0.00 + receivables 0.00 + positions 0.00 = 4956.00.
- AFTER_CLOSE: End of run: no forced liquidation; 0 open trade(s) valued at the last close.

### Journal sequence numbers

Fills and ledger lines share one counter: 0 RESERVE, 1 RELEASE, 2 BUY fill, 3 FILL_BUY, 4 SELL fill, 5 FILL_SELL.

### Outcome

The run completes. Open trades stay OPEN_AT_END and are valued at the last close.

## Hand check

1. ATR3 window, indices 2, 3, 4. Indices 2 and 3 are (5, 5.10, 4.90, 5): true range 0.20 each. Index 4 is (5, 5.16, 4.90, 5.05): max(0.26, 0.16, 0.10) = 0.26. The sum is 0.66 and ATR3 = 0.66 / 3 = 0.22 exactly, so nothing is off the grid before the first split. The close 5.05 is above SMA3 = 5.0166...: entry intent with cap floor(5000.00 / 5) = 1000.00.
2. Entry. Index 5 opens at 5.00 with zero fees: 200 shares cost 1000.00 <= 1000.00. Quantity 200, available 4000.00. Stop = 5 - 1 * 0.22 = 4.78 and target = 5 + 5 * 0.22 = 6.10, both exact prices on the grid.
3. Index 6 is the ex-date of SPLIT-17-2 (17-for-2, ratio r = 17/2 = 8.5). Quantity 200 * 17/2 = 1700 (200 / 2 = 100, 100 * 17 = 1700, a whole number). Every price-unit value is divided by 17/2, that is multiplied by 2/17: entry 5 * 2/17 = 10/17 = 0.5882..., stop 4.78 * 2/17 = 239/50 * 2/17 = 239/425 = 0.5623..., target 6.10 * 2/17 = 61/10 * 2/17 = 61/85 = 0.7176..., ATR snapshot 0.22 * 2/17 = 11/50 * 2/17 = 11/425 = 0.0258.... Each fraction is in lowest terms (239 = 17 * 14 + 1, 61 = 17 * 3 + 10, 11 and 10 are not multiples of 17) and its denominator contains the prime factor 17 (425 = 5 * 5 * 17, 85 = 5 * 17, 17), and a fraction in lowest terms has a finite decimal form only if its denominator has no prime factor other than 2 and 5. So the stop and the target both leave the grid, and so do the entry price and the snapshot. The raw bars of indices 6 and 7 trade near 0.59, between the stop 0.5623... and the target 0.7176... (low 0.57 > 0.5623..., high 0.65 < 0.7176...): no gap and no touch. Equity at the close of index 6 is 4000.00 + 1700 * 0.59 = 5003.00 and at index 7 it is 4000.00 + 1700 * 0.58 = 4986.00.
4. Index 8 is the ex-date of SPLIT-2-17 (2-for-17, ratio r' = 2/17). Quantity 1700 * 2/17 = 200 (whole). Every price-unit value is divided by 2/17, that is multiplied by 17/2: stop 239/425 * 17/2 = 239/50 = 4.78, target 61/85 * 17/2 = 61/10 = 6.10, entry 10/17 * 17/2 = 5, snapshot 11/425 * 17/2 = 11/50 = 0.22. A multiplication and a division by the same ratio are exact inverses in rational arithmetic, so every value returns to the exact value it had before the first split. Bar 8 (5, 5.10, 4.90, 5) touches neither level.
5. Index 9 (5, 6.09, 4.79, 5): the high 6.09 < 6.10 and the low 4.79 > 4.78, one tick inside each level: no touch.
6. Index 10 (5, 5.10, 4.78, 4.85): the open 5.00 is above the stop (no gap). The low 4.78 <= 4.78 by equality: the stop is touched (the high 5.10 is below the target 6.10). The fill is floor(4.78) = 4.78, before costs and without slippage. Notional 200 * 4.78 = 956.00; fee 0.00; proceeds 956.00; available 4000.00 + 956.00 = 4956.00.
7. Index 11 is a flat bar and the last session, so no new position is opened. The run ends with no position; the closed trade states the restored quantity 200 and the entry price 5.00.

The oracle asserts these hand-derived values against its own output (a disagreement stops the run and is resolved by re-reading the specification, never by copying a value):

- `entries.0.quantity` = `200` (1000.00 / 5.00, zero fees)
- `daily.5.cash_available` = `4000.00` (5000.00 - 1000.00)
- `daily.5.positions.0.stop` = `4.78` (5 - 0.22)
- `daily.5.positions.0.target` = `6.10` (5 + 5 * 0.22)
- `daily.6.positions.0.quantity` = `1700` (200 * 17/2)
- `daily.6.equity` = `5003.00` (4000.00 + 1700 * 0.59)
- `daily.7.positions.0.quantity` = `1700` (unchanged)
- `daily.7.equity` = `4986.00` (4000.00 + 1700 * 0.58)
- `daily.8.positions.0.quantity` = `200` (1700 * 2/17)
- `daily.8.positions.0.entry_price` = `5` (restored exactly)
- `daily.8.positions.0.stop` = `4.78` (restored exactly)
- `daily.8.positions.0.target` = `6.10` (restored exactly)
- `daily.8.positions.0.snapshots.0.value` = `0.22` (restored exactly)
- `daily.9.positions.0.stop` = `4.78` (still exact)
- `daily.9.positions.0.target` = `6.10` (still exact)
- `corporate_actions.0.action_id` = `SPLIT-17-2` (input order)
- `corporate_actions.1.action_id` = `SPLIT-2-17` (input order)
- `fills.1.session` = `2026-01-19` (index 10)
- `fills.1.quantity` = `200` (restored quantity)
- `trades.0.quantity` = `200` (restored quantity)
- `trades.0.entry_price` = `5.00` (restored entry price)
- `fills.1.reason` = `STOP` (low 4.78 <= stop 4.78)
- `fills.1.price` = `4.78` (floor(4.78))
- `fills.1.notional` = `956.00` (200 * 4.78)
- `final.cash_available` = `4956.00` (4000.00 + 956.00)

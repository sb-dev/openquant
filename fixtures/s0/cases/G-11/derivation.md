# G-11: Grid tie: stop touched at exactly 4.78 after a 7-for-2 split and its reverse (exact round trip)

Origin: derived by `fixtures/s0/oracle/oracle.py` from OQ-02 sections 2.1 to 2.6 and the declared policy semantics; the oracle uses exact rational arithmetic and never reads the Rust engine. Status: hand-checked (see the last section). Covers: Split across an ex-date, Entry and exit phases.

## Design

12 sessions with zero fees. ATR3 = 0.22 is exact, so the stop 4.78 and the target 5.66 are on the grid before the splits. A 7-for-2 split at index 6 and its reverse at index 8 convert the quantity (200, 700, 200 shares) and divide then multiply every level by 7/2, which leaves no finite decimal form in between; the levels must come back exactly. The stop is touched at exactly 4.78 after a split and its reverse. A stop that was divided and multiplied again with finitely many digits can come back one unit of the last digit below 4.78, and a low of exactly 4.78 would then miss it.

## Inputs

- Strategy: `strategy.json` (strategy hash `sha256:1c5e5be9a9b486bc244fa1b977618fd6d3795e35d6c831462988d84522ccc3d2`).
- Input hash binding in `input.json`: `sha256:1c5e5be9a9b486bc244fa1b977618fd6d3795e35d6c831462988d84522ccc3d2`.
- Policy: price scale 2, quantity scale 0, money scale 2, diagnostic scale 4, lot size 1; fixed fee 0 per fill, 0 bps, gap-exit slippage 100 bps; dividend withholding 0 bps.
- Windows: warm-up from 2026-01-05, scored from 2026-01-08, run ends after 2026-01-20; 12 calendar sessions, 12 bars; initial capital 5000.00.
- Corporate action: `{"action_id": "SPLIT-7-2", "available_at": "2026-01-13T06:00:00Z", "effective_session": "2026-01-13", "kind": "SPLIT", "ratio_new": 7, "ratio_old": 2}`.
- Corporate action: `{"action_id": "SPLIT-2-7", "available_at": "2026-01-15T06:00:00Z", "effective_session": "2026-01-15", "kind": "SPLIT", "ratio_new": 2, "ratio_old": 7}`.
- Note on the policy: the fixed fee is 0, so quantity and cash are whole numbers.

| Session | Open | High | Low | Close | Volume |
| --- | --- | --- | --- | --- | --- |
| 2026-01-05 | 5 | 5.1 | 4.9 | 5 | 1000 |
| 2026-01-06 | 5 | 5.1 | 4.9 | 5 | 1000 |
| 2026-01-07 | 5 | 5.1 | 4.9 | 5 | 1000 |
| 2026-01-08 | 5 | 5.1 | 4.9 | 5 | 1000 |
| 2026-01-09 | 5 | 5.16 | 4.9 | 5.05 | 1000 |
| 2026-01-12 | 5 | 5.1 | 4.9 | 5 | 1000 |
| 2026-01-13 | 1.43 | 1.51 | 1.38 | 1.43 | 1000 |
| 2026-01-14 | 1.43 | 1.51 | 1.38 | 1.42 | 1000 |
| 2026-01-15 | 5 | 5.1 | 4.9 | 5 | 1000 |
| 2026-01-16 | 5 | 5.65 | 4.79 | 5 | 1000 |
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
- OPEN: Levels from the signal-session snapshots (entry_atr=0.22): stop 4.78, target 5.66; need 0 < stop < entry 5.00 < target.
- OPEN: Release cap 1000.00 (available 5000.00), buy 200 at 5.00: notional 1000.00, fee 0.00, debit 1000.00; available -> 4000.00.
- DURING_SESSION: Touch test for T-2026-01-12-SYN: low 4.90 > stop 4.78 -> False; high 5.10 < target 5.66 -> False.
- AFTER_CLOSE: Signal: condition FALSE, decision NO_ENTRY.
- AFTER_CLOSE: Daily record: equity = available 4000.00 + reserved 0.00 + receivables 0.00 + positions 1000.00 = 5000.00.

### 2026-01-13

- BEFORE_OPEN: Split SPLIT-7-2: ratio r = 7/2 = 3.5, applied exactly once.
- BEFORE_OPEN: Position T-2026-01-12-SYN: quantity 200 * 3.5 = 700; entry 5 / 3.5 = 10/7; stop 4.78 -> 239/175; target 5.66 -> 283/175; snapshots entry_atr=0.22 -> entry_atr=11/175; scheduled stop none -> none.
- DURING_SESSION: Touch test for T-2026-01-12-SYN: low 1.38 > stop 239/175 -> False; high 1.51 < target 283/175 -> False.
- AFTER_CLOSE: Indicator sma3 = mean of the last 3 close values (indices 4..6): sum 3011/700 / 3 = 3011/2100 -> 1.4338
- AFTER_CLOSE: Indicator atr3: true ranges (indices 4..6) sum to 183/700; ATR = 183/700 / 3 = 61/700 -> 0.0871
- AFTER_CLOSE: Signal: condition FALSE, decision NO_ENTRY.
- AFTER_CLOSE: Daily record: equity = available 4000.00 + reserved 0.00 + receivables 0.00 + positions 1001.00 = 5001.00.

### 2026-01-14

- DURING_SESSION: Touch test for T-2026-01-12-SYN: low 1.38 > stop 239/175 -> False; high 1.51 < target 283/175 -> False.
- AFTER_CLOSE: Signal: condition FALSE, decision NO_ENTRY.
- AFTER_CLOSE: Daily record: equity = available 4000.00 + reserved 0.00 + receivables 0.00 + positions 994.00 = 4994.00.

### 2026-01-15

- BEFORE_OPEN: Split SPLIT-2-7: ratio r = 2/7 = 2/7, applied exactly once.
- BEFORE_OPEN: Position T-2026-01-12-SYN: quantity 700 * 2/7 = 200; entry 10/7 / 2/7 = 5; stop 239/175 -> 4.78; target 283/175 -> 5.66; snapshots entry_atr=11/175 -> entry_atr=0.22; scheduled stop none -> none.
- DURING_SESSION: Touch test for T-2026-01-12-SYN: low 4.90 > stop 4.78 -> False; high 5.10 < target 5.66 -> False.
- AFTER_CLOSE: Indicator sma3 = mean of the last 3 close values (indices 6..8): sum 14.975 / 3 = 599/120 -> 4.9917
- AFTER_CLOSE: Indicator atr3: true ranges (indices 6..8) sum to 1.11; ATR = 1.11 / 3 = 0.37 -> 0.3700
- AFTER_CLOSE: Signal: condition TRUE, decision SKIPPED (HELD).
- AFTER_CLOSE: Daily record: equity = available 4000.00 + reserved 0.00 + receivables 0.00 + positions 1000.00 = 5000.00.

### 2026-01-16

- DURING_SESSION: Touch test for T-2026-01-12-SYN: low 4.79 > stop 4.78 -> False; high 5.65 < target 5.66 -> False.
- AFTER_CLOSE: Indicator sma3 = mean of the last 3 close values (indices 7..9): sum 14.97 / 3 = 4.99 -> 4.9900
- AFTER_CLOSE: Indicator atr3: true ranges (indices 7..9) sum to 1.515; ATR = 1.515 / 3 = 0.505 -> 0.5050
- AFTER_CLOSE: Signal: condition TRUE, decision SKIPPED (HELD).
- AFTER_CLOSE: Daily record: equity = available 4000.00 + reserved 0.00 + receivables 0.00 + positions 1000.00 = 5000.00.

### 2026-01-19

- DURING_SESSION: Touch test for T-2026-01-12-SYN: low 4.78 <= stop 4.78 -> True; high 5.10 < target 5.66 -> False.
- DURING_SESSION: Sell 200 at 4.78 (STOP): notional 200 * 4.78 = 956.00; fee = ceil(0 + 956.00 * 0/10000) = 0.00; proceeds 956.00 - 0.00 = 956.00; available -> 4956.00.
- AFTER_CLOSE: Indicator sma3 = mean of the last 3 close values (indices 8..10): sum 14.85 / 3 = 4.95 -> 4.9500
- AFTER_CLOSE: Indicator atr3: true ranges (indices 8..10) sum to 1.38; ATR = 1.38 / 3 = 0.46 -> 0.4600
- AFTER_CLOSE: Signal: condition FALSE, decision NO_ENTRY.
- AFTER_CLOSE: Daily record: equity = available 4956.00 + reserved 0.00 + receivables 0.00 + positions 0.00 = 4956.00.

### 2026-01-20

- AFTER_CLOSE: Indicator sma3 = mean of the last 3 close values (indices 9..11): sum 14.85 / 3 = 4.95 -> 4.9500
- AFTER_CLOSE: Indicator atr3: true ranges (indices 9..11) sum to 1.43; ATR = 1.43 / 3 = 143/300 -> 0.4767
- AFTER_CLOSE: Signal: condition TRUE, decision SKIPPED (NO_NEXT_SESSION).
- AFTER_CLOSE: Daily record: equity = available 4956.00 + reserved 0.00 + receivables 0.00 + positions 0.00 = 4956.00.
- AFTER_CLOSE: End of run: no forced liquidation; 0 open trade(s) valued at the last close.

### Journal sequence numbers

Fills and ledger lines share one counter: 0 RESERVE, 1 RELEASE, 2 BUY fill, 3 FILL_BUY, 4 SELL fill, 5 FILL_SELL.

### Outcome

The run completes. Open trades stay OPEN_AT_END and are valued at the last close.

## Hand check

1. ATR3 window, indices 2, 3, 4. Indices 2 and 3 are (5, 5.10, 4.90, 5): true range 0.20 each. Index 4 is (5, 5.16, 4.90, 5.05): max(0.26, 0.16, 0.10) = 0.26. The sum is 0.66 and ATR3 = 0.66 / 3 = 0.22 exactly, so nothing is off the grid before the first split. The close 5.05 is above SMA3 = 5.0166...: entry intent with cap floor(5000.00 / 5) = 1000.00.
2. Entry. Index 5 opens at 5.00 with zero fees: 200 shares cost 1000.00 <= 1000.00. Quantity 200, available 4000.00. Stop = 5 - 1 * 0.22 = 4.78 and target = 5 + 3 * 0.22 = 5.66, both exact prices on the grid.
3. Index 6 is the ex-date of SPLIT-7-2 (7-for-2, ratio r = 7/2). Quantity 200 * (7/2) = 700 (a whole number). Every price-unit value is divided by r: entry 5 / (7/2) = 10/7, stop 4.78 / (7/2) = 239/175 = 1.3657..., target 5.66 / (7/2) = 283/175 = 1.6171..., ATR snapshot 0.22 / (7/2) = 11/175. None of them has a finite decimal form. The raw bars of indices 6 and 7 trade near 1.43, between the stop and the target: no gap and no touch.
4. Index 8 is the ex-date of SPLIT-2-7 (2-for-7, ratio r' = 2/7). Quantity 700 * (2/7) = 200 (whole). Every price-unit value is divided by r', that is multiplied by 3.5: stop 239/175 * 3.5 = 4.78, target 283/175 * 3.5 = 5.66, entry 10/7 * 3.5 = 5, snapshot 11/175 * 3.5 = 0.22. A division and a multiplication by the same ratio are exact inverses in rational arithmetic, so every value returns to the exact value it had before the first split. Bar 8 (5, 5.10, 4.90, 5) touches neither level.
5. Index 9 (5, 5.65, 4.79, 5): the high 5.65 < 5.66 and the low 4.79 > 4.78, one tick inside each level: no touch.
6. Index 10 (5, 5.10, 4.78, 4.85): the open 5.00 is above the stop (no gap). The low 4.78 <= 4.78 by equality: the stop is touched (the high 5.10 is below the target 5.66). The fill is floor(4.78) = 4.78, before costs and without slippage. Notional 200 * 4.78 = 956.00; fee 0.00; proceeds 956.00; available 4000.00 + 956.00 = 4956.00.
7. Index 11 is a flat bar and the last session, so no new position is opened. The run ends with no position; the closed trade states the restored quantity 200 and the entry price 5.00.

The oracle asserts these hand-derived values against its own output (a disagreement stops the run and is resolved by re-reading the specification, never by copying a value):

- `entries.0.quantity` = `200` (1000.00 / 5.00, zero fees)
- `daily.5.cash_available` = `4000.00` (5000.00 - 1000.00)
- `daily.5.positions.0.stop` = `4.78` (5 - 0.22)
- `daily.5.positions.0.target` = `5.66` (5 + 3 * 0.22)
- `daily.6.positions.0.quantity` = `700` (200 * (7/2))
- `daily.7.positions.0.quantity` = `700` (unchanged)
- `daily.8.positions.0.quantity` = `200` (700 * (2/7))
- `daily.8.positions.0.entry_price` = `5` (restored exactly)
- `daily.8.positions.0.stop` = `4.78` (restored exactly)
- `daily.8.positions.0.target` = `5.66` (restored exactly)
- `daily.8.positions.0.snapshots.0.value` = `0.22` (restored exactly)
- `daily.9.positions.0.stop` = `4.78` (still exact)
- `daily.9.positions.0.target` = `5.66` (still exact)
- `corporate_actions.0.action_id` = `SPLIT-7-2` (input order)
- `corporate_actions.1.action_id` = `SPLIT-2-7` (input order)
- `fills.1.session` = `2026-01-19` (index 10)
- `fills.1.quantity` = `200` (restored quantity)
- `trades.0.quantity` = `200` (restored quantity)
- `trades.0.entry_price` = `5.00` (restored entry price)
- `fills.1.reason` = `STOP` (low 4.78 <= stop 4.78)
- `fills.1.price` = `4.78` (floor(4.78))
- `fills.1.notional` = `956.00` (200 * 4.78)
- `final.cash_available` = `4956.00` (4000.00 + 956.00)

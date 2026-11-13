# C-07: A split available after the session open is FUTURE_DATA

Origin: derived by `fixtures/s0/oracle/oracle.py` from OQ-02 sections 2.1 to 2.6 and the declared policy semantics; the oracle uses exact rational arithmetic and never reads the Rust engine. Status: not individually hand-checked. Covers: Invalid inputs, Split across an ex-date.

## Design

Nine sessions. A 2-for-1 split is effective at index 6 but its availability time is one minute after that session's open (14:31 against 14:30). Applying it at BEFORE_OPEN would use data that was not yet known, so the run fails with FAILED FUTURE_DATA at BEFORE_OPEN of index 6; the journal keeps everything through the close of index 5.

## Inputs

- Strategy: `strategy.json` (strategy hash `sha256:1e899a271c1c24428284b2d50b177820eba4674f0fd510f5560042d6f5cd3efc`).
- Input hash binding in `input.json`: `sha256:1e899a271c1c24428284b2d50b177820eba4674f0fd510f5560042d6f5cd3efc`.
- Policy: price scale 2, quantity scale 0, money scale 2, diagnostic scale 4, lot size 1; fixed fee 1.00 per fill, 10 bps, gap-exit slippage 0 bps; dividend withholding 0 bps.
- Windows: warm-up from 2026-01-05, scored from 2026-01-08, run ends after 2026-01-15; 9 calendar sessions, 9 bars; initial capital 5000.00.
- Corporate action: `{"action_id": "SPLIT-2-1", "available_at": "2026-01-13T14:31:00Z", "effective_session": "2026-01-13", "kind": "SPLIT", "ratio_new": 2, "ratio_old": 1}`.

| Session | Open | High | Low | Close | Volume |
| --- | --- | --- | --- | --- | --- |
| 2026-01-05 | 50 | 51 | 49 | 50 | 1000 |
| 2026-01-06 | 50 | 51 | 49 | 50 | 1000 |
| 2026-01-07 | 50 | 51 | 49 | 50 | 1000 |
| 2026-01-08 | 50 | 51 | 49 | 50 | 1000 |
| 2026-01-09 | 50 | 51.5 | 49.5 | 51 | 1000 |
| 2026-01-12 | 50 | 51 | 49 | 50 | 1000 |
| 2026-01-13 | 50 | 51 | 49 | 50 | 1000 |
| 2026-01-14 | 50 | 51 | 49 | 50 | 1000 |
| 2026-01-15 | 50 | 51 | 49 | 50 | 1000 |

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

- OPEN: Size intent I-2026-01-09-SYN: cap 1000.00, open 50.00, lot 1, fee(n) = ceil(1 + n * 10/10000). Largest lot multiple that fits: q=20: 1000.00 + fee 2.00 = 1002.00 > cap 1000.00; q=19: 950.00 + fee 1.95 = 951.95 <= cap 1000.00.
- OPEN: Levels from the signal-session snapshots (entry_atr=2): stop 46, target 60; need 0 < stop < entry 50.00 < target.
- OPEN: Release cap 1000.00 (available 5000.00), buy 19 at 50.00: notional 950.00, fee 1.95, debit 951.95; available -> 4048.05.
- DURING_SESSION: Touch test for T-2026-01-12-SYN: low 49.00 > stop 46 -> False; high 51.00 < target 60 -> False.
- AFTER_CLOSE: Signal: condition FALSE, decision NO_ENTRY.
- AFTER_CLOSE: Daily record: equity = available 4048.05 + reserved 0.00 + receivables 0.00 + positions 950.00 = 4998.05.

### 2026-01-13

- BEFORE_OPEN: FAILURE FAILED FUTURE_DATA: action SPLIT-2-1 becomes available at 2026-01-13T14:31:00Z, after the deadline 2026-01-13T14:30:00Z (the earlier of the session open 2026-01-13T14:30:00Z and the information cutoff 2026-01-16T00:00:00Z). Journal kept through the last completed event.

### Journal sequence numbers

Fills and ledger lines share one counter: 0 RESERVE, 1 RELEASE, 2 BUY fill, 3 FILL_BUY.

### Outcome

The run stops with status FAILED, code FUTURE_DATA at 2026-01-13 BEFORE_OPEN. The expected journal is the journal through the last completed event.

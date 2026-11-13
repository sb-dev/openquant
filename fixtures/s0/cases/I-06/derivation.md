# I-06: Confirmed halt: the pending entry expires at the open and its reservation is released

Origin: derived by `fixtures/s0/oracle/oracle.py` from OQ-02 sections 2.1 to 2.6 and the declared policy semantics; the oracle uses exact rational arithmetic and never reads the Rust engine. Status: hand-checked (see the last section). Covers: Unplanned non-trading events.

## Design

Six calendar sessions; index 5 is the last. A CONFIRMED_HALT effective at index 5 became available before its open and there is no bar for index 5. The intent reserved at the close of index 4 cannot fill; it expires at the intended opening phase and the reservation is released. The instrument stays in the run.

## Inputs

- Strategy: `strategy.json` (strategy hash `sha256:da942d012adb0885096d3eeb7da9bbc6d4b60eecdfe135db85fee1d1f9300dcb`).
- Input hash binding in `input.json`: `sha256:da942d012adb0885096d3eeb7da9bbc6d4b60eecdfe135db85fee1d1f9300dcb`.
- Policy: price scale 2, quantity scale 0, money scale 2, diagnostic scale 4, lot size 1; fixed fee 1.00 per fill, 10 bps, gap-exit slippage 0 bps; dividend withholding 0 bps.
- Windows: warm-up from 2026-01-05, scored from 2026-01-08, run ends after 2026-01-12; 6 calendar sessions, 5 bars; initial capital 5000.00.
- Unplanned event: `{"available_at": "2026-01-12T13:30:00Z", "effective_session": "2026-01-12", "event_id": "HALT-1", "kind": "CONFIRMED_HALT"}`.

| Session | Open | High | Low | Close | Volume |
| --- | --- | --- | --- | --- | --- |
| 2026-01-05 | 50 | 51 | 49 | 50 | 1000 |
| 2026-01-06 | 50 | 51 | 49 | 50 | 1000 |
| 2026-01-07 | 50 | 51 | 49 | 50 | 1000 |
| 2026-01-08 | 50 | 51 | 49 | 50 | 1000 |
| 2026-01-09 | 50 | 51.5 | 49.5 | 51 | 1000 |

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

- OPEN: Confirmed halt: intent I-2026-01-09-SYN expires (EXPIRED_NON_TRADING); reservation 1000.00 released; available -> 5000.00.
- AFTER_CLOSE: Confirmed halt, nothing held: no signal can be created.
- AFTER_CLOSE: Daily record: equity = available 5000.00 + reserved 0.00 + receivables 0.00 + positions 0.00 = 5000.00.
- AFTER_CLOSE: End of run: no forced liquidation; 0 open trade(s) valued at the last close.

### Journal sequence numbers

Fills and ledger lines share one counter: 0 RESERVE, 1 RELEASE.

### Outcome

The run completes. Open trades stay OPEN_AT_END and are valued at the last close.

## Hand check

- The signal at index 4 reserves floor(5000.00 / 5) = 1000.00 (available 4000.00). Index 5 is a confirmed halt (available 13:30, before the 14:30 open): no bar is needed and none is supplied. At OPEN the intent expires (EXPIRED, EXPIRED_NON_TRADING) and the reservation is released: available 5000.00, no fill, no fee. The session has no signal (a non-trading instrument cannot create one) and a daily record with cash 5000.00 only.

The oracle asserts these hand-derived values against its own output (a disagreement stops the run and is resolved by re-reading the specification, never by copying a value):

- `entries.0.status` = `EXPIRED` (confirmed halt at the intended open)
- `entries.0.reason` = `EXPIRED_NON_TRADING` (non-trading session)
- `cash_ledger.1.kind` = `RELEASE` (reservation released)
- `cash_ledger.1.available_after` = `5000.00` (all cash available again)
- `final.equity` = `5000.00` (no position, no fee)

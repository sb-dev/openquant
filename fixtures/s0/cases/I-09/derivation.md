# I-09: A bar supplied for a session with a confirmed halt is contradictory input

Origin: derived by `fixtures/s0/oracle/oracle.py` from OQ-02 sections 2.1 to 2.6 and the declared policy semantics; the oracle uses exact rational arithmetic and never reads the Rust engine. Status: not individually hand-checked. Covers: Unplanned non-trading events, Invalid inputs.

## Design

Six calendar sessions. A CONFIRMED_HALT effective at index 5 became available at 13:30, before the 14:30 open, so the instrument is known to be non-trading for that session. The input nevertheless supplies a bar for index 5. A confirmed non-trading instrument can create no signal and no fill, and evidence that a bar exists contradicts the halt. The input is rejected as INVALID_INPUT before any evaluation; no session is processed and no journal is produced. (A halt that became available after the open does not confirm the halt and is not contradicted by a bar.)

## Inputs

- Strategy: `strategy.json` (strategy hash `sha256:d6b6e678662d2e7cb28dccd53fe55a5151a96172f5e791342249a3bb577ad845`).
- Input hash binding in `input.json`: `sha256:d6b6e678662d2e7cb28dccd53fe55a5151a96172f5e791342249a3bb577ad845`.
- Policy: price scale 2, quantity scale 0, money scale 2, diagnostic scale 4, lot size 1; fixed fee 1.00 per fill, 10 bps, gap-exit slippage 0 bps; dividend withholding 0 bps.
- Windows: warm-up from 2026-01-05, scored from 2026-01-08, run ends after 2026-01-12; 6 calendar sessions, 6 bars; initial capital 5000.00.
- Unplanned event: `{"available_at": "2026-01-12T13:30:00Z", "effective_session": "2026-01-12", "event_id": "HALT-1", "kind": "CONFIRMED_HALT"}`.

| Session | Open | High | Low | Close | Volume |
| --- | --- | --- | --- | --- | --- |
| 2026-01-05 | 50 | 51 | 49 | 50 | 1000 |
| 2026-01-06 | 50 | 51 | 49 | 50 | 1000 |
| 2026-01-07 | 50 | 51 | 49 | 50 | 1000 |
| 2026-01-08 | 50 | 51 | 49 | 50 | 1000 |
| 2026-01-09 | 50 | 51.5 | 49.5 | 51 | 1000 |
| 2026-01-12 | 50 | 51 | 49 | 50 | 1000 |

## Expected result

Rejected before evaluation: status FAILED, code INVALID_INPUT. No journal is produced.

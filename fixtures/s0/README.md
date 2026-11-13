# S0 seed evaluation fixtures

Synthetic one-instrument fixtures for the offline seed evaluation (OQ-06 section 8, S0). No
provider data, credentials or private account data. Licence: Apache-2.0.

## Layout

| Path | Content |
| --- | --- |
| `strategies/` | The four seed Strategy Artefacts (RSI threshold 30 or 32, break-even off or on) and a fifth data-only variant (threshold 40). They differ only in data and have distinct hashes. |
| `cases/<id>/` | One case: `case.json`, `strategy.json` or a seed copy, `input.json`, `expected.json`, `derivation.md`. |
| `coverage.json` | Maps each S0 row of OQ-06 section 8 to the cases that demonstrate it. |
| `oracle/` | Provenance scripts used to derive expected values. Verification does not run them. |

## Case format

`case.json` has `id`, `title`, `covers` (S0 row names), `strategy`, `input`, `expected`,
`derivation` and optional `restore_every_cut`. Files are relative to the case directory.

`expected.json` has `schema` (`s0-expected/1`), `case`, `origin` and `expect`. `origin.kind`
names how the values were derived. When a script derived them, `origin.oracle` and
`origin.oracle_sha256` bind the values to that script version. `expect` states the values the
derivation covers:

- `outcome`: `status` and, for a rejected case, `code`.
- `signals`: records matched by `session`. A case lists only the sessions it derives.
- `entries`, `fills`, `trades`, `cash_ledger`, `daily`, `corporate_actions`: arrays with the same
  length as the actual array. Each record states the fields it derives.
- `final`: the final state.

Decimal strings compare by value. Every other value compares exactly. Expected numbers come from
the independent derivation, never from the engine. Tests never regenerate them.

## Run

```bash
cargo run --locked -p openquant-engine --bin s0-replay
```

The command writes `local-runs/s0/report.md`, one result file per case and `index.json`.
It exits with a failure if any case differs from its expectation, if a repeated evaluation
differs, or if a restored run differs from uninterrupted execution.

## Wire formats of results

- Fills, ledger lines, daily cash and equity: money scale of the policy. Prices: price scale.
  Quantities: quantity scale.
- Position levels, snapshots and scheduled stops: exact value without trailing zeros.
- Indicator values and ranks in signals: rounded half-even to the diagnostic scale (display only).
- Fills and ledger lines share one sequence counter (`seq`).
- A daily record is the end-of-session state, after reservations for the next open.

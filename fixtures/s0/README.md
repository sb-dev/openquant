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
`derivation` and optional `restore_every_cut`. Files are relative to the case directory. The
directory name equals the case id. `covers` and `coverage.json` must name the same cases for
each row, and every S0 row needs at least one case.

`expected.json` has `schema` (`s0-expected/1`), `case`, `origin` and `expect`. `origin.kind`
names how the values were derived. When a script derived them, `origin.oracle` and
`origin.oracle_sha256` bind the values to that script version; the tests fail if the script
changes after the values were derived. `expect` states the values the derivation covers:

- `outcome`: `status` and, for a failed or insufficient case, `code`.
- `signals`: records matched by `session`. A case lists only the sessions it derives.
- `entries`, `fills`, `trades`, `cash_ledger`, `daily`, `corporate_actions`: arrays with the same
  length as the actual array. Each record states the fields it derives.
- `final`: the final state.

A completed case states all nine sections. A case that fails or is insufficient after processing
events states `outcome` and the journal sections through the last completed event (`signals`,
`entries`, `fills`, `cash_ledger`, `daily`, `corporate_actions`). A case rejected before the first
event states `outcome` only.

## How a case is compared

The comparison reports each difference with its path, the expected value and the actual value.
It also counts checks: every scalar value and every array length that an expectation states is
one check. The report shows checks, matches and differences per section and in total.

- Decimal strings compare by value (`50` equals `50.00`). Strings outside the wire decimal
  grammar (`1e3`, `050`, `+1`, `-0`) and every other value compare exactly.
- An object in the expectation need only list the fields it derives; extra actual fields are not
  compared. Arrays must have the same length.
- Signals are matched by `session`, so a case can list a few sessions out of many.
- Expected numbers come from the independent derivation, never from the engine. Tests never
  regenerate them. A case that disagrees with the engine is reported, not edited.

Beyond the expected values, every case that starts a run must also repeat byte for byte when
evaluated again from freshly parsed documents, and its result must validate against the
`evaluation-result/1` schema and survive a parse and serialise round trip unchanged.

When `restore_every_cut` is true, the harness checkpoints the uninterrupted state at every event
boundary (from before the first event to the last completed event), restores it on a freshly
prepared run through the checkpoint schema and requires an identical state and an identical final
result. Runs of up to 128 events do the full check at every cut. Longer runs restore and compare
the state at every cut and do the full check (checkpoint as schema-validated text, run to the
end, compare the result bytes) at about 16 evenly spread cuts (every ceil(events / 16)-th cut,
starting with the first) and at the last cut.

## Run

```bash
cargo run --locked -p openquant-engine --bin s0-replay
```

The command writes `local-runs/s0/report.md`, one result file per case (`results/<id>.result.json`)
and `index.json`. Options: `--fixtures DIR`, `--out DIR`, `--case ID` (one case; row coverage is
then not checked).

Exit status: 0 when every case passes and every S0 row is covered; 1 when any case differs from
its expectation, a repeated evaluation differs, a result fails its schema, a restored run
differs from uninterrupted execution, or `coverage.json` and the cases disagree (full runs
only); 2 for a usage or file error.

The report lists, in order: the run header (source revision, command, toolchain, engine), the
summary with each case's S0 rows and verdict, the S0 row coverage table, one section per case
(identities, signals, entry intents, fills, trades, cash ledger, corporate actions applied, daily
cash positions and equity, final state, expected versus actual with check counts, determinism and
restore) and the remaining limitations. `index.json` holds case ids, verdicts and result digests
only; it has no clock, path or revision, so repeated runs write the same bytes. The report header
records the source revision and command and so is not byte-identical across different commands.

The same cases run in `cargo test -p openquant-engine` (`tests/s0_fixtures.rs`), which also checks
that the S0 rows in the harness equal the S0 rows of OQ-06 section 8, that expectations state the
required sections, and that two complete runs write byte-identical result files and index.

## Wire formats of results

- Fills, ledger lines, daily cash and equity: money scale of the policy. Prices: price scale.
  Quantities: quantity scale.
- Position levels, snapshots and scheduled stops: exact value without trailing zeros.
- Indicator values and ranks in signals: rounded half-even to the diagnostic scale (display only).
- Fills and ledger lines share one sequence counter (`seq`).
- A daily record is the end-of-session state, after reservations for the next open.

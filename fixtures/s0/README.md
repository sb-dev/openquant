# S0 seed evaluation fixtures

Synthetic one-instrument fixtures for the offline seed evaluation (OQ-06 section 8, S0). No
provider data, credentials or private account data. Licence: Apache-2.0.

## Layout

| Path | Content |
| --- | --- |
| `strategies/` | The four seed Strategy Artefacts (RSI threshold 30 or 32, break-even off or on) and a fifth data-only variant (threshold 40). They differ only in data and have distinct hashes. |
| `cases/<id>/` | One case: `case.json`, `strategy.json` or a relative path to a seed in `strategies/`, `input.json`, `expected.json`, `derivation.md`. |
| `coverage.json` | Maps each S0 row of OQ-06 section 8 to the cases that demonstrate it. |
| `oracle/oracle.py` | The exact-rational (Python `fractions`) script that derives every case except `F0-smoke`, `coverage.json` and the oracle's entries in `fixtures/protocol/manifest.json`. Verification does not run it; the tests only check its hash. See Regenerating. |

## Case ids

An id is `<prefix>-<number>`, optionally followed by one lowercase letter or a `-vN` suffix, and it is the directory name.

- Prefixes: `F0` the lead's smoke case (`F0-smoke`, hand-derived, not produced by the oracle), `SEM` seed semantics, `ENT` and `DEF` entry variants and definition execution, `X` execution and cash, `C` corporate actions, `I` invalid inputs and non-trading events, `R` replay.
- A `-vN` suffix names the seed variant that runs the bars of its family: `ENT-01-v1` to `ENT-01-v4`, `ENT-02-v1` to `ENT-02-v4`, `DEF-01-v1` to `DEF-01-v4` and `DEF-02-v1` to `DEF-02-v4` run the four seed variants on the same bars. `ENT-03` runs the data-only fifth variant. `ENT-03-v1` and `ENT-03-v2` run the first two variants on the same bars, because one case runs one strategy.
- A lowercase letter (`X-02a`, `X-09b`, `C-01c`, `C-04a`, `I-05c`) marks a sub-case that varies one input of a sibling case. `SEM-04b` varies `SEM-04` in the same way.
- `X-12` to `X-14` are off-grid execution cases (next section).

## Off-grid levels

In `X-01` to `X-11` every stop and target lies on the price grid, so rounding a touched level would change nothing. `X-12` (intraday target touch), `X-13` (gap above the target) and `X-14` (intraday stop touch) use a signal bar whose true-range sum is not a multiple of 3 cents. ATR3 is then 67/30, 32/15 or 13/6, which has no finite decimal form, and the level falls between two grid prices (for example the target 367/6 = 61.1666...).

- The position keeps the exact level. A bar that stops short of it is not a touch, even where the level rounded to the grid would be touched.
- A touched level fills at the level floored to the price scale (`floor(367/6) = 61.16`; nearest or upward rounding would give 61.17), before costs. A gap above a target also fills at the floored level. Slippage applies to a gap through a stop only, never to these fills. This is the declared policy: sale levels round down (OQ-02 section 2.5, a fill "at its level").
- These levels have no finite decimal form, so the expected `daily` positions omit `stop`, `target` and the `entry_atr` snapshot value. The fill price, fee and cash state their effect.

## Information cutoff

Every input states `windows.information_cutoff`. The deadline for a bar, a corporate action or halt evidence is the earlier of the session open (the next open for a bar) and the cutoff. The final session has only the cutoff. Cases `I-10`, `I-11` and `C-08` pin this rule. `I-09` pins the rejection of a bar on a session with a confirmed halt.

## Case format

`case.json` has `id`, `title`, `covers` (S0 row names), `strategy`, `input`, `expected`,
`derivation` and optional `restore_every_cut`. Files are relative to the case directory. The
directory name equals the case id. `covers` and `coverage.json` must name the same cases for
each row, and every S0 row needs at least one case.

`expected.json` has `schema` (`s0-expected/1`), `case`, `origin` and `expect`. `origin.kind`
names how the values were derived: `oracle`, or `lead-hand-derived` for `F0-smoke`. When a script
derived them, `origin.oracle` and `origin.oracle_sha256` bind the values to that script version;
the tests fail if the script changes after the values were derived. `expect` states the values the
derivation covers:

- `outcome`: `status` and, for a failed or insufficient case, `code`, plus `at` (session and phase)
  when the run processed events.
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
- Position levels, snapshots and scheduled stops: exact value without trailing zeros. A value with no
  finite decimal form (see Off-grid levels) is a long rounded decimal, and expectations do not state it.
- Indicator values and ranks in signals: rounded half-even to the diagnostic scale (display only).
- Fills and ledger lines share one sequence counter (`seq`).
- A daily record is the end-of-session state, after reservations for the next open.

## Regenerating

Run `python3 -I fixtures/s0/oracle/oracle.py` from the repository root, only after a deliberate
change to the oracle. It rewrites every oracle case, `coverage.json` (from the `covers` of each
case) and the oracle's entries in `fixtures/protocol/manifest.json`, and writes the hash of the new
script into every `expected.json`. `F0-smoke` is hand-derived and the oracle never writes it. Review
the diff before committing: apart from that hash, a change to an existing `input.json` or an expected
value needs an explanation, and the tests never regenerate anything. Delete a `__pycache__` that the
run leaves behind.

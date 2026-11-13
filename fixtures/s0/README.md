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

- Prefixes: `F0` the lead's smoke case (`F0-smoke`, hand-derived, not produced by the oracle), `SEM` seed semantics, `ENT` and `DEF` entry variants and definition execution, `X` execution and cash, `C` corporate actions, `I` invalid inputs and non-trading events, `R` replay, `G` grid ties (see Grid ties).
- A `-vN` suffix names the seed variant that runs the bars of its family: `ENT-01-v1` to `ENT-01-v4`, `ENT-02-v1` to `ENT-02-v4`, `DEF-01-v1` to `DEF-01-v4` and `DEF-02-v1` to `DEF-02-v4` run the four seed variants on the same bars. `ENT-03` runs the data-only fifth variant. `ENT-03-v1` and `ENT-03-v2` run the first two variants on the same bars, because one case runs one strategy.
- A lowercase letter (`X-02a`, `X-09b`, `C-01c`, `C-04a`, `I-05c`) marks a sub-case that varies one input of a sibling case. `SEM-04b` varies `SEM-04` in the same way.
- `X-12` to `X-14` are off-grid execution cases (next section).
- `G-01` to `G-11b` are grid ties. Where a number holds two cases, the lowercase letters name the two rounding directions (`G-05a`, `G-05b`, `G-07a`, `G-07b`, `G-08a`, `G-08b`, `G-09a`, `G-09b`, `G-09c`), and a bare id with a `b` sibling names the first direction or the stop variant (`G-06` and `G-06b`, `G-10` and `G-10b`, `G-11` and `G-11b`).
- `G-12a` to `G-12d` and `G-13`, `G-13b` pin the opposite of a grid tie: a gap test against a level that is off the grid, and a split round trip whose converted levels leave the grid (see Off-grid gap tests and a split round trip). The four letters of `G-12` name the level and the open: `G-12a` target, open at the grid price below it (no gap); `G-12b` stop, open at the grid price above it (no gap); `G-12c` target, open above it (gap); `G-12d` stop, open below it (gap). `G-13` is the stop variant and `G-13b` the target variant, as `G-10` and `G-10b`.

## Off-grid levels

In `X-01` to `X-11` every stop and target lies on the price grid, so rounding a touched level would change nothing. `X-12` (intraday target touch), `X-13` (gap above the target) and `X-14` (intraday stop touch) use a signal bar whose true-range sum is not a multiple of 3 cents. ATR3 is then 67/30, 32/15 or 13/6, which has no finite decimal form, and the level falls between two grid prices (for example the target 367/6 = 61.1666...).

- The position keeps the exact level. A bar that stops short of it is not a touch, even where the level rounded to the grid would be touched.
- A touched level fills at the level floored to the price scale (`floor(367/6) = 61.16`; nearest or upward rounding would give 61.17), before costs. A gap above a target also fills at the floored level. Slippage applies to a gap through a stop only, never to these fills. This is the declared policy: sale levels round down (OQ-02 section 2.5, a fill "at its level").
- These levels have no finite decimal form, so the expected `daily` positions omit `stop`, `target` and the `entry_atr` snapshot value. The fill price, fee and cash state their effect.

## Grid ties

`X-12` to `X-14` put the level between two grid prices. `G-01` to `G-11b` pin the opposite situation: the exact decision value is a price on the grid, although an intermediate value has no finite decimal form. A true-range sum of 0.67 gives ATR3 = 67/300 = 0.2233..., yet 3 x ATR3 is exactly 0.67, so a target of 5 + 3 x ATR3 is the grid price 5.67. The same happens to the mean of three closes that sum to 6.01 (3 x SMA3 = 6.01 although SMA3 = 601/300) and to a level that a 3-for-1 split divides by 3 and a later 1-for-3 split multiplies by 3. Such a value is a grid tie, and the exact value decides it: a high of 5.67 touches the target 5.67 and the sale fills at floor(5.67) = 5.67, before costs. The oracle never rounds an intermediate value, so it states the exact decision.

A computation that rounds the intermediate value to finitely many digits ends one unit of its last digit away from the grid price, and then can decide a touch, a gap, a trigger or a signal the wrong way, floor the fill to the price below, or accept a level that must be rejected (a stop of exactly 0). The repeating digit sets the direction. A sum of 0.67 gives 0.2233..., which rounds below the exact value; a sum of 0.68 gives 0.2266..., which rounds above it. In general the cent remainder of the sum divided by 3 is 1 (below) or 2 (above); a remainder of 0 terminates and is no tie.

A comparison is misjudged in only one of the two directions, so each family has a case for each direction:

| Cases | Tie pinned | Misjudged when the rounded value lies |
| --- | --- | --- |
| `G-01`, `G-02` | intraday target touch at 5.67 and 5.68 (high equals the target, the bar before is one tick below) | below (fill 5.66 instead of 5.67, `G-01`); above (no touch, `G-02`) |
| `G-03`, `G-04` | intraday stop touch at 4.32 and 4.33 (low equals the stop) | below the stop (no touch, `G-03`); never above, because no grid price lies between (`G-04` pins the stored level and the other direction) |
| `G-05a`, `G-05b` | gap above the target, the open equals the target 5.67 and 5.68 | below (fill 5.66, `G-05a`); above (no gap, `G-05b`) |
| `G-06`, `G-06b` | gap through the stop, the open equals the stop 4.32 and 4.33, slippage applies (fill floor(open x 0.99)) | below the stop (no gap, `G-06`); never above (`G-06b`) |
| `G-07a`, `G-07b` | a stop of exactly 0 (ATR6 = 5/6 and 7/6, stop multiplier 6) is `INVALID_LEVEL` at the entry open, partial journal as in `I-03` | ATR below, so the stop is a small positive number and is accepted (`G-07a`); never when the ATR rounds above, because the stop is then negative and is rejected as well (`G-07b`) |
| `G-08a`, `G-08b` | break-even trigger `high >= entry + 3 x entry_atr` fires on a high that equals the level (5.68, 5.67) and not on the bar one tick below | above (no trigger, `G-08a`); never below (`G-08b`) |
| `G-09a`, `G-09b`, `G-09c` | entry signal `3 x SMA3 >= K` (`<= K` in `G-09c`) where the three closes sum to K exactly (6.01, 6.02) | below for `>=` (`G-09a`); above for `<=` (`G-09c`); never above for `>=` (`G-09b`) |
| `G-10`, `G-10b`, `G-11`, `G-11b` | stop (`G-10`, `G-11`) or target (`G-10b`, `G-11b`) touched at exactly 4.78 or 5.66 after a 3-for-1 or 7-for-2 split at index 6 and its reverse split at index 8; quantities 200, 600, 200 and 200, 700, 200 are whole | depends on how the division and the later multiplication are rounded: below makes the stop miss and floors the target fill to 5.65, above makes the target miss |

The cases marked "never" in the last column pin the direction that a rounding computation would still decide correctly. They exist so that a repair cannot swap one direction for the other.

Derivation method. Every case is a reduced strategy: the SMA and ATR windows, the multipliers and the comparison are data, and the instrument has one entry and few sessions. Indices 0 to 3 are flat bars of true range 0.20 and the signal bar (index 4) is chosen so that the three true ranges add up to the stated sum. The multiplier 3 cancels the divisor 3, so the level is the grid price entry plus or minus the sum. The bar before the tie stays one tick inside the level and the tie bar equals it exactly. `derivation.md` lists numbered rational steps (the true ranges, the sum, ATR = sum / 3, the exact levels, the sizing, the touch or gap test, the fill and the cash) that a reviewer can check by hand, and the oracle asserts a set of hand-derived values against its own output. The split cases use ATR3 = 0.22, which terminates, so that only the split conversion leaves the grid: 4.78 and 5.66 are not multiples of 3 cents (478 = 3 x 159 + 1, 566 = 3 x 188 + 2) and the divisions by 3 and by 7/2 have no finite decimal form, while the reverse split restores every value exactly.

The expected daily positions state an entry price, stop or target only when it terminates, so the positions of `G-10` to `G-11b` between the two splits state their quantities only.

## Off-grid gap tests and a split round trip

`X-12` to `X-14` pin the touch tests and the fill rule against an off-grid level, and `X-13` pins one gap far above a target. Nothing there pins the gap tests `open <= stop` and `open >= target` for an open that is the grid price next to the level. An open is always a grid price and an off-grid level lies strictly between two grid prices, so a gap test that compares the open with the level rounded to the grid (`open >= floor(target)`, `open <= ceil(stop)`) differs from the exact test for exactly one open on each side. `G-12a` to `G-12d` pin both sides. They reuse the signal bars of `X-12` (target 367/6 = 61.1666..., `G-12a` and `G-12c`) and `X-14` (stop 137/3 = 45.6666..., `G-12b` and `G-12d`), enter 19 shares at 50.00 with a fixed fee of 1.00 and declare 150 bps of gap-exit slippage. Index 6 stays at the grid price next to the level without a gap or a touch, and index 7 decides.

| Cases | Pinned | Wrong rule and what it does |
| --- | --- | --- |
| `G-12a` | target 367/6; index 6 opens at 61.16 = floor(target) with a high of 61.16, index 7 opens at 61.16 and its high 61.17 reaches the target: no gap, `TARGET` at `DURING_SESSION` of index 7, filled at floor(367/6) = 61.16 | `open >= floor(target)` sells at the open of index 6 as `GAP_TARGET` at `OPEN` (same price, other session, phase and reason) |
| `G-12b` | stop 137/3; index 6 opens at 45.67 = ceil(stop) with a low of 45.67, index 7 opens at 45.67 and its low 45.66 reaches the stop: no gap, `STOP` at `DURING_SESSION` of index 7, filled at floor(137/3) = 45.66 without slippage | `open <= ceil(stop)` sells at the open of index 6 as `GAP_STOP` at `OPEN`, filled at floor(45.67 x 0.985) = 44.98 |
| `G-12c` | target 367/6; as `G-12a` but index 7 opens at 61.17 above the target: `GAP_TARGET` at `OPEN`, filled at floor(367/6) = 61.16, below the open and without slippage | `open > ceil(target)` misses the gap and the exit becomes an intraday `TARGET` touch; filling the gap at the open gives 61.17 |
| `G-12d` | stop 137/3; as `G-12b` but index 7 opens at 45.66 below the stop: `GAP_STOP` at `OPEN`, filled at floor(45.66 x 0.985) = floor(44.9751) = 44.97 | `open < floor(stop)` misses the gap and fills the touch at 45.66; rounding to nearest gives 44.98; no slippage gives 45.66 |

`G-10` to `G-11b` convert the levels with the ratios 3-for-1 and 7-for-2. `G-13` and `G-13b` use a third ratio, 17-for-2 at index 6, with the reverse 2-for-17 at index 8. The quantity is 200, 1700 and 200 shares (whole at each step), the stop 4.78 and the target 6.10 come from ATR3 = 0.22 with the multipliers 1 and 5, and between the splits they are 4.78 x 2/17 = 239/425 = 0.5623... and 6.10 x 2/17 = 61/85 = 0.7176.... Both fractions are in lowest terms and their denominators contain the prime factor 17, so neither has a finite decimal form; the entry price 10/17 and the ATR snapshot 11/425 leave the grid as well. The reverse split must restore the exact values: `G-13` touches the stop with a low of exactly 4.78 (the bar before has a low of 4.79), `G-13b` touches the target with a high of exactly 6.10 and fills at 6.10 (the bar before has a high of 6.09). A level that was divided and multiplied again with finitely many digits can come back one unit of its last digit from the grid price, and the direction decides whether the touch is missed or the fill is floored one tick low. A scratch program with `rust_decimal` 1.43.0 (not run by any test) applied the conversion that the core used before it compared exact levels, `value x old / new` in 28-digit decimals, to the 17-for-2 round trip and got 4.7799999999999999999999999995 for the stop and 6.1000000000000000000000000005 for the target: below and above the grid price, so a low of exactly 4.78 and a high of exactly 6.10 would both miss in a comparison of decimals. The same program returned 4.78 and 5.66 exactly for the 7-for-2 round trip of `G-11` and `G-11b`.

## Information cutoff

Every input states `windows.information_cutoff`. The deadline for a bar, a corporate action or halt evidence is the earlier of the session open (the next open for a bar) and the cutoff. The final session has only the cutoff. A bar or action available after its deadline fails with `FUTURE_DATA`. Halt evidence available after its deadline confirms nothing and does not fail the run. Cases `I-10`, `I-11` and `C-08` pin this rule. `I-09` pins the rejection of a bar on a session with a confirmed halt.

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
- `outcome_detail_includes`: stated by every INSUFFICIENT case (`I-02`, `I-07`, `C-02`, `C-06`). An
  array of strings that must each occur as a substring of `outcome.detail`. OQ-02 section 2.5
  requires an INSUFFICIENT result to report the instrument, the event, the missing evidence and the
  affected period. The oracle derives the strings from the case input only, never from the engine,
  so they fix the facts the text names and not its wording. Each array starts with the
  `instrument_id`, then, in this order:
  - `MISSING_REQUIRED_BAR`: the session date that has no bar.
  - `UNSUPPORTED_VALUATION`: the `event_id` of every confirmed halt covering the failing session, the
    failing session date and `windows.scored_end`.
  - `UNSUPPORTED_CORPORATE_ACTION` and `FRACTIONAL_ENTITLEMENT`: the `action_id` and the effective
    session date.
- `signals`: records matched by `session`. A case lists only the sessions it derives.
- `entries`, `fills`, `trades`, `cash_ledger`, `daily`, `corporate_actions`: arrays with the same
  length as the actual array. Each record states the fields it derives.
- `final`: the final state.

A completed case states all nine sections. A case that fails or is insufficient after processing
events states `outcome` and the journal sections through the last completed event (`signals`,
`entries`, `fills`, `cash_ledger`, `daily`, `corporate_actions`); an INSUFFICIENT case also states
`outcome_detail_includes`. A case rejected before the first event states `outcome` only.

## How a case is compared

The comparison reports each difference with its path, the expected value and the actual value.
It also counts checks: every scalar value and every array length that an expectation states is
one check. The report shows checks, matches and differences per section and in total.

- Decimal strings compare by value (`50` equals `50.00`). Strings outside the wire decimal
  grammar (`1e3`, `050`, `+1`, `-0`) and every other value compare exactly.
- An object in the expectation need only list the fields it derives; extra actual fields are not
  compared. Arrays must have the same length.
- Signals are matched by `session`, so a case can list a few sessions out of many.
- `outcome_detail_includes` is not compared as a subset of the result: each string is a substring
  test on `outcome.detail`, and the result has no section of that name.
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
  finite decimal form (see Off-grid levels and Grid ties) is a long rounded decimal, and expectations do not state it.
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
run leaves behind. The oracle writes its own manifest entries after all others, so a run can reorder
`fixtures/protocol/manifest.json` without changing the set of entries. Review that diff as a reorder
and restore it with `git checkout fixtures/protocol/manifest.json`.

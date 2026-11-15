# Shared Rust numerical library

Status: S0 implemented — offline seed evaluation on synthetic data. S1 adds the derived evidence of one run and one candidate: exact metrics, the buy-and-hold benchmark, the two audits, the cohort gates, lineage and the stored-checkpoint hash check, under a separate method identity. Crate `openquant-core`. The connected competition is not implemented: no job, route or service calls this evidence yet. Joint watchlist evaluation (S4) and live execution are not implemented.

Signals, simulation, accounting, portfolio, risk, and metrics. This is a library, not a set of separate services. Verify numerical semantics using independent fixtures.

S0 evaluates the daily swing seed as versioned Strategy Definitions through reviewed typed operators, with synthetic inputs and a local harness. Threshold and break-even changes belong to the definitions, not separate Rust strategy paths. Use the input/result/checkpoint schemas owned by `api-contracts`.

## Numerics

Every value that feeds a price-grid decision is an exact fraction (`Ratio` in `src/ratio.rs`: two `i128`, always reduced, positive denominator). That covers the operator evaluator (means, RSI, true range, ATR, arithmetic, every comparison), bar prices after a split adjustment, and the levels a position holds: entry price, stop, target, scheduled stop and snapshots. A level is never rounded: `5 + 3 * (0.67 / 3)` is exactly `5.67`, a high of `5.67` touches it, `5 - 6 * (5 / 6)` is exactly zero and fails `0 < stop`, and a forward split followed by its reverse returns a level to its exact value. The touch, gap, validity, break-even and entry comparisons all read the exact value. The fill price of a touched or gapped level is the exact level floored to the price grid, and the gap slippage rule is unchanged.

Money, quantities, caps, fees, marks and ranks stay `Decimal` with the rounding rules of OQ-02 section 2.5. A level meets them in one place only: the sale price. A result shows a level as a `Decimal`: the exact decimal when it terminates within 28 fractional digits, otherwise the exact value rounded half-even to the most digits a decimal carries (`Ratio::to_display_decimal`).

The exact domain is a fraction whose numerator and denominator fit a signed 128-bit integer. The seed strategies fit. Some ordinary expressions do not: the mean of `close / open` over ten sessions overflows at 2 price decimals (seven sessions at 4 decimals, four at 8). The S0 policy also admits extreme compositions (a price near 5 × 10^8 with 8 digits times a constant near 10^12 with 12 digits). Such a composition is not rounded and does not wrap: the run fails with `ARITHMETIC_OVERFLOW` and produces no completed result. Comparison never overflows. A level with an integer part of 2^96 or more fits 128 bits but has no decimal view, so no result or checkpoint could carry it. `Run::step` checks every level, snapshot and scheduled stop after each event and fails the event that creates such a value (`State::check_renderable`). `Run::restore` makes the same check.

Failure text that prints a level uses the canonical form of `Ratio`'s `Display` (a normalised decimal, or a reduced fraction `n/d`), so an uninterrupted run and a run restored from a checkpoint at any cut produce byte-identical results. The checkpoint stores levels and snapshots in the same form (`Exact` in `api-contracts`). S1 and the installed CLI reuse this validator and evaluator. Joint watchlist evaluation remains S4.

## Derived evidence (S1)

Everything below reads a result and never changes it. Engine identity is unchanged: `Contract`, `Contract::ALL`, `ENGINE_DIGEST` and every S0 fixture are byte-identical. Derived evidence has its own identity, the digest of the reviewed method text `src/method.txt` (`method_identity()`: name `openquant-evidence-methods`, version `1`), pinned by `tests/method_golden.rs`. A change to what any module below computes is a change to that text, and so to the method digest, and needs an explicit compatibility decision (OQ-02 section 7).

| Module | What it does |
| --- | --- |
| `exact` | `Q`, an exact fraction of unbounded integers. Ratios, money and means are computed without rounding and written once, half-even. The evaluator does not use it; it keeps `Ratio` (two `i128`) for price-grid decisions. A mean of ratios over 250 sessions has a denominator that 128 bits cannot hold, so evidence needs this type. No float anywhere. |
| `metrics` | `compute_metrics`: the `evaluation-metrics/1` of one `COMPLETED` run: net return, maximum drawdown, worst session return, turnover, trade and session counts, execution cost (fees plus gap slippage), exposure, buy-and-hold and excess return. Scored sessions only. A result that did not complete, belongs to another run, or contradicts itself is refused, never guessed. |
| `benchmark` | `buy_and_hold`: the largest whole-lot quantity that the initial capital covers with the run's fee at the first fillable open of the scored window, held with the run's corporate-action handling, marked at each close and never sold. It reuses the evaluator's lot search and dividend rule. A benchmark that has no value says why. |
| `audit` | `audit_run`: accounting reconciliation (the journal against itself and the capital, exact) and signal and data timing (phases, sessions, availability), the two audits that the correctness gates read. |
| `gates` | `assess` and `report`: the 17 gates of the cohort suite from a candidate's evidence and the registered `cohort-policy/1`, written as `gate-report/1`. A required gate without a reviewed method is an error. |
| `lineage` | The leaf-level rule difference between a parent and a child strategy, classified by dependency into entry, exit or other, the declared-change check and the lookback check of the `validate` job, written as `validation-result/1`. |
| `method` | The method text and its identity. |
| `Run::restore_stored` | Restores a checkpoint from stored bytes only after their SHA-256 matches the digest they are stored under. |

Choices that the frozen specification leaves open, each stated in `src/method.txt`:

- **Gap slippage** is measured against the open of the exit session (`quantity * (open - fill price)`), not against the stop level that `evaluation-metrics/1` names. The stop is not recoverable exactly from the journal when it is off the price grid, and a stop-based figure would add the market's own gap to the cost model.
- **Excess return** is the exact strategy return minus the exact benchmark return, rounded once. It can differ by one unit of the last digit from the difference of the two published returns. Gates compare the published value.
- **Candidate defects** (`INVALID_LEVEL` and the four operator codes) fail `DEFINITION_VALIDATION` only. The other correctness gates are `INSUFFICIENT` with `RUN_FAILED`: a failed run has no ledger, timing or result, and a gate is not failed without evidence of a defect.
- **A measured threshold failure beats missing evidence.** A gate whose threshold provably fails in one window is `FAIL` (or `INSUFFICIENT` with `BELOW_THRESHOLD`) even when another window has no run.
- **A change that cannot be declared.** A declared change holds 256 characters. Replacing a list renders the whole list, so a revision that adds or removes an indicator or a snapshot cannot declare its change and reports `LINEAGE_MISMATCH`.

Expected values come from independent calculations: `fixtures/s1/metrics` (an exact-fraction oracle script, hand derivations, and the S0 oracle's journals), compared with a tolerance of zero.

See [architecture](../../docs/specs/05-system-architecture-and-data-spec.md) and the [M1 guide](../../docs/guides/m1-watchlist-research.md).

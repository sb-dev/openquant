# S0 offline seed evaluation

Date: 2026-11-13. Owner: OQ-06 section 8 (S0), OQ-02 sections 2.2 to 2.6, OQ-05 section 7.

Status: implemented on branch `ccr-17c8728f-tu3pa4` and verified locally with `node scripts/verify.ts`. Independent review outcomes are in the last section. This log explains decisions. The canonical specifications own the requirements.

## What S0 adds

- A Cargo workspace with three crates and a pinned toolchain: `openquant-contracts` (bindings, validation, canonical JSON, digests), `openquant-core` (validator, operators, signals, execution phases, accounting, corporate actions, checkpoint) and `openquant-engine` (`s0-replay`, comparator, report).
- Five versioned JSON Schemas (`common`, `strategy-artefact`, `evaluation-input`, `evaluation-result`, `checkpoint`). Rust bindings are generated at build time. Every payload is checked against the schema and against a strict typed parse.
- Four seed Strategy Definitions (RSI threshold 30 or 32, break-even off or on) and a fifth data-only variant (threshold 40). They differ only in data. A test scans the shared code for variant names.
- 67 replay cases: F0-smoke (lead-derived smoke case) and 66 cases derived by an independent exact-arithmetic oracle. Each case records the SHA-256 of the oracle script that produced it.

## Declared policy (synthetic, not a vendor model)

The specification says a registered policy binds costs and scales, so these values are policy data in the input, not code constants.

| Item | Value in the fixtures |
| --- | --- |
| Policy | `daily-long-only-cash@1`, USD, price scale 2, quantity scale 0, money scale 2, diagnostic scale 4 (fixtures) |
| Cost model | `fixed_plus_bps@1`: fee = ceil(fixed + bps x notional / 10000) to the money scale, on every fill |
| Slippage | `gap_exit_slippage_bps` applies only to a gap-through-stop exit. The fill is floor(open x (1 - bps / 10000)) to the price scale |
| Touched exits | An intraday stop or target touch, and a gap above a target, fill at the level floored to the price scale. A sale never receives more than its level. A level is off the price grid when the ATR does not terminate |
| Sizing | cap = floor(unreserved cash / vacant slots) at the signal close. Quantity = the largest lot multiple with notional + fee <= cap |
| Corporate actions | `split_cash_dividend_ex_date@1`: split and ordinary cash dividend at the ex-date; other kinds give INSUFFICIENT |
| Dividend receivable | floor(held x amount x (1 - withholding_bps / 10000)) to the money scale. `held` is the quantity before a same-day split |
| Availability | Evidence is usable when `available_at` is not later than the deadline. The deadline is the earlier of the next session open and `information_cutoff` |
| Bounds | price <= 1e9, volume <= 1e15, capital <= 1e15, scales within the schema maxima |
| Validator limits | expression depth 16, 128 nodes, cost 200,000, window <= 252, periods <= 60, total lookback <= 400, evaluation depth through `ref` 64, whole-strategy cost 1,000,000 |

## Interpretations the specification leaves open

Each item is a choice made during implementation. Each is pinned by a named test or fixture case.

1. RSI is computed as 100 x sum of gains / (sum of gains + sum of losses). It equals the simple-mean form and avoids an inexact ratio. Both sums zero gives a missing value (`UNDEFINED_FLAT`). Pinned by SEM-01, SEM-02, SEM-04, SEM-04b.
2. The simple moving average includes bar t. Pinned by SEM-05.
3. The catalogue holds 19 operators. The five seed artefacts use 18 of them. `lt` is supported and used by no seed or fixture strategy. `min`, `max` and `ema` give `UNSUPPORTED_OPERATOR` although OQ-02 section 2.2 lists some of them. Pinned by `operators_catalogue`.
4. Any missing boolean operand makes `and` and `or` missing, even if another operand would decide the result. A missing entry condition skips the entry as `INDICATOR_UNAVAILABLE`. Pinned by SEM-02.
5. The missing reason of `lag` is the reason of its argument. Pinned by SEM-02, SEM-03.
6. Boundary equalities: a gap exit when open <= stop or open >= target; an intraday touch when low <= stop or high >= target; the break-even trigger uses high >= entry + snapshot. Pinned by X-05 to X-09.
7. If one bar touches both stop and target, the stop wins and `ambiguous_bar` is true. Pinned by X-07.
8. A break-even stop is decided at the close and takes effect before the next open. It applies to a position filled that day. Pinned by X-09a, X-09b.
9. A dividend entitlement uses the quantity held at the start of BEFORE_OPEN, before a same-day split. A position that exits at the ex-date open is still entitled. A zero entitlement creates no receivable and no ledger line, but the action is recorded as applied. Pinned by C-03, C-04, C-05.
10. Receivables are not cash and are excluded from the unreserved cash that sizes an entry. They are paid at the declared phase of the payment session. The schema and the code accept BEFORE_OPEN, OPEN, DURING_SESSION and AFTER_CLOSE. Pinned by C-03, C-04a to C-04c.
11. A split converts quantity, entry price, stop, target, mark, scheduled stop, unit-typed snapshots and the open trade record to the new share basis. Reserved caps and ranks do not change. A fractional result gives INSUFFICIENT `FRACTIONAL_ENTITLEMENT`. Pinned by C-01a to C-01c, C-02.
12. A level converted by a split ratio that does not terminate is rounded at 28 significant digits. A comparison against a grid price stays exact because the rounding error (at most 5e-27) is smaller than the grid step.
13. `INVALID_LEVEL` (a stop or target that breaks 0 < stop < entry < target) is FAILED and rolls back the whole OPEN event. The reservation line stays in the journal. Pinned by I-03.
14. An event that fails is rolled back as a whole. The journal holds everything through the last completed event, and `outcome.at` names the failing event. Pinned by C-02, C-06, C-07, C-08, I-01, I-02, I-03, I-07, I-10, I-11.
15. A confirmed halt known at the open and a supplied bar for the same session are contradictory. The input is rejected as `INVALID_INPUT` before any event. The alternative, ignoring the bar, was rejected because it would hide a data error. A halt that becomes available only after the open does not confirm a halt. Pinned by I-09 and `input_validation_prepare`.
16. Holding a position through a confirmed halt gives INSUFFICIENT `UNSUPPORTED_VALUATION`. No liquidation price is invented. Pinned by I-07.
17. Evidence available exactly at its deadline is usable. Evidence available later is future data and fails the run (`FUTURE_DATA`, FAILED). It is not a missing observation (`INSUFFICIENT`), because the evidence exists. OQ-02 section 2.5 now states this. Pinned by `information_cutoff.rs`, I-01, I-10, I-11, C-07, C-08.
18. A stop or target that is touched intraday fills at the level floored to the price scale. A gap above a target fills at the target floored to the price scale. Pinned by `execution_exits.rs` and the off-grid cases X-12 to X-14.
19. The dividend receivable is floor(held x amount x (1 - withholding_bps / 10000)) to the money scale. Pinned by R-01 and `corporate_actions_dividend.rs`.
20. A break-even stop level must satisfy 0 < level < target. Any other level gives FAILED `INVALID_LEVEL`. No level is invented. Pinned by `execution_exits.rs`.
21. A sale whose fee would leave cash negative is refused with FAILED `UNSUPPORTED_POLICY`. Cash never goes negative. No fixture case or named test forces this path. `properties_execution_random.rs` only allows the code among the accepted outcomes.
22. INSUFFICIENT outcomes carry the instrument, the event, the missing evidence and the affected period in `outcome.detail` (OQ-02 section 2.5). The cases state the required substrings in `outcome_detail_includes`. The wording is not pinned, only the facts.
23. Spread, latency and participation (OQ-02 section 3.3) are not modelled. The S0 cost model is `fixed_plus_bps@1` plus gap-exit slippage only.

## Information cutoff (owner review, PR #8)

The owner review found that the last session skipped the availability check, because no next open bounded it. `windows.information_cutoff` is now a required instant in `evaluation-input/1`.

- The deadline for a decision is the earlier of the next session open and the cutoff. At the final session the cutoff is the only deadline, so the check still runs and the closing mark is covered.
- The same deadline applies to corporate actions at BEFORE_OPEN and to halt evidence that confirms a halt.
- A bar or action available after its deadline fails with FAILED `FUTURE_DATA`. Availability exactly at the deadline is accepted. A halt known only after its deadline does not confirm the halt.
- OQ-02 section 2.5 and OQ-05 section 7 now state the rule and bind the cutoff into the evaluation input identity.
- The cutoff is part of the input, so it is part of `input_hash`.
- Pinned by fixtures I-10 (final bar), I-11 (cutoff before the next open), C-08 (action), the protocol cases `input.cutoff-missing`, `input.cutoff-malformed`, `input.cutoff-impossible`, and `tests/information_cutoff.rs`.
- Mutation check: restoring the old after-close behaviour fails I-10, I-11 and two core tests. Removing the action and halt deadlines fails C-08 and two core tests. Both were restored.

## Differences from the source scripts

OQ-02 section 2.6 and the OQ-06 S0 row "Seed semantics" require these to be explicit. The scripts V1 and V2 are outside Git. Their SHA-256 values are in `2026-11-07-strategy-research-and-evaluation.md`. The "Source" column below is taken from that log, not from the script bytes. Nobody compared the S0 rules with the script code for this log.

| Category (OQ-02 section 2.6) | Source (as described on 2026-11-07) | S0 seed |
| --- | --- | --- |
| Warm-up and undefined values | Not recorded in the 2026-11-07 log | RSI needs window + 1 closes. A flat window (no gains and no losses) gives a missing value `UNDEFINED_FLAT`. A missing operand skips the entry as `INDICATOR_UNAVAILABLE`. First valid index 49 for the 50-bar average |
| Price basis and corporate actions | Not recorded | Signals read a causal split-adjusted series. Fills and marks use raw prices. Split and cash dividend apply at the ex-date. Other kinds give INSUFFICIENT |
| Entry timing | Completed-bar signals at the same close | The signal is decided at the close. The entry fills at the next session open |
| Stop changes | V2 updates the stop from the high before it checks the low | The break-even trigger is decided at the close. The new stop takes effect before the next open |
| Intraday order | The order of high and low is unknown | If one bar touches both stop and target, the stop wins and `ambiguous_bar` is true |
| Ties | Not recorded | Rank descending, then instrument id ascending |
| Cash accounting | Available cash divided by vacant slots | Exact decimal cash. Cap = floor(unreserved cash / vacant slots). Quantity is the largest lot multiple that fits with the fee. Reservations are released when an entry is skipped |
| Costs | Not recorded | `fixed_plus_bps@1` fee on every fill. Gap-through-stop exits add slippage |
| Alignment | Both align stocks by row number | Sessions come from the calendar. S0 evaluates one instrument |
| Valuation cutoff | V1 downloads maximum history. V2 downloads one year and evaluates at most 60 rows | Frozen input windows and an explicit `information_cutoff` |
| Remaining positions | Both can mark remaining positions beyond the simulated endpoint | Open positions are marked at the final close. The result reports `OPEN_AT_END`. Nothing is liquidated |

The seed contract assumptions in the strategy artefacts do not list these rows. The log is the record for S0.

## How the evidence is independent

- The oracle uses Python `fractions`. A blind author wrote 62 of the cases. That author did not read the Rust core and did not run Cargo. Expected values come from the oracle and hand derivations. The engine never generates them.
- After the engine, the oracle and the harness were merged, all 63 cases matched without any edit to an expected value. Twelve cases failed on the corporate-action path only before the execution agent's work was merged.
- The cutoff change edited the oracle after the engine existed. It changed no existing expected value. A script compared every existing `input.json` and `expected.json` before and after: only `information_cutoff` and the oracle hash differ. Cases I-09, I-10, I-11 and C-08 were written by the lead with the engine in view. Their independence rests on the blind re-derivation in the review step.
- The oracle runs only by hand. `node scripts/verify.ts` does not run it, and it fails if any file under `fixtures/` changes while it runs.

## Known limits

- S0 contributes to acceptance A03 to A05 only. A11 distributed recovery, the public CLI, TypeScript parity and S4 joint ranking are not covered.
- Rank ties compare exact decimal ranks, which carry at most 28 significant digits. This is exact for the single-instrument S0 case. A tie between instruments with ranks that differ beyond 28 digits is not covered. S4 joint ranking is not covered.
- Level and trigger expressions may contain a literal PRICE constant. A split converts stored levels and unit-typed snapshots. It does not convert a literal constant inside a trigger expression. No seed definition uses such a constant.
- `operator_set_digest` covers the catalogue text. The validator limits (window, periods, constant magnitude and scale) live in `compile.rs` and `strategy.rs`, not in the digested text. Raising a limit does not change the digest. A18 invalidation is out of S0 scope.
- `expected.json` files are bound to the oracle by `origin.oracle_sha256`, which hashes `oracle.py` only. `node scripts/verify.ts` does not re-derive expected values and does not hash them. CODEOWNERS review of `/fixtures/` guards an edit to an expected value.
- `outcome.status` in `evaluation-result/1` holds the numerical evaluation outcome. S1 maps it to run status and gate result (OQ-02 section 3.6). The schema does not tie each code to a status. The engine does, in `status_of`.
- The deep restore check (checkpoint text, then run to the end) runs at every cut for runs of at most 128 events. Longer runs run it at about 16 spread cuts plus the last. Every cut still gets a checkpoint, restore and field-by-field state comparison.
- Arithmetic overflow is a typed failure, never a silent rounding. A proptest shows this for 250 generated extreme cases, not for every input.
- Fee and scale values are declared synthetic policy. They are not a vendor fee model.

## Verification record

Run on the merged tree with `node scripts/verify.ts` (Node 22 locally, 24 in CI):

- repository checks and 87 repository tests;
- `cargo fmt --all --check`, `cargo clippy --workspace --all-targets --locked -- -D warnings`, `cargo test --workspace --locked` (347 tests passed);
- `s0-replay`: 67 cases, 0 failed, 0 coverage problems, deterministic repeat and restore from every cut point;
- fixtures unchanged while verification ran.

## Independent review outcomes

Pending. The four reviews (numerical correctness, Rust quality, specification compliance, verification coverage) are recorded here after they run.

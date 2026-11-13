# S0 offline seed evaluation

Date: 2026-11-13. Owner: OQ-06 section 8 (S0), OQ-02 sections 2.2 to 2.6, OQ-05 section 7.

Status: implemented on branch `ccr-17c8728f-tu3pa4` and verified locally with `node scripts/verify.ts`. Independent review outcomes are in the last section. This log explains decisions. The canonical specifications own the requirements.

## What S0 adds

- A Cargo workspace with three crates and a pinned toolchain: `openquant-contracts` (bindings, validation, canonical JSON, digests), `openquant-core` (validator, operators, signals, execution phases, accounting, corporate actions, checkpoint) and `openquant-engine` (`s0-replay`, comparator, report).
- Five versioned JSON Schemas (`common`, `strategy-artefact`, `evaluation-input`, `evaluation-result`, `checkpoint`). Rust bindings are generated at build time. Every payload is checked against the schema and against a strict typed parse.
- Four seed Strategy Definitions (RSI threshold 30 or 32, break-even off or on) and a fifth data-only variant (threshold 40). They differ only in data. A test scans the shared code for variant names.
- 98 replay cases: F0-smoke (lead-derived smoke case) and 97 cases derived by an independent exact-arithmetic oracle. 25 of them (G-01 to G-13b, grid ties) were written blind after the owner review of `19baa96`, and 3 more (I-12a to I-12c, levels without a decimal view) after the round 3 reviews (see Round 3).

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

Each item is a choice made during implementation. Each is pinned by a named test or fixture case, except interpretation 23, which records a feature that S0 does not have.

1. RSI is computed as 100 x sum of gains / (sum of gains + sum of losses). It equals the simple-mean form and avoids an inexact ratio. Both sums zero gives a missing value (`UNDEFINED_FLAT`). Pinned by SEM-01, SEM-02, SEM-04, SEM-04b.
2. The simple moving average includes bar t. Pinned by SEM-05.
3. The catalogue holds 19 operators. The five seed artefacts use 18 of them. `lt` is supported and used by no seed or fixture strategy. `min`, `max` and `ema` give `UNSUPPORTED_OPERATOR` although OQ-02 section 2.2 lists some of them. Pinned by `operators_catalogue`.
4. Any missing boolean operand makes `and` and `or` missing, even if another operand would decide the result. A missing entry condition skips the entry as `INDICATOR_UNAVAILABLE`. Pinned by SEM-02.
5. The missing reason of `lag` is the reason of its argument. Pinned by SEM-02.
6. Boundary equalities: a gap exit when open <= stop or open >= target; an intraday touch when low <= stop or high >= target; the break-even trigger uses high >= entry + snapshot. Pinned by X-05 to X-09.
7. If one bar touches both stop and target, the stop wins and `ambiguous_bar` is true. Pinned by X-07.
8. A break-even stop is decided at the close and takes effect before the next open. It applies to a position filled that day. X-09a and X-09b pin the close decision and the next-session effect. `execution_exits.rs` `break_even_on_and_off_give_different_scheduled_stops_and_exits` pins the fill-day rule. No fixture case triggers on the fill day.
9. A dividend entitlement uses the quantity held at the start of BEFORE_OPEN, before a same-day split. A position that exits at the ex-date open is still entitled. A zero entitlement creates no receivable and no ledger line, but the action is recorded as applied. C-03, C-04 and C-05 pin the pre-split quantity and the zero entitlement. `corporate_actions_dividend.rs` `a_position_that_gaps_out_at_the_ex_date_open_is_still_entitled` pins the ex-date exit.
10. Receivables are not cash and are excluded from the unreserved cash that sizes an entry. They are paid at the declared phase of the payment session. The schema and the code accept BEFORE_OPEN, OPEN, DURING_SESSION and AFTER_CLOSE. C-03, C-04 and C-04a to C-04c pin BEFORE_OPEN, OPEN and AFTER_CLOSE and the sizing rule. No fixture pays at DURING_SESSION. Only `corporate_actions_dividend.rs` covers it.
11. A split converts quantity, entry price, stop, target, mark, scheduled stop, unit-typed snapshots and the open trade record to the new share basis. Reserved caps and ranks do not change. A fractional result gives INSUFFICIENT `FRACTIONAL_ENTITLEMENT`. Pinned by C-01a to C-01c, C-02.
12. Every level is held exactly. A mean, RSI, true range, ATR and every arithmetic result is a fraction of two 128-bit integers (`Ratio`, reduced, positive denominator). A level such as `5 + 3 x (0.67 / 3)` is exactly 5.67. A split divides a level by `r` without rounding, so a split followed by its reverse restores every level. Every decision uses the exact value: the intraday touch, the gap tests, `0 < stop < entry < target`, the break-even trigger, the new-stop check and the entry signal. Only the fill price meets the price grid: it is the exact level floored to the price scale (interpretation 18). A value that is shown is the exact value rounded half-even. A level, a snapshot and the rank of an entry record use the most fractional digits a 96-bit decimal carries (at most 28, and 28 or 29 significant digits). A signal indicator and the rank of a signal record use `diagnostic_scale`. That rounding never feeds a decision, except that rank ties compare the rounded entry rank (Known limits). The first version of S0 rounded levels at 28 digits and was wrong on a tie. Round 2 numerical F-1 reported it, and the owner reproduced it on `19baa96`: ATR3 with target multiplier 3, true ranges 0.20, 0.20 and 0.27, entry 5.00 and high 5.67 gave a stored target of 5.6699999999999999999999999999 and a sale at 5.66 and not at 5.67. A level of 5/6 x 6 at entry 5 gave an exact stop of 0, which the first version accepted as 0.0000000000000000000000000002. Pinned by G-01 to G-11b and by `exact_levels.rs`, `exact_state.rs`, `ratio.rs` and `signals_split_adjustment.rs`.
13. `INVALID_LEVEL` (a stop or target that breaks 0 < stop < entry < target) is FAILED and rolls back the whole OPEN event. The reservation line stays in the journal. Every comparison of the rule uses the exact value, not the grid price: a stop that is one exact fraction below the entry is valid even where its grid ceiling equals the entry, and a stop or target equal to the entry is invalid. Pinned by I-03, G-07a, G-07b and by `exact_levels.rs` (`a_stop_is_valid_one_exact_fraction_below_the_entry_and_invalid_at_or_above_it`, `a_target_is_valid_one_exact_fraction_above_the_entry_and_invalid_at_or_below_it`, `a_positive_stop_below_one_price_unit_is_valid_and_a_negative_one_is_not`). Round 3 spec F4 found these bounds unpinned: a mutant that tested the grid prices instead survived every test.
14. An event that fails is rolled back as a whole. The journal holds everything through the last completed event, and `outcome.at` names the failing event. Pinned by C-02, C-06, C-07, C-08, I-01, I-02, I-03, I-07, I-10, I-11.
15. A confirmed halt known at the open and a supplied bar for the same session are contradictory. The input is rejected as `INVALID_INPUT` before any event. The alternative, ignoring the bar, was rejected because it would hide a data error. A halt that becomes available only after the open does not confirm a halt. Pinned by I-09 and `input_validation_prepare`.
16. Holding a position through a confirmed halt gives INSUFFICIENT `UNSUPPORTED_VALUATION`. No liquidation price is invented. Pinned by I-07.
17. Evidence available exactly at its deadline is usable. Evidence available later is future data and fails the run (`FUTURE_DATA`, FAILED). It is not a missing observation (`INSUFFICIENT`), because the evidence exists. OQ-02 section 2.5 now states this. Halt evidence is the one exception. Halt evidence available after its deadline confirms nothing (interpretation 15). It is not future data. A session with no bar and no usable halt evidence is INSUFFICIENT `MISSING_REQUIRED_BAR`. A session with a bar is accepted and the late halt evidence is ignored. Pinned for bars and actions by `information_cutoff.rs`, I-01, I-10, I-11, C-07, C-08. Pinned for late halt evidence by `information_cutoff.rs` `a_halt_known_only_after_the_cutoff_does_not_confirm_the_halt` and `execution_nontrading.rs` `halt_evidence_that_arrives_after_the_open_does_not_explain_the_missing_bar`. No fixture case pins late halt evidence.
18. A stop or target that is touched intraday fills at the exact level floored to the price scale. A gap above a target fills at the exact target floored to the price scale. Every touch and gap test compares the bar with the exact level, never with the floored one. X-12 has a high 0.0067 below a target of 367/6 (61.1666...) and X-14 has a low 0.0033 above a stop of 137/3 (45.6666...). Neither bar is a touch. Pinned by `execution_exits.rs`, by the off-grid cases X-12 (intraday target), X-13 (gap above target) and X-14 (intraday stop), and by the grid-tie cases: G-01 to G-04 (intraday touch, both rounding directions), G-05a and G-05b (gap above a target equal to the open), G-06 and G-06b (gap through a stop equal to the open, with slippage), G-07a and G-07b (exact zero stop), G-08a and G-08b (break-even trigger), G-09a to G-09c (entry signal), G-10 to G-11b (levels after a split and its reverse) and G-12a to G-13b. G-12a to G-12d pin the gap tests against a level that is off the grid, which round 2 F-3 found missing. G-12a (target 367/6) opens at 61.16, the floor of the target, so it is no gap and the exit is an intraday touch. G-12c opens at 61.17 and exits as `GAP_TARGET` at the floored target 61.16. G-12b (stop 137/3) opens at 45.67, the ceiling of the stop, so it is no gap. G-12d opens at 45.66 and exits as `GAP_STOP` with the declared slippage (floor of 44.9751 is 44.97). G-13 and G-13b hold a stop 4.78 and a target 6.10 through a 17-for-2 split and its reverse. The converted levels 239/425 and 61/85 do not terminate. The fixtures agent reported, from a scratch run of the old arithmetic (`rust_decimal`, not the old engine), that 4.78 returns as 4.7799999999999999999999999995 and 6.10 as 6.1000000000000000000000000005.
19. The dividend receivable is floor(held x amount x (1 - withholding_bps / 10000)) to the money scale. Pinned by R-01 and `corporate_actions_dividend.rs`.
20. A break-even stop level must satisfy 0 < level < target, on the exact value. Any other level gives FAILED `INVALID_LEVEL` at the close that decides it. No level is invented. `execution_exits.rs` `a_new_stop_at_or_above_the_target_is_an_invalid_level` pins the upper bound only. Round 3 (spec F4, Rust F2) found that no test pinned the lower bound. Pinned now by `exact_levels.rs` `a_break_even_new_stop_of_exactly_zero_is_an_invalid_level_at_the_close` and `a_break_even_new_stop_is_valid_one_exact_fraction_inside_each_bound_and_invalid_on_it`.
21. A sale whose fee would leave cash negative is refused with FAILED `UNSUPPORTED_POLICY`. Cash never goes negative. Pinned by `execution_nontrading.rs` `a_sale_whose_fee_would_leave_cash_negative_is_refused`. No fixture case forces this path.
22. INSUFFICIENT outcomes carry the instrument, the event, the missing evidence and the affected period in `outcome.detail` (OQ-02 section 2.5). The cases state the required substrings in `outcome_detail_includes`, and the comparator checks that each one occurs in the actual detail. The wording is not pinned, only the facts: `MISSING_REQUIRED_BAR` names the instrument and the session date; `UNSUPPORTED_VALUATION` names the instrument, the event id of every confirmed halt that covers the failing session, the failing session date and `windows.scored_end`; `UNSUPPORTED_CORPORATE_ACTION` and `FRACTIONAL_ENTITLEMENT` name the instrument, the action id and the effective session date. Pinned by I-02, I-07, C-02, C-06 and `insufficient_detail.rs`. The detail is cut at 1,000 characters, so a very long list of halt ids is not named in full (see Known limits).
23. Spread, latency and participation (OQ-02 section 3.3) are not modelled. The S0 cost model is `fixed_plus_bps@1` plus gap-exit slippage only.
24. A session without a bar (a confirmed halt) writes a daily record and no signal record. Every window that spans that session is missing history. Pinned by I-06 (6 sessions, 5 signal records, 6 daily records).
25. `Run::prepare` applies input rules that the schema cannot state, and fails the run before any event when one is broken: `fee_bps` and `gap_exit_slippage_bps` below 10,000; `withholding_bps` at most 10,000; `money_scale` at least `price_scale` plus `quantity_scale`; instrument id at most 51 characters; dividend amount at most 8 decimals; payment session on the calendar and not before the ex-date; bar `available_at` not before `event_time`; calendar strictly ascending and without overlap. `input_validation_prepare.rs` tests the calendar, policy, window, bar, action and instrument-id rules. Nobody mapped each single rule to one test.
26. For a FAILED or INSUFFICIENT result, `final` holds the state after the last completed event, with the last mark. It is not a valuation at the failing event. In I-07 `final.equity` is 4998.05 (the close of 2026-01-14) while the outcome is `UNSUPPORTED_VALUATION` at 2026-01-15 AFTER_CLOSE. The `FinalState` schema description now says so. I-07 pins the outcome and its location. No fixture or test pins `final.equity` of a failed run: a round 3 verifier read 4998.05 by running I-07.
27. The exact domain has a limit. A `Ratio` holds two 128-bit integers. An operation whose result, or an intermediate of it, needs more than 128 bits does not round and does not wrap. It fails the run with FAILED `ARITHMETIC_OVERFLOW` before a completed result. This is the explicit rejection OQ-02 section 2.5 now allows. Some results that would fit are rejected too, because an intermediate does not fit. The checking agent compared `Ratio` with Python `Fraction` on about 660,000 generated operations and reported 10 to 80 such rejections in every 94,500 operations at the edge of the range, for example `x + x` with equal huge denominators. The seed strategies fit. Some ordinary expressions do not. The lead measured the mean of `close / open` over random prices near 100 (5 seeds each): it fits up to 9 sessions at 2 price decimals and overflows from 10 (3 of 5 runs; 5 of 5 from 12), fits up to 6 sessions at 4 decimals and overflows from 7, and fits up to 3 sessions at 8 decimals and overflows from 4. `sma(close, w)` never overflowed up to w = 14. A price near 5 x 10^8 with 8 fractional digits, multiplied by a constant near 10^12 with 12 fractional digits, is admitted by the policy and is rejected. Round 3 reported the first measurement (expressions reviewer F2), and the lead repeated it. Pinned by `exact_state.rs` `a_level_that_does_not_fit_128_bits_fails_the_run_with_a_typed_overflow` and `ratio.rs`.
28. The checkpoint carries a level, a snapshot or a scheduled stop as `Exact` (`common.schema.json`): a normalised decimal when the value terminates within 28 fractional digits, otherwise a reduced fraction `n/d`. Result views keep decimals. Restore rejects, with `INVALID_DECIMAL`, a fraction that is not reduced, has denominator 1, could be written as a decimal, or does not fit 128 bits. `checkpoint/1` is first defined in this pull request and no reader existed before it, so the fraction form belongs to its first definition and needs no version bump. OQ-05 section 7 states the exception. A value that fits 128 bits but not the 96 bits of a decimal (an integer part of 2^96 = 79228162514264337593543950336 or more) has no decimal view and no wire form: it cannot be a decimal, and denominator 1 is refused. The first version of the exact fix could hold such a level. Three round 3 reviewers (expressions, Rust and spec) reached it with three constants near 10^12, for example a target `entry_price * 999999999999^3` of about 5 x 10^36. The run then ended with no result: `evaluate()` returned nothing and the harness reported an error, where `0e12c11` gave a typed `FAILED ARITHMETIC_OVERFLOW`. The state is now guarded. `Run::step` checks every level, snapshot and scheduled stop of the new state after each event (`State::check_renderable`). A value without a decimal view fails that event with `ARITHMETIC_OVERFLOW` and the event is discarded, so the last completed state can always be reported and checkpointed. `Run::restore` makes the same check for a state read from a checkpoint. OQ-02 section 2.5 says so. Pinned by `exact_state.rs` (`a_target_with_no_decimal_view_fails_the_run_and_the_result_reports_it`, `a_snapshot_with_no_decimal_view_fails_the_event_that_takes_it`, `every_level_a_state_holds_is_checked_for_a_decimal_view`, `the_decimal_limit_is_the_limit_of_the_view_not_of_the_exact_value`, `a_checkpoint_that_holds_a_level_with_no_decimal_view_is_refused_at_restore`), by `packages/api-contracts/rust/tests/exact.rs` and by the `exact` payloads in `fixtures/protocol` (3 valid, 22 invalid).
29. Text that prints a level uses one canonical form: a normalised decimal when the value terminates within 28 fractional digits, otherwise the reduced fraction `n/d`. It does not depend on how the value was computed. A restored run therefore prints the same failure text as an uninterrupted run (round 2 numerical F-2, fixed). Four raw results change against `19baa96` in text only (I-03, X-12, X-13 and X-14). The `INVALID_LEVEL` detail of I-03 reads `found stop -10, entry 50, target 60` and not `-10.0`, `60.0`. X-12, X-13 and X-14 show a non-terminating target as the correctly rounded exact value (367/6 as 61.166666666666666666666666667) where the first version showed a double-rounded last digit. No expected value changed, because those cases omit non-terminating levels. Pinned by `exact_levels.rs` `a_failure_that_prints_levels_reads_the_same_in_every_restored_run`.
30. A sale whose price floors to zero or less fails the run with FAILED `INVALID_LEVEL` (`exit price 0.00 is not positive`), and the event is discarded. A bar price is at least one tick, so an intraday touch cannot floor below one tick. The rule fires when declared gap slippage takes the floored price to 0.00 (an open of 0.01 with 5,000 bps). OQ-02 section 2.5 says to reject unsupported fills rather than invent a price. Round 3 (numerical N-3, spec F5) found the rule unrecorded and unpinned: a mutant that allowed a zero price survived every test and fixture. Pinned by `execution_sale_price.rs` (`a_gap_sale_that_floors_to_one_price_unit_is_a_sale`, `a_gap_sale_that_floors_to_zero_is_an_invalid_level_and_the_event_is_discarded`). No fixture case pins it.

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
- The review fixes added cases X-12, X-13 and X-14 and the `outcome_detail_includes` arrays. A fixtures agent wrote them with the oracle, in a separate worktree from the engine fix, from the frozen detail contract in interpretation 22. That agent could read the engine source. The oracle never reads it. After the merge, every case passed without any edit to an expected value. A script compared every `input.json`, `strategy.json` and `expected.json` that existed before the fix (172 files) with the merged tree. Only the oracle hash and the four `outcome_detail_includes` arrays (C-02, C-06, I-02, I-07) differ.
- The round 3 fix added I-12a to I-12c (a target and a snapshot without a decimal view, and a control just below the limit). A fixtures agent wrote them with the oracle in a separate worktree. The agent reported that it did not read `packages/quant-core/src` or `apps/engine/src` and did not run the engine until the expected values were committed. Git cannot show this: every commit is authored "Claude". The agent gave the oracle its own function for the rule (`check_representable`, limit `LEVEL_INTEGER_LIMIT`). After the commit the engine agreed on all three cases (101, 72 and 219 checks, as the agent reported) with no edit to an expected value. The oracle changed, so its SHA-256 changed (`b3fe445cdbe3` to `5a2ce8e05927`). The lead compared every fixture file of `f7bd1de` with the merged tree byte by byte: 94 `expected.json` files differ only in the oracle SHA-256, and no file was removed. `oracle.py`, `coverage.json`, the fixtures README and the protocol manifest differ as intended, and 15 case files and two protocol payloads are new.
- The oracle's expected position view omits a stop, target or snapshot that has no finite decimal form (for example 367/6). The engine reports such a level as a long rounded decimal. The case states the fills, fees and cash that follow from the level, and it does not copy the engine's rounding.
- The oracle runs only by hand. `node scripts/verify.ts` does not run it, and it fails if any file under `fixtures/` changes while it runs.

## Known limits

- S0 contributes to acceptance A03 to A05 only. A11 distributed recovery, the public CLI, TypeScript parity and S4 joint ranking are not covered.
- Rank ties compare the rank rounded to the most digits a 96-bit decimal holds (28 or 29 significant digits), not the exact rank. This is exact for the single-instrument S0 case. A tie between instruments with ranks that differ beyond 28 digits is not covered. S4 joint ranking is not covered.
- The position mark after a non-terminating split is still a `Decimal` rounded at 28 digits. It affects valuation only. No level, touch or fill reads it.
- `Ratio::from_decimal` and the internal `divide` keep a final fallback arm that keeps the function total. Both arms cannot run (the divisor is a greatest common divisor that fits an `i128`, and `10^28` fits an `i128`). A typed internal failure would be cleaner. The checking agent saw no run reach either arm in about 660,000 differential operations.
- Level and trigger expressions may contain a literal PRICE constant. A split converts stored levels and unit-typed snapshots. It does not convert a literal constant inside a trigger expression. No seed definition uses such a constant.
- `operator_set_digest` covers the catalogue text. The validator limits (window, periods, constant magnitude and scale) live in `compile.rs` and `strategy.rs`, not in the digested text. Raising a limit does not change the digest. A18 invalidation is out of S0 scope.
- `expected.json` files are bound to the oracle by `origin.oracle_sha256`, which hashes `oracle.py` only. `node scripts/verify.ts` does not re-derive expected values and does not hash them. CODEOWNERS review of `/fixtures/` guards an edit to an expected value.
- `outcome.status` in `evaluation-result/1` holds the numerical evaluation outcome. S1 maps it to run status and gate result (OQ-02 section 3.6). The schema does not tie each code to a status. The engine does, in `status_of`.
- The deep restore check (checkpoint text, then run to the end) runs at every cut for runs of at most 128 events. Longer runs run it at about 16 spread cuts plus the last. Every cut still gets a checkpoint, restore and field-by-field state comparison.
- Arithmetic overflow is a typed failure, never a silent rounding. Two proptests check generated cases, not every input. `properties_execution_random.rs` runs 250 extreme prices and scales and asserts no panic, a code on a failure and a schema-valid result. `properties_no_decimal_view.rs` runs 300 chains of factors near 10^12 on a target and a snapshot and asserts a result, a typed code, a checkpoint after every completed event and a result for the last state. Neither asserts exactness. A composition beyond 128 bits is rejected with `ARITHMETIC_OVERFLOW`, including some compositions whose result would fit (interpretation 27). An exact value does not mean an unlimited one.
- Schema validation of an invalid document is bounded by structural limits: 20,000 values, depth 128, 8,192 items per array, 64 keys per object and 16,384 bytes per string. The value limit is per document. A schema-valid result or checkpoint can hold more than 20,000 values and is accepted. An invalid document above a limit reports `SCHEMA_VIOLATION` with its first violation, even when that violation is a decimal-grammar one. A 16 MiB payload of the densest values peaked at about 300 MB while parsing (reported by the contracts agent, measured in a release build).
- `Run::prepare` caps the input at 400 sessions, 400 bars, 32 corporate actions and 32 unplanned events and fails larger input with `INVALID_INPUT`. The per-step state clone and the per-decision series rebuild remain. Their cost is bounded by these caps and was not redesigned.
- The typed `Decimal` and `Identifier` bindings are generated code and use a regex that can backtrack on long non-matching text. The validated path (`parse`) rejects such text first. A caller that passes untrusted text straight to `Decimal::from_str` is still exposed.
- Checkpoint restore cross-checks cash, receivables, positions and the daily records against the journal, and checks the cursor, identities and applied action ids. It does not check a position's stop, target, scheduled stop, snapshot values or fired adjustments, a pending entry's rank, or the amount of the last ledger line, at any cursor. The Rust reviewer edited one such value at a time at every cut of 38 cases, and restore accepted each edit. Edits to balances, quantities, entry prices, caps and applied ids were rejected. The content hash stored with the checkpoint (OQ-05 R2) is the guard against these edits.
- The verify driver tests catch a dropped, shortened or ignored Cargo step. They do not catch a deliberate bypass added inside `scripts/verify.ts`, such as a condition around the loop or a hidden stdio. CODEOWNERS review guards that file.
- A strategy near the cost cap is not cheap. `MAX_STRATEGY_COST` counts node visits, not the time of exact arithmetic with large terms. The round 3 expressions reviewer built a strategy at 99.3% of the cap (five indicators `sma(sma(sma(close, 58), 58), 58)`, 400 sessions, 8 price decimals). A run took 25.8 s in release and 51.5 s in debug in the reviewer's measurement, on a loaded machine. A verifier repeated it and measured 13.3 s and 35.3 s. The strategy finished, with no hang and no panic. The replay evaluates every case twice and restores from many cuts, so such a case would run longer.
- `RUSTDOCFLAGS=-D warnings cargo doc --no-deps` fails inside the generated bindings (an unclosed HTML tag in a schema description). `node scripts/verify.ts` does not run `cargo doc`. Reported by the round 3 Rust reviewer, who did not check an earlier commit.
- Fee and scale values are declared synthetic policy. They are not a vendor fee model.

Limits found by the round 2 reviewers. The numerical findings F-1 (ties at an off-grid level), F-2 (restore text) and F-3 (gap tests unpinned) are fixed (interpretations 12, 18 and 29, Round 3). The rest are minor, change no committed fixture result and were not fixed in this PR.

- **Detail length (spec F5).** `outcome.detail` is cut at 1,000 characters. With 32 confirmed halts and 64-character ids, the detail names 11 ids and cuts the 11th. The instrument, the dates and the first ids stay.
- **Execution handlers are public (Rust R2-01).** The functions in `execution::*` are public in `openquant-core`. They do not repeat the forged-event check that `Run::step` makes. Nothing outside the crate calls them. `Run::step` also trusts a `State` that a caller builds by hand. Only `Run::restore` validates a state.
- **Typed strategy path has no count caps (Rust R2-02).** `validate_strategy` caps no indicator, snapshot or adjustment count. The schema caps them at 32, 8 and 4. A typed artefact with 16,000 indicators took 2.1 s to validate and one with 32,000 took 9.96 s. The text path is bounded by the schema.
- **Deep `Value` (Rust R2-03).** `validate` on a hand-built `serde_json::Value` nested about 2,000 levels deep overflowed the stack in the reviewer's test. Depth 100 and 500 were safe. Text input is safe, because the strict parser refuses depth above 128.
- **Decimal inside a corporate action (Rust R2-05).** A malformed decimal inside a corporate action reports `SCHEMA_VIOLATION`, not `INVALID_DECIMAL`, because the action is a `oneOf` that wraps the pattern error. The same defect in other fields reports `INVALID_DECIMAL`.
- **CI wiring checks are substring checks (verification V2-1).** The reviewer made eight edits to `ci.yml` and `node scripts/check-repository.ts` still passed after each: `node scripts/verify.ts || true`, `echo node scripts/verify.ts`, `if: ${{ false }}` on the verify step, a commented-out install step, an `echo` install step, a commented `timeout-minutes` before a short one, a removed `push` trigger and a removed `pull_request` trigger. CODEOWNERS review of `.github/` guards the workflow.
- **Applied-id guard (verification V2-2).** The check `state.applied.contains(&action.id)` in `execution/corporate_actions.rs` (line 38 at `0e12c11`, line 39 at `f7bd1de`) is not pinned by a test. The round 2 reviewer removed it and all 389 tests passed. The lead did not repeat this at the final head. `Run::step` rejects an out-of-order event and `Run::restore` checks the applied ids, so the guard is defence in depth.

## Verification record

Run with `node scripts/verify.ts` (Node 22 locally, 24 in CI) on the tree of the commit that records round 3. Exit 0:

- repository checks and 116 repository tests (0 failed, 0 skipped);
- `cargo fmt --all --check`, `cargo clippy --workspace --all-targets --locked -- -D warnings`, `cargo test --workspace --locked` (454 tests passed, 0 failed, 0 ignored);
- `s0-replay`: 98 cases, 0 failed, 0 coverage problems, deterministic repeat and restore from every cut point;
- fixtures unchanged while verification ran.

The lead ran this and read the counts from its output. The counts of earlier commits are 116 / 445 / 95 on `9598599` (CI run 43500629911), 116 / 438 / 95 on `f7bd1de`, and 116 / 389 / 70 on `0e12c11` and `19baa96` (Round 2).

## Independent review outcomes

### Round 1 (commit `3ee7d8f`)

Four reviewers worked on separate checkouts. None of them wrote the code under review. Each finding went to adversarial verifiers. A finding survives when fewer than half of the verifiers refute it.

| Review | Verdict | Findings (surviving) |
| --- | --- | --- |
| Numerical correctness | PASS | 3 minor (M1 to M3) |
| Rust quality and safety | CHANGE REQUIRED | 1 major (F-01), 6 minor (F-02 to F-07) |
| Specification compliance | CHANGE REQUIRED | 2 major (F-1, F-2), 5 minor surviving (F-3, F-5, F-8 to F-10); F-4, F-6, F-7 were refuted by the verifiers |
| Verification coverage | CHANGE REQUIRED | 2 major (F1, F2), 4 minor (F3 to F6) |

The numerical reviewer re-derived ten cases blind and found no mismatch except an undeclared rounding convention (the dividend floor, now policy). An independent exact-rational simulator ran 590 random inputs against the engine with 0 differences.

### Disposition of every surviving finding

| Finding | Disposition |
| --- | --- |
| Numerical M1 (touched-exit rounding unpinned) | Fixed. Cases X-12 to X-14 and interpretation 18 |
| Numerical M2 (rounding rules missing from policy) | Fixed. Policy table and interpretations 17 to 21 |
| Numerical M3 (unused `State::receivables_total` saturates) | Fixed. The method is removed |
| Rust F-01 (validation memory) | Fixed. First-error fast path, structural limits and a bounded report. 200,000 empty bars: peak 681,608 kB before, 17,880 kB after (reported by the contracts agent) |
| Rust F-02 (engine lints, generated allow) | Fixed. The engine inherits the workspace lints. The generated-code allow is `unwrap_used` only |
| Rust F-03 (`decimal::format` panic and silent scale loss) | Fixed. It returns an error |
| Rust F-04 (unbounded typed API) | Partly fixed. Count caps in `Run::prepare`. The typed `Decimal` backtracking and the per-step clone remain, see Known limits |
| Rust F-05 (forged `MarketEvent`) | Fixed. `Run::step` rejects it with `INVALID_INPUT` |
| Rust F-06 (checkpoint balances unchecked) | Partly fixed. Balances, daily records and positions are cross-checked. A consistent in-session edit is not detected, see Known limits |
| Rust F-07 (failure code from a truncated list) | Fixed. The code reads the full classification |
| Spec F-1 (INSUFFICIENT detail) | Fixed. Interpretation 22 and `outcome_detail_includes` |
| Spec F-2 (differences from the source scripts) | Documented in this log |
| Spec F-3 (cutoff wording) | Fixed in OQ-02 section 2.5 and OQ-05 section 7 |
| Spec F-5 (unrecorded behaviour) | Documented. Interpretations 17 to 23 and the policy table |
| Spec F-8 (checkpoint cross-check claim) | Fixed with Rust F-06 |
| Spec F-9 (operator digest omits limits) | Accepted and documented in Known limits |
| Spec F-10 (`outcome.status` vocabulary) | Documented in the schema descriptions and Known limits |
| Verification F1 (Cargo guard tautological) | Fixed. A literal expected command list, driver tests with a stub Cargo, code-shape checks |
| Verification F2 (replay not tied to inventory) | Fixed. The report check reads the fixture inventory. A Rust test runs the binary on the committed fixtures |
| Verification F3 (tests fail in the worktree path) | Fixed. The copy filter uses relative paths |
| Verification F4 (expected values not content-bound) | Accepted and documented in Known limits |
| Verification F5 (unrecognised manifest `expect`) | Fixed in Rust and TypeScript |
| Verification F6 (engine lints) | Fixed with Rust F-02 |

### Round 2 (commit `0e12c11`)

Four new reviewers worked on separate checkouts of `0e12c11`. None of them wrote the code, and none was a round 1 reviewer. A verifier tried to refute each finding. All four verdicts are PASS. No blocker and no major finding was reported or survived.

| Review | Verdict | Findings |
| --- | --- | --- |
| Numerical correctness | PASS | 5 minor. 3 survive (F-1, F-2, F-3). F-4 and F-5 were refuted |
| Rust quality and safety | PASS | 5 minor (R2-01 to R2-05). All survive |
| Specification compliance | PASS | 8 minor. 6 survive (F1 to F5, F8). F6 and F7 were refuted |
| Verification coverage | PASS | 2 minor (V2-1, V2-2). Both survive |

Reported by the reviewers (the lead did not repeat these runs):

- The numerical reviewer derived 11 cases blind with their own exact-rational simulator (X-12, X-13, X-14, X-05, X-07, C-01a, C-05, SEM-04, ENT-02-v2, I-10, R-01) before opening any expected value. They found 0 differences. They ran 2,400 random cases and 10 hand-built edge cases. They ran 17 required mutants: 16 were killed by the replay and 1 (m14) is equivalent. Two more mutants of theirs survive (F-3).
- The Rust reviewer ran `cargo fmt`, `cargo clippy` and `cargo test` (389 passed). They restored at 1,379 cuts of 38 cases and saw no false rejection.
- The specification reviewer ran `node scripts/verify.ts` on `0e12c11` (exit 0, 116 / 389 / 70) and traced OQ-02 sections 2.2 to 2.6 to the code. They found no behaviour that diverges from the specification. Their findings are in documentation.
- The verification reviewer ran `node scripts/verify.ts` in a fresh clone (exit 0, 158 s). Of 14 mutations, 12 were killed, 1 survived (V2-2) and 1 does not apply to this commit.

The lead checked that all 19 commits from `3ee7d8f` to `0e12c11` have exactly one `Co-Authored-By` trailer that names the model reported by `get_session`, and no session link.

Disposition of every surviving finding:

| Finding | Disposition |
| --- | --- |
| Numerical F-1 (ties at an off-grid level) | Accepted in round 2 as a limit. Reopened by the owner (CHANGE REQUIRED on `19baa96`). Fixed with exact arithmetic (Round 3, interpretation 12) |
| Numerical F-2 (restore text differs after a split) | Accepted in round 2 as a limit. Fixed in Round 3 (interpretation 29) |
| Numerical F-3 (gap tests unpinned) | Accepted in round 2 as a limit. Fixed in Round 3 by G-05, G-06 and G-12a to G-12d (interpretation 18) |
| Rust R2-01 (public phase handlers) | Accepted and documented in Known limits |
| Rust R2-02 (no strategy count caps) | Accepted and documented in Known limits |
| Rust R2-03 (deep `Value`) | Documented in Known limits and in the `limits.rs` module doc |
| Rust R2-04 (checkpoint limit understated) | Fixed in the `checkpoint.rs` doc comment and in Known limits |
| Rust R2-05 (decimal in a corporate action) | Accepted and documented in Known limits |
| Spec F1 (late halt evidence) | Fixed in documents: OQ-02 section 2.5, the `evaluation-input` schema description, `fixtures/s0/README.md` and interpretation 17. The code is unchanged |
| Spec F2 (interpretation 21 pin) | Fixed. Interpretation 21 names its test. The sentence above the list is reworded |
| Spec F3 (pins that do not pin) | Fixed in interpretations 5, 8, 9, 10 and 12 |
| Spec F4 (count and commit) | Fixed. "5 minor" and the verification record name their commits |
| Spec F5 (detail cut at 1,000 characters) | Documented in interpretation 22 and Known limits |
| Spec F8 (unrecorded behaviour) | Documented in interpretations 24 to 26. The `FinalState` schema description now says "as of the last completed event" |
| Verification V2-1 (CI substring checks) | Accepted and documented in Known limits |
| Verification V2-2 (applied-id check unpinned) | Accepted and documented in Known limits |

The verifiers refuted four findings. Numerical F-4 asked for the end of the affected period in three detail arrays. Numerical F-5 said a FAILED result keeps exits that were computed from a future bar. Spec F6 said the disposition of round 1 F-2 overstated the record. Spec F7 said `engine_digest` hashes a descriptor and not the executable.

Not verified by the reviewers, and not verified by the lead:

- CI on GitHub was not run by any reviewer. The lead read the check runs on `0e12c11` back. Both completed with success (see the pull request).
- Node 24 was not available to the reviewers. All runs used Node 22.
- The release-profile memory and time figures in this log were not reproduced. The Rust reviewer used the test profile.
- The rounding bound "at most 5e-27" was not measured for prices near 1e9.
- The specification reviewer worked as a single agent, without separate refutation agents.
- The oracle's own arithmetic was checked only by the numerical reviewer's independent simulator on the cases listed above.

What changed after the review: the commit that records round 2 changes this log, one sentence in OQ-02 section 2.5, `fixtures/s0/README.md`, the description text of two JSON Schema properties (`information_cutoff` and `FinalState`), and the doc comments in `checkpoint.rs` and `limits.rs`. It changes no executable Rust code, no fixture data and no expected value. The four PASS verdicts apply to `0e12c11`. The recording commit was not reviewed again. The lead ran `node scripts/verify.ts` on the tree of the recording commit: exit 0, 116 repository tests, 389 Rust tests, 70 cases, 0 failed, 0 coverage problems.

### Round 3 (owner review of `19baa96`, the exact-arithmetic fix)

The owner reviewed `19baa96` twice (reviews 5894419748 and 5894439129). Both are CHANGE REQUIRED. The second review replaces the owner's earlier PASS on `0e12c11`. The owner's finding, as reported by the owner: the evaluator rounds a non-terminating mean to a `Decimal` before it multiplies. Touch decisions, gap decisions, level validity and the sale price then read the rounded level. This changes fills and cash. The owner asks the repository either to preserve exact boundary decisions for accepted level expressions or to reject unsupported numerical cases before a completed result, and to add independent regression cases for levels exactly on the grid, in both rounding directions, for touch, gap and invalid-level decisions. The owner reproduced the defect on a copy of X-12 (ATR3, target multiplier 3, true ranges 0.20, 0.20 and 0.27, entry 5.00, high 5.67): the stored target was 5.6699999999999999999999999999 and 199 shares sold at 5.66 and not at 5.67. The owner reported that CI was green on `19baa96`. The owner's local Cargo run failed on a disk-space error in the owner's environment. That is not a test failure.

The same mechanism was already in round 2 as numerical F-1, rated minor by the reviewer and accepted by the lead as a limit with "fix before S1". The lead reversed that decision. The defect is real (reproduced by the numerical reviewer, by the owner and by the lead's fixture agent on `19baa96`), it changes fills and cash, and S0 already runs reduced ATR3 definitions through this evaluator. The fix therefore belongs in S0.

The fix, in one workflow with two implementers in separate worktrees and one independent checker for each branch:

- `Ratio` (`packages/quant-core/src/ratio.rs`): a reduced fraction of two `i128`. Checked `add`, `sub`, `mul` and `div`. An overflow is the typed failure `ARITHMETIC_OVERFLOW`. Comparison cannot overflow. `floor_to`, `ceil_to` and `half_even_to` are exact. `Display` is canonical.
- The evaluator, the levels a position holds, the split conversion, the break-even trigger and the entry condition use `Ratio`. Money, quantities, caps, fees, marks and ranks stay `Decimal`. The fill price is the exact level floored to the price scale.
- The checkpoint uses the `Exact` value (interpretation 28). OQ-02 sections 2.5 and 2.6 and OQ-05 section 7 state the rule.
- Failure text prints a canonical form (interpretation 29).
- 25 new independent cases G-01 to G-13b (19 written first, 6 more after a reviewer gap was found in the first 19: the off-grid gap tests and a 17-for-2 split round trip). The fixtures agent did not read the engine source and did not run Cargo until the expected values were committed. The expected values come from the oracle only. The lead checked that the 69 existing `expected.json` files differ from `19baa96` only in the oracle SHA-256 (a byte-level replace of the new hash by the old one reproduces each file), that no other existing case file changed, and that the new hash is the SHA-256 of `oracle.py`.

Reported by the checking agents (the lead did not repeat these runs):

- Fixtures. A second agent re-derived all 19 cases with its own exact simulator without reading the engine or the oracle: 19 of 19 agree. For each case it checked that the tie is real. On the `19baa96` engine, 16 of 89 cases fail: 12 differ in a fill, a status or an entry decision, 2 differ only in the stored level text and 2 only in a converted ATR snapshot. Three new cases (G-07b, G-08b, G-09b) pass on the old engine because the rounding went the other way. They guard the opposite direction so that a repair cannot swap one direction for the other. G-11 and G-11b (7-for-2 and back) do not expose a decision error on the old engine, because that ratio round-trips under the old rounding.
- Core. A third agent compared `Ratio` with Python `Fraction` on about 660,000 generated operations in debug and release (0 mismatches, no panic) and ran a parser fuzz of about 178,000 tokens against an independent canonical-rule reference (0 mismatches). It ran 14 mutants and all 14 were killed. One mutant (ceil instead of floor on a target fill) survives the new tests and is killed by the existing X-12 to X-14. One (`<` to `<=` in the new-stop check) is killed by an existing test. It ran 2,000 random one-instrument runs against its own simulator: 1,816 completed runs agree on every fill and on the equity, and 184 `FRACTIONAL_ENTITLEMENT` runs agree. The `19baa96` engine disagreed on 4 of them. The 13 harness tests in `exact_levels.rs` all fail on `19baa96`. It ran the reviewers' reproduction cases R-0036, R-0348 and R-0352 and the seven edge cases: 10 of 10 agree with its simulator.
- G-12a to G-13b. A third fixtures agent wrote these six cases under the same blind rule and the same oracle process, after the first 19 showed a gap (off-grid gap tests, and a split ratio that leaves the grid). It reported: all six pass on the exact engine (`s0-replay`: 95 cases, 0 failed); the mutants `open >= floor(target)` and `open <= ceil(stop)` fail G-12a to G-12d and no earlier case; the diff against `a4e90c5` shows the oracle SHA-256 in existing expected files, six new case directories, coverage additions and README lines. The lead checked the diff against `19baa96` (existing expected files differ only in the oracle SHA-256). No other agent had re-derived these six cases when this text was written.
- The core checker reported one false sentence, which the lead fixed: the first docs said that the S0 policy limits fit 128 bits with a wide margin (interpretation 27).

Verified by the lead on `f7bd1de`: `node scripts/verify.ts`, exit 0 (116 repository tests, 438 Rust tests, 95 cases, 0 failed, 0 coverage problems). The Verification record above lists the counts of every head. The Rust test count did not change when G-12a to G-13b were added, because the fixture cases run inside the replay and not as Rust tests.

#### Independent reviews of `f7bd1de`

Five new reviewers worked on separate checkouts of `f7bd1de`: numerical correctness, accepted level expressions (a new dimension, added after the owner review), Rust quality and safety, specification compliance and verification coverage. None wrote the code. At least one verifier tried to refute each finding.

| Review | Verdict | Findings |
| --- | --- | --- |
| Numerical correctness | PASS | 4 minor (N-1 to N-4). All survive |
| Accepted level expressions | CHANGE REQUIRED | 1 major (F1), 2 minor. F1 and F2 survive. F3 was refuted |
| Rust quality and safety | CHANGE REQUIRED | 1 major (F1), 3 minor. F1, F2 and F3 survive. F4 was refuted |
| Specification compliance | CHANGE REQUIRED | 1 major (F1), 6 minor (F2 to F7). All survive |
| Verification coverage | PASS | 2 minor (M-1, M-2). M-2 survives. M-1 was refuted |

Three reviewers reported the same major defect, each on its own path. The lead's own tests show it: they fail when the new check is removed. A level, snapshot or scheduled stop with an integer part of 2^96 or more fits a `Ratio` but has no decimal view and no checkpoint form (interpretation 28). A strategy with three constants near 10^12 reaches it. The run then ended with no result at all: `evaluate()` returned nothing and the harness reported an error. `0e12c11` had given a typed `FAILED ARITHMETIC_OVERFLOW`, so the exact fix was a regression on this path. The fix is in `9598599`.

Reported by the reviewers (the lead did not repeat these runs):

- Numerical. Its own exact simulator, written from the specifications and not from the engine, agreed on 31 of 31 cases (all 25 G cases and six others, 296 signal records). 17 assigned mutants were killed. Extra mutants survived. They became N-1 to N-3. 199,990 `Ratio` operations against Python `Fraction` (debug profile): 0 wrong, 301 typed rejections of results that would have fit. 1,400 random tie-biased runs: 0 differences after it fixed its own simulator, which had missed the rule that rejects a non-positive sale price.
- Accepted level expressions. About 9,800 random strategies that the validator accepts: the engine never returned a completed result that differed from the reviewer's exact simulator, and never panicked. All 8 rounding mutants were caught. The reviewer read the engine source before it wrote the simulator, so a misreading of the specification that both share would not show.
- Rust. `Ratio` against Python `Fraction`: 250,000 operand pairs, about 1,000,000 operations and 2,250,000 rounding checks in debug and release, 0 mismatches. 600,000 comparison pairs: 0 mismatches. 94 hostile tokens and 2,000,000 fuzz strings: no panic. Format and clippy were clean and 438 tests passed. The reviewer measured a maximum-cost 400-session case at 17.2 s in release against 4.0 s at `0e12c11`.
- Specification. 18 of the 25 G cases fail on the `19baa96` engine. G-07b, G-08b, G-09b and G-12a to G-12d pass there, as the fixtures README says. 70 existing `expected.json` files differ from `19baa96` only in the oracle SHA-256.
- Verification. A fresh clone passed `node scripts/verify.ts` in 295 s cold. 15 mutations of code or fixtures: 14 killed, and the one survivor is known limit V2-2. The oracle regenerated all 94 oracle cases byte for byte.

What the reviewers did not verify, as they reported it: release-profile behaviour (numerical, expressions); the RSI, volume and lag operators, the four seed strategies and multi-instrument ranking (numerical, expressions); dividends, halts and quantity scales above 0 under fuzzing (expressions); GitHub Actions behaviour, Node 24 and a 2-vCPU runner (verification); the authorship and blindness of every fixtures agent, which git cannot show (numerical, spec, verification); the figures that other agents reported earlier in this log (all five).

Disposition of every surviving finding:

| Finding | Disposition |
| --- | --- |
| Major F1 (expressions F1, Rust F1, spec F1): a level without a decimal view ends the run with no result | Fixed in `9598599`. `State::check_renderable` runs after every event in `Run::step` and in `Run::restore`. The event that creates the level fails with `ARITHMETIC_OVERFLOW` and is discarded. Tests: `exact_state.rs`, `properties_no_decimal_view.rs`, two protocol payloads, cases I-12a to I-12c. OQ-02 section 2.5, interpretation 28 |
| N-1 (numerical): the terminal arms of the continued-fraction comparison are untested | 21 new rows in `ratio.rs` (`the_order_does_not_overflow_where_the_cross_products_do`). Both mutants killed |
| N-2: the `mul_div` fallback boundary `remainder >= d` is untested | 8 new rounding rows in `ratio.rs`. The mutant is killed |
| N-3 and spec F5: a non-positive sale price is neither recorded nor pinned | Interpretation 30, `execution_sale_price.rs`. The mutant is killed |
| N-4 and spec F6: log sentences that are false or stale | Interpretations 12, 26, 28 and 29, the proptest limit and the rank-tie limit are corrected |
| Expressions F2: "ordinary inputs fit" is wrong | The lead measured it (interpretation 27). `ratio.rs`, the core README and the log say what fits |
| Rust F2: a break-even stop of exactly 0 is unpinned | `exact_levels.rs`. The mutant is killed (interpretation 20) |
| Rust F3: a stale count in a doc comment | "six" is now "seven" in `api-contracts` `lib.rs` (the reviewer's removal of the allow gives 7 errors, repeated by a verifier) |
| Spec F2, F3: OQ-02 section 7 and the `Exact` description | OQ-02 section 7 names the exception. The OQ-05 sentence and the `Exact` description now state the canonical rule |
| Spec F4: the invalid-level bounds are unpinned | `exact_levels.rs` pins `stop == entry`, `target == entry` and the exact fraction on each side (interpretation 13). A mutant that tested grid prices is killed |
| Spec F7: the draft PR body overstated its claims | Corrected in the PR body (independence, rank-tie limit, numerical difference against `19baa96`) |
| Verification M-2: stale figures in limit V2-2 | Corrected |
| Expressions F3 (refuted): wall time of a strategy at the cost cap | Not a defect, as the verifier showed: the cap counts node visits. Recorded in Known limits |
| Rust F4 (refuted): the stack-overflow depth in a doc comment | Not a defect: the comment says "about 2,000 can overflow", and the depth depends on the stack. A verifier measured between 500 and 700 in a debug test thread. No change |
| Verification M-1 (refuted): `origin.kind` can be relabelled to skip the oracle hash check | The stated limit: `expected.json` is bound to the oracle by a hash that `verify` checks, and CODEOWNERS review guards the files |

The mutant results in this table are the test agent's report. The lead repeated only the two mutants of `Run::step` and `Run::restore`.

Owner reviews, as the owner reported them: review 5895774037 returned PASS on `3059110`. Review 5895851455 returned PASS on `f7bd1de`: the owner reran the original reproduction (199 shares sold at 5.67, 33 restore checks), re-derived G-12a to G-13b independently and found them equal, and reported 116 repository tests, 438 Rust tests (8 CLI tests failed first on a stale build cache and passed after a rebuild) and 95 cases, with CI run 43478889293. It asked for the blank line at the end of this file to go. Review 5897543190 returned PASS on `9598599`: no new blocking finding, the complete change since `f7bd1de` read, 12 exact-state tests, 2 shared-protocol tests and 95 cases rerun locally, and CI run 43500629911 (116 repository tests, 445 Rust tests, 95 cases). The owner did not reproduce the fuzz experiments of this log. These reviews cover offline S0 only.

Verified by the lead on `9598599`: `node scripts/verify.ts` exit 0 (116 repository tests, 445 Rust tests, 95 cases), and CI run 43500629911 completed with `success` (read from the GitHub API). The lead also removed the new check from `Run::step` and from `Run::restore` one at a time: the new tests fail each time.

Round 4 reviews on the final commit: not yet run when this text was written.

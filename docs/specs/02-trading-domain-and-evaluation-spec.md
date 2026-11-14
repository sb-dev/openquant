---
id: OQ-02
title: OpenQuant — Trading Domain and Evaluation
version: 1.4.0
status: canonical
updated: 2026-11-14
owns: strategy semantics, evaluation, lifecycle, portfolio, risk, A01–A18
---

# OpenQuant — Trading Domain and Evaluation

This document defines required behaviour. It does not claim that the behaviour is implemented.
See the [specification index](README.md) for ownership and the current bootstrap scope.

## 1. Core records and ownership

Use these records to describe the product. They are not a requirement to force all storage into six tables.

| Record | Contents | Authoritative writer |
|---|---|---|
| **Research Mission** | Objective, hypotheses, constraints, cohort, budgets, agent configurations, search history | Control application |
| **Strategy Version** | Stable strategy identity, parent version, hypothesis, contract, executable definition, content hash | Control application after validation |
| **Run** | Strategy/version, mode, inputs, attempts, checkpoints, outcomes, metrics, artefact references | Evaluation service or assigned trading engine |
| **Decision** | Actor, requested action, evidence references, policy version, expected state, outcome | Authorised control or risk command |
| **Capital Mandate** | Account, strategy version, capital ceiling, limits, allowed operations, expiry, revision | Steward-authorised control command |
| **Portfolio Account** | Cash, positions, orders, fills, reservations, costs, reconciliation state | Assigned execution engine |

Supporting records include dataset manifests, cohort policies, findings, agent forecasts, and audit events. Store these beside the owning domain. Do not build a generic knowledge platform to manage them.

A Research Mission has its own status: `CREATED`, `IN_PROGRESS`, `BLOCKED`, `WITHDRAWN` or `CONCLUDED`. `CREATED` means the mission exists but has not started. It becomes `IN_PROGRESS` when the Researcher starts it. `BLOCKED` means work cannot continue, for example because a budget is exhausted; the reason is shown and outcomes are kept. `WITHDRAWN` means a Researcher cancelled the mission: its open runs become `CANCELLED` and its open agent attempts are cancelled. A concluded mission records one outcome, `ELIGIBLE_FOUND` or `NO_ELIGIBLE_CANDIDATE`, with its reason. These values do not overlap with run status, gate results, Decision outcomes, attention status or the activation states in §4. The Researcher sets the mission's budgets when creating it, within the cohort policy's maxima and the period cap. Each agent configuration is an executor profile plus a behaviour-bundle hash (OQ-03 §2). Agent attempts and the typed retrieval, validation and assessment jobs are non-trial work. They are not evaluation runs and do not count as trials (§3.1).

An authorised command records each Decision. A policy-determined Decision applies an approved policy instead of a new human judgement. In S1 the workflows service principal records the `DRAFT` → `EVALUATING` Decision this way (§4). That Decision names the cohort policy digest, the Steward's Decision that approved the policy, and the Researcher who started the mission. A service principal may record a policy-determined Decision only under an approved policy. It may reserve within an existing budget. It cannot approve a policy, create or enlarge a budget, or change a limit.

An **Evidence Bundle** is a manifest of the exact runs, findings, and policy used for a decision. It is not another copy of their contents.

The **Strategy Graph** is a generated view of parent versions and linked records. Its maintenance is automatic. It needs no manual graph editing and no separate graph database.

Each account has one execution writer. API users, AI agents, and evaluation workers cannot edit its positions or fills. Manual broker activity is imported through reconciliation, not concealed by editing OpenQuant state.

### 1.1 Watchlists, profiles and source evidence

A Watchlist Version binds stable instrument IDs and membership; provider symbols and SEC company IDs are mappings with effective dates, not universal identities. Preserve renamed and removed members in past cycles. A user-selected current watchlist is not evidence of an unbiased historical investable universe.

A Research Profile Version binds provider/adapter identities, required capabilities, feed/session/adjustment rules, market/currency, cohort suite, history and information cutoff, calendar/schedule, freshness policy and budgets. Credentials are references only. Edits apply to future cycles. A Research Cycle freezes watchlist/profile versions and its work allocation. It retains bounded per-stock missions and can create a strategy-level mission over that same watchlist. Every member has an explicit coverage outcome. An early failure cannot erase the other members.

A Research Mission binds one instrument or an exact watchlist version, permitted operators, parameter bounds, and required evidence. Per-stock findings can support a strategy-level mission through immutable references. Their scores do not become trading signals without an executable rule and registered data semantics. Research coverage and joint strategy results are separate outcomes.

A dataset manifest records requested and returned coverage, provider/feed, adapter/transformation versions, instrument mapping, bar/session/currency/adjustment semantics, retrieval time, content hashes, completeness and use/retention constraints. Preserve source responses when permitted. Corrections produce new snapshots. Reusing a frozen snapshot reproduces that input; it does not prove the provider's earlier historical version.

A source-evidence record binds document/URL, publisher, original provider reference, content hash where retention permits, publication/availability/retrieval times and their precision, and retrieval outcome. Unknown timestamps remain unknown. An as-of request is a constraint, not a provider guarantee. Exclude unknown or later availability from historical decisions unless the registered policy supplies a justified conservative bound. Web date filters alone do not establish historical page contents.

SEC evidence retains company ID, accession, form, acceptance time, amendment relation, reporting period, taxonomy/tag and units for each fact. Resolve restatements using the filing version available at the cutoff. Do not silently select the latest company-facts value. Tavily snippets, extracted pages and generated summaries retain separate identities; a search score or generated answer is not a verified financial fact.

A provider comparison freezes equivalent requests and policy, stores separate manifests, and reports coverage, semantic differences, measured latency/usage and disagreements. Predeclare tolerances. Equal payloads are not required, and agreement is not an independent financial baseline. A source change creates a new input identity and, when used for selection, a new registered trial. Never blend fallback data silently or select the feed by favourable backtest returns.

## 2. One strategy format

### 2.1 Strategy Contract and Strategy Definition

Keep the existing terminology, with one ownership rule:

**The Strategy Contract explains a strategy. The Strategy Definition specifies its executable behaviour. Both belong to the same versioned artefact.**

The contract contains the hypothesis, economic rationale, intended conditions, benchmarks, assumptions, and invalidation conditions. The definition contains the universe binding and eligibility rules, data dependencies, indicators, entries, ranking and tie-break rules, position limits, sizing, exits, state transitions, and requested execution behaviour.

The approved version binds both sections to one hash. Behavioural changes create a new version. There is no production strategy code generated independently from this artefact.

Use the same format for one instrument and a watchlist. When positions compete for cash or slots, the complete definition is one trading policy. Its run binds an exact Watchlist Version within the definition's permitted universe. Changing run membership creates a new input identity and trial; changing universe rules creates a new Strategy Version.

Keep measurement conditions outside the strategy: initial evaluation capital, dates, benchmarks, data snapshots, fill/cost assumptions and the evaluation suite belong to the registered policy and run. Bind the strategy's execution requirements to a compatible policy; reject an unsupported combination. A strategy revision cannot silently change the comparison conditions.

### 2.2 Bounded execution

The definition uses a small set of reviewed operators. The initial long-only daily subset supports:

| Operator group | Required semantics |
| --- | --- |
| Inputs and history | OHLCV references by instrument/session, bounded lag, and prior-position state. |
| Calculations | Typed arithmetic, min/max, simple rolling means, simple-mean RSI and ATR. Division by zero has an explicit outcome. |
| Conditions | Comparisons and Boolean combinations over available values. |
| Selection | Eligibility, descending rank, stable instrument-ID tie-break, one holding per instrument and a bounded slot count. |
| Sizing | Cash divided by vacant slots, cash caps, lot rounding and reservations within the assigned strategy budget. |
| Exits and state | Entry price/ATR snapshots, fixed stop/target, and a one-time stop change with an effective session. |
| Rebalance | Declared decision schedule and target changes; no implicit rebalance on every arriving stock bar. |

Each operator defines input/output types and units, lookback and warm-up, missing/non-finite values, update phase, bounds and compatibility version. Do not substitute Wilder smoothing for a simple mean under the same identifier. Indicators include the current completed bar only where their definition says so.

Represent expressions as typed operator trees. Do not execute arbitrary expression strings through `eval`, shell commands, or dynamic code loading.

Validate lookback bounds, data types, units, instrument references, resource limits, and unavailable operators. Reject unknown behaviour rather than substituting an approximation.

A new operator is a reviewed code contribution with tests. This preserves extensibility without giving every strategy arbitrary execution privileges. Frozen model artefacts can later use the same reviewed operator boundary; they do not require LLM calls on the order path.

Strategy-requested risk limits can only tighten the active mandate. They cannot increase its authority.

### 2.3 One execution function

The shared core implements this conceptual boundary:

```text
step(strategy_version, prior_state, market_event)
    -> next_state, target_positions, diagnostics
```

Historical and paper runs use a simulated execution adapter. Shadow uses the production decision path without broker submission. Live uses the broker adapter.

Reuse signal, sizing, risk, and accounting semantics where they apply. Do not claim simulated fills equal real fills. Alpaca's own documentation, for example, identifies market impact, latency, and order-queue effects that its paper simulation does not reproduce.

For joint execution, `market_event` identifies the common session/phase and validated observations for the bound universe. `prior_state` includes positions, cash, reservations, pending entries and scheduled stop changes for the whole strategy. The adapter must not trigger a separate ranking whenever a stock arrives. Stock input order cannot change the result. Checkpoints preserve this state and the event cursor.

### 2.4 Joint selection and capital

Each historical or paper candidate has one isolated simulated ledger. Its instruments share cash and position slots; competing candidates do not share that ledger. The evaluation policy supplies initial capital. In an account, the strategy uses its assigned budget and sub-ledger under §5, never the account's entire cash balance.

Rank eligible new entries at a common decision time. Exclude held instruments and existing entry reservations. Resolve equal scores by ascending stable instrument ID. Count reserved entries against slot limits. Persist selection, rejection and skipped-entry reasons, including unavailable indicators, existing holdings, rank, cash and lot constraints.

Sizing reserves costs as well as notional. Debit actual filled quantity times price plus costs; do not debit a nominal allocation unrelated to rounded shares. Leave unspent cash available under the next permitted decision. Cash becomes available only after its fill or reservation-release event. Intraday exits cannot fund earlier opening entries. Strategy limits can only tighten account/mandate limits.

Report joint equity and costs with per-stock contributions and cash attribution. Standalone stock tests remain diagnostics; summing their returns cannot establish the joint policy's result.

### 2.5 Initial daily execution policy

M1 uses one market/currency, one declared session calendar, daily OHLCV and long-only cash positions. The registered policy binds costs, price/quantity scales, corporate-action handling and the following conservative phases. Other execution policies require separately versioned semantics and evidence.

| Phase | Required behaviour |
| --- | --- |
| Before open | Restore positions, scheduled stops, entry intents and cash/slot reservations. Apply effective corporate actions to that state exactly once, then activate scheduled stops on the resulting price basis. |
| Open | Process existing-position gap exits, then eligible reserved entry intents in their frozen rank order. Resolve entries from the opening price under the declared fill/cost model. Never rerank using opening prices or later data. |
| During session | Test stops and targets active for that session, including protection on newly filled positions. Use only those levels; a high-triggered stop change is not effective yet. |
| After close | Complete indicators for the common session, value holdings, and schedule stop changes for surviving positions. Rank new entries and reserve cash caps/slots for the next open. |

For the initial simulated cash-cap model, freeze each entry's maximum total spend at the close. The signal inputs must be available before the intended opening phase; late data cannot create a retroactive fill. The simulator converts the cap to the largest permitted lot multiple whose notional plus costs fits the reservation. Use the declared opening fill price and round quantity down. This is a declared simulation assumption, not a guarantee of a broker's opening fill. Skip an unfillable intent with a reason, release its reservation, and do not backfill or enlarge other intents until the next close. Opening exits cannot enlarge previously frozen entry caps. An intent expires after its intended opening phase. A broker adapter must support the requested behaviour or reject it before live use.

For a long position that gaps through an active stop, use the opening price with adverse execution costs, not the stop price. A gap above a target fills at the target before costs in this conservative model. Otherwise an intraday stop/target touch fills at its level before costs. If both are touched and their order is unknown, the stop takes precedence. Record ambiguous bars. Reject invalid levels or unsupported fills rather than inventing a price. Decide every level comparison on the exact value of the level: a stop or target touch, a gap, a break-even trigger and `0 < stop < entry < target`. Do not round the level to the price grid or to working precision first. A level that an implementation cannot hold exactly is rejected explicitly before the run reports `COMPLETED`. A level that it holds but cannot report, as a decimal in a result or in a checkpoint, counts as one it cannot hold: the run rejects it at the event that creates it. Round only the fill price, under the declared rounding policy. A stop moved to entry does not remove fees, gaps or loss risk.

Align by session/time, never by row number. Declare the warm-up range separately from the scored period. Missing required bars or a required valuation at the common cutoff make joint evidence insufficient; do not shrink the universe, advance one stock to a later date, or forward-fill a tradable bar. Evidence that exists but becomes available after the earlier of the next intended open and the run's information cutoff is future data. It fails the run with `FUTURE_DATA`; it is not a missing observation. Availability exactly at that instant is usable. At the final session the cutoff alone bounds the closing valuation. Halt evidence is the one exception: evidence that is not available by its deadline confirms nothing, and it is neither future data nor a missing observation by itself (see the eligibility rule below). Expected market closures and causally established ineligibility remain distinct from missing observations. Optional company-research failures do not block a price-only strategy unless its mission requires that evidence.

M1 explicitly limits evidence for unplanned halts, delistings and acquisitions. An absent bar alone does not establish that no qualifying trades occurred. Require dated source evidence and apply any eligibility change only from its verified availability time, no earlier than its effective time. A confirmed non-trading instrument cannot create a signal or fill; expire its pending entry at the intended opening phase and release the reservation. Keep it in the frozen universe and coverage report. If it is held and the required valuation or terminal settlement is unsupported, mark joint evidence `INSUFFICIENT`. Report the instrument, event, missing evidence and affected period. Do not invent a liquidation price or remove the instrument and rerun the same comparison. This M1 limitation can bias the set of completed runs; report it alongside cohort results. A later policy for stale marks or terminal settlement requires separately versioned semantics and acceptance evidence under §3.3.

### 2.6 Daily swing seed family

The supplied `daily_multifactor_swing_trader.py` and `gemini-code-1793903237866.py` are source references, not executable product plugins. Their exact-byte SHA-256 identities are recorded in the [research log](../research-logs/2026-11-07-strategy-research-and-evaluation.md#source-identities). The corrected seed family uses the following rules. Thresholds and five slots belong to this example, not global defaults.

| Component | Definition |
| --- | --- |
| Trend | `close[t] > SMA50[t]`. |
| Recent weakness | `RSI[t-2] <= threshold OR RSI[t-1] <= threshold`; current `RSI[t] > 30`. This does not require an upward crossing at session `t`. The current floor remains 30 in all four versions. |
| Volume | `volume[t] > volume_SMA20[t]`; the mean includes bar `t`. |
| Rank | `50 * (volume[t] / volume_SMA20[t]) + (100 - RSI[t])`, descending. |
| Sizing | Five slots, one position per instrument. At the close, divide unreserved strategy cash by vacant slots; freeze each selected entry's total spend cap. Unused slots retain cash. |
| Protection | `stop = entry_price - 2 * entry_ATR`; `target = entry_price + 5 * entry_ATR`. |
| Optional break-even | When `high >= entry_price + entry_ATR`, move the stop once to entry for a surviving position, effective next session. |

RSI uses 14-bar simple means of positive/negative close changes: `100 - 100 / (1 + mean_gain / mean_loss)`. With positive gain and zero loss, RSI is 100; with zero gain and positive loss, it is 0; with both zero, it is unavailable. ATR is the 14-bar simple mean of `max(high-low, abs(high-previous_close), abs(low-previous_close))`. Require full windows and a previous close for each change/true-range observation. Entry requires all referenced indicator values, including both lagged RSI values, to be available; ATR and volume mean must be positive and finite. Preserve these definitions in reviewed operators.

Signal OHLC is split-adjusted to the signal session's share basis using only actions effective and available by that session. Adjust historical volume inversely to prices on the same basis. Do not use future adjustments or dividend-adjusted prices. All indicator values referenced at decision `t`, including lagged RSI, use that causal series. Fills, gap/touch checks and holdings valuation use raw as-traded prices on the current session's share basis.

Snapshot `entry_ATR` from the signal session, not the following entry session's completed range. Convert this price distance to the entry session's share basis for any intervening split. `entry_price` is the actual simulated fill on that basis. Stops, targets and break-even thresholds use the same basis as the position and raw prices checked against them.

For an effective split with ratio `r = new shares / old shares`, multiply held quantity by `r`. Divide `entry_price`, `entry_ATR`, active stops/targets and scheduled stop levels by `r`, without rounding: a split followed by its reverse restores every level exactly. Convert pending entry ATR by the same ratio, but retain the monetary cap and frozen rank. Size the entry from that cap at the new raw opening price, including costs and lot rounding. Record the action identity and checkpoint its application to prevent double adjustment after recovery. A resulting fractional entitlement requires declared cash-in-lieu or fractional-share semantics; otherwise the evidence is insufficient, never silently rounded away.

For an ordinary cash dividend, record the entitled quantity held immediately before the ex-date boundary. New ex-date entries receive no entitlement. Add the declared cash entitlement as a receivable in equity on the ex-date and move it to cash only at the evidenced payment phase. It cannot fund entries before payment. Keep raw price levels and position quantity unchanged by the dividend. Include the raw ex-date price move and the separate entitlement once each in returns. Require causal action data, payment timing and any withholding assumptions in the profile. Special distributions or other unsupported action semantics make evidence insufficient.

Use the common calendar, cutoff, accounting and daily phases above. Re-entry after an exit requires a fresh close decision and cannot occur earlier than the next session's open. Record the differences from the source scripts, including warm-up/undefined-value handling, price basis and corporate actions, next-open fills, deferred stop changes, deterministic ties and exact cash accounting. Initial capital and instruments come from the evaluation profile; do not adopt the scripts' currency label or fallback tickers as defaults.

## 3. Evaluation and the Arena

### 3.1 Register the evaluation plan before selection

A cohort policy fixes the market profile, data splits, benchmarks, costs, evidence requirements, and promotion thresholds. It also declares the required robustness suite.

Every trial is registered before execution. Attempts reference one logical run. Operational retries do not count as new independent discoveries. Changed parameters, features, data selection, or strategy behaviour do count as new search trials.

In S1 the registered comparison is an evaluation plan. The API records it when the mission starts, after retrieval and before any validation or run, and never changes it. The cohort policy declares three non-overlapping scored windows: D (development), V (validation) and H (holdout). Window rules use calendar-date bounds. They resolve against the frozen retrieved calendar, and the plan records the resolved sessions. Each window is a separate run with a fresh ledger and the same fixed warm-up. The plan holds:

- trial slots: one for the seed and one for the revision of each proposer configuration; the seed slot names the seed's draft digest (§4), and a revision slot is a placeholder until its candidate is registered;
- the window rules and their resolved sessions;
- the scenarios: base costs, cost stress at twice the base costs, and a deterministic repeat of the D base run;
- the H slots of each trial slot;
- the gates, by reference to the cohort policy (§3.2). The policy also declares the benchmarks and metric scale (§3.6).

A planned slot is not a run. Runs, budget reservations and dispatch entries are written later (§4). The repeat checks determinism; it is not a new trial. The plan freezes these conditions. A controlled revision changes entry rules or exit rules, not both.

Retain the complete history of experiments performed within OpenQuant. Imported results disclose any unknown external search history. Do not infer a precise independent-trial count from raw job count.

Repeated selection can inflate apparent performance. The Deflated Sharpe Ratio literature explicitly addresses selection bias from multiple testing and non-normal returns. Where suitable, include an adjustment such as DSR or a probability-of-backtest-overfitting analysis, with its assumptions. No statistic alone proves an edge.

### 3.2 Required evidence categories

| Category | Required checks |
|---|---|
| Correctness | Definition validation, deterministic replay, accounting, signal timing, data availability |
| Historical validity | Point-in-time data, declared benchmarks, realistic costs, walk-forward evaluation |
| Robustness | Parameter sensitivity, cost stress, execution delay, adverse regimes, and the resampling tests required by the cohort |
| Prospective evidence | Frozen strategy versions observed on future live data, including outages and non-trading periods |
| Portfolio fit | Aggregate exposure, strategy-family overlap, costs, capacity, and contribution to the selected portfolio objective |
| Operating readiness | Production-path behaviour, failure recovery, reconciliation, mandate enforcement, and emergency procedures |

Do not remove a required test to make a candidate pass. A skipped or inapplicable test needs a policy-approved reason. Missing evidence is `INSUFFICIENT`, not a pass.

A cheap integrity failure can stop an invalid run. Required tests for an otherwise valid candidate remain required. Avoid an indiscriminate Cartesian product of every possible stress dimension; use the declared suite and explicit combined stress cases.

The S1 cohort policy assigns these checks to `EVALUATING` → `PAPER` eligibility:

| Category | S1 treatment |
|---|---|
| Correctness | Gates: definition validation, deterministic replay (two evaluations of one input give equal result digests), accounting reconciliation, and signal and data timing. |
| Historical validity | Gates: point-in-time data, the base cost model, excess return over buy-and-hold, walk-forward over D, V and H (§3.1), and a minimum trade count. |
| Robustness | Gate: cost stress at twice the base costs. Parameter sensitivity, execution delay and adverse regimes are `INSUFFICIENT` with a reason. Resampling is `NOT_APPLICABLE` with the policy reason. |
| Prospective evidence, portfolio fit, operating readiness | `NOT_APPLICABLE` to this transition, with the policy reason. |

Required robustness checks stay `INSUFFICIENT` in S1, so no S1 candidate can become eligible. The expected S1 mission outcome is therefore a valid `NO_ELIGIBLE_CANDIDATE`. Offline fixtures under a separate test policy cover the `PASS` path. Thresholds belong to the registered policy, not to this specification.

### 3.3 Data and holdout discipline

Store event time and availability time. Preserve instrument identity, calendars, corporate actions, delistings, and data revisions where relevant. Transformations must use only information available at the simulated decision time.

Define warm-up, missing-data handling, executable prices, spread, latency, liquidity participation, fees, and rounding. Include borrowing, funding, currency conversion, or other instrument-specific costs when the profile requires them. Otherwise declare the affected strategy unsupported.

An agent cannot inspect a final holdout before submitting its version. Once feedback is revealed, record that the holdout was consumed. Tuning on it cannot produce a fresh out-of-sample claim.

Historical data may already be represented in an LLM's training. A historical holdout is therefore not a complete defence against model contamination. Keep prospective paper evidence and record model provenance.

In S1 the evaluation plan holds the H slots from the start (§3.1). Only the freeze step writes H runs, once every trial slot is terminal (§4). In S1 every agent request, proposer and critic, carries holdout exclusions that name V and H. Revision context holds D results and findings only. Revealing an H result writes a holdout-consumption record. Label H "historical holdout within model training period". Record each configured model's published knowledge cutoff, or record that the checked source does not state it (OQ-03 §2).

### 3.4 Live paper competition

Each candidate receives its own virtual ledger under the same declared cohort capital and risk rules. Use common market observations and evaluation periods. Display unmatched periods separately rather than merging them into one ranking.

The referee controls timestamps, fill simulation, costs, and metrics. Agents cannot rewrite fills, reset losses, or selectively remove inactive periods.

A new version starts a new trial. Retain the old version's results. A failed or retired competitor remains in the cohort record.

A historical replay is labelled `REPLAY` or `BACKTEST`, never live paper trading. An official `PAPER` run requires a live-data adapter. Loss of data is recorded as missing evidence, not quietly repaired with favourable historical fills.

### 3.5 Shadow validation

Shadow runs the intended portfolio, sizing, risk checks, order construction, and broker constraints without submitting orders. It can share a live-data feed and core implementation with paper trading.

Store shadow evidence separately. A stronger paper return cannot substitute for an untested execution path. More shadow days cannot substitute for adequate market evidence either.

### 3.6 Results and selection

Keep these separate:

```text
Run status:       QUEUED / RUNNING / COMPLETED / FAILED / CANCELLED
Gate result:      PASS / FAIL / INSUFFICIENT / NOT_APPLICABLE
Decision outcome: APPROVED / REJECTED / DEFERRED
```

A completed run can contain failing gates. A gate pass does not grant capital.

Map each numerical outcome of the Rust core, and each submission that ends before the core prepares a run, to run status and gates as follows:

| Numerical outcome | Run status | Gates and follow-up |
|---|---|---|
| `COMPLETED` | `COMPLETED` | Assess gates from the run's metrics. |
| `FAILED` with `INVALID_LEVEL` or an operator code (`UNSUPPORTED_OPERATOR`, `OPERATOR_TYPE_MISMATCH`, `OPERATOR_UNIT_MISMATCH`, `INVALID_PARAMETER`) | `FAILED` | Correctness `FAIL`. The defect belongs to the candidate. |
| `FAILED` with `FUTURE_DATA`, `EVENT_OUT_OF_ORDER`, or an input, schema, identity, policy or checkpoint code | `FAILED` | Dependent gates `INSUFFICIENT`. The defect belongs to the platform; open an attention item. |
| `FAILED` with `ARITHMETIC_OVERFLOW` | `FAILED` | Outside the engine domain. Dependent gates `INSUFFICIENT`. |
| `INSUFFICIENT` with any code | `COMPLETED` | Dependent gates `INSUFFICIENT`. No metrics. |
| `NOT_PREPARED`: the job ended before the core prepared a run, with a failure code | `FAILED` | Mapped by its failure code, as the `FAILED` rows above. No metrics. |

Worker death or lease expiry does not decide a run. Recovery fences a new attempt of the same run up to a declared attempt cap (OQ-05 §4). The run is `FAILED` only when the cap is exhausted or the failure is not retryable. Cancellation gives `CANCELLED`.

Critic findings use the typed categories in [OQ-03 §4](03-model-backed-execution-spec.md#4-request-and-result-boundaries). The registered policy maps each category and its applicability conditions, including the lifecycle transitions it affects, to blocking or advisory treatment. Method notes, source summaries and model-stated severity cannot set or change that mapping. An unknown category is an invalid result, not an advisory finding. A finding based only on summary-only capital caps, parameter-count preferences or reward/risk thresholds (see `rule_origin`, OQ-03 §3) has the primary category `method_advice` unless the registered policy explicitly adopts that rule. Finding treatment is separate from run status, gate results and decision outcomes. A valid adverse finding is a completed research result, not a failed run or an approval.

Rank within comparable cohorts. Show net return, drawdown, tail risk, turnover, execution cost, exposure, sample size, search history, and uncertainty. Define each metric's unit, window, and method. Do not use unexplained “robustness: HIGH” or “portfolio contribution: +0.31” as approval inputs.

In S1 the Rust core computes these metrics for each run: net return, maximum drawdown, worst session return, turnover, trade and session counts, execution cost (fees plus the slippage reconstructed for gap-through-stop exits), exposure, the buy-and-hold return and the excess return over it. Metrics use scored sessions and `COMPLETED` numerical outcomes only. They use exact arithmetic and one half-even rounding. Money metrics, such as execution cost, round to the run's money scale. Ratio metrics, such as returns, drawdown, turnover and exposure, round to the policy's declared metric scale. Counts are integers. The tolerance is zero. The reviewed method text bound by method identity (§7) defines each unit, window and formula. The benchmarks are cash and same-stock buy-and-hold: whole lots bought at the first fillable open of the scored window, with the run's corporate-action handling. S1 does not compute uncertainty, because this section gives no method. The cohort policy records this as an approved limitation, and the D, V and H results are shown side by side. A Rust assessment job writes the gate report from the official results and the registered policy. The API only applies finding treatment and combines the gate results. Expected metric and gate values come from independent calculations (A04).

### 3.7 Controlled seed comparison

Register four versions from §2.6: threshold 30 without break-even, threshold 32 without break-even, threshold 30 with break-even, and threshold 32 with break-even. Keep the watchlist, dates, warm-up, data, initial capital, daily execution policy, costs and benchmarks identical. Record parentage and the changed rules. Compare net return, drawdown, turnover, trade count and cost sensitivity, with per-stock contributions and skipped entries.

These runs isolate the entry-rule change, exit change and their interaction. The current `RSI[t] > 30` floor remains fixed. Threshold 30 implies a crossing above 30 in one of the last two transitions, but not necessarily at session `t`. Threshold 32 also admits a path such as `31, 31, 31`, with no crossing. Interpret the entry variant as allowing this additional behaviour, not merely changing how deep a recovery must start. The comparison does not presume an improvement. Component-removal tests and new strategy families use their own registered trials. Failure and adverse results remain in the search history.

## 4. Lifecycle and promotion

Preserve the original checks, but do not build a service for each stage.

| Current state | Required evidence for the next state | Next state |
|---|---|---|
| `DRAFT` | Valid contract/definition, independent critique, registered evaluation plan | `EVALUATING` |
| `EVALUATING` | Required historical and robustness gates pass | `PAPER` |
| `PAPER` | Sufficient prospective evidence, no blocking findings, acceptable portfolio proposal | `SHADOW` |
| `SHADOW` | Execution-path checks and recovery tests pass; steward approves a live mandate | `LIVE`, mandate tier `MICRO` |
| `LIVE`, tier `MICRO` | Actual fills, costs, reconciliation, and risk behaviour support a larger allocation | `LIVE`, mandate tier `PRODUCTION` |

Independent critique applies to a validated, registered `DRAFT` version and its hash. A draft that fails validation receives diagnostics, not critique. A transition waits while an applicable finding that the registered policy treats as blocking for that transition remains unresolved (§3.6). Advisory findings remain visible in the evidence bundle.

In S1 a proposal follows this order:

1. Result parsing checks its structure, references and declared rule differences (OQ-03 §3).
2. The API checks scope, bounds and lineage.
3. Rust validation checks the draft by its draft digest, which is not a Strategy Version hash. It returns a validation result, recomputes the rule differences and requires the maximum lookback to fit the warm-up.
4. Only then is the version registered as `DRAFT` with its Strategy Version hash.
5. The candidate receives one critique, and the registered policy assigns treatment to its findings (table below).
6. The workflows service principal records the policy-determined `DRAFT` → `EVALUATING` Decision through the internal guarded command `record_evaluation_decision` (§1). An `APPROVED` Decision writes that version's D and V runs (base, cost stress, and the repeat of the D base run), their budget reservations and their dispatch-outbox entries, in one transaction.

The seed follows the same order. The Researcher's `register_seed` command stores the seed as a draft, by its draft digest, with its source-interpretation record. The draft is not yet a Strategy Version. The mission and the seed slot of its evaluation plan name that draft digest. The mission's first validation job validates the draft. Only then is Strategy Version 1 registered. A validation job always runs inside a mission.

The Decision is `DEFERRED` only when the critique ends without a valid result. This happens at once after an outcome that is not retried: refusal, denied capability, authentication failure or cancellation. It also happens when the attempt cap is exhausted after retried failures: timeout, malformed result, lease expiry or runner crash (OQ-05 §4). A `DEFERRED` Decision writes no run, reservation or outbox entry, and shows its reason. The candidate is not evaluated. The seed goes first. Revisions need the seed's D results. If the seed is not evaluated, no revision can run, and each revision slot ends with the reason `SEED_NOT_EVALUATED`. Otherwise each controlled revision follows the same path to its own D and V runs.

A trial slot of the evaluation plan (§3.1) is terminal when its candidate's D and V runs have ended, its Decision is `DEFERRED`, or no version passed validation for it (for a revision slot, within the revision budget). A revision slot is also terminal when the seed was not evaluated (`SEED_NOT_EVALUATED`). Once every slot is terminal, the workflows principal runs the internal guarded command `freeze_candidates` under the approved policy. It freezes the candidate set and writes the H runs of every candidate in `EVALUATING`, with their reservations and outbox entries, in one transaction (§3.3). If no candidate is in `EVALUATING`, for example because the seed was not evaluated, it writes no run and the mission concludes `NO_ELIGIBLE_CANDIDATE` with the recorded reasons. The assessment job receives the evaluation plan by reference. Assessment, eligibility and the mission outcome close the mission.

In S1 no finding category blocks `DRAFT` → `EVALUATING`. The cohort policy treats the categories for `EVALUATING` → `PAPER` eligibility as follows:

| Finding category | S1 treatment for `EVALUATING` → `PAPER` eligibility |
|---|---|
| `data_quality_alignment`, `causal_leakage`, `execution_accounting_assumption`, `search_overfitting`, `policy_mismatch`, `missing_evidence` | Blocking |
| `hypothesis_assumption`, `portfolio_fit`, `operational_risk`, `source_uncertainty`, `method_advice` | Advisory |

S1 records no `EVALUATING` → `PAPER` Decision; automatic paper promotion stays disabled until M2.

`PAUSED` suspends authority without erasing evidence or positions. `RETIRED` ends new deployment eligibility. Existing obligations remain visible until closed or transferred through an explicit process.

Paper promotion can be automatic under a previously approved cohort policy. First live use, increased capital ceilings, wider instrument permissions, weaker limits, and resumption after a risk halt require steward approval.

No fixed number of days proves readiness. Policies specify minimum observations, time coverage, operational evidence, and uncertainty limits appropriate to the strategy. A long elapsed period with few meaningful observations can still be insufficient.

### Approval protocol

An approval binds the exact strategy hash, engine compatibility, evidence manifest, policy revision, account, mandate limits, and expiry. Check these again when applying it. Reject stale approvals.

Persist the decision before dispatching activation. Distinguish `APPROVED`, `INSTALLED`, and `ACTIVE`. The TUI must not report activation until the execution engine confirms the installed revision and the API reads back the resulting state.

A behaviour-changing revision returns to evaluation. It does not inherit permission to trade merely because its parent version was approved.

## 5. Portfolio allocation

The Arena selects eligible candidates. A separate deterministic portfolio calculation proposes allocations. Neither raw-return rank nor agent voting controls capital.

The strategy owns ranking and sizing within its assigned budget (§2.4). This allocator owns allocation across strategies. Account execution owns authoritative cash, positions, reservations and broker orders. A five-slot watchlist strategy is one candidate here; its stock selector is not a second account allocator. Joint evaluation within that candidate is required in M1; cross-strategy portfolio validation remains M3.

Use one transparent allocator initially:

1. Group materially similar strategies into declared risk families.
2. Assign bounded risk budgets across eligible families.
3. Convert budgets to candidate capital using a documented volatility estimate and confidence tier.
4. Apply strategy, family, instrument, liquidity, turnover, and account limits.
5. Compare the proposal with the current portfolio after costs under the same evaluation scenarios.
6. Keep the current portfolio or retain cash when the proposal does not meet the predeclared objective.

Confidence tiers come from evidence policy, not an LLM's self-confidence. Cap adjustments rather than amplifying a noisy estimate. Do not redistribute unused capital automatically in a way that breaks family limits.

Report the change in expected return, observed drawdown, tail loss, exposure, and costs separately. The policy defines the objective and its allowed trade-offs before testing candidates. For example, diversification can target lower tail loss subject to a return floor. It need not select the highest standalone return.

Use bounded allocation steps and scheduled reviews. Automatic reductions operate within an approved policy. Capital-ceiling increases need approval. Strategy decay can trigger reduction, pause, or a new research mission.

Multiple strategies share one broker account. The engine keeps strategy sub-ledgers, combines target positions, accounts for working orders, and produces net account orders. Allocate fills and costs back through a fixed rule. Both gross strategy exposure and net account exposure remain subject to limits.

## 6. Live trading and risk

### 6.1 One accountable execution process

Use one active trading process per broker account. It owns market-state validation, target aggregation, risk reservations, submission, fill processing, and reconciliation.

Do not add separate risk, routing, order, and reconciliation microservices. These functions share the account state and must make consistent decisions.

Historical evaluation runs cannot share its broker credentials or consume its reserved resources. Deploying the API or the TUI must not restart the live process.

The account writer uses an ownership lease and revision. Losing ownership stops new submissions. Do not automatically promote a replacement while the old writer may still submit. A takeover requires stopping or isolating the old writer and reconciling broker state.

### 6.2 Before every order

Check the installed mandate, global halt, strategy status, market freshness, order age, account reconciliation, available cash, working-order reservations, position limits, exposure, liquidity, and price constraints.

Perform check-and-reserve as one serialised account operation. Release or adjust reservations only from confirmed outcomes. Concurrent intents must not each spend the same remaining risk budget.

Use explicit decimal amounts and instrument tick/lot rules for money and quantities. Statistical calculations may use floating point with documented tolerances. Wire contracts must not silently convert exact amounts to JavaScript binary floating-point numbers.

### 6.3 Unknown outcomes are a real state

Before broker submission, durably record the intent, mandate revision, reservation, and stable client-order identifier.

If submission times out, mark the order `UNKNOWN`. Do not assume it failed and resubmit with a new identifier. Query broker state and reconcile before taking further action on that intent.

Deduplicate broker updates by broker event/fill identifiers. Apply fills even when they arrive after a cancel request. A cancellation request is not a cancellation confirmation.

A small crash-recovery journal may retain broker messages and emergency cancellation records awaiting database persistence. It is not a second portfolio database. If durable recording fails, stop new submissions and escalate through the incident procedure.

### 6.4 Pause, halt, and liquidation

**Pause a strategy:** block new strategy risk and cancel applicable working orders. Keep managing and reporting its existing exposure under the approved exit policy.

**Halt the account:** block ordinary strategy submissions and request cancellation of cancellable working orders. Confirm each cancellation separately. Continue reconciliation. Existing positions are not automatically liquidated.

**Liquidate:** a separate authorised operation with its own execution limits. Any emergency risk-reduction order requires the necessary fresh broker and market state. “Risk-reducing” is not permission to bypass all checks.

Loss limits are intervention thresholds, not guarantees that losses cannot exceed them.

Before live enablement, test an emergency route independent of the ordinary Hono/TUI connection. At minimum, the steward must be able to use the broker's own controls. The normal application API remains the TUI's only control boundary.

### 6.5 Failure behaviour

| Failure | Required response |
|---|---|
| LLM unavailable | Pause research; installed deterministic strategies do not need the LLM. |
| Control application unavailable | Grant no new authority. Respect mandate expiry. Continue permitted supervision of existing orders and exposure. |
| Market data stale | Stop affected new risk. Keep the last observation timestamp visible. |
| Broker outcome unknown | Retain reservations and reconcile; never retry blindly. |
| Account state or ownership uncertain | Block new submissions and resolve ownership/state first. |
| Persistence unavailable | Stop new submissions; preserve recoverable broker events and use the emergency procedure as needed. |
| TUI disconnected | Trading controls continue independently. On return, fetch current state before permitting consequential actions. |

## 7. Reproducibility and compatibility

Every run binds the strategy, exact watchlist membership, profile, engine/operator compatibility, dataset manifests, calendar, warm-up and scored windows, initial capital, execution/cost policy, seed, and evaluation-suite versions. Record deterministic event ordering and recoverable checkpoints. The joint ledger, pending entries, reservations and scheduled stop changes belong to that same run identity.

Exact ledger results require exact reproducibility. Statistical outputs use declared tolerances. Prices, quantities, and monetary values use explicit decimal strings on the wire, except the checkpoint `Exact` value of OQ-05 section 7. Instrument tick, lot, currency, and rounding rules are part of the execution profile.

Reuse cached output only when all behaviour-affecting inputs match. Record reuse in the new run. Reused output is not new independent evidence.

An engine change must invalidate affected evidence or produce an explicit compatibility decision. Do not overwrite earlier results or silently accept changed numbers.

Engine identity covers the numerical evaluation contracts: the engine version, the operator set and the versions of the engine-scope contracts. Connected envelopes are outside it (OQ-05 §7); adding them does not change engine identity. Derived evidence (validation, metrics, benchmarks, gates and lineage) carries a separate method identity: the digest of a reviewed method text, pinned by a golden test. Bind method identity into each derived payload, the evaluation submission and the release identity. A change to that text changes method identity and needs the same explicit compatibility decision as an engine change. A content change to an engine-scope schema needs a new version tag or an explicit A18 compatibility decision. S1 keeps `evaluation-input/1` and carries the other run bindings in an outer evaluation request (OQ-05 §7). It adds a provider source value to the dataset reference of `evaluation-input/1` under one such decision: the core does not read the dataset source, so no number changes.

## 8. Durable ownership

Register each trial before execution. Keep a logical run separate from its operational attempts. Only the current authorised attempt can commit its official result.

Upload results before accepting their manifest. Unregistered artefacts are not evidence. Retain failure and cancellation records. Notifications do not establish completion.

Persist each consequential domain change and its audit event together. Corrections append new records. Do not erase history to make results look better.

[Architecture](05-system-architecture-and-data-spec.md) owns the database, queue, lease, and protocol implementation. [Model execution](03-model-backed-execution-spec.md) owns role separation and research budgets.

## 9. Acceptance and preservation of results

Acceptance tests below are requirements, not reported test results.

| ID | Required demonstration |
|---|---|
| **A01** | Multiple proposer configurations produce registered competing candidates. An independent critic can block a candidate with an unresolved finding. |
| **A02** | Agents cannot write official results, enlarge budgets, approve their own work, change mandates, or submit broker orders. |
| **A03** | Repeating fixed-input evaluation reproduces signals, orders, accounting, gate outcomes, and metrics within declared tolerances. |
| **A04** | An independent hand-calculated fixture checks fees, fills, cash, positions, and return calculations. Agreement between two paths using the same bug is insufficient. |
| **A05** | Leakage, future-data access, missing data, and invalid strategy operators produce explicit failures. Consumed holdouts cannot be relabelled untouched. |
| **A06** | Search history survives revisions, discarded variants, cancelled runs, and retries. Imported unknown history remains marked unknown. |
| **A07** | Live paper competitors use comparable conditions and retain losses, outages, and retired candidates. Replay cannot be presented as prospective paper evidence. |
| **A08** | Paper and shadow use shared strategy semantics, but store distinct evidence. A paper pass cannot bypass shadow checks. |
| **A09** | Every real-money activation binds current evidence, policy, version, and mandate. Stale, expired, or unapproved activation is rejected. |
| **A10** | Portfolio allocation accounts for families, correlations, liquidity, costs, and unused cash. Aggregate reservations prevent concurrent orders exceeding capacity. |
| **A11** | Queue redelivery, workflow retry, worker death, and result-upload failure create no duplicate official result or orphaned permanent success claim. |
| **A12** | An order accepted by the broker before a simulated timeout is found by reconciliation without a duplicate submission. Duplicate fill messages do not duplicate P&L. |
| **A13** | A stale writer, stale quote, unknown account state, unavailable durable store, or active halt blocks new unapproved exposure. Late fills remain visible. |
| **A14** | Halt and liquidation have different effects. Emergency access works when the ordinary application is unavailable. Restart begins with reconciliation. |
| **A15** | The TUI preserves focus and confirmations, identifies stale/unknown state, and reports success only after authoritative read-back. |
| **A16** | A clean installed release runs the fixture demo without cloud, model, data-provider, or broker credentials. |
| **A17** | A public benchmark export is reproducible, version-labelled, licence-checked, and free from private account data and secrets. |
| **A18** | Engine changes invalidate affected evidence or produce an explicit compatibility decision. Changed numbers are explained, not silently replaced. |

A01's critic block applies when an unresolved finding has an applicable blocking treatment under the registered policy (§§3.6 and 4). The critic cannot assign that treatment, close its own finding or approve the candidate. This interprets A01 without changing its wording.

### Measuring “same results”

For deterministic behaviour, create golden reference fixtures from the approved semantics and independent calculations. Compare old and new implementations on identical inputs when an older implementation exists. Do not use the earlier documents' illustrative returns as targets.

For research quality, compare role configurations on the same missions, budgets, datasets, and model versions. Measure valid candidate yield, known-flaw detection, calibration, diversity, compute cost, and prospective portfolio contribution. Use repeated runs and report uncertainty.

Fewer agents must not be claimed to produce equally good strategies until that comparison is run. If a specialised role improves results materially at the same budget, add it as another profile of the existing runner, not another service.

No benchmark establishes future profitability. Promotion gates reduce specific risks; they do not eliminate market risk.

## 10. Source migration

Adopts Design v2 §§4–5, 8–13, and 16. A01–A18 retain their original identifiers and wording. No broker, live capital limit, or market-data entitlement is selected by this specification.

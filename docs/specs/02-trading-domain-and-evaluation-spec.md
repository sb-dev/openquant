---
id: OQ-02
title: OpenQuant — Trading Domain and Evaluation
version: 1.0.0
status: canonical
updated: 2026-10-19
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

An **Evidence Bundle** is a manifest of the exact runs, findings, and policy used for a decision. It is not another copy of their contents.

The **Strategy Graph** is a generated view of parent versions and linked records. Its maintenance is automatic. It needs no manual graph editing and no separate graph database.

Each account has one execution writer. API users, AI agents, and evaluation workers cannot edit its positions or fills. Manual broker activity is imported through reconciliation, not concealed by editing OpenQuant state.

## 2. One strategy format

### 2.1 Strategy Contract and Strategy Definition

Keep the existing terminology, with one ownership rule:

**The Strategy Contract explains a strategy. The Strategy Definition specifies its executable behaviour. Both belong to the same versioned artefact.**

The contract contains the hypothesis, economic rationale, intended conditions, benchmarks, assumptions, and invalidation conditions. The definition contains the universe, data dependencies, signals, entries, exits, sizing, and requested execution behaviour.

The approved version binds both sections to one hash. Behavioural changes create a new version. There is no production strategy code generated independently from this artefact.

### 2.2 Bounded execution

The definition uses a small set of reviewed operators. Start with the operators required by the bundled strategies: rolling calculations, comparisons, boolean conditions, rebalance rules, and sizing rules.

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

## 3. Evaluation and the Arena

### 3.1 Register the evaluation plan before selection

A cohort policy fixes the market profile, data splits, benchmarks, costs, evidence requirements, and promotion thresholds. It also declares the required robustness suite.

Every trial is registered before execution. Attempts reference one logical run. Operational retries do not count as new independent discoveries. Changed parameters, features, data selection, or strategy behaviour do count as new search trials.

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

### 3.3 Data and holdout discipline

Store event time and availability time. Preserve instrument identity, calendars, corporate actions, delistings, and data revisions where relevant. Transformations must use only information available at the simulated decision time.

Define warm-up, missing-data handling, executable prices, spread, latency, liquidity participation, fees, and rounding. Include borrowing, funding, currency conversion, or other instrument-specific costs when the profile requires them. Otherwise declare the affected strategy unsupported.

An agent cannot inspect a final holdout before submitting its version. Once feedback is revealed, record that the holdout was consumed. Tuning on it cannot produce a fresh out-of-sample claim.

Historical data may already be represented in an LLM's training. A historical holdout is therefore not a complete defence against model contamination. Keep prospective paper evidence and record model provenance.

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

Rank within comparable cohorts. Show net return, drawdown, tail risk, turnover, execution cost, exposure, sample size, search history, and uncertainty. Define each metric's unit, window, and method. Do not use unexplained “robustness: HIGH” or “portfolio contribution: +0.31” as approval inputs.

## 4. Lifecycle and promotion

Preserve the original checks, but do not build a service for each stage.

| Current state | Required evidence for the next state | Next state |
|---|---|---|
| `DRAFT` | Valid contract/definition, independent critique, registered evaluation plan | `EVALUATING` |
| `EVALUATING` | Required historical and robustness gates pass | `PAPER` |
| `PAPER` | Sufficient prospective evidence, no blocking findings, acceptable portfolio proposal | `SHADOW` |
| `SHADOW` | Execution-path checks and recovery tests pass; steward approves a live mandate | `LIVE`, mandate tier `MICRO` |
| `LIVE`, tier `MICRO` | Actual fills, costs, reconciliation, and risk behaviour support a larger allocation | `LIVE`, mandate tier `PRODUCTION` |

`PAUSED` suspends authority without erasing evidence or positions. `RETIRED` ends new deployment eligibility. Existing obligations remain visible until closed or transferred through an explicit process.

Paper promotion can be automatic under a previously approved cohort policy. First live use, increased capital ceilings, wider instrument permissions, weaker limits, and resumption after a risk halt require steward approval.

No fixed number of days proves readiness. Policies specify minimum observations, time coverage, operational evidence, and uncertainty limits appropriate to the strategy. A long elapsed period with few meaningful observations can still be insufficient.

### Approval protocol

An approval binds the exact strategy hash, engine compatibility, evidence manifest, policy revision, account, mandate limits, and expiry. Check these again when applying it. Reject stale approvals.

Persist the decision before dispatching activation. Distinguish `APPROVED`, `INSTALLED`, and `ACTIVE`. The TUI must not report activation until the execution engine confirms the installed revision and the API reads back the resulting state.

A behaviour-changing revision returns to evaluation. It does not inherit permission to trade merely because its parent version was approved.

## 5. Portfolio allocation

The Arena selects eligible candidates. A separate deterministic portfolio calculation proposes allocations. Neither raw-return rank nor agent voting controls capital.

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

Every run binds the strategy, engine, dataset, cost model, policy, seed, and evaluation-suite versions. Record deterministic event ordering and recoverable checkpoints.

Exact ledger results require exact reproducibility. Statistical outputs use declared tolerances. Prices, quantities, and monetary values use explicit decimal strings on the wire. Instrument tick, lot, currency, and rounding rules are part of the execution profile.

Reuse cached output only when all behaviour-affecting inputs match. Record reuse in the new run. Reused output is not new independent evidence.

An engine change must invalidate affected evidence or produce an explicit compatibility decision. Do not overwrite earlier results or silently accept changed numbers.

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

### Measuring “same results”

For deterministic behaviour, create golden reference fixtures from the approved semantics and independent calculations. Compare old and new implementations on identical inputs when an older implementation exists. Do not use the earlier documents' illustrative returns as targets.

For research quality, compare role configurations on the same missions, budgets, datasets, and model versions. Measure valid candidate yield, known-flaw detection, calibration, diversity, compute cost, and prospective portfolio contribution. Use repeated runs and report uncertainty.

Fewer agents must not be claimed to produce equally good strategies until that comparison is run. If a specialised role improves results materially at the same budget, add it as another profile of the existing runner, not another service.

No benchmark establishes future profitability. Promotion gates reduce specific risks; they do not eliminate market risk.

## 10. Source migration

Adopts Design v2 §§4–5, 8–13, and 16. A01–A18 retain their original identifiers and wording. No broker, live capital limit, or market-data entitlement is selected by this specification.

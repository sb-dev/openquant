# AI-Native Quant Trading Platform — Design Specification

**Version:** 1.0  
**Status:** Concept / operating specification  
**Scope:** Lightweight research, strategy competition, paper trading, controlled capital promotion, and live portfolio operation.

---

## 1. Purpose

Build a lightweight AI-native quantitative trading platform that continuously:

1. generates market hypotheses and trading strategies with AI agents;
2. tests those strategies under reproducible and adversarial conditions;
3. lets strategies compete through live paper trading;
4. promotes only robust strategies through progressively stricter gates;
5. allocates real capital according to portfolio contribution and risk;
6. continuously monitors, demotes, mutates, or retires strategies as evidence changes.

The platform is not an autonomous trading bot.

It is a **governed strategy market** in which agents compete to produce evidence and strategies compete to earn capital.

The primary optimisation target is:

> **Sustainable portfolio-level risk-adjusted return after realistic costs, subject to hard risk constraints.**

Raw strategy return is never sufficient for promotion.

---

## 2. Design Principles

### 2.1 Evidence before capital

Agents may propose strategies. Strategies may earn capital only through evidence.

No strategy moves directly from idea or backtest to material live capital.

### 2.2 Separate creation from judgement

The same agent must not control strategy creation, evaluation, capital allocation, and execution.

At minimum, the platform separates:

- research;
- strategy construction;
- adversarial review;
- evaluation;
- risk;
- capital allocation;
- execution.

### 2.3 Portfolio value over individual winners

The best standalone strategy is not necessarily the best addition to the fund.

Capital allocation considers:

- expected return;
- downside risk;
- drawdown;
- correlation;
- factor exposure;
- liquidity;
- capacity;
- transaction costs;
- marginal portfolio contribution.

### 2.4 Live evidence outranks simulated evidence

Evidence strength increases approximately in this order:

`hypothesis < backtest < walk-forward < paper < shadow < micro-capital < production`

Historical performance can reject a strategy but should not, by itself, justify substantial capital.

### 2.5 Every experiment has a cost

The platform records every strategy variant, parameter search, dataset choice, and evaluation attempt.

A strategy is judged in the context of **all trials that produced it**, not only its winning backtest.

### 2.6 Risk controls are outside the strategy

A strategy cannot increase its own:

- capital;
- leverage;
- permitted instruments;
- position limits;
- drawdown limits;
- execution permissions.

Hard controls live below the agent layer and above the broker.

### 2.7 Strategies are disposable

Strategies are expected to decay.

Retirement is a normal lifecycle state, not a failure of the platform.

### 2.8 Reproducibility is mandatory

Every material result must be reproducible from versioned:

- strategy code;
- strategy contract;
- data;
- configuration;
- cost model;
- execution model;
- evaluation method.

---

## 3. Core Operating Model

The system has four logical domains.

### 3.1 Foundry

Creates hypotheses and candidate strategies.

Outputs:

- research theses;
- strategy contracts;
- implementations;
- mutations of existing strategies.

### 3.2 Arena

Evaluates competing strategies.

It runs:

- historical tests;
- walk-forward tests;
- robustness tests;
- stress tests;
- live paper trading;
- shadow trading.

The Arena, not the strategy agent, owns official performance results.

### 3.3 Governor

Owns independent risk and promotion controls.

It can:

- reject a strategy;
- block an order;
- reduce allocation;
- pause a strategy;
- halt the entire platform.

### 3.4 Fund

Owns the live portfolio.

It:

- allocates capital;
- combines approved strategies;
- sends approved orders through the execution gateway;
- attributes portfolio P&L and risk;
- continuously reassesses allocations.

---

## 4. Core Domain Objects

### 4.1 Hypothesis

A falsifiable claim about a potential market edge.

Required fields:

- thesis;
- economic or behavioural rationale;
- target market;
- expected horizon;
- required data;
- expected regime;
- known failure conditions;
- confidence.

A hypothesis is not executable.

### 4.2 Strategy Contract

The canonical specification for a strategy.

Required fields:

```yaml
strategy:
  id:
  version:
  parent_strategy:
  hypothesis:
  universe:
  frequency:
  signal:
  entry:
  exit:
  sizing:
  execution_assumptions:
  risk_limits:
  expected_regimes:
  invalidation_conditions:
  required_data:
  benchmark:
```

The contract is the boundary between research intent and implementation.

### 4.3 Strategy Implementation

Executable implementation of one Strategy Contract version.

Multiple implementations may compete against the same contract.

### 4.4 Experiment

One evaluation attempt.

It records:

- strategy version;
- parameters;
- input data version;
- test window;
- cost model;
- execution model;
- result;
- agent responsible;
- parent experiment;
- whether the result influenced later work.

Failed and abandoned experiments remain part of the record.

### 4.5 Evidence Bundle

The complete evidence supporting the current strategy state.

It may contain:

- backtest results;
- walk-forward results;
- stress tests;
- critic findings;
- paper-trading record;
- shadow-trading record;
- live execution record;
- incidents;
- current confidence.

Promotion decisions operate on Evidence Bundles rather than isolated metrics.

### 4.6 Agent Reputation

A role-specific performance record.

Examples:

- researcher reputation;
- critic reputation;
- implementation reliability;
- forecast calibration;
- risk detection quality.

Reputation affects how much influence an agent receives, but never overrides hard policy.

### 4.7 Capital Mandate

The maximum authority granted to a live strategy.

It contains:

- allocated capital;
- maximum gross exposure;
- leverage;
- instrument permissions;
- position limits;
- loss limits;
- execution permissions;
- expiry/review date.

A strategy cannot modify its own mandate.

---

## 5. Agent Model

Use specialised agents with narrow authority.

### 5.1 Research Agent

Responsibilities:

- explore market structure and data;
- generate falsifiable hypotheses;
- identify candidate signals;
- explain the expected source of edge.

Cannot:

- approve its own hypothesis;
- allocate capital;
- place orders.

### 5.2 Strategy Agent

Responsibilities:

- convert approved hypotheses into Strategy Contracts;
- define entry, exit, sizing, and invalidation logic;
- propose variants.

Cannot:

- score official results;
- change production risk limits.

### 5.3 Implementation Agent

Responsibilities:

- implement Strategy Contracts;
- maintain tests;
- preserve contract semantics;
- optimise runtime without silently changing strategy behaviour.

### 5.4 Critic Agent

Responsibilities:

- attempt to falsify hypotheses;
- identify leakage, overfitting, selection bias, and unrealistic assumptions;
- propose stress scenarios;
- challenge economic rationale;
- compare apparent alpha with known factor exposures.

Critics build reputation when their warnings predict later failures.

### 5.5 Evaluation Agent

Responsibilities:

- execute official experiments;
- enforce test isolation;
- calculate official metrics;
- maintain hidden evaluation sets;
- detect invalid experiments.

The Evaluation Agent owns the scoreboard.

### 5.6 Risk Agent

Responsibilities:

- evaluate strategy and portfolio risk;
- enforce mandate limits;
- detect abnormal behaviour;
- veto promotion or execution.

The Risk Agent can reduce authority but cannot grant itself trading authority.

### 5.7 Allocator Agent

Responsibilities:

- estimate marginal portfolio contribution;
- recommend allocations;
- account for correlation, capacity, and risk concentration;
- propose rebalancing.

Allocation recommendations remain bounded by the Governor.

### 5.8 Execution Agent

Responsibilities:

- transform approved target orders into executable orders;
- minimise execution cost within policy;
- manage order state;
- report actual versus expected fills.

It cannot invent trades or change investment logic.

### 5.9 Steward

Human control role.

Required for:

- enabling real-money trading;
- increasing major capital limits;
- changing global risk policy;
- enabling new asset classes or brokers;
- overriding automated pauses;
- emergency intervention.

---

## 6. Strategy Lifecycle

Every strategy follows the same state machine.

```text
IDEA
  ↓
CONTRACT
  ↓
ADVERSARIAL_REVIEW
  ↓
BACKTEST
  ↓
ROBUSTNESS
  ↓
PAPER
  ↓
SHADOW
  ↓
MICRO_CAPITAL
  ↓
PRODUCTION
  ↓
────────────────────────────
PAUSED / MUTATING / RETIRED
```

Promotion is evidence-driven.

Demotion can happen from any live stage.

### 6.1 Idea

A research hypothesis is registered.

Minimum output:

- falsifiable thesis;
- rationale;
- intended market;
- expected failure condition.

### 6.2 Contract

The hypothesis becomes a precise Strategy Contract.

Ambiguous contracts cannot progress.

### 6.3 Adversarial Review

Critics attempt to reject the strategy before expensive testing.

Typical attacks:

- no plausible mechanism;
- hidden look-ahead;
- survivorship bias;
- data leakage;
- unrealistic fills;
- untradeable liquidity;
- excessive complexity;
- duplicated portfolio exposure.

### 6.4 Backtest

Historical test with point-in-time data and explicit trading costs.

Backtest results are accompanied by:

- number of strategy variants tried;
- number of parameter combinations tried;
- sensitivity analysis;
- benchmark comparison;
- cost assumptions;
- rejected experiments.

### 6.5 Robustness

Required robustness methods should include an appropriate subset of:

- rolling or expanding walk-forward validation;
- untouched holdout periods;
- cross-regime evaluation;
- parameter perturbation;
- cost and slippage stress;
- execution-delay stress;
- bootstrap or Monte Carlo analysis;
- probability-of-backtest-overfitting analysis;
- multiple-testing-aware performance adjustment;
- synthetic or counterfactual stress scenarios.

No single metric is the universal promotion rule.

### 6.6 Paper

The strategy consumes live data and produces simulated orders.

The official simulator owns:

- timestamps;
- order acceptance;
- fills;
- spread;
- slippage;
- fees;
- P&L.

Agents cannot rewrite fills after observing outcomes.

### 6.7 Shadow

The strategy produces the orders it would send in production.

The platform records:

- market state at decision time;
- intended order;
- executable market conditions;
- expected fill;
- subsequent outcome;
- interaction with the live portfolio.

No order reaches the broker.

### 6.8 Micro-Capital

A strategy receives the minimum meaningful live allocation.

The purpose is execution validation, not profit maximisation.

Capital increases remain deliberately slow.

### 6.9 Production

The strategy participates in the live portfolio.

Allocation is dynamic and can move both up and down.

### 6.10 Mutation

A strategy may produce descendants when:

- its edge weakens;
- execution changes;
- market regime changes;
- critics identify a fix;
- new data supports a revision.

A mutation receives a new Strategy Contract version and re-enters the lifecycle at the appropriate evaluation stage.

### 6.11 Retirement

Retire when:

- the edge no longer survives evaluation;
- expected capacity disappears;
- live behaviour materially deviates from the contract;
- a strategy becomes redundant;
- governance cost exceeds portfolio contribution.

Historical lineage remains immutable.

---

## 7. Strategy Arena

### 7.1 Competition unit

Strategies compete for **promotion and capital**, not a permanent rank.

There is no single universal leaderboard.

The Arena exposes several views:

- absolute performance;
- risk-adjusted performance;
- robustness;
- drawdown;
- execution quality;
- diversification contribution;
- confidence/evidence strength.

### 7.2 Cohorts

Only economically comparable strategies should compete directly.

Possible cohorts:

- same asset class;
- same horizon;
- same liquidity tier;
- same risk budget;
- same strategy family.

This reduces meaningless comparisons between structurally different strategies.

### 7.3 Hidden evaluation

The platform may withhold:

- specific holdout periods;
- stress scenarios;
- cost shocks;
- execution-delay scenarios;
- regime subsets.

Agents receive the result and diagnostics after official evaluation, not the hidden test definition beforehand.

### 7.4 Trial accounting

The Arena records the complete search path.

If 5,000 variants were tried before one attractive backtest emerged, the winner is evaluated as the result of 5,000 trials.

Discarding losing trials from the record is prohibited.

---

## 8. Game-Theoretic Mechanism

Game theory is used to design incentives, not to make the system unnecessarily complex.

### 8.1 Roles have conflicting objectives

Different agents optimise different goals:

- Researcher: find genuine edge.
- Strategy Agent: make the edge executable.
- Critic: find reasons it will fail.
- Evaluator: measure without favour.
- Allocator: improve the whole portfolio.
- Risk Agent: limit ruin and abnormal behaviour.

No single agent controls the full payoff function.

### 8.2 Agent reputation

Agents accumulate role-specific reputation.

Examples:

**Researcher**

Reward when proposed strategies later survive out-of-sample and live evaluation.

**Critic**

Reward when identified risks later prove material.

Penalise critics that indiscriminately reject everything.

**Allocator**

Reward calibration between predicted and realised marginal portfolio contribution.

**Execution Agent**

Reward realised implementation shortfall relative to the approved execution objective.

### 8.3 Confidence staking

When making material predictions, agents submit a probability or confidence score.

Examples:

- probability a strategy survives paper trading;
- probability its Sharpe falls below a threshold;
- probability a drawdown limit is breached;
- probability correlation with another strategy exceeds a threshold.

Reputation is updated using a proper scoring rule.

This rewards calibrated uncertainty rather than confident rhetoric.

No monetary token economy is required.

### 8.4 Adversarial review

Each important proposal receives at least one independent critic.

Higher-risk proposals receive multiple critics with different attack mandates:

- statistical;
- market-structure;
- execution;
- portfolio;
- operational.

### 8.5 No winner-takes-all

The platform deliberately avoids giving all capital to the current top performer.

Winner-takes-all selection encourages:

- leverage;
- tail-risk hiding;
- short-term optimisation;
- strategy convergence.

Instead, capital is diversified and scaled by marginal portfolio value.

### 8.6 Exploration budget

The fund reserves a controlled research budget for new strategies.

This prevents successful incumbents from consuming all available resources and eliminating exploration.

The exploration budget is risk capital for **learning**, not a licence for uncontrolled live trading.

---

## 9. Evaluation Model

### 9.1 Metric groups

Every strategy receives a vector of scores.

Do not collapse all evaluation into a single opaque number.

#### Performance

Examples:

- cumulative return;
- annualised return;
- Sharpe;
- Sortino;
- expectancy;
- profit factor.

#### Risk

Examples:

- realised volatility;
- maximum drawdown;
- downside deviation;
- expected shortfall;
- concentration;
- leverage;
- gap exposure.

#### Robustness

Examples:

- out-of-sample degradation;
- cross-regime consistency;
- parameter sensitivity;
- cost sensitivity;
- probability of backtest overfitting;
- multiple-testing-adjusted performance;
- result dispersion across validation windows.

#### Execution

Examples:

- turnover;
- implementation shortfall;
- spread paid;
- slippage;
- fill ratio;
- latency sensitivity;
- capacity.

#### Portfolio contribution

Examples:

- correlation;
- marginal volatility;
- marginal drawdown;
- factor diversification;
- capital efficiency;
- incremental expected return.

#### Governance

Examples:

- reproducibility;
- contract completeness;
- test coverage;
- known failure boundaries;
- incident history;
- unexplained deviations.

### 9.2 Promotion score

Promotion rules may combine metrics, but hard gates remain independent.

A strategy with excellent expected return cannot compensate for:

- invalid data;
- failed risk controls;
- unexplained behaviour;
- insufficient evidence;
- unacceptable liquidity.

### 9.3 Benchmarking

Every strategy declares relevant benchmarks before official evaluation.

Depending on the strategy, benchmarks may include:

- cash;
- passive index exposure;
- factor portfolio;
- naive strategy;
- current production strategy;
- randomised/null model.

Benchmark choice cannot be changed retrospectively to improve appearance.

---

## 10. Capital Allocation

### 10.1 Objective

Allocate capital to maximise portfolio utility subject to hard constraints.

Conceptually:

```text
maximise:
    expected portfolio contribution
  - risk penalty
  - concentration penalty
  - execution/capacity penalty
  - uncertainty penalty
```

Subject to:

```text
strategy mandates
portfolio exposure limits
liquidity limits
drawdown limits
leverage limits
asset/instrument permissions
```

### 10.2 Confidence-adjusted allocation

New or weakly evidenced strategies receive an uncertainty haircut.

Two strategies with equal estimated edge need not receive equal capital if one has substantially less evidence.

### 10.3 Incremental promotion

Capital increases through bounded steps.

Example:

```text
£0
→ paper
→ shadow
→ £100
→ £500
→ £2,000
→ £10,000
→ production mandate
```

Actual levels are configurable by fund size and instrument.

There is no automatic exponential scaling.

### 10.4 Allocation decay

Allocation should decrease when:

- confidence falls;
- correlation rises;
- drawdown exceeds expectation;
- execution deteriorates;
- strategy capacity shrinks;
- regime fit weakens.

Demotion should be easier than promotion.

---

## 11. Risk Architecture

Risk control has four layers.

### 11.1 Strategy risk

Per-strategy controls may include:

- maximum capital;
- maximum position;
- maximum order;
- maximum leverage;
- maximum daily loss;
- maximum drawdown;
- maximum turnover;
- instrument whitelist;
- trading hours;
- maximum stale-signal age.

### 11.2 Portfolio risk

Controls may include:

- gross exposure;
- net exposure;
- leverage;
- asset concentration;
- sector concentration;
- factor concentration;
- correlated-strategy concentration;
- liquidity;
- daily loss;
- portfolio drawdown.

### 11.3 Execution risk

The Trading Gateway enforces:

- pre-trade validation;
- price collars;
- quantity/notional limits;
- duplicate-order detection;
- stale-market-data rejection;
- market-state checks;
- order-rate limits;
- kill switches.

These controls execute independently of LLM availability.

### 11.4 Platform risk

The platform must support:

- deterministic shutdown;
- broker disconnect handling;
- stale data detection;
- reconciliation;
- immutable decision logs;
- clock/time synchronisation;
- restart recovery;
- business continuity;
- human emergency control.

---

## 12. Trading Gateway

The Trading Gateway is the sole production boundary to brokers or venues.

```text
Strategy
   ↓
Target Position / Trade Intent
   ↓
Portfolio + Risk Evaluation
   ↓
Approved Order Intent
   ↓
Trading Gateway
   ↓
Pre-trade Controls
   ↓
Execution
   ↓
Broker / Venue
```

Strategy agents never receive broker credentials.

The gateway must reject an order when:

- mandate is absent;
- risk limits fail;
- data is stale;
- instrument is not permitted;
- the strategy is paused;
- the order conflicts with a global halt;
- order state cannot be reconciled safely.

---

## 13. Data and Experiment Integrity

### 13.1 Point-in-time correctness

Historical evaluation must only expose information available at the simulated decision time.

### 13.2 Immutable raw data

Raw market and reference data is immutable once ingested.

Corrections produce versioned replacements.

### 13.3 Dataset lineage

Every experiment records exact dataset versions.

### 13.4 Feature lineage

Derived features record:

- source data;
- transformation version;
- effective timestamp;
- availability timestamp.

### 13.5 Search lineage

The platform records:

- hypotheses considered;
- strategies generated;
- parameters searched;
- features tried;
- discarded experiments.

This enables multiple-testing and overfitting controls.

---

## 14. Strategy Graph

The platform maintains a graph of strategy lineage and evidence.

Example:

```text
Market Observation
      ↓
Hypothesis H17
      ↓
Strategy S42 v1
  ↙       ↓       ↘
Critic   Tests   Implementation
          ↓
      Evidence E12
          ↓
      Paper Run P8
          ↓
     Strategy S42 v2
          ↓
      Micro Capital
          ↓
       Production
```

The graph should answer:

- Where did this strategy originate?
- Which data and experiments support it?
- How many alternatives were tried?
- Which agent proposed it?
- Which critics challenged it?
- Why was it promoted?
- Why does it currently have this allocation?
- What would invalidate it?
- Which production orders did it cause?
- Which descendants came from it?

Graph maintenance is automatic.

---

## 15. Control Plane and Audit

Every material automated decision generates a structured decision record.

Example:

```yaml
decision:
  id:
  timestamp:
  actor:
  action:
  strategy:
  inputs:
  evidence:
  policy_version:
  outcome:
  confidence:
  explanation:
  resulting_state:
```

Critical actions require deterministic policy checks even when an AI agent recommends them.

Audit records must cover:

- strategy versions;
- experiments;
- promotion decisions;
- allocation changes;
- risk decisions;
- production orders;
- fills;
- incidents;
- human overrides.

---

## 16. Operating Cadence

### Continuous

- ingest data;
- run active strategies;
- enforce risk;
- reconcile positions and orders;
- monitor incidents.

### Daily

- P&L attribution;
- exposure report;
- strategy health;
- paper/shadow results;
- execution quality;
- abnormal-behaviour detection.

### Weekly

- Arena review;
- promotion/demotion decisions;
- allocation rebalance;
- critic review;
- strategy decay analysis;
- new research priorities.

### Monthly

- strategy retirement review;
- portfolio regime review;
- agent reputation update;
- experiment/search audit;
- risk-limit review.

### Periodic governance review

- broker and venue controls;
- model/agent governance;
- disaster recovery;
- regulatory obligations;
- asset-class permissions;
- capital scaling.

---

## 17. Lightweight Initial Platform

The first useful system should remain small.

### Phase 1 — Research + Arena

Build:

- Strategy Contract;
- Strategy Graph;
- Research Agent;
- Strategy Agent;
- Critic Agent;
- Evaluation Agent;
- reproducible backtest runner;
- trial accounting;
- robustness evaluation;
- strategy scorecard.

No broker connection.

### Phase 2 — Live Paper Market

Add:

- live market data;
- persistent paper portfolios;
- execution simulator;
- strategy cohorts;
- live leaderboard;
- agent reputation;
- confidence scoring.

This is the first complete **strategy market**.

### Phase 3 — Shadow Fund

Add:

- portfolio allocator;
- fund-level risk;
- shadow target positions;
- realistic order-intent simulation;
- broker market-state comparison;
- operations console.

No live orders.

### Phase 4 — Micro-Capital

Add:

- Trading Gateway;
- broker connection;
- pre-trade controls;
- reconciliation;
- kill switches;
- human approval;
- tiny live mandates.

### Phase 5 — AI-Native Fund

Add:

- multiple production strategies;
- dynamic allocation;
- automated demotion;
- strategy mutation;
- portfolio-level learning;
- investor/reporting layer if required.

---

## 18. Explicit Non-Goals

The initial platform does not attempt to:

- build an unrestricted autonomous hedge fund;
- let LLMs send arbitrary broker orders;
- optimise high-frequency execution;
- predict every asset class;
- create a token economy for agents;
- use one universal leaderboard score;
- promote strategies solely from backtests;
- automate legal or compliance judgement;
- eliminate human governance.

These can be reconsidered only when they solve a demonstrated constraint.

---

## 19. Success Criteria

The platform is successful when it can demonstrate all of the following:

1. Every live strategy can be traced to its hypothesis and complete experiment history.
2. Failed and discarded experiments remain visible.
3. Agents cannot approve or capitalise their own work.
4. Paper-trading results cannot be modified by strategy agents.
5. Promotion requires increasing levels of independent evidence.
6. Capital allocation considers portfolio contribution rather than raw return.
7. Hard risk limits remain enforceable without AI agents.
8. A strategy can be automatically paused or demoted.
9. Broker access exists only through the Trading Gateway.
10. Production decisions and orders are reconstructable from audit records.
11. The system can operate usefully in paper-only mode before real capital is enabled.

---

## 20. Core Product Loop

The complete platform can be reduced to one loop:

```text
OBSERVE
   ↓
HYPOTHESISE
   ↓
DESIGN
   ↓
ATTACK
   ↓
TEST
   ↓
COMPETE
   ↓
ALLOCATE
   ↓
TRADE
   ↓
MEASURE
   ↓
PROMOTE / DEMOTE / MUTATE / RETIRE
   └──────────────────────────────→ OBSERVE
```

The loop should become better at three things over time:

1. finding genuine edges;
2. rejecting false edges earlier;
3. allocating capital more efficiently.

That—not the intelligence of any individual agent—is the durable advantage of the platform.

---

## 21. Governing Principle

> **Agents compete for credibility. Strategies compete for capital. Risk controls remain sovereign.**

This principle should remain true as the platform grows.

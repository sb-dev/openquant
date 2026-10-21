# OpenQuant Open-Source Project Organisation

**Version:** 1.0  
**Status:** Project organisation specification  
**Working project name:** OpenQuant  
**Companion specifications:** AI-Native Quant Trading Platform — Design Specification v1; AI-Native Quant Fund — Ink UX/UI Specification v1.1; AI-Native Quant Fund — Tech Stack Specification v1

---

## 0. Project Name

`OpenQuant` is a strong working name: short, understandable, open-source, and clearly related to quantitative finance.

It should be treated as a working identity until the project completes a formal naming and availability review before public launch.

The final name should communicate OpenQuant's defining idea:

> AI agents generate strategies, independent agents attack them, evidence decides what advances, and governed strategies earn capital progressively.

Potential alternatives:

### ProofQuant

Emphasises the project's strongest principle:

> evidence before capital.

It fits strategy validation, adversarial testing, reproducibility, promotion gates, and open-source transparency.

### QuantGauntlet

Emphasises strategies surviving increasingly difficult evaluation stages. More distinctive, but less institutional in tone.

### Strategy Foundry

Emphasises continuous strategy creation, testing, mutation, and retirement. Strong for the research layer, but underrepresents portfolio and risk operation.

### OpenFund

Simple and serious, but broader than the project's quantitative and agentic identity.

### Working recommendation

Use **OpenQuant** during development.

Before the first coordinated public launch, check:

- GitHub organisation and repository availability;
- package registries;
- domains;
- major social handles;
- existing financial products;
- existing open-source projects;
- relevant trademarks.

If a rename is required, **ProofQuant** best reflects the system's core philosophy.

The remainder of this specification uses **OpenQuant**.

---

# 1. Purpose

OpenQuant should be organised as one open-source product with several public surfaces, each serving a distinct part of the user journey.

The repository remains the source of truth.

The website, documentation, Academy, Strategy Library, benchmarks, examples, case studies, blog, and integration catalogue should build on repository knowledge rather than become independent content silos.

The overall journey is:

> **Discover → Understand → Run → Research → Test → Compare → Learn → Extend → Contribute**

The open-source project should make the complete system understandable before a user enables real-money trading.

The public product should make clear that OpenQuant is not:

- an AI stock picker;
- a prompt-to-trade bot;
- a strategy marketplace promising returns;
- a leaderboard that rewards reckless risk;
- a black-box autonomous fund.

It is:

> **an open operating system for AI-native quantitative research, adversarial strategy evaluation, paper competition, governed capital allocation, and controlled trading.**

---

# 2. Project Surfaces

| Surface | Primary purpose | User question |
|---|---|---|
| README | Acquisition and first successful run | What is OpenQuant, and can I run it? |
| Docs | Product behaviour and reference | How does OpenQuant work? |
| Academy | Quant + OpenQuant proficiency | How do I use the system well? |
| Examples | Executable workflows | What does this look like in practice? |
| Strategy Library | Reusable Strategy Definitions | What strategies can I inspect, test, or extend? |
| Arena / Benchmarks | Reproducible evaluation | How well does the system actually evaluate strategies? |
| Case Studies | Complete evidence-backed journeys | What happens across a full strategy lifecycle? |
| Integrations | Ecosystem and customisation | Which data, brokers, models, and tools can I connect? |
| Blog | Current thinking and discovery | What is happening in AI-native quant engineering? |
| Website | Main public entry point | Why should I care about OpenQuant? |
| GitHub Discussions | Community knowledge and collaboration | Where do I ask, debate, and share work? |

Each surface has one primary responsibility.

Avoid reproducing the same material independently across multiple locations.

---

## 2.1 Product-Driven Publishing

Public project material should evolve with the software.

Documentation, examples, benchmark results, Academy material, and demonstrations are not a separate marketing backlog completed after engineering.

When a capability becomes usable, publish the smallest useful set of material required for someone to:

```text
discover it
↓
understand it
↓
run it
↓
verify it
↓
learn it deeply when needed
```

The operating loop is:

```text
product intent
↓
specification
↓
implementation
↓
tests / evaluation
↓
public artefact
↓
publication where useful
↓
user / production feedback
↓
future product intent
```

A capability is not genuinely open merely because its source code exists. It should also have enough public context to be understood, exercised, evaluated, and extended safely.

---

## 2.2 Evidence-Ready Publishing

OpenQuant makes claims about strategies, backtests, robustness, paper performance, execution, risk, and portfolio behaviour.

Those claims require stronger publication discipline than ordinary product marketing.

Public performance material must be traceable to evidence.

| Claim | Minimum public grounding |
|---|---|
| Feature exists | accepted implementation + tests |
| Strategy can execute | Strategy Definition + reproducible example |
| Backtest result | engine version + dataset identity + cost model + configuration |
| Robustness claim | declared robustness suite + results |
| Paper-trading claim | immutable paper run + timestamps + simulator version |
| Live execution claim | real execution record + mode clearly labelled |
| Performance comparison | same benchmark/cohort + disclosed assumptions |
| Risk claim | defined metric/policy + reproducible calculation |
| Production reliability | operational evidence, not design intent |

Never promote claims such as:

```text
profitable
market-beating
robust
safe
production-ready
```

solely because a favourable backtest exists.

Every public result must identify its mode:

```text
BACKTEST
PAPER
SHADOW
MICRO-CAPITAL
LIVE
```

A reader must never need to infer whether money was actually at risk.

---

## 2.3 Progressive Public Product

The public project should grow alongside implementation.

| Capability milestone | Public surfaces that should advance |
|---|---|
| TUI shell | README concept/demo, Getting Started docs, terminal demo |
| Strategy Definition | authoring docs, first Strategy Library entries, example |
| Foundry | Research Mission guide, Foundry example, Academy research lesson |
| Rust Arena | evaluation docs, benchmark pack, reproducible benchmark results |
| Robustness | validation methodology, failed-strategy example, Academy evaluation lesson |
| Paper trading | paper guide, public paper example, Arena results |
| Shadow fund | portfolio/risk docs, complete shadow case study |
| Micro-capital | live-safety docs, broker guide, explicit risk disclosures |
| Production fund | operations/reconciliation material and real case study where appropriate |
| Ecosystem maturity | integration catalogue, contributor guides, external Strategy Definitions |
| Hardened project | public audit, reproducibility report, OpenQuant-building-OpenQuant case study |

This is a progression target, not a requirement to update every surface on every release.

The rule is:

> Update the smallest set of public surfaces necessary to make a capability discoverable, understandable, reproducible, and safe to use.

---

# 3. Repository Structure

Start with one monorepo.

```text
openquant/
├── README.md
├── LICENSE
├── CONTRIBUTING.md
├── CODE_OF_CONDUCT.md
├── SECURITY.md
├── GOVERNANCE.md
├── CHANGELOG.md
│
├── apps/
│   ├── cli/
│   └── api/
│
├── packages/
│   ├── domain/
│   ├── api-client/
│   ├── realtime-client/
│   ├── contracts/
│   ├── strategy-contract/
│   └── mocks/
│
├── rust/
│   ├── crates/
│   └── services/
│
├── protocol/
│
├── specs/
│   ├── design/
│   ├── ux/
│   └── engineering/
│
├── docs/
│   ├── getting-started/
│   ├── concepts/
│   ├── guides/
│   ├── reference/
│   ├── architecture/
│   ├── evaluation/
│   ├── risk/
│   └── operations/
│
├── academy/
│   ├── foundations/
│   ├── research/
│   ├── evaluation/
│   ├── portfolio/
│   ├── operations/
│   ├── advanced/
│   └── projects/
│
├── strategies/
│   ├── official/
│   ├── educational/
│   └── registry/
│
├── benchmarks/
│   ├── suites/
│   ├── fixtures/
│   ├── baselines/
│   └── results/
│
├── examples/
│   ├── first-strategy/
│   ├── research-mission/
│   ├── adversarial-review/
│   ├── walk-forward/
│   ├── paper-arena/
│   ├── portfolio-allocation/
│   ├── custom-data-adapter/
│   └── ...
│
├── integrations/
│   ├── data/
│   ├── brokers/
│   ├── llm/
│   └── registry/
│
├── website/
│   ├── content/
│   │   ├── blog/
│   │   ├── case-studies/
│   │   └── releases/
│   └── ...
│
├── infra/
│
└── .github/
    ├── ISSUE_TEMPLATE/
    ├── workflows/
    ├── CODEOWNERS
    └── ...
```

The exact directory names may evolve.

The important rules are:

1. The repository remains canonical.
2. Public documentation is version-controlled.
3. Strategy Definitions are version-controlled.
4. Benchmark configurations and baseline results are version-controlled.
5. Website content reuses repository sources where practical.
6. Large licensed market datasets do not need to live in Git.
7. Large generated artefacts may live externally, but their manifests and provenance remain in the repository.

---

# 4. README.md

The README is a primary acquisition and onboarding surface.

Its journey should be:

> **Understand → Believe → Run → See Evidence → Explore**

It should not become the complete documentation, methodology guide, architecture specification, or quant course.

## 4.1 Hero

Start with one concise statement.

For example:

> **OpenQuant is an open-source AI-native quant fund where agents create strategies, critics try to break them, and evidence decides what earns capital.**

Immediately show the operating loop:

```text
Research
↓
Strategy
↓
Attack
↓
Backtest
↓
Robustness
↓
Paper Arena
↓
Shadow
↓
Capital
↓
Monitor / Demote / Mutate
```

Then establish the safety boundary:

> OpenQuant runs paper-first. Real-money execution is a separately enabled, governed capability.

## 4.2 Why OpenQuant Exists

Explain the problem briefly.

AI can generate trading ideas and code quickly. That does not mean those ideas are valid.

Typical failures include:

- backtest overfitting;
- data leakage;
- unrealistic execution;
- hidden transaction costs;
- strategy duplication;
- excessive correlation;
- regime fragility;
- reward hacking;
- uncontrolled live execution.

OpenQuant turns strategy development into an explicit evidence and governance system.

## 4.3 Show Before Explaining

Demonstrate one small end-to-end workflow before installation detail.

```text
Research Mission
"Find a liquid short-horizon diversifier"
        ↓
8 hypotheses
        ↓
3 Strategy Definitions
        ↓
independent critic review
        ↓
2 rejected
        ↓
1 robustness candidate
        ↓
paper Arena
```

A reader should understand the product before installing it.

## 4.4 Quick Start

The Quick Start should produce a meaningful **paper-only** result with minimal setup.

Target:

```text
clone
↓
install
↓
run OpenQuant
↓
load bundled fixture dataset
↓
run one bundled Strategy Definition
↓
inspect evidence
```

The first successful experience must not require:

- brokerage credentials;
- live market data;
- paid LLM APIs where avoidable;
- cloud infrastructure;
- production configuration.

Provide a deterministic offline/fixture path where practical.

## 4.5 Core Concepts

Introduce briefly:

- Research Mission;
- Foundry;
- Hypothesis;
- Strategy Definition;
- Strategy Contract;
- Critic;
- Experiment;
- Evidence Bundle;
- Arena;
- Lifecycle Gates;
- Capital Mandate;
- Strategy Graph;
- Risk Governor;
- Trading Core.

Each concept links to deeper documentation.

## 4.6 Evidence Model

Establish early that OpenQuant does not equate a high backtest return with a good strategy.

```text
Hypothesis
<
Backtest
<
Walk-forward / robustness
<
Paper
<
Shadow
<
Micro-capital
<
Production
```

Every stage can promote, demote, pause, mutate, or retire a strategy.

## 4.7 Learn OpenQuant

Use progressive learning paths.

### 10-minute introduction

Run and inspect one strategy.

### 30-minute workflow

Take a bundled hypothesis through evaluation and paper competition.

### 2-hour project

Create a Strategy Definition, run critic/evaluation workflows, and compare against a baseline.

### Academy

Learn quantitative research, robust backtesting, agentic research, portfolio construction, risk, execution, and extension development.

## 4.8 Examples

Surface realistic examples directly:

- first Strategy Definition;
- momentum strategy that fails robustness;
- mean-reversion strategy through walk-forward validation;
- adversarial critic review;
- paper Arena competition;
- strategy mutation;
- low-correlation portfolio addition;
- custom data adapter;
- custom LLM provider;
- custom evaluation metric.

Failures should be represented alongside successes.

## 4.9 Public Safety Boundary

The README should state concisely that:

- the project is research/trading infrastructure, not investment advice;
- bundled strategies are examples, not recommendations;
- backtests are not live returns;
- real-money trading is disabled by default;
- users are responsible for data, broker, legal, regulatory, and tax obligations;
- credentials must never be committed.

## 4.10 Community

End with routes to:

- Docs;
- Academy;
- Strategy Library;
- Benchmarks;
- examples;
- GitHub Discussions;
- contribution guide;
- integrations;
- roadmap;
- website.

---

# 5. Website

The website is broader and more visual than the README.

The README primarily answers:

> How can I understand and run OpenQuant?

The website primarily answers:

> Why does an evidence-driven AI-native quant platform matter?

Suggested navigation:

```text
Product
Arena
Strategies
Docs
Academy
Benchmarks
Case Studies
Blog
GitHub
```

`Arena` and `Benchmarks` should be prominent because transparent evaluation is a defining part of the project.

---

# 6. Homepage

The homepage is primarily a product and credibility surface.

Recommended structure:

```text
Hero
↓
The problem with AI-generated trading strategies
↓
How OpenQuant works
↓
Research → Arena → Capital lifecycle
↓
Terminal demo
↓
Evidence, not leaderboard P&L
↓
Strategy Definition
↓
Adversarial agents
↓
Rust evaluation engine
↓
Portfolio + risk governance
↓
Public Arena / benchmark evidence
↓
Examples / case study
↓
Open-source call to action
```

The homepage should communicate:

- why the system exists;
- what makes it different;
- that it is open-source;
- that evaluation is reproducible;
- that real money is governed and optional.

Do not lead with hypothetical returns, "beat the market", or sensational AI-trading claims.

---

# 7. Arena Public Surface

The public Arena is a distinctive OpenQuant surface.

Its purpose is to make strategy evaluation inspectable.

It may expose:

```text
Strategy
Lifecycle stage
Cohort
Evidence gates
Evaluation status
Risk metrics
Robustness metrics
Paper performance
Experiment count
Engine version
Dataset manifest
```

Public presentation should default to comparable cohorts rather than one universal ranking.

Examples:

```text
US Equity / Daily
US Equity / Intraday
ETF / Mean Reversion
FX / Intraday
Synthetic Benchmark
```

## 7.1 Arena Result Labels

Always display mode:

```text
BACKTEST
PAPER
SHADOW
LIVE
```

Never visually combine them into one continuous return series without clear segmentation.

## 7.2 Arena Reproducibility

A public benchmark run should resolve to:

```text
Strategy Definition
+
engine version
+
dataset manifest
+
cost model
+
evaluation configuration
+
seed where applicable
=
result
```

Where data licensing prevents redistribution, publish enough metadata and instructions for appropriately licensed users to reproduce the run.

## 7.3 Public Leaderboards

Avoid a permanent "highest return wins" leaderboard.

Useful rankings include:

- evidence readiness;
- robustness;
- downside-adjusted performance;
- portfolio contribution;
- execution quality;
- reproducibility.

Any composite score must disclose its components.

---

# 8. Documentation

Documentation is product-centred.

Recommended structure:

```text
Docs

Getting Started
  Installation
  First run
  First strategy
  First evaluation
  Paper-only setup

Concepts
  Research Mission
  Foundry
  Strategy Definition
  Strategy Contract
  Experiments
  Evidence Bundles
  Arena
  Strategy Graph
  Promotion
  Capital Mandates
  Risk
  Trading Core

Guides
  Create a Research Mission
  Author a Strategy Definition
  Run a backtest
  Run walk-forward validation
  Run robustness tests
  Start paper trading
  Compare strategies
  Build a portfolio
  Add a dataset
  Add an LLM provider
  Add a broker
  Configure live trading

Evaluation
  Point-in-time data
  Transaction costs
  Slippage
  Walk-forward
  Parameter sensitivity
  Monte Carlo
  Multiple testing
  Trial accounting
  Benchmark methodology

Risk
  Strategy limits
  Portfolio limits
  Hard risk engine
  Halt behaviour
  Live safety model

Operations
  Workflows
  Evaluation jobs
  Reconciliation
  Audit
  Observability
  Recovery

Reference
  CLI
  Configuration
  Strategy Definition schema
  API
  Protocol schemas
  Environment variables
  Exit codes

Architecture
  System architecture
  TypeScript control plane
  Rust quant plane
  Data architecture
  Trading Core
  Security model
```

Documentation defines product behaviour.

Methodology belongs primarily in the Academy.

---

# 9. Academy

The Academy should be user-centred rather than feature-centred.

Its purpose is to improve proficiency in quantitative research, experimental discipline, AI-agent research, robustness, portfolio reasoning, risk, and OpenQuant operation.

Recommended curriculum:

```text
Academy

1. Foundations
   What quantitative trading is
   Hypotheses and falsification
   Sources of apparent alpha
   Risk-adjusted thinking
   Research vs execution

2. Strategy Research
   Turning observations into hypotheses
   Economic rationale
   Signals
   Position sizing
   Exit logic
   Strategy invalidation
   Strategy Definitions

3. Backtesting Correctly
   Point-in-time data
   Look-ahead bias
   Survivorship bias
   Trading costs
   Slippage
   Capacity
   Benchmark selection

4. Robust Evaluation
   In-sample vs out-of-sample
   Walk-forward testing
   Parameter sensitivity
   Monte Carlo
   Regime analysis
   Multiple testing
   Backtest overfitting
   Trial accounting

5. AI-Native Research
   Research agents
   Strategy agents
   Critic agents
   Agent calibration
   Adversarial workflows
   Confidence scoring
   Preventing reward hacking

6. Arena
   Cohorts
   Evidence gates
   Comparisons
   Paper trading
   Shadow trading
   Promotion and demotion

7. Portfolio
   Correlation
   Diversification
   Marginal contribution
   Capital allocation
   Capacity
   Strategy decay

8. Risk and Execution
   Hard risk limits
   Market state
   Orders and fills
   Reconciliation
   Kill switches
   Paper vs live semantics

9. Operating OpenQuant
   Daily monitoring
   Weekly Arena review
   Incidents
   Audit
   Strategy retirement
   Production feedback

10. Extending OpenQuant
    Data adapters
    Broker adapters
    LLM providers
    Evaluation suites
    Strategy primitives
    Custom metrics

11. Projects
    Build a strategy from a hypothesis
    Debunk an overfit strategy
    Run a multi-strategy paper fund
    Add a market-data adapter
    Build an evaluation suite
```

The Academy teaches judgement and methodology, not merely commands.

---

# 10. Examples

Examples are first-class project assets.

Avoid limiting them to toy code snippets.

```text
examples/
├── first-strategy/
├── research-mission/
├── strategy-definition/
├── adversarial-review/
├── overfit-strategy/
├── walk-forward/
├── cost-stress/
├── parameter-sensitivity/
├── paper-arena/
├── strategy-mutation/
├── portfolio-diversifier/
├── custom-data-adapter/
├── custom-llm-provider/
└── custom-evaluation-suite/
```

A good example should be reusable:

```text
Executable Example
      │
      ├── README walkthrough
      ├── Docs guide
      ├── Academy exercise
      ├── Benchmark fixture
      ├── Demo
      └── Case study component
```

---

# 11. Strategy Library

OpenQuant should have a first-class Strategy Library.

Its purpose is not to distribute "winning trades". It provides inspectable, reusable Strategy Definitions.

Suggested structure:

```text
strategies/
├── official/
│   ├── buy-and-hold-baseline/
│   ├── moving-average/
│   ├── cross-sectional-momentum/
│   ├── mean-reversion/
│   └── ...
│
├── educational/
│   ├── look-ahead-bias-demo/
│   ├── overfitting-demo/
│   ├── transaction-cost-demo/
│   └── ...
│
└── registry/
```

Each strategy should include:

```text
name
purpose
hypothesis
Strategy Definition
asset/universe requirements
data requirements
expected horizon
known assumptions
known failure modes
evaluation instructions
licence
author
```

Optional:

```text
official benchmark results
paper-run references
```

## 11.1 Strategy Publication Policy

A strategy is not accepted into the official library because it has high returns.

Official strategies are selected for:

- educational value;
- benchmark value;
- methodological usefulness;
- demonstration of an OpenQuant capability;
- broad reproducibility;
- useful baseline behaviour.

The repository should intentionally include strategies that fail.

Examples:

```text
overfit strategy
cost-sensitive strategy
regime-fragile strategy
highly correlated strategy
```

These are valuable test fixtures.

## 11.2 Community Strategies

Community Strategy Definitions may remain in external repositories.

The registry needs only enough metadata to discover, inspect, install, evaluate, and attribute them.

```yaml
name:
description:
author:
version:
repository:
openquantCompatibility:
strategyDefinition:
dataRequirements:
assetClasses:
licence:
```

Do not create a complex strategy marketplace initially.

---

# 12. Benchmarks

Benchmarks are a core credibility surface.

They test both strategies **and OpenQuant itself**.

Benchmark categories:

```text
Engine correctness
Simulation correctness
Evaluation methodology
Strategy robustness
Performance regression
Cross-version reproducibility
Portfolio calculations
Risk invariants
```

## 12.1 Benchmark Packs

Example:

```text
benchmarks/suites/us-equity-daily-v1/
├── manifest.yaml
├── strategies/
├── evaluation.yaml
├── expected/
└── README.md
```

The manifest defines:

- dataset;
- universe;
- period;
- cost assumptions;
- benchmark strategies;
- evaluation suite;
- expected invariants.

## 12.2 Baselines

Maintain intentionally simple baselines:

- cash;
- buy-and-hold;
- random entry;
- simple momentum;
- simple mean reversion;
- naive equal-weight portfolio.

Complex agent-generated strategies should have to beat useful baselines after costs and risk, not merely produce a positive return.

## 12.3 Benchmark Results

Version official results with:

```text
OpenQuant version
Quant engine version
Benchmark suite version
Dataset manifest
Run date
Environment
Results
```

A release that materially changes evaluation output should rerun relevant benchmark packs.

---

# 13. Case Studies

Case studies demonstrate complete journeys rather than isolated features.

They should include successes, failures, and ambiguous results.

## 13.1 From Mission to Paper Arena

```text
Research Mission
↓
Hypotheses
↓
Critic review
↓
Strategy Definitions
↓
Backtests
↓
Robustness
↓
Paper Arena
↓
Promotion decision
```

## 13.2 The Strategy That Looked Excellent and Failed

```text
strong backtest
↓
large search history
↓
walk-forward degradation
↓
cost sensitivity
↓
critic finding
↓
rejection
```

This should be a flagship case study because it demonstrates why OpenQuant exists.

## 13.3 Portfolio Diversifier

Show why:

```text
lower standalone return
+
low correlation
+
good robustness
=
higher portfolio value
```

## 13.4 Paper to Shadow

Show how live market conditions can change confidence without risking money.

## 13.5 Micro-Capital Promotion

Publish only after a genuine controlled live process exists.

Show evidence, mandate, hard risk limits, expected vs realised execution, incidents where relevant, and subsequent capital decisions.

Do not turn the case study into a profit advertisement.

## 13.6 OpenQuant Building OpenQuant

Use the project's own benchmark and operating history as a continuing dogfooding case study.

Examples:

- an agent-created reference strategy;
- a critic catching a bad strategy;
- a quant-engine regression detected by benchmarks;
- a public benchmark improving after an evaluation fix.

---

# 14. Integrations

OpenQuant should initially provide an integration registry, not a marketplace.

Categories:

```text
Market Data
Brokers
LLM Providers
Storage
Observability
Research Sources
```

Third-party integrations may live in independent repositories.

Official integrations may live in the OpenQuant organisation or monorepo depending on coupling.

## 14.1 Integration Manifest

```yaml
name:
category:
description:
author:
version:
repository:
openquantCompatibility:
capabilities:
configuration:
licence:
status:
```

Statuses:

```text
OFFICIAL
COMMUNITY
EXPERIMENTAL
DEPRECATED
```

## 14.2 Data Integrations

Document:

- supported instruments;
- frequencies;
- historical/live capabilities;
- point-in-time characteristics;
- corporate actions where relevant;
- licensing restrictions;
- expected costs;
- rate limits;
- redistribution restrictions.

An open-source connector does not make proprietary data open.

## 14.3 Broker Integrations

Document:

- paper support;
- live support;
- asset classes;
- order types;
- authentication;
- reconciliation behaviour;
- known limitations;
- supported OpenQuant versions.

Real-money broker adapters require a higher review standard than ordinary integrations.

---

# 15. Blog

The blog should not be limited to release announcements.

It should establish OpenQuant within quantitative engineering, agentic AI, reproducible research, and trading-system engineering.

## OpenQuant

Topics:

- releases;
- capabilities;
- architecture decisions;
- benchmark changes;
- design changes;
- project updates;
- integrations.

## AI + Quant

Topics:

- agentic strategy research;
- AI-generated strategies;
- critic agents;
- multi-agent evaluation;
- LLMs in quant research;
- game theory for agent incentives;
- AI failure modes;
- model calibration.

## Quant Engineering

Topics:

- backtest architecture;
- point-in-time data;
- Rust for simulation;
- execution modelling;
- reproducibility;
- risk engines;
- reconciliation;
- event-driven trading systems.

## Research Practice

Topics:

- overfitting;
- walk-forward validation;
- transaction costs;
- multiple testing;
- regime analysis;
- portfolio contribution;
- strategy decay.

## Building in Public

Topics:

- failed experiments;
- benchmark regressions;
- design trade-offs;
- what agents got wrong;
- why strategies were retired;
- operating lessons.

The blog should attract people interested in quant engineering before they know OpenQuant exists.

---

# 16. Content Ownership

Each information type should have one canonical home.

| Information | Canonical location |
|---|---|
| What OpenQuant is | README / website |
| Installation | Docs |
| Product concepts | Docs |
| CLI behaviour | Reference |
| Strategy Definition schema | Reference / specification |
| Architecture | Engineering specs / architecture docs |
| Quant methodology | Academy |
| Executable workflows | Examples |
| Reusable Strategy Definitions | Strategy Library |
| Evaluation standards | Evaluation docs / benchmark suites |
| Official reproducible results | Benchmarks |
| Complete journeys | Case Studies |
| Current thinking | Blog |
| Integration metadata | Integration registry |
| Project governance | GOVERNANCE.md / CONTRIBUTING.md |
| Security reporting | SECURITY.md |

Product behaviour must not be defined accidentally by a blog post, Academy lesson, case study, or strategy example.

If a concept becomes OpenQuant behaviour, represent it in the appropriate product specification and documentation.

---

# 17. Content Reuse

Avoid writing equivalent material independently for every surface.

```text
Canonical strategy example
      │
      ├── README excerpt
      ├── Docs walkthrough
      ├── Academy exercise
      ├── Benchmark fixture
      ├── Website demo
      └── Case study
```

```text
Benchmark result
      │
      ├── Arena page
      ├── Release notes
      ├── Case study evidence
      └── Blog analysis
```

```text
Integration manifest
      │
      ├── Docs catalogue
      ├── Website catalogue
      └── CLI discovery
```

```text
Engineering specification
      │
      ├── implementation
      ├── architecture docs
      └── reference material
```

The website should be primarily a presentation layer over repository knowledge.

---

# 18. Data Publication Policy

Quant projects have special data constraints.

Distinguish:

```text
open data
redistributable data
user-supplied data
commercial/licensed data
generated fixtures
```

Official examples and automated tests should prefer synthetic data, freely redistributable data, and compact checked-in fixtures.

A benchmark may rely on external licensed data, but its manifest must make reproduction requirements explicit.

Never commit data in violation of provider terms.

## 18.1 Dataset Manifests

Official dataset references should support metadata such as:

```yaml
id:
provider:
licence:
assetClass:
universe:
frequency:
start:
end:
pointInTime:
corporateActions:
contentHash:
sourceInstructions:
```

The manifest is version-controlled even when the dataset is not.

---

# 19. Public Performance Policy

Every performance presentation should identify:

```text
mode
period
capital basis
fees
transaction-cost assumptions
slippage assumptions
benchmark
strategy version
engine version
data/dataset identity
```

Where relevant also disclose:

```text
number of trials
parameter search
holdout methodology
confidence / uncertainty
```

Avoid screenshots of isolated equity curves without provenance.

Prefer reproducible result pages.

## 19.1 Backtest

Must be labelled:

```text
BACKTEST
```

Never describe a backtest as a track record.

## 19.2 Paper

Must be labelled:

```text
PAPER
```

Distinguish simulated fills from broker/live fills.

## 19.3 Shadow

Must be labelled:

```text
SHADOW
```

Clarify that orders were observed but not submitted.

## 19.4 Live

Use:

```text
LIVE
```

only for genuine broker-executed capital.

Live results should not be selectively published only when successful.

---

# 20. Community Organisation

Use GitHub as the primary collaboration surface.

## 20.1 Issues

Issues are for concrete work:

- bugs;
- feature requests;
- documentation defects;
- benchmark regressions;
- integration problems;
- reproducibility failures.

Issue templates should request useful evidence.

Example bug fields:

```text
OpenQuant version
environment
strategy/evaluation ID
reproduction steps
expected result
actual result
logs/reference
```

## 20.2 Discussions

Suggested categories:

```text
Announcements
Help
Research Ideas
Strategy Design
Evaluation
Benchmarks
Integrations
Architecture
Show and Tell
General
```

Do not let Discussions become:

- stock-tip channels;
- signal-selling;
- copy-trading promotion;
- investment solicitation.

## 20.3 RFCs

Material architecture or methodology changes should use lightweight RFCs.

Examples:

- changing Strategy Definition semantics;
- adding an official evaluation methodology;
- changing paper-fill semantics;
- introducing a new live broker;
- altering public benchmark scoring;
- changing capital/risk architecture.

RFCs should state:

```text
problem
proposal
alternatives
compatibility
risks
migration
decision
```

---

# 21. Contribution Model

`CONTRIBUTING.md` should define contribution types clearly:

```text
Code
Strategy Definitions
Benchmarks
Documentation
Academy
Examples
Integrations
Research methodology
Bug reports
Reproducibility reports
```

Different artefacts require different acceptance criteria.

## 21.1 Code Contributions

Require:

- tests;
- lint/type/static-analysis checks;
- no unexplained dependency growth;
- architecture-boundary compliance;
- benchmark checks where relevant.

## 21.2 Strategy Contributions

Require:

- hypothesis;
- Strategy Definition;
- data requirements;
- known assumptions;
- evaluation configuration;
- no unsupported profitability claim;
- licence compatibility.

Strategies do not need to be profitable to be valuable contributions.

## 21.3 Benchmark Contributions

Require:

- stated purpose;
- reproducible configuration;
- deterministic fixture or dataset manifest;
- expected invariants;
- no benchmark designed solely to favour one strategy.

## 21.4 Integration Contributions

Require:

- supported capabilities;
- failure semantics;
- configuration docs;
- tests or fixtures;
- licence;
- security review for broker/live integrations.

---

# 22. Governance

Start lightweight.

```text
Maintainer
↓
Core contributors
↓
Contributors
↓
Community
```

Do not create committees before the project needs them.

`GOVERNANCE.md` should define:

- maintainer responsibilities;
- decision process;
- release authority;
- security decisions;
- dispute resolution;
- how maintainers are added or removed;
- RFC acceptance.

High-risk areas receive stricter review authority:

```text
risk engine
broker execution
credential handling
public performance methodology
Strategy Definition execution sandbox
```

---

# 23. Security

`SECURITY.md` is mandatory before live trading support is public.

It should define private disclosure for:

- broker credential exposure;
- order/risk bypass;
- authentication bypass;
- remote code execution;
- strategy sandbox escape;
- sensitive data exposure;
- dependency compromise.

Do not require researchers to open public issues for exploitable live-trading vulnerabilities.

---

# 24. Releases

Use conventional versioned releases.

Release notes should separate:

```text
Product
Quant Engine
Strategy Definition
Evaluation
Risk
Integrations
Breaking Changes
Migration
Known Issues
```

Where evaluation semantics change materially:

- rerun affected official benchmarks;
- publish changed results;
- explain why results changed.

A quant-engine change that alters backtests is not merely an implementation detail.

---

# 25. User Journey

The ecosystem should support:

```text
GitHub / Search / Article / Recommendation
                  │
                  ▼
          Website or README
                  │
                  ▼
            Understand OpenQuant
                  │
                  ▼
              Quick Start
                  │
                  ▼
        First reproducible strategy
                  │
                  ▼
          Examples / Strategy Library
                  │
                  ▼
              Arena / Benchmarks
                  │
                  ▼
                Academy
                  │
                  ▼
        Build own strategy / integration
                  │
                  ▼
          Run persistent paper fund
                  │
                  ▼
        Advanced governed operation
                  │
                  ▼
              Contribute
```

Real-money trading is not a required step in the community journey.

A user can receive substantial value from research, evaluation, paper trading, methodology, and infrastructure alone.

---

# 26. Core Principles

## Repository as Source of Truth

Product knowledge, Strategy Definitions, benchmark manifests, examples, educational material, and ecosystem metadata are version-controlled wherever practical.

## Evidence Before Claims

Public credibility should come from reproducibility and transparent evaluation, not favourable return screenshots.

## Paper First

The default public experience is useful without broker credentials or real capital.

## Progressive Disclosure

```text
Homepage
→ README
→ Quick Start
→ Examples
→ Arena / Strategy Library
→ Docs
→ Academy
→ Engineering specifications
```

## Show Real Work

Prefer complete workflows, rejected hypotheses, failed strategies, benchmark regressions, and operational lessons over polished toy demonstrations.

## Separate Product from Methodology

Documentation explains OpenQuant.

The Academy teaches how to perform AI-native quantitative research and operate OpenQuant well.

## Separate Research from Recommendation

A public Strategy Definition is an inspectable research artefact, not an endorsement to trade it.

## Reuse Content

Strategies, benchmarks, examples, specifications, and integration manifests should feed multiple surfaces.

## Reproducibility Is Product

Benchmark manifests, engine versions, strategy hashes, data lineage, and evaluation configuration are user-facing product assets, not internal metadata.

## Failures Are Valuable

A strategy that fails robustness may be a stronger educational and benchmark asset than a strategy with a high backtest return.

## Dogfood OpenQuant

Use OpenQuant to evaluate its own reference strategies, Arena behaviour, risk logic, strategy mutations, benchmark regressions, and operational workflows.

The project should gradually become one of its own strongest case studies.

---

# 27. Recommended Initial Public Scope

Do not build the whole ecosystem infrastructure at once.

Start with:

```text
Repository
├── README
├── Source
├── Specs
├── Docs
├── Examples
├── Strategy Library
├── Benchmark suites
├── Academy foundations
└── Website
    ├── Homepage
    ├── Docs
    ├── Strategies
    ├── Benchmarks
    └── Blog
```

Initial GitHub community:

```text
Issues
Discussions
CONTRIBUTING
SECURITY
GOVERNANCE
```

Keep content Markdown-first where practical.

Do not initially build:

- a learning-management system;
- a strategy marketplace;
- paid signal infrastructure;
- social trading;
- copy trading;
- a large extension marketplace;
- a custom documentation CMS;
- a proprietary benchmark portal disconnected from Git.

The goal is to help someone:

> **discover OpenQuant, understand it, reproduce its claims, learn sound AI-native quant practice, extend the system, and contribute back.**

---

# 28. Initial Content Set

A first public release should communicate the philosophy without pretending the complete fund already exists.

## README

- product thesis;
- lifecycle diagram;
- deterministic Quick Start;
- paper-first boundary;
- core concepts;
- links.

## Docs

- installation;
- first strategy;
- Strategy Definition;
- first evaluation;
- architecture overview.

## Strategy Library

At least:

```text
buy-and-hold baseline
simple momentum
simple mean reversion
deliberately overfit strategy
```

## Benchmarks

At least:

```text
simulation-correctness
cost-model
walk-forward
overfitting-demo
```

## Examples

At least:

```text
first-strategy
adversarial-review
walk-forward
paper-arena
```

## Academy

At least:

```text
quant research foundations
backtest failure modes
evidence ladder
OpenQuant operating loop
```

## Website

At least:

```text
homepage
docs
strategies
benchmarks
blog
```

---

# 29. Public Milestone Plan

## Milestone A — Understand

Outcome:

```text
A newcomer understands the product without installing it.
```

Ship README, homepage, architecture illustration, and lifecycle explanation.

## Milestone B — Reproduce

Outcome:

```text
A newcomer can reproduce one bundled evaluation locally.
```

Ship Quick Start, fixture data, reference Strategy Definition, and benchmark result.

## Milestone C — Research

Outcome:

```text
A user can create a Research Mission and inspect generated hypotheses.
```

Ship Foundry docs, example mission, and Academy research lesson.

## Milestone D — Challenge

Outcome:

```text
A user can watch a strategy survive or fail adversarial evaluation.
```

Ship critic docs, robustness benchmark, and failed-strategy case study.

## Milestone E — Compete

Outcome:

```text
Several strategies can run in a reproducible paper Arena.
```

Ship Arena surface, comparison guide, paper benchmark, and public paper-result format.

## Milestone F — Portfolio

Outcome:

```text
OpenQuant evaluates strategies by portfolio contribution, not isolated return.
```

Ship portfolio docs, diversification example, and allocation case study.

## Milestone G — Shadow

Outcome:

```text
The project can observe intended trading against live market conditions without sending orders.
```

Ship shadow guide, execution-comparison example, and operations material.

## Milestone H — Governed Live Trading

Outcome:

```text
Real capital can be enabled through explicit mandates and deterministic risk controls.
```

Ship before or alongside it:

- mature SECURITY.md;
- broker integration docs;
- risk architecture docs;
- reconciliation docs;
- emergency-control docs;
- high-risk contribution policy.

Do not make this the first public milestone.

---

# 30. Success Criteria

The open-source organisation is working when:

1. The repository is clearly canonical.
2. A newcomer can understand the project before installing it.
3. A first useful paper/evaluation workflow requires no broker account.
4. Performance claims resolve to reproducible evidence.
5. Strategies and benchmark results expose versions and assumptions.
6. Failed strategies are represented publicly rather than hidden.
7. Documentation and Academy have distinct responsibilities.
8. Strategy Definitions can be reused without duplicating tutorials.
9. Benchmark packs can detect evaluation-engine regressions.
10. Public Arena results distinguish backtest, paper, shadow, and live modes.
11. Community contribution does not become a stock-tip forum.
12. Licensed data is not accidentally redistributed.
13. Broker/live-trading contributions receive stronger review.
14. The website reuses repository knowledge rather than becoming a parallel source of truth.
15. The project can grow from paper research to governed live execution without reorganising its public identity.
16. OpenQuant itself becomes a credible long-running case study of evidence-driven AI-native quantitative research.

---

# 31. Governing Principle

> **Open the code, open the methodology, open the evidence — not the risk controls.**

OpenQuant should make AI-native quantitative research easier to inspect, reproduce, challenge, and extend while keeping the boundary between experimentation and real capital explicit.

---

**OpenQuant Open-Source Project Organisation v1**

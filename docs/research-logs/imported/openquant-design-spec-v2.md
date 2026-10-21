# OpenQuant — Design Specification

**Version:** 2.0  
**Date:** 7 October 2026  
**Status:** Proposed design baseline; implementation not verified  
**Project:** OpenQuant (`openquant`)

## 1. Purpose and scope

OpenQuant is an open-source platform that uses AI agents to develop trading strategies. Strategies compete through controlled evaluation and live paper trading. Selected strategies can receive real capital under explicit mandates and independent risk controls.

The objective remains portfolio-level return after costs, subject to risk limits. The platform must also reject weak strategies, retain failed experiments, and learn from operating evidence. These objectives come from the original design. [S1, §§1–2, 19]

**Simplify the machinery, not the evidence or the controls.**

This specification replaces the original product design as the recommended baseline. It records proposed changes to the tech stack, UX/UI, and project organisation specifications. It does not silently rewrite those files. Section 18 lists the alignment work.

“Keep the same results” means preserve the required capabilities and testable behaviour. It does not mean that a design can guarantee the same future returns or the same ideas from stochastic AI models. Section 16 defines how to measure equivalence and research quality.

### Operating boundary

Start with one operator-controlled fund, one live broker account, and one supported market profile. A market profile defines instruments, data, trading hours, execution assumptions, and evaluation rules. Add profiles without creating another platform.

Retain the full path from research to governed live trading. High-frequency trading, investor onboarding, custody, and managing outside capital are not part of this design. A live deployment still needs its own broker, data, operational, and legal assessment.

The name is **OpenQuant**. Naming alternatives are outside this specification.

## 2. Review findings and design changes

The previous specifications provide the product goals and the TypeScript/Rust split. They also describe more agent roles, workflow classes, packages, and public surfaces than the operating loop needs. [S1, §§4–8; S2, §§8, 11; S4, §§2, 27–29]

The following changes are design recommendations, not statements about existing code.

| Finding in the previous design | Proposed change | What must remain |
|---|---|---|
| Separate research, strategy, implementation, critic, evaluator, risk, allocator, and execution agent roles | Use two AI roles: proposer and critic. Use ordinary software for official evaluation, allocation calculations, risk, and execution. | Independent challenge and separation of authority |
| Strategy Contract, Strategy Definition, and implementation can become parallel descriptions | Store one immutable strategy version with a human-readable contract and its executable definition. | Falsifiable hypothesis and exact execution semantics |
| Multiple engine crates and services are described before separate deployment needs exist | Use one Rust core library with modules and thin process entry points. | Shared calculations and isolated live execution |
| Many separate business workflows | Use one research workflow and one evaluation workflow. Use transactional commands for approvals and mandates. | Durable work, cancellation, audit, and recovery |
| Evidence Bundle and Strategy Graph could become independently maintained systems | Derive them from strategy versions, runs, findings, and decisions. Freeze evidence references when approving an action. | Complete lineage and reproducible approvals |
| Paper and shadow appear as a simple evidence ranking | Keep separate checks, but run them through the same engine. Treat shadow as operational validation, not automatic proof of better alpha. | Forward evidence and production-path validation |
| The tech delivery sequence adds paper simulation before live-data integration | Add live data before starting an official paper run. | Genuine prospective paper trading |
| A result can be called “passed” without distinguishing execution success from strategy validity | Separate run status, gate outcomes, and approval decisions. | Clear reasons for every promotion or rejection |
| The open-source plan promises a cloud-free first run, but the stack describes a cloud-backed product | Provide a local fixture demo using the same Rust core, not a second local backend. | A reproducible first result without credentials |
| Public Arena, Academy, catalogues, and content can become separate applications | Publish them as sections of one repository-backed static site. | All public surfaces, without independent services |

Two safety gaps also need explicit treatment: stale reads after a write, and broker requests whose outcome is unknown. Sections 11–12 specify both.

## 3. The complete operating loop

```text
Research Mission
    -> competing proposals
    -> independent critique
    -> historical evaluation
    -> live paper competition
    -> portfolio and execution-path review
    -> bounded live mandate
    -> monitoring, reduction, pause, retirement, or a new version
```

A mission can finish with no eligible strategy. An Arena cohort can have no winner. The fund can retain cash. The system must not manufacture a promotion to complete a workflow.

### Three implementation units

| Unit | Responsibility | Authority boundary |
|---|---|---|
| **Terminal application** | Ink UI, local presentation state, commands, evidence inspection | No authority to calculate official results or send broker orders |
| **Control application** | Hono API, agent jobs, evaluation coordination, lifecycle decisions, mandates, audit | Can authorise a bounded deployment; cannot bypass trading checks |
| **Rust engine** | Strategy execution, simulation, metrics, portfolio calculations, hard risk, broker state | Can act only within installed mandates; cannot grant itself capital |

The engine is one codebase, not one unrestricted process. Historical jobs have no broker credentials. Before live trading, the live engine runs in an independently deployed process with separate credentials and resource limits. A large backtest must not delay live risk checks.

### Retained stack, smaller use of it

Retain the selected AICaaS-derived stack: TypeScript, Ink, Hono, Cloudflare Workflows, Durable Objects, Neon/Postgres, Hyperdrive, R2, Cloudflare Queues, and native Rust on Fly.io. [S2, §§2–4]

Use one API Worker, two workflow classes, one notification Durable Object class, and one batch-evaluation queue. Postgres stores structured state. R2 stores immutable datasets and large artefacts. The public website has no dependency on the private trading database.

This is not a single-server deployment. It is a small number of application components using the already selected managed services. No operating-cost or performance saving is claimed until measured.

## 4. Core records and ownership

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

The **Strategy Graph** is a generated view of parent versions and linked records. Its maintenance is automatic. It needs no manual graph editing and no separate graph database. [S1, §14; S2, §13.1]

Each account has one execution writer. API users, AI agents, and evaluation workers cannot edit its positions or fills. Manual broker activity is imported through reconciliation, not concealed by editing OpenQuant state.

## 5. One strategy format

### 5.1 Strategy Contract and Strategy Definition

Keep the existing terminology, with one ownership rule:

**The Strategy Contract explains a strategy. The Strategy Definition specifies its executable behaviour. Both belong to the same versioned artefact.**

The contract contains the hypothesis, economic rationale, intended conditions, benchmarks, assumptions, and invalidation conditions. The definition contains the universe, data dependencies, signals, entries, exits, sizing, and requested execution behaviour.

The approved version binds both sections to one hash. Behavioural changes create a new version. There is no production strategy code generated independently from this artefact.

### 5.2 Bounded execution

The definition uses a small set of reviewed operators. Start with the operators required by the bundled strategies: rolling calculations, comparisons, boolean conditions, rebalance rules, and sizing rules.

Represent expressions as typed operator trees. Do not execute arbitrary expression strings through `eval`, shell commands, or dynamic code loading.

Validate lookback bounds, data types, units, instrument references, resource limits, and unavailable operators. Reject unknown behaviour rather than substituting an approximation.

A new operator is a reviewed code contribution with tests. This preserves extensibility without giving every strategy arbitrary execution privileges. Frozen model artefacts can later use the same reviewed operator boundary; they do not require LLM calls on the order path.

Strategy-requested risk limits can only tighten the active mandate. They cannot increase its authority.

### 5.3 One execution function

The shared core implements this conceptual boundary:

```text
step(strategy_version, prior_state, market_event)
    -> next_state, target_positions, diagnostics
```

Historical and paper runs use a simulated execution adapter. Shadow uses the production decision path without broker submission. Live uses the broker adapter.

Reuse signal, sizing, risk, and accounting semantics where they apply. Do not claim simulated fills equal real fills. Alpaca's own documentation, for example, identifies market impact, latency, and order-queue effects that its paper simulation does not reproduce. [W3]

## 6. Two AI roles, multiple competing agents

### Proposer

A proposer researches hypotheses, produces Strategy Definitions, requests bounded experiments, and proposes revisions. Several proposer configurations compete within a mission.

### Critic

A critic challenges the hypothesis, data, assumptions, tests, portfolio fit, and operational risks. It returns structured findings with evidence references and proposed tests.

Use the same agent runner for both roles, with different instructions and permissions. Record the actual provider, model identifier, prompt version, tool permissions, and generation settings for every attempt.

Separate role identities and access. The proposing agent cannot close its own critic findings or write official results. A different session of the same model provides process separation, not guaranteed independence of judgement.

### Software, not additional AI roles

The Rust engine produces official results. A deterministic policy evaluator decides whether gates are satisfied. Portfolio software calculates proposed weights and risk. The trading core checks every order.

An LLM may explain those outputs. Its explanation has no authority to replace them.

### Budgets and accumulated learning

Each mission has explicit candidate, experiment, compute, LLM-spend, and revision budgets. A runner cannot increase them. Exhaustion pauses further work and reports what was learned.

Subsequent proposals receive a bounded context pack: relevant past hypotheses, failed trials, critic findings, and observed outcomes. Retrieve this from existing records. Do not add a memory service or vector database without a demonstrated retrieval need.

Record unsuccessful model calls and revised outputs. A transport retry must not silently replace an earlier candidate with whichever model response looks best.

## 7. Game theory without an internal economy

The mechanism uses different roles and shared evaluation rules. It does not require agents to trade tokens, negotiate capital, or vote on their own evidence.

| Mechanism | Rule |
|---|---|
| Comparable competition | Predeclare the cohort, budgets, evaluation windows, and constraints. |
| Independent judgement | Proposers cannot write official scores or resolve their own findings. |
| Search accountability | Record all executed trials, including discarded variants and failed attempts. |
| Forecast calibration | Store a probability, a precise outcome, and a resolution date before observing the outcome. |
| Diversity | Group related strategies and cap their combined exposure. Renaming a strategy does not reset its lineage. |
| Exploration | Reserve a fixed research budget for new approaches. Do not take it from live capital automatically. |

For binary forecasts, use mean squared probability error: `mean((p - y)^2)`, where `y` is 0 or 1. Lower is better. Compare forecasts on the same type of resolved outcome. Show sample count and unresolved forecasts.

A critic is not rewarded merely because its veto prevented a strategy from being tested. Unobserved outcomes remain unresolved. Keep reasoning quality and forecast accuracy separate.

Reputation can inform later research budgets under a fixed policy. It never changes risk limits, promotion gates, or broker permissions. Do not claim that this mechanism makes honesty a dominant strategy; that has not been established.

## 8. Evaluation and the Arena

### 8.1 Register the evaluation plan before selection

A cohort policy fixes the market profile, data splits, benchmarks, costs, evidence requirements, and promotion thresholds. It also declares the required robustness suite.

Every trial is registered before execution. Attempts reference one logical run. Operational retries do not count as new independent discoveries. Changed parameters, features, data selection, or strategy behaviour do count as new search trials.

Retain the complete history of experiments performed within OpenQuant. Imported results disclose any unknown external search history. Do not infer a precise independent-trial count from raw job count.

Repeated selection can inflate apparent performance. The Deflated Sharpe Ratio literature explicitly addresses selection bias from multiple testing and non-normal returns. [W4] Where suitable, include an adjustment such as DSR or a probability-of-backtest-overfitting analysis, with its assumptions. No statistic alone proves an edge.

### 8.2 Required evidence categories

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

### 8.3 Data and holdout discipline

Store event time and availability time. Preserve instrument identity, calendars, corporate actions, delistings, and data revisions where relevant. Transformations must use only information available at the simulated decision time.

Define warm-up, missing-data handling, executable prices, spread, latency, liquidity participation, fees, and rounding. Include borrowing, funding, currency conversion, or other instrument-specific costs when the profile requires them. Otherwise declare the affected strategy unsupported.

An agent cannot inspect a final holdout before submitting its version. Once feedback is revealed, record that the holdout was consumed. Tuning on it cannot produce a fresh out-of-sample claim.

Historical data may already be represented in an LLM's training. A historical holdout is therefore not a complete defence against model contamination. Keep prospective paper evidence and record model provenance.

### 8.4 Live paper competition

Each candidate receives its own virtual ledger under the same declared cohort capital and risk rules. Use common market observations and evaluation periods. Display unmatched periods separately rather than merging them into one ranking.

The referee controls timestamps, fill simulation, costs, and metrics. Agents cannot rewrite fills, reset losses, or selectively remove inactive periods.

A new version starts a new trial. Retain the old version's results. A failed or retired competitor remains in the cohort record.

A historical replay is labelled `REPLAY` or `BACKTEST`, never live paper trading. An official `PAPER` run requires a live-data adapter. Loss of data is recorded as missing evidence, not quietly repaired with favourable historical fills.

### 8.5 Shadow validation

Shadow runs the intended portfolio, sizing, risk checks, order construction, and broker constraints without submitting orders. It can share a live-data feed and core implementation with paper trading.

Store shadow evidence separately. A stronger paper return cannot substitute for an untested execution path. More shadow days cannot substitute for adequate market evidence either.

### 8.6 Results and selection

Keep these separate:

```text
Run status:       QUEUED / RUNNING / COMPLETED / FAILED / CANCELLED
Gate result:      PASS / FAIL / INSUFFICIENT / NOT_APPLICABLE
Decision outcome: APPROVED / REJECTED / DEFERRED
```

A completed run can contain failing gates. A gate pass does not grant capital.

Rank within comparable cohorts. Show net return, drawdown, tail risk, turnover, execution cost, exposure, sample size, search history, and uncertainty. Define each metric's unit, window, and method. Do not use unexplained “robustness: HIGH” or “portfolio contribution: +0.31” as approval inputs.

## 9. Lifecycle and promotion

Preserve the original checks, but do not build a service for each stage. [S1, §6]

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

## 10. Portfolio allocation

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

## 11. Live trading and risk

### 11.1 One accountable execution process

Use one active trading process per broker account. It owns market-state validation, target aggregation, risk reservations, submission, fill processing, and reconciliation.

Do not add separate risk, routing, order, and reconciliation microservices. These functions share the account state and must make consistent decisions.

Historical evaluation runs cannot share its broker credentials or consume its reserved resources. Deploying the API or the TUI must not restart the live process.

The account writer uses an ownership lease and revision. Losing ownership stops new submissions. Do not automatically promote a replacement while the old writer may still submit. A takeover requires stopping or isolating the old writer and reconciling broker state.

### 11.2 Before every order

Check the installed mandate, global halt, strategy status, market freshness, order age, account reconciliation, available cash, working-order reservations, position limits, exposure, liquidity, and price constraints.

Perform check-and-reserve as one serialised account operation. Release or adjust reservations only from confirmed outcomes. Concurrent intents must not each spend the same remaining risk budget.

Use explicit decimal amounts and instrument tick/lot rules for money and quantities. Statistical calculations may use floating point with documented tolerances. Wire contracts must not silently convert exact amounts to JavaScript binary floating-point numbers.

### 11.3 Unknown outcomes are a real state

Before broker submission, durably record the intent, mandate revision, reservation, and stable client-order identifier.

If submission times out, mark the order `UNKNOWN`. Do not assume it failed and resubmit with a new identifier. Query broker state and reconcile before taking further action on that intent.

Deduplicate broker updates by broker event/fill identifiers. Apply fills even when they arrive after a cancel request. A cancellation request is not a cancellation confirmation.

A small crash-recovery journal may retain broker messages and emergency cancellation records awaiting database persistence. It is not a second portfolio database. If durable recording fails, stop new submissions and escalate through the incident procedure.

### 11.4 Pause, halt, and liquidation

**Pause a strategy:** block new strategy risk and cancel applicable working orders. Keep managing and reporting its existing exposure under the approved exit policy.

**Halt the account:** block ordinary strategy submissions and request cancellation of cancellable working orders. Confirm each cancellation separately. Continue reconciliation. Existing positions are not automatically liquidated.

**Liquidate:** a separate authorised operation with its own execution limits. Any emergency risk-reduction order requires the necessary fresh broker and market state. “Risk-reducing” is not permission to bypass all checks.

Loss limits are intervention thresholds, not guarantees that losses cannot exceed them.

Before live enablement, test an emergency route independent of the ordinary Hono/TUI connection. At minimum, the steward must be able to use the broker's own controls. The normal application API remains the TUI's only control boundary.

### 11.5 Failure behaviour

| Failure | Required response |
|---|---|
| LLM unavailable | Pause research; installed deterministic strategies do not need the LLM. |
| Control application unavailable | Grant no new authority. Respect mandate expiry. Continue permitted supervision of existing orders and exposure. |
| Market data stale | Stop affected new risk. Keep the last observation timestamp visible. |
| Broker outcome unknown | Retain reservations and reconcile; never retry blindly. |
| Account state or ownership uncertain | Block new submissions and resolve ownership/state first. |
| Persistence unavailable | Stop new submissions; preserve recoverable broker events and use the emergency procedure as needed. |
| TUI disconnected | Trading controls continue independently. On return, fetch current state before permitting consequential actions. |

## 12. Persistence, jobs, and event delivery

### One canonical database

Postgres holds structured domain state and audit records. R2 holds large immutable artefacts. Enforce writer permissions by service role. Do not use shared unrestricted database credentials.

Disable Hyperdrive query caching for the private application initially. Cloudflare documents that cached reads are not automatically invalidated by writes, and recommends cache-disabled access when freshness is required. [W1] Retain connection pooling without creating two freshness policies prematurely.

Approval, mandate, permission, risk, and post-write reads must be authoritative. User-visible cached snapshots always show their observation time.

### Two workflow classes

`ResearchWorkflow` coordinates proposer and critic attempts under a mission budget.

`EvaluationWorkflow` coordinates the predeclared historical/robustness suite and its result collection.

Ordinary approval and mandate changes are version-checked database commands. They do not need a durable workflow waiting on every human decision. Persistent paper and live sessions are engine processes, not endlessly running evaluation jobs.

### One batch queue

The queue carries historical evaluation work only. Do not route live orders, emergency halts, or raw market ticks through it.

Cloudflare Queues uses at-least-once delivery; duplicate processing must be handled by the application. [W2]

Register a run and a pending dispatch record in one database transaction. Dispatch asynchronously and retry with the same identifier. A recovery task retries undispatched work. This is a small transactional outbox, not a general event platform.

A worker claims a run attempt with a lease, records checkpoints, and renews ownership. Commit a result only for the current attempt. A worker with an expired lease cannot replace the official result. Redelivery may repeat work, but must not create a second official result.

Treat artefact upload and database registration separately. An uploaded but unregistered artefact is not official evidence. Verify its manifest and hash before accepting it. Store failure and cancellation outcomes as well as success.

### Notifications, not another state store

Use the Durable Object only to notify connected clients of changed entities and revisions. It does not own fund state, approval state, or the audit trail.

After a change, the client fetches the affected snapshot. Reconnects and missed notifications trigger resynchronisation. The durable run/decision records determine whether work completed; delivery of a notification does not.

Persist domain changes and their audit event together. Keep diagnostics separate. A transport acknowledgement means “received”, not “executed successfully”.

## 13. Data integrity and security boundaries

Every run binds strategy, engine, dataset, cost model, policy, seed, and evaluation-suite versions. Use deterministic event ordering and record checkpoints. Exact ledger results require exact reproducibility; statistical outputs use predefined tolerances.

Reuse cached evaluation outputs only when all behaviour-affecting inputs match. Record each reuse in the new run's provenance. A reused output is not new independent evidence.

Use a small number of schemas at boundaries: strategy artefact, run request/result, market events, and mandate/command envelopes. Validate them in both TypeScript and Rust with shared fixtures. Unknown mandatory fields or unsupported semantics fail validation.

Treat news, retrieved documents, strategy descriptions, and model output as untrusted input. They cannot change tool permissions, expose secrets, or override policy. Restrict URLs and storage references to authorised sources. Strip terminal control sequences from untrusted text before rendering it.

Authentication and action authorisation remain server-side. Local UI state, a confirmation phrase, or an agent prompt cannot grant permissions. Credentials are separated by environment and service. Live broker credentials exist only in the live execution process.

## 14. Operator experience and first run

Keep the Ink frontend and its separation of rendering from application behaviour. [S3, §1; S5, §§1, 29]

Use five primary workspaces:

| Workspace | Purpose |
|---|---|
| **Overview** | Attention items, fund state, active work, and next decisions |
| **Foundry** | Missions, hypotheses, proposals, and critique |
| **Arena** | All strategies, evaluation evidence, comparisons, and promotion review |
| **Portfolio** | Mandates, positions, attribution, exposure, and risk detail |
| **Operations** | Runs, orders, reconciliation, incidents, service state, and audit |

Strategy Detail is shared across entry points. Agent records belong to mission/run detail rather than a separate management application. Audit is a filtered view of the same records.

Risk status and the route to risk/emergency controls remain persistent and accessible from every workspace. Reducing navigation must not bury risk.

Always show environment, real/simulated money mode, data freshness, account, and risk state. Do not let a production API environment imply that a selected run is live.

Retain keyboard navigation, focus isolation, no-colour/ASCII support, 80-column operation, and machine-readable output. A terminal resize must not hide the action being confirmed.

High-risk actions use structured review and explicit confirmation. The server revalidates their exact revisions. Show `PENDING` or `UNKNOWN` until the outcome is confirmed. Never print “No state changed” solely because a request timed out.

Quitting the TUI detaches it. It does not stop backend runs or halt trading. Cancelling a research run, pausing a strategy, and halting trading are separate commands.

### Cloud-free demonstration

Specify `openquant demo` as the target first-run command. It launches the installed Rust engine against bundled fixtures through the local application runtime. It uses the same strategy and evaluation code as the service.

Use recorded agent proposals where no model credentials are available. Label them as recorded. The engine must calculate the demonstrated results; do not substitute a pre-rendered success screen.

This mode writes local run artefacts. It has no broker adapter enabled, no live credentials, and no cloud orchestration. It demonstrates `REPLAY`, not live paper performance. It is not a second full production backend.

## 15. Open-source organisation

Retain the repository-first public model and its separate Docs, Academy, examples, Strategy Library, benchmarks, case studies, blog, and integration catalogue. [S4, §§1–2, 16–17]

Implement these as content directories and generated pages in one website. Public Arena pages are exported, versioned reports, not a public connection to the private operating console.

Use one canonical example pack to drive a tutorial, demo, test, and public result. Publish failed strategies and benchmark regressions alongside successful runs.

The risk engine and its tests are open-source. Credentials, account data, active mandates, and private datasets are not public. “Open source” does not mean unrestricted authority over a running fund.

Data manifests declare licensing and redistribution conditions. Generated examples use synthetic or redistributable fixtures. A connector does not grant permission to redistribute its provider's data.

Live accounts and strategies remain private by default. Public results require explicit, redacted exports. Label `BACKTEST`, `REPLAY`, `PAPER`, `SHADOW`, and real-money results clearly. Small-capital live results also show the `MICRO` tier. Preserve assumptions, periods, search history, and version provenance.

Choose and document the project's software licence before public release. This design does not claim that a licence, name registration, or legal approval has already been completed.

### Small repository structure

```text
openquant/
  apps/cli/             Ink, commands, local UI runtime
  apps/api/             Hono, domain modules, two workflows, notifications
  packages/contracts/   schemas, wire types, validation fixtures
  packages/client/      typed API and realtime client
  rust/core/            strategy, data, simulation, metrics, portfolio, risk
  rust/runner/          thin batch/session entry points and broker adapters
  docs/specs/           product, tech stack, UX/UI, project organisation
  docs/                 guides, reference, architecture, operations
  examples/             executable canonical example packs
  strategies/           bundled definitions and registry metadata
  benchmarks/           suites, baselines, manifests, public result metadata
  academy/              learning material
  website/              static presentation and editorial content
  infra/                deployment configuration
```

Keep modules inside their owning package until independent reuse justifies extraction. Keep CI and publishing tools from the existing stack; do not create a platform to operate this platform.

## 16. Acceptance and preservation of results

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

## 17. Delivery sequence

These are complete operating checkpoints, not separate products.

| Checkpoint | End-to-end outcome | Required evidence |
|---|---|---|
| **C1 — Reproducible core** | Run bundled strategy definitions, costs, metrics, and risk checks through the actual engine; inspect results in Ink. | A03–A05, A16 |
| **C2 — Competing research** | Proposers and critics produce competing versions; the complete registered historical/robustness suite generates official evidence. | A01–A06, A11 |
| **C3 — Persistent paper fund** | Live data feeds paper competitors; shadow validates a proposed portfolio and production decision path; monitoring and recovery operate. | A07–A10, A13, A15 |
| **C4 — Governed live operation** | An isolated engine installs an approved micro mandate, reconciles real broker state, enforces limits, and supports halt and retirement. | All applicable tests, including broker-specific A12–A14 and A18 |

Increase capital only after the live evidence and mandate policy permit it. Scaling workers, adding markets, and adding brokers are later capacity changes, not prerequisites for the complete loop.

Each checkpoint includes its runnable example, operator guide, tests, and labelled public evidence. Do not advertise a planned capability as delivered.

## 18. Alignment with the existing specifications

This document contains the proposed design changes. The earlier files remain unchanged.

| Existing document | Required alignment when this design is adopted |
|---|---|
| **Trading Platform Design v1** | Use two AI roles, one versioned strategy artefact, derived evidence/lineage, explicit gate outcomes, and the lifecycle in §9. Preserve the original product objectives. |
| **Tech Stack v1** | Retain the chosen stack. Consolidate packages and workflows. Specify persistent paper sessions, cache-disabled reads, run ownership, outbox recovery, account reservations, and unknown broker outcomes. |
| **Ink UX/UI v1.1** | Consolidate navigation as in §14. Keep risk persistent. Add activation acknowledgement, stale-review rejection, `UNKNOWN` outcomes, and explicit detach semantics. Keep implementation details out of the UX spec. |
| **Open-Source Organisation v1** | Retain public surfaces as repository-backed content. Remove naming alternatives. Distinguish fixture replay from paper trading. Publish risk-control code while protecting private operating data. |

This product design owns cross-system behaviour and safety invariants. The tech stack owns implementation choices. The UX/UI spec owns interaction details. The organisation plan owns public surfaces and contribution practice.

Before implementing an affected work unit, align its relevant companion section. An implementation PR must not choose between conflicting specifications silently.

### Inputs still required before live enablement

The selected market, data provider, broker, account permissions, base currency, capital amount, risk limits, data rights, and deployment obligations are not established by the supplied design files. Do not fabricate them or copy illustrative monetary limits from the older examples.

They are explicit inputs to a versioned live profile. They do not block the credential-free core demo or research implementation.

## 19. Sources and verification boundary

### Project sources reviewed

- **[S1]** `ai-native-quant-trading-platform-design-spec-v1.md` — original goals, roles, lifecycle, evidence, portfolio, and controls.
- **[S2]** `ai-native-quant-fund-tech-stack-spec-v1.md` — selected stack, TypeScript/Rust responsibilities, Strategy Definition, storage, deployment, and tests.
- **[S3]** `ai-native-quant-fund-ink-ux-ui-spec-v1.1.md` — operator workflows, navigation, confirmation, state presentation, and accessibility.
- **[S4]** `openquant-open-source-project-organisation-v1.md` — public surfaces, reproducibility, examples, data publication, and governance.
- **[S5]** `Production Best Practices for an Ink TypeScript TUI.md` — rendering/runtime separation and terminal reliability practices.
- **[S6]** `aicaas-stack-spec-1(1).md` — the retained Cloudflare-derived architecture and external compute extension.

These documents state design intent. They are not evidence of deployed capabilities or profitable strategies. Recommendations that change them are identified in §§2 and 18.

### External checks

The following primary sources were consulted on 7 October 2026. They support the stated platform or methodological facts, not the correctness of an OpenQuant implementation.

- **[W1] Cloudflare — Query caching.** Cache invalidation and fresh-read behaviour. `https://developers.cloudflare.com/hyperdrive/concepts/query-caching/`
- **[W2] Cloudflare — Delivery guarantees.** At-least-once queue delivery and duplicate handling. `https://developers.cloudflare.com/queues/reference/delivery-guarantees/`
- **[W3] Alpaca — Paper Trading.** Limitations of that provider's paper simulation. This is not a broker recommendation. `https://docs.alpaca.markets/us/docs/paper-trading`
- **[W4] Bailey and López de Prado — The Deflated Sharpe Ratio (2014).** Abstract and publication record on selection bias, multiple testing, and non-normal returns. The full paper was not reviewed for this specification. `https://papers.ssrn.com/sol3/papers.cfm?abstract_id=2460551`

### Verification status

This work reviews specifications and proposes a coherent design. It does not verify application code, engine performance, broker compatibility, statistical equivalence, live controls, profitability, or regulatory compliance.

Those claims require the acceptance evidence defined above.

**Governing principle: one operating loop, shared implementations, independent evidence, and explicit authority.**

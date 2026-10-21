# AI-Native Quant Fund — Tech Stack Specification

**Version:** 1.0  
**Status:** Engineering specification  
**Companion specs:** AI-Native Quant Trading Platform — Design Specification v1; AI-Native Quant Fund — Ink UX/UI Specification v1.1

---

## 1. Purpose

Define the implementation stack and technical boundaries for the AI-native quant fund.

The architecture is intentionally split into two planes:

```text
CONTROL PLANE  — TypeScript
QUANT / TRADING PLANE — Rust
```

The control plane owns orchestration, product state, agent workflows, governance, API access, and the terminal client.

The Rust plane owns CPU-heavy quantitative evaluation and, once real capital is enabled, deterministic risk and execution.

The governing engineering principle is:

> **TypeScript coordinates the fund. Rust computes and enforces the trading-critical path.**

This avoids rewriting I/O-heavy Cloudflare orchestration in Rust while using Rust where predictable performance, numerical throughput, and deterministic state machines provide material value.

---

## 2. Stack Summary

| Layer | Technology | Role |
|---|---|---|
| Terminal frontend | TypeScript + Ink + React | Full-screen operator TUI |
| CLI/runtime | TypeScript + Node.js | Local command handling, session runtime, typed remote client |
| API | Hono on Cloudflare Workers | Sole remote boundary for the TUI and external clients |
| Durable orchestration | Cloudflare Workflows | Research, agent chains, reviews, promotions, scheduled health workflows |
| Realtime | Cloudflare Durable Objects + WebSockets | Session-scoped live updates and reconnect state |
| Primary database | Neon Postgres + Hyperdrive | Canonical relational state and audit metadata |
| Object/data storage | Cloudflare R2 | Historical datasets, Parquet, evaluation outputs, large immutable artifacts |
| Async bridge | Cloudflare Queues | Dispatch CPU-heavy work outside Workers |
| Quant compute | Rust on Fly.io | Backtests, walk-forward, simulation, stress testing, portfolio maths |
| Production risk/execution | Rust on Fly.io | Deterministic pre-trade risk, order state, broker execution, reconciliation |
| Agent/LLM access | Provider adapters from TypeScript control plane | Research and reasoning models |
| Observability | Better Stack + Cloudflare Observability + OpenTelemetry | Logs, traces, alerts, runtime health |
| Infrastructure as code | Terraform | Cloudflare/Fly infrastructure and environment configuration |
| Deployment | Wrangler + Fly deploy + GitHub Actions | Application deployment and CI/CD |
| Monorepo | pnpm + Turborepo + Cargo workspace | Shared TypeScript and Rust projects |

---

## 3. Architecture

```text
┌────────────────────────────── LOCAL TERMINAL ───────────────────────────────┐
│                                                                            │
│  TypeScript + Ink                                                          │
│                                                                            │
│  apps/cli                                                                  │
│    ├─ TUI                                                                  │
│    ├─ local application runtime                                            │
│    ├─ typed Hono client                                                    │
│    └─ realtime client                                                      │
│                                                                            │
└──────────────────────────────────┬─────────────────────────────────────────┘
                                   │ HTTPS / WSS
                                   ▼
┌──────────────────────────── CLOUDFLARE ─────────────────────────────────────┐
│                                                                            │
│  TypeScript Control Plane                                                  │
│                                                                            │
│  Hono API Worker                                                           │
│    ├─ API                                                                  │
│    ├─ authentication / authorisation                                       │
│    ├─ domain commands and queries                                          │
│    ├─ Workflow triggers                                                    │
│    └─ external provider orchestration                                      │
│                                                                            │
│  Cloudflare Workflows                                                      │
│    ├─ ResearchMissionWorkflow                                              │
│    ├─ StrategyEvaluationWorkflow                                           │
│    ├─ PromotionWorkflow                                                    │
│    ├─ AllocationReviewWorkflow                                             │
│    └─ StrategyHealthWorkflow                                               │
│                                                                            │
│  Durable Objects                                                           │
│    └─ terminal/realtime sessions                                           │
│                                                                            │
│  Hyperdrive ───────────────────────────→ Neon Postgres                      │
│  R2         ───────────────────────────→ datasets / artifacts               │
│                                                                            │
│  Cloudflare Queue                                                          │
│          │                                                                 │
└──────────┼─────────────────────────────────────────────────────────────────┘
           │ evaluation jobs
           ▼
┌────────────────────────────── FLY.IO ───────────────────────────────────────┐
│                                                                            │
│  Rust Quant Worker                                                         │
│    ├─ strategy runtime                                                     │
│    ├─ backtest engine                                                      │
│    ├─ walk-forward                                                         │
│    ├─ robustness / stress                                                  │
│    ├─ portfolio metrics                                                    │
│    └─ paper execution simulation                                           │
│                                                                            │
│  Rust Trading Core                  [introduced with real capital]          │
│    ├─ hard risk engine                                                     │
│    ├─ order state machine                                                  │
│    ├─ broker adapters                                                      │
│    └─ reconciliation                                                       │
│                                                                            │
└──────────────────────────────────┬─────────────────────────────────────────┘
                                   │
                         market data / broker
```

---

## 4. Architecture Boundaries

### 4.1 TypeScript Control Plane

Owns:

- TUI;
- external API;
- authentication and authorisation;
- research missions;
- agent orchestration;
- strategy lifecycle;
- evidence registration;
- promotion workflows;
- capital mandate workflows;
- audit records;
- attention items;
- realtime operator updates;
- configuration and governance.

It does not perform large numerical simulations.

### 4.2 Rust Quant Plane

Owns:

- historical simulation;
- execution simulation;
- transaction-cost modelling;
- walk-forward evaluation;
- bootstrap/Monte Carlo analysis;
- parameter perturbation;
- portfolio and correlation calculations;
- high-volume market-data transforms needed by evaluation.

It receives immutable evaluation requests and returns immutable evaluation results.

It does not approve strategy promotion or capital.

### 4.3 Rust Trading Core

Added only when live capital is enabled.

Owns:

- deterministic hard risk checks;
- approved mandate enforcement;
- order validation;
- order lifecycle;
- broker connectivity;
- live position reconciliation;
- kill/halt enforcement;
- execution telemetry.

It does not call LLMs.

It does not create strategies.

It does not decide its own risk limits.

### 4.4 Persistence

Neon Postgres and R2 own durable truth.

Durable Objects own hot session state only.

Cloudflare Workflows own durable workflow execution but are not the canonical store for fund entities.

---

## 5. Why TypeScript for the Control Plane

The control plane is dominated by:

- network I/O;
- LLM requests;
- database queries;
- workflow coordination;
- WebSocket updates;
- API validation;
- operator interactions.

TypeScript provides:

- direct compatibility with Ink and React;
- first-class Cloudflare Workers support;
- Hono's typed client model;
- one language across TUI, API, Workflows, and Durable Objects;
- straightforward sharing of domain types and validators;
- fast iteration on agent workflows.

The TUI and API remain independently deployable despite sharing TypeScript packages.

---

## 6. Why Rust for Quant Compute

Quant evaluation is fundamentally different from agent orchestration.

Representative work:

```text
strategy variants
× walk-forward windows
× parameter perturbations
× cost scenarios
× bootstrap paths
× market observations
```

Rust is used for this plane because it provides:

- native CPU performance;
- predictable memory behaviour;
- data-parallel execution;
- strong numeric and data-processing libraries;
- deterministic binaries;
- easy isolation from the LLM/control plane;
- reuse of the same calculations in simulation and production.

Rust is introduced at the first serious Arena implementation rather than postponed until performance becomes a problem.

---

## 7. Why Not an All-Rust Backend

An all-Rust backend would add complexity where it provides little benefit.

The following stay TypeScript:

```text
authentication
CRUD/query APIs
LLM orchestration
Cloudflare Workflows
Durable Object session handling
research workflows
promotion workflows
audit queries
operator realtime updates
```

The system deliberately optimises for **language fit by workload**, not language uniformity.

---

## 8. Repository Structure

```text
/
├── apps/
│   ├── cli/                         # TypeScript + Ink
│   └── api/                         # Hono + Workflows + Durable Objects
│
├── packages/
│   ├── domain/                      # TS domain types and lifecycle rules
│   ├── api-client/                  # typed Hono client
│   ├── realtime-client/             # WebSocket client
│   ├── contracts/                   # API schemas / validation
│   ├── strategy-contract/           # strategy definition types and schemas
│   ├── config/                      # shared TS configuration
│   └── mocks/                       # HTTP/realtime fixtures
│
├── rust/
│   ├── Cargo.toml                   # Rust workspace
│   ├── crates/
│   │   ├── protocol/                # cross-language job/result envelopes
│   │   ├── strategy-runtime/        # interprets approved strategy definitions
│   │   ├── market-data/             # canonical bars/events/datasets
│   │   ├── simulator/               # fills, costs, slippage
│   │   ├── metrics/                 # performance/risk/robustness metrics
│   │   ├── portfolio/               # portfolio maths
│   │   ├── risk-engine/             # deterministic hard-risk library
│   │   └── execution/               # order state / broker abstractions
│   │
│   └── services/
│       ├── quant-worker/             # launch Rust service
│       └── trading-core/             # add with real capital
│
├── protocol/
│   ├── evaluation-request.schema.json
│   ├── evaluation-result.schema.json
│   ├── strategy-definition.schema.json
│   └── fixtures/
│
├── migrations/
│
├── infra/
│   ├── cloudflare/
│   ├── fly/
│   └── environments/
│
├── pnpm-workspace.yaml
├── turbo.json
└── package.json
```

The TypeScript workspace uses `pnpm` + Turborepo.

Rust uses a Cargo workspace.

Turborepo may invoke Cargo tasks, but Cargo remains authoritative for Rust dependency/build semantics.

---

## 9. Frontend Stack

### 9.1 TypeScript + Ink

Ink is the interactive terminal renderer.

Responsibilities:

- render current application state;
- capture keyboard input;
- manage focus and overlays;
- present progress;
- display errors and confirmations;
- adapt to terminal dimensions.

Ink components must not contain fund business rules.

### 9.2 Local Application Runtime

A small TypeScript runtime sits between Ink and remote services.

Responsibilities:

- navigation state;
- focus/input modes;
- typed commands;
- remote request lifecycle;
- cancellation;
- reconnect state;
- event reduction;
- local non-sensitive preferences.

The runtime does not become a second durable backend.

### 9.3 Hono Client

The TUI calls the Hono Worker through a typed client.

Prefer Hono RPC typing for TypeScript-to-TypeScript routes:

```ts
import { hc } from "hono/client";
import type { AppType } from "@fund/api";

export const createApiClient = (baseUrl: string) =>
  hc<AppType>(baseUrl);
```

The client never connects directly to Neon, Hyperdrive, R2, Workflows, or broker services.

---

## 10. Hono API Worker

Hono is the sole public application boundary.

Responsibilities:

- authentication;
- authorisation;
- queries;
- domain commands;
- workflow creation;
- workflow control;
- evaluation dispatch;
- realtime-session establishment;
- market-data/broker administration where required;
- webhook ingestion;
- CLI/TUI access.

Rule:

```text
TUI / external client
        ↓
      Hono
        ↓
domain / workflow / storage / compute
```

Do not expose internal Cloudflare resources directly to the terminal application.

---

## 11. Cloudflare Workflows

Use Workflows for durable, multi-step, I/O-heavy orchestration.

Initial workflow types:

```text
ResearchMissionWorkflow
StrategyConstructionWorkflow
StrategyEvaluationWorkflow
PromotionWorkflow
AllocationReviewWorkflow
StrategyHealthWorkflow
```

Example research workflow:

```text
mission created
→ gather research context
→ run researcher agents
→ register hypotheses
→ run critic agents
→ construct candidate strategy definitions
→ schedule evaluations
→ produce mission summary
```

Example promotion workflow:

```text
promotion requested
→ load evidence bundle
→ validate mandatory gates
→ request risk evaluation
→ create proposed mandate
→ require human decision where policy says so
→ persist decision
→ update strategy state
```

Workflow steps must be:

- idempotent where they have side effects;
- resumable;
- versioned;
- observable.

Large data is stored in R2/Postgres and referenced by ID rather than passed through workflow state.

---

## 12. Durable Objects

Use Durable Objects for session-scoped realtime coordination.

One logical session object per active terminal session or subscription group.

Responsibilities:

- WebSocket connections;
- event fan-out;
- connection/reconnection cursor;
- subscription state;
- short-lived presence/session metadata.

Do not store canonical:

- strategies;
- allocations;
- mandates;
- orders;
- evidence;
- audit history;

only in a Durable Object.

Durable Objects are transport/session infrastructure, not durable fund truth.

---

## 13. Database — Neon Postgres + Hyperdrive

Neon Postgres is the canonical structured database.

Hyperdrive is used by Cloudflare Workers for pooled Postgres access.

Primary domains:

```text
users
roles
strategies
strategy_versions
hypotheses
research_missions
experiments
evidence
evaluation_runs
promotion_reviews
capital_mandates
allocations
portfolio_snapshots
positions
orders
fills
risk_limits
risk_events
agent_profiles
agent_predictions
agent_reputation
attention_items
workflow_records
decision_records
audit_events
dataset_catalog
```

### 13.1 Relational First

Strategy lineage is initially relational.

Example:

```text
strategy_versions.parent_version_id
hypotheses.id
experiments.strategy_version_id
evidence.experiment_id
decisions.evidence_bundle_id
```

Recursive queries/materialised views are sufficient for initial lineage views.

Do not add a graph database just because the product calls the structure a Strategy Graph.

### 13.2 SurrealDB

Deferred.

Introduce only when there is a demonstrated requirement for:

- relationship-heavy agent memory;
- GraphRAG;
- graph traversal that becomes awkward in Postgres;
- cross-domain knowledge graphs.

The application contracts must not assume a graph database.

---

## 14. Object and Dataset Storage — R2

R2 stores large or immutable artifacts.

Use it for:

- historical market datasets;
- Parquet files;
- point-in-time dataset snapshots;
- backtest result bundles;
- Monte Carlo distributions;
- generated reports;
- model artifacts;
- large research outputs;
- archived diagnostics.

Postgres stores metadata and references.

Example:

```text
dataset_catalog
  id
  provider
  universe
  period
  schema_version
  content_hash
  r2_uri
  created_at
```

Raw historical market data should not be expanded into relational rows merely to fit Postgres.

---

## 15. Market Data Model

The platform is not initially an HFT system.

Define one canonical internal market-data representation.

Core types:

```text
Instrument
Bar
Quote
Trade
CorporateAction
TradingCalendar
DatasetManifest
```

Every historical record needed by a strategy must preserve:

```text
event_time
availability_time
source
instrument
dataset_version
```

This supports point-in-time evaluation and prevents accidental look-ahead.

### 15.1 Historical Data

Preferred storage:

```text
provider input
→ validation/normalisation
→ partitioned Parquet
→ R2
→ dataset catalogue in Postgres
```

### 15.2 Live Data

Provider-specific feeds terminate behind a market-data adapter.

The rest of the system consumes canonical market events.

Do not make strategy definitions depend on a provider's proprietary payload shape.

---

## 16. Strategy Definition / Strategy IR

Agents should not need to generate arbitrary executable Rust source code.

The normal strategy output is a declarative, versioned **Strategy Definition**.

Example:

```yaml
version: 1

universe:
  type: instrument_set
  instruments: [SPY, QQQ]

frequency: 5m

features:
  - id: z
    type: rolling_zscore
    source: close
    lookback: 20

entry:
  long:
    when: z < -2.0
  short:
    when: z > 2.0

exit:
  when: abs(z) < 0.4

sizing:
  type: volatility_target
  target: 0.10

risk:
  max_position_pct: 0.02

execution:
  order_type: market
```

The Strategy Definition is:

- generated/proposed by agents;
- schema validated;
- immutable once evaluated;
- interpreted by the Rust strategy runtime;
- used consistently in backtest, paper, shadow, and live execution.

Benefits:

- reproducibility;
- no arbitrary code execution;
- safer agent-generated strategies;
- consistent simulation/live semantics;
- cross-language readability.

### 16.1 Escape Hatch

Advanced strategies may eventually use trusted compiled strategy modules.

They require a different governance class and are not part of the initial platform.

---

## 17. Rust Quant Worker

The first Rust service is `quant-worker`.

It is stateless with respect to canonical fund state.

Input:

```text
EvaluationRequest
```

Output:

```text
EvaluationResult
```

Responsibilities:

- load referenced datasets;
- instantiate Strategy Definition;
- simulate execution;
- calculate metrics;
- run requested robustness suite;
- write large result artifacts;
- return summary/provenance.

### 17.1 Initial Rust Libraries

Use a small, conventional stack:

| Need | Rust choice |
|---|---|
| async runtime | Tokio |
| service/API shell | Axum |
| serialisation | Serde |
| HTTP | Reqwest |
| structured errors | thiserror / anyhow at application boundaries |
| logging/tracing | tracing + OpenTelemetry |
| tabular data | Polars |
| columnar files | Arrow / Parquet through Polars ecosystem |
| dense numeric operations | ndarray where needed |
| CPU data parallelism | Rayon |
| database access when required | SQLx |
| property testing | proptest |
| benchmarks | Criterion |

Do not add numerical libraries pre-emptively.

Use them only where a concrete evaluation requires them.

### 17.2 Evaluation Determinism

Every request records:

- strategy-definition hash;
- engine version;
- dataset version/hash;
- seed where randomness exists;
- transaction-cost model version;
- evaluation configuration;
- runtime version.

The same request should be reproducible within defined numeric tolerances.

---

## 18. Evaluation Job Protocol

CPU-heavy work is asynchronous.

```text
Hono / Workflow
→ evaluation request
→ Cloudflare Queue
→ quant-worker
→ R2 / Postgres
→ completion event
```

Evaluation request:

```json
{
  "schemaVersion": 1,
  "evaluationId": "E551",
  "strategyVersionId": "S33-v4",
  "strategyDefinitionUri": "r2://...",
  "datasetId": "D18",
  "suite": "walk-forward",
  "config": {},
  "seed": 48121
}
```

Result summary:

```json
{
  "schemaVersion": 1,
  "evaluationId": "E551",
  "status": "passed",
  "metrics": {},
  "warnings": [],
  "artifactUri": "r2://...",
  "engineVersion": "quant-engine-0.3.1"
}
```

Queue delivery is treated as at-least-once.

Evaluation IDs are idempotency keys.

Repeated delivery must not create duplicate official results.

---

## 19. Cross-Language Contracts

There are two contract families.

### 19.1 TypeScript API Contracts

TUI ↔ Hono uses TypeScript/Hono route inference and runtime validation.

### 19.2 TypeScript ↔ Rust Wire Contracts

Queue/job/result contracts are language-neutral.

Canonical schemas live in:

```text
/protocol/*.schema.json
```

Rules:

- every message has `schemaVersion`;
- wire fields are additive by default;
- incompatible changes require a new schema version;
- TypeScript validates before dispatch;
- Rust validates on receipt;
- shared fixtures are executed in both TypeScript and Rust test suites.

Do not rely on compile-time TypeScript types as the cross-language wire contract.

---

## 20. Paper Trading

Paper trading uses the same Strategy Definition and core calculations as historical simulation.

The difference is the event source.

```text
Historical:
dataset → strategy runtime → simulator

Paper:
live market events → strategy runtime → simulator
```

Paper state is durable outside the local TUI.

The simulator owns official:

- order timestamps;
- fills;
- spread;
- fees;
- slippage;
- P&L.

Strategy agents cannot edit simulated outcomes.

---

## 21. Rust Risk Engine

The risk engine is a library before it is a service.

It is used by:

- backtest/paper simulation;
- portfolio analysis;
- future Trading Core.

Inputs:

```text
TradeIntent
PortfolioState
MarketState
CapitalMandate
RiskPolicy
```

Output:

```text
ACCEPT
REJECT
REDUCE
HALT
```

with structured reasons.

The engine contains no LLM calls.

Risk rules are deterministic and versioned.

Examples:

- strategy capital limit;
- position notional;
- gross/net exposure;
- leverage;
- instrument permission;
- price collar;
- stale-data age;
- daily loss;
- drawdown;
- correlated-cluster limit;
- global trading halt.

The same rule implementations should be reused between simulation and live trading where semantics match.

---

## 22. Rust Trading Core

Do not build this service during the paper-only phase.

Introduce it when micro-capital trading is enabled.

Responsibilities:

- receive approved Trade Intents;
- load/verify active Capital Mandate;
- execute hard risk checks;
- create broker orders;
- maintain deterministic order state;
- handle broker acknowledgements/fills;
- reconcile positions/cash/orders;
- enforce emergency halt;
- emit execution/audit events.

Conceptual path:

```text
Strategy Decision
      ↓
Trade Intent
      ↓
Portfolio approval
      ↓
Trading Core
      ↓
Hard Risk Engine
      ↓
Order State Machine
      ↓
Broker Adapter
```

### 22.1 Failure Policy

Trading Core fails closed for new risk.

Examples:

- unknown mandate → reject;
- stale market state → reject;
- unreconciled order state → reject new conflicting orders;
- risk policy unavailable → reject;
- global halt → reject.

It must remain able to reconcile/manage already-open broker state when the AI/control plane is unavailable.

---

## 23. Broker Adapters

Broker integration is behind a Rust interface.

Conceptually:

```rust
trait Broker {
    async fn submit_order(...);
    async fn cancel_order(...);
    async fn get_order(...);
    async fn list_open_orders(...);
    async fn positions(...);
    async fn account_state(...);
}
```

Provider-specific models are converted into canonical internal:

```text
Order
OrderUpdate
Fill
Position
AccountState
```

Broker credentials never reach:

- agents;
- Strategy Definitions;
- TUI payloads;
- evaluation workers that do not require them.

---

## 24. Portfolio and Capital Allocation

The TypeScript control plane owns allocation workflows and governance.

Rust owns calculation-heavy portfolio analytics.

Typical flow:

```text
Control Plane
→ request portfolio evaluation
→ Rust portfolio engine
→ marginal contribution / exposure metrics
→ Control Plane
→ proposed allocations
→ governance / human approval
→ persisted Capital Mandates
```

Rust does not autonomously grant capital.

Capital Mandates are canonical, versioned domain objects.

---

## 25. Agent Layer

Agent orchestration remains in TypeScript.

Agent roles:

```text
Research
Strategy
Critic
Evaluation
Risk advisory
Allocator advisory
Execution advisory
```

Agents interact with tools through narrowly scoped capabilities.

Agents may:

- inspect research data;
- propose hypotheses;
- generate Strategy Definitions;
- request evaluations;
- criticise evidence;
- recommend promotion/allocation.

Agents may not:

- modify official evaluation results;
- edit broker state;
- change their own permissions;
- bypass hard risk;
- retrieve broker credentials;
- directly submit live broker orders.

---

## 26. LLM Provider Abstraction

Do not couple domain workflows to one model vendor.

Define provider adapters around capabilities such as:

```text
generateStructured
generateText
streamText
embed
```

Workflow/domain code depends on capability interfaces.

Provider-specific:

- API keys;
- model identifiers;
- rate limits;
- request/response formats;

remain in adapters/configuration.

All structured agent outputs are runtime validated before entering the domain.

---

## 27. Authentication and Authorisation

The TUI authenticates to Hono.

Use short-lived application credentials/tokens rather than embedding persistent infrastructure credentials in the CLI.

Authorisation is role-based and action-specific.

Example roles:

```text
viewer
researcher
operator
steward
administrator
```

Example permission boundaries:

```text
viewer       read only
researcher   create research missions / evaluations
operator     paper/shadow operations
steward      real-capital promotion / mandate changes
administrator infrastructure configuration
```

High-risk server-side checks remain mandatory regardless of UI state.

---

## 28. Secret Management

Secrets are held only in the service that requires them.

Cloudflare:

- LLM provider secrets;
- Neon/Hyperdrive configuration;
- webhook secrets;
- service credentials.

Fly.io Trading Core:

- broker credentials;
- broker signing secrets;
- live market-data credentials where appropriate.

Rules:

- no secrets in Git;
- no secrets in Strategy Definitions;
- no broker credentials in agent prompts;
- no broker credentials in TUI config;
- redact secrets from logs.

---

## 29. Audit and Decision Records

Every consequential state change creates an audit record.

Examples:

```text
strategy.created
strategy.promoted
strategy.paused
evaluation.completed
mandate.created
allocation.changed
risk.rejected
order.submitted
order.cancelled
fill.received
halt.activated
human.override
```

Audit records contain references to:

- actor;
- object;
- input state;
- evidence;
- policy version;
- result;
- timestamp;
- environment.

The audit table is append-oriented.

Corrections create new records rather than rewriting history.

Large supporting artifacts remain in R2.

---

## 30. Realtime Model

The control plane publishes semantic operational events.

Examples:

```text
attention.created
strategy.state_changed
workflow.progressed
evaluation.completed
risk.warning
risk.halted
order.state_changed
reconciliation.mismatch
```

Durable Objects fan these events to subscribed terminal sessions.

Do not send:

- raw tick feeds;
- arbitrary internal logs;
- UI-specific rendering commands.

The TUI receives state changes, not infrastructure noise.

---

## 31. Observability

### TypeScript / Cloudflare

Use:

- Cloudflare Workers logs/traces;
- Workflow observability;
- structured application logs;
- Better Stack for central logs, alerting, uptime, and on-call.

### Rust

Use:

- `tracing`;
- OpenTelemetry;
- structured JSON logs;
- service health endpoints;
- evaluation duration/throughput metrics;
- broker/reconciliation metrics.

Correlate end-to-end work with stable identifiers:

```text
request_id
workflow_id
evaluation_id
strategy_id
order_id
```

Never log full sensitive prompts, credentials, or unnecessary trading-account details.

---

## 32. Testing

### 32.1 TypeScript

Use:

- Vitest for domain/runtime/API tests;
- Ink rendering/interaction tests;
- mock Hono responses;
- mock WebSocket events;
- contract fixtures.

Test:

- lifecycle transitions;
- permissions;
- confirmation policies;
- workflow idempotency;
- reconnect behaviour;
- stale-state handling.

### 32.2 Rust

Use:

- `cargo test`;
- property tests for invariants;
- deterministic fixture backtests;
- simulation golden tests where appropriate;
- Criterion for critical numerical paths.

Critical invariants:

```text
cash + marked positions = portfolio value within tolerance
no fill exceeds available simulated liquidity rule
risk rejection cannot create broker order
duplicate evaluation request cannot create duplicate official result
duplicate broker update cannot duplicate fill
halted system cannot create new production exposure
```

### 32.3 Cross-Language Contracts

Every protocol fixture is validated by both TypeScript and Rust CI.

This is the primary drift defence between planes.

---

## 33. Local Development

### TypeScript

Run the TUI against:

- mock API/realtime;
- local Wrangler API;
- staging backend.

Normal UI development should not require:

- live LLM calls;
- paid market data;
- broker access;
- Rust Trading Core.

### Rust Quant

Support evaluation against fixture Parquet datasets.

Example workflow:

```text
fixture Strategy Definition
+ fixture dataset
+ fixed seed
→ quant-worker
→ deterministic result fixture
```

### Integration

Use a Neon development branch and local/staging Cloudflare resources for full-path tests.

---

## 34. Deployment

### Cloudflare

Deploy:

```text
Hono API
Workflows
Durable Objects
R2 bindings
Hyperdrive bindings
Queues
```

with Wrangler.

Infrastructure configuration is managed by Terraform.

### Fly.io

Deploy:

```text
quant-worker
trading-core
```

as separate applications/services when both exist.

The quant worker can scale independently from Trading Core.

Trading Core should start single-region close to the selected broker/market-data endpoints unless a concrete resilience requirement justifies more complexity.

---

## 35. CI/CD

Use GitHub Actions.

Required checks:

```text
TypeScript
- lint
- typecheck
- test
- build

Rust
- fmt
- clippy
- test
- protocol fixtures
- build

Contracts
- schema validation
- cross-language fixture compatibility

Infrastructure
- terraform fmt
- terraform validate
- terraform plan where appropriate
```

Production deployments require protected environments.

Trading Core deployment is separate from ordinary control-plane deployment.

A normal TUI/API release must not implicitly deploy or restart the live trading process.

---

## 36. Infrastructure as Code

Terraform manages infrastructure.

Initial resources:

```text
Cloudflare
- API Worker
- Workflow bindings
- Durable Object bindings
- Hyperdrive
- R2
- Queue
- DNS/routes
- environment bindings

Fly.io
- quant-worker app
- networking
- secrets references/configuration

Neon
- project/branches where managed through provider or explicit setup
```

Add Trading Core resources only with micro-capital phase.

Avoid Kubernetes.

Avoid Kafka/NATS.

Avoid a service mesh.

The architecture should remain understandable by one operator/developer.

---

## 37. Initial Delivery Architecture

The first complete Arena does not need the entire production stack.

### Phase 1 — Local/Product Shell

```text
Ink TUI
Mock API
Mock realtime
Strategy Definition schema
```

### Phase 2 — TypeScript Control Plane

```text
Ink
Hono
Neon
R2
Workflows
Durable Objects
```

Supports research missions and persisted strategy lifecycle.

### Phase 3 — Rust Arena

Add:

```text
Cloudflare Queue
quant-worker
historical datasets
backtests
walk-forward
robustness suites
paper simulator
```

This is the first complete AI strategy market.

### Phase 4 — Shadow Fund

Add:

```text
live market-data adapter
portfolio analytics
shadow order intents
execution comparison
reconciliation model
```

Still no broker orders.

### Phase 5 — Micro-Capital

Add:

```text
trading-core
hard risk engine
broker adapter
live reconciliation
broker secrets
emergency halt
```

### Phase 6 — Production Fund

Add only proven needs:

```text
additional brokers
additional evaluation workers
advanced graph/memory store
additional market-data services
regional trading-core deployment
```

---

## 38. Explicit Non-Goals

Do not introduce initially:

- Kubernetes;
- Kafka;
- NATS;
- microservices for every domain;
- separate graph database;
- Python production services;
- arbitrary agent-generated executable trading code;
- GPU infrastructure;
- HFT/microsecond execution;
- direct database access from the TUI;
- direct broker access from agents;
- direct broker access from the TypeScript control plane.

These require a demonstrated need.

---

## 39. Technology Decision Summary

### TypeScript

Use for:

```text
Ink
local runtime
Hono
Cloudflare Workflows
Durable Objects
agent orchestration
governance
API/domain workflows
```

### Rust

Use for:

```text
strategy runtime
backtests
simulation
robustness
portfolio computation
hard risk
execution
reconciliation
```

### Neon Postgres

Use for:

```text
canonical structured fund state
strategy lineage
evidence metadata
mandates
orders/fills metadata
audit
```

### R2

Use for:

```text
market datasets
Parquet
large evaluation results
immutable artifacts
```

### Cloudflare Workflows

Use for:

```text
durable I/O-heavy business/agent processes
```

### Cloudflare Queues

Use for:

```text
cross-runtime asynchronous CPU jobs
```

### Durable Objects

Use for:

```text
session-scoped realtime coordination
```

---

## 40. Engineering Acceptance Criteria

The stack is correctly implemented when:

1. The Ink application has no direct database or broker credentials.
2. Hono is the sole application API boundary for the TUI.
3. Long-running quantitative work does not run inside the TUI or block request handlers.
4. Official evaluation results are produced by the trusted Rust engine.
5. Strategy Definitions are versioned, immutable per evaluation, and schema validated.
6. TypeScript and Rust share versioned wire contracts with cross-language tests.
7. Failed/duplicate queue deliveries cannot create duplicate official evaluations.
8. Durable Objects are not the sole durable store of fund truth.
9. Raw historical datasets live outside relational tables where columnar storage is more appropriate.
10. Hard live risk rules contain no LLM dependency.
11. Agents cannot directly send broker orders.
12. Broker credentials exist only inside authorised live-trading infrastructure.
13. Paper and live paths reuse the same strategy semantics where practical.
14. Control-plane outages do not allow new uncontrolled live exposure.
15. The paper/Arena platform can run without deploying Trading Core.
16. The architecture remains operable without Kubernetes, Kafka, or a large service fleet.

---

## 41. Governing Architecture Principle

> **AI proposes. The control plane governs. Rust evaluates and enforces. Durable storage records the truth.**

This boundary should remain intact as the fund grows.

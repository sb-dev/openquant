---
id: OQ-05
title: OpenQuant — System Architecture and Data
version: 1.0.0
status: canonical
updated: 2026-10-19
owns: stack, hosting, source boundaries, persistence, protocols, authentication
---

# OpenQuant — System Architecture and Data

This document defines required behaviour. It does not claim that the behaviour is implemented.
See the [specification index](README.md) for ownership and the current bootstrap scope.

## 1. Technology and workload placement

| Concern | Selected technology |
| --- | --- |
| Operator client | TypeScript, React, Ink, Node.js. |
| Control application | TypeScript, Hono, Cloudflare Workers. |
| Durable product work | `ResearchWorkflow` and `EvaluationWorkflow` on Cloudflare Workflows. |
| Notifications | One Durable Object class with authenticated WebSocket subscriptions. |
| Canonical structured state | Neon Postgres; Hyperdrive for Worker connections, query caching disabled. |
| Immutable large artefacts | R2; partitioned Parquet for historical market data where suitable. |
| Batch dispatch | One Cloudflare Queue with an HTTP-pull consumer. |
| Native execution | Rust on Fly.io; batch, paper/shadow, and live profiles from one source tree. |
| Delegated model host | Isolated Node process on Fly.io using the reviewed external CLI. |
| Public website | Astro with Cloudflare static hosting; repository content and approved exports. |
| Observability | Structured logs, OpenTelemetry, Rust `tracing`, Cloudflare telemetry, Better Stack alerts. |
| Delivery | GitHub Actions, Wrangler, pinned flyctl, Terraform for supported Cloudflare resources. |
| Build | pnpm and Turborepo for TypeScript; one Cargo workspace for Rust. |

Use four separate Fly apps: agent runner, batch engine, paper engine, and live engine. Add each at its checkpoint. Do not introduce Cloudflare Containers as a parallel execution host.

The operator client accesses all private remote state through Hono. It never connects directly to Neon, Hyperdrive, Fly control APIs, or a broker.

## 2. Source ownership

| Path | Owns |
| --- | --- |
| `apps/cli` | Rendering, input, focus, navigation, local presentation runtime, and direct CLI commands. |
| `apps/api` | Authentication, guarded commands, queries, domain policy, workflows, notifications, infrastructure adapters, SQL migrations. |
| `apps/agent-runner` | Isolated delegated model execution. |
| `apps/engine` | Native process entry points, market-data adapters, broker adapters, persistence adapters. |
| `apps/web` | Public static presentation. |
| `packages/api-contracts` | API and cross-runtime schema source. |
| `packages/api-client` | HTTP/events, reconnect, runtime validation, outcome handling. |
| `packages/agents` | Role behaviour, output schemas, assembly/parsing, evaluation cases, release identity. |
| `packages/quant-core` | Shared signals, simulation, accounting, portfolio, risk, and metrics. |

API-only domain, application, database, configuration, and telemetry modules remain inside `apps/api` until another consumer needs them. The only SQL migration owner is `apps/api/migrations`.

List TypeScript packages explicitly in the pnpm workspace. Do not give Rust an npm wrapper just to put Cargo into the JavaScript task graph. Commit generated pnpm and Cargo lockfiles when their executable packages exist.

Create an executable package only when its checkpoint supplies working code and verification. Directory guides reserve ownership during bootstrap; they are not completed services.

Boundary checks reject API implementation imports in Ink, Node subprocess code in Worker bundles, and broker code in the agent runtime. Domain modules do not import Cloudflare bindings.

## 3. Durable product workflows

**ResearchWorkflow:** reserve the mission budget, invoke competing proposer configurations, register candidates, invoke independent criticism, and request bounded evaluations. It records every attempt and uses controlled revisions.

**EvaluationWorkflow:** freeze the strategy/data/policy manifest, request engine work, verify the returned artefacts, and record official evidence. Numerical success and promotion eligibility remain separate.

Mandate approval, rejection, acknowledgements, and policy changes are ordinary version-checked commands. They do not need one workflow class each. Cloudflare's Workflow API provides the orchestration boundary; application records remain authoritative for domain state.

Cloudflare schedules trigger product work and recovery. Market calendars and stored schedule slots determine whether work is due. A repeated trigger cannot create another run for the same logical slot. Persistent paper/live feeds run on Fly.io, not in GitHub Actions or one Workflow step per tick.

## 4. Dispatch, ownership, and completion

Create the run, budget reservation, and dispatch-outbox entry in one database transaction. Retain one batch queue for quantitative jobs. Queue messages contain input references, not whole datasets. Do not put live orders, halts, or raw market ticks on this queue.

The batch host pulls work through the Cloudflare Queues HTTP API using HTTP POST. Configure an HTTP-pull consumer; do not also attach a push consumer. Verify the pinned integration against the provider contract during the deployment probe.

A batch worker must claim the logical attempt through a guarded application endpoint before executing it. Use an application lease and revision separately from the queue receipt. Accept completion only from the current owner. A redelivered message cannot authorise duplicate official results.

Acknowledge work after its terminal result is committed. Long evaluations must be bounded or checkpointed to fit the documented visibility window. If visibility expires, the run record and recovery task decide whether to resume or fence a new attempt. Do not rely on the queue lease alone or assume an unlimited visibility extension.

ResearchWorkflow uses authenticated HTTPS to submit an existing attempt ID to the Fly agent-runner. The host must obtain a durable claim through the control API before returning acceptance or starting the tool. It then returns promptly; the Workflow observes stored status through bounded polling. A timed-out dispatch is checked under the same ID, not blindly respawned. This path needs no second queue initially.

Upload immutable results first. Verify schema, input hashes, running engine/executor identity, and attempt ownership before committing the official result. A stale worker may leave an unreferenced artefact; it cannot replace accepted evidence. Notify clients only after commit. Recovery finds missing dispatches and expired attempts even when no client is connected.

## 5. Storage, networking, and credentials

Neon stores canonical missions, versions, runs, decisions, mandates, accounting, order history, and audit records. R2 stores immutable inputs, reports, and checkpoints. Hyperdrive caching is disabled for private application reads initially.

There is one SQL migration owner: `apps/api/migrations`. Cloudflare uses Hyperdrive. Fly engine processes that own accounting use bounded Postgres connections and narrow service roles, not a Worker binding or a second database. Batch and agent hosts use scoped input/result endpoints where no direct database authority is required.

Use authenticated TLS connections across the Cloudflare/Fly boundary. Service credentials bind the caller to permitted operations, environment, and run/account scope. Do not assume Cloudflare can reach Fly private DNS without an explicitly configured network bridge. The TUI still accesses private application state only through Hono.

Separate Fly apps for the agent runner, batch engine, paper engine, and live engine. Fly app secrets are available to every Machine in that app; process groups alone are therefore not a credential boundary. Live broker keys must never be installed in a batch or agent app.

An agent receives only the approved research bundle and model access required by its execution profile. Keep host service credentials out of the child process environment. Batch compute receives read-scoped inputs and an attempt-scoped result route. Deploy tokens remain outside all product runtimes.

Fly root disks are ephemeral. Treat them as scratch space. A Fly Volume may support a bounded crash-recovery journal when required, but it is not a second canonical portfolio database. Volumes are host-local and not automatically replicated; snapshots do not replace tested recovery.

## 6. Native runtime policy

Start with fixed, bounded execution capacity. Keep the batch consumer running while the service is enabled. Poll with backoff when idle. Add scale-to-zero only when a tested wake-up path exists; an outbound queue poll cannot wake a stopped process.

Paper and live profiles must not use HTTP-idle autostop. Their workload is a persistent market session, not incoming web traffic. Fly configuration exposes lifecycle and resource controls; choose and test them per profile rather than inheriting web-app defaults.

Use one active live writer per broker account. Restart begins with reconciliation. Before a replacement can submit orders, stop or isolate the old writer and establish current ownership. Generic rolling, canary, or blue/green traffic switching is not sufficient evidence of single-writer safety.

Keep one explicit region per profile initially. Select it using the chosen data, database, and broker requirements. Do not invent a latency guarantee or automatically relocate a live account. Separate compute resources keep batch work from delaying paper/live supervision.

## 7. Data and protocol contracts

[Trading domain](02-trading-domain-and-evaluation-spec.md) owns record meaning, accounting, lifecycle, and risk. Postgres stores structured records and append-oriented audit. R2 stores immutable datasets, reports, checkpoints, and model artefacts with content hashes. The Strategy Graph is a generated relational view.

Canonical market types include Instrument, Bar, Quote, Trade, CorporateAction, TradingCalendar, and DatasetManifest. Preserve event time, availability time, source, instrument identity, and dataset version. Normalise provider payloads behind an adapter. A strategy must not depend on a provider-specific payload.

Schemas for strategies, evaluation requests/results, market events, and command/mandate envelopes live in `packages/api-contracts/schemas`. Agent output schemas live in `packages/agents/schemas`. Reference them rather than duplicating them.

Every wire envelope identifies its schema version. Incompatible changes require a new version. Reject unknown mandatory fields and unsupported semantics. Generate language bindings from the schemas. Validate at runtime in both TypeScript and Rust using the same valid and invalid fixtures.

Prices, quantities, and money use explicit decimal strings. The Rust core owns calculation and rounding. Statistical tolerances are declared per metric. The UI formats official values; it does not recompute them.

Hono route inference can supplement TypeScript typing. It does not replace runtime validation or define Rust's contract.

Evaluation input identity binds strategy, engine, data, cost model, policy, suite, and seed. Result identity also binds the logical run, current attempt, ownership revision, and actual executable digest. Verify these before accepting an artefact.

## 8. Client runtime and notifications

The client runtime owns connection state, pending commands, focus state, local cancellation, and resynchronisation. React renders state and dispatches typed intent. It does not own a second durable fund lifecycle.

Notify only after the domain transaction commits. Send changed entity identifiers and revisions, not raw tick streams, arbitrary logs, or UI rendering instructions. The client fetches the affected authoritative snapshot.

Durable Objects own connections and short-lived subscription state. They do not own mandates, orders, approvals, or audit. On reconnect, missed notifications, or an unexpected revision, fetch current snapshots before allowing consequential actions.

Use one command path for Ink and non-interactive CLI use. JSON goes to stdout, diagnostics to stderr. Do not render Ink in machine mode. Sanitise terminal control sequences in untrusted text. Preserve exit-code and cancellation semantics in the CLI reference when implemented.

## 9. Authentication and authority

Use short-lived application credentials in the client. Authorise every action server-side. Separate environment, service, run, and account scope.

| Role | Intended capability |
| --- | --- |
| Viewer | Read authorised state. |
| Researcher | Create bounded research missions and evaluations. |
| Operator | Operate paper and shadow sessions. |
| Steward | Approve live mandates and consequential authority changes. |
| Administrator | Configure infrastructure; this role does not imply trading authority. |

An input phrase, prompt, client state, Fly Machine ID, or Durable Object ID grants no authority. Treat retrieved material, model output, and uploaded strategies as untrusted data. Restrict storage references and URLs to authorised sources.

Deploy credentials exist only in protected delivery jobs. Live broker credentials exist only in the live Fly app. Redact logs, traces, and errors. Do not pass host service credentials to the delegated model process.

## 10. Observability

Correlate request, mission, run, attempt, strategy, order, and deployment identifiers. Record queue age, lease expiry, evaluation duration, budget consumption, data freshness, reconciliation lag, and unknown broker outcomes.

Keep diagnostic logs separate from canonical audit. An alert acknowledges a condition; it does not resolve it. Bound event buffers and render updates. Do not log full sensitive prompts or private account payloads by default.

## 11. Build and deployment identity

Pin the Node, package manager, Rust, container base, and executor versions when their implementation is tested. Reuse one Rust library across batch, paper, shadow, live, and local replay. Processes share code, not credentials or account authority.

Release identity binds source SHA, CLI version, engine digest, behaviour hash, schema versions, migration level, and deployment references. [Engineering](06-engineering-delivery-and-operations-spec.md) owns CI, resource ownership, rollout, and read-back requirements.

## 12. Source migration

Adopts Repository Design v1.1 §§4, 6–9 and Design v2 §§12–14. The previous Tech Stack supplies retained data, identity, and telemetry concerns. It does not retain extra workflows, a provider router, a separate graph service, or the old top-level Rust layout.

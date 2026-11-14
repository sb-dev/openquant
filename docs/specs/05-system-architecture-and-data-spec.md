---
id: OQ-05
title: OpenQuant — System Architecture and Data
version: 1.4.0
status: canonical
updated: 2026-11-14
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
| `packages/agents` | Role behaviour, skill modules and method notes, role request/result schemas, assembly/parsing, evaluation cases, release identity. |
| `packages/quant-core` | Shared signals, simulation, accounting, portfolio, risk, and metrics. |

API-only domain, application, database, configuration, and telemetry modules remain inside `apps/api` until another consumer needs them. The only SQL migration owner is `apps/api/migrations`.

List TypeScript packages explicitly in the pnpm workspace. Do not give Rust an npm wrapper just to put Cargo into the JavaScript task graph. Commit generated pnpm and Cargo lockfiles when their executable packages exist.

Create an executable package only when its checkpoint supplies working code and verification. Directory guides reserve ownership during bootstrap; they are not completed services.

Boundary checks reject API implementation imports in Ink, Node subprocess code in Worker bundles, and broker code in the agent runtime. Domain modules do not import Cloudflare bindings.

Skill registration and schema exports in `packages/agents`, and everything they import, build for Workers without Node-only code. ResearchWorkflow calls a skill's request assembly after selecting the bundle and evidence. The guarded API calls its result parsing before its own authority and acceptance checks. Neither function dispatches or waits for a model process. Runner clients and process control stay in `apps/agent-runner`. A later evidence tool calls a guarded attempt-scoped API route; SEC and Tavily adapters remain in `apps/api`.

## 3. Durable product workflows

**ResearchWorkflow:** reserve the mission budget, invoke competing proposer configurations, register candidates, invoke independent criticism, and request bounded evaluations. It records every attempt and uses controlled revisions.

**EvaluationWorkflow:** freeze the strategy/data/policy manifest, request engine work, verify the returned artefacts, and record official evidence. Numerical success and promotion eligibility remain separate.

In S1 the batch path runs four typed jobs: `retrieve`, `validate`, `evaluate` and `assess`. Only `evaluate` produces a numerical run result. `assess` writes the gate report from official results, the registered cohort policy and the evaluation plan (OQ-02 §3.6). The transition table in §4 defines the states and transitions of jobs, runs, attempts, leases, budget reservations and outbox entries. A command, workflow or worker can make only a listed transition; any other is rejected.

Both workflows accept the mission scope defined by OQ-02 §1.1. Per-stock missions retain their own findings and outcomes. A strategy-level mission uses immutable references to required findings and proposes a whole-watchlist policy. Its EvaluationWorkflow submits each candidate's joint evaluations through the existing batch path. Each Rust run owns the strategy ledger and common event sequence for its registered scenario. Separate stock results are diagnostics, not a substitute for this run. No additional service, workflow class or numerical engine is required.

Mandate approval, rejection, acknowledgements, and policy changes are ordinary version-checked commands. They do not need one workflow class each. Cloudflare's Workflow API provides the orchestration boundary; application records remain authoritative for domain state.

Cloudflare schedules trigger product work and recovery. Market calendars and stored schedule slots determine whether work is due. A repeated trigger cannot create another run for the same logical slot. Persistent paper/live feeds run on Fly.io, not in GitHub Actions or one Workflow step per tick.

### 3.1 Watchlist cycle dispatch

Use a stable schedule ID plus logical calendar slot as the uniqueness key. Atomically freeze profile/watchlist versions and reserve the cycle budget before dispatch. Editing a profile does not permit a second automatic cycle for the same slot. An explicit rerun has its own identity, reason and budget and remains linked to the original slot.

Freeze allocations for each stock and for joint strategy work under the same cycle/period caps. Persist links from the cycle to each mission and candidate evaluation. Materialise one bounded evidence manifest from required completed findings, source snapshots and explicit optional failures before joint dispatch. Required missing inputs block the dependent work with a reason; other stock outcomes remain intact. Do not silently remove a stock or create a different universe. Retry and recovery reuse the frozen dependencies and logical identities. New evidence or membership requires a new recorded input/trial.

Store timezone, calendar version, session, data-ready deadline, freshness threshold, overlap policy and catch-up limit. The initial policy runs one active cycle per schedule, defers within the freshness deadline, records missed/expired slots, and dispatches only the latest eligible missed slot on recovery. Do not create unbounded historical backlogs. Pause prevents new cycles from starting but lets already active cycles dispatch their remaining bounded work and finish; cancellation explicitly targets active work. Resume applies the same catch-up policy. Missing/stale data and insufficient budget produce visible coverage reasons without inventing run-status enum values.

## 4. Dispatch, ownership, and completion

Create the run, budget reservation, and dispatch-outbox entry in one database transaction. Retain one batch queue for quantitative jobs. Queue messages contain input references, not whole datasets. Do not put live orders, halts, or raw market ticks on this queue.

The batch host pulls work through the Cloudflare Queues HTTP API using HTTP POST. Configure an HTTP-pull consumer; do not also attach a push consumer. Verify the pinned integration against the provider contract during the deployment probe.

A batch worker must claim the logical attempt through a guarded application endpoint before executing it. Use an application lease and revision separately from the queue receipt. Accept completion only from the current owner. A redelivered message cannot authorise duplicate official results.

Acknowledge work after its terminal result is committed. Long evaluations must be bounded or checkpointed to fit the documented visibility window. If visibility expires, the run record and recovery task decide whether to resume or fence a new attempt. Do not rely on the queue lease alone or assume an unlimited visibility extension.

A `job-dispatch/1` message names one job kind and carries references only. A worker claims the attempt with `attempt-claim/1`. A successful claim returns an attempt-scoped capability that expires with the lease (§9). When a worker dies or its lease expires, recovery fences a new attempt of the same logical run or job up to the declared attempt cap. Each attempt has its own budget reservation. The run or job is `FAILED` only when the cap is exhausted or the failure is not retryable. Cancellation gives `CANCELLED`. OQ-02 §3.6 maps numerical outcomes to run status and gates.

ResearchWorkflow uses authenticated HTTPS to submit an existing attempt ID to the Fly agent-runner. The host must obtain a durable claim through the control API before returning acceptance or starting the tool. It then returns promptly; the Workflow observes stored status through bounded polling. A timed-out dispatch is checked under the same ID, not blindly respawned. This path needs no second queue initially.

Upload immutable results first. Verify schema, input hashes, running engine/executor identity, and attempt ownership before committing the official result. A stale worker may leave an unreferenced artefact; it cannot replace accepted evidence. Notify clients only after commit. Recovery finds missing dispatches and expired attempts even when no client is connected.

For a provider run, the Rust `evaluate` job builds the inner evaluation input from the frozen dataset manifest and the evaluation request. It uploads that input and reports its hash in the evaluation submission. Before acceptance, the API checks that the input's windows, information cutoff and policy equal the request, and that every hash binds. The Worker passes references only.

S1 uses these state values, which `connected-common` defines. Run status is the OQ-02 §3.6 enum, and an `evaluate` job is a run. A `retrieve`, `validate` or `assess` job uses the same five values but is not a run. An agent attempt uses the attempt, lease, reservation and outbox rows; its logical run is not an evaluation run (OQ-02 §1). An attempt is `PENDING`, `CLAIMED`, `COMPLETED`, `FAILED`, `LEASE_EXPIRED` or `CANCELLED`. A lease is `HELD`, `RELEASED` or `EXPIRED`. A budget reservation is `RESERVED`, `SETTLED`, `UNRECONCILED` or `RELEASED`. An outbox entry is `PENDING`, `SENT` or `CANCELLED`. Each durable write in the table is one transaction with its audit record.

| State | Event | Precondition | Durable write | External effect | Retry | Recovery |
|---|---|---|---|---|---|---|
| None | `APPROVED` `DRAFT` → `EVALUATING` Decision (D and V runs), `freeze_candidates` (H runs), or a workflow step that needs a job or agent attempt | Approved policy; mission `IN_PROGRESS`; budget available, else the mission becomes `BLOCKED`; expected revisions match | Run or job `QUEUED`; attempt `PENDING`; reservation `RESERVED`; outbox `PENDING` | None | The same command ID returns the first result | None |
| Outbox `PENDING` | Dispatcher send | Attempt still `PENDING` | Outbox `SENT` | `job-dispatch/1` on the batch queue, or `agent-dispatch/1` to the agent runner | A failed send stays `PENDING` and is sent again under the same attempt ID | Recovery sends entries left `PENDING` |
| Attempt `PENDING` | Claim with `attempt-claim/1` | Current attempt of an open run or job | Attempt `CLAIMED`; lease `HELD` with its expiry; run or job `RUNNING` | Grant with an attempt-scoped capability that expires with the lease | A second claim is refused; a lost grant is recovered by the lease-expiry row | None |
| Attempt `CLAIMED` | Result submission | Caller holds the current lease and ownership revision; schema, hashes and identities bind | Attempt `COMPLETED` with its accepted result, or `FAILED` with its failure code or agent outcome; lease `RELEASED`; run or job status by OQ-02 §3.6 | The batch worker acknowledges the queue message; clients are notified | The same submission returns the stored result. After a retryable `FAILED` attempt below the attempt cap, a new attempt `PENDING` with its own reservation and outbox entry | None |
| Attempt `CLAIMED` | Lease expiry | No result committed | Attempt `LEASE_EXPIRED`; lease `EXPIRED`. Below the attempt cap and retryable: a new attempt `PENDING` with its own reservation and outbox entry. Otherwise run or job `FAILED` | None | The new attempt is the retry | Scheduled recovery finds expired leases without a client |
| Attempt `LEASE_EXPIRED` | Late submission | None | Rejection recorded; nothing else changes | `api-error/1` with `STALE_OWNERSHIP` | None | None |
| Reservation `RESERVED` or `UNRECONCILED` | Usage report, or the attempt ends without one. After lease expiry or cancellation of a claimed attempt, only once termination is confirmed | None | `SETTLED`: the reported usage replaces the reservation and the remainder returns to the budget. Without a report, `UNRECONCILED`: the full amount counts as spent | None | None | Recovery reconciles `UNRECONCILED` reservations |
| Run or job `QUEUED` or `RUNNING` | `cancel_mission` | Researcher; no result committed yet. A result committed first wins | Mission `WITHDRAWN`; run or job `CANCELLED`; outbox `PENDING` becomes `CANCELLED`; a `PENDING` attempt `CANCELLED` with its reservation `RELEASED`; a `CLAIMED` attempt `CANCELLED`, keeping its reservation until termination is confirmed | Cancellation request to the worker or runner | None | A later submission from a cancelled attempt is rejected |

## 5. Storage, networking, and credentials

Neon stores canonical missions, versions, runs, decisions, mandates, accounting, order history, and audit records. R2 stores immutable inputs, reports, and checkpoints. Hyperdrive caching is disabled for private application reads initially.

There is one SQL migration owner: `apps/api/migrations`. Cloudflare uses Hyperdrive. Fly engine processes that own accounting use bounded Postgres connections and narrow service roles, not a Worker binding or a second database. Batch and agent hosts use scoped input/result endpoints where no direct database authority is required.

Use authenticated TLS connections across the Cloudflare/Fly boundary. Service credentials bind the caller to permitted operations, environment, and run/account scope. Do not assume Cloudflare can reach Fly private DNS without an explicitly configured network bridge. The TUI still accesses private application state only through Hono.

Separate Fly apps for the agent runner, batch engine, paper engine, and live engine. Fly app secrets are available to every Machine in that app; process groups alone are therefore not a credential boundary. Live broker keys must never be installed in a batch or agent app.

An agent receives only the approved research bundle and model access required by its execution profile. Keep host service credentials out of the child process environment. Batch compute receives read-scoped inputs and an attempt-scoped result route. Deploy tokens remain outside all product runtimes.

In S1 the batch and agent-runner apps upload artefacts through attempt-scoped Hono routes. The Worker verifies their content hashes and writes content-addressed R2 keys. These apps hold no R2 or database credentials. The batch app holds one dedicated Cloudflare Queues consumer token with the minimum scope for pull and acknowledgement; record that scope.

The batch app also holds the market-data credentials used by §7.1 retrieval jobs. Every Machine in that app can access those app secrets, including evaluation Machines. Treat the entire app as one trusted credential boundary. Its deployment profile permits bounded outbound retrieval only to approved provider endpoints and required application input/result services. Record and verify the endpoint and redirect restrictions. Do not rely on process groups to isolate retrieval credentials.

In S1 one egress module is the only HTTP client in the batch binary. It uses HTTPS only, follows no redirects and permits only listed host, method and path combinations: `data.alpaca.markets` for daily bars, the minute bars of the session probe and corporate actions; `paper-api.alpaca.markets` for reads of the account, calendar and asset; the Cloudflare Queues pull and acknowledgement paths on `api.cloudflare.com`; and the application API host. Add operating-system enforcement inside the Machine where Fly supports it; this support is not yet verified. The S1 egress evidence is this allowlist plus a deployed probe that tries a host outside the list and a cross-host redirect, and records both refusals. The authority probe runs as a one-off Machine in the batch app. Its probe-only allowlist adds one account read on the live trading host `api.alpaca.markets` to record that the host rejects the key. It makes no order call. If authority or egress cannot be verified, provider enablement stays blocked.

Batch credentials must carry no live order authority. For Alpaca, a paper-account credential is a candidate only if verified account authority and data entitlements satisfy the profile. A live-account trading key is prohibited even if the adapter calls only market-data endpoints. S1 must establish the selected credential's authority and entitlements without submitting an order. If suitable credentials or access restrictions cannot be verified, block provider enablement. Keep secrets out of probe evidence and logs. This preserves R10.

Fly root disks are ephemeral. Treat them as scratch space. A Fly Volume may support a bounded crash-recovery journal when required, but it is not a second canonical portfolio database. Volumes are host-local and not automatically replicated; snapshots do not replace tested recovery.

## 6. Native runtime policy

Start with fixed, bounded execution capacity. Keep the batch consumer running while the service is enabled. Poll with backoff when idle. Add scale-to-zero only when a tested wake-up path exists; an outbound queue poll cannot wake a stopped process.

Paper and live profiles must not use HTTP-idle autostop. Their workload is a persistent market session, not incoming web traffic. Fly configuration exposes lifecycle and resource controls; choose and test them per profile rather than inheriting web-app defaults.

Use one active live writer per broker account. Restart begins with reconciliation. Before a replacement can submit orders, stop or isolate the old writer and establish current ownership. Generic rolling, canary, or blue/green traffic switching is not sufficient evidence of single-writer safety.

Keep one explicit region per profile initially. Select it using the chosen data, database, and broker requirements. Do not invent a latency guarantee or automatically relocate a live account. Separate compute resources keep batch work from delaying paper/live supervision.

## 7. Data and protocol contracts

[Trading domain](02-trading-domain-and-evaluation-spec.md) owns record meaning, accounting, lifecycle, and risk. Postgres stores structured records and append-oriented audit. R2 stores immutable datasets, reports, checkpoints, and model artefacts with content hashes. The Strategy Graph is a generated relational view.

Canonical market types include Instrument, Bar, Quote, Trade, CorporateAction, TradingCalendar, and DatasetManifest. Preserve event time, availability time, source, instrument identity, and dataset version. Normalise provider payloads behind an adapter. A strategy must not depend on a provider-specific payload.

Schemas for strategies, evaluation requests/results, market events, and command/mandate envelopes live in `packages/api-contracts/schemas`. Agent role request/result schemas live in `packages/agents/schemas` as JSON Schema. They reference the exact versioned strategy and evaluation schemas in `packages/api-contracts/schemas` with `$ref`. Build tooling bundles those references into the complete schema supplied to the model. A missing reference, unsupported construct or model-schema incompatibility fails the build or probe; never replace it with an unconstrained schema. Skill-local tool input/output schemas arrive with the first S3 tool. They use strict Zod objects. They contain no embedded financial subdocuments and accept authorised references instead; a tool that needs an embedded financial document first extends this policy. Export each tool schema supplied to the model in its matching input or output direction. The exported schema and the runtime parser both reject unknown fields and never coerce, default or strip values, and parity tests cover the pinned exporter. Reference these owners rather than duplicating them.

Every wire envelope identifies its schema version. Incompatible changes require a new version. Reject unknown mandatory fields and unsupported semantics. Generate language bindings from the schemas. Validate at runtime in both TypeScript and Rust using the same valid and invalid fixtures.

S1 adds connected envelopes as a contract set separate from the engine-scope contracts (strategy artefact, evaluation input and result, checkpoint and their common definitions). Envelopes are outside engine identity (OQ-02 §7). Envelope-only codes, such as stale ownership, live in one shared connected-common schema, and every definition name stays unique across all schemas. One protocol manifest lists the fixtures of both sets. New entries are additive, and an entry whose verdict depends on attempt ownership declares that attempt context. The S1 envelopes are:

- `evaluation-plan/1`: the registered comparison of one mission (OQ-02 §3.1). Evaluation requests and the assessment job refer to it by its digest.
- `evaluation-request/1`: the outer request for one run. Every request binds the required engine digest and operator set, method identity, strategy reference, run, attempt and ownership revision. Mode `BACKTEST` pairs only with a provider dataset manifest. It also binds the profile revision, cohort policy, suite, evaluation plan, dataset-manifest digests and windows. Mode `REPLAY` pairs only with an evaluation-input reference and replay conditions. It needs no profile or cohort policy and serves the synthetic S0 replay. The deterministic repeat of a provider D run is a `BACKTEST` that names the original run as the run it repeats.
- `evaluation-submission/1`: the worker's claim of a result. It binds the actual executable digest, the result reference and digest, and the mode `REPLAY` or `BACKTEST`.
- `job-dispatch/1` (kinds `retrieve`, `validate`, `evaluate` and `assess`; references only) and `attempt-claim/1`.
- `command/1`: a guarded command with its client command ID and expected revision.
- `research-profile/1`, `cohort-policy/1` (it names its suite), `dataset-manifest/1`, `retrieval-request/1` and `retrieval-result/1`.
- `validation-result/1`, `evaluation-metrics/1` and `gate-report/1`: derived evidence. Each binds method identity.
- `agent-dispatch/1` and `agent-attempt-result/1`: host-side agent envelopes (OQ-03 §4). The model never receives them.
- `api-error/1`: the error body of every route.
- `release-manifest/1`: the release identity that `deploy.yml` records through an Administrator-only route (§11; OQ-06 §3).

The route manifest `packages/api-contracts/routes/v1.json` lists the API routes and the envelopes that each route accepts and returns. `evaluation-input/1` keeps its tag; a provider source value is its only S1 change (OQ-02 §7). Multi-instrument input for S4 needs `evaluation-input/2`. A test pins the SHA-256 of each engine-scope schema. Any content change to one of them needs a new version tag or an explicit A18 compatibility decision.

TypeScript validation follows the Rust contract layer in the same order: version check; strict JSON, where duplicate keys and non-integer numbers give `SCHEMA_VIOLATION` and integers with a magnitude above 2^53 − 1 are rejected; schema; the decimal and `Exact` patterns, which give `INVALID_DECIMAL`; the 80-character `Exact` limit; structural limits; and the canonical SHA-256 digest. TypeScript treats `Exact` as an opaque string. Semantic checks stay in Rust: a payload that passes the TypeScript parse but carries a Rust semantic code is a deferred case, and the parity test asserts the number of deferred cases. For every other shared fixture, TypeScript and Rust give the same verdict, and the same digest for a valid payload.

Prices, quantities, and money use explicit decimal strings. One exception keeps recovery exact: a checkpoint may carry a position's entry price, stop, target, snapshot or scheduled stop, or a pending entry's snapshot, as a reduced fraction `n/d` when the value has no decimal form of at most 28 fractional digits that fits 96 bits. Result views and every other contract keep decimal strings. The Rust core owns calculation and rounding. Statistical tolerances are declared per metric. The UI formats official values; it does not recompute them.

Hono route inference can supplement TypeScript typing. It does not replace runtime validation or define Rust's contract.

Evaluation input identity binds strategy, watchlist/profile versions, engine/operator compatibility, per-instrument dataset manifests, calendar, warm-up/scored windows, information cutoff, initial capital, execution/cost policy, suite, and seed. Result identity also binds the logical run, current attempt, ownership revision, and actual executable digest. Verify these before accepting an artefact.

Joint market events carry session/phase, availability times, instrument identities and explicit coverage. Checkpoints bind that event cursor to positions, cash, reservations, pending entries and scheduled stop changes. Results expose joint ledger/metrics, per-stock contributions, selection/skipped-entry diagnostics and incomplete coverage. Generate cross-runtime bindings and valid/invalid fixtures from the existing schema owners. No provider payload or agent score bypasses the reviewed strategy operators. OQ-02 §§2–3 owns the numerical and event-order rules.

### 7.1 Pluggable data and research providers

Use three capability-specific interfaces. Register adapters in code and select them through a versioned research profile. Adding an adapter must not require provider branches in research workflows. This is data-source selection; the delegated model executor remains governed by OQ-03 and is not a new model router.

| Interface | Initial adapters | Host and operations |
| --- | --- | --- |
| `MarketDataProvider` | `alpaca`, `massive` | Rust adapters in `apps/engine`; instrument mapping, historical bars and declared corporate-action/calendar capabilities. |
| `CompanyFilingsProvider` | `sec-edgar` | TypeScript adapters in `apps/api`; filing discovery, document retrieval and filing-linked financial facts. |
| `WebResearchProvider` | `tavily` | TypeScript adapters in `apps/api`; search and bounded content extraction. |

Keep provider SDKs, authentication, endpoint conventions and pagination inside adapters. `packages/quant-core` consumes validated inputs and never calls providers. Language-neutral request/result schemas remain in `packages/api-contracts`; internal interfaces live beside their hosts. No new shared package, plugin loader, service or workflow class is required.

| Contract | Required behaviour |
| --- | --- |
| Capabilities | Declare operations, markets, history, feed coverage, frequencies, sessions, adjustments, time precision and revision/as-of limitations. Check account entitlements before dispatch; reject unsupported semantics explicitly. |
| Request | Bind logical request/attempt, profile revision, stable instrument mapping, range/cutoff, operation, semantic settings, limits and cancellation/deadline. Provider defaults must not choose financial semantics. |
| Result | Return normalized typed data plus manifest/source references, requested/returned coverage, completeness, source IDs, adapter/transformation identity, usage and timestamps. Distinguish no observations, partial retrieval and failure. |
| Errors | Separate authentication, permission/entitlement, rate limit, timeout, unavailable data, unsupported capability, malformed response and cancellation. Retry only classified transient failures within the same bounded policy; preserve every billed attempt. |
| Persistence | Freeze validated snapshots before evaluation. Retain permitted original payloads and transformation identity. Cache keys include provider/feed, all semantic inputs, cutoff and revision; never share across incompatible profiles. |

Market retrieval executes as a bounded job in the existing batch host. The API sends a guarded retrieval request through the existing batch dispatch path, receives the validated manifest and records it before evaluation. The Rust normaliser writes the availability time of every bar and every corporate action into that manifest, under the profile's declared availability rules. A retrieval job does not become an official numerical result. Market credentials reside only in the owning host and are absent from model subprocesses. SEC/Tavily calls remain bounded API-owned I/O, with permitted large artefacts stored in R2. The research workflow assembles approved evidence references before agent dispatch.

Enforce request/credit and aggregate budgets outside adapters. Apply provider/account rate limits across concurrent jobs, bounded pagination, request timeouts and cancellation. Preserve `Retry-After` when present. Do not retry authentication or unsupported-capability errors as transient failures. Unknown billed usage stays reserved. Redact keys, raw credentials and sensitive query content from telemetry.

SEC access follows its declared-client and fair-access requirements. Web extraction accepts only permitted public HTTP(S) targets; validate redirects and reject internal/private addresses. Treat retrieved instructions as untrusted data. Generated answers and snippets never replace original evidence.

Switch providers only for future cycles or explicit new comparisons. Initial automatic fallback is disabled. For comparison, issue separate requests with aligned feed/session/adjustment semantics, preserve both results and report differences. Never splice the responses into a single unlabelled dataset. [Provider reference](../reference/service-providers.md) and [comparison guide](../guides/provider-comparison.md) track integration details and verification limits.

## 8. Client runtime and notifications

The client runtime owns connection state, pending commands, focus state, local cancellation, and resynchronisation. React renders state and dispatches typed intent. It does not own a second durable fund lifecycle.

Notify only after the domain transaction commits. Send changed entity identifiers and revisions, not raw tick streams, arbitrary logs, or UI rendering instructions. The client fetches the affected authoritative snapshot.

Durable Objects own connections and short-lived subscription state. They do not own mandates, orders, approvals, or audit. On reconnect, missed notifications, or an unexpected revision, fetch current snapshots before allowing consequential actions.

S1 adds no Durable Object. The client polls with bounds and reads authoritative state back. This is a recorded S1 limitation, not a change to the notification design.

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
| Service principal | Batch, runner, workflow or deploy identity. Only the operations listed for it in its environment. No trading authority. It may reserve within an existing budget, and may record a policy-determined Decision only under an approved policy (OQ-02 §1). It cannot approve a policy, create or enlarge a budget, or change a limit. |

The application issues its own tokens. In S1 a person's application credential exchanges for a 15-minute access token through `openquant login`. Service principals hold environment- and operation-scoped credentials. A successful attempt claim returns an attempt-scoped capability that expires with the lease. S1 uses the Viewer, Researcher, Steward and Administrator roles and service principals; Operator arrives with paper sessions. A coding agent session holds at most a Viewer credential.

An input phrase, prompt, client state, Fly Machine ID, or Durable Object ID grants no authority. Treat retrieved material, model output, and uploaded strategies as untrusted data. Restrict storage references and URLs to authorised sources.

Deploy credentials exist only in protected delivery jobs. Live broker credentials exist only in the live Fly app. Redact logs, traces, and errors. Do not pass host service credentials to the delegated model process.

## 10. Observability

Correlate request, mission, run, attempt, strategy, order, and deployment identifiers. Record queue age, lease expiry, evaluation duration, budget consumption, data freshness, reconciliation lag, and unknown broker outcomes.

Keep diagnostic logs separate from canonical audit. An alert acknowledges a condition; it does not resolve it. Bound event buffers and render updates. Do not log full sensitive prompts or private account payloads by default.

## 11. Build and deployment identity

Pin the Node, package manager, Rust, container base, and executor versions when their implementation is tested. Reuse one Rust library across batch, paper, shadow, live, and local replay. Processes share code, not credentials or account authority.

Release identity binds source SHA, CLI version, engine digest, image and binary digests, behaviour hash, method identity (OQ-02 §7), schema versions, migration level, and deployment references. [Engineering](06-engineering-delivery-and-operations-spec.md) owns CI, resource ownership, rollout, and read-back requirements.

## 12. Source migration

Adopts Repository Design v1.1 §§4, 6–9 and Design v2 §§12–14. The previous Tech Stack supplies retained data, identity, and telemetry concerns. It does not retain extra workflows, a provider router, a separate graph service, or the old top-level Rust layout.

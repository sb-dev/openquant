# OpenQuant — Source Repository Design Specification

**Version:** 1.1  
**Date:** 19 October 2026  
**Status:** Proposed repository design; not an implemented scaffold  
**Product baseline:** OpenQuant Design Specification v2  
**Reference revision:** `sb-dev/kakeibo@75443233c474a2a4072348078c22d72d15573645`
**Revision scope:** Retain Fly.io for native execution and persistent engine sessions. Supersede v1.0's Cloudflare Containers proposal. The Kakeibo review is carried forward from v1.0; it was not repeated for this hosting revision.

## 1. Decision

Use one monorepo with Kakeibo's top-level organisation. Adapt its applications and packages to OpenQuant rather than copying its mobile product or every reserved package.

```text
GitHub Actions   → validate, build, review, release, and deploy the repository
Cloudflare      → coordinate OpenQuant's durable product tasks
Fly.io          → run native executors and persistent engine sessions
Ink             → operate the product through typed commands and views
Rust            → evaluate strategies and enforce trading rules
Neon + R2       → retain canonical records and immutable artefacts
```

Keep the complete research-to-capital loop from Design v2. Retain proposer and critic roles, independent evaluation, paper competition, shadow validation, portfolio allocation, governed live execution, and automatic monitoring. This document changes their source organisation and hosting integration, not their financial meaning.

**Repository automation must not become the trading runtime. Product agents must not become repository administrators.**

The application code, prompts, schemas, tests, deployment definitions, and public material belong in the same repository. Production data, credentials, active account mandates, and licensed datasets do not.

## 2. What the Kakeibo review established

The review covered the complete recursive tree at the pinned revision, all seven canonical specifications, root policies, contribution templates, directory guides, and the two reachable commits. The tree contains **65 tracked files: 37 non-empty files and 28 empty `.gitkeep` files**. The Git tree response was not truncated. Appendix A records the coverage. [K1–K5]

Kakeibo is a **pre-implementation scaffold**. Its README and changelog say so. Its application, package, infrastructure, and workflow directories contain placeholders. There is no executable application, test suite, package manifest, or GitHub Actions workflow to inherit or run. [K1, K2]

| Reference finding | OpenQuant adaptation |
|---|---|
| `apps/`, `packages/`, `docs/`, `academy/`, `blog/`, `fixtures/`, `infra/`, `.github/` form the project structure. | Keep these roots. Add only `scripts/` for reusable repository tooling. |
| Seven numbered specifications assign authority by subject. | Keep seven owners, adapted to quant, model execution, and Ink. |
| The domain owns financial truth; the assistant produces bounded interpretation. | Rust owns numerical results and risk. Models propose strategies and criticism. Application code owns accepted state changes. |
| AI behaviour has versioned source, tests, release identity, and rollback. | Version the proposer/critic bundle separately from the executor and engine. |
| Tests, examples, and public explanations reuse synthetic fixtures. | One example pack supplies the real engine demo, regression tests, and published result. |
| The public service and independent deployments use one codebase. | Support one Cloudflare + Fly.io managed architecture, with an offline fixture demo rather than a second production backend. |
| The spec index does not match several document headers. The assistant spec also has conflicting header/footer versions. | Store version metadata once. Generate the index and check it in CI. |
| `REPOSITORY_TREE.txt` misrepresents nesting and repeats an entry. | Generate it from tracked paths. Reject drift in CI. |
| Some specifications refer to legacy implementation that is absent from this revision. | Mark inherited statements as reference material. Do not invent migration code or claim compatibility with missing source. |
| Security reporting and provider configuration remain placeholders. | Treat operational configuration as an explicit deployment gate, not a completed control. |

Do not import Kakeibo's budgeting rules, Kei persona, Expo/EAS/Maestro stack, subscription model, Meta conversion pipeline, or analytics database extensions. They solve a different product's needs.

## 3. Source authority and deliberate changes

Use the current user direction: Cloudflare remains the product control and orchestration platform; Fly.io remains the execution host where native processes or persistent sessions require it. Use OpenQuant Design v2 for product and safety semantics. Use the Ink UX/UI specification with the v2 navigation and outcome corrections. Use the Ink production guide for terminal engineering. [S1–S3]

The AICaaS attachment separates mostly I/O-bound orchestration from native and sustained CPU workloads. Its Fly.io extension and HTTP-pull queue bridge remain the reference pattern. Its illustrative limits, costs, provider resources, and API calls are not adopted without current verification. The attachment does not replace Ink with React Router or permit direct database access from the terminal. [S4, §§2, 8, 11]

The Pactwright execution attachment supplies delegation and guarded mutation. It is a dated research log, not a current CLI compatibility test. A delegated CLI needs a process host even when much of its elapsed time is model/API wait. This is why the initial Node-based executor belongs on Fly.io; it is not a reason to move ordinary API or Workflow I/O there. [S5, §§3–5, 10]

Three decisions apply:

1. **Hosting:** retain Cloudflare Workers, Workflows, notification Durable Objects, Queues, Hyperdrive, and R2. Use Fly.io for the native Rust engine and delegated Node executor. Do not maintain a parallel Cloudflare Containers execution path.
2. **Execution:** implement one delegated `AgentExecutor` for proposer and critic work. The initial adapter uses Claude Code, following the attached reference. Do not build a provider-selection platform.
3. **Layout:** move the earlier top-level `rust/` and `website/` into Kakeibo-style `apps/` and `packages/`. Consolidate small API-only libraries into API modules.

Fly Machines provide an API/CLI-managed VM host, and Cloudflare Queues supports HTTP-pull consumers outside Workers. These documented capabilities support the proposed integration. They do **not** establish OpenQuant performance, broker suitability, or unattended executor reliability. Section 12 defines the required deployment evidence. [W1, W8]

## 4. Repository layout

This is the target structure. Create an executable package only when its checkpoint supplies working code and tests. Do not add dozens of empty packages to make the repository look complete.

```text
openquant/
├── README.md
├── AGENTS.md
├── LICENSE
├── SECURITY.md
├── CONTRIBUTING.md
├── CODE_OF_CONDUCT.md
├── TRADEMARKS.md
├── CHANGELOG.md
├── REPOSITORY_TREE.txt                 # generated from tracked files
├── package.json
├── pnpm-workspace.yaml
├── pnpm-lock.yaml
├── turbo.json
├── tsconfig.base.json
├── Cargo.toml                         # workspace: engine + shared core
├── Cargo.lock
├── rust-toolchain.toml
├── .gitignore
│
├── apps/
│   ├── README.md
│   ├── cli/                           # TypeScript, React, Ink
│   │   ├── src/
│   │   │   ├── index.tsx
│   │   │   ├── screens/
│   │   │   ├── components/
│   │   │   ├── application/           # local presentation/session runtime
│   │   │   ├── input/
│   │   │   └── rendering/
│   │   ├── tests/
│   │   └── package.json
│   ├── api/                           # Hono + Cloudflare control application
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   ├── routes/
│   │   │   ├── domain/                # lifecycle, budgets, authority
│   │   │   ├── application/           # commands, queries, guarded writes
│   │   │   ├── workflows/             # ResearchWorkflow, EvaluationWorkflow
│   │   │   ├── durable-objects/       # notifications only; no container controllers
│   │   │   └── infrastructure/        # Postgres, R2, auth, telemetry adapters
│   │   ├── migrations/                # sole owner of application SQL migrations
│   │   ├── tests/
│   │   ├── wrangler.jsonc
│   │   └── package.json
│   ├── agent-runner/                  # Fly.io Node host; delegates to one tool
│   │   ├── src/
│   │   ├── tests/
│   │   ├── Dockerfile
│   │   └── package.json
│   ├── engine/                        # Fly.io Rust host; also builds local demo binary
│   │   ├── src/
│   │   │   ├── bin/
│   │   │   ├── market_data/
│   │   │   ├── brokers/
│   │   │   └── persistence/
│   │   ├── tests/
│   │   ├── Dockerfile
│   │   └── Cargo.toml
│   └── web/                           # Astro public site; not the trading UI
│       ├── src/
│       ├── tests/
│       ├── wrangler.jsonc
│       └── package.json
│
├── packages/
│   ├── README.md
│   ├── api-contracts/                 # public API and cross-runtime schemas
│   │   ├── schemas/
│   │   ├── src/
│   │   └── tests/
│   ├── api-client/                    # HTTP, events, reconnect, runtime validation
│   │   ├── src/
│   │   └── tests/
│   ├── agents/                        # behaviour source; not a provider router
│   │   ├── policy/
│   │   ├── roles/                     # proposer, critic
│   │   ├── skills/                    # only explicitly selected reusable guidance
│   │   ├── schemas/
│   │   ├── evals/
│   │   ├── release/
│   │   └── src/                       # request assembly and result parsing
│   └── quant-core/                    # one Rust library, not a service per module
│       ├── src/                       # signals, simulation, accounting, risk, metrics
│       ├── tests/
│       ├── benches/                   # engine throughput/memory benchmarks
│       └── Cargo.toml
│
├── docs/
│   ├── README.md
│   ├── specs/                         # seven authoritative owners; see §5
│   ├── research-logs/                 # rationale and imported reference sources
│   ├── getting-started/
│   ├── product/
│   ├── concepts/
│   ├── guides/                        # examples link to canonical fixture packs
│   ├── reference/                     # CLI, API, strategies, benchmarks, integrations
│   ├── architecture/
│   ├── deployment/
│   ├── contributing/
│   └── operations/
├── academy/
│   ├── README.md
│   ├── foundations/
│   ├── research/
│   ├── evaluation/
│   ├── portfolio/
│   ├── operations/
│   └── advanced-use/
├── blog/
│   ├── README.md
│   ├── openquant/
│   ├── research-and-evaluation/
│   ├── engineering-and-trust/
│   └── case-studies/
├── fixtures/
│   ├── market-data/
│   ├── example-packs/                  # strategy + inputs + expectations + licence
│   ├── benchmark-packs/                # evaluation suites and fixed baselines
│   ├── agent-results/                  # explicitly recorded, never real-model proof
│   └── protocol/                      # shared valid/invalid TS and Rust messages
├── infra/
│   ├── README.md
│   ├── terraform/                     # Cloudflare infrastructure
│   ├── fly/                           # versioned Fly app configuration
│   │   ├── agent-runner.toml
│   │   ├── engine-batch.toml
│   │   ├── engine-paper.toml           # paper + shadow sessions at C3
│   │   └── engine-live.toml            # isolated live application at C4
│   └── environments/                  # non-secret profiles and binding metadata
├── scripts/
│   ├── check-repository.ts
│   ├── generate-repository-tree.ts
│   ├── check-contracts.ts
│   ├── verify-package.ts
│   └── verify-deployment.ts
└── .github/
    ├── ISSUE_TEMPLATE/
    ├── PULL_REQUEST_TEMPLATE.md
    ├── CODEOWNERS
    ├── dependabot.yml
    └── workflows/                     # responsibilities defined in §10
```

### Layout adaptations

`apps/mobile` becomes `apps/cli`. `packages/kei` becomes `packages/agents`, without a mascot or general chat application. Rust's shared library lives in `packages/quant-core`; its process entry points live in `apps/engine`.

Kakeibo's separate domain, application, database, validation, configuration, and observability package slots become modules inside `apps/api` while they have one consumer. Market-data and broker adapters live beside their Rust host. Terminal styling stays in `apps/cli` rather than creating a cross-web/mobile design-token package.

The Strategy Library and public Arena remain product surfaces. Their executable sources are example/benchmark packs; their catalogue and published reports are rendered through `apps/web`. This avoids parallel copies under several root directories. Large run artefacts stay in R2, with reviewed public manifests where publication is authorised.

## 5. Canonical specification set

Adopt Kakeibo's seven-owner model. Do not create seven overlapping restatements of Design v2.

| File under `docs/specs/` | Owns | Main source to migrate |
|---|---|---|
| `01-product-design-spec.md` | goals, operating loop, scope, human responsibilities | Design v2 product sections |
| `02-trading-domain-and-evaluation-spec.md` | strategy artefact, accounting, evaluation, portfolio, risk invariants | Design v2 domain and acceptance sections |
| `03-model-backed-execution-spec.md` | proposer/critic behaviour, delegation, permissions, budgets, result contract | Design v2 + Pactwright execution reference |
| `04-ink-ux-ui-spec.md` | screens, navigation, input, terminal states, confirmations | Ink UX/UI v1.1 with Design v2 corrections |
| `05-system-architecture-and-data-spec.md` | technology, hosting, module boundaries, persistence, protocols | Tech Stack v1 corrected by Design v2 and this plan |
| `06-engineering-delivery-and-operations-spec.md` | CI, releases, model evaluations, deployments, recovery | This plan's engineering sections |
| `07-open-source-project-organisation-spec.md` | public surfaces, contribution, licensing, publication | OpenQuant organisation plan corrected by Design v2 |

`docs/specs/README.md` states ownership and conflict resolution. Its version/status table is generated from each document's single metadata block. An implementation PR cites the owning section and its acceptance test. Research notes, README, and blog cannot override a canonical rule.

Retain imported references with origin, date, and content hash under research logs. Mark them non-canonical. Do not copy obsolete numerical examples, model flags, product names, or deployment claims into accepted requirements.

Migration must preserve the existing A01–A18 acceptance identifiers. A wording or directory change does not retire a requirement.

## 6. Code ownership and dependencies

### 6.1 Applications

**`apps/cli`** renders state and dispatches intent. Its local runtime owns navigation, focus, cancellation of local work, and connection state. The backend owns durable product workflows. Exiting Ink detaches the operator; it does not stop trading.

**`apps/api`** owns authenticated commands and queries, lifecycle rules, budget reservations, promotion decisions, and canonical writes. Keep routes thin. Domain modules do not import Cloudflare bindings; infrastructure adapters provide those bindings.

**`apps/agent-runner`** hosts a narrowly scoped delegated tool invocation. It receives a bounded request and returns a structured result. It has no repository-write, deployment, official-result-write, or broker capability.

**`apps/engine`** loads verified inputs, runs the Rust core, and adapts market data or broker events. Batch, paper, and live modes share source but use separate processes and permission profiles. The live Fly app, credentials, and deployment entry point are separate from routine API deployment.

**`apps/web`** publishes static public content and authorised result exports. It has no private database credential or direct connection to the operator event stream.

### 6.2 Shared packages

Keep four shared source packages initially:

| Package | Why it is shared |
|---|---|
| `api-contracts` | client, API, executor, and Rust wire validation need one schema source |
| `api-client` | Ink and non-interactive commands use the same transport and outcome handling |
| `agents` | production research and real-model evaluations use the same behaviour bundle |
| `quant-core` | historical replay, paper, shadow, live, and independent fixtures use one numerical implementation |

Agent output schemas live in `packages/agents/schemas`; general wire envelopes live in `packages/api-contracts/schemas`. Reference them rather than maintaining duplicate definitions.

Use Hono route inference for TypeScript request typing where useful. Validate external payloads at runtime. Generate type bindings from canonical schemas; never treat generated TypeScript types as Rust's wire contract. Cross-language tests consume the same valid and invalid message fixtures.

Prices, quantities, and monetary values use explicit decimal strings on the wire. Rust owns calculations and rounding rules. Statistical calculations have declared tolerances. The UI formats results; it does not recompute official returns.

### 6.3 Build boundaries

Use pnpm and Turborepo for TypeScript. Use a root Cargo workspace for `apps/engine` and `packages/quant-core`. Commit both lockfiles. Pin the Node, Rust, package-manager, container-base, and executor versions when implementation is tested.

List TypeScript packages explicitly in the pnpm workspace. Rust stays in the Cargo workspace. Fly deployment profiles live under `infra/fly`; no TypeScript container-controller package or npm wrapper around Rust is required.

Shared workflow scripts can invoke Cargo directly. Do not create fake npm packages solely to make Cargo appear in a JavaScript task graph. Run Rust and cross-language checks whenever their inputs change; initially running them on every PR is simpler and safer.

Boundary tests reject imports from the API implementation into Ink, Node subprocess code into Worker bundles, and broker code into the agent runtime. UI tests use explicit client fixtures, not alternate domain implementations.

## 7. Cloudflare orchestration and Fly.io execution

### 7.1 Workload placement

| Workload | Host | Reason for this design |
|---|---|---|
| Hono API, authoritative reads, guarded commands | Cloudflare Workers | Retain the selected public application boundary. |
| ResearchWorkflow and EvaluationWorkflow | Cloudflare Workflows | Coordinate durable product work, budgets, retries, and outcome collection. |
| Operational notifications and scheduled dispatch/recovery | Cloudflare | Keep coordination beside the control application. |
| Delegated proposer/critic tool | Fly.io, `agent-runner` | Run the required Node process, CLI, and isolated request workspace. |
| Backtests, stress suites, portfolio calculations | Fly.io, `engine-batch` | Run the shared native Rust core with bounded CPU and memory. |
| Persistent paper and shadow sessions | Fly.io, `engine-paper` | Maintain live feed connections and recoverable session state without competing with batch jobs. |
| Live execution, risk, orders, reconciliation | Separate Fly.io app, `engine-live`, at C4 | Isolate broker credentials, account ownership, deployment, and reserved resources. |
| Public website | Cloudflare static hosting | Publish repository-owned content without private fund access. |
| Canonical records and large artefacts | Neon Postgres and R2 | Preserve the existing storage ownership. |

These are deployment profiles, not new domain services. The three engine profiles share `apps/engine` and `packages/quant-core`. Introduce each profile only at its checkpoint.

```text
Ink / CLI
   │ authenticated HTTP + operational events
   ▼
Hono API Worker [Cloudflare]
   ├── guarded commands / authoritative reads ── Hyperdrive ── Neon
   ├── ResearchWorkflow ── authenticated attempt dispatch ── Fly agent-runner
   ├── EvaluationWorkflow ── batch queue ← HTTP pull ─────── Fly engine-batch
   ├── scheduled recovery / market-calendar task dispatch
   ├── notification Durable Object
   └── immutable artefacts ── R2

Fly engine-paper [C3] ── live market data ── paper/shadow sessions
Fly engine-live  [C4] ── installed mandate ── risk / orders ── broker

Fly executors ── scoped results/status ── Hono ── commit ── notification
Static public site ── approved repository content and redacted exports only
```

No Cloudflare Container controllers are needed. The notification Durable Object remains a lightweight notification component. Neither a Durable Object ID nor a Fly Machine ID substitutes for account ownership checks.

### 7.2 Only two durable product workflow classes

**ResearchWorkflow:** reserve the mission budget, invoke competing proposer configurations, register candidates, invoke independent criticism, and request bounded evaluations. It records every attempt and uses controlled revisions.

**EvaluationWorkflow:** freeze the strategy/data/policy manifest, request engine work, verify the returned artefacts, and record official evidence. Numerical success and promotion eligibility remain separate.

Mandate approval, rejection, acknowledgements, and policy changes are ordinary version-checked commands. They do not need one workflow class each. Cloudflare's Workflow API provides the orchestration boundary; application records remain authoritative for domain state. [W3]

Cloudflare schedules trigger product work and recovery. Market calendars and stored schedule slots determine whether work is due. A repeated trigger cannot create another run for the same logical slot. Persistent paper/live feeds run on Fly.io, not in GitHub Actions or one Workflow step per tick.

### 7.3 Durable dispatch and completion

Create the run, budget reservation, and dispatch-outbox entry in one database transaction. Retain one batch queue for quantitative jobs. Queue messages contain input references, not whole datasets. Do not put live orders, halts, or raw market ticks on this queue.

The batch host pulls work through the documented Cloudflare Queues HTTP API. Configure an HTTP-pull consumer; do not also attach a push consumer. The current pull call uses HTTP POST. The attachment's illustrative GET call is not the implementation contract. [W8]

A batch worker must claim the logical attempt through a guarded application endpoint before executing it. Use an application lease and revision separately from the queue receipt. Accept completion only from the current owner. A redelivered message cannot authorise duplicate official results.

Acknowledge work after its terminal result is committed. Long evaluations must be bounded or checkpointed to fit the documented visibility window. If visibility expires, the run record and recovery task decide whether to resume or fence a new attempt. Do not rely on the queue lease alone or assume an unlimited visibility extension. [W8]

ResearchWorkflow uses authenticated HTTPS to submit an existing attempt ID to the Fly agent-runner. The host must obtain a durable claim through the control API before returning acceptance or starting the tool. It then returns promptly; the Workflow observes stored status through bounded polling. A timed-out dispatch is checked under the same ID, not blindly respawned. This path needs no second queue initially.

Upload immutable results first. Verify schema, input hashes, running engine/executor identity, and attempt ownership before committing the official result. A stale worker may leave an unreferenced artefact; it cannot replace accepted evidence. Notify clients only after commit. Recovery finds missing dispatches and expired attempts even when no client is connected.

### 7.4 Storage, networking, and credentials

Neon stores canonical missions, versions, runs, decisions, mandates, accounting, order history, and audit records. R2 stores immutable inputs, reports, and checkpoints. Hyperdrive caching is disabled for private application reads initially.

There is one SQL migration owner: `apps/api/migrations`. Cloudflare uses Hyperdrive. Fly engine processes that own accounting use bounded Postgres connections and narrow service roles, not a Worker binding or a second database. Batch and agent hosts use scoped input/result endpoints where no direct database authority is required.

Use authenticated TLS connections across the Cloudflare/Fly boundary. Service credentials bind the caller to permitted operations, environment, and run/account scope. Do not assume Cloudflare can reach Fly private DNS without an explicitly configured network bridge. The TUI still accesses private application state only through Hono.

Separate Fly apps for the agent runner, batch engine, paper engine, and live engine. Fly app secrets are available to every Machine in that app; process groups alone are therefore not a credential boundary. Live broker keys must never be installed in a batch or agent app. [W9]

An agent receives only the approved research bundle and model access required by its execution profile. Keep host service credentials out of the child process environment. Batch compute receives read-scoped inputs and an attempt-scoped result route. Deploy tokens remain outside all product runtimes.

Fly root disks are ephemeral. Treat them as scratch space. A Fly Volume may support a bounded crash-recovery journal when required, but it is not a second canonical portfolio database. Volumes are host-local and not automatically replicated; snapshots do not replace tested recovery. [W2]

### 7.5 Runtime policy

Start with fixed, bounded execution capacity. Keep the batch consumer running while the service is enabled. Poll with backoff when idle. Add scale-to-zero only when a tested wake-up path exists; an outbound queue poll cannot wake a stopped process.

Paper and live profiles must not use HTTP-idle autostop. Their workload is a persistent market session, not incoming web traffic. Fly configuration exposes lifecycle and resource controls; choose and test them per profile rather than inheriting web-app defaults. [W7]

Use one active live writer per broker account. Restart begins with reconciliation. Before a replacement can submit orders, stop or isolate the old writer and establish current ownership. Generic rolling, canary, or blue/green traffic switching is not sufficient evidence of single-writer safety.

Keep one explicit region per profile initially. Select it using the chosen data, database, and broker requirements. Do not invent a latency guarantee or automatically relocate a live account. Separate compute resources keep batch work from delaying paper/live supervision.

## 8. Model-backed execution

The attached Pactwright log argues for one delegated executor, fresh execution identity, explicit opt-in, and runtime-owned mutation. Adopt those boundaries without importing Pactwright's whole delivery engine. [S5, §§3–5, 8–15]

```text
application-selected role + immutable bundle + bounded evidence
   → AgentExecutor
   → selected external tool in isolated Node execution on Fly.io
   → structured result
   → schema / provenance / authority validation
   → guarded application command
```

The initial adapter delegates to a pinned Claude Code CLI. OpenQuant does not select providers through a custom model router. The operator selects a permitted execution profile; the delegated tool owns provider integration. Alternative tools can later implement the same interface without changing strategy or capital semantics.

The proposer and critic use the **same mechanism**, but separate sessions, task contexts, permissions, and result records. A critic cannot rewrite its candidate. Neither role can mark its own output as accepted evidence.

Required invocation identity includes the run and attempt IDs, fresh session ID, behaviour-bundle hash, executor version, requested profile, reported actual model where available, and permitted data references. Preserve unreported values as unknown rather than inventing them.

The host enforces timeout, process-tree termination, output-size bounds, and budget limits. Distinguish malformed output, permission denial, authentication failure, timeout, model refusal, and a valid adverse research result. Provider-reported cost is labelled as an estimate when appropriate.

Do not treat repeated LLM calls as idempotent: they can change output and incur new cost. Record retries, prevent overlapping attempts from exceeding the reserved budget, and accept only one authorised result per attempt contract.

Disable discovery of arbitrary local hooks, plugins, repository instructions, and user configuration. Supply the reviewed bundle explicitly. Current Claude Code documentation offers controlled non-interactive execution and structured output, but the exact pinned binary and its permissions must be exercised in the deployment probe. The attachment's September CLI flags are not assumed current. [W4]

Production research receives no writable project checkout. Source text, strategy descriptions, and market/news content remain untrusted data. No `eval`, arbitrary shell execution from model text, self-installed skills, or unrestricted network tools are granted to product agents.

`execution.enabled` is explicit and defaults off. Missing authentication or unsupported executor capability produces a blocked/failed run, not a recorded model success. Offline tests inject controlled responses. A separate opt-in test must exercise the real delegated runner before claiming real-model execution.

The third-party executor is an external dependency. Document its authentication, service terms, and distribution requirements before publishing an image containing it. An open-source OpenQuant licence does not automatically license that dependency.

## 9. Ink frontend implementation

The frontend remains TypeScript Ink. Do not substitute AICaaS's React Router frontend or Kakeibo's Expo frontend. The separate Ink specification continues to own presentation. [S2, S3]

Use five workspaces from Design v2: **Overview, Foundry, Arena, Portfolio, Operations**. Keep risk state and the risk/emergency route persistent. Strategy details are reused across views. Agent activity and audit are contextual views, not new primary applications.

Implement explicit screen, overlay, focus, input-mode, connection, and pending-command states. Components render those states and dispatch typed intent. The client runtime processes responses and events. It never owns a second durable trading lifecycle.

The shared command path serves both interactive Ink and machine output. JSON goes to stdout; diagnostics go to stderr. No Ink rendering occurs in machine mode. Input handling must isolate pasted text and modal focus. Support no colour, ASCII fallback, narrow layouts, terminal resize, and terminal cleanup.

Preserve the distinctions `PENDING`, `UNKNOWN`, `REJECTED`, and confirmed completion. Confirmation binds the reviewed revision; the server revalidates it. A network timeout cannot justify the message “No state changed”. Query authoritative state before reporting success.

`openquant demo` uses the installed native engine with the canonical fixture pack. It is labelled **REPLAY**, uses no cloud/model/broker credentials, and identifies recorded agent proposals. It must compute results, not display a scripted pass screen. The remote engine remains the only production execution path.

Test application state and command handling without Ink. Test terminal interaction separately, then install the actual release package in a clean environment and run it. The supplied Ink guide explicitly requires installed-artefact and terminal-compatibility verification. [S3, §§32–36]

## 10. GitHub Actions and repository automation

### 10.1 Workflows

Keep YAML thin. Checked-in TypeScript scripts implement reusable repository checks and read-back verification. The following filenames are proposed interfaces, not files created by this design.

| Workflow | Trigger | Responsibility | Sensitive access |
|---|---|---|---|
| `ci.yml` | PR and push to protected `main`; `merge_group` only if a merge queue is adopted | repository/spec checks, TS/Rust checks, database/contract tests, fixture evaluation, package build | none |
| `security.yml` | PR/push where appropriate and scheduled scans | dependency, code, secret, and image scanning; expiring exceptions | no product credentials |
| `deploy.yml` | successful trusted `main` revision for staging; explicit production approval | Cloudflare API/site and Fly agent, batch, and paper deployments; verify resulting versions; exclude live | target-specific deployment credentials |
| `infrastructure.yml` | PR validation; trusted reviewed plan/apply | Cloudflare Terraform, declared queue-consumer setup, Fly app provisioning/configuration checks, and resource read-back | environment-scoped infrastructure credentials |
| `release.yml` | protected release tag or approved dispatch | build and verify CLI/engine artefacts, publish provenance and release notes, install published candidate | publishing credentials only |
| `model-evaluation.yml` | explicit dispatch on reviewed revision | real proposer/critic compatibility and regression evaluation with fixed budgets | test model access only |
| `deploy-live.yml` | explicit dispatch, introduced at C4 | isolated Fly live-image rollout; old-writer shutdown, reconciliation, and authority read-back before any resumption | separately protected live deployment access |

Dependabot opens grouped npm, Cargo, and Actions update PRs. No automatic major upgrade or baseline rewrite. Link checking and benchmark regression checks can remain jobs in existing workflows rather than new automation services.

An optional future AI code-review job may produce findings or a draft patch. It must not merge its own changes, approve its own checks, change production settings, or share a credential store with product agents. Do not add it before deterministic repository automation works.

### 10.2 Required CI contract

Normal CI runs without cloud, model, market-data, or broker credentials. Its required status is a stable aggregate job named `ci`.

The aggregate fails when any required child fails, is cancelled, or is unexpectedly skipped. Do not use a blanket `continue-on-error` or a path-filtered workflow that can leave the required check absent. Begin with broad checks; add measured change selection later.

Required coverage includes:

- TypeScript formatting, lint, type checks, tests, builds, and Worker bundle validation;
- Cargo format, clippy, unit/property tests, and real fixture evaluation;
- API permissions, database transaction/migration tests against real Postgres, and TS/Rust protocol fixtures;
- model adapter parsing, denied tools, timeout/retry handling, and explicit disabled-executor behaviour;
- Ink state, focus, resize, stale-state, non-TTY, and installed-package smoke tests;
- spec metadata, local links, generated tree, licences, and public/private artefact checks.

Run benchmarks against hand-calculated or independently specified baselines. Never make the system pass by regenerating expected numbers during the test. Golden-data updates require an explained semantic change and review.

### 10.3 Permission boundaries

Default Actions permissions are read-only. Grant write permissions only to the job that requires them. Pin external actions to verified full commit SHAs. Do not execute PR code in a privileged `pull_request_target` or follow-up job with production secrets. Treat PR text, patches, outputs, and uploaded artefacts as untrusted. These controls follow GitHub's security guidance. [W5]

Fork PRs receive no deployment credentials or private datasets. A trusted publishing job verifies the source revision, workflow identity, artefact digest, and eligibility before using a build. It does not run arbitrary scripts recovered from an untrusted artefact.

Use GitHub environments to restrict deployment branches, release secrets, and approval gates. Verify that the repository's plan and settings support the chosen protections. If the gate is unavailable or misconfigured, block the sensitive workflow rather than silently downgrading it. [W6]

`CODEOWNERS` covers workflow files, repository scripts, domain/risk rules, migrations, schemas, agent policy, infrastructure, and canonical specs. A code-ownership file is not enforcement by itself; the repository setup check must read back the corresponding ruleset and environment protections.

A solo maintainer must not be represented as two independent human reviewers. Deterministic checks and isolated model review remain useful, but they do not create a second human approval.

### 10.4 What GitHub Actions must not do

GHA must not run the production paper fund, hold continuous broker connections, schedule live rebalances, approve capital, edit active mandates, or become the durable store for product runs. Repository issues track development work; one issue per backtest or market event is not the product task model.

Cloudflare Workflows coordinate research and evaluation. Fly hosts perform delegated model execution and Rust computation. The live engine enforces trading logic. GHA builds and deploys their verified releases.

## 11. Environments, configuration, and release ownership

Use development, staging, and production application environments. Keep fixture/demo mode separate from real-money mode. Production hosting does not imply live trading permission.

Local development uses the same source with Wrangler, native Cargo/Node processes, and Docker where needed to test Fly images. The offline engine demo is smaller and needs no local production replica. Staging uses synthetic data, test market feeds, or a broker sandbox with clearly labelled semantics.

Each environment profile declares required bindings and capabilities. Missing bindings fail validation. No placeholder identifier may reach a deployed configuration. Profiles contain names and non-secret settings, not credentials.

Assign one writer per managed resource:

| Owner | Resources |
|---|---|
| Terraform | Cloudflare storage, Hyperdrive with caching disabled, batch queue, DNS/routes, and supported access resources |
| Infrastructure workflow, versioned setup commands | HTTP-pull consumer configuration and Fly app provisioning; verify state before and after changes |
| Wrangler through GHA | Cloudflare Worker code, Workflow and notification Durable Object exports/bindings, public site assets |
| Pinned flyctl through GHA | Fly deployment profiles, immutable images, Machine counts/resources, and controlled secret updates |
| Versioned SQL migration job | application schema |
| Runtime commands | missions, evidence, approvals, active account mandates and product decisions |

Use generated binding metadata where Terraform outputs feed Wrangler. Keep Fly profiles under `infra/fly` and non-secret app/environment mappings under `infra/environments`. Do not let Terraform and flyctl both manage the same Fly resources. This plan does not depend on the dated Fly Terraform example in the AICaaS attachment. Protect Terraform state and saved plans; inject secrets through the approved secret path, not checked-in `.tfvars`.

Use app-scoped Fly deploy credentials in protected GHA jobs, with separate live and non-live access. Fly documents a flyctl/GitHub Actions deployment path. Keep OpenQuant's stricter action pinning, approved-artifact, and read-back rules rather than copying a mutable example workflow. [W10]

Treat live secret rotation as a controlled rollout. Fly documents that ordinary secret updates restart app Machines; stage changes and apply them only through the live recovery procedure. Do not allow a routine secret-sync job to restart the live writer. [W9]

Disable competing automatic deploy routes, including Workers Builds for the same target. GHA is the single release controller. GitHub-hosted scheduled scans are acceptable; they are not runtime scheduling.

Release identity records the source SHA, CLI version, engine digest, agent-bundle hash, protocol versions, migration level, and deployment references. Components can deploy independently without independent version systems for every folder.

Serialize deployments per component and environment. Cancel superseded validation work, but do not cancel an in-progress migration or live rollout simply because a newer push arrived. Use expand/contract database migrations, and verify backup/restore and rollback procedures before production use.

A CLI/API release must not automatically restart the live engine. A research-bundle update must not activate a changed strategy. An engine change must trigger the evidence-compatibility rules in Design v2 before affected strategies regain authority.

## 12. Deployment verification and live readiness

A successful upload is not a successful deployment.

For staging, deploy the selected immutable artefacts. Read back the Cloudflare Worker version and each affected Fly app's Machine IDs, running image digest, process profile, configuration, and health. Verify protocol compatibility and migration level. Run an authenticated synthetic command and verify its saved outcome before recording deployment success.

Production uses the reviewed release identity, not a fresh unreviewed build. Read back the same state after promotion. Failed or partial rollout retains the exact failing component and recovery action in the release record. A healthy process is not proof that a mandate has been activated.

### Fly execution probe

Before treating a Fly execution profile as working, verify:

1. The Rust image starts and reproduces an independent fixture result.
2. The delegated CLI starts with its pinned version, controlled configuration, isolated session, valid authentication, and restricted tools.
3. Authenticated dispatch, result publication, and HTTP-pull queue handling work across the Cloudflare/Fly boundary.
4. Timeout, crash, queue redelivery, and lost acknowledgements preserve recoverable run ownership and one official result.
5. Restart restores from durable inputs/checkpoints, including loss of the ephemeral root disk. Any recovery journal has an explicit loss and restore test.
6. Old/new API and engine versions either interoperate or fail explicitly. Actual running digests match the release manifest.
7. Capacity limits hold, and long-running work survives low inbound HTTP traffic. Batch overload cannot consume reserved paper/live resources.
8. Agent and batch deployments cannot read broker secrets, alter active mandates, or restart the live app.

Fly documents app lifecycle controls and ephemeral/local storage behaviour. These capabilities still require application-level recovery tests. No process is assumed to remain alive indefinitely. [W1, W2, W7]

### Additional live gate

C4 requires the selected broker, instrument set, market-data rights, account permissions, capital policy, network requirements, and operational ownership. These are not supplied by the reference repository.

Before enabling real money, test durable order intent before submission, account writer fencing, unknown submissions, duplicate and late fills, partial cancellation, control-plane failure, database failure, restart reconciliation, and a broker emergency path independent of the normal API.

Disable new exposure when authority or durable account state is unavailable. Preserve the ability to cancel/reconcile existing broker obligations through the approved recovery route. Halt does not promise liquidation; liquidation requires its own explicit policy and verified result.

The protected live rollout first disables new submissions and confirms the old writer is stopped or isolated. It deploys the reviewed image, restores and reconciles broker state, verifies ownership and installed mandate revision, then awaits any approval required for resumption. Do not create concurrent active writers to obtain a zero-downtime deployment.

Do not enable live operation if the Fly deployment cannot satisfy the broker and recovery contract. Record a blocking finding. A new hosting decision would need an explicit spec change; the system must not silently switch providers or weaken controls.

## 13. Fixture, evaluation, and public-content organisation

An example pack contains one strategy artefact, a dataset manifest, execution configuration, expected invariants, licence information, and an explanation. Tests, the CLI demo, Academy exercises, and website examples reference that pack rather than copying it.

Keep three kinds of evidence separate:

| Evidence | Location and use |
|---|---|
| Deterministic engine/protocol fixtures | `fixtures/` and component tests; run on ordinary CI |
| Model behaviour evaluations | `packages/agents/evals/`; same real runner for paid acceptance, controlled adapter responses for offline tests |
| Product research and account history | private Neon/R2; not Git, public CI artefacts, or a public Arena feed |

Runtime strategy competition is coordinated by Cloudflare and executed by the Fly-hosted engine. Repository benchmark runs validate the software and its evaluation method. A benchmark fixture is not proof of future trading returns.

The website reads Docs, Academy, Blog, and approved public result manifests. Keep strategy and integration catalogues as content, not a new marketplace backend. Published results disclose strategy/engine/data versions, mode, period, costs, and search-history limits. Data licensing and privacy checks precede export.

Public risk code and tests are part of the open-source project. Active mandates and broker credentials are not. Do not repeat the earlier wording that suggested the risk-control implementation itself should be closed.

## 14. Contributor and repository contracts

The root `.gitignore` excludes Rust build output, local run data, Wrangler state, `.dev.vars` files, Terraform state/plans, credentials, and private exports. Ignore rules complement secret scanning and release allowlists; they do not replace them.

Use `AGENTS.md` as the concise source of coding-agent instructions: authority map, dependency boundaries, verification commands, secret rules, and prohibited live actions. Tool-specific adapters may point to it; they must not become a second behavioural source.

The application behaviour bundle is separate from coding-agent instructions. A deployed research agent must not discover `AGENTS.md`, `.claude` configuration, or arbitrary plugins from a user-submitted repository.

Keep Kakeibo's three contribution levels: local improvement, implementation within an existing contract, and canonical change. Require an owning-spec update for the last category. PRs state what changed, why, the relevant requirement, tests actually run, and unresolved failures.

Use the project's requested commit form:

```text
<type>: <imperative summary>
```

Allowed types are `feature`, `fix`, `docs`, and `chore`. AI-authored commits have exactly one co-author trailer naming the verified model used for that work. Do not invent a model identity or add session links. Inspect repository guidance/history before committing.

Use Apache-2.0 as the proposed software licence, following Kakeibo. Confirm the root licence and notices when scaffolding. Provider software, datasets, and brand assets retain their own terms. `TRADEMARKS.md` must not claim a registration or naming clearance that has not been established.

Configure a real private vulnerability-reporting route and verify it before a public release. Describe broker/risk bypass, account data exposure, executor escapes, and supply-chain compromise explicitly. Do not publish private account evidence in issues.

## 15. Repository command contract

These are commands the scaffold must implement, not commands verified in the current source.

| Command | Required meaning |
|---|---|
| `pnpm verify` | all deterministic repository, TypeScript, Rust, protocol, and fixture checks required for the current checkpoint |
| `pnpm dev:cli` | start Ink against the selected explicit fixture or development API profile |
| `pnpm dev:api` | start the Cloudflare development application |
| `pnpm demo` | build/use the actual engine and calculate the bundled replay result |
| `pnpm verify:package` | pack, clean-install, and execute the release candidate; inspect its file allowlist |
| `pnpm verify:contracts` | validate schemas and shared TS/Rust protocol fixtures |
| `pnpm generate:tree` | regenerate the tracked-file repository map |
| `pnpm verify:deployment` | read back the selected deployed release and run safe smoke checks |
| `pnpm agents:eval` | explicit real-model evaluation; fails clearly when credentials or execution opt-in are absent |

The root scripts and GHA call the same implementations. Do not replace missing checks with `echo`, unconditional success, or zero-test runs. A newly introduced package must either have its required tests or be clearly excluded as not yet implemented. Exclusion cannot count as feature acceptance.

For release distribution, test Linux and macOS targets selected by the project. The installed CLI must locate the matching native engine through a verified release manifest, not download an unpinned executable during ordinary use. Do not advertise unsupported platforms.

## 16. Delivery checkpoints and acceptance

Build working vertical slices rather than a large empty tree.

| Checkpoint | Repository outcome | Design v2 evidence |
|---|---|---|
| C1 — Reproducible core | Root workspaces and CI; real Rust fixture evaluation; Ink inspection; clean installed demo; source/spec checks | A03–A05, A15–A16 |
| C2 — Competing research | Hono/Neon/R2; two Workflows; delegated proposer/critic runner; official evaluation dispatch and recovery | A01–A06, A11 |
| C3 — Persistent paper fund | Live-data adapter, independent paper competitors, shadow portfolio path, notifications, restart and stale-state controls | A07–A10, A13, A15 |
| C4 — Governed live | Separate Fly live app, credentials, and deployment; approved micro mandate; broker reconciliation and emergency recovery | all applicable checks, including A09–A14 and A18 |

Public evidence/export checks A17 apply whenever a result is published. Engine compatibility A18 applies whenever a release changes evaluated semantics, including before live trading.

Repository-specific acceptance adds:

- **R01:** the current spec index and repository map can be regenerated without drift;
- **R02:** a clean checkout passes the implemented deterministic checks without production credentials;
- **R03:** a PR cannot obtain live credentials or bypass the protected release path;
- **R04:** the installed demo calculates its result through the shared Rust core;
- **R05:** the paid model test uses the same executor and behaviour bundle as production research;
- **R06:** Cloudflare coordinates and Fly executes a complete research/evaluation run without an active TUI or GHA runner;
- **R07:** ordinary API, website, and agent-bundle deployments cannot activate or restart live trading;
- **R08:** deployment status is based on read-back Cloudflare versions, Fly Machine/image/profile identity, and safe smoke tests;
- **R09:** public site and release artefacts contain no private account data, active mandates, or secrets;
- **R10:** batch and live processes share numerical code but use separate Fly apps and cannot share trading credentials or account authority.

These are required tests, not reported pass results.

## Appendix A. Kakeibo review coverage

The pinned tree was the scope of the source review. Unchanged small files were also read through their initial-commit patches and matched to the current tree's blob identities. The four updated specifications were read at the pinned current revision. There were no implementation files to execute. [K1–K5]

| Area | Non-empty files read | Empty tracked files checked |
|---|---:|---:|
| Repository root | 9 | 0 |
| `.github/` | 3 | 1 |
| `apps/` | 1 | 3 |
| `packages/` | 1 | 13 |
| `docs/` | 19 | 0 |
| `academy/` | 1 | 6 |
| `blog/` | 1 | 3 |
| `fixtures/` | 1 | 0 |
| `infra/` | 1 | 2 |
| **Total** | **37** | **28** |

Root coverage: `.gitignore`, `README.md`, `REPOSITORY_TREE.txt`, `CHANGELOG.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`, `TRADEMARKS.md`, and `LICENSE`.

GitHub coverage: both issue templates, the PR template, and the workflow placeholder. No runnable workflow YAML is present at this revision.

Documentation coverage: `docs/README.md`; all ten subsection README files; the specification index; and all seven canonical specs. The review included the full product, financial-domain, assistant, mobile-design, architecture/data, delivery/operations, and open-source content—not only the repository README.

Remaining coverage: the Apps, Packages, Academy, Blog, Infrastructure, and synthetic-financial-data guides; every placeholder in the actual tree; and both commits' metadata. No `AGENTS.md`, `CLAUDE.md`, source implementation, dependency lockfile, or executable test suite exists in the pinned tree.

Repository settings, installed GitHub Apps, configured secrets, ruleset enforcement, deployed services, and runtime behaviour were not audited. This source review does not establish their state.

## Appendix B. Sources and status

### Project sources

- **[S1]** `openquant-design-spec-v2.md`: simplified product and safety baseline; especially §§3–5, 9–18.
- **[S2]** `ai-native-quant-fund-ink-ux-ui-spec-v1.1.md`: terminal interaction reference, subject to Design v2's explicit corrections.
- **[S3]** `Production Best Practices for an Ink TypeScript TUI.md`: renderer/runtime separation, focus, cancellation, testing, and installed-package verification.
- **[S4]** `aicaas-stack-spec.md`: supplied managed stack reference; especially §§2, 4–6, 8, 11–12. The Fly.io extension is retained. Its cost estimates and illustrative API, CLI, provider-resource, and model versions were not adopted as current facts.
- **[S5]** `2026-09-14-pactwright-model-backed-execution.md`: reported executor investigation; one tool, structured results, runtime-owned mutation, session isolation, opt-in, and bounded cost.
- **[S6]** `openquant-open-source-project-organisation-v1.md` and `ai-native-quant-fund-tech-stack-spec-v1.md`: retained context where consistent with Design v2 and the current request.

### Kakeibo sources

All current-file references use revision `75443233c474a2a4072348078c22d72d15573645`.

- **[K1]** [Complete recursive tree](https://api.github.com/repos/sb-dev/kakeibo/git/trees/75443233c474a2a4072348078c22d72d15573645?recursive=1).
- **[K2]** [README](https://github.com/sb-dev/kakeibo/blob/75443233c474a2a4072348078c22d72d15573645/README.md) and [specification index](https://github.com/sb-dev/kakeibo/blob/75443233c474a2a4072348078c22d72d15573645/docs/specs/README.md).
- **[K3]** [Canonical specification directory](https://github.com/sb-dev/kakeibo/tree/75443233c474a2a4072348078c22d72d15573645/docs/specs): files `01` through `07`, read in full.
- **[K4]** [Initial-commit file patches](https://api.github.com/repos/sb-dev/kakeibo/commits/0151cc33560f0ed4500ce6f2a19947ef2100de48?per_page=100): unchanged policies, directory guides, templates, and placeholders.
- **[K5]** [Pinned main history](https://api.github.com/repos/sb-dev/kakeibo/commits?sha=75443233c474a2a4072348078c22d72d15573645&per_page=20).

### External documentation

The initial repository review checked W3–W6 on 19 October 2026. This hosting revision checked W1–W2 and W7–W10 on the same date. These are platform references, not OpenQuant deployment results.

- **[W1]** [Fly Machines](https://docs.fly.io/machines): VM hosting and API/CLI lifecycle control.
- **[W2]** [Fly Volumes overview](https://docs.fly.io/volumes/overview): ephemeral root disks, host-local volumes, replication, and recovery limitations.
- **[W3]** [Cloudflare Workflows Workers API](https://developers.cloudflare.com/workflows/build/workers-api/): durable workflow integration.
- **[W4]** [Claude Code programmatic execution](https://code.claude.com/docs/en/headless): non-interactive invocation and configuration/output controls. No CLI invocation was performed in this review.
- **[W5]** [GitHub Actions secure use](https://docs.github.com/en/actions/reference/security/secure-use): workflow permissions, untrusted input, and action pinning.
- **[W6]** [GitHub deployment environments](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments): protected deployment configuration.
- **[W7]** [Fly app configuration](https://docs.fly.io/reference/configuration): images, deployment strategy, resources, shutdown, and autostop settings.
- **[W8]** [Cloudflare Queues HTTP-pull consumers](https://developers.cloudflare.com/queues/configuration/pull-consumers/): external consumers, configuration, authentication, visibility, and acknowledgements.
- **[W9]** [Secrets and Fly Apps](https://docs.fly.io/apps/secrets): app-wide secret scope and restart effects of secret updates.
- **[W10]** [Fly deployment with GitHub Actions](https://docs.fly.io/launch/continuous-deployment-with-github-actions): flyctl deployment and app-scoped tokens.

### Verification boundary

This deliverable revises the repository design only. The prior pinned Kakeibo review is retained, not repeated. No repository, cloud resources, credentials, or running application were changed. Neither Cloudflare/Fly deployment, broker compatibility, nor model/strategy performance was tested. Implementation must produce the evidence required by C1–C4 and R01–R10.

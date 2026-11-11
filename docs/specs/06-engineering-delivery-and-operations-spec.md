---
id: OQ-06
title: OpenQuant — Engineering, Delivery and Operations
version: 1.3.0
status: canonical
updated: 2026-11-11
owns: verification, automation, releases, deployments, recovery, R01–R10
---

# OpenQuant — Engineering, Delivery and Operations

This document defines required behaviour. It does not claim that the behaviour is implemented.
See the [specification index](README.md) for ownership and the current bootstrap scope.

## 1. Bootstrap and command scope

The bootstrap contains canonical specifications, directory ownership guides, root policies, GitHub templates, and working repository checks. It contains no application, Rust engine, executor, or deployment implementation. M1 is not complete.

Implemented commands:

| Command | Behaviour |
| --- | --- |
| `pnpm verify` | Run repository checks and their regression tests. |
| `pnpm generate:spec-index` | Generate the ownership/version index from the seven front-matter blocks. |
| `pnpm generate:tree` | Generate the file map from the Git index, or files in an extracted archive. |

Node can run the TypeScript tooling directly. No dependency install is needed for the bootstrap checks. Native type stripping is execution, not TypeScript type checking. S0 adds the Rust build toolchain and schema checks. S1 adds the TypeScript build toolchain, strict type checks and cross-runtime validation.

The root command must grow with the implemented checkpoint. A passing bootstrap check does not satisfy application acceptance. Do not add placeholder commands that print success for absent implementation.

## 2. GitHub Actions
### 2.1 Workflows

Keep YAML thin. Checked-in TypeScript scripts implement reusable repository checks and read-back verification. Only `ci.yml` is implemented in the bootstrap. Add the other workflows with their tested capabilities; their table entries are delivery requirements.

| Workflow | Trigger | Responsibility | Sensitive access |
|---|---|---|---|
| `ci.yml` | PR and push to protected `main`; `merge_group` only if a merge queue is adopted | repository/spec checks, TS/Rust checks, database/contract tests, fixture evaluation, package build | none |
| `security.yml` | PR/push where appropriate and scheduled scans | dependency, code, secret, and image scanning; expiring exceptions | no product credentials |
| `deploy.yml` | successful trusted `main` revision for staging; explicit production approval | Cloudflare API/site and Fly agent, batch, and paper deployments; verify resulting versions; exclude live | target-specific deployment credentials |
| `infrastructure.yml` | PR validation; trusted reviewed plan/apply | Cloudflare Terraform, declared queue-consumer setup, Fly app provisioning/configuration checks, and resource read-back | environment-scoped infrastructure credentials |
| `release.yml` | protected release tag or approved dispatch | build and verify CLI/engine artefacts, publish provenance and release notes, install published candidate | publishing credentials only |
| `model-evaluation.yml` | explicit dispatch on reviewed revision | real proposer/critic compatibility and regression evaluation with fixed budgets | test model access only |
| `deploy-live.yml` | explicit dispatch, introduced at M4 | isolated Fly live-image rollout; old-writer shutdown, reconciliation, and authority read-back before any resumption | separately protected live deployment access |

The bootstrap configures Dependabot for Actions. Add grouped npm and Cargo updates when their dependency manifests exist. No automatic major upgrade or baseline rewrite. Link checking and benchmark regression checks can remain jobs in existing workflows rather than new automation services.

An optional future AI code-review job may produce findings or a draft patch. It must not merge its own changes, approve its own checks, change production settings, or share a credential store with product agents. Do not add it before deterministic repository automation works.

### 2.2 Required CI contract

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

### 2.3 Permission boundaries

Default Actions permissions are read-only. Grant write permissions only to the job that requires them. Pin external actions to verified full commit SHAs. Do not execute PR code in a privileged `pull_request_target` or follow-up job with production secrets. Treat PR text, patches, outputs, and uploaded artefacts as untrusted. These controls follow GitHub's security guidance.

Fork PRs receive no deployment credentials or private datasets. A trusted publishing job verifies the source revision, workflow identity, artefact digest, and eligibility before using a build. It does not run arbitrary scripts recovered from an untrusted artefact.

Use GitHub environments to restrict deployment branches, release secrets, and approval gates. Verify that the repository's plan and settings support the chosen protections. If the gate is unavailable or misconfigured, block the sensitive workflow rather than silently downgrading it.

`CODEOWNERS` covers workflow files, repository scripts, domain/risk rules, migrations, schemas, agent policy, infrastructure, and canonical specs. A code-ownership file is not enforcement by itself; the repository setup check must read back the corresponding ruleset and environment protections.

A solo maintainer must not be represented as two independent human reviewers. Deterministic checks and isolated model review remain useful, but they do not create a second human approval.

### 2.4 What GitHub Actions must not do

GHA must not run the production paper fund, hold continuous broker connections, schedule live rebalances, approve capital, edit active mandates, or become the durable store for product runs. Repository issues track development work; one issue per backtest or market event is not the product task model.

Cloudflare Workflows coordinate research and evaluation. Fly hosts perform delegated model execution and Rust computation. The live engine enforces trading logic. GHA builds and deploys their verified releases.

## 3. Environments, resources, and releases

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

Use app-scoped Fly deploy credentials in protected GHA jobs, with separate live and non-live access. Fly documents a flyctl/GitHub Actions deployment path. Keep OpenQuant's stricter action pinning, approved-artifact, and read-back rules rather than copying a mutable example workflow.

Treat live secret rotation as a controlled rollout. Fly documents that ordinary secret updates restart app Machines; stage changes and apply them only through the live recovery procedure. Do not allow a routine secret-sync job to restart the live writer.

Disable competing automatic deploy routes, including Workers Builds for the same target. GHA is the single release controller. GitHub-hosted scheduled scans are acceptable; they are not runtime scheduling.

Release identity records the source SHA, CLI version, engine digest, agent-bundle hash, protocol versions, migration level, and deployment references. Components can deploy independently without independent version systems for every folder.

Serialize deployments per component and environment. Cancel superseded validation work, but do not cancel an in-progress migration or live rollout simply because a newer push arrived. Use expand/contract database migrations, and verify backup/restore and rollback procedures before production use.

A CLI/API release must not automatically restart the live engine. A research-bundle update must not activate a changed strategy. An engine change must satisfy [domain §7](02-trading-domain-and-evaluation-spec.md#7-reproducibility-and-compatibility) before affected strategies regain authority.

## 4. Deployment verification and live readiness

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

Fly documents app lifecycle controls and ephemeral/local storage behaviour. These capabilities still require application-level recovery tests. No process is assumed to remain alive indefinitely.

### Additional live gate

M4 requires the selected broker, instrument set, market-data rights, account permissions, capital policy, network requirements, and operational ownership. These are not supplied by the reference repository.

Before enabling real money, test durable order intent before submission, account writer fencing, unknown submissions, duplicate and late fills, partial cancellation, control-plane failure, database failure, restart reconciliation, and a broker emergency path independent of the normal API.

Disable new exposure when authority or durable account state is unavailable. Preserve the ability to cancel/reconcile existing broker obligations through the approved recovery route. Halt does not promise liquidation; liquidation requires its own explicit policy and verified result.

The protected live rollout first disables new submissions and confirms the old writer is stopped or isolated. It deploys the reviewed image, restores and reconciles broker state, verifies ownership and installed mandate revision, then awaits any approval required for resumption. Do not create concurrent active writers to obtain a zero-downtime deployment.

Do not enable live operation if the Fly deployment cannot satisfy the broker and recovery contract. Record a blocking finding. A new hosting decision would need an explicit spec change; the system must not silently switch providers or weaken controls.

## 5. Fixtures, evaluations, and public content

An example pack contains one strategy artefact, a dataset manifest, execution configuration, expected invariants, licence information, and an explanation. A family comparison references versioned packs and common inputs through one comparison manifest. Tests, the CLI demo, Academy exercises, and website examples reference those packs rather than copying them.

Keep three kinds of evidence separate:

| Evidence | Location and use |
|---|---|
| Deterministic engine/protocol fixtures | `fixtures/` and component tests; run on ordinary CI |
| Model behaviour evaluations | `packages/agents/evals/<skill>/`, with recorded responses in `fixtures/agent-results`; same real runner for paid acceptance, controlled adapter responses for offline tests |
| Product research and account history | private Neon/R2; not Git, public CI artefacts, or a public Arena feed |

Skill evaluation suites stay outside the runtime asset tree. Ordinary CI runs non-empty offline suites; paid or external evaluations remain explicit, bounded and separate. Bundle checks prove that evaluation files, expected answers, development scripts and private snapshots cannot enter a bundle. Exact numerical expectations reference independent shared fixtures.

Runtime strategy competition is coordinated by Cloudflare and executed by the Fly-hosted engine. Repository benchmark runs validate the software and its evaluation method. A benchmark fixture is not proof of future trading returns.

The website reads Docs, Academy, Blog, and approved public result manifests. Keep strategy and integration catalogues as content, not a new marketplace backend. Published results disclose strategy/engine/data versions, mode, period, costs, and search-history limits. Data licensing and privacy checks precede export.

Public risk code and tests are part of the open-source project. Active mandates and broker credentials remain private.

## 6. Contributor contracts

`AGENTS.md` is the coding-agent instruction source. Product behaviour belongs in `packages/agents`; deployed research agents do not discover repository instructions or plugins.

Use the root contribution policy, required verification, and commit convention. Inspect repository guidance and recent history before committing. Never invent an AI model identity for a co-author trailer.

The spec index is generated from each document's single metadata block. `REPOSITORY_TREE.txt` is generated from the Git index. Stage intended file additions and deletions before regenerating it. In an extracted ZIP without a Git root, generate it from regular files after excluding local build and secret paths.

Specification versions describe canonical requirements, not implemented releases. Use a patch change for clarifications or delivery sequencing that preserves domain and protocol semantics, a minor change for compatible new requirements, and a major change for incompatible requirements. Assess changes against the last merged version. An open PR may revise its proposed versions without a bump for every review commit; cite the commit SHA for exact draft content. After merge, changed canonical content needs a new version.

The reference archive preserves source bytes and hashes. It is non-canonical. A source migration record explains changes. Research logs and public material cannot override canonical requirements.

`CODEOWNERS` requests review; it does not enforce repository rules. Before public release, verify branch rules, required checks, code-owner enforcement, private security reporting, and protected environment capabilities on the actual repository.

## 7. Application command contract

Add each command with its implementation and tests. The following commands are not available in the bootstrap.

| Command | Required behaviour |
| --- | --- |
| `pnpm dev:cli` | Start Ink with an explicit fixture or development API profile. |
| `pnpm dev:api` | Start the Cloudflare development application. |
| `pnpm demo` | Calculate the bundled replay through the actual Rust engine. |
| `pnpm verify:package` | Pack, clean-install, execute the release candidate, and inspect its file allowlist. |
| `pnpm verify:contracts` | Validate schemas and shared TypeScript/Rust valid and invalid messages. |
| `pnpm verify:deployment` | Read the selected deployed identity back and run safe smoke checks. |
| `pnpm agents:eval` | Run explicit real-model evaluation; fail without opt-in or required authentication. |

Root scripts and GHA call the same implementations. Never replace a missing check with `echo`, unconditional success, or a zero-test run.

Test selected Linux and macOS release targets. The installed CLI must find the matching native engine through a verified release manifest. It must not download an unpinned binary during ordinary use. Do not advertise untested platforms.

## 8. Delivery checkpoints and acceptance

Build working vertical slices rather than a large empty tree.

| Milestone | Repository outcome | Required evidence |
|---|---|---|
| M1 — Automated watchlist research | S0–S5: offline seed evaluation, one complete connected competition, selectable/comparable market data, filing/web evidence, per-stock coverage, joint watchlist strategy evaluation and unattended revisions/recovery | A01–A06, A11, applicable A15; R01–R03, R05–R06, R08 and applicable R07/R09/R10 boundaries |
| M2 — Prospective paper competition | Live observations, independent paper ledgers and recoverable sessions | A07, applicable A13/A15 |
| M3 — Portfolio and shadow validation | Portfolio fit, separate shadow evidence and execution-path checks without orders | A08–A10, applicable A13/A15 |
| M4 — Governed live | Isolated account writer, bounded mandate, broker reconciliation and emergency recovery | All applicable checks, including A09–A14/A18 and R07–R10 |
| Public CLI release | Clean installed credential-free replay through shared Rust, terminal inspection and release verification | A03–A05, A15–A16, R04 and applicable release checks |

[The roadmap](../product/roadmap.md) defines incremental outcomes and dependencies. S0 incorporates the former C1 numerical foundation; S1–S5 deliver the connected M1 research path from former C2. M2/M3 split former C3; M4 preserves former C4. The installed-demo gate remains mandatory before public CLI release and can follow private M1. No acceptance ID is removed or relabelled as passed.

### S0 — Offline seed evaluation

Run the OQ-02 §§2.5–2.6 daily swing seed on fixed synthetic data through the shared Rust core. Demonstrate one complete one-instrument path from indicators and signals to fills, cash and positions. Use independently calculated expectations, including the two RSI entry conditions, execution timing, sizing, corporate actions and invalid inputs. This slice needs no provider credentials, model execution, cloud services or deployment.

Represent each seed variant as a versioned Strategy Contract and Strategy Definition under OQ-02 §§2.1–2.2. Evaluate the definition's typed operator trees through the shared validator and evaluator. Thresholds 30/32 and break-even off/on are differences in the definitions, with distinct artefact identities. They are not separate Rust strategy implementations or evaluator modes. Implement only the reviewed operator subset needed by the seed. A hard-coded seed path cannot satisfy S0 acceptance.

S0's strategy/evaluation input, numerical result and restored-state payloads use versioned language-neutral schemas in `packages/api-contracts/schemas`, following OQ-05 §7. They are shared contracts, not provisional local formats. Generate Rust bindings and validate these payloads in S0, including unsupported versions, unknown mandatory fields and decimal values. Store shared valid/invalid payloads in `fixtures/protocol`. A checkpoint binds the strategy/input/engine identities and event cursor to positions, cash, reservations, pending entries, scheduled stops and applied action identities. Local report formatting may remain harness-specific; its numerical payload must use the shared result schema. S1 adds TypeScript bindings and validation against the same fixtures, plus the run/attempt/ownership envelopes required by connected execution. S0 does not invent those remote identities or claim an official application result.

S0 is complete only when a clean checkout can run a documented local command, inspect actual results and pass the S0 cases below through `pnpm verify`. Add the Cargo workspace, pinned toolchain, lockfile, schemas, real core implementation and local harness together. Wire Rust format, clippy, schema validation, tests and fixture execution into `scripts/verify.ts` and `.github/workflows/ci.yml`. A Rust integration-test harness is sufficient; it must expose signals, trades, cash and positions, not only a pass count. Do not require the installed CLI, API service, TypeScript runtime, Ink or a second numerical engine.

Record the source revision, strategy/input/configuration identities, engine identity, command, independent expected results, actual results and remaining limits. Repeat runs must agree. Restoring local numerical state must preserve the event cursor and corporate-action identities so a split is not applied twice. This local replay contributes to A03–A05; it does not establish A11 distributed recovery, complete an acceptance ID by itself or satisfy the public CLI release gate.

Require S0 evidence before accepting S1. Provider setup and integration investigation may proceed in parallel. S1 reuses the verified core and fixtures for one stock, a seed and a controlled revision through the connected competition path. It still requires real provider and proposer/critic execution, registered trials, durable official results, permissions, budgets and verified deployment. S4 adds joint watchlist replay and the four-candidate comparison in OQ-02 §3.7. S5 carries bounded revisions, failed trials and consumed holdouts across unattended cycles, with distributed recovery. Allocation across strategies remains M3.

Before S1 acceptance, pass the S0 definitions and a proposer-authored controlled revision through the same Rust validation and evaluation path. Verify that the connected schema boundary preserves S0's independent expected results and restored state. Do not replace the S0 evaluator when the first proposer is connected.

Before S0, `packages/agents` may hold draft method notes, procedure drafts, evaluation case descriptions and non-financial I/O shapes, checked by repository tooling. These drafts do not stub financial schemas, form a bundle or satisfy S0 or S1. S1 adds the pilot role modules, wire schemas and owner validators, the bundle allowlist, required dependencies and lockfile, strict TypeScript checks and non-empty offline suites to `pnpm verify`. The first S3 evidence tool adds its bridge, handler, local tool schemas with exported-schema/runtime-parser parity tests on shared valid/invalid payloads, call records and host/tool integration tests together. Its registered-tool probe proves that model processes and their children cannot read host credentials. Earlier executable delivery requires a change to this sequencing.

### Connected slices and acceptance cases

For M1, ordinary CI adds shared adapter contracts, permitted/synthetic response fixtures, schema validation, instrument mapping, split/dividend/units handling, calendar/DST and early-close cases, amendments and cutoff exclusion, pagination, partial/no-data distinctions, typed errors, bounded retry/cancellation and redaction. Validate malicious source text cannot change tools. Provider comparison uses predeclared tolerances and separately labelled datasets; never rewrite golden values to match a vendor.

Use synthetic or permitted inputs and independently calculated expected results for these cases. They extend the existing acceptance IDs without changing their text:

| Case | Required demonstration | Acceptance | Delivery scope |
| --- | --- | --- | --- |
| Definition execution | Load distinct versioned definitions for threshold 30/32 and break-even off/on through one validator and evaluator. Definition changes alone produce the expected signal and scheduled-stop differences. Unsupported operator IDs and invalid operator types/units fail before evaluation. | A03–A05 | S0 for one-instrument fixtures; S1 for the connected path; S4 for the joint comparison |
| Shared payloads | Validate input, numerical result and checkpoint payloads against their api-contracts schemas. Serialize and restore state through the checkpoint schema without changing replay results. Reject unsupported schema versions, unknown mandatory fields and mismatched checkpoint identities. | A03–A05 | S0 for Rust; S1 for TypeScript/Rust parity and connected envelopes |
| Seed semantics | Simple-mean RSI/ATR, lagged weakness, current volume mean, warm-up and zero/undefined inputs match the declared formulas. Source-to-seed changes are explicit. | A03–A05 | S0 |
| Entry variants | RSI `29, 31, 31` satisfies threshold 30 without a crossing at `t`; `31, 31, 31` satisfies threshold 32 only. The current floor remains 30 and rank inputs come from `t`. | A03–A05 | S0 |
| Competing entries | With four of five slots occupied, three qualifying stocks produce one selected entry. Equal scores use stable IDs. Permuting input order preserves fills and ledger results. | A03–A04 | S4 |
| Time and coverage | Unequal date ranges cannot be aligned by row. Missing required data blocks joint evidence without dropping a member or erasing other stock findings. All holdings use one valuation cutoff. | A05 | S4 |
| Unplanned non-trading events | Distinguish a confirmed halt from unexplained missing data. Apply eligibility changes only when available and effective. Expire an unfilled opening intent. An unsupported held-position valuation or terminal settlement produces `INSUFFICIENT` with event details, retains the frozen universe and appears in cohort coverage. | A05 | S0 for local missing-data, expiry and unsupported-action handling; S4 for joint/cohort coverage |
| Split across an ex-date | With a 2-for-1 split, 10 held shares at entry 100 and entry ATR 4 become 20 shares at entry 50 and ATR 2. Stop 92 and target 120 become 46 and 60; a scheduled stop at 100 becomes 50. With zero costs and whole-share lots, a separate pending cap of 1,000 buys 20 shares at raw open 50, with signal ATR 4 converted to 2. Rank and cap stay fixed. Repeat after recovery without applying the split twice. | A03–A05, A11 | S0 for arithmetic and local state restore; S5 for distributed recovery |
| Cash dividend | For an ordinary dividend of 1 per share, 20 eligible shares create a receivable of 20 on the ex-date. With zero costs/withholding and raw price 50 before and 49 after, equity remains 1,000 before other moves. Buying power is unchanged until payment, then cash rises by 20 and the receivable becomes zero. An ex-date buyer gets no entitlement; stops and targets stay on the raw basis. | A03–A05 | S0 |
| Entry and exit phases | Close signals cannot fill at that close. Entry ATR comes from the signal session. Opening gaps, dual stop/target touches and next-session stop activation follow the registered policy. Intraday proceeds cannot fund prior entries. | A03–A05 | S0 for one instrument; S4 for cash timing across instruments |
| Cash and quantities | Fees, lot rounding, cash caps, reservations, expired/skipped entries and later cash reuse reconcile independently. No candidate spends another candidate's simulated capital. | A03–A04 | S0 for one ledger; S1 for candidate isolation; S4 for shared instrument cash |
| Revisions and comparison | The four versions share all evaluation conditions. Parent hashes, rule changes, failures, optional/required evidence and consumed holdouts remain inspectable. Changed conditions register a distinct comparison. | A01–A02, A05–A06, A15 | S1 for seed/revision lineage; S4 for four-candidate comparison; S5 for cross-cycle history |
| Pilot skill modules | Role modules register with no callable tools. Shared valid/invalid payloads pass through assembly and parsing. Development scripts run in fixture mode through the same exports. The bundle holds only allowlisted paths and hashes. Unregistered drafts are rejected before critique, unknown finding categories fail, and the registered policy assigns treatment. The real executor probe uses the production bundle with explicit tool denial. | A01–A02, A05; R05 | S1; S3 adds the first registered evidence tool, its schema-parity tests and its probe |
| Joint recovery | Interrupted and uninterrupted replay match, including pending entries and scheduled stops. Redelivery produces one official result. Stock and joint attempts stay within shared cycle/period budgets. | A02–A03, A11 | S4 for deterministic joint replay and shared budgets; S5 for distributed recovery and redelivery |
| Invalid inputs | Reject unsupported operators and invalid levels. Exclude prohibited future data. Missing required inputs and unsupported corporate actions produce explicit failure or insufficient evidence under OQ-02 §§2.2, 2.5–2.6; never substitute values or silently drop inputs. | A03–A05 | S0; S1 also checks the connected boundary |
| Local replay | Repeat fixed inputs and restore numerical state, including pending entries, scheduled stops and applied action identities. Signals, fills and final cash/positions match independent expectations and uninterrupted execution. | A03–A05 | S0; does not establish A11 |

These are implementation acceptance requirements. A documentation check does not execute them or establish strategy performance.

Opt-in live probes verify all four initial adapters with actual entitlements, bounded spend, declared source terms and recorded running identities. S1 records the market-data credential's verified account type, absence of live order authority and required feed/history entitlements, without recording secrets or placing orders. It also verifies the batch app's approved outbound destinations and redirect restrictions under OQ-05 §5. Missing authority or entitlement evidence blocks enablement; a successful data response alone does not establish credential safety. Exercise the real delegated executor separately using the production bundle. S5 requires successive scheduled cycles without a TUI/GHA runner, duplicate-slot/overlap handling, missed-slot recovery, pause/cancel/resume, worker death, lost acknowledgement, source outages, shared rate limits and period-wide budget exhaustion. Preserve unresolved usage and partial evidence. Mocked responses cannot establish these outcomes.

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

## 9. Source migration

Adopts Repository Design v1.1 §§10–16, Design v2 §17, and the Ink production guide's verification practices. The [bootstrap record](../research-logs/2026-10-19-bootstrap-verification.md) records checks actually run. Planned gates are not pass results.

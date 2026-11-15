# Cloudflare control application

Status: S1 pull request P2, parts A and B, are implemented: the Hono route layer for every route of the route manifest, authentication, the SQL migrations with their runner and the real-Postgres test setup (part A); and the guarded commands, the state machine of jobs, runs, attempts, leases, reservations and outbox entries, the budgets, and the routes of the seven commands and of the command status (part B). `auth.token`, `system.identity`, `/health`, the seven command routes and `commands.show` answer with data. The other 19 routes pass the whole route layer and then answer `UNAVAILABLE` and name the part that builds them. The attempt and result routes, the read models, the release route, the bootstrap command, recovery as a scheduled task, the outbox dispatcher and both Workflows are not implemented. S1 is incomplete, and M1 to M4 are not implemented.

Hono routes, domain rules, guarded commands, two Workflows, notifications, and infrastructure adapters. Keep filing/web provider adapters and SQL migrations here. API-only modules stay here until another consumer exists.

Owner: [05-system-architecture-and-data-spec.md](../../docs/specs/05-system-architecture-and-data-spec.md). The specifications for this part are OQ-05 §§3, 4, 5, 7, 9 and 11 and OQ-02 §8; the acceptance cases are A02, A11 and A15.

## What exists

| Path | Purpose |
| --- | --- |
| `src/app.ts` | `createApp(env)`: the Hono app. It serves every manifest route of the `api` host, `/health`, a typed 404 and a typed 500. Every response has `cache-control: no-store` and `x-content-type-options: nosniff`. |
| `src/worker.ts` | The Worker entry. It builds the environment from the bindings of `wrangler.jsonc` on each request. |
| `src/env.ts` | `ApiEnv`: database factory, object store, clock, id generator, secrets, log. Tests inject a real Postgres connection and an in-memory object store. |
| `src/manifest.ts` | The route manifest `packages/api-contracts/routes/v1.json`, read at build time and checked once. The code serves what it lists. |
| `src/route-layer.ts` | The chain of every route: authenticate, authorise, body limit, parse, form and command kind, handler. |
| `src/body.ts` | Reads a body within the limit of its route. It never calls `request.text()` on an unbounded body. |
| `src/errors.ts` | `api-error/1`: a `ContractError` becomes `code`, `violations` (`apiViolations`, at most 21, pointers cut to 1,024 characters) and a message that repeats no body text. |
| `src/auth/` | Tokens (WebCrypto HMAC), credentials (hash only), authentication and authorisation. |
| `src/handlers/` | The handlers that exist (`auth.token`, `system.identity`, the command routes and `commands.show`) and the table of the deferred routes. |
| `src/commands/` | The guarded commands: the runner (`runner.ts`) and the appliers of the nine kinds (`registrations.ts`, `missions.ts`, `decisions.ts`), with the rules that a schema cannot state (`policy-checks.ts`). |
| `src/domain/` | The rules behind the commands: the transition table (`transitions.ts`), runs and jobs (`work.ts`), attempts, leases, retry and cancellation (`attempts.ts`, `retry.ts`), budgets (`budget.ts`), mission status (`missions.ts`), finding treatment and holdout consumption (`findings.ts`), the dispatch messages (`dispatch.ts`), registered documents (`documents.ts`, `store.ts`) and exact decimals (`decimal.ts`). |
| `src/db/` | The `Database` interface, the one node-postgres adapter, the migration level. |
| `src/store/objects.ts` | The content-addressed object store (`sha256/<hex>`) and its R2 adapter. It verifies the digest before it writes. |
| `migrations/` | Eight plain SQL files, `0001_identity` to `0008_commands`. |
| `tools/migrations.ts`, `tools/migrate.ts` | The migration runner and its command. |
| `tools/test-database.ts` | Provisioning of the test database. |
| `tools/bundle-check.ts` | The Worker bundle check (part of `build`). |
| `wrangler.jsonc`, `.dev.vars.example` | Binding names and secret names. No identifier, no bucket name, no value. |

## Commands

Run these from this directory, or through Turborepo from the repository root (`pnpm verify`).

| Command | Work |
| --- | --- |
| `pnpm run typecheck` | `tsc` on `src` with the Workers types and no Node types, then on `src`, `test`, `tools` with both. |
| `pnpm run lint` | Biome. |
| `pnpm run test` | Vitest on a real PostgreSQL server (below). |
| `pnpm run build` | `tsc` on `src`, then the Worker bundle check: `src/worker.ts` bundles for the neutral platform with no Node module, with Hono as the one bundled dependency and `pg` as the one import. |
| `pnpm run migrate` | Apply the pending migrations to `DATABASE_URL`. `-- --status` shows what is applied and pending. |

## Why the tests run in Node

wrangler, miniflare and `@cloudflare/vitest-pool-workers` are not installed, and no `pnpm dev:api` exists. This is a decision, not an omission:

- `wrangler` and `miniflare` pull in `sharp`, whose platform packages carry LGPL libvips and whose install script CI forbids (`--ignore-scripts`). `scripts/workspace/licences.ts` rejects the licence.
- `@cloudflare/vitest-pool-workers` needs `vitest` `^4.1`; the repository uses 5.1.0.

The tests therefore run in Node against the Hono app (`app.request`) and a real PostgreSQL server, through `pg` behind the small `Database` interface. `wrangler.jsonc` is a plain config file that no tool in this repository reads. Running the Worker under `workerd` with a Hyperdrive binding is a probe for P6 and a recorded limitation. Unverified until then:

- the Worker runtime itself: `pg` over `cloudflare:sockets` with `nodejs_compat`, Hyperdrive transactions, the R2 adapter, `ctx.waitUntil` closing the connection;
- that `wrangler` accepts `wrangler.jsonc` (the `main`, `hyperdrive` and `r2_buckets` entries need an id and a bucket name that P6 supplies), and that it bundles `pg` as the bundle check assumes;
- the bundle size on the platform: the bundle is about 3 MiB (about 240 KiB gzip), almost all of it the generated contract validators of `@openquant/api-contracts`;
- `WorkerBindings` in `src/env.ts` is written by hand, because `wrangler types` needs wrangler. `test/wrangler-config.test.ts` compares it with `wrangler.jsonc` and `.dev.vars.example` in both directions. This is a known drift risk until P6 adds the tool.

## Authentication and authority (OQ-05 §9, D12)

The application issues its own tokens. Three credentials appear in `Authorization: Bearer <token>`:

| Token | Form | Accepted by |
| --- | --- | --- |
| A person's long-lived credential | `oqk1.<id>.<secret>` | `auth.token` only, which exchanges it for an access token. |
| Access token | `oqa1.<payload>.<mac>`, 15 minutes, the subject only | The `human` routes. Roles (`Viewer`, `Researcher`, `Steward`, `Administrator`) are read from the database on every request, with no hierarchy, so a revoked role stops working at once. |
| Service credential | `oqk1.<id>.<secret>` of a `batch`, `runner`, `workflows` or `deploy` principal, with the route ids it may call | The `service` routes whose principals list it, when the route id is among its operations. |
| Attempt capability | `oqp1.<payload>.<mac>`, bound to one attempt and one ownership revision | The `attempt` routes, for the attempt in the path. |

- The database stores only the hash of a credential secret (SHA-256 with a domain prefix). The secret exists once, when it is issued. A test searches every table for every secret that it issues.
- Tokens are HMAC-SHA-256 over `<prefix>.<payload>` with the key of `TOKEN_SIGNING_KEY`, so a token of one type never verifies as another.
- A missing, malformed, unknown, expired, revoked or wrong-environment credential, or one of a disabled principal, is `401 UNAUTHENTICATED`. A valid credential that the route does not accept, a role or principal that it does not list, a service credential without the route among its operations, or a capability for another attempt than the path names is `403 FORBIDDEN`.
- A capability expires with its lease. The token is judged against the lease row, so a late submission is told what happened: `409 LEASE_EXPIRED`, or `409 STALE_OWNERSHIP` once a newer attempt of the same run or job exists, and the rejection is recorded in the audit log. No state changes. A capability of an attempt that already ended passes authorisation, and its route decides what a repeat gets.
- A caller that fails authentication or authorisation never has its body read.

## Routes

The route table is built from the manifest. A test checks that the app serves exactly the 29 routes of the `api` host and `/health`, and that each route has either a handler or an entry in the deferred table, never both. `runner.dispatch` belongs to the agent runner and is a 404 here.

Implemented here: `auth.token`, `system.identity` (environment, protocol versions from the manifest, the migration level read live, and the release recorded for the environment or the statement that none is), `/health`, the seven command routes (`research-profiles.register`, `cohort-policies.register`, `budgets.register`, `seeds.register`, `missions.create`, `missions.run-now`, `missions.cancel`) and `commands.show`.

Deferred, with the part that builds them (the message of the `UNAVAILABLE` answer names it):

| Part | Routes |
| --- | --- |
| P2 part C, attempts | `attempts.claim`, `attempts.input`, `attempts.artefact`, `attempts.retrieval-result`, `attempts.validation-result`, `attempts.evaluation-submission`, `attempts.gate-report`, `attempts.agent-result` |
| P2 part C, read models | `missions.show`, `missions.plan`, `missions.lineage`, `missions.trials`, `missions.findings`, `missions.gates`, `missions.decisions`, `runs.metrics`, `runs.result`, `jobs.show` |
| P2 part C, release | `releases.record` |

`api-error/1` has no "not implemented" code. `UNAVAILABLE` is in the error list of every route, and this answer is acceptable in this part only. A later part moves its routes from the table to the handler registry.

## Guarded commands (OQ-05 §§3 and 4, OQ-02 §§1 and 4, `command/1`)

A command carries its client command ID, the expected revision of its target and its payload. `src/commands/runner.ts` gives each of the nine kinds the same life:

1. **Accepted.** One transaction records the command as `PENDING` with its actor and the digest of its body. The same ID with the same body and actor returns the first result; with another body or another actor it is `COMMAND_ID_REUSED` and nothing is written. A principal who may not apply the kind gets `FORBIDDEN` before anything is recorded.
2. **Applied.** One transaction takes the command row lock, runs the applier of the kind and marks the command `APPLIED` with the record it produced (`id`, `revision`), together with every change and audit row of the applier. Two requests with one ID queue on the lock: the first applies, the second reads its result.
3. **Refused.** A refusal that belongs to the state of the system (`REVISION_CONFLICT`, `NOT_FOUND`, `POLICY_VIOLATION`, `BUDGET_EXHAUSTED`, `IDENTITY_MISMATCH`) rolls back everything of step 2 and is recorded in a third transaction with its code and reason. The same ID returns the same refusal, even after the state changed; the client uses a new ID to try again. A refusal for want of budget also blocks the mission that asked, in that transaction. Any other failure rolls back and leaves the command `PENDING`: it decided nothing, and a retry with the same ID applies it.

`commands.show` returns the stored status (`PENDING`, `APPLIED` or `REJECTED`) of any command to any person with a role. A client that timed out reads it back and never assumes that nothing changed.

`EXECUTION_DISABLED` is a switch of the deployment (`OPENQUANT_RESEARCH_EXECUTION`, `disabled` in `wrangler.jsonc`), not a decision about a command: `run_mission_now` and a claim are refused with it before anything is recorded, and nothing is dispatched. A refusal for a missing release identity works the same way (below).

| Command | Who | Target and expected revision | What it writes |
| --- | --- | --- | --- |
| `register_budget` | Steward | The budget cap; 0 for the first revision, then the latest. | The cap, its two period pools (model spend, provider requests), its document. A new revision may change the amounts, never the period or the currency, and never go below what the missions already hold. |
| `register_research_profile` | Steward | The profile; 0, then the latest. | The profile revision, bound to the current revision of the period budget that it names. |
| `register_cohort_policy` | Steward | The policy; 0, then the latest. | The policy revision and the Steward's approval Decision, which every policy-determined Decision under it names. The rules of the policy that a schema cannot state are checked (`policy-checks.ts`). |
| `register_seed` | Researcher | The draft; 0. The draft exists already: `REVISION_CONFLICT` at revision 1. | The draft by its digest and its source-interpretation record. It is not a Strategy Version. |
| `create_mission` | Researcher | 0 (the mission does not exist yet). | A `CREATED` mission at revision 1 with its budget, its agent configurations and the pools of its allowances. The whole mission budget is taken from the period budget that the profile names. |
| `run_mission_now` | Researcher | The mission revision. | `CREATED` to `IN_PROGRESS`, and the retrieval job with its attempt, reservation and outbox entry. |
| `cancel_mission` | Researcher | The mission revision. | `WITHDRAWN`; every open run and job `CANCELLED`; attempts and reservations as below. |
| `record_evaluation_decision` | `workflows` service principal, no route | The mission revision. | The policy-determined `DRAFT` to `EVALUATING` Decision. `APPROVED` writes the candidate's five development and validation runs with their attempts, reservations and outbox entries in one transaction; `DEFERRED` writes none. |
| `freeze_candidates` | `workflows` service principal, no route | The mission revision. | The holdout runs of every candidate in `EVALUATING`, with their reservations and outbox entries, in one transaction; with no candidate in `EVALUATING` no run, and the mission concludes `NO_ELIGIBLE_CANDIDATE`. |

Roles have no hierarchy: an Administrator is not a Steward, and a Steward is not a Researcher. A test goes through nine kinds and eight principals. The mission revision grows on every change of the mission (a start, a block, a withdrawal, a Decision, a freeze), so a workflow that read an older revision learns that the mission moved.

`record_evaluation_decision` checks, before it writes: the mission is `IN_PROGRESS`; the plan digest is the plan of the mission; the slot exists and has no Decision; the cohort policy, the approval Decision and the Researcher named are those of the mission; the strategy is the registered version of the slot and is still a `DRAFT`; for `APPROVED` the critic attempt completed for this slot and its result is a recorded artefact; for `DEFERRED` the critic job of the slot ended as the command says (the outcome and the number of attempts that the job recorded, and the cap exhausted for a retried outcome). In S1 no finding category blocks this transition, so `REJECTED` cannot be recorded. `freeze_candidates` checks that the slots are every slot of the plan once, that each `EVALUATING` slot has an `APPROVED` Decision for its strategy and no open run, and that each reason for a slot that is not evaluated is what the records show (`DECISION_DEFERRED`, `NO_REGISTERED_VERSION`, `SEED_NOT_EVALUATED`).

## State machine, fencing, retry and cancellation (OQ-05 §4)

`src/domain/transitions.ts` holds the transition table of OQ-05 §4 for runs, jobs, attempts, leases, reservations, outbox entries, missions and trials. Every status change checks it before the `UPDATE`; the database trigger (migration 0001) is the second line, and `test/domain.transitions.test.ts` proves that both lists equal a literal written from the specification.

- **Lock order** is the mission, then the run or job, then its attempts, then budget pools by ID. A cancellation and a completion of one mission therefore queue behind each other, and whichever commits first wins.
- **Compare-and-set.** A run, a job and a mission each have a `revision` that every change checks and increments.
- **Fencing.** An attempt holds an ownership revision (fixed when it is created, at most the attempt cap) and a lease. A submission, a failure report or a claim that does not come from the live owner is refused and changes nothing: `STALE_OWNERSHIP` for another revision or once a newer attempt exists, `LEASE_EXPIRED` for a lease that ended, `ATTEMPT_NOT_CLAIMABLE` for an attempt that is cancelled or has ended (a part C route maps it for its own error list). The rejection of a late submission is recorded in the audit log in the same transaction. A repeated submission therefore never makes a second result.
- **Retry classes** (`src/domain/retry.ts`). Retried within the attempt cap and the budget: lease expiry (a worker death or a runner crash), an agent timeout or malformed result, a retrieval failure of a transient class that the host marks retryable. Never retried: an agent refusal, denied capability, authentication failure or cancellation, and a retrieval failure of class authentication, permission, unsupported capability, cancellation or `EGRESS_REFUSED`, whatever the host says.
- **A retry** is a new attempt of the same run or job with its own reservation and outbox entry, and a message that names it. The failed attempt's reservation is settled by the usage it reported; after a lease expiry it stays `RESERVED` until `confirmTermination`.
- **No budget for a retry.** A retryable failure below the cap that the budget cannot cover (or that happens in a `BLOCKED` mission) leaves the run or job `QUEUED` with no live attempt and the reason in `waiting_reason`, and the mission `BLOCKED` with the same reason. Nothing resumes it: only `cancel_mission` ends it.
- **Cancellation.** `cancel_mission` cancels every open run and job (a waiting one too). A `PENDING` attempt is `CANCELLED`, its reservation `RELEASED` and its outbox entry `CANCELLED`. A `CLAIMED` attempt is `CANCELLED`, its lease `RELEASED` and its reservation kept until its termination is confirmed. A run or job that ended is not touched: a result that committed first wins.

The guarded functions that part C wraps in routes and recovery are exported from `src/domain/attempts.ts`: `claimAttempt`, `completeAttempt`, `failAttempt`, `expireLease`, `confirmTermination`, `reconcileReservation`, `markOutboxSent`, `cancelOpenWork`. Each takes the caller's transaction, so a route writes its result row in the same transaction. They return the typed refusal as data (`Guarded`), so the rejection can be recorded before the caller answers.

## Budgets (OQ-03 §1, OQ-05 §4, D22, D26)

Amounts are exact decimals (`decimal.ts`) in `numeric(24, 8)` columns; nothing is computed with floating point, and spend with more than eight fractional digits is rounded up.

- A **pool** is one limit. `committed` counts reservations and spend and can never exceed it. A mission has one model-spend pool for each agent configuration (its own allowance: no configuration can consume another's) and one pool each for provider requests, batch compute seconds and agent compute seconds. A period budget has a model-spend and a provider-request pool. Registering a new revision of the same period keeps what the missions hold.
- A mission **takes its whole budget from the period pool when it is created**: two missions at the pilot maxima use the 210 USD and 120 requests of the period, and a third is `BUDGET_EXHAUSTED`. A budget that the period can never hold is `POLICY_VIOLATION`.
- Every attempt **reserves its cap before dispatch**, in the transaction that writes it: an agent attempt the model spend per attempt from the allowance of its configuration and the agent timeout of the policy in compute seconds; a batch attempt the job timeout of the policy in compute seconds; a retrieval also its provider requests (the mission's requests over its attempt cap). An agent configuration also counts its attempts against its allowance of agent attempts.
- **Settlement** never returns more than the reservation. `consumed = min(usage, reservation)`; the rest returns to the pool; usage above the reservation is an **overrun** on the pool, which blocks further reservations and makes the mission `BLOCKED`. **Unknown usage is never zero**: a line that nothing reported keeps its reservation, and the reservation is `UNRECONCILED` until `reconcileReservation` settles it from a later report. Every movement is a row of the usage ledger.
- A retry consumes budget like a first attempt.

## Evaluation and retrieval requests

`src/domain/dispatch.ts` builds the dispatch message of the work that this part creates and stores its request document by digest: the `retrieval-request/1` of a mission's retrieval (the instrument, the dataset operations of the profile, its history range, the information cutoff, the data semantics, the limits) and the `evaluation-request/1` of each planned run (the strategy version, the resolved window of the plan, the cost scenario, the engine and method identity of the release recorded for the environment, the holdout withheld from every run that does not evaluate it). The cost stress multiplies the components that the cohort policy names. A test compares both with the fixtures of the protocol manifest.

A run request needs the release identity of the environment (the engine digest and the method identity come from the recorded `release-manifest/1`). Without one the command answers `EXECUTION_DISABLED`, stays `PENDING`, and applies when the same ID is retried after the release is recorded. Messages for `validate`, `assess` and agent work need inputs that part C records: a caller that creates such work passes its own builder, and a retry of it without one throws.

## Migrations

`migrations/NNNN_name.sql`, numbered from `0001` without a gap, each applied in its own transaction together with its row in `schema_migrations`, under one advisory lock. The runner refuses a changed or missing applied file and a file with transaction control. The migration level is the id of the last applied file; `system.identity` reads it for the release identity. Use a direct, not a pooled, connection string.

Migration `0008_commands` adds the strategy ID of a seed draft (unique, so two drafts of one strategy cannot both become version 1) and the reason of a withdrawal. Nothing is deployed, so the first column is `NOT NULL`.

State rules of the specifications are constraints: the transition table of OQ-05 §4 (`state_transitions` and one trigger per status column, with terminal states that never move), one live attempt per run or job, the attempt cap and fencing revisions, attempt, reservation and outbox written in one transaction, a budget pool that cannot commit more than its limit, one official result per run, results tied to a COMPLETED attempt and to the run status of OQ-02 §3.6, metrics only for COMPLETED results, holdout runs only through `freeze_candidates` slots, no EVALUATING to PAPER Decision and no PAPER lifecycle, hash-only credentials, and append-only audit. `test/constraints.*.test.ts` tries to break each one, and `test/transitions.test.ts` compares the transition table with a literal written from the specification.

## Test database

The test task needs PostgreSQL 14 or later. A Vitest global setup (`test/support/global-setup.ts`, with `tools/test-database.ts`) provides it:

1. `OPENQUANT_TEST_DATABASE_URL`, when set: an existing server whose role may create databases.
2. Otherwise a temporary cluster from the server binaries on the machine (`pg_config --bindir`, `PATH`, `/usr/lib/postgresql/<version>/bin` highest first, Homebrew, `/usr/local/pgsql/bin`): `initdb` and `pg_ctl` in a temporary directory, a socket directory and a random TCP port on 127.0.0.1. As root, PostgreSQL refuses to run, so every command goes through `runuser -u postgres`. The cluster is stopped and removed on exit, on SIGINT and SIGTERM, and a sweep at the start removes the directories of dead clusters.
3. Otherwise the run fails with instructions. It never skips.

The global setup applies the migrations with the runner to a template database, and each test file copies it. `apps/api/turbo.json` passes `OPENQUANT_TEST_DATABASE_URL`, `PATH` and `TMPDIR` through to the test task under Turborepo's strict environment mode.

Unverified until a pull request runs: the CI path (a non-root runner with the preinstalled PostgreSQL binaries and no service container) and the Turborepo pass-through in CI. Hyperdrive and Neon behaviour are not covered by a local cluster.

## Limits and open points

- No rate limiting: `RATE_LIMITED` is never emitted. A Workers rate-limit binding is a P6 item.
- The views (`access-token`, `system-identity`) are typed in `src/views.ts`, which `packages/api-client` cannot import (import boundary). A shared home is a decision for the lead.
- `/health` is not in the route manifest.
- `attention_items.status` takes the values `OPEN`, `ACKNOWLEDGED` and `RESOLVED`: the specifications name attention items and give no values.
- S1 uses four roles. No Operator role exists (OQ-05 §9 adds it with paper sessions).
- `releases.record` lists `REVISION_CONFLICT`, but its request carries no expected revision; its meaning is unspecified. Decide it before the route is built.
- The first Administrator and the service principals have no bootstrap command yet. `createPrincipal`, `grantRole` and `issueCredential` in `src/auth/credentials.ts` are the tested library functions that a bootstrap command will call.
- The mission budget stays taken from the period budget after a withdrawal or a conclusion: no S1 command returns the unspent part (the reservations of a cancelled mission do return to the mission's pools).
- The batch compute that an attempt reserves is the job timeout of the cohort policy, the per-attempt cap. The pilot proposes 600 seconds for an evaluate attempt and 7,200 batch seconds for a mission: 21 runs would reserve 12,600, so a mission with the proposed values is `BLOCKED` at its third candidate (a test shows it). P3 replaces the batch timeouts with measured values, and the policy and the mission budget must then agree.
- `max_retries` (2) and `request_timeout_seconds` (30) of a retrieval request have no source in the research profile or the cohort policy, so `dispatch.ts` sets them. The seed of an evaluation request is 0: the evaluator reads no random seed.
- The concurrency limits of the cohort policy (`concurrent_batch_attempts`, `concurrent_agent_attempts`) are not enforced yet: they belong to the claim route of part C, and `attempts.claim` lists no code for "try later".
- No table links an attempt to the agent result that it produced, so `record_evaluation_decision` checks the critique result only as a recorded artefact of the stated size. The agent-result route of part C should record the link.
- The evaluation plan, the dataset manifest and the registered Strategy Versions are written by part C. The tests write them with SQL, as part C will.
- Command IDs are global, as the table of migration 0007 makes them: a principal who guesses the predictable ID of a workflow command can take it first, and the workflow then gets `COMMAND_ID_REUSED`. Scoping the ID by actor needs a migration; the specification does not say.
- Recovery as a scheduled task, the outbox dispatcher and the Workflows are not built. Their guarded functions (`expireLease`, `confirmTermination`, `reconcileReservation`, `markOutboxSent`) are, with tests.

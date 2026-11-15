# Cloudflare control application

Status: S1 pull request P2 is implemented in three parts: the Hono route layer, authentication, the SQL migrations with their runner and the real-Postgres test setup (part A); the guarded commands, the state machine of jobs, runs, attempts, leases, reservations and outbox entries, and the budgets (part B); and the attempt, result, recovery, read-model and bootstrap work of part C. Every one of the 29 routes of the `api` host answers with data: no route answers "not implemented". The outbox dispatcher and the scheduled recovery pass are built on interfaces for the batch queue and the agent runner and are tested with fakes; the Worker runtime (workerd, Hyperdrive, R2, Queues), `ResearchWorkflow` and `EvaluationWorkflow` (P5) and the deployment (P6) are not built or tested here. S1 is incomplete: the connected competition is not implemented. M1 to M4 are not implemented.

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
| `src/handlers/` | One handler for every route of the `api` host (`index.ts` is the registry): identity, commands, the attempt routes (`attempts.ts`), the read routes (`reads.ts`) and the release route (`releases.ts`). |
| `src/commands/` | The guarded commands: the runner (`runner.ts`) and the appliers of the nine kinds (`registrations.ts`, `missions.ts`, `decisions.ts`), with the rules that a schema cannot state (`policy-checks.ts`). |
| `src/domain/` | The rules behind the commands and the routes: the transition table (`transitions.ts`), runs and jobs (`work.ts`), attempts, leases, retry and cancellation (`attempts.ts`, `retry.ts`), budgets (`budget.ts`), mission status (`missions.ts`), finding treatment and holdout consumption (`findings.ts`), registered documents (`documents.ts`, `store.ts`) and exact decimals (`decimal.ts`). The dispatch messages are built in `dispatch.ts` (retrieve, evaluate) and `builders.ts` (validate, assess, the retry of an agent, and `startValidation` and `startAssessment` for the workflow). Part C adds the claim (`claim.ts`), one acceptance function for each result route (`retrieval.ts`, `validation.ts`, `evaluation.ts`, `assessment.ts`, `agents.ts`), the outcome table of OQ-02 §3.6 (`outcomes.ts`), the evaluation plan (`plan.ts`), the reading of a role output (`critique.ts`), cited artefacts (`refs.ts`), the shared steps of a result route (`results.ts`) and attention items (`attention.ts`). |
| `src/outbox.ts` | The outbox dispatcher: the interfaces of the batch queue and of the agent runner, and the authenticated HTTPS call to the runner. |
| `src/recovery.ts` | One scheduled recovery pass: expired leases, confirmed terminations, and the dispatch of what is pending. |
| `src/read-models.ts` | The read models of the GET routes. |
| `src/db/` | The `Database` interface, the one node-postgres adapter, the migration level. |
| `src/store/objects.ts` | The content-addressed object store (`sha256/<hex>`) and its R2 adapter. It verifies the digest before it writes. |
| `migrations/` | Nine plain SQL files, `0001_identity` to `0009_attempt_routes`. |
| `tools/migrations.ts`, `tools/migrate.ts` | The migration runner and its command. |
| `tools/bootstrap.ts` | The bootstrap of an environment: the first Administrator and the service principals. |
| `tools/test-database.ts` | Provisioning of the test database. |
| `tools/bundle-check.ts` | The Worker bundle check (part of `build`). |
| `wrangler.jsonc`, `.dev.vars.example` | Binding names, secret names and the cron trigger. No identifier, no bucket name, no value. |

## Commands

Run these from this directory, or through Turborepo from the repository root (`pnpm verify`).

| Command | Work |
| --- | --- |
| `pnpm run typecheck` | `tsc` on `src` with the Workers types and no Node types, then on `src`, `test`, `tools` with both. |
| `pnpm run lint` | Biome. |
| `pnpm run test` | Vitest on a real PostgreSQL server (below). |
| `pnpm run build` | `tsc` on `src`, then the Worker bundle check: `src/worker.ts` bundles for the neutral platform with no Node module, with Hono as the one bundled dependency and `pg` as the one import. |
| `pnpm run migrate` | Apply the pending migrations to `DATABASE_URL`. `-- --status` shows what is applied and pending. |
| `pnpm run bootstrap -- --environment <E> --out <file>` | Create the first Administrator and the four service principals of an environment on a clean database (`DATABASE_URL`, a direct connection), and write their credentials, shown once, to a new file of mode 0600 (below). |

## Why the tests run in Node

wrangler, miniflare and `@cloudflare/vitest-pool-workers` are not installed, and no `pnpm dev:api` exists. This is a decision, not an omission:

- `wrangler` and `miniflare` pull in `sharp`, whose platform packages carry LGPL libvips and whose install script CI forbids (`--ignore-scripts`). `scripts/workspace/licences.ts` rejects the licence.
- `@cloudflare/vitest-pool-workers` needs `vitest` `^4.1`; the repository uses 5.1.0.

The tests therefore run in Node against the Hono app (`app.request`) and a real PostgreSQL server, through `pg` behind the small `Database` interface. `wrangler.jsonc` is a plain config file that no tool in this repository reads. Running the Worker under `workerd` with a Hyperdrive binding is a probe for P6 and a recorded limitation. Unverified until then:

- the Worker runtime itself: `pg` over `cloudflare:sockets` with `nodejs_compat`, Hyperdrive transactions, the R2 adapter, `ctx.waitUntil` closing the connection, the Queue producer binding that the dispatcher sends to, and the cron trigger that calls `scheduled` (the tests call both with fakes);
- that `wrangler` accepts `wrangler.jsonc` (the `main`, `hyperdrive`, `r2_buckets` and `queues` entries need an id, a bucket name and a queue name that P6 supplies), and that it bundles `pg` as the bundle check assumes;
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

The route table is built from the manifest. A test checks that the app serves exactly the 29 routes of the `api` host and `/health`, that each has one handler in `src/handlers/index.ts`, and that none answers `UNAVAILABLE`. `runner.dispatch` belongs to the agent runner and is a 404 here.

| Routes | What they do |
| --- | --- |
| `auth.token`, `system.identity`, `/health` | Identity (above). `/health` is not in the manifest. |
| `research-profiles.register`, `cohort-policies.register`, `budgets.register`, `seeds.register`, `missions.create`, `missions.run-now`, `missions.cancel`, `commands.show` | Guarded commands and their status read-back (below). |
| `attempts.claim`, `attempts.input`, `attempts.artefact` | The claim of an attempt and what a host reads and writes under its capability (below). |
| `attempts.retrieval-result`, `attempts.validation-result`, `attempts.evaluation-submission`, `attempts.gate-report`, `attempts.agent-result` | The five result submissions (below). |
| `missions.show`, `missions.plan`, `missions.lineage`, `missions.trials`, `missions.findings`, `missions.gates`, `missions.decisions`, `jobs.show`, `runs.metrics`, `runs.result` | Read models (below). |
| `releases.record` | The release identity of an environment (below). |

## Attempts and results (OQ-05 §§4, 5 and 7, OQ-02 §§3.6 and 8)

**Claim.** A service principal that received a dispatch message claims its attempt with `attempt-claim/1` before it does anything. The claim is refused, and nothing is written, when research execution is off (`EXECUTION_DISABLED`), when the principal is not the host of the message (`FORBIDDEN`: a batch credential cannot claim agent work), when the dispatch digest, the ownership revision or the executable (it must be one of the executables of the release recorded for the environment, once one is recorded) is not the attempt's (`IDENTITY_MISMATCH`, `STALE_OWNERSHIP`), when the attempt is not `PENDING` or its mission is withdrawn or concluded (`ATTEMPT_NOT_CLAIMABLE`), and when the mission already runs as many attempts on that host as the cohort policy allows (`RATE_LIMITED`, safe to repeat). The grant is a lease of the attempt timeout of the policy plus 60 seconds, and an `oqp1` capability that expires with it. The attempt is `CLAIMED`, the lease `HELD`, and the run or job `RUNNING`.

**Inputs and artefacts.** `attempts.input` serves an artefact that the dispatch message names, or that the request document of an evaluation or the submissions of an assessment name in turn, and no other. `attempts.artefact` is content-addressed: the Worker hashes the bytes, refuses them when they are not the digest of the path (`DIGEST_MISMATCH`) or above the artefact limit of the cohort policy (`LIMIT_EXCEEDED`), then writes the key `sha256/<hex>` and the artefact row with the uploader and the attempt. Fly hosts hold no storage credentials. Once the lease has ended, the capability reads and writes nothing (`LEASE_EXPIRED`, `STALE_OWNERSHIP`).

**Results.** Every result route runs one transaction through one function of `src/domain/`. The caller must hold the current lease and ownership revision, and the document must bind to its request:

| Route | Accepted when | Writes |
| --- | --- | --- |
| `attempts.retrieval-result` | The manifest (cited, uploaded, parsed within its limit) names this job, attempt and request, the mission's instrument, the research profile revision and data semantics, the claiming executable and the requested range, repeats the coverage of the result, and gives every bar the availability of its session close plus the profile's delay. | The job `COMPLETED` with its coverage (`COMPLETE`, `PARTIAL`, `NO_OBSERVATIONS`), the dataset manifest, the retrieval result, and the evaluation plan (below). A failure is classified: only a transient class is retried, within the cap and the budget. |
| `attempts.validation-result` | It names the draft and the parent that the job asked about, the engine and method of the release, the claiming executable and the policy's warm-up, and for a revision the declared changes equal the changes that Rust computed. | `VALID`: Strategy Version in `DRAFT`, its trial `REGISTERED`, its lineage. `INVALID`: the trial `INVALID` with the diagnostics. Either way the job is `COMPLETED`. |
| `attempts.evaluation-submission` | The submission names this run, attempt, request, mode, environment, engine, method and executable; the result is scanned (below) and its schema version, strategy hash, input hash, engine digest and outcome status and code equal the submission; the input repeats the windows, cutoff, capital, policy and seed of the request and is built from the mission's dataset manifest; the metrics derive from that result and input for the window and cost case of the run. | Exactly one official result for the run (`results.run_id` is its key), the metrics of a `COMPLETED` outcome, and the run status of the outcome table below. |
| `attempts.gate-report` | The report is the report of this job and candidate, the policy and its method, and lists every gate of the policy once with the outcome kind that the policy allows; every artefact it read was given to the job or committed by its runs. | The gate report and its results, the eligibility for `EVALUATING` to `PAPER` with its reasons, the treatment of the candidate's findings, and, when nothing is open, the conclusion of the mission. |
| `attempts.agent-result` | The provenance is that of the dispatch (request, bundle, session) and of the claiming runner; a completion returns the output contract of the role, within its limit and readable. | An outcome other than a completion: the logical run `FAILED` or retried (retry classes below). A completion: the run `COMPLETED`, the link from the attempt to its output (`agent_results`), and for a critic one finding per entry, labelled `model_judgement`; the registered policy, not the model, assigns the treatment. |

A violated binding is `IDENTITY_MISMATCH` (`SCHEMA_VIOLATION` or `LIMIT_EXCEEDED` where the contract layer says so). Its transaction rolls back whole, the attempt stays `CLAIMED` for the next try, and the refusal is recorded in the audit log. A submission that repeats the document that the attempt completed with returns the stored outcome and writes nothing; another document from the same attempt is `IDENTITY_MISMATCH`. A submission after the lease, after a newer attempt exists, or after `cancel_mission` is rejected (`LEASE_EXPIRED`, `STALE_OWNERSHIP`), the rejection is recorded in the same transaction, and nothing else changes. The usage in a result settles the reservation of its attempt: a value that nothing reported stays reserved and is never zero (budgets below). The Decision `record_evaluation_decision` cites a critique result only when it is the output that the completed critic attempt reported.

**The result scan.** The API reads a cited `evaluation-result/1` with `scanEvaluationResult` and never parses all of it. It accepts one of up to 8 MiB (`RESULT_SCAN_LIMIT`), although the parse limit of the contract is 512 KiB, and builds only its head. A larger result commits nothing: the run fails with `RESULT_TOO_LARGE` as a platform failure, an attention item is opened and the caller is told `LIMIT_EXCEEDED`. `test/results.scan.test.ts` submits results of 2 MiB and of exactly 8 MiB.

**Outcome to status** (`src/domain/outcomes.ts`, OQ-02 §3.6, D5, D6). The engine derives the status from the code, so a pair that does not belong together is refused.

| Outcome | Run | Gates | Attention item |
| --- | --- | --- | --- |
| `COMPLETED` | `COMPLETED`, with metrics | assessed from the metrics | no |
| `FAILED` with `INVALID_LEVEL` or an operator code | `FAILED` | correctness `FAIL`: the candidate's defect | no |
| `FAILED` with `FUTURE_DATA`, `EVENT_OUT_OF_ORDER`, or an input, schema, identity, policy or checkpoint code | `FAILED` | `INSUFFICIENT`: the platform's defect | yes |
| `FAILED` with `ARITHMETIC_OVERFLOW` | `FAILED` | `INSUFFICIENT`: outside the engine domain | no |
| `INSUFFICIENT` with any of its codes | `COMPLETED`, no metrics | `INSUFFICIENT` | no |
| `NOT_PREPARED` with a code | `FAILED`, no result document | as the `FAILED` rows | as the `FAILED` rows |

**A job that ends for good** (attempt cap exhausted, or a failure that is not retried) is not left to be found: a retrieval that failed blocks its mission with the reason; a validation that could not run discards its trial, with the reason; every kind but an agent's logical run opens an attention item (`attention_items`). An agent run's outcome is the input of the Decision (`DEFERRED`) and is not reported twice.

## The evaluation plan (OQ-02 §§3.1 and 3.3)

The plan is recorded in the transaction that accepts the retrieval, after retrieval and before any validation or run, and never changes (`src/domain/plan.ts`). It resolves each window rule of the cohort policy against the calendar of the frozen manifest: the first and last scored session, the session that starts its fixed warm-up, the information cutoff (the availability of the last scored bar) and the number of sessions of its run, including dividend payment sessions. It lists the trial slots (the seed, and one revision for each proposer configuration), every run slot (each window and cost case, the repeat of the D base run, the H slots), and the scenarios. Data that a run needs and the retrieved manifest lacks, a window that cannot be resolved, or a run above the session limit, does not give a plan: the mission is `BLOCKED` with the reason and an attention item. `NO_OBSERVATIONS` does the same. `missions.plan` serves the stored document.

The workflow starts the work that follows with `startValidation` (a validation of a draft: its trial row, a validate job and its first attempt) and `startAssessment` (one candidate's assessment, after its runs ended) in `src/domain/builders.ts`. They are entry points for P5, not routes. `startValidation` refuses what the lineage forbids (a seed with a parent or another draft; a revision whose parent is not the Strategy Version registered for the seed slot) and a slot that has used the revisions of the mission budget. The first attempt of an agent run is built by the workflow that assembles its request (OQ-03 §3); a retry repeats the message of the attempt before it, for its own attempt, session and result route.

## The dispatch outbox and recovery (OQ-05 §4)

The outbox entry is written with its attempt and reservation. `dispatchPending` (`src/outbox.ts`) sends the stored message to the batch queue (`job-dispatch/1`) or to the agent runner (`agent-dispatch/1`) through two small interfaces, so a test supplies fakes. A failed send leaves the entry `PENDING`, and the next pass sends the same message under the same attempt; an entry whose attempt was claimed already is marked `SENT` without a send, and a cancelled one is never sent. With research execution off, or without the binding of a destination, nothing is sent. The runner is called over HTTPS only, with the credential of the workflows principal, with no redirect.

`runRecovery` (`src/recovery.ts`) is one pass, run by the cron trigger of `wrangler.jsonc` every minute (`scheduled` in `src/worker.ts`), with no client connected:

1. A held lease that has ended is fenced: the attempt is `LEASE_EXPIRED`, and below the attempt cap and with budget a new attempt of the same run or job is written with its own reservation and outbox entry. At the cap the run or job is `FAILED`; with no budget it waits `QUEUED` and the mission is `BLOCKED`.
2. The reservation of a fenced attempt, or of one that `cancel_mission` cancelled while claimed, stays `RESERVED` until its termination is confirmed. A probe says whether the host stopped; the default one (`deadlineProbe`) confirms once the lease deadline and 300 seconds have passed. With no usage report the reservation becomes `UNRECONCILED`: the full amount counts as spent, and a later report can still settle it.
3. Every pending entry is sent.

Each step is idempotent, and one failing item is logged, counted in the summary and tried again on the next pass. The writes run under the one active `workflows` service principal of the environment; with none, the pass logs it and only sends.

## Read models (OQ-04 §§4 and 5, OQ-05 §7)

Any person with a role reads them, and none changes mission state. A value that nothing reported is `null` or labelled unreported, never zero (`used` of a reservation line, an unset treatment, an unfinished run). The shapes are API-owned (`src/read-models.ts`); `runs.metrics` and `runs.result` return the committed bytes unchanged, with `x-content-digest`, and `NOT_FOUND` while none is committed (a `FAILED` or `INSUFFICIENT` run has no metrics).

| Route | View |
| --- | --- |
| `missions.show` | Status, outcome and reasons, scope, profile and policy revision, plan digest, budget limits and pools, reservations by status, candidates by trial slot, jobs with their attempts, run counts, attention items. |
| `missions.plan` | The stored `evaluation-plan/1`. |
| `missions.lineage` | The Strategy Graph, derived: versions, parents, change scope, linked runs, findings and Decisions. |
| `missions.trials` | Trial slots, planned run slots with their run (status, mode, environment, attempts, holdout consumption), and every proposal, invalid and discarded ones too. |
| `missions.findings` | Findings with category, source, applicability and the treatment of each lifecycle transition. |
| `missions.gates` | Gate reports with eligibility and its reasons. |
| `missions.decisions` | Decisions with actor, outcome and evidence, and the Steward approval that each policy-determined Decision names. |
| `jobs.show` | A job or an evaluation run: attempts with outcome, lease, ownership revision, dispatch state and reservation lines. |

Revealing the result of a holdout run is consumption (OQ-02 §3.3, A05). The first read of the metrics or result of a `HOLDOUT` run, and the first read of a gate report that shows holdout observations, write one record per run in the transaction of that read.

## Release identity (OQ-05 §§9 and 11, D23)

`releases.record` stores the `release-manifest/1` that the delivery job built, for the environment of this API and at the migration level of its database (`IDENTITY_MISMATCH` otherwise). The same manifest twice is one record, and `system.identity` shows the newest. Run requests, claims, validation, evaluation and gate reports bind to the engine, method and executables of that record.

## Bootstrap (OQ-05 §9, D12)

`pnpm --filter @openquant/api run bootstrap -- --environment STAGING --out /path/to/secrets.json` (with `DATABASE_URL`, a direct connection) creates the first Administrator and the `batch`, `runner`, `workflows` and `deploy` principals of an environment, and one credential for each. It is a command with the database role that applies the migrations, not a route: nobody who can only reach the API can create an Administrator. The credentials go to the file that the operator names, which the command creates with mode 0600 and never overwrites; the command prints identifiers and the path, no secret. The database stores only hashes. The file belongs in a secret store (GitHub environment secrets, Fly secrets), never in version control; the operator moves each secret and deletes the file. A failure removes the file and creates nothing. It refuses an environment that has principals already. The Administrator has that role only (no hierarchy, no trading authority); each service credential carries the operations that the manifest lists for its principal.

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

A run request needs the release identity of the environment (the engine digest and the method identity come from the recorded `release-manifest/1`). Without one the command answers `EXECUTION_DISABLED`, stays `PENDING`, and applies when the same ID is retried after the release is recorded. `builders.ts` builds the `validate` and `assess` messages (below). The first attempt of agent work needs the role request that the workflow assembles, so its caller passes its own builder; its retry repeats the message of the attempt before it.

## Migrations

`migrations/NNNN_name.sql`, numbered from `0001` without a gap, each applied in its own transaction together with its row in `schema_migrations`, under one advisory lock. The runner refuses a changed or missing applied file and a file with transaction control. The migration level is the id of the last applied file; `system.identity` reads it for the release identity. Use a direct, not a pooled, connection string.

Migration `0008_commands` adds the strategy ID of a seed draft (unique, so two drafts of one strategy cannot both become version 1) and the reason of a withdrawal. Migration `0009_attempt_routes` adds the draft and parent of a validate job, the digest of the result document that an attempt ended with (so a repeated submission finds it), and `agent_results`, the link from an agent attempt to its output. Nothing is deployed, so the first columns are `NOT NULL`.

State rules of the specifications are constraints: the transition table of OQ-05 §4 (`state_transitions` and one trigger per status column, with terminal states that never move), one live attempt per run or job, the attempt cap and fencing revisions, attempt, reservation and outbox written in one transaction, a budget pool that cannot commit more than its limit, one official result per run, results tied to a COMPLETED attempt and to the run status of OQ-02 §3.6, metrics only for COMPLETED results, holdout runs only through `freeze_candidates` slots, no EVALUATING to PAPER Decision and no PAPER lifecycle, hash-only credentials, and append-only audit. `test/constraints.*.test.ts` tries to break each one, and `test/transitions.test.ts` compares the transition table with a literal written from the specification.

## Test database

The test task needs PostgreSQL 14 or later. A Vitest global setup (`test/support/global-setup.ts`, with `tools/test-database.ts`) provides it:

1. `OPENQUANT_TEST_DATABASE_URL`, when set: an existing server whose role may create databases.
2. Otherwise a temporary cluster from the server binaries on the machine (`pg_config --bindir`, `PATH`, `/usr/lib/postgresql/<version>/bin` highest first, Homebrew, `/usr/local/pgsql/bin`): `initdb` and `pg_ctl` in a temporary directory, a socket directory and a random TCP port on 127.0.0.1. As root, PostgreSQL refuses to run, so every command goes through `runuser -u postgres`. The cluster is stopped and removed on exit, on SIGINT and SIGTERM, and a sweep at the start removes the directories of dead clusters.
3. Otherwise the run fails with instructions. It never skips.

The global setup applies the migrations with the runner to a template database, and each test file copies it. `apps/api/turbo.json` passes `OPENQUANT_TEST_DATABASE_URL`, `PATH` and `TMPDIR` through to the test task under Turborepo's strict environment mode.

Unverified until a pull request runs: the CI path (a non-root runner with the preinstalled PostgreSQL binaries and no service container) and the Turborepo pass-through in CI. Hyperdrive and Neon behaviour are not covered by a local cluster.

## Limits and open points

What part C does not do, and what a reader must not assume:

- **Not built here.** `ResearchWorkflow` and `EvaluationWorkflow` (P5) call the entry points of this package (`startValidation`, `startAssessment`, `record_evaluation_decision`, `freeze_candidates`, the agent builder); nothing here starts a proposer, reads a proposal or decides when to freeze. The batch host (P3) and the agent runner (P4) are not called by any test: the tests play their side through the HTTP routes with synthetic documents. The Queues pull consumer, the queue name, the Hyperdrive and R2 identifiers and the Worker runtime are P6.
- **Replay runs.** `evaluation-request/1` has a `REPLAY` mode and the runs table allows it, but a run without a mission has no budget to draw on, so the evaluation route accepts `BACKTEST` runs only. The connected S0 replay is P5.
- **Role outputs.** The shared parsers of `packages/agents` are not an import of this package yet. The API reads a critic's output with its own strict reading of `strategy-critique.result/1` (`src/domain/critique.ts`) so that the findings it records are what the critic returned, and a proposer's output only for its tag and proposal kind; the workflow that reads the proposal must use the shared parser. Reference checks against the request (cited methods, evidence, elements) are the shared parser's job.
- **Termination is assumed from the clock.** `deadlineProbe` takes a host to have stopped 300 seconds after its lease ended. No platform call backs it: P6 supplies a probe that asks Fly. The assumption is safe in one direction: confirming without a report releases nothing.
- **Rate limiting.** `RATE_LIMITED` is answered only by the claim route, for the concurrency limit of the cohort policy. There is no general rate limit; a Workers rate-limit binding is a P6 item.
- **Attention items.** `attention_items.status` takes the values `OPEN`, `ACKNOWLEDGED` and `RESOLVED`: the specifications name attention items and give no values. No route reads or changes them yet; `missions.show` lists them.
- **View shapes.** The views are typed here and in `src/views.ts`, which `packages/api-client` cannot import (import boundary). A shared home is a decision for the lead.
- `releases.record` lists `REVISION_CONFLICT`, but its request carries no expected revision; its meaning is unspecified, so the route never answers it.
- `/health` is not in the route manifest. S1 uses four roles: no Operator role exists (OQ-05 §9 adds it with paper sessions).
- The mission budget stays taken from the period budget after a withdrawal or a conclusion: no S1 command returns the unspent part (the reservations of a cancelled mission do return to the mission's pools).
- The batch compute that an attempt reserves is the job timeout of the cohort policy, the per-attempt cap. The pilot proposes 600 seconds for an evaluate attempt and 7,200 batch seconds for a mission: 21 runs would reserve 12,600, so a mission with the proposed values is `BLOCKED` at its third candidate (a test shows it). P3 replaces the batch timeouts with measured values, and the policy and the mission budget must then agree.
- `max_retries` (2) and `request_timeout_seconds` (30) of a retrieval request have no source in the research profile or the cohort policy, so `dispatch.ts` sets them. The seed of an evaluation request is 0: the evaluator reads no random seed.
- The retrieval cutoff of a request assumes a 16:00 New York close on the last window end date, because the retrieved calendar does not exist yet; the plan then resolves the real cutoff from the retrieved bars.
- A claim made before any release is recorded skips the executable check of the release (there is none to check against); every result route needs a release and refuses without one.
- Command IDs are global, as the table of migration 0007 makes them: a principal who guesses the predictable ID of a workflow command can take it first, and the workflow then gets `COMMAND_ID_REUSED`. Scoping the ID by actor needs a migration; the specification does not say.

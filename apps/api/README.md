# Cloudflare control application

Status: S1 pull request P2, part A, the durable API foundation, is implemented: the Hono route layer for every route of the route manifest, authentication, the SQL migrations with their runner, and the real-Postgres test setup. Only `auth.token`, `system.identity` and `/health` answer with data. The other 27 routes pass the whole route layer and then answer `UNAVAILABLE` and name the part that builds them. The guarded commands, the attempt and result routes, the read models, recovery, the outbox dispatcher and both Workflows are not implemented. S1 is incomplete, and M1 to M4 are not implemented.

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
| `src/handlers/` | The handlers that exist (`auth.token`, `system.identity`) and the table of the deferred routes. |
| `src/db/` | The `Database` interface, the one node-postgres adapter, the migration level. |
| `src/store/objects.ts` | The content-addressed object store (`sha256/<hex>`) and its R2 adapter. It verifies the digest before it writes. |
| `migrations/` | Seven plain SQL files, `0001_identity` to `0007_control`. |
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

Implemented here: `auth.token`, `system.identity` (environment, protocol versions from the manifest, the migration level read live, and the release recorded for the environment or the statement that none is), `/health`.

Deferred, with the part that builds them (the message of the `UNAVAILABLE` answer names it):

| Part | Routes |
| --- | --- |
| P2 part B | `research-profiles.register`, `cohort-policies.register`, `budgets.register`, `seeds.register`, `missions.create`, `missions.run-now`, `missions.cancel`, `commands.show` |
| P2 part C, attempts | `attempts.claim`, `attempts.input`, `attempts.artefact`, `attempts.retrieval-result`, `attempts.validation-result`, `attempts.evaluation-submission`, `attempts.gate-report`, `attempts.agent-result` |
| P2 part C, read models | `missions.show`, `missions.plan`, `missions.lineage`, `missions.trials`, `missions.findings`, `missions.gates`, `missions.decisions`, `runs.metrics`, `runs.result`, `jobs.show` |
| P2 part C, release | `releases.record` |

`api-error/1` has no "not implemented" code. `UNAVAILABLE` is in the error list of every route, and this answer is acceptable in this part only. A later part moves its routes from the table to the handler registry.

## Migrations

`migrations/NNNN_name.sql`, numbered from `0001` without a gap, each applied in its own transaction together with its row in `schema_migrations`, under one advisory lock. The runner refuses a changed or missing applied file and a file with transaction control. The migration level is the id of the last applied file; `system.identity` reads it for the release identity. Use a direct, not a pooled, connection string.

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

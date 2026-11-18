# Fly.io profiles

One profile per app, named after the app. The delivery job deploys a pinned image by digest with pinned flyctl (`flyctl deploy --config infra/fly/<app>.toml --image <registry>/<repository>@sha256:<digest>`); a profile never builds.

| File | Checkpoint | Required boundary |
| --- | --- | --- |
| `openquant-staging-agent-runner.toml` | M1 | Separate app; isolated delegated CLI; no broker, repository-write, or deployment authority. One TLS service on internal port 8080 for `runner.dispatch` and `runner.cancel`; the proxy never stops its Machines. Execution stays off (`AGENT_RUNNER_ENABLED=false`) until the executor probe passes. |
| `openquant-staging-engine-batch.toml` | M1 | Separate app; bounded native compute; HTTP-pull queue; attempt-scoped outcomes. No service at all: it only pulls. |
| `engine-paper.toml` | M2/M3 | Persistent live-data paper/shadow sessions; no broker trading credentials. |
| `engine-live.toml` | M4 | Isolated live app; one account writer; separately protected deploy and secrets. |

The paper and live profiles are not supplied as dummy configurations. Pin tested images and select a region from actual data/broker/database needs. The staging profiles propose `iad`; the owner confirms it against the Neon region before the first deployment. Their Machine sizes (`shared-cpu-2x`, 1 GB for the batch host, 2 GB for the runner) and the restart policy (`on-failure`, five retries) are starting values for the deployment probe to confirm.

Do not use HTTP-idle autostop for paper/live sessions. Keep the batch consumer running unless a tested wake-up path exists. Root disks are scratch. A recovery journal is not a second canonical portfolio database.

Fly app secrets are app-wide. Process groups alone do not isolate broker credentials. Test old-writer shutdown, restart reconciliation, and read-back before any live resumption.

The termination probe of the API (`apps/api/src/fly-probe.ts`) reads the state of the Machine that ran a fenced attempt through the Machines API, with a read-only token, and confirms the termination only for a `stopped` or `destroyed` Machine. A batch Machine keeps running between attempts, so the reservation of an attempt fenced on a running Machine stays held until that Machine stops or is replaced (decision D22). [`scripts/infrastructure.ts`](../../scripts/infrastructure.ts) checks these files; `flyctl config validate` has not been run on them.

# Infrastructure

The staging infrastructure is defined as code (P6.1) and has not been deployed: no account, credential, image, state or plan exists for it. The owning contracts are [architecture](../docs/specs/05-system-architecture-and-data-spec.md) and [engineering](../docs/specs/06-engineering-delivery-and-operations-spec.md).

| Area | Owner | Files |
| --- | --- | --- |
| [Terraform](terraform/README.md) | Supported Cloudflare resources. | The R2 bucket, the batch queue, Hyperdrive with caching off, the Worker route. |
| [Fly](fly/README.md) | Versioned native app profiles and controlled flyctl rollout. | `openquant-staging-engine-batch`, `openquant-staging-agent-runner`. |
| [Environments](environments/README.md) | Non-secret names, bindings, capabilities, and release references. | `staging.json`. |
| Images | The delivery job builds and pushes them by digest. | [`apps/engine/Dockerfile`](../apps/engine/Dockerfile), [`apps/agent-runner/Dockerfile`](../apps/agent-runner/Dockerfile), the root `.dockerignore`. |

Add concrete resource identifiers only after provisioning and read-back. Do not place placeholder IDs in deployable configuration. GitHub Actions is the release controller; Cloudflare runs product scheduling and workflows.

## What is checked here, and what is not

`pnpm verify:repository` (and `pnpm verify`) runs the static checks of [`scripts/infrastructure.ts`](../scripts/infrastructure.ts) on these files: the environment profile holds names only and agrees with the Fly profiles, `apps/api/wrangler.jsonc`, `apps/api/.dev.vars.example` and the Terraform variables; each Fly profile is its app with one region, Machine size and restart policy, and no secret in `[env]`; the batch host has no service and the runner has its one TLS service; each Dockerfile pins its base images by digest and ends as a non-root user with no credential in `ENV` or `ARG`; the engine image is a locked release build on the pinned toolchain; the runner image uses the pinned Node, pnpm and executor version; `.dockerignore` excludes history, dependencies and credential files; Terraform pins its provider exactly, leaves the backend to init, disables Hyperdrive caching and holds no literal identifier or variable file.

Not checked, and not yet run:

- `terraform init` and `terraform validate`: Terraform is not installed in the development container. The resource attributes follow the Cloudflare provider 5.x documentation as last known and are not validated. Run `terraform -chdir=infra/terraform init -backend=false && terraform -chdir=infra/terraform validate` before the first plan.
- `flyctl config validate`: the Fly profiles are read only by the static checks. Their keys (`[[vm]]`, `[[restart]]`, `[[services]]`) follow Fly's configuration reference as last known.
- A local `docker build`: there is no Docker daemon in the development container. The engine build steps (`cargo build --release --locked` and the loopback refusal check) and the runner build steps (`pnpm --filter "@openquant/agent-runner..." run build`, and the install of Claude Code 2.1.325 with its `--version` check) were run natively instead. No image has been built.
- The base image digests are the index digests that Docker Hub reported for `rust:1.97.0-slim-bookworm`, `debian:bookworm-slim` and `node:24.19.0-bookworm-slim` on 2026-11-18; they were not pulled.
- A CI image build. A `docker build` job (no push) is left for P6.2: the CI aggregate rules would accept one more job that the aggregate `ci` needs and checks, but the workflow guard tests (`scripts/workspace/tests/workflows.test.ts`, `scripts/tests/repository.test.ts`) edit `ci.yml` on the assumption of one checkout step and one needed job, so the job needs those tests reworked with it, and its first run should not be a required check that has never passed.
- Every deployment probe of OQ-06 §4, the egress probe and the executor probe.

## What the owner provides before the first staging deployment

Accounts: a Cloudflare account with a zone for the API host, Workers, R2, Queues and Hyperdrive; a Fly.io organisation; the Neon project with its migration and application roles (D23); an Anthropic API key for the runner (only when execution is enabled); an Alpaca paper account (only when provider retrieval is enabled); a state store for Terraform.

The names of every secret and setting are in [`environments/staging.json`](environments/staging.json); the values never enter Git. [Environments](environments/README.md) lists where each one is set.

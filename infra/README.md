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

The workflow [`infrastructure-check.yml`](../.github/workflows/infrastructure-check.yml) runs on a pull request that changes these files or the images' inputs, and on dispatch. It uses no secret and is not part of the required `ci` aggregate. Its `images` job builds both images (no push), runs `engine-batch --check-config` in the built image with a synthetic configuration (exit 0) and with the loopback variables added (exit 2), checks that `claude --version` names the pinned executor version, starts the runner with `AGENT_RUNNER_ENABLED=false` and no network, opens a TCP connection to its port (the runner has no health route; Fly checks it the same way), sends a dispatch without a credential (401 `UNAUTHENTICATED`), and stops it with SIGTERM (exit 0). Its `terraform` job downloads Terraform 1.17.0 from releases.hashicorp.com, checks the archive against the SHA-256 in the workflow and in the published `SHA256SUMS`, and runs `terraform fmt -check -recursive`, `terraform init -backend=false` and `terraform validate` in `infra/terraform`.

Not checked, and not yet run:

- A Terraform plan or apply: they need the owner's account, credential and state store.
- `flyctl config validate`: it needs a Fly login, so the delivery workflow runs it with the owner's Fly token. Until then the Fly profiles are read only by the static checks. Their keys (`[[vm]]`, `[[restart]]`, `[[services]]`) follow Fly's configuration reference as last known.
- A local `docker build`: there is no Docker daemon in the development container, so the images are built only by `infrastructure-check.yml`.
- The base image digests are the index digests that Docker Hub reported for `rust:1.97.0-slim-bookworm`, `debian:bookworm-slim` and `node:24.19.0-bookworm-slim` on 2026-11-18; they were not pulled in the development container. `infrastructure-check.yml` pulls them by digest when it builds the images.
- Every deployment probe of OQ-06 §4, the egress probe and the executor probe.

## What the owner provides before the first staging deployment

Accounts: a Cloudflare account with a zone for the API host, Workers, R2, Queues and Hyperdrive; a Fly.io organisation; the Neon project with its migration and application roles (D23); an Anthropic API key for the runner (only when execution is enabled); an Alpaca paper account (only when provider retrieval is enabled); a state store for Terraform.

The names of every secret and setting are in [`environments/staging.json`](environments/staging.json); the values never enter Git. [Environments](environments/README.md) lists where each one is set.

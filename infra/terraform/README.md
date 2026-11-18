# Terraform ownership

At M1, manage supported Cloudflare storage, cache-disabled Hyperdrive, batch queue, routes/DNS, and access resources. Use versioned setup commands for the HTTP-pull consumer where required.

Keep state, plans, and secrets out of Git. Wrangler owns Worker code and bindings. flyctl owns Fly app deployment. Do not assign the same resource to two tools.

## Files

| File | Content |
| --- | --- |
| `versions.tf` | Terraform `~> 1.17.0`, the Cloudflare provider pinned at `= 5.28.1`, and an empty `s3` backend block. |
| `variables.tf` | Every value: account, zone, bucket, queue, Hyperdrive and database settings, Worker name and route pattern. `database_password` is sensitive. No variable has a default except the optional bucket location. |
| `main.tf` | `cloudflare_r2_bucket.artefacts`, `cloudflare_queue.batch`, `cloudflare_hyperdrive_config.application` with `caching = { disabled = true }`, and `cloudflare_workers_route.api`. |
| `outputs.tf` | The bucket name, the queue id and name, and the Hyperdrive id that the Wrangler deployment needs for its bindings. |

The HTTP-pull consumer of the queue is not a resource here: the infrastructure workflow configures it with a versioned setup command (OQ-06 §3). The provider reads `CLOUDFLARE_API_TOKEN` from the environment of the protected job.

## State

The backend block is empty on purpose: the state store is chosen at init and kept out of Git. With a file of S3 backend settings that is not tracked (bucket, key, region, endpoint and credentials of the owner's store, such as an R2 bucket):

```sh
terraform -chdir=infra/terraform init -backend-config=<untracked backend settings file>
terraform -chdir=infra/terraform validate
terraform -chdir=infra/terraform plan -out=<untracked plan file>
```

Supply variables as `TF_VAR_<name>` from the protected environment, never in a tracked `.tfvars` file. The Hyperdrive password is in the state, so the state store is a secret store.

## Checks

[`infrastructure-check.yml`](../../.github/workflows/infrastructure-check.yml) runs `terraform fmt -check -recursive`, `terraform init -backend=false` and `terraform validate` here with Terraform 1.17.0, whose archive it checks against a pinned SHA-256. No plan has run: it needs the owner's account, credential and state store. [`scripts/infrastructure.ts`](../../scripts/infrastructure.ts) checks the exact provider pin, `required_version`, the empty backend, Hyperdrive caching, the absence of literal identifiers and of tracked variable files, and that the variables equal the list in `infra/environments/staging.json`.

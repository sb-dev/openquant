# Environment profiles

Use development, staging, and production profiles. A production API does not enable live trading.

Profiles contain non-secret app names, regions, bindings, capabilities, schema/migration requirements, and immutable release references. Credentials belong in their scoped secret stores.

Missing required configuration must fail validation. Do not substitute placeholder IDs. Test environment protections and deployed identity before claiming a deployment works.

## `staging.json`

The staging profile (`openquant-environment/1`) names hosts, Fly apps, tracked files and the names of settings and secrets. It holds no value: [`scripts/infrastructure.ts`](../../scripts/infrastructure.ts) fixes its shape, so an extra key, a name with a value or a URL in place of a host fails `pnpm verify`. It also must agree with the files it names: each Fly profile configures its app, no listed setting or secret is set in that profile's `[env]`, the Worker variables equal the `vars` of `apps/api/wrangler.jsonc`, the Worker secrets equal the names of `apps/api/.dev.vars.example`, and the Terraform variables and sensitive variables equal those of `infra/terraform`. Production and development profiles are added with their own checks.

| Entry | Where its values are set |
| --- | --- |
| `hosts` | The hosts that staging talks to. The API host is the owner's domain and appears as the settings below. |
| `cloudflare.worker.variables` | Plain Worker variables, set per environment by the Wrangler deployment: `OPENQUANT_ENVIRONMENT=STAGING`, `OPENQUANT_RESEARCH_EXECUTION` (stays `disabled` until the deployment is verified), `AGENT_EXECUTOR_VERSION`, and the two Fly apps of `fly_apps`. |
| `cloudflare.worker.secrets` | `wrangler secret put`. `FLY_MACHINES_READ_TOKEN` is a read-only Fly token for the Machines of both apps; with the two app names it turns the termination probe on (`apps/api/src/fly-probe.ts`). |
| `cloudflare.terraform.variables` | `TF_VAR_*` variables of the protected infrastructure job; `secret_variables` come from its secret store. `credentials` (`CLOUDFLARE_API_TOKEN`) is read by the provider. |
| `fly.<app>.settings` | Non-secret values that only the owner knows (the API origin, the queue account and id), set on the app with `fly secrets set` because a tracked profile holds no placeholder. |
| `fly.<app>.secrets`, `optional_secrets` | `fly secrets set` on that app only (OQ-05 §5: app secrets reach every Machine of the app). The Alpaca pair is optional: without it provider retrieval stays off. |

How an attempt is mapped to its Fly Machine: the host's claim names it. On a Machine, `engine-batch` and the agent runner build their `attempt-claim/1` worker name from `FLY_MACHINE_ID` (`fly:<machine id>:<process>`), the API stores it on the attempt, and the termination probe asks the Machines API about that Machine in the app of the attempt's destination (`fly.<app>` through `cloudflare.worker.fly_apps`). It confirms a termination only for a `stopped` or `destroyed` Machine.

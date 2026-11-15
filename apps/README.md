# Applications

Directories reserve ownership until their checkpoint. The agent runner is implemented for S1 and tested with a fake executor, and its evaluation harness (`pnpm agents:eval`) refuses a real-model run without the owner's key and an explicit opt-in; nothing here is deployed.

| Path | Purpose | First checkpoint |
| --- | --- | --- |
| [cli](cli/README.md) | TypeScript Ink operator client | M1 |
| [api](api/README.md) | Cloudflare control application | M1 |
| [agent-runner](agent-runner/README.md) | Fly.io delegated execution host (implemented for S1, tested with a fake executor, not deployed) | M1 |
| [engine](engine/README.md) | Native Rust host | M1 |
| [web](web/README.md) | Public static website | Public release onward |

Add manifests and tests with working code. See [architecture](../docs/specs/05-system-architecture-and-data-spec.md).

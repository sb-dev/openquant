# Applications

Directories reserve ownership. No executable application is present in the bootstrap.

| Path | Purpose | First checkpoint |
| --- | --- | --- |
| [cli](cli/README.md) | TypeScript Ink operator client | C1 |
| [api](api/README.md) | Cloudflare control application | C2 |
| [agent-runner](agent-runner/README.md) | Fly.io delegated execution host | C2 |
| [engine](engine/README.md) | Native Rust host | C1 |
| [web](web/README.md) | Public static website | C1 onward |

Add manifests and tests with working code. See [architecture](../docs/specs/05-system-architecture-and-data-spec.md).

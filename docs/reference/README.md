# Reference

Implemented bootstrap commands:

| Command | Purpose |
| --- | --- |
| `pnpm verify` | All implemented bootstrap checks and regression tests. |
| `pnpm verify:repository` | Repository integrity checks. |
| `pnpm test` | Checker regression tests. |
| `pnpm generate:spec-index` | Regenerate the canonical ownership/version index. |
| `pnpm generate:tree` | Regenerate the tracked-file map. |

The equivalent Node commands are in root `package.json`. Application CLI, API, strategy/protocol schemas, exit codes, configuration, and integration catalogues are added with their implementation. See [engineering §7](../specs/06-engineering-delivery-and-operations-spec.md#7-application-command-contract).

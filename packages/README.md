# Shared packages

Keep these four package boundaries. API-only modules remain in `apps/api`.

| Path | Purpose | First checkpoint |
| --- | --- | --- |
| [api-contracts](api-contracts/README.md) | Shared wire schemas | M1/S0 schema source and Rust validation; S1 TypeScript validation |
| [api-client](api-client/README.md) | Typed client transport (S1 HTTP client implemented) | M1 |
| [agents](agents/README.md) | Versioned proposer/critic behaviour | M1 (pre-S0 draft assets; role modules S1) |
| [quant-core](quant-core/README.md) | Shared Rust numerical library | M1/S0 |

S0 added Rust code under `quant-core` and `api-contracts/rust` (the generated bindings crate). S1 adds the TypeScript package `api-contracts/ts`, the first entry of the pnpm workspace, and `agents`, the second: the proposer and critic role modules, their behaviour bundle and offline suites, with no model call. S1 then adds `api-client`, the typed client of the API routes. The other directories are reserved and their executable packages are not implemented.

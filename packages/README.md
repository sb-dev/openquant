# Shared packages

Keep these four package boundaries. API-only modules remain in `apps/api`.

| Path | Purpose | First checkpoint |
| --- | --- | --- |
| [api-contracts](api-contracts/README.md) | Shared wire schemas | M1/S0 schema source and Rust validation; S1 TypeScript validation |
| [api-client](api-client/README.md) | Typed client transport | M1 |
| [agents](agents/README.md) | Versioned proposer/critic behaviour | M1 (pre-S0 draft assets; role modules S1) |
| [quant-core](quant-core/README.md) | Shared Rust numerical library | M1/S0 |

Directories are reserved; executable packages are not implemented. `packages/agents` holds non-executable draft assets checked by repository tooling.

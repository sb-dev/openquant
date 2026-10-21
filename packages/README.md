# Shared packages

Keep these four package boundaries. API-only modules remain in `apps/api`.

| Path | Purpose | First checkpoint |
| --- | --- | --- |
| [api-contracts](api-contracts/README.md) | Shared wire schemas | C1 |
| [api-client](api-client/README.md) | Typed client transport | C1/C2 |
| [agents](agents/README.md) | Versioned proposer/critic behaviour | C2 |
| [quant-core](quant-core/README.md) | Shared Rust numerical library | C1 |

Directories are reserved; executable packages are not implemented.

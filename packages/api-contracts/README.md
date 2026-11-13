# Shared wire schemas

Status: S0 implemented for the schema source and Rust validation (crate `openquant-contracts` in `rust`, bindings generated at build time from `schemas`). S1 adds TypeScript validation.

Language-neutral contracts and runtime validation. Generate bindings and execute shared valid/invalid fixtures in TypeScript and Rust. Money and quantities are decimal strings.

S0 adds the seed's strategy/evaluation input, numerical result and checkpoint schemas in `schemas`, with generated Rust bindings and shared payload fixtures. These are the same contracts reused by S1 and the public CLI. S1 adds TypeScript bindings and connected run/attempt/ownership envelopes. S0 does not require an executable TypeScript package or API service.

See [architecture](../../docs/specs/05-system-architecture-and-data-spec.md) and the [M1 guide](../../docs/guides/m1-watchlist-research.md).

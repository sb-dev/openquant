# Native Rust host

Status: S0 local harness implemented (`s0-replay`, crate `openquant-engine`). The connected batch host is planned for M1/S1.

Thin entry points around quant-core. S0 runs the core locally through a small harness; it does not require the connected batch host. Add batch hosting and the first market adapter in S1, then the second market adapter in S2. Add live-data paper at M2, shadow validation at M3, and separately deployed live execution at M4. Market and broker adapters belong beside this host.

Tests (`cargo test -p openquant-engine`): `tests/s0_fixtures.rs` runs every S0 fixture case; `tests/compare.rs`, `tests/report.rs` and `tests/s0_replay_cli.rs` pin the comparison, the report and the exit status. `s0-replay` exits 1 on any difference or coverage problem and 2 on a usage or file error.

Owner: [05-system-architecture-and-data-spec.md](../../docs/specs/05-system-architecture-and-data-spec.md). Add executable files and required verification together.

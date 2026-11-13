# Native Rust host

Status: S0 local harness implemented (`s0-replay`, crate `openquant-engine`). The connected batch host is planned for M1/S1.

Thin entry points around quant-core. S0 runs the core locally through a small harness; it does not require the connected batch host. Add batch hosting and the first market adapter in S1, then the second market adapter in S2. Add live-data paper at M2, shadow validation at M3, and separately deployed live execution at M4. Market and broker adapters belong beside this host.

Tests (`cargo test -p openquant-engine`): `tests/s0_fixtures.rs` runs every S0 fixture case; `tests/compare.rs`, `tests/report.rs` and `tests/s0_replay_cli.rs` pin the comparison, the report and the exit status. `s0-replay` exits 1 on any difference or coverage problem and 2 on a usage or file error.

Expectation sections (`expect` in a case's `expected.json`): every section except one is a view of the result (`outcome`, `signals`, `entries`, `fills`, `trades`, `cash_ledger`, `daily`, `corporate_actions`, `final`), and only the fields it states are compared. `outcome_detail_includes` is an array of strings and each must be a substring of the actual `outcome.detail`, so a case can require that an `INSUFFICIENT` detail names the instrument, the event and the affected period without pinning the wording (OQ-02 section 2.5). It counts one check for the array and one per string, like any array. An absent or non-string `outcome.detail` fails every string at once, and an empty array asserts nothing. The matching is exact and case-sensitive.

The detail text comes from the shared core. It is written for a reader and the harness never parses it. It names these facts: `MISSING_REQUIRED_BAR` the instrument and the session with no bar; `UNSUPPORTED_VALUATION` the instrument, the `event_id` of every confirmed halt of the session, the first unvalued session and the last session of the scored window (`windows.scored_end`); `UNSUPPORTED_CORPORATE_ACTION` and `FRACTIONAL_ENTITLEMENT` the instrument, the `action_id` and the effective session. The result schema limits the detail to 1000 characters.

Lints: the crate inherits the workspace lint policy, so `unwrap`, `expect`, `panic`, indexing and float arithmetic are denied in the library and the binary as in the core. The integration tests allow them at their crate roots, as the core tests do.

Owner: [05-system-architecture-and-data-spec.md](../../docs/specs/05-system-architecture-and-data-spec.md). Add executable files and required verification together.

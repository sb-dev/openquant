# Shared Rust numerical library

Status: planned; no implementation. First slice: M1/S0 — Offline seed evaluation.

Signals, simulation, accounting, portfolio, risk, and metrics. This is a library, not a set of separate services. Verify numerical semantics using independent fixtures.

S0 evaluates the daily swing seed as versioned Strategy Definitions through reviewed typed operators, with synthetic inputs and a local harness. Threshold and break-even changes belong to the definitions, not separate Rust strategy paths. Use the input/result/checkpoint schemas owned by `api-contracts`. S1 and the installed CLI reuse this validator and evaluator. Joint watchlist evaluation remains S4.

See [architecture](../../docs/specs/05-system-architecture-and-data-spec.md) and the [M1 guide](../../docs/guides/m1-watchlist-research.md).

# Shared Rust numerical library

Status: planned; no implementation. First slice: M1/S0 — Offline seed evaluation.

Signals, simulation, accounting, portfolio, risk, and metrics. This is a library, not a set of separate services. Verify numerical semantics using independent fixtures.

S0 implements the daily swing seed's one-instrument path with synthetic inputs and a local harness. Later slices and the installed CLI reuse this core. Joint watchlist evaluation remains S4.

See [architecture](../../docs/specs/05-system-architecture-and-data-spec.md) and the [M1 guide](../../docs/guides/m1-watchlist-research.md).

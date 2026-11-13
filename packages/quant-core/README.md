# Shared Rust numerical library

Status: S0 implemented — offline seed evaluation on synthetic data. Crate `openquant-core`. Connected use, joint watchlist evaluation (S4) and live execution are not implemented.

Signals, simulation, accounting, portfolio, risk, and metrics. This is a library, not a set of separate services. Verify numerical semantics using independent fixtures.

S0 evaluates the daily swing seed as versioned Strategy Definitions through reviewed typed operators, with synthetic inputs and a local harness. Threshold and break-even changes belong to the definitions, not separate Rust strategy paths. Use the input/result/checkpoint schemas owned by `api-contracts`.

## Numerics

Every value that feeds a price-grid decision is an exact fraction (`Ratio` in `src/ratio.rs`: two `i128`, always reduced, positive denominator). That covers the operator evaluator (means, RSI, true range, ATR, arithmetic, every comparison), bar prices after a split adjustment, and the levels a position holds: entry price, stop, target, scheduled stop and snapshots. A level is never rounded: `5 + 3 * (0.67 / 3)` is exactly `5.67`, a high of `5.67` touches it, `5 - 6 * (5 / 6)` is exactly zero and fails `0 < stop`, and a forward split followed by its reverse returns a level to its exact value. The touch, gap, validity, break-even and entry comparisons all read the exact value. The fill price of a touched or gapped level is the exact level floored to the price grid, and the gap slippage rule is unchanged.

Money, quantities, caps, fees, marks and ranks stay `Decimal` with the rounding rules of OQ-02 section 2.5. A level meets them in one place only: the sale price. A result shows a level as a `Decimal`: the exact decimal when it terminates within 28 fractional digits, otherwise the exact value rounded half-even to the most digits a decimal carries (`Ratio::to_display_decimal`).

The exact domain is a fraction whose numerator and denominator fit a signed 128-bit integer. Ordinary inputs fit. The S0 policy still admits extreme compositions that do not (a price near 5 × 10^8 with 8 digits times a constant near 10^12 with 12 digits). Such a composition is not rounded and does not wrap: the run fails with `ARITHMETIC_OVERFLOW` and produces no completed result. Comparison never overflows.

Failure text that prints a level uses the canonical form of `Ratio`'s `Display` (a normalised decimal, or a reduced fraction `n/d`), so an uninterrupted run and a run restored from a checkpoint at any cut produce byte-identical results. The checkpoint stores levels and snapshots in the same form (`Exact` in `api-contracts`). S1 and the installed CLI reuse this validator and evaluator. Joint watchlist evaluation remains S4.

See [architecture](../../docs/specs/05-system-architecture-and-data-spec.md) and the [M1 guide](../../docs/guides/m1-watchlist-research.md).

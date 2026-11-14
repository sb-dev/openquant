# Shared wire schemas

Status: S0 implemented for the schema source and Rust validation (crate `openquant-contracts` in `rust`, bindings generated at build time from `schemas`). S1 adds TypeScript validation in [`ts`](ts/README.md) (package `@openquant/api-contracts`). Its parity with Rust is checked against the Rust contracts report.

Language-neutral contracts and runtime validation. Generate bindings and execute shared valid/invalid fixtures in TypeScript and Rust. Money and quantities are decimal strings.

## Exact values

A checkpoint keeps the state that feeds a price-grid decision exactly, so a restored run decides every touch and comparison as the uninterrupted run did. The schema type is `Exact` (`common.schema.json`): a `Decimal`, or a fraction `n/d` for a value with no finite decimal form (a third, or a mean over three sessions). Position `entry_price`, `stop`, `target`, snapshot values, the scheduled stop level and pending-entry snapshot values use it (`CheckpointSnapshotValue` and `CheckpointScheduledStop` in `checkpoint.schema.json`). Cash, quantities, caps, marks, ranks and every field of the result stay `Decimal`: a result shows values, rounded as before.

The pattern checks the grammar only. The canonical rule is enforced in code (`exact` in the Rust crate):

- A value that terminates within 28 fractional digits and fits a decimal is a normalised decimal.
- Any other value is a reduced fraction with a denominator above 1, written without plus sign, leading zeros or exponent, with numerator and denominator inside a signed 128-bit integer (the numerator is never `-2^127`).
- A reader rejects a fraction that is not reduced, has denominator 1, has a decimal form, or does not fit 128 bits. The rejection is `INVALID_DECIMAL`, like a malformed decimal, as is a pattern failure on an `Exact` field. A text longer than 80 characters is `SCHEMA_VIOLATION`.

An integer beyond 96 bits has no wire form: the writer refuses it with `ARITHMETIC_OVERFLOW`. The shared fixtures in `fixtures/protocol` include checkpoints from real runs that carry fractions, and rejected forms of each rule.

S0 adds the seed's strategy/evaluation input, numerical result and checkpoint schemas in `schemas`, with generated Rust bindings and shared payload fixtures. These are the same contracts reused by S1 and the public CLI. S1 adds TypeScript bindings and connected run/attempt/ownership envelopes. S0 does not require an executable TypeScript package or API service.

See [architecture](../../docs/specs/05-system-architecture-and-data-spec.md) and the [M1 guide](../../docs/guides/m1-watchlist-research.md).

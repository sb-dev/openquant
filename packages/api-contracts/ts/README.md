# TypeScript contracts

Package `@openquant/api-contracts`. It gives TypeScript code the shared contracts in `../schemas`: types, strict parsing, validation and canonical digests. It follows the Rust contract layer in `../rust` ([architecture §7](../../../docs/specs/05-system-architecture-and-data-spec.md#7-data-and-protocol-contracts)).

## Generated files

`tools/generate.ts` bundles every schema into one document. Each `urn:` reference becomes a local `#/$defs/` reference, as `rust/build.rs` does. Definition names must stay unique across all schemas. The script writes `dist/generated`: the bundle, TypeScript types, the contract table and Ajv standalone validators. The validators are ES modules. They need no package at run time and compile no code at run time. Nothing generated is committed. Every package script that needs these files runs the generator first.

## Contract layer

`parseContract(contract, text)` takes JSON text or UTF-8 bytes. It applies the Rust checks in the Rust order:

1. Strict JSON: at most 16 MiB, no duplicate key, no fraction or exponent, no `-0`, fewer than 128 nested arrays or objects.
2. The version tag. A missing or non-string tag is `SCHEMA_VIOLATION`. Another tag is `UNSUPPORTED_SCHEMA_VERSION`.
3. Integers above 2^53 − 1 in magnitude. TypeScript cannot hold them exactly, so they are `SCHEMA_VIOLATION`. Rust gives the same code, because no schema admits them.
4. The schema. A failure of only the `Decimal` or `Exact` pattern is `INVALID_DECIMAL`. Any other failure is `SCHEMA_VIOLATION`. An `Exact` text longer than 80 characters fails `maxLength`, so it is `SCHEMA_VIOLATION`.
5. An invalid document beyond the structural limits of `rust/src/limits.rs` is `SCHEMA_VIOLATION`.

`validateContract` checks a value built in code through its canonical text. `canonicalJson` and `digest` match `rust/src/canonical.rs` byte for byte. The digest uses WebCrypto and returns `sha256:<hex>`.

`Exact` is an opaque branded string. TypeScript never computes with it. Semantic rules stay in Rust: the `Exact` canonical form, decimal range and scale, operators and run preparation. A payload can pass here and fail there.

`src` imports no Node module. The build bundles it with esbuild for the neutral platform and fails on a Node import, a dependency or run-time code generation.

## Commands

Run these from this directory, or through Turborepo from the repository root.

| Command | Work |
| --- | --- |
| `pnpm run typecheck` | Generate, then type check `src` without Node types and the tests and tools with them. |
| `pnpm run lint` | Biome format and lint check. |
| `pnpm run test` | Generate, then run every Vitest test, including the parity test. |
| `pnpm run test:parity` | Generate, then run the parity test only. |
| `pnpm run build` | Generate, type check `src`, then run the Worker bundle check. |

## Parity with Rust

The parity test reads `local-runs/contracts/report.json`, which the Rust `contracts-report` binary writes. It fails when the report is missing or was made from another `fixtures/protocol/manifest.json`. Otherwise it checks that both runtimes give every manifest entry the same verdict, the same code and, when accepted, the same digest. `semantic_invalid` entries pass here and are counted: Rust rejects them later.

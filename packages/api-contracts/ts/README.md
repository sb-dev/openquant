# TypeScript contracts

Package `@openquant/api-contracts`. It gives TypeScript code the shared contracts in `../schemas`: types, strict parsing, validation and canonical digests. It follows the Rust contract layer in `../rust` ([architecture §7](../../../docs/specs/05-system-architecture-and-data-spec.md#7-data-and-protocol-contracts)).

## Generated files

`tools/generate.ts` bundles every schema into one document. Each `urn:` reference becomes a local `#/$defs/` reference, as `rust/build.rs` does. Definition names must stay unique across all schemas. The script writes `dist/generated`: the bundle, TypeScript types, the contract table and Ajv standalone validators. The validators are ES modules. They need no package at run time and compile no code at run time. Nothing generated is committed. Every package script that needs these files runs the generator first.

## Contract layer

`parseContract(contract, text)` takes JSON text or UTF-8 bytes. It applies the Rust checks in the Rust order:

1. Strict JSON: at most 16 MiB of valid UTF-8, no duplicate key, no fraction or exponent, no `-0`, no integer outside the 64-bit range, fewer than 128 nested arrays or objects.
2. The version tag. A missing or non-string tag is `SCHEMA_VIOLATION`. Another tag is `UNSUPPORTED_SCHEMA_VERSION`.
3. Integers above 2^53 − 1 in magnitude. TypeScript cannot hold them exactly, so they are `SCHEMA_VIOLATION`. Rust gives the same code, because no schema admits them.
4. The value bound: a document with more values than the contract's bound is `SCHEMA_VIOLATION` (below).
5. The schema. A failure of only the `Decimal` or `Exact` pattern is `INVALID_DECIMAL`. Any other failure is `SCHEMA_VIOLATION`. An `Exact` text longer than 80 characters fails `maxLength`, so it is `SCHEMA_VIOLATION`.
6. An invalid document beyond the structural limits of `rust/src/limits.rs` is `SCHEMA_VIOLATION`.

## Value bound

A dense 16 MiB body, such as `[{},{},…]`, needs several hundred MB of heap when every value is built, and a Worker isolate has 128 MB. The parse therefore builds at most `valueBound(contract)` values: the larger of the contract's `maxValues`, the most values a schema-valid document can hold, and the 20,000-value structural limit. `tools/generate.ts` derives `maxValues` from the bundled schema; it is an over-approximation, so no valid document reaches the bound. Above the bound a document is invalid and has more than 20,000 values, so Rust rejects it with `SCHEMA_VIOLATION` as well.

Past the bound the parser stops building values. It still reads the whole text with every strict-JSON rule, holds later object keys as a hash and a text offset, and keeps the top-level `schema_version`, also when the version is itself the value that passes the bound. A strict-JSON error or a wrong version tag anywhere therefore gets the same code as in Rust. Fixtures put a wrong tag at value 20,000 and 20,001 of `api-error/1`, and a correct tag at value 20,001.

The values that the parse does build are compact. Each array is copied off a shared stack at its exact length, and a string with escapes is decoded in one piece.

## Worker byte limit

`strategy-artefact` and `command` hold a recursive `Expr` tree, so their schemas give no bound (`maxValues` is `null`). The bounds of `checkpoint` and `evaluation-result` are above a million values. A value bound alone does not keep their parse within a Worker.

`workerBodyLimit(contract)` gives every contract the largest body, in UTF-8 bytes, that a Worker parses: 4 MiB when the value bound is at most 100,000, and 512 KiB otherwise. `parseContract` itself still accepts the 16 MiB that Rust accepts. The API refuses a larger request body with `LIMIT_EXCEEDED` before it parses it, and P2 implements that check. Every route with a request body records the limit of its contract as `max_body_bytes` in `routes/v1.json`; a raw artefact upload records 16 MiB, because the API hashes and stores it without parsing it. The Worker serves stored `evaluation-result` and `checkpoint` documents by content hash and never parses them ([architecture §7](../../../docs/specs/05-system-architecture-and-data-spec.md#7-data-and-protocol-contracts)).

`test/memory.test.ts` checks each limit. For every contract it parses nine dense shapes at the contract's limit, each in a child Node process with a 128 MB heap: flat arrays of zeros, empty arrays, empty objects and one-item arrays; chains of nested arrays; objects with many keys or with a new key each; and one string of escapes, also with a character that makes the text two bytes a character. The peak of heap and external memory, which holds the body bytes and, in Node, the decoded text, must stay within 64 MB, the Node baseline of about 20 MiB included. A control shows that building every value of a dense 16 MiB body exhausts the same heap.

## Values, digests and scope

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

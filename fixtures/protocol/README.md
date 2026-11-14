# Cross-runtime protocol fixtures

Status: S0 fixtures implemented and validated in Rust. The S1 envelope fixtures are added, but no runtime validates them yet. Rust and TypeScript validation of the envelopes arrives later in S1.

## Manifest

`manifest.json` lists every payload with its contract, expectation (`valid`, `schema_invalid` or `semantic_invalid`) and failure code. Paths in the manifest are relative to `fixtures`. A test fails if a file is missing from the manifest. `with_strategy` and `with_input` name the payload that a semantic check reads beside the fixture.

## S0 payloads

S0 adds valid/invalid strategy/evaluation input, numerical result and checkpoint payloads against the schemas in `packages/api-contracts/schemas`. Rust validates them and verifies serialized state restore. The valid result and checkpoint payloads were emitted once from the F0 smoke case as schema examples; they are not numerical goldens. Include unsupported versions, unknown mandatory fields, decimal precision, invalid operator IDs/types/units, malformed identities and mismatched checkpoint identities. The `exact-*` payloads cover the `Exact` checkpoint value: valid fractions from a real run, and invalid forms (not reduced, denominator 1, decimal-representable, zero denominator, beyond 128 bits, a fraction in a money or result field).

## S1 envelopes

S1 adds fixtures for the connected envelopes in `packages/api-contracts/schemas` ([architecture §7](../../docs/specs/05-system-architecture-and-data-spec.md#7-data-and-protocol-contracts)). They cover the evaluation plan, request and submission; job dispatch and attempt claim; commands; the research profile, cohort policy and dataset manifest; retrieval requests and results; validation results, metrics and gate reports; agent dispatch and attempt results; API errors; and the release manifest.

- `valid/` holds valid payloads. `input.provider-source` is an engine-scope evaluation input: the synthetic F0 bars with the provider source value, which changes no result.
- `invalid/` holds `schema_invalid` payloads: unsupported versions, unknown fields, malformed digests and decimals, and combinations that an envelope forbids.
- The S1 entries are appended to the manifest. The S0 entries and their files are unchanged.
- A fixture that cites another fixture cites its canonical SHA-256 digest. When a cited fixture changes, recompute its digest and update every fixture that cites it.
- Provider-shaped payloads, such as dataset manifests and job dispatches, use an obviously synthetic instrument and round synthetic values. They hold no real market data ([publication and data policy](../../docs/specs/07-open-source-project-organisation-spec.md#7-publication-and-data-policy)).
- A case whose verdict depends on attempt ownership, such as stale ownership or a late completion, needs the API's state. It arrives with the API as a `semantic_invalid` entry that declares its attempt context.

The S1 TypeScript layer will run every shared payload and compare its verdict, and the digest of a valid payload, with Rust. Keep provisional harness-only wire formats out of this shared contract.

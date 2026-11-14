# Cross-runtime protocol fixtures

Status: S0 and S1 fixtures implemented. Rust validates every fixture, and the TypeScript contract layer gives every entry the same verdict, code and digest (`packages/api-contracts/ts`). No API or worker uses the S1 envelopes yet.

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
- `api-error.value-bound-*` payloads hold 20,000 values or more; 20,000 is the TypeScript value bound of `api-error/1`. They pin the order of the checks around that bound in both runtimes: a strict-JSON error anywhere, then the version tag, then the bound. The `-at-20000` and `-at-20001` payloads put the version tag at value 20,000 and 20,001, so the tag is read also when it is the value that passes the bound. They are written on one line.
- `validation-result.*` payloads cover the two forms: a seed has no parent and no change scope, and a valid revision has the scope `ENTRY` or `EXIT`. `revision-scope` is a revision that changes both rules, recorded as `INVALID` with `REVISION_SCOPE`.
- `retrieval-result.*-retryable` payloads mark retryable a failure class that is never retried, including `EGRESS_REFUSED`.
- `api-error.wrong-version-*` payloads pin that strict JSON runs before the version check.
- Bytes that are not UTF-8 are not committed, because the repository checks read every tracked file as text. The Rust contracts-report test and the TypeScript validation test build the same byte strings and both expect `SCHEMA_VIOLATION`.

The S1 TypeScript layer will run every shared payload and compare its verdict, and the digest of a valid payload, with Rust. Keep provisional harness-only wire formats out of this shared contract.

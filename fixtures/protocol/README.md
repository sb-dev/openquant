# Cross-runtime protocol fixtures

Status: S0 fixtures implemented; TypeScript execution arrives in S1.

S0 adds valid/invalid strategy/evaluation input, numerical result and checkpoint payloads against the schemas in `packages/api-contracts/schemas`. Rust validates them and verifies serialized state restore. `manifest.json` lists every payload with its contract, expectation (`valid`, `schema_invalid` or `semantic_invalid`) and failure code. Paths in the manifest are relative to `fixtures`. A test fails if a file is missing from the manifest. The valid result and checkpoint payloads were emitted once from the F0 smoke case as schema examples; they are not numerical goldens. Include unsupported versions, unknown mandatory fields, decimal precision, invalid operator IDs/types/units, malformed identities and mismatched checkpoint identities. The `exact-*` payloads cover the `Exact` checkpoint value: valid fractions from a real run, and invalid forms (not reduced, denominator 1, decimal-representable, zero denominator, beyond 128 bits, a fraction in a money or result field).

S1 tests the same payloads in TypeScript and Rust, then adds connected run/attempt/ownership envelopes and stale-ownership cases. Keep provisional harness-only wire formats out of this shared contract.

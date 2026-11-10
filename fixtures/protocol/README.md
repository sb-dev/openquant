# Cross-runtime protocol fixtures

Status: planned fixture area.

S0 adds valid/invalid strategy/evaluation input, numerical result and checkpoint payloads against the schemas in `packages/api-contracts/schemas`. Rust validates them and verifies serialized state restore. Include unsupported versions, unknown mandatory fields, decimal precision, invalid operator IDs/types/units, malformed identities and mismatched checkpoint identities.

S1 tests the same payloads in TypeScript and Rust, then adds connected run/attempt/ownership envelopes and stale-ownership cases. Keep provisional harness-only wire formats out of this shared contract.

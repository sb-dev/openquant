# Fixtures

S0 added executable fixtures: versioned seed definitions, synthetic inputs, independent numerical expectations and real shared-core evaluation through a local harness (see [S0 fixtures](s0/README.md)), plus valid/invalid input, numerical result and checkpoint payloads for the api-contracts schemas, exercised in Rust. S1 runs the same fixtures in TypeScript and adds connected envelopes. Provider and recorded model-response cases arrive with their S1–S3 integrations. S4 adds joint watchlist and comparison cases; S5 adds distributed recovery. Public CLI release reuses the seed fixtures and adds the installed replay path.

| Area | Contract |
| --- | --- |
| [S0 seed evaluation](s0/README.md) | Versioned seed Strategy Definitions, independent synthetic cases and the S0 coverage map. |
| [Market data](market-data/README.md) | Synthetic or redistributable observations with timestamps, availability, provenance, and licence. |
| [Example packs](example-packs/README.md) | One shared input for demo, test, guide, Academy, and public evidence. |
| [Benchmark packs](benchmark-packs/README.md) | Fixed methods, independent expected invariants, and versioned results. |
| [Agent results](agent-results/README.md) | Explicitly recorded outputs for offline adapter tests. |
| [Protocol](protocol/README.md) | Shared valid/invalid messages for TypeScript and Rust. |

Production research and account history remain private in Neon/R2. See [domain](../docs/specs/02-trading-domain-and-evaluation-spec.md) and [publication policy](../docs/specs/07-open-source-project-organisation-spec.md).

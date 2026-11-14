# Shared wire schemas

Status: S0 implemented for the schema source and Rust validation (crate `openquant-contracts` in `rust`, bindings generated at build time from `schemas`). The S1 connected envelopes and the route manifest are contracts only: no runtime validates them yet. S1 adds their Rust and TypeScript validation.

Language-neutral contracts and runtime validation. Generate bindings and execute shared valid/invalid fixtures in TypeScript and Rust. Money and quantities are decimal strings.

## Engine-scope contracts

S0 adds the seed's strategy/evaluation input, numerical result and checkpoint schemas in `schemas`, with generated Rust bindings and shared payload fixtures: `strategy-artefact`, `evaluation-input`, `evaluation-result`, `checkpoint` and their `common` definitions. These are the same contracts reused by S1 and the public CLI. They are inside engine identity. A content change needs a new version tag or an explicit A18 compatibility decision. S1 adds one value, the provider source of `evaluation-input/1`, under an A18 note; the core does not read it, so no result changes.

## Exact values

A checkpoint keeps the state that feeds a price-grid decision exactly, so a restored run decides every touch and comparison as the uninterrupted run did. The schema type is `Exact` (`common.schema.json`): a `Decimal`, or a fraction `n/d` for a value with no finite decimal form (a third, or a mean over three sessions). Position `entry_price`, `stop`, `target`, snapshot values, the scheduled stop level and pending-entry snapshot values use it (`CheckpointSnapshotValue` and `CheckpointScheduledStop` in `checkpoint.schema.json`). Cash, quantities, caps, marks, ranks and every field of the result stay `Decimal`: a result shows values, rounded as before.

The pattern checks the grammar only. The canonical rule is enforced in code (`exact` in the Rust crate):

- A value that terminates within 28 fractional digits and fits a decimal is a normalised decimal.
- Any other value is a reduced fraction with a denominator above 1, written without plus sign, leading zeros or exponent, with numerator and denominator inside a signed 128-bit integer (the numerator is never `-2^127`).
- A reader rejects a fraction that is not reduced, has denominator 1, has a decimal form, or does not fit 128 bits. The rejection is `INVALID_DECIMAL`, like a malformed decimal, as is a pattern failure on an `Exact` field. A text longer than 80 characters is `SCHEMA_VIOLATION`.

An integer beyond 96 bits has no wire form: the writer refuses it with `ARITHMETIC_OVERFLOW`. The shared fixtures in `fixtures/protocol` include checkpoints from real runs that carry fractions, and rejected forms of each rule.

## Connected envelopes

S1 adds connected envelopes as a separate contract set ([architecture §7](../../docs/specs/05-system-architecture-and-data-spec.md#7-data-and-protocol-contracts)). They are outside engine identity. Every definition name is unique across all schemas.

| Group | Schemas |
| --- | --- |
| Shared codes and state values | `connected-common` |
| Evaluation | `evaluation-plan`, `evaluation-request`, `evaluation-submission` |
| Jobs and attempts | `job-dispatch`, `attempt-claim` |
| Guarded commands | `command` |
| Policy and data | `research-profile`, `cohort-policy`, `dataset-manifest`, `retrieval-request`, `retrieval-result` |
| Derived evidence, each bound to method identity | `validation-result`, `evaluation-metrics`, `gate-report` |
| Agent host, never sent to the model | `agent-dispatch`, `agent-attempt-result` |
| API | `api-error`, `release-manifest` |

`connected-common` also holds state values that no S1 envelope carries yet, such as the job, attempt, lease, reservation, outbox and mission states. The API read models use them ([architecture §4](../../docs/specs/05-system-architecture-and-data-spec.md#4-dispatch-ownership-and-completion)).

The agent role schemas live in `packages/agents/schemas`. They reference these schemas with `$ref`.

## Route manifest

`routes/v1.json` lists the HTTP routes of the S1 API and the agent-runner dispatch endpoint. Each route names its host, method, path, accepted credentials, request and response bodies, success status and its own error codes.

- Credentials: a person's long-lived credential (token route only), a person's 15-minute access token with the roles that may call the route, a service principal credential with the principals that may call it, or the attempt-scoped capability from a claim grant. Any one listed credential is enough.
- Bodies: a contract body names a schema in `schemas` by its short name, with a form where a contract has two forms. A view body is an API-owned read model; it is not a cross-runtime contract, and `apps/api` owns its shape. A bytes body is a raw artefact addressed by its SHA-256 digest.
- Errors: every error body is `api-error/1`. The common errors apply to every route, and the manifest maps each error code to its HTTP status.
- The internal commands `record_evaluation_decision` and `freeze_candidates` have no route. Only the workflows service principal applies them.

## Contract sets

The Rust crate has two contract sets (OQ-05 §7):

- `Contract`: the engine-scope contracts. Their version tags are part of engine identity. A test pins the SHA-256 of each engine-scope schema file. A change to one needs a new version tag or an A18 decision.
- `Envelope`: the S1 connected envelopes. They are outside engine identity.

`common` and `connected-common` hold shared definitions only. Each set validates against its own schema registry. Both sets use the same contract layer and the same failure codes.

`contracts-report` runs every protocol fixture through the contract layer and writes the verdicts for the TypeScript parity test:

```sh
cargo run --locked -p openquant-contracts --bin contracts-report -- --out <dir>
```

It writes `<dir>/report.json` (`contracts-report/1`). Each entry has the verdict, the failure code of a rejected payload and the canonical digest of an accepted one. It never runs core semantics, so a `semantic_invalid` fixture is accepted.

See [architecture](../../docs/specs/05-system-architecture-and-data-spec.md) and the [M1 guide](../../docs/guides/m1-watchlist-research.md).

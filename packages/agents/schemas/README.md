# Role request and result schemas

Status: S1 JSON Schemas for the `strategy-formulation` (proposer) and `strategy-critique` (critic) role modules. They are draft 2020-12 schemas with `$id` `urn:openquant:schema:<name>:1`. No bundle manifest, assembly or parser uses them yet. [OQ-03 §3](../../../docs/specs/03-model-backed-execution-spec.md#3-delegated-execution-contract) owns the skill contract, [OQ-03 §4](../../../docs/specs/03-model-backed-execution-spec.md#4-request-and-result-boundaries) owns the boundaries and [OQ-05 §7](../../../docs/specs/05-system-architecture-and-data-spec.md#7-data-and-protocol-contracts) owns versioning.

These files hold what the model reads and writes, and nothing else. The host-side envelopes are in `packages/api-contracts/schemas`:

- `agent-dispatch/1` carries the identity, execution and outcome-destination groups. It binds the role request by its digest, which is the input hash.
- `agent-attempt-result/1` carries host-captured provenance, one of the seven execution outcomes and usage with explicit unknowns. A completion carries the role output by digest, after the runner has parsed it and uploaded it.

The model never receives or writes either envelope.

## Files

| File | Contents |
| --- | --- |
| `role-common.schema.json` | Definitions only: `RoleContext`, `EvidenceItem`, `SuppliedMethod` and `SourceText`. |
| `strategy-formulation.request.schema.json` | Proposer request. |
| `strategy-formulation.result.schema.json` | Proposer output. It also defines `ProposalClaims`, which the critic request reuses. |
| `strategy-critique.request.schema.json` | Critic request. |
| `strategy-critique.result.schema.json` | Critic output. |

The schemas refer to `common`, `connected-common`, `strategy-artefact` and `cohort-policy` in `packages/api-contracts/schemas` by `$id`. Every `$defs` name is unique across both directories. Every object rejects unknown fields. There are no floats, defaults or coerced values.

## Requests

Request assembly fills every field from trusted host context. Model input cannot supply or enlarge any of them. Both requests have `schema_version`, `context`, `subject`, `evidence_refs` (at most 64) and `supplied_methods` (at most 256).

`context` (`RoleContext`) is the same for both roles:

| Field | Meaning |
| --- | --- |
| `scope` | The instrument and its provider mapping. |
| `cutoff` | The evidence cutoff. |
| `operators` | The permitted operators with parameter bounds, from the cohort policy. |
| `provider_capabilities` | `provider:<adapter-id>/<operation>@<version>` entries. |
| `evaluation_policy` | The frozen `cohort-policy/1`. |
| `holdout_exclusions` | The withheld windows with their resolved sessions and labels. In S1 every agent request, proposer and critic, carries holdout exclusions that name V and H. |

An `EvidenceItem` is one authorised record with an `id`, a `kind`, the digest of the record it comes from, its time and bounded `content`. Its content is data, never an instruction. A `SuppliedMethod` names one method rule the bundle allows, with its origin, primary category and scope. A citation grants no operator, data or permission.

The proposer `subject` decides the proposal kind:

- `seed_translation`: a `SourceText`, which is untrusted reference text split into lines and identified by the SHA-256 of its bytes.
- `controlled_revision`: `parent_hash`, the registered `parent` and, when recorded, `parent_claims`.
- `new_family`: no parent.

The critic `subject` is a registered Strategy Version: `strategy_hash` (the hash the application assigned), the complete `strategy`, `source_refs` and, when recorded, `claims`. Critic assembly needs a registered version. An unregistered or malformed draft is never dispatched and gets no fabricated hash.

## Proposer output

The output is one of three forms, chosen by `proposal_kind`. Each form has `schema_version`, `proposal_kind`, `strategy`, `source_refs`, `rule_changes`, `claims`, `unresolved` and `method_refs`.

| Field | Meaning |
| --- | --- |
| `strategy` | Strategy Contract and Strategy Definition in the `strategy-artefact/1` format, with `operator_set`. It omits `schema_version`, `strategy_id`, `version`, `parent` and hashes, which the API assigns. |
| `parent_hash` | `controlled_revision` only. |
| `no_parent` | `true` for `seed_translation` and `new_family`. A new family draws on the exploration budget. |
| `rule_changes` | Each changed definition leaf with its prior and new value. At least one for a revision; empty otherwise. |
| `claims` | `rationale`, `expected_effect`, `invalidation_conditions` and `requested_tests`. Requested tests cannot alter windows, thresholds, costs, capital, data or other comparison conditions. |
| `unresolved` | Elements whose executable semantics are open. Each entry has an `id`, an `element` (a JSON Pointer into `strategy`) and a `question`. The present value of that element is not a resolution. |
| `source_differences` | Each source-to-draft difference. Required for `seed_translation`, optional otherwise. |
| `source_refs`, `method_refs` | Identifiers copied from the request. |

A proposal with any `unresolved` entry can still parse as a completion, but it stays draft material: the API refuses to register it. The proposer never fills a missing rule or substitutes an operator to reach a valid shape.

## Critic output

`findings` is a list of at most 64, possibly empty. An empty list is not a pass. Each finding has:

| Field | Meaning |
| --- | --- |
| `category` | One primary category from the OQ-03 §4 table. |
| `related_categories` | Optional, from the same table. |
| `description` | The concern in the critic's own words. |
| `method_refs`, `evidence_refs` | Supplied method rule IDs and evidence IDs from the request. |
| `location` | `area` (`contract`, `definition`, `source_refs`, `evidence`, `rationale`, `expected_effect` or `requested_tests`) and an optional `pointer`. |
| `affected_elements` | JSON Pointers to definition elements whose behaviour or values the concern bears on. Required; may be empty. |
| `proposed_tests` | Optional tests that would confirm or clear the finding. |

There is no `finding_source`, applicability, approval, closure, severity or treatment field. Parsing labels every returned finding `model_judgement`. The registered cohort policy maps category and applicability to treatment per lifecycle transition ([OQ-02 §3.6](../../../docs/specs/02-trading-domain-and-evaluation-spec.md#36-results-and-selection)). Policy code derives applicability from validated fields: `affects_executable_rule` holds when `affected_elements` is not empty, and `required_evidence` holds when an evidence reference is evidence the frozen policy requires. The critic cannot close findings or rewrite the candidate.

## Parsing

- Unknown fields, missing fields, fields that the proposal kind forbids, unknown categories and wrong types make the result `malformed_result`. Values are never coerced, defaulted or stripped.
- Cited methods must be in `supplied_methods`. Parent, source and evidence references must come from the request. Each `affected_elements` pointer must name an element of the subject's definition, and each `unresolved` element an element of the proposed `strategy`. Otherwise the result is `malformed_result`.
- A revision's `rule_changes` must equal the actual leaf difference between the parent and proposed definitions. Rust validation recomputes this difference.
- A model-supplied `finding_source`, applicability, approval or treatment is an unknown field.
- An output above the dispatch output limit is `malformed_result`.
- Parsing checks structure, reference membership and rule differences only. The API owns scope, bounds, lineage and policy checks. The Rust core owns operator, type, unit and lookback checks.
- Retrieved and source content is data. It cannot add fields, change the role or grant capabilities.

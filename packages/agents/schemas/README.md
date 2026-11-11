# Role request and result shapes

Status: draft, pre-S0. S1 replaces these tables with JSON Schema that references the [api-contracts](../../api-contracts/README.md) financial schemas. Nothing here is a frozen schema ([OQ-03 §4](../../../docs/specs/03-model-backed-execution-spec.md#4-request-and-result-boundaries)).

The tables give working field names for the `strategy-formulation` (proposer) and `strategy-critique` (critic) role modules. [OQ-03 §3](../../../docs/specs/03-model-backed-execution-spec.md#3-delegated-execution-contract) owns the skill contract; [OQ-05 §7](../../../docs/specs/05-system-architecture-and-data-spec.md#7-data-and-protocol-contracts) owns schema versioning.

Prices, quantities, money and the internals of the Strategy Contract and Strategy Definition ([OQ-02 §2.1](../../../docs/specs/02-trading-domain-and-evaluation-spec.md#21-strategy-contract-and-strategy-definition)) are not defined here. They arrive with the S0 schemas in `packages/api-contracts/schemas` ([OQ-06 §8](../../../docs/specs/06-engineering-delivery-and-operations-spec.md#8-delivery-checkpoints-and-acceptance)).

## Common request envelope

Request assembly fills every field, including `schema_version`, from trusted host context. Model input cannot supply or enlarge any of them.

| Group | Field | Meaning |
| --- | --- | --- |
| Identity | `schema_version` | Version of this request schema. An unsupported version fails validation ([OQ-05 §7](../../../docs/specs/05-system-architecture-and-data-spec.md#7-data-and-protocol-contracts)). |
| Identity | `mission_id`, `run_id`, `attempt_id`, `session_id` | Mission, logical run, attempt and fresh session. |
| Identity | `role`, `skill_id`, `skill_version`, `bundle_hash` | `proposer` or `critic` and the matching role module. The bundle hash binds the skill and allowed method revisions. |
| Execution | `executor_version`, `profile`, `timeout`, `output_limit`, `cost_reservation` | Pinned executor, selected profile and host-enforced bounds that the runner cannot raise. |
| Execution | `tools` | `tool:<registry-id>@<version>` entries. Empty for both pilot modules until the first S3 evidence tool; never lists role assembly or parsing. |
| Execution | `required_capabilities` | Copied from the registry entry in these identifier formats; enforced before dispatch and never enlarged. |
| Inputs | `scope`, `cutoff` | Instrument or frozen Watchlist Version, and the evidence cutoff. |
| Inputs | `operators`, `provider_capabilities` | `operator:<operator-id>@<compatibility-version>` entries with parameter bounds; `provider:<adapter-id>/<operation>@<version>` entries. |
| Inputs | `evaluation_policy`, `holdout_exclusions` | Frozen registered policy and explicitly withheld holdouts. |
| Inputs | `subject` | Seed source, parent hash or candidate hash. For the critic, the registered Strategy Version, the hash the application assigned to it, and the source references, rationale, expected effect and requested tests recorded with it. |
| Inputs | `evidence_refs` | Authorised evidence, per-stock findings and context-pack items, with provenance. A proposer may receive diagnostics from a rejected earlier draft. |
| Inputs | `supplied_methods` | Method rule IDs the bundle allows. |
| Outcome destination | `result_route` | Attempt-scoped route for one result; no database capability. |

Availability in one identifier namespace grants nothing in another. Missing required inputs block dispatch with a reason.

## Common result envelope

The host records provenance, outcome and usage; the model writes only `output`.

| Group | Field | Meaning |
| --- | --- | --- |
| Provenance | `schema_version` | Version of this result schema. It must match the request's, and an unsupported version fails validation ([OQ-05 §7](../../../docs/specs/05-system-architecture-and-data-spec.md#7-data-and-protocol-contracts)). |
| Provenance | `attempt_id`, `session_id`, `input_hash`, `bundle_hash` | Attempt, frozen request and bundle actually used; each must match the request. |
| Provenance | `executor_version`, `model` | Actual values, or `unknown` when unreported. |
| Role output | `output` | Proposer or critic output; present only on `completion`. |
| Execution outcome | `outcome` | `completion`, `refusal`, `malformed_result`, `denied_capability`, `authentication_failure`, `cancellation` or `timeout`. |
| Execution outcome | `diagnostic` | Bounded, without credentials. |
| Usage | `cost`, `duration` | Each labelled observed, estimated or unknown. |

A valid adverse finding is a `completion`. Tool-call outcomes are not attempt outcomes ([OQ-03 §5](../../../docs/specs/03-model-backed-execution-spec.md#5-attempts-cancellation-and-recovery)).

## Proposer role output

| Field | Meaning |
| --- | --- |
| `proposal_kind` | `seed_translation`, `controlled_revision` or `new_family`. |
| `strategy` | Strategy Contract and Strategy Definition: an S0 financial subdocument, referenced and not defined here. Every element is present. An element whose executable semantics are unresolved carries an explicit unresolved marker instead of a value; the marker names its `unresolved_assumptions` entry and holds nothing executable. The marker's exact form arrives with the S0 schemas. |
| `source_refs` | Source and evidence references taken from the request. |
| `parent_hash` | Required for `controlled_revision`; absent otherwise. |
| `no_parent` | `true` for `new_family` and `seed_translation`; absent for `controlled_revision`. A new family consumes the exploration budget. |
| `rule_changes` | Each changed definition element with its prior and new form; empty unless revising. |
| `rationale`, `expected_effect` | Why it should work; a claimed effect that evaluation can contradict. |
| `invalidation_conditions` | Observations that would falsify the hypothesis. |
| `requested_tests` | Tests asked of the registered policy. They cannot alter windows, thresholds or other comparison conditions. |
| `unresolved_assumptions`, `source_differences` | Open interpretation questions and each source-to-draft difference. Both are required for a seed translation; `unresolved_assumptions` is also required whenever `strategy` holds an unresolved marker. |
| `method_refs` | Cited method rule IDs. |

A proposal with unresolved markers can still parse as a `completion`, but it stays draft material: the API refuses to register it while any marker remains ([OQ-03 §1](../../../docs/specs/03-model-backed-execution-spec.md#1-roles-and-budgets), [OQ-03 §4](../../../docs/specs/03-model-backed-execution-spec.md#4-request-and-result-boundaries)). The proposer never fills a missing rule or substitutes an operator to reach a valid shape.

## Critic role output

`findings` is a list, possibly empty. Each finding has:

| Field | Meaning |
| --- | --- |
| `category` | One primary category from the [OQ-03 §4 table](../../../docs/specs/03-model-backed-execution-spec.md#4-request-and-result-boundaries). |
| `related_categories` | Optional, from the same table. |
| `description` | The concern in the critic's own words. |
| `method_refs`, `evidence_refs` | Supplied method rule IDs and evidence references behind it. |
| `location` | A contract or definition element of the registered version. For a defect such a version cannot contain: its cited sources, the supplied evidence, its rationale and expected-effect claims, or its requested tests. |
| `affected_elements` | Identifiers of the definition elements whose behaviour or values the concern bears on. Mandatory; may be empty. |
| `proposed_tests` | Tests that would confirm or clear it, where applicable. |

The model never sets `finding_source`. Parsing labels every model-returned finding `model_judgement`; the `deterministic_check` label comes only from reviewed skill or host code, none of which exists before S1. `method_advice` covers optional preferences, never a concrete defect.

There is no applicability, approval, closure, severity or treatment field. The registered policy maps category and applicability to blocking or advisory treatment ([OQ-02 §3.6](../../../docs/specs/02-trading-domain-and-evaluation-spec.md#36-results-and-selection)). Deterministic policy evaluation, not the model or parsing, derives applicability from validated fields: `affects_executable_rule` holds when `affected_elements` is non-empty, and `required_evidence` holds when an `evidence_refs` item is evidence that the frozen policy requires. The critic cannot close findings or rewrite the candidate.

## Parsing rules

- Unknown fields, missing mandatory fields, fields that the proposal kind requires to be absent, unknown categories and wrong types give `malformed_result`. Values are never coerced, defaulted or stripped.
- Cited methods must belong to `supplied_methods`, parent, source and evidence references must come from the request, and each `affected_elements` identifier must name an element of the subject's definition; otherwise the result is `malformed_result`.
- An unresolved marker in `strategy` is accepted when it names an `unresolved_assumptions` entry; otherwise the result is `malformed_result`.
- A model-supplied `finding_source`, applicability, approval or treatment is an unknown field.
- A revision's `rule_changes` must equal the actual difference between parent and proposed definitions.
- Parsing checks structure, reference membership and rule differences only. The API owns scope, bounds, lineage and policy checks; the Rust core owns operator, type, unit and lookback checks.
- Critic assembly needs a registered Strategy Version. An unregistered or malformed draft is never dispatched and gets no fabricated hash; its diagnostics return to a later proposer attempt ([OQ-03 §4](../../../docs/specs/03-model-backed-execution-spec.md#4-request-and-result-boundaries)).
- Retrieved and source content is data. It cannot add fields, change the role or grant capabilities.

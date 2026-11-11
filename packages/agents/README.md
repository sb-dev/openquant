# Versioned proposer/critic behaviour

Status: pre-S0 draft assets only. No executable skill, schema, bundle or package exists. First executable checkpoint: M1/S1.

Policy, roles, reviewed skill modules, method notes, role request/result schemas, request assembly, parsing, evaluation cases, and release identity. No provider router or arbitrary auto-discovered skills. [Model execution §§3–4](../../docs/specs/03-model-backed-execution-spec.md#3-delegated-execution-contract) owns the skill contract; [engineering §8](../../docs/specs/06-engineering-delivery-and-operations-spec.md#8-delivery-checkpoints-and-acceptance) owns its delivery sequence.

## Contents

| Path | Contents |
| --- | --- |
| `src/methods/sources.json` | Source registry: author, title, edition, rule prefix, and the digest of each user-supplied summary PDF. |
| `src/methods/<source>.md` | Draft method notes for one source. Each rule records its origin, finding category, platform scope, summary page, corrections and limits. |
| `src/skills/strategy-formulation/procedure.md` | Draft proposer procedure for the first pilot role module. |
| `src/skills/strategy-critique/procedure.md` | Draft critic procedure for the second pilot role module. |
| [`schemas/README.md`](schemas/README.md) | Non-financial request/result shapes for both role modules. S1 replaces them with JSON Schema. |
| `evals/fixture-policy.json` | Synthetic finding-treatment policy used only by offline evaluation cases. |
| `evals/<skill>/fixtures/dataset.json` | Evaluation case descriptions with split labels and expected outcomes. |

## Rules for these drafts

- The method notes come from assistant-written summaries, not from the books. Every rule is `summary_claim_unverified` or `summariser_recommendation`. No rule is `primary_checked`, so none can enter a released bundle. A `primary_checked` rule would need a `primary_pages_checked` record in `sources.json` with its rule ID, the primary edition and locator, the exact pages, the check date and who checked it.
- Notes and procedures are written in original words. The summaries, the books and long passages stay outside Git.
- Corrections to the summaries are limited to rendering repairs, internal consistency and checks against standard definitions or the canonical specifications. A correction is not a primary-page check.
- A rule's origin follows its operative instruction. Use `summary_claim_unverified` when the summary attributes the instruction to the book. Use `summariser_recommendation` when it comes from summariser advice, from an adaptation in the note or from the specifications.
- A rule's scope is `seed` when it applies to the daily long-only seed family today, including a request for a test that the registered policy can declare. It is `needs_operator` when it needs a new reviewed operator, data or data semantics first. It is `out_of_scope` when the initial platform cannot express it.
- A rule's category is its primary OQ-03 §4 category. The last column can name related categories.
- Runtime assets under `src/` contain no evaluation material, links or quotations. Evaluation cases stay under `evals/`.
- Case descriptions contain no numerical goldens. S0 supplies independent shared fixtures; S1 converts these cases into executable suites.
- Public cases are regression evidence, not holdouts.
- In a case, `warnings` are non-fatal messages from the host, the parser or owner validation. `diagnostics` are block, malformed or rejection reasons.

`pnpm verify` runs `scripts/agent-assets.ts`. It checks the exact file layout, the source registry, rule rows, rule references, finding-category parity with OQ-03 §4, the fixture policy, case fields, split labels and coverage of the OQ-03 §6 cases. It does not check that a rule is true, that a summary matches its book, or that a procedure improves research.

# Versioned proposer/critic behaviour

Status: S1 parts A and C. `@openquant/agents` is a workspace package with the static registry of the two pilot role modules, Worker-safe request assembly and result parsing for both, the dispatch checks that `agent-dispatch/1` cannot make, the spec-derived production procedures, the behaviour-bundle manifest with its generated module, and offline suites with labelled synthetic responses. No model is called. The delegated runner (`apps/agent-runner`) uses these modules on the request it is given and on the output it gets back, and runs every offline fixture through its real code path with a fake executor; `pnpm agents:eval` refuses without `--mode`, runs the offline suites with `--mode fixture` and, only with `--mode live`, the owner's key and an explicit opt-in, a real-model evaluation (never run in this repository); the spike of the pinned executor is recorded in its README (`--json-schema` enforcement could not be verified without credentials), and a real-model run is a later part of S1. The connected competition is not implemented.

Policy, roles, reviewed skill modules, role request/result schemas, request assembly, parsing, evaluation cases and release identity. No provider router or arbitrary auto-discovered skills. [Model execution §§3–4](../../docs/specs/03-model-backed-execution-spec.md#3-delegated-execution-contract) owns the skill contract; [engineering §8](../../docs/specs/06-engineering-delivery-and-operations-spec.md#8-delivery-checkpoints-and-acceptance) owns its delivery sequence.

## What the package does

| Module | Work |
| --- | --- |
| `src/registry.ts` | Two entries, `strategy-formulation` (proposer) and `strategy-critique` (critic): skill and version, task, roles, entry kind `role_module`, request and result contracts, required capabilities (none), limits (512 KiB), source and method references (none) and entry points. It also holds the three agent configurations of decision D7: proposer A `claude-opus-5-5`, proposer B `claude-sonnet-5-5` and the critic `claude-opus-5-5` in its own profile and sessions, each with the one baseline bundle hash and its recorded knowledge cutoff (June 2026 for `claude-opus-5-5`; not stated by the checked source for `claude-sonnet-5-5`). |
| `src/assemble.ts` | `assembleFormulationRequest` and `assembleCritiqueRequest`. They fill the request from trusted host context, take `supplied_methods` and the instructions from the bundle module, validate the request against its schema, and return the canonical text with its digest, size and media type. `verifyRequest` runs the same checks on a request that was stored earlier: the host that executes a request verifies it the way assembly builds it (schema, canonical text, the bundle's supplied methods, and every refusal below). A refusal is a value: unset or incomplete holdout exclusions (V and H must each be named once, with the policy label, inside the window and covering all of it: only weekend days and at most one holiday may lie between a policy bound and the exclusion's first or last session), an evidence record that mentions a date inside a withheld window (a year-first date: `YYYY-MM-DD`, `YYYY/MM/DD` or compact `YYYYMMDD`, also inside a timestamp or a longer token such as `2024-06-03T20:00:00Z` or `file_2024-06-03.csv`; not screened: month names, day-first or month-first numeric dates, two-digit years, ordinal and week dates), operators that are not the policy's, a duplicate evidence id, a request above 512 KiB, a parent or strategy hash that is not the digest of the registered artefact, and run metrics as critic evidence (critique precedes evaluation). |
| `src/dispatch.ts` | `checkDispatch` enforces what `agent-dispatch/1` does not: the role matches the skill, the request contract is the skill's, the request digest, size and media type are the assembled request's, the holdout exclusions equal the request's and name V and H, the bundle hash is the built-in one, the required capabilities are the registry's and available, the profile is registered for the role, the output limit is at most 512 KiB, no tool is granted, and the result route is the attempt's. |
| `src/contract.ts` | `parseRole`: the byte limit, strict JSON, the version tag and the schema, with one bounded printable diagnostic, mapped onto the malformed reasons of `agent-attempt-result/1`. The shared `parseContract` cannot take the role schemas yet (see "Shared contract layer" below). |
| `src/leaf-diff.ts` | The leaf-level rule difference between a parent and a proposal, written as a proposal declares it, and the change scope (`ENTRY`, `EXIT`, `BOTH`, `NONE`, `OUTSIDE`) by dependency. |
| `src/parse-formulation.ts` | `parseFormulationResult`: malformed when a reference is not in the request (`REFERENCE_INVALID`) or the declared `rule_changes` are not exactly the parent difference (`RULE_CHANGES_MISMATCH`). Otherwise a completion with blockers: an unresolved entry, a revision that is not an entry-only or exit-only change, an operator outside the permitted set, a date inside a withheld window. Blockers are early notices. The API and the Rust core check scope, bounds, lineage, operators, types, units and lookback. No blocker makes a result malformed, in this module or in the agent runner: skill code does not repeat the Rust core's operator validation (OQ-03 section 3), so the draft is kept and the Rust core's diagnostics go to the next proposer attempt (OQ-02 section 4). The date screen finds the same forms as the evidence screen of `src/assemble.ts`. |
| `src/parse-critique.ts` | `parseCritiqueResult`: references from the request, pointers into the registered subject, every finding labelled `model_judgement`, an empty list flagged as not a pass. It assigns no treatment, severity or approval. |

`src` imports no Node module. `pnpm run build` bundles it for the neutral platform and fails on a Node import, a third-party dependency or run-time code generation.

## The behaviour bundle

`bundle.manifest.json` is the exact allowlist of what ships (OQ-03 §3), never a recursive copy: the two `src/skills/<skill>/procedure.md` files and the five role schemas in `schemas`, each with its SHA-256, and the digest of each derived, self-contained result schema (the schema that the executor output must satisfy, with the shared definitions it reaches). `methods` is empty: the baseline bundle adopts no method note. The bundle hash is the SHA-256 of the exact manifest bytes, so any change of a shipped file, of the list or of a derived schema gives a new hash through a reviewed `bundle:update`. `test/bundle.test.ts` pins the reviewed hash.

`tools/generate.ts` runs before every task. It checks the manifest against the files, then writes `dist/generated` (never committed): the role types, the first-error validators and `bundle.ts` with the procedure text, the result schemas and the bundle hash. Request assembly reads that module and no file. `scripts/agent-assets.ts` checks the manifest in `pnpm verify`: every listed file and hash; the file set in the bundle directories equals the list; an evaluation file, an expected answer, a development script, a method note, a private snapshot, an absolute or traversing path or a duplicate in the list fails; no procedure cites a method rule or evaluation material; and the Output section of each procedure names every field of its result schema.

Evaluation files (`evals/`), the code directories (`test/`, `tools/`, `dev/`) and the draft method notes (`src/methods`) are not part of the bundle and are never delivered to the executor. The production procedures are derived from OQ-02 and OQ-03 only; no book rule and no unverified method enters them.

## Contents

| Path | Contents |
| --- | --- |
| `bundle.manifest.json` | The bundle manifest. |
| `src/skills/<skill>/procedure.md` | Production procedure of one role module (shipped). |
| [`schemas/README.md`](schemas/README.md) | The five role request and result schemas (shipped). |
| `src/*.ts` | The role modules, Worker-safe. |
| `src/methods/sources.json`, `src/methods/<source>.md` | Draft method notes with their source registry. Not part of the bundle and not referenced by it. |
| `evals/fixture-policy.json` | Synthetic finding-treatment policy with one row per category and lifecycle transition, used only by offline evaluation. |
| `evals/<skill>/fixtures/dataset.json` | Evaluation case descriptions with split labels and expected outcomes. Critique cases supply no run of the candidate: critique follows registration and precedes evaluation. |
| `tools/` | Build tools: the generator, the manifest updater and the Worker bundle check. |
| `dev/` | Development scripts, fixture mode only. |
| `test/` | Vitest tests. |
| [`../../fixtures/agent-results`](../../fixtures/agent-results/README.md) | The offline suites. |

## Commands

Run these from the repository root with `pnpm --filter @openquant/agents run <command>`, or through Turborepo.

| Command | Work |
| --- | --- |
| `typecheck` | Generate, then type check `src` without Node types and the tests, tools and development scripts with them. |
| `lint` | Biome over `src test tools dev`. The hand-written JSON and Markdown data are checked by `scripts/agent-assets.ts`. |
| `test` | Generate, then run the Vitest tests. |
| `build` | Generate, type check `src`, then the Worker bundle check. |
| `generate` | Check the manifest against the files and write `dist/generated`. |
| `bundle:update` | Rewrite `bundle.manifest.json` from the files. Review the change: it changes the bundle hash. |
| `eval:fixture` | Run every offline fixture. `--mode live` is refused: no development script calls a model. The root command `pnpm agents:eval` (in `apps/agent-runner/tools`) runs the same fixtures with `--mode fixture`, refuses without `--mode`, and holds the guarded live mode. |

The package needs `packages/api-contracts/ts/dist/generated`. Turborepo builds it first (`^build`), and `generate` writes it when it is missing.

## Shared contract layer

The role schemas live here and reference the shared schemas by `$id`. The shared generator in `packages/api-contracts/ts` cannot bundle them: its `$id` grammar has no dot, its version tag is derived from the file name, and it reads only its own directory. This package therefore bundles the role schemas itself, reusing the shared generator for types, validators and the contract table, and `src/contract.ts` replaces `parseContract` for the role contracts. When the shared layer takes the role schemas, `parseRole` reduces to a call of `parseContract`.

## Rules for the draft method notes

- The method notes come from assistant-written summaries, not from the books. Every rule is `summary_claim_unverified` or `summariser_recommendation`. No rule is `primary_checked`, so none can enter a released bundle. A `primary_checked` rule would need a `primary_pages_checked` record in `sources.json` with its rule ID, the primary edition and locator, the exact pages, the check date and who checked it.
- Notes are written in original words. The summaries, the books and long passages stay outside Git.
- Corrections to the summaries are limited to rendering repairs, internal consistency and checks against standard definitions or the canonical specifications. A correction is not a primary-page check.
- A rule's origin follows its operative instruction. Use `summary_claim_unverified` when the summary attributes the instruction to the book. Use `summariser_recommendation` when it comes from summariser advice, from an adaptation in the note or from the specifications.
- A rule's scope is `seed` when it applies to the daily long-only seed family today, including a request for a test that the registered policy can declare. It is `needs_operator` when it needs a new reviewed operator, data or data semantics first. It is `out_of_scope` when the initial platform cannot express it.
- A rule's category is its primary OQ-03 §4 category. The last column can name related categories.
- Shipped text and draft notes under `src/` contain no evaluation material, links or quotations. Evaluation cases stay under `evals/`.
- Case descriptions contain no numerical goldens. Public cases are regression evidence, not holdouts.
- In a case, `warnings` are non-fatal messages from the host, the parser or owner validation. `diagnostics` are block, malformed or rejection reasons.

`pnpm verify` runs `scripts/agent-assets.ts` and the package tasks. The checks do not prove that a rule is true, that a summary matches its book, or that a procedure improves research. Real-model behaviour is untested here: fixtures are synthetic and labelled so.

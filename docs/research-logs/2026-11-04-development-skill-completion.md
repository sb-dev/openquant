# Development skill completion

## Problem and result

The first installation supplied 28 shared skills and configured two machine-local Claude plugins. That did not make `rust-review` or `spec-to-code-compliance` available as shared skills after checkout. AI engineering, durable workflow design, and project-specific delivery procedures were also missing.

The shared inventory now has 38 entries. Ten additions cover:

- `rust-review` and `spec-to-code-compliance`: portable entries with all pinned upstream plugin resources.
- `gha-security-review`: the Sentry review skill from the earlier recommendation.
- `prompt-engineering-patterns` and `llm-evaluation`: generic AI development guidance.
- `openquant-ai-engineering`: executor contracts, prompts, context, permissions, and model evaluation.
- `openquant-workflow-design`: scheduled research, durable dispatch, ownership, cancellation, and recovery.
- `openquant-research-evaluation`: competing research, source evidence, cohorts, and calibration.
- `openquant-financial-invariants`: units, accounting, independent fixtures, and changed numerical results.
- `openquant-vertical-slice`: small complete outcomes with specification and verification evidence.

The optional dimensional-analysis plugin from the initial research was not part of the 30 selected installs. Unit and scaling checks are covered by the new financial-invariants procedure. The proposed custom checkpoint and financial-evidence skills are delivered under the names above. No Production Skills family is claimed as installed.

## Ownership and sources

OQ-03 §§1–6 owns model behaviour. OQ-05 §§3–5 owns product orchestration. OQ-02 owns financial and research evidence. OQ-06 §§5–8 owns fixtures, development procedures, and delivery. OQ-07 §11 requires preserved third-party terms.

The installed sources and task map are in [the shared skill guide](../../.claude/README.md). Source revisions and notices are in `.claude/skill-sources.json`. The portable manifest records upstream paths, installed paths, and hashes for every review-bundle file.

The generic AI sources are pinned to wshobson/agents `7e2fb559cf4b824b27f1fec49fe88f7511066d26`; all 12 files match that revision. Sentry uses the existing `0c464f411bdfb8d4c12314b36264d06cb2f60270` revision. Trail of Bits uses the existing `470419e16f97e112d01fc32f4898aea1755015d9` revision. MIT, Apache-2.0, and CC-BY-SA-4.0 notices remain with the source records. The new first-party procedures use the repository's Apache-2.0 licence.

The portable review entries preserve 113 upstream resource files. Two nested entry paths are renamed to `SKILL.upstream.md` to avoid duplicate discovery. Of those files, 112 retain identical bytes. One Rust helper test changes its entry path to the renamed file. Two new root entry files map plugin-specific orchestration to available tools. Sequential role passes explicitly lack independent validation. Native Claude plugin settings remain unchanged.

## Checks and limits

Skills CLI 1.7.6 lists the same 38 unique names for Codex and Claude Code. All matching relative aliases resolve. The five new first-party skill frontmatters pass the skill validator.

The bundled Sentry scanner was run on all ten additions. Its five Rust findings flag auto-discovered pytest files. Those files are retained upstream helper tests, reviewed before execution. The scanner produced no findings on the other nine additions. Static scanning is not proof of safety.

The Rust helper suite passes 87 tests. It does not test the OpenQuant engine, which is absent. A sequential portable smoke check stops at that absence. A narrowly scoped compliance exercise classifies an absent planned runtime requirement without reporting it as a bootstrap defect. This does not validate the full compliance workflow or independent refutation.

A bounded AI/workflow design exercise used daily watchlist research, two proposer profiles, one critic, a three-unit budget, lost dispatch acknowledgement, duplicate triggers, and worker expiry. The exercise identified missing candidate-hash wording, same-model independence limits, multidimensional budgets, critic coverage, and conservative unknown-cost accounting. The project skills now state those rules. This was a design exercise, not deployed execution.

`pnpm verify` passes all 25 repository tests. Repository verification now rejects a missing declared shared skill, missing alias, missing portable support file, or changed portable resource hash. This prevents plugin configuration from satisfying a shared installation claim. The bootstrap checks remain separate from application, paid-model, and deployment acceptance.

Generic AI examples contain illustrative Python frameworks, placeholder metrics, and provider IDs. Their prompt optimizer uses word counts and word overlap, not authoritative token usage or research correctness. No dependency or model service is added to OpenQuant. GHA source guidance has a narrower threat model; OpenQuant's stricter full-SHA Action policy still applies.

The first verification run caught a stale portable-entry hash after its last edit. The final manifest records the reviewed entry bytes, and the full check was rerun. Preserved upstream whitespace produces two `git diff --check` notices in the generic AI skill and its licence; first-party changes have no whitespace errors.

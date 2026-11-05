---
name: openquant-vertical-slice
description: Plan, implement, or review one complete OpenQuant vertical slice from operator action to durable result and evidence. Use for roadmap decomposition, checkpoint tasks, spec compliance, minimal implementation, and acceptance handoffs.
---

# OpenQuant vertical slice

Read `AGENTS.md`, `docs/specs/README.md`, `docs/product/roadmap.md`, and the owning specification. OQ-06 §8 owns checkpoint acceptance. Resolve paths from the repository root.

## Select the outcome

Define one observable user or operator result. Inspect current code and verification before choosing dependencies. Do not count reserved directories or written requirements as implemented capability.

Trace the narrow path through input, guarded command, durable state, execution, result, and presentation. Include only layers needed for this outcome. Reuse the four shared packages and API-owned modules. Do not create empty packages or horizontal infrastructure phases as deliverables.

For a roadmap task, produce ordered slices with the outcome, dependencies, affected owners/paths, runnable demonstration, failure behaviour, and acceptance evidence. Preserve accepted product scope. If a requested priority changes canonical checkpoint semantics, propose the owning specification change instead of silently rewriting it.

## Implement and verify

Map each changed behaviour to its owning spec section and relevant acceptance ID. Keep one authoritative owner. Update each affected specification if semantics change.

Implement the smallest path that demonstrates the outcome. Use deterministic adapters only when the outcome permits them. Label recorded model proposals and replay data. They cannot prove actual model execution or prospective paper performance.

Test the key behaviour and failure boundary. Run the repository's required checks. Add a verification command only when it performs real work; no unconditional success or zero-test substitutes. Keep expected financial results independently derived.

Before committing, inspect guidance and recent commits. Stage only intended paths. Regenerate `REPOSITORY_TREE.txt` after additions/deletions. Regenerate the spec index only if spec metadata changed. Run `pnpm verify` again after generated changes.

Use the repository commit format and exactly one verified model co-author trailer. Read a pushed commit, PR, or other external change back before reporting success.

## Deliver

State the observable outcome, changed files, owning requirements, exact run command, verified results, and remaining limits. Keep bootstrap checks separate from checkpoint acceptance. End with the user's next action, if one is needed.

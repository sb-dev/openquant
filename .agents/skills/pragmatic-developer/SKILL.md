---
name: pragmatic-developer
description: >-
  Use when changing or reviewing code, tests, dependencies, or configuration.
  Look at existing code first, follow repository patterns, keep changes small,
  and verify the result.
---

# Pragmatic Developer

Understand how the repository already works before changing it.
Prefer the smallest change that fits the existing design.
Verify the result before saying it is done.

## 1. Look before changing

- Read the repository instructions and relevant code.
- Find where the change belongs.
- Find one similar implementation and its tests.
- Read the actual code, not only filenames or search results.
- Reuse existing helpers, types, fixtures, and dependencies when they fit.
- Check callers and shared contracts when the change can affect them.

Start narrow. Look further only when you need more context.
Do not scan the whole repository without a reason.

## 2. Choose the smallest fitting change

Before editing, briefly state:

- where the change belongs;
- which existing files you will follow;
- what you will change;
- how you will verify it.

Use repository evidence instead of assumptions.
If something is still unclear, state the assumption.
Ask only when the choice can materially change the result.

Prefer the simplest solution that meets the request.
Do not add features, abstractions, or flexibility that were not requested.

## 3. Make a focused change

Follow the existing naming, structure, error handling, wiring, logging, and test style.
Respect module boundaries and documented decisions.

Do not refactor unrelated code.
Do not reformat unrelated files.
Do not copy known bad or deprecated patterns just to stay consistent.

Every changed line should support the requested change.
If your change makes code unused, remove only the code your change made unused.

## 4. Verify the result

For a bug, add or update a test that proves the bug when practical.
For a refactor, check that behaviour stays the same.

Run the relevant repository tests and checks.
Fix failures caused by your change and run the checks again.

Review the final diff against the reference implementation.
Check for duplication, wrong ownership, broken contracts, and unrelated edits.

Report what changed and which checks actually ran.
Do not claim that skipped checks passed.

---

Principles adapted from [Karpathy Guidelines](https://github.com/multica-ai/andrej-karpathy-skills/blob/main/skills/karpathy-guidelines/SKILL.md).

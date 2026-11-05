---
name: rust-review
description: Review Rust crates, services, or libraries for safe/unsafe boundary issues, memory safety, concurrency hazards, panic-induced denial of service, FFI safety, and async runtime mistakes. Use for a Rust security audit, especially unsafe, FFI, or concurrent code.
---

# Rust security review

This is a local portable entry point adapted from the pinned Trail of Bits plugin.
Attribution: Trail of Bits, https://github.com/trailofbits/skills.
This adapted entry and its upstream resources retain CC-BY-SA-4.0;
see the preserved licence in `.claude/third-party/trailofbits/skills/LICENSE`.
The complete plugin source is in `upstream/`.
Invoke this shared skill as `rust-review`; no named plugin agent is required.
Apply repository instructions and canonical specifications first.
This is a development tool, not an OpenQuant deployed research-agent bundle.

## Required procedure

Read the full [upstream procedure](upstream/skills/rust-review/SKILL.upstream.md) before starting.
Follow all phases, evidence rules, finding schemas, retry limits, coverage gates,
judging order, report safeguards, and success criteria there.
Apply only the runtime substitutions below.
Do not replace the full procedure with a short inline review.

1. Resolve this skill's actual directory, including through the Claude symlink.
   Set `RUST_REVIEW_PLUGIN_ROOT` to its absolute `upstream/` directory.
   Verify `prompts/clusters/manifest.json` and `scripts/build_run_plan.py` there.
   Use this pinned directory instead of upstream's environment-variable or home-directory search.
2. Resolve the threat model, severity filter, and requested scope from the user.
   Ask for missing audit decisions together.
   Use the current model unless the user selects another available model.
   Record the actual model if supplied by the runtime; otherwise record `unknown`.
   Do not translate Claude model names into guessed provider equivalents.
3. Use native file, shell, search, and delegation tools for the upstream operations.
   `Read`, `Write`, `Edit`, `Bash`, and `Glob` describe capabilities, not mandatory tool names.
   Use `rg` for the upstream regex searches.
   Read and review bundled scripts before running them.
   Keep the upstream Python 3.11+ and `uv` prerequisites.
4. Maintain the upstream task ledger with host task tools, or persist equivalent
   task IDs, statuses, attempts, abort reasons, and worker metadata in
   `${output_dir}/tasks.json` when those tools are unavailable.
   Never mark a worker complete before its artifact validation passes.
5. Run each role from its full instruction file below, using the rendered worker
   prompt verbatim as task input. If generic delegation is available and permitted,
   supply the role file as instructions to a generic agent. Do not depend on
   `rust-review:*` agent registrations or frontmatter-enforced tool grants.
   Enforce the stated role boundaries yourself.
6. If delegation is unavailable, run distinct sequential role passes.
   Persist each worker's artifacts before starting the next pass.
   Read each role file again at the role boundary.
   State `execution_mode: sequential-role-passes` in `run-summary.md`.
   State that judges were not independent agents. Do not claim independent validation.
   All workers and both judge passes remain mandatory.
7. The cache primer and foreground/wave advice are Claude runtime optimizations.
   Use them only where the host supports their documented behavior.
   In sequential mode skip only the cache primer, never a review pass.
   With delegation, cap concurrency at the host limit and wait for every worker.
8. Run the deduplication judge before the false-positive/severity judge.
   Preserve Phase 7 retry cleanup only within the current run's assigned prefixes.
   Run the artifact validator and SARIF/report safeguards exactly as upstream specifies.
   Read all final artifacts back. Report incomplete coverage, failed judges, dropped
   findings, and unverified severity before presenting conclusions.

## Role files and resources

- [Worker](upstream/agents/rust-review-worker.md): read for each worker or primer.
- [Deduplication judge](upstream/agents/rust-review-dedup-judge.md): read after workers finish.
- [False-positive and severity judge](upstream/agents/rust-review-fp-judge.md): read after deduplication.
- [Cluster manifest](upstream/prompts/clusters/manifest.json): planner-owned selection and all prompt paths.
- [Run planner](upstream/scripts/build_run_plan.py): required deterministic plan and prompt generation.
- [Artifact validator](upstream/scripts/validate_artifacts.py): required worker completion gate.
- [SARIF generator](upstream/scripts/generate_sarif.py): required final machine-readable report.

Interpret every relative plugin path in the upstream procedure and role files
from `RUST_REVIEW_PLUGIN_ROOT`, not the audited source directory.
The full plugin README, prompts, and script tests are preserved beneath `upstream/`.
The original skill entry is named `SKILL.upstream.md` to avoid duplicate discovery.
The prompt-regex test uses that filename; all other upstream contents are unchanged.
The repository's third-party Trail of Bits licence applies to those files.

If the requested scope has no Rust source, stop with that fact.
Do not report a Rust audit from installation checks or script tests.
This port changes orchestration only; upstream runtime claims are not verification
of this portable entry point.

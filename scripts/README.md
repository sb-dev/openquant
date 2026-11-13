# Repository tooling

The scripts use Node built-ins and erasable TypeScript syntax. Use `.node-version`. No dependency install is required for the Node scripts. The Rust steps need the toolchain pinned in `rust-toolchain.toml`.

| Script | Purpose |
| --- | --- |
| `verify.ts` | Run repository checks and their regression tests, then the Rust steps from `rust.ts`, then check the S0 replay report; fail on any failure. |
| `rust.ts` | The Cargo commands run by `verify.ts` (format, clippy, tests, S0 replay), the pinned-toolchain check and the fixture-change guard. |
| `s0.ts` | Static S0 rules: Rust workspace and toolchain pin, required Cargo steps in `verify.ts` and CI, fixture case layout, oracle hashes, S0 row coverage, protocol manifest completeness; and the replay report check. |
| `check-repository.ts` | Check the seven specs, metadata/index, acceptance IDs, links/anchors, source hashes, file map, high-confidence credential patterns, and selected workflow conventions. |
| `generate-spec-index.ts` | Generate the ownership/version table from document metadata. |
| `generate-repository-tree.ts` | Generate the sorted file map from the Git index, or regular files in an extracted archive. |
| `repository.ts` | Shared implementation. |
| `development-skills.ts` | Check declared shared skills, aliases, installer records, adapted-file hashes, and complete portable resources with recorded hashes. |
| `agent-assets.ts` | Check the pre-S1 draft assets in `packages/agents`: exact layout, source registry, method-note rule rows, rule references, finding-category parity with OQ-03 §4, the synthetic fixture policy, evaluation case fields and required case coverage. It does not check that a rule is true or that a procedure works. |
| `tests/repository.test.ts` | Negative cases for drift, missing requirements, links, provenance, mutable actions, archive path escape, and agent asset rules. |

In a Git checkout, stage intended added/deleted paths before generating the tree. The index records intended repository contents. An extracted ZIP has no `.git`, so the same tool reads its files.

Imported source Markdown is excluded from local-link checks because its historical links and layouts are intentionally unchanged. Every imported file remains covered by its SHA-256 check.

The workflow checks are static conventions, not an Actions emulator or full security audit. Type stripping does not type-check. S0 adds Rust verification. S1 adds strict TypeScript checks and actual application tests. Public CLI release adds installed-package validation.

# Repository tooling

The scripts use Node built-ins and erasable TypeScript syntax. Use `.node-version`. No dependency install is required.

| Script | Purpose |
| --- | --- |
| `verify.ts` | Run repository checks and their regression tests; fail on either failure. |
| `check-repository.ts` | Check the seven specs, metadata/index, acceptance IDs, links/anchors, source hashes, file map, high-confidence credential patterns, and selected workflow conventions. |
| `generate-spec-index.ts` | Generate the ownership/version table from document metadata. |
| `generate-repository-tree.ts` | Generate the sorted file map from the Git index, or regular files in an extracted archive. |
| `repository.ts` | Shared implementation. |
| `tests/repository.test.ts` | Negative cases for drift, missing requirements, links, provenance, mutable actions, and archive path escape. |

In a Git checkout, stage intended added/deleted paths before generating the tree. The index records intended repository contents. An extracted ZIP has no `.git`, so the same tool reads its files.

Imported source Markdown is excluded from local-link checks because its historical links and layouts are intentionally unchanged. Every imported file remains covered by its SHA-256 check.

The workflow checks are static conventions, not an Actions emulator or full security audit. Type stripping does not type-check. C1 adds strict TypeScript checks, actual application tests, Rust verification, and installed-package validation.

# Repository tooling

The scripts use Node built-ins and erasable TypeScript syntax. Use `.node-version`. No dependency install is required for the Node scripts. The Rust steps need the toolchain pinned in `rust-toolchain.toml`.

| Script | Purpose |
| --- | --- |
| `verify.ts` | Run repository checks and their regression tests, then the pinned-toolchain check, the Rust steps from `rust.ts`, the fixture-change guard and the S0 replay report check; fail on any failure. |
| `rust.ts` | The Cargo commands run by `verify.ts` (format, clippy, tests, S0 replay), the pinned-toolchain check and the fixture-change guard. |
| `s0.ts` | Static S0 rules: Rust workspace and toolchain pin, the Cargo steps compared with a literal expected list, the code shapes `verify.ts` must keep, CI wiring, fixture case layout, oracle hashes, S0 row coverage, protocol manifest vocabulary and completeness; and the replay report check against the fixture inventory. |
| `check-repository.ts` | Check the seven specs, metadata/index, acceptance IDs, links/anchors, source hashes, file map, high-confidence credential patterns, and selected workflow conventions. |
| `generate-spec-index.ts` | Generate the ownership/version table from document metadata. |
| `generate-repository-tree.ts` | Generate the sorted file map from the Git index, or regular files in an extracted archive. |
| `repository.ts` | Shared implementation. |
| `development-skills.ts` | Check declared shared skills, aliases, installer records, adapted-file hashes, and complete portable resources with recorded hashes. |
| `agent-assets.ts` | Check the pre-S1 draft assets in `packages/agents`: exact layout, source registry, method-note rule rows, rule references, finding-category parity with OQ-03 §4, the synthetic fixture policy, evaluation case fields and required case coverage. It does not check that a rule is true or that a procedure works. |
| `tests/repository.test.ts` | Negative cases for drift, missing requirements, links, provenance, mutable actions, archive path escape, agent asset rules and the S0 rules; and behavioural tests of the `verify.ts` driver. |

In a Git checkout, stage intended added/deleted paths before generating the tree. The index records intended repository contents. An extracted ZIP has no `.git`, so the same tool reads its files.

Imported source Markdown is excluded from local-link checks because its historical links and layouts are intentionally unchanged. Every imported file remains covered by its SHA-256 check.

The workflow checks are static conventions, not an Actions emulator or full security audit. Type stripping does not type-check. S0 adds Rust verification. S1 adds strict TypeScript checks and actual application tests. Public CLI release adds installed-package validation.

## How the S0 verification is guarded

The guards do not read their expectation from the file they check.

- `expectedCargoCommands` in `s0.ts` is a literal ordered list. `s0Errors` compares the real `cargoCommands` from `rust.ts` with it by exact equality, so a dropped step, a changed flag (`--locked`, `-D warnings`), an added `--lib` or `--no-run`, a duplicate or a reordering fails. A change to a Cargo step is therefore a change to two files in one review.
- `verifyDriverErrors` and `rustModuleErrors` require code shapes, not identifiers: the exit-code check on every Cargo step, the fixture digest taken before and compared after, the toolchain pin check, the `reportErrors` call, and `runCargo` returning the exit status. They read the source without comments, so a comment cannot satisfy them, and they check the order. `withoutComments` is not a parser; it only has to read these two files.
- The driver tests run the real `verify.ts`, `rust.ts` and `s0.ts` in a temporary root. Four inputs are stand-ins: `scripts/check-repository.ts` and `scripts/tests/repository.test.ts` in that root (the driver would otherwise run this test file again and recurse), and `cargo` and `rustc`, shell scripts placed first on `PATH`. A stand-in `cargo` records its arguments, can exit non-zero for a chosen subcommand, can change a fixture, and can write a replay report. There is no switch in `verify.ts`, so nothing in a normal run can disable a step. The tests need `sh` and are skipped on Windows. They take a few seconds.
- `reportErrors` lists the directories under `fixtures/s0/cases`. The replay index and the report must hold exactly those case ids, each once, and the `- cases: N` line must equal their number. A replay of part of the inventory fails even when every listed case passed.
- Every entry of `fixtures/protocol/manifest.json` must use an `expect` of `valid`, `schema_invalid` or `semantic_invalid` and one of the four contract names, because the Rust tests select entries by those values and silently skip any other. Every file must be listed and every listed file must exist.

Expected values in `fixtures/s0/cases/*/expected.json` are bound to `origin.oracle_sha256` and to CODEOWNERS review of `/fixtures/`; `verify` does not re-derive them, because OQ-06 section 8 requires no second numerical engine in verification, so a golden change is a reviewed change with an explained semantic reason and never a side effect of a test run.

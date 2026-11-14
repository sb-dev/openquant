# Changelog

## Unreleased — bootstrap

- Consolidate seven canonical specifications under `docs/specs`.
- Preserve Design v2 acceptance A01–A18 and repository acceptance R01–R10.
- Retain Cloudflare orchestration and Fly.io native execution.
- Add source ownership guides, contributor policies, issue/PR templates, and CI.
- Add TypeScript checks for metadata, file-map drift, links, source hashes, and workflow conventions.
- Archive nine supplied design references with SHA-256 provenance.

- Add the S0 offline seed evaluation: a Cargo workspace with a pinned toolchain, versioned input/result/checkpoint schemas with generated Rust bindings and runtime validation, a shared Rust core (typed operator interpreter, daily execution phases, exact accounting, corporate actions, checkpoint restore), four versioned seed Strategy Definitions, independent synthetic fixtures, a local replay report, and Rust checks in `pnpm verify` and CI.
- Decide every S0 level comparison (stop and target touch, gap, validity, break-even trigger, entry signal) on exact rational values, and keep levels exact through splits. A level that does not fit 128 bits, or has no decimal view (an integer part of 2^96 or more), fails with `ARITHMETIC_OVERFLOW` at the event that creates it. The checkpoint may carry a level as a reduced fraction `n/d` (`Exact`). Add 25 independent grid-tie cases (G-01 to G-13b) and three cases for levels without a decimal view (I-12a to I-12c).
- Add the S1 TypeScript workspace (pnpm, Turborepo, strict TypeScript, Biome, Vitest) and `@openquant/api-contracts`: generated types and standalone validators for every shared schema, strict JSON, canonical SHA-256 digests and the Rust contract-layer order, with a parity test against the Rust contracts report.
- Add the S1 TypeScript steps to `pnpm verify` and CI: the Rust contracts report, a dependency check against `pnpm-lock.yaml` that never installs, Turborepo typecheck, lint, test and build without cached results, and workspace checks for licences, import boundaries and parsed workflow YAML.
- Close the verification guard gaps of the P1 review: CI checks fix every step, input and environment variable of the `checks` job; `verify.ts`, its step environment and the step runners must equal their reviewed code; every step runs without inherited variables that could switch it off; the workspace packages, their task scripts and the Turborepo task list are literal; Vitest and `node:test` reporters fail a run that executes no test or skips one; tracked Cargo configuration and manifest settings that skip tests fail.
- Close the second-round verification guard gaps of the P1 review: `pnpm-workspace.yaml` may set only `packages`, `verifyDepsBeforeRun: error` and the reviewed `allowBuilds`, and no other tracked file configures pnpm; the root scripts are a literal set, no manifest defines an install lifecycle script or hook, and CI installs with `--ignore-scripts`; CI runs the repository checks as their own step before any install; the top-level code of the guard modules may not use `process`, the environment or an exit, and no verification script reads the `CI`, `GITHUB_*` or `RUNNER_*` variables; Cargo manifests are read as TOML, and the workspace checks require a Cargo test target for every tracked integration test file; the `node:test` reporter compares the files that ran with the listed workspace test files; a Dependabot update of a pinned action commit passes. The guards run inside the code they guard, so changes to `scripts/**` and `.github/**` rely on code-owner review.

No trading application, connected research, broker adapter, model runner, cloud deployment, or package release is implemented.

# Changelog

## Unreleased — bootstrap

- Consolidate seven canonical specifications under `docs/specs`.
- Preserve Design v2 acceptance A01–A18 and repository acceptance R01–R10.
- Retain Cloudflare orchestration and Fly.io native execution.
- Add source ownership guides, contributor policies, issue/PR templates, and CI.
- Add TypeScript checks for metadata, file-map drift, links, source hashes, and workflow conventions.
- Archive nine supplied design references with SHA-256 provenance.

- Add the S0 offline seed evaluation: a Cargo workspace with a pinned toolchain, versioned input/result/checkpoint schemas with generated Rust bindings and runtime validation, a shared Rust core (typed operator interpreter, daily execution phases, exact accounting, corporate actions, checkpoint restore), four versioned seed Strategy Definitions, independent synthetic fixtures, a local replay report, and Rust checks in `pnpm verify` and CI.
- Decide every S0 level comparison (stop and target touch, gap, validity, break-even trigger, entry signal) on exact rational values, and keep levels exact through splits. A level that does not fit 128 bits fails with `ARITHMETIC_OVERFLOW`. The checkpoint may carry a level as a reduced fraction `n/d` (`Exact`). Add 25 independent grid-tie cases (G-01 to G-13b).

No trading application, connected research, broker adapter, model runner, cloud deployment, or package release is implemented.

# Changelog

## Unreleased — bootstrap

- Consolidate seven canonical specifications under `docs/specs`.
- Preserve Design v2 acceptance A01–A18 and repository acceptance R01–R10.
- Retain Cloudflare orchestration and Fly.io native execution.
- Add source ownership guides, contributor policies, issue/PR templates, and CI.
- Add TypeScript checks for metadata, file-map drift, links, source hashes, and workflow conventions.
- Archive nine supplied design references with SHA-256 provenance.

- Add the S0 offline seed evaluation: a Cargo workspace with a pinned toolchain, versioned input/result/checkpoint schemas with generated Rust bindings and runtime validation, a shared Rust core (typed operator interpreter, daily execution phases, exact accounting, corporate actions, checkpoint restore), four versioned seed Strategy Definitions, independent synthetic fixtures, a local replay report, and Rust checks in `pnpm verify` and CI.

No trading application, connected research, broker adapter, model runner, cloud deployment, or package release is implemented.

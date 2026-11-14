# Getting started

Clone the repository. Use Node 24 (the version in `.node-version`) and the pnpm version in `packageManager` in `package.json`. Install the dependencies locked in `pnpm-lock.yaml`:

```bash
git clone https://github.com/sb-dev/openquant.git
cd openquant
pnpm install --frozen-lockfile
```

Run the verification:

```bash
node scripts/verify.ts
```

No cloud, model, market-data or broker credentials are required. The repository checks run with Node alone. The TypeScript steps need the installed dependencies: verification compares them with `pnpm-lock.yaml` and stops with `Run: pnpm install --frozen-lockfile` when they are missing or differ. It never installs. The Rust steps need the toolchain pinned in `rust-toolchain.toml` (`rustup toolchain install`) and fetch the crates locked in `Cargo.lock`. The check verifies repository structure, spec metadata, local links, acceptance IDs, source hashes, workflow conventions, regression cases, Rust formatting, clippy, Rust tests, the S0 offline replay, the Rust contracts report, TypeScript type checks, lint, tests and builds, and the licences, import boundaries and workflow files. It does not start a trading application. S1 is incomplete; real-Postgres tests arrive with the S1 durable API.

To replay the S0 fixture cases and read the report:

```bash
cargo run --locked -p openquant-engine --bin s0-replay
```

The report is `local-runs/s0/report.md`.

## Next implementation

Read the [roadmap](../product/roadmap.md), then follow [M1 — Automated watchlist research](../guides/m1-watchlist-research.md). The first target is a durable competing research cycle with real data and numerical evidence. The [installed replay](../guides/public-cli-replay.md) is a separate public CLI release gate. Neither connected runtime is implemented yet. S0 provides the offline seed evaluation they reuse.

Before changing files, read [CONTRIBUTING.md](../../CONTRIBUTING.md), [AGENTS.md](../../AGENTS.md), and the owning specification. Work on a branch. Run verification before committing and use the specified commit format. AI-authored commits require a verified model trailer.

## Maintainer setup

Remote repository settings are separate from the source checkout. Inspect existing settings before changing them. Require the stable `ci` check through a branch ruleset after that check exists.

Enable code-owner review and protect changes to workflows, specs, schemas, risk code, and infrastructure. Verify the ruleset settings. Keep fork PR workflows free from secrets and use a read-only default Actions token.

Enable and verify private vulnerability reporting before public release. Set a private maintainer contact for community concerns. The bootstrap does not configure these remote settings.

Deployment and release workflows are added with their implementation checkpoints. They need protected environments, scoped credentials, reviewed artefact identity, and read-back tests before use. No cloud deployment is needed to inspect or verify this bootstrap.


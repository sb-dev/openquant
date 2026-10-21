# OpenQuant

OpenQuant is an open-source platform for AI-assisted quantitative research, strategy evaluation, paper competition, and governed trading.

Proposers create strategies. Critics challenge them. Software produces official evidence and enforces risk. A steward approves real-capital authority.

**Status: specification-first bootstrap.** This repository contains the agreed design, source layout, contributor policies, and executable repository checks. It does not yet contain a trading application, Rust engine, or deployed service.

## Start here

1. Read the [canonical specs](docs/specs/README.md).
2. Run the bootstrap checks below.
3. Follow [repository setup](docs/getting-started/README.md).
4. Implement [C1 — Reproducible core](docs/guides/c1-reproducible-core.md).

## Verify the bootstrap

Use the Node version in `.node-version`. The checks need no cloud credentials or dependency installation.

```bash
node scripts/verify.ts
```

With the pinned pnpm version, the equivalent command is:

```bash
pnpm verify
```

GitHub Actions runs the same checks on pull requests and pushes to `main`. The required aggregate check is named `ci`. Repository settings still need to be configured after import.

## Product loop

Research → competing proposals → independent critique → historical evaluation → live paper competition → portfolio/shadow review → approved mandate → monitoring and revision.

A mission can produce no eligible strategy. A portfolio can retain cash. A passing backtest does not grant trading authority.

| Area | Intended implementation |
| --- | --- |
| Operator frontend | TypeScript, React, Ink. |
| Product orchestration | Hono and Cloudflare Workers, Workflows, notifications, and scheduling. |
| Native execution | Rust on Fly.io; separate batch, paper/shadow, and live apps. |
| Model execution | Isolated Node host on Fly.io; one delegated executor for proposer and critic. |
| Durable state | Neon Postgres and R2. |
| Repository automation | GitHub Actions for verification, releases, and deployment. |

The target first product command is `openquant demo`. C1 will calculate a bundled **REPLAY** through the actual Rust core without broker, model, market-data, or cloud credentials. That command is not implemented in this bootstrap.

## Repository

| Path | Purpose |
| --- | --- |
| [apps](apps/README.md) | CLI, API, agent host, engine host, public website. |
| [packages](packages/README.md) | Contracts, client, agent behaviour, shared Rust core. |
| [docs/specs](docs/specs/README.md) | Seven canonical owners. |
| [docs](docs/README.md) | Setup, guides, architecture, operations, source migration. |
| [fixtures](fixtures/README.md) | Planned example packs, benchmarks, protocol cases, recorded agent data. |
| [academy](academy/README.md) | Quantitative research and operating methods. |
| [blog](blog/README.md) | Project changes, research, engineering, case studies. |
| [infra](infra/README.md) | Cloudflare/Fly resource and deployment ownership. |
| [scripts](scripts/README.md) | Working repository checks and generators. |

See [REPOSITORY_TREE.txt](REPOSITORY_TREE.txt) for the generated file list.

## Contribute

Read [CONTRIBUTING.md](CONTRIBUTING.md) and [AGENTS.md](AGENTS.md). Cite the owning specification. Report only checks actually run. Planned application acceptance is separate from bootstrap verification.

New OpenQuant material uses [Apache-2.0](LICENSE). Third-party material retains its own terms. See [NOTICE](NOTICE), [SECURITY.md](SECURITY.md), and [TRADEMARKS.md](TRADEMARKS.md).

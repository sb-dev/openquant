# OpenQuant

OpenQuant is an open-source platform for AI-assisted quantitative research, strategy evaluation, paper competition, and governed trading.

Proposers create strategies. Critics challenge them. Software produces official evidence and enforces risk. A steward approves real-capital authority.

**Status: specification-first bootstrap with the S0 offline seed evaluation.** This repository contains the agreed design, source layout, contributor policies, executable repository checks, and the shared Rust core's offline seed evaluation on synthetic data (M1/S0). It does not yet contain a trading application, connected research, or deployed service. M1 is not complete.

## Start here

1. Follow [getting started](docs/getting-started/README.md) to clone and verify the repository.
2. Read the [design](#design) and [canonical specs](docs/specs/README.md).
3. Follow the [roadmap](docs/product/roadmap.md), starting with [M1 — Automated watchlist research](docs/guides/m1-watchlist-research.md).

## Verify the bootstrap

Use Node 24 (the version in `.node-version`), the pnpm version in `packageManager` in `package.json`, and the Rust toolchain pinned in `rust-toolchain.toml` (`rustup toolchain install` installs it). The checks need no cloud, model, market-data or broker credentials. Install the locked dependencies first. Verification compares the install with `pnpm-lock.yaml`, fails with the install command when they differ, and never installs. The Rust steps fetch the crates locked in `Cargo.lock`.

```bash
pnpm install --frozen-lockfile
pnpm verify
```

`pnpm verify` runs `node scripts/verify.ts`: the repository checks, `cargo fmt`, `cargo clippy`, `cargo test`, the S0 replay and the Rust contracts report, then the S1 TypeScript steps: Turborepo typecheck, lint, test and build without cached results, and the workspace checks (licences, import boundaries, workflow files). S1 is incomplete. Real-Postgres tests arrive with the S1 durable API. Replay the S0 fixture cases and read the report:

```bash
cargo run --locked -p openquant-engine --bin s0-replay
```

The report is `local-runs/s0/report.md`. See [S0 fixtures](fixtures/s0/README.md).

GitHub Actions runs the same checks on pull requests and pushes to `main`. The required aggregate check is named `ci`. Maintainers must [verify remote settings](docs/getting-started/README.md#maintainer-setup); the workflow does not configure branch protection.

## Product loop

Research → competing proposals → independent critique → historical evaluation → live paper competition → portfolio/shadow review → approved mandate → monitoring and revision.

A mission can produce no eligible strategy. A portfolio can retain cash. A passing backtest does not grant trading authority.

## Design

| Principle | Owning specification |
| --- | --- |
| One shared Rust core calculates strategy behaviour across replay, backtest, paper, shadow, and live profiles. Processes retain separate credentials and authority. | [Domain §2](docs/specs/02-trading-domain-and-evaluation-spec.md#2-one-strategy-format), [architecture §§5–6](docs/specs/05-system-architecture-and-data-spec.md#5-storage-networking-and-credentials). |
| Proposers and critics use separate sessions and bounded budgets. Guarded application commands accept their proposals; agents cannot create official evidence or grant capital authority. | [Model execution](docs/specs/03-model-backed-execution-spec.md). |
| Immutable strategies, complete trial histories, point-in-time data, and consumed holdouts make evidence traceable. Paper uses future live data with simulated fills; shadow tests the production decision path without orders. Replay remains historical. | [Evaluation §3](docs/specs/02-trading-domain-and-evaluation-spec.md#3-evaluation-and-the-arena). |
| Approval binds the strategy, evidence, policy, account, limits, and expiry. Approved, installed, and active are distinct states. | [Lifecycle §4](docs/specs/02-trading-domain-and-evaluation-spec.md#4-lifecycle-and-promotion). |
| Ink exposes evidence, freshness, risk, and command outcomes. Closing the terminal does not stop backend work. | [Terminal UX](docs/specs/04-ink-ux-ui-spec.md). |

## Roadmap

All application checkpoints are planned. Repository checks do not satisfy their product acceptance gates.

| Milestone | Intended outcome |
| --- | --- |
| M1 — Automated watchlist research | Recurring competing research with selectable Alpaca/Massive data, SEC/Tavily evidence, bounded budgets and recovery. |
| M2 — Prospective paper competition | Frozen candidates, future observations and independent recoverable virtual ledgers. |
| M3 — Portfolio and shadow validation | Combined exposure and execution-path evidence without broker orders. |
| M4 — Governed live | Isolated live execution, bounded mandates, reconciliation and emergency recovery. |
| Public CLI release | Clean installed credential-free replay through the shared Rust engine. |

The [delivery roadmap](docs/product/roadmap.md) links prerequisites, acceptance evidence, and open decisions. The [Production Skills plan](docs/product/production-skills.md) records candidate development support and the separate product-agent boundary.

## Technology

| Area | Intended implementation |
| --- | --- |
| Operator frontend | TypeScript, React, Ink. |
| Product orchestration | Hono and Cloudflare Workers, Workflows, notifications, and scheduling. |
| Native execution | Rust on Fly.io; separate batch, paper/shadow, and live apps. |
| Model execution | Isolated Node host on Fly.io; one delegated executor for proposer and critic. |
| Durable state | Neon Postgres and R2. |
| Public website | Astro; repository content and approved public exports. |
| Infrastructure | Terraform for supported Cloudflare resources; versioned setup commands and Fly profiles. |
| Repository automation | GitHub Actions for verification, releases, and deployment. |

See [architecture §1](docs/specs/05-system-architecture-and-data-spec.md#1-technology-and-workload-placement) and [resource ownership](docs/specs/06-engineering-delivery-and-operations-spec.md#3-environments-resources-and-releases). Wrangler deploys Cloudflare code; pinned flyctl deploys Fly apps through GitHub Actions.

The first operational target is [automated watchlist research](docs/guides/m1-watchlist-research.md). [Provider contracts](docs/reference/service-providers.md) keep source selection separate from research logic. The public CLI release separately requires `openquant demo`, a credential-free **REPLAY** through the shared Rust core. These runtime capabilities are not implemented.

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

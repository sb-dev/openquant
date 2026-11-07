---
id: OQ-01
title: OpenQuant — Product Design
version: 1.1.0
status: canonical
updated: 2026-11-05
owns: goals, scope, operating loop, human responsibilities
---

# OpenQuant — Product Design

This document defines required behaviour. It does not claim that the behaviour is implemented.
See the [specification index](README.md) for ownership and the current bootstrap scope.

## 1. Purpose and scope

OpenQuant is an open-source platform for AI-assisted quantitative research, controlled strategy evaluation, paper competition, and governed trading.

The objective is portfolio-level return after costs, subject to risk limits. The system must reject weak strategies, retain failed experiments, and use operating evidence to improve research.

Start with one operator-controlled fund, one live broker account, and one supported market profile. The profile defines instruments, data, trading hours, execution assumptions, and evaluation rules.

The complete research-to-capital loop remains in scope. High-frequency trading, investor onboarding, custody, and managing outside capital are outside this design.

The project name is **OpenQuant**. The executable name is `openquant`.

## 2. Operating loop and authority

A research mission creates competing proposals. Independent critique challenges them. Historical evaluation and live paper competition collect evidence. Portfolio and execution-path reviews determine eligibility. A steward can then approve a bounded live mandate. Monitoring can reduce, pause, retire, or return a strategy to research.

A mission can finish with no eligible strategy. An Arena cohort can have no winner. The fund can retain cash. The system must not manufacture a promotion to complete a workflow.

### Three implementation units

| Unit | Responsibility | Authority boundary |
|---|---|---|
| **Terminal application** | Ink UI, local presentation state, commands, evidence inspection | No authority to calculate official results or send broker orders |
| **Control application** | Hono API, agent jobs, evaluation coordination, lifecycle decisions, mandates, audit | Can authorise a bounded deployment; cannot bypass trading checks |
| **Rust engine** | Strategy execution, simulation, metrics, portfolio calculations, hard risk, broker state | Can act only within installed mandates; cannot grant itself capital |

The engine is one codebase, not one unrestricted process. Historical jobs have no broker credentials. Before live trading, the live engine runs in an independently deployed process with separate credentials and resource limits. A large backtest must not delay live risk checks.

## 3. Research and evidence

Use two AI roles: proposer and critic. Several proposer configurations can compete within a mission. Ordinary software produces official evaluation results, calculates allocations, and enforces risk.

One immutable strategy artefact contains the explanatory Strategy Contract and the executable Strategy Definition. Evidence Bundles and the Strategy Graph are derived from stored records. Graph maintenance is automatic.

Research can return no eligible candidate. A fund can retain cash. Neither an agent nor a workflow must manufacture a promotion to report completion.

Paper and shadow are separate evidence checks. Paper observes future live data with simulated fills. Shadow checks the intended production decision path without broker submission. Historical fixture replay is labelled `REPLAY`.

[Trading domain](02-trading-domain-and-evaluation-spec.md) owns the exact rules. [Model execution](03-model-backed-execution-spec.md) owns AI permissions and behaviour.

## 4. Human responsibilities

The steward sets research budgets, cohort policies, supported markets, and capital mandates. First live activation, increased capital ceilings, wider instrument permissions, weaker limits, and resumption after a risk halt require steward approval.

Automatic reductions and pauses operate within an approved policy. No agent grants itself capital or expands its own permissions.

Before live enablement, select the market, data provider, broker, account permissions, base currency, capital amount, risk limits, data rights, and operational responsibilities. These inputs belong to a versioned live profile. Do not adopt monetary values from illustrative examples as defaults.

An operator must have an emergency route independent of the normal application. A solo maintainer is not two independent human reviewers.

## 5. Operator experience

The primary workspaces are **Overview, Foundry, Arena, Portfolio, Operations**. Risk status and emergency access remain visible from every workspace. Strategy detail is reused across these views.

The interface must show environment, account, real or simulated money mode, data freshness, and risk state. It must distinguish a pending command, an unknown outcome, and a confirmed result.

Exiting the terminal detaches the operator. It does not halt trading or cancel backend work.

The first operational milestone is automated competing research on a saved stock watchlist. The operator selects a versioned research profile, sources, calendar and spending limits. Each cycle freezes membership and inputs, records competing proposals and critique, and produces official Rust evaluation evidence. Inspection, pause, explicit cancellation and resume remain available while the backend works without a terminal.

Start with daily bars, one market/currency and reviewed long-only operators. Alpaca and Massive are initial selectable market adapters; SEC EDGAR supplies filings and Tavily supplies web evidence. Their capabilities and access must be verified before use. A source or stock failure remains visible. A cycle may produce no eligible strategy.

The public CLI release separately provides `openquant demo`: a credential-free bundled REPLAY through the same Rust core. Recorded proposals are labelled. The installed demo remains required for public CLI release, but does not block private M1 operation.

[Ink UX/UI](04-ink-ux-ui-spec.md) owns the interaction details.

## 6. Operating cadence

| Cadence | Work |
| --- | --- |
| Continuous | Ingest data, run active strategies, enforce risk, reconcile orders and positions, and monitor incidents. |
| Daily | Review P&L attribution, exposure, strategy health, paper/shadow results, and execution quality. |
| Weekly | Review Arena evidence, promotion or demotion, allocation, critic findings, decay, and research priorities. |
| Monthly | Review retirement, portfolio regimes, agent calibration, search history, and risk limits. |
| Governance review | Review broker controls, recovery evidence, market permissions, applicable obligations, and capital scaling. |

Research remains enabled across bounded cycles. Initially dispatch after the selected trading session and provider freshness window; also permit explicit on-demand runs. The stored schedule policy owns overlap and missed-slot behaviour. Daily historical refreshes remain BACKTEST evidence.

Cloudflare schedules durable product work. GitHub Actions runs repository verification and delivery. The product continues without an open terminal or GitHub runner.

## 7. Delivery and acceptance

Deliver M1 automated watchlist research, M2 prospective paper competition, M3 portfolio/shadow validation, and M4 governed live operation. Deliver the installed offline replay as a separate public CLI release gate. [Engineering §8](06-engineering-delivery-and-operations-spec.md#8-delivery-checkpoints-and-acceptance) owns their completion evidence.

The [A01–A18 acceptance criteria](02-trading-domain-and-evaluation-spec.md#9-acceptance-and-preservation-of-results) preserve the agreed product requirements. Repository acceptance R01–R10 is defined in the engineering specification.

“Same results” means preserved capabilities and measured behaviour. It does not promise equal future returns or identical ideas from stochastic models. Compare deterministic outputs on fixed inputs. Compare research quality under matched missions, budgets, data, and model versions.

## 8. Public product

Keep one repository-backed website for Docs, Academy, examples, the Strategy Library, benchmarks, case studies, integrations, and blog material. Real-money trading is optional for community use.

Publish methodology, risk code, and tests. Keep credentials, account data, active mandates, and private datasets out of public material. [Open-source organisation](07-open-source-project-organisation-spec.md) owns publication rules.

## 9. Source migration

This specification adopts Design v2 §§1, 3, 14–18 and the original operating cadence. Source layout and hosting follow Repository Design v1.1. See the [source migration record](../research-logs/2026-10-19-bootstrap-migration.md).

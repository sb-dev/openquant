---
id: OQ-07
title: OpenQuant — Open-Source Project Organisation
version: 1.0.0
status: canonical
updated: 2026-10-19
owns: public surfaces, contribution, governance, licensing, publication
---

# OpenQuant — Open-Source Project Organisation

This document defines required behaviour. It does not claim that the behaviour is implemented.
See the [specification index](README.md) for ownership and the current bootstrap scope.

## 1. Purpose and identity

OpenQuant is one open-source product. The repository is the canonical source for specifications, code, public documentation, examples, benchmark definitions, and ecosystem metadata.

Use the name **OpenQuant** and the command `openquant`. Do not replace the name with alternatives. Do not claim trademark registration or naming clearance.

The public journey is **Discover → Understand → Run → Research → Test → Compare → Learn → Extend → Contribute**. Real-money trading is optional throughout the community journey.

## 2. Public surfaces and source ownership

| Surface | Purpose | Source |
| --- | --- | --- |
| README | Explain the product and lead to the first verified run. | Root README. |
| Docs | Explain product behaviour, installation, guides, and reference. | `docs/`, with requirements owned by `docs/specs`. |
| Academy | Teach research judgement, evaluation, portfolio reasoning, and operation. | `academy/`. |
| Examples | Reproduce complete workflows. | `fixtures/example-packs`, described in `docs/guides`. |
| Strategy Library | Discover inspectable, reusable strategy artefacts. | Example packs and catalogue metadata in `docs/reference`. |
| Arena / Benchmarks | Inspect reproducible evaluation and comparable evidence. | `fixtures/benchmark-packs` and approved result manifests. |
| Case studies | Trace complete journeys, including failures. | `blog/case-studies`. |
| Integrations | Discover capabilities, constraints, and compatibility. | Catalogue metadata in `docs/reference`; adapters beside their host. |
| Blog | Explain research practice, engineering, changes, and lessons. | `blog/`. |
| Website | Present the public product and these sources. | `apps/web`; no separate content backend. |
| Discussions | Ask for help, debate methods, and collaborate. | GitHub, when configured. |

The website renders repository material and approved, redacted exports. It does not connect to the private operating console or fund database. Public Arena pages are versioned reports.

Keep product behaviour in the owning specification. Academy, examples, blog posts, and screenshots cannot redefine it.

## 3. README and website

The README follows understand, see evidence, run, and explore. Keep it concise. Explain the research-to-capital loop, why evidence matters, the current implementation status, available commands, and next steps.

Advertise only implemented quick-start commands. At C1, the first useful result is a deterministic `REPLAY` through the actual engine without broker, data-provider, model, or cloud credentials.

The website adds a product overview, terminal demonstration, evidence model, strategy format, critic workflow, evaluation results, portfolio/risk boundaries, examples, and contribution routes. Do not lead with hypothetical returns or use “production-ready” without operating evidence.

The project provides research and trading infrastructure. Bundled strategies are examples, not recommendations. Backtests are not live returns. Real-money execution is separately enabled under a mandate.

## 4. Documentation and Academy

Docs explain OpenQuant. Academy teaches how to conduct and evaluate research with it.

| Academy area | Topics |
| --- | --- |
| Foundations | Hypotheses, falsification, apparent alpha, risk-adjusted thinking, research versus execution. |
| Research | Economic rationale, signals, sizing, exits, invalidation, declarative strategy design, proposer/critic work. |
| Evaluation | Point-in-time data, survivorship and look-ahead bias, costs, slippage, capacity, baselines, walk-forward tests, sensitivity, resampling, regimes, multiple testing, holdouts, trial accounting. |
| Portfolio | Correlation, families, marginal contribution, allocation, cash, capacity, strategy decay. |
| Operations | Paper/shadow/live distinctions, order states, reconciliation, halt, monitoring, audit, incidents, retirement. |
| Advanced use | Data and broker adapters, delegated execution adapters, evaluation suites, reviewed strategy operators, custom metrics. |

Include projects that construct a hypothesis, reject an overfit strategy, run a paper cohort, add a data adapter, and build an evaluation suite. Introduce each with its working capability, not as a claim of existing support.

## 5. Example packs and Strategy Library

One canonical example pack contains the strategy artefact, hypothesis, dataset manifest, execution configuration, expected invariants, explanation, licence, and attribution. Tests, demo, guides, Academy, and public results reference that pack.

Strategy metadata identifies purpose, universe, data requirements, horizon, assumptions, known failure modes, evaluation instructions, compatible schema/engine versions, licence, and author. Link benchmark or paper evidence only when it exists.

Select official examples for educational value, reproducibility, useful baselines, regression detection, or demonstrated capability. A high return alone is not an acceptance criterion.

Retain examples that are overfit, cost-sensitive, regime-fragile, or highly correlated. Failed strategies are useful evidence and tests.

Start with cash/buy-and-hold baselines, simple momentum, simple mean reversion, and a deliberately overfit case as checkpoints make them runnable. Do not invent successful fixture results to populate a catalogue.

Community strategy metadata can link to external repositories. A registry is sufficient. Do not build a strategy marketplace or signal-selling service.

## 6. Benchmarks

Benchmark packs cover engine correctness, simulation correctness, evaluation methodology, robustness, performance regression, cross-version reproducibility, portfolio calculations, and risk invariants.

Each pack specifies its purpose, strategy inputs, dataset identity, period, universe, costs, evaluation suite, fixed seed where used, expected invariants, and independent baseline calculations.

Use simple baselines such as cash, buy-and-hold, random entry, momentum, mean reversion, and equal weight. Compare after costs and under declared risk constraints.

Public results identify OpenQuant version, engine digest, suite version, data manifest, run date, environment, output, and reproducibility instructions. Rerun affected packs when semantics change. Do not regenerate golden outputs merely to make tests pass.

Runtime research history is private Neon/R2 data. Repository benchmarks verify software and methodology; they are not the production research scheduler.

## 7. Publication and data policy

Evidence must support each claim:

| Claim | Required grounding |
| --- | --- |
| Feature exists | Implemented behaviour and relevant passing tests. |
| Strategy executes | Versioned artefact and reproducible example. |
| Historical result | Engine/data/strategy identity, configuration, cost model, and result. |
| Robustness | Declared suite, assumptions, full outcomes, and exclusions. |
| Paper result | Prospective timestamps, immutable run, live-data source, simulator identity. |
| Live result | Broker execution evidence, mode, tier, period, and redacted provenance. |
| Comparison | Same cohort, inputs/period where applicable, methods, costs, and uncertainty. |
| Reliability | Tested operational evidence rather than design intent. |

Label `REPLAY`, `BACKTEST`, `PAPER`, `SHADOW`, and `LIVE` explicitly. Real-money results with a `MICRO` mandate show that tier. Do not merge modes into an unlabelled return series or describe historical output as a track record.

Every performance presentation identifies period, capital basis, fees, slippage/cost assumptions, benchmark, strategy version, engine version, dataset identity, search history, holdout use, and uncertainty where relevant. Unknown external search history remains unknown.

Do not selectively publish only successful live periods. Prefer reproducible result pages over isolated equity-curve screenshots. Reuse the same approved report in release notes, Arena pages, and case studies.

Distinguish synthetic, open, redistributable, user-supplied, and commercially licensed data. Manifests state provider, licence, asset class, universe, frequency, period, point-in-time properties, corporate actions, content hash, and source/reproduction instructions.

Licensed datasets remain outside Git unless redistribution is permitted. A connector does not grant data rights. Private accounts, active mandates, credentials, and prompts containing private information are excluded from exports.

Public exports require explicit authorisation, redaction, licence checks, and reproducibility review. A17 applies whenever a result is published. The risk implementation and tests remain open-source.

## 8. Case studies and blog

Publish complete journeys: mission to paper Arena; a strong backtest that fails; a portfolio diversifier; paper-to-shadow; and governed micro-capital only after real execution exists.

Include unsuccessful and inconclusive outcomes. Explain evidence, decisions, limits, and incidents. A lower standalone return can add portfolio value; quantify the chosen objective rather than declaring universal superiority.

Blog topics include project changes, AI-assisted research, evaluation methods, Rust simulation, point-in-time data, risk, reconciliation, regressions, and operating lessons. Group them under OpenQuant, research/evaluation, engineering/trust, and case studies.

Use the project's own fixture and operating history for a continuing case study once there is evidence to publish.

## 9. Integrations

Begin with a catalogue, not a marketplace. Record name, category, description, author, version, repository, compatibility, capabilities, configuration, licence, and status: `OFFICIAL`, `COMMUNITY`, `EXPERIMENTAL`, or `DEPRECATED`.

Data adapters document instruments, frequencies, historical/live support, point-in-time properties, corporate actions, limits, costs, and redistribution terms.

Broker adapters document sandbox/live support, asset classes, order types, authentication, idempotency limits, reconciliation, cancellation semantics, known limitations, and compatible OpenQuant versions. Live integrations require the domain and operational evidence before publication as supported.

A delegated model adapter follows the common AgentExecutor boundary. Do not introduce an OpenQuant provider-selection platform through the integration catalogue.

## 10. Community and governance

Issues track bugs, implementation, docs, reproducibility failures, benchmark regressions, and integrations. Ask for version, environment, safe reproduction, expected/actual results, and redacted evidence.

Discussions can cover announcements, help, research ideas, strategy design, evaluation, benchmarks, integrations, architecture, and demonstrations. They are not a stock-tip, copy-trading, signal-sales, or investment-solicitation channel.

Start with a maintainer and contributors. The maintainer owns release decisions, accepted specifications, security handling, and adding/removing maintainers. Record material decisions in a research log with problem, options, decision, compatibility, risks, migration, and verification.

Use three contribution levels: local improvement, implementation under an existing contract, and canonical change. The last updates the owning specification before acceptance. Changes to strategy semantics, evaluation methods, risk, broker execution, credential handling, or public performance methods need focused review and evidence.

A solo maintainer cannot claim independent human approval. Automated checks and model findings do not create another human reviewer. Resolve disagreements through a recorded decision and allow evidence-based reconsideration.

## 11. Licensing, security, and releases

Use Apache-2.0 for new OpenQuant code and documentation. Preserve notices and third-party terms. Imported reference documents keep their source attribution; their inclusion does not relicense external software or datasets. Brand use is covered by `TRADEMARKS.md`.

Before public release, configure and verify a private vulnerability-reporting route. Security issues include broker/risk bypass, authentication bypass, executor escape, account data exposure, and supply-chain compromise. Do not request public account evidence.

Release notes separate product, quant engine, strategy schema, evaluation, risk, integrations, breaking changes, migrations, and known issues. Explain numerical changes and publish affected benchmark results. Do not describe a compatibility decision as proof of future returns.

## 12. Progressive publication and acceptance

At bootstrap, publish the design and truthful status. At C1, add the runnable replay, first example pack, correctness/cost benchmarks, and introductory learning material. C2 adds research/critique and rejection examples. C3 adds prospective paper, portfolio, and shadow material. C4 adds broker, emergency, recovery, and governed live guides.

Each usable capability ships the smallest set of material needed to discover, understand, run, verify, and extend it. Do not build a CMS, learning-management system, strategy marketplace, or private benchmark portal as prerequisites.

Acceptance requires a clear canonical source; a credential-free first evaluation when C1 ships; reproducible claims; versioned strategy/data assumptions; failed examples; separate Docs and Academy roles; reusable packs; regression benchmarks; explicit modes; protected private data; reviewed live integrations; and one website that reuses repository knowledge.

## 13. Source migration

Retains the organisation plan's public surfaces, curriculum, evidence rules, integration catalogue, and contribution model. Applies Design v2 §15 and Repository Design v1.1 §§13–14. Removes naming alternatives, duplicate root catalogues, the claim that replay is live paper trading, and wording that implied risk-control code should be closed.

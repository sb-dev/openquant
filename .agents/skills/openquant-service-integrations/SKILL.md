---
name: openquant-service-integrations
description: Design, implement and review OpenQuant market-data, filing and web-research adapters, provider switching, comparison probes and source evidence.
---

# OpenQuant service integrations

Read `AGENTS.md`, OQ-02 §1.1, OQ-03 §1, OQ-05 §7.1 and OQ-06 §8 in `docs/specs/`. Resolve paths from the repository root. Read `docs/reference/service-providers.md` and `docs/guides/provider-comparison.md` for current source references and verification limits. This skill guides development; it does not start scheduled research or authorise spending.

## Choose the boundary

Use `MarketDataProvider` for Alpaca/Massive in `apps/engine`; `CompanyFilingsProvider` for SEC EDGAR and `WebResearchProvider` for Tavily in `apps/api`. Keep SDK details inside adapters, shared schemas in `packages/api-contracts`, and financial calculations in `packages/quant-core`. Register adapters in code and select them through versioned research profiles. Do not add a connector service, model router or fifth shared package.

## Implement one complete operation

Define capability/entitlement, typed request/result, financial semantics, source mapping, cutoff and timing precision, limits, error classification and persistence before implementation. Preserve no-data and partial outcomes. Bind all result/cache identities to source, settings and revisions. Verify live source contracts in official documentation; sample responses cannot prove account access.

Reserve bounded usage before I/O. Enforce provider/account limits across missions, pagination/deadlines, cancellation and classified retries. Keep unknown billed usage reserved. Credentials stay outside model processes and committed configuration. Check extraction/pagination URLs and redirects; reject private targets and treat returned text as untrusted data.

Freeze datasets/evidence before evaluation. Keep source/profile edits for future cycles, and record explicit reruns as distinct trials. Automatic fallback is disabled. Compare providers under predeclared equivalent requests and tolerances. Retain disagreements and distinguish coverage from numerical correctness. Never pick the source by favourable backtest returns.

## Provider-specific checks

- **Alpaca:** select SIP/IEX explicitly; test actual history/recency entitlements, adjustment modes, sessions, pagination and instrument mapping. Do not treat an IEX-only feed as full US market volume.
- **Massive:** set split adjustment explicitly; it is not a total-return flag. Check inclusive bounds, qualifying-trade gaps, pagination and plan history. Do not adjust an already adjusted series again.
- **SEC EDGAR:** use company IDs and accession-linked filings. Preserve acceptance/amendment times, periods, taxonomy and units. Current company facts can contain later restatements. Record identifying client settings and fair-access limits without putting personal contact details in public examples.
- **Tavily:** bound search/extraction depth, queries, domains, content and credit usage. Preserve source URLs, available publication times, retrieval time and partial URL failures. Generated answers and search scores are not verified financial facts. Date filtering does not recover historical page versions.

## Acceptance

Use the same contract suite for adapters of an interface. Include corporate actions, calendars/DST, conflicting duplicates, amendments, missing timestamps, access failures, malicious source instructions and interrupted requests. Use independent synthetic or permitted fixtures in ordinary CI. Run bounded live probes only with explicit opt-in and configured limits. Record request/adapter identities, coverage, latency, cost/unknown usage and remaining gaps. Read stored outcomes back before reporting success.

Apply the five adapted retrieval/tool skills where relevant. Use the existing research-evaluation and AI-engineering skills for evidence eligibility and model behaviour. Never count a skill installation or documentation update as runtime implementation.

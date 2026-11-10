# Watchlist research and provider contracts

Date: 2026-11-05. Base revision: `75d26f6e75dbd06e64c12fce0192ae6a681cfd80`.

## Decision

Deliver automated competing watchlist research first. Replace the C1–C4 delivery sequence with M1–M4 and a separate public CLI release gate. Preserve A01–A18 and R01–R10 verbatim. M1 incorporates numerical correctness and durable research; M2/M3 separate prospective paper from portfolio/shadow validation. The public CLI gate retains the clean installed offline replay.

Define `MarketDataProvider` (Alpaca/Massive), `CompanyFilingsProvider` (SEC EDGAR) and `WebResearchProvider` (Tavily). Use registered adapters selected through a versioned research profile. Freeze provider, watchlist and evidence identities for every cycle. Disable automatic fallback. Record data comparisons as distinct inputs/trials with predeclared semantics and tolerances.

Keep market adapters in the native engine host, filing/web adapters in the API, schemas in api-contracts and calculations in quant-core. Retain the existing four shared packages, two workflow classes and one batch queue. Data selection does not introduce a model router.

## Delivery and compatibility

Canonical specifications advance to 1.1.0. The roadmap defines five M1 slices, then prospective paper, shadow/portfolio and live outcomes. Supporting guides and component ownership labels follow the new sequence. The original C1 guide becomes the public CLI replay guide; the historical migration record links to its original committed version.

Install five ML4T retrieval/tool skills from revision `691857537a0c8befc11dc2f2ad7a458b7c7e801c` using Skills CLI 1.7.6. Adapt them for OpenQuant schema/numeric rules, qualified data validation, correct calendar handling and bounded provider tools. Add `openquant-service-integrations` and align three existing project skills. Record upstream hashes, installed hashes and licence notices. Extend repository verification to reject adapted-file drift and unsafe adaptation paths. Preserve matching relative Claude aliases.

These are development skills. The deployed behaviour bundle still needs its own reviewed release and evaluations. No application, provider adapter, cloud resource or scheduled job is implemented by this change.

## Source evidence and limits

The [provider reference](../reference/service-providers.md) links official sources reviewed on 2026-11-05. These establish documented API behaviour only. No authenticated provider probes, paid model runs, real datasets or deployment acceptance were executed. Use synthetic/permitted fixtures for ordinary checks and explicit bounded live probes for M1 acceptance.

## Verification record

- `pnpm generate:spec-index` and `pnpm generate:tree`: regenerated current specification metadata and the tracked file map.
- `pnpm verify`: repository checks and 27 regression tests pass, including adapted-file mutation/path checks. These remain bootstrap checks.
- `pnpm dlx skills@1.7.6 list --agent codex` and the equivalent `--agent claude-code`: both list all six new entries. All 45 declared aliases resolve to the matching canonical source; all entry front matter parses.
- Acceptance comparison against the base revision: A01–A18 and R01–R10 text is unchanged.
- GPT-6 Astra exercised the new guidance on split/DST, filing amendments, uncertain web availability, ambiguous billed timeouts and active-profile changes. It corrected retry wording and added eight synthetic acceptance designs to the comparison guide. DST values were checked using Python `zoneinfo`. These designs are not executed adapter tests.
- `git diff --check`: no whitespace errors.

An initial check identified a historical link to the renamed C1 guide; it now points to the original committed guide. The skill review changed the adapted fetch-data file, so its recorded hash was updated before final verification. No provider implementation or live research behaviour is claimed.

## Delivery amendment — 2026-11-10

Add S0 — Offline seed evaluation before S1. This changes the current M1 sequence to six slices, S0–S5; the five-slice decision above remains the historical record. OQ-06 §8 and the [roadmap](../product/roadmap.md) own the current acceptance and dependencies.

S0 gives the existing numerical requirements a separate completion point: fixed synthetic inputs, independent expectations and inspectable results through the shared Rust core in `pnpm verify`. It needs no provider credentials, model execution, cloud service or deployment. S1 depends on that evidence and retains connected competition, authority, durability and deployment verification. S4 retains joint watchlist evaluation; S5 retains unattended revisions and distributed recovery. The installed public CLI replay remains a separate release gate.

This amendment changes delivery planning only. It does not implement the core or fixtures, establish an acceptance pass, or alter the financial rules, A01–A18 or R01–R10.

Review clarification — 2026-11-10: S0 evaluates versioned Strategy Definitions through the reviewed typed operator path. Threshold and break-even variants change definition data, not evaluator code. Its input, numerical result and checkpoint schemas belong to `packages/api-contracts/schemas` from S0. Rust validation and shared payload fixtures arrive with S0; S1 adds TypeScript validation and connected envelopes. This avoids a separate hard-coded seed or temporary wire format that S1 would need to replace. The extra S0 work is bounded to the seed's operator/schema subset; connected and joint acceptance remain in S1 and S4.

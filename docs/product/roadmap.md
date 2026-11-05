# Delivery roadmap

Status: planning. M1–M4 and the public CLI release are not implemented.

The first operational milestone is automated competing research on a stock watchlist. Build complete user outcomes through the existing API, workflows, agent host and shared Rust core. Add infrastructure with the slice that uses it.

[Engineering §8](../specs/06-engineering-delivery-and-operations-spec.md#8-delivery-checkpoints-and-acceptance) owns milestone acceptance. [Domain §9](../specs/02-trading-domain-and-evaluation-spec.md#9-acceptance-and-preservation-of-results) retains A01–A18. Requirements are not pass results.

## Milestones

| Milestone | Operator outcome | Required evidence |
| --- | --- | --- |
| M1 — Automated watchlist research | Configure sources, watchlist, schedule and budgets. Competing proposers, a separate critic and the Rust evaluator produce durable evidence while the terminal is closed. | A01–A06, A11, applicable A15; R01–R03, R05–R06, R08 and applicable isolation/export checks. All slices below, including live provider and executor probes. |
| M2 — Prospective paper competition | Frozen candidates compete on future market observations with independent virtual ledgers. | A07, applicable A13/A15; common periods, retained losses/outages, restart and stale-data evidence. Historical refreshes cannot satisfy PAPER evidence. |
| M3 — Portfolio and shadow validation | Inspect combined exposure and validate the intended execution path without submitting orders. | A08–A10, applicable A13/A15; separate shadow evidence, portfolio constraints, current approval state and no live authority. |
| M4 — Governed live operation | Operate an isolated live account under an approved bounded mandate. | All applicable criteria, including A09–A14/A18 and R07–R10; broker reconciliation, single-writer recovery and emergency evidence. |

R01–R03 apply throughout. Apply R07–R10 when their boundaries are introduced. A17 applies to each public export. A18 applies whenever engine semantics change. The [live gate](../specs/06-engineering-delivery-and-operations-spec.md#additional-live-gate) remains mandatory.

## M1 vertical slices

Start with one market/currency, daily bars, a small operator-selected watchlist and reviewed long-only operators. Two proposer configurations compete under the same declared policy; the critic has separate authority. Exact instruments, source entitlements, history, thresholds and spending limits are configured before live probes.

| Slice | Outcome and dependency | Demonstration and failure evidence |
| --- | --- | --- |
| S1 — One complete competition | For one stock, retrieve Alpaca data, freeze inputs, register competing proposals, critique and evaluate them with Rust, then inspect the saved result. Introduce only the contracts, deployment and CLI view needed for this path. | Independent financial fixture; real provider and executor probes; full trial history; invalid operators/data fail; no eligible candidate is a valid result. Ownership, permissions and budgets apply from this slice. |
| S2 — Switch and compare sources | Build on S1. Select Massive through a versioned profile and run the same workflow. Compare aligned Alpaca/Massive datasets separately. | Same workflow without provider-specific branches; shared adapter contract cases; feed/session/adjustment differences explained; unavailable capabilities fail; no silent fallback or best-return source selection. |
| S3 — Research with cited evidence | Build on S2. Attach SEC EDGAR filings/facts and Tavily search/extracted sources to a bounded mission. | Filing identities, amendments, units and timestamps retained; unsupported historical availability excluded; source instructions cannot change tools; failed/partial retrieval is visible. News or filings used as executable inputs need registered data semantics and a reviewed operator. |
| S4 — Cover a saved watchlist | Build on S3. Run per-stock missions from one immutable watchlist snapshot and inspect coverage. | Every member has an outcome/reason; edits affect future cycles; one failure does not erase other results; per-stock allocation prevents budget starvation. |
| S5 — Continue unattended research | Build on S4. Enable calendar-based cycles, pause/cancel/resume, recover failures and use bounded prior findings. | Repeated slots deduplicate; stale data, overlap and missed cycles follow policy; successive live cycles finish without TUI/GHA; crash/redelivery/lost-ack recovery; total spend stays bounded; lineage and consumed holdouts survive revisions. |

Each slice includes its minimum operator view, tests and run guide. S5 completes the unattended operating gate; it does not defer basic durability or authority from S1. [The M1 guide](../guides/m1-watchlist-research.md) defines the implementation handoff. [Provider comparison](../guides/provider-comparison.md) defines comparison evidence.

## Public CLI release

The credential-free installed REPLAY demo is a separate release gate, not a prerequisite for private M1 operation. Preserve A03–A05, A15–A16 and R04, clean Linux/macOS installation, matching engine identity and release allowlist checks. Follow [public CLI replay](../guides/public-cli-replay.md). Do not publish the CLI as satisfying these checks before they pass.

The former C1 numerical foundation is incorporated into S1; its installed demo remains this release gate. Former C2 maps to M1; former C3 splits into M2/M3; former C4 maps to M4. No acceptance ID is removed or redefined.

## Evidence and decisions

For each slice record source revision, exact procedure, input/executable identities, expected and observed results, and remaining gaps. Run deterministic checks through `pnpm verify`; keep credentialed provider, paid-model and deployment probes separate. Bootstrap checks alone cannot complete a milestone.

| Decision | Latest point and owner | Evidence |
| --- | --- | --- |
| Market, instruments, history, costs, operators and cohort suite | Before S1 evaluation; research operator/core implementer | Valid/invalid contracts, independent calculations, common benchmarks and holdout policy. |
| Source profiles, credentials, entitlements and storage rights | Before each adapter's live probe; integration owner/operator | [Provider reference](../reference/service-providers.md), actual access/coverage, rate limits and permitted retention. |
| Executor version/profile, authentication and distribution | Before S1 real-model claim; runner owner | Pinned isolated binary, production behaviour bundle, bounded measured execution. |
| Watchlist schedule, freshness, missed-slot policy and aggregate budgets | Before S5 enablement; operator | Frozen profile, coverage, repeated-slot and exhaustion tests. |
| Deployment ownership and recovery | Each deployed slice; operations owner | Running identities, saved outcome, failure and restore evidence. |
| Prospective feed and simulation policy | Before M2; research operator | Actual live feed, comparable ledgers, outage and restart checks. |
| Broker, account, capital and emergency ownership | Before M4; steward/operations owner | Approved profile and live-readiness evidence. |

Public material follows verified capability under [organisation §12](../specs/07-open-source-project-organisation-spec.md#12-progressive-publication-and-acceptance). Reuse versioned packs; retain failed examples; keep restricted data private. Development skills support delivery under the [selection plan](production-skills.md); they do not establish runtime acceptance.

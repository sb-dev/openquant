# Delivery roadmap

Status: planning. C1–C4 are not implemented.

This roadmap makes [engineering §8](../specs/06-engineering-delivery-and-operations-spec.md#8-delivery-checkpoints-and-acceptance) actionable. The canonical specifications own requirements. [Domain §9](../specs/02-trading-domain-and-evaluation-spec.md#9-acceptance-and-preservation-of-results) owns A01–A18; engineering §8 owns R01–R10. The summaries below do not replace them.

## Baseline and evidence

The bootstrap supplies specifications, directory ownership guides, contributor policies, and repository checks. Run `node scripts/verify.ts` from the repository root. This checks structure and regressions; it does not verify an application or deployment.

Keep each checkpoint planned until its code exists. Record implementation and verification separately. A completion record must identify the source revision, exact commands or procedures, input and executable identities, expected results, observed results, and remaining gaps. Keep public records in `docs/research-logs`; keep private operational evidence outside Git and link only authorised references.

Extend `pnpm verify` with the deterministic checks introduced by each checkpoint. Record paid-model, deployment, and live-readiness checks separately when credentials or an operating environment are required. A mock, screenshot, or successful upload does not establish those results.

## Checkpoints

| Checkpoint | Prerequisites and deliverables | Acceptance and evidence |
| --- | --- | --- |
| **C1 — Reproducible core** | Follow the [C1 guide](../guides/c1-reproducible-core.md). Add tested TypeScript/Rust workspaces, versioned protocols, independent synthetic financial fixtures, a shared Rust evaluator, Ink inspection, and a clean installed `openquant demo` in `REPLAY` mode. | **A03–A05, A15–A16; R01–R04**, plus applicable release checks. Save actual ledger results, invalid/future/missing-data failures, terminal interaction results, and clean Linux/macOS installation evidence. Expected financial values must be calculated independently of the engine. |
| **C2 — Competing research** | Build on the C1 contracts and fixtures. Add Hono/Neon/R2, ResearchWorkflow and EvaluationWorkflow, the delegated proposer/critic runner, and official evaluation dispatch. Declare budgets, cohort policy, data provenance, and holdout access before evaluating candidates. | **A01–A06, A11; R05–R06**, plus applicable repository/deployment checks. Exercise the real opt-in executor and reviewed bundle. Save complete trial histories, failed/retried attempts, and recovery evidence for crash, redelivery, and lost acknowledgement. Verify a saved run across Cloudflare/Fly without an active terminal or GitHub Actions runner. |
| **C3 — Persistent paper fund** | Use durable C2 run ownership. Select a permitted live-data feed and comparable paper policies. Add independent virtual ledgers, the separate shadow portfolio path, notifications, and persistent session recovery. | **A07–A10, A13, A15**, plus applicable repository/deployment checks. Retain prospective paper outcomes, separate shadow evidence, portfolio constraints, approval-state checks without live authority, and restart/stale-state results. Replay cannot satisfy prospective paper evidence. |
| **C4 — Governed live** | Require eligible evidence and the [additional live gate](../specs/06-engineering-delivery-and-operations-spec.md#additional-live-gate). Add the isolated live Fly app, protected deployment, approved micro mandate, broker reconciliation, and emergency procedures. | **All applicable checks, including A09–A14 and A18; R07–R10.** Save exact approval/install/activation read-backs, single-writer and durable-order-intent tests, unknown-submission recovery, duplicate/late-fill handling, and emergency/restart results. Halt and liquidation remain separate actions. |

R01–R03 remain ongoing repository obligations. Apply R07–R10 as their deployment, publication, and execution boundaries are introduced; their evidence is not deferred automatically to C4. The [deployment probe](../specs/06-engineering-delivery-and-operations-spec.md#4-deployment-verification-and-live-readiness) defines required cross-service checks and running-identity read-backs.

**A17 applies whenever a result is published. A18 applies whenever evaluated engine semantics change, including before live trading.** Preserve affected evidence or record an explicit compatibility decision. Never silently replace expected numbers.

## Public material follows verified capability

Follow [organisation §12](../specs/07-open-source-project-organisation-spec.md#12-progressive-publication-and-acceptance):

| Stage | Material to add when its evidence exists |
| --- | --- |
| C1 | Runnable replay, first reusable example pack, correctness/cost benchmarks, and introductory learning material. |
| C2 | Research, critique, and rejection examples with bounded execution and complete trial context. |
| C3 | Prospective paper, portfolio, and shadow examples with explicit mode and limitations. |
| C4 | Broker, emergency, recovery, and governed live guides. |

Reuse the same versioned packs across tests, demo, docs, and Academy. Include failed examples. Keep public benchmarks separate from private runtime competition. Publication requires authorisation, licence checks, redaction, and reproducibility review under [organisation §7](../specs/07-open-source-project-organisation-spec.md#7-publication-and-data-policy).

## Decisions before implementation or operation

These choices remain open. Owners below are responsibilities to assign, not named assignees. Record each decision, evidence, owner, and any blocking finding in the relevant implementation research log.

| Decision | Responsible role | Latest decision point and evidence |
| --- | --- | --- |
| Supported operators, numeric rules, protocol versions, and fixture inputs | Core implementer; maintainer reviews | C1 implementation. Independent calculations and valid/invalid protocol cases. |
| Research/data profile, cohort policy, costs, and holdout access | Research operator | Before the affected C2 evaluation. Data provenance, permitted use, and a registered comparison plan. |
| Executor version/profile, authentication, distribution terms, and budget | Runner implementer; operator | Before claiming C2 real-model support or publishing its image. Pinned-binary probe and separate paid evaluation using the production behaviour bundle. |
| Live-data source, instrument coverage, calendars, and paper policy | Research operator | Before C3 prospective collection. Feed entitlement, event/availability semantics, stale-data tests, and comparable virtual ledgers. |
| Deployment ownership, recovery, and protected access | Maintainer; operations owner | At each deployed checkpoint. Running identities, saved synthetic result, recovery evidence, and verified remote settings. |
| Broker/account, currency, permissions, capital/risk policy, network requirements, and emergency ownership | Steward; operations owner | Before C4 activation. Approved operating profile and the live-readiness evidence required by engineering §4. |
| Rights and private-data removal for a public result | Publisher; maintainer | Before any export. Authorisation, licence/provenance checks, redaction, and reproducibility evidence. |

An unresolved prerequisite blocks its affected capability. It does not justify an invented default or a weaker acceptance gate. Hosting changes require a canonical decision if Fly cannot meet the selected broker and recovery contract.

## Production Skills

The [selection and integration plan](production-skills.md) identifies candidate development support. OpenQuant owns its product requirements and acceptance. Skill maturity or a specialist benchmark cannot establish completion of an OpenQuant checkpoint. Pactwright adoption is not a prerequisite in this roadmap.

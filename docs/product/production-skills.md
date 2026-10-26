# Production Skills selection and integration

Status: proposed development support. No family or Extension Pack is selected or verified for OpenQuant by this document.

OpenQuant owns this plan, its requirements, and its integration evidence. The Production Skills [composition contract](https://github.com/sb-dev/production-skills/blob/ae4c0f1bd63107f9dc33e192bbf2a02a9cab75cf/docs/specs/04-cross-domain-orchestration-and-integration.md) keeps consuming-project state outside the central family repository. Production Skills remain independent of Pactwright.

## Candidate selection

The registry statuses below were reviewed on 26 October 2026 at Production Skills revision `ae4c0f1bd63107f9dc33e192bbf2a02a9cab75cf`. They are registry declarations, not independent proof of capability. Recheck the owning family and its installation/evaluation evidence before selection.

| Candidate and recorded status | Proposed OpenQuant contribution | Evidence required for adoption |
| --- | --- | --- |
| [Software Engineering — proposed](https://github.com/sb-dev/production-skills/blob/ae4c0f1bd63107f9dc33e192bbf2a02a9cab75cf/registry/projects/software-engineering-skills.json) | C1–C4 contracts, shared-core implementation, deployment isolation, and recovery. | A bounded implementation task that preserves the owning specification and passes the relevant OpenQuant tests. |
| [Deep Research — proposed](https://github.com/sb-dev/production-skills/blob/ae4c0f1bd63107f9dc33e192bbf2a02a9cab75cf/registry/projects/deep-research-skills.json) | Source verification and evidence synthesis for data, methods, and integration choices. | Traceable sources, uncertainty, access limits, and a usable handoff. Research does not certify strategy performance or release restricted holdout data. |
| [UI/UX — scaffolded](https://github.com/sb-dev/production-skills/blob/ae4c0f1bd63107f9dc33e192bbf2a02a9cab75cf/registry/projects/ui-ux-design-skills.json) | Ink focus, navigation, accessibility, confirmations, and stale/unknown states. | Interaction evidence against [the terminal UX specification](../specs/04-ink-ux-ui-spec.md) and A15; visual polish alone is insufficient. |
| [QA/Evaluation — proposed](https://github.com/sb-dev/production-skills/blob/ae4c0f1bd63107f9dc33e192bbf2a02a9cab75cf/registry/projects/qa-evaluation-skills.json) | Independent fixtures, failure scenarios, and regression coverage. | Relevant domain coverage and reproducible failures. Financial correctness remains owned by OpenQuant's domain specification and tests. |
| [Legal — researching](https://github.com/sb-dev/production-skills/blob/ae4c0f1bd63107f9dc33e192bbf2a02a9cab75cf/registry/projects/legal-skills.json) | Data licences, executor redistribution, public claims, and escalation of unresolved constraints. | Source-backed, jurisdiction-specific findings when needed. No registry status establishes permission to use data, distribute software, or operate live trading. |

These candidates do not block ordinary implementation while their families mature. Use the [roadmap](roadmap.md) and existing specifications to deliver the work. Do not invent an available quantitative-finance family or select unrelated families without an actual requirement.

## Development and deployed agents

[AGENTS.md](../../AGENTS.md) governs agents that work on this repository. Development skill selection can support that work within the same specification and review boundaries.

Deployed proposers and critics follow a different contract: [model execution §3](../specs/03-model-backed-execution-spec.md#3-delegated-execution-contract). They receive an explicit reviewed behaviour bundle owned by `packages/agents`, bounded evidence, and restricted permissions. Arbitrary repository instructions, user configuration, hooks, plugins, and self-installed skills must not enter that runtime. Agents return proposals; guarded application commands own accepted writes.

Any future reuse of skill guidance inside the deployed bundle needs an explicit reviewed change, recorded provenance, behaviour/schema compatibility, and the relevant offline and real-executor evaluations. Installing a development skill does not authorise this reuse or grant access to trading credentials.

## Adoption record and evaluation

For each actual selection, record the requirement, family revision, selected skills or packs, constraints, handoff owner, trial commands, observed results, and remaining limits in an OpenQuant research log. Verify clean installation and relevant behaviour before claiming integration.

Keep three evidence layers separate:

- The family benchmark measures specialist production quality.
- An orchestrator evaluation measures responsibility and handoff fulfilment, if an orchestrator is used.
- OpenQuant acceptance measures the assembled product, including financial and operational behaviour.

The [family evaluation contract](https://github.com/sb-dev/production-skills/blob/ae4c0f1bd63107f9dc33e192bbf2a02a9cab75cf/docs/specs/03-production-skills-evaluation-and-extension-packs.md) does not replace A01–A18 or R01–R10. Keep correctness, research quality, and operational readiness visible. Do not collapse them into a single score.

Use project instructions before proposing a new Extension Pack. A pack needs reusable specialisation and evidence that it changes behaviour usefully. If selected, record its exact revision and compare it with the core skill under comparable inputs and execution conditions. Preserve adverse and inconclusive results.

Pactwright is optional. If adopted later, its selected Agent Pack composes the Production Skills. Record that integration separately; it must not replace OpenQuant's runtime orchestration or weaken acceptance authority.

# Common contract for book-derived research skills

Date: 2026-11-10. Reviewed `main` at [`54f9912b29dbfb5af410aa42ad7b87f8eb343bd6`](https://github.com/sb-dev/openquant/commit/54f9912b29dbfb5af410aa42ad7b87f8eb343bd6), after PR #4 merged.

Status: proposed. This log recommends an authoring contract. It does not change canonical requirements, install skills, or establish runtime readiness.

## Recommendation

Use complete executable skill modules with shared host adapters. Each skill owns registration, typed input/output schemas, executable task logic, supporting instructions, scripts and evaluations. The host supplies approved clients, permissions, budgets, cancellation and result acceptance. A prompt or method manifest alone is not the skill.

Organise skills around formulation, experiment design, critique and sizing. Several books can support one task. Keep checked method notes and provenance as supporting assets. Share a method record when several skills use it; do not require a separate manifest framework for every skill. Do not combine every book's preferred rules into a universal trading policy.

The summaries are sufficient to start source-labelled drafts and design tests. They are not sufficient to release verified book-derived methods. OQ-03 §3 requires checking extracted equations against the PDF before adoption. Source fidelity, engine support and agent behaviour need separate evidence.

## Evidence and existing boundaries

This review used the current specifications, package guides, the [earlier research log](2026-11-07-strategy-research-and-evaluation.md), all ten user-supplied Google Docs summaries, and the user's full executable skill layout. That layout includes `index.ts`, `schema.ts`, `utils.ts`, `scripts/manual-test.ts` and per-skill evaluations. The summaries were last modified on 2026-11-09. Their extracted-text identities appear below. Original books and PDFs were not inspected.

- **Verified repository facts:** the specifications define the boundaries below. The package guides still mark the runtime implementation as planned.
- **Reported source material:** the summaries describe book methods and recommend skill behaviour. Their equations, defaults and book attributions remain unverified against primary pages.
- **Design inference:** the proposed contract and tests below address omissions and conflicts found in those summaries. They are recommendations, not implemented checks.

| Owner | Constraint on the contract |
| --- | --- |
| [OQ-02 §§2–3, 5 and 7](../specs/02-trading-domain-and-evaluation-spec.md) | One immutable Strategy Contract/Definition; reviewed typed operators; frozen evaluation conditions; strategy sizing separate from cross-strategy allocation and account authority. |
| [OQ-03 §§1–4 and 6](../specs/03-model-backed-execution-spec.md) | Existing proposer/critic roles; explicit reviewed behaviour bundle; bounded requests; structured results; source checks and fresh evaluation cases. |
| [OQ-05 §§2 and 7](../specs/05-system-architecture-and-data-spec.md) | Agent schemas belong to `packages/agents`. Strategy, evaluation and checkpoint schemas belong to `packages/api-contracts`. The shared Rust core owns numerical calculations. Reference these owners; do not copy their schemas. |
| [OQ-06 §§5 and 8](../specs/06-engineering-delivery-and-operations-spec.md) | S0 uses shared definitions, schemas and the Rust evaluator. S1 adds connected envelopes and TypeScript validation without replacing that path. Offline fixtures and real-model evidence remain distinct. |
| [OQ-07 §§7 and 10](../specs/07-open-source-project-organisation-spec.md) | Research logs propose decisions. Public procedures retain attribution without publishing licensed PDFs, private source documents or lengthy extracts. |

No new agent role, shared package, service, database, plugin loader or numerical engine is needed. Installing a development skill does not activate a product skill.

The specs establish ownership and authority. They do not yet define the executable skill registration interface, Zod schema/export policy, script lifecycle, dependency injection or per-skill evaluation discovery. These are contract gaps to resolve before implementation, not reasons to reduce a skill to prose.

## What the ten summaries contribute

Book names use the [existing reading list](2026-11-07-strategy-research-and-evaluation.md#reading-list-and-skill-priorities). Summary headings identify the inspected passages; they are not verified book-page citations. All ten references remain in scope.

| Source and summary passage | Useful method | Required contract detail or unresolved issue |
| --- | --- | --- |
| Chan, *Algorithmic Trading* — “Execution & Pitfall Checklist”; risk section | Economic hypotheses, causal signals, mean-reversion and momentum variants. | Separate hypothesis, statistical test and executable rule. Shorting, cointegration and intraday methods need capabilities outside the initial daily subset. The summary contains a damaged formula span and an unsupported drawdown guarantee. |
| Pardo, *The Evaluation and Optimization of Trading Strategies*, 2nd edition — “Core Heuristics & Validation Rules” | Bounded searches, parameter stability and walk-forward tests. | Fix split construction, retraining, objective and metric denominator rules. The suggested 50–60% walk-forward-efficiency threshold cannot become a global gate. |
| Kaufman, *Trading Systems and Methods*, 6th edition — “Core Mathematical Primitives”; “Mandatory Linting Rules” | Indicator variants, method selection and sensitivity checks. | Bind smoothing, initialization, units and operator versions. The summary's EMA-based ATR differs from the seed's simple-mean ATR. Indicator names alone are insufficient. |
| Murphy, *Technical Analysis of the Financial Markets* — trendlines, patterns and risk rules | Trend, chart-pattern and volume hypotheses. | Define pivot detection, confirmation time, scale and thresholds. Terms such as decisive breaks and chart angles do not define causal operators. Source risk ratios are not universal constraints. |
| Penman, *Financial Statement Analysis and Security Valuation*, 5th edition — §§2–5 | Statement reformulation, accounting checks, profitability and valuation. | Preserve filing identity and classification assumptions. Resolve average versus beginning balances and growth-rate versus growth-factor notation. Applicability differs for financial and non-financial firms. |
| Gray/Vogel, *Quantitative Momentum* — “Exact Mathematical Specifications” | Cross-sectional ranking, path quality and scheduled rebalancing. | Choose exact windows, endpoints, return basis, percentile rounding, ties and zero-return treatment. The summary allows different past-return windows for its path-quality score. |
| Aronson, *Evidence-Based Technical Analysis* — statistical primitives and testing pipeline | Falsifiable hypotheses, null models and search-adjusted tests. | Specify the tested family, benchmark, dependence assumptions and resampling algorithm. The stationary-bootstrap description omits block construction. Diagnostic returns must not replace ledger returns. |
| Carver, *Systematic Trading* — “Mathematical Pipeline”; cost guardrails | Forecast normalization, volatility sizing and cost controls. | Declare each stage's units, calibration window and capital scope. Avoid normalizing an already normalized signal twice. Constants and exclusion thresholds remain method-specific proposals. |
| Harris, *Trading and Exchanges* — spread measures and implementation shortfall | Execution realism, liquidity and transaction-cost analysis. | Specify trade side, benchmark time, measurement horizon and quote/trade requirements. The summary's buy-side shortfall expression does not define sell-side treatment. Daily bars do not establish queue-level fills. |
| López de Prado, *Advances in Financial Machine Learning* — pipeline and “Hard Guardrails” | Label horizons, overlapping observations and leakage controls. | Declare training/label windows, preprocessing fit scope and purge/embargo rules. Activity bars, learned models and portfolio methods are conditional extensions, not M1 defaults. |

### Conflicts that need explicit decisions

1. **Same name, different mathematics.** Kaufman's summary writes ATR as an EMA of true range. OQ-02 §2.6 specifies a 14-bar simple mean. Preserve the canonical seed. A different smoothing method needs a different reviewed operator identity and an explicit strategy revision; never substitute it silently.
2. **Incomplete valuation notation.** Penman's summary uses average NOA in profitability analysis and beginning NOA in forecasting. It also describes growth as 3–4% but later uses `g = 1.0` for no growth and `g = 1.04` for growth. These may describe different applications. Resolve their denominator and rate/factor conventions against the relevant pages rather than silently repairing the summary.
3. **Different data basis.** Gray/Vogel's summary uses dividend-inclusive momentum and mixes monthly windows with a 252/21-session approximation. The seed uses causal split-adjusted signal prices and separate dividend accounting. Each method needs its own reviewed semantics. A shared skill must not change the seed's data basis or choose between the summary's alternatives without recording that choice.
4. **Examples are not platform gates.** Murphy's suggested minimum 3:1 reward-to-risk ratio would reject the seed's nominal `5 * ATR` target / `2 * ATR` stop ratio of 2.5. Pardo's efficiency threshold and Carver's sizing constants likewise require method-specific review. The registered policy, not a book summary, owns acceptance thresholds.
5. **Analysis is not execution authority.** Harris's future midpoint can support an after-trade diagnostic, not the earlier signal. Carver's sizing work cannot spend account-wide capital. Advanced ML guidance cannot replace daily bars or execute generated Python. Chan's claimed drawdown guarantee cannot override OQ-02 §6.4: loss limits do not guarantee a maximum loss.

These are observations about the summaries. They do not establish errors in the original books.

## Two contract options

| Option | Benefits | Costs and limits |
| --- | --- | --- |
| **1. Self-contained executable skill modules** | Each skill owns its registration, task logic, dependency wiring, scripts and test harness. Easy to develop and run separately. | Repeats validation, cancellation, logging and capability handling. Each module needs more integration review to prevent differences in those controls. |
| **2. Executable skill modules with shared host adapters — recommended** | Each skill retains its executable task logic and complete supporting files. The host supplies common execution controls and approved client interfaces. The same entry point serves production, the playground and tests. | Requires a small shared interface and a verified executor/tool bridge. Avoid growing this into a general plugin framework. |

Both options use the existing provider, API and Rust owners. Neither permits a second official financial implementation or direct broker authority. Option 2 reduces repeated platform code while preserving the user's full skill definition. Start with a static registry and the necessary shared types; extract further helpers only when actual callers need them.

## Proposed common contract

The skill is the full module. Its registration, runtime contract, instructions, source assets and tests must describe the same behaviour.

### 1. Package structure

Use `packages/agents/src/skills/<skill-name>/` within the existing package owner. This is a proposed layout, not a new npm package per skill.

| File | Responsibility |
| --- | --- |
| `index.ts` | Export stable registration metadata, tool-schema exports and the executable handler or factory. Importing the module performs no network, model or persistence work. |
| `schema.ts` | Export Zod structural input/output validators and inferred types. Reuse shared contracts under the schema policy below. Validate both sides of the exported boundary. |
| `utils.ts` | Implement task-specific business logic, bounded context assembly, evidence checks, exact rule diffs and formatting. Receive approved API/service clients through dependency injection. |
| `scripts/manual-test.ts` | Execute the same registered entry point with a named fixture. Default to offline clients. External calls require explicit opt-in and bounded budgets. This is a playground, not a second implementation. |
| `scripts/` | Contain any other reviewed, skill-specific executable helpers. Classify each as development-only or an explicitly registered runtime operation. A directory name grants no execution permission. |
| `evals/fixtures/dataset.json` | Hold versioned synthetic or permitted cases, expected assertions and source identity. Reference shared numerical fixtures instead of copying their goldens. |
| `evals/<skill-name>.eval.ts` | Exercise the actual exports with deterministic assertions and separately selected model evaluations. Record tested skill/bundle identity. |
| `SKILL.md` or equivalent procedure asset | Explain the task, permitted role, method selection, bounded workflow and limitations. Include it explicitly in the reviewed bundle. |
| `references/` | Keep original method notes, provenance, checked equations, adaptations and worked examples. Reference shared method records where reuse warrants them. |

The planned package-level runner under `packages/agents/evals/` can discover explicitly configured per-skill suites and hold cross-skill cases. It must not maintain a second copy. Canonical schema outputs remain under `packages/agents/schemas`. OQ-05/OQ-06 need to make this source/generated-file and evaluation-layout mapping explicit.

### 2. Registration and execution

Use one reviewed static registry. A model supplies task arguments, never a module path, replacement client or executable name. Mount selected tools through `apps/agent-runner` and the existing `AgentExecutor` contract. The pinned delegated CLI's tool bridge still needs implementation and a deployment probe; this proposal does not assume that it already works.

Distinguish two entries in `index.ts`: a host-only role-task entry, such as `runTask`, and explicitly agent-callable bounded tools. The pilot's role-task entry assembles context, runs the recorded proposer or critic attempt, and validates its result. Helpers such as `validate_strategy_proposal` can run inside that attempt. Never expose the role-task entry as its own recursive tool. The manual and evaluation harnesses call the same appropriate entry.

Conceptual callable boundary, not implemented API:

```ts
type ExecuteSkill = (
  input: SkillInput,
  context: SkillContext,
  dependencies: SkillDependencies,
  signal: AbortSignal,
) => Promise<SkillResult>;
```

| Part | Minimum contract |
| --- | --- |
| Registration | Skill ID/version, description, supported task and roles, host-task versus agent-tool entry kind, input/output schemas, required capabilities, declared resource limits, source/method references and executable entry point. |
| Model-supplied input | Task arguments and authorised references, such as a frozen candidate, requested rule changes or evidence query. These cannot enlarge the host's scope or limits. |
| Trusted context | Mission/run/attempt and skill-call identities, role, bundle/skill versions, scope, cutoff, frozen policy, deadline and reserved allowances. The host constructs this context; it is not accepted from model input. |
| Injected dependencies | Narrow approved evidence, API and numerical clients. Tests inject controlled clients. Production injects the existing authorised adapters, not arbitrary HTTP or provider credentials. |
| Cancellation | An in-process cancellation signal plus a wire deadline. Propagate cancellation to dependencies and stop new work. The signal object is not a JSON field. |
| Result | Schema-valid task output, source/method and evidence references, coverage, assumptions, warnings and limitations. Host records bind it to the call and capture observed usage/duration, retaining unknowns. |
| Failure | Distinguish invalid input/output, denied capability, authentication failure, unavailable dependency, timeout and cancellation. Map them to existing attempt/error contracts; a classification does not authorise its own retry. |

The handler performs real task logic. A deterministic tool can retrieve bounded evidence, validate a proposed change or assemble an experiment request. It cannot infer a strategy merely because source notes are present. Model-led formulation and criticism use the existing proposer/critic `AgentExecutor` path. Do not hide unrecorded nested model calls in `utils.ts`.

Validate task inputs and permissions before external work. Validate outputs, identities and size before accepting them. Use the existing guarded API for accepted mutations. A tool result is not automatically an official result or registered trial. Potentially billed calls and retries retain their call/attempt identity and consume the existing budgets. Cancellation does not prove a remote request stopped or cost nothing.

For example, a web-evidence skill can validate a query, call an injected evidence client, inspect coverage and return formatted source records. Tavily integration and secrets stay at the OQ-05 §7.1 owner. A sizing skill can build a proposed revision and request reviewed calculations; `utils.ts` does not become a second RSI, ATR, ledger or backtest engine.

Runtime helper scripts require an explicit registry entry, fixed reviewed code, validated arguments, bounded I/O, a controlled environment and host termination checks. Never pass model text to a shell or allow arbitrary script paths. `manual-test.ts` is development-only. Its existence does not expose it to production agents.

### 3. Schema and source contracts

Use Zod for skill-local structural I/O. Generate the corresponding versioned tool JSON schemas under `packages/agents/schemas`; do not hand-maintain both representations. Existing language-neutral strategy/evaluation schemas remain authoritative in `packages/api-contracts/schemas`. Compose their generated bindings or references instead of redefining financial fields in a skill.

Validate shared subdocuments at their owning boundary. Add common valid/invalid fixtures for the Zod, exported tool and shared wire representations. Preserve decimal strings, explicit versions and the unknown-mandatory-field policy. Do not use coercion, defaults or silent field stripping to change financial meaning. Structural validity does not prove causal, numerical or policy correctness.

The critique schema validates a bounded draft container and its content hash. It does not require that draft to pass the executable Strategy Definition schema first. Checking the draft's defects is part of the audit.

[Zod's JSON Schema documentation](https://zod.dev/json-schema) distinguishes input and output conversion and identifies constructs that cannot be exported faithfully. The implementation must select the correct direction and reject unsupported export constructs rather than widening them to an unconstrained schema. Pin and test the chosen toolchain; this PR installs none.

Method metadata supports this executable contract. Record source author/title/edition, content identity, chapter/page or explicit unknown, source-check status, formula/procedure, applicability, assumptions, parameter units/bounds/origin, adaptations, worked checks and known limits. A shared method manifest is useful for reuse but cannot replace the handler, schema, script or test suite.

Use conditional details only where the method needs them:

| Method type | Additional semantics |
| --- | --- |
| Technical signal or pattern | Smoothing, initialization, lookback endpoints, confirmation delay, price basis and earliest usable time. |
| Fundamental analysis | Filing accession/version, acceptance and availability times, reporting period, taxonomy/tag, units, classifications and accounting reconciliations. Assumptions never replace missing facts without an explicit scenario. |
| Statistical evaluation | Objective/null/benchmark, split construction, tested family, return convention, resampling dependence, metric edge cases and policy reference. |
| Learned model | Training/label intervals, preprocessing and feature-selection fit scope, purge/embargo rules, frozen model identity and calibration evidence. |
| Sizing or execution analysis | Forecast/volatility units, capital scope, costs, lot rules, trade side, benchmark time and measurement horizon. |

Preserve three separate checks: **source fidelity**, **available capabilities**, and **behaviour evidence**. Primary-source verification does not make an operator available. An available operator does not verify a book attribution. Neither demonstrates profitability.

### 4. Role requests and results

Reuse OQ-03 §4. Bind the selected skill and allowed method revisions through the bundle identity. The request supplies the mission scope, allowed operators and bounds, frozen policy, authorised evidence/cutoffs, holdout exclusions and applicable parent/candidate hashes.

Keep run/attempt/session identity, executor/profile, permissions, timeout, output limits and budget reservations in the existing envelope. The host derives each skill's trusted context from it. Record requested methods and the methods actually used. The latter must be a subset of the reviewed selection, not newly discovered files.

Before dispatch, the host validates source-adoption evidence, schema compatibility and the intersection of task requirements with mission permissions and available capabilities. Missing inputs required to perform that task block it with a reason. Optional failures remain visible. Never fabricate data, silently substitute an operator, expand scope or choose a new provider.

A critic can inspect a candidate with unsupported operators, missing evidence or unresolved rules as bounded untrusted draft data. Those defects block executable registration, not the critique that reports them. Validate the critic's own input contract without requiring the candidate to be evaluable first.

Use task-specific payloads within the existing proposer/critic result envelope, not one oversized report schema.

| Task | Permitted result |
| --- | --- |
| Formulation | Complete proposed Strategy Contract/Definition; source and method references; hypothesis, assumptions, invalidation conditions and tests. A revision includes parent hash and exact rule changes. |
| Experiment design | Bounded experiment request referencing a frozen Strategy Version and policy. A proposed change to measurement conditions creates a separate registered comparison. |
| Critique | Findings against the frozen candidate hash, evidence references and proposed tests. The critic cannot rewrite the candidate or close its own findings through an approval field. |
| Sizing | A controlled strategy revision within its assigned budget, or a critique of sizing assumptions. It does not calculate an authoritative account allocation, grant capital or submit orders. |

The host/API validates identities, references, scope, bounds and lineage before guarded writes. Unresolved executable semantics prevent registration as an evaluable Strategy Version. Preserve interpretation notes as draft material or findings; never fill missing rules merely to obtain schema-valid output.

A valid adverse finding is not a tool failure. Keep execution outcomes, OQ-02 §3.6 gate results and approval decisions separate. Do not add run-status enums for every method limitation. Official numerical results still come from the Rust engine.

## Verification and adoption

The following checks are proposed, not executed by this research.

| Layer | Required evidence |
| --- | --- |
| Source review | Check selected primary pages, equations, notation, assumptions and attribution. Resolve damaged extraction and document every adaptation. Summary-only drafts do not enter a released book-derived runtime bundle. |
| Structural checks | Exercise `schema.ts` and exported tool schemas with shared valid/invalid payloads. Check versions, references, required fields, exact amounts, unknown fields and input/output parity. A valid structure cannot clear unresolved semantics. |
| Task-logic tests | Exercise `utils.ts` and `index.ts` with fixed time and injected clients. Check applicability, bounds, policy preservation, evidence handling and exact rule diffs. Invalid task inputs must fail before external calls. |
| Host/tool integration | Invoke the actual registered handler. Check tool exposure, denied capabilities, identity mismatch, malformed dependency responses, timeout, cancellation, output limits, budget accounting and redaction. Mock external boundaries, not the skill under test. |
| Numerical delegation | Verify requests and returned identities/units against shared protocol fixtures. Use actual Rust execution and independent expected calculations to establish mathematics. A mocked numerical response proves transport only. Never generate goldens from the implementation during tests. |
| Script parity | Run `scripts/manual-test.ts` in fixture mode as a smoke test. Use the same schemas, handler and client interfaces, with fixture implementations through the production injection path. Return a meaningful exit status. Test any runtime helper's argument, environment and termination bounds. |
| Offline agent checks | Test assembly, parsing, source-injection resistance, role restrictions and controlled responses. Keep task cases outside the examples used for tuning. Offline adapter success does not prove model behaviour. |
| Opt-in real-executor checks | Compare the baseline role bundle with a version that adds the method. Match missions, evidence, executor configuration and budgets. Exercise the production execution path and record each tested bundle identity. Record actual model identity, validity, known-flaw detection, false positives and relevant cost/latency measures. Use repeated trials and retain adverse, inconclusive and uncertain outcomes. |

Each `dataset.json` case records its ID, purpose, requirement/method reference, input, frozen context, dependency responses, expected outcome, permitted calls and expected warnings or failures. Exact numerical expectations reference independent shared fixtures. Statistical values state tolerances. Label authoring, tuning and fresh evaluation cases separately. Expected answers must not enter the evaluated agent's context.

Use Vitest for deterministic TypeScript checks and suite orchestration. Its [test discovery rules](https://vitest.dev/guide/learn/writing-tests#test-files) do not include `.eval.ts` by default; explicitly include those files and fail an unexpectedly empty suite. Keep offline tests and paid/external evaluations in separate configured selections. Run TypeScript type checks separately from test execution.

[DeepEval's TypeScript package](https://github.com/confident-ai/deepeval/blob/main/typescript/README.md) supports Vitest integration. It is an optional evaluation dependency, not a runtime requirement. Use a calibrated judge only for qualitative matters such as whether a critique explains a known flaw. Exact schema, permission, identity and financial checks remain deterministic. Pin the judge and rubric, bound its cost, and prevent automatic upload of private evidence. A judge score cannot replace numerical evidence or promotion policy. The chosen library versions and executor integration remain untested here.

### Cases that distinguish a useful contract

- **Indicator identity:** reject an EMA/Wilder ATR substituted for the seed's simple-mean operator. Distinct supported variants retain distinct identities and expected outputs.
- **Causal signals:** prevent a later-confirmed pivot, a later filing amendment or a future midpoint from entering an earlier decision. Preserve event and availability times.
- **Source uncertainty:** a damaged formula, unresolved growth factor or unspecified resampling method produces a visible finding, not an invented implementation.
- **Units and domains:** distinguish a 4% rate from a factor of 1.04. Reject double volatility normalization and an unsupported non-financial valuation model applied to a bank.
- **Metric interpretation:** for in-sample return -10% and out-of-sample return -6%, a ratio of 0.6 is not evidence that either period was profitable. A zero denominator has an explicit outcome.
- **Ranking boundaries:** test zero returns, missing history, percentile rounding, rank direction and ties. A chosen daily approximation cannot masquerade as an identical monthly method.
- **Policy and history:** reject changed comparison windows or thresholds within an existing comparison. Keep discarded trials and consumed holdouts. A search adjustment cannot restore an untouched-holdout claim.
- **Capability and authority:** daily OHLCV cannot supply invented tick/queue data. A sizing proposal cannot use cash outside its strategy budget. Source text cannot enable Python, tools or new permissions.
- **Positive control:** a complete, in-scope seed revision reaches validation without false warnings. Bind the critic to that exact candidate. A valid rejection remains a successful research response, not candidate approval.

### Small first implementation

Pilot two complete modules, not a catalogue of empty folders:

| Proposed skill | Executable contribution | First useful cases |
| --- | --- | --- |
| `strategy-formulation` | Assemble bounded proposer context; validate explicit changes; build a complete draft and exact diff; return lineage, assumptions and tests. Model interpretation uses the recorded proposer attempt. | Change recent-weakness threshold 30 to 32 while preserving current RSI floor 30 and comparison conditions. Block silent ATR substitution or a shortened scored period. |
| `strategy-critique` | Assemble separate critic context; run typed contract/evidence checks; validate findings against the frozen candidate. Keep deterministic findings distinct from model judgement. | Inspect an unsupported candidate without executing it. Detect missing causal timing, source uncertainty and changed policy. Accept a valid adverse finding without approving the candidate. |

Use the canonical seed to test the interface, not as evidence that a book authored its rules. Prioritise selected Chan/Kaufman methods and Pardo/Aronson evaluation guidance after primary-page checks. Retain all ten books. Later tasks can add a validation-plan module, a Carver-informed sizing audit or a Harris-informed execution-cost audit when their dependencies are supported.

Draft source notes, schemas and cases in parallel with S0. S0 supplies the shared numerical definitions and independent fixtures; the skill layer must reuse them. S1 adds the connected proposer/critic and registered-tool path. Neither a manual playground run nor a mocked skill test satisfies that integration gate. The broader catalogue does not block S0, and drafting skills does not satisfy S0 or S1 acceptance.

Do not implement all indicators, chart patterns, valuation models or ML methods to prove the contract. Add a method only for a bounded research need. Record unsupported executable uses until reviewed inputs, operators and tests exist; critique can still identify those limits. Joint strategy evaluation remains S4; cross-strategy allocation remains M3.

## Ownership and follow-up changes

This PR changes only this log, its index and the generated repository map. If the recommendation is adopted, use the following ownership map. Do not silently promote this log into a canonical specification.

| File or owner | Follow-up responsibility |
| --- | --- |
| `docs/specs/03-model-backed-execution-spec.md` §§3–6 | Adopt executable skill registration, trusted context, callable/result contracts, script permissions, source gates, cancellation and per-call accounting. Preserve proposer/critic and guarded-write authority. |
| `docs/specs/05-system-architecture-and-data-spec.md` §§2 and 7 | Define the skill source layout, Zod-to-tool schema generation, shared-schema references and per-skill evaluation ownership. Keep provider and numerical owners unchanged. |
| `docs/specs/06-engineering-delivery-and-operations-spec.md` §§5 and 8 | Add executable-module, script-parity, schema-parity and bundle checks. Require the actual registered-tool/executor probe. Preserve S0/S1 and offline/real-executor distinctions. |
| `packages/agents` | Implement the static registry, minimal shared types, full skill modules, schemas, reviewed source notes, scripts, evaluations and release identity together. Do not create placeholder packages. |
| `apps/agent-runner` and the existing `AgentExecutor` adapter | Mount allowlisted tools, supply trusted context and narrow clients, enforce resource bounds and record each call. Verify the pinned CLI's real tool bridge. |
| `docs/product/production-skills.md`, `docs/guides/m1-watchlist-research.md`, `packages/agents/README.md` | Point authors to the adopted contract and record actual implementation limits. Do not imply that a development-skill install enables runtime use. |
| `packages/api-contracts`, `packages/quant-core`, `fixtures` | Reuse existing schema and numerical owners. Add code/fixtures only for an accepted method's actual dependency. A new financial semantic rule also updates OQ-02. |
| Package manifests/lockfile, `scripts/verify.ts`, `.github/workflows/ci.yml` | Add pinned dependencies, strict TypeScript/build checks and non-empty offline skill suites with the implementation. Keep external/model evaluations explicit, bounded and separate from ordinary CI. |

Release identity binds the compiled handler/utilities, registered runtime scripts, instructions, source notes, schema versions and dependency/build identities. Evaluation evidence also binds the test/fixture revision, manual harness and observed outcomes. Exclude development-only scripts and private fixtures from the production allowlist. Changes produce new immutable identities; earlier attempts retain theirs. A new bundle does not rewrite a Strategy Version, reuse incompatible evidence or activate trading. Engine/operator changes follow OQ-02 §7.

The main risks are duplicated platform logic, a second numerical implementation and an overgrown skill framework. Keep task logic executable and local to the skill, inject existing capabilities, and add shared abstractions only for demonstrated reuse. Source-check status still does not prove quality; retain separate numerical, behavioural and operating evidence.

## Summary source identities

These SHA-256 values identify the inspected summary text, not original book bytes. Each snapshot consists of Google Docs paragraph text in returned order, joined with two newline characters and one final newline, encoded as UTF-8. The private documents and snapshots remain outside Git. Reviewers need authorised source access to inspect them; a hash alone supplies no book content or verification.

| Summary, identified by author and reading-list title | Extracted-text SHA-256 |
| --- | --- |
| Chan — *Algorithmic Trading* | `ce69c36a7b072abebaeede0782493ba9280f6eec79a49a6dec5125e828cdaa4e` |
| Pardo — *The Evaluation and Optimization of Trading Strategies*, 2nd edition | `57c524e955e3e1e426a08ef8c3062b9c6a9927eb79d48f652d12275ec1625568` |
| Kaufman — *Trading Systems and Methods*, 6th edition | `a06bc2d736578f449f944d088f3941e407a0d9f64cf0b347796949141e4d4eb7` |
| Murphy — *Technical Analysis of the Financial Markets* | `80b9b3499271ea9ccc3001f4c4ab4a13c11e19aaf4244630f2fd31c9f91981d2` |
| Penman — *Financial Statement Analysis and Security Valuation*, 5th edition | `c99b70b993fe34679eba80f4e09c529860fa7e06df9fde703cc6a3c8a46a335d` |
| Gray/Vogel — *Quantitative Momentum* | `efca1916bcf4ed3173bb700148321777c7d6e654bb6bea586dd0fceb9f68367a` |
| Aronson — *Evidence-Based Technical Analysis* | `ae8b12b066d83b6ce34876e13f03d81f9a0086ed52fdb8ca80906c776dc6eca3` |
| Carver — *Systematic Trading* | `c82c1e0cac40b74040b35974f12692b335854ef99aa8a14f4f044ce1786e141b` |
| Harris — *Trading and Exchanges* | `aef608392364c1ece44323444ede7db3cd75c8beddb835f0c84181387d64958f` |
| López de Prado — *Advances in Financial Machine Learning* | `e317b36608d4c2c8d53ba43ca674fe3088e115507a8d966db4452bac284b44a3` |

## Verification limits

This is a specification, summary and tooling-documentation review. No original-book formula check, market backtest or real-model evaluation was run. No executable skill, schema generator, runtime bridge or numerical engine was implemented. Zod, Vitest and DeepEval were not installed or tested in this PR. The proposed cases are not pass results. Repository checks for this documentation change are reported in the PR; they cannot establish skill effectiveness or financial performance.

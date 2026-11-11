# Common contract for book-derived research skills

Date: 2026-11-10. Review corrections: 2026-11-11. Reviewed `main` at [`54f9912b29dbfb5af410aa42ad7b87f8eb343bd6`](https://github.com/sb-dev/openquant/commit/54f9912b29dbfb5af410aa42ad7b87f8eb343bd6), after PR #4 merged.

Status: proposed. This log recommends an authoring contract. It does not change canonical requirements, install skills, or establish runtime readiness.

## Recommendation

Use complete executable skill modules with shared host adapters. Each skill owns registration, typed input/output schemas, executable task logic, supporting instructions, scripts and evaluations. The host supplies approved clients, permissions, budgets, cancellation and result acceptance. A prompt or method manifest alone is not the skill.

Organise skills around formulation, experiment design, critique and sizing. Several books can support one task. Keep checked method notes and provenance as supporting assets. Share a method record when several skills use it; do not require a separate manifest framework for every skill. Do not combine every book's preferred rules into a universal trading policy.

The summaries are sufficient to draft source notes and test cases, with each rule labelled by origin. They are not sufficient to release verified book-derived methods. OQ-03 §3 requires checking extracted equations against the PDF before adoption. Source fidelity, engine support and agent behaviour need separate evidence.

## Evidence and existing boundaries

This review used the current specifications, package guides, the [earlier research log](2026-11-07-strategy-research-and-evaluation.md), all ten user-supplied Google Docs summaries, and the user's full executable skill layout. That layout includes `index.ts`, `schema.ts`, `utils.ts`, `scripts/manual-test.ts` and per-skill evaluations. The summaries were last modified on 2026-11-09. Their extracted-text identities appear below. Original books and PDFs were not inspected.

- **Verified repository facts:** the specifications define the boundaries below. The package guides still mark the runtime implementation as planned.
- **Reviewer-reported source characteristics:** the 2026-11-11 review describes assistant-style follow-up questions, empty widget headings and summariser-designed lint rules in the summaries. This revision did not independently re-fetch those documents; it does not assert verified authorship.
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

The reviewer additionally reports unspecified smoothing for a Wilder-labelled RSI, annualisation constants of 252 versus 256 days, and opposing stop guidance for momentum/trend methods. These source observations were not independently rechecked in this revision. They are extraction checks, not new trading requirements. OQ-02 §§2.2 and 2.6 independently confirm that the seed uses simple-mean RSI. Record smoothing, day-count and stop-policy assumptions explicitly before adopting a method.

Each extracted rule has one origin: `primary_checked` (exact primary page checked), `summary_claim_unverified` (summary claim only), or `summariser_recommendation` (design advice with no book attribution). An ambiguous origin remains unverified. Naming a book in a draft does not attribute the summariser's routing, lint rules or defaults to its author.

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
| `schema.ts` | Export strict Zod schemas for local tool arguments/results and references to authoritative role/wire schemas and validators. Apply the composition policy below; do not mirror financial fields. |
| `utils.ts` | Implement task-specific business logic, bounded context assembly, evidence checks, exact rule diffs and formatting. Receive approved API/service clients through dependency injection. |
| `scripts/manual-test.ts` | Execute the same registered entry point with a named fixture. Default to offline clients. External calls require explicit opt-in and bounded budgets. This is a playground, not a second implementation. |
| `scripts/` | Development-only helpers in v1. No runtime script entry type or arbitrary process execution. |
| `packages/agents/evals/<skill-name>/fixtures/dataset.json` | Hold versioned synthetic or permitted cases, expected assertions and source identity. Reference shared numerical fixtures instead of copying their goldens. |
| `packages/agents/evals/<skill-name>/<skill-name>.eval.ts` | Exercise the actual exports with deterministic assertions and separately selected model evaluations. Record tested skill/bundle identity. |
| `procedure.md` | Explain the task, permitted role, method selection, bounded workflow and limitations. Include it explicitly in the reviewed bundle. |
| `references/` | Keep original method notes, provenance, checked equations, adaptations and worked examples. Reference shared method records where reuse warrants them. |

Evaluation paths above are repository-relative; other rows are relative to the skill directory. Keep recorded model responses in `fixtures/agent-results` and reference them from cases. Keep suites under the existing OQ-06 §5 owner, not beside runtime assets.

The bundle is an exact allowlist of paths and content hashes, never a recursive directory copy. The host verifies the manifest and supplies selected `procedure.md` text and method notes explicitly in the request. Discovery remains disabled. Test that evaluation files, expected answers, development scripts and private snapshots cannot enter the bundle or delegated filesystem. Development `SKILL.md` files remain separate.

### 2. Registration and execution

Use one reviewed static registry. A model supplies task arguments, never a module path, replacement client or executable name. Mount selected tools through `apps/agent-runner` and the existing `AgentExecutor` contract. The pinned delegated CLI's tool bridge still needs implementation and a deployment probe; this proposal does not assume that it already works.

Role modules export pure `assembleRequest` and `parseResult` functions. Cloudflare ResearchWorkflow calls assembly after selecting the bundle and evidence. The guarded API calls parsing on the submitted result, then performs its own authority and acceptance checks. Neither function dispatches or waits for a model process. Fly's runner claims the existing attempt, returns promptly and executes the CLI; the Workflow polls durable status under OQ-03 §5 and OQ-05 §4.

`index.ts`, `schema.ts` and their transitive imports must build for Workers without Node-only code. Runner-specific clients and process control stay in `apps/agent-runner`. The following `ExecuteSkill` signature applies only to bounded agent-callable tools. Role assembly/parsing is never exposed as a recursive tool. Harnesses use the same exports.

Conceptual agent-tool boundary, not implemented API:

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
| Registration | Skill ID/version, description, supported task and roles, role assembly/parsing versus agent-tool entry kind, input/output schemas, required capabilities, declared resource limits, source/method references and executable entry point. |
| Model-supplied input | Task arguments and authorised references, such as a frozen candidate, requested rule changes or evidence query. These cannot enlarge the host's scope or limits. |
| Trusted context | Mission/run/attempt and skill-call identities, role, bundle/skill versions, scope, cutoff, frozen policy, deadline and reserved allowances. The host constructs this context; it is not accepted from model input. |
| Injected dependencies | Narrow attempt-scoped API/evidence clients supplied by the runner host. No numerical client in v1. Tests inject controlled clients; production does not import API-owned adapters or expose service credentials. |
| Cancellation | An in-process cancellation signal plus a wire deadline. Propagate cancellation to dependencies and stop new work. The signal object is not a JSON field. |
| Result | Schema-valid task output, source/method and evidence references, coverage, assumptions, warnings and limitations. Host records bind it to the call and capture observed usage/duration, retaining unknowns. |
| Tool-call outcome | Record success, invalid input/output, denied capability, authentication failure, unavailable dependency, timeout or cancellation against the skill-call identity. Return bounded diagnostics to the model. A tool failure does not automatically terminate the attempt. |

The handler performs real task logic. A deterministic tool can retrieve bounded evidence, check structural fields and exact rule differences or assemble an experiment request. It cannot infer a strategy merely because source notes are present. Model-led formulation and criticism use the existing proposer/critic `AgentExecutor` path. Do not hide unrecorded nested model calls in `utils.ts`.

Validate task inputs and permissions before external work. Validate outputs, identities and size before accepting them. Use the existing guarded API for accepted mutations. A tool result is not automatically an official result or registered trial. Potentially billed calls and retries retain their call/attempt identity and consume the existing budgets. Cancellation does not prove a remote request stopped or cost nothing.

Tool handlers run in the trusted runner host, not in the delegated CLI or a child it starts. A host-side bridge supplies bounded results to the CLI. Do not assume an MCP transport or current CLI support; the deployment probe must establish the pinned bridge and prove that model processes and their children cannot read host credentials.

SEC/Tavily adapters remain in `apps/api`. A later evidence tool uses a guarded attempt-scoped API route, with scope, cutoff, deadline, budget and per-call records enforced there. It cannot call an API-owned adapter in process from Fly. Add migrations only if the existing call records cannot express the required identity; `apps/api/migrations` remains the owner. The first pilot uses its frozen evidence pack and adds no live retrieval dependency.

V1 skill logic checks structure, reference membership and exact rule differences only. It cannot duplicate API scope/bounds/lineage/policy validation or Rust operator/type/unit/lookback validation. After submission, the API performs its checks; EvaluationWorkflow sends numerical work through the batch path. Later attempts receive validation/evaluation outcomes through their bounded context packs. No synchronous dry-run endpoint, Rust npm wrapper or second numerical/semantic validator is proposed.

Attempt outcomes remain exactly OQ-03 §4: completion, refusal, malformed result, denied capability, authentication failure, cancellation, or timeout. A recoverable tool failure can still lead to completion. Missing required evidence makes the result ineligible; an optional failure remains in coverage. A terminal denial/authentication failure/cancellation/timeout maps to that existing attempt outcome; malformed final output maps to malformed result. Do not invent an attempt status for unavailable dependencies or invalid tool arguments.

`scripts/` is development-only in v1. Defer runtime scripts until a concrete task requires them and the owning specs define their controls. Never pass model text to a shell.

### 3. Schema and source contracts

Keep JSON Schema as the authoritative source for role request/result wire envelopes in `packages/agents/schemas` and financial subdocuments in `packages/api-contracts/schemas`, following OQ-05 §7. Role result schemas reference the exact versioned Strategy Contract/Definition with `$ref`. Build tooling bundles those references into the complete schema supplied to the model. Missing references, unsupported constructs or model-schema incompatibility fail the build/probe; never replace them with `{}`. Generate TypeScript bindings from those sources and validate with the owner-provided runtime validators.

Use Zod only for skill-local tool I/O without embedded financial subdocuments in v1. Tools accept authorised references; they do not define a second Strategy Definition. `schema.ts` exports both those local validators and the authoritative role-schema/validator references. This avoids Zod-to-JSON-to-Zod round trips and experimental JSON-to-Zod conversion. A future tool needing embedded financial documents must first extend this composition policy.

Export local tool schemas with the correct input/output direction. Use `z.strictObject()` for input objects; reject unknown fields in both the exported schema and runtime parser. No coercion, defaults or silent stripping may change meaning. [Zod's documentation](https://zod.dev/json-schema) explains input/output conversion and unsupported constructs. The chosen pinned exporter still needs parity tests; this proposal does not claim a working generator.

Use common valid/invalid fixtures across the complete wire schema, runtime validation and tool schemas where applicable. Preserve decimal strings and explicit versions. Structural validity does not prove semantic correctness. Critic requests reference only registered Strategy Versions and their application-owned hashes; malformed drafts are rejected by deterministic validation before paid criticism.

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

Keep run/attempt/session identity, executor/profile, permissions, timeout, output limits and budget reservations in the existing envelope. The host derives each skill's trusted context from it. Record supplied methods and result-cited methods. Citations are model self-reports, not proof of internal use. Validate that every cited method belongs to the supplied reviewed set.

Before dispatch, the host validates source-adoption evidence, schema compatibility and the intersection of task requirements with mission permissions and available capabilities. Missing inputs required to perform that task block it with a reason. Optional failures remain visible. Never fabricate data, silently substitute an operator, expand scope or choose a new provider.

The pilot follows registration before criticism. Unsupported or schema-invalid drafts produce validation diagnostics for a later proposer attempt; they do not trigger paid critique or receive a fabricated Strategy Version hash. Offline parser rejection cases remain useful. Pre-registration model critique is deferred; it would need a draft owner/hash, dispatch/budget policy and explicit A01 interpretation in OQ-02/OQ-03/OQ-05.

Use separate identifier namespaces: `tool:<registry-id>@<version>` for permissions, `provider:<adapter-id>/<operation>@<version>` for provider capability declarations, and `operator:<operator-id>@<compatibility-version>` for engine availability. These are reference formats, not new copies of the owning registries. Freeze the required lists in the request; availability in one namespace grants no authority in another.

Use task-specific payloads within the existing proposer/critic result envelope, not one oversized report schema.

| Task | Permitted result |
| --- | --- |
| Formulation | Complete proposed Strategy Contract/Definition; source and method references; hypothesis, assumptions, invalidation conditions and tests. A revision includes parent hash and exact rule changes. |
| Experiment design | Bounded experiment request referencing a frozen Strategy Version and policy. A proposed change to measurement conditions creates a separate registered comparison. |
| Critique | Findings against the registered Strategy Version hash, evidence references and proposed tests. The critic cannot rewrite the candidate or close its own findings through an approval field. |
| Sizing | A controlled strategy revision within its assigned budget, or a critique of sizing assumptions. It does not calculate an authoritative account allocation, grant capital or submit orders. |

The host/API validates identities, references, scope, bounds and lineage before guarded writes. Unresolved executable semantics prevent registration as an evaluable Strategy Version. Preserve interpretation notes as draft material or findings; never fill missing rules merely to obtain schema-valid output.

Each critic finding carries a typed category, method reference, evidence/location and origin (`deterministic_check` or `model_judgement`). Proposed categories are `causal_leakage`, `policy_mismatch`, `source_uncertainty`, `missing_evidence` and `method_advice`. The registered policy maps categories and applicability conditions to blocking or advisory treatment. Method notes and model severity cannot set that mapping. Unknown categories fail result validation rather than becoming advisory by default.

This mapping requires adoption in OQ-02's finding/gate rules and OQ-03's result contract before pilot acceptance. Preserve A01's ability to block on unresolved applicable findings. Summary-only capital caps, parameter-count preferences and reward/risk thresholds are `method_advice` unless the registered policy explicitly adopts them. No runtime gate changes in this PR.

A valid adverse finding is not a tool failure. Keep execution outcomes, OQ-02 §3.6 gate results and approval decisions separate. Do not add run-status enums for every method limitation. Official numerical results still come from the Rust engine.

## Verification and adoption

The following checks are proposed, not executed by this research.

| Layer | Required evidence |
| --- | --- |
| Source review | Check selected primary pages, equations, notation, assumptions and attribution. Resolve damaged extraction and document every adaptation. Summary-only drafts do not enter a released book-derived runtime bundle. |
| Structural checks | Exercise `schema.ts` and exported tool schemas with shared valid/invalid payloads. Check versions, references, required fields, exact amounts, unknown fields and input/output parity. A valid structure cannot clear unresolved semantics. |
| Task-logic tests | Exercise `utils.ts` and `index.ts` with fixed time and injected clients. Check structural constraints, reference membership, policy-reference preservation, evidence handling and exact rule diffs. API/Rust tests own semantic bounds and policy decisions. Invalid task inputs must fail before external calls. |
| Host/tool integration | Invoke the actual registered handler. Check tool exposure, denied capabilities, identity mismatch, malformed dependency responses, timeout, cancellation, output limits, budget accounting and redaction. Mock external boundaries, not the skill under test. |
| Owner validation | Submit parsed proposals through the API checks and existing asynchronous evaluation path. Test rejection diagnostics in subsequent context packs. Shared Rust tests and independent fixtures establish mathematics; skill tests cannot replace them. |
| Script parity | Run `scripts/manual-test.ts` in fixture mode as a smoke test. Use the same schemas, handler and client interfaces, with fixture implementations through the production injection path. Return a meaningful exit status. No runtime scripts are included in v1. |
| Offline agent checks | Test assembly, parsing, source-injection resistance, role restrictions and controlled responses. Keep task cases outside the examples used for tuning. Offline adapter success does not prove model behaviour. |
| Opt-in real-executor checks | Compare the baseline role bundle with a version that adds the method. Match missions, evidence, executor configuration and budgets. Exercise the production execution path and record each tested bundle identity. Record actual model identity, validity, known-flaw detection, false positives and relevant cost/latency measures. Use repeated trials and retain adverse, inconclusive and uncertain outcomes. |

Each `dataset.json` case records its ID, purpose, requirement/method reference, input, frozen context, references to recorded dependency responses, expected outcome, permitted calls and expected warnings or failures. Exact numerical expectations reference independent shared fixtures. Statistical values state tolerances. Label authoring, tuning and fresh evaluation cases separately. Expected answers must not enter the evaluated agent's context. Mark a fresh case consumed once its result informs a prompt or method change. Public repository cases are regression evidence, not secret or contamination-free holdouts.

Use Vitest for deterministic TypeScript checks and suite orchestration. Its [test discovery rules](https://vitest.dev/guide/learn/writing-tests#test-files) do not include `.eval.ts` by default; explicitly include those files and fail an unexpectedly empty suite. Keep offline tests and paid/external evaluations in separate configured selections. Run TypeScript type checks separately from test execution.

Defer DeepEval and model judges from v1. Compare typed finding categories and referenced defects with labelled expected sets using deterministic assertions. Human review can assess explanation quality. If a judge becomes necessary, adopt it through `AgentExecutor` with its own reviewed bundle, identity and budget; do not introduce a second provider SDK/key path.

### Cases that distinguish a useful contract

- **Indicator identity:** reject Wilder-labelled RSI with unspecified smoothing or an EMA/Wilder ATR substituted for the seed's simple-mean operator. Distinct supported variants retain distinct identities and expected outputs.
- **Causal signals:** prevent a later-confirmed pivot, a later filing amendment or a future midpoint from entering an earlier decision. Preserve event and availability times.
- **Source uncertainty:** a damaged formula, unresolved growth factor or unspecified resampling method produces a visible finding, not an invented implementation.
- **Units and domains:** distinguish a 4% rate from a factor of 1.04. Reject double volatility normalization and an unsupported non-financial valuation model applied to a bank.
- **Metric interpretation:** for in-sample return -10% and out-of-sample return -6%, a ratio of 0.6 is not evidence that either period was profitable. A zero denominator has an explicit outcome.
- **Ranking boundaries:** test zero returns, missing history, percentile rounding, rank direction and ties. A chosen daily approximation cannot masquerade as an identical monthly method.
- **Policy and history:** reject changed comparison windows or thresholds within an existing comparison. Keep discarded trials and consumed holdouts. A search adjustment cannot restore an untouched-holdout claim.
- **Capability and authority:** daily OHLCV cannot supply invented tick/queue data. A sizing proposal cannot use cash outside its strategy budget. Source text cannot enable Python, tools or new permissions.
- **Positive control:** a complete, in-scope seed revision reaches owner validation with no unsupported blocking findings. Compare category/evidence pairs with the labelled expected set. Policy-permitted `method_advice` is not a false positive; an invented defect or advisory elevated to blocking is. Bind the critic to that exact candidate. A valid rejection remains a successful research response, not candidate approval.

### Small first implementation

Pilot two complete modules, not a catalogue of empty folders:

| Proposed skill | Executable contribution | First useful cases |
| --- | --- | --- |
| `strategy-formulation` | Assemble bounded proposer context; parse structural output; compute an exact diff; return lineage, assumptions and tests. Model interpretation uses the recorded proposer attempt. | Change recent-weakness threshold 30 to 32 while preserving current RSI floor 30 and comparison conditions. Exercise owner rejection of silent RSI/ATR substitution or a shortened scored period, then pass diagnostics to the next attempt. |
| `strategy-critique` | Assemble separate critic context; parse typed findings and check their references against the registered candidate. The API owns policy mapping and acceptance. Keep deterministic findings distinct from model judgement. | Critique a registered candidate with a labelled evidence or methodological flaw. Reject malformed/unregistered input before dispatch. Test policy handling of source uncertainty and method advice. Accept a valid adverse finding without approving the candidate. |

Use the canonical seed to test the interface, not as evidence that a book authored its rules. Prioritise selected Chan/Kaufman methods and Pardo/Aronson evaluation guidance after primary-page checks. Retain all ten books. Later tasks can add a validation-plan module, a Carver-informed sizing audit or a Harris-informed execution-cost audit when their dependencies are supported.

Before S0, author source notes, dataset case descriptions and non-financial I/O shapes only. Do not stub or copy financial schemas. S0 supplies shared schemas, definitions, Rust validation and independent fixtures. Executable pilot modules land with S1, together with pinned dependencies/lockfile, strict TypeScript checks, owner validators, runner and tool bridge, and real checks in `pnpm verify`. Earlier executable delivery requires an OQ-06 sequencing change first. Neither a manual playground run nor a mocked skill test satisfies that integration gate. The broader catalogue does not block S0, and drafting skills does not satisfy S0 or S1 acceptance.

Do not implement all indicators, chart patterns, valuation models or ML methods to prove the contract. Add a method only for a bounded research need. Record unsupported executable uses until reviewed inputs, operators and tests exist; validation diagnostics can identify those limits without a paid critic attempt. Joint strategy evaluation remains S4; cross-strategy allocation remains M3.

## Ownership and follow-up changes

This PR changes only this log, its index and the generated repository map. If the recommendation is adopted, use the following ownership map. Do not silently promote this log into a canonical specification.

| File or owner | Follow-up responsibility |
| --- | --- |
| `docs/specs/03-model-backed-execution-spec.md` §§3–6 | Adopt executable skill registration, trusted context, callable/result contracts, finding categories, source gates, cancellation and separate call/attempt outcomes. Preserve proposer/critic and guarded-write authority. |
| `docs/specs/05-system-architecture-and-data-spec.md` §§2 and 7 | Define Worker-safe exports, JSON-first role schemas, local Zod tool exports, bundled shared references and existing evaluation ownership. Keep provider and numerical owners unchanged. |
| `docs/specs/06-engineering-delivery-and-operations-spec.md` §§5 and 8 | Add executable-module, script-parity, schema-parity and bundle checks. Require the actual registered-tool/executor probe. Preserve S0/S1 and offline/real-executor distinctions. |
| `docs/specs/02-trading-domain-and-evaluation-spec.md` §§3 and 9 | Adopt policy-owned blocking/advisory classification and its A01 interpretation before pilot acceptance. Preserve A01–A18 wording. |
| `apps/api` | Own guarded result parsing/acceptance, policy mapping and future attempt-scoped evidence routes, call records and any required migrations. |
| `packages/agents` | Implement the static registry, minimal shared types, full skill modules, schemas, reviewed source notes, scripts, evaluations and release identity together. Do not create placeholder packages. |
| `apps/agent-runner` and the existing `AgentExecutor` adapter | Mount allowlisted tools, supply trusted context and narrow clients, enforce resource bounds and record each call. Verify the pinned CLI's real tool bridge. |
| `docs/product/production-skills.md`, `docs/guides/m1-watchlist-research.md`, `packages/agents/README.md` | Point authors to the adopted contract and record actual implementation limits. Do not imply that a development-skill install enables runtime use. |
| `packages/api-contracts`, `packages/quant-core`, `fixtures` | Reuse existing schema and numerical owners. Add code/fixtures only for an accepted method's actual dependency. A new financial semantic rule also updates OQ-02. |
| Package manifests/lockfile, `scripts/verify.ts`, `.github/workflows/ci.yml` | Add pinned dependencies, strict TypeScript/build checks and non-empty offline skill suites with the implementation. Keep external/model evaluations explicit, bounded and separate from ordinary CI. |

Release identity binds source file hashes, lockfile, pinned toolchain/build configuration, instructions, source notes and schema versions. The deployed artefact retains its own digest; do not claim a reproducible compiled-handler hash without a reproducible build. Evaluation evidence also binds the test/fixture revision, manual harness and observed outcomes. Exclude development-only scripts and private fixtures from the production allowlist. Changes produce new immutable identities; earlier attempts retain theirs. For an unchanged skill, deterministic evidence can be reused only when source, schemas, dependencies, toolchain and fixtures are identical and applicability is recorded. Changed host/bundle composition requires integration checks; model behaviour evidence binds the whole bundle and is not automatically transferable. A new bundle does not rewrite a Strategy Version or activate trading. Engine/operator changes follow OQ-02 §7.

The main risks are duplicated platform logic, a second numerical implementation and an overgrown skill framework. Keep task logic executable and local to the skill, inject existing capabilities, and add shared abstractions only for demonstrated reuse. Source-check status still does not prove quality; retain separate numerical, behavioural and operating evidence.

## Summary source identities

These are previously recorded SHA-256 identities for extracted summary text, not original book bytes. The earlier recipe described paragraph text joined with two newlines and a final newline. It did not record the exact API/export version, table/formula traversal, Drive revision IDs or a durable snapshot locator. Those details cannot be reconstructed from the hashes. This revision did not reproduce them; the table is historical provenance, not a reproducible source-verification claim.

Before primary-source adoption, capture a new authorised private snapshot and record the exact API call or export MIME type, response/extractor version, document revision if available, retrieval time, table/list/formula treatment, byte encoding and digest. Record an access-controlled snapshot locator outside Git. If revision access or retention is unavailable, state that limitation. Never invent old revision IDs or claim a current editable document reproduces these bytes.

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

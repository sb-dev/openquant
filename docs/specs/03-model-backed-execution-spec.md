---
id: OQ-03
title: OpenQuant — Model-Backed Execution
version: 1.0.0
status: canonical
updated: 2026-10-19
owns: proposer and critic behaviour, delegation, permissions, budgets, results
---

# OpenQuant — Model-Backed Execution

This document defines required behaviour. It does not claim that the behaviour is implemented.
See the [specification index](README.md) for ownership and the current bootstrap scope.

## 1. Roles and budgets

### Proposer

A proposer researches hypotheses, produces Strategy Definitions, requests bounded experiments, and proposes revisions. Several proposer configurations compete within a mission.

### Critic

A critic challenges the hypothesis, data, assumptions, tests, portfolio fit, and operational risks. It returns structured findings with evidence references and proposed tests.

Use the same agent runner for both roles, with different instructions and permissions. Record the actual provider, model identifier, prompt version, tool permissions, and generation settings for every attempt.

Separate role identities and access. The proposing agent cannot close its own critic findings or write official results. A different session of the same model provides process separation, not guaranteed independence of judgement.

### Software, not additional AI roles

The Rust engine produces official results. A deterministic policy evaluator decides whether gates are satisfied. Portfolio software calculates proposed weights and risk. The trading core checks every order.

An LLM may explain those outputs. Its explanation has no authority to replace them.

### Budgets and accumulated learning

Each mission has explicit candidate, experiment, compute, LLM-spend, and revision budgets. A runner cannot increase them. Exhaustion pauses further work and reports what was learned.

Subsequent proposals receive a bounded context pack: relevant past hypotheses, failed trials, critic findings, and observed outcomes. Retrieve this from existing records. Do not add a memory service or vector database without a demonstrated retrieval need.

Record unsuccessful model calls and revised outputs. A transport retry must not silently replace an earlier candidate with whichever model response looks best.

## 2. Competition and learning

The mechanism uses different roles and shared evaluation rules. It does not require agents to trade tokens, negotiate capital, or vote on their own evidence.

| Mechanism | Rule |
|---|---|
| Comparable competition | Predeclare the cohort, budgets, evaluation windows, and constraints. |
| Independent judgement | Proposers cannot write official scores or resolve their own findings. |
| Search accountability | Record all executed trials, including discarded variants and failed attempts. |
| Forecast calibration | Store a probability, a precise outcome, and a resolution date before observing the outcome. |
| Diversity | Group related strategies and cap their combined exposure. Renaming a strategy does not reset its lineage. |
| Exploration | Reserve a fixed research budget for new approaches. Do not take it from live capital automatically. |

For binary forecasts, use mean squared probability error: `mean((p - y)^2)`, where `y` is 0 or 1. Lower is better. Compare forecasts on the same type of resolved outcome. Show sample count and unresolved forecasts.

A critic is not rewarded merely because its veto prevented a strategy from being tested. Unobserved outcomes remain unresolved. Keep reasoning quality and forecast accuracy separate.

Reputation can inform later research budgets under a fixed policy. It never changes risk limits, promotion gates, or broker permissions. Do not claim that this mechanism makes honesty a dominant strategy; that has not been established.

## 3. Delegated execution contract

Use one delegated executor, fresh execution identity, explicit opt-in, and runtime-owned mutation.

The application selects a role, immutable behaviour bundle, and bounded evidence. `AgentExecutor` delegates the request to the selected tool. The application validates the structured result and applies any permitted state change through a guarded command.

The initial adapter delegates to a pinned Claude Code CLI. OpenQuant does not select providers through a custom model router. The operator selects a permitted execution profile; the delegated tool owns provider integration. Alternative tools can later implement the same interface without changing strategy or capital semantics.

The proposer and critic use the **same mechanism**, but separate sessions, task contexts, permissions, and result records. A critic cannot rewrite its candidate. Neither role can mark its own output as accepted evidence.

Required invocation identity includes the run and attempt IDs, fresh session ID, behaviour-bundle hash, executor version, requested profile, reported actual model where available, and permitted data references. Preserve unreported values as unknown rather than inventing them.

The host enforces timeout, process-tree termination, output-size bounds, and budget limits. Distinguish malformed output, permission denial, authentication failure, timeout, model refusal, and a valid adverse research result. Provider-reported cost is labelled as an estimate when appropriate.

Do not treat repeated LLM calls as idempotent: they can change output and incur new cost. Record retries, prevent overlapping attempts from exceeding the reserved budget, and accept only one authorised result per attempt contract.

Disable discovery of arbitrary local hooks, plugins, repository instructions, and user configuration. Supply the reviewed bundle explicitly. Exercise the exact pinned binary, structured output, configuration isolation, and permissions in the deployment probe.

Production research receives no writable project checkout. Source text, strategy descriptions, and market/news content remain untrusted data. No `eval`, arbitrary shell execution from model text, self-installed skills, or unrestricted network tools are granted to product agents.

`execution.enabled` is explicit and defaults off. Missing authentication or unsupported executor capability produces a blocked/failed run, not a recorded model success. Offline tests inject controlled responses. A separate opt-in test must exercise the real delegated runner before claiming real-model execution.

The third-party executor is an external dependency. Document its authentication, service terms, and distribution requirements before publishing an image containing it. An open-source OpenQuant licence does not automatically license that dependency.

## 4. Request and result boundaries

`packages/agents` owns role instructions, reviewed skills, output schemas, request assembly, parsing, evaluation cases, and release metadata. `apps/agent-runner` owns the isolated host process. The API alone performs canonical research writes after validation.

| Request field group | Required contents |
| --- | --- |
| Identity | Mission, logical run, attempt, role, fresh session, behaviour-bundle hash. |
| Execution | Pinned tool version, selected profile, timeout, output limit, permitted tools, cost reservation. |
| Inputs | Candidate hash where applicable, authorised evidence references, provenance, explicit holdout exclusions. |
| Outcome destination | Attempt-scoped result route; no unrestricted database capability. |

| Result field group | Required contents |
| --- | --- |
| Provenance | Attempt/session identity, actual executor version, actual model when reported, input and bundle hashes. |
| Role output | Validated proposal or critic findings with evidence references and suggested tests. |
| Execution outcome | Completion, refusal, malformed result, denied capability, authentication failure, cancellation, or timeout. |
| Usage | Observed cost and duration, with unknown or estimated fields labelled. |

These are contract requirements, not a frozen JSON schema. C2 supplies versioned schemas and shared valid/invalid fixtures. Unsupported mandatory fields or semantics fail validation.

A valid critic result can reject a candidate. Successful tool execution is not approval of its output. A critic recommendation is not an official numeric evaluation result.

The host strips service credentials from the child environment. It provides no writable project checkout, broker access, deployment token, or official-result writer. Retrieved content is data, never authority to change the role or tools.

## 5. Attempts, cancellation, and recovery

ResearchWorkflow creates the attempt and reserves its budget before dispatch. The runner claims that attempt through an authenticated endpoint before starting the external tool. An ambiguous dispatch is resolved under the same attempt ID before another process starts.

The host returns acceptance promptly. Cloudflare observes durable status through bounded polling. A fresh retry consumes a recorded attempt and its budget. Only the current claim can complete.

Cancellation terminates the child process tree and records the outcome. A timeout must not leave an unbounded subprocess. Store a bounded diagnostic record without credentials or full sensitive context.

## 6. Verification

Offline tests cover request construction, schema validation, malformed output, identity mismatch, denied tools, refusal, missing authentication, missing executable, cancellation, timeout, and late completion from an expired attempt.

Real-model tests are opt-in and run the same executor and behaviour bundle as production research. Use reviewed revisions, fixed missions, declared budgets, and recorded actual model versions. A replayed fixture cannot count as a real-model result.

Before adopting a tool version, exercise its actual binary, supported flags, permission controls, configuration isolation, session identity, structured output, and termination behaviour. The September Pactwright CLI observations are historical evidence, not a current invocation recipe.

Assess candidate validity, known-flaw detection, calibration, diversity, cost, and prospective contribution. Preserve uncertainty. Add a specialised profile only when matched-budget evidence justifies it; do not create another service by default.

## 7. Source migration

Adopts Design v2 §§6–7 and Repository Design v1.1 §8. The Pactwright execution reference supplies delegation and guarded writes. It does not grant product agents repository-write permissions or define current executor flags.

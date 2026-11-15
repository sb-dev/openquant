# Fly.io delegated execution host

Status: S1 part B. `@openquant/agent-runner` is a workspace package: the dispatch endpoint, the claim before any process starts, the pinned Claude Code executor with its isolation, and the posting of the host-captured attempt result. It is tested with a fake executor and fake or loopback APIs only. No model was called by its tests, and the real pinned binary has never been run by them. It is not deployed (the Fly app, the image and the executor probe arrive with P6), and the connected competition is not implemented.

Run the reviewed external CLI in isolated sessions. Return structured outcomes; never write canonical research results or obtain broker credentials.

Owner: [03-model-backed-execution-spec.md](../../docs/specs/03-model-backed-execution-spec.md) §§3–6 and [05-system-architecture-and-data-spec.md](../../docs/specs/05-system-architecture-and-data-spec.md) §§4–5. The role schemas, request assembly, result parsing, the dispatch checks and the behaviour bundle are in [`packages/agents`](../../packages/agents/README.md). The envelopes and the route are in [`packages/api-contracts`](../../packages/api-contracts/README.md): `agent-dispatch/1`, `agent-attempt-result/1`, `attempt-claim/1` and the route `runner.dispatch` of `routes/v1.json`.

## What happens to a dispatch

1. `POST /v1/agent-attempts` with the bearer secret of the workflows principal (`AGENT_RUNNER_DISPATCH_TOKEN`, compared in constant time). A body above the route's limit (4 MiB) is refused with `LIMIT_EXCEEDED` while it arrives, before anything parses it. The body is parsed with the shared strict parser as `agent-dispatch/1`; a rejection is an `api-error/1` body with the listing of the contract layer.
2. Before the claim, only what needs no state is refused: another environment (`IDENTITY_MISMATCH`), an attempt that this process already runs (`ATTEMPT_NOT_CLAIMABLE`) and a full runner (`RATE_LIMITED`, two attempts at once by default).
3. **The runner claims the attempt through the API (`attempt-claim/1`) and nothing has started before that.** A refused or unconfirmed claim is the answer of the dispatch (`STALE_OWNERSHIP`, `ATTEMPT_NOT_CLAIMABLE`, `IDENTITY_MISMATCH`, `EXECUTION_DISABLED`, or `UNAVAILABLE` with `state_changed: UNKNOWN` when the claim may exist), and no process, directory or call follows.
4. The answer is `202` with no body. The attempt then runs on its own: `execution.enabled`, the installed bundle against `bundle.manifest.json` and the dispatch, the pinned executor version and cost currency, the request artefact (bytes, digest, size, role schema), the dispatch checks of `@openquant/agents` (`checkDispatch`: role against skill, request against dispatch, holdout exclusions that name V and H, profile, output limit, no tool, result route), the executor, the shared validator on its output, the upload of the validated role output, and the result.
5. The result is checked with the shared validator, then posted to `/v1/attempts/{attempt}/agent-result` with the attempt capability. The runner never sends an envelope that the validator rejects.

The API credentials are two: the runner's service credential, used for the claim only, and the attempt-scoped capability that the grant returns, used for the input, the artefact and the result (OQ-05 §9). The runner holds no R2 or database credential (OQ-05 §5).

## Outcomes

| Event | Outcome of `agent-attempt-result/1` | Retried by recovery |
| --- | --- | --- |
| Valid role output | `completion`, with the stored role output by digest | no |
| The model declines (`stop_reason` `refusal`) | `refusal` | no |
| Executable missing; execution disabled; version, profile, currency or capability not supported; bundle or request mismatch | `denied_capability` (`EXECUTABLE_MISSING`, `EXECUTION_DISABLED`, `CAPABILITY_UNSUPPORTED`, `CAPABILITY_DENIED`, `BUNDLE_MISMATCH`) | no |
| The executor stopped at its cost reservation | `denied_capability` `CAPABILITY_DENIED` | no |
| Credential not set, or rejected (HTTP 401 or 403, or the text of the error) | `authentication_failure` (`CREDENTIAL_MISSING`, `CREDENTIAL_REJECTED`) | no |
| Not JSON, schema, reference or rule-change failure of the shared validator; output over the limit; a session or model in the executor's report that is not the attempt's; an executor that ended without a result | `malformed_result` | yes |
| The deadline of the dispatch | `timeout`, after the tree was killed | yes |
| `Runner.cancel(attempt)` | `cancellation`, after the tree was killed | no |
| The runner crashes, shuts down, loses its lease or cannot read or store what it needs | nothing is posted: the lease expires and recovery fences a new attempt | yes |
| A late completion | the API rejects it with `LEASE_EXPIRED` or `STALE_OWNERSHIP` and records it; the runner does not retry it | no |

A denial before the model starts costs nothing, and the runner knows it never started the call, so it reports an observed zero. A run that started and ended without a usage report reports unknown cost and token counts, which keeps the full reservation (OQ-03 §1). Cost from Claude Code is labelled `estimated`. Input tokens are fresh input, cache writes and cache reads together. The model, provider, effort and executor version are those the executor reports, or unknown; nothing is inferred from the requested profile.

## Isolation of the executor

For each attempt the runner makes a fresh directory with an empty `HOME`, an empty working directory and a private `TMPDIR`, and removes it afterwards. The child starts in its own process group and receives:

- an environment built from an allowlist, never inherited: `PATH` (a fixed value), `HOME`, `TMPDIR`, a few neutral variables, the executor's own switches (`CLAUDE_CONFIG_DIR` in the fresh home, no auto-update, no telemetry, no non-essential traffic), and the one model credential variable (`ANTHROPIC_API_KEY` by default). The configuration refuses any other name that is a credential of the host or of another system (`AGENT_RUNNER_*`, `CLOUDFLARE_*`, `FLY_*`, `ALPACA_*`, `DATABASE_*`, `GITHUB_*` and others). Proxy and certificate variables pass only with `AGENT_RUNNER_ALLOW_PROXY_ENV=true`, which the configuration refuses in `PRODUCTION`;
- the request on standard input (the exact bytes of the artefact the API stores) and, as the system prompt, the procedure of the role module followed by its result schema, both from the built-in behaviour bundle module (`instructionsFor`), so the bundle hash binds the text. The schema is in the prompt whether or not the `--json-schema` guard is on. No file of the bundle reaches the child, and the installed bundle directory is checked against the manifest before each attempt (hash of the manifest, hash of every listed file, no unlisted file);
- these arguments: `-p --output-format json --model <profile model> [--effort <level>] --tools "" --setting-sources "" --strict-mcp-config --disable-slash-commands --no-session-persistence --session-id <uuid> --permission-prompts none --max-budget-usd <reservation> --system-prompt=<procedure> [--bare]`. The session UUID is derived from the dispatch's session identifier (the CLI needs a UUID, the dispatch carries an identifier).

The host enforces the deadline of the dispatch, a hard limit on standard output (six times the output limit, for JSON escaping, plus 64 KiB; one more byte kills the tree), and the output limit on the text of the result. At the deadline, at an overflow, at an abort and at the end of every run (also a normal one) it kills the whole process group. A descendant that leaves the group (`setsid`) escapes this control; that is a recorded limit, and the executor probe of P6 checks process-tree termination on the deployed machine.

The diagnostics are bounded to 2,000 characters, printable, and free of the model credential, the runner's own credentials and the attempt capability. Logs are one JSON line per event and carry identifiers and codes only.

## Spike with the pinned binary (claude 2.1.325)

Recorded for OQ-03 §6 and the pilot decision record (D6). No credential was created or configured for it; the one call described in the warning below used the access of the development session itself.

| Item | Result |
| --- | --- |
| Version | `claude --version` prints `2.1.325 (Claude Code)`. The runner is pinned to this version and checks it per attempt. |
| Flags that exist in `claude --help` | `-p/--print`, `--output-format text\|json\|stream-json`, `--json-schema <schema>` (print mode), `--tools <tools...>` (`""` disables all), `--setting-sources <sources>`, `--session-id <uuid>`, `--no-session-persistence` (print mode), `--bare`, `--model`, `--effort`, `--strict-mcp-config`, `--disable-slash-commands`, `--permission-prompts host\|none`, `--max-budget-usd` (print mode), `--system-prompt`, `--append-system-prompt`, `--restricted`, `--settings`. |
| `--setting-sources ""` | The parser in the shipped binary returns an empty list for an empty string, so no setting source is loaded. Read from the binary's text; not run. |
| Result subtypes | The binary names `error_max_turns`, `error_during_execution`, `error_max_budget_usd` and `error_max_structured_output_retries` besides success. The runner maps them (see Outcomes). |
| Environment variables | The binary contains `CLAUDE_CONFIG_DIR`, `DISABLE_AUTOUPDATER`, `DISABLE_TELEMETRY`, `DISABLE_ERROR_REPORTING`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` and `CLAUDE_CODE_SIMPLE`. |
| **`--json-schema` enforcement** | **Could NOT be verified without credentials**, nor how it treats the recursive `Expr` schema of the proposer result. The runner therefore asks for text JSON and validates it itself with the shared validator: that is the default path. `--json-schema` is only an additional guard behind `AGENT_RUNNER_USE_JSON_SCHEMA=true`, which stays off until the P6 executor probe verifies enforcement. |
| `--bare`, `--permission-prompts none`, `--max-budget-usd` | Listed by `--help` and used by the runner; their effect with a real credential is for the executor probe. |
| Shape of a result | One observation of `--output-format json` (a plain prompt, no tools) gave an object with `type: "result"`, `subtype`, `is_error`, `result` (text), `stop_reason`, `api_error_status`, `session_id`, `total_cost_usd`, `usage` (`input_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`, `output_tokens`) and `modelUsage` (keyed by the model, with `outputTokens` and `provider`). The parser reads exactly these, treats every field as optional and keeps what is missing as unknown. The shape of an error result was not observed, so the authentication and refusal mapping reads the HTTP status and the text and is tested against fake output only. |
| Fresh HOME | A run writes `.claude.json` and a `.claude` directory into `HOME` even with `--no-session-persistence`, so the runner gives every attempt a new `HOME` and removes it. |

Warning for development: in the Claude Code on the web container that S1 is built in, the pinned binary reaches the model even with an empty environment and a fresh `HOME`, through the access of the session itself. An invocation of `claude -p` there is a real, billed model call. The tests of this package therefore never start the real binary: they run scripts that stand in for it (`test/support/fake-claude.mjs`). Besides `--version` and `--help`, the real binary was started once, by mistake, while the spike was prepared: one call with the single word `ok` as prompt, which cost about 0.008 USD by its own estimate. The shape of a result above comes from that call, and no further call was made.

## Configuration

Read once from the environment of the process (`AGENT_RUNNER_*`). Execution is off unless `AGENT_RUNNER_ENABLED=true`; a disabled runner still claims every dispatch and records `denied_capability` `EXECUTION_DISABLED`, so a refusal is a recorded outcome.

| Variable | Meaning |
| --- | --- |
| `AGENT_RUNNER_ENVIRONMENT` | `DEVELOPMENT`, `STAGING` or `PRODUCTION`; a dispatch for another environment is refused. |
| `AGENT_RUNNER_ENABLED` | `true` to run the executor. Default off. |
| `AGENT_RUNNER_DISPATCH_TOKEN` | The secret of the workflows principal; at least 32 characters. |
| `AGENT_RUNNER_API_BASE_URL`, `AGENT_RUNNER_API_TOKEN` | The control API (https, or http on a loopback address) and the runner's service credential for the claim. |
| `AGENT_RUNNER_EXECUTOR_PATH`, `AGENT_RUNNER_EXECUTOR_VERSION` | The absolute path and the pinned version of the CLI; required when enabled. |
| `AGENT_RUNNER_CREDENTIAL_ENV` | The variable that holds the model credential. Default `ANTHROPIC_API_KEY`. Empty if another authentication is configured. |
| `AGENT_RUNNER_PASS_ENV` | More variable names that the child receives. Credentials of the host are refused. |
| `AGENT_RUNNER_ALLOW_PROXY_ENV` | Pass proxy and certificate variables. Tests and development only; refused in `PRODUCTION`. |
| `AGENT_RUNNER_USE_JSON_SCHEMA` | Add `--json-schema` as an additional guard. Default off (see the spike). |
| `AGENT_RUNNER_BARE` | Pass `--bare`. Default on. |
| `AGENT_RUNNER_BUNDLE_DIR` | The installed behaviour bundle. Default `bundle` beside the built module. |
| `AGENT_RUNNER_SCRATCH_DIR`, `AGENT_RUNNER_PORT`, `AGENT_RUNNER_HOST`, `AGENT_RUNNER_MAX_CONCURRENT`, `AGENT_RUNNER_API_TIMEOUT_MS`, `AGENT_RUNNER_WORKER_ID` | Scratch root, listen address (default `127.0.0.1:8080`), concurrency (default 2), API timeout and worker name. |

## Commands

Run these from the repository root with `pnpm --filter @openquant/agent-runner run <command>`, or through Turborepo. They need `pnpm install --frozen-lockfile` first.

| Command | Work |
| --- | --- |
| `typecheck` | Type check `src`, then the tests and tools. |
| `lint` | Biome format and lint check. |
| `test` | The Vitest tests. They start fake executors, loopback servers and the built runner; they use no network and no model. |
| `build` | Type check, then bundle `src/main.ts` into `dist/agent-runner.mjs` for Node 24 with the behaviour bundle in `dist/bundle`, and fail on a dependency other than a Node built-in or on a bundle file that differs from the manifest. |
| `start` | `node dist/agent-runner.mjs`, configured by the variables above. |

## What is not done, and what is not verified

- The real pinned binary was not run by any test: its authentication, its refusal and error results, the effect of `--bare`, the enforcement of `--json-schema` and the model identity it reports are for the executor probe (P6, OQ-06 Fly execution probe). The mapping of those cases is tested against fake output.
- The route manifest has no route that asks a runner to cancel. `Runner.cancel` and the outcome `cancellation` exist, and nothing calls them yet.
- No Fly app, image or release exists. The runner listens on loopback by default.
- The runner compares the session and the model that the executor reports with the ones it passed, and treats a missing report as unknown, not as a mismatch.

// `pnpm agents:eval`: the evaluation harness of the proposer and critic modules (OQ-03 section 6, OQ-06 section 7).
//
// OQ-06 section 7 defines the command as explicit real-model evaluation that fails without opt-in or required
// authentication. So the bare command refuses: it exits non-zero, names `--mode live`, `--allow-real-model-calls` and
// the missing key, and calls no model. Two modes are run only when named:
//
// - fixture (`--mode fixture`): runs every offline suite of fixtures/agent-results through request assembly and
//   result parsing, exactly as `pnpm --filter @openquant/agents run eval:fixture` does. No model is called, and the
//   result says so. A fixture is synthetic, so it never counts as a real-model result.
//
// - live (`--mode live`): runs a few reviewed cases through the production path of the runner (`runAttempt`, the real
//   executor, the shipped behaviour bundle) with the owner's key, and writes a report with the actual model, validity,
//   known-flaw detection, cost and latency of each trial. It refuses to start unless every guard below holds, and it
//   makes no call and starts no process when one does not:
//     1. the explicit opt-in flag `--allow-real-model-calls`;
//     2. a key that the owner supplies in OPENQUANT_EVAL_ANTHROPIC_API_KEY, and that is not any credential of the
//        session that runs this script (ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, PACTWRIGHT_ANTHROPIC_API_KEY or a
//        Claude Code token);
//     3. no coding-agent session: the variables that Claude Code and its cloud sessions set must be absent;
//     4. the pinned executor: an absolute path and the pinned version;
//     5. a budget: `--max-budget-usd` that covers every attempt at its reservation.
//   Proxy and certificate variables reach the executor only with `--allow-proxy-env`, a flag for tests and local
//   development. The child gets the key under the name ANTHROPIC_API_KEY and nothing else of this environment.
//
// The repository session never has the owner's key, and the live mode is not run by any test with a real binary: the
// tests start it with a script that stands in for the executor.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assembleCritiqueRequest,
  assembleFormulationRequest,
  BUNDLE_HASH,
  parseCritiqueResult,
  parseFormulationResult,
  profilesForRole,
  type StrategyCritiqueRequest,
  type StrategyFormulationRequest,
} from '@openquant/agents';
import type {
  AgentAttemptResult,
  AgentDispatch,
  AttemptClaimGrant,
  AttemptClaimRequest,
  ExecutableIdentity,
} from '@openquant/api-contracts';
import {
  type FixtureReport,
  fixtureFiles,
  readFixture,
  runFixtures,
  SUITES,
} from '../../../packages/agents/dev/fixture-runner.ts';
import {
  type CritiqueRecipe,
  critiqueInput,
  type FormulationRecipe,
  formulationInput,
} from '../../../packages/agents/dev/world.ts';
import { type ApiClient, type ApiResult, failure } from '../src/api-client.ts';
import { runAttempt } from '../src/attempt.ts';
import { stageBundle } from '../src/bundle.ts';
import { PROXY_AND_CA_VARIABLES } from '../src/child-env.ts';
import type { RunnerConfig } from '../src/config.ts';
import { type ExecutionEnd, type ExecutionRequest, type ExecutorConfig, execute } from '../src/executor.ts';
import { sha256Bytes } from '../src/text.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(here, '../../..');
const agentsRoot = resolve(repositoryRoot, 'packages/agents');

/** The variable in which the owner supplies the key of a live run. */
export const KEY_VARIABLE = 'OPENQUANT_EVAL_ANTHROPIC_API_KEY';
export const EXECUTOR_PATH_VARIABLE = 'OPENQUANT_EVAL_EXECUTOR_PATH';
export const EXECUTOR_VERSION_VARIABLE = 'OPENQUANT_EVAL_EXECUTOR_VERSION';

/** Credentials of the session that runs this script. A live run never uses one of them as its key. */
const SESSION_CREDENTIALS: readonly string[] = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'PACTWRIGHT_ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
];

/** Variables that a coding-agent session sets. A live run starts only outside such a session. */
export function sessionMarkers(env: Readonly<Record<string, string | undefined>>): string[] {
  return Object.keys(env)
    .filter((name) => env[name] !== undefined && (name === 'CLAUDECODE' || /^(?:CLAUDE_CODE_|CCR_)/.test(name)))
    .sort();
}

/** The most that one live run may reserve, and the reservation of one attempt (decision D22: 5 USD). */
const BUDGET_CEILING_USD = 50;
const DEFAULT_ATTEMPT_USD = 5;
const MAX_TRIALS = 5;

/** The reviewed cases of a live run: the valid control of the proposer and a known flaw for the critic. */
export const LIVE_CASES: readonly string[] = [
  'strategy-formulation/valid-revision-entry',
  'strategy-critique/causal-leak-candidate',
];

export interface EvalArgs {
  /** Undefined when `--mode` is not given: the command then refuses. */
  readonly mode: 'fixture' | 'live' | undefined;
  readonly allowRealModelCalls: boolean;
  readonly allowProxyEnv: boolean;
  readonly maxBudgetUsd: number | undefined;
  readonly attemptUsd: number;
  readonly trials: number;
  readonly out: string | undefined;
}

export type ParsedArgs =
  | { readonly ok: true; readonly args: EvalArgs }
  | { readonly ok: false; readonly errors: readonly string[] };

function amount(text: string | undefined, name: string, errors: string[]): number | undefined {
  if (text === undefined) return undefined;
  if (!/^\d{1,4}(?:\.\d{1,4})?$/.test(text) || Number(text) <= 0) {
    errors.push(`${name} must be a positive decimal in US dollars, such as 5 or 0.25`);
    return undefined;
  }
  return Number(text);
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const errors: string[] = [];
  let mode: string | undefined;
  let allowRealModelCalls = false;
  let allowProxyEnv = false;
  let maxBudget: string | undefined;
  let attempt: string | undefined;
  let trials = 1;
  let out: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index] ?? '';
    const value = (): string | undefined => {
      index += 1;
      const next = argv[index];
      if (next === undefined || next.startsWith('--')) errors.push(`${flag} needs a value`);
      return next?.startsWith('--') ? undefined : next;
    };
    if (flag === '--mode') mode = value();
    else if (flag === '--allow-real-model-calls') allowRealModelCalls = true;
    else if (flag === '--allow-proxy-env') allowProxyEnv = true;
    else if (flag === '--max-budget-usd') maxBudget = value();
    else if (flag === '--attempt-usd') attempt = value();
    else if (flag === '--trials') {
      const text = value();
      trials = text !== undefined && /^[1-9]$/.test(text) ? Number(text) : Number.NaN;
      if (!(trials >= 1 && trials <= MAX_TRIALS)) errors.push(`--trials must be an integer from 1 to ${MAX_TRIALS}`);
    } else if (flag === '--out') out = value();
    else errors.push(`unknown argument ${flag}`);
  }
  if (mode !== undefined && mode !== 'fixture' && mode !== 'live') errors.push('--mode must be fixture or live');
  const maxBudgetUsd = amount(maxBudget, '--max-budget-usd', errors);
  const attemptUsd = amount(attempt, '--attempt-usd', errors) ?? DEFAULT_ATTEMPT_USD;
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    args: {
      mode: mode === 'live' || mode === 'fixture' ? mode : undefined,
      allowRealModelCalls,
      allowProxyEnv,
      maxBudgetUsd,
      attemptUsd,
      trials,
      out,
    },
  };
}

type Env = Readonly<Record<string, string | undefined>>;

/**
 * Every reason why a live run must not start. Empty means that it may. Pure: it reads nothing but its arguments, so
 * the guards are tested without a process, a file or a key.
 */
export function liveRefusals(args: EvalArgs, env: Env): string[] {
  const reasons: string[] = [];
  if (!args.allowRealModelCalls) {
    reasons.push('live mode makes real, billed model calls and needs the explicit flag --allow-real-model-calls');
  }
  const key = env[KEY_VARIABLE];
  if (key === undefined || key.length < 16) {
    reasons.push(
      `the owner's key is not supplied: set ${KEY_VARIABLE} (this repository and its sessions never hold one)`,
    );
  } else if (SESSION_CREDENTIALS.some((name) => env[name] === key)) {
    reasons.push(`${KEY_VARIABLE} holds a credential of the session that runs this script; supply the owner's own key`);
  }
  const markers = sessionMarkers(env);
  if (markers.length > 0) {
    reasons.push(
      `this is a coding-agent session (${markers.slice(0, 3).join(', ')}): run live mode from the owner's own terminal or workflow`,
    );
  }
  const path = env[EXECUTOR_PATH_VARIABLE];
  if (path === undefined || !path.startsWith('/')) {
    reasons.push(`${EXECUTOR_PATH_VARIABLE} must be the absolute path of the pinned executor`);
  }
  if (!/^\d+\.\d+\.\d+$/.test(env[EXECUTOR_VERSION_VARIABLE] ?? '')) {
    reasons.push(`${EXECUTOR_VERSION_VARIABLE} must be the pinned version, such as 2.1.325`);
  }
  if (args.maxBudgetUsd === undefined) {
    reasons.push('--max-budget-usd is required: the total that the run may reserve');
  } else {
    if (args.maxBudgetUsd > BUDGET_CEILING_USD)
      reasons.push(`--max-budget-usd is above the ceiling of ${BUDGET_CEILING_USD} USD`);
    const needed = LIVE_CASES.length * args.trials * args.attemptUsd;
    if (needed > args.maxBudgetUsd) {
      reasons.push(
        `${LIVE_CASES.length} cases of ${args.trials} trial(s) at ${args.attemptUsd} USD reserve ${needed} USD, above --max-budget-usd ${args.maxBudgetUsd}`,
      );
    }
  }
  return reasons;
}

// ---------------------------------------------------------------------------------------------------------------
// Fixture mode
// ---------------------------------------------------------------------------------------------------------------

export interface Output {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

export async function runFixtureMode(output: Output, root?: string): Promise<number> {
  const reports: FixtureReport[] = await runFixtures(root);
  let failed = 0;
  for (const report of reports) {
    if (report.problems.length === 0) {
      output.out(`ok   ${report.suite}/${report.id}`);
    } else {
      failed += 1;
      output.out(`FAIL ${report.suite}/${report.id}`);
      for (const problem of report.problems) output.out(`       ${problem}`);
    }
  }
  const perSuite = SUITES.map((suite) => `${suite} ${reports.filter((item) => item.suite === suite).length}`).join(
    ', ',
  );
  output.out(
    `${reports.length} synthetic fixtures (${perSuite}), ${failed} failed. Fixture mode: no model was called, and no result of this mode is a real-model result.`,
  );
  return failed === 0 && reports.length > 0 ? 0 : 1;
}

// ---------------------------------------------------------------------------------------------------------------
// Live mode
// ---------------------------------------------------------------------------------------------------------------

/** An API that keeps one attempt in memory: the harness has no control API, and it writes nothing durable. */
class EvalApi implements ApiClient {
  readonly inputs = new Map<string, Uint8Array>();
  readonly artefacts = new Map<string, Uint8Array>();
  readonly results: AgentAttemptResult[] = [];

  async claim(_request: AttemptClaimRequest): Promise<ApiResult<AttemptClaimGrant>> {
    return failure(0, 'BAD_RESPONSE', 'the harness claims nothing: it runs the attempt itself');
  }

  async fetchInput(_attempt: string, digest: string): Promise<ApiResult<Uint8Array>> {
    const bytes = this.inputs.get(digest);
    return bytes === undefined ? failure(404, 'NOT_FOUND', `no input ${digest}`) : { ok: true, value: bytes };
  }

  async putArtefact(_attempt: string, digest: string, bytes: Uint8Array): Promise<ApiResult<undefined>> {
    this.artefacts.set(digest, bytes);
    return { ok: true, value: undefined };
  }

  async postAgentResult(_attempt: string, result: AgentAttemptResult): Promise<ApiResult<undefined>> {
    this.results.push(result);
    return { ok: true, value: undefined };
  }
}

export interface TrialReport {
  readonly case: string;
  readonly trial: number;
  readonly outcome: string;
  readonly reason: string | null;
  readonly model: string;
  readonly cost_usd: string | null;
  readonly input_tokens: number | null;
  readonly output_tokens: number | null;
  readonly duration_ms: number | null;
  /** The output passed the shared validator and the rules of the host. */
  readonly valid: boolean;
  /** Critic only: every category that the fixture expects was reported. Null where the case has no known flaw. */
  readonly detected: boolean | null;
  /**
   * Critic only: findings outside the labelled categories, `method_advice` excepted (OQ-03 section 6: policy-permitted
   * advice is not a false positive). A reviewer decides whether each is an invented defect or a real one that the label
   * missed, so this counts possible false positives and decides nothing.
   */
  readonly unlabelled_findings: number | null;
}

export interface EvalReport {
  readonly label: 'real-model evaluation';
  readonly generated_at: string;
  readonly bundle_hash: string;
  readonly executor_version: string;
  readonly reserved_usd: number;
  readonly max_budget_usd: number;
  readonly trials: readonly TrialReport[];
}

export interface LiveDeps {
  readonly execute: (config: ExecutorConfig, request: ExecutionRequest) => Promise<ExecutionEnd>;
  readonly now: () => number;
}

const defaultDeps: LiveDeps = { execute, now: () => Date.now() };

function pick(env: Env, names: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of names) {
    const value = env[name];
    if (typeof value === 'string' && value !== '') out[name] = value;
  }
  return out;
}

function identityOfThisScript(): ExecutableIdentity {
  return {
    name: 'openquant-agents-eval',
    version: '0.0.0',
    digest: sha256Bytes(readFileSync(fileURLToPath(import.meta.url))),
  };
}

async function requestFor(fixture: ReturnType<typeof readFixture>): Promise<{
  readonly role: 'proposer' | 'critic';
  readonly request: StrategyFormulationRequest | StrategyCritiqueRequest;
  readonly text: string;
  readonly artefact: AgentDispatch['inputs']['request']['artefact'];
}> {
  const critique = fixture.suite === 'strategy-critique';
  const assembly = critique
    ? await assembleCritiqueRequest(await critiqueInput(fixture.request as CritiqueRecipe))
    : await assembleFormulationRequest(await formulationInput(fixture.request as FormulationRecipe));
  if (!assembly.ok) throw new Error(`the request of ${fixture.suite}/${fixture.id} was refused by assembly`);
  return {
    role: critique ? 'critic' : 'proposer',
    request: assembly.request,
    text: assembly.text,
    artefact: assembly.artefact,
  };
}

export async function runLiveMode(
  args: EvalArgs,
  env: Env,
  output: Output,
  deps: LiveDeps = defaultDeps,
): Promise<number> {
  const scratch = mkdtempSync(join(tmpdir(), 'openquant-agents-eval-'));
  try {
    const bundleDir = join(scratch, 'bundle');
    stageBundle(agentsRoot, bundleDir);
    // The child receives the owner's key under the name that the CLI reads, and nothing else of this environment but
    // the proxy and certificate variables, and only behind the flag.
    const hostEnv: Record<string, string> = {
      ANTHROPIC_API_KEY: env[KEY_VARIABLE] ?? '',
      ...(args.allowProxyEnv ? pick(env, PROXY_AND_CA_VARIABLES) : {}),
    };
    const executorVersion = env[EXECUTOR_VERSION_VARIABLE] ?? '';
    const executor: ExecutorConfig = {
      path: env[EXECUTOR_PATH_VARIABLE] ?? '',
      version: executorVersion,
      credentialEnv: 'ANTHROPIC_API_KEY',
      passEnv: [],
      allowProxyEnv: args.allowProxyEnv,
      enforceSchema: false,
      bare: true,
      childPath: '/usr/local/bin:/usr/bin:/bin',
      scratchRoot: join(scratch, 'attempts'),
      hostEnv,
      versionTimeoutMs: 10_000,
      stderrLimit: 65_536,
    };
    const config: RunnerConfig = {
      environment: 'DEVELOPMENT',
      enabled: true,
      dispatchToken: 'not-a-dispatch-token-it-is-never-served',
      api: { baseUrl: 'http://127.0.0.1:1', credential: 'not-an-api-credential', timeoutMs: 1000 },
      executor,
      bundleDir,
      maxConcurrent: 1,
      workerId: 'agents-eval',
      identity: identityOfThisScript(),
      listen: { host: '127.0.0.1', port: 0 },
    };
    const trials: TrialReport[] = [];
    const files = fixtureFiles();
    for (const id of LIVE_CASES) {
      const file = files.find((candidate) => candidate.endsWith(`/${id}.json`));
      if (file === undefined) throw new Error(`the live case ${id} is not a fixture`);
      const fixture = readFixture(file);
      const built = await requestFor(fixture);
      for (let trial = 1; trial <= args.trials; trial += 1) {
        const api = new EvalApi();
        api.inputs.set(built.artefact.digest, Buffer.from(built.text, 'utf8'));
        const attempt = `eval-${fixture.id}-${trial}`.slice(0, 60);
        const profile = profilesForRole(built.role)[0]?.profile;
        if (profile === undefined) throw new Error(`no configuration for ${built.role}`);
        const dispatch: AgentDispatch = {
          schema_version: 'agent-dispatch/1',
          environment: 'DEVELOPMENT',
          identity: {
            mission_id: 'agents-eval',
            run_id: `agents-eval-${fixture.id}`,
            attempt: { attempt_id: attempt, ownership_revision: 1 },
            session_id: `session-${attempt}`,
            role: built.role,
            skill: { id: fixture.suite, version: '1' },
            bundle_hash: BUNDLE_HASH,
          },
          execution: {
            executor: { version: executorVersion, profile },
            bounds: {
              timeout_seconds: 900,
              output_limit_bytes: 524288,
              cost_reservation: { amount: String(args.attemptUsd), currency: 'USD' },
            },
            tools: [],
            required_capabilities: [],
          },
          inputs: {
            request: {
              contract: `${fixture.suite}.request/1` as AgentDispatch['inputs']['request']['contract'],
              artefact: built.artefact,
            },
            holdout_exclusions: built.request.context.holdout_exclusions,
          },
          result_route: `/v1/attempts/${attempt}/agent-result`,
        };
        const grant: AttemptClaimGrant = {
          schema_version: 'attempt-claim/1',
          form: 'grant',
          attempt: dispatch.identity.attempt,
          granted_at: new Date(deps.now()).toISOString().replace(/\.\d{3}Z$/, 'Z'),
          lease_expires_at: new Date(deps.now() + 3_600_000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
          capability: { token: 'eval-attempt-capability-not-a-secret' },
        };
        await runAttempt(
          dispatch,
          grant,
          {
            config,
            api,
            execute: (request) => deps.execute(executor, request),
            now: deps.now,
            log: () => undefined,
            sleep: async () => undefined,
          },
          new AbortController().signal,
        );
        trials.push(summarise(fixture, built, api, trial));
        const last = trials.at(-1);
        output.out(
          `${last?.valid ? 'valid  ' : 'invalid'} ${id} trial ${trial}: ${last?.outcome}${last?.reason ? ` ${last.reason}` : ''}, model ${last?.model}, cost ${last?.cost_usd ?? 'unknown'} USD, ${last?.duration_ms ?? 'unknown'} ms`,
        );
      }
    }
    const report: EvalReport = {
      label: 'real-model evaluation',
      generated_at: new Date(deps.now()).toISOString(),
      bundle_hash: BUNDLE_HASH,
      executor_version: executorVersion,
      reserved_usd: LIVE_CASES.length * args.trials * args.attemptUsd,
      max_budget_usd: args.maxBudgetUsd ?? 0,
      trials,
    };
    const target = resolve(args.out ?? join(repositoryRoot, 'local-runs/agents-eval/report.json'));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, `${JSON.stringify(report, null, 2)}\n`);
    output.out(
      `Report written to ${target}. It holds the actual model, validity, detection, cost and latency of each trial.`,
    );
    // A trial that was denied or could not authenticate says nothing about the model: the run is incomplete.
    const incomplete = trials.some(
      (item) =>
        item.outcome === 'denied_capability' || item.outcome === 'authentication_failure' || item.outcome === 'none',
    );
    return incomplete ? 1 : 0;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function summarise(
  fixture: ReturnType<typeof readFixture>,
  built: Awaited<ReturnType<typeof requestFor>>,
  api: EvalApi,
  trial: number,
): TrialReport {
  const result = api.results[0];
  const caseName = `${fixture.suite}/${fixture.id}`;
  if (result === undefined) {
    return {
      case: caseName,
      trial,
      outcome: 'none',
      reason: 'no result was posted',
      model: 'unknown',
      cost_usd: null,
      input_tokens: null,
      output_tokens: null,
      duration_ms: null,
      valid: false,
      detected: null,
      unlabelled_findings: null,
    };
  }
  const { outcome, usage, provenance } = result;
  let valid = false;
  let detected: boolean | null = null;
  let unlabelled: number | null = null;
  if (outcome.outcome === 'completion') {
    const stored = api.artefacts.get(outcome.output.artefact.digest);
    const text = stored === undefined ? '' : Buffer.from(stored).toString('utf8');
    if (built.role === 'critic') {
      const parsed = parseCritiqueResult(built.request as StrategyCritiqueRequest, text);
      valid = parsed.ok;
      const expected = ((fixture.expect as { findings?: { category: string }[] } | undefined)?.findings ?? []).map(
        (item) => item.category,
      );
      if (parsed.ok) {
        const found = new Set(parsed.findings.map((item) => item.category));
        if (expected.length > 0) detected = expected.every((category) => found.has(category as never));
        unlabelled = parsed.findings.filter(
          (item) => item.category !== 'method_advice' && !expected.includes(item.category),
        ).length;
      }
    } else {
      valid = parseFormulationResult(built.request as StrategyFormulationRequest, text).ok;
    }
  }
  return {
    case: caseName,
    trial,
    outcome: outcome.outcome,
    reason: 'reason' in outcome ? outcome.reason : null,
    model: provenance.model.status === 'reported' ? provenance.model.value : 'unknown',
    cost_usd: usage.cost.label === 'unknown' ? null : usage.cost.amount,
    input_tokens: usage.input_tokens.label === 'unknown' ? null : usage.input_tokens.count,
    output_tokens: usage.output_tokens.label === 'unknown' ? null : usage.output_tokens.count,
    duration_ms: usage.duration.label === 'unknown' ? null : usage.duration.milliseconds,
    valid,
    detected,
    unlabelled_findings: unlabelled,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------------------------------------------

const USAGE = `Usage: pnpm agents:eval --mode live|fixture [options]

  The mode is required: without --mode the command refuses and calls no model.
  fixture             run the offline suites; no model is called
  live                real, billed model calls with the owner's key; refused unless every guard holds
    --allow-real-model-calls   the explicit opt-in
    --max-budget-usd <n>       total reservation of the run (ceiling ${BUDGET_CEILING_USD})
    --attempt-usd <n>          reservation of one attempt (default ${DEFAULT_ATTEMPT_USD})
    --trials <1-${MAX_TRIALS}>           trials per case (default 1)
    --allow-proxy-env          pass proxy and certificate variables to the executor (tests and local development)
    --out <file>               report path (default local-runs/agents-eval/report.json)
  environment for live mode: ${KEY_VARIABLE}, ${EXECUTOR_PATH_VARIABLE}, ${EXECUTOR_VERSION_VARIABLE}
`;

export async function main(
  argv: readonly string[],
  env: Env,
  output: Output = { out: (line) => console.log(line), err: (line) => console.error(line) },
  deps: LiveDeps = defaultDeps,
): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    output.out(USAGE);
    return 0;
  }
  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    for (const error of parsed.errors) output.err(error);
    output.err(USAGE);
    return 2;
  }
  const { args } = parsed;
  if (args.mode === undefined) {
    output.err(
      'agents:eval runs an explicit real-model evaluation and refused to run without --mode. No model was called and no process was started.',
    );
    output.err(
      `  A real-model run needs --mode live, --allow-real-model-calls, --max-budget-usd and the owner's key in ${KEY_VARIABLE}${
        env[KEY_VARIABLE] === undefined ? ' (not set)' : ''
      }.`,
    );
    output.err('  The offline fixtures run with --mode fixture; they call no model and are never a real-model result.');
    return 2;
  }
  if (args.mode === 'fixture') {
    if (args.allowRealModelCalls || args.maxBudgetUsd !== undefined) {
      output.err('--allow-real-model-calls and --max-budget-usd belong to --mode live; fixture mode calls no model.');
      return 2;
    }
    return runFixtureMode(output);
  }
  const reasons = liveRefusals(args, env);
  if (reasons.length > 0) {
    output.err('agents:eval live mode refused to run. No model was called and no process was started:');
    for (const reason of reasons) output.err(`  - ${reason}`);
    return 2;
  }
  return runLiveMode(args, env, output, deps);
}

// The root script generates the bundle module first (`node packages/agents/tools/generate.ts`), as `eval:fixture` does.
if (import.meta.main) {
  process.exit(await main(process.argv.slice(2), process.env));
}

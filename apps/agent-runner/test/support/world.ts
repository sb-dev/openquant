// Test harness of the agent runner: a fake CLI on disk, a fake control API, a staged bundle and a valid dispatch.
//
// Nothing here calls a model or the network. The "CLI" is a script that stands in for the pinned binary, the API is an
// in-memory fake (or a loopback server in the HTTP tests), and every request and output is synthetic.

import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assembleCritiqueRequest,
  assembleFormulationRequest,
  BUNDLE_HASH,
  type StrategyCritiqueRequest,
  type StrategyFormulationRequest,
} from '@openquant/agents';
import type {
  AgentAttemptResult,
  AgentDispatch,
  ArtefactRef,
  AttemptClaimGrant,
  AttemptClaimRequest,
} from '@openquant/api-contracts';
import { critiqueRequestInput, revisionInput } from '../../../../packages/agents/test/support/requests.ts';
import { type ApiClient, type ApiFailure, type ApiFailureCode, type ApiResult, failure } from '../../src/api-client.ts';
import { stageBundle } from '../../src/bundle.ts';
import type { RunnerConfig } from '../../src/config.ts';
import { sha256Bytes } from '../../src/text.ts';

export const here = dirname(fileURLToPath(import.meta.url));
export const runnerRoot = resolve(here, '../..');
export const repositoryRoot = resolve(runnerRoot, '../..');
export const agentsRoot = resolve(repositoryRoot, 'packages/agents');
export const FAKE_SCRIPT = resolve(here, 'fake-claude.mjs');

/** Secrets that the tests put in the runner environment. None is real. */
export const MODEL_KEY = 'sk-ant-test-0000000000000000000000000000';
export const HOST_SECRET = 'host-service-secret-0000000000000000';
export const DISPATCH_TOKEN = 'dispatch-token-00000000000000000000000';
export const API_TOKEN = 'runner-api-token-000000000000000000000';
export const CAPABILITY = 'attempt-capability-0000000000000000000000';

const temporary: string[] = [];

export function scratch(prefix = 'oq-runner-test-'): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporary.push(directory);
  return directory;
}

export function cleanup(): void {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------------------------------------------
// The fake CLI
// ---------------------------------------------------------------------------------------------------------------

export interface Scenario {
  readonly behaviour: 'result' | 'raw' | 'echo-stdin' | 'dump-env' | 'hang' | 'grandchild' | 'flood' | 'crash';
  readonly version?: string;
  readonly versionExit?: number;
  readonly resultText?: string;
  readonly report?: Record<string, unknown>;
  readonly omit?: readonly string[];
  readonly reportedModel?: string;
  readonly reportedSession?: string;
  readonly exitCode?: number;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly pidFile?: string;
  readonly afterSpawn?: 'exit' | 'hang';
}

export interface FakeCli {
  readonly path: string;
  readonly log: string;
  /** Every call that the fake recorded, in order. */
  calls(): readonly FakeCall[];
}

export interface FakeCall {
  readonly kind: 'version' | 'run';
  readonly args?: readonly string[];
  readonly env: Record<string, string>;
  readonly cwd: string;
  readonly stdinBytes?: number;
  readonly stdinSha256?: string;
  readonly homeEntries?: readonly string[];
  readonly cwdEntries?: readonly string[];
  readonly pid?: number;
}

/** Install a fake CLI: a shell script that runs the checked-in fake with a scenario file. */
export function installFakeCli(scenario: Scenario, directory = scratch('oq-fake-cli-')): FakeCli {
  const log = join(directory, 'calls.jsonl');
  writeFileSync(join(directory, 'scenario.json'), JSON.stringify({ ...scenario, log }));
  const path = join(directory, 'claude');
  writeFileSync(
    path,
    `#!/bin/sh\nexec '${process.execPath}' '${FAKE_SCRIPT}' '${join(directory, 'scenario.json')}' "$@"\n`,
  );
  chmodSync(path, 0o755);
  return {
    path,
    log,
    calls() {
      try {
        return readFileSync(log, 'utf8')
          .split('\n')
          .filter((line) => line !== '')
          .map((line) => JSON.parse(line) as FakeCall);
      } catch {
        return [];
      }
    },
  };
}

/** Change the scenario of an installed fake CLI. */
export function setScenario(cli: FakeCli, scenario: Scenario): void {
  writeFileSync(join(cli.path, '..', 'scenario.json'), JSON.stringify({ ...scenario, log: cli.log }));
}

// ---------------------------------------------------------------------------------------------------------------
// The fake control API
// ---------------------------------------------------------------------------------------------------------------

export interface FakeApiOptions {
  claim?: ApiFailure | 'grant';
  input?: ApiFailure | 'ok';
  artefact?: ApiFailure | 'ok';
  result?: ApiFailure | 'ok';
  /** Make the first N calls of `fetchInput` fail with this code before it succeeds. */
  transientInputFailures?: number;
}

export class FakeApi implements ApiClient {
  readonly events: string[] = [];
  readonly claims: AttemptClaimRequest[] = [];
  readonly artefacts = new Map<string, Uint8Array>();
  readonly results: AgentAttemptResult[] = [];
  readonly capabilities: string[] = [];
  readonly stored = new Map<string, Uint8Array>();
  options: FakeApiOptions;
  /** Called inside `claim`, to look at the world at the moment of the claim. */
  onClaim: (() => void) | undefined;
  #transient: number;

  constructor(options: FakeApiOptions = {}) {
    this.options = options;
    this.#transient = options.transientInputFailures ?? 0;
  }

  store(bytes: Uint8Array): string {
    const digest = sha256Bytes(bytes);
    this.stored.set(digest, bytes);
    return digest;
  }

  async claim(request: AttemptClaimRequest): Promise<ApiResult<AttemptClaimGrant>> {
    this.events.push('claim');
    this.claims.push(request);
    this.onClaim?.();
    if (this.options.claim !== undefined && this.options.claim !== 'grant') return this.options.claim;
    return {
      ok: true,
      value: {
        schema_version: 'attempt-claim/1',
        form: 'grant',
        attempt: request.attempt,
        granted_at: '2026-11-15T10:00:00Z',
        lease_expires_at: '2026-11-15T10:20:00Z',
        capability: { token: CAPABILITY },
      },
    };
  }

  async fetchInput(attemptId: string, digest: string, capability: string): Promise<ApiResult<Uint8Array>> {
    this.events.push('fetch');
    this.capabilities.push(capability);
    if (this.#transient > 0) {
      this.#transient -= 1;
      return failure(503, 'UNAVAILABLE', 'try later');
    }
    if (this.options.input !== undefined && this.options.input !== 'ok') return this.options.input;
    const bytes = this.stored.get(digest);
    return bytes === undefined
      ? failure(404, 'NOT_FOUND', `no input ${digest} for ${attemptId}`)
      : { ok: true, value: bytes };
  }

  async putArtefact(
    _attemptId: string,
    digest: string,
    bytes: Uint8Array,
    capability: string,
  ): Promise<ApiResult<undefined>> {
    this.events.push('put');
    this.capabilities.push(capability);
    if (this.options.artefact !== undefined && this.options.artefact !== 'ok') return this.options.artefact;
    this.artefacts.set(digest, bytes);
    return { ok: true, value: undefined };
  }

  async postAgentResult(
    _attemptId: string,
    result: AgentAttemptResult,
    capability: string,
  ): Promise<ApiResult<undefined>> {
    this.events.push('post');
    this.capabilities.push(capability);
    if (this.options.result !== undefined && this.options.result !== 'ok') return this.options.result;
    this.results.push(result);
    return { ok: true, value: undefined };
  }
}

export function apiFailure(status: number, code: ApiFailureCode): ApiFailure {
  return failure(status, code, `fake ${code}`);
}

// ---------------------------------------------------------------------------------------------------------------
// Requests, dispatches and configuration
// ---------------------------------------------------------------------------------------------------------------

export interface Assembled<R> {
  readonly request: R;
  readonly bytes: Uint8Array;
  readonly artefact: ArtefactRef;
}

export async function formulationRequest(): Promise<Assembled<StrategyFormulationRequest>> {
  const assembly = await assembleFormulationRequest(await revisionInput());
  if (!assembly.ok) throw new Error(`the proposer request was refused: ${JSON.stringify(assembly.refusals)}`);
  return { request: assembly.request, bytes: Buffer.from(assembly.text, 'utf8'), artefact: assembly.artefact };
}

export async function critiqueRequest(): Promise<Assembled<StrategyCritiqueRequest>> {
  const assembly = await assembleCritiqueRequest(await critiqueRequestInput());
  if (!assembly.ok) throw new Error(`the critic request was refused: ${JSON.stringify(assembly.refusals)}`);
  return { request: assembly.request, bytes: Buffer.from(assembly.text, 'utf8'), artefact: assembly.artefact };
}

export interface DispatchOptions {
  attempt?: string;
  session?: string;
  role?: 'proposer' | 'critic';
  model?: string;
  timeoutSeconds?: number;
  outputLimitBytes?: number;
  bundleHash?: string;
  executorVersion?: string;
  currency?: string;
  environment?: AgentDispatch['environment'];
}

export function dispatchFor(
  assembled: Assembled<StrategyFormulationRequest | StrategyCritiqueRequest>,
  options: DispatchOptions = {},
): AgentDispatch {
  const role = options.role ?? 'proposer';
  const attempt = options.attempt ?? 'attempt-1';
  return {
    schema_version: 'agent-dispatch/1',
    environment: options.environment ?? 'STAGING',
    identity: {
      mission_id: 'mission-1',
      run_id: 'agent-run-1',
      attempt: { attempt_id: attempt, ownership_revision: 1 },
      session_id: options.session ?? `session-${attempt}`,
      role,
      skill: { id: role === 'proposer' ? 'strategy-formulation' : 'strategy-critique', version: '1' },
      bundle_hash: options.bundleHash ?? BUNDLE_HASH,
    },
    execution: {
      executor: {
        version: options.executorVersion ?? '2.1.325',
        profile: { model: options.model ?? 'claude-opus-5-5', effort: 'executor_default' },
      },
      bounds: {
        timeout_seconds: options.timeoutSeconds ?? 20,
        output_limit_bytes: options.outputLimitBytes ?? 524288,
        cost_reservation: { amount: '5', currency: options.currency ?? 'USD' },
      },
      tools: [],
      required_capabilities: [],
    },
    inputs: {
      request: {
        contract: role === 'proposer' ? 'strategy-formulation.request/1' : 'strategy-critique.request/1',
        artefact: assembled.artefact,
      },
      holdout_exclusions: assembled.request.context.holdout_exclusions,
    },
    result_route: `/v1/attempts/${attempt}/agent-result`,
  };
}

export interface World {
  readonly config: RunnerConfig;
  readonly cli: FakeCli;
  readonly api: FakeApi;
  readonly scratchRoot: string;
  readonly bundleDir: string;
}

export const TEST_IDENTITY = { name: 'openquant-agent-runner', version: '0.0.0', digest: `sha256:${'a'.repeat(64)}` };

export function makeWorld(
  scenario: Scenario,
  overrides: {
    enabled?: boolean;
    apiOptions?: FakeApiOptions;
    executor?: Partial<RunnerConfig['executor']>;
    maxConcurrent?: number;
  } = {},
): World {
  const scratchRoot = scratch('oq-scratch-');
  const bundleDir = join(scratch('oq-bundle-'), 'bundle');
  stageBundle(agentsRoot, bundleDir);
  const cli = installFakeCli(scenario);
  const hostEnv: Record<string, string> = {
    ANTHROPIC_API_KEY: MODEL_KEY,
    AGENT_RUNNER_DISPATCH_TOKEN: DISPATCH_TOKEN,
    AGENT_RUNNER_API_TOKEN: API_TOKEN,
    CLOUDFLARE_API_TOKEN: HOST_SECRET,
    FLY_API_TOKEN: HOST_SECRET,
    DATABASE_URL: `postgres://user:${HOST_SECRET}@localhost/db`,
    HTTPS_PROXY: 'http://proxy.invalid:3128',
    SSL_CERT_FILE: '/etc/ssl/ca.invalid',
    OQ_TEST_PARENT_SECRET: HOST_SECRET,
  };
  const config: RunnerConfig = {
    environment: 'STAGING',
    enabled: overrides.enabled ?? true,
    dispatchToken: DISPATCH_TOKEN,
    api: { baseUrl: 'http://127.0.0.1:1', credential: API_TOKEN, timeoutMs: 2000 },
    executor: {
      path: cli.path,
      version: '2.1.325',
      credentialEnv: 'ANTHROPIC_API_KEY',
      passEnv: [],
      allowProxyEnv: false,
      enforceSchema: false,
      bare: true,
      childPath: '/usr/bin:/bin',
      scratchRoot,
      hostEnv,
      versionTimeoutMs: 10_000,
      stderrLimit: 65_536,
      ...overrides.executor,
    },
    bundleDir,
    maxConcurrent: overrides.maxConcurrent ?? 2,
    workerId: 'worker-test',
    identity: TEST_IDENTITY,
    listen: { host: '127.0.0.1', port: 0 },
  };
  return { config, cli, api: new FakeApi(overrides.apiOptions), scratchRoot, bundleDir };
}

/** Poll until `done` is true, within `ms`. */
export async function until(done: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!done()) {
    if (Date.now() > end) throw new Error('condition not met in time');
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
}

export function mkdirs(...paths: string[]): void {
  for (const path of paths) mkdirSync(path, { recursive: true });
}

/**
 * Whether a process is still running. A process that was killed and not yet reaped is a zombie: it has ended, so it
 * counts as gone (the state `Z` in /proc on Linux). Without /proc the signal test is all there is.
 */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    // The state is the field after the command name, which is in parentheses and may itself hold spaces.
    return stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3) !== 'Z';
  } catch {
    return true;
  }
}

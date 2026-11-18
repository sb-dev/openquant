// The configuration of the agent runner, read once from the environment of the process (OQ-03 sections 3 and 5).
//
// Execution is disabled unless `AGENT_RUNNER_ENABLED=true` (OQ-03 section 3: `execution.enabled` defaults off). A
// disabled runner still claims an attempt and records `denied_capability`, so a refusal is a recorded outcome and
// not a silence. The model credential is the one secret that reaches the executor, and the configuration refuses any
// other variable name that would hand the child a credential of the host.

import { hostname } from 'node:os';
import { join, resolve } from 'node:path';
import type { DeploymentEnvironment, ExecutableIdentity } from '@openquant/api-contracts';
import { validBaseUrl } from './api-client.ts';
import { passEnvProblem } from './child-env.ts';
import type { ExecutorConfig } from './executor.ts';

export interface RunnerConfig {
  readonly environment: DeploymentEnvironment;
  readonly enabled: boolean;
  /** The secret that the workflows principal presents to the dispatch route. */
  readonly dispatchToken: string;
  readonly api: { readonly baseUrl: string; readonly credential: string; readonly timeoutMs: number };
  readonly executor: ExecutorConfig;
  /** The directory with the installed behaviour bundle. */
  readonly bundleDir: string;
  /** At most this many attempts run at once. */
  readonly maxConcurrent: number;
  readonly workerId: string;
  /** The identity that the runner reports for itself in the claim and in every result. */
  readonly identity: ExecutableIdentity;
  readonly listen: { readonly host: string; readonly port: number };
}

export type ConfigResult =
  | { readonly ok: true; readonly config: RunnerConfig }
  | { readonly ok: false; readonly errors: readonly string[] };

type Env = Readonly<Record<string, string | undefined>>;

const ENVIRONMENTS: readonly DeploymentEnvironment[] = ['DEVELOPMENT', 'STAGING', 'PRODUCTION'];
const MIN_TOKEN_LENGTH = 32;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const FLY_MACHINE_ID = /^[0-9a-z]{1,32}$/;

function flag(env: Env, name: string, errors: string[]): boolean {
  const value = env[name];
  if (value === undefined || value === '') return false;
  if (value === 'true') return true;
  if (value === 'false') return false;
  errors.push(`${name} must be true or false`);
  return false;
}

function integer(env: Env, name: string, fallback: number, low: number, high: number, errors: string[]): number {
  const text = env[name];
  if (text === undefined || text === '') return fallback;
  const value = /^[0-9]{1,9}$/.test(text) ? Number(text) : Number.NaN;
  if (!(value >= low && value <= high)) {
    errors.push(`${name} must be an integer from ${low} to ${high}`);
    return fallback;
  }
  return value;
}

export interface LoadOptions {
  /** The identity of the runner executable. The caller measures it (a SHA-256 of the running file). */
  readonly identity: ExecutableIdentity;
  /** The directory that holds the installed bundle when AGENT_RUNNER_BUNDLE_DIR is not set. */
  readonly defaultBundleDir: string;
}

export function loadConfig(env: Env, options: LoadOptions): ConfigResult {
  const errors: string[] = [];
  const need = (name: string): string => {
    const value = env[name];
    if (value === undefined || value === '') errors.push(`${name} is required`);
    return value ?? '';
  };

  const environment = (env.AGENT_RUNNER_ENVIRONMENT ?? '') as DeploymentEnvironment;
  if (!ENVIRONMENTS.includes(environment))
    errors.push(`AGENT_RUNNER_ENVIRONMENT must be one of ${ENVIRONMENTS.join(', ')}`);

  const enabled = flag(env, 'AGENT_RUNNER_ENABLED', errors);
  const allowProxyEnv = flag(env, 'AGENT_RUNNER_ALLOW_PROXY_ENV', errors);
  const enforceSchema = flag(env, 'AGENT_RUNNER_USE_JSON_SCHEMA', errors);
  const bare =
    env.AGENT_RUNNER_BARE === undefined || env.AGENT_RUNNER_BARE === '' ? true : flag(env, 'AGENT_RUNNER_BARE', errors);
  if (allowProxyEnv && environment === 'PRODUCTION') {
    errors.push('AGENT_RUNNER_ALLOW_PROXY_ENV is a test and development switch and is refused in PRODUCTION');
  }

  const dispatchToken = need('AGENT_RUNNER_DISPATCH_TOKEN');
  if (dispatchToken !== '' && dispatchToken.length < MIN_TOKEN_LENGTH) {
    errors.push(`AGENT_RUNNER_DISPATCH_TOKEN must be at least ${MIN_TOKEN_LENGTH} characters`);
  }
  const apiCredential = need('AGENT_RUNNER_API_TOKEN');
  const baseUrl = need('AGENT_RUNNER_API_BASE_URL');
  const checkedBase = baseUrl === '' ? '' : validBaseUrl(baseUrl);
  if (checkedBase === undefined)
    errors.push('AGENT_RUNNER_API_BASE_URL must be an https URL, or http on a loopback address');

  // The executor is configured only when execution is enabled; a disabled runner needs none of it.
  const executablePath = env.AGENT_RUNNER_EXECUTOR_PATH ?? '';
  const executorVersion = env.AGENT_RUNNER_EXECUTOR_VERSION ?? '';
  const credentialEnv =
    env.AGENT_RUNNER_CREDENTIAL_ENV === undefined ? 'ANTHROPIC_API_KEY' : env.AGENT_RUNNER_CREDENTIAL_ENV;
  const passEnv = (env.AGENT_RUNNER_PASS_ENV ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name !== '');
  if (enabled) {
    if (!executablePath.startsWith('/'))
      errors.push('AGENT_RUNNER_EXECUTOR_PATH must be an absolute path when execution is enabled');
    if (!VERSION.test(executorVersion))
      errors.push('AGENT_RUNNER_EXECUTOR_VERSION must be the pinned version, such as 2.1.325');
  }
  for (const name of credentialEnv === '' ? passEnv : [credentialEnv, ...passEnv]) {
    const problem = passEnvProblem(name);
    if (problem) errors.push(`AGENT_RUNNER_PASS_ENV: ${problem}`);
  }

  // On a Fly Machine the worker name carries the Machine ID that Fly sets, `fly:<machine id>:agent-runner-<pid>`. The
  // API stores it with the claim, and its termination probe asks Fly about that Machine (apps/api/src/fly-probe.ts).
  // It grants no authority (OQ-05 section 9).
  const flyMachine = env.FLY_MACHINE_ID ?? '';
  let workerId: string;
  if (flyMachine !== '') {
    if (!FLY_MACHINE_ID.test(flyMachine)) errors.push('FLY_MACHINE_ID must be a Fly Machine ID');
    if (env.AGENT_RUNNER_WORKER_ID !== undefined && env.AGENT_RUNNER_WORKER_ID !== '')
      errors.push('AGENT_RUNNER_WORKER_ID cannot be set on a Fly Machine: the worker name carries FLY_MACHINE_ID');
    workerId = `fly:${flyMachine}:agent-runner-${process.pid}`;
  } else {
    workerId = (env.AGENT_RUNNER_WORKER_ID ?? `${hostname()}-${process.pid}`)
      .replace(/[^A-Za-z0-9._:-]/g, '-')
      .slice(0, 64);
    if (!IDENTIFIER.test(workerId)) errors.push('AGENT_RUNNER_WORKER_ID must be an identifier');
  }

  const port = integer(env, 'AGENT_RUNNER_PORT', 8080, 1, 65535, errors);
  const maxConcurrent = integer(env, 'AGENT_RUNNER_MAX_CONCURRENT', 2, 1, 16, errors);
  const apiTimeoutMs = integer(env, 'AGENT_RUNNER_API_TIMEOUT_MS', 15_000, 100, 120_000, errors);
  const scratchRoot = resolve(env.AGENT_RUNNER_SCRATCH_DIR ?? join('/tmp', 'openquant-agent-runner'));

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    config: {
      environment,
      enabled,
      dispatchToken,
      api: {
        baseUrl: checkedBase ?? '',
        credential: apiCredential,
        timeoutMs: apiTimeoutMs,
      },
      executor: {
        path: executablePath,
        version: executorVersion,
        credentialEnv: credentialEnv === '' ? undefined : credentialEnv,
        passEnv,
        allowProxyEnv,
        enforceSchema,
        bare,
        childPath: '/usr/local/bin:/usr/bin:/bin',
        scratchRoot,
        hostEnv: env,
        versionTimeoutMs: 10_000,
        stderrLimit: 65_536,
      },
      bundleDir: resolve(env.AGENT_RUNNER_BUNDLE_DIR ?? options.defaultBundleDir),
      maxConcurrent,
      workerId,
      identity: options.identity,
      listen: { host: env.AGENT_RUNNER_HOST ?? '127.0.0.1', port },
    },
  };
}

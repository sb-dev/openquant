// The delegated executor: one pinned Claude Code CLI run for one attempt (OQ-03 sections 3 to 5).
//
// Per attempt the runner makes a fresh directory with an empty HOME, an empty working directory and a private
// TMPDIR, checks the pinned version of the executable, builds the environment from an allowlist, starts the CLI in
// its own process group with no tools and no setting source, reads at most a bounded number of bytes, and kills the
// whole tree at the deadline, at an overflow, at an abort and at the end of the run. It maps what happened onto the
// execution outcomes of agent-attempt-result/1. It never validates the role output: the caller does, with the shared
// validator. It starts no model call unless the executable path is configured, and tests configure scripts only.

import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { ExecutorProfile } from '@openquant/api-contracts';
import { buildChildEnvironment } from './child-env.ts';
import {
  authenticationFailure,
  buildArguments,
  type CliReport,
  cliSessionId,
  executorFixedEnvironment,
  modelMatches,
  parseCliReport,
  parseCliVersion,
} from './cli.ts';
import { type ProcessEnd, runProcess } from './process-tree.ts';
import { diagnostic } from './text.ts';

export type DeniedReason =
  | 'EXECUTION_DISABLED'
  | 'EXECUTABLE_MISSING'
  | 'CAPABILITY_UNSUPPORTED'
  | 'CAPABILITY_DENIED'
  | 'BUNDLE_MISMATCH';

export interface ExecutorConfig {
  /** The absolute path of the pinned CLI. */
  readonly path: string;
  /** The version that this runner is pinned to. */
  readonly version: string;
  /** The variable that holds the model credential: it must be present, and only it is passed on. */
  readonly credentialEnv: string | undefined;
  /** Further names that the child receives from the host environment. */
  readonly passEnv: readonly string[];
  readonly allowProxyEnv: boolean;
  /** Add `--json-schema` as an additional guard. Off until the executor probe verifies enforcement. */
  readonly enforceSchema: boolean;
  readonly bare: boolean;
  /** The PATH of the child. It is a fixed value and never the PATH of the runner. */
  readonly childPath: string;
  readonly scratchRoot: string;
  readonly hostEnv: Readonly<Record<string, string | undefined>>;
  readonly versionTimeoutMs: number;
  readonly stderrLimit: number;
}

export interface ExecutionRequest {
  /** The identifier that the dispatch gives the session. The CLI session is derived from it. */
  readonly sessionId: string;
  readonly profile: ExecutorProfile;
  readonly timeoutMs: number;
  readonly outputLimitBytes: number;
  /** The cost reservation as a decimal string in US dollars. */
  readonly budgetUsd: string;
  /** The procedure text of the role module. */
  readonly systemPrompt: string;
  /** The exact bytes of the frozen role request: standard input of the executor. */
  readonly request: Uint8Array;
  /** The result schema for the additional guard. */
  readonly resultSchema: unknown;
  readonly signal: AbortSignal | undefined;
}

/** What the host captured about the run, with explicit unknowns. */
export interface ExecutionFacts {
  readonly executorVersion: string | undefined;
  readonly sessionId: string | undefined;
  readonly model: string | undefined;
  readonly provider: string | undefined;
  readonly effort: string | undefined;
  readonly costUsd: number | undefined;
  readonly inputTokens: number | undefined;
  readonly outputTokens: number | undefined;
  /** The wall-clock time of the model run, or undefined when it never started. */
  readonly durationMs: number | undefined;
  /** True once the model run was started. A denial before that costs nothing. */
  readonly started: boolean;
}

export type MalformedKind = 'NOT_JSON' | 'SCHEMA_INVALID' | 'IDENTITY_MISMATCH' | 'OUTPUT_LIMIT_EXCEEDED';

export type ExecutionEnd =
  | { readonly kind: 'output'; readonly text: string; readonly facts: ExecutionFacts }
  | { readonly kind: 'refusal'; readonly diagnostic: string; readonly facts: ExecutionFacts }
  | {
      readonly kind: 'authentication';
      readonly reason: 'CREDENTIAL_MISSING' | 'CREDENTIAL_REJECTED';
      readonly diagnostic: string;
      readonly facts: ExecutionFacts;
    }
  | {
      readonly kind: 'denied';
      readonly reason: DeniedReason;
      readonly diagnostic: string;
      readonly facts: ExecutionFacts;
    }
  | {
      readonly kind: 'malformed';
      readonly reason: MalformedKind;
      readonly diagnostic: string;
      readonly facts: ExecutionFacts;
    }
  | { readonly kind: 'timeout'; readonly diagnostic: string; readonly facts: ExecutionFacts }
  | { readonly kind: 'cancelled'; readonly diagnostic: string; readonly facts: ExecutionFacts };

/** The longest single argument that Linux passes to a program (MAX_ARG_STRLEN is 128 KiB). */
const ARGUMENT_LIMIT_BYTES = 120_000;
/** A worst case of JSON escaping around the result text, plus the fixed fields of the CLI result. */
const ESCAPE_FACTOR = 6;
const WRAPPER_BYTES = 65_536;

const NO_FACTS: ExecutionFacts = {
  executorVersion: undefined,
  sessionId: undefined,
  model: undefined,
  provider: undefined,
  effort: undefined,
  costUsd: undefined,
  inputTokens: undefined,
  outputTokens: undefined,
  durationMs: undefined,
  started: false,
};

/** The largest number of bytes of standard output that the runner reads for an output limit. */
export function stdoutCap(outputLimitBytes: number): number {
  return outputLimitBytes * ESCAPE_FACTOR + WRAPPER_BYTES;
}

export async function execute(config: ExecutorConfig, request: ExecutionRequest): Promise<ExecutionEnd> {
  await mkdir(config.scratchRoot, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(config.scratchRoot, 'attempt-'));
  try {
    return await executeIn(config, request, directory);
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 2 });
  }
}

async function executeIn(config: ExecutorConfig, request: ExecutionRequest, directory: string): Promise<ExecutionEnd> {
  const home = join(directory, 'home');
  const work = join(directory, 'work');
  const tmp = join(directory, 'tmp');
  for (const path of [home, work, tmp]) await mkdir(path, { mode: 0o700 });
  const passEnv = [...(config.credentialEnv ? [config.credentialEnv] : []), ...config.passEnv];
  const env = buildChildEnvironment({
    hostEnv: config.hostEnv,
    passEnv,
    allowProxyEnv: config.allowProxyEnv,
    home,
    tmp,
    path: config.childPath,
    fixed: executorFixedEnvironment(home),
  });
  const secrets = passEnv.flatMap((name) => {
    const value = config.hostEnv[name];
    return typeof value === 'string' ? [value] : [];
  });
  const say = (text: string) => diagnostic(text, secrets);

  // 1. The executable and its pinned version.
  const probe = await runProcess({
    command: config.path,
    args: ['--version'],
    cwd: work,
    env,
    stdin: undefined,
    timeoutMs: config.versionTimeoutMs,
    stdoutLimit: 4096,
    stderrLimit: 4096,
    signal: request.signal,
  });
  const denied = (reason: DeniedReason, text: string, facts: ExecutionFacts = NO_FACTS): ExecutionEnd => ({
    kind: 'denied',
    reason,
    diagnostic: say(text),
    facts,
  });
  if (probe.kind === 'not_started') {
    return probe.code === 'ENOENT' || probe.code === 'ENOTDIR'
      ? denied('EXECUTABLE_MISSING', 'the pinned executor is not installed at the configured path')
      : denied('CAPABILITY_DENIED', `the pinned executor cannot be started (${probe.code})`);
  }
  if (probe.kind === 'aborted') {
    return {
      kind: 'cancelled',
      diagnostic: say('the attempt was cancelled before the executor started'),
      facts: NO_FACTS,
    };
  }
  const installed =
    probe.kind === 'exited' && probe.exitCode === 0 ? parseCliVersion(probe.stdout.toString('utf8')) : undefined;
  if (installed === undefined) {
    return denied('CAPABILITY_UNSUPPORTED', 'the executor did not report a version for --version');
  }
  if (installed !== config.version) {
    return denied(
      'CAPABILITY_UNSUPPORTED',
      `the installed executor is version ${installed}, and this runner is pinned to ${config.version}`,
      { ...NO_FACTS, executorVersion: installed },
    );
  }
  const withVersion: ExecutionFacts = { ...NO_FACTS, executorVersion: installed };

  // 2. The credential. The child gets exactly this one secret.
  if (config.credentialEnv && !config.hostEnv[config.credentialEnv]) {
    return {
      kind: 'authentication',
      reason: 'CREDENTIAL_MISSING',
      diagnostic: say(`the model credential ${config.credentialEnv} is not set in the runner environment`),
      facts: withVersion,
    };
  }

  // 3. The run.
  const args = buildArguments({
    profile: request.profile,
    sessionUuid: cliSessionId(request.sessionId),
    budgetUsd: request.budgetUsd,
    systemPrompt: request.systemPrompt,
    bare: config.bare,
    resultSchema: config.enforceSchema ? request.resultSchema : undefined,
  });
  if (args.some((argument) => Buffer.byteLength(argument) > ARGUMENT_LIMIT_BYTES)) {
    return denied(
      'CAPABILITY_UNSUPPORTED',
      'an argument of the executor is longer than the system allows',
      withVersion,
    );
  }
  const end = await runProcess({
    command: config.path,
    args,
    cwd: work,
    env,
    stdin: request.request,
    timeoutMs: request.timeoutMs,
    stdoutLimit: stdoutCap(request.outputLimitBytes),
    stderrLimit: config.stderrLimit,
    signal: request.signal,
  });
  return interpret(request, end, withVersion, say);
}

/** Map the end of a run onto an execution outcome. Exported so that the table can be tested without a process. */
export function interpret(
  request: Pick<ExecutionRequest, 'sessionId' | 'profile' | 'outputLimitBytes' | 'timeoutMs' | 'budgetUsd'>,
  end: ProcessEnd,
  base: ExecutionFacts,
  say: (text: string) => string,
): ExecutionEnd {
  if (end.kind === 'not_started') {
    return {
      kind: 'denied',
      reason: end.code === 'ENOENT' ? 'EXECUTABLE_MISSING' : 'CAPABILITY_DENIED',
      diagnostic: say(`the executor could not be started (${end.code})`),
      facts: base,
    };
  }
  const durationMs = end.durationMs;
  const stderr = end.stderr.toString('utf8');
  const report = end.kind === 'exited' ? parseCliReport(end.stdout.toString('utf8')) : undefined;
  const facts: ExecutionFacts = { ...factsFrom(base, report, durationMs), started: true };

  if (end.kind === 'timeout') {
    return {
      kind: 'timeout',
      diagnostic: say(`the executor was ended at the deadline of ${Math.round(request.timeoutMs / 1000)} seconds`),
      facts,
    };
  }
  if (end.kind === 'aborted') {
    return { kind: 'cancelled', diagnostic: say('the attempt was cancelled and its process tree was ended'), facts };
  }
  if (end.kind === 'overflow') {
    return {
      kind: 'malformed',
      reason: 'OUTPUT_LIMIT_EXCEEDED',
      diagnostic: say(
        `the executor wrote more than ${stdoutCap(request.outputLimitBytes)} bytes; the process tree was ended`,
      ),
      facts,
    };
  }

  // The executor exited by itself.
  if (report?.stopReason === 'refusal') {
    return { kind: 'refusal', diagnostic: say('the model declined the task (stop reason refusal)'), facts };
  }
  const auth = authenticationFailure(report, stderr);
  if (
    auth !== undefined &&
    (report === undefined ? end.exitCode !== 0 : report.isError || report.subtype !== 'success')
  ) {
    return {
      kind: 'authentication',
      reason: auth,
      diagnostic: say(
        auth === 'CREDENTIAL_MISSING'
          ? 'the executor reports that no credential is available'
          : `the executor reports that the credential was rejected${report?.apiErrorStatus ? ` (status ${report.apiErrorStatus})` : ''}`,
      ),
      facts,
    };
  }
  if (report === undefined) {
    const how = end.signal ? `signal ${end.signal}` : `exit code ${end.exitCode ?? 'unknown'}`;
    return {
      kind: 'malformed',
      reason: 'NOT_JSON',
      diagnostic: say(`the executor ended with ${how} and wrote no result object; stderr: ${stderr.slice(0, 400)}`),
      facts,
    };
  }
  if (report.isError || report.subtype !== 'success') {
    const subtype = report.subtype ?? 'error';
    if (subtype === 'error_max_budget_usd') {
      return {
        kind: 'denied',
        reason: 'CAPABILITY_DENIED',
        diagnostic: say(`the executor stopped at the cost reservation of ${request.budgetUsd} USD`),
        facts,
      };
    }
    if (subtype === 'error_max_structured_output_retries') {
      return {
        kind: 'malformed',
        reason: 'SCHEMA_INVALID',
        diagnostic: say('the executor could not produce output that satisfies the result schema'),
        facts,
      };
    }
    const status = report.apiErrorStatus === undefined ? '' : ` (API status ${report.apiErrorStatus})`;
    return {
      kind: 'malformed',
      reason: 'NOT_JSON',
      diagnostic: say(`the executor ended with ${subtype}${status} and no usable result`),
      facts,
    };
  }
  if (report.resultText === undefined) {
    return { kind: 'malformed', reason: 'NOT_JSON', diagnostic: say('the executor result has no text'), facts };
  }
  const size = Buffer.byteLength(report.resultText);
  if (size > request.outputLimitBytes) {
    return {
      kind: 'malformed',
      reason: 'OUTPUT_LIMIT_EXCEEDED',
      diagnostic: say(`the output is ${size} bytes; the limit is ${request.outputLimitBytes}`),
      facts,
    };
  }
  const expected = cliSessionId(request.sessionId);
  if (report.sessionId !== undefined && report.sessionId !== expected) {
    return {
      kind: 'malformed',
      reason: 'IDENTITY_MISMATCH',
      diagnostic: say(`the executor reported session ${report.sessionId}, not the session ${expected} of the attempt`),
      facts,
    };
  }
  if (report.model !== undefined && !modelMatches(request.profile.model, report.model)) {
    return {
      kind: 'malformed',
      reason: 'IDENTITY_MISMATCH',
      diagnostic: say(
        `the executor reported the model ${report.model}, not the requested model ${request.profile.model}`,
      ),
      facts,
    };
  }
  return { kind: 'output', text: report.resultText, facts };
}

function factsFrom(base: ExecutionFacts, report: CliReport | undefined, durationMs: number): ExecutionFacts {
  return {
    ...base,
    sessionId: report?.sessionId,
    model: report?.model,
    provider: report?.provider,
    effort: report?.effort,
    costUsd: report?.costUsd,
    inputTokens: report?.inputTokens,
    outputTokens: report?.outputTokens,
    durationMs,
  };
}

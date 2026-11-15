// The evaluation harness `pnpm agents:eval` (OQ-03 section 6, OQ-06 section 7): fixture mode by default, and a live
// mode that refuses to run unless every guard holds. No test here starts the real executor or calls a model: the live
// path runs a script that stands in for it, and every refusal is checked before any process exists.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { fixtureFiles, readFixture } from '../../../packages/agents/dev/fixture-runner.ts';
import { responseText } from '../../../packages/agents/dev/world.ts';
import { finding } from '../../../packages/agents/test/support/requests.ts';
import type { ExecutionEnd, ExecutionRequest, ExecutorConfig } from '../src/executor.ts';
import { execute } from '../src/executor.ts';
import {
  type EvalArgs,
  type EvalReport,
  EXECUTOR_PATH_VARIABLE,
  EXECUTOR_VERSION_VARIABLE,
  KEY_VARIABLE,
  LIVE_CASES,
  liveRefusals,
  main,
  parseArgs,
  sessionMarkers,
} from '../tools/agents-eval.ts';
import { cleanup, installFakeCli, runnerRoot, scratch } from './support/world.ts';

afterEach(cleanup);

const OWNER_KEY = 'sk-ant-owner-key-0000000000000000000000';
const TOOL = resolve(runnerRoot, 'tools/agents-eval.ts');

function args(argv: string[]): EvalArgs {
  const parsed = parseArgs(argv);
  if (!parsed.ok) throw new Error(parsed.errors.join('; '));
  return parsed.args;
}

const LIVE_ARGV = ['--mode', 'live', '--allow-real-model-calls', '--max-budget-usd', '10'];

/** An environment that satisfies every guard: the owner's key, the pinned executor, and no session marker. */
function liveEnv(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    [KEY_VARIABLE]: OWNER_KEY,
    [EXECUTOR_PATH_VARIABLE]: '/opt/pinned/claude',
    [EXECUTOR_VERSION_VARIABLE]: '2.1.325',
    PATH: '/usr/bin:/bin',
    ...overrides,
  };
}

function collect() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, output: { out: (line: string) => out.push(line), err: (line: string) => err.push(line) } };
}

describe('the arguments', () => {
  it('default to fixture mode with no opt-in, one trial and the reservation of decision D22', () => {
    expect(args([])).toEqual({
      mode: 'fixture',
      allowRealModelCalls: false,
      allowProxyEnv: false,
      maxBudgetUsd: undefined,
      attemptUsd: 5,
      trials: 1,
      out: undefined,
    });
  });

  it('read every flag of the live mode', () => {
    expect(
      args([...LIVE_ARGV, '--allow-proxy-env', '--attempt-usd', '2.5', '--trials', '3', '--out', '/tmp/report.json']),
    ).toEqual({
      mode: 'live',
      allowRealModelCalls: true,
      allowProxyEnv: true,
      maxBudgetUsd: 10,
      attemptUsd: 2.5,
      trials: 3,
      out: '/tmp/report.json',
    });
  });

  it.each([
    [['--mode', 'real'], /--mode must be fixture or live/],
    [['--mode'], /--mode needs a value/],
    [['--trials', '0'], /--trials must be an integer from 1 to 5/],
    [['--trials', '6'], /--trials must be an integer from 1 to 5/],
    [['--max-budget-usd', '-1'], /--max-budget-usd must be a positive decimal/],
    [['--max-budget-usd', '1e3'], /--max-budget-usd must be a positive decimal/],
    [['--attempt-usd', '0'], /--attempt-usd must be a positive decimal/],
    [['--live'], /unknown argument --live/],
  ])('refuse %j', (argv, message) => {
    const parsed = parseArgs(argv);
    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.errors.join(' ')).toMatch(message);
  });
});

describe('the guards of the live mode', () => {
  it('pass for the opt-in, the owner key, the pinned executor, a budget and no session', () => {
    expect(liveRefusals(args(LIVE_ARGV), liveEnv())).toEqual([]);
  });

  it('name the flag when the opt-in is missing', () => {
    const reasons = liveRefusals(args(['--mode', 'live', '--max-budget-usd', '10']), liveEnv());
    expect(reasons).toEqual([expect.stringContaining('--allow-real-model-calls')]);
  });

  it('refuse a missing, empty or short key', () => {
    for (const value of [undefined, '', 'short']) {
      const reasons = liveRefusals(args(LIVE_ARGV), liveEnv({ [KEY_VARIABLE]: value }));
      expect(reasons).toEqual([expect.stringContaining(`the owner's key is not supplied: set ${KEY_VARIABLE}`)]);
    }
  });

  it.each(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'PACTWRIGHT_ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'])(
    'refuse the key when it is the %s of the session',
    (name) => {
      const env = liveEnv({ [name]: OWNER_KEY });
      const reasons = liveRefusals(args(LIVE_ARGV), env);
      expect(reasons.some((reason) => reason.includes('a credential of the session'))).toBe(true);
    },
  );

  it('accept a session credential that differs from the owner key, as long as it is not used', () => {
    const env = liveEnv({ ANTHROPIC_API_KEY: 'sk-ant-another-key-0000000000000000' });
    expect(liveRefusals(args(LIVE_ARGV), env)).toEqual([]);
  });

  it.each([
    'CLAUDECODE',
    'CLAUDE_CODE_ENTRYPOINT',
    'CLAUDE_CODE_REMOTE',
    'CLAUDE_CODE_SESSION_ID',
    'CCR_SESSION_PROFILE',
  ])('refuse a coding-agent session that sets %s', (name) => {
    const reasons = liveRefusals(args(LIVE_ARGV), liveEnv({ [name]: '1' }));
    expect(reasons).toEqual([expect.stringContaining('this is a coding-agent session')]);
    expect(reasons[0]).toContain(name);
  });

  it('list the session markers in order, and none for a clean environment', () => {
    expect(
      sessionMarkers({ CLAUDECODE: '1', CCR_B: 'x', CLAUDE_CODE_A: 'y', PATH: '/bin', CLAUDE_CODE_GONE: undefined }),
    ).toEqual(['CCR_B', 'CLAUDECODE', 'CLAUDE_CODE_A']);
    expect(sessionMarkers({ PATH: '/bin', CLAUDE_HOME: 'x' })).toEqual([]);
  });

  it('require the absolute path and the pinned version of the executor', () => {
    expect(liveRefusals(args(LIVE_ARGV), liveEnv({ [EXECUTOR_PATH_VARIABLE]: 'claude' }))).toEqual([
      expect.stringContaining('absolute path'),
    ]);
    expect(liveRefusals(args(LIVE_ARGV), liveEnv({ [EXECUTOR_PATH_VARIABLE]: undefined }))).toEqual([
      expect.stringContaining('absolute path'),
    ]);
    expect(liveRefusals(args(LIVE_ARGV), liveEnv({ [EXECUTOR_VERSION_VARIABLE]: '2.1' }))).toEqual([
      expect.stringContaining('pinned version'),
    ]);
  });

  it('require a budget that covers every attempt at its reservation, within the ceiling', () => {
    expect(liveRefusals(args(['--mode', 'live', '--allow-real-model-calls']), liveEnv())).toEqual([
      expect.stringContaining('--max-budget-usd is required'),
    ]);
    // Two cases of two trials at 5 USD reserve 20 USD.
    const short = liveRefusals(
      args([...LIVE_ARGV.slice(0, 3), '--max-budget-usd', '19.99', '--trials', '2']),
      liveEnv(),
    );
    expect(short).toEqual([expect.stringContaining('reserve 20 USD, above --max-budget-usd 19.99')]);
    expect(
      liveRefusals(args([...LIVE_ARGV.slice(0, 3), '--max-budget-usd', '20', '--trials', '2']), liveEnv()),
    ).toEqual([]);
    expect(liveRefusals(args([...LIVE_ARGV.slice(0, 3), '--max-budget-usd', '51']), liveEnv())).toEqual([
      expect.stringContaining('above the ceiling of 50 USD'),
    ]);
  });

  it('report every reason at once for an empty environment, as this session would', () => {
    const reasons = liveRefusals(args(['--mode', 'live']), { CLAUDECODE: '1' });
    expect(reasons).toHaveLength(6);
  });

  it('use two reviewed cases that exist as fixtures, one for each role module', () => {
    const names = fixtureFiles().map((file) => {
      const fixture = readFixture(file);
      return `${fixture.suite}/${fixture.id}`;
    });
    expect(LIVE_CASES.every((name) => names.includes(name))).toBe(true);
    expect(LIVE_CASES.map((name) => name.split('/')[0]).sort()).toEqual(['strategy-critique', 'strategy-formulation']);
  });
});

describe('main', () => {
  it('runs the offline suites in fixture mode by default, and says that no model was called', async () => {
    const { out, err, output } = collect();
    expect(await main([], {}, output)).toBe(0);
    expect(err).toEqual([]);
    expect(out.at(-1)).toMatch(
      /^\d+ synthetic fixtures \(strategy-formulation \d+, strategy-critique \d+\), 0 failed\. Fixture mode: no model was called/,
    );
    expect(out.filter((line) => line.startsWith('FAIL'))).toEqual([]);
  });

  it('refuses the live flags in fixture mode instead of ignoring them', async () => {
    const { err, output } = collect();
    expect(await main(['--allow-real-model-calls'], {}, output)).toBe(2);
    expect(err.join('\n')).toMatch(/belong to --mode live/);
  });

  it('prints its usage for --help and for a bad argument', async () => {
    const help = collect();
    expect(await main(['--help'], {}, help.output)).toBe(0);
    expect(help.out.join('\n')).toMatch(/Usage: pnpm agents:eval/);
    const bad = collect();
    expect(await main(['--nonsense'], {}, bad.output)).toBe(2);
    expect(bad.err.join('\n')).toMatch(/unknown argument --nonsense/);
  });

  it('refuses a live run without the opt-in or the key, and does not touch the executor', async () => {
    let calls = 0;
    const deps = {
      execute: async (): Promise<ExecutionEnd> => {
        calls += 1;
        throw new Error('the executor must not be reached');
      },
      now: () => Date.now(),
    };
    for (const [argv, env] of [
      [['--mode', 'live'], liveEnv()],
      [LIVE_ARGV, liveEnv({ [KEY_VARIABLE]: undefined })],
      [LIVE_ARGV, liveEnv({ CLAUDECODE: '1' })],
    ] as const) {
      const { err, output } = collect();
      expect(await main(argv, env, output, deps)).toBe(2);
      expect(err.join('\n')).toMatch(/refused to run\. No model was called and no process was started/);
    }
    expect(calls).toBe(0);
  });

  it('never prints the key', async () => {
    const { out, err, output } = collect();
    await main(LIVE_ARGV, liveEnv({ CLAUDECODE: '1' }), output);
    expect([...out, ...err].join('\n')).not.toContain(OWNER_KEY);
  });
});

describe('the live mode with a script that stands in for the executor', () => {
  async function scenarioTexts() {
    const byName = new Map(
      fixtureFiles().map((file) => {
        const fixture = readFixture(file);
        return [`${fixture.suite}/${fixture.id}`, fixture] as const;
      }),
    );
    const formulation = byName.get('strategy-formulation/valid-revision-entry');
    const critique = byName.get('strategy-critique/causal-leak-candidate');
    if (!formulation || !critique) throw new Error('the live fixtures are missing');
    return {
      'strategy-formulation': await responseText(formulation),
      'strategy-critique': await responseText(critique),
    };
  }

  async function runLive(extra: string[] = [], env: Record<string, string | undefined> = {}) {
    const cli = installFakeCli({ behaviour: 'result', resultByRole: await scenarioTexts() });
    const target = join(scratch('oq-eval-report-'), 'report.json');
    const { out, err, output } = collect();
    // The default executor of the harness is the real one; here it is pointed at the stand-in script by the path
    // variable, and the host environment of the process under test is the explicit one below.
    const environment = liveEnv({
      [EXECUTOR_PATH_VARIABLE]: cli.path,
      SOME_HOST_SECRET: 'host-secret-value-not-for-the-child',
      HTTPS_PROXY: 'http://proxy.invalid:3128',
      SSL_CERT_FILE: '/etc/ssl/ca.invalid',
      ...env,
    });
    const code = await main([...LIVE_ARGV, '--out', target, ...extra], environment, output, {
      execute: (config: ExecutorConfig, request: ExecutionRequest) => execute(config, request),
      now: () => Date.now(),
    });
    return { code, out, err, cli, report: JSON.parse(readFileSync(target, 'utf8')) as EvalReport, target };
  }

  it('runs both reviewed cases through the production path and writes a report with the actual model', async () => {
    const run = await runLive();
    expect(run.err).toEqual([]);
    expect(run.code).toBe(0);
    expect(run.report.label).toBe('real-model evaluation');
    expect(run.report.executor_version).toBe('2.1.325');
    expect(run.report.reserved_usd).toBe(10);
    expect(
      run.report.trials.map((item) => [item.case, item.outcome, item.valid, item.detected, item.unlabelled_findings]),
    ).toEqual([
      ['strategy-formulation/valid-revision-entry', 'completion', true, null, null],
      ['strategy-critique/causal-leak-candidate', 'completion', true, true, 0],
    ]);
    for (const trial of run.report.trials) {
      expect(trial.model).toBe('claude-opus-5-5');
      expect(trial.cost_usd).toBe('0.0123456');
      expect(trial.input_tokens).toBe(115);
      expect(trial.duration_ms).not.toBeNull();
    }
    expect(run.out.at(-1)).toMatch(/^Report written to .*report\.json\./);
    // The same executor path as production: the pinned flags, no tool, the bundle's procedure as the system prompt.
    const runs = run.cli.calls().filter((call) => call.kind === 'run');
    expect(runs).toHaveLength(2);
    for (const call of runs) {
      expect(call.args).toEqual(
        expect.arrayContaining(['--tools', '', '--setting-sources', '', '--no-session-persistence']),
      );
    }
  });

  it('counts the findings outside the labelled categories as possible false positives, and not method advice', async () => {
    const texts = await scenarioTexts();
    const critique = JSON.parse(texts['strategy-critique']) as { findings: unknown[] };
    critique.findings.push(finding({ category: 'portfolio_fit' }), finding({ category: 'method_advice' }));
    const cli = installFakeCli({
      behaviour: 'result',
      resultByRole: { ...texts, 'strategy-critique': JSON.stringify(critique) },
    });
    const target = join(scratch('oq-eval-report-'), 'report.json');
    const code = await main(
      [...LIVE_ARGV, '--out', target],
      liveEnv({ [EXECUTOR_PATH_VARIABLE]: cli.path }),
      collect().output,
      {
        execute: (config: ExecutorConfig, request: ExecutionRequest) => execute(config, request),
        now: () => Date.now(),
      },
    );
    expect(code).toBe(0);
    const report = JSON.parse(readFileSync(target, 'utf8')) as EvalReport;
    expect(report.trials[1]).toMatchObject({ valid: true, detected: true, unlabelled_findings: 1 });
  });

  it('gives the child the owner key and nothing else of the environment, and no proxy variable by default', async () => {
    const run = await runLive();
    for (const call of run.cli.calls()) {
      expect(call.env.ANTHROPIC_API_KEY).toBe(OWNER_KEY);
      const text = JSON.stringify(call.env);
      expect(text).not.toContain('host-secret-value-not-for-the-child');
      expect(call.env.HTTPS_PROXY).toBeUndefined();
      expect(call.env.SSL_CERT_FILE).toBeUndefined();
    }
    expect(JSON.stringify(run.report)).not.toContain(OWNER_KEY);
    expect(run.out.join('\n') + run.err.join('\n')).not.toContain(OWNER_KEY);
  });

  it('passes proxy and certificate variables only behind --allow-proxy-env', async () => {
    const run = await runLive(['--allow-proxy-env']);
    const first = run.cli.calls().find((call) => call.kind === 'run');
    expect(first?.env.HTTPS_PROXY).toBe('http://proxy.invalid:3128');
    expect(first?.env.SSL_CERT_FILE).toBe('/etc/ssl/ca.invalid');
    expect(JSON.stringify(first?.env)).not.toContain('host-secret-value-not-for-the-child');
  });

  it('exits with 1 when an attempt could not run, and keeps what it measured', async () => {
    const cli = installFakeCli({ behaviour: 'result', resultByRole: {}, version: '9.9.9' });
    const target = join(scratch('oq-eval-report-'), 'report.json');
    const { output } = collect();
    const code = await main([...LIVE_ARGV, '--out', target], liveEnv({ [EXECUTOR_PATH_VARIABLE]: cli.path }), output, {
      execute: (config: ExecutorConfig, request: ExecutionRequest) => execute(config, request),
      now: () => Date.now(),
    });
    expect(code).toBe(1);
    const report = JSON.parse(readFileSync(target, 'utf8')) as EvalReport;
    expect(report.trials.map((item) => item.outcome)).toEqual(['denied_capability', 'denied_capability']);
  });
});

describe('the command as a program', () => {
  const run = (argv: string[], env: Record<string, string>) =>
    spawnSync(process.execPath, [TOOL, ...argv], { env, encoding: 'utf8', cwd: runnerRoot, timeout: 60_000 });

  it('refuses live mode in a coding-agent session, with every other guard satisfied, and starts no executor', () => {
    const cli = installFakeCli({ behaviour: 'result', resultText: '{}' });
    const result = run(LIVE_ARGV, {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      CLAUDECODE: '1',
      [KEY_VARIABLE]: OWNER_KEY,
      [EXECUTOR_PATH_VARIABLE]: cli.path,
      [EXECUTOR_VERSION_VARIABLE]: '2.1.325',
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/this is a coding-agent session \(CLAUDECODE\)/);
    expect(result.stderr).toMatch(/No model was called and no process was started/);
    expect(result.stderr).not.toContain(OWNER_KEY);
    expect(cli.calls()).toEqual([]);
  });

  it('refuses live mode with an empty environment and exits 2', () => {
    const result = run(['--mode', 'live'], { PATH: process.env.PATH ?? '/usr/bin:/bin' });
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/--allow-real-model-calls/);
  });

  it('runs the offline suites by default and exits 0', () => {
    const result = run([], { PATH: process.env.PATH ?? '/usr/bin:/bin' });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/0 failed\. Fixture mode: no model was called/);
  });
});

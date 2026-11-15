import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cliSessionId } from '../src/cli.ts';
import { type ExecutionRequest, execute, interpret, stdoutCap } from '../src/executor.ts';
import {
  cleanup,
  HOST_SECRET,
  installFakeCli,
  isAlive,
  MODEL_KEY,
  makeWorld,
  type Scenario,
  scratch,
  until,
  type World,
} from './support/world.ts';

afterEach(cleanup);

const REQUEST_BYTES = Buffer.from('{"synthetic":"request"}\n', 'utf8');

function request(overrides: Partial<ExecutionRequest> = {}): ExecutionRequest {
  return {
    sessionId: 'session-attempt-1',
    profile: { model: 'claude-opus-5-5', effort: 'executor_default' },
    timeoutMs: 20_000,
    outputLimitBytes: 4096,
    budgetUsd: '5',
    systemPrompt: '---\nprocedure text\n---',
    request: REQUEST_BYTES,
    resultSchema: { type: 'object' },
    signal: undefined,
    ...overrides,
  };
}

function run(world: World, overrides: Partial<ExecutionRequest> = {}) {
  return execute(world.config.executor, request(overrides));
}

const ok = (resultText = '{"a":1}', extra: Partial<Scenario> = {}): Scenario => ({
  behaviour: 'result',
  resultText,
  ...extra,
});

describe('a successful run', () => {
  it('returns the text of the result with the facts the host captured', async () => {
    const world = makeWorld(ok());
    const end = await run(world);
    expect(end).toMatchObject({ kind: 'output', text: '{"a":1}' });
    if (end.kind !== 'output') return;
    expect(end.facts).toMatchObject({
      executorVersion: '2.1.325',
      model: 'claude-opus-5-5',
      provider: 'firstParty',
      effort: undefined,
      costUsd: 0.0123456,
      inputTokens: 115,
      outputTokens: 20,
      started: true,
      sessionId: cliSessionId('session-attempt-1'),
    });
    expect(end.facts.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('hands the exact request bytes to standard input and the procedure to the system prompt', async () => {
    const world = makeWorld({ behaviour: 'echo-stdin' });
    const end = await run(world);
    expect(end).toMatchObject({ kind: 'output', text: REQUEST_BYTES.toString('utf8') });
    const call = world.cli.calls().find((entry) => entry.kind === 'run');
    expect(call?.stdinBytes).toBe(REQUEST_BYTES.length);
    expect(call?.args).toContain('--system-prompt=---\nprocedure text\n---');
    expect(call?.args?.join('\n')).not.toContain('synthetic');
  });

  it('runs the recipe: no tool, no setting source, no stored session, the requested model, a derived session', async () => {
    const world = makeWorld(ok());
    await run(world, { profile: { model: 'claude-sonnet-5-5', effort: 'high' } });
    const args = world.cli.calls().find((entry) => entry.kind === 'run')?.args ?? [];
    const at = (flag: string) => args[args.indexOf(flag) + 1];
    expect(args[0]).toBe('-p');
    expect(at('--output-format')).toBe('json');
    expect(at('--model')).toBe('claude-sonnet-5-5');
    expect(at('--effort')).toBe('high');
    expect(at('--tools')).toBe('');
    expect(at('--setting-sources')).toBe('');
    expect(at('--session-id')).toBe(cliSessionId('session-attempt-1'));
    expect(at('--max-budget-usd')).toBe('5');
    expect(args).toContain('--no-session-persistence');
    expect(args).toContain('--strict-mcp-config');
    expect(args).toContain('--bare');
    expect(args.some((argument) => argument.startsWith('--json-schema'))).toBe(false);
  });

  it('adds the result schema as a guard only when the configuration turns it on', async () => {
    const world = makeWorld(ok(), { executor: { enforceSchema: true } });
    await run(world);
    const args = world.cli.calls().find((entry) => entry.kind === 'run')?.args ?? [];
    expect(args).toContain('--json-schema={"type":"object"}');
  });
});

describe('isolation of the child', () => {
  it('never gives the child a secret of the host, only the model credential and the fixed variables', async () => {
    const world = makeWorld({ behaviour: 'dump-env' });
    const end = await run(world);
    if (end.kind !== 'output') throw new Error(end.kind);
    const seen = (JSON.parse(end.text) as { env: Record<string, string> }).env;
    const names = Object.keys(seen)
      .filter((name) => !['PWD', 'SHLVL', '_', 'OLDPWD'].includes(name))
      .sort();
    expect(names).toEqual(
      [
        'ANTHROPIC_API_KEY',
        'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
        'CLAUDE_CONFIG_DIR',
        'DISABLE_AUTOUPDATER',
        'DISABLE_ERROR_REPORTING',
        'DISABLE_TELEMETRY',
        'HOME',
        'LANG',
        'LC_ALL',
        'NO_COLOR',
        'PATH',
        'TMPDIR',
        'TZ',
      ].sort(),
    );
    expect(seen.ANTHROPIC_API_KEY).toBe(MODEL_KEY);
    expect(JSON.stringify(seen)).not.toContain(HOST_SECRET);
    expect(seen.PATH).toBe('/usr/bin:/bin');
  });

  it('does not read the real process environment either', async () => {
    process.env.OQ_TEST_PROCESS_SECRET = 'process-secret-0123456789';
    try {
      const world = makeWorld({ behaviour: 'dump-env' });
      const end = await run(world);
      if (end.kind !== 'output') throw new Error(end.kind);
      expect(end.text).not.toContain('process-secret-0123456789');
      expect(end.text).not.toContain('OQ_TEST_PROCESS_SECRET');
    } finally {
      delete process.env.OQ_TEST_PROCESS_SECRET;
    }
  });

  it('passes proxy and certificate variables only behind the explicit test flag', async () => {
    const without = makeWorld({ behaviour: 'dump-env' });
    const withoutEnd = await run(without);
    if (withoutEnd.kind !== 'output') throw new Error(withoutEnd.kind);
    for (const name of ['HTTPS_PROXY', 'SSL_CERT_FILE']) expect(withoutEnd.text).not.toContain(name);

    const withFlag = makeWorld({ behaviour: 'dump-env' }, { executor: { allowProxyEnv: true } });
    const withEnd = await run(withFlag);
    if (withEnd.kind !== 'output') throw new Error(withEnd.kind);
    const seen = (JSON.parse(withEnd.text) as { env: Record<string, string> }).env;
    expect(seen.HTTPS_PROXY).toBe('http://proxy.invalid:3128');
    expect(seen.SSL_CERT_FILE).toBe('/etc/ssl/ca.invalid');
    expect(seen).not.toHaveProperty('CLOUDFLARE_API_TOKEN');
  });

  it('gives every attempt a fresh empty HOME, a fresh empty working directory and a fresh session, and removes them', async () => {
    const world = makeWorld(ok());
    await run(world, { sessionId: 'session-a' });
    await run(world, { sessionId: 'session-b' });
    const runs = world.cli.calls().filter((entry) => entry.kind === 'run');
    expect(runs).toHaveLength(2);
    const [first, second] = runs;
    expect(first?.env.HOME).not.toBe(second?.env.HOME);
    expect(first?.cwd).not.toBe(second?.cwd);
    expect(first?.env.TMPDIR).not.toBe(second?.env.TMPDIR);
    const sessions = runs.map((entry) => entry.args?.[(entry.args?.indexOf('--session-id') ?? 0) + 1]);
    expect(new Set(sessions).size).toBe(2);
    for (const entry of runs) {
      // Nothing of an earlier attempt: the directories are empty when the CLI starts.
      expect(entry.homeEntries).toEqual([]);
      expect(entry.cwdEntries).toEqual([]);
      expect(entry.env.HOME?.startsWith(world.scratchRoot)).toBe(true);
      expect(entry.cwd.startsWith(world.scratchRoot)).toBe(true);
      expect(entry.cwd).not.toBe(entry.env.HOME);
      expect(entry.env.CLAUDE_CONFIG_DIR).toBe(`${entry.env.HOME}/.claude`);
    }
    // Everything of the attempts is gone afterwards.
    expect(readdirSync(world.scratchRoot)).toEqual([]);
  });

  it('removes the attempt directory even when the executor fails', async () => {
    const world = makeWorld({ behaviour: 'raw', stdout: 'garbage', exitCode: 1 });
    await run(world);
    expect(readdirSync(world.scratchRoot)).toEqual([]);
  });
});

describe('what is denied before the model is called', () => {
  it('denies a missing executable and starts nothing', async () => {
    const world = makeWorld(ok(), { executor: { path: join(scratch(), 'no-such-claude') } });
    const end = await run(world);
    expect(end).toMatchObject({ kind: 'denied', reason: 'EXECUTABLE_MISSING', facts: { started: false } });
  });

  it('denies an executable that cannot be run', async () => {
    const dir = scratch();
    const path = join(dir, 'claude');
    (await import('node:fs')).writeFileSync(path, 'x', { mode: 0o644 });
    const world = makeWorld(ok(), { executor: { path } });
    expect(await run(world)).toMatchObject({ kind: 'denied', reason: 'CAPABILITY_DENIED' });
  });

  it('denies a version other than the pinned one and never runs the model', async () => {
    const world = makeWorld(ok(), {});
    const other = installFakeCli({ ...ok(), version: '2.1.999' });
    const end = await execute({ ...world.config.executor, path: other.path }, request());
    expect(end).toMatchObject({
      kind: 'denied',
      reason: 'CAPABILITY_UNSUPPORTED',
      facts: { executorVersion: '2.1.999', started: false },
    });
    expect(end.kind === 'denied' && end.diagnostic).toMatch(/2\.1\.999.*2\.1\.325/);
    expect(other.calls().map((call) => call.kind)).toEqual(['version']);
  });

  it('denies an executable that reports no version', async () => {
    const world = makeWorld({ behaviour: 'result', versionExit: 1 });
    expect(await run(world)).toMatchObject({ kind: 'denied', reason: 'CAPABILITY_UNSUPPORTED' });
    expect(world.cli.calls().map((call) => call.kind)).toEqual(['version']);
  });

  it('reports a missing model credential without running the model', async () => {
    const world = makeWorld(ok());
    const { ANTHROPIC_API_KEY: _removed, ...rest } = world.config.executor.hostEnv;
    const end = await execute({ ...world.config.executor, hostEnv: rest }, request());
    expect(end).toMatchObject({ kind: 'authentication', reason: 'CREDENTIAL_MISSING', facts: { started: false } });
    expect(world.cli.calls().filter((call) => call.kind === 'run')).toEqual([]);
  });

  it('refuses an argument that is longer than the system accepts', async () => {
    const world = makeWorld(ok());
    const end = await run(world, { systemPrompt: 'x'.repeat(130_000) });
    expect(end).toMatchObject({ kind: 'denied', reason: 'CAPABILITY_UNSUPPORTED' });
    expect(world.cli.calls().filter((call) => call.kind === 'run')).toEqual([]);
  });

  it('cancels at once when the signal is already aborted', async () => {
    const world = makeWorld(ok());
    const controller = new AbortController();
    controller.abort('cancel');
    expect(await run(world, { signal: controller.signal })).toMatchObject({ kind: 'cancelled' });
    expect(world.cli.calls().filter((call) => call.kind === 'run')).toEqual([]);
  });
});

describe('what the executor reports', () => {
  it('maps an authentication failure of the executor to a rejected credential', async () => {
    const world = makeWorld({
      behaviour: 'result',
      report: { is_error: true, api_error_status: 401, result: `Invalid API key ${MODEL_KEY}` },
      exitCode: 1,
    });
    const end = await run(world);
    expect(end).toMatchObject({ kind: 'authentication', reason: 'CREDENTIAL_REJECTED' });
    // The diagnostic never repeats the credential, even when the executor does.
    expect(end.kind === 'authentication' && end.diagnostic).not.toContain(MODEL_KEY);
  });

  it('maps a refusal of the model to a refusal, not to a malformed result', async () => {
    const world = makeWorld(ok("I can't help with that.", { report: { stop_reason: 'refusal' } }));
    expect(await run(world)).toMatchObject({ kind: 'refusal' });
  });

  it('maps output that is over the limit to a malformed result with the limit reason', async () => {
    const world = makeWorld(ok('x'.repeat(5000)));
    expect(await run(world, { outputLimitBytes: 4096 })).toMatchObject({
      kind: 'malformed',
      reason: 'OUTPUT_LIMIT_EXCEEDED',
    });
  });

  it('ends the tree and reports an overflow when the executor floods standard output', async () => {
    const world = makeWorld({ behaviour: 'flood' });
    const started = Date.now();
    const end = await run(world, { outputLimitBytes: 1024 });
    expect(end).toMatchObject({ kind: 'malformed', reason: 'OUTPUT_LIMIT_EXCEEDED', facts: { started: true } });
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it('maps a session in the report that is not the session of the attempt to an identity mismatch', async () => {
    const world = makeWorld(ok('{}', { reportedSession: '11111111-1111-4111-8111-111111111111' }));
    const end = await run(world);
    expect(end).toMatchObject({ kind: 'malformed', reason: 'IDENTITY_MISMATCH' });
    expect(end.kind === 'malformed' && end.diagnostic).toMatch(/session/);
  });

  it('maps a model in the report that is not the requested model to an identity mismatch', async () => {
    const world = makeWorld(ok('{}', { reportedModel: 'claude-sonnet-5-5' }));
    const end = await run(world);
    expect(end).toMatchObject({ kind: 'malformed', reason: 'IDENTITY_MISMATCH' });
    expect(end.kind === 'malformed' && end.diagnostic).toMatch(/claude-sonnet-5-5/);
  });

  it('accepts a dated snapshot of the requested model and records it as reported', async () => {
    const world = makeWorld(ok('{}', { reportedModel: 'claude-opus-5-5-20261001' }));
    expect(await run(world)).toMatchObject({ kind: 'output', facts: { model: 'claude-opus-5-5-20261001' } });
  });

  it('treats a report without a session or a model as unknown, not as a mismatch', async () => {
    const world = makeWorld(ok('{}', { omit: ['session_id', 'modelUsage', 'total_cost_usd', 'usage'] }));
    const end = await run(world);
    expect(end).toMatchObject({
      kind: 'output',
      facts: {
        sessionId: undefined,
        model: undefined,
        costUsd: undefined,
        inputTokens: undefined,
        outputTokens: undefined,
      },
    });
  });

  it('maps the budget stop of the executor to a denial of capability and keeps the usage it reported', async () => {
    const world = makeWorld(
      ok('', { report: { is_error: true, subtype: 'error_max_budget_usd', total_cost_usd: 5.01 } }),
    );
    const end = await run(world, { budgetUsd: '5' });
    expect(end).toMatchObject({ kind: 'denied', reason: 'CAPABILITY_DENIED', facts: { costUsd: 5.01, started: true } });
  });

  it('maps the other error results to a malformed result that is retried within the cap', async () => {
    for (const subtype of ['error_during_execution', 'error_max_turns']) {
      const world = makeWorld(ok('', { report: { is_error: true, subtype, api_error_status: 529 } }));
      const end = await run(world);
      expect(end, subtype).toMatchObject({ kind: 'malformed', reason: 'NOT_JSON' });
      expect(end.kind === 'malformed' && end.diagnostic).toContain(subtype);
    }
    const world = makeWorld(ok('', { report: { is_error: true, subtype: 'error_max_structured_output_retries' } }));
    expect(await run(world)).toMatchObject({ kind: 'malformed', reason: 'SCHEMA_INVALID' });
  });

  it('maps standard output that is not a result object to NOT_JSON, with a bounded diagnostic', async () => {
    const world = makeWorld({ behaviour: 'raw', stdout: 'I am not JSON', stderr: 'oops', exitCode: 0 });
    const end = await run(world);
    expect(end).toMatchObject({ kind: 'malformed', reason: 'NOT_JSON' });
    expect(end.kind === 'malformed' && end.diagnostic.length).toBeLessThanOrEqual(2000);
  });

  it('maps an executor that was ended by a signal to NOT_JSON', async () => {
    const world = makeWorld({ behaviour: 'crash' });
    const end = await run(world);
    expect(end).toMatchObject({ kind: 'malformed', reason: 'NOT_JSON' });
    expect(end.kind === 'malformed' && end.diagnostic).toContain('SIGABRT');
  });
});

describe('time and cancellation', () => {
  it('ends a hung executor at the deadline and kills the whole tree', async () => {
    const pidFile = join(scratch(), 'pid');
    const world = makeWorld({ behaviour: 'grandchild', pidFile });
    const end = await run(world, { timeoutMs: 800 });
    expect(end).toMatchObject({ kind: 'timeout', facts: { started: true } });
    expect(end.kind === 'timeout' && end.diagnostic).toMatch(/deadline/);
    const pid = Number(readFileSync(pidFile, 'utf8'));
    await until(() => !isAlive(pid), 5000);
    expect(readdirSync(world.scratchRoot)).toEqual([]);
  });

  it('kills a descendant that is left behind when the executor itself finishes', async () => {
    const pidFile = join(scratch(), 'pid');
    const world = makeWorld({ behaviour: 'grandchild', pidFile, afterSpawn: 'exit', resultText: '{}' });
    expect(await run(world)).toMatchObject({ kind: 'output' });
    const pid = Number(readFileSync(pidFile, 'utf8'));
    await until(() => !isAlive(pid), 5000);
  });

  it('cancels a running executor on the abort signal', async () => {
    const world = makeWorld({ behaviour: 'hang' });
    const controller = new AbortController();
    const running = run(world, { signal: controller.signal });
    await until(() => world.cli.calls().some((call) => call.kind === 'run'));
    controller.abort('cancel');
    expect(await running).toMatchObject({ kind: 'cancelled', facts: { started: true } });
    expect(existsSync(world.scratchRoot) ? readdirSync(world.scratchRoot) : []).toEqual([]);
  });
});

describe('interpret', () => {
  const base = {
    executorVersion: '2.1.325',
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
  const say = (text: string) => text;

  it('maps a process that could not start to a denial', () => {
    const asked = {
      sessionId: 's',
      profile: { model: 'm', effort: 'executor_default' as const },
      outputLimitBytes: 10,
      timeoutMs: 1000,
      budgetUsd: '5',
    };
    expect(interpret(asked, { kind: 'not_started', code: 'ENOENT', message: '' }, base, say)).toMatchObject({
      kind: 'denied',
      reason: 'EXECUTABLE_MISSING',
    });
    expect(interpret(asked, { kind: 'not_started', code: 'EACCES', message: '' }, base, say)).toMatchObject({
      kind: 'denied',
      reason: 'CAPABILITY_DENIED',
    });
  });

  it('sizes the standard-output cap from the output limit', () => {
    expect(stdoutCap(524288)).toBe(524288 * 6 + 65536);
  });
});

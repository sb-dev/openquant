// The commands of the CLI against a fake API: login and the 0600 credentials file, the token renewal, stable exit
// codes, authority refusals, the journal of commands whose outcome is unknown, resynchronisation after a stale revision,
// the read-back after a command, and the confirmation of a consequential command in a terminal.

import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EXIT } from '../src/outcome.ts';
import {
  ACCESS_TOKEN,
  accessToken,
  apiError,
  CREDENTIAL,
  type Doc,
  fixture,
  type Harness,
  harness,
  TestInput,
  TestOutput,
  until,
} from './support.ts';

let cli: Harness;
beforeEach(() => {
  cli = harness();
});
afterEach(() => {
  cli.cleanup();
});

const mission = fixture('mission-view.concluded.json');
const created = { ...mission, status: 'CREATED', revision: 1 };
const budgetFile = (name = 'budget.json') => {
  const path = resolve(cli.configDir, name);
  writeFileSync(path, JSON.stringify(fixture('command.register-budget.json').payload.budget));
  return path;
};
const statusFor = (body: string | undefined, record = { id: 'staging-period-cap', revision: 1 }): Doc => {
  const request = JSON.parse(body ?? '{}');
  return {
    schema_version: 'command/1',
    form: 'status',
    command_id: request.command_id,
    kind: request.payload.kind,
    state: 'APPLIED',
    received_at: '2026-11-15T10:00:00Z',
    applied_at: '2026-11-15T10:00:00Z',
    record,
  };
};
const posts = () => cli.api.sent.filter((sent) => sent.method === 'POST' && sent.path !== '/v1/auth/token');

describe('login', () => {
  it('stores the credential and the token in a 0600 file and never prints either', async () => {
    const run = await cli.login(['Steward']);
    expect(run.exit).toBe(EXIT.OK);
    const file = resolve(cli.configDir, 'credentials.json');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(cli.configDir).mode & 0o777).toBe(0o700);
    for (const text of [run.stdout.text, run.stderr.text]) {
      expect(text).not.toContain(CREDENTIAL);
      expect(text).not.toContain(ACCESS_TOKEN);
      expect(text).not.toContain('c2VjcmV0');
    }
    expect(run.stdout.text).toContain('Logged in as Researcher (human-researcher)');
    expect(run.stdout.text).toContain('roles: Steward');
    const json = await cli.run(['login', '--api', 'https://api.example.test', '--json'], { stdin: `${CREDENTIAL}\n` });
    expect(json.stdout.text).not.toContain(CREDENTIAL);
    expect(json.stdout.text).not.toContain(ACCESS_TOKEN);
    expect(JSON.parse(json.stdout.text).data.environment).toBe('DEVELOPMENT');
  });

  it('refuses a refused credential with exit 3 and stores nothing, and refuses an http address that is not local', async () => {
    cli.api.on('POST', '/v1/auth/token', () => ({ status: 401, body: apiError('UNAUTHENTICATED') }));
    const refused = await cli.run(['login', '--api', 'https://api.example.test'], { stdin: 'oqk1.wrong\n' });
    expect(refused.exit).toBe(EXIT.UNAUTHENTICATED);
    expect(refused.stderr.text).not.toContain('oqk1.wrong');
    expect(() => statSync(resolve(cli.configDir, 'credentials.json'))).toThrow();
    const plain = await cli.run(['login', '--api', 'http://api.example.test'], { stdin: `${CREDENTIAL}\n` });
    expect(plain.exit).toBe(EXIT.USAGE);
    expect(plain.stderr.text).toContain('must use https');
    expect(cli.api.sent.filter((sent) => sent.headers.authorization === `Bearer ${CREDENTIAL}`)).toEqual([]);
  });

  it('refuses a credentials file that other users can read', async () => {
    await cli.login();
    const file = resolve(cli.configDir, 'credentials.json');
    const { chmodSync } = await import('node:fs');
    chmodSync(file, 0o644);
    const run = await cli.run(['mission', 'show', 'msn-00000a']);
    expect(run.exit).toBe(EXIT.UNAUTHENTICATED);
    expect(run.stderr.text).toContain('mode 0644');
    expect(cli.api.sent.filter((sent) => sent.path === '/v1/missions/msn-00000a')).toEqual([]);
  });

  it('renews an expired access token with the stored credential', async () => {
    await cli.login();
    let issued = 0;
    cli.api.on('POST', '/v1/auth/token', () => {
      issued += 1;
      return { status: 200, body: accessToken(['Researcher'], `oqa1.renewed-${issued}`) };
    });
    cli.api.on('GET', '/v1/missions/msn-00000a', (sent) =>
      sent.headers.authorization === 'Bearer oqa1.renewed-1'
        ? { status: 200, body: mission }
        : { status: 401, body: apiError('UNAUTHENTICATED') },
    );
    // The stored token expires at 10:15; renew it as if 10:14:30 were now.
    const stored = JSON.parse(
      (await import('node:fs')).readFileSync(resolve(cli.configDir, 'credentials.json'), 'utf8'),
    );
    stored.access_token_expires_at = '2026-11-15T10:00:30Z';
    writeFileSync(resolve(cli.configDir, 'credentials.json'), JSON.stringify(stored), { mode: 0o600 });
    const run = await cli.run(['mission', 'show', 'msn-00000a']);
    expect(run.exit).toBe(EXIT.OK);
    expect(issued).toBe(1);
    const after = JSON.parse(
      (await import('node:fs')).readFileSync(resolve(cli.configDir, 'credentials.json'), 'utf8'),
    );
    expect(after.access_token).toBe('oqa1.renewed-1');
    expect(statSync(resolve(cli.configDir, 'credentials.json')).mode & 0o777).toBe(0o600);
  });
});

describe('exit codes', () => {
  it('are stable for usage, login, not found, unavailable and an invalid answer', async () => {
    expect((await cli.run([])).exit).toBe(EXIT.USAGE);
    expect((await cli.run(['--help'])).exit).toBe(EXIT.OK);
    expect((await cli.run(['frobnicate'])).exit).toBe(EXIT.USAGE);
    expect((await cli.run(['mission', 'show'])).exit).toBe(EXIT.USAGE);
    expect((await cli.run(['mission', 'show', 'a', '--file', 'x'])).exit).toBe(EXIT.USAGE);
    expect((await cli.run(['mission', 'show', 'msn-1'])).exit).toBe(EXIT.UNAUTHENTICATED);
    await cli.login();
    expect((await cli.run(['mission', 'show', 'msn-missing'])).exit).toBe(EXIT.NOT_FOUND);
    cli.api.on('GET', '/v1/missions/down', () => ({
      status: 503,
      body: apiError('UNAVAILABLE', { retry_safe: true }),
    }));
    expect((await cli.run(['mission', 'show', 'down'])).exit).toBe(EXIT.UNAVAILABLE);
    cli.api.on('GET', '/v1/missions/lost', () => 'network-failure');
    expect((await cli.run(['mission', 'show', 'lost'])).exit).toBe(EXIT.UNAVAILABLE);
    cli.api.on('GET', '/v1/missions/odd', () => ({ status: 200, body: { ...mission, revision: 0 } }));
    const odd = await cli.run(['mission', 'show', 'odd', '--json']);
    expect(odd.exit).toBe(EXIT.PROTOCOL);
    expect(JSON.parse(odd.stdout.text)).toMatchObject({ outcome: 'PROTOCOL', data: null });
  });
});

describe('authority', () => {
  it('a Researcher cannot run a Steward command: the API refuses it, and the CLI exits 4 and names the role', async () => {
    await cli.login(['Researcher']);
    cli.api.on('POST', '/v1/budgets', () => ({ status: 403, body: apiError('FORBIDDEN') }));
    const run = await cli.run(['budget', 'register', '--file', budgetFile()]);
    expect(run.exit).toBe(EXIT.FORBIDDEN);
    expect(run.stdout.text).toContain('REJECTED');
    expect(run.stdout.text).toContain('No state changed.');
    expect(run.stdout.text).toContain('This command needs one of these roles: Steward.');
  });

  it('a Viewer cannot write: mission create is refused with exit 4', async () => {
    await cli.login(['Viewer']);
    cli.api.on('POST', '/v1/missions', () => ({ status: 403, body: apiError('FORBIDDEN') }));
    const spec = resolve(cli.configDir, 'mission.json');
    writeFileSync(spec, JSON.stringify(fixture('command.create-mission.json').payload.mission));
    const run = await cli.run(['mission', 'create', '--file', spec, '--json']);
    expect(run.exit).toBe(EXIT.FORBIDDEN);
    expect(JSON.parse(run.stdout.text).error).toMatchObject({ code: 'FORBIDDEN', state_changed: 'NONE' });
  });
});

describe('commands', () => {
  it('send a registration with its expected revision and print the applied record', async () => {
    await cli.login(['Steward']);
    cli.api.on('POST', '/v1/budgets', (sent) => ({ status: 202, body: statusFor(sent.body) }));
    const run = await cli.run(['budget', 'register', '--file', budgetFile(), '--command-id', 'cmd-budget-1']);
    expect(run.exit).toBe(EXIT.OK);
    const body = JSON.parse(posts()[0]?.body ?? '{}');
    expect(body).toMatchObject({
      command_id: 'cmd-budget-1',
      expected_revision: 0,
      payload: { kind: 'register_budget' },
    });
    expect(run.stdout.text).toContain('Command cmd-budget-1 (register_budget): APPLIED');
    expect(run.stdout.text).toContain('record: staging-period-cap revision 1');
  });

  it('refuse an input document that breaks command/1 before sending it', async () => {
    await cli.login(['Steward']);
    const path = resolve(cli.configDir, 'bad.json');
    writeFileSync(path, JSON.stringify({ budget_id: 'x' }));
    const run = await cli.run(['budget', 'register', '--file', path]);
    expect(run.exit).toBe(EXIT.USAGE);
    expect(run.stderr.text).toContain('nothing was sent');
    expect(posts()).toEqual([]);
  });

  it('read the created mission back after mission create', async () => {
    await cli.login();
    cli.api.on('POST', '/v1/missions', (sent) => ({
      status: 202,
      body: statusFor(sent.body, { id: 'msn-00000a', revision: 1 }),
    }));
    cli.api.on('GET', '/v1/missions/msn-00000a', () => ({ status: 200, body: created }));
    const spec = resolve(cli.configDir, 'mission.json');
    writeFileSync(spec, JSON.stringify(fixture('command.create-mission.json').payload.mission));
    const run = await cli.run(['mission', 'create', '--file', spec]);
    expect(run.exit).toBe(EXIT.OK);
    expect(run.stdout.text).toContain('record: msn-00000a revision 1');
    expect(run.stdout.text).toContain('Mission msn-00000a (revision 1)');
    expect(run.stdout.text).toContain('status: CREATED');
  });

  it('keep an UNKNOWN outcome in the journal, refuse new commands until it is resolved, and resolve it with the same request', async () => {
    await cli.login(['Steward']);
    let recorded: string | undefined;
    cli.api.on('POST', '/v1/budgets', (sent, count) => {
      if (count === 1) return 'network-failure';
      recorded = sent.body;
      return { status: 202, body: statusFor(sent.body) };
    });
    cli.api.on('GET', '/v1/commands/cmd-lost', () =>
      recorded === undefined
        ? { status: 404, body: apiError('NOT_FOUND') }
        : { status: 200, body: statusFor(recorded) },
    );
    const lost = await cli.run(['budget', 'register', '--file', budgetFile(), '--command-id', 'cmd-lost']);
    expect(lost.exit).toBe(EXIT.UNKNOWN);
    expect(lost.stdout.text).toContain('Command cmd-lost (register_budget): UNKNOWN');
    expect(lost.stdout.text).toContain('openquant command resolve cmd-lost');
    const journal = resolve(cli.configDir, 'pending', 'cmd-lost.json');
    expect(statSync(journal).mode & 0o777).toBe(0o600);
    const blocked = await cli.run(['budget', 'register', '--file', budgetFile()]);
    expect(blocked.exit).toBe(EXIT.UNKNOWN);
    expect(blocked.stderr.text).toContain('Run openquant command resolve cmd-lost first.');
    expect(posts()).toHaveLength(1);
    const resolved = await cli.run(['command', 'resolve', 'cmd-lost']);
    expect(resolved.exit).toBe(EXIT.OK);
    expect(resolved.stdout.text).toContain('Command cmd-lost (register_budget): APPLIED');
    expect(posts()).toHaveLength(2);
    expect(posts()[1]?.body).toBe(posts()[0]?.body);
    expect(() => statSync(journal)).toThrow();
    expect((await cli.run(['command', 'show', 'cmd-lost'])).exit).toBe(EXIT.OK);
  });

  it('journal the exact request with its API and principal before it is sent, and remove it once the outcome is known', async () => {
    await cli.login(['Steward']);
    const journal = resolve(cli.configDir, 'pending', 'cmd-early.json');
    let entry: Doc | undefined;
    cli.api.on('POST', '/v1/budgets', (sent) => {
      entry = JSON.parse(readFileSync(journal, 'utf8')) as Doc;
      return { status: 202, body: statusFor(sent.body) };
    });
    const run = await cli.run(['budget', 'register', '--file', budgetFile(), '--command-id', 'cmd-early']);
    expect(run.exit).toBe(EXIT.OK);
    expect(entry).toMatchObject({
      schema: 'openquant-cli-pending/2',
      api_url: 'https://api.example.test',
      principal_id: 'human-researcher',
      route: 'budgets.register',
    });
    expect(JSON.stringify(entry?.request)).toBe(posts()[0]?.body);
    expect(() => statSync(journal)).toThrow();
  });

  it('resolve an UNKNOWN command only against the API and as the principal that sent it (OQ-05 section 9)', async () => {
    await cli.login(['Steward']);
    let recorded: string | undefined;
    cli.api.on('POST', '/v1/budgets', (sent, count) => {
      if (count === 1) return 'network-failure';
      recorded = sent.body;
      return { status: 202, body: statusFor(sent.body) };
    });
    cli.api.on('GET', '/v1/commands/cmd-bound', () =>
      recorded === undefined
        ? { status: 404, body: apiError('NOT_FOUND') }
        : { status: 200, body: statusFor(recorded) },
    );
    const lost = await cli.run(['budget', 'register', '--file', budgetFile(), '--command-id', 'cmd-bound']);
    expect(lost.exit).toBe(EXIT.UNKNOWN);
    const journal = resolve(cli.configDir, 'pending', 'cmd-bound.json');
    const sentBefore = cli.api.sent.length;
    const next =
      'Log in to https://api.example.test as human-researcher, then run openquant command resolve cmd-bound.';

    // Another API: neither resolved nor resent there, and new commands name where to resolve it.
    expect((await cli.run(['login', '--api', 'https://staging.example.test'], { stdin: `${CREDENTIAL}\n` })).exit).toBe(
      EXIT.OK,
    );
    const otherApi = await cli.run(['command', 'resolve', 'cmd-bound', '--json']);
    expect(otherApi.exit).toBe(EXIT.SESSION_MISMATCH);
    expect(JSON.parse(otherApi.stdout.text).error).toMatchObject({
      code: 'CLI_SESSION_MISMATCH',
      state_changed: 'NONE',
      next,
    });
    const blocked = await cli.run(['budget', 'register', '--file', budgetFile(), '--json']);
    expect(blocked.exit).toBe(EXIT.UNKNOWN);
    expect(JSON.parse(blocked.stdout.text).error.next).toBe(next);

    // The same API as another principal.
    cli.api.on('POST', '/v1/auth/token', () => ({
      status: 200,
      body: { ...accessToken(['Steward']), principal: { id: 'human-other', display_name: 'Other', kind: 'HUMAN' } },
    }));
    expect((await cli.run(['login', '--api', 'https://api.example.test'], { stdin: `${CREDENTIAL}\n` })).exit).toBe(
      EXIT.OK,
    );
    const otherPrincipal = await cli.run(['command', 'resolve', 'cmd-bound']);
    expect(otherPrincipal.exit).toBe(EXIT.SESSION_MISMATCH);
    expect(otherPrincipal.stderr.text).toContain('as human-other. Nothing was sent;');

    const reached = cli.api.sent.slice(sentBefore).filter((sent) => !sent.path.startsWith('/v1/auth/'));
    expect(reached.map((sent) => `${sent.origin} ${sent.method} ${sent.path}`)).toEqual([
      'https://staging.example.test GET /v1/system/identity',
      'https://api.example.test GET /v1/system/identity',
    ]);
    expect(statSync(journal).isFile()).toBe(true);

    // Back on the original API as the original principal, the same request settles it.
    await cli.login(['Steward']);
    const resolved = await cli.run(['command', 'resolve', 'cmd-bound']);
    expect(resolved.exit).toBe(EXIT.OK);
    expect(posts()).toHaveLength(2);
    expect(posts()[1]?.origin).toBe('https://api.example.test');
    expect(posts()[1]?.body).toBe(posts()[0]?.body);
    expect(() => statSync(journal)).toThrow();
  });

  it('resynchronise after a stale revision: exit 7 with the current mission read again', async () => {
    await cli.login();
    cli.api.on('GET', '/v1/missions/msn-00000a', () => ({ status: 200, body: mission }));
    cli.api.on('POST', '/v1/missions/msn-00000a/run-now', () => ({
      status: 409,
      body: apiError('REVISION_CONFLICT', { current_revision: 8 }),
    }));
    const run = await cli.run(['mission', 'run-now', 'msn-00000a', '--yes', '--expected-revision', '1', '--json']);
    expect(run.exit).toBe(EXIT.CONFLICT);
    const document = JSON.parse(run.stdout.text);
    expect(document.error).toMatchObject({ code: 'REVISION_CONFLICT', current_revision: 8, state_changed: 'NONE' });
    expect(document.data.mission.status).toBe('CONCLUDED');
    expect(posts()).toHaveLength(1);
    const text = await cli.run(['mission', 'run-now', 'msn-00000a', '--yes', '--expected-revision', '1']);
    expect(text.stdout.text).toContain('Current state, read again:');
    expect(text.stdout.text).toContain('Current revision: 8');
  });

  it('report a refusal by policy with exit 6 and a pending command with exit 8', async () => {
    await cli.login();
    cli.api.on('GET', '/v1/missions/msn-1', () => ({ status: 200, body: { ...created, mission_id: 'msn-1' } }));
    cli.api.on('POST', '/v1/missions/msn-1/run-now', () => ({ status: 409, body: apiError('BUDGET_EXHAUSTED') }));
    expect((await cli.run(['mission', 'run-now', 'msn-1', '--yes'])).exit).toBe(EXIT.REJECTED);
    cli.api.on('POST', '/v1/missions/msn-1/cancel', (sent) => ({
      status: 202,
      body: { ...statusFor(sent.body), state: 'PENDING', applied_at: undefined, record: undefined },
    }));
    cli.api.on('GET', '/v1/commands/cmd-pending', (_, __) => ({
      status: 200,
      body: {
        schema_version: 'command/1',
        form: 'status',
        command_id: 'cmd-pending',
        kind: 'cancel_mission',
        state: 'PENDING',
        received_at: '2026-11-15T10:00:00Z',
      },
    }));
    const pending = await cli.run([
      'mission',
      'cancel',
      'msn-1',
      '--reason',
      'Stop.',
      '--yes',
      '--command-id',
      'cmd-pending',
    ]);
    expect(pending.exit).toBe(EXIT.PENDING);
    expect(pending.stdout.text).toContain('accepted and durable, not applied yet');
  });

  it('ask for confirmation in a terminal, send nothing when declined, and send the shown revision when confirmed', async () => {
    await cli.login();
    cli.api.on('GET', '/v1/missions/msn-1', () => ({
      status: 200,
      body: { ...created, mission_id: 'msn-1', revision: 4 },
    }));
    cli.api.on('POST', '/v1/missions/msn-1/run-now', (sent) => ({
      status: 202,
      body: statusFor(sent.body, { id: 'msn-1', revision: 5 }),
    }));
    const declineInput = new TestInput(true);
    const declineOutput = new TestOutput(true, 80);
    const declining = cli.run(['mission', 'run-now', 'msn-1'], {
      tty: true,
      input: declineInput,
      output: declineOutput,
    });
    await until(() => declineOutput.text.includes('>[ Keep as is ]<'), 'the confirmation');
    expect(declineOutput.text).toContain('Mission msn-1: CREATED, revision 4');
    declineInput.type('\r');
    const declined = await declining;
    expect(declined.exit).toBe(EXIT.DECLINED);
    expect(declineOutput.text).toContain('Declined: nothing was sent.');
    expect(posts()).toEqual([]);

    const input = new TestInput(true);
    const output = new TestOutput(true, 80);
    const confirming = cli.run(['mission', 'run-now', 'msn-1'], { tty: true, input, output });
    await until(() => output.text.includes('>[ Keep as is ]<'), 'the confirmation');
    input.type('\t');
    await until(() => output.text.includes('>[ Run now ]<'), 'focus on the action');
    input.type('\r');
    const confirmed = await confirming;
    expect(confirmed.exit).toBe(EXIT.OK);
    expect(JSON.parse(posts()[0]?.body ?? '{}')).toMatchObject({
      expected_revision: 4,
      payload: { kind: 'run_mission_now', mission_id: 'msn-1' },
    });
  });
});

describe('mission results', () => {
  const lineage = fixture('lineage-view.three-versions.json');
  const plan = fixture('evaluation-plan.aapl-mission.json');
  const result = fixture('evaluation-result.f0.json');
  const roles: Record<string, string> = { d: 'DEVELOPMENT', v: 'VALIDATION', h: 'HOLDOUT' };
  // The committed metrics of each seed run: the validation-base fixture, moved to the run's window and cost case.
  const metricsOf = (runId: string, slot: string, netReturn: string): Doc => {
    const metrics = fixture('evaluation-metrics.validation-base.json');
    const [, window, cost] = slot.split('.');
    metrics.run_id = runId;
    metrics.window.role = roles[window ?? ''];
    metrics.window.cost_scenario = cost === 'stress' ? 'COST_STRESS' : 'BASE';
    metrics.strategy.net_return.value = netReturn;
    return metrics;
  };
  const served: Record<string, Doc> = {
    'run-00001e': metricsOf('run-00001e', 'seed.d.base', '0.010000'),
    'run-000026': metricsOf('run-000026', 'seed.d.base.repeat', '0.010001'),
    'run-000020': metricsOf('run-000020', 'seed.d.stress', '0.009000'),
    'run-000022': metricsOf('run-000022', 'seed.v.base', '0.041873'),
    'run-000024': metricsOf('run-000024', 'seed.v.stress', '0.040000'),
    'run-0000bd': metricsOf('run-0000bd', 'seed.h.base', '0.030000'),
    // run-0000bf (H, COST_STRESS) has no committed metrics: NOT_FOUND.
  };
  // The buy-and-hold return is shown as the metrics state it, even where it is not net return minus excess return.
  (served['run-000022'] as Doc).benchmarks.buy_and_hold.net_return.value = '0.299999';
  (served['run-0000bd'] as Doc).benchmarks.buy_and_hold = {
    status: 'INSUFFICIENT',
    reason: 'No whole lot is affordable at the first fillable open.',
  };

  function serve(withPlan: boolean): void {
    cli.api.on('GET', '/v1/missions/msn-00000a/lineage', () => ({ status: 200, body: lineage }));
    cli.api.on('GET', '/v1/missions/msn-00000a/plan', () =>
      withPlan ? { status: 200, body: plan } : { status: 404, body: apiError('NOT_FOUND') },
    );
    for (const [runId, metrics] of Object.entries(served)) {
      cli.api.on('GET', `/v1/runs/${runId}/metrics`, () => ({ status: 200, body: metrics }));
    }
    cli.api.on('GET', '/v1/runs/run-000022/result', () => ({ status: 200, body: result }));
  }

  it('show the official D, V and H values side by side with both benchmarks, the ledger and the labels', async () => {
    await cli.login(['Viewer']);
    serve(true);
    const run = await cli.run(['mission', 'results', 'msn-00000a', '--candidate', 'seed']);
    expect(run.exit).toBe(EXIT.OK);
    const text = run.stdout.text;
    const lines = text.split('\n');
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(80);
    expect(text).toContain('Candidate seed: daily-swing-seed v1, EVALUATING');
    expect(text).not.toContain('Candidate rev-a');
    expect(lines).toContain('    BASE                D           D repeat    V           H');
    expect(text).toMatch(/ {4}net return +0\.010000 +0\.010001 +0\.041873 +0\.030000\n/);
    expect(text).toMatch(/ {4}net return +0\.009000 +0\.040000 +unknown\n/);
    expect(text).toMatch(/ {4}B&H net return +0\.300000 +0\.300000 +0\.299999 +INSUFFICIENT\n/);
    expect(text).toMatch(/ {4}cash excess return +0\.041873 +0\.041873 +0\.041873 +0\.041873\n/);
    expect(text).toMatch(/ {4}fees +150\.00 USD +150\.00 USD +unknown\n/);
    expect(text).toContain('buy-and-hold of run-0000bd: INSUFFICIENT - No whole lot is affordable');
    expect(text).toContain('  Simulated per-candidate ledger (final state of each result)');
    expect(text).toMatch(/ {4}equity +unknown +unknown +5132\.00 +unknown\n/);
    expect(text).toMatch(/ {4}ledger entries +unknown +unknown +7 +unknown\n/);
    expect(text).toContain('  window label of D, V, H: historical window within model training period');
    expect(text).toContain('  H 2025-01-02 to 2025-12-31: historical window within model training period');
    expect(text).toContain('  uncertainty: NOT_COMPUTED - S1 reports no uncertainty statistic');
    expect(text).toContain('  uncertainty: unknown (no official metrics) (run-0000bf)');

    const json = await cli.run(['mission', 'results', 'msn-00000a', '--candidate', 'seed', '--json']);
    expect(json.exit).toBe(EXIT.OK);
    const data = JSON.parse(json.stdout.text).data;
    expect(data.windows).toEqual(plan.windows);
    const runs: Doc[] = data.candidates[0].runs;
    const byId = (id: string) => runs.find((item) => item.run_id === id) as Doc;
    expect(byId('run-000022')).toMatchObject({ window_role: 'VALIDATION', cost_scenario: 'BASE', replay_of: null });
    expect(byId('run-000022').metrics).toEqual(served['run-000022']);
    expect(byId('run-000022').result).toEqual(result);
    expect(byId('run-000026').replay_of).toBe('seed.d.base');
    expect(byId('run-0000bf')).toMatchObject({ metrics: null, result: null });
    expect(byId('run-00001e').window_label).toBe('historical window within model training period');
  });

  it('show an unrecorded plan as unknown labels, and refuse an unknown candidate with exit 5', async () => {
    await cli.login(['Viewer']);
    serve(false);
    const run = await cli.run(['mission', 'results', 'msn-00000a']);
    expect(run.exit).toBe(EXIT.OK);
    expect(run.stdout.text).toContain('  labels unknown: the evaluation plan is not recorded yet');
    expect(run.stdout.text).toContain('  window label of D, V, H: unknown (no evaluation plan recorded)');
    expect(run.stdout.text).toContain('Candidate rev-a:');
    const missing = await cli.run(['mission', 'results', 'msn-00000a', '--candidate', 'nope', '--json']);
    expect(missing.exit).toBe(EXIT.NOT_FOUND);
  });
});

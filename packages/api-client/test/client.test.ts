// The client against a fake API: command IDs, read-back of PENDING and UNKNOWN outcomes, resynchronisation after a
// stale revision, typed errors, and validation of every answer (OQ-04 section 12, OQ-05 sections 7 and 8). The client
// against the real API and PostgreSQL is tested in apps/api/test/client.test.ts.

import { describe, expect, it } from 'vitest';
import {
  ApiClient,
  CommandIdReusedError,
  ForbiddenError,
  InternalApiError,
  InvalidCommandError,
  InvalidRequestError,
  NotFoundError,
  parseAccessToken,
  RefusedError,
  ResponseContractError,
  RevisionConflictError,
  TransportError,
  UnauthenticatedError,
  UnavailableError,
} from '../src/index.ts';
import { apiError, type Doc, type FakeApi, fakeApi, fixture, statusOf } from './support.ts';

const budget = fixture('command.register-budget.json').payload.budget;
const missionView = fixture('mission-view.concluded.json');

function client(api: FakeApi, options: { refresh?: () => Promise<string | undefined> } = {}) {
  let ids = 0;
  return new ApiClient({
    baseUrl: 'https://api.example.test/',
    fetch: api.fetch,
    auth: { accessToken: async () => 'oqa1.token', ...(options.refresh ? { refresh: options.refresh } : {}) },
    now: () => new Date('2026-11-15T10:00:00.250Z'),
    newCommandId: () => `cmd-test-${++ids}`,
    readBack: { attempts: 3, delayMs: 0 },
    sleep: async () => {},
  });
}

const bodyOf = (api: FakeApi, index: number): Doc => JSON.parse(api.sent[index]?.body ?? 'null') as Doc;

describe('commands', () => {
  it('give each command a new client command ID and send command/1 with its expected revision', async () => {
    const api = fakeApi();
    api.on('POST', '/v1/budgets', (request) => ({ status: 202, body: statusOf(JSON.parse(request.body ?? '')) }));
    const subject = client(api);
    const first = await subject.registerBudget(budget as never, { expectedRevision: 0 });
    const second = await subject.registerBudget(budget as never, { expectedRevision: 0 });
    expect(first.state).toBe('APPLIED');
    expect(second.state).toBe('APPLIED');
    expect(bodyOf(api, 0)).toEqual({
      schema_version: 'command/1',
      form: 'request',
      command_id: 'cmd-test-1',
      expected_revision: 0,
      issued_at: '2026-11-15T10:00:00Z',
      payload: { kind: 'register_budget', budget },
    });
    expect(bodyOf(api, 1).command_id).toBe('cmd-test-2');
    expect(api.sent[0]?.headers.authorization).toBe('Bearer oqa1.token');
    expect(api.sent[0]?.headers['content-type']).toBe('application/json');
  });

  it('refuse a request that breaks command/1 before anything is sent', async () => {
    const api = fakeApi();
    const subject = client(api);
    const broken = { ...budget, model_spend: { amount: 'ten', currency: 'USD' } };
    await expect(subject.registerBudget(broken as never, { expectedRevision: 0 })).rejects.toBeInstanceOf(
      InvalidCommandError,
    );
    await expect(subject.runMissionNow('msn-1', { expectedRevision: -1 })).rejects.toThrow(/nothing was sent/);
    expect(api.sent).toEqual([]);
  });

  it('read a PENDING command back within the bound, until it is applied', async () => {
    const api = fakeApi();
    let request: Doc = {};
    api.on('POST', '/v1/budgets', (sent) => {
      request = JSON.parse(sent.body ?? '');
      return { status: 202, body: statusOf(request, 'PENDING') };
    });
    api.on('GET', '/v1/commands/cmd-test-1', (_, count) => ({
      status: 200,
      body: statusOf(request, count < 2 ? 'PENDING' : 'APPLIED'),
    }));
    const outcome = await client(api).registerBudget(budget as never, { expectedRevision: 0 });
    expect(outcome.state).toBe('APPLIED');
    expect(api.sent.map((sent) => `${sent.method} ${sent.path}`)).toEqual([
      'POST /v1/budgets',
      'GET /v1/commands/cmd-test-1',
      'GET /v1/commands/cmd-test-1',
    ]);
  });

  it('keep a command PENDING when the bounded read-back does not see it applied', async () => {
    const api = fakeApi();
    let request: Doc = {};
    api.on('POST', '/v1/budgets', (sent) => {
      request = JSON.parse(sent.body ?? '');
      return { status: 202, body: statusOf(request, 'PENDING') };
    });
    api.on('GET', '/v1/commands/cmd-test-1', () => ({ status: 200, body: statusOf(request, 'PENDING') }));
    const outcome = await client(api).registerBudget(budget as never, { expectedRevision: 0 });
    expect(outcome.state).toBe('PENDING');
    expect(api.sent.filter((sent) => sent.method === 'GET')).toHaveLength(3);
  });

  it('read a command back after a lost answer: a timeout does not prove that nothing changed', async () => {
    const api = fakeApi();
    let request: Doc = {};
    api.on('POST', '/v1/budgets', (sent) => {
      request = JSON.parse(sent.body ?? '');
      return 'network-failure';
    });
    api.on('GET', '/v1/commands/cmd-test-1', () => ({ status: 200, body: statusOf(request) }));
    const outcome = await client(api).registerBudget(budget as never, { expectedRevision: 0 });
    expect(outcome.state).toBe('APPLIED');
    expect(api.sent.filter((sent) => sent.method === 'POST')).toHaveLength(1);
  });

  it('report UNKNOWN when neither the answer nor the read-back settles the command, and never resend on its own', async () => {
    const api = fakeApi();
    api.on('POST', '/v1/budgets', () => 'network-failure');
    const outcome = await client(api).registerBudget(budget as never, { expectedRevision: 0 });
    expect(outcome.state).toBe('UNKNOWN');
    if (outcome.state === 'UNKNOWN') expect(outcome.cause).toBeInstanceOf(TransportError);
    expect(api.sent.map((sent) => `${sent.method} ${sent.path}`)).toEqual([
      'POST /v1/budgets',
      'GET /v1/commands/cmd-test-1',
    ]);
  });

  it('treat an answer whose state change is UNKNOWN, or an unusable answer, as unknown until read back', async () => {
    const api = fakeApi();
    api.on('POST', '/v1/budgets', (_, count) =>
      count === 1
        ? { status: 500, body: apiError('INTERNAL', { state_changed: 'UNKNOWN' }) }
        : { status: 202, body: '{"not":"a status"}' },
    );
    const subject = client(api);
    const first = await subject.registerBudget(budget as never, { expectedRevision: 0 });
    expect(first.state).toBe('UNKNOWN');
    if (first.state === 'UNKNOWN') expect(first.cause).toBeInstanceOf(InternalApiError);
    const second = await subject.registerBudget(budget as never, { expectedRevision: 0 });
    expect(second.state).toBe('UNKNOWN');
    if (second.state === 'UNKNOWN') expect(second.cause).toBeInstanceOf(ResponseContractError);
  });

  it('resolve an UNKNOWN command by reading it back, then by sending the identical request once', async () => {
    const api = fakeApi();
    let recorded: Doc | undefined;
    api.on('POST', '/v1/budgets', (sent, count) => {
      if (count === 1) return 'network-failure';
      recorded = JSON.parse(sent.body ?? '');
      return { status: 202, body: statusOf(recorded as Doc) };
    });
    api.on('GET', '/v1/commands/cmd-test-1', () =>
      recorded === undefined ? { status: 404, body: apiError('NOT_FOUND') } : { status: 200, body: statusOf(recorded) },
    );
    const subject = client(api);
    const lost = await subject.registerBudget(budget as never, { expectedRevision: 0 });
    expect(lost.state).toBe('UNKNOWN');
    const resolved = await subject.resolveCommand('budgets.register', lost.request);
    expect(resolved.state).toBe('APPLIED');
    const posts = api.sent.filter((sent) => sent.method === 'POST');
    expect(posts).toHaveLength(2);
    // The same command ID and the same bytes: the API applies one command.
    expect(posts[1]?.body).toBe(posts[0]?.body);
  });

  it('resynchronise after a stale revision from the authoritative mission, and send nothing more', async () => {
    const api = fakeApi();
    api.on('POST', '/v1/missions/msn-00000a/run-now', () => ({
      status: 409,
      body: apiError('REVISION_CONFLICT', { current_revision: 8 }),
    }));
    api.on('GET', '/v1/missions/msn-00000a', () => ({ status: 200, body: missionView }));
    const outcome = await client(api).runMissionNow('msn-00000a', { expectedRevision: 1 });
    expect(outcome.state).toBe('REJECTED');
    if (outcome.state !== 'REJECTED') return;
    expect(outcome.error).toBeInstanceOf(RevisionConflictError);
    const conflict = outcome.error as RevisionConflictError;
    expect(conflict.currentRevision).toBe(8);
    expect(conflict.resync.mission?.status).toBe('CONCLUDED');
    expect(conflict.stateChanged).toBe('NONE');
    expect(api.sent.map((sent) => `${sent.method} ${sent.path}`)).toEqual([
      'POST /v1/missions/msn-00000a/run-now',
      'GET /v1/missions/msn-00000a',
    ]);
  });

  it('keep the current revision of the error when the resync read fails', async () => {
    const api = fakeApi();
    api.on('POST', '/v1/missions/msn-1/cancel', () => ({
      status: 409,
      body: apiError('REVISION_CONFLICT', { current_revision: 3 }),
    }));
    api.on('GET', '/v1/missions/msn-1', () => ({ status: 503, body: apiError('UNAVAILABLE', { retry_safe: true }) }));
    const outcome = await client(api).cancelMission('msn-1', 'Stop.', { expectedRevision: 2 });
    expect(outcome.state).toBe('REJECTED');
    if (outcome.state === 'REJECTED') expect((outcome.error as RevisionConflictError).currentRevision).toBe(3);
  });
});

describe('errors', () => {
  it('map each api-error/1 code to its typed error', async () => {
    const cases: [string, number, new (...args: never[]) => Error][] = [
      ['UNAUTHENTICATED', 401, UnauthenticatedError],
      ['FORBIDDEN', 403, ForbiddenError],
      ['NOT_FOUND', 404, NotFoundError],
      ['REVISION_CONFLICT', 409, RevisionConflictError],
      ['COMMAND_ID_REUSED', 409, CommandIdReusedError],
      ['SCHEMA_VIOLATION', 400, InvalidRequestError],
      ['LIMIT_EXCEEDED', 413, InvalidRequestError],
      ['POLICY_VIOLATION', 422, RefusedError],
      ['BUDGET_EXHAUSTED', 409, RefusedError],
      ['EXECUTION_DISABLED', 409, RefusedError],
      ['RATE_LIMITED', 429, UnavailableError],
      ['UNAVAILABLE', 503, UnavailableError],
      ['INTERNAL', 500, InternalApiError],
    ];
    for (const [code, status, type] of cases) {
      const api = fakeApi();
      api.on('GET', '/v1/missions/msn-1', () => ({ status, body: apiError(code) }));
      const error = await client(api)
        .mission('msn-1')
        .catch((caught: unknown) => caught);
      expect(error, code).toBeInstanceOf(type);
      expect((error as { code: string }).code, code).toBe(code);
      expect((error as { diagnosticRef: string }).diagnosticRef).toBe('diag-1');
    }
  });

  it('refuse an error answer that is not api-error/1, or whose status is not the status of its code', async () => {
    const api = fakeApi();
    api.on('GET', '/v1/missions/a', () => ({ status: 500, body: '<html>oops</html>' }));
    api.on('GET', '/v1/missions/b', () => ({ status: 500, body: apiError('NOT_FOUND') }));
    const subject = client(api);
    await expect(subject.mission('a')).rejects.toBeInstanceOf(ResponseContractError);
    await expect(subject.mission('b')).rejects.toBeInstanceOf(ResponseContractError);
  });

  it('refresh the access token once after UNAUTHENTICATED and repeat the request', async () => {
    const api = fakeApi();
    api.on('GET', '/v1/missions/msn-00000a', (sent) =>
      sent.headers.authorization === 'Bearer oqa1.fresh'
        ? { status: 200, body: missionView }
        : { status: 401, body: apiError('UNAUTHENTICATED') },
    );
    let refreshed = 0;
    const subject = client(api, {
      refresh: async () => {
        refreshed += 1;
        return 'oqa1.fresh';
      },
    });
    expect((await subject.mission('msn-00000a')).mission_id).toBe('msn-00000a');
    expect(refreshed).toBe(1);
    const stale = client(api, { refresh: async () => undefined });
    await expect(stale.mission('msn-00000a')).rejects.toBeInstanceOf(UnauthenticatedError);
  });
});

describe('reads', () => {
  it('validate each view against its contract and refuse one that breaks it', async () => {
    const api = fakeApi();
    api.on('GET', '/v1/missions/msn-00000a', () => ({ status: 200, body: missionView }));
    api.on('GET', '/v1/missions/msn-zero', () => ({ status: 200, body: { ...missionView, revision: 0 } }));
    api.on('GET', '/v1/missions/msn-extra', () => ({ status: 200, body: { ...missionView, risk: 'OK' } }));
    const subject = client(api);
    expect((await subject.mission('msn-00000a')).status).toBe('CONCLUDED');
    await expect(subject.mission('msn-zero')).rejects.toBeInstanceOf(ResponseContractError);
    await expect(subject.mission('msn-extra')).rejects.toBeInstanceOf(ResponseContractError);
  });

  it('read every view route of the manifest with its contract', async () => {
    const api = fakeApi();
    const views: [string, string, (subject: ApiClient) => Promise<unknown>][] = [
      ['/v1/missions/m/lineage', 'lineage-view.three-versions.json', (s) => s.lineage('m')],
      ['/v1/missions/m/trials', 'trials-view.concluded.json', (s) => s.trials('m')],
      ['/v1/missions/m/findings', 'findings-view.three-critiques.json', (s) => s.findings('m')],
      ['/v1/missions/m/gates', 'gates-view.one-report.json', (s) => s.gates('m')],
      ['/v1/missions/m/decisions', 'decisions-view.concluded.json', (s) => s.decisions('m')],
      ['/v1/jobs/j', 'job-view.retrieve.json', (s) => s.job('j')],
      ['/v1/missions/m/plan', 'evaluation-plan.aapl-mission.json', (s) => s.plan('m')],
      [
        '/v1/runs/run-aapl-v-base-a/metrics',
        'evaluation-metrics.validation-base.json',
        (s) => s.runMetrics('run-aapl-v-base-a'),
      ],
      ['/v1/runs/r/result', 'evaluation-result.f0.json', (s) => s.runResult('r')],
      ['/v1/system/identity', 'system-identity-view.release-recorded.json', (s) => s.identity()],
    ];
    const subject = client(api);
    for (const [path, name, read] of views) {
      api.on('GET', path, () => ({ status: 200, body: fixture(name) }));
      expect(await read(subject), name).toEqual(fixture(name));
      // The same answer under another view's route breaks that route's contract.
      api.on('GET', path, () => ({ status: 200, body: missionView }));
      await expect(read(subject), name).rejects.toBeInstanceOf(ResponseContractError);
    }
  });

  it('read the official metrics and result of a run: NOT_FOUND while none is committed, and only for that run', async () => {
    const api = fakeApi();
    const metrics = fixture('evaluation-metrics.validation-base.json');
    api.on('GET', '/v1/runs/run-other/metrics', () => ({ status: 200, body: metrics }));
    const subject = client(api);
    await expect(subject.runMetrics('run-none')).rejects.toBeInstanceOf(NotFoundError);
    await expect(subject.runResult('run-none')).rejects.toBeInstanceOf(NotFoundError);
    await expect(subject.runMetrics('run-other')).rejects.toBeInstanceOf(ResponseContractError);
    expect(api.sent.map((sent) => sent.path)).toEqual([
      '/v1/runs/run-none/metrics',
      '/v1/runs/run-none/result',
      '/v1/runs/run-other/metrics',
    ]);
  });

  it('encode a path parameter as one segment', async () => {
    const api = fakeApi();
    await client(api)
      .mission('a/../b?c')
      .catch(() => undefined);
    expect(api.sent[0]?.path).toBe('/v1/missions/a%2F..%2Fb%3Fc');
  });

  it('exchange a credential for an access token and check the token view field by field', async () => {
    const api = fakeApi();
    const token = {
      access_token: 'oqa1.abc',
      token_type: 'Bearer',
      issued_at: '2026-11-15T10:00:00Z',
      expires_at: '2026-11-15T10:15:00Z',
      principal: { id: 'human-researcher', display_name: 'Researcher', kind: 'HUMAN' },
      roles: ['Researcher'],
    };
    api.on('POST', '/v1/auth/token', (sent) =>
      sent.headers.authorization === 'Bearer oqk1.credential'
        ? { status: 200, body: token }
        : { status: 401, body: apiError('UNAUTHENTICATED') },
    );
    const subject = new ApiClient({ baseUrl: 'https://api.example.test', fetch: api.fetch });
    expect(await subject.exchangeCredential('oqk1.credential')).toEqual(token);
    await expect(subject.exchangeCredential('oqk1.other')).rejects.toBeInstanceOf(UnauthenticatedError);
    const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
    expect(parseAccessToken(encode(token))).toEqual(token);
    expect(parseAccessToken(encode({ ...token, roles: ['Owner'] }))).toBeUndefined();
    expect(parseAccessToken(encode({ ...token, extra: true }))).toBeUndefined();
    expect(parseAccessToken(encode({ ...token, expires_at: '2026-11-15' }))).toBeUndefined();
  });
});

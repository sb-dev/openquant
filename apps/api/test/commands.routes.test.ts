// The command routes end to end through the Hono layer: authentication, authorisation, the body limit and the parse of
// part A, then the guarded command, then the status. Credentials are issued by the application's own code and
// exchanged for access tokens, as a person's are. Bodies and answers are checked against the contracts.

import { parseContract } from '@openquant/api-contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { issueCredential } from '../src/auth/credentials.ts';
import { accessTokenFor, everyOperation } from './support/actors.ts';
import { bearer, bodyOf } from './support/app.ts';
import { ids, NOW } from './support/seed.ts';
import { createWorld, type Doc, missionPayload, type World } from './support/world.ts';

interface Http {
  readonly world: World;
  readonly tokens: Record<'steward' | 'researcher' | 'viewer' | 'admin' | 'workflows', string>;
}

async function httpWorld(options: Parameters<typeof createWorld>[0] = {}): Promise<Http> {
  const world = await createWorld(options);
  const now = new Date(NOW);
  const credentials = await world.tx(async (tx) => {
    const issue = async (principalId: string, kind: 'HUMAN' | 'SERVICE', operations?: readonly string[]) =>
      (
        await issueCredential(tx, world.testApp.env.ids, now, {
          principalId,
          principalKind: kind,
          ...(operations === undefined ? {} : { operations }),
          issuedBy: ids.admin,
        })
      ).token;
    return {
      steward: await issue(ids.steward, 'HUMAN'),
      researcher: await issue(ids.researcher, 'HUMAN'),
      viewer: await issue(ids.viewer, 'HUMAN'),
      admin: await issue(ids.admin, 'HUMAN'),
      workflows: await issue(ids.workflows, 'SERVICE', everyOperation),
    };
  });
  const tokens = {
    steward: await accessTokenFor(world.testApp, credentials.steward),
    researcher: await accessTokenFor(world.testApp, credentials.researcher),
    viewer: await accessTokenFor(world.testApp, credentials.viewer),
    admin: await accessTokenFor(world.testApp, credentials.admin),
    workflows: credentials.workflows,
  };
  return { world, tokens };
}

const post = (http: Http, path: string, token: string, body: unknown) =>
  http.world.testApp.request(path, {
    method: 'POST',
    headers: { ...bearer(token), 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
const get = (http: Http, path: string, token: string) => http.world.testApp.request(path, { headers: bearer(token) });

async function errorBody(response: Response) {
  const body = await bodyOf<{
    code: string;
    message: string;
    current_revision?: number;
    state_changed: string;
    violations?: { pointer: string }[];
  }>(response);
  expect(parseContract('api-error', JSON.stringify(body)).ok).toBe(true);
  return body;
}

describe('the pilot through the routes', () => {
  let http: Http;
  beforeAll(async () => {
    http = await httpWorld();
  });
  afterAll(async () => {
    await http.world.drop();
  });
  const ids2: Record<string, string> = {};

  it('registers the budget, the profile, the policy and the seed with 202 and the status of each command', async () => {
    const { world, tokens } = http;
    const steps: [string, string, string, Doc][] = [
      ['budgets.register', '/v1/budgets', tokens.steward, { kind: 'register_budget', budget: world.docs.budget }],
      [
        'research-profiles.register',
        '/v1/research-profiles',
        tokens.steward,
        { kind: 'register_research_profile', profile: world.docs.profile },
      ],
      [
        'cohort-policies.register',
        '/v1/cohort-policies',
        tokens.steward,
        { kind: 'register_cohort_policy', policy: world.docs.policy },
      ],
      ['seeds.register', '/v1/strategies/seeds', tokens.researcher, { kind: 'register_seed', ...world.docs.seed }],
    ];
    for (const [name, path, token, payload] of steps) {
      const request = world.command(payload);
      const response = await post(http, path, token, request);
      expect(response.status, name).toBe(202);
      expect(response.headers.get('cache-control')).toBe('no-store');
      const status = await bodyOf<Doc>(response);
      expect(parseContract('command', JSON.stringify(status)).ok, name).toBe(true);
      expect(status).toMatchObject({
        form: 'status',
        state: 'APPLIED',
        command_id: request.command_id,
        kind: payload.kind,
      });
      // The same command is read back by its ID with the same answer.
      const shown = await get(http, `/v1/commands/${request.command_id}`, tokens.viewer);
      expect(shown.status, name).toBe(200);
      expect(await bodyOf(shown)).toEqual(status);
    }
  });

  it('creates the mission with its ID in the status, and starts it', async () => {
    const { world, tokens } = http;
    const create = world.command(missionPayload(world));
    const created = await post(http, '/v1/missions', tokens.researcher, create);
    expect(created.status).toBe(202);
    const status = await bodyOf<{ record: { id: string; revision: number } }>(created);
    expect(status.record.revision).toBe(1);
    ids2.mission = status.record.id;
    const run = world.command({ kind: 'run_mission_now', mission_id: ids2.mission }, { expectedRevision: 1 });
    const started = await post(http, `/v1/missions/${ids2.mission}/run-now`, tokens.researcher, run);
    expect(started.status).toBe(202);
    expect((await bodyOf<{ record: { revision: number } }>(started)).record.revision).toBe(2);
    expect(await world.sql('SELECT status FROM missions')).toEqual([{ status: 'IN_PROGRESS' }]);
    expect(await world.sql('SELECT count(*)::int AS n FROM outbox WHERE status = $1', ['PENDING'])).toEqual([{ n: 1 }]);
  });

  it('answers a repeated command with the same status, and the same ID with another body with COMMAND_ID_REUSED', async () => {
    const { world, tokens } = http;
    const request = world.command(
      { kind: 'cancel_mission', mission_id: ids2.mission, reason: 'Stop.' },
      { expectedRevision: 2 },
    );
    const first = await post(http, `/v1/missions/${ids2.mission}/cancel`, tokens.researcher, request);
    expect(first.status).toBe(202);
    const firstBody = await bodyOf(first);
    const replay = await post(http, `/v1/missions/${ids2.mission}/cancel`, tokens.researcher, request);
    expect(replay.status).toBe(202);
    expect(await bodyOf(replay)).toEqual(firstBody);
    expect(await world.sql(`SELECT count(*)::int AS n FROM missions WHERE status = 'WITHDRAWN'`)).toEqual([{ n: 1 }]);
    const changed = { ...request, payload: { ...request.payload, reason: 'Another reason.' } };
    const reused = await post(http, `/v1/missions/${ids2.mission}/cancel`, tokens.researcher, changed);
    expect(reused.status).toBe(409);
    expect(await errorBody(reused)).toMatchObject({ code: 'COMMAND_ID_REUSED', state_changed: 'NONE' });
  });

  it('answers a refusal with its status and code, records it for the ID, and shows it with the status route', async () => {
    const { world, tokens } = http;
    // A stale revision: the mission is at revision 3 after its withdrawal.
    const stale = world.command(
      { kind: 'cancel_mission', mission_id: ids2.mission, reason: 'Again.' },
      { expectedRevision: 1 },
    );
    const refused = await post(http, `/v1/missions/${ids2.mission}/cancel`, tokens.researcher, stale);
    expect(refused.status).toBe(409);
    expect(await errorBody(refused)).toMatchObject({
      code: 'REVISION_CONFLICT',
      current_revision: 3,
      state_changed: 'NONE',
    });
    const again = await post(http, `/v1/missions/${ids2.mission}/cancel`, tokens.researcher, stale);
    expect(again.status).toBe(409);
    const shown = await bodyOf<{ state: string; error: { code: string } }>(
      await get(http, `/v1/commands/${stale.command_id}`, tokens.researcher),
    );
    expect(shown).toMatchObject({ state: 'REJECTED', error: { code: 'REVISION_CONFLICT' } });
    expect(parseContract('command', JSON.stringify(shown)).ok).toBe(true);
    // A rule of the policy is 422, a record that does not exist 404.
    const budget = structuredClone(world.docs.budget) as Doc;
    budget.budget_id = 'late-cap';
    budget.period = { start: '2026-11-30', end: '2026-11-01' };
    const invalid = await post(http, '/v1/budgets', tokens.steward, world.command({ kind: 'register_budget', budget }));
    expect(invalid.status).toBe(422);
    expect(await errorBody(invalid)).toMatchObject({ code: 'POLICY_VIOLATION' });
    const missing = await post(
      http,
      '/v1/missions/msn-none/run-now',
      tokens.researcher,
      world.command({ kind: 'run_mission_now', mission_id: 'msn-none' }, { expectedRevision: 1 }),
    );
    expect(missing.status).toBe(404);
    expect(await errorBody(missing)).toMatchObject({ code: 'NOT_FOUND' });
  });

  it('answers 404 for a command ID that nobody sent, and lets every role read a command', async () => {
    const { tokens } = http;
    expect((await get(http, '/v1/commands/cmd-never-sent', tokens.viewer)).status).toBe(404);
    const known = (await http.world.sql<{ command_id: string }>('SELECT command_id FROM commands LIMIT 1'))[0]
      ?.command_id;
    for (const role of ['viewer', 'researcher', 'steward', 'admin'] as const) {
      expect((await get(http, `/v1/commands/${known}`, tokens[role])).status, role).toBe(200);
    }
    expect((await get(http, `/v1/commands/${known}`, tokens.workflows)).status).toBe(403);
    expect((await http.world.testApp.request(`/v1/commands/${known}`)).status).toBe(401);
  });
});

describe('who may call the command routes', () => {
  it('lets only the role of the route apply a command, applies the role as listed, and keeps the internal commands off the routes', async () => {
    const http = await httpWorld();
    const { world, tokens } = http;
    const budget = world.command({ kind: 'register_budget', budget: world.docs.budget });
    expect((await post(http, '/v1/budgets', tokens.researcher, budget)).status).toBe(403);
    expect((await post(http, '/v1/budgets', tokens.viewer, budget)).status).toBe(403);
    // An Administrator is not a Steward: roles have no hierarchy.
    expect((await post(http, '/v1/budgets', tokens.admin, budget)).status).toBe(403);
    expect((await post(http, '/v1/budgets', tokens.workflows, budget)).status).toBe(403);
    expect(
      (await http.world.testApp.request('/v1/budgets', { method: 'POST', body: JSON.stringify(budget) })).status,
    ).toBe(401);
    expect(await world.sql('SELECT 1 FROM commands')).toEqual([]);
    expect((await post(http, '/v1/budgets', tokens.steward, budget)).status).toBe(202);
    // The two internal commands have no route: nothing answers for them, and the route of another kind refuses them.
    for (const path of [
      '/v1/missions/msn-1/decisions',
      '/v1/missions/msn-1/freeze',
      '/v1/decisions',
      '/v1/candidates/freeze',
    ]) {
      expect((await post(http, path, tokens.workflows, {})).status, path).toBe(404);
    }
    const decision = world.command({
      kind: 'freeze_candidates',
      mission_id: 'msn-1',
      plan_digest: `sha256:${'a'.repeat(64)}`,
      slots: [{ trial_slot: 'seed', status: 'NOT_EVALUATED', reason: 'DECISION_DEFERRED' }],
    });
    const wrongRoute = await post(http, '/v1/missions', tokens.researcher, decision);
    expect(wrongRoute.status).toBe(400);
    expect(await errorBody(wrongRoute)).toMatchObject({
      code: 'SCHEMA_VIOLATION',
      violations: [{ pointer: '/payload/kind' }],
    });
    await world.drop();
  });

  it('refuses a command for another mission than the path names, before applying it', async () => {
    const http = await httpWorld();
    const request = http.world.command(
      { kind: 'cancel_mission', mission_id: 'msn-other', reason: 'x' },
      { expectedRevision: 1 },
    );
    const response = await post(http, '/v1/missions/msn-path/cancel', http.tokens.researcher, request);
    expect(response.status).toBe(400);
    expect(await errorBody(response)).toMatchObject({
      code: 'SCHEMA_VIOLATION',
      violations: [{ pointer: '/payload/mission_id' }],
    });
    expect(await http.world.sql('SELECT 1 FROM commands')).toEqual([]);
    await http.world.drop();
  });
});

describe('research execution switched off', () => {
  it('answers run-now with EXECUTION_DISABLED, records no command, and starts nothing', async () => {
    const http = await httpWorld({ researchExecution: false });
    const { world, tokens } = http;
    await post(
      http,
      '/v1/budgets',
      tokens.steward,
      world.command({ kind: 'register_budget', budget: world.docs.budget }),
    );
    await post(
      http,
      '/v1/research-profiles',
      tokens.steward,
      world.command({ kind: 'register_research_profile', profile: world.docs.profile }),
    );
    await post(
      http,
      '/v1/cohort-policies',
      tokens.steward,
      world.command({ kind: 'register_cohort_policy', policy: world.docs.policy }),
    );
    await post(
      http,
      '/v1/strategies/seeds',
      tokens.researcher,
      world.command({ kind: 'register_seed', ...world.docs.seed }),
    );
    const created = await post(http, '/v1/missions', tokens.researcher, world.command(missionPayload(world)));
    const missionId = (await bodyOf<{ record: { id: string } }>(created)).record.id;
    const run = world.command({ kind: 'run_mission_now', mission_id: missionId }, { expectedRevision: 1 });
    const response = await post(http, `/v1/missions/${missionId}/run-now`, tokens.researcher, run);
    expect(response.status).toBe(409);
    expect(await errorBody(response)).toMatchObject({ code: 'EXECUTION_DISABLED', state_changed: 'NONE' });
    expect((await get(http, `/v1/commands/${run.command_id}`, tokens.viewer)).status).toBe(404);
    expect(await world.sql('SELECT status FROM missions')).toEqual([{ status: 'CREATED' }]);
    expect(await world.sql('SELECT 1 FROM jobs')).toEqual([]);
    await world.drop();
  });
});

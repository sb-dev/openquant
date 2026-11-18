// @openquant/api-client against the real API: the Hono app and PostgreSQL of the other API tests, reached through the
// app's own request method as the client's fetch (OQ-05 sections 7 to 9). Login exchanges a person's credential for an
// access token; commands get client command IDs and are read back by them; a stale revision is resynchronised from the
// mission; a lost answer is settled by the read-back; every view parses against its contract; and the API refuses a
// Researcher's Steward command and every write of a Viewer, which the client reports as ForbiddenError with no state
// changed.

import {
  type AccessToken,
  ApiClient,
  type CommandOutcome,
  type Fetch,
  ForbiddenError,
  RevisionConflictError,
  TransportError,
  UnauthenticatedError,
} from '@openquant/api-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { issueCredential } from '../src/auth/credentials.ts';
import { ids, NOW } from './support/seed.ts';
import { createWorld, type Doc, missionPayload, type World } from './support/world.ts';

type Person = 'steward' | 'researcher' | 'viewer';

let world: World;
let credentials: Record<Person, string>;
let tokens: Record<Person, AccessToken>;
let missionId: string;

/** The app as the client's fetch. `drop` loses the answer of the next POST after the API has handled it. */
const transport = { dropNextPost: false };
const fetch: Fetch = async (url, init) => {
  const response = await world.testApp.app.request(url, init as RequestInit);
  if (init.method === 'POST' && transport.dropNextPost) {
    transport.dropNextPost = false;
    throw new TypeError('the connection closed before the answer arrived');
  }
  return response;
};

let counter = 0;
function clientFor(person?: Person): ApiClient {
  return new ApiClient({
    baseUrl: 'http://api.test',
    fetch,
    now: () => world.testApp.clock.now(),
    newCommandId: () => `cmd-client-${++counter}`,
    readBack: { attempts: 2, delayMs: 0 },
    ...(person === undefined ? {} : { auth: { accessToken: async () => tokens[person].access_token } }),
  });
}

const applied = (outcome: CommandOutcome) => {
  if (outcome.state !== 'APPLIED') throw new Error(`expected APPLIED, got ${outcome.state}`);
  return outcome.status;
};
const forbidden = (outcome: CommandOutcome) => {
  expect(outcome.state).toBe('REJECTED');
  if (outcome.state !== 'REJECTED') return;
  expect(outcome.error).toBeInstanceOf(ForbiddenError);
  expect(outcome.error.stateChanged).toBe('NONE');
};

beforeAll(async () => {
  world = await createWorld();
  credentials = await world.tx(async (tx) => {
    const issue = async (principalId: string) =>
      (
        await issueCredential(tx, world.testApp.env.ids, new Date(NOW), {
          principalId,
          principalKind: 'HUMAN',
          issuedBy: ids.admin,
        })
      ).token;
    return {
      steward: await issue(ids.steward),
      researcher: await issue(ids.researcher),
      viewer: await issue(ids.viewer),
    };
  });
});
afterAll(async () => {
  await world.drop();
});

describe('login', () => {
  it('exchanges a credential for an access token and reads the environment with it', async () => {
    const bare = clientFor();
    tokens = {
      steward: await bare.exchangeCredential(credentials.steward),
      researcher: await bare.exchangeCredential(credentials.researcher),
      viewer: await bare.exchangeCredential(credentials.viewer),
    };
    expect(tokens.researcher.roles).toEqual(['Researcher']);
    expect(tokens.researcher.principal.id).toBe(ids.researcher);
    expect(tokens.steward.roles).toEqual(['Steward']);
    expect((await clientFor('viewer').identity()).environment).toBe('DEVELOPMENT');
    await expect(bare.exchangeCredential('oqk1.unknown.secret')).rejects.toBeInstanceOf(UnauthenticatedError);
  });
});

describe('commands', () => {
  it('apply the registrations with client command IDs, read back by those IDs', async () => {
    const steward = clientFor('steward');
    const budget = await steward.registerBudget(world.docs.budget as never, { expectedRevision: 0 });
    expect(applied(budget).record).toEqual({ id: 'staging-period-cap', revision: 1 });
    expect(budget.request.command_id).toMatch(/^cmd-client-\d+$/);
    expect(await clientFor('viewer').commandStatus(budget.request.command_id)).toEqual(applied(budget));
    applied(await steward.registerResearchProfile(world.docs.profile as never, { expectedRevision: 0 }));
    applied(await steward.registerCohortPolicy(world.docs.policy as never, { expectedRevision: 0 }));
    const { kind: _kind, ...seed } = { kind: 'register_seed', ...world.docs.seed };
    applied(await clientFor('researcher').registerSeed(seed as never, { expectedRevision: 0 }));
  });

  it('create a mission, read it back, start it, and resynchronise a stale revision from the mission', async () => {
    const researcher = clientFor('researcher');
    const created = applied(
      await researcher.createMission((missionPayload(world) as Doc).mission, { expectedRevision: 0 }),
    );
    missionId = created.record.id;
    const view = await researcher.mission(missionId);
    expect(view).toMatchObject({ mission_id: missionId, status: 'CREATED', revision: 1 });
    const started = applied(await researcher.runMissionNow(missionId, { expectedRevision: view.revision }));
    expect(started.record).toEqual({ id: missionId, revision: 2 });
    const stale = await researcher.cancelMission(missionId, 'Stop.', { expectedRevision: 1 });
    expect(stale.state).toBe('REJECTED');
    if (stale.state !== 'REJECTED') return;
    expect(stale.error).toBeInstanceOf(RevisionConflictError);
    const conflict = stale.error as RevisionConflictError;
    expect(conflict.currentRevision).toBe(2);
    expect(conflict.resync.mission).toMatchObject({ mission_id: missionId, status: 'IN_PROGRESS', revision: 2 });
    expect(await world.sql('SELECT status FROM missions WHERE mission_id = $1', [missionId])).toEqual([
      { status: 'IN_PROGRESS' },
    ]);
  });

  it('settle a command whose answer was lost by reading it back: it was applied once', async () => {
    const steward = clientFor('steward');
    const budget = { ...world.docs.budget, budget_id: 'lost-answer-cap' };
    transport.dropNextPost = true;
    const outcome = await steward.registerBudget(budget as never, { expectedRevision: 0 });
    expect(outcome.state).toBe('APPLIED');
    expect(await world.sql(`SELECT revision FROM budget_caps WHERE budget_id = 'lost-answer-cap'`)).toEqual([
      { revision: 1 },
    ]);
    // Resolving it again sends nothing new: the read-back finds it.
    const again = await steward.resolveCommand('budgets.register', outcome.request);
    expect(again.state).toBe('APPLIED');
    expect(
      await world.sql(`SELECT count(*)::int AS n FROM commands WHERE command_id = $1`, [outcome.request.command_id]),
    ).toEqual([{ n: 1 }]);
  });

  it('report an answer that never comes as UNKNOWN, not as a failure', async () => {
    const unreachable = new ApiClient({
      baseUrl: 'http://api.test',
      fetch: async () => {
        throw new TypeError('connect ECONNREFUSED');
      },
      auth: { accessToken: async () => tokens.steward.access_token },
      readBack: { attempts: 1, delayMs: 0 },
    });
    const outcome = await unreachable.registerBudget(world.docs.budget as never, { expectedRevision: 1 });
    expect(outcome.state).toBe('UNKNOWN');
    if (outcome.state === 'UNKNOWN') expect(outcome.cause).toBeInstanceOf(TransportError);
  });
});

describe('views', () => {
  it('parse every read route of the mission against its contract', async () => {
    const viewer = clientFor('viewer');
    expect((await viewer.mission(missionId)).status).toBe('IN_PROGRESS');
    expect((await viewer.lineage(missionId)).mission_id).toBe(missionId);
    expect((await viewer.trials(missionId)).mission_id).toBe(missionId);
    expect((await viewer.findings(missionId)).findings).toEqual([]);
    expect((await viewer.gates(missionId)).reports).toEqual([]);
    const decisions = await viewer.decisions(missionId);
    expect(decisions.decisions.map((decision) => decision.kind)).toEqual(['POLICY_APPROVAL']);
  });
});

describe('authority', () => {
  it('refuses a Researcher every Steward command, and changes nothing', async () => {
    const researcher = clientFor('researcher');
    const before = await world.snapshot();
    forbidden(
      await researcher.registerBudget({ ...world.docs.budget, budget_id: 'other-cap' } as never, {
        expectedRevision: 0,
      }),
    );
    forbidden(
      await researcher.registerResearchProfile({ ...world.docs.profile, revision: 2 } as never, {
        expectedRevision: 1,
      }),
    );
    forbidden(
      await researcher.registerCohortPolicy({ ...world.docs.policy, revision: 2 } as never, { expectedRevision: 1 }),
    );
    expect(await world.snapshot()).toEqual(before);
  });

  it('refuses a Viewer every write, and lets the Viewer read', async () => {
    const viewer = clientFor('viewer');
    const before = await world.snapshot();
    forbidden(await viewer.createMission((missionPayload(world) as Doc).mission, { expectedRevision: 0 }));
    forbidden(await viewer.runMissionNow(missionId, { expectedRevision: 2 }));
    forbidden(await viewer.cancelMission(missionId, 'Stop.', { expectedRevision: 2 }));
    forbidden(
      await viewer.registerBudget({ ...world.docs.budget, budget_id: 'viewer-cap' } as never, { expectedRevision: 0 }),
    );
    const { kind: _kind, ...seed } = { kind: 'register_seed', ...world.docs.seed };
    forbidden(await viewer.registerSeed(seed as never, { expectedRevision: 0 }));
    expect(await world.snapshot()).toEqual(before);
    expect((await viewer.mission(missionId)).revision).toBe(2);
  });
});

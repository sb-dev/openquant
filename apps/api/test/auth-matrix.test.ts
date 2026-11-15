// The authentication and permission matrix: every route that the API host serves, called with every class of
// credential. The expected answer comes from an oracle that reads the raw route manifest, not from src/manifest.ts, and
// from a hand-written table of who may call what, taken from the specification. A missing or wrong credential gets
// the error that the manifest maps: 401 UNAUTHENTICATED or 403 FORBIDDEN, or the 409 of a capability whose lease ended.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseContract } from '@openquant/api-contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signAccessToken } from '../src/auth/tokens.ts';
import {
  type Actors,
  accessTokenFor,
  type HumanName,
  type MintedCapability,
  mintCapability,
  seedActors,
} from './support/actors.ts';
import { bearer, createTestApp, type TestApp } from './support/app.ts';
import { sha } from './support/seed.ts';

interface RawRoute {
  id: string;
  host: string;
  method: string;
  path: string;
  auth: { kind: string; roles?: string[]; principals?: string[] }[];
}
interface RawManifest {
  routes: RawRoute[];
  error_status: Record<string, number>;
}
const raw = JSON.parse(
  readFileSync(resolve(fileURLToPath(import.meta.url), '../../../../packages/api-contracts/routes/v1.json'), 'utf8'),
) as RawManifest;
const served = raw.routes.filter((route) => route.host === 'api');

// What each role and service may call, from OQ-02 section 4, OQ-05 sections 4 and 9 and the pilot record: the specification
// text, written out by hand. The oracle below is checked against it, and so are the live answers.
const everyRole: HumanName[] = ['viewer', 'researcher', 'steward', 'admin'];
const specification: Record<
  string,
  { people?: HumanName[]; credential?: true; services?: string[]; attempts?: string[] }
> = {
  'auth.token': { credential: true },
  'system.identity': { people: everyRole, services: ['workflows'] },
  'releases.record': { people: ['admin'], services: ['deploy'] },
  'research-profiles.register': { people: ['steward'] },
  'cohort-policies.register': { people: ['steward'] },
  'budgets.register': { people: ['steward'] },
  'seeds.register': { people: ['researcher'] },
  'missions.create': { people: ['researcher'] },
  'missions.run-now': { people: ['researcher'] },
  'missions.cancel': { people: ['researcher'] },
  'attempts.claim': { services: ['batch', 'runner'] },
  'attempts.input': { attempts: ['batch', 'runner'] },
  'attempts.artefact': { attempts: ['batch', 'runner'] },
  'attempts.retrieval-result': { attempts: ['batch'] },
  'attempts.validation-result': { attempts: ['batch'] },
  'attempts.evaluation-submission': { attempts: ['batch'] },
  'attempts.gate-report': { attempts: ['batch'] },
  'attempts.agent-result': { attempts: ['runner'] },
};
for (const id of [
  'missions.show',
  'missions.plan',
  'missions.lineage',
  'missions.trials',
  'missions.findings',
  'missions.gates',
  'missions.decisions',
  'commands.show',
  'runs.metrics',
  'runs.result',
  'jobs.show',
]) {
  specification[id] = { people: everyRole };
}

const PEOPLE_ROLE: Record<HumanName, string> = {
  viewer: 'Viewer',
  researcher: 'Researcher',
  steward: 'Steward',
  admin: 'Administrator',
};

type Outcome = 'allowed' | 'UNAUTHENTICATED' | 'FORBIDDEN' | 'LEASE_EXPIRED' | 'STALE_OWNERSHIP';

// The oracle: who the raw manifest lets in.
const ruleOf = (route: RawRoute, kind: string) => route.auth.filter((rule) => rule.kind === kind);
const oracle = {
  person: (route: RawRoute, name: HumanName): Outcome =>
    ruleOf(route, 'human').some((rule) => rule.roles?.includes(PEOPLE_ROLE[name])) ? 'allowed' : 'FORBIDDEN',
  credential: (route: RawRoute): Outcome => (ruleOf(route, 'human_credential').length > 0 ? 'allowed' : 'FORBIDDEN'),
  service: (route: RawRoute, kind: string, operations: boolean): Outcome =>
    operations && ruleOf(route, 'service').some((rule) => rule.principals?.includes(kind)) ? 'allowed' : 'FORBIDDEN',
  attempt: (route: RawRoute, kind: string, state: string, samePath: boolean): Outcome => {
    const listed = ruleOf(route, 'attempt').some((rule) => rule.principals?.includes(kind));
    if (!listed || !samePath) return 'FORBIDDEN';
    // An attempt that ended passes authorisation, and its route decides: a result route answers a repeat of its own
    // submission, while the input and artefact routes read and write nothing once the lease has ended.
    const ended = route.id === 'attempts.input' || route.id === 'attempts.artefact' ? 'LEASE_EXPIRED' : 'allowed';
    return {
      live: 'allowed',
      completed: ended,
      lease_expired: 'LEASE_EXPIRED',
      stale: 'STALE_OWNERSHIP',
      expired_by_time: 'LEASE_EXPIRED',
    }[state] as Outcome;
  },
};

let testApp: TestApp;
let actors: Actors;
const access = {} as Record<HumanName, string>;
const capabilities: Record<string, MintedCapability & { kind: string; state: string }> = {};

function pathOf(route: RawRoute, attemptId: string): string {
  return route.path
    .replace('{attempt_id}', attemptId)
    .replace('{digest}', sha('artefact'))
    .replace(/\{[a-z_]+\}/g, 'x-1');
}

async function call(route: RawRoute, token: string | undefined, attemptId = 'att-x'): Promise<Response> {
  const headers: Record<string, string> = token === undefined ? {} : bearer(token);
  const method = route.method;
  return testApp.request(pathOf(route, attemptId), method === 'GET' ? { headers } : { method, headers, body: '{}' });
}

const statusOf = (code: string): number => raw.error_status[code] as number;

async function expectOutcome(label: string, response: Response, outcome: Outcome): Promise<string | undefined> {
  if (outcome === 'allowed') {
    // Past authorisation the answer is a validation error, a deferred route or a success: never 401, 403 or a lease error.
    return [401, 403].includes(response.status) || (await response.clone().text()).includes('LEASE_EXPIRED')
      ? `${label}: expected to be allowed, got ${response.status}`
      : undefined;
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  const parsed = parseContract('api-error', bytes);
  if (!parsed.ok) return `${label}: the error body is not api-error/1`;
  if (parsed.value.code !== outcome) return `${label}: expected ${outcome}, got ${parsed.value.code}`;
  if (response.status !== statusOf(outcome))
    return `${label}: expected status ${statusOf(outcome)}, got ${response.status}`;
  return undefined;
}

beforeAll(async () => {
  testApp = await createTestApp();
  actors = await seedActors(testApp);
  for (const name of everyRole) access[name] = await accessTokenFor(testApp, actors.people[name]);
  const make = async (
    key: string,
    state: 'live' | 'lease_expired' | 'stale' | 'completed' | 'expires_soon',
    principal: string,
    kind: string,
  ) => {
    capabilities[key] = {
      ...(await mintCapability(testApp, state, principal)),
      kind,
      state: state === 'expires_soon' ? 'expired_by_time' : state,
    };
  };
  await make('batch-live', 'live', 'svc-batch', 'batch');
  await make('runner-live', 'live', 'svc-runner', 'runner');
  await make('batch-lease-expired', 'lease_expired', 'svc-batch', 'batch');
  await make('batch-stale', 'stale', 'svc-batch', 'batch');
  await make('batch-completed', 'completed', 'svc-batch', 'batch');
  await make('runner-lease-expired', 'lease_expired', 'svc-runner', 'runner');
  await make('workflows-live', 'live', 'svc-workflows', 'workflows');
  await make('batch-soon', 'expires_soon', 'svc-batch', 'batch');
});
afterAll(async () => {
  await testApp.drop();
});

describe('the specification and the manifest agree on who may call what', () => {
  it('lists every served route, and the manifest has the 29 routes of the API host', () => {
    expect(served).toHaveLength(29);
    expect(Object.keys(specification).sort()).toEqual(served.map((route) => route.id).sort());
  });

  for (const route of served) {
    it(`${route.id}: the roles, services and attempt principals of the manifest are those of the specification`, () => {
      const wanted = specification[route.id] ?? {};
      const people = everyRole.filter((name) => oracle.person(route, name) === 'allowed');
      expect(people, 'people').toEqual(everyRole.filter((name) => wanted.people?.includes(name)));
      expect(oracle.credential(route) === 'allowed', 'person credential').toBe(wanted.credential === true);
      const services = ['batch', 'runner', 'workflows', 'deploy'].filter(
        (kind) => oracle.service(route, kind, true) === 'allowed',
      );
      expect(services, 'services').toEqual(
        ['batch', 'runner', 'workflows', 'deploy'].filter((kind) => wanted.services?.includes(kind)),
      );
      const attempts = ['batch', 'runner', 'workflows', 'deploy'].filter(
        (kind) => oracle.attempt(route, kind, 'live', true) === 'allowed',
      );
      expect(attempts, 'attempt capabilities').toEqual(
        ['batch', 'runner', 'workflows', 'deploy'].filter((kind) => wanted.attempts?.includes(kind)),
      );
    });
  }
});

describe('a missing or wrong credential gets the manifest error', () => {
  for (const route of served) {
    it(`${route.id}: no, malformed, unknown, wrongly signed and expired credentials are UNAUTHENTICATED`, async () => {
      const key = testApp.env.secrets.tokenSigningKey;
      const now = Math.floor(testApp.clock.now().getTime() / 1000);
      const bad: [string, string | undefined][] = [
        ['no header', undefined],
        ['garbage', 'garbage'],
        ['access prefix only', 'oqa1.'],
        ['capability prefix only', 'oqp1.x.y'],
        ['unknown credential', `oqk1.cred-ffffff.${'A'.repeat(43)}`],
        [
          'another key',
          await signAccessToken(new Uint8Array(32).fill(7), {
            sub: 'human-admin',
            env: 'DEVELOPMENT',
            iat: now,
            exp: now + 900,
          }),
        ],
        [
          'expired access token',
          await signAccessToken(key, { sub: 'human-admin', env: 'DEVELOPMENT', iat: now - 1000, exp: now - 100 }),
        ],
        [
          'access token of an unknown person',
          await signAccessToken(key, { sub: 'human-nobody', env: 'DEVELOPMENT', iat: now, exp: now + 900 }),
        ],
        [
          'access token of a service',
          await signAccessToken(key, { sub: 'svc-batch', env: 'DEVELOPMENT', iat: now, exp: now + 900 }),
        ],
      ];
      const problems: string[] = [];
      for (const [label, token] of bad) {
        const problem = await expectOutcome(`${route.id} with ${label}`, await call(route, token), 'UNAUTHENTICATED');
        if (problem) problems.push(problem);
      }
      // A scheme other than Bearer is not a credential.
      const basic = await testApp.request(pathOf(route, 'att-x'), {
        method: route.method === 'GET' ? 'GET' : route.method,
        headers: { authorization: `Basic ${actors.people.admin}` },
      });
      const problem = await expectOutcome(`${route.id} with Basic`, basic, 'UNAUTHENTICATED');
      if (problem) problems.push(problem);
      expect(problems).toEqual([]);
    });
  }
});

describe('a valid credential is allowed or refused as the manifest says', () => {
  for (const route of served) {
    it(`${route.id}: each role, person credential and service credential`, async () => {
      const problems: string[] = [];
      const check = async (label: string, token: string, outcome: Outcome) => {
        const problem = await expectOutcome(`${route.id} with ${label}`, await call(route, token), outcome);
        if (problem) problems.push(problem);
      };
      for (const name of everyRole) await check(`${name} access token`, access[name], oracle.person(route, name));
      for (const name of everyRole) {
        await check(
          `${name} long-lived credential`,
          actors.people[name],
          name === 'viewer' || name === 'researcher' || name === 'steward' || name === 'admin'
            ? oracle.credential(route)
            : 'FORBIDDEN',
        );
      }
      for (const kind of ['batch', 'runner', 'workflows', 'deploy'] as const) {
        await check(`${kind} service credential`, actors.services.full[kind], oracle.service(route, kind, true));
        await check(
          `${kind} service credential without the operation`,
          actors.services.none[kind],
          oracle.service(route, kind, false),
        );
      }
      expect(problems).toEqual([]);
    });
  }
});

describe('an attempt capability', () => {
  for (const route of served) {
    it(`${route.id}: is judged by its principal, its attempt and its lease`, async () => {
      const problems: string[] = [];
      for (const [name, capability] of Object.entries(capabilities)) {
        if (name === 'batch-soon') continue;
        const matching = await expectOutcome(
          `${route.id} with ${name}`,
          await call(route, capability.token, capability.attemptId),
          oracle.attempt(route, capability.kind, capability.state, route.path.includes('{attempt_id}')),
        );
        if (matching) problems.push(matching);
        // The same capability on the path of another attempt is refused, whatever the state of the lease.
        const other = await expectOutcome(
          `${route.id} with ${name} for another attempt`,
          await call(route, capability.token, 'att-other'),
          'FORBIDDEN',
        );
        if (other) problems.push(other);
      }
      expect(problems).toEqual([]);
    });
  }

  it('is a person-less credential: a capability and a person credential are different kinds, in both directions', async () => {
    const live = capabilities['batch-live'] as MintedCapability;
    const identity = served.find((route) => route.id === 'system.identity') as RawRoute;
    const token = served.find((route) => route.id === 'auth.token') as RawRoute;
    expect(
      await expectOutcome('capability on identity', await call(identity, live.token), 'FORBIDDEN'),
    ).toBeUndefined();
    expect(
      await expectOutcome('capability on the token route', await call(token, live.token), 'FORBIDDEN'),
    ).toBeUndefined();
  });

  it('records the rejection of a late submission, once for each attempt that it came from', async () => {
    const stale = capabilities['batch-stale'] as MintedCapability;
    const route = served.find((entry) => entry.id === 'attempts.retrieval-result') as RawRoute;
    await call(route, stale.token, stale.attemptId);
    const rows = await testApp.database.sql<{
      detail: { route: string; code: string };
      actor: string;
      subject: string;
    }>(
      `SELECT actor, subject, detail FROM audit_events WHERE event_type = 'attempt.late_submission_rejected' AND subject = $1 ORDER BY audit_id DESC`,
      [stale.attemptId],
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]).toMatchObject({
      actor: 'svc-batch',
      detail: { route: 'attempts.retrieval-result', code: 'STALE_OWNERSHIP' },
    });
    // The rejection changes nothing else: the attempt and its job are as they were.
    const attempt = await testApp.database.sql<{ status: string }>(
      'SELECT status FROM attempts WHERE attempt_id = $1',
      [stale.attemptId],
    );
    expect(attempt[0]?.status).toBe('LEASE_EXPIRED');
  });

  it('expires with its lease: the same capability is live, and then LEASE_EXPIRED when the lease time has passed', async () => {
    const soon = capabilities['batch-soon'] as MintedCapability;
    const route = served.find((entry) => entry.id === 'attempts.input') as RawRoute;
    expect(
      await expectOutcome('before expiry', await call(route, soon.token, soon.attemptId), 'allowed'),
    ).toBeUndefined();
    testApp.clock.advanceSeconds(9);
    expect(
      await expectOutcome('one second before', await call(route, soon.token, soon.attemptId), 'allowed'),
    ).toBeUndefined();
    testApp.clock.advanceSeconds(1);
    expect(
      await expectOutcome('at the expiry', await call(route, soon.token, soon.attemptId), 'LEASE_EXPIRED'),
    ).toBeUndefined();
  });
});

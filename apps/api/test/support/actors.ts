// People and services for the application tests: the seed graph, committed, with a long-lived credential for every
// principal, issued by the application's own code, and attempt capabilities in each state.

import { capabilityHash, issueCredential } from '../../src/auth/credentials.ts';
import { signCapability } from '../../src/auth/tokens.ts';
import { apiRoutes, type ServiceKind } from '../../src/manifest.ts';
import { bearer, bodyOf, type TestApp } from './app.ts';
import { ids, insertAttempt, insertJob, insertLease, insertPool, NOW, seedGraph } from './seed.ts';

export type HumanName = 'admin' | 'steward' | 'researcher' | 'viewer';

export interface Actors {
  /** Long-lived credentials of the four people, as they present them. */
  readonly people: Readonly<Record<HumanName, string>>;
  /** Long-lived credentials of the four services: scoped to every route, or to one unrelated operation. */
  readonly services: Readonly<Record<'full' | 'none', Readonly<Record<ServiceKind, string>>>>;
  readonly principalIds: Readonly<Record<HumanName | ServiceKind, string>>;
}

const people: Record<HumanName, string> = {
  admin: ids.admin,
  steward: ids.steward,
  researcher: ids.researcher,
  viewer: ids.viewer,
};
const services: Record<ServiceKind, string> = {
  batch: ids.batch,
  runner: ids.runner,
  workflows: ids.workflows,
  deploy: ids.deploy,
};

/** The routes of the API host: what a "full" service credential names. */
export const everyOperation: readonly string[] = apiRoutes.map((route) => route.id);

export async function seedActors(testApp: TestApp): Promise<Actors> {
  const now = new Date(NOW);
  return testApp.database.db.transaction(async (tx) => {
    await seedGraph(tx);
    const issue = async (principalId: string, kind: 'HUMAN' | 'SERVICE', operations?: readonly string[]) =>
      (
        await issueCredential(tx, testApp.env.ids, now, {
          principalId,
          principalKind: kind,
          ...(operations === undefined ? {} : { operations }),
          issuedBy: ids.admin,
        })
      ).token;
    const humanTokens = {} as Record<HumanName, string>;
    for (const [name, principal] of Object.entries(people) as [HumanName, string][]) {
      humanTokens[name] = await issue(principal, 'HUMAN');
    }
    const full = {} as Record<ServiceKind, string>;
    const none = {} as Record<ServiceKind, string>;
    for (const [kind, principal] of Object.entries(services) as [ServiceKind, string][]) {
      full[kind] = await issue(principal, 'SERVICE', everyOperation);
      none[kind] = await issue(principal, 'SERVICE', ['unrelated.operation']);
    }
    return { people: humanTokens, services: { full, none }, principalIds: { ...people, ...services } };
  });
}

/** A 15-minute access token, obtained from the token route with a person's credential. */
export async function accessTokenFor(testApp: TestApp, credential: string): Promise<string> {
  const response = await testApp.request('/v1/auth/token', { method: 'POST', headers: bearer(credential) });
  if (response.status !== 200) throw new Error(`auth.token answered ${response.status}`);
  return (await bodyOf<{ access_token: string }>(response)).access_token;
}

export type CapabilityState = 'live' | 'expires_soon' | 'lease_expired' | 'stale' | 'completed';

let capabilityCounter = 0;

export interface MintedCapability {
  readonly token: string;
  readonly attemptId: string;
  readonly jobId: string;
  readonly ownershipRevision: number;
}

/**
 * An attempt of a new retrieve job, in the given state, and the capability that its claim would have granted. The
 * lease expires 300 seconds after the test clock, 10 seconds for `expires_soon`.
 */
export async function mintCapability(
  testApp: TestApp,
  state: CapabilityState,
  principal: string = ids.batch,
): Promise<MintedCapability> {
  capabilityCounter += 1;
  const jobId = `job-cap-${capabilityCounter}`;
  const attemptId = `att-cap-${capabilityCounter}`;
  const granted = testApp.clock.now();
  const expiresAt = new Date(granted.getTime() + (state === 'expires_soon' ? 10 : 300) * 1000);
  const token = await signCapability(testApp.env.secrets.tokenSigningKey, {
    sub: principal,
    env: testApp.env.environment,
    att: attemptId,
    own: 1,
    iat: Math.floor(granted.getTime() / 1000),
    exp: Math.floor(expiresAt.getTime() / 1000),
  });
  const hash = await capabilityHash(token);
  await testApp.database.db.transaction(async (tx) => {
    await insertJob(tx, { jobId, kind: 'retrieve', status: state === 'completed' ? 'COMPLETED' : 'RUNNING' });
    const poolId = await insertPool(tx);
    const status = {
      live: 'CLAIMED',
      expires_soon: 'CLAIMED',
      lease_expired: 'LEASE_EXPIRED',
      stale: 'LEASE_EXPIRED',
      completed: 'COMPLETED',
    }[state];
    await insertAttempt(tx, { attemptId, jobId, poolId, status });
    if (status === 'CLAIMED') {
      await tx.query('UPDATE leases SET capability_hash = $2, expires_at = $3 WHERE attempt_id = $1', [
        attemptId,
        hash,
        expiresAt,
      ]);
    } else {
      await insertLease(tx, attemptId, 1, status === 'COMPLETED' ? 'RELEASED' : 'EXPIRED');
      await tx.query('UPDATE leases SET capability_hash = $2, expires_at = $3 WHERE attempt_id = $1', [
        attemptId,
        hash,
        expiresAt,
      ]);
    }
    if (state === 'stale') {
      await insertAttempt(tx, { attemptId: `${attemptId}-next`, jobId, revision: 2, poolId });
    }
  });
  return { token, attemptId, jobId, ownershipRevision: 1 };
}

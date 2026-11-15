// The Worker entry (src/worker.ts) with fake bindings, against the real node-postgres adapter and the test database: a
// HYPERDRIVE-shaped object whose connection string is the test cluster, a fake R2 bucket and a fake execution
// context. The runtime itself (workerd, Hyperdrive, R2) is not covered: P6's deployment probe is the first run there.

import { randomBytes } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { toBase64Url } from '../src/auth/encoding.ts';
import type { WorkerBindings } from '../src/env.ts';
import worker, { workerEnv } from '../src/worker.ts';
import { type Actors, accessTokenFor, seedActors } from './support/actors.ts';
import { bearer, createTestApp, type TestApp } from './support/app.ts';

const signingKey = new Uint8Array(randomBytes(32));
let testApp: TestApp;
let actors: Actors;

beforeAll(async () => {
  testApp = await createTestApp({ signingKey });
  actors = await seedActors(testApp);
});
afterAll(async () => {
  await testApp.drop();
});
afterEach(() => {
  vi.restoreAllMocks();
});

function bindings(overrides: Record<string, unknown> = {}): WorkerBindings {
  return {
    HYPERDRIVE: { connectionString: testApp.database.url },
    ARTEFACTS: {},
    TOKEN_SIGNING_KEY: toBase64Url(signingKey),
    OPENQUANT_ENVIRONMENT: 'DEVELOPMENT',
    ...overrides,
  } as unknown as WorkerBindings;
}

function context() {
  const work: Promise<unknown>[] = [];
  return {
    work,
    ctx: {
      waitUntil: (promise: Promise<unknown>) => {
        work.push(promise);
      },
      passThroughOnException: () => undefined,
    } as unknown as ExecutionContext,
  };
}

async function activeConnections(): Promise<number> {
  const rows = await testApp.database.sql<{ count: string }>(
    `SELECT count(*) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
    [testApp.database.name],
  );
  return Number(rows[0]?.count);
}

describe('the Worker entry', () => {
  it('serves a request through the real adapter, and closes its connection with waitUntil', async () => {
    const { ctx, work } = context();
    const response = await worker.fetch(new Request('http://localhost/health'), bindings(), ctx);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
    // The handle is closed after the response, in the lifetime that waitUntil keeps open.
    expect(work).toHaveLength(1);
    await Promise.all(work);
    expect(await activeConnections()).toBe(0);
  });

  it('authenticates with the signing key of its secret and reads the identity of the database', async () => {
    // The Worker reads the real clock: the token is issued at the real time, not at the test clock's.
    testApp.clock.set(new Date());
    const access = await accessTokenFor(testApp, actors.people.viewer);
    const { ctx, work } = context();
    const response = await worker.fetch(
      new Request('http://localhost/v1/system/identity', { headers: bearer(access) }),
      bindings(),
      ctx,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ environment: 'DEVELOPMENT', protocol: { route_manifest: 'v1' } });
    await Promise.all(work);
    // The same token is refused when the secret is another key: the key comes from the binding, not from the code.
    const other = await worker.fetch(
      new Request('http://localhost/v1/system/identity', { headers: bearer(access) }),
      bindings({ TOKEN_SIGNING_KEY: toBase64Url(new Uint8Array(randomBytes(32))) }),
      context().ctx,
    );
    expect(other.status).toBe(401);
  });

  it('answers 500 INTERNAL, and says nothing of the binding, when one is missing or unusable', async () => {
    const broken: [string, Record<string, unknown>, string][] = [
      ['a missing secret', { TOKEN_SIGNING_KEY: undefined }, 'TOKEN_SIGNING_KEY'],
      ['a short secret', { TOKEN_SIGNING_KEY: 'short-secret-value' }, 'TOKEN_SIGNING_KEY'],
      ['a missing Hyperdrive binding', { HYPERDRIVE: undefined }, 'HYPERDRIVE'],
      ['an empty connection string', { HYPERDRIVE: { connectionString: '' } }, 'HYPERDRIVE'],
      ['a missing bucket', { ARTEFACTS: undefined }, 'ARTEFACTS'],
      ['an unknown environment', { OPENQUANT_ENVIRONMENT: 'LIVE' }, 'OPENQUANT_ENVIRONMENT'],
      ['no environment', { OPENQUANT_ENVIRONMENT: undefined }, 'OPENQUANT_ENVIRONMENT'],
    ];
    for (const [label, overrides, name] of broken) {
      const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const response = await worker.fetch(new Request('http://localhost/health'), bindings(overrides), context().ctx);
      expect(response.status, label).toBe(500);
      const text = await response.text();
      const body = JSON.parse(text) as { code: string; diagnostic_ref: string; message: string };
      expect(body.code, label).toBe('INTERNAL');
      expect(text, label).not.toContain(name);
      expect(text, label).not.toContain('short-secret-value');
      // The log line names the binding, never a value, under the reference of the response.
      expect(error).toHaveBeenCalledTimes(1);
      const line = String(error.mock.calls[0]?.[0]);
      expect(line, label).toContain(body.diagnostic_ref);
      expect(line, label).toContain(name);
      expect(line, label).not.toContain('short-secret-value');
      error.mockRestore();
    }
  });

  it('builds a fresh environment for each request and keeps no state between them', async () => {
    const first = workerEnv(bindings());
    const second = workerEnv(bindings());
    expect(first).not.toBe(second);
    expect(first.database()).not.toBe(first.database());
    expect(first.environment).toBe('DEVELOPMENT');
    expect(workerEnv(bindings({ OPENQUANT_ENVIRONMENT: 'PRODUCTION' })).environment).toBe('PRODUCTION');
  });

  it('logs one JSON line for an unexpected error and never a credential', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const response = await worker.fetch(
      new Request('http://localhost/health'),
      bindings({ TOKEN_SIGNING_KEY: undefined }),
      context().ctx,
    );
    expect(response.status).toBe(500);
    const entry = JSON.parse(String(error.mock.calls[0]?.[0])) as { level: string; diagnostic_ref: string };
    expect(entry.level).toBe('error');
    expect(entry.diagnostic_ref).toMatch(/^diag-[0-9a-f]{24}$/);
  });
});

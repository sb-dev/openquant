// The three routes that this part implements end to end: auth.token, system.identity and /health, on a real PostgreSQL
// database through the real Hono app. Expected values come from the raw route manifest, the migration directory and
// node:crypto, not from the code under test.

import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseContract } from '@openquant/api-contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.ts';
import { ACCESS_TOKEN_SECONDS, verifyAccessToken } from '../src/auth/tokens.ts';
import { readMigrationLevel } from '../src/db/migration-level.ts';
import type { ApiEnv } from '../src/env.ts';
import { type Actors, accessTokenFor, seedActors } from './support/actors.ts';
import { bearer, bodyOf, createTestApp, type TestApp } from './support/app.ts';
import { emptyDatabase } from './support/database.ts';
import { sha } from './support/seed.ts';

const directory = resolve(fileURLToPath(import.meta.url), '..');
const manifest = JSON.parse(
  readFileSync(resolve(directory, '../../../packages/api-contracts/routes/v1.json'), 'utf8'),
) as {
  routes: {
    host: string;
    request: { kind: string; contract?: string };
    response: { kind: string; contract?: string };
  }[];
};
const migrationIds = readdirSync(resolve(directory, '../migrations'))
  .filter((name) => name.endsWith('.sql'))
  .sort()
  .map((name) => name.replace(/\.sql$/, ''));

let testApp: TestApp;
let actors: Actors;

beforeAll(async () => {
  testApp = await createTestApp();
  actors = await seedActors(testApp);
});
afterAll(async () => {
  await testApp.drop();
});

interface TokenView {
  access_token: string;
  token_type: string;
  issued_at: string;
  expires_at: string;
  principal: { id: string; display_name: string; kind: string };
  roles: string[];
}

describe('auth.token (D12: a 15-minute access token for a person)', () => {
  it('exchanges a person credential for an access token that names the person and the roles', async () => {
    const response = await testApp.request('/v1/auth/token', {
      method: 'POST',
      headers: bearer(actors.people.steward),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(response.headers.get('cache-control')).toBe('no-store');
    const view = await bodyOf<TokenView>(response);
    expect(view.token_type).toBe('Bearer');
    expect(view.issued_at).toBe('2026-11-15T10:00:00Z');
    // 15 minutes: 900 seconds after the issue.
    expect(view.expires_at).toBe('2026-11-15T10:15:00Z');
    expect(ACCESS_TOKEN_SECONDS).toBe(900);
    expect(view.principal).toEqual({ id: 'human-steward', display_name: 'Person human-steward', kind: 'HUMAN' });
    expect(view.roles).toEqual(['Steward']);
    const checked = await verifyAccessToken(testApp.env.secrets.tokenSigningKey, view.access_token);
    expect(checked.ok && checked.claims.exp - checked.claims.iat).toBe(900);
  });

  it('writes the issue and its audit row, with the credential id and never the secret', async () => {
    await testApp.request('/v1/auth/token', { method: 'POST', headers: bearer(actors.people.researcher) });
    const rows = await testApp.database.sql<{
      actor: string;
      subject: string;
      detail: Record<string, string>;
      diagnostic_ref: string;
    }>(
      `SELECT actor, subject, detail, diagnostic_ref FROM audit_events WHERE event_type = 'auth.token_issued' ORDER BY audit_id DESC LIMIT 1`,
    );
    expect(rows[0]).toMatchObject({ actor: 'human-researcher', subject: 'human-researcher' });
    const secret = actors.people.researcher.split('.')[2] as string;
    expect(JSON.stringify(rows[0])).not.toContain(secret);
    expect(rows[0]?.detail.credential_id).toBe(actors.people.researcher.split('.')[1]);
    expect(rows[0]?.diagnostic_ref).toMatch(/^diag-/);
  });

  it('accepts only a person credential: an access token, a service credential and no credential are refused', async () => {
    const access = await accessTokenFor(testApp, actors.people.admin);
    const refusals = [
      ['an access token', bearer(access), 403],
      ['a service credential', bearer(actors.services.full.workflows), 403],
      ['no credential', {}, 401],
      ['a malformed credential', bearer('not-a-credential'), 401],
    ] as const;
    for (const [label, headers, status] of refusals) {
      const response = await testApp.request('/v1/auth/token', { method: 'POST', headers });
      expect(response.status, label).toBe(status);
      const body = await bodyOf<{ code: string }>(response);
      expect(body.code, label).toBe(status === 401 ? 'UNAUTHENTICATED' : 'FORBIDDEN');
    }
  });

  it('answers a 401 with the Bearer challenge', async () => {
    const response = await testApp.request('/v1/auth/token', { method: 'POST' });
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toBe('Bearer');
  });

  it('does not read a body on this route, however large', async () => {
    const response = await testApp.request('/v1/auth/token', {
      method: 'POST',
      headers: { ...bearer(actors.people.viewer), 'content-length': '999999999' },
      body: 'ignored',
    });
    expect(response.status).toBe(200);
  });
});

describe('system.identity (OQ-05 section 11)', () => {
  const identity = async (token: string) => testApp.request('/v1/system/identity', { headers: bearer(token) });

  it('shows the environment, the protocol, the migration level and that no release is recorded', async () => {
    const access = await accessTokenFor(testApp, actors.people.viewer);
    const response = await identity(access);
    expect(response.status).toBe(200);
    const view = await bodyOf<{
      environment: string;
      protocol: { route_manifest: string; contracts: string[] };
      migration_level: string;
      release: unknown;
      release_note: string | null;
      generated_at: string;
    }>(response);
    expect(view.environment).toBe('DEVELOPMENT');
    expect(view.protocol.route_manifest).toBe('v1');
    expect(view.migration_level).toBe(migrationIds.at(-1));
    expect(view.release).toBeNull();
    expect(view.release_note).toBe('No release manifest is recorded for DEVELOPMENT.');
    expect(view.generated_at).toBe('2026-11-15T10:00:00Z');
  });

  it('lists the contract tags of the served routes, and the error body, from the raw manifest', async () => {
    const access = await accessTokenFor(testApp, actors.people.viewer);
    const view = await bodyOf<{ protocol: { contracts: string[] } }>(await identity(access));
    const expected = new Set(['api-error/1']);
    for (const route of manifest.routes.filter((entry) => entry.host === 'api')) {
      if (route.request.kind === 'contract' && route.request.contract) expected.add(`${route.request.contract}/1`);
      if (route.response.kind === 'contract' && route.response.contract) expected.add(`${route.response.contract}/1`);
    }
    expect(view.protocol.contracts).toEqual([...expected].sort());
    // The agent-runner endpoint is not served here: its agent-dispatch contract is not listed.
    expect(view.protocol.contracts).not.toContain('agent-dispatch/1');
    expect(view.protocol.contracts).toContain('attempt-claim/1');
  });

  it('shows the current release of the environment, the newest of several, and no other environment', async () => {
    const document = (commit: string, environment = 'DEVELOPMENT') => ({
      schema_version: 'release-manifest/1',
      environment,
      source_commit: commit.repeat(40),
      migration_level: migrationIds.at(-1),
    });
    const insert = `INSERT INTO release_records (environment, source_commit, manifest_digest, migration_level, document, recorded_by, recorded_at)
      VALUES ($1, $2, $3, $4, $5, 'svc-deploy', $6)`;
    await testApp.database.sql(insert, [
      'DEVELOPMENT',
      'a'.repeat(40),
      sha('release-a'),
      migrationIds.at(-1),
      JSON.stringify(document('a')),
      '2026-11-14T09:00:00Z',
    ]);
    await testApp.database.sql(insert, [
      'DEVELOPMENT',
      'b'.repeat(40),
      sha('release-b'),
      migrationIds.at(-1),
      JSON.stringify(document('b')),
      '2026-11-15T09:00:00Z',
    ]);
    await testApp.database.sql(insert, [
      'STAGING',
      'c'.repeat(40),
      sha('release-c'),
      migrationIds.at(-1),
      JSON.stringify(document('c', 'STAGING')),
      '2026-11-15T09:30:00Z',
    ]);
    const access = await accessTokenFor(testApp, actors.people.viewer);
    const view = await bodyOf<{
      release: { manifest_digest: string; recorded_at: string; manifest: { source_commit: string } };
      release_note: null;
    }>(await identity(access));
    expect(view.release.manifest.source_commit).toBe('b'.repeat(40));
    expect(view.release.manifest_digest).toBe(sha('release-b'));
    expect(view.release.recorded_at).toBe('2026-11-15T09:00:00Z');
    expect(view.release_note).toBeNull();
  });

  it('is open to every role and to the workflows service, and to nothing else', async () => {
    for (const name of ['viewer', 'researcher', 'steward', 'admin'] as const) {
      const access = await accessTokenFor(testApp, actors.people[name]);
      expect((await identity(access)).status, name).toBe(200);
    }
    expect((await identity(actors.services.full.workflows)).status).toBe(200);
    for (const kind of ['batch', 'runner', 'deploy'] as const) {
      expect((await identity(actors.services.full[kind])).status, kind).toBe(403);
    }
    // A person's long-lived credential is for the token route only.
    expect((await identity(actors.people.viewer)).status).toBe(403);
    expect((await testApp.request('/v1/system/identity')).status).toBe(401);
  });

  it('refuses a workflows credential that does not name the route among its operations', async () => {
    expect((await identity(actors.services.none.workflows)).status).toBe(403);
  });

  it('fails with UNAVAILABLE, not a crash, when the database was never migrated', async () => {
    const empty = await emptyDatabase();
    try {
      await expect(readMigrationLevel(empty.db)).rejects.toMatchObject({ code: 'UNAVAILABLE' });
      // A table that exists but holds no migration row says the same.
      await empty.sql('CREATE TABLE schema_migrations (migration_id text PRIMARY KEY)');
      await expect(readMigrationLevel(empty.db)).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    } finally {
      await empty.drop();
    }
  });
});

describe('/health', () => {
  it('answers ok without any credential, and shows no identity data', async () => {
    const response = await testApp.request('/health');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('answers UNAVAILABLE as an api-error when the database does not answer', async () => {
    const broken: ApiEnv = {
      ...testApp.env,
      database: () => ({
        query: async () => {
          throw new Error('connection refused');
        },
        transaction: async () => {
          throw new Error('connection refused');
        },
        close: async () => undefined,
      }),
    };
    const response = await Promise.resolve(createApp(broken).request('/health'));
    expect(response.status).toBe(503);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const parsed = parseContract('api-error', bytes);
    expect(parsed.ok && parsed.value).toMatchObject({ code: 'UNAVAILABLE', retry_safe: true, state_changed: 'NONE' });
    expect(new TextDecoder().decode(bytes)).not.toContain('connection refused');
  });

  it('is not a manifest route, and a POST to it is an unknown route', async () => {
    expect((await testApp.request('/health', { method: 'POST' })).status).toBe(404);
  });
});

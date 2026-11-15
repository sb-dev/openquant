// Credentials (OQ-05 section 9): hash-only storage, lookup and refusal, revocation and expiry, disabled principals,
// environments, operation scopes and roles read per request. Everything runs against the real database and the real
// app. The expected hash is computed with node:crypto, and the secrets are searched for in every table.

import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  capabilityHash,
  createPrincipal,
  credentialHash,
  grantRole,
  issueCredential,
  parseCredentialToken,
  revokeCredential,
} from '../src/auth/credentials.ts';
import { type Actors, accessTokenFor, mintCapability, seedActors } from './support/actors.ts';
import { bearer, createTestApp, type TestApp } from './support/app.ts';

let testApp: TestApp;
let actors: Actors;

beforeAll(async () => {
  testApp = await createTestApp();
  actors = await seedActors(testApp);
});
afterAll(async () => {
  await testApp.drop();
});

const identity = (token: string) => testApp.request('/v1/system/identity', { headers: bearer(token) });
const sha256 = (text: string) => `sha256:${createHash('sha256').update(text).digest('hex')}`;

async function newPerson(
  id: string,
  options: { environment?: string; role?: 'Viewer' | 'Steward'; expiresAt?: Date } = {},
) {
  const now = testApp.clock.now();
  return testApp.database.db.transaction(async (tx) => {
    await createPrincipal(tx, now, {
      principalId: id,
      kind: 'HUMAN',
      displayName: id,
      environment: options.environment ?? 'DEVELOPMENT',
    });
    if (options.role !== 'Steward') await grantRole(tx, now, id, 'Viewer', 'human-admin');
    else await grantRole(tx, now, id, 'Steward', 'human-admin');
    return issueCredential(tx, testApp.env.ids, now, {
      principalId: id,
      principalKind: 'HUMAN',
      issuedBy: 'human-admin',
      ...(options.expiresAt === undefined ? {} : { expiresAt: options.expiresAt }),
    });
  });
}

describe('credential storage', () => {
  it('stores the hash of the secret with a domain prefix, as node:crypto computes it', async () => {
    const token = actors.people.viewer;
    const parsed = parseCredentialToken(token);
    expect(parsed).toBeDefined();
    const rows = await testApp.database.sql<{ secret_hash: string }>(
      'SELECT secret_hash FROM credentials WHERE credential_id = $1',
      [parsed?.credentialId],
    );
    expect(rows[0]?.secret_hash).toBe(sha256(`openquant-credential-v1\n${parsed?.secret}`));
    expect(rows[0]?.secret_hash).toBe(await credentialHash(parsed?.secret as string));
    // The plain hash of the secret, and the hash of a capability, are not the stored value.
    expect(rows[0]?.secret_hash).not.toBe(sha256(parsed?.secret as string));
    expect(await capabilityHash(parsed?.secret as string)).not.toBe(rows[0]?.secret_hash);
  });

  it('holds no secret, no credential and no token in any column of any table', async () => {
    const access = await accessTokenFor(testApp, actors.people.steward);
    const capability = await mintCapability(testApp, 'live');
    await identity(access);
    const credentials = [
      ...Object.values(actors.people),
      ...Object.values(actors.services.full),
      ...Object.values(actors.services.none),
    ];
    const needles = [
      ...credentials,
      ...credentials.map((token) => parseCredentialToken(token)?.secret as string),
      access,
      access.split('.')[2] as string,
      capability.token,
    ];
    expect(new Set(needles).size).toBe(needles.length);
    const tables = await testApp.database.sql<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`,
    );
    expect(tables.length).toBeGreaterThan(40);
    const patterns = needles.map((needle) => `%${needle}%`);
    for (const { table_name: table } of tables) {
      const hits = await testApp.database.sql<{ count: string }>(
        `SELECT count(*) FROM "${table}" t WHERE t::text LIKE ANY($1::text[])`,
        [patterns],
      );
      expect(hits[0]?.count, `table ${table}`).toBe('0');
    }
  });

  it('refuses a stored value that is not a hash', async () => {
    await expect(
      testApp.database.sql(
        `INSERT INTO credentials (credential_id, principal_id, principal_kind, secret_hash, created_at) VALUES ('cred-plain', 'human-viewer', 'HUMAN', $1, now())`,
        [actors.people.viewer],
      ),
    ).rejects.toMatchObject({ constraint: 'credentials_hash_only' });
  });

  it('issues a credential and its audit row in one transaction, and neither when the transaction fails', async () => {
    const now = testApp.clock.now();
    await expect(
      testApp.database.db.transaction(async (tx) => {
        await issueCredential(tx, testApp.env.ids, now, {
          principalId: 'human-viewer',
          principalKind: 'HUMAN',
          issuedBy: 'human-admin',
        });
        throw new Error('the command failed after the credential was written');
      }),
    ).rejects.toThrow(/the command failed/);
    const before = await testApp.database.sql<{ credentials: string; audits: string }>(
      `SELECT (SELECT count(*) FROM credentials) AS credentials, (SELECT count(*) FROM audit_events WHERE event_type = 'auth.credential_issued') AS audits`,
    );
    const issued = await testApp.database.db.transaction((tx) =>
      issueCredential(tx, testApp.env.ids, now, {
        principalId: 'human-viewer',
        principalKind: 'HUMAN',
        issuedBy: 'human-admin',
      }),
    );
    const after = await testApp.database.sql<{ credentials: string; audits: string }>(
      `SELECT (SELECT count(*) FROM credentials) AS credentials, (SELECT count(*) FROM audit_events WHERE event_type = 'auth.credential_issued') AS audits`,
    );
    expect(Number(after[0]?.credentials)).toBe(Number(before[0]?.credentials) + 1);
    expect(Number(after[0]?.audits)).toBe(Number(before[0]?.audits) + 1);
    const audit = await testApp.database.sql<{ detail: { credential_id: string } }>(
      `SELECT detail FROM audit_events WHERE event_type = 'auth.credential_issued' ORDER BY audit_id DESC LIMIT 1`,
    );
    expect(audit[0]?.detail.credential_id).toBe(issued.credentialId);
    expect(JSON.stringify(audit[0])).not.toContain(parseCredentialToken(issued.token)?.secret as string);
  });

  it('refuses a service credential that names no operation', async () => {
    await expect(
      testApp.database.db.transaction((tx) =>
        issueCredential(tx, testApp.env.ids, testApp.clock.now(), {
          principalId: 'svc-batch',
          principalKind: 'SERVICE',
          issuedBy: 'human-admin',
        }),
      ),
    ).rejects.toMatchObject({ constraint: 'credentials_operations_shape' });
  });
});

describe('what a credential must be', () => {
  it('is refused with a wrong secret, a wrong id, the secret of another credential, or a changed character', async () => {
    const parsed = parseCredentialToken(actors.services.full.workflows);
    const other = parseCredentialToken(actors.services.full.batch);
    const secret = parsed?.secret as string;
    const flipped = `${secret.slice(0, -1)}${secret.endsWith('A') ? 'B' : 'A'}`;
    const tries = [
      `oqk1.${parsed?.credentialId}.${flipped}`,
      `oqk1.${parsed?.credentialId}.${other?.secret}`,
      `oqk1.${other?.credentialId}.${secret}`,
      `oqk1.cred-000000.${secret}`,
      `oqk1.${parsed?.credentialId}.${secret.slice(0, -1)}`,
      `oqk1.${parsed?.credentialId}.${secret}x`,
      `oqk2.${parsed?.credentialId}.${secret}`,
    ];
    for (const token of tries) expect((await identity(token)).status, token).toBe(401);
    expect((await identity(actors.services.full.workflows)).status).toBe(200);
  });

  it('is refused after it is revoked, and the revocation is audited', async () => {
    const issued = await newPerson('human-revoked');
    const access = await accessTokenFor(testApp, issued.token);
    expect((await identity(access)).status).toBe(200);
    expect((await testApp.request('/v1/auth/token', { method: 'POST', headers: bearer(issued.token) })).status).toBe(
      200,
    );
    await testApp.database.db.transaction((tx) =>
      revokeCredential(tx, testApp.clock.now(), issued.credentialId, 'human-admin'),
    );
    expect((await testApp.request('/v1/auth/token', { method: 'POST', headers: bearer(issued.token) })).status).toBe(
      401,
    );
    const audit = await testApp.database.sql(
      `SELECT 1 FROM audit_events WHERE event_type = 'auth.credential_revoked' AND subject = $1`,
      [issued.credentialId],
    );
    expect(audit).toHaveLength(1);
    // An access token that was already issued stays valid until its expiry: it is not a credential row.
    expect((await identity(access)).status).toBe(200);
  });

  it('is refused from its expiry instant on, and accepted a second before', async () => {
    const expiresAt = new Date(testApp.clock.now().getTime() + 60_000);
    const issued = await newPerson('human-expiring', { expiresAt });
    const present = () => testApp.request('/v1/auth/token', { method: 'POST', headers: bearer(issued.token) });
    expect((await present()).status).toBe(200);
    testApp.clock.set(new Date(expiresAt.getTime() - 1000));
    expect((await present()).status).toBe(200);
    testApp.clock.set(expiresAt);
    expect((await present()).status).toBe(401);
    testApp.clock.set(new Date('2026-11-15T10:00:00Z'));
  });

  it('is refused when its principal is disabled, also for an access token that it already issued', async () => {
    const issued = await newPerson('human-disabled');
    const access = await accessTokenFor(testApp, issued.token);
    expect((await identity(access)).status).toBe(200);
    await testApp.database.sql(`UPDATE principals SET status = 'DISABLED' WHERE principal_id = 'human-disabled'`);
    expect((await testApp.request('/v1/auth/token', { method: 'POST', headers: bearer(issued.token) })).status).toBe(
      401,
    );
    expect((await identity(access)).status).toBe(401);
  });

  it('is refused in another environment than its principal, for a credential and for an access token', async () => {
    const staging = await newPerson('human-staging', { environment: 'STAGING' });
    expect((await testApp.request('/v1/auth/token', { method: 'POST', headers: bearer(staging.token) })).status).toBe(
      401,
    );
    // The same database seen as STAGING accepts the credential, and its token is refused by DEVELOPMENT.
    const asStaging = await createTestApp({
      environment: 'STAGING',
      database: testApp.database,
      signingKey: testApp.env.secrets.tokenSigningKey,
    });
    const token = await accessTokenFor(asStaging, staging.token);
    expect((await asStaging.request('/v1/system/identity', { headers: bearer(token) })).status).toBe(200);
    expect((await identity(token)).status).toBe(401);
  });

  it('is judged on its roles at each request: a revoked role stops working at once', async () => {
    const issued = await newPerson('human-steward-2', { role: 'Steward' });
    const access = await accessTokenFor(testApp, issued.token);
    const register = () => testApp.request('/v1/budgets', { method: 'POST', headers: bearer(access), body: '{}' });
    // A Steward is allowed past authorisation: the empty body is then refused by the contract layer (400), not 403.
    expect((await register()).status).toBe(400);
    await testApp.database.sql(
      `DELETE FROM principal_roles WHERE principal_id = 'human-steward-2' AND role = 'Steward'`,
    );
    expect((await register()).status).toBe(403);
  });

  it('is judged on its operations: a service credential works only for the routes that it names', async () => {
    const now = testApp.clock.now();
    const scoped = await testApp.database.db.transaction(async (tx) => {
      await tx.query(
        `UPDATE credentials SET revoked_at = $1 WHERE principal_id = 'svc-workflows' AND revoked_at IS NULL AND operations <@ ARRAY['unrelated.operation']::oq_route_id[]`,
        [now],
      );
      return issueCredential(tx, testApp.env.ids, now, {
        principalId: 'svc-workflows',
        principalKind: 'SERVICE',
        operations: ['system.identity'],
        issuedBy: 'human-admin',
      });
    });
    expect((await identity(scoped.token)).status).toBe(200);
    const elsewhere = await testApp.request('/v1/missions/mission-1', { headers: bearer(scoped.token) });
    expect(elsewhere.status).toBe(403);
  });
});

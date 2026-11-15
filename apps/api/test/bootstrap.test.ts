// The bootstrap of an environment (OQ-05 section 9, decision D12): the first Administrator and the four service
// principals, each with a credential that exists once, in a file that the operator names. The tests run the library
// function against real PostgreSQL databases and the command line as a child process. Expected operations are read from
// the raw route manifest, not from the code under test.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { parseCredentialToken } from '../src/auth/credentials.ts';
import { bootstrapToFile } from '../tools/bootstrap.ts';
import { bearer, bodyOf, createTestApp } from './support/app.ts';
import { migratedDatabase, type TestDatabase } from './support/database.ts';

const directory = resolve(fileURLToPath(import.meta.url), '..');
const apiRoot = resolve(directory, '..');
const raw = JSON.parse(readFileSync(resolve(apiRoot, '../../packages/api-contracts/routes/v1.json'), 'utf8')) as {
  routes: { id: string; host: string; auth: { kind: string; principals?: string[] }[] }[];
};
/**
 * The operations of a service credential: every route of the manifest that lists the principal for `service`. The
 * workflows credential also names runner.dispatch, because the dispatcher presents it to the agent runner.
 */
const operationsOf = (kind: string): string[] =>
  raw.routes
    .filter((route) => route.auth.some((rule) => rule.kind === 'service' && rule.principals?.includes(kind)))
    .map((route) => route.id)
    .sort();

interface SecretFile {
  note: string;
  environment: string;
  credentials: {
    principal_id: string;
    principal_kind: string;
    authority: string;
    operations?: string[];
    credential_id: string;
    token: string;
  }[];
}

const databases: TestDatabase[] = [];
const folders: string[] = [];
async function emptyEnvironment(): Promise<TestDatabase> {
  const database = await migratedDatabase();
  databases.push(database);
  return database;
}
function outPath(name = 'secrets.json'): string {
  const folder = mkdtempSync(join(tmpdir(), 'oq-bootstrap-'));
  folders.push(folder);
  return join(folder, name);
}
afterEach(async () => {
  for (const database of databases.splice(0)) await database.drop();
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

const readSecrets = (path: string): SecretFile => JSON.parse(readFileSync(path, 'utf8')) as SecretFile;
const options = { environment: 'DEVELOPMENT' as const, adminId: 'admin-1', adminName: 'First Administrator' };

describe('the bootstrap of an environment', () => {
  it('creates the Administrator and the four service principals, each with one credential, in a file of mode 0600', async () => {
    const database = await emptyEnvironment();
    const path = outPath();
    const result = await bootstrapToFile(database.url, path, options);

    // The file belongs to its owner alone, whatever the umask of the process was.
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const file = readSecrets(path);
    expect(file.environment).toBe('DEVELOPMENT');
    expect(file.note).toContain('shown here once');
    expect(file.credentials.map((entry) => entry.principal_id).sort()).toEqual([
      'admin-1',
      'svc-development-batch',
      'svc-development-deploy',
      'svc-development-runner',
      'svc-development-workflows',
    ]);
    // What the command returns names principals and the path, and no secret.
    expect(result.path).toBe(path);
    expect(result.principals).toHaveLength(5);
    for (const entry of file.credentials) expect(JSON.stringify(result)).not.toContain(entry.token);

    const principals = await database.sql<{
      principal_id: string;
      kind: string;
      service_kind: string | null;
      environment: string;
      status: string;
    }>('SELECT principal_id, kind, service_kind, environment, status FROM principals ORDER BY principal_id');
    expect(principals).toEqual([
      { principal_id: 'admin-1', kind: 'HUMAN', service_kind: null, environment: 'DEVELOPMENT', status: 'ACTIVE' },
      ...['batch', 'deploy', 'runner', 'workflows'].map((kind) => ({
        principal_id: `svc-development-${kind}`,
        kind: 'SERVICE',
        service_kind: kind,
        environment: 'DEVELOPMENT',
        status: 'ACTIVE',
      })),
    ]);
    // The Administrator has that role and no other: roles have no hierarchy, and no role carries trading authority.
    expect(await database.sql('SELECT principal_id, role FROM principal_roles')).toEqual([
      { principal_id: 'admin-1', role: 'Administrator' },
    ]);
    // Each service credential carries the operations that the manifest lists for its principal, and nothing more.
    for (const kind of ['batch', 'deploy', 'runner', 'workflows']) {
      const entry = file.credentials.find((candidate) => candidate.principal_id === `svc-development-${kind}`);
      expect(entry?.principal_kind, kind).toBe('SERVICE');
      expect(entry?.authority, kind).toBe(kind);
      expect(entry?.operations, kind).toEqual(operationsOf(kind));
      expect(entry?.operations?.length, kind).toBeGreaterThan(0);
    }
    expect(file.credentials.find((entry) => entry.principal_id === 'admin-1')?.operations).toBeUndefined();
  });

  it('stores only hashes: no secret, token or credential appears in any table', async () => {
    const database = await emptyEnvironment();
    const path = outPath();
    await bootstrapToFile(database.url, path, options);
    const file = readSecrets(path);
    const needles = file.credentials.flatMap((entry) => [
      entry.token,
      parseCredentialToken(entry.token)?.secret as string,
    ]);
    expect(needles.every((needle) => needle.length >= 32)).toBe(true);
    expect(new Set(needles).size).toBe(needles.length);
    const tables = await database.sql<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
    );
    expect(tables.length).toBeGreaterThan(40);
    for (const { table_name: table } of tables) {
      const hits = await database.sql<{ count: string }>(
        `SELECT count(*) FROM "${table}" t WHERE t::text LIKE ANY($1::text[])`,
        [needles.map((needle) => `%${needle}%`)],
      );
      expect(hits[0]?.count, `table ${table}`).toBe('0');
    }
    const stored = await database.sql<{ secret_hash: string }>('SELECT secret_hash FROM credentials');
    expect(stored).toHaveLength(5);
    for (const row of stored) expect(row.secret_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('issues credentials that work as the roles and operations say, and no more', async () => {
    const database = await emptyEnvironment();
    const path = outPath();
    await bootstrapToFile(database.url, path, options);
    const tokens = Object.fromEntries(readSecrets(path).credentials.map((entry) => [entry.principal_id, entry.token]));
    const app = await createTestApp({ database });

    // The Administrator exchanges the credential for an access token with the one role.
    const exchanged = await app.request('/v1/auth/token', {
      method: 'POST',
      headers: bearer(tokens['admin-1'] as string),
    });
    expect(exchanged.status).toBe(200);
    const view = await bodyOf<{ access_token: string; roles: string[]; principal: { id: string } }>(exchanged);
    expect(view.roles).toEqual(['Administrator']);
    expect(view.principal.id).toBe('admin-1');
    const access = view.access_token;
    const call = (method: string, path: string, token: string, body?: unknown) =>
      app.request(path, {
        method,
        headers: { ...bearer(token), 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    expect((await call('GET', '/v1/system/identity', access)).status).toBe(200);
    // An Administrator does not become a Steward or a Researcher: configuring infrastructure grants no research authority.
    expect((await call('POST', '/v1/budgets', access, {})).status).toBe(403);
    expect((await call('POST', '/v1/missions', access, {})).status).toBe(403);

    // A service credential works for its own routes only.
    expect((await call('GET', '/v1/system/identity', tokens['svc-development-workflows'] as string)).status).toBe(200);
    for (const kind of ['batch', 'deploy', 'runner']) {
      expect((await call('GET', '/v1/system/identity', tokens[`svc-development-${kind}`] as string)).status, kind).toBe(
        403,
      );
    }
    expect((await call('POST', '/v1/releases', tokens['svc-development-batch'] as string, {})).status).toBe(403);
    // The deploy principal reaches the release route: it gets as far as the body, which it did not send.
    expect((await call('POST', '/v1/releases', tokens['svc-development-deploy'] as string, {})).status).toBe(400);
    // A person's long-lived credential is for the token route only.
    expect((await call('GET', '/v1/system/identity', tokens['admin-1'] as string)).status).toBe(403);
  });

  it('runs once per environment: a second run changes nothing and leaves no file', async () => {
    const database = await emptyEnvironment();
    const first = outPath('first.json');
    await bootstrapToFile(database.url, first, options);
    const before = readFileSync(first, 'utf8');
    const principalsBefore = await database.sql('SELECT principal_id FROM principals ORDER BY principal_id');

    const second = outPath('second.json');
    await expect(
      bootstrapToFile(database.url, second, { ...options, adminId: 'admin-2', adminName: 'Another' }),
    ).rejects.toThrow(/has principals already/);
    expect(existsSync(second)).toBe(false);
    expect(readFileSync(first, 'utf8')).toBe(before);
    expect(await database.sql('SELECT principal_id FROM principals ORDER BY principal_id')).toEqual(principalsBefore);

    // Another environment of the same database starts clean, with its own principal identifiers.
    const staging = outPath('staging.json');
    await bootstrapToFile(database.url, staging, { environment: 'STAGING', adminId: 'admin-staging', adminName: 'S' });
    expect(
      readSecrets(staging)
        .credentials.map((entry) => entry.principal_id)
        .sort(),
    ).toEqual([
      'admin-staging',
      'svc-staging-batch',
      'svc-staging-deploy',
      'svc-staging-runner',
      'svc-staging-workflows',
    ]);
  });

  it('never replaces a file that exists, and creates nothing when it cannot write', async () => {
    const database = await emptyEnvironment();
    const path = outPath();
    writeFileSync(path, 'keep me', { mode: 0o644 });
    await expect(bootstrapToFile(database.url, path, options)).rejects.toThrow(/EEXIST/);
    expect(readFileSync(path, 'utf8')).toBe('keep me');
    expect(await database.sql('SELECT 1 FROM principals')).toHaveLength(0);
  });

  it('leaves neither principals nor a file when the creation fails half way', async () => {
    const database = await emptyEnvironment();
    const path = outPath();
    // An identifier that the schema refuses: the failure happens after the first statements of the transaction.
    await expect(bootstrapToFile(database.url, path, { ...options, adminId: 'not an identifier' })).rejects.toThrow();
    expect(existsSync(path)).toBe(false);
    expect(await database.sql('SELECT 1 FROM principals')).toHaveLength(0);
    expect(await database.sql('SELECT 1 FROM credentials')).toHaveLength(0);
    // The same file name works afterwards.
    await bootstrapToFile(database.url, path, options);
    expect(existsSync(path)).toBe(true);
  });
});

describe('the command line', () => {
  function run(args: string[], url?: string) {
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.DATABASE_URL;
    if (url !== undefined) env.DATABASE_URL = url;
    return spawnSync(process.execPath, ['tools/bootstrap.ts', ...args], { cwd: apiRoot, env, encoding: 'utf8' });
  }

  it('prints identifiers and the path, never a secret, and writes the file with mode 0600', async () => {
    const database = await emptyEnvironment();
    const path = outPath();
    const result = run(['--environment', 'DEVELOPMENT', '--out', path], database.url);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('created admin-1 (Administrator)');
    for (const kind of ['batch', 'deploy', 'runner', 'workflows']) {
      expect(result.stdout).toContain(`created svc-development-${kind} (${kind})`);
    }
    expect(result.stdout).toContain(path);
    const file = readSecrets(path);
    expect(file.credentials).toHaveLength(5);
    for (const entry of file.credentials) {
      expect(result.stdout).not.toContain(entry.token);
      expect(result.stderr).not.toContain(entry.token);
    }
    expect(result.stdout + result.stderr).not.toContain('oqk1');
    expect(result.stdout + result.stderr).not.toContain(database.url);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('refuses a missing argument, a missing database and an unknown environment with the usage, exit code 2', async () => {
    const database = await emptyEnvironment();
    const path = outPath();
    const cases: [string, string[], string | undefined][] = [
      ['no --out', ['--environment', 'DEVELOPMENT'], database.url],
      ['no --environment', ['--out', path], database.url],
      ['no DATABASE_URL', ['--environment', 'DEVELOPMENT', '--out', path], undefined],
      ['an unknown environment', ['--environment', 'LIVE', '--out', path], database.url],
    ];
    for (const [label, args, url] of cases) {
      const result = run(args, url);
      expect(result.status, label).toBe(2);
      expect(result.stderr, label).not.toBe('');
      expect(existsSync(path), label).toBe(false);
    }
    expect(await database.sql('SELECT 1 FROM principals')).toHaveLength(0);
  });

  it('says why it failed on a second run and leaves the first file alone, with exit code 1', async () => {
    const database = await emptyEnvironment();
    const first = outPath('first.json');
    expect(run(['--environment', 'DEVELOPMENT', '--out', first], database.url).status).toBe(0);
    const before = readFileSync(first, 'utf8');
    const second = outPath('second.json');
    const result = run(['--environment', 'DEVELOPMENT', '--out', second], database.url);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('has principals already');
    expect(existsSync(second)).toBe(false);
    expect(readFileSync(first, 'utf8')).toBe(before);
  });
});

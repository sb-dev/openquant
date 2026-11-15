import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  loadMigrations,
  migrate,
  migrationStatus,
  migrationsDirectory,
  transactionControl,
} from '../tools/migrations.ts';
import { emptyDatabase, type TestDatabase } from './support/database.ts';

const scratch: string[] = [];
const databases: TestDatabase[] = [];
afterAll(async () => {
  for (const directory of scratch) rmSync(directory, { recursive: true, force: true });
  for (const database of databases) await database.drop();
});

function copyOfMigrations(): string {
  const directory = mkdtempSync(join(tmpdir(), 'oq-migrations-'));
  scratch.push(directory);
  cpSync(migrationsDirectory, directory, { recursive: true });
  return directory;
}

async function freshDatabase(): Promise<TestDatabase> {
  const database = await emptyDatabase();
  databases.push(database);
  return database;
}

// The expected ids come from the directory listing and the checksums from node:crypto, not from the runner.
const fileNames = readdirSync(migrationsDirectory)
  .filter((name) => name.endsWith('.sql'))
  .sort();
const expectedIds = fileNames.map((name) => name.replace(/\.sql$/, ''));
const expectedChecksums = fileNames.map((name) =>
  createHash('sha256')
    .update(readFileSync(join(migrationsDirectory, name)))
    .digest('hex'),
);

describe('applying the migrations', () => {
  it('applies every file in order from an empty database, and a second run applies nothing', async () => {
    const database = await freshDatabase();
    const first = await migrate(database.url);
    expect(first.applied).toEqual(expectedIds);
    expect(first.level).toBe(expectedIds.at(-1));
    const before = await database.sql<{ migration_id: string; checksum: string; applied_at: Date }>(
      'SELECT migration_id, checksum, applied_at FROM schema_migrations ORDER BY migration_id',
    );
    expect(before.map((row) => row.migration_id)).toEqual(expectedIds);
    expect(before.map((row) => row.checksum)).toEqual(expectedChecksums);

    const second = await migrate(database.url);
    expect(second.applied).toEqual([]);
    expect(second.level).toBe(first.level);
    const after = await database.sql<{ migration_id: string; checksum: string; applied_at: Date }>(
      'SELECT migration_id, checksum, applied_at FROM schema_migrations ORDER BY migration_id',
    );
    expect(after).toEqual(before);
  });

  it('numbers its files from 0001 without a gap, and the level is an Identifier of the contracts', () => {
    expect(expectedIds[0]).toMatch(/^0001_/);
    for (const [index, id] of expectedIds.entries()) expect(id.slice(0, 4)).toBe(String(index + 1).padStart(4, '0'));
    // The release manifest carries the level as an Identifier (common.schema.json).
    expect(expectedIds.at(-1)).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/);
  });

  it('reports the status without changing anything', async () => {
    const database = await freshDatabase();
    const empty = await migrationStatus(database.url);
    expect(empty).toEqual({ applied: [], pending: expectedIds, level: null });
    await migrate(database.url);
    const done = await migrationStatus(database.url);
    expect(done.pending).toEqual([]);
    expect(done.applied.map((row) => row.id)).toEqual(expectedIds);
    expect(done.level).toBe(expectedIds.at(-1));
  });

  it('refuses a migration file that changed after it was applied', async () => {
    const directory = copyOfMigrations();
    const database = await freshDatabase();
    await migrate(database.url, loadMigrations(directory));
    writeFileSync(
      join(directory, fileNames[1] as string),
      `${readFileSync(join(directory, fileNames[1] as string), 'utf8')}\n-- edited\n`,
    );
    await expect(migrate(database.url, loadMigrations(directory))).rejects.toThrow(/has changed since it was applied/);
    await expect(migrationStatus(database.url, loadMigrations(directory))).rejects.toThrow(/has changed/);
  });

  it('refuses a missing applied file', async () => {
    const directory = copyOfMigrations();
    const database = await freshDatabase();
    await migrate(database.url, loadMigrations(directory));
    rmSync(join(directory, fileNames.at(-1) as string));
    const remaining = loadMigrations(directory);
    // The database holds one more migration than the files do.
    await expect(migrate(database.url, remaining)).rejects.toThrow(/no matching file/);
  });

  it('rolls back a failing migration and keeps the earlier ones', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'oq-migrations-'));
    scratch.push(directory);
    writeFileSync(join(directory, '0001_first.sql'), 'CREATE TABLE first_table (id integer PRIMARY KEY);\n');
    writeFileSync(
      join(directory, '0002_broken.sql'),
      'CREATE TABLE second_table (id integer PRIMARY KEY);\nINSERT INTO first_table VALUES (1), (1);\n',
    );
    const database = await freshDatabase();
    await expect(migrate(database.url, loadMigrations(directory))).rejects.toThrow(
      /0002_broken failed and was rolled back/,
    );
    const tables = await database.sql<{ name: string }>(
      "SELECT relname AS name FROM pg_class WHERE relname IN ('first_table', 'second_table') ORDER BY relname",
    );
    expect(tables.map((row) => row.name)).toEqual(['first_table']);
    const status = await migrationStatus(database.url, loadMigrations(directory));
    expect(status.level).toBe('0001_first');
    expect(status.pending).toEqual(['0002_broken']);
  });

  it('serialises two runners that start together: each file is applied once', async () => {
    const database = await freshDatabase();
    const [left, right] = await Promise.all([migrate(database.url), migrate(database.url)]);
    expect([...left.applied, ...right.applied].sort()).toEqual(expectedIds);
    expect(new Set([...left.applied, ...right.applied]).size).toBe(expectedIds.length);
    const rows = await database.sql<{ count: string }>('SELECT count(*) FROM schema_migrations');
    expect(rows[0]?.count).toBe(String(expectedIds.length));
  });
});

describe('the rules for migration files', () => {
  it('refuses a gap, a bad name and an empty directory', () => {
    const gap = mkdtempSync(join(tmpdir(), 'oq-migrations-'));
    scratch.push(gap);
    writeFileSync(join(gap, '0001_a.sql'), 'SELECT 1;\n');
    writeFileSync(join(gap, '0003_c.sql'), 'SELECT 1;\n');
    expect(() => loadMigrations(gap)).toThrow(/expected 0002, found 0003_c\.sql/);

    const badName = mkdtempSync(join(tmpdir(), 'oq-migrations-'));
    scratch.push(badName);
    writeFileSync(join(badName, '0001_Mixed.sql'), 'SELECT 1;\n');
    expect(() => loadMigrations(badName)).toThrow(/must match NNNN_name\.sql/);

    const empty = mkdtempSync(join(tmpdir(), 'oq-migrations-'));
    scratch.push(empty);
    expect(() => loadMigrations(empty)).toThrow(/No migration file found/);
  });

  it('refuses transaction control in a file but accepts BEGIN inside a function body', () => {
    const directory = mkdtempSync(join(tmpdir(), 'oq-migrations-'));
    scratch.push(directory);
    writeFileSync(join(directory, '0001_tx.sql'), 'BEGIN;\nCREATE TABLE t (id integer);\nCOMMIT;\n');
    expect(() => loadMigrations(directory)).toThrow(/must not contain BEGIN/);

    const body = 'CREATE FUNCTION f() RETURNS integer LANGUAGE plpgsql AS $$\nBEGIN\n  RETURN 1;\nEND\n$$;\n';
    expect(transactionControl(body)).toBeUndefined();
    expect(transactionControl("-- BEGIN in a comment\nSELECT 'COMMIT';\n")).toBeUndefined();
    expect(transactionControl('CREATE TABLE t (id integer);\n  commit;\n')).toBe('commit');
    expect(transactionControl('SELECT 1; ROLLBACK;')).toBe('rollback');
    expect(transactionControl('CREATE TABLE t (id integer); SAVEPOINT a;')).toBe('savepoint');
  });

  it('holds no BEGIN, COMMIT or ROLLBACK in any shipped file', () => {
    for (const name of fileNames) {
      expect(transactionControl(readFileSync(join(migrationsDirectory, name), 'utf8')), name).toBeUndefined();
    }
  });
});

describe('the command line', () => {
  const tool = resolve(migrationsDirectory, '../tools/migrate.ts');

  it('prints the status and the migration level and never the connection string', async () => {
    const database = await freshDatabase();
    await migrate(database.url);
    const result = spawnSync(process.execPath, [tool, '--status'], {
      env: { PATH: process.env.PATH ?? '', DATABASE_URL: database.url },
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`migration level: ${expectedIds.at(-1)}`);
    for (const id of expectedIds) expect(result.stdout).toContain(`applied ${id}`);
    expect(result.stdout + result.stderr).not.toContain(database.url);
  });

  it('applies the pending files when it runs without --status', async () => {
    const database = await freshDatabase();
    const result = spawnSync(process.execPath, [tool], {
      env: { PATH: process.env.PATH ?? '', DATABASE_URL: database.url },
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`Applied ${expectedIds.length} migrations.`);
    expect((await migrationStatus(database.url)).level).toBe(expectedIds.at(-1));
  });

  it('exits with 2 and a message when DATABASE_URL is not set', () => {
    const result = spawnSync(process.execPath, [tool], {
      env: { PATH: process.env.PATH ?? '', RANDOM_NOISE: randomBytes(2).toString('hex') },
      encoding: 'utf8',
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('DATABASE_URL is not set');
  });
});

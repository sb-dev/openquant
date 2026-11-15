// The migration runner (OQ-05 section 5: apps/api/migrations is the one SQL migration owner).
//
// Migrations are plain SQL files named NNNN_name.sql, numbered from 0001 without a gap. The runner applies each
// pending file in its own transaction together with its row in schema_migrations, under one advisory lock, so two
// runners serialise and a failed file leaves nothing behind. It refuses to continue when an applied file has changed
// or is missing, because history is append-only. The migration level is the id of the last applied file; the API
// reads it for the release identity (OQ-05 section 11). This file runs in Node, never in a Worker.

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';

export const migrationsDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '../migrations');

const FILE_NAME = /^([0-9]{4})_([a-z0-9_]+)\.sql$/;
// One constant key: the migrations of one database are serialised, whatever connection runs them.
const ADVISORY_LOCK_KEY = 7_236_001;

export interface MigrationFile {
  /** The file name without .sql, such as 0001_identity. It is the migration level when it is the last applied. */
  readonly id: string;
  readonly sql: string;
  /** SHA-256 of the file bytes, lower-case hex. */
  readonly checksum: string;
}

export interface MigrationReport {
  /** Ids applied by this run, in order. */
  readonly applied: readonly string[];
  /** Id of the last applied migration, or null when none is applied. */
  readonly level: string | null;
}

export interface MigrationStatus {
  readonly applied: readonly { readonly id: string; readonly checksum: string }[];
  readonly pending: readonly string[];
  readonly level: string | null;
}

// A migration file holds no transaction control: the runner wraps each file in one transaction. Dollar-quoted
// bodies (function definitions use BEGIN and END inside them), comments and string literals are removed first.
export function transactionControl(sql: string): string | undefined {
  const bare = sql
    .replace(/\$([A-Za-z_]*)\$[\s\S]*?\$\1\$/g, '')
    .replace(/--[^\n]*/g, '')
    .replace(/'(?:[^']|'')*'/g, "''");
  for (const statement of bare.split(';')) {
    const word = /^\s*(begin|commit|end|rollback|start\s+transaction|savepoint|release|abort)\b/i.exec(statement);
    if (word) return word[1]?.toLowerCase();
  }
  return undefined;
}

export function loadMigrations(directory: string = migrationsDirectory): MigrationFile[] {
  const names = readdirSync(directory).filter((name) => !name.startsWith('.'));
  const files: MigrationFile[] = [];
  for (const name of names.sort()) {
    const match = FILE_NAME.exec(name);
    if (!match) throw new Error(`Migration file name ${JSON.stringify(name)} must match NNNN_name.sql (lower case).`);
    const expected = String(files.length + 1).padStart(4, '0');
    if (match[1] !== expected) {
      throw new Error(`Migrations must be numbered from 0001 without a gap: expected ${expected}, found ${name}.`);
    }
    const bytes = readFileSync(resolve(directory, name));
    const sql = bytes.toString('utf8');
    const control = transactionControl(sql);
    if (control) {
      throw new Error(
        `${name} must not contain ${control.toUpperCase()}: the runner applies each file in one transaction.`,
      );
    }
    files.push({ id: name.replace(/\.sql$/, ''), sql, checksum: createHash('sha256').update(bytes).digest('hex') });
  }
  if (files.length === 0) throw new Error(`No migration file found in ${directory}.`);
  return files;
}

interface AppliedRow {
  migration_id: string;
  checksum: string;
}

const CREATE_LOG = `CREATE TABLE IF NOT EXISTS schema_migrations (
  migration_id text PRIMARY KEY CHECK (migration_id ~ '^[0-9]{4}_[a-z0-9_]+$'),
  checksum text NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
  applied_at timestamptz NOT NULL DEFAULT now()
)`;

function appliedProblems(files: readonly MigrationFile[], applied: readonly AppliedRow[]): string[] {
  const problems: string[] = [];
  applied.forEach((row, index) => {
    const file = files[index];
    if (!file || file.id !== row.migration_id) {
      problems.push(
        `Applied migration ${row.migration_id} has no matching file at its position: files must not be removed or renumbered.`,
      );
    } else if (file.checksum !== row.checksum) {
      problems.push(
        `Applied migration ${row.migration_id} has changed since it was applied: add a new migration instead.`,
      );
    }
  });
  return problems;
}

async function readApplied(client: Client): Promise<AppliedRow[]> {
  const result = await client.query<AppliedRow>(
    'SELECT migration_id, checksum FROM schema_migrations ORDER BY migration_id',
  );
  return result.rows;
}

/** Apply the pending migrations. Call it with a direct (not pooled) connection string, as Neon advises. */
export async function migrate(
  connectionString: string,
  files: readonly MigrationFile[] = loadMigrations(),
): Promise<MigrationReport> {
  const client = new Client({ connectionString });
  client.on('error', () => undefined);
  await client.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [ADVISORY_LOCK_KEY]);
    await client.query(CREATE_LOG);
    const applied = await readApplied(client);
    const problems = appliedProblems(files, applied);
    if (problems.length > 0) throw new Error(problems.join(' '));
    const done: string[] = [];
    for (const file of files.slice(applied.length)) {
      await client.query('BEGIN');
      try {
        await client.query(file.sql);
        await client.query('INSERT INTO schema_migrations (migration_id, checksum) VALUES ($1, $2)', [
          file.id,
          file.checksum,
        ]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw new Error(
          `Migration ${file.id} failed and was rolled back: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      done.push(file.id);
    }
    return { applied: done, level: done.at(-1) ?? applied.at(-1)?.migration_id ?? null };
  } finally {
    await client.end();
  }
}

/** What is applied and what is pending, without changing anything. */
export async function migrationStatus(
  connectionString: string,
  files: readonly MigrationFile[] = loadMigrations(),
): Promise<MigrationStatus> {
  const client = new Client({ connectionString });
  client.on('error', () => undefined);
  await client.connect();
  try {
    const exists = await client.query<{ present: boolean }>(
      "SELECT to_regclass('schema_migrations') IS NOT NULL AS present",
    );
    const applied = exists.rows[0]?.present ? await readApplied(client) : [];
    const problems = appliedProblems(files, applied);
    if (problems.length > 0) throw new Error(problems.join(' '));
    return {
      applied: applied.map((row) => ({ id: row.migration_id, checksum: row.checksum })),
      pending: files.slice(applied.length).map((file) => file.id),
      level: applied.at(-1)?.migration_id ?? null,
    };
  } finally {
    await client.end();
  }
}

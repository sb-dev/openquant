// Per-test-file databases on the run's server: a copy of the migrated template, or an empty database for the
// migration tests. A test file drops its database when it ends.

import { randomBytes } from 'node:crypto';
import { Client } from 'pg';
import { inject } from 'vitest';
import type { Database } from '../../src/db/database.ts';
import { createPgDatabase } from '../../src/db/pg.ts';
import { withDatabase } from './global-setup.ts';

export interface TestDatabase {
  readonly name: string;
  readonly url: string;
  /** The adapter that the application uses. */
  readonly db: Database;
  /** Run a statement outside the adapter and return the rows. */
  sql<R extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<R[]>;
  /** Open another connection, for tests of concurrent transactions. The caller ends it. */
  connect(): Promise<Client>;
  drop(): Promise<void>;
}

async function create(template: string | undefined): Promise<TestDatabase> {
  const admin = inject('databaseAdminUrl');
  const name = `oq_test_${randomBytes(6).toString('hex')}`;
  const control = new Client({ connectionString: admin });
  await control.connect();
  try {
    await control.query(
      template === undefined ? `CREATE DATABASE ${name}` : `CREATE DATABASE ${name} TEMPLATE ${template}`,
    );
  } finally {
    await control.end();
  }
  const url = withDatabase(admin, name);
  const db = createPgDatabase(url);
  return {
    name,
    url,
    db,
    sql: async (text, values) => (await db.query(text, values)).rows as never,
    connect: async () => {
      const client = new Client({ connectionString: url });
      client.on('error', () => undefined);
      await client.connect();
      return client;
    },
    drop: async () => {
      await db.close();
      const cleanup = new Client({ connectionString: admin });
      await cleanup.connect();
      try {
        await cleanup.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      } finally {
        await cleanup.end();
      }
    },
  };
}

/** A database with the schema of every migration. */
export const migratedDatabase = (): Promise<TestDatabase> => create(inject('templateDatabase'));

/** An empty database, for tests of the migration runner. */
export const emptyDatabase = (): Promise<TestDatabase> => create(undefined);

export interface PgFailure {
  readonly code: string;
  readonly constraint?: string;
  readonly message: string;
}

/** The SQLSTATE and constraint name of a failed statement, or undefined when it succeeded. */
export async function failureOf(work: Promise<unknown>): Promise<PgFailure | undefined> {
  try {
    await work;
    return undefined;
  } catch (error) {
    const failure = error as { code?: unknown; constraint?: unknown; message?: unknown };
    return {
      code: typeof failure.code === 'string' ? failure.code : 'none',
      ...(typeof failure.constraint === 'string' ? { constraint: failure.constraint } : {}),
      message: typeof failure.message === 'string' ? failure.message : String(error),
    };
  }
}

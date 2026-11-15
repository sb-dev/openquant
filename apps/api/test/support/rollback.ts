// A harness for tests that break one invariant at a time: one database per test file, and every test runs in a
// transaction that is rolled back, on a graph that the test seeds first. A statement that must fail runs under a
// savepoint, so the transaction survives it and the test can go on.

import type { Client } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, expect } from 'vitest';
import { failureOf, migratedDatabase, type PgFailure, type TestDatabase } from './database.ts';
import { type Exec, seedGraph } from './seed.ts';

export interface Harness {
  /** The connection of the current test. Valid inside a test body. */
  readonly client: () => Client;
  readonly exec: Exec;
  /** The database of the file, for tests that need a second connection. */
  readonly database: () => TestDatabase;
  /** Run a statement that must fail, and check its SQLSTATE and constraint name. */
  violation(
    text: string,
    values: readonly unknown[],
    expected: { code: string; constraint?: string },
  ): Promise<PgFailure>;
  /** Run a statement that must succeed and return its rows. */
  ok(text: string, values?: readonly unknown[]): Promise<Record<string, unknown>[]>;
}

export function useRolledBackTransaction(options: { seed?: boolean } = {}): Harness {
  let database: TestDatabase | undefined;
  let client: Client | undefined;
  const current = (): Client => {
    if (!client) throw new Error('No transaction is open.');
    return client;
  };
  const exec: Exec = { query: (text, values) => current().query(text, values as unknown[] | undefined) as never };

  beforeAll(async () => {
    database = await migratedDatabase();
    client = await database.connect();
  });
  afterAll(async () => {
    await client?.end();
    await database?.drop();
  });
  beforeEach(async () => {
    await current().query('BEGIN');
    if (options.seed !== false) await seedGraph(exec);
  });
  afterEach(async () => {
    await current().query('ROLLBACK');
  });

  return {
    client: current,
    exec,
    database: () => {
      if (!database) throw new Error('No database.');
      return database;
    },
    async violation(text, values, expected) {
      await current().query('SAVEPOINT probe');
      const failure = await failureOf(current().query(text, values as unknown[]));
      await current().query('ROLLBACK TO SAVEPOINT probe');
      expect(failure, `expected a violation of ${expected.constraint ?? expected.code} for: ${text}`).toBeDefined();
      expect({ code: failure?.code, constraint: failure?.constraint }).toEqual(
        expected.constraint === undefined ? { code: expected.code, constraint: failure?.constraint } : expected,
      );
      return failure as PgFailure;
    },
    async ok(text, values) {
      return (await current().query(text, values as unknown[])).rows;
    },
  };
}

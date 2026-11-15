// The node-postgres adapter. On Cloudflare the connection string is the Hyperdrive binding's (OQ-05 section 1,
// Hyperdrive with query caching disabled); in tests it is a local Postgres. One Client per request, opened on the
// first query and closed with the request. No pool: Hyperdrive pools connections to the origin itself.

import { Client } from 'pg';
import type { Database, Queryable, QueryResult, Row } from './database.ts';

export interface PgOptions {
  /** Milliseconds to wait for a connection. */
  readonly connectionTimeoutMillis?: number;
  /** Milliseconds a statement may run; the server cancels it after that. */
  readonly statementTimeoutMillis?: number;
}

export function createPgDatabase(connectionString: string, options: PgOptions = {}): Database {
  let client: Client | undefined;
  let connecting: Promise<Client> | undefined;
  let inTransaction = false;

  function connection(): Promise<Client> {
    if (client) return Promise.resolve(client);
    connecting ??= (async () => {
      const next = new Client({
        connectionString,
        connectionTimeoutMillis: options.connectionTimeoutMillis ?? 10_000,
        statement_timeout: options.statementTimeoutMillis ?? 30_000,
        application_name: 'openquant-api',
      });
      // An error on an idle connection must not become an unhandled event; the next query reports it.
      next.on('error', () => undefined);
      await next.connect();
      client = next;
      return next;
    })();
    return connecting;
  }

  async function run<R>(text: string, values?: readonly unknown[]): Promise<QueryResult<R>> {
    const result = await (await connection()).query<R>(text, values);
    return { rows: result.rows, rowCount: result.rowCount ?? 0 };
  }

  return {
    query: async <R = Row>(text: string, values?: readonly unknown[]) => {
      if (inTransaction) throw new Error('The database is in a transaction: use the transaction handle.');
      return run<R>(text, values);
    },
    async transaction<T>(work: (tx: Queryable) => Promise<T>): Promise<T> {
      if (inTransaction) throw new Error('Transactions do not nest.');
      inTransaction = true;
      try {
        await run('BEGIN');
        try {
          const value = await work({ query: run });
          await run('COMMIT');
          return value;
        } catch (error) {
          await run('ROLLBACK').catch(() => undefined);
          throw error;
        }
      } finally {
        inTransaction = false;
      }
    },
    async close(): Promise<void> {
      const pending = connecting;
      client = undefined;
      connecting = undefined;
      if (pending) await (await pending.catch(() => undefined))?.end().catch(() => undefined);
    },
  };
}

// The database interface of the control application. Source code sees these types only; src/db/pg.ts is the one
// adapter to node-postgres. A request holds one Database, which connects on its first query, so a request that is
// rejected before it needs the database opens no connection (OQ-05 section 5).

export type Row = Record<string, unknown>;

export interface QueryResult<R = Row> {
  readonly rows: R[];
  readonly rowCount: number;
}

export interface Queryable {
  query<R = Row>(text: string, values?: readonly unknown[]): Promise<QueryResult<R>>;
}

export interface Database extends Queryable {
  /**
   * Run `work` in one transaction: COMMIT when it returns, ROLLBACK when it throws. The Queryable it receives is the
   * transaction; the Database itself must not be used until the transaction ends.
   */
  transaction<T>(work: (tx: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/** A factory, so each request gets its own connection and no request state lives at module level. */
export type DatabaseFactory = () => Database;

/** SQLSTATE of a failed statement, as node-postgres reports it. */
export function sqlState(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

/** An INSERT ... RETURNING or SELECT that must find exactly one row. */
export function oneRow<R>(result: QueryResult<R>): R {
  const [row] = result.rows;
  if (result.rows.length !== 1 || row === undefined) {
    throw new Error(`Expected one row, found ${result.rows.length}.`);
  }
  return row;
}

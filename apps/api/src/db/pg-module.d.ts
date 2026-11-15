// The part of node-postgres (`pg`) that this package uses. A local declaration keeps @types/node out of the Worker
// type check: the Worker source is checked without Node types, and `pg` runs in the Worker through nodejs_compat and
// Hyperdrive (OQ-05 section 1). The adapter in pg.ts is the only module of src that imports `pg`.

declare module 'pg' {
  export interface QueryResult<Row> {
    rows: Row[];
    rowCount: number | null;
  }

  export interface ClientConfig {
    connectionString?: string;
    connectionTimeoutMillis?: number;
    statement_timeout?: number;
    application_name?: string;
  }

  export class Client {
    constructor(config?: ClientConfig);
    connect(): Promise<void>;
    query<Row = Record<string, unknown>>(text: string, values?: readonly unknown[]): Promise<QueryResult<Row>>;
    on(event: 'error', listener: (error: Error) => void): this;
    end(): Promise<void>;
  }
}

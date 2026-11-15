// A control application under test: the real Hono app and the real PostgreSQL adapter on a test database, with a clock
// that the test moves, deterministic identifiers and an in-memory object store.

import { randomBytes } from 'node:crypto';
import type { Hono } from 'hono';
import { createApp, type EnvSource } from '../../src/app.ts';
import type { Database } from '../../src/db/database.ts';
import { createPgDatabase } from '../../src/db/pg.ts';
import type { ApiEnv, DeploymentEnvironment, LogEntry } from '../../src/env.ts';
import type { Handler } from '../../src/handlers/context.ts';
import { handlers } from '../../src/handlers/index.ts';
import { migratedDatabase, type TestDatabase } from './database.ts';
import { createMemoryObjectStore, type MemoryObjectStore } from './objects.ts';

export const START = new Date('2026-11-15T10:00:00Z');

export interface TestClock {
  now(): Date;
  set(date: Date): void;
  advanceSeconds(seconds: number): void;
}

export function createClock(start: Date = START): TestClock {
  let current = start;
  return {
    now: () => current,
    set: (date) => {
      current = date;
    },
    advanceSeconds: (seconds) => {
      current = new Date(current.getTime() + seconds * 1000);
    },
  };
}

export interface TestApp {
  readonly app: Hono<never>;
  readonly env: ApiEnv;
  readonly database: TestDatabase;
  readonly clock: TestClock;
  readonly objects: MemoryObjectStore;
  readonly logs: LogEntry[];
  /** Handles that the application opened and the number of those closed, for tests of the connection lifetime. */
  readonly connections: { opened: number; closed: number; queries: number };
  request(path: string, init?: RequestInit): Promise<Response>;
  drop(): Promise<void>;
}

export interface TestAppOptions {
  readonly environment?: DeploymentEnvironment;
  readonly registry?: Readonly<Record<string, Handler>>;
  readonly database?: TestDatabase;
  readonly signingKey?: Uint8Array;
}

export async function createTestApp(options: TestAppOptions = {}): Promise<TestApp> {
  const database = options.database ?? (await migratedDatabase());
  const clock = createClock();
  const objects = createMemoryObjectStore();
  const logs: LogEntry[] = [];
  const connections = { opened: 0, closed: 0, queries: 0 };
  let counter = 0;
  const env: ApiEnv = {
    environment: options.environment ?? 'DEVELOPMENT',
    database: () => {
      const inner: Database = createPgDatabase(database.url);
      connections.opened += 1;
      return {
        query: (text, values) => {
          connections.queries += 1;
          return inner.query(text, values);
        },
        transaction: (work) => {
          connections.queries += 1;
          return inner.transaction(work);
        },
        close: async () => {
          connections.closed += 1;
          await inner.close();
        },
      };
    },
    objects,
    clock: () => clock.now(),
    ids: {
      next: (prefix) => {
        counter += 1;
        return `${prefix}-${counter.toString(16).padStart(6, '0')}`;
      },
    },
    secrets: { tokenSigningKey: options.signingKey ?? new Uint8Array(randomBytes(32)) },
    log: (entry) => {
      logs.push(entry);
    },
  };
  const source: EnvSource = env;
  const app = createApp(source, options.registry ?? handlers) as unknown as Hono<never>;
  return {
    app,
    env,
    database,
    clock,
    objects,
    logs,
    connections,
    request: (path, init) => Promise.resolve(app.request(path, init)),
    drop: () => database.drop(),
  };
}

export async function bodyOf<T = unknown>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

export function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

export function jsonBody(value: unknown): RequestInit {
  return { method: 'POST', body: JSON.stringify(value), headers: { 'content-type': 'application/json' } };
}

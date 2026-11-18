// A fake API for the client tests: a fetch that answers each method and path with a handler, records every request,
// and can fail a request as a network failure. Valid bodies come from the shared protocol fixtures.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Fetch, FetchInit } from '../src/index.ts';

const root = resolve(fileURLToPath(import.meta.url), '../../../..');

// biome-ignore lint/suspicious/noExplicitAny: tests edit fixture documents by path.
export type Doc = Record<string, any>;

export function fixture(name: string): Doc {
  return JSON.parse(readFileSync(resolve(root, 'fixtures/protocol/valid', name), 'utf8')) as Doc;
}

export interface Sent {
  readonly method: string;
  readonly path: string;
  readonly headers: Record<string, string>;
  readonly body: string | undefined;
}

export type Reply = { status: number; body: unknown } | 'network-failure';
export type Handler = (request: Sent, count: number) => Reply;

export interface FakeApi {
  readonly fetch: Fetch;
  readonly sent: Sent[];
  on(method: string, path: string, handler: Handler): void;
}

export function fakeApi(): FakeApi {
  const handlers = new Map<string, Handler>();
  const counts = new Map<string, number>();
  const sent: Sent[] = [];
  const fetch: Fetch = async (url: string, init: FetchInit) => {
    const path = new URL(url).pathname;
    const request: Sent = { method: init.method, path, headers: init.headers, body: init.body };
    sent.push(request);
    const key = `${init.method} ${path}`;
    const count = (counts.get(key) ?? 0) + 1;
    counts.set(key, count);
    const handler = handlers.get(key);
    const reply: Reply = handler === undefined ? { status: 404, body: apiError('NOT_FOUND') } : handler(request, count);
    if (reply === 'network-failure') throw new TypeError('fetch failed');
    const text = typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body);
    const bytes = new TextEncoder().encode(text);
    return {
      status: reply.status,
      headers: { get: () => 'application/json' },
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    };
  };
  return {
    fetch,
    sent,
    on: (method, path, handler) => {
      handlers.set(`${method} ${path}`, handler);
    },
  };
}

export function apiError(code: string, extra: Doc = {}): Doc {
  return {
    schema_version: 'api-error/1',
    code,
    message: `${code} for the test`,
    state_changed: 'NONE',
    retry_safe: false,
    diagnostic_ref: 'diag-1',
    ...extra,
  };
}

/** The status form of a command request: APPLIED with the given record, or another state. */
export function statusOf(
  request: Doc,
  state: 'APPLIED' | 'PENDING' = 'APPLIED',
  record = { id: 'rec-1', revision: 1 },
): Doc {
  const base = {
    schema_version: 'command/1',
    form: 'status',
    command_id: request.command_id,
    kind: request.payload.kind,
    state,
    received_at: '2026-11-15T10:00:00Z',
  };
  return state === 'APPLIED' ? { ...base, applied_at: '2026-11-15T10:00:01Z', record } : base;
}

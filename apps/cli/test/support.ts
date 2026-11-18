// Test doubles for the CLI: terminal streams that a test can resize and type into, a fake API behind a fetch, the
// shared protocol fixtures, and a temporary configuration directory. No test reaches a network or a real API here;
// apps/api/test/client.test.ts runs the client against the real API on PostgreSQL.

import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import type { Fetch, FetchInit } from '@openquant/api-client';
import { type CliIo, runCli } from '../src/cli.ts';

const root = resolve(fileURLToPath(import.meta.url), '../../../..');

// biome-ignore lint/suspicious/noExplicitAny: tests edit fixture documents by path.
export type Doc = Record<string, any>;

export function fixture(name: string): Doc {
  return JSON.parse(readFileSync(resolve(root, 'fixtures/protocol/valid', name), 'utf8')) as Doc;
}

/** A terminal or a pipe: everything written is kept; a terminal has columns and can be resized. */
export class TestOutput extends EventEmitter {
  readonly isTTY: boolean;
  columns: number;
  rows = 60;
  readonly writes: string[] = [];
  constructor(isTTY: boolean, columns = 100) {
    super();
    this.isTTY = isTTY;
    this.columns = columns;
  }
  write = (chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
    this.writes.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    const callback = rest.find((item) => typeof item === 'function') as (() => void) | undefined;
    if (callback !== undefined) queueMicrotask(callback);
    return true;
  };
  get text(): string {
    return this.writes.join('');
  }
  /** The last frame Ink wrote (Ink's debug mode writes each frame whole). */
  lastFrame(): string {
    return this.writes.at(-1) ?? '';
  }
  resize(columns: number): void {
    this.columns = columns;
    this.emit('resize');
  }
}

/** A terminal keyboard: typed text reaches Ink as one chunk, as a paste does. */
export class TestInput extends EventEmitter {
  readonly isTTY: boolean;
  #queue: string[] = [];
  constructor(isTTY = true) {
    super();
    this.isTTY = isTTY;
    // Text typed before Ink listens is kept and offered again when it starts listening.
    this.on('newListener', (event: string) => {
      if (event === 'readable' && this.#queue.length > 0) queueMicrotask(() => this.emit('readable'));
    });
  }
  type(text: string): void {
    this.#queue.push(text);
    this.emit('readable');
    this.emit('data', text);
  }
  read = (): string | null => this.#queue.shift() ?? null;
  setEncoding(): this {
    return this;
  }
  setRawMode(): this {
    return this;
  }
  resume(): this {
    return this;
  }
  pause(): this {
    return this;
  }
  ref(): this {
    return this;
  }
  unref(): this {
    return this;
  }
}

export const settle = (ms = 60) => new Promise((done) => setTimeout(done, ms));

/**
 * Wait until `check` holds, then a little longer: Ink writes a frame during its commit and activates input handlers in
 * the effects after it, so a key typed at once could reach the previous handlers.
 */
export async function until(check: () => boolean, what: string, ms = 3_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await settle(10);
  }
  await settle(30);
}

export interface Sent {
  readonly origin: string;
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

export function fakeApi(): FakeApi {
  const handlers = new Map<string, Handler>();
  const counts = new Map<string, number>();
  const sent: Sent[] = [];
  const fetch: Fetch = async (url: string, init: FetchInit) => {
    const { origin, pathname: path } = new URL(url);
    const request: Sent = { origin, method: init.method, path, headers: init.headers, body: init.body };
    sent.push(request);
    const key = `${init.method} ${path}`;
    const count = (counts.get(key) ?? 0) + 1;
    counts.set(key, count);
    const handler = handlers.get(key);
    const reply: Reply = handler === undefined ? { status: 404, body: apiError('NOT_FOUND') } : handler(request, count);
    if (reply === 'network-failure') throw new TypeError('fetch failed');
    const bytes = new TextEncoder().encode(typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body));
    return {
      status: reply.status,
      headers: { get: () => 'application/json' },
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    };
  };
  return { fetch, sent, on: (method, path, handler) => void handlers.set(`${method} ${path}`, handler) };
}

export const CREDENTIAL = 'oqk1.cred-0001.c2VjcmV0LXNlY3JldC1zZWNyZXQ';
export const ACCESS_TOKEN = 'oqa1.eyJzdWIiOiJodW1hbi1yZXNlYXJjaGVyIn0.c2lnbmF0dXJl';
export const NOW = new Date('2026-11-15T10:00:00Z');

export function accessToken(roles: string[] = ['Researcher'], token = ACCESS_TOKEN): Doc {
  return {
    access_token: token,
    token_type: 'Bearer',
    issued_at: '2026-11-15T10:00:00Z',
    expires_at: '2026-11-15T10:15:00Z',
    principal: { id: 'human-researcher', display_name: 'Researcher', kind: 'HUMAN' },
    roles,
  };
}

/** The token and identity routes of a fake API, for one person. */
export function withLogin(api: FakeApi, roles: string[] = ['Researcher']): void {
  api.on('POST', '/v1/auth/token', (sent) =>
    sent.headers.authorization === `Bearer ${CREDENTIAL}`
      ? { status: 200, body: accessToken(roles) }
      : { status: 401, body: apiError('UNAUTHENTICATED') },
  );
  api.on('GET', '/v1/system/identity', () => ({
    status: 200,
    body: fixture('system-identity-view.release-recorded.json'),
  }));
}

export interface Run {
  readonly exit: number;
  readonly stdout: TestOutput;
  readonly stderr: TestOutput;
}

export interface Harness {
  readonly configDir: string;
  readonly api: FakeApi;
  run(
    argv: string[],
    options?: { tty?: boolean; stdin?: string; columns?: number; input?: TestInput; output?: TestOutput },
  ): Promise<Run>;
  login(roles?: string[]): Promise<Run>;
  cleanup(): void;
}

export function harness(): Harness {
  const configDir = mkdtempSync(resolve(tmpdir(), 'openquant-cli-'));
  const api = fakeApi();
  const run: Harness['run'] = async (argv, options = {}) => {
    const stdout = options.output ?? new TestOutput(options.tty === true, options.columns);
    const stderr = new TestOutput(options.tty === true, options.columns);
    const stdin =
      options.input ??
      (options.stdin === undefined ? new TestInput(options.tty === true) : Readable.from([options.stdin]));
    const io: CliIo = {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stderr: stderr as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      env: { OPENQUANT_CONFIG_DIR: configDir },
      fetch: api.fetch,
      now: () => NOW,
      readBack: { attempts: 2, delayMs: 0 },
      sleep: async () => {},
      ink: { interactive: true, debug: true },
    };
    const exit = await runCli(argv, io);
    return { exit, stdout, stderr };
  };
  return {
    configDir,
    api,
    run,
    login: (roles = ['Researcher']) => {
      withLogin(api, roles);
      return run(['login', '--api', 'https://api.example.test'], { stdin: `${CREDENTIAL}\n` });
    },
    cleanup: () => rmSync(configDir, { recursive: true, force: true }),
  };
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: the expression finds terminal control sequences.
export const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/;

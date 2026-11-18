// The connected world of apps/api/test/e2e.connected.test.ts: the real API app on a real test PostgreSQL, the real
// built engine-batch binary, the agent runner (its own source, in process) with a fake executor, and loopback fakes of
// everything external: a Cloudflare Queues HTTP-pull endpoint, an Alpaca data and trading host, and the TLS in front of
// them. Nothing here calls a real provider, a model or the network: every host listens on 127.0.0.1.
//
// The binary reaches the fakes through its test-only loopback mode (apps/engine/src/batch/config.rs, LoopbackTest):
// in a debug build and in DEVELOPMENT only, the hosts of its egress allowlist resolve to one loopback port and the wire
// trusts one certificate authority made here with openssl. The allowlist itself is unchanged.

import { type ChildProcess, execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUNDLE_HASH } from '@openquant/agents';
import { HttpApiClient } from '../../../agent-runner/src/api-client.ts';
import { stageBundle } from '../../../agent-runner/src/bundle.ts';
import { loadConfig } from '../../../agent-runner/src/config.ts';
import { Runner } from '../../../agent-runner/src/runner.ts';
import { createDispatchServer } from '../../../agent-runner/src/server.ts';
import { issueCredential } from '../../src/auth/credentials.ts';
import { readMigrationLevel } from '../../src/db/migration-level.ts';
import type { ServiceKind } from '../../src/manifest.ts';
import { createAgentRunnerClient, type Dispatchers } from '../../src/outbox.ts';
import { runRecovery } from '../../src/recovery.ts';
import { serviceOperations } from '../../tools/bootstrap.ts';
import { createRealClock, createTestApp, type TestApp } from './app.ts';
import { ids, seedPrincipals } from './seed.ts';

const here = resolve(fileURLToPath(import.meta.url), '..');
export const repositoryRoot = resolve(here, '../../../..');
export const ENGINE_BATCH_BINARY = resolve(repositoryRoot, 'target/debug/engine-batch');
export const S0_REPLAY_INDEX = resolve(repositoryRoot, 'local-runs/s0/index.json');

/** The engine and method identity of the running core: the golden values of packages/quant-core/tests (A18). */
export const ENGINE = {
  engine_digest: 'sha256:7ceafb5e32e05c234b2a4cd2915946d4c6273ea9455d7b4f98821712555bb36a',
  operator_set: 'daily-long-only-seed@1',
};
export const METHOD = {
  name: 'openquant-evidence-methods',
  version: '1',
  digest: 'sha256:f9ff643a1c197a0425a65bb38bc2dc53b0b1cc9f97ecdecea37690acedce0123',
};

export const API_HOST = 'api.openquant.test';
export const QUEUE_HOST = 'api.cloudflare.com';
export const DATA_HOST = 'data.alpaca.markets';
export const PAPER_HOST = 'paper-api.alpaca.markets';
const QUEUE_ACCOUNT = 'acct-e2e';
const QUEUE_ID = 'batch-e2e';
// Synthetic values: none is a credential of any system.
const QUEUE_TOKEN = 'synthetic-queue-token-e2e-0000000000';
const ALPACA_KEY_ID = 'synthetic-alpaca-key-id-e2e';
const ALPACA_SECRET = 'synthetic-alpaca-secret-e2e-000000';
const DISPATCH_TOKEN = 'synthetic-dispatch-token-e2e-00000000000000';
export const EXECUTOR_VERSION = '2.1.325';

const sha256 = (bytes: Uint8Array | string): string => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

/** The batch binary that `pnpm verify` builds. Missing, the connected test fails with the command that builds it. */
export function requireBatchBinary(): Uint8Array {
  if (!existsSync(ENGINE_BATCH_BINARY)) {
    throw new Error(
      `The connected test needs the batch binary ${ENGINE_BATCH_BINARY}, which is missing. Build it with ` +
        '`cargo build --locked -p openquant-engine --bin engine-batch` (pnpm verify builds it before the TypeScript ' +
        'tests). The test never skips.',
    );
  }
  return readFileSync(ENGINE_BATCH_BINARY);
}

/** The S0 replay index (`result_digest` of every case), written by `s0-replay`. Missing, the test fails with the command. */
export function requireS0Index(): { case: string; outcome: string; result_digest: string | null }[] {
  if (!existsSync(S0_REPLAY_INDEX)) {
    throw new Error(
      `The connected replay compares with ${S0_REPLAY_INDEX}, which is missing. Write it with ` +
        '`cargo run --locked -p openquant-engine --bin s0-replay -- --out local-runs/s0` (pnpm verify runs it first).',
    );
  }
  return (JSON.parse(readFileSync(S0_REPLAY_INDEX, 'utf8')) as { cases: never[] }).cases;
}

/**
 * The S0 cases that s0-replay reports as "Rejected before evaluation" in its report, with the outcome code of their
 * zero-state result: the core refused their documents before it prepared a run.
 */
export function s0RejectedBeforeEvaluation(): Map<string, string> {
  const report = readFileSync(resolve(repositoryRoot, 'local-runs/s0/report.md'), 'utf8');
  const rejected = new Map<string, string>();
  for (const section of report.split('\n## ').slice(1)) {
    const caseId = section.split(' ')[0] ?? '';
    if (!section.includes('Rejected before evaluation')) continue;
    const result = JSON.parse(
      readFileSync(resolve(repositoryRoot, `local-runs/s0/results/${caseId}.result.json`), 'utf8'),
    ) as { outcome: { code: string } };
    rejected.set(caseId, result.outcome.code);
  }
  return rejected;
}

// --- TLS -------------------------------------------------------------------------------------------------------------

interface Tls {
  readonly key: Buffer;
  readonly cert: Buffer;
  /** The certificate authority in DER, which the binary trusts in its loopback mode. */
  readonly rootDer: string;
}

/** A certificate authority and one server certificate for the four loopback hosts, made with openssl. */
function makeTls(directory: string): Tls {
  const probe = spawnSync('openssl', ['version'], { encoding: 'utf8' });
  if (probe.status !== 0) {
    throw new Error(
      'The connected test makes its loopback certificates with openssl, which is not on PATH. Install it.',
    );
  }
  const at = (name: string) => join(directory, name);
  const run = (args: string[]) => execFileSync('openssl', args, { cwd: directory, stdio: 'pipe' });
  const ec = ['-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes'];
  run([
    'req',
    '-x509',
    ...ec,
    '-keyout',
    at('ca.key'),
    '-out',
    at('ca.crt'),
    '-days',
    '2',
    '-subj',
    '/CN=openquant-e2e-test-ca',
    '-addext',
    'basicConstraints=critical,CA:TRUE',
    '-addext',
    'keyUsage=critical,keyCertSign,cRLSign',
  ]);
  run(['req', ...ec, '-keyout', at('server.key'), '-out', at('server.csr'), '-subj', '/CN=openquant-e2e-hosts']);
  writeFileSync(
    at('server.ext'),
    [
      `subjectAltName=${[API_HOST, QUEUE_HOST, DATA_HOST, PAPER_HOST].map((host) => `DNS:${host}`).join(',')}`,
      'basicConstraints=critical,CA:FALSE',
      'keyUsage=critical,digitalSignature',
      'extendedKeyUsage=serverAuth',
      '',
    ].join('\n'),
  );
  run([
    'x509',
    '-req',
    '-in',
    at('server.csr'),
    '-CA',
    at('ca.crt'),
    '-CAkey',
    at('ca.key'),
    '-CAcreateserial',
    '-out',
    at('server.crt'),
    '-days',
    '2',
    '-extfile',
    at('server.ext'),
  ]);
  run(['x509', '-in', at('ca.crt'), '-outform', 'DER', '-out', at('ca.der')]);
  return { key: readFileSync(at('server.key')), cert: readFileSync(at('server.crt')), rootDer: at('ca.der') };
}

// --- the fake Cloudflare queue ---------------------------------------------------------------------------------------

interface QueuedMessage {
  readonly id: string;
  readonly body: string;
  attempts: number;
  visibleAt: number;
  leaseId: string | undefined;
}

/**
 * Cloudflare Queues as the HTTP-pull consumer sees it: a producer side for the API's dispatcher, and the pull and
 * acknowledge paths for the binary. A `json` message body is serialised JSON, delivered base64-encoded with
 * `metadata["CF-Content-Type"] = "json"`, as Cloudflare's pull-consumer documentation states. A pull with nothing
 * visible waits a little before it answers empty, so the worker's idle backoff stays short; a pull whose consumer
 * went away meanwhile leases nothing.
 */
export class FakeQueue {
  readonly #messages: QueuedMessage[] = [];
  #counter = 0;
  #wakers: (() => void)[] = [];
  readonly acknowledged: string[] = [];
  readonly delayed: { id: string; seconds: number }[] = [];
  closed = false;

  send(message: unknown): void {
    this.#counter += 1;
    this.#messages.push({
      id: `msg-${this.#counter}`,
      body: Buffer.from(JSON.stringify(message), 'utf8').toString('base64'),
      attempts: 0,
      visibleAt: 0,
      leaseId: undefined,
    });
    for (const wake of this.#wakers.splice(0)) wake();
  }

  /** Messages not acknowledged yet. */
  get pending(): number {
    return this.#messages.length;
  }

  release(): void {
    this.closed = true;
    for (const wake of this.#wakers.splice(0)) wake();
  }

  async pull(batchSize: number, visibilityMs: number, gone: () => boolean = () => false): Promise<unknown> {
    const deadline = Date.now() + 5_000;
    for (;;) {
      const now = Date.now();
      const visible = this.#messages.filter((message) => message.visibleAt <= now).slice(0, Math.max(1, batchSize));
      // A consumer that went away while its pull waited (a killed process) leases nothing: the wait is this fake's own.
      if (gone()) return { success: false };
      if (visible.length > 0 || now >= deadline || this.closed) {
        for (const message of visible) {
          message.attempts += 1;
          message.visibleAt = now + visibilityMs;
          message.leaseId = `lease-${message.id}-${message.attempts}`;
        }
        return {
          success: true,
          errors: [],
          messages: [],
          result: {
            messages: visible.map((message) => ({
              id: message.id,
              lease_id: message.leaseId,
              timestamp_ms: now,
              attempts: message.attempts,
              body: message.body,
              metadata: { 'CF-Content-Type': 'json' },
            })),
          },
        };
      }
      await new Promise<void>((wake) => {
        const timer = setTimeout(wake, 100);
        this.#wakers.push(() => {
          clearTimeout(timer);
          wake();
        });
      });
    }
  }

  settle(body: { acks?: { lease_id: string }[]; retries?: { lease_id: string; delay_seconds?: number }[] }): unknown {
    for (const ack of body.acks ?? []) {
      const index = this.#messages.findIndex((message) => message.leaseId === ack.lease_id);
      if (index >= 0) this.acknowledged.push((this.#messages.splice(index, 1)[0] as QueuedMessage).id);
    }
    for (const retry of body.retries ?? []) {
      const message = this.#messages.find((entry) => entry.leaseId === retry.lease_id);
      if (message === undefined) continue;
      message.visibleAt = Date.now() + (retry.delay_seconds ?? 0) * 1000;
      message.leaseId = undefined;
      this.delayed.push({ id: message.id, seconds: retry.delay_seconds ?? 0 });
    }
    return { success: true, errors: [], messages: [], result: { ackCount: body.acks?.length ?? 0 } };
  }
}

// --- the fake Alpaca ---------------------------------------------------------------------------------------------------

/** A weekday calendar date of the synthetic market, in UTC days. */
function weekdaysBetween(first: string, last: string): string[] {
  const out: string[] = [];
  const day = 24 * 3600 * 1000;
  for (let at = Date.parse(`${first}T00:00:00Z`); at <= Date.parse(`${last}T00:00:00Z`); at += day) {
    const weekday = new Date(at).getUTCDay();
    if (weekday !== 0 && weekday !== 6) out.push(new Date(at).toISOString().slice(0, 10));
  }
  return out;
}

/** Whether US Eastern daylight time is in force on a date: second Sunday of March to first Sunday of November. */
function easternDaylight(date: string): boolean {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  const sunday = (m: number, nth: number) => {
    const first = new Date(Date.UTC(year, m - 1, 1)).getUTCDay();
    return 1 + ((7 - first) % 7) + 7 * (nth - 1);
  };
  if (month < 3 || month > 11) return false;
  if (month > 3 && month < 11) return true;
  return month === 3 ? day >= sunday(3, 2) : day < sunday(11, 1);
}

/**
 * The synthetic daily bars of the fake market. Every value is invented: a deterministic random walk in cents from the
 * first session of 2022, so that a session has the same bar whatever range a request asks for.
 */
export class SyntheticMarket {
  readonly #bars = new Map<string, { o: number; h: number; l: number; c: number; v: number }>();

  constructor() {
    let state = 20_261_118n;
    const next = (bound: number) => {
      state = (state * 6364136223846793005n + 1442695040888963407n) % 2n ** 64n;
      return Number((state >> 33n) % BigInt(bound));
    };
    let close = 15_000;
    for (const session of weekdaysBetween('2022-01-03', '2026-12-31')) {
      const open = Math.max(1_000, close + next(201) - 100);
      const move = next(601) - 300 + Math.round((15_000 - open) / 200);
      const end = Math.max(1_000, open + move);
      const high = Math.max(open, end) + next(150);
      const low = Math.max(500, Math.min(open, end) - next(150));
      this.#bars.set(session, { o: open, h: high, l: low, c: end, v: 40_000_000 + next(20_000_000) });
      close = end;
    }
  }

  sessions(first: string, last: string): string[] {
    return weekdaysBetween(first, last).filter((session) => this.#bars.has(session));
  }

  bar(session: string) {
    return this.#bars.get(session);
  }
}

const cents = (value: number): string => `${Math.trunc(value / 100)}.${String(value % 100).padStart(2, '0')}`;

/** The fake Alpaca hosts: the asset, calendar, daily bar and corporate-action reads of the market adapter, no more. */
export class FakeAlpaca {
  readonly market = new SyntheticMarket();
  readonly requests: string[] = [];
  readonly #asset: Record<string, unknown>;

  constructor(instrument: { symbol: string; provider_asset_id: string }) {
    // The asset record of the market-data fixtures, for the mission's instrument.
    const template = JSON.parse(
      readFileSync(resolve(repositoryRoot, 'fixtures/market-data/cases/N-03-holiday/responses/01-asset.json'), 'utf8'),
    ) as Record<string, unknown>;
    this.#asset = {
      ...template,
      id: instrument.provider_asset_id,
      symbol: instrument.symbol,
      name: 'Synthetic Pilot Instrument',
    };
  }

  answer(
    host: string,
    method: string,
    url: URL,
    headers: IncomingMessage['headers'],
  ): { status: number; body: unknown } {
    this.requests.push(`${method} ${host}${url.pathname}`);
    if (headers['apca-api-key-id'] !== ALPACA_KEY_ID || headers['apca-api-secret-key'] !== ALPACA_SECRET) {
      return { status: 401, body: { message: 'unauthorized' } };
    }
    const query = url.searchParams;
    if (host === PAPER_HOST && url.pathname === `/v2/assets/${this.#asset.symbol}`)
      return { status: 200, body: this.#asset };
    if (host === PAPER_HOST && url.pathname === '/v2/calendar') {
      const sessions = this.market.sessions(query.get('start') ?? '', query.get('end') ?? '');
      return {
        status: 200,
        body: sessions.map((date) => ({
          date,
          open: '09:30',
          close: '16:00',
          session_open: '0400',
          session_close: '2000',
          settlement_date: date,
        })),
      };
    }
    if (host === DATA_HOST && url.pathname === `/v2/stocks/${this.#asset.symbol}/bars`) {
      const first = (query.get('start') ?? '').slice(0, 10);
      const last = (query.get('end') ?? '').slice(0, 10);
      const bars = this.market.sessions(first, last).map((session) => {
        const bar = this.market.bar(session) as { o: number; h: number; l: number; c: number; v: number };
        return {
          t: `${session}T0${easternDaylight(session) ? 4 : 5}:00:00Z`,
          o: bar.o,
          h: bar.h,
          l: bar.l,
          c: bar.c,
          v: bar.v,
        };
      });
      return { status: 200, body: { bars, symbol: this.#asset.symbol, next_page_token: null } };
    }
    if (host === DATA_HOST && url.pathname === '/v1/corporate-actions') {
      return { status: 200, body: { corporate_actions: {}, next_page_token: null } };
    }
    return { status: 404, body: { message: 'not found' } };
  }
}

/** Prices are JSON numbers in cents with two decimals, as the provider writes them: never a float in this test. */
function alpacaJson(body: unknown): string {
  return JSON.stringify(body, (key, value) =>
    ['o', 'h', 'l', 'c'].includes(key) && typeof value === 'number' ? `@@${cents(value)}@@` : value,
  ).replace(/"@@([0-9.]+)@@"/g, '$1');
}

// --- the HTTP fronts -----------------------------------------------------------------------------------------------

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

async function toFetch(request: IncomingMessage, origin: string): Promise<Request> {
  const body = await readBody(request);
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (typeof value === 'string') headers.set(name, value);
  }
  const method = request.method ?? 'GET';
  return new Request(`${origin}${request.url ?? '/'}`, {
    method,
    headers,
    ...(method === 'GET' || method === 'HEAD' ? {} : { body: new Uint8Array(body) }),
  });
}

async function sendResponse(target: ServerResponse, response: Response): Promise<void> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    headers[name] = value;
  });
  const bytes = Buffer.from(await response.arrayBuffer());
  target.writeHead(response.status, { ...headers, 'content-length': String(bytes.length) });
  target.end(bytes);
}

function listen(server: Server): Promise<number> {
  return new Promise((done, fail) => {
    server.once('error', fail);
    server.listen(0, '127.0.0.1', () => done((server.address() as AddressInfo).port));
  });
}

/** A request of the binary to the API that the test may hold: it answers only when the test releases it. */
export type Hold = (method: string, path: string) => Promise<void> | undefined;

// --- the world -------------------------------------------------------------------------------------------------------

export interface ConnectedWorld {
  readonly app: TestApp;
  readonly queue: FakeQueue;
  readonly alpaca: FakeAlpaca;
  /** Every host and path that a request reached the loopback TLS front with. */
  readonly seen: string[];
  /** The base URL of the API over plain HTTP on the loopback interface, for the api-client and the runner. */
  readonly apiUrl: string;
  readonly credentials: Readonly<Record<'admin' | 'steward' | 'researcher' | 'viewer', string>> &
    Readonly<Record<ServiceKind, string>>;
  readonly batchDigest: string;
  readonly runnerIdentity: { name: string; version: string; digest: string };
  hold: Hold | undefined;
  /** One pass of the scheduled recovery, as the cron trigger runs it, with the queue and the runner as dispatchers. */
  tick(): Promise<void>;
  /** Start the ticker that takes a recovery pass every few hundred milliseconds, until stop(). */
  startTicking(): void;
  stopTicking(): Promise<void>;
  /** Start (or start again) the batch binary. */
  startBatch(): void;
  /** Kill the batch binary at once, as a crash. */
  killBatch(): Promise<void>;
  /** What the batch binary wrote to standard error, across its starts. */
  batchLog(): string;
  close(): Promise<void>;
}

export interface ConnectedOptions {
  readonly instrument: { symbol: string; provider_asset_id: string };
  /** The fake executor's answers, keyed "<skill>|<model>" or "<skill>|*". */
  readonly answers: Record<string, { result?: string; refusal?: true }>;
}

export async function connectedWorld(options: ConnectedOptions): Promise<ConnectedWorld> {
  const binary = requireBatchBinary();
  const batchDigest = sha256(binary);
  const scratch = mkdtempSync(join(tmpdir(), 'oq-connected-'));
  const tls = makeTls(scratch);
  const clock = createRealClock();
  const app = await createTestApp({ orchestrate: true, clock });
  const now = clock.now();

  // People and services, with the service credentials that bootstrap issues: the operations of the route manifest.
  const credentials = await app.database.db.transaction(async (tx) => {
    await seedPrincipals(tx);
    const issue = async (principalId: string, kind: 'HUMAN' | 'SERVICE', operations?: readonly string[]) =>
      (
        await issueCredential(tx, app.env.ids, now, {
          principalId,
          principalKind: kind,
          ...(operations === undefined ? {} : { operations }),
          issuedBy: ids.admin,
        })
      ).token;
    return {
      admin: await issue(ids.admin, 'HUMAN'),
      steward: await issue(ids.steward, 'HUMAN'),
      researcher: await issue(ids.researcher, 'HUMAN'),
      viewer: await issue(ids.viewer, 'HUMAN'),
      batch: await issue(ids.batch, 'SERVICE', serviceOperations('batch')),
      runner: await issue(ids.runner, 'SERVICE', serviceOperations('runner')),
      workflows: await issue(ids.workflows, 'SERVICE', serviceOperations('workflows')),
      deploy: await issue(ids.deploy, 'SERVICE', serviceOperations('deploy')),
    };
  });

  const queue = new FakeQueue();
  const alpaca = new FakeAlpaca(options.instrument);
  const seen: string[] = [];
  const world = { hold: undefined as Hold | undefined };

  // The loopback TLS front of the binary: one port, routed by the host name the binary asked for.
  const https = createHttpsServer({ key: tls.key, cert: tls.cert }, async (request, response) => {
    const host = (request.headers.host ?? '').split(':')[0] ?? '';
    const url = new URL(request.url ?? '/', `https://${host}`);
    seen.push(`${request.method} ${host}${url.pathname}`);
    try {
      if (host === API_HOST) {
        const held = world.hold?.(request.method ?? 'GET', url.pathname);
        if (held !== undefined) await held;
        if (response.destroyed) return;
        await sendResponse(response, await app.app.request(await toFetch(request, `https://${API_HOST}`)));
        return;
      }
      if (host === QUEUE_HOST) {
        const authorised = request.headers.authorization === `Bearer ${QUEUE_TOKEN}`;
        const base = `/client/v4/accounts/${QUEUE_ACCOUNT}/queues/${QUEUE_ID}/messages`;
        const body = JSON.parse((await readBody(request)).toString('utf8') || '{}');
        let answer: unknown;
        if (!authorised) answer = undefined;
        else if (url.pathname === `${base}/pull`)
          answer = await queue.pull(body.batch_size, body.visibility_timeout_ms, () => request.socket.destroyed);
        else if (url.pathname === `${base}/ack`) answer = queue.settle(body);
        const status = !authorised ? 401 : answer === undefined ? 404 : 200;
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(answer ?? { success: false }));
        return;
      }
      if (host === DATA_HOST || host === PAPER_HOST) {
        await readBody(request);
        const { status, body } = alpaca.answer(host, request.method ?? 'GET', url, request.headers);
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(alpacaJson(body));
        return;
      }
      response.writeHead(421);
      response.end();
    } catch (error) {
      if (!response.headersSent) response.writeHead(500);
      response.end(String(error));
    }
  });
  const httpsPort = await listen(https);

  // The API over plain HTTP on the loopback interface, for the api-client and the runner (it allows http on loopback).
  const http = createHttpServer(async (request, response) => {
    await sendResponse(response, await app.app.request(await toFetch(request, 'http://127.0.0.1')));
  });
  const apiPort = await listen(http);
  const apiUrl = `http://127.0.0.1:${apiPort}`;

  // The agent runner: its own modules in process, its claim through the real API with the runner credential, and a
  // fake executor (fake-executor.mjs) in place of the pinned CLI.
  const executorDir = join(scratch, 'executor');
  mkdirSync(executorDir);
  writeFileSync(
    join(executorDir, 'scenario.json'),
    JSON.stringify({ version: EXECUTOR_VERSION, answers: options.answers }),
  );
  const executorPath = join(executorDir, 'claude');
  writeFileSync(
    executorPath,
    `#!/bin/sh\nexec '${process.execPath}' '${join(here, 'fake-executor.mjs')}' '${join(executorDir, 'scenario.json')}' "$@"\n`,
  );
  chmodSync(executorPath, 0o755);
  const bundleDir = join(scratch, 'bundle');
  stageBundle(resolve(repositoryRoot, 'packages/agents'), bundleDir);
  const runnerIdentity = {
    name: 'agent-runner',
    version: '0.0.0',
    digest: sha256(readFileSync(resolve(repositoryRoot, 'apps/agent-runner/src/runner.ts'))),
  };
  const loaded = loadConfig(
    {
      AGENT_RUNNER_ENVIRONMENT: 'DEVELOPMENT',
      AGENT_RUNNER_ENABLED: 'true',
      AGENT_RUNNER_DISPATCH_TOKEN: DISPATCH_TOKEN,
      AGENT_RUNNER_API_BASE_URL: apiUrl,
      AGENT_RUNNER_API_TOKEN: credentials.runner,
      AGENT_RUNNER_EXECUTOR_PATH: executorPath,
      AGENT_RUNNER_EXECUTOR_VERSION: EXECUTOR_VERSION,
      AGENT_RUNNER_SCRATCH_DIR: join(scratch, 'runner'),
      AGENT_RUNNER_WORKER_ID: 'runner-e2e',
      AGENT_RUNNER_BUNDLE_DIR: bundleDir,
      // The fake executor needs no model credential; the variable must hold a value for the runner to start one.
      ANTHROPIC_API_KEY: 'synthetic-model-credential-not-real',
    },
    { identity: runnerIdentity, defaultBundleDir: bundleDir },
  );
  if (!loaded.ok) throw new Error(`The runner configuration is refused: ${loaded.errors.join('; ')}`);
  const runnerLog: string[] = [];
  const runner = new Runner({
    config: loaded.config,
    api: new HttpApiClient(loaded.config.api),
    log: (event, fields) => runnerLog.push(JSON.stringify({ event, ...fields })),
  });
  const runnerServer = createDispatchServer({
    runner,
    dispatchToken: DISPATCH_TOKEN,
    log: (event, fields) => runnerLog.push(JSON.stringify({ event, ...fields })),
  });
  const runnerPort = await listen(runnerServer);

  // The dispatchers of the scheduled pass: the queue producer and the authenticated HTTPS client of the runner, whose
  // requests the test delivers to the runner's loopback port.
  const dispatchers: Dispatchers = {
    batch: { send: async (message) => queue.send(message) },
    runner: createAgentRunnerClient('https://runner.openquant.test', DISPATCH_TOKEN, async (request) => {
      const target = new URL(request.url);
      return fetch(`http://127.0.0.1:${runnerPort}${target.pathname}`, {
        method: request.method,
        headers: request.headers,
        ...(request.method === 'GET' ? {} : { body: await request.text() }),
        redirect: 'manual',
      });
    }),
  };
  const tick = async () => {
    const db = app.env.database();
    try {
      await runRecovery(app.env, db, { dispatchers });
    } finally {
      await db.close();
    }
  };
  let ticking: Promise<void> | undefined;
  let stopTicks = false;

  // The batch binary, in its test-only loopback mode.
  let batch: ChildProcess | undefined;
  let batchExit: Promise<void> | undefined;
  let stderr = '';
  const evidence = join(scratch, 'provider-evidence.json');
  writeFileSync(
    evidence,
    JSON.stringify({
      schema: 'provider-evidence/1',
      facts: {
        paper_authority: 'verified',
        no_live_authority: 'verified',
        data_entitlement: 'verified',
        session_semantics: 'verified',
        egress_refusals: 'verified',
        declaration_field: 'verified',
      },
      constraints: { redistribution_permitted: false, retain_raw: false, terms_ref: 'synthetic-e2e-terms' },
      licence:
        'Synthetic values of the connected test, invented for this repository under Apache-2.0. Not provider data.',
    }),
  );
  const journal = join(scratch, 'journal');
  mkdirSync(journal);
  const startBatch = () => {
    batch = spawn(ENGINE_BATCH_BINARY, [], {
      env: {
        PATH: '/usr/bin:/bin',
        OPENQUANT_ENVIRONMENT: 'DEVELOPMENT',
        OPENQUANT_API_URL: `https://${API_HOST}`,
        OPENQUANT_API_TOKEN: credentials.batch,
        OPENQUANT_QUEUE_ACCOUNT_ID: QUEUE_ACCOUNT,
        OPENQUANT_QUEUE_ID: QUEUE_ID,
        OPENQUANT_QUEUE_TOKEN: QUEUE_TOKEN,
        OPENQUANT_MARKET_RETRIEVAL: 'enabled',
        OPENQUANT_ALPACA_KEY_ID: ALPACA_KEY_ID,
        OPENQUANT_ALPACA_SECRET: ALPACA_SECRET,
        OPENQUANT_PROVIDER_EVIDENCE_FILE: evidence,
        OPENQUANT_CONCURRENCY: '2',
        OPENQUANT_SCRATCH_DIR: journal,
        OPENQUANT_TEST_LOOPBACK_PORT: String(httpsPort),
        OPENQUANT_TEST_LOOPBACK_ROOT: tls.rootDer,
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    batch.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    const child = batch;
    batchExit = new Promise((done) => child.once('exit', () => done()));
  };
  const killBatch = async () => {
    if (batch !== undefined && batch.exitCode === null && batch.signalCode === null) {
      batch.kill('SIGKILL');
      await batchExit;
    }
  };

  return {
    app,
    queue,
    alpaca,
    seen,
    apiUrl,
    credentials,
    batchDigest,
    runnerIdentity,
    get hold() {
      return world.hold;
    },
    set hold(value) {
      world.hold = value;
    },
    tick,
    startTicking() {
      stopTicks = false;
      ticking = (async () => {
        while (!stopTicks) {
          try {
            await tick();
          } catch (error) {
            stderr += `\n[tick failed] ${String(error)}\n`;
          }
          await new Promise((done) => setTimeout(done, 250));
        }
      })();
    },
    async stopTicking() {
      stopTicks = true;
      await ticking;
    },
    startBatch,
    killBatch,
    batchLog: () => `${stderr}\n--- runner ---\n${runnerLog.join('\n')}`,
    async close() {
      stopTicks = true;
      await ticking;
      queue.release();
      await killBatch();
      await runner.shutdown();
      await new Promise<void>((done) => runnerServer.close(() => done()));
      https.closeAllConnections();
      http.closeAllConnections();
      await new Promise<void>((done) => https.close(() => done()));
      await new Promise<void>((done) => http.close(() => done()));
      await app.drop();
      rmSync(scratch, { recursive: true, force: true });
    },
  };
}

/** The release of the environment, as the delivery job records it, with the identities that actually run here. */
export async function releaseManifest(world: ConnectedWorld): Promise<Record<string, unknown>> {
  const template = JSON.parse(
    readFileSync(resolve(repositoryRoot, 'fixtures/protocol/valid/release-manifest.staging.json'), 'utf8'),
  ) as Record<string, unknown>;
  return {
    ...template,
    environment: 'DEVELOPMENT',
    engine: ENGINE,
    method: METHOD,
    bundle_hash: BUNDLE_HASH,
    executables: [{ name: 'engine-batch', version: '0.0.0', digest: world.batchDigest }, world.runnerIdentity],
    migration_level: await readMigrationLevel(world.app.database.db),
  };
}

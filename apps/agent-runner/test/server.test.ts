import { readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { connect } from 'node:net';
import { resolve } from 'node:path';
import { canonicalJson, parseContract, validateContract } from '@openquant/api-contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { revisionOutput } from '../../../packages/agents/test/support/requests.ts';
import { Runner } from '../src/runner.ts';
import {
  apiError,
  createDispatchServer,
  DISPATCH_BODY_LIMIT,
  DISPATCH_PATH,
  ERROR_STATUS,
  sameSecret,
} from '../src/server.ts';
import {
  API_TOKEN,
  apiFailure,
  CAPABILITY,
  cleanup,
  DISPATCH_TOKEN,
  dispatchFor,
  formulationRequest,
  HOST_SECRET,
  MODEL_KEY,
  makeWorld,
  repositoryRoot,
  type Scenario,
  until,
  type World,
} from './support/world.ts';

interface Route {
  id: string;
  max_body_bytes: number;
  success_status: number;
  errors: string[];
  auth: { kind: string; principals?: string[] }[];
}
interface Manifest {
  common_errors: string[];
  error_status: Record<string, number>;
  routes: Route[];
}
const manifest = JSON.parse(
  readFileSync(resolve(repositoryRoot, 'packages/api-contracts/routes/v1.json'), 'utf8'),
) as Manifest;
const route = manifest.routes.find((entry) => entry.id === 'runner.dispatch') as Route;

let server: Server | undefined;
let world: World;
let runner: Runner;
let port = 0;
let valid: ReturnType<typeof dispatchFor>;
const logs: string[] = [];

async function start(scenario: Scenario, options: Parameters<typeof makeWorld>[1] = {}): Promise<void> {
  const assembled = await formulationRequest();
  world = makeWorld(scenario, options);
  world.api.store(assembled.bytes);
  valid = dispatchFor(assembled);
  runner = new Runner({
    config: world.config,
    api: world.api,
    log: (event, fields) => logs.push(JSON.stringify({ event, ...fields })),
    sleep: async () => undefined,
  });
  server = createDispatchServer({
    runner,
    dispatchToken: DISPATCH_TOKEN,
    log: (event, fields) => logs.push(JSON.stringify({ event, ...fields })),
  });
  await new Promise<void>((done) => server?.listen(0, '127.0.0.1', done));
  port = (server.address() as AddressInfo).port;
}

beforeEach(() => {
  logs.length = 0;
});

afterEach(async () => {
  await runner?.shutdown();
  await new Promise<void>((done) => (server ? server.close(() => done()) : done()));
  server = undefined;
  cleanup();
});

const url = () => `http://127.0.0.1:${port}${DISPATCH_PATH}`;

function post(
  body: string | Uint8Array,
  headers: Record<string, string> = { authorization: `Bearer ${DISPATCH_TOKEN}` },
) {
  return fetch(url(), {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: Buffer.from(typeof body === 'string' ? body : body),
  });
}

async function errorBody(response: Response) {
  const text = await response.text();
  const parsed = parseContract('api-error', text);
  expect(parsed.ok, text).toBe(true);
  if (!parsed.ok) throw new Error(text);
  for (const secret of [MODEL_KEY, HOST_SECRET, DISPATCH_TOKEN, API_TOKEN, CAPABILITY])
    expect(text).not.toContain(secret);
  return parsed.value;
}

// A raw HTTP exchange: the head and the chunks are written as given, and whatever arrives before the socket closes is returned.
function raw(head: string[], chunks: Buffer[]): Promise<string> {
  return new Promise((resolveRaw) => {
    const socket = connect(port, '127.0.0.1');
    let received = '';
    socket.on('data', (data) => {
      received += data.toString('latin1');
    });
    socket.on('error', () => undefined);
    socket.on('close', () => resolveRaw(received));
    socket.write(`${head.join('\r\n')}\r\n\r\n`);
    for (const chunk of chunks) socket.write(chunk);
    setTimeout(() => socket.destroy(), 4000);
  });
}

describe('the route manifest and the endpoint', () => {
  it('serves the path and the body limit that routes/v1.json states for runner.dispatch', () => {
    expect(route).toBeDefined();
    expect(DISPATCH_PATH).toBe('/v1/agent-attempts');
    expect(DISPATCH_BODY_LIMIT).toBe(route.max_body_bytes);
    expect(route.success_status).toBe(202);
    expect(route.auth).toEqual([{ kind: 'service', principals: ['workflows'] }]);
  });

  it('maps every error code that it can send onto the status of the manifest, and sends only listed codes', () => {
    for (const [code, status] of Object.entries(ERROR_STATUS)) expect(manifest.error_status[code], code).toBe(status);
    const listed = new Set([...route.errors, ...manifest.common_errors]);
    // The codes that a dispatch can end with, besides NOT_FOUND for a path that is no route at all.
    for (const code of [
      'UNAUTHENTICATED',
      'LIMIT_EXCEEDED',
      'SCHEMA_VIOLATION',
      'UNSUPPORTED_SCHEMA_VERSION',
      'INVALID_DECIMAL',
      'STALE_OWNERSHIP',
      'ATTEMPT_NOT_CLAIMABLE',
      'IDENTITY_MISMATCH',
      'EXECUTION_DISABLED',
      'RATE_LIMITED',
      'UNAVAILABLE',
      'INTERNAL',
    ]) {
      expect(listed.has(code), code).toBe(true);
    }
  });

  it('builds error bodies that are valid api-error/1 documents', () => {
    for (const code of Object.keys(ERROR_STATUS)) {
      const body = apiError(code as keyof typeof ERROR_STATUS, 'message', { stateChanged: 'UNKNOWN' });
      expect(validateContract('api-error', body).ok, code).toBe(true);
    }
    expect(apiError('RATE_LIMITED', 'x').retry_safe).toBe(true);
    expect(apiError('IDENTITY_MISMATCH', 'x').retry_safe).toBe(false);
  });

  it('compares secrets of any length in constant time and exactly', () => {
    expect(sameSecret('a', 'a')).toBe(true);
    expect(sameSecret('a', 'b')).toBe(false);
    expect(sameSecret('', 'a')).toBe(false);
    expect(sameSecret('a'.repeat(1000), 'a'.repeat(999))).toBe(false);
  });
});

describe('authentication', () => {
  it('accepts the dispatch with the credential of the workflows principal and answers 202 with no body', async () => {
    await start({ behaviour: 'result', resultText: JSON.stringify(await revisionOutput()) });
    const response = await post(canonicalJson(valid));
    expect(response.status).toBe(202);
    expect(await response.text()).toBe('');
    await runner.idle();
    expect(world.api.results).toHaveLength(1);
    expect(world.api.results[0]?.outcome.outcome).toBe('completion');
  });

  it('refuses a request without a credential, with a wrong one and with another credential of the system, and claims nothing', async () => {
    await start({ behaviour: 'result' });
    const attempts: Record<string, string>[] = [
      {},
      { authorization: 'Bearer wrong-token-0000000000000000000000000' },
      { authorization: `Bearer ${API_TOKEN}` },
      { authorization: `Bearer ${CAPABILITY}` },
      { authorization: DISPATCH_TOKEN },
      { authorization: `Basic ${DISPATCH_TOKEN}` },
      { authorization: `Bearer ${DISPATCH_TOKEN} extra` },
    ];
    for (const headers of attempts) {
      const response = await post(canonicalJson(valid), headers);
      expect(response.status, JSON.stringify(headers)).toBe(401);
      expect((await errorBody(response)).code).toBe('UNAUTHENTICATED');
    }
    expect(world.api.events).toEqual([]);
    expect(world.cli.calls()).toEqual([]);
  });

  it('refuses before it reads a large body', async () => {
    await start({ behaviour: 'result' });
    const reply = await raw(
      ['POST /v1/agent-attempts HTTP/1.1', 'host: x', 'content-length: 3000000', 'content-type: application/json'],
      [],
    );
    expect(reply.startsWith('HTTP/1.1 401')).toBe(true);
  });

  it('answers 404 for another path or another method, whatever the credential', async () => {
    await start({ behaviour: 'result' });
    const other = await fetch(`http://127.0.0.1:${port}/v1/other`, {
      method: 'POST',
      headers: { authorization: `Bearer ${DISPATCH_TOKEN}` },
      body: '{}',
    });
    expect(other.status).toBe(404);
    expect((await errorBody(other)).code).toBe('NOT_FOUND');
    const get = await fetch(url(), { headers: { authorization: `Bearer ${DISPATCH_TOKEN}` } });
    expect(get.status).toBe(404);
    await get.arrayBuffer();
  });
});

describe('the body', () => {
  it('refuses a declared length above the limit with LIMIT_EXCEEDED, before it reads or parses the body', async () => {
    await start({ behaviour: 'result' });
    const reply = await raw(
      [
        'POST /v1/agent-attempts HTTP/1.1',
        'host: x',
        `authorization: Bearer ${DISPATCH_TOKEN}`,
        `content-length: ${DISPATCH_BODY_LIMIT + 1}`,
      ],
      [],
    );
    expect(reply.startsWith('HTTP/1.1 413')).toBe(true);
    expect(JSON.parse(reply.slice(reply.indexOf('{')))).toMatchObject({
      schema_version: 'api-error/1',
      code: 'LIMIT_EXCEEDED',
    });
    expect(world.api.events).toEqual([]);
  });

  it('refuses a streamed body that grows past the limit, and does not parse it (a parse would say 400)', async () => {
    await start({ behaviour: 'result' });
    const chunk = Buffer.alloc(1024 * 1024, 0x78);
    const chunks = [chunk, chunk, chunk, chunk, Buffer.from('x')].flatMap((data) => [
      Buffer.from(`${data.length.toString(16)}\r\n`),
      data,
      Buffer.from('\r\n'),
    ]);
    const reply = await raw(
      [
        'POST /v1/agent-attempts HTTP/1.1',
        'host: x',
        `authorization: Bearer ${DISPATCH_TOKEN}`,
        'transfer-encoding: chunked',
      ],
      [...chunks, Buffer.from('0\r\n\r\n')],
    );
    expect(reply.startsWith('HTTP/1.1 413')).toBe(true);
    expect(world.api.events).toEqual([]);
  });

  it('parses a body of exactly the limit and refuses it as malformed, not as too large', async () => {
    await start({ behaviour: 'result' });
    const response = await post(Buffer.alloc(DISPATCH_BODY_LIMIT, 0x78));
    expect(response.status).toBe(400);
    expect((await errorBody(response)).code).toBe('SCHEMA_VIOLATION');
    expect(world.api.events).toEqual([]);
  });

  it('refuses a dispatch that does not satisfy agent-dispatch/1 with the violations of the contract layer', async () => {
    await start({ behaviour: 'result' });
    const broken = { ...valid, identity: { ...valid.identity, role: 'operator' } };
    const response = await post(JSON.stringify(broken));
    expect(response.status).toBe(400);
    const body = await errorBody(response);
    expect(body.code).toBe('SCHEMA_VIOLATION');
    expect(body.violations?.length).toBeGreaterThan(0);
    expect(body.violations?.[0]?.pointer).toContain('/identity/role');
    expect(world.api.events).toEqual([]);
  });

  it('refuses another version of the contract and an unknown field', async () => {
    await start({ behaviour: 'result' });
    const version = await post(JSON.stringify({ ...valid, schema_version: 'agent-dispatch/2' }));
    expect(version.status).toBe(400);
    expect((await errorBody(version)).code).toBe('UNSUPPORTED_SCHEMA_VERSION');
    const field = await post(JSON.stringify({ ...valid, tools_override: ['Bash'] }));
    expect(field.status).toBe(400);
    expect((await errorBody(field)).code).toBe('SCHEMA_VIOLATION');
  });

  it('refuses a malformed cost amount as INVALID_DECIMAL, the only decimal violation', async () => {
    await start({ behaviour: 'result' });
    const bad = {
      ...valid,
      execution: {
        ...valid.execution,
        bounds: { ...valid.execution.bounds, cost_reservation: { amount: '05', currency: 'USD' } },
      },
    };
    const response = await post(JSON.stringify(bad));
    expect(response.status).toBe(400);
    expect((await errorBody(response)).code).toBe('INVALID_DECIMAL');
  });

  it('refuses a request that lists a tool, because no tool is granted to the pilot roles', async () => {
    await start({ behaviour: 'result' });
    const response = await post(
      JSON.stringify({ ...valid, execution: { ...valid.execution, tools: ['tool:search@1'] } }),
    );
    expect(response.status).toBe(400);
    expect((await errorBody(response)).code).toBe('SCHEMA_VIOLATION');
  });
});

describe('what the runner answers when it cannot take the attempt', () => {
  it.each([
    [apiFailure(409, 'STALE_OWNERSHIP'), 409, 'STALE_OWNERSHIP', 'NONE'],
    [apiFailure(409, 'ATTEMPT_NOT_CLAIMABLE'), 409, 'ATTEMPT_NOT_CLAIMABLE', 'NONE'],
    [apiFailure(409, 'EXECUTION_DISABLED'), 409, 'EXECUTION_DISABLED', 'NONE'],
    [apiFailure(0, 'NETWORK'), 503, 'UNAVAILABLE', 'UNKNOWN'],
    [apiFailure(400, 'SCHEMA_VIOLATION'), 500, 'INTERNAL', 'NONE'],
  ] as const)(
    'answers a refused claim (%#) with status %i, code %s and state_changed %s, and starts nothing',
    async (claim, status, code, stateChanged) => {
      await start({ behaviour: 'result' }, { apiOptions: { claim } });
      const response = await post(canonicalJson(valid));
      expect(response.status).toBe(status);
      const body = await errorBody(response);
      expect(body).toMatchObject({ code, state_changed: stateChanged });
      expect(world.cli.calls()).toEqual([]);
      expect(runner.running).toBe(0);
    },
  );

  it('answers 422 for a dispatch for another environment and 429 above the concurrency', async () => {
    await start({ behaviour: 'hang' }, { maxConcurrent: 1 });
    const other = await post(JSON.stringify({ ...valid, environment: 'PRODUCTION' }));
    expect(other.status).toBe(422);
    expect((await errorBody(other)).code).toBe('IDENTITY_MISMATCH');

    expect((await post(canonicalJson(valid))).status).toBe(202);
    const second = dispatchFor(await formulationRequest(), { attempt: 'attempt-2' });
    const busy = await post(canonicalJson(second));
    expect(busy.status).toBe(429);
    const body = await errorBody(busy);
    expect(body).toMatchObject({ code: 'RATE_LIMITED', retry_safe: true });
    expect(world.api.claims.map((claim) => claim.attempt.attempt_id)).toEqual(['attempt-1']);
    runner.cancel('attempt-1');
    await until(() => runner.running === 0);
  });

  it('answers 202 for a disabled executor and records the denial, so a refusal is never silent', async () => {
    await start({ behaviour: 'result' }, { enabled: false });
    expect((await post(canonicalJson(valid))).status).toBe(202);
    await runner.idle();
    expect(world.api.results[0]?.outcome).toMatchObject({ outcome: 'denied_capability', reason: 'EXECUTION_DISABLED' });
    expect(world.cli.calls()).toEqual([]);
  });
});

describe('the cancel route', () => {
  const cancelRoute = manifest.routes.find((entry) => entry.id === 'runner.cancel') as Route & {
    path: string;
    request: { kind: string };
  };
  const cancel = (attemptId: string, headers: Record<string, string> = { authorization: `Bearer ${DISPATCH_TOKEN}` }) =>
    fetch(`http://127.0.0.1:${port}${DISPATCH_PATH}/${attemptId}/cancel`, { method: 'POST', headers });

  it('is the route that routes/v1.json lists: the workflows credential, no body, 204 and no error of its own', () => {
    expect(cancelRoute).toMatchObject({
      path: '/v1/agent-attempts/{attempt_id}/cancel',
      auth: [{ kind: 'service', principals: ['workflows'] }],
      request: { kind: 'none' },
      success_status: 204,
      errors: [],
    });
  });

  it('ends the attempt that runs, which records the outcome cancellation and nothing else', async () => {
    await start({ behaviour: 'hang' });
    expect((await post(canonicalJson(valid))).status).toBe(202);
    await until(() => world.cli.calls().length > 0);
    const response = await cancel('attempt-1');
    expect(response.status).toBe(204);
    expect(await response.text()).toBe('');
    await until(() => runner.running === 0);
    expect(world.api.results).toHaveLength(1);
    expect(world.api.results[0]?.outcome).toMatchObject({ outcome: 'cancellation' });
    // A repeated request, or one for an attempt that this runner does not run, is answered the same and ends nothing.
    expect((await cancel('attempt-1')).status).toBe(204);
    expect((await cancel('attempt-unknown')).status).toBe(204);
    expect(world.api.results).toHaveLength(1);
  });

  it('refuses a request without the dispatch credential and ends nothing', async () => {
    await start({ behaviour: 'hang' });
    expect((await post(canonicalJson(valid))).status).toBe(202);
    const response = await cancel('attempt-1', { authorization: 'Bearer wrong-token-0000000000000000000000000' });
    expect(response.status).toBe(401);
    expect((await errorBody(response)).code).toBe('UNAUTHENTICATED');
    expect(runner.running).toBe(1);
    runner.cancel('attempt-1');
    await until(() => runner.running === 0);
  });

  it('is no route for another method or another path', async () => {
    await start({ behaviour: 'result' });
    const get = await fetch(`http://127.0.0.1:${port}${DISPATCH_PATH}/attempt-1/cancel`, {
      headers: { authorization: `Bearer ${DISPATCH_TOKEN}` },
    });
    expect(get.status).toBe(404);
    expect((await cancel('attempt-1/extra')).status).toBe(404);
    expect((await cancel('-attempt')).status).toBe(404);
  });
});

describe('logs', () => {
  it('never contain a credential, a capability or a payload', async () => {
    await start({ behaviour: 'result', resultText: JSON.stringify(await revisionOutput()) });
    await post(canonicalJson(valid), { authorization: 'Bearer wrong-token-0000000000000000000000000' });
    await post(canonicalJson(valid));
    await runner.idle();
    const text = logs.join('\n');
    expect(text.length).toBeGreaterThan(0);
    for (const secret of [MODEL_KEY, HOST_SECRET, DISPATCH_TOKEN, API_TOKEN, CAPABILITY, 'wrong-token'])
      expect(text).not.toContain(secret);
    expect(text).not.toContain('definition');
  });
});

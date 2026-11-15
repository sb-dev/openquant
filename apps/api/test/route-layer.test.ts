// The route layer (OQ-05 sections 7 and 9): the body limit before any parse, the mapping of a ContractError onto
// api-error/1, the form and command kind checks, the order of the chain, unknown routes, the handler of every route, unexpected
// errors and response headers. Requests go through the real Hono app on a real database.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type ContractName, parseContract } from '@openquant/api-contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readBounded } from '../src/body.ts';
import { ApiFailure } from '../src/errors.ts';
import type { Handler } from '../src/handlers/context.ts';
import { handlers } from '../src/handlers/index.ts';
import { type Actors, accessTokenFor, type HumanName, mintCapability, seedActors } from './support/actors.ts';
import { bearer, createTestApp, type TestApp } from './support/app.ts';

// biome-ignore lint/suspicious/noExplicitAny: the tests edit fixture documents by path.
type Doc = Record<string, any>;

const root = resolve(fileURLToPath(import.meta.url), '../../../..');
interface RawRoute {
  id: string;
  host: string;
  method: string;
  path: string;
  auth: { kind: string; roles?: string[]; principals?: string[] }[];
  request: { kind: string; contract?: string; form?: string; command_kind?: string };
  max_body_bytes?: number;
  errors: string[];
}
const manifest = JSON.parse(readFileSync(resolve(root, 'packages/api-contracts/routes/v1.json'), 'utf8')) as {
  routes: RawRoute[];
  common_errors: string[];
  error_status: Record<string, number>;
};
const served = manifest.routes.filter((route) => route.host === 'api');
const withBody = served.filter((route) => route.request.kind !== 'none');
const fixture = (path: string): Buffer => readFileSync(resolve(root, 'fixtures', path));
const validFixture: Record<string, string> = {
  'research-profiles.register': 'protocol/valid/command.register-research-profile.json',
  'cohort-policies.register': 'protocol/valid/command.register-cohort-policy.json',
  'budgets.register': 'protocol/valid/command.register-budget.json',
  'seeds.register': 'protocol/valid/command.register-seed.json',
  'missions.create': 'protocol/valid/command.create-mission.json',
  'missions.run-now': 'protocol/valid/command.run-mission-now.json',
  'missions.cancel': 'protocol/valid/command.cancel-mission.json',
  'releases.record': 'protocol/valid/release-manifest.staging.json',
  'attempts.claim': 'protocol/valid/attempt-claim.claim.json',
  'attempts.retrieval-result': 'protocol/valid/retrieval-result.complete.json',
  'attempts.validation-result': 'protocol/valid/validation-result.valid-seed.json',
  'attempts.evaluation-submission': 'protocol/valid/evaluation-submission.completed-replay.json',
  'attempts.gate-report': 'protocol/valid/gate-report.no-eligible-candidate.json',
  'attempts.agent-result': 'protocol/valid/agent-attempt-result.completion.json',
};

let testApp: TestApp;
let actors: Actors;
const people = {} as Record<HumanName, string>;
const roleToPerson: Record<string, HumanName> = {
  Viewer: 'viewer',
  Researcher: 'researcher',
  Steward: 'steward',
  Administrator: 'admin',
};
const callers = new Map<string, { token: string; attemptId: string }>();

beforeAll(async () => {
  testApp = await createTestApp();
  actors = await seedActors(testApp);
  for (const name of Object.keys(roleToPerson).map((role) => roleToPerson[role] as HumanName)) {
    people[name] = await accessTokenFor(testApp, actors.people[name]);
  }
});
afterAll(async () => {
  await testApp.drop();
});

/** A credential that the manifest lets into the route, and the attempt id for the path. */
async function callerFor(route: RawRoute): Promise<{ token: string; attemptId: string }> {
  const cached = callers.get(route.id);
  if (cached) return cached;
  let found: { token: string; attemptId: string };
  const human = route.auth.find((rule) => rule.kind === 'human');
  const service = route.auth.find((rule) => rule.kind === 'service');
  const attempt = route.auth.find((rule) => rule.kind === 'attempt');
  if (human?.roles?.[0]) found = { token: people[roleToPerson[human.roles[0]] as HumanName], attemptId: 'att-x' };
  else if (service?.principals?.[0]) {
    found = { token: actors.services.full[service.principals[0] as 'batch'], attemptId: 'att-x' };
  } else if (attempt?.principals?.[0]) {
    const minted = await mintCapability(testApp, 'live', `svc-${attempt.principals[0]}`);
    found = { token: minted.token, attemptId: minted.attemptId };
  } else found = { token: actors.people.admin, attemptId: 'att-x' };
  callers.set(route.id, found);
  return found;
}

const pathOf = (route: RawRoute, attemptId: string) =>
  route.path
    .replace('{attempt_id}', attemptId)
    .replace('{digest}', `sha256:${'a'.repeat(64)}`)
    // The mission of the path is the mission of the command fixtures: a command for another mission is refused.
    .replace('{mission_id}', 'msn-aapl-0001')
    .replace(/\{[a-z_]+\}/g, 'x-1');

async function send(
  route: RawRoute,
  body: Uint8Array | string | undefined,
  extra: Record<string, string> = {},
  token?: string,
) {
  const caller = await callerFor(route);
  const headers: Record<string, string> = { ...bearer(token ?? caller.token), ...extra };
  return testApp.request(pathOf(route, caller.attemptId), {
    method: route.method,
    headers,
    ...(body === undefined ? {} : { body }),
  });
}

function padded(document: Uint8Array, size: number): Uint8Array {
  const out = new Uint8Array(size);
  out.fill(0x20);
  out.set(document);
  return out;
}

async function errorOf(response: Response): Promise<{
  code: string;
  message: string;
  violations?: { pointer: string; message: string }[];
  diagnostic_ref: string;
  state_changed: string;
  retry_safe: boolean;
}> {
  const bytes = new Uint8Array(await response.arrayBuffer());
  const parsed = parseContract('api-error', bytes);
  expect(parsed.ok, new TextDecoder().decode(bytes).slice(0, 300)).toBe(true);
  return parsed.ok ? (parsed.value as never) : (undefined as never);
}

describe('the body limit comes before the parse (OQ-05 section 7)', () => {
  it('declares a limit for every route with a body, and none for a route without one', () => {
    for (const route of served)
      expect(route.max_body_bytes !== undefined, route.id).toBe(route.request.kind !== 'none');
    expect(withBody.map((route) => route.max_body_bytes)).toContain(16 * 1024 * 1024);
  });

  for (const route of withBody) {
    const limit = route.max_body_bytes as number;
    it(`${route.id}: refuses ${limit} bytes plus one that a parse would accept, and lets exactly ${limit} bytes through`, async () => {
      const document =
        route.request.kind === 'bytes' ? new Uint8Array([1, 2, 3]) : fixture(validFixture[route.id] as string);
      if (route.request.kind === 'contract') {
        // The padded document is valid JSON of the contract: only the limit stands in its way.
        expect(parseContract(route.request.contract as ContractName, padded(document, limit)).ok).toBe(true);
      }
      const over = await send(route, padded(document, limit + 1), { 'content-length': String(limit + 1) });
      expect(over.status, 'a declared length above the limit').toBe(413);
      expect((await errorOf(over)).code).toBe('LIMIT_EXCEEDED');
      const exact = await send(route, padded(document, limit), { 'content-length': String(limit) });
      // Past the limit and the parse the route does its own work: a command is applied or refused for its own reason,
      // and an attempt route refuses a body whose attempt is not the attempt of the path. It is neither LIMIT_EXCEEDED
      // nor a failure of the parse.
      expect([202, 204, 400, 404, 409, 422], `exactly the limit: ${exact.status}`).toContain(exact.status);
      if (exact.status === 400) {
        expect(
          (await errorOf(exact)).violations?.[0]?.pointer,
          'a 400 past the parse names the attempt of the body',
        ).toBe('/attempt/attempt_id');
      }
    });
  }

  it('counts the bytes of a body that declares no length, or a false small one, and refuses it above the limit', async () => {
    const route = served.find((entry) => entry.id === 'budgets.register') as RawRoute;
    const limit = route.max_body_bytes as number;
    const document = padded(fixture(validFixture['budgets.register'] as string), limit + 1);
    // A false, small Content-Length: the declared 10 bytes are no promise.
    const lying = await send(route, document, { 'content-length': '10' });
    expect(lying.status).toBe(413);
    // No Content-Length: a stream, as chunked transfer gives.
    const caller = await callerFor(route);
    const chunks = [document.slice(0, 1000), document.slice(1000)];
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        const next = chunks.shift();
        if (next) controller.enqueue(next);
        else controller.close();
      },
    });
    const streamed = await testApp.app.fetch(
      new Request(`http://localhost${pathOf(route, caller.attemptId)}`, {
        method: 'POST',
        headers: bearer(caller.token),
        body: stream,
        duplex: 'half',
      } as RequestInit),
    );
    expect(streamed.status).toBe(413);
    expect((await errorOf(streamed)).code).toBe('LIMIT_EXCEEDED');
  });

  it('stops reading a stream one chunk after the limit, however long the stream is', async () => {
    let pulled = 0;
    const endless = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulled += 1;
          controller.enqueue(new Uint8Array(1000));
        },
      },
      { highWaterMark: 0 },
    );
    await expect(
      readBounded(
        new Request('http://localhost/x', { method: 'POST', body: endless, duplex: 'half' } as RequestInit),
        4096,
      ),
    ).rejects.toMatchObject({
      code: 'LIMIT_EXCEEDED',
    });
    // 5 chunks of 1000 bytes pass the limit of 4096: nothing is read beyond the chunk that crossed it.
    expect(pulled).toBe(5);
  });

  it('reads a body that is within the limit whole, whether it comes in one chunk or in many', async () => {
    const bytes = new Uint8Array(3000).map((_, index) => index % 251);
    const one = await readBounded(new Request('http://localhost/x', { method: 'POST', body: bytes }), 4096);
    expect(one).toEqual(bytes);
    const parts = [bytes.slice(0, 1), bytes.slice(1, 2000), bytes.slice(2000)];
    const many = new ReadableStream<Uint8Array>({
      pull(controller) {
        const next = parts.shift();
        if (next) controller.enqueue(next);
        else controller.close();
      },
    });
    expect(
      await readBounded(
        new Request('http://localhost/x', { method: 'POST', body: many, duplex: 'half' } as RequestInit),
        4096,
      ),
    ).toEqual(bytes);
    expect(await readBounded(new Request('http://localhost/x'), 10)).toEqual(new Uint8Array(0));
  });
});

describe('the order of the chain: authenticate, authorise, limit, parse', () => {
  const route = () => served.find((entry) => entry.id === 'budgets.register') as RawRoute;

  function lazyBody(size: number) {
    const state = { pulls: 0 };
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          state.pulls += 1;
          if (sent >= size) controller.close();
          else {
            sent += 1000;
            controller.enqueue(new Uint8Array(1000).fill(0x20));
          }
        },
      },
      { highWaterMark: 0 },
    );
    return { state, stream };
  }

  async function sendStream(token: string | undefined, size: number) {
    const { state, stream } = lazyBody(size);
    const response = await testApp.app.fetch(
      new Request('http://localhost/v1/budgets', {
        method: 'POST',
        headers: token === undefined ? {} : bearer(token),
        body: stream,
        duplex: 'half',
      } as RequestInit),
    );
    return { response, pulls: state.pulls };
  }

  it('answers an unauthenticated caller with 401 and never reads its body, however large', async () => {
    const { response, pulls } = await sendStream(undefined, 10_000_000);
    expect(response.status).toBe(401);
    expect(pulls).toBe(0);
  });

  it('answers a caller without the role with 403 and never reads its body', async () => {
    const { response, pulls } = await sendStream(people.viewer, 10_000_000);
    expect(response.status).toBe(403);
    expect(pulls).toBe(0);
  });

  it('refuses an authorised caller with an oversized body at the limit, not at the parse', async () => {
    const { response, pulls } = await sendStream(people.steward, 10_000_000);
    expect(response.status).toBe(413);
    // It read the body only up to the limit of 512 KiB and one chunk.
    expect(pulls).toBeLessThanOrEqual(Math.ceil((route().max_body_bytes as number) / 1000) + 1);
    expect(pulls).toBeGreaterThan(0);
  });

  it('checks the limit before it parses: a body that is both too large and not JSON is LIMIT_EXCEEDED', async () => {
    const response = await send(route(), new Uint8Array((route().max_body_bytes as number) + 1).fill(0x78));
    expect(response.status).toBe(413);
  });

  it('opens no database query for a request without a credential', async () => {
    const before = { ...testApp.connections };
    expect((await testApp.request('/v1/budgets', { method: 'POST', body: '{}' })).status).toBe(401);
    expect(testApp.connections.queries).toBe(before.queries);
    expect(testApp.connections.closed - before.closed).toBe(testApp.connections.opened - before.opened);
  });

  it('closes the database handle of every request, success or failure', async () => {
    const before = { ...testApp.connections };
    await testApp.request('/v1/system/identity', { headers: bearer(people.viewer) });
    await testApp.request('/v1/budgets', { method: 'POST', headers: bearer(people.steward), body: '{' });
    await testApp.request('/nowhere');
    await testApp.request('/health');
    expect(testApp.connections.opened - before.opened).toBe(4);
    expect(testApp.connections.closed - before.closed).toBe(4);
  });
});

describe('a ContractError becomes api-error/1 (OQ-05 section 7)', () => {
  const budget = () => JSON.parse(fixture('protocol/valid/command.register-budget.json').toString('utf8')) as Doc;
  const steward = () => served.find((entry) => entry.id === 'budgets.register') as RawRoute;

  it('carries the 21 entries of a real maximal listing and a 400', async () => {
    const command = budget();
    // One malformed decimal under the root oneOf of command/1 lists 20 violations and a counted rest.
    command.payload.budget.model_spend.amount = '01.5';
    const response = await send(steward(), JSON.stringify(command));
    expect(response.status).toBe(400);
    const body = await errorOf(response);
    expect(body.code).toBe('SCHEMA_VIOLATION');
    expect(body.violations).toHaveLength(21);
    expect(body.violations?.at(-1)).toMatchObject({ pointer: '' });
    expect(body.violations?.at(-1)?.message).toMatch(/further violation\(s\) not listed$/);
    expect(body.state_changed).toBe('NONE');
    expect(body.retry_safe).toBe(false);
  });

  it('keeps the long pointer of a deep Expr whole when it fits the 1,024 characters, and cuts one that does not', async () => {
    const strategy = JSON.parse(fixture('s0/strategies/seed-1-rsi30-breakeven-off.json').toString('utf8')) as Doc;
    let expr: Record<string, unknown> = {
      op: 'operator:bar_field@1',
      args: [],
      params: { field: 'CLOSE' },
      bogus: true,
    };
    for (let level = 0; level < 55; level += 1) expr = { op: 'operator:sma@1', args: [expr], params: { window: 2 } };
    strategy.definition.indicators[0].expr = expr;
    const seed = JSON.parse(fixture('protocol/valid/command.register-seed.json').toString('utf8')) as Doc;
    seed.payload.draft = strategy;
    const route = served.find((entry) => entry.id === 'seeds.register') as RawRoute;
    const response = await send(route, JSON.stringify(seed));
    expect(response.status).toBe(400);
    const body = await errorOf(response);
    const longest = Math.max(...(body.violations ?? []).map((entry) => entry.pointer.length));
    expect(longest).toBeGreaterThan(256);
    expect(longest).toBeLessThanOrEqual(1024);
    // A key that makes the pointer longer than 1,024 characters is cut to 1,024, never rejected.
    const wide = JSON.parse(JSON.stringify(seed)) as Doc;
    let inner: Doc = wide.payload.draft.definition.indicators[0].expr;
    while (inner.args?.[0]) inner = inner.args[0];
    inner[`${'k'.repeat(250)}`] = 1;
    const wideResponse = await send(route, JSON.stringify(wide));
    expect(wideResponse.status).toBe(400);
    const wideBody = await errorOf(wideResponse);
    expect(wideBody.violations?.every((entry) => entry.pointer.length <= 1024 && entry.message.length <= 1000)).toBe(
      true,
    );
  });

  const malformed: [string, Uint8Array | string, string, number][] = [
    ['an empty body', '', 'SCHEMA_VIOLATION', 400],
    ['JSON that is not an object', '[]', 'SCHEMA_VIOLATION', 400],
    ['text that is not JSON', 'not json', 'SCHEMA_VIOLATION', 400],
    ['bytes that are not UTF-8', new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]), 'SCHEMA_VIOLATION', 400],
    ['a duplicate key', '{"schema_version":"command/1","schema_version":"command/1"}', 'SCHEMA_VIOLATION', 400],
    ['a number that is not an integer', '{"schema_version":"command/1","x":1.5}', 'SCHEMA_VIOLATION', 400],
    ['nesting of 200 levels', `${'['.repeat(200)}${']'.repeat(200)}`, 'SCHEMA_VIOLATION', 400],
    ['another version of the contract', '{"schema_version":"command/2"}', 'UNSUPPORTED_SCHEMA_VERSION', 400],
    ['no version', '{"form":"request"}', 'SCHEMA_VIOLATION', 400],
  ];
  for (const [label, body, code, status] of malformed) {
    it(`answers ${label} with ${code} and repeats none of it`, async () => {
      const response = await send(steward(), body);
      expect(response.status).toBe(status);
      const parsed = await errorOf(response);
      expect(parsed.code).toBe(code);
      const text = JSON.stringify(parsed);
      for (const piece of typeof body === 'string' ? [body, 'not json', 'command/2'] : []) {
        if (piece.length > 8) expect(text, piece).not.toContain(piece);
      }
      expect(parsed.diagnostic_ref).toMatch(/^diag-[0-9a-f]+$/);
    });
  }

  it('answers every schema-invalid fixture of a route with a code that the route lists, or with the limit', async () => {
    const entries = (
      JSON.parse(readFileSync(resolve(root, 'fixtures/protocol/manifest.json'), 'utf8')) as {
        entries: { path: string; contract: string; expect: string; code?: string }[];
      }
    ).entries;
    let checked = 0;
    for (const route of withBody.filter((entry) => entry.request.kind === 'contract')) {
      const allowed = new Set([...route.errors, ...manifest.common_errors]);
      const limit = route.max_body_bytes as number;
      for (const entry of entries.filter(
        (item) => item.contract === route.request.contract && item.expect === 'schema_invalid',
      )) {
        const bytes = fixture(entry.path);
        const response = await send(route, bytes);
        const body = await errorOf(response);
        const expected = bytes.length > limit ? 'LIMIT_EXCEEDED' : entry.code;
        expect(body.code, `${route.id} ${entry.path}`).toBe(expected);
        expect(allowed.has(body.code), `${route.id} lists ${body.code} for ${entry.path}`).toBe(true);
        expect(response.status).toBe(manifest.error_status[body.code]);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(40);
  });
});

describe('the form and the command kind of a route', () => {
  it('refuses a grant on the claim route, with the pointer of the field', async () => {
    const route = served.find((entry) => entry.id === 'attempts.claim') as RawRoute;
    const response = await send(route, fixture('protocol/valid/attempt-claim.grant.json'));
    expect(response.status).toBe(400);
    const body = await errorOf(response);
    expect(body.code).toBe('SCHEMA_VIOLATION');
    expect(body.violations).toEqual([{ pointer: '/form', message: 'The route accepts the claim form only.' }]);
  });

  it('refuses a status on a command route and a command of another kind than the route accepts', async () => {
    const route = served.find((entry) => entry.id === 'budgets.register') as RawRoute;
    const status = await send(route, fixture('protocol/valid/command.status-pending.json'));
    expect((await errorOf(status)).violations?.[0]?.pointer).toBe('/form');
    const other = await send(route, fixture('protocol/valid/command.cancel-mission.json'));
    expect(other.status).toBe(400);
    expect((await errorOf(other)).violations).toEqual([
      { pointer: '/payload/kind', message: 'The route accepts register_budget only.' },
    ]);
  });

  it('accepts the command that the route names, for every command route', async () => {
    for (const route of served.filter((entry) => entry.request.command_kind !== undefined)) {
      const response = await send(route, fixture(validFixture[route.id] as string));
      // The command is accepted by the route layer. What the command then does (it is applied, or refused for want of
      // the records that it names) is the business of the command tests.
      expect([202, 404, 409, 422], `${route.id}: ${response.status}`).toContain(response.status);
    }
  });
});

describe('routes that do not exist', () => {
  it('answers an unknown path, an unknown method and the runner endpoint with a 404 api-error', async () => {
    const tries: [string, string][] = [
      ['GET', '/nowhere'],
      ['GET', '/v1'],
      ['DELETE', '/v1/missions'],
      ['GET', '/v1/budgets'],
      ['POST', '/v1/agent-attempts'],
      ['GET', '/v1/auth/token'],
    ];
    for (const [method, path] of tries) {
      const response = await testApp.request(path, { method, headers: bearer(people.admin) });
      expect(response.status, `${method} ${path}`).toBe(404);
      expect((await errorOf(response)).code).toBe('NOT_FOUND');
    }
  });

  it('serves exactly the routes of the manifest that are on the API host, and /health', () => {
    const registered = testApp.app.routes
      .filter((entry) => entry.method !== 'ALL')
      .map((entry) => `${entry.method} ${entry.path}`)
      .sort();
    const expected = [
      ...served.map((route) => `${route.method} ${route.path.replace(/\{([a-z_]+)\}/g, ':$1')}`),
      'GET /health',
    ].sort();
    expect(registered).toEqual(expected);
    expect(registered).not.toContain('POST /v1/agent-attempts');
  });
});

describe('every served route has a handler', () => {
  it('registers a handler for each of the 29 routes of the API host, and for no other', () => {
    expect(Object.keys(handlers).sort()).toEqual(served.map((route) => route.id).sort());
    expect(served).toHaveLength(29);
  });

  it('answers no route with UNAVAILABLE: nothing is "not implemented" after part C', async () => {
    for (const route of served) {
      const response = await send(route, route.request.kind === 'none' ? undefined : '{}');
      expect(response.status, route.id).not.toBe(503);
    }
  });
});

describe('an unexpected error', () => {
  async function appWith(handler: Handler) {
    return createTestApp({
      registry: { ...handlers, 'system.identity': handler },
      database: testApp.database,
      signingKey: testApp.env.secrets.tokenSigningKey,
    });
  }

  it('is answered with INTERNAL and a diagnostic reference only, and the cause stays in the log under that reference', async () => {
    const secret = `oqk1.cred-000001.${'S'.repeat(43)}`;
    const broken = await appWith(async () => {
      throw new Error(`database said no for ${secret} at postgres://user@host/db`);
    });
    const response = await broken.request('/v1/system/identity', { headers: bearer(people.viewer) });
    expect(response.status).toBe(500);
    const text = await response.text();
    const body = JSON.parse(text) as { code: string; diagnostic_ref: string; state_changed: string; message: string };
    expect(body.code).toBe('INTERNAL');
    expect(body.state_changed).toBe('UNKNOWN');
    expect(text).not.toContain('database said no');
    expect(text).not.toContain(secret);
    const entry = broken.logs.find((line) => line.diagnostic_ref === body.diagnostic_ref);
    expect(entry).toBeDefined();
    expect(JSON.stringify(entry)).not.toContain(secret);
    expect(JSON.stringify(entry)).not.toContain('postgres://');
    expect(JSON.stringify(entry)).toContain('database said no');
  });

  it('passes an ApiFailure of a handler through with its own code and status', async () => {
    const refusing = await appWith(async () => {
      throw new ApiFailure('POLICY_VIOLATION', 'The budget is above the maxima.', { currentRevision: 7 });
    });
    const response = await refusing.request('/v1/system/identity', { headers: bearer(people.viewer) });
    expect(response.status).toBe(422);
    expect(await errorOf(response)).toMatchObject({
      code: 'POLICY_VIOLATION',
      message: 'The budget is above the maxima.',
    });
  });

  it('sets the cache and sniffing headers on a success, a failure and an unknown route', async () => {
    for (const response of [
      await testApp.request('/v1/system/identity', { headers: bearer(people.viewer) }),
      await testApp.request('/v1/system/identity'),
      await testApp.request('/nowhere'),
      await testApp.request('/health'),
    ]) {
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    }
  });

  it('gives every error response its own diagnostic reference, in the body and nowhere else secret', async () => {
    const first = await errorOf(await testApp.request('/nowhere'));
    const second = await errorOf(await testApp.request('/nowhere'));
    expect(first.diagnostic_ref).not.toBe(second.diagnostic_ref);
  });
});

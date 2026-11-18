// The Fly termination probe (src/fly-probe.ts) against a fake Machines API: a loopback HTTP server that answers
// GET /v1/apps/{app}/machines/{id} as the test says. It confirms a termination only for a Machine that is stopped or
// destroyed, and confirms nothing for a running Machine, an unknown state, another Machine, an error status, a
// redirect, a body that is not JSON, a dropped connection or a timeout. The real Machines API is not called.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { WorkerBindings } from '../src/env.ts';
import { createFlyTerminationProbe, FLY_MACHINES_API, flyMachineOf } from '../src/fly-probe.ts';
import { type FencedAttempt, unwiredProbe } from '../src/recovery.ts';
import { terminationProbeOf } from '../src/worker.ts';

type Handler = (request: IncomingMessage, response: ServerResponse) => void;

let handler: Handler = (_request, response) => response.end();
const seen: { method: string; url: string; authorization: string | undefined }[] = [];
let server: Server;
let baseUrl: string;

beforeAll(async () => {
  server = createServer((request, response) => {
    seen.push({ method: request.method ?? '', url: request.url ?? '', authorization: request.headers.authorization });
    handler(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const MACHINE = '148e272b0a1d2c';
const TOKEN = 'fly-read-token-for-the-test';

function fenced(overrides: Partial<FencedAttempt> = {}): FencedAttempt {
  return {
    attemptId: 'att-1',
    status: 'LEASE_EXPIRED',
    destination: 'BATCH_QUEUE',
    leaseExpiresAt: new Date('2026-11-18T10:00:00Z'),
    workerId: `fly:${MACHINE}:engine-batch-7-0`,
    ...overrides,
  };
}

function probe(timeoutMs = 2_000, log: (entry: unknown) => void = () => undefined) {
  return createFlyTerminationProbe({
    token: TOKEN,
    apps: { BATCH_QUEUE: 'openquant-staging-engine-batch', AGENT_RUNNER: 'openquant-staging-agent-runner' },
    baseUrl,
    timeoutMs,
    log,
  });
}

/** Answer every request with this status and JSON body. */
function answer(status: number, body: unknown): void {
  handler = (_request, response) => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
  };
}

const now = new Date('2026-11-18T10:05:00Z');

describe('the Fly termination probe', () => {
  it('confirms a Machine that is stopped or destroyed, asking the app of the destination with the read token', async () => {
    for (const state of ['stopped', 'destroyed']) {
      answer(200, { id: MACHINE, state, region: 'iad' });
      seen.length = 0;
      expect(await probe().check(fenced(), now)).toEqual({ terminated: true });
      expect(seen).toEqual([
        {
          method: 'GET',
          url: `/v1/apps/openquant-staging-engine-batch/machines/${MACHINE}`,
          authorization: `Bearer ${TOKEN}`,
        },
      ]);
    }
    // An agent attempt asks the runner's app; a cancelled-while-claimed attempt is asked about the same way.
    answer(200, { id: MACHINE, state: 'stopped' });
    seen.length = 0;
    const agent = fenced({
      destination: 'AGENT_RUNNER',
      status: 'CANCELLED',
      workerId: `fly:${MACHINE}:agent-runner-9`,
    });
    expect(await probe().check(agent, now)).toEqual({ terminated: true });
    expect(seen[0]?.url).toBe(`/v1/apps/openquant-staging-agent-runner/machines/${MACHINE}`);
  });

  it('confirms nothing for a Machine that runs or is in any other or unknown state', async () => {
    for (const state of [
      'started',
      'starting',
      'stopping',
      'created',
      'replacing',
      'suspended',
      'destroying',
      'Stopped',
    ]) {
      answer(200, { id: MACHINE, state });
      expect(await probe().check(fenced(), now), state).toEqual({ terminated: false });
    }
    for (const body of [{ id: MACHINE }, { id: MACHINE, state: 7 }, null, ['stopped'], 'stopped']) {
      answer(200, body);
      expect(await probe().check(fenced(), now), JSON.stringify(body)).toEqual({ terminated: false });
    }
  });

  it('confirms nothing when the answer is about another Machine', async () => {
    answer(200, { id: 'ffffffffffffff', state: 'stopped' });
    expect(await probe().check(fenced(), now)).toEqual({ terminated: false });
  });

  it('confirms nothing on an error status, a redirect, a body that is not JSON or a dropped connection', async () => {
    for (const status of [201, 301, 302, 401, 403, 404, 429, 500, 503]) {
      handler = (_request, response) => {
        response.writeHead(status, { 'content-type': 'application/json', location: 'https://elsewhere.invalid/' });
        response.end(JSON.stringify({ id: MACHINE, state: 'stopped' }));
      };
      expect(await probe().check(fenced(), now), String(status)).toEqual({ terminated: false });
    }
    handler = (_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"id": "148e272b0a1d2c", "state": "stopp');
    };
    expect(await probe().check(fenced(), now)).toEqual({ terminated: false });
    handler = (request) => request.socket.destroy();
    expect(await probe().check(fenced(), now)).toEqual({ terminated: false });
  });

  it('confirms nothing when the API does not answer in time, or stops half way through the body', async () => {
    handler = () => undefined;
    const logs: unknown[] = [];
    const started = Date.now();
    expect(await probe(150, (entry) => logs.push(entry)).check(fenced(), now)).toEqual({ terminated: false });
    expect(Date.now() - started).toBeLessThan(1_500);
    expect(JSON.stringify(logs)).toContain('"reason":"timeout"');
    handler = (_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.write('{"id": "148e272b0a1d2c", ');
    };
    expect(await probe(150).check(fenced(), now)).toEqual({ terminated: false });
    // A fetch that ignores the abort signal still times out.
    const stuck = createFlyTerminationProbe({
      token: TOKEN,
      apps: { BATCH_QUEUE: 'openquant-staging-engine-batch', AGENT_RUNNER: 'openquant-staging-agent-runner' },
      timeoutMs: 50,
      fetch: () => new Promise<Response>(() => undefined),
    });
    expect(await stuck.check(fenced(), now)).toEqual({ terminated: false });
  });

  it('asks nothing for a worker that did not name a Fly Machine, and never logs the token', async () => {
    answer(200, { id: MACHINE, state: 'stopped' });
    const logs: unknown[] = [];
    for (const workerId of [
      null,
      'worker-1',
      `engine-batch-${MACHINE}-0`,
      `fly:${MACHINE}`,
      `fly:../x:y`,
      'fly:ABC:y',
    ]) {
      seen.length = 0;
      expect(await probe(2_000, (entry) => logs.push(entry)).check(fenced({ workerId }), now)).toEqual({
        terminated: false,
      });
      expect(seen, String(workerId)).toEqual([]);
    }
    expect(JSON.stringify(logs)).toContain('worker_not_on_fly');
    expect(JSON.stringify(logs)).not.toContain(TOKEN);
  });

  it('reads the Machine ID from the worker name that the hosts build from FLY_MACHINE_ID', () => {
    expect(flyMachineOf(`fly:${MACHINE}:engine-batch-12-1`)).toBe(MACHINE);
    expect(flyMachineOf(`fly:${MACHINE}:agent-runner-3`)).toBe(MACHINE);
    expect(flyMachineOf('worker-1')).toBeUndefined();
    expect(flyMachineOf(undefined)).toBeUndefined();
  });
});

describe('the probe of the Worker', () => {
  const configured = {
    FLY_MACHINES_READ_TOKEN: TOKEN,
    FLY_ENGINE_BATCH_APP: 'openquant-staging-engine-batch',
    FLY_AGENT_RUNNER_APP: 'openquant-staging-agent-runner',
  };
  const bindingsOf = (values: Record<string, string>) => values as unknown as WorkerBindings;

  it('is the probe that confirms nothing until the token and both apps are set', () => {
    const logs: unknown[] = [];
    const log = (entry: unknown) => void logs.push(entry);
    expect(terminationProbeOf(bindingsOf({}), log)).toBe(unwiredProbe);
    expect(logs).toEqual([]);
    for (const name of Object.keys(configured)) {
      const partial: Record<string, string> = { ...configured, [name]: '' };
      expect(terminationProbeOf(bindingsOf(partial), log), name).toBe(unwiredProbe);
    }
    expect(terminationProbeOf(bindingsOf({ ...configured, FLY_ENGINE_BATCH_APP: 'Not/An/App' }), log)).toBe(
      unwiredProbe,
    );
    expect(JSON.stringify(logs)).toContain('the termination probe is not configured');
    expect(JSON.stringify(logs)).not.toContain(TOKEN);
  });

  it('asks the public Machines API when it is configured', async () => {
    const calls: { url: string; authorization: string | null }[] = [];
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      calls.push({ url: String(input), authorization: new Headers(init?.headers).get('authorization') });
      return new Response(JSON.stringify({ id: MACHINE, state: 'destroyed' }), { status: 200 });
    });
    try {
      const wired = terminationProbeOf(bindingsOf(configured), () => undefined);
      expect(wired).not.toBe(unwiredProbe);
      expect(await wired.check(fenced(), now)).toEqual({ terminated: true });
      expect(calls).toEqual([
        {
          url: `${FLY_MACHINES_API}/v1/apps/openquant-staging-engine-batch/machines/${MACHINE}`,
          authorization: `Bearer ${TOKEN}`,
        },
      ]);
    } finally {
      spy.mockRestore();
    }
  });
});

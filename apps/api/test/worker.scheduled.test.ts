// The cron trigger of the Worker (wrangler.jsonc, `triggers.crons`): one recovery pass with the queue producer and the
// runner of its bindings. The bindings are fakes: a Queue producer, a bucket that serves the test's object store, and a
// stub of `fetch` for the runner. The Worker reads the real clock, so the leases of this test (granted at the test
// clock, hours in the past) have ended when the pass runs. The runtime itself (workerd, Queues, Hyperdrive) is not
// covered: P6's deployment probe is the first run there.

import { randomBytes } from 'node:crypto';
import type { Sha256Digest } from '@openquant/api-contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { toBase64Url } from '../src/auth/encoding.ts';
import type { WorkerBindings } from '../src/env.ts';
import worker, { dispatchersOf } from '../src/worker.ts';
import { claim, claimRequest, type Flow, outboxOf, type Started, startAgent, startedFlow } from './support/flow.ts';

const flows: (Flow & Started)[] = [];
async function fresh(): Promise<Flow & Started> {
  const flow = await startedFlow();
  flows.push(flow);
  return flow;
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const flow of flows.splice(0)) await flow.world.drop();
});

/** An R2 bucket over the test's in-memory object store: the key `sha256/<hex>` is the digest `sha256:<hex>`. */
function bucketOver(flow: Flow & Started): R2Bucket {
  const { objects } = flow.world.testApp;
  const digestOf = (key: string): Sha256Digest => `sha256:${key.slice('sha256/'.length)}` as Sha256Digest;
  return {
    async head(key: string) {
      const stored = await objects.head(digestOf(key));
      return stored === null ? null : { size: stored.size };
    },
    async get(key: string) {
      const bytes = await objects.get(digestOf(key));
      return bytes === null ? null : { arrayBuffer: async () => bytes.slice().buffer };
    },
    async put(key: string, bytes: Uint8Array) {
      await objects.put(digestOf(key), bytes);
    },
  } as unknown as R2Bucket;
}

function bindings(flow: Flow & Started, overrides: Record<string, unknown> = {}): WorkerBindings {
  return {
    HYPERDRIVE: { connectionString: flow.world.testApp.database.url },
    ARTEFACTS: bucketOver(flow),
    TOKEN_SIGNING_KEY: toBase64Url(new Uint8Array(randomBytes(32))),
    OPENQUANT_ENVIRONMENT: 'DEVELOPMENT',
    OPENQUANT_RESEARCH_EXECUTION: 'enabled',
    ...overrides,
  } as unknown as WorkerBindings;
}

function context() {
  const work: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (promise: Promise<unknown>) => {
      work.push(promise);
    },
    passThroughOnException: () => undefined,
  } as unknown as ExecutionContext;
  return { work, ctx };
}

const controller = { cron: '* * * * *', scheduledTime: Date.now(), noRetry: () => undefined } as ScheduledController;

async function runScheduled(flow: Flow & Started, overrides: Record<string, unknown> = {}) {
  const { ctx, work } = context();
  worker.scheduled?.(controller, bindings(flow, overrides), ctx);
  expect(work).toHaveLength(1);
  await Promise.all(work);
}

const outboxStatus = (flow: Flow, attemptId: string) =>
  flow.world.sql<{ status: string }>('SELECT status FROM outbox WHERE attempt_id = $1', [attemptId]);

describe('the scheduled handler', () => {
  it('sends the pending job-dispatch/1 to the queue producer as JSON, and marks the entry SENT', async () => {
    const flow = await fresh();
    const send = vi.fn(async () => undefined);
    await runScheduled(flow, { BATCH_QUEUE: { send } });

    const stored = await outboxOf(flow, flow.retrieve.attemptId);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(stored.message, { contentType: 'json' });
    expect(await outboxStatus(flow, flow.retrieve.attemptId)).toEqual([{ status: 'SENT' }]);
  });

  it('fences an attempt whose lease ended, writes the retry through the bucket and sends it', async () => {
    const flow = await fresh();
    const send = vi.fn(async () => undefined);
    const claimed = await claim(flow, flow.retrieve.attemptId);
    // The test clock granted this lease at 10:00; the Worker's clock is the real one, hours later.
    expect(Date.parse(claimed.leaseExpiresAt)).toBeLessThan(Date.now());
    await runScheduled(flow, { BATCH_QUEUE: { send } });

    const attempts = await flow.world.sql<{ attempt_id: string; ownership_revision: number; status: string }>(
      'SELECT attempt_id, ownership_revision, status FROM attempts WHERE job_id = $1 ORDER BY ownership_revision',
      [flow.retrieve.jobId],
    );
    expect(attempts).toMatchObject([
      { ownership_revision: 1, status: 'LEASE_EXPIRED' },
      { ownership_revision: 2, status: 'PENDING' },
    ]);
    const retry = attempts[1]?.attempt_id as string;
    const stored = await outboxOf(flow, retry);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(stored.message, { contentType: 'json' });
    // The request document of the retry reached the store through the bucket binding.
    const inputs = stored.message.inputs as { request: { digest: string } };
    expect(await flow.world.testApp.objects.head(inputs.request.digest as Sha256Digest)).not.toBeNull();
    expect(await outboxStatus(flow, retry)).toEqual([{ status: 'SENT' }]);
  });

  it('sends an agent-dispatch/1 to the runner over HTTPS with the credential of its binding, when both are set', async () => {
    const flow = await fresh();
    const agent = await startAgent(flow, { role: 'CRITIC' });
    const fetched: Request[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      fetched.push(input as Request);
      return new Response(null, { status: 202 });
    });
    await runScheduled(flow, {
      AGENT_RUNNER_URL: 'https://runner.example.test',
      AGENT_RUNNER_CREDENTIAL: 'oqk1.id.secret',
    });

    expect(fetched).toHaveLength(1);
    expect(fetched[0]?.url).toBe('https://runner.example.test/v1/agent-attempts');
    expect(fetched[0]?.headers.get('authorization')).toBe('Bearer oqk1.id.secret');
    expect(JSON.parse(await (fetched[0] as Request).text())).toEqual((await outboxOf(flow, agent.attemptId)).message);
    expect(await outboxStatus(flow, agent.attemptId)).toEqual([{ status: 'SENT' }]);
    // The batch entry has no producer binding in this run: it is left PENDING for a pass that has one.
    expect(await outboxStatus(flow, flow.retrieve.attemptId)).toEqual([{ status: 'PENDING' }]);
  });

  it('leaves an entry PENDING when its destination is unreachable, and sends nothing while execution is disabled', async () => {
    const flow = await fresh();
    const failing = vi.fn(async () => {
      throw new Error('The queue is unavailable.');
    });
    await runScheduled(flow, { BATCH_QUEUE: { send: failing } });
    expect(failing).toHaveBeenCalledTimes(1);
    expect(await outboxStatus(flow, flow.retrieve.attemptId)).toEqual([{ status: 'PENDING' }]);

    const quiet = vi.fn(async () => undefined);
    await runScheduled(flow, { BATCH_QUEUE: { send: quiet }, OPENQUANT_RESEARCH_EXECUTION: 'disabled' });
    expect(quiet).not.toHaveBeenCalled();
    expect(await outboxStatus(flow, flow.retrieve.attemptId)).toEqual([{ status: 'PENDING' }]);
  });

  it('asks Fly about the Machine that the claim named, and confirms the termination only once it has stopped', async () => {
    const flow = await fresh();
    const machine = '148e272b0a1d2c';
    // The batch host claims as it does on a Fly Machine: its worker name carries FLY_MACHINE_ID.
    const outbox = await outboxOf(flow, flow.retrieve.attemptId);
    const response = await flow.send('POST', `/v1/attempts/${flow.retrieve.attemptId}/claim`, flow.service('batch'), {
      ...claimRequest(flow.retrieve.attemptId, outbox.revision, outbox.digest),
      worker_id: `fly:${machine}:engine-batch-7-0`,
    });
    expect(response.status).toBe(200);
    let state = 'started';
    const asked: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      asked.push(String(input));
      return new Response(JSON.stringify({ id: machine, state }), { status: 200 });
    });
    const fly = {
      FLY_MACHINES_READ_TOKEN: 'fly-read-token-for-the-test',
      FLY_ENGINE_BATCH_APP: 'openquant-staging-engine-batch',
      FLY_AGENT_RUNNER_APP: 'openquant-staging-agent-runner',
    };
    const reservation = () =>
      flow.world.sql<{ status: string }>('SELECT status FROM reservations WHERE attempt_id = $1', [
        flow.retrieve.attemptId,
      ]);

    // The lease has ended and the Machine still runs: fenced, the reservation held.
    await runScheduled(flow, fly);
    expect(asked).toEqual([`https://api.machines.dev/v1/apps/openquant-staging-engine-batch/machines/${machine}`]);
    expect(await reservation()).toEqual([{ status: 'RESERVED' }]);
    // Without the probe's configuration nothing is asked and nothing is confirmed, even once the Machine stopped.
    state = 'stopped';
    await runScheduled(flow);
    expect(asked).toHaveLength(1);
    expect(await reservation()).toEqual([{ status: 'RESERVED' }]);
    // Configured, the stopped Machine confirms it: no usage report, so the full amount counts as spent.
    await runScheduled(flow, fly);
    expect(asked).toHaveLength(2);
    expect(await reservation()).toEqual([{ status: 'UNRECONCILED' }]);
  });

  it('refuses an http runner URL and says so, without the credential, and still serves the queue', async () => {
    const flow = await fresh();
    const logs: unknown[] = [];
    const entries = (entry: unknown) => void logs.push(entry);
    const dispatchers = dispatchersOf(
      bindings(flow, {
        AGENT_RUNNER_URL: 'http://runner.example.test',
        AGENT_RUNNER_CREDENTIAL: 'oqk1.id.secret',
        BATCH_QUEUE: { send: async () => undefined },
      }),
      entries as never,
    );
    expect(dispatchers.runner).toBeUndefined();
    expect(dispatchers.batch).toBeDefined();
    expect(JSON.stringify(logs)).toContain('not an https URL');
    expect(JSON.stringify(logs)).not.toContain('oqk1');
    // Without either runner binding there is no runner, and no log.
    const none = dispatchersOf(bindings(flow), entries as never);
    expect(none).toEqual({ batch: undefined, runner: undefined });
  });
});

// The dispatch outbox (OQ-05 section 4, "Outbox PENDING: Dispatcher send") and the call to the agent runner. The queue and
// the runner are fakes: the Worker supplies the Cloudflare Queue producer and an authenticated HTTPS call. What a test
// expects is derived here from the rows that the system wrote, not from the code under test.

import { afterEach, describe, expect, it } from 'vitest';
import type { ApiEnv } from '../src/env.ts';
import {
  type AgentRunnerClient,
  type BatchQueue,
  createAgentRunnerClient,
  type Dispatchers,
  dispatchPending,
} from '../src/outbox.ts';
import { claim, type Flow, outboxOf, type Started, startAgent, startedFlow } from './support/flow.ts';

const flows: (Flow & Started)[] = [];
async function fresh(options: Parameters<typeof startedFlow>[0] = {}): Promise<Flow & Started> {
  const flow = await startedFlow(options);
  flows.push(flow);
  return flow;
}
afterEach(async () => {
  for (const flow of flows.splice(0)) await flow.world.drop();
});

function fakes(options: { failQueue?: number; failRunner?: boolean } = {}) {
  const sent = { batch: [] as unknown[], runner: [] as unknown[] };
  let queueFailures = options.failQueue ?? 0;
  const batch: BatchQueue = {
    async send(message) {
      if (queueFailures > 0) {
        queueFailures -= 1;
        throw new Error('The queue is unavailable.');
      }
      sent.batch.push(message);
    },
  };
  const runner: AgentRunnerClient = {
    async dispatch(message) {
      if (options.failRunner === true) throw new Error('The runner is unavailable.');
      sent.runner.push(message);
    },
  };
  const dispatchers: Dispatchers = { batch, runner };
  return { sent, dispatchers };
}

async function pass(flow: Flow & Started, dispatchers: Dispatchers, limit?: number, override: Partial<ApiEnv> = {}) {
  const env: ApiEnv = { ...flow.world.testApp.env, ...override };
  const db = env.database();
  try {
    return await dispatchPending(env, db, dispatchers, limit);
  } finally {
    await db.close();
  }
}

const statusOf = (flow: Flow, attemptId: string) =>
  flow.world.sql<{ status: string; sent: boolean }>(
    'SELECT status, sent_at IS NOT NULL AS sent FROM outbox WHERE attempt_id = $1',
    [attemptId],
  );

describe('the dispatcher', () => {
  it('sends the message that the transaction stored, byte for byte, and marks the entry SENT once', async () => {
    const flow = await fresh();
    const { sent, dispatchers } = fakes();
    const stored = await outboxOf(flow, flow.retrieve.attemptId);
    expect(await statusOf(flow, flow.retrieve.attemptId)).toEqual([{ status: 'PENDING', sent: false }]);

    expect(await pass(flow, dispatchers)).toEqual({ sent: 1, failed: 0, delivered: 0, skipped: 0 });
    expect(sent.batch).toEqual([stored.message]);
    expect(sent.runner).toEqual([]);
    // The message names its attempt and its ownership revision: a redelivery cannot authorise another attempt.
    expect((sent.batch[0] as { attempt: unknown }).attempt).toEqual({
      attempt_id: flow.retrieve.attemptId,
      ownership_revision: 1,
    });
    expect(await statusOf(flow, flow.retrieve.attemptId)).toEqual([{ status: 'SENT', sent: true }]);

    // A second pass finds nothing pending.
    expect(await pass(flow, dispatchers)).toEqual({ sent: 0, failed: 0, delivered: 0, skipped: 0 });
    expect(sent.batch).toHaveLength(1);
  });

  it('leaves a failed send PENDING and sends the same message again under the same attempt on the next pass', async () => {
    const flow = await fresh();
    const down = fakes({ failQueue: 1 });
    const stored = await outboxOf(flow, flow.retrieve.attemptId);

    expect(await pass(flow, down.dispatchers)).toEqual({ sent: 0, failed: 1, delivered: 0, skipped: 0 });
    expect(down.sent.batch).toEqual([]);
    expect(await statusOf(flow, flow.retrieve.attemptId)).toEqual([{ status: 'PENDING', sent: false }]);
    // The failure is logged with the attempt, never with the message.
    const warning = flow.world.testApp.logs.find((entry) => entry.message.startsWith('outbox send failed'));
    expect(warning).toMatchObject({ level: 'warn', attempt_id: flow.retrieve.attemptId, destination: 'BATCH_QUEUE' });
    expect(JSON.stringify(warning)).not.toContain('The queue is unavailable');

    expect(await pass(flow, down.dispatchers)).toEqual({ sent: 1, failed: 0, delivered: 0, skipped: 0 });
    expect(down.sent.batch).toEqual([stored.message]);
    expect(await statusOf(flow, flow.retrieve.attemptId)).toEqual([{ status: 'SENT', sent: true }]);
  });

  it('routes a batch message to the queue and an agent message to the runner, and marks both SENT', async () => {
    const flow = await fresh();
    const agent = await startAgent(flow, { role: 'CRITIC' });
    const { sent, dispatchers } = fakes();

    expect(await pass(flow, dispatchers)).toEqual({ sent: 2, failed: 0, delivered: 0, skipped: 0 });
    expect(sent.batch).toEqual([(await outboxOf(flow, flow.retrieve.attemptId)).message]);
    expect(sent.runner).toEqual([(await outboxOf(flow, agent.attemptId)).message]);
    expect((sent.runner[0] as { schema_version: string }).schema_version).toBe('agent-dispatch/1');
    expect(await statusOf(flow, agent.attemptId)).toEqual([{ status: 'SENT', sent: true }]);
  });

  it('does not let a failing destination stop the other: the runner is down, the queue is served', async () => {
    const flow = await fresh();
    const agent = await startAgent(flow, { role: 'CRITIC' });
    const { sent, dispatchers } = fakes({ failRunner: true });

    expect(await pass(flow, dispatchers)).toEqual({ sent: 1, failed: 1, delivered: 0, skipped: 0 });
    expect(sent.batch).toHaveLength(1);
    expect(await statusOf(flow, flow.retrieve.attemptId)).toEqual([{ status: 'SENT', sent: true }]);
    expect(await statusOf(flow, agent.attemptId)).toEqual([{ status: 'PENDING', sent: false }]);
  });

  it('sends the oldest entries first and no more than the limit of a pass', async () => {
    const flow = await fresh();
    const second = await startAgent(flow, { role: 'CRITIC' });
    flow.world.testApp.clock.advanceSeconds(5);
    const third = await startAgent(flow, { role: 'CRITIC' });
    const { sent, dispatchers } = fakes();

    expect(await pass(flow, dispatchers, 2)).toEqual({ sent: 2, failed: 0, delivered: 0, skipped: 0 });
    expect(sent.batch).toHaveLength(1);
    expect(sent.runner).toHaveLength(1);
    // The retrieval and the first agent entry were written first: the third waits for the next pass.
    expect(await statusOf(flow, second.attemptId)).toEqual([{ status: 'SENT', sent: true }]);
    expect(await statusOf(flow, third.attemptId)).toEqual([{ status: 'PENDING', sent: false }]);
    expect(await pass(flow, dispatchers, 2)).toEqual({ sent: 1, failed: 0, delivered: 0, skipped: 0 });
  });

  it('marks an entry delivered, without sending, when the worker claimed its attempt before the dispatcher marked it', async () => {
    const flow = await fresh();
    // The worker holds the message already (a send whose mark was lost), and claims.
    await claim(flow, flow.retrieve.attemptId);
    expect(await statusOf(flow, flow.retrieve.attemptId)).toEqual([{ status: 'PENDING', sent: false }]);
    const { sent, dispatchers } = fakes();

    expect(await pass(flow, dispatchers)).toEqual({ sent: 0, failed: 0, delivered: 1, skipped: 0 });
    expect(sent.batch).toEqual([]);
    expect(await statusOf(flow, flow.retrieve.attemptId)).toEqual([{ status: 'SENT', sent: true }]);
  });

  it('never sends the entry of a cancelled attempt: cancel_mission made it CANCELLED', async () => {
    const flow = await fresh();
    const [mission] = await flow.world.sql<{ revision: number }>(
      'SELECT revision FROM missions WHERE mission_id = $1',
      [flow.missionId],
    );
    const cancelled = await flow.world.apply(
      'researcher',
      { kind: 'cancel_mission', mission_id: flow.missionId, reason: 'Stop.' },
      { expectedRevision: mission?.revision as number },
    );
    expect(cancelled.state).toBe('APPLIED');
    const { sent, dispatchers } = fakes();

    expect(await pass(flow, dispatchers)).toEqual({ sent: 0, failed: 0, delivered: 0, skipped: 0 });
    expect(sent.batch).toEqual([]);
    expect(await flow.world.sql('SELECT status FROM outbox WHERE attempt_id = $1', [flow.retrieve.attemptId])).toEqual([
      { status: 'CANCELLED' },
    ]);
  });

  it('sends nothing while research execution is off, and nothing to a destination that has no dispatcher', async () => {
    const off = await fresh();
    const first = fakes();
    expect(await pass(off, first.dispatchers, undefined, { researchExecution: false })).toEqual({
      sent: 0,
      failed: 0,
      delivered: 0,
      skipped: 1,
    });
    expect(first.sent.batch).toEqual([]);
    expect(await statusOf(off, off.retrieve.attemptId)).toEqual([{ status: 'PENDING', sent: false }]);

    const on = await fresh();
    const none = fakes();
    expect(await pass(on, { runner: none.dispatchers.runner })).toEqual({
      sent: 0,
      failed: 0,
      delivered: 0,
      skipped: 1,
    });
    expect(await statusOf(on, on.retrieve.attemptId)).toEqual([{ status: 'PENDING', sent: false }]);
  });
});

describe('the call to the agent runner', () => {
  const message = { schema_version: 'agent-dispatch/1', note: 'a message' };

  function recordingFetch(status: number) {
    const requests: Request[] = [];
    return {
      requests,
      fetcher: async (request: Request) => {
        requests.push(request);
        return new Response(null, { status });
      },
    };
  }

  it('posts the message to /v1/agent-attempts with the credential of the workflows principal, and follows no redirect', async () => {
    const fetched = recordingFetch(202);
    const client = createAgentRunnerClient('https://runner.example.test/base', 'oqk1.id.secret', fetched.fetcher);
    await client.dispatch(message);
    const [request] = fetched.requests;
    expect(fetched.requests).toHaveLength(1);
    expect(request?.method).toBe('POST');
    expect(request?.url).toBe('https://runner.example.test/v1/agent-attempts');
    expect(request?.redirect).toBe('manual');
    expect(request?.headers.get('authorization')).toBe('Bearer oqk1.id.secret');
    expect(request?.headers.get('content-type')).toBe('application/json');
    expect(JSON.parse(await (request as Request).text())).toEqual(message);
  });

  it('accepts any 2xx answer and refuses the rest, a redirect included, without repeating the credential', async () => {
    for (const status of [200, 202, 204]) {
      await expect(
        createAgentRunnerClient(
          'https://runner.example.test',
          'oqk1.id.secret',
          recordingFetch(status).fetcher,
        ).dispatch(message),
      ).resolves.toBeUndefined();
    }
    for (const status of [301, 302, 401, 409, 500, 503]) {
      const error = await createAgentRunnerClient(
        'https://runner.example.test',
        'oqk1.id.secret',
        recordingFetch(status).fetcher,
      )
        .dispatch(message)
        .then(
          () => undefined,
          (rejected: unknown) => rejected as Error,
        );
      expect(error?.message, String(status)).toContain(String(status));
      expect(error?.message, String(status)).not.toContain('oqk1');
    }
  });

  it('is built for an https URL only, and a network failure rejects so that the entry stays PENDING', async () => {
    expect(() => createAgentRunnerClient('http://runner.example.test', 'oqk1.id.secret')).toThrow(/HTTPS only/);
    expect(() => createAgentRunnerClient('not a url', 'oqk1.id.secret')).toThrow();
    const client = createAgentRunnerClient('https://runner.example.test', 'oqk1.id.secret', async () => {
      throw new TypeError('network down');
    });
    await expect(client.dispatch(message)).rejects.toThrow('network down');
  });
});

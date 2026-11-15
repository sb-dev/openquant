// Scheduled recovery (OQ-05 section 4: "Recovery finds missing dispatches and expired attempts even when no client is
// connected"; OQ-03 section 1: lease expiry releases nothing until termination is confirmed; A11). Every test moves the
// clock past a lease, runs one pass and reads the rows. The queue and the runner are fakes, and so is the probe that says
// whether a host stopped. Expected amounts are derived from the pilot policy: a retrieval attempt reserves the retrieve
// timeout of 600 seconds and 20 provider requests (60 requests over the attempt cap of 3).

import { afterEach, describe, expect, it } from 'vitest';
import type { Database } from '../src/db/database.ts';
import type { ApiEnv } from '../src/env.ts';
import type { Dispatchers } from '../src/outbox.ts';
import { deadlineProbe, runRecovery, TERMINATION_GRACE_SECONDS, type TerminationProbe } from '../src/recovery.ts';
import {
  AGENT_RUNNER,
  type Claimed,
  claim,
  driveRetrieval,
  ENGINE_BATCH,
  errorCode,
  type Flow,
  outboxOf,
  type Started,
  startAgent,
  startedFlow,
  startValidationOf,
  submit,
} from './support/flow.ts';
import { ids } from './support/seed.ts';

const flows: (Flow & Started)[] = [];
async function fresh(): Promise<Flow & Started> {
  const flow = await startedFlow();
  flows.push(flow);
  return flow;
}
afterEach(async () => {
  for (const flow of flows.splice(0)) await flow.world.drop();
});

function queue() {
  const sent = { batch: [] as unknown[], runner: [] as unknown[] };
  const dispatchers: Dispatchers = {
    batch: {
      async send(message) {
        sent.batch.push(message);
      },
    },
    runner: {
      async dispatch(message) {
        sent.runner.push(message);
      },
    },
  };
  return { sent, dispatchers };
}

/** A host that never confirms: the reservations of fenced attempts stay as they are. */
const never: TerminationProbe = { check: async () => ({ terminated: false }) };

async function recover(
  flow: Flow & Started,
  deps: { dispatchers: Dispatchers; probe?: TerminationProbe; limit?: number },
  wrap: (db: Database) => Database = (db) => db,
) {
  const env: ApiEnv = flow.world.testApp.env;
  const db = env.database();
  try {
    return await runRecovery(env, wrap(db), deps);
  } finally {
    await db.close();
  }
}

const afterLease = (flow: Flow, claimed: Pick<Claimed, 'leaseExpiresAt'>, plusSeconds = 1) =>
  flow.world.testApp.clock.set(new Date(Date.parse(claimed.leaseExpiresAt) + plusSeconds * 1000));

const attemptsOf = (flow: Flow & Started) =>
  flow.world.sql<{ attempt_id: string; ownership_revision: number; status: string }>(
    'SELECT attempt_id, ownership_revision, status FROM attempts WHERE job_id = $1 ORDER BY ownership_revision',
    [flow.retrieve.jobId],
  );
const latest = async (flow: Flow & Started) => (await attemptsOf(flow)).at(-1)?.attempt_id as string;

const reservationsOf = (flow: Flow & Started) =>
  flow.world.sql<{ ownership_revision: number; status: string }>(
    `SELECT a.ownership_revision, r.status FROM reservations r JOIN attempts a ON a.attempt_id = r.attempt_id
      WHERE a.job_id = $1 ORDER BY a.ownership_revision`,
    [flow.retrieve.jobId],
  );

async function committed(flow: Flow & Started, dimension: string): Promise<string> {
  const [pool] = await flow.world.sql<{ committed: string }>(
    `SELECT committed::text AS committed FROM budget_pools WHERE scope = 'MISSION' AND mission_id = $1 AND dimension = $2 AND configuration_id IS NULL`,
    [flow.missionId, dimension],
  );
  return pool?.committed as string;
}

const zero = { sent: 0, failed: 0, delivered: 0, skipped: 0 };

describe('a worker that died', () => {
  it('has its attempt fenced, a retry written with its own reservation and outbox entry, and the retry dispatched', async () => {
    const flow = await fresh();
    const { sent, dispatchers } = queue();
    // A first pass sends what the transaction wrote: nothing is expired, nothing is lost.
    expect(await recover(flow, { dispatchers, probe: never })).toEqual({
      leasesExpired: 0,
      retried: 0,
      failed: 0,
      waiting: 0,
      terminationsConfirmed: 0,
      reconciled: 0,
      dispatch: { ...zero, sent: 1 },
      errors: 0,
    });
    const first = await claim(flow, flow.retrieve.attemptId);
    expect(await committed(flow, 'BATCH_COMPUTE_SECONDS')).toBe('600.00000000');
    expect(await committed(flow, 'PROVIDER_REQUESTS')).toBe('20.00000000');

    // The lease is still held one second before it ends: recovery leaves the attempt alone.
    afterLease(flow, first, -1);
    expect((await recover(flow, { dispatchers, probe: never })).leasesExpired).toBe(0);
    afterLease(flow, first, 1);
    const summary = await recover(flow, { dispatchers, probe: never });
    expect(summary).toEqual({
      leasesExpired: 1,
      retried: 1,
      failed: 0,
      waiting: 0,
      terminationsConfirmed: 0,
      reconciled: 0,
      dispatch: { ...zero, sent: 1 },
      errors: 0,
    });

    expect(await attemptsOf(flow)).toMatchObject([
      { ownership_revision: 1, status: 'LEASE_EXPIRED' },
      { ownership_revision: 2, status: 'PENDING' },
    ]);
    expect(await flow.world.sql('SELECT status FROM jobs WHERE job_id = $1', [flow.retrieve.jobId])).toEqual([
      { status: 'QUEUED' },
    ]);
    expect(await flow.world.sql('SELECT status FROM leases WHERE attempt_id = $1', [first.attemptId])).toEqual([
      { status: 'EXPIRED' },
    ]);
    // Nothing is released until termination is confirmed: attempt 1 keeps its reservation, attempt 2 adds its own.
    expect(await reservationsOf(flow)).toEqual([
      { ownership_revision: 1, status: 'RESERVED' },
      { ownership_revision: 2, status: 'RESERVED' },
    ]);
    expect(await committed(flow, 'BATCH_COMPUTE_SECONDS')).toBe('1200.00000000');
    expect(await committed(flow, 'PROVIDER_REQUESTS')).toBe('40.00000000');

    // The retry went out under its own attempt, as the message that its transaction stored.
    const second = await latest(flow);
    const stored = await outboxOf(flow, second);
    expect(sent.batch).toHaveLength(2);
    expect(sent.batch[1]).toEqual(stored.message);
    expect((sent.batch[1] as { attempt: unknown }).attempt).toEqual({ attempt_id: second, ownership_revision: 2 });
    expect(stored.digest).not.toBe((await outboxOf(flow, first.attemptId)).digest);
    expect(await flow.world.sql('SELECT status FROM outbox WHERE attempt_id = $1', [second])).toEqual([
      { status: 'SENT' },
    ]);
    const audited = await flow.world.sql<{ event_type: string }>(
      `SELECT event_type FROM audit_events WHERE subject = $1 ORDER BY audit_id`,
      [first.attemptId],
    );
    expect(audited.map((row) => row.event_type)).toContain('attempt.lease_expired');
  });

  it('is idempotent: a second pass finds nothing to expire, confirm or send', async () => {
    const flow = await fresh();
    const { sent, dispatchers } = queue();
    const first = await claim(flow, flow.retrieve.attemptId);
    afterLease(flow, first);
    await recover(flow, { dispatchers, probe: never });
    const before = await flow.world.snapshot();
    const sentBefore = sent.batch.length;

    expect(await recover(flow, { dispatchers, probe: never })).toEqual({
      leasesExpired: 0,
      retried: 0,
      failed: 0,
      waiting: 0,
      terminationsConfirmed: 0,
      reconciled: 0,
      dispatch: zero,
      errors: 0,
    });
    expect(sent.batch).toHaveLength(sentBefore);
    expect(await flow.world.snapshot()).toEqual(before);
  });

  it('rejects the late result of the dead worker and commits the result of its successor: one official result (A11)', async () => {
    const flow = await fresh();
    const { dispatchers } = queue();
    const first = await claim(flow, flow.retrieve.attemptId);
    afterLease(flow, first);
    await recover(flow, { dispatchers, probe: never });
    const secondId = await latest(flow);

    // The first worker wakes up and submits: a newer attempt owns the job.
    const late = await submit(flow, first, 'retrieval-result', { schema_version: 'retrieval-result/1' });
    expect(late.status).toBe(409);
    expect(await errorCode(late)).toBe('STALE_OWNERSHIP');
    expect(await flow.world.sql('SELECT 1 FROM dataset_manifests')).toHaveLength(0);

    // The successor does the work and commits.
    const driven = await driveRetrieval({ ...flow, retrieve: { jobId: flow.retrieve.jobId, attemptId: secondId } });
    expect(driven.response.status).toBe(204);
    expect(await attemptsOf(flow)).toMatchObject([
      { ownership_revision: 1, status: 'LEASE_EXPIRED' },
      { ownership_revision: 2, status: 'COMPLETED' },
    ]);
    expect(await flow.world.sql('SELECT status FROM jobs WHERE job_id = $1', [flow.retrieve.jobId])).toEqual([
      { status: 'COMPLETED' },
    ]);
    expect(await flow.world.sql('SELECT attempt_id FROM retrieval_results')).toEqual([{ attempt_id: secondId }]);
    expect(await flow.world.sql('SELECT 1 FROM dataset_manifests')).toHaveLength(1);

    // The dead attempt's reservation is confirmed once its host is taken to have stopped: it reported nothing, so the
    // full amount counts as spent; the successor's reservation settled with what it reported.
    afterLease(flow, first, TERMINATION_GRACE_SECONDS + 1);
    const summary = await recover(flow, { dispatchers });
    expect(summary.terminationsConfirmed).toBe(1);
    expect(await reservationsOf(flow)).toEqual([
      { ownership_revision: 1, status: 'UNRECONCILED' },
      { ownership_revision: 2, status: 'SETTLED' },
    ]);
    // 600 seconds of attempt 1 stay counted; attempt 2 used 5 of its 600 (4,120 ms rounded up) and 2 of its 20 requests.
    expect(await committed(flow, 'BATCH_COMPUTE_SECONDS')).toBe('605.00000000');
    expect(await committed(flow, 'PROVIDER_REQUESTS')).toBe('22.00000000');
  });
});

describe('a worker that dies every time', () => {
  it('is fenced at each lease until the cap of 3: the job FAILED, the mission BLOCKED, an attention item, no fourth attempt', async () => {
    const flow = await fresh();
    const { sent, dispatchers } = queue();
    let attemptId = flow.retrieve.attemptId;
    for (const revision of [1, 2, 3]) {
      const claimed = await claim(flow, attemptId);
      expect(claimed.ownershipRevision).toBe(revision);
      afterLease(flow, claimed);
      const summary = await recover(flow, { dispatchers, probe: never });
      expect(summary.leasesExpired, `lease ${revision}`).toBe(1);
      expect(summary.retried, `lease ${revision}`).toBe(revision < 3 ? 1 : 0);
      expect(summary.failed, `lease ${revision}`).toBe(revision < 3 ? 0 : 1);
      attemptId = await latest(flow);
    }
    expect(await attemptsOf(flow)).toMatchObject([
      { ownership_revision: 1, status: 'LEASE_EXPIRED' },
      { ownership_revision: 2, status: 'LEASE_EXPIRED' },
      { ownership_revision: 3, status: 'LEASE_EXPIRED' },
    ]);
    expect(
      await flow.world.sql('SELECT status, failure_code FROM jobs WHERE job_id = $1', [flow.retrieve.jobId]),
    ).toEqual([{ status: 'FAILED', failure_code: 'LEASE_EXPIRED' }]);
    // The job is final and the mission cannot continue without its data: it is BLOCKED with the reason, and an operator
    // finds an attention item for it.
    const [mission] = await flow.world.sql<{ status: string; blocked_reason: string }>(
      'SELECT status, blocked_reason FROM missions WHERE mission_id = $1',
      [flow.missionId],
    );
    expect(mission?.status).toBe('BLOCKED');
    expect(mission?.blocked_reason).toContain('attempt cap of 3');
    const items = await flow.world.sql<{ subject: string; reason: string; status: string }>(
      'SELECT subject, reason, status FROM attention_items WHERE mission_id = $1',
      [flow.missionId],
    );
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ subject: `retrieve job ${flow.retrieve.jobId}`, status: 'OPEN' });
    expect(items[0]?.reason).toContain('LEASE_EXPIRED');
    // The worker claimed attempt 1 before any pass sent its message, so that entry was marked delivered; the two retries
    // were sent, each under its own attempt. No message names a fourth.
    expect(
      sent.batch.map((message) => (message as { attempt: { ownership_revision: number } }).attempt.ownership_revision),
    ).toEqual([2, 3]);

    // Nothing was confirmed while the host was not known to have stopped: three reservations of 600 seconds stay held.
    expect(await reservationsOf(flow)).toEqual([
      { ownership_revision: 1, status: 'RESERVED' },
      { ownership_revision: 2, status: 'RESERVED' },
      { ownership_revision: 3, status: 'RESERVED' },
    ]);
    expect(await committed(flow, 'BATCH_COMPUTE_SECONDS')).toBe('1800.00000000');

    // Once the deadline and the grace have passed, with no report, every full reservation counts as spent.
    afterLease(flow, { leaseExpiresAt: (await lastLeaseEnd(flow)).toISOString() }, TERMINATION_GRACE_SECONDS + 1);
    expect((await recover(flow, { dispatchers, probe: deadlineProbe() })).terminationsConfirmed).toBe(3);
    expect((await reservationsOf(flow)).map((row) => row.status)).toEqual([
      'UNRECONCILED',
      'UNRECONCILED',
      'UNRECONCILED',
    ]);
    expect(await committed(flow, 'BATCH_COMPUTE_SECONDS')).toBe('1800.00000000');
    expect(await committed(flow, 'PROVIDER_REQUESTS')).toBe('60.00000000');
    expect((await recover(flow, { dispatchers, probe: deadlineProbe() })).terminationsConfirmed).toBe(0);
    // A failed job is final: no pass opens a fourth attempt.
    expect(await attemptsOf(flow)).toHaveLength(3);
  });

  it('keeps a job without budget QUEUED with no live attempt, and the mission BLOCKED, when no budget covers the retry', async () => {
    const flow = await fresh();
    const { dispatchers } = queue();
    // Leave less than one more retrieval attempt in the mission's batch pool: 7,200 - 600 held - 6,300 = 300 < 600.
    await flow.world.sql(
      `UPDATE budget_pools SET committed = committed + 6300 WHERE scope = 'MISSION' AND mission_id = $1 AND dimension = 'BATCH_COMPUTE_SECONDS'`,
      [flow.missionId],
    );
    const first = await claim(flow, flow.retrieve.attemptId);
    afterLease(flow, first);
    const summary = await recover(flow, { dispatchers, probe: never });
    expect(summary).toMatchObject({ leasesExpired: 1, retried: 0, failed: 0, waiting: 1, errors: 0 });
    expect(await attemptsOf(flow)).toMatchObject([{ ownership_revision: 1, status: 'LEASE_EXPIRED' }]);
    const [job] = await flow.world.sql<{ status: string; waiting_reason: string }>(
      'SELECT status, waiting_reason FROM jobs WHERE job_id = $1',
      [flow.retrieve.jobId],
    );
    expect(job?.status).toBe('QUEUED');
    expect(job?.waiting_reason).toContain('waits for budget');
    const [mission] = await flow.world.sql<{ status: string }>('SELECT status FROM missions WHERE mission_id = $1', [
      flow.missionId,
    ]);
    expect(mission?.status).toBe('BLOCKED');
    // Nothing resumes it: the next pass finds no expired lease and writes no attempt.
    expect((await recover(flow, { dispatchers, probe: never })).leasesExpired).toBe(0);
    expect(await attemptsOf(flow)).toHaveLength(1);
  });
});

/** A host that dies on every attempt of a job: three claims, each followed by the end of its lease and one pass. */
async function crashEveryAttempt(
  flow: Flow & Started,
  jobId: string,
  dispatchers: Dispatchers,
  host: { who: 'batch' | 'runner'; executable: typeof AGENT_RUNNER } = { who: 'batch', executable: ENGINE_BATCH },
): Promise<void> {
  for (let made = 0; made < 3; made += 1) {
    const [row] = await flow.world.sql<{ attempt_id: string }>(
      'SELECT attempt_id FROM attempts WHERE job_id = $1 ORDER BY ownership_revision DESC LIMIT 1',
      [jobId],
    );
    const claimed = await claim(flow, row?.attempt_id as string, host.who, host.executable);
    afterLease(flow, claimed);
    await recover(flow, { dispatchers, probe: never });
  }
}

describe('other work that ends for good after its last lease', () => {
  it('discards the trial of a validation that could never run, and leaves the mission running', async () => {
    const flow = await fresh();
    const { dispatchers } = queue();
    expect((await driveRetrieval(flow)).response.status).toBe(204);
    const work = await startValidationOf(flow, { trialSlot: 'seed', draftDigest: flow.world.records.seedDigest });
    await crashEveryAttempt(flow, work.jobId, dispatchers);

    expect(await flow.world.sql('SELECT status, failure_code FROM jobs WHERE job_id = $1', [work.jobId])).toEqual([
      { status: 'FAILED', failure_code: 'LEASE_EXPIRED' },
    ]);
    // The draft was never validated: its trial is in the search history as DISCARDED, with the reason, not DRAFTED for good.
    const [trial] = await flow.world.sql<{ status: string; reason: string }>(
      `SELECT status, reason FROM trials WHERE mission_id = $1 AND draft_digest = $2`,
      [flow.missionId, flow.world.records.seedDigest],
    );
    expect(trial?.status).toBe('DISCARDED');
    expect(trial?.reason).toContain('attempt cap of 3');
    // An operator sees it. The mission can go on (a proposer may draft again), so it is not blocked.
    const [mission] = await flow.world.sql<{ status: string }>('SELECT status FROM missions WHERE mission_id = $1', [
      flow.missionId,
    ]);
    expect(mission?.status).toBe('IN_PROGRESS');
    expect(
      await flow.world.sql<{ subject: string }>('SELECT subject FROM attention_items WHERE mission_id = $1', [
        flow.missionId,
      ]),
    ).toEqual([{ subject: `validate job ${work.jobId}` }]);
  });

  it('reports no attention item for an agent run: its outcome is the input of the Decision', async () => {
    const flow = await fresh();
    const { dispatchers } = queue();
    expect((await driveRetrieval(flow)).response.status).toBe(204);
    const agent = await startAgent(flow, { slot: 'seed', role: 'CRITIC' });
    await crashEveryAttempt(flow, agent.jobId, dispatchers, { who: 'runner', executable: AGENT_RUNNER });

    expect(await flow.world.sql('SELECT status, failure_code FROM jobs WHERE job_id = $1', [agent.jobId])).toEqual([
      { status: 'FAILED', failure_code: 'LEASE_EXPIRED' },
    ]);
    expect(await flow.world.sql('SELECT 1 FROM attention_items WHERE mission_id = $1', [flow.missionId])).toHaveLength(
      0,
    );
    const [mission] = await flow.world.sql<{ status: string }>('SELECT status FROM missions WHERE mission_id = $1', [
      flow.missionId,
    ]);
    expect(mission?.status).toBe('IN_PROGRESS');
  });
});

async function lastLeaseEnd(flow: Flow & Started): Promise<Date> {
  const [row] = await flow.world.sql<{ expires_at: Date }>('SELECT max(expires_at) AS expires_at FROM leases');
  return row?.expires_at as Date;
}

describe('the termination of a host', () => {
  it('settles the reservation from what the host reported, and returns the unused part to the pools', async () => {
    const flow = await fresh();
    const { dispatchers } = queue();
    const first = await claim(flow, flow.retrieve.attemptId);
    afterLease(flow, first);
    const reported: TerminationProbe = {
      async check() {
        return {
          terminated: true,
          usage: {
            BATCH_COMPUTE_SECONDS: { label: 'observed', amount: '20' },
            PROVIDER_REQUESTS: { label: 'observed', amount: '1' },
          },
        };
      },
    };
    const summary = await recover(flow, { dispatchers, probe: reported });
    expect(summary).toMatchObject({ leasesExpired: 1, retried: 1, terminationsConfirmed: 1, errors: 0 });
    expect((await reservationsOf(flow))[0]).toEqual({ ownership_revision: 1, status: 'SETTLED' });
    // 20 of 600 seconds and 1 of 20 requests were used: the rest returns. The retry holds a full reservation of its own.
    expect(await committed(flow, 'BATCH_COMPUTE_SECONDS')).toBe('620.00000000');
    expect(await committed(flow, 'PROVIDER_REQUESTS')).toBe('21.00000000');
  });

  it('is confirmed for an attempt that cancel_mission cancelled while it was claimed, once the deadline and the grace passed', async () => {
    const flow = await fresh();
    const { dispatchers } = queue();
    const claimed = await claim(flow, flow.retrieve.attemptId);
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
    expect(await attemptsOf(flow)).toMatchObject([{ status: 'CANCELLED' }]);
    // The lease was released by the cancellation; the reservation is kept until the host is known to have stopped.
    expect(await reservationsOf(flow)).toEqual([{ ownership_revision: 1, status: 'RESERVED' }]);

    afterLease(flow, claimed, TERMINATION_GRACE_SECONDS - 1);
    expect((await recover(flow, { dispatchers })).terminationsConfirmed).toBe(0);
    afterLease(flow, claimed, TERMINATION_GRACE_SECONDS + 1);
    const summary = await recover(flow, { dispatchers });
    expect(summary).toMatchObject({ leasesExpired: 0, terminationsConfirmed: 1 });
    expect(await reservationsOf(flow)).toEqual([{ ownership_revision: 1, status: 'UNRECONCILED' }]);
  });
});

describe('a pass that meets a failure', () => {
  it('goes on with the other items, counts and logs the failure, and repeats the failed item on the next pass', async () => {
    const flow = await fresh();
    const { dispatchers } = queue();
    const batch = await claim(flow, flow.retrieve.attemptId);
    const agent = await startAgent(flow, { role: 'CRITIC' });
    const claimedAgent = await claim(flow, agent.attemptId, 'runner', AGENT_RUNNER);
    // Both leases ended; the retrieval's ends first, so the failing transaction is the first one of the pass.
    afterLease(flow, claimedAgent);
    expect(Date.parse(batch.leaseExpiresAt)).toBeLessThan(Date.parse(claimedAgent.leaseExpiresAt));

    let transactions = 0;
    const flaky = (db: Database): Database => ({
      query: (text, values) => db.query(text, values),
      transaction: (work) => {
        transactions += 1;
        if (transactions === 1) return Promise.reject(new Error('The database dropped the connection.'));
        return db.transaction(work);
      },
      close: () => db.close(),
    });
    const first = await recover(flow, { dispatchers, probe: never }, flaky);
    expect(first).toMatchObject({ leasesExpired: 1, retried: 1, errors: 1 });
    const failure = flow.world.testApp.logs.find((entry) => entry.message === 'recovery: lease expiry failed');
    expect(failure).toMatchObject({ level: 'error', attempt_id: batch.attemptId });
    // The retrieval attempt is untouched, the agent attempt was fenced and retried.
    expect(await attemptsOf(flow)).toMatchObject([{ ownership_revision: 1, status: 'CLAIMED' }]);
    expect(
      await flow.world.sql('SELECT status FROM attempts WHERE job_id = $1 ORDER BY ownership_revision', [agent.jobId]),
    ).toEqual([{ status: 'LEASE_EXPIRED' }, { status: 'PENDING' }]);

    const second = await recover(flow, { dispatchers, probe: never });
    expect(second).toMatchObject({ leasesExpired: 1, retried: 1, errors: 0 });
    expect(await attemptsOf(flow)).toMatchObject([
      { ownership_revision: 1, status: 'LEASE_EXPIRED' },
      { ownership_revision: 2, status: 'PENDING' },
    ]);
  });

  it('still sends what is pending when no workflows principal exists to write under, and says so', async () => {
    const flow = await fresh();
    const { sent, dispatchers } = queue();
    await flow.world.sql(`UPDATE principals SET status = 'DISABLED' WHERE principal_id = $1`, [ids.workflows]);
    const claimed = await claim(flow, flow.retrieve.attemptId);
    afterLease(flow, claimed);

    const summary = await recover(flow, { dispatchers, probe: never });
    expect(summary).toEqual({
      leasesExpired: 0,
      retried: 0,
      failed: 0,
      waiting: 0,
      terminationsConfirmed: 0,
      reconciled: 0,
      dispatch: { ...zero, delivered: 1 },
      errors: 1,
    });
    // The attempt was already claimed, so its entry is delivered: the dispatcher marks it, and sends nothing.
    expect(sent.batch).toEqual([]);
    expect(
      flow.world.testApp.logs.find((entry) => entry.message.startsWith('recovery: no active workflows')),
    ).toMatchObject({ level: 'error' });
    // Nothing was fenced: a pass with the principal back does it.
    await flow.world.sql(`UPDATE principals SET status = 'ACTIVE' WHERE principal_id = $1`, [ids.workflows]);
    expect((await recover(flow, { dispatchers, probe: never })).leasesExpired).toBe(1);
  });
});

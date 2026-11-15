// UNRECONCILED reservations (OQ-05 section 4, the reservation row: "Without a report, UNRECONCILED: the full amount
// counts as spent", and Recovery column: "Recovery reconciles UNRECONCILED reservations"). An attempt whose lease ended
// without a usage report is fenced, and once the termination probe confirms that its host stopped its reservation
// becomes UNRECONCILED: the whole amount counts as spent. Two paths settle it from what a host later reports, never above the reservation:
//
//   - a late agent-result from the runner of the fenced attempt. The submission is rejected as before (LEASE_EXPIRED or
//     STALE_OWNERSHIP, recorded, the run and the result unchanged), but the usage that it carries settles the
//     reservation. A usage above the reservation is an overrun and blocks the mission;
//   - a recovery step: when the termination probe reports usage for an attempt whose reservation is UNRECONCILED, the
//     reservation is settled from it. The step is a no-op when nothing is UNRECONCILED.
//
// A late report of a batch attempt does not settle: for batch work UNRECONCILED stays final in S1 (README, limits).
// The amounts are the reservations of the pilot policy: an agent attempt reserves 5.00 of model spend and 900 agent
// compute seconds; a retrieval attempt reserves 600 batch seconds and 20 provider requests.

import { afterEach, describe, expect, it } from 'vitest';
import { openAttempt } from '../src/domain/attempts.ts';
import { insertJob } from '../src/domain/work.ts';
import type { ApiEnv } from '../src/env.ts';
import type { Dispatchers } from '../src/outbox.ts';
import { runRecovery, type TerminationProbe } from '../src/recovery.ts';
import {
  AGENT_RUNNER,
  bytesOf,
  type Claimed,
  claim,
  errorCode,
  type Flow,
  manifestFor,
  outboxOf,
  requestOf,
  retrievalResult,
  type Started,
  startAgent,
  startedFlow,
  submit,
  upload,
} from './support/flow.ts';
import { agentResultDoc } from './support/steps.ts';
import type { Doc } from './support/world.ts';

const flows: (Flow & Started)[] = [];
async function fresh(): Promise<Flow & Started> {
  const flow = await startedFlow({
    policy: (policy) => {
      policy.limits.concurrent_agent_attempts = 10;
    },
  });
  flows.push(flow);
  return flow;
}
afterEach(async () => {
  for (const flow of flows.splice(0)) await flow.world.drop();
});

const dispatchers: Dispatchers = {
  batch: { async send() {} },
  runner: { async dispatch() {} },
};

async function recover(flow: Flow & Started, probe?: TerminationProbe) {
  const env: ApiEnv = flow.world.testApp.env;
  const db = env.database();
  try {
    return await runRecovery(env, db, { dispatchers, ...(probe === undefined ? {} : { probe }) });
  } finally {
    await db.close();
  }
}

/** Move the clock past the end of a lease. The clock alone confirms no termination: only a probe does (D22). */
const afterLease = (flow: Flow, claimed: Pick<Claimed, 'leaseExpiresAt'>, plusSeconds = 1) =>
  flow.world.testApp.clock.set(new Date(Date.parse(claimed.leaseExpiresAt) + plusSeconds * 1000));

/** A probe that confirms that the host stopped, with no usage report. */
const stopped: TerminationProbe = { check: async () => ({ terminated: true }) };

async function pool(flow: Flow & Started, dimension: string, configuration: string | null = null) {
  const [row] = await flow.world.sql<{ committed: string; overrun: string }>(
    `SELECT committed::text, overrun::text FROM budget_pools
      WHERE scope = 'MISSION' AND mission_id = $1 AND dimension = $2 AND configuration_id IS NOT DISTINCT FROM $3`,
    [flow.missionId, dimension, configuration],
  );
  return row as { committed: string; overrun: string };
}

const reservationOf = async (flow: Flow & Started, attemptId: string) =>
  (await flow.world.sql<{ status: string }>('SELECT status FROM reservations WHERE attempt_id = $1', [attemptId]))[0]
    ?.status;

/** A critic attempt that was claimed and whose host never reported: the lease ends, recovery fences it and settles nothing. */
async function silentAgent(flow: Flow & Started) {
  const work = await startAgent(flow, { role: 'CRITIC' });
  const claimed = await claim(flow, work.attemptId, 'runner', AGENT_RUNNER);
  const { message } = await outboxOf(flow, work.attemptId);
  afterLease(flow, claimed);
  const summary = await recover(flow, stopped);
  return { work, claimed, message, summary };
}

/** The report of the host that stopped after its lease ended, with the cost and the duration that it measured. */
const lateReport = (
  claimed: Pick<Claimed, 'attemptId' | 'ownershipRevision'>,
  message: Doc,
  cost: string,
  edit?: (result: Doc) => void,
) =>
  agentResultDoc(
    claimed,
    message,
    { outcome: 'timeout', diagnostic: 'The host terminated the process tree at the deadline.' },
    (result) => {
      result.usage.cost = { label: 'estimated', amount: cost, currency: 'USD' };
      result.usage.duration = { label: 'observed', milliseconds: 30000 };
      edit?.(result);
    },
  );

describe('a late agent report from a fenced attempt', () => {
  it('settles the UNRECONCILED reservation from its usage, is rejected as before, and changes neither the run nor the result', async () => {
    const flow = await fresh();
    const { work, claimed, message, summary } = await silentAgent(flow);
    // The pass fenced the attempt, wrote its retry, and confirmed the termination without a report.
    expect(summary).toMatchObject({ leasesExpired: 1, retried: 1, terminationsConfirmed: 1, reconciled: 0 });
    expect(await reservationOf(flow, work.attemptId)).toBe('UNRECONCILED');
    // 5.00 of the critic's allowance and 900 seconds count as spent, and the retry reserved the same again.
    expect((await pool(flow, 'MODEL_SPEND', 'critic')).committed).toBe('10.00000000');
    expect((await pool(flow, 'AGENT_COMPUTE_SECONDS')).committed).toBe('1800.00000000');
    const before = await flow.world.sql(
      'SELECT a.attempt_id, a.status, a.result_digest, j.status AS job FROM attempts a JOIN jobs j ON j.job_id = a.job_id WHERE j.job_id = $1 ORDER BY a.ownership_revision',
      [work.jobId],
    );

    const response = await submit(flow, claimed, 'agent-result', lateReport(claimed, message, '1.10'));
    // A newer attempt exists, so the host no longer owns the run: the rejection is the one of the route layer.
    expect(response.status).toBe(409);
    expect(await errorCode(response)).toBe('STALE_OWNERSHIP');

    // The reservation is settled from 1.10 estimated of 5.00 and 30 observed of 900 seconds: the rest returned.
    expect(await reservationOf(flow, work.attemptId)).toBe('SETTLED');
    const lines = await flow.world.sql(
      `SELECT p.dimension, l.reserved::text, l.used::text, l.usage_label FROM reservation_lines l
         JOIN budget_pools p ON p.pool_id = l.pool_id WHERE l.attempt_id = $1 ORDER BY p.dimension`,
      [work.attemptId],
    );
    expect(lines).toEqual([
      { dimension: 'AGENT_COMPUTE_SECONDS', reserved: '900.00000000', used: '30.00000000', usage_label: 'observed' },
      { dimension: 'MODEL_SPEND', reserved: '5.00000000', used: '1.10000000', usage_label: 'estimated' },
    ]);
    expect((await pool(flow, 'MODEL_SPEND', 'critic')).committed).toBe('6.10000000');
    expect((await pool(flow, 'AGENT_COMPUTE_SECONDS')).committed).toBe('930.00000000');
    // The run, the attempts and the result are as they were: the report carried a usage, not a result.
    expect(
      await flow.world.sql(
        'SELECT a.attempt_id, a.status, a.result_digest, j.status AS job FROM attempts a JOIN jobs j ON j.job_id = a.job_id WHERE j.job_id = $1 ORDER BY a.ownership_revision',
        [work.jobId],
      ),
    ).toEqual(before);
    expect(await flow.world.sql('SELECT 1 FROM agent_results')).toHaveLength(0);
    // Both are in the audit log: the rejection of the late submission, and the reconciliation.
    expect(
      await flow.world.sql<{ event_type: string }>(
        `SELECT event_type FROM audit_events WHERE subject = $1 AND event_type IN ('attempt.late_submission_rejected', 'reservation.reconciled') ORDER BY audit_id`,
        [work.attemptId],
      ),
    ).toEqual([{ event_type: 'attempt.late_submission_rejected' }, { event_type: 'reservation.reconciled' }]);

    // The same report again settles nothing more.
    const again = await submit(flow, claimed, 'agent-result', lateReport(claimed, message, '1.10'));
    expect(again.status).toBe(409);
    expect((await pool(flow, 'MODEL_SPEND', 'critic')).committed).toBe('6.10000000');
  });

  it('is answered LEASE_EXPIRED when no newer attempt exists, and settles the reservation all the same', async () => {
    const flow = await fresh();
    // A job of one attempt: the cap is used by the attempt that went silent, so recovery writes no retry.
    const work = await flow.world.tx(async (tx) => {
      const job = await insertJob(tx, flow.world.testApp.env, {
        missionId: flow.missionId,
        kind: 'agent',
        attemptCap: 1,
        configurationId: 'critic',
        agentRole: 'CRITIC',
      });
      const opened = await openAttempt(tx, flow.work(), job);
      if (!opened.ok) throw new Error(opened.reason);
      return { jobId: job.id, attemptId: opened.attemptId };
    });
    const claimed = await claim(flow, work.attemptId, 'runner', AGENT_RUNNER);
    const { message } = await outboxOf(flow, work.attemptId);
    afterLease(flow, claimed);
    expect(await recover(flow, stopped)).toMatchObject({
      leasesExpired: 1,
      retried: 0,
      failed: 1,
      terminationsConfirmed: 1,
    });
    expect(await reservationOf(flow, work.attemptId)).toBe('UNRECONCILED');

    const response = await submit(flow, claimed, 'agent-result', lateReport(claimed, message, '2.50'));
    expect(response.status).toBe(409);
    expect(await errorCode(response)).toBe('LEASE_EXPIRED');
    expect(await reservationOf(flow, work.attemptId)).toBe('SETTLED');
    expect((await pool(flow, 'MODEL_SPEND', 'critic')).committed).toBe('2.50000000');
    expect(await flow.world.sql('SELECT status, failure_code FROM jobs WHERE job_id = $1', [work.jobId])).toEqual([
      { status: 'FAILED', failure_code: 'LEASE_EXPIRED' },
    ]);
  });

  it('never settles above the reservation: the overrun is recorded and blocks the mission', async () => {
    const flow = await fresh();
    const { work, claimed, message } = await silentAgent(flow);
    const response = await submit(flow, claimed, 'agent-result', lateReport(claimed, message, '9.00'));
    expect(response.status).toBe(409);
    expect(await reservationOf(flow, work.attemptId)).toBe('SETTLED');
    // 9.00 reported against 5.00 reserved: 5.00 is consumed, 4.00 is an overrun, and nothing returns to the pool.
    const spend = await pool(flow, 'MODEL_SPEND', 'critic');
    expect(spend).toEqual({ committed: '10.00000000', overrun: '4.00000000' });
    const [mission] = await flow.world.sql<{ status: string; blocked_reason: string }>(
      'SELECT status, blocked_reason FROM missions WHERE mission_id = $1',
      [flow.missionId],
    );
    expect(mission?.status).toBe('BLOCKED');
    expect(mission?.blocked_reason).toContain('went over its reservation');
  });

  it('leaves the reservation UNRECONCILED when the report is not the report of the dispatch, names no usage, or is not a report', async () => {
    const flow = await fresh();
    const { work, claimed, message } = await silentAgent(flow);
    const cases: [string, Doc][] = [
      [
        'another session',
        lateReport(claimed, message, '1.10', (result) => (result.provenance.session_id = 'session-x')),
      ],
      [
        'another runner',
        lateReport(claimed, message, '1.10', (result) => (result.provenance.runner.digest = 'sha256:'.padEnd(71, '0'))),
      ],
      ['another currency', lateReport(claimed, message, '1.10', (result) => (result.usage.cost.currency = 'EUR'))],
      [
        'an unknown usage',
        lateReport(claimed, message, '1.10', (result) => {
          result.usage.cost = { label: 'unknown', reason: 'The executor reported no cost.' };
          result.usage.duration = { label: 'unknown', reason: 'No clock was running.' };
        }),
      ],
    ];
    for (const [label, report] of cases) {
      const response = await submit(flow, claimed, 'agent-result', report);
      expect(response.status, label).toBe(409);
      expect(await reservationOf(flow, work.attemptId), label).toBe('UNRECONCILED');
    }
    // A body that is not an agent-attempt-result/1 is refused by the route layer as before; nothing is settled.
    const empty = await flow.send('POST', `/v1/attempts/${work.attemptId}/agent-result`, claimed.token, '{}');
    expect(empty.status).toBe(409);
    expect(await reservationOf(flow, work.attemptId)).toBe('UNRECONCILED');
    expect((await pool(flow, 'MODEL_SPEND', 'critic')).committed).toBe('10.00000000');
  });

  it('does not settle a reservation that termination has not confirmed: it is RESERVED, not UNRECONCILED', async () => {
    const flow = await fresh();
    const work = await startAgent(flow, { role: 'CRITIC' });
    const claimed = await claim(flow, work.attemptId, 'runner', AGENT_RUNNER);
    const { message } = await outboxOf(flow, work.attemptId);
    // Fenced, but the host is not known to have stopped: the default probe confirms nothing.
    afterLease(flow, claimed);
    expect(await recover(flow)).toMatchObject({ leasesExpired: 1, terminationsConfirmed: 0 });
    expect(await reservationOf(flow, work.attemptId)).toBe('RESERVED');
    const response = await submit(flow, claimed, 'agent-result', lateReport(claimed, message, '1.10'));
    expect(response.status).toBe(409);
    expect(await reservationOf(flow, work.attemptId)).toBe('RESERVED');
  });
});

describe('a late report from a batch attempt', () => {
  it('does not settle: UNRECONCILED stays final for batch work in S1', async () => {
    const flow = await fresh();
    const { jobId, attemptId } = flow.retrieve;
    const claimed = await claim(flow, attemptId);
    const request = await requestOf(flow, attemptId);
    const manifest = await upload(
      flow,
      claimed,
      bytesOf(manifestFor(flow, { jobId, attemptId, requestDigest: request.digest })),
    );
    afterLease(flow, claimed);
    expect(await recover(flow, stopped)).toMatchObject({ leasesExpired: 1, terminationsConfirmed: 1, reconciled: 0 });
    expect(await reservationOf(flow, attemptId)).toBe('UNRECONCILED');
    const response = await submit(
      flow,
      claimed,
      'retrieval-result',
      retrievalResult(claimed, jobId, request.digest, { status: 'COMPLETE', manifest }),
    );
    expect(response.status).toBe(409);
    expect(await reservationOf(flow, attemptId)).toBe('UNRECONCILED');
    expect((await pool(flow, 'BATCH_COMPUTE_SECONDS')).committed).toBe('1200.00000000');
  });
});

describe('the recovery step that reconciles', () => {
  /** A probe that records every attempt that it is asked about, and answers as `answer` says. */
  function probe(answer: (attemptId: string) => ReturnType<TerminationProbe['check']>) {
    const asked: string[] = [];
    const checked: TerminationProbe = {
      check: (attempt) => {
        asked.push(attempt.attemptId);
        return answer(attempt.attemptId);
      },
    };
    return { asked, checked };
  }

  it('is a no-op when nothing is UNRECONCILED: it asks nobody and changes nothing', async () => {
    const flow = await fresh();
    await claim(flow, flow.retrieve.attemptId);
    const { asked, checked } = probe(async () => ({ terminated: true }));
    // The pass still marks the dispatched entry of the claimed attempt as sent; that is not a budget movement.
    const before = await flow.world.snapshot(['audit_events', 'outbox']);
    expect(await recover(flow, checked)).toMatchObject({ reconciled: 0, terminationsConfirmed: 0, errors: 0 });
    expect(asked).toEqual([]);
    expect(await flow.world.snapshot(['audit_events', 'outbox'])).toEqual(before);
  });

  it('settles an UNRECONCILED reservation when the probe reports usage, once, and never above the reservation', async () => {
    const flow = await fresh();
    const work = await startAgent(flow, { role: 'CRITIC' });
    const claimed = await claim(flow, work.attemptId, 'runner', AGENT_RUNNER);
    afterLease(flow, claimed);
    // The pass that confirms the termination without a report: the probe is asked once, not again by the second step.
    const silent = probe(async () => ({ terminated: true }));
    expect(await recover(flow, silent.checked)).toMatchObject({ terminationsConfirmed: 1, reconciled: 0 });
    expect(silent.asked).toEqual([work.attemptId]);
    expect(await reservationOf(flow, work.attemptId)).toBe('UNRECONCILED');

    // A later pass: the platform now knows what the host used. 2.00 of 5.00 and 100 of 900 seconds.
    const reported = probe(async () => ({
      terminated: true,
      usage: {
        MODEL_SPEND: { label: 'estimated' as const, amount: '2.00' },
        AGENT_COMPUTE_SECONDS: { label: 'observed' as const, amount: '100' },
      },
    }));
    expect(await recover(flow, reported.checked)).toMatchObject({ reconciled: 1, terminationsConfirmed: 0, errors: 0 });
    expect(reported.asked).toEqual([work.attemptId]);
    expect(await reservationOf(flow, work.attemptId)).toBe('SETTLED');
    // The retry holds its own full reservation: 5.00 and 900 seconds on top of what the first attempt used.
    expect((await pool(flow, 'MODEL_SPEND', 'critic')).committed).toBe('7.00000000');
    expect((await pool(flow, 'AGENT_COMPUTE_SECONDS')).committed).toBe('1000.00000000');
    expect(
      await flow.world.sql(`SELECT 1 FROM audit_events WHERE event_type = 'reservation.reconciled' AND subject = $1`, [
        work.attemptId,
      ]),
    ).toHaveLength(1);

    // Nothing is UNRECONCILED any more: the next pass asks nobody.
    const quiet = probe(async () => ({ terminated: true }));
    expect(await recover(flow, quiet.checked)).toMatchObject({ reconciled: 0 });
    expect(quiet.asked).toEqual([]);
  });

  it('leaves the reservation UNRECONCILED while the probe has no usage, and under the default probe', async () => {
    const flow = await fresh();
    const { work } = await silentAgent(flow);
    expect(await reservationOf(flow, work.attemptId)).toBe('UNRECONCILED');
    const nothing = probe(async () => ({ terminated: true }));
    expect(await recover(flow, nothing.checked)).toMatchObject({ reconciled: 0 });
    expect(nothing.asked).toEqual([work.attemptId]);
    expect(await recover(flow)).toMatchObject({ reconciled: 0 });
    expect(await reservationOf(flow, work.attemptId)).toBe('UNRECONCILED');
    expect((await pool(flow, 'MODEL_SPEND', 'critic')).committed).toBe('10.00000000');
  });

  it('records usage above the reservation as an overrun and blocks the mission, as every settlement does', async () => {
    const flow = await fresh();
    const { work } = await silentAgent(flow);
    const over = probe(async () => ({
      terminated: true,
      usage: { MODEL_SPEND: { label: 'estimated' as const, amount: '8.00' } },
    }));
    expect(await recover(flow, over.checked)).toMatchObject({ errors: 0 });
    expect((await pool(flow, 'MODEL_SPEND', 'critic')).overrun).toBe('3.00000000');
    const [mission] = await flow.world.sql<{ status: string }>('SELECT status FROM missions WHERE mission_id = $1', [
      flow.missionId,
    ]);
    expect(mission?.status).toBe('BLOCKED');
    // The compute line was not reported: it stays reserved, so the reservation is still UNRECONCILED.
    expect(await reservationOf(flow, work.attemptId)).toBe('UNRECONCILED');
  });
});

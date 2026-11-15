// Attempts, leases, fencing, retry, cancellation and the outbox on a real PostgreSQL (OQ-05 section 4; OQ-03 section 5;
// decisions D5, D6 and D22). Each test states, from the specification, what must hold: only the current owner commits,
// a late submission is rejected and recorded, a retry is a new attempt with its own reservation up to the attempt cap
// and the budget, a retry that no budget covers leaves the work QUEUED and the mission BLOCKED, and a result that
// committed before a cancellation wins.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { executeCommand } from '../src/commands/runner.ts';
import type { Database, Queryable } from '../src/db/database.ts';
import {
  claimAttempt,
  completeAttempt,
  confirmTermination,
  expireLease,
  markOutboxSent,
  openAttempt,
  reconcileReservation,
} from '../src/domain/attempts.ts';
import { insertJob } from '../src/domain/work.ts';
import {
  batchUsage,
  claim,
  complete,
  dispatchDigestOf,
  fail,
  liveAttempt,
  revisionOf,
  startAgentJob,
} from './support/attempts.ts';
import { completedCritique, decide, missionRevision } from './support/pipeline.ts';
import { ids, sha } from './support/seed.ts';
import { actorOf, plannedWorld, startedWorld, type World } from './support/world.ts';

/** A world in which rev-a is APPROVED: five runs, each QUEUED with a PENDING attempt. */
async function approved(options: Parameters<typeof plannedWorld>[0] = {}): Promise<World> {
  const world = await plannedWorld(options);
  const critique = await completedCritique(world, 'rev-a');
  const outcome = await decide(world, 'rev-a', 'APPROVED', critique);
  if (outcome.state !== 'APPLIED') throw new Error('The Decision was not applied.');
  return world;
}

async function runAttempt(world: World, runSlot: string): Promise<{ runId: string; attemptId: string }> {
  const rows = await world.sql<{ run_id: string; attempt_id: string }>(
    `SELECT r.run_id, a.attempt_id FROM runs r JOIN attempts a ON a.run_id = r.run_id
      WHERE r.run_slot = $1 AND a.status IN ('PENDING', 'CLAIMED')`,
    [runSlot],
  );
  return { runId: rows[0]?.run_id as string, attemptId: rows[0]?.attempt_id as string };
}

const runRow = async (world: World, runId: string) =>
  (
    await world.sql<{ status: string; revision: number; failure_code: string | null; waiting_reason: string | null }>(
      'SELECT status, revision, failure_code, waiting_reason FROM runs WHERE run_id = $1',
      [runId],
    )
  )[0];

const expire = (world: World, attemptId: string) =>
  world.tx((tx) => expireLease(tx, world.work(ids.workflows), attemptId));

async function batchCommitted(world: World): Promise<string> {
  const rows = await world.sql<{ committed: string }>(
    `SELECT committed::text AS committed FROM budget_pools WHERE mission_id = $1 AND dimension = 'BATCH_COMPUTE_SECONDS'`,
    [world.records.missionId],
  );
  return rows[0]?.committed as string;
}

describe('claiming an attempt', () => {
  let world: World;
  beforeAll(async () => {
    world = await approved();
  });
  afterAll(async () => {
    await world.drop();
  });

  it('makes the attempt CLAIMED, grants a lease with the capability hash, and sets the run RUNNING', async () => {
    const { runId, attemptId } = await runAttempt(world, 'rev-a.d.base');
    const outcome = await claim(world, attemptId);
    expect(outcome.ok).toBe(true);
    const attempt = await world.sql(
      `SELECT status, worker_id, executable_name, executable_version, executable_digest, dispatch_digest, claimed_at IS NOT NULL AS claimed FROM attempts WHERE attempt_id = $1`,
      [attemptId],
    );
    expect(attempt).toEqual([
      {
        status: 'CLAIMED',
        worker_id: 'worker-1',
        executable_name: 'engine-batch',
        executable_version: '0.0.0',
        executable_digest: sha('engine-batch'),
        dispatch_digest: await dispatchDigestOf(world, attemptId),
        claimed: true,
      },
    ]);
    const lease = await world.sql(
      `SELECT status, ownership_revision, capability_hash, to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS expires FROM leases WHERE attempt_id = $1`,
      [attemptId],
    );
    // The lease runs 900 seconds from the claim at 10:00:00.
    expect(lease).toEqual([
      {
        status: 'HELD',
        ownership_revision: 1,
        capability_hash: sha(`capability-${attemptId}`),
        expires: '2026-11-15T10:15:00Z',
      },
    ]);
    expect(await runRow(world, runId)).toMatchObject({ status: 'RUNNING', revision: 2 });
    expect(
      await world.sql(`SELECT actor FROM audit_events WHERE event_type = 'attempt.claimed' AND subject = $1`, [
        attemptId,
      ]),
    ).toEqual([{ actor: ids.batch }]);
  });

  it('refuses a second claim, another ownership revision, another dispatch digest and an unknown attempt, and changes nothing', async () => {
    const { attemptId } = await runAttempt(world, 'rev-a.d.base');
    const other = await runAttempt(world, 'rev-a.d.stress');
    const before = await world.snapshot();
    const second = await claim(world, attemptId);
    expect(second.ok === false && second.failure.code).toBe('ATTEMPT_NOT_CLAIMABLE');
    const revision = await claim(world, other.attemptId, { ownershipRevision: 2 });
    expect(revision.ok === false && revision.failure.code).toBe('STALE_OWNERSHIP');
    const digest = await claim(world, other.attemptId, { dispatchDigest: sha('another message') });
    expect(digest.ok === false && digest.failure.code).toBe('IDENTITY_MISMATCH');
    const unknown = await claim(world, 'att-none', { ownershipRevision: 1, dispatchDigest: sha('x') });
    expect(unknown.ok === false && unknown.failure.code).toBe('NOT_FOUND');
    expect(await world.snapshot()).toEqual(before);
  });
});

describe('only the current owner commits', () => {
  it('accepts the result of the live attempt once: attempt COMPLETED, lease RELEASED, run COMPLETED, reservation SETTLED', async () => {
    const world = await approved();
    const { runId, attemptId } = await runAttempt(world, 'rev-a.v.base');
    await claim(world, attemptId);
    const done = await complete(world, attemptId, { usage: batchUsage(120) });
    expect(done.ok && done.value.work.status).toBe('COMPLETED');
    expect(
      await world.sql('SELECT status, ended_at IS NOT NULL AS ended FROM attempts WHERE attempt_id = $1', [attemptId]),
    ).toEqual([{ status: 'COMPLETED', ended: true }]);
    expect(
      await world.sql('SELECT status, released_at IS NOT NULL AS released FROM leases WHERE attempt_id = $1', [
        attemptId,
      ]),
    ).toEqual([{ status: 'RELEASED', released: true }]);
    expect(await runRow(world, runId)).toMatchObject({ status: 'COMPLETED', failure_code: null });
    expect(await world.sql('SELECT status FROM reservations WHERE attempt_id = $1', [attemptId])).toEqual([
      { status: 'SETTLED' },
    ]);
    // 300 seconds were reserved and 120 used: the other 180 are back in the pool.
    expect(await batchCommitted(world)).toBe('1920.00000000');
    await world.drop();
  });

  it('gives a run that the core ended with a failure outcome the status FAILED and its code, with the attempt still COMPLETED', async () => {
    const world = await approved();
    const { runId, attemptId } = await runAttempt(world, 'rev-a.v.stress');
    await claim(world, attemptId);
    const done = await complete(world, attemptId, {
      workStatus: 'FAILED',
      failureCode: 'INVALID_LEVEL',
      usage: batchUsage(5),
    });
    expect(done.ok).toBe(true);
    expect(await runRow(world, runId)).toMatchObject({ status: 'FAILED', failure_code: 'INVALID_LEVEL' });
    expect(await world.sql('SELECT status FROM attempts WHERE attempt_id = $1', [attemptId])).toEqual([
      { status: 'COMPLETED' },
    ]);
    await world.drop();
  });

  it('answers a repeated submission without a second result: the attempt, the run and the reservation stay as the first left them', async () => {
    const world = await approved();
    const { runId, attemptId } = await runAttempt(world, 'rev-a.d.base');
    await claim(world, attemptId);
    expect((await complete(world, attemptId, { usage: batchUsage() })).ok).toBe(true);
    const before = await world.snapshot(['audit_events']);
    const again = await complete(world, attemptId, { usage: batchUsage(1) });
    expect(again.ok === false && again.failure.code).toBe('ATTEMPT_NOT_CLAIMABLE');
    expect(await world.snapshot(['audit_events'])).toEqual(before);
    expect(
      await world.sql(`SELECT count(*)::int AS n FROM attempts WHERE run_id = $1 AND status = 'COMPLETED'`, [runId]),
    ).toEqual([{ n: 1 }]);
    await world.drop();
  });

  it('refuses a completion with another ownership revision than the attempt holds, and records the rejection', async () => {
    const world = await approved();
    const { attemptId } = await runAttempt(world, 'rev-a.d.base');
    await claim(world, attemptId);
    const before = await world.snapshot(['audit_events']);
    const wrong = await complete(world, attemptId, { ownershipRevision: 2 });
    expect(wrong.ok === false && wrong.failure.code).toBe('STALE_OWNERSHIP');
    expect(await world.snapshot(['audit_events'])).toEqual(before);
    expect(
      await world.sql(`SELECT detail FROM audit_events WHERE event_type = 'attempt.late_submission_rejected'`),
    ).toEqual([{ detail: { action: 'complete', code: 'STALE_OWNERSHIP', ownership_revision: 1 } }]);
    await world.drop();
  });

  it('rejects a submission after the lease ended with LEASE_EXPIRED, records it, and changes nothing else', async () => {
    const world = await approved();
    const { runId, attemptId } = await runAttempt(world, 'rev-a.d.base');
    await claim(world, attemptId, { leaseSeconds: 60 });
    world.testApp.clock.advanceSeconds(61);
    const before = await world.snapshot(['audit_events']);
    const late = await complete(world, attemptId, { usage: batchUsage() });
    expect(late.ok === false && late.failure.code).toBe('LEASE_EXPIRED');
    expect(await world.snapshot(['audit_events'])).toEqual(before);
    expect(await runRow(world, runId)).toMatchObject({ status: 'RUNNING' });
    expect(
      await world.sql(
        `SELECT detail->>'code' AS code FROM audit_events WHERE event_type = 'attempt.late_submission_rejected'`,
      ),
    ).toEqual([{ code: 'LEASE_EXPIRED' }]);
    await world.drop();
  });

  it('rejects the late attempt with STALE_OWNERSHIP once recovery fenced a newer attempt, and lets the newer attempt commit', async () => {
    const world = await approved();
    const { runId, attemptId } = await runAttempt(world, 'rev-a.d.base');
    await claim(world, attemptId, { leaseSeconds: 60 });
    world.testApp.clock.advanceSeconds(61);
    const expired = await expire(world, attemptId);
    expect(expired.status === 'EXPIRED' && expired.after.outcome).toBe('RETRIED');
    const late = await complete(world, attemptId, { ownershipRevision: 1 });
    expect(late.ok === false && late.failure.code).toBe('STALE_OWNERSHIP');
    const next = await liveAttempt(world, { id: runId });
    expect(next).toBeDefined();
    expect(await revisionOf(world, next as string)).toBe(2);
    // Fencing: attempt 2 cannot commit with the revision of attempt 1.
    expect((await claim(world, next as string)).ok).toBe(true);
    const crossed = await complete(world, next as string, { ownershipRevision: 1 });
    expect(crossed.ok === false && crossed.failure.code).toBe('STALE_OWNERSHIP');
    expect((await complete(world, next as string, { usage: batchUsage() })).ok).toBe(true);
    expect(await runRow(world, runId)).toMatchObject({ status: 'COMPLETED' });
    expect(
      await world.sql(`SELECT count(*)::int AS n FROM attempts WHERE run_id = $1 AND status = 'COMPLETED'`, [runId]),
    ).toEqual([{ n: 1 }]);
    await world.drop();
  });

  it('lets exactly one of two concurrent claims and exactly one of two concurrent completions win', async () => {
    const world = await approved();
    const { runId, attemptId } = await runAttempt(world, 'rev-a.d.base');
    const claims = await Promise.all([
      claim(world, attemptId, { worker: 'w-1' }),
      claim(world, attemptId, { worker: 'w-2' }),
    ]);
    expect(claims.filter((outcome) => outcome.ok)).toHaveLength(1);
    expect(claims.find((outcome) => !outcome.ok && outcome.failure.code === 'ATTEMPT_NOT_CLAIMABLE')).toBeDefined();
    const completions = await Promise.all([
      complete(world, attemptId, { usage: batchUsage(10) }),
      complete(world, attemptId, { usage: batchUsage(20) }),
    ]);
    expect(completions.filter((outcome) => outcome.ok)).toHaveLength(1);
    expect(await runRow(world, runId)).toMatchObject({ status: 'COMPLETED' });
    // The usage of the winner, and only the winner, was settled: 300 - 10 or 300 - 20 returned.
    const used = await world.sql<{ used: string }>(
      `SELECT used::text AS used FROM reservation_lines WHERE attempt_id = $1`,
      [attemptId],
    );
    expect(['10.00000000', '20.00000000']).toContain(used[0]?.used);
    await world.drop();
  });
});

describe('a lease that expires: recovery fences a new attempt of the same run, up to the cap', () => {
  it('writes the retry with its own reservation and outbox entry, keeps the old reservation until termination is confirmed', async () => {
    const world = await approved();
    const { runId, attemptId } = await runAttempt(world, 'rev-a.v.base');
    await claim(world, attemptId, { leaseSeconds: 60 });
    expect(await batchCommitted(world)).toBe('2100.00000000');
    world.testApp.clock.advanceSeconds(61);
    const expired = await expire(world, attemptId);
    expect(expired.status).toBe('EXPIRED');
    expect(expired.status === 'EXPIRED' && expired.after).toMatchObject({ outcome: 'RETRIED', ownershipRevision: 2 });

    const attempts = await world.sql(
      `SELECT ownership_revision, status, failure_code, ended_at IS NOT NULL AS ended FROM attempts WHERE run_id = $1 ORDER BY ownership_revision`,
      [runId],
    );
    expect(attempts).toEqual([
      { ownership_revision: 1, status: 'LEASE_EXPIRED', failure_code: 'LEASE_EXPIRED', ended: true },
      { ownership_revision: 2, status: 'PENDING', failure_code: null, ended: false },
    ]);
    expect(await world.sql('SELECT status FROM leases WHERE attempt_id = $1', [attemptId])).toEqual([
      { status: 'EXPIRED' },
    ]);
    expect(await runRow(world, runId)).toMatchObject({ status: 'QUEUED', revision: 3 });
    // Nothing is released until the termination of attempt 1 is confirmed; attempt 2 reserves its own 300 seconds.
    expect(await world.sql('SELECT status FROM reservations WHERE attempt_id = $1', [attemptId])).toEqual([
      { status: 'RESERVED' },
    ]);
    expect(await batchCommitted(world)).toBe('2400.00000000');
    // Its outbox message and request name attempt 2, so a redelivery of attempt 1's message cannot authorise attempt 2.
    const next = (await liveAttempt(world, { id: runId })) as string;
    const outbox = await world.sql<{
      status: string;
      message: { attempt: { attempt_id: string; ownership_revision: number } };
      message_digest: string;
    }>('SELECT status, message, message_digest FROM outbox WHERE attempt_id = $1', [next]);
    expect(outbox[0]?.status).toBe('PENDING');
    expect(outbox[0]?.message.attempt).toEqual({ attempt_id: next, ownership_revision: 2 });
    expect(outbox[0]?.message_digest).not.toBe(await dispatchDigestOf(world, attemptId));
    // The host of attempt 1 confirms that it ended, with the 20 seconds it used: 280 of the 300 return.
    const confirmed = await world.tx((tx) =>
      confirmTermination(tx, world.work(ids.workflows), attemptId, batchUsage(20)),
    );
    expect(confirmed.status).toBe('SETTLED');
    expect(await batchCommitted(world)).toBe('2120.00000000');
    await world.drop();
  });

  it('fails the run at the cap of 3, with the code of the cause and no fourth attempt, and keeps every unconfirmed reservation', async () => {
    const world = await approved();
    const { runId } = await runAttempt(world, 'rev-a.d.base');
    let attemptId = (await liveAttempt(world, { id: runId })) as string;
    for (let made = 1; made <= 3; made += 1) {
      expect((await claim(world, attemptId, { leaseSeconds: 60 })).ok).toBe(true);
      world.testApp.clock.advanceSeconds(61);
      const outcome = await expire(world, attemptId);
      if (made < 3) {
        expect(outcome.status === 'EXPIRED' && outcome.after.outcome).toBe('RETRIED');
        attemptId = (await liveAttempt(world, { id: runId })) as string;
      } else {
        expect(outcome.status === 'EXPIRED' && outcome.after).toMatchObject({ outcome: 'FAILED' });
        expect(outcome.status === 'EXPIRED' && outcome.after.outcome === 'FAILED' && outcome.after.reason).toContain(
          'attempt cap of 3',
        );
      }
    }
    expect(await runRow(world, runId)).toMatchObject({ status: 'FAILED', failure_code: 'LEASE_EXPIRED' });
    expect(await liveAttempt(world, { id: runId })).toBeUndefined();
    expect(
      await world.sql(`SELECT ownership_revision, status FROM attempts WHERE run_id = $1 ORDER BY ownership_revision`, [
        runId,
      ]),
    ).toEqual([
      { ownership_revision: 1, status: 'LEASE_EXPIRED' },
      { ownership_revision: 2, status: 'LEASE_EXPIRED' },
      { ownership_revision: 3, status: 'LEASE_EXPIRED' },
    ]);
    // Three unconfirmed reservations of 300 seconds each stay counted (the other four runs hold 4 x 300, the retrieval 600).
    expect(await batchCommitted(world)).toBe('2700.00000000');
    // A failed run is final: nothing moves it.
    await expect(world.sql(`UPDATE runs SET status = 'QUEUED' WHERE run_id = '${runId}'`)).rejects.toMatchObject({
      code: '23514',
    });
    await world.drop();
  });

  it('expires nothing that has not expired, was not claimed, or does not exist', async () => {
    const world = await approved();
    const { attemptId } = await runAttempt(world, 'rev-a.d.base');
    expect((await expire(world, attemptId)).status).toBe('NOT_CLAIMED');
    await claim(world, attemptId, { leaseSeconds: 60 });
    world.testApp.clock.advanceSeconds(59);
    expect((await expire(world, attemptId)).status).toBe('NOT_EXPIRED');
    expect((await expire(world, 'att-none')).status).toBe('UNKNOWN_ATTEMPT');
    await world.drop();
  });
});

describe('which failures are retried', () => {
  it('retries an agent timeout and a malformed result, and ends a refusal, a denied capability, an authentication failure and a cancellation at once', async () => {
    const world = await plannedWorld();
    const cases: [string, 'RETRIED' | 'FAILED'][] = [
      ['timeout', 'RETRIED'],
      ['malformed_result', 'RETRIED'],
      ['refusal', 'FAILED'],
      ['denied_capability', 'FAILED'],
      ['authentication_failure', 'FAILED'],
      ['cancellation', 'FAILED'],
    ];
    for (const [outcome, expected] of cases) {
      const job = await startAgentJob(world, { slot: 'seed' });
      await claim(world, job.attemptId);
      const failed = await fail(world, job.attemptId, { kind: 'AGENT_OUTCOME', outcome: outcome as 'timeout' });
      expect(failed.ok && failed.value.outcome, outcome).toBe(expected);
      const attempts = await world.sql(`SELECT count(*)::int AS n FROM attempts WHERE job_id = $1`, [job.jobId]);
      expect(attempts, outcome).toEqual([{ n: expected === 'RETRIED' ? 2 : 1 }]);
      const row = await world.sql(`SELECT status, failure_code FROM jobs WHERE job_id = $1`, [job.jobId]);
      expect(row, outcome).toEqual([
        expected === 'RETRIED'
          ? { status: 'QUEUED', failure_code: null }
          : { status: 'FAILED', failure_code: `AGENT_${outcome.toUpperCase()}` },
      ]);
      expect(
        await world.sql(`SELECT agent_outcome FROM attempts WHERE attempt_id = $1`, [job.attemptId]),
        outcome,
      ).toEqual([{ agent_outcome: outcome }]);
    }
    await world.drop();
  });

  it('never retries EGRESS_REFUSED: the retrieval job fails at the first attempt, below the cap, even if the host marks it retryable', async () => {
    const world = await startedWorld();
    const { jobId, attemptId } = world.retrieve;
    await claim(world, attemptId);
    const failed = await fail(
      world,
      attemptId,
      { kind: 'RETRIEVAL', errorClass: 'EGRESS_REFUSED', retryable: true },
      {
        usage: {
          PROVIDER_REQUESTS: { label: 'observed', amount: '0' },
          BATCH_COMPUTE_SECONDS: { label: 'observed', amount: '2' },
        },
      },
    );
    expect(failed.ok && failed.value.outcome).toBe('FAILED');
    expect(await world.sql('SELECT status, failure_code FROM jobs WHERE job_id = $1', [jobId])).toEqual([
      { status: 'FAILED', failure_code: 'RETRIEVAL_EGRESS_REFUSED' },
    ]);
    expect(
      await world.sql('SELECT ownership_revision, status, failure_code FROM attempts WHERE job_id = $1', [jobId]),
    ).toEqual([{ ownership_revision: 1, status: 'FAILED', failure_code: 'RETRIEVAL_EGRESS_REFUSED' }]);
    // No new reservation and no outbox entry for a second attempt: the failure is final. The mission cannot go on without
    // its data, so it is BLOCKED with the reason, and an attention item shows it to an operator.
    expect(await world.sql('SELECT 1 FROM outbox')).toHaveLength(1);
    expect(await world.sql('SELECT status FROM missions')).toEqual([{ status: 'BLOCKED' }]);
    expect(await world.sql('SELECT subject FROM attention_items')).toEqual([{ subject: `retrieve job ${jobId}` }]);
    await world.drop();
  });

  it('applies the classes of retrieval failure: never for authentication, permission, unsupported capability, cancellation and egress; a flag decides the rest', async () => {
    const cases: [string, boolean, 'RETRIED' | 'FAILED'][] = [
      ['AUTHENTICATION', true, 'FAILED'],
      ['PERMISSION', true, 'FAILED'],
      ['UNSUPPORTED_CAPABILITY', true, 'FAILED'],
      ['CANCELLED', true, 'FAILED'],
      ['EGRESS_REFUSED', true, 'FAILED'],
      ['RATE_LIMITED', true, 'RETRIED'],
      ['TIMEOUT', true, 'RETRIED'],
      ['UNAVAILABLE_DATA', true, 'RETRIED'],
      ['MALFORMED_RESPONSE', true, 'RETRIED'],
      ['RATE_LIMITED', false, 'FAILED'],
      ['TIMEOUT', false, 'FAILED'],
    ];
    for (const [errorClass, retryable, expected] of cases) {
      const world = await startedWorld();
      await claim(world, world.retrieve.attemptId);
      const failed = await fail(
        world,
        world.retrieve.attemptId,
        { kind: 'RETRIEVAL', errorClass: errorClass as 'TIMEOUT', retryable },
        { usage: batchUsage(5) },
      );
      expect(failed.ok && failed.value.outcome, `${errorClass} retryable=${retryable}`).toBe(expected);
      await world.drop();
    }
  });

  it('retries a worker failure only when the host marks it retryable', async () => {
    for (const [retryable, expected] of [
      [true, 'RETRIED'],
      [false, 'FAILED'],
    ] as const) {
      const world = await startedWorld();
      await claim(world, world.retrieve.attemptId);
      const failed = await fail(
        world,
        world.retrieve.attemptId,
        { kind: 'WORKER_FAILURE', code: 'DISK_FULL', retryable },
        { usage: batchUsage(5) },
      );
      expect(failed.ok && failed.value.outcome).toBe(expected);
      if (expected === 'FAILED')
        expect(await world.sql('SELECT failure_code FROM jobs')).toEqual([{ failure_code: 'DISK_FULL' }]);
      await world.drop();
    }
  });
});

describe('a retry that no budget covers', () => {
  it('leaves the job QUEUED with no live attempt, the mission BLOCKED with the reason, and only cancel_mission ends it', async () => {
    // 1,300 batch seconds hold two retrievals of 600: the third attempt cannot be reserved.
    const world = await startedWorld({ mission: (mission) => (mission.budget.batch_compute_seconds = 1300) });
    const { jobId } = world.retrieve;
    let attemptId = world.retrieve.attemptId;
    for (let made = 1; made <= 2; made += 1) {
      expect((await claim(world, attemptId, { leaseSeconds: 60 })).ok).toBe(true);
      world.testApp.clock.advanceSeconds(61);
      const outcome = await expire(world, attemptId);
      if (made === 1) {
        expect(outcome.status === 'EXPIRED' && outcome.after.outcome).toBe('RETRIED');
        attemptId = (await liveAttempt(world, { id: jobId })) as string;
      } else {
        expect(outcome.status === 'EXPIRED' && outcome.after.outcome).toBe('WAITING');
      }
    }
    // The job waits QUEUED, no attempt is live, the old reservations are held, the reason says what ran out.
    const job = await world.sql<{ status: string; waiting_reason: string | null; completed_at: Date | null }>(
      'SELECT status, waiting_reason, completed_at FROM jobs WHERE job_id = $1',
      [jobId],
    );
    expect(job[0]?.status).toBe('QUEUED');
    expect(job[0]?.completed_at).toBeNull();
    expect(job[0]?.waiting_reason).toContain('BATCH_COMPUTE_SECONDS');
    expect(job[0]?.waiting_reason).toContain('100.00000000 is left');
    expect(await liveAttempt(world, { id: jobId })).toBeUndefined();
    expect(await world.sql(`SELECT count(*)::int AS n FROM attempts WHERE job_id = $1`, [jobId])).toEqual([{ n: 2 }]);
    const mission = await world.sql<{ status: string; blocked_reason: string }>(
      'SELECT status, blocked_reason FROM missions',
    );
    expect(mission[0]?.status).toBe('BLOCKED');
    expect(mission[0]?.blocked_reason).toBe(job[0]?.waiting_reason);
    // Confirming the first termination returns seconds to the pool, and still resumes nothing: no command raises or
    // re-opens a budget in S1.
    await world.tx((tx) =>
      confirmTermination(tx, world.work(ids.workflows), world.retrieve.attemptId, batchUsage(100)),
    );
    expect(await world.sql('SELECT status FROM jobs')).toEqual([{ status: 'QUEUED' }]);
    expect(await world.sql('SELECT status FROM missions')).toEqual([{ status: 'BLOCKED' }]);
    expect(await liveAttempt(world, { id: jobId })).toBeUndefined();
    // The one way out is withdrawal: the waiting job is CANCELLED, with nothing live to release.
    const revision = await missionRevision(world);
    const cancelled = await world.apply(
      'researcher',
      { kind: 'cancel_mission', mission_id: world.records.missionId, reason: 'Out of budget.' },
      { expectedRevision: revision },
    );
    expect(cancelled.state).toBe('APPLIED');
    expect(await world.sql('SELECT status, waiting_reason FROM jobs')).toEqual([
      { status: 'CANCELLED', waiting_reason: null },
    ]);
    expect(await world.sql('SELECT status FROM missions')).toEqual([{ status: 'WITHDRAWN' }]);
    await world.drop();
  });

  it('writes no attempt when the mission is already BLOCKED: a retry needs available budget like a first attempt', async () => {
    const world = await plannedWorld();
    const job = await startAgentJob(world, { slot: 'seed' });
    const other = await startAgentJob(world, { slot: 'rev-a' });
    await claim(world, other.attemptId);
    // An overrun of the other attempt blocks the mission.
    await complete(world, other.attemptId, {
      usage: {
        MODEL_SPEND: { label: 'observed', amount: '9' },
        AGENT_COMPUTE_SECONDS: { label: 'observed', amount: '10' },
      },
    });
    expect(await world.sql('SELECT status FROM missions')).toEqual([{ status: 'BLOCKED' }]);
    await claim(world, job.attemptId);
    const failed = await fail(world, job.attemptId, { kind: 'AGENT_OUTCOME', outcome: 'timeout' });
    expect(failed.ok && failed.value.outcome).toBe('WAITING');
    expect(await liveAttempt(world, { id: job.jobId })).toBeUndefined();
    expect(await world.sql('SELECT status FROM jobs WHERE job_id = $1', [job.jobId])).toEqual([{ status: 'QUEUED' }]);
    await world.drop();
  });
});

describe('cancel_mission against attempts in flight', () => {
  it('cancels a CLAIMED attempt and keeps its reservation until termination is confirmed, and releases the pending ones', async () => {
    const world = await approved();
    const claimed = await runAttempt(world, 'rev-a.d.base');
    await claim(world, claimed.attemptId);
    const revision = await missionRevision(world);
    const outcome = await world.apply(
      'researcher',
      { kind: 'cancel_mission', mission_id: world.records.missionId, reason: 'Stop.' },
      { expectedRevision: revision },
    );
    expect(outcome.state).toBe('APPLIED');
    // The claimed attempt: CANCELLED, lease RELEASED, reservation still RESERVED (the worker may still be running).
    expect(await world.sql('SELECT status FROM attempts WHERE attempt_id = $1', [claimed.attemptId])).toEqual([
      { status: 'CANCELLED' },
    ]);
    expect(await world.sql('SELECT status FROM leases WHERE attempt_id = $1', [claimed.attemptId])).toEqual([
      { status: 'RELEASED' },
    ]);
    expect(await world.sql('SELECT status FROM reservations WHERE attempt_id = $1', [claimed.attemptId])).toEqual([
      { status: 'RESERVED' },
    ]);
    // The four pending attempts: CANCELLED, RELEASED, their outbox entries CANCELLED.
    const pending = await world.sql(
      `SELECT a.status AS attempt, r.status AS reservation, o.status AS outbox FROM attempts a
         JOIN reservations r ON r.attempt_id = a.attempt_id JOIN outbox o ON o.attempt_id = a.attempt_id
        WHERE a.run_id IS NOT NULL AND a.attempt_id <> $1`,
      [claimed.attemptId],
    );
    expect(pending).toHaveLength(4);
    for (const row of pending)
      expect(row).toEqual({ attempt: 'CANCELLED', reservation: 'RELEASED', outbox: 'CANCELLED' });
    expect(await world.sql(`SELECT DISTINCT status FROM runs`)).toEqual([{ status: 'CANCELLED' }]);
    // 600 (retrieval, released) + 4 x 300 released; the claimed run's 300 stays: 300 committed.
    expect(await batchCommitted(world)).toBe('300.00000000');
    // A later submission from the cancelled attempt is rejected and changes nothing.
    const late = await complete(world, claimed.attemptId, { usage: batchUsage(10) });
    expect(late.ok === false && late.failure.code).toBe('ATTEMPT_NOT_CLAIMABLE');
    expect(late.ok === false && late.failure.message).toContain('CANCELLED');
    // Termination is confirmed with the usage that its host measured: 240 of the 300 return.
    const confirmed = await world.tx((tx) =>
      confirmTermination(tx, world.work(ids.workflows), claimed.attemptId, batchUsage(60)),
    );
    expect(confirmed.status).toBe('SETTLED');
    expect(await batchCommitted(world)).toBe('60.00000000');
    await world.drop();
  });

  it('lets a result that committed first win: the completed run stays COMPLETED and the others are cancelled', async () => {
    const world = await approved();
    const done = await runAttempt(world, 'rev-a.v.base');
    await claim(world, done.attemptId);
    expect((await complete(world, done.attemptId, { usage: batchUsage() })).ok).toBe(true);
    const revision = await missionRevision(world);
    await world.apply(
      'researcher',
      { kind: 'cancel_mission', mission_id: world.records.missionId, reason: 'Stop.' },
      { expectedRevision: revision },
    );
    expect(await runRow(world, done.runId)).toMatchObject({ status: 'COMPLETED' });
    expect(await world.sql(`SELECT status, count(*)::int AS n FROM runs GROUP BY status ORDER BY status`)).toEqual([
      { status: 'CANCELLED', n: 4 },
      { status: 'COMPLETED', n: 1 },
    ]);
    await world.drop();
  });

  it('rejects a completion that comes after the cancellation committed', async () => {
    const world = await approved();
    const target = await runAttempt(world, 'rev-a.v.base');
    await claim(world, target.attemptId);
    const revision = await missionRevision(world);
    await world.apply(
      'researcher',
      { kind: 'cancel_mission', mission_id: world.records.missionId, reason: 'Stop.' },
      { expectedRevision: revision },
    );
    const late = await complete(world, target.attemptId, { usage: batchUsage() });
    expect(late.ok === false && late.failure.code).toBe('ATTEMPT_NOT_CLAIMABLE');
    expect(await runRow(world, target.runId)).toMatchObject({ status: 'CANCELLED' });
    await world.drop();
  });
});

/** A database whose first lock on the mission row holds until released: it parks the transaction that took it. */
function parkAfterMissionLock(db: Database) {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let locked: () => void = () => undefined;
  const hasLock = new Promise<void>((resolve) => {
    locked = resolve;
  });
  let parked = false;
  const wrapped: Database = {
    query: ((text: string, values?: readonly unknown[]) => db.query(text, values)) as Database['query'],
    close: () => db.close(),
    transaction: (work) =>
      db.transaction((tx) =>
        work({
          query: (async (text: string, values?: readonly unknown[]) => {
            const result = await tx.query(text, values);
            if (!parked && /FROM missions WHERE mission_id = \$1 FOR UPDATE/.test(text)) {
              parked = true;
              locked();
              await gate;
            }
            return result;
          }) as Queryable['query'],
        }),
      ),
  };
  return { db: wrapped, hasLock, release };
}

const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

describe('cancel versus complete, concurrently: whichever commits first wins, and the other sees it', () => {
  it('a completion holding the mission lock makes the cancellation wait, and the completed run stays COMPLETED', async () => {
    const world = await approved();
    const target = await runAttempt(world, 'rev-a.d.base');
    await claim(world, target.attemptId);
    const completing = parkAfterMissionLock(world.testApp.env.database());
    const finishing = completing.db.transaction((tx) =>
      completeAttempt(tx, world.work(ids.batch), {
        attemptId: target.attemptId,
        ownershipRevision: 1,
        workStatus: 'COMPLETED',
        usage: batchUsage(),
      }),
    );
    await completing.hasLock;
    let cancelled = false;
    const revision = await missionRevision(world);
    const cancelling = world
      .apply(
        'researcher',
        { kind: 'cancel_mission', mission_id: world.records.missionId, reason: 'Stop.' },
        { expectedRevision: revision },
      )
      .then((outcome) => {
        cancelled = true;
        return outcome;
      });
    await sleep(300);
    expect(cancelled, 'the cancellation waits for the mission lock').toBe(false);
    completing.release();
    const [result, outcome] = await Promise.all([finishing, cancelling]);
    expect(result.ok).toBe(true);
    // The cancellation saw a run that had ended, and left it as it was.
    expect(outcome.state).toBe('APPLIED');
    expect(await runRow(world, target.runId)).toMatchObject({ status: 'COMPLETED' });
    expect(await world.sql('SELECT status FROM missions')).toEqual([{ status: 'WITHDRAWN' }]);
    expect(await world.sql('SELECT status FROM attempts WHERE attempt_id = $1', [target.attemptId])).toEqual([
      { status: 'COMPLETED' },
    ]);
    await world.drop();
  });

  it('a cancellation holding the mission lock makes the completion wait, and the completion is rejected', async () => {
    const world = await approved();
    const target = await runAttempt(world, 'rev-a.d.base');
    await claim(world, target.attemptId);
    const cancelling = parkAfterMissionLock(world.testApp.env.database());
    const revision = await missionRevision(world);
    const cancel = executeCommand(
      { env: world.testApp.env, db: cancelling.db, actor: actorOf('researcher'), builders: world.builders },
      world.command(
        { kind: 'cancel_mission', mission_id: world.records.missionId, reason: 'Stop.' },
        { expectedRevision: revision },
      ) as never,
    );
    await cancelling.hasLock;
    let finished = false;
    const completing = complete(world, target.attemptId, { usage: batchUsage() }).then((outcome) => {
      finished = true;
      return outcome;
    });
    await sleep(300);
    expect(finished, 'the completion waits for the mission lock').toBe(false);
    cancelling.release();
    const [outcome, result] = await Promise.all([cancel, completing]);
    expect(outcome.state).toBe('APPLIED');
    expect(result.ok === false && result.failure.code).toBe('ATTEMPT_NOT_CLAIMABLE');
    expect(await runRow(world, target.runId)).toMatchObject({ status: 'CANCELLED' });
    await world.drop();
  });
});

describe('execution switched off', () => {
  it('refuses a claim with EXECUTION_DISABLED before it reads or writes anything', async () => {
    const world = await approved();
    const { attemptId } = await runAttempt(world, 'rev-a.d.base');
    const before = await world.snapshot();
    const disabled = { ...world.testApp.env, researchExecution: false };
    const dispatchDigest = await dispatchDigestOf(world, attemptId);
    const outcome = await world.tx((tx) =>
      claimAttempt(
        tx,
        { env: disabled, actorId: ids.batch, builders: world.builders },
        {
          attemptId,
          ownershipRevision: 1,
          dispatchDigest,
          workerId: 'worker-1',
          executable: { name: 'engine-batch', version: '0.0.0', digest: sha('engine-batch') },
          leaseExpiresAt: new Date('2026-11-15T10:15:00Z'),
          capabilityHash: sha('capability'),
        },
      ),
    );
    expect(outcome.ok === false && outcome.failure.code).toBe('EXECUTION_DISABLED');
    expect(await world.snapshot()).toEqual(before);
    await world.drop();
  });
});

describe('recovery reconciles a reservation that nothing reported', () => {
  it('settles it from a later report, returns the unused part, and turns an overrun into a BLOCKED mission', async () => {
    const world = await plannedWorld();
    const job = await startAgentJob(world, { slot: 'seed' });
    await claim(world, job.attemptId);
    const done = await complete(world, job.attemptId, { usage: {} });
    expect(done.ok && done.value.settled).toBe('UNRECONCILED');
    // Still counted as spent in full.
    const critic = () =>
      world.sql<{ committed: string; overrun: string }>(
        `SELECT committed::text AS committed, overrun::text AS overrun FROM budget_pools WHERE configuration_id = 'critic' AND mission_id = $1`,
        [world.records.missionId],
      );
    expect((await critic())[0]).toEqual({ committed: '5.00000000', overrun: '0.00000000' });
    const reconcile = (usage: Parameters<typeof reconcileReservation>[3]) =>
      world.tx((tx) => reconcileReservation(tx, world.work(ids.workflows), job.attemptId, usage));
    // A report that leaves a line unknown changes nothing yet.
    expect((await reconcile({ MODEL_SPEND: { label: 'unknown' } })).status).toBe('UNRECONCILED');
    // The report arrives with a spend of 8 USD against a reservation of 5, and 100 seconds of compute.
    const settled = await reconcile({
      MODEL_SPEND: { label: 'estimated', amount: '8' },
      AGENT_COMPUTE_SECONDS: { label: 'observed', amount: '100' },
    });
    expect(settled.status).toBe('SETTLED');
    expect((await critic())[0]).toEqual({ committed: '5.00000000', overrun: '3.00000000' });
    expect(await world.sql('SELECT status, blocked_reason FROM missions')).toEqual([
      { status: 'BLOCKED', blocked_reason: expect.stringContaining('went over its reservation by 3.00000000') },
    ]);
    expect((await reconcile({ MODEL_SPEND: { label: 'observed', amount: '1' } })).status).toBe('UNCHANGED');
    expect(
      await world.sql(`SELECT count(*)::int AS n FROM audit_events WHERE event_type = 'reservation.reconciled'`),
    ).toEqual([{ n: 2 }]);
    await world.drop();
  });

  it('refuses an attempt that has not ended, and one that does not exist', async () => {
    const world = await plannedWorld();
    const job = await startAgentJob(world, { slot: 'seed' });
    await expect(
      world.tx((tx) => reconcileReservation(tx, world.work(ids.workflows), job.attemptId, {})),
    ).rejects.toMatchObject({ code: 'ATTEMPT_NOT_CLAIMABLE' });
    await expect(
      world.tx((tx) => reconcileReservation(tx, world.work(ids.workflows), 'att-none', {})),
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await world.drop();
  });
});

describe('the dispatch outbox', () => {
  it('is sent once, under the same attempt, and never after the attempt was cancelled', async () => {
    const world = await approved();
    const first = await runAttempt(world, 'rev-a.d.base');
    const second = await runAttempt(world, 'rev-a.d.stress');
    const send = (attemptId: string) => world.tx((tx) => markOutboxSent(tx, world.testApp.env, attemptId));
    expect(await send(first.attemptId)).toBe('SENT');
    expect(
      await world.sql('SELECT status, sent_at IS NOT NULL AS sent FROM outbox WHERE attempt_id = $1', [
        first.attemptId,
      ]),
    ).toEqual([{ status: 'SENT', sent: true }]);
    expect(await send(first.attemptId)).toBe('ALREADY_SENT');
    expect(await send('att-none')).toBe('UNKNOWN_ATTEMPT');
    const revision = await missionRevision(world);
    await world.apply(
      'researcher',
      { kind: 'cancel_mission', mission_id: world.records.missionId, reason: 'Stop.' },
      { expectedRevision: revision },
    );
    expect(await send(second.attemptId)).toBe('CANCELLED');
    // The message that was already sent stays SENT: the worker's claim of a cancelled attempt is refused instead.
    expect(await world.sql('SELECT status FROM outbox WHERE attempt_id = $1', [first.attemptId])).toEqual([
      { status: 'SENT' },
    ]);
    const late = await claim(world, first.attemptId);
    expect(late.ok === false && late.failure.code).toBe('ATTEMPT_NOT_CLAIMABLE');
    await world.drop();
  });
});

describe('compare-and-set on the mission revision', () => {
  it('applies one of two commands that expect the same revision, and refuses the other with the current revision', async () => {
    const world = await startedWorld();
    // Two Researchers' commands race to cancel the same mission at the same revision.
    const revision = await missionRevision(world);
    const payload = { kind: 'cancel_mission', mission_id: world.records.missionId, reason: 'Stop.' };
    const outcomes = await Promise.all([
      world.apply('researcher', payload, { expectedRevision: revision }),
      world.apply('researcher', payload, { expectedRevision: revision }),
    ]);
    expect(outcomes.filter((outcome) => outcome.state === 'APPLIED')).toHaveLength(1);
    const refused = outcomes.find((outcome) => outcome.state === 'REJECTED');
    expect(refused?.state === 'REJECTED' && refused.status.error.code).toBe('REVISION_CONFLICT');
    expect(await world.sql('SELECT status, revision FROM missions')).toEqual([
      { status: 'WITHDRAWN', revision: revision + 1 },
    ]);
    await world.drop();
  });

  it('refuses the second of two concurrent registrations of one revision of a record, for want of the expected revision', async () => {
    const world = await startedWorld();
    const budget = structuredClone(world.docs.budget) as {
      revision: number;
      budget_id: string;
      model_spend: { amount: string };
    };
    budget.revision = 2;
    budget.model_spend.amount = '300.00';
    const outcomes = await Promise.all(
      [1, 2].map(() => world.apply('steward', { kind: 'register_budget', budget }, { expectedRevision: 1 })),
    );
    expect(outcomes.filter((outcome) => outcome.state === 'APPLIED')).toHaveLength(1);
    const refused = outcomes.find((outcome) => outcome.state === 'REJECTED');
    expect(refused?.state === 'REJECTED' && refused.status.error.code).toBe('REVISION_CONFLICT');
    expect(await world.sql('SELECT revision FROM budget_caps ORDER BY revision')).toEqual([
      { revision: 1 },
      { revision: 2 },
    ]);
    // The new revision enlarged the cap and kept what the mission already holds.
    expect(
      await world.sql(
        `SELECT dimension, limit_amount::text AS lim, committed::text AS committed, budget_revision FROM budget_pools WHERE scope = 'PERIOD' ORDER BY dimension`,
      ),
    ).toEqual([
      { dimension: 'MODEL_SPEND', lim: '300.00000000', committed: '105.00000000', budget_revision: 2 },
      { dimension: 'PROVIDER_REQUESTS', lim: '120.00000000', committed: '60.00000000', budget_revision: 2 },
    ]);
    await world.drop();
  });
});

describe('a job and its attempts at the transaction boundary', () => {
  it('writes the attempt, its reservation and its outbox entry together or not at all', async () => {
    const world = await plannedWorld();
    const before = await world.snapshot();
    await expect(
      world.tx(async (tx) => {
        const job = await insertJob(tx, world.testApp.env, {
          missionId: world.records.missionId as string,
          kind: 'agent',
          attemptCap: 3,
          configurationId: 'critic',
          agentRole: 'CRITIC',
        });
        const opened = await openAttempt(tx, world.work(), job);
        expect(opened.ok).toBe(true);
        throw new Error('the connection fails before commit');
      }),
    ).rejects.toThrow('before commit');
    expect(await world.snapshot()).toEqual(before);
    // The same writes, committed with the outbox row left out, are refused by the database at commit.
    await expect(
      world.tx(async (tx) => {
        await tx.query(
          `INSERT INTO jobs (job_id, kind, mission_id, agent_role, configuration_id, attempt_cap, created_at) VALUES ('job-x', 'agent', $1, 'CRITIC', 'critic', 3, now())`,
          [world.records.missionId],
        );
        await tx.query(
          `INSERT INTO attempts (attempt_id, job_id, ownership_revision, attempt_cap, created_at) VALUES ('att-x', 'job-x', 1, 3, now())`,
        );
      }),
    ).rejects.toMatchObject({ constraint: 'attempts_have_reservation_and_outbox' });
    expect(await world.snapshot()).toEqual(before);
    await world.drop();
  });

  it('refuses to build a message for work that this part has no builder for, instead of sending an empty one', async () => {
    const world = await plannedWorld();
    await expect(
      world.tx(async (tx) => {
        const job = await insertJob(tx, world.testApp.env, {
          missionId: world.records.missionId as string,
          kind: 'validate',
          attemptCap: 3,
        });
        return openAttempt(tx, world.work(), job);
      }),
    ).rejects.toThrow(/builds no dispatch message for validate/);
    await world.drop();
  });
});

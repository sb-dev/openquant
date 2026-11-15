// Helpers that drive attempts through the guarded functions, in their own transactions as a worker and the recovery do:
// create a job of an agent, claim an attempt as a worker would, complete it, fail it, and finish every run of a slot.

import {
  type Claimed,
  type Completed,
  claimAttempt,
  completeAttempt,
  type FailureReport,
  failAttempt,
  type Guarded,
  openAttempt,
} from '../../src/domain/attempts.ts';
import type { UsageReport } from '../../src/domain/budget.ts';
import { insertJob, type Work } from '../../src/domain/work.ts';
import { ids, sha } from './seed.ts';
import type { World } from './world.ts';

export interface AgentJob {
  readonly jobId: string;
  readonly attemptId: string;
}

/** A logical run of an agent for a trial slot (the critic by default) with its first attempt. */
export async function startAgentJob(
  world: World,
  options: { slot?: string | undefined; configuration?: string; role?: 'PROPOSER' | 'CRITIC' } = {},
): Promise<AgentJob> {
  const missionId = world.records.missionId as string;
  const role = options.role ?? 'CRITIC';
  return world.tx(async (tx) => {
    const job = await insertJob(tx, world.testApp.env, {
      missionId,
      kind: 'agent',
      attemptCap: 3,
      configurationId: options.configuration ?? (role === 'CRITIC' ? 'critic' : 'proposer-a'),
      agentRole: role,
      ...(options.slot === undefined ? {} : { trialSlot: options.slot }),
    });
    const opened = await openAttempt(tx, world.work(), job);
    if (!opened.ok) throw new Error(`The agent attempt was not reserved: ${opened.reason}`);
    return { jobId: job.id, attemptId: opened.attemptId };
  });
}

/** The digest of the dispatch message of an attempt, which a worker claims with. */
export async function dispatchDigestOf(world: World, attemptId: string): Promise<string> {
  const rows = await world.sql<{ message_digest: string }>('SELECT message_digest FROM outbox WHERE attempt_id = $1', [
    attemptId,
  ]);
  return rows[0]?.message_digest as string;
}

export interface ClaimOptions {
  readonly ownershipRevision?: number;
  readonly leaseSeconds?: number;
  readonly dispatchDigest?: string;
  readonly worker?: string;
}

export async function claim(world: World, attemptId: string, options: ClaimOptions = {}): Promise<Guarded<Claimed>> {
  const revision =
    options.ownershipRevision ??
    (
      await world.sql<{ ownership_revision: number }>('SELECT ownership_revision FROM attempts WHERE attempt_id = $1', [
        attemptId,
      ])
    )[0]?.ownership_revision ??
    1;
  const dispatchDigest = options.dispatchDigest ?? (await dispatchDigestOf(world, attemptId));
  const expires = new Date(world.testApp.clock.now().getTime() + (options.leaseSeconds ?? 900) * 1000);
  return world.tx((tx) =>
    claimAttempt(tx, world.work(ids.batch), {
      attemptId,
      ownershipRevision: revision,
      dispatchDigest,
      workerId: options.worker ?? 'worker-1',
      executable: { name: 'engine-batch', version: '0.0.0', digest: sha('engine-batch') },
      leaseExpiresAt: expires,
      capabilityHash: sha(`capability-${attemptId}`),
    }),
  );
}

export async function revisionOf(world: World, attemptId: string): Promise<number> {
  const rows = await world.sql<{ ownership_revision: number }>(
    'SELECT ownership_revision FROM attempts WHERE attempt_id = $1',
    [attemptId],
  );
  return rows[0]?.ownership_revision as number;
}

export async function complete(
  world: World,
  attemptId: string,
  options: {
    ownershipRevision?: number;
    workStatus?: 'COMPLETED' | 'FAILED';
    failureCode?: string;
    usage?: UsageReport;
  } = {},
): Promise<Guarded<Completed>> {
  const revision = options.ownershipRevision ?? (await revisionOf(world, attemptId));
  return world.tx((tx) =>
    completeAttempt(tx, world.work(ids.batch), {
      attemptId,
      ownershipRevision: revision,
      workStatus: options.workStatus ?? 'COMPLETED',
      ...(options.failureCode === undefined ? {} : { failureCode: options.failureCode }),
      usage: options.usage ?? {},
    }),
  );
}

export async function fail(
  world: World,
  attemptId: string,
  cause: FailureReport['cause'],
  options: { ownershipRevision?: number; usage?: UsageReport } = {},
) {
  const revision = options.ownershipRevision ?? (await revisionOf(world, attemptId));
  return world.tx((tx) =>
    failAttempt(tx, world.work(ids.batch), {
      attemptId,
      ownershipRevision: revision,
      cause,
      usage: options.usage ?? {},
    }),
  );
}

/** The live attempt of a run or job, if it has one. */
export async function liveAttempt(world: World, work: Pick<Work, 'id'> | { id: string }): Promise<string | undefined> {
  const rows = await world.sql<{ attempt_id: string }>(
    `SELECT attempt_id FROM attempts WHERE (run_id = $1 OR job_id = $1) AND status IN ('PENDING', 'CLAIMED')`,
    [work.id],
  );
  return rows[0]?.attempt_id;
}

/** The usage of one batch attempt that took 100 seconds. */
export const batchUsage = (seconds = 100): UsageReport => ({
  BATCH_COMPUTE_SECONDS: { label: 'observed', amount: String(seconds) },
});

/** Claim and complete the live attempt of every run of a slot that is still open, as workers would. */
export async function finishRuns(
  world: World,
  slot: string,
  workStatus: 'COMPLETED' | 'FAILED' = 'COMPLETED',
): Promise<number> {
  const runs = await world.sql<{ run_id: string }>(
    `SELECT run_id FROM runs WHERE mission_id = $1 AND trial_slot = $2 AND status IN ('QUEUED', 'RUNNING') ORDER BY run_id`,
    [world.records.missionId, slot],
  );
  for (const run of runs) {
    const attemptId = await liveAttempt(world, { id: run.run_id });
    if (attemptId === undefined) throw new Error(`The run ${run.run_id} has no live attempt.`);
    const claimed = await claim(world, attemptId);
    if (!claimed.ok) throw claimed.failure;
    const done = await complete(world, attemptId, {
      workStatus,
      ...(workStatus === 'FAILED' ? { failureCode: 'INVALID_LEVEL' } : {}),
      usage: batchUsage(),
    });
    if (!done.ok) throw done.failure;
  }
  return runs.length;
}

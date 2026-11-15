// Attempts, leases, the dispatch outbox and their reservations: the guarded functions behind OQ-05 section 4. Each
// function is one row of the transition table, written in one transaction with its audit record by the caller's
// transaction. Their shared rules:
//
//   - fencing: only the current owner commits. An attempt holds an ownership revision, fixed when it is created, and a
//     lease. A submission, a failure report or a claim from any other attempt, from one whose lease ended, or from one
//     that was cancelled or already ended is refused with the typed 409, its rejection is recorded and nothing else
//     changes (LEASE_EXPIRED, or STALE_OWNERSHIP once a newer attempt of the same run or job exists);
//   - compare-and-set: every status change of a run, job or mission checks its revision (work.ts, missions.ts);
//   - lock order: mission, run or job, attempt, budget pools. A cancellation and a completion of the same mission
//     therefore queue behind each other, and whichever commits first wins (OQ-05 section 4, `cancel_mission`);
//   - a retry is a new attempt with its own reservation and outbox row. It is written only when the budget and the
//     attempt cap allow it. Otherwise the run or job waits QUEUED with no live attempt and the mission is BLOCKED with
//     the reason, and only cancel_mission ends that.

import { digest } from '@openquant/api-contracts';
import { writeAudit } from '../audit.ts';
import type { Queryable } from '../db/database.ts';
import type { ApiEnv } from '../env.ts';
import { ApiFailure } from '../errors.ts';
import {
  type AgentAllowanceCheck,
  commitReservation,
  type Need,
  planReservation,
  releaseReservation,
  settleReservation,
  type UsageReport,
} from './budget.ts';
import { type Binding, builderFor, type DispatchBuilders, retrievalRequestCap } from './dispatch.ts';
import { loadPolicy } from './documents.ts';
import { blockMission } from './missions.ts';
import { classify, type FailureCause } from './retry.ts';
import { findMission, loadMissionBudget, lockMission, type MissionRow } from './rows.ts';
import { assertTransition } from './transitions.ts';
import { findWork, lockOpenWork, setWaitingReason, setWorkStatus, type Work, workOfAttempt } from './work.ts';

export interface WorkContext {
  readonly env: ApiEnv;
  /** The principal that the audit rows and stored requests of the call are recorded under. */
  readonly actorId: string;
  readonly builders: DispatchBuilders;
}

/** A guarded function answers with the typed refusal as data, so the refusal can be recorded in its transaction. */
export type Guarded<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly failure: ApiFailure };

export interface AttemptRow {
  readonly attempt_id: string;
  readonly run_id: string | null;
  readonly job_id: string | null;
  readonly ownership_revision: number;
  readonly attempt_cap: number;
  readonly status: 'PENDING' | 'CLAIMED' | 'COMPLETED' | 'FAILED' | 'LEASE_EXPIRED' | 'CANCELLED';
  readonly failure_code: string | null;
  readonly agent_outcome: string | null;
  readonly worker_id: string | null;
  readonly claimed_at: Date | null;
}

interface LeaseRow {
  readonly status: 'HELD' | 'RELEASED' | 'EXPIRED';
  readonly expires_at: Date;
}

const ATTEMPT_COLUMNS = `attempt_id, run_id, job_id, ownership_revision, attempt_cap, status, failure_code,
  agent_outcome, worker_id, claimed_at`;

async function lockAttempt(tx: Queryable, attemptId: string): Promise<AttemptRow | undefined> {
  const { rows } = await tx.query<AttemptRow>(
    `SELECT ${ATTEMPT_COLUMNS} FROM attempts WHERE attempt_id = $1 FOR UPDATE`,
    [attemptId],
  );
  return rows[0];
}

async function leaseOf(tx: Queryable, attemptId: string): Promise<LeaseRow | undefined> {
  const { rows } = await tx.query<LeaseRow>('SELECT status, expires_at FROM leases WHERE attempt_id = $1 FOR UPDATE', [
    attemptId,
  ]);
  return rows[0];
}

async function newerAttemptExists(tx: Queryable, attempt: AttemptRow): Promise<boolean> {
  const { rows } = await tx.query(
    `SELECT 1 FROM attempts
      WHERE ownership_revision > $3 AND ((run_id IS NOT NULL AND run_id = $1) OR (job_id IS NOT NULL AND job_id = $2))
      LIMIT 1`,
    [attempt.run_id, attempt.job_id, attempt.ownership_revision],
  );
  return rows.length > 0;
}

export interface Located {
  readonly mission: MissionRow;
  readonly work: Work;
  readonly attempt: AttemptRow;
}

/**
 * Lock the mission, the run or job and the attempt, in that order, and read them again under the locks. Undefined when
 * the attempt does not exist.
 */
export async function locate(tx: Queryable, attemptId: string): Promise<Located | undefined> {
  const unlocked = await workOfAttempt(tx, attemptId);
  if (unlocked === undefined) return undefined;
  const mission = await lockMission(tx, unlocked.missionId);
  const work = await findWork(tx, unlocked.kind, unlocked.id, true);
  const attempt = await lockAttempt(tx, attemptId);
  if (work === undefined || attempt === undefined) return undefined;
  return { mission, work, attempt };
}

/** The refusal of a call that does not come from the live owner of its attempt, or undefined when it does. */
async function fenceFailure(
  tx: Queryable,
  env: Pick<ApiEnv, 'clock'>,
  attempt: AttemptRow,
  ownershipRevision: number,
): Promise<ApiFailure | undefined> {
  if (attempt.ownership_revision !== ownershipRevision) {
    return new ApiFailure('STALE_OWNERSHIP', 'The ownership revision of the call is not the one of this attempt.');
  }
  switch (attempt.status) {
    case 'CLAIMED': {
      const lease = await leaseOf(tx, attempt.attempt_id);
      if (lease !== undefined && lease.status === 'HELD' && lease.expires_at > env.clock()) return undefined;
      return new ApiFailure('LEASE_EXPIRED', 'The lease of this attempt has ended.');
    }
    case 'LEASE_EXPIRED':
      return (await newerAttemptExists(tx, attempt))
        ? new ApiFailure(
            'STALE_OWNERSHIP',
            'A newer attempt of the same run or job exists: this attempt no longer owns it.',
          )
        : new ApiFailure('LEASE_EXPIRED', 'The lease of this attempt has ended.');
    case 'PENDING':
      return new ApiFailure('ATTEMPT_NOT_CLAIMABLE', 'This attempt has not been claimed.');
    default:
      return new ApiFailure(
        'ATTEMPT_NOT_CLAIMABLE',
        `This attempt is ${attempt.status}: no result can be committed from it.`,
      );
  }
}

async function recordRejection(
  tx: Queryable,
  ctx: WorkContext,
  attempt: AttemptRow,
  failure: ApiFailure,
  action: string,
): Promise<void> {
  await writeAudit(tx, ctx.env.clock(), {
    eventType: 'attempt.late_submission_rejected',
    actor: ctx.actorId,
    subject: attempt.attempt_id,
    detail: { action, code: failure.code, ownership_revision: attempt.ownership_revision },
  });
}

// --- creating an attempt -----------------------------------------------------------------------------------------

/** What an attempt of this work reserves before it is dispatched. */
export async function reservationNeeds(
  tx: Queryable,
  env: ApiEnv,
  work: Work,
): Promise<{ needs: Need[]; allowance?: AgentAllowanceCheck }> {
  const mission = await findMission(tx, work.missionId);
  if (mission === undefined) throw new Error(`The mission ${work.missionId} does not exist.`);
  const policy = await loadPolicy(tx, env, mission.policy_id, mission.policy_revision);
  if (policy === undefined) throw new Error(`The policy of mission ${mission.mission_id} is missing.`);
  const { limits } = policy.document;
  const budget = await loadMissionBudget(tx, mission.mission_id);
  switch (work.dispatchKind) {
    case 'retrieve':
      return {
        needs: [
          {
            dimension: 'PROVIDER_REQUESTS',
            amount: String(retrievalRequestCap(budget.provider_requests, budget.attempt_cap)),
          },
          { dimension: 'BATCH_COMPUTE_SECONDS', amount: String(limits.job_timeouts.retrieve_seconds) },
        ],
      };
    case 'validate':
      return { needs: [{ dimension: 'BATCH_COMPUTE_SECONDS', amount: String(limits.job_timeouts.validate_seconds) }] };
    case 'evaluate':
      return { needs: [{ dimension: 'BATCH_COMPUTE_SECONDS', amount: String(limits.job_timeouts.evaluate_seconds) }] };
    case 'assess':
      return { needs: [{ dimension: 'BATCH_COMPUTE_SECONDS', amount: String(limits.job_timeouts.assess_seconds) }] };
    case 'agent': {
      if (work.configurationId === null || work.agentRole === null)
        throw new Error(`The agent job ${work.id} has no configuration.`);
      return {
        needs: [
          { dimension: 'MODEL_SPEND', configurationId: work.configurationId, amount: budget.model_spend_per_attempt },
          { dimension: 'AGENT_COMPUTE_SECONDS', amount: String(limits.agent_timeout_seconds) },
        ],
        allowance: { configurationId: work.configurationId, role: work.agentRole },
      };
    }
  }
}

export type OpenAttempt =
  | { readonly ok: true; readonly attemptId: string; readonly ownershipRevision: number }
  | { readonly ok: false; readonly reason: string };

/**
 * Create the next attempt of a run or job, with its reservation and its outbox entry, or say why no budget covers it.
 * The caller holds the mission and work locks and has checked the attempt cap.
 */
export async function openAttempt(tx: Queryable, ctx: WorkContext, work: Work): Promise<OpenAttempt> {
  const { env } = ctx;
  const column = work.kind === 'run' ? 'run_id' : 'job_id';
  const latest = await tx.query<{ latest: number }>(
    `SELECT COALESCE(MAX(ownership_revision), 0)::int AS latest FROM attempts WHERE ${column} = $1`,
    [work.id],
  );
  const ownershipRevision = (latest.rows[0]?.latest ?? 0) + 1;
  if (ownershipRevision > work.attemptCap) {
    throw new Error(`The ${work.kind} ${work.id} has used its attempt cap of ${work.attemptCap}.`);
  }
  const mission = await findMission(tx, work.missionId);
  if (mission === undefined) throw new Error(`The mission ${work.missionId} does not exist.`);
  if (mission.status === 'BLOCKED') {
    return { ok: false, reason: `The mission is BLOCKED: ${mission.blocked_reason ?? 'no reason recorded'}.` };
  }
  if (mission.status !== 'IN_PROGRESS' && mission.status !== 'CREATED') {
    return { ok: false, reason: `The mission is ${mission.status}.` };
  }
  const { needs, allowance } = await reservationNeeds(tx, env, work);
  const plan = await planReservation(tx, work.missionId, needs, allowance);
  if (!plan.ok) return { ok: false, reason: plan.reason };
  const now = env.clock();
  const attemptId = env.ids.next('att');
  await tx.query(
    `INSERT INTO attempts (attempt_id, run_id, job_id, ownership_revision, attempt_cap, created_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      attemptId,
      work.kind === 'run' ? work.id : null,
      work.kind === 'job' ? work.id : null,
      ownershipRevision,
      work.attemptCap,
      now,
    ],
  );
  await commitReservation(tx, attemptId, plan.lines, now);
  const binding: Binding = { attemptId, ownershipRevision };
  const dispatch = await builderFor(ctx.builders, work)({ tx, env, actorId: ctx.actorId }, work, binding);
  await tx.query(
    `INSERT INTO outbox (attempt_id, destination, message, message_digest, created_at)
     VALUES ($1, $2, $3::jsonb, $4, $5)`,
    [attemptId, dispatch.destination, JSON.stringify(dispatch.message), await digest(dispatch.message as never), now],
  );
  await writeAudit(tx, now, {
    eventType: 'attempt.created',
    actor: ctx.actorId,
    subject: attemptId,
    detail: { [work.kind]: work.id, ownership_revision: ownershipRevision, kind: work.dispatchKind },
  });
  return { ok: true, attemptId, ownershipRevision };
}

// --- claim -------------------------------------------------------------------------------------------------------

export interface ClaimInput {
  readonly attemptId: string;
  readonly ownershipRevision: number;
  /** The digest of the dispatch message that the worker received: attempt-claim/1 dispatch_digest. */
  readonly dispatchDigest: string;
  readonly workerId: string;
  readonly executable: { readonly name: string; readonly version: string; readonly digest: string };
  readonly leaseExpiresAt: Date;
  /** The hash of the attempt capability that the caller will return to the worker (leases.capability_hash). */
  readonly capabilityHash: string;
}

export interface Claimed {
  readonly work: Work;
  readonly leaseExpiresAt: Date;
}

/** PENDING to CLAIMED, the lease HELD and the run or job RUNNING (OQ-05 section 4). A second claim is refused. */
export async function claimAttempt(tx: Queryable, ctx: WorkContext, input: ClaimInput): Promise<Guarded<Claimed>> {
  if (!ctx.env.researchExecution) {
    // A switch of the deployment, not a state of the attempt: nothing is read or written, so no worker starts work.
    return {
      ok: false,
      failure: new ApiFailure('EXECUTION_DISABLED', 'Research execution is disabled in this environment.'),
    };
  }
  const located = await locate(tx, input.attemptId);
  if (located === undefined) return { ok: false, failure: new ApiFailure('NOT_FOUND', 'The attempt does not exist.') };
  const { mission, attempt } = located;
  let { work } = located;
  if (attempt.ownership_revision !== input.ownershipRevision) {
    return {
      ok: false,
      failure: new ApiFailure('STALE_OWNERSHIP', 'The ownership revision is not the one of this attempt.'),
    };
  }
  if (attempt.status !== 'PENDING') {
    return {
      ok: false,
      failure: new ApiFailure('ATTEMPT_NOT_CLAIMABLE', `The attempt is ${attempt.status}: it cannot be claimed.`),
    };
  }
  if (mission.status !== 'IN_PROGRESS' && mission.status !== 'BLOCKED') {
    return {
      ok: false,
      failure: new ApiFailure('ATTEMPT_NOT_CLAIMABLE', `The mission is ${mission.status}: its work cannot be claimed.`),
    };
  }
  const outbox = await tx.query<{ message_digest: string }>('SELECT message_digest FROM outbox WHERE attempt_id = $1', [
    input.attemptId,
  ]);
  if (outbox.rows[0]?.message_digest !== input.dispatchDigest) {
    return {
      ok: false,
      failure: new ApiFailure(
        'IDENTITY_MISMATCH',
        'The dispatch digest is not the digest of the message of this attempt.',
      ),
    };
  }
  const now = ctx.env.clock();
  assertTransition('attempt', 'PENDING', 'CLAIMED');
  await tx.query(
    `UPDATE attempts SET status = 'CLAIMED', claimed_at = $2, worker_id = $3, executable_name = $4,
            executable_version = $5, executable_digest = $6, dispatch_digest = $7
      WHERE attempt_id = $1`,
    [
      input.attemptId,
      now,
      input.workerId,
      input.executable.name,
      input.executable.version,
      input.executable.digest,
      input.dispatchDigest,
    ],
  );
  await tx.query(
    `INSERT INTO leases (attempt_id, ownership_revision, granted_at, expires_at, capability_hash)
     VALUES ($1, $2, $3, $4, $5)`,
    [input.attemptId, attempt.ownership_revision, now, input.leaseExpiresAt, input.capabilityHash],
  );
  if (work.status === 'QUEUED') work = await setWorkStatus(tx, ctx.env, work, 'RUNNING');
  await writeAudit(tx, now, {
    eventType: 'attempt.claimed',
    actor: ctx.actorId,
    subject: input.attemptId,
    detail: { [work.kind]: work.id, worker_id: input.workerId, lease_expires_at: input.leaseExpiresAt.toISOString() },
  });
  return { ok: true, value: { work, leaseExpiresAt: input.leaseExpiresAt } };
}

// --- completion and failure --------------------------------------------------------------------------------------

export interface Completion {
  readonly attemptId: string;
  readonly ownershipRevision: number;
  /**
   * The status of the run or job once the attempt's result is accepted: COMPLETED, or FAILED for a run that the core
   * ended with a failure outcome (OQ-02 section 3.6). The attempt itself is COMPLETED: its result was accepted.
   */
  readonly workStatus: 'COMPLETED' | 'FAILED';
  readonly failureCode?: string;
  readonly usage: UsageReport;
}

export interface Completed {
  readonly work: Work;
  readonly settled: 'SETTLED' | 'UNRECONCILED' | 'UNCHANGED';
}

async function blockOnOverrun(
  tx: Queryable,
  ctx: WorkContext,
  mission: MissionRow,
  overruns: readonly { dimension: string; configurationId: string | null; amount: string }[],
  attemptId: string,
): Promise<void> {
  const first = overruns[0];
  if (first === undefined) return;
  const where = first.configurationId === null ? 'the mission' : `the allowance of ${first.configurationId}`;
  await blockMission(
    tx,
    ctx.env,
    mission,
    `Usage of attempt ${attemptId} went over its reservation by ${first.amount} in ${first.dimension} of ${where}.`,
    ctx.actorId,
  );
}

/** Accept the result of the current attempt: it is COMPLETED, its lease RELEASED, the work gets its final status. */
export async function completeAttempt(
  tx: Queryable,
  ctx: WorkContext,
  completion: Completion,
): Promise<Guarded<Completed>> {
  const located = await locate(tx, completion.attemptId);
  if (located === undefined) return { ok: false, failure: new ApiFailure('NOT_FOUND', 'The attempt does not exist.') };
  const { mission, attempt } = located;
  let { work } = located;
  const failure = await fenceFailure(tx, ctx.env, attempt, completion.ownershipRevision);
  if (failure !== undefined) {
    await recordRejection(tx, ctx, attempt, failure, 'complete');
    return { ok: false, failure };
  }
  const now = ctx.env.clock();
  assertTransition('attempt', 'CLAIMED', 'COMPLETED');
  await tx.query(`UPDATE attempts SET status = 'COMPLETED', ended_at = $2, agent_outcome = $3 WHERE attempt_id = $1`, [
    attempt.attempt_id,
    now,
    work.dispatchKind === 'agent' ? 'completion' : null,
  ]);
  assertTransition('lease', 'HELD', 'RELEASED');
  await tx.query(`UPDATE leases SET status = 'RELEASED', released_at = $2 WHERE attempt_id = $1`, [
    attempt.attempt_id,
    now,
  ]);
  work = await setWorkStatus(tx, ctx.env, work, completion.workStatus, {
    ...(completion.failureCode === undefined ? {} : { failureCode: completion.failureCode }),
  });
  const settled = await settleReservation(tx, attempt.attempt_id, completion.usage, now);
  await blockOnOverrun(tx, ctx, mission, settled.overruns, attempt.attempt_id);
  await writeAudit(tx, now, {
    eventType: 'attempt.completed',
    actor: ctx.actorId,
    subject: attempt.attempt_id,
    detail: { [work.kind]: work.id, work_status: completion.workStatus, reservation: settled.status },
  });
  return { ok: true, value: { work, settled: settled.status } };
}

export type AfterFailure =
  | { readonly outcome: 'FAILED'; readonly work: Work; readonly reason: string }
  | { readonly outcome: 'RETRIED'; readonly work: Work; readonly attemptId: string; readonly ownershipRevision: number }
  | { readonly outcome: 'WAITING'; readonly work: Work; readonly reason: string };

/**
 * The work of a run or job whose attempt ended without an accepted result and that is RUNNING: retry it with a new
 * attempt, leave it waiting for budget, or fail it (OQ-05 section 4).
 */
async function retryOrFail(
  tx: Queryable,
  ctx: WorkContext,
  mission: MissionRow,
  work: Work,
  attempt: AttemptRow,
  classification: { retryable: boolean; code: string },
): Promise<AfterFailure> {
  if (!classification.retryable) {
    const failed = await setWorkStatus(tx, ctx.env, work, 'FAILED', { failureCode: classification.code });
    return { outcome: 'FAILED', work: failed, reason: `${classification.code} is not retried.` };
  }
  if (attempt.ownership_revision >= work.attemptCap) {
    const failed = await setWorkStatus(tx, ctx.env, work, 'FAILED', { failureCode: classification.code });
    return { outcome: 'FAILED', work: failed, reason: `The attempt cap of ${work.attemptCap} is exhausted.` };
  }
  const queued = await setWorkStatus(tx, ctx.env, work, 'QUEUED');
  const opened = await openAttempt(tx, ctx, queued);
  if (opened.ok) {
    return {
      outcome: 'RETRIED',
      work: queued,
      attemptId: opened.attemptId,
      ownershipRevision: opened.ownershipRevision,
    };
  }
  // No budget covers a new reservation: the work waits QUEUED with no live attempt and the mission is BLOCKED.
  const reason = `${work.kind} ${work.id} waits for budget: ${opened.reason}`;
  const waiting = await setWaitingReason(tx, queued, reason.length > 1000 ? reason.slice(0, 1000) : reason);
  await blockMission(tx, ctx.env, mission, reason, ctx.actorId);
  return { outcome: 'WAITING', work: waiting, reason };
}

export interface FailureReport {
  readonly attemptId: string;
  readonly ownershipRevision: number;
  readonly cause: Exclude<FailureCause, { kind: 'LEASE_EXPIRED' }>;
  readonly usage: UsageReport;
}

/**
 * The current owner reports that its attempt ended without an accepted result. The attempt is FAILED with the cause,
 * its reservation is settled by the usage it reports (a missing report keeps the reservation), and a retryable cause
 * below the attempt cap gets a new attempt.
 */
export async function failAttempt(
  tx: Queryable,
  ctx: WorkContext,
  report: FailureReport,
): Promise<Guarded<AfterFailure & { settled: string }>> {
  const located = await locate(tx, report.attemptId);
  if (located === undefined) return { ok: false, failure: new ApiFailure('NOT_FOUND', 'The attempt does not exist.') };
  const { mission, work, attempt } = located;
  const failure = await fenceFailure(tx, ctx.env, attempt, report.ownershipRevision);
  if (failure !== undefined) {
    await recordRejection(tx, ctx, attempt, failure, 'fail');
    return { ok: false, failure };
  }
  const classification = classify(report.cause);
  const now = ctx.env.clock();
  assertTransition('attempt', 'CLAIMED', 'FAILED');
  await tx.query(
    `UPDATE attempts SET status = 'FAILED', ended_at = $2, failure_code = $3, agent_outcome = $4 WHERE attempt_id = $1`,
    [attempt.attempt_id, now, classification.code, classification.agentOutcome ?? null],
  );
  assertTransition('lease', 'HELD', 'RELEASED');
  await tx.query(`UPDATE leases SET status = 'RELEASED', released_at = $2 WHERE attempt_id = $1`, [
    attempt.attempt_id,
    now,
  ]);
  const settled = await settleReservation(tx, attempt.attempt_id, report.usage, now);
  await blockOnOverrun(tx, ctx, mission, settled.overruns, attempt.attempt_id);
  const after = await retryOrFail(
    tx,
    ctx,
    (await findMission(tx, mission.mission_id)) as MissionRow,
    work,
    attempt,
    classification,
  );
  await writeAudit(tx, now, {
    eventType: 'attempt.failed',
    actor: ctx.actorId,
    subject: attempt.attempt_id,
    detail: { [work.kind]: work.id, code: classification.code, next: after.outcome, reservation: settled.status },
  });
  return { ok: true, value: { ...after, settled: settled.status } };
}

export type Expiry =
  | { readonly status: 'EXPIRED'; readonly after: AfterFailure }
  | { readonly status: 'NOT_EXPIRED' | 'NOT_CLAIMED' | 'UNKNOWN_ATTEMPT' };

/**
 * Recovery of one attempt whose lease ran out without a result (scheduled recovery, with no client connected). The
 * attempt is LEASE_EXPIRED and its lease EXPIRED. Its reservation stays RESERVED: nothing is released until its
 * termination is confirmed (confirmTermination). Below the cap and with budget a new attempt is written, a retry.
 */
export async function expireLease(tx: Queryable, ctx: WorkContext, attemptId: string): Promise<Expiry> {
  const located = await locate(tx, attemptId);
  if (located === undefined) return { status: 'UNKNOWN_ATTEMPT' };
  const { mission, work, attempt } = located;
  if (attempt.status !== 'CLAIMED') return { status: 'NOT_CLAIMED' };
  const lease = await leaseOf(tx, attemptId);
  const now = ctx.env.clock();
  if (lease !== undefined && lease.status === 'HELD' && lease.expires_at > now) return { status: 'NOT_EXPIRED' };
  assertTransition('attempt', 'CLAIMED', 'LEASE_EXPIRED');
  await tx.query(
    `UPDATE attempts SET status = 'LEASE_EXPIRED', ended_at = $2, failure_code = 'LEASE_EXPIRED' WHERE attempt_id = $1`,
    [attemptId, now],
  );
  assertTransition('lease', 'HELD', 'EXPIRED');
  await tx.query(`UPDATE leases SET status = 'EXPIRED', released_at = $2 WHERE attempt_id = $1`, [attemptId, now]);
  const after = await retryOrFail(tx, ctx, mission, work, attempt, classify({ kind: 'LEASE_EXPIRED' }));
  await writeAudit(tx, now, {
    eventType: 'attempt.lease_expired',
    actor: ctx.actorId,
    subject: attemptId,
    detail: { [work.kind]: work.id, next: after.outcome },
  });
  return { status: 'EXPIRED', after };
}

/**
 * The termination of an attempt that was fenced by lease expiry or cancelled while claimed is confirmed, with the
 * usage that its host reported, if any (OQ-03 section 1: lease expiry releases nothing until termination is
 * confirmed). Without a report the reservation becomes UNRECONCILED and counts as spent.
 */
export async function confirmTermination(
  tx: Queryable,
  ctx: WorkContext,
  attemptId: string,
  usage: UsageReport = {},
): Promise<{ status: 'SETTLED' | 'UNRECONCILED' | 'UNCHANGED' }> {
  const located = await locate(tx, attemptId);
  if (located === undefined) throw new ApiFailure('NOT_FOUND', 'The attempt does not exist.');
  const { mission, attempt } = located;
  if (attempt.status !== 'LEASE_EXPIRED' && !(attempt.status === 'CANCELLED' && attempt.claimed_at !== null)) {
    throw new ApiFailure(
      'ATTEMPT_NOT_CLAIMABLE',
      `The attempt is ${attempt.status}: it has no termination to confirm.`,
    );
  }
  const settled = await settleReservation(tx, attemptId, usage, ctx.env.clock());
  await blockOnOverrun(tx, ctx, mission, settled.overruns, attemptId);
  await writeAudit(tx, ctx.env.clock(), {
    eventType: 'attempt.termination_confirmed',
    actor: ctx.actorId,
    subject: attemptId,
    detail: { reservation: settled.status },
  });
  return { status: settled.status };
}

/**
 * Recovery of a reservation that stayed UNRECONCILED because its attempt ended without a usage report (OQ-05 section 4:
 * "Recovery reconciles UNRECONCILED reservations"). A report settles it: the part that was not used returns to the
 * budget, never more than the reservation, and usage above it is an overrun. A line that is still unknown stays
 * reserved. The attempt can be in any ended state. Returns how the reservation now stands.
 */
export async function reconcileReservation(
  tx: Queryable,
  ctx: WorkContext,
  attemptId: string,
  usage: UsageReport,
): Promise<{ status: 'SETTLED' | 'UNRECONCILED' | 'UNCHANGED' }> {
  const located = await locate(tx, attemptId);
  if (located === undefined) throw new ApiFailure('NOT_FOUND', 'The attempt does not exist.');
  const { mission, attempt } = located;
  if (attempt.status === 'PENDING' || attempt.status === 'CLAIMED') {
    throw new ApiFailure('ATTEMPT_NOT_CLAIMABLE', `The attempt is ${attempt.status}: it has not ended.`);
  }
  const rows = await tx.query<{ status: string }>('SELECT status FROM reservations WHERE attempt_id = $1', [attemptId]);
  if (rows.rows[0]?.status !== 'UNRECONCILED') return { status: 'UNCHANGED' };
  const settled = await settleReservation(tx, attemptId, usage, ctx.env.clock());
  await blockOnOverrun(tx, ctx, mission, settled.overruns, attemptId);
  await writeAudit(tx, ctx.env.clock(), {
    eventType: 'reservation.reconciled',
    actor: ctx.actorId,
    subject: attemptId,
    detail: { reservation: settled.status },
  });
  return { status: settled.status };
}

// --- cancellation ------------------------------------------------------------------------------------------------

export interface CancelSummary {
  readonly runsCancelled: number;
  readonly jobsCancelled: number;
  /** Attempts cancelled before their claim: reservation released, outbox entry cancelled. */
  readonly pendingAttempts: number;
  /** Attempts cancelled while claimed: the reservation stays until termination is confirmed. */
  readonly claimedAttempts: number;
}

/**
 * The cancel_mission effect on work (OQ-05 section 4): every open run and job becomes CANCELLED, a PENDING attempt is
 * CANCELLED with its reservation RELEASED and its PENDING outbox entry CANCELLED, and a CLAIMED attempt is CANCELLED
 * and keeps its reservation. A run or job that already ended is not touched: a result that committed first wins.
 * The caller holds the mission lock.
 */
export async function cancelOpenWork(tx: Queryable, ctx: WorkContext, missionId: string): Promise<CancelSummary> {
  const now = ctx.env.clock();
  let runsCancelled = 0;
  let jobsCancelled = 0;
  let pendingAttempts = 0;
  let claimedAttempts = 0;
  for (const open of await lockOpenWork(tx, missionId)) {
    const column = open.kind === 'run' ? 'run_id' : 'job_id';
    const live = await tx.query<AttemptRow>(
      `SELECT ${ATTEMPT_COLUMNS} FROM attempts WHERE ${column} = $1 AND status IN ('PENDING', 'CLAIMED') FOR UPDATE`,
      [open.id],
    );
    for (const attempt of live.rows) {
      assertTransition('attempt', attempt.status, 'CANCELLED');
      await tx.query(`UPDATE attempts SET status = 'CANCELLED', ended_at = $2 WHERE attempt_id = $1`, [
        attempt.attempt_id,
        now,
      ]);
      if (attempt.status === 'PENDING') {
        pendingAttempts += 1;
        await releaseReservation(tx, attempt.attempt_id, now);
        await tx.query(`UPDATE outbox SET status = 'CANCELLED' WHERE attempt_id = $1 AND status = 'PENDING'`, [
          attempt.attempt_id,
        ]);
      } else {
        claimedAttempts += 1;
        assertTransition('lease', 'HELD', 'RELEASED');
        await tx.query(`UPDATE leases SET status = 'RELEASED', released_at = $2 WHERE attempt_id = $1`, [
          attempt.attempt_id,
          now,
        ]);
      }
    }
    await setWorkStatus(tx, ctx.env, open, 'CANCELLED');
    if (open.kind === 'run') runsCancelled += 1;
    else jobsCancelled += 1;
  }
  return { runsCancelled, jobsCancelled, pendingAttempts, claimedAttempts };
}

// --- outbox ------------------------------------------------------------------------------------------------------

/** The dispatcher delivered the message of an attempt: PENDING to SENT, only while the attempt is still PENDING. */
export async function markOutboxSent(
  tx: Queryable,
  env: Pick<ApiEnv, 'clock'>,
  attemptId: string,
): Promise<'SENT' | 'ALREADY_SENT' | 'CANCELLED' | 'UNKNOWN_ATTEMPT'> {
  const { rows } = await tx.query<{ outbox_status: string; attempt_status: string }>(
    `SELECT o.status AS outbox_status, a.status AS attempt_status
       FROM outbox o JOIN attempts a ON a.attempt_id = o.attempt_id WHERE o.attempt_id = $1 FOR UPDATE OF o`,
    [attemptId],
  );
  const row = rows[0];
  if (row === undefined) return 'UNKNOWN_ATTEMPT';
  if (row.outbox_status === 'SENT') return 'ALREADY_SENT';
  if (row.outbox_status === 'CANCELLED' || row.attempt_status !== 'PENDING') return 'CANCELLED';
  assertTransition('outbox', 'PENDING', 'SENT');
  await tx.query(`UPDATE outbox SET status = 'SENT', sent_at = $2 WHERE attempt_id = $1`, [attemptId, env.clock()]);
  return 'SENT';
}

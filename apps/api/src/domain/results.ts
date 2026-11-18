// What every result route shares (OQ-05 section 4, "Attempt CLAIMED: Result submission"): only the current owner commits,
// a submission that is repeated returns the stored result, a late one is rejected and recorded, and the usage of the
// attempt settles its reservation with unknown values kept explicit.

import type { CostUsage, CountUsage, DurationUsage } from '@openquant/api-contracts';
import { writeAudit } from '../audit.ts';
import type { Database, Queryable } from '../db/database.ts';
import type { ApiEnv } from '../env.ts';
import { ApiFailure } from '../errors.ts';
import {
  fenceFailure,
  type Located,
  type LocatedAny,
  locate,
  locateAny,
  recordRejection,
  type WorkContext,
} from './attempts.ts';
import type { UsageValue } from './budget.ts';

export type ResultGate<L extends LocatedAny = Located> =
  | { readonly kind: 'live'; readonly located: L }
  | { readonly kind: 'repeat'; readonly located: L }
  | { readonly kind: 'rejected'; readonly failure: ApiFailure };

/** As openResult, for the evaluation route, which also takes the submission of a REPLAY run (replay.ts). */
export function openAnyResult(
  tx: Queryable,
  ctx: WorkContext,
  attemptId: string,
  ownershipRevision: number,
): Promise<ResultGate<LocatedAny>> {
  return openWith(tx, ctx, attemptId, ownershipRevision, locateAny);
}

/**
 * Decide what a submission from an attempt may do. `live`: the caller holds the current lease and ownership revision.
 * `repeat`: the attempt already completed with its result (the caller compares the stored digest with the body).
 * `rejected`: a late submission, which is recorded in this transaction and changes nothing else: STALE_OWNERSHIP,
 * LEASE_EXPIRED, or ATTEMPT_NOT_CLAIMABLE for an attempt that is cancelled, failed, completed with no result of its own
 * or still pending (OQ-05 section 4).
 */
export function openResult(
  tx: Queryable,
  ctx: WorkContext,
  attemptId: string,
  ownershipRevision: number,
): Promise<ResultGate> {
  return openWith(tx, ctx, attemptId, ownershipRevision, locate);
}

async function openWith<L extends LocatedAny>(
  tx: Queryable,
  ctx: WorkContext,
  attemptId: string,
  ownershipRevision: number,
  find: (tx: Queryable, attemptId: string) => Promise<L | undefined>,
): Promise<ResultGate<L>> {
  const located = await find(tx, attemptId);
  if (located === undefined) {
    return { kind: 'rejected', failure: new ApiFailure('NOT_FOUND', 'The attempt does not exist.') };
  }
  const { attempt } = located;
  const ended = attempt.status === 'COMPLETED' || attempt.status === 'FAILED';
  if (ended && attempt.result_digest !== null && attempt.ownership_revision === ownershipRevision) {
    return { kind: 'repeat', located };
  }
  const failure = await fenceFailure(tx, ctx.env, attempt, ownershipRevision);
  if (failure === undefined) return { kind: 'live', located };
  await recordRejection(tx, ctx, attempt, failure, 'submit');
  return { kind: 'rejected', failure };
}

/**
 * The outcome of a repeated submission: it is the same document that the attempt ended with (nothing changes and the
 * caller answers as for the first), or another document, which is refused.
 */
export function repeatOutcome(
  located: LocatedAny,
  submissionDigest: string,
): { readonly ok: true } | { readonly ok: false; readonly failure: ApiFailure } {
  return located.attempt.result_digest === submissionDigest ? { ok: true } : { ok: false, failure: differentRepeat() };
}

/** The answer of a repeated submission that differs from the one that the attempt completed with. */
export function differentRepeat(): ApiFailure {
  return new ApiFailure(
    'IDENTITY_MISMATCH',
    'This attempt completed with another submission: a repeat must be the same document.',
  );
}

// --- usage ---------------------------------------------------------------------------------------------------------

/** Reported duration as compute seconds, rounded up: the pool never counts less than was used. Unknown stays unknown. */
export function durationUsage(duration: DurationUsage): UsageValue {
  if (duration.label === 'unknown') return { label: 'unknown' };
  return { label: duration.label, amount: String(Math.ceil(duration.milliseconds / 1000)) };
}

export function countUsage(count: CountUsage): UsageValue {
  if (count.label === 'unknown') return { label: 'unknown' };
  return { label: count.label, amount: String(count.count) };
}

/** Reported cost. A currency other than the mission's cannot be settled against its pools: that is a mismatch. */
export function costUsage(cost: CostUsage, currency: string): UsageValue {
  if (cost.label === 'unknown') return { label: 'unknown' };
  if (cost.currency !== currency) {
    throw new ApiFailure('IDENTITY_MISMATCH', `The cost is reported in ${cost.currency}, not in ${currency}.`);
  }
  return { label: cost.label, amount: cost.amount };
}

// --- rejections ----------------------------------------------------------------------------------------------------

/**
 * Record a refused submission in its own transaction, after the one that refused it rolled back. The caller is told
 * why; the audit log keeps that it happened (OQ-02 section 8). Best effort: a failure here never hides the refusal.
 */
export async function auditRefusal(
  db: Database,
  env: Pick<ApiEnv, 'clock'>,
  actor: string,
  attemptId: string,
  route: string,
  failure: ApiFailure,
  diagnosticRef: string,
): Promise<void> {
  try {
    await db.transaction((tx) =>
      writeAudit(tx, env.clock(), {
        eventType: 'attempt.submission_refused',
        actor,
        subject: attemptId,
        diagnosticRef,
        detail: { route, code: failure.code },
      }),
    );
  } catch {
    // The refusal still reaches the caller.
  }
}

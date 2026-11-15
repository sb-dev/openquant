// Scheduled recovery (OQ-05 section 4: "Recovery finds missing dispatches and expired attempts even when no client is
// connected"; OQ-03 section 1: "lease expiry releases nothing until termination is confirmed"). A Cloudflare cron
// trigger runs one pass, and every step of it is idempotent, so a pass that overlaps another or that stops half way
// loses nothing:
//
//   1. an attempt whose lease ran out without a result is fenced (LEASE_EXPIRED). Below the attempt cap, with budget and
//      a retryable cause, a new attempt of the same run or job is written with its own reservation and outbox entry. At
//      the cap the run or job fails. Without budget it waits QUEUED and the mission is BLOCKED (expireLease);
//   2. the reservation of a fenced or cancelled-while-claimed attempt stays RESERVED until its termination is confirmed.
//      A probe says whether the host has stopped; the default one confirms when the lease deadline and a grace have
//      passed (below). Confirmation with no usage report makes the reservation UNRECONCILED: the full amount counts as
//      spent. Nothing is released without a report (confirmTermination);
//   3. a reservation that stayed UNRECONCILED is reconciled when the probe now reports the usage of its attempt
//      (reconcileReservation, OQ-05 section 4: "Recovery reconciles UNRECONCILED reservations"). The step asks about the
//      attempts that were fenced or cancelled while claimed and still hold an UNRECONCILED reservation, other than the
//      ones that step 2 has just asked about, and does nothing when there is none. A report that a runner posts after its
//      lease ended settles the reservation too (the agent result route); that path and this one never settle twice;
//   4. every PENDING outbox entry is sent again (outbox.ts): a dispatch that was lost, or that failed, is not missed.
//
// One failing item never stops the pass: its error is logged and counted, and the item is tried again on the next pass.

import type { Database } from './db/database.ts';
import { confirmTermination, expireLease, reconcileReservation, type WorkContext } from './domain/attempts.ts';
import type { UsageReport } from './domain/budget.ts';
import { allBuilders } from './domain/builders.ts';
import type { ApiEnv } from './env.ts';
import { type Dispatchers, type DispatchSummary, dispatchPending } from './outbox.ts';

export interface TerminationEvidence {
  readonly terminated: boolean;
  /** What the host reported, when it did. Without it the reservation stays counted as spent. */
  readonly usage?: UsageReport;
}

export interface FencedAttempt {
  readonly attemptId: string;
  readonly status: 'LEASE_EXPIRED' | 'CANCELLED';
  readonly destination: 'BATCH_QUEUE' | 'AGENT_RUNNER';
  /** The time at which the lease ran, or would have run, out. */
  readonly leaseExpiresAt: Date;
}

/** Whether the host of a fenced attempt has stopped. P6 supplies a probe that asks the platform; S1 ships the deadline. */
export interface TerminationProbe {
  check(attempt: FencedAttempt, now: Date): Promise<TerminationEvidence>;
}

/** Default grace after the lease deadline: the host's own timeout ends the work before the lease does. */
export const TERMINATION_GRACE_SECONDS = 300;

/**
 * The host is taken to have stopped once the lease deadline and a grace have passed: the host stops its work at its own
 * timeout, which is shorter than the lease. This is an assumption that no platform call backs yet (README, open points).
 * It is safe: confirming without a report releases nothing, and a later report (a runner's agent result, or the usage that
 * a platform probe reports) can still settle the reservation. The default probe reports no usage.
 */
export function deadlineProbe(graceSeconds: number = TERMINATION_GRACE_SECONDS): TerminationProbe {
  return {
    async check(attempt, now) {
      return { terminated: now.getTime() >= attempt.leaseExpiresAt.getTime() + graceSeconds * 1000 };
    },
  };
}

export interface RecoveryDeps {
  readonly dispatchers: Dispatchers;
  readonly probe?: TerminationProbe;
  readonly limit?: number;
}

export interface RecoverySummary {
  readonly leasesExpired: number;
  readonly retried: number;
  readonly failed: number;
  readonly waiting: number;
  readonly terminationsConfirmed: number;
  /** Reservations that were UNRECONCILED and are now SETTLED from the usage that the probe reported. */
  readonly reconciled: number;
  readonly dispatch: DispatchSummary;
  /** Items that threw: logged and tried again on the next pass. */
  readonly errors: number;
}

export async function runRecovery(env: ApiEnv, db: Database, deps: RecoveryDeps): Promise<RecoverySummary> {
  const limit = deps.limit ?? 50;
  const probe = deps.probe ?? deadlineProbe();
  // Recovery writes under the workflows service principal: the requests that it stores name an uploader (a principal).
  const actor = await db.query<{ principal_id: string }>(
    `SELECT principal_id FROM principals WHERE kind = 'SERVICE' AND service_kind = 'workflows' AND status = 'ACTIVE' AND environment = $1`,
    [env.environment],
  );
  const actorId = actor.rows[0]?.principal_id;
  let leasesExpired = 0;
  let retried = 0;
  let failed = 0;
  let waiting = 0;
  let terminationsConfirmed = 0;
  let reconciled = 0;
  let errors = 0;
  const fail = (what: string, attemptId: string, error: unknown): void => {
    errors += 1;
    env.log({
      level: 'error',
      message: `recovery: ${what} failed`,
      attempt_id: attemptId,
      error: error instanceof Error ? error.name : 'unknown',
    });
  };

  if (actorId === undefined) {
    // Nothing that writes can run without an actor: the dispatch of what is pending still can.
    env.log({ level: 'error', message: 'recovery: no active workflows service principal exists in this environment' });
    const dispatch = await dispatchPending(env, db, deps.dispatchers, limit);
    return { leasesExpired, retried, failed, waiting, terminationsConfirmed, reconciled, dispatch, errors: 1 };
  }
  const context: WorkContext = { env, actorId, builders: allBuilders };

  const expired = await db.query<{ attempt_id: string }>(
    `SELECT attempt_id FROM leases WHERE status = 'HELD' AND expires_at <= $1 ORDER BY expires_at, attempt_id LIMIT $2`,
    [env.clock(), limit],
  );
  for (const row of expired.rows) {
    try {
      const outcome = await db.transaction((tx) => expireLease(tx, context, row.attempt_id));
      if (outcome.status !== 'EXPIRED') continue;
      leasesExpired += 1;
      if (outcome.after.outcome === 'RETRIED') retried += 1;
      else if (outcome.after.outcome === 'FAILED') failed += 1;
      else waiting += 1;
    } catch (error) {
      fail('lease expiry', row.attempt_id, error);
    }
  }

  const fenced = await db.query<{
    attempt_id: string;
    status: 'LEASE_EXPIRED' | 'CANCELLED';
    destination: 'BATCH_QUEUE' | 'AGENT_RUNNER';
    expires_at: Date;
  }>(
    `SELECT a.attempt_id, a.status, o.destination, l.expires_at
       FROM attempts a
       JOIN reservations r ON r.attempt_id = a.attempt_id AND r.status = 'RESERVED'
       JOIN leases l ON l.attempt_id = a.attempt_id
       JOIN outbox o ON o.attempt_id = a.attempt_id
      WHERE a.status = 'LEASE_EXPIRED' OR (a.status = 'CANCELLED' AND a.claimed_at IS NOT NULL)
      ORDER BY l.expires_at, a.attempt_id LIMIT $1`,
    [limit],
  );
  // The attempts that this pass asked the probe about: step 3 does not ask again for the ones it has just seen.
  const asked = new Set<string>();
  for (const row of fenced.rows) {
    try {
      asked.add(row.attempt_id);
      const now = env.clock();
      const evidence = await probe.check(
        { attemptId: row.attempt_id, status: row.status, destination: row.destination, leaseExpiresAt: row.expires_at },
        now,
      );
      if (!evidence.terminated) continue;
      await db.transaction((tx) => confirmTermination(tx, context, row.attempt_id, evidence.usage ?? {}));
      terminationsConfirmed += 1;
    } catch (error) {
      fail('termination confirmation', row.attempt_id, error);
    }
  }

  // Reservations that stayed UNRECONCILED: a probe that now knows the usage of the attempt settles them. The oldest
  // reservations come first, so a pass that asks about `limit` of them moves on as they are settled.
  const unreconciled = await db.query<{
    attempt_id: string;
    status: 'LEASE_EXPIRED' | 'CANCELLED';
    destination: 'BATCH_QUEUE' | 'AGENT_RUNNER';
    expires_at: Date;
  }>(
    `SELECT a.attempt_id, a.status, o.destination, l.expires_at
       FROM reservations r
       JOIN attempts a ON a.attempt_id = r.attempt_id
       JOIN leases l ON l.attempt_id = a.attempt_id
       JOIN outbox o ON o.attempt_id = a.attempt_id
      WHERE r.status = 'UNRECONCILED' AND (a.status = 'LEASE_EXPIRED' OR (a.status = 'CANCELLED' AND a.claimed_at IS NOT NULL))
      ORDER BY r.reserved_at, a.attempt_id LIMIT $1`,
    [limit],
  );
  for (const row of unreconciled.rows) {
    if (asked.has(row.attempt_id)) continue;
    try {
      const evidence = await probe.check(
        { attemptId: row.attempt_id, status: row.status, destination: row.destination, leaseExpiresAt: row.expires_at },
        env.clock(),
      );
      if (!evidence.terminated || evidence.usage === undefined) continue;
      const usage = evidence.usage;
      const outcome = await db.transaction((tx) => reconcileReservation(tx, context, row.attempt_id, usage));
      if (outcome.status === 'SETTLED') reconciled += 1;
    } catch (error) {
      fail('reconciliation', row.attempt_id, error);
    }
  }

  const dispatch = await dispatchPending(env, db, deps.dispatchers, limit);
  return { leasesExpired, retried, failed, waiting, terminationsConfirmed, reconciled, dispatch, errors };
}

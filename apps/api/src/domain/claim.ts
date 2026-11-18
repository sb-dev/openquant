// The claim of an attempt (OQ-05 section 4, "Attempt PENDING: Claim with attempt-claim/1"). A worker that received a
// dispatch message claims its attempt through the guarded API before it executes anything. The claim:
//
//   - is refused when research execution is off, when the environment has no recorded release (EXECUTION_DISABLED: no
//     executable can be verified, for any kind of work and for agent attempts), when the service principal is not the
//     host that the message was dispatched to (a batch credential cannot claim agent work and the reverse), when the
//     executable is not one of the recorded release, and when the mission's concurrency limit of the cohort policy is
//     reached (heldSlots: a slot is held until the worker is known to have stopped, decision D22);
//   - takes a lease that lasts the attempt timeout of the cohort policy plus a short grace, so that the host's own timeout
//     ends the work before the lease does (the lease is separate from any queue receipt);
//   - returns an attempt-scoped capability that expires with the lease: a token signed with the application key whose
//     hash is stored with the lease, so it is valid only for this attempt, this ownership revision and this lease.

import type { AttemptClaimGrant, AttemptClaimRequest } from '@openquant/api-contracts';
import { validateContract } from '@openquant/api-contracts';
import { capabilityHash } from '../auth/credentials.ts';
import { signCapability } from '../auth/tokens.ts';
import type { Queryable } from '../db/database.ts';
import { ApiFailure } from '../errors.ts';
import type { ServiceKind } from '../manifest.ts';
import { claimAttempt, type Guarded, locateAny, type WorkContext } from './attempts.ts';
import { currentRelease, loadPolicy } from './documents.ts';
import { dispatchOf } from './refs.ts';
import { findReplay } from './rows.ts';
import type { DispatchKind } from './work.ts';

/** The lease outlasts the attempt timeout by this long, so a host that stops at its timeout can still submit. */
export const LEASE_GRACE_SECONDS = 60;

/** The result routes: a late submission to one of them shows that the worker reached its end. */
/**
 * The concurrency slots of one host class (dispatch destination) that the attempts of a mission hold (OQ-05 section 4;
 * decision D22: lease expiry releases nothing until termination is confirmed). An attempt holds its slot from its claim
 * until it completes (its result or failure report commits) or its worker is known to have stopped. The end of its
 * lease is not that: an attempt that is CLAIMED with an expired lease, LEASE_EXPIRED or cancelled while claimed keeps
 * its slot while its reservation is RESERVED, that is until the termination probe confirms that the host stopped
 * (confirmTermination). A refused late request is not termination evidence: it may be malformed, and the worker may
 * still run, so it frees nothing.
 */
export async function heldSlots(
  tx: Queryable,
  missionId: string,
  destination: 'BATCH_QUEUE' | 'AGENT_RUNNER',
): Promise<number> {
  const { rows } = await tx.query<{ held: number }>(
    `SELECT count(*)::int AS held
       FROM attempts a
       JOIN outbox o ON o.attempt_id = a.attempt_id AND o.destination = $2
       JOIN reservations rv ON rv.attempt_id = a.attempt_id
       JOIN leases l ON l.attempt_id = a.attempt_id
       LEFT JOIN runs r ON r.run_id = a.run_id
       LEFT JOIN jobs j ON j.job_id = a.job_id
      WHERE COALESCE(r.mission_id, j.mission_id) = $1
        AND (a.status = 'CLAIMED'
             OR ((a.status = 'LEASE_EXPIRED' OR (a.status = 'CANCELLED' AND a.claimed_at IS NOT NULL))
                 AND rv.status = 'RESERVED'))`,
    [missionId, destination],
  );
  return rows[0]?.held ?? 0;
}

function timestamp(date: Date): string {
  return `${date.toISOString().slice(0, 19)}Z`;
}

export function timeoutSeconds(
  limits: {
    agent_timeout_seconds: number;
    job_timeouts: Record<'retrieve_seconds' | 'validate_seconds' | 'evaluate_seconds' | 'assess_seconds', number>;
  },
  kind: DispatchKind,
): number {
  switch (kind) {
    case 'retrieve':
      return limits.job_timeouts.retrieve_seconds;
    case 'validate':
      return limits.job_timeouts.validate_seconds;
    case 'evaluate':
      return limits.job_timeouts.evaluate_seconds;
    case 'assess':
      return limits.job_timeouts.assess_seconds;
    case 'agent':
      return limits.agent_timeout_seconds;
  }
}

export async function grantClaim(
  tx: Queryable,
  ctx: WorkContext,
  claimer: { readonly principalId: string; readonly serviceKind: ServiceKind },
  request: AttemptClaimRequest,
): Promise<Guarded<AttemptClaimGrant>> {
  const { env } = ctx;
  if (!env.researchExecution) {
    return {
      ok: false,
      failure: new ApiFailure('EXECUTION_DISABLED', 'Research execution is disabled in this environment.'),
    };
  }
  // The release identity is what an executable is verified against (OQ-05 sections 4 and 11). With none recorded no
  // executable can be told from another, so nothing is claimed: a switch of the deployment, like the one above.
  const release = await currentRelease(tx, env.environment);
  if (release === undefined) {
    return {
      ok: false,
      failure: new ApiFailure(
        'EXECUTION_DISABLED',
        `No release identity is recorded for ${env.environment}: no work is claimed until the deployment records one.`,
      ),
    };
  }
  const attemptId = request.attempt.attempt_id;
  const located = await locateAny(tx, attemptId);
  if (located === undefined) return { ok: false, failure: new ApiFailure('NOT_FOUND', 'The attempt does not exist.') };
  const { mission, work } = located;
  const dispatch = await dispatchOf(tx, attemptId);
  const expected: ServiceKind = dispatch.destination === 'BATCH_QUEUE' ? 'batch' : 'runner';
  if (claimer.serviceKind !== expected) {
    return {
      ok: false,
      failure: new ApiFailure('FORBIDDEN', 'This service principal does not host the work of this attempt.'),
    };
  }
  const policy =
    mission === undefined ? undefined : await loadPolicy(tx, env, mission.policy_id, mission.policy_revision);
  if (mission !== undefined && policy === undefined)
    throw new Error(`The policy of mission ${mission.mission_id} is missing.`);
  if (
    !release.executables.some(
      (entry) =>
        entry.name === request.executable.name &&
        entry.version === request.executable.version &&
        entry.digest === request.executable.digest,
    )
  ) {
    return {
      ok: false,
      failure: new ApiFailure(
        'IDENTITY_MISMATCH',
        'The executable is not one of the executables of the recorded release.',
      ),
    };
  }
  const now = env.clock();
  // An attempt that cannot be claimed is told why (it is claimed, ended or of another revision), never "try later".
  const claimable =
    located.attempt.status === 'PENDING' && located.attempt.ownership_revision === request.attempt.ownership_revision;
  // The mission lock (taken by locate) serialises claims of one mission, so the count below cannot be raced. A replay
  // runs one attempt at a time by construction and has no cohort policy, so it has no concurrency limit of its own.
  const limit =
    policy === undefined
      ? Number.POSITIVE_INFINITY
      : expected === 'batch'
        ? policy.document.limits.concurrent_batch_attempts
        : policy.document.limits.concurrent_agent_attempts;
  const held = mission === undefined ? 0 : await heldSlots(tx, mission.mission_id, dispatch.destination);
  if (claimable && held >= limit) {
    return {
      ok: false,
      failure: new ApiFailure(
        'RATE_LIMITED',
        `The mission already has ${limit} ${expected} attempts that hold a slot: claim again later.`,
        {
          retrySafe: true,
        },
      ),
    };
  }
  const timeout =
    policy === undefined
      ? (await findReplay(tx, work.replayId as string)).evaluate_seconds
      : timeoutSeconds(policy.document.limits, work.dispatchKind);
  const seconds = timeout + LEASE_GRACE_SECONDS;
  const leaseExpiresAt = new Date(Math.floor((now.getTime() + seconds * 1000) / 1000) * 1000);
  const token = await signCapability(env.secrets.tokenSigningKey, {
    sub: claimer.principalId,
    env: env.environment,
    att: attemptId,
    own: request.attempt.ownership_revision,
    iat: Math.floor(now.getTime() / 1000),
    exp: Math.floor(leaseExpiresAt.getTime() / 1000),
  });
  const claimed = await claimAttempt(tx, ctx, {
    attemptId,
    ownershipRevision: request.attempt.ownership_revision,
    dispatchDigest: request.dispatch_digest,
    workerId: request.worker_id,
    executable: request.executable,
    leaseExpiresAt,
    capabilityHash: await capabilityHash(token),
  });
  if (!claimed.ok) return claimed;
  const grant = {
    schema_version: 'attempt-claim/1',
    form: 'grant',
    attempt: request.attempt,
    granted_at: timestamp(now),
    lease_expires_at: timestamp(leaseExpiresAt),
    capability: { token },
  };
  const checked = validateContract('attempt-claim', grant);
  if (!checked.ok) throw new Error(`The API built an invalid attempt grant: ${checked.error.message}`);
  return { ok: true, value: checked.value as AttemptClaimGrant };
}

// A retrieval result (OQ-05 sections 4 and 7.1). The batch host fetched provider data, froze it as a dataset manifest and
// uploaded it. The API checks that the manifest binds to the request it answers, records it as the mission's one
// snapshot, completes the job with its coverage, settles the usage, and records the evaluation plan. A failure is
// classified: only transient classes are retried, within the attempt cap and the budget; the others end the job.

import type { DatasetManifest, RetrievalResult } from '@openquant/api-contracts';
import { canonicalJson, digest } from '@openquant/api-contracts';
import type { Queryable } from '../db/database.ts';
import { ApiFailure } from '../errors.ts';
import { completeAttempt, failAttempt, type Guarded, type WorkContext } from './attempts.ts';
import { openAttention } from './attention.ts';
import type { UsageReport } from './budget.ts';
import { loadProfile } from './documents.ts';
import { blockMission, bumpMission } from './missions.ts';
import { barAvailability, recordPlan } from './plan.ts';
import { claimedExecutable, dispatchOf, loadCited, requestRefOf, sameExecutable } from './refs.ts';
import { countUsage, durationUsage, openResult, repeatOutcome } from './results.ts';
import { findMission, type MissionRow } from './rows.ts';
import { storeDocument } from './store.ts';

function mismatch(message: string): ApiFailure {
  return new ApiFailure('IDENTITY_MISMATCH', message);
}

const same = (left: unknown, right: unknown): boolean => canonicalJson(left as never) === canonicalJson(right as never);

/** The checks of a manifest against the retrieval it answers. Throws IDENTITY_MISMATCH; nothing is written yet. */
export function checkManifest(
  manifest: DatasetManifest,
  expected: {
    jobId: string;
    attemptId: string;
    requestDigest: string;
    mission: MissionRow;
    profile: { id: string; revision: number; digest: string; data: unknown; history: unknown; delayMinutes: number };
    executable: { name: string; version: string; digest: string };
    completeness: string;
  },
): void {
  const { retrieval, instrument, source, coverage } = manifest;
  if (retrieval.job_id !== expected.jobId || retrieval.attempt_id !== expected.attemptId) {
    throw mismatch('The manifest was not produced by this job and attempt.');
  }
  if (retrieval.request_digest !== expected.requestDigest) {
    throw mismatch('The manifest answers another retrieval request than the one of this attempt.');
  }
  const { mission } = expected;
  if (
    instrument.instrument_id !== mission.instrument_id ||
    instrument.symbol !== mission.symbol ||
    instrument.provider !== mission.provider ||
    instrument.provider_asset_id !== mission.provider_asset_id ||
    instrument.effective_from !== mission.instrument_effective_from
  ) {
    throw mismatch('The manifest is for another instrument than the one of the mission.');
  }
  const profile = expected.profile;
  if (
    source.profile.id !== profile.id ||
    source.profile.revision !== profile.revision ||
    source.profile.digest !== profile.digest
  ) {
    throw mismatch('The manifest was built under another research profile revision than the one of the mission.');
  }
  if (!sameExecutable(source.executable, expected.executable)) {
    throw mismatch('The manifest was built by another executable than the one that claimed this attempt.');
  }
  if (!same(manifest.semantics, profile.data)) {
    throw mismatch('The data semantics of the manifest are not those of the research profile.');
  }
  if (coverage.completeness !== expected.completeness) {
    throw mismatch('The coverage of the manifest does not repeat the status of the retrieval result.');
  }
  if (!same(coverage.requested, profile.history)) {
    throw mismatch('The manifest covers another range than the one the profile requests.');
  }
  // Every bar is available at its session close plus the profile's delay (SESSION_CLOSE_PLUS_DELAY).
  const sessions = new Map(manifest.content.calendar.map((entry) => [entry.session, entry]));
  for (const bar of manifest.content.bars) {
    const session = sessions.get(bar.session);
    if (session === undefined || bar.available_at !== barAvailability(session, profile.delayMinutes)) {
      throw mismatch(`The availability of the bar of ${bar.session} does not follow the rule of the research profile.`);
    }
  }
}

function usageOf(result: RetrievalResult): UsageReport {
  return {
    PROVIDER_REQUESTS: countUsage(result.usage.provider_requests),
    BATCH_COMPUTE_SECONDS: durationUsage(result.usage.duration),
  };
}

export type RetrievalAccepted = 'COMPLETED' | 'RETRIED' | 'FAILED' | 'WAITING' | 'REPEATED';

export async function acceptRetrievalResult(
  tx: Queryable,
  ctx: WorkContext,
  principalId: string,
  result: RetrievalResult,
): Promise<Guarded<RetrievalAccepted>> {
  const gate = await openResult(tx, ctx, result.attempt.attempt_id, result.attempt.ownership_revision);
  if (gate.kind === 'rejected') return { ok: false, failure: gate.failure };
  const { env } = ctx;
  const submissionDigest = await digest(result as never);
  if (gate.kind === 'repeat') {
    const repeat = repeatOutcome(gate.located, submissionDigest);
    return repeat.ok ? { ok: true, value: 'REPEATED' } : { ok: false, failure: repeat.failure };
  }
  const { mission, work, attempt } = gate.located;
  if (work.kind !== 'job' || work.dispatchKind !== 'retrieve') {
    throw mismatch('This attempt does not belong to a retrieve job.');
  }
  if (result.job_id !== work.id) throw mismatch('The result is for another job than the one of this attempt.');
  const dispatch = await dispatchOf(tx, attempt.attempt_id);
  const requestRef = requestRefOf(dispatch.message);
  if (result.request_digest !== requestRef.digest) {
    throw mismatch('The result answers another retrieval request than the one of this attempt.');
  }
  const executable = await claimedExecutable(tx, attempt.attempt_id);
  if (!sameExecutable(result.executable, executable)) {
    throw mismatch('The result comes from another executable than the one that claimed this attempt.');
  }
  const usage = usageOf(result);
  const outcome = result.outcome;

  if (outcome.status === 'FAILED') {
    const stored = await storeDocument(tx, env, 'retrieval-result', result, principalId);
    const failed = await failAttempt(tx, ctx, {
      attemptId: attempt.attempt_id,
      ownershipRevision: attempt.ownership_revision,
      cause: { kind: 'RETRIEVAL', errorClass: outcome.error, retryable: outcome.retryable },
      usage,
      resultDigest: stored.ref.digest,
    });
    if (!failed.ok) return failed;
    if (failed.value.outcome === 'FAILED') {
      // The job ended for good: attempts.ts blocked the mission and opened the attention item.
      await tx.query(
        `INSERT INTO retrieval_results (job_id, attempt_id, result_digest, outcome, error_class, retryable, recorded_at)
         VALUES ($1, $2, $3, 'FAILED', $4, $5, $6)`,
        [work.id, attempt.attempt_id, stored.ref.digest, outcome.error, outcome.retryable, env.clock()],
      );
    }
    return { ok: true, value: failed.value.outcome };
  }

  // A snapshot: bind the manifest, record it and the plan, complete the job.
  const manifest = await loadCited(tx, env, 'dataset-manifest', outcome.manifest, 'manifest');
  const profile = await loadProfile(tx, env, mission.profile_id, mission.profile_revision);
  if (profile === undefined) throw new Error(`The profile of mission ${mission.mission_id} is missing.`);
  checkManifest(manifest, {
    jobId: work.id,
    attemptId: attempt.attempt_id,
    requestDigest: requestRef.digest,
    mission,
    profile: {
      id: profile.id,
      revision: profile.revision,
      digest: profile.digest,
      data: profile.document.data,
      history: profile.document.history,
      delayMinutes: profile.document.data.bar_availability.delay_minutes,
    },
    executable,
    completeness: outcome.status,
  });
  const stored = await storeDocument(tx, env, 'retrieval-result', result, principalId);
  const done = await completeAttempt(tx, ctx, {
    attemptId: attempt.attempt_id,
    ownershipRevision: attempt.ownership_revision,
    workStatus: 'COMPLETED',
    usage,
    resultDigest: stored.ref.digest,
  });
  if (!done.ok) return done;
  await tx.query(
    `INSERT INTO dataset_manifests (manifest_digest, mission_id, job_id, completeness, retrieved_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [outcome.manifest.digest, mission.mission_id, work.id, outcome.status, manifest.retrieval.retrieved_at],
  );
  await tx.query(
    `INSERT INTO retrieval_results (job_id, attempt_id, result_digest, outcome, manifest_digest, recorded_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [work.id, attempt.attempt_id, stored.ref.digest, outcome.status, outcome.manifest.digest, env.clock()],
  );
  const current = (await findMission(tx, mission.mission_id)) as MissionRow;
  if (outcome.status === 'NO_OBSERVATIONS') {
    const reason = `The retrieval ${work.id} returned no observations: no run can be planned.`;
    await blockMission(tx, env, current, reason, ctx.actorId);
    await openAttention(tx, env, mission.mission_id, `retrieve job ${work.id}`, reason);
    return { ok: true, value: 'COMPLETED' };
  }
  const plan = await recordPlan(tx, env, current, manifest, outcome.manifest, principalId);
  if (!plan.ok) {
    // Required data is missing, or a window cannot be resolved: the work that depends on it is blocked, with the reason.
    await blockMission(tx, env, current, plan.reason, ctx.actorId);
    await openAttention(tx, env, mission.mission_id, `retrieve job ${work.id}`, plan.reason);
    return { ok: true, value: 'COMPLETED' };
  }
  const latest = (await findMission(tx, mission.mission_id)) as MissionRow;
  await bumpMission(tx, latest);
  return { ok: true, value: 'COMPLETED' };
}

// A validation result (OQ-02 sections 3.1 and 4, OQ-05 section 4, decisions D8 and D9). The Rust validate job ran the
// shared strategy validator on a draft, checked that its longest lookback fits the warm-up and, for a revision,
// recomputed the leaf difference from the parent and classified its change scope. The API trusts none of that blindly:
// it binds the result to the draft and the parent that the job was asked about, to the declared changes of the draft,
// and to the release identity. A VALID result registers the draft as a Strategy Version in DRAFT. An INVALID one
// registers nothing and its diagnostics go to the next proposer attempt. Either way the job is COMPLETED.

import type { StrategyArtefact, ValidationResult } from '@openquant/api-contracts';
import { canonicalJson, digest } from '@openquant/api-contracts';
import type { Queryable } from '../db/database.ts';
import { ApiFailure } from '../errors.ts';
import { completeAttempt, type Guarded, type WorkContext } from './attempts.ts';
import { currentRelease, loadPolicy } from './documents.ts';
import { claimedExecutable, loadCited, sameExecutable } from './refs.ts';
import { durationUsage, openResult, repeatOutcome } from './results.ts';
import { artefactRef, storeDocument } from './store.ts';
import { assertTransition } from './transitions.ts';

function mismatch(message: string): ApiFailure {
  return new ApiFailure('IDENTITY_MISMATCH', message);
}

/** The release identity that derived evidence must carry. Without a recorded release nothing can be verified. */
export async function requireRelease(tx: Queryable, environment: string) {
  const release = await currentRelease(tx, environment);
  if (release === undefined) {
    throw mismatch(
      `No release identity is recorded for ${environment}: the engine and method of a result cannot be verified.`,
    );
  }
  return release;
}

interface JobRow {
  job_id: string;
  trial_slot: string | null;
  draft_digest: string | null;
  parent_hash: string | null;
}

const changeKey = (change: { path: string; from: string; to: string }): string => canonicalJson(change);

/** The declared changes of a revision draft equal the changes that Rust computed, as sets. */
export function sameChanges(
  declared: readonly { path: string; from: string; to: string }[],
  computed: readonly { path: string; from: string; to: string }[],
): boolean {
  const left = new Set(declared.map(changeKey));
  const right = new Set(computed.map(changeKey));
  return left.size === right.size && declared.length === computed.length && [...left].every((key) => right.has(key));
}

export type ValidationAccepted = 'REGISTERED' | 'INVALID' | 'REPEATED';

export async function acceptValidationResult(
  tx: Queryable,
  ctx: WorkContext,
  principalId: string,
  result: ValidationResult,
): Promise<Guarded<ValidationAccepted>> {
  const gate = await openResult(tx, ctx, result.attempt.attempt_id, result.attempt.ownership_revision);
  if (gate.kind === 'rejected') return { ok: false, failure: gate.failure };
  const { env } = ctx;
  const submissionDigest = await digest(result);
  if (gate.kind === 'repeat') {
    const repeat = repeatOutcome(gate.located, submissionDigest);
    return repeat.ok ? { ok: true, value: 'REPEATED' } : { ok: false, failure: repeat.failure };
  }
  const { mission, work, attempt } = gate.located;
  if (work.kind !== 'job' || work.dispatchKind !== 'validate') {
    throw mismatch('This attempt does not belong to a validate job.');
  }
  const jobRows = await tx.query<JobRow>(
    'SELECT job_id, trial_slot, draft_digest, parent_hash FROM jobs WHERE job_id = $1',
    [work.id],
  );
  const job = jobRows.rows[0] as JobRow;
  if (job.draft_digest === null || job.trial_slot === null)
    throw new Error(`The validate job ${work.id} names no draft.`);
  if (result.job_id !== work.id) throw mismatch('The result is for another job than the one of this attempt.');
  if (result.draft_digest !== job.draft_digest) {
    throw mismatch('The result validated another draft than the one that the job asked about.');
  }
  const isRevision = 'parent_hash' in result;
  if (isRevision !== (job.parent_hash !== null) || (isRevision && result.parent_hash !== job.parent_hash)) {
    throw mismatch('The result names another parent than the one that the job asked about.');
  }
  const release = await requireRelease(tx, env.environment);
  if (result.engine_digest !== release.engine.engine_digest) {
    throw mismatch('The result was computed by another engine than the one of the recorded release.');
  }
  if (canonicalJson(result.method) !== canonicalJson(release.method)) {
    throw mismatch('The result carries another method identity than the one of the recorded release.');
  }
  const executable = await claimedExecutable(tx, attempt.attempt_id);
  if (!sameExecutable(result.executable, executable)) {
    throw mismatch('The result comes from another executable than the one that claimed this attempt.');
  }

  const draftRef = await artefactRef(tx, job.draft_digest);
  if (draftRef === undefined) throw new Error(`The draft ${job.draft_digest} of job ${work.id} is not recorded.`);
  const draft: StrategyArtefact = await loadCited(tx, env, 'strategy-artefact', draftRef, 'draft');
  const policy = await loadPolicy(tx, env, mission.policy_id, mission.policy_revision);
  if (policy === undefined) throw new Error(`The policy of mission ${mission.mission_id} is missing.`);
  const outcome = result.outcome;
  if (outcome.status === 'VALID') {
    // A seed has no parent and is version 1; a revision names its parent in the draft, and its declared changes are
    // the leaf difference that Rust computed (lineage, OQ-02 section 3.1).
    if (!isRevision) {
      if (draft.parent !== undefined || draft.version !== 1) {
        throw mismatch('A seed draft has no parent and is version 1.');
      }
    } else {
      if (draft.parent === undefined || draft.parent.hash !== result.parent_hash) {
        throw mismatch('The draft does not name the parent that the result validated against.');
      }
      if (!('computed_changes' in outcome) || !sameChanges(draft.parent.changes, outcome.computed_changes)) {
        throw mismatch('The changes that the draft declares are not the changes that the validation computed.');
      }
      const parent = await tx.query<{ strategy_id: string; version: number }>(
        'SELECT strategy_id, version FROM strategy_versions WHERE strategy_hash = $1 AND mission_id = $2',
        [result.parent_hash, mission.mission_id],
      );
      const parentVersion = parent.rows[0];
      if (parentVersion === undefined || parentVersion.strategy_id !== draft.strategy_id) {
        throw mismatch('The parent is not a registered Strategy Version of this strategy in this mission.');
      }
    }
    const warmup = policy.document.conditions.windows.warmup_sessions;
    if (outcome.warmup_sessions !== warmup || outcome.max_lookback_sessions > outcome.warmup_sessions) {
      throw mismatch('The warm-up or the lookback of the result does not fit the cohort policy.');
    }
    const taken = await tx.query(`SELECT 1 FROM strategy_versions WHERE strategy_id = $1 AND version = $2`, [
      draft.strategy_id,
      draft.version,
    ]);
    if (taken.rows.length > 0) throw mismatch('This version of the strategy is registered already.');
  }

  const stored = await storeDocument(tx, env, 'validation-result', result, principalId);
  const done = await completeAttempt(tx, ctx, {
    attemptId: attempt.attempt_id,
    ownershipRevision: attempt.ownership_revision,
    workStatus: 'COMPLETED',
    usage: { BATCH_COMPUTE_SECONDS: durationUsage(result.duration) },
    resultDigest: stored.ref.digest,
  });
  if (!done.ok) return done;

  const trial = await tx.query<{ trial_id: string }>(
    `SELECT trial_id FROM trials WHERE mission_id = $1 AND trial_slot = $2 AND draft_digest = $3 AND status = 'DRAFTED'`,
    [mission.mission_id, job.trial_slot, job.draft_digest],
  );
  const trialId = trial.rows[0]?.trial_id;
  if (trialId === undefined)
    throw new Error(`The draft ${job.draft_digest} has no DRAFTED trial in ${job.trial_slot}.`);
  const now = env.clock();
  if (outcome.status === 'VALID') {
    await tx.query(
      `INSERT INTO strategy_versions (strategy_hash, strategy_id, version, parent_hash, mission_id, registered_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [job.draft_digest, draft.strategy_id, draft.version, draft.parent?.hash ?? null, mission.mission_id, now],
    );
    assertTransition('trial', 'DRAFTED', 'REGISTERED');
    await tx.query(`UPDATE trials SET status = 'REGISTERED', strategy_hash = $2 WHERE trial_id = $1`, [
      trialId,
      job.draft_digest,
    ]);
    if (isRevision && 'change_scope' in outcome) {
      await tx.query(
        `INSERT INTO strategy_lineage (child_hash, parent_hash, change_scope, validation_digest, recorded_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [job.draft_digest, result.parent_hash, outcome.change_scope, stored.ref.digest, now],
      );
    }
    await tx.query(
      `INSERT INTO validation_results (job_id, attempt_id, result_digest, draft_digest, status, change_scope, strategy_hash, recorded_at)
       VALUES ($1, $2, $3, $4, 'VALID', $5, $6, $7)`,
      [
        work.id,
        attempt.attempt_id,
        stored.ref.digest,
        job.draft_digest,
        'change_scope' in outcome ? outcome.change_scope : null,
        job.draft_digest,
        now,
      ],
    );
    return { ok: true, value: 'REGISTERED' };
  }
  const reason = outcome.diagnostics
    .map((entry) => `${entry.code}${entry.pointer === '' ? '' : ` at ${entry.pointer}`}`)
    .join('; ')
    .slice(0, 1000);
  assertTransition('trial', 'DRAFTED', 'INVALID');
  await tx.query(`UPDATE trials SET status = 'INVALID', reason = $2 WHERE trial_id = $1`, [trialId, reason]);
  await tx.query(
    `INSERT INTO validation_results (job_id, attempt_id, result_digest, draft_digest, status, recorded_at)
     VALUES ($1, $2, $3, $4, 'INVALID', $5)`,
    [work.id, attempt.attempt_id, stored.ref.digest, job.draft_digest, now],
  );
  return { ok: true, value: 'INVALID' };
}

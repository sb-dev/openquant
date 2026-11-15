// The dispatch messages of the work that part C creates or retries (OQ-05 section 4): validate and assess jobs, and the
// retry of an agent attempt. dispatch.ts builds the two kinds that the commands create (retrieve, evaluate).
//
//   validate   references the draft that the job names, its registered parent, and the cohort policy
//   assess     references the plan, the candidate's slot, the policy, the validation result, every run of the slot with its
//              committed submission, and the dataset manifest
//   agent      the first attempt is built by the workflow that assembles the role request (OQ-03 section 3; P5). A retry
//              repeats the message of the attempt before it, for its own attempt, session and result route.
//
// The workflow starts validate and assess work with startValidation and startAssessment, which also take the
// guarded steps around it: the trial row of a proposal, the checks that nothing of the candidate is still open.

import type { ArtefactRef, JobDispatch } from '@openquant/api-contracts';
import { validateContract } from '@openquant/api-contracts';
import type { Queryable } from '../db/database.ts';
import { openAttempt, type WorkContext } from './attempts.ts';
import {
  type Binding,
  type Dispatch,
  type DispatchBuilder,
  type DispatchBuilders,
  defaultBuilders,
} from './dispatch.ts';
import { loadPolicy } from './documents.ts';
import { blockMission } from './missions.ts';
import { findMission, loadMissionBudget, lockMission, type MissionRow } from './rows.ts';
import { artefactRef } from './store.ts';
import { insertJob, type Work } from './work.ts';

function timestamp(date: Date): string {
  return `${date.toISOString().slice(0, 19)}Z`;
}

function assertValid(message: unknown): Record<string, unknown> {
  const checked = validateContract('job-dispatch', message);
  if (!checked.ok) throw new Error(`The API built an invalid job-dispatch message: ${checked.error.message}`);
  return checked.value as unknown as Record<string, unknown>;
}

async function requireRef(tx: Queryable, digest: string, what: string): Promise<ArtefactRef> {
  const ref = await artefactRef(tx, digest);
  if (ref === undefined) throw new Error(`The ${what} ${digest} is not a recorded artefact.`);
  return ref;
}

function envelope(
  missionId: string,
  work: Work,
  binding: Binding,
  environment: string,
  now: Date,
  inputs: unknown,
): Record<string, unknown> {
  return assertValid({
    schema_version: 'job-dispatch/1',
    environment,
    job_id: work.id,
    attempt: { attempt_id: binding.attemptId, ownership_revision: binding.ownershipRevision },
    mission_id: missionId,
    dispatched_at: timestamp(now),
    inputs,
  });
}

export const buildValidate: DispatchBuilder = async ({ tx, env }, work, binding): Promise<Dispatch> => {
  const row = await tx.query<{ draft_digest: string | null; parent_hash: string | null }>(
    'SELECT draft_digest, parent_hash FROM jobs WHERE job_id = $1',
    [work.id],
  );
  const job = row.rows[0];
  if (job?.draft_digest == null) throw new Error(`The validate job ${work.id} names no draft.`);
  const mission = (await findMission(tx, work.missionId)) as MissionRow;
  const policy = await loadPolicy(tx, env, mission.policy_id, mission.policy_revision);
  if (policy === undefined) throw new Error(`The policy of mission ${mission.mission_id} is missing.`);
  const inputs = {
    kind: 'validate',
    draft: await requireRef(tx, job.draft_digest, 'draft'),
    ...(job.parent_hash === null ? {} : { parent: await requireRef(tx, job.parent_hash, 'parent') }),
    cohort_policy: await requireRef(tx, policy.digest, 'cohort policy'),
  };
  return {
    destination: 'BATCH_QUEUE',
    message: envelope(mission.mission_id, work, binding, env.environment, env.clock(), inputs),
  };
};

export const buildAssess: DispatchBuilder = async ({ tx, env }, work, binding): Promise<Dispatch> => {
  if (work.trialSlot === null) throw new Error(`The assess job ${work.id} names no trial slot.`);
  const mission = (await findMission(tx, work.missionId)) as MissionRow;
  const policy = await loadPolicy(tx, env, mission.policy_id, mission.policy_revision);
  if (policy === undefined) throw new Error(`The policy of mission ${mission.mission_id} is missing.`);
  const plan = await tx.query<{ plan_digest: string }>(
    'SELECT plan_digest FROM evaluation_plans WHERE mission_id = $1',
    [mission.mission_id],
  );
  const candidate = await tx.query<{ strategy_hash: string }>(
    `SELECT strategy_hash FROM trials WHERE mission_id = $1 AND trial_slot = $2 AND status = 'REGISTERED'`,
    [mission.mission_id, work.trialSlot],
  );
  const strategyHash = candidate.rows[0]?.strategy_hash;
  const planDigest = plan.rows[0]?.plan_digest;
  if (strategyHash === undefined || planDigest === undefined)
    throw new Error(`The slot ${work.trialSlot} has no candidate to assess.`);
  const validation = await tx.query<{ result_digest: string }>(
    'SELECT result_digest FROM validation_results WHERE strategy_hash = $1',
    [strategyHash],
  );
  const runs = await tx.query<{
    run_id: string;
    run_slot: string;
    status: string;
    window_role: string;
    cost_scenario: string;
    replay_of: string | null;
    submission_digest: string | null;
  }>(
    `SELECT r.run_id, r.run_slot, r.status, r.window_role, r.cost_scenario, o.run_slot AS replay_of, s.submission_digest
       FROM runs r LEFT JOIN runs o ON o.run_id = r.repeat_of_run LEFT JOIN results s ON s.run_id = r.run_id
      WHERE r.mission_id = $1 AND r.trial_slot = $2 ORDER BY r.run_slot`,
    [mission.mission_id, work.trialSlot],
  );
  const manifests = await tx.query<{ manifest_digest: string }>(
    'SELECT manifest_digest FROM dataset_manifests WHERE mission_id = $1',
    [mission.mission_id],
  );
  const validationDigest = validation.rows[0]?.result_digest;
  if (validationDigest === undefined) throw new Error(`The candidate ${strategyHash} has no validation result.`);
  // One statement at a time on the transaction's connection.
  const assessed: Record<string, unknown>[] = [];
  for (const run of runs.rows) {
    assessed.push({
      run_id: run.run_id,
      run_slot: run.run_slot,
      status: run.status,
      window_role: run.window_role,
      cost_scenario: run.cost_scenario,
      ...(run.replay_of === null ? {} : { replay_of: run.replay_of }),
      ...(run.submission_digest === null
        ? {}
        : { submission: await requireRef(tx, run.submission_digest, 'submission') }),
    });
  }
  const manifestRefs: ArtefactRef[] = [];
  for (const row of manifests.rows) manifestRefs.push(await requireRef(tx, row.manifest_digest, 'dataset manifest'));
  const inputs = {
    kind: 'assess',
    strategy_hash: strategyHash,
    plan: await requireRef(tx, planDigest, 'plan'),
    trial_slot: work.trialSlot,
    cohort_policy: await requireRef(tx, policy.digest, 'cohort policy'),
    validation: await requireRef(tx, validationDigest, 'validation result'),
    runs: assessed,
    manifests: manifestRefs,
  };
  return {
    destination: 'BATCH_QUEUE',
    message: envelope(mission.mission_id, work, binding, env.environment, env.clock(), inputs),
  };
};

/** A retry of agent work repeats the message of the attempt before it, for the new attempt, a fresh session and route. */
export const retryAgent: DispatchBuilder = async ({ tx, env }, work, binding): Promise<Dispatch> => {
  const previous = await tx.query<{ message: Record<string, unknown> }>(
    `SELECT o.message FROM outbox o JOIN attempts a ON a.attempt_id = o.attempt_id
      WHERE a.job_id = $1 ORDER BY a.ownership_revision DESC LIMIT 1`,
    [work.id],
  );
  const first = previous.rows[0]?.message;
  if (first === undefined) {
    throw new Error(
      `The first attempt of the agent run ${work.id} is built by the workflow that assembles its request.`,
    );
  }
  const identity = first.identity as Record<string, unknown>;
  const message = {
    ...first,
    identity: {
      ...identity,
      attempt: { attempt_id: binding.attemptId, ownership_revision: binding.ownershipRevision },
      session_id: env.ids.next('sess'),
    },
    result_route: `/v1/attempts/${binding.attemptId}/agent-result`,
  };
  const checked = validateContract('agent-dispatch', message);
  if (!checked.ok) throw new Error(`The API built an invalid agent-dispatch message: ${checked.error.message}`);
  return { destination: 'AGENT_RUNNER', message: message as Record<string, unknown> };
};

/** Every kind that the API can build or retry. The first attempt of agent work is supplied by its caller. */
export const allBuilders: DispatchBuilders = {
  ...defaultBuilders,
  validate: buildValidate,
  assess: buildAssess,
  agent: retryAgent,
};

export type Started =
  | { readonly ok: true; readonly jobId: string; readonly attemptId: string; readonly ownershipRevision: number }
  | { readonly ok: false; readonly reason: string };

/**
 * Start the validation of a draft in a mission: the proposal's trial row (DRAFTED), a validate job and its first
 * attempt with its reservation and outbox entry. The mission must be IN_PROGRESS and the slot must exist in its plan.
 * With no budget for the attempt the mission is BLOCKED and the reason is returned.
 */
export async function startValidation(
  tx: Queryable,
  ctx: WorkContext,
  input: { missionId: string; trialSlot: string; draftDigest: string; parentHash?: string },
): Promise<Started> {
  const mission = await lockMission(tx, input.missionId);
  if (mission.status !== 'IN_PROGRESS') return { ok: false, reason: `The mission is ${mission.status}.` };
  const slot = await tx.query<{
    slot_kind: 'SEED' | 'REVISION';
    draft_digest: string | null;
    parent_slot: string | null;
  }>('SELECT slot_kind, draft_digest, parent_slot FROM trial_slots WHERE mission_id = $1 AND trial_slot = $2', [
    mission.mission_id,
    input.trialSlot,
  ]);
  const planned = slot.rows[0];
  if (planned === undefined) return { ok: false, reason: `The plan has no trial slot ${input.trialSlot}.` };
  // Lineage (OQ-02 section 3.1): the seed slot validates the seed draft and has no parent; a revision slot validates a
  // controlled revision of the registered seed, so its parent is the Strategy Version registered for the parent slot.
  if (planned.slot_kind === 'SEED') {
    if (input.parentHash !== undefined) return { ok: false, reason: 'The seed has no parent.' };
    if (input.draftDigest !== planned.draft_digest) {
      return { ok: false, reason: `The seed slot ${input.trialSlot} validates the seed draft of the plan only.` };
    }
  } else {
    const parent = await tx.query<{ strategy_hash: string }>(
      `SELECT strategy_hash FROM trials WHERE mission_id = $1 AND trial_slot = $2 AND status = 'REGISTERED'`,
      [mission.mission_id, planned.parent_slot],
    );
    const registered = parent.rows[0]?.strategy_hash;
    if (registered === undefined) {
      return { ok: false, reason: `The slot ${planned.parent_slot} has no registered Strategy Version to revise yet.` };
    }
    if (input.parentHash !== registered) {
      return {
        ok: false,
        reason: `A revision in ${input.trialSlot} revises the Strategy Version registered for ${planned.parent_slot}: ${registered}.`,
      };
    }
  }
  const budget = await loadMissionBudget(tx, mission.mission_id);
  if (planned.slot_kind === 'REVISION') {
    const proposed = await tx.query<{ proposals: number }>(
      'SELECT count(*)::int AS proposals FROM trials WHERE mission_id = $1 AND trial_slot = $2',
      [mission.mission_id, input.trialSlot],
    );
    if ((proposed.rows[0]?.proposals ?? 0) >= budget.revisions_per_proposer) {
      return {
        ok: false,
        reason: `The slot ${input.trialSlot} has used its ${budget.revisions_per_proposer} proposals of the mission budget.`,
      };
    }
  }
  const ordinal = await tx.query<{ next: number }>(
    'SELECT COALESCE(MAX(proposal_ordinal), 0)::int + 1 AS next FROM trials WHERE mission_id = $1 AND trial_slot = $2',
    [mission.mission_id, input.trialSlot],
  );
  await tx.query(
    `INSERT INTO trials (trial_id, mission_id, trial_slot, proposal_ordinal, draft_digest, created_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      ctx.env.ids.next('trial'),
      mission.mission_id,
      input.trialSlot,
      ordinal.rows[0]?.next,
      input.draftDigest,
      ctx.env.clock(),
    ],
  );
  const job = await insertJob(tx, ctx.env, {
    missionId: mission.mission_id,
    kind: 'validate',
    attemptCap: budget.attempt_cap,
    trialSlot: input.trialSlot,
    draftDigest: input.draftDigest,
    ...(input.parentHash === undefined ? {} : { parentHash: input.parentHash }),
  });
  const opened = await openAttempt(tx, ctx, job);
  if (!opened.ok) {
    await blockMission(
      tx,
      ctx.env,
      mission,
      `The validation of ${input.draftDigest} cannot be reserved: ${opened.reason}`,
      ctx.actorId,
    );
    return { ok: false, reason: opened.reason };
  }
  return { ok: true, jobId: job.id, attemptId: opened.attemptId, ownershipRevision: opened.ownershipRevision };
}

/**
 * Start the assessment of one candidate: its gate report is written by a Rust assess job from the official results of
 * every run of its slot. The candidate must be in EVALUATING, every run of its slot must have ended and its holdout runs
 * must exist (freeze_candidates wrote them).
 */
export async function startAssessment(
  tx: Queryable,
  ctx: WorkContext,
  input: { missionId: string; trialSlot: string },
): Promise<Started> {
  const mission = await lockMission(tx, input.missionId);
  if (mission.status !== 'IN_PROGRESS') return { ok: false, reason: `The mission is ${mission.status}.` };
  const candidate = await tx.query<{ strategy_hash: string; lifecycle: string }>(
    `SELECT v.strategy_hash, v.lifecycle FROM trials t JOIN strategy_versions v ON v.strategy_hash = t.strategy_hash
      WHERE t.mission_id = $1 AND t.trial_slot = $2 AND t.status = 'REGISTERED'`,
    [mission.mission_id, input.trialSlot],
  );
  const version = candidate.rows[0];
  if (version === undefined || version.lifecycle !== 'EVALUATING') {
    return { ok: false, reason: `The slot ${input.trialSlot} has no candidate in EVALUATING.` };
  }
  const planned = await tx.query<{ planned: number; written: number; open: number }>(
    `SELECT (SELECT count(*) FROM run_slots WHERE mission_id = $1 AND trial_slot = $2)::int AS planned,
            (SELECT count(*) FROM runs WHERE mission_id = $1 AND trial_slot = $2)::int AS written,
            (SELECT count(*) FROM runs WHERE mission_id = $1 AND trial_slot = $2 AND status IN ('QUEUED', 'RUNNING'))::int AS open`,
    [mission.mission_id, input.trialSlot],
  );
  const counts = planned.rows[0];
  if (counts === undefined || counts.written !== counts.planned) {
    return {
      ok: false,
      reason: `Not every planned run of ${input.trialSlot} is written: the candidates are not frozen.`,
    };
  }
  if (counts.open > 0) return { ok: false, reason: `A run of ${input.trialSlot} has not ended.` };
  const existing = await tx.query(
    `SELECT 1 FROM jobs WHERE mission_id = $1 AND trial_slot = $2 AND kind = 'assess' AND status <> 'CANCELLED'`,
    [mission.mission_id, input.trialSlot],
  );
  if (existing.rows.length > 0) return { ok: false, reason: `The slot ${input.trialSlot} is assessed already.` };
  const budget = await loadMissionBudget(tx, mission.mission_id);
  const job = await insertJob(tx, ctx.env, {
    missionId: mission.mission_id,
    kind: 'assess',
    attemptCap: budget.attempt_cap,
    trialSlot: input.trialSlot,
  });
  const opened = await openAttempt(tx, ctx, job);
  if (!opened.ok) {
    await blockMission(
      tx,
      ctx.env,
      mission,
      `The assessment of ${input.trialSlot} cannot be reserved: ${opened.reason}`,
      ctx.actorId,
    );
    return { ok: false, reason: opened.reason };
  }
  return { ok: true, jobId: job.id, attemptId: opened.attemptId, ownershipRevision: opened.ownershipRevision };
}

export type { JobDispatch };

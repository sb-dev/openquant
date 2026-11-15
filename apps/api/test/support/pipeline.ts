// The steps between a started mission and its frozen candidates, as the workflows service principal takes them: a
// critique that completed or ended without a result, and the policy-determined Decision that follows it.

import { claim, complete, fail, startAgentJob } from './attempts.ts';
import { ids, sha } from './seed.ts';
import type { Doc, World } from './world.ts';

export async function missionRevision(world: World): Promise<number> {
  const rows = await world.sql<{ revision: number }>('SELECT revision FROM missions WHERE mission_id = $1', [
    world.records.missionId,
  ]);
  return rows[0]?.revision as number;
}

/** A critic attempt that completed with its result artefact. */
export async function completedCritique(world: World, slot: string) {
  const job = await startAgentJob(world, { slot });
  const claimed = await claim(world, job.attemptId);
  if (!claimed.ok) throw claimed.failure;
  const done = await complete(world, job.attemptId, {
    usage: {
      MODEL_SPEND: { label: 'estimated', amount: '3.25' },
      AGENT_COMPUTE_SECONDS: { label: 'observed', amount: '240' },
    },
  });
  if (!done.ok) throw done.failure;
  const result = { digest: sha(`critique-${slot}`), media_type: 'application/json', size_bytes: 1003 };
  await world.sql(
    `INSERT INTO artefacts (digest, media_type, size_bytes, stored_at, uploaded_by) VALUES ($1, 'application/json', 1003, $2, $3) ON CONFLICT DO NOTHING`,
    [result.digest, '2026-11-15T10:00:00Z', ids.runner],
  );
  // The agent-result route records the link between the attempt and its output: so does this stand-in for it.
  await world.sql(
    `INSERT INTO agent_results (attempt_id, job_id, role, outcome, result_digest, output_contract, output_digest, recorded_at)
     VALUES ($1, $2, 'CRITIC', 'completion', $3, 'strategy-critique.result/1', $3, $4)`,
    [job.attemptId, job.jobId, result.digest, '2026-11-15T10:00:00Z'],
  );
  return { status: 'COMPLETED', attempt_id: job.attemptId, result };
}

/** A critique job that ended without a result: its last attempt ended with this outcome after `attempts` attempts. */
export async function failedCritique(world: World, slot: string, outcome: 'refusal' | 'timeout', attempts: number) {
  const job = await startAgentJob(world, { slot });
  let attemptId = job.attemptId;
  for (let made = 1; made <= attempts; made += 1) {
    const claimed = await claim(world, attemptId);
    if (!claimed.ok) throw claimed.failure;
    const failed = await fail(world, attemptId, { kind: 'AGENT_OUTCOME', outcome });
    if (!failed.ok) throw failed.failure;
    if (failed.value.outcome === 'RETRIED') attemptId = failed.value.attemptId;
  }
  return { status: 'NO_VALID_RESULT', outcome, attempts };
}

export function decisionPayload(world: World, slot: string, strategyHash: string, critique: Doc, outcome: string): Doc {
  return {
    kind: 'record_evaluation_decision',
    mission_id: world.records.missionId,
    plan_digest: world.records.planDigest,
    trial_slot: slot,
    strategy_hash: strategyHash,
    critique,
    outcome,
    authority: {
      cohort_policy: structuredClone(world.records.policy),
      policy_approval: world.records.approvalId,
      mission_started_by: ids.researcher,
    },
  };
}

export async function decide(
  world: World,
  slot: string,
  outcome: 'APPROVED' | 'DEFERRED',
  critique: Doc,
  edit?: (payload: Doc) => void,
) {
  const versions = await world.sql<{ strategy_hash: string }>(
    `SELECT strategy_hash FROM trials WHERE mission_id = $1 AND trial_slot = $2`,
    [world.records.missionId, slot],
  );
  const payload = decisionPayload(world, slot, versions[0]?.strategy_hash as string, critique, outcome);
  edit?.(payload);
  return world.apply('workflows', payload, { expectedRevision: await missionRevision(world) });
}

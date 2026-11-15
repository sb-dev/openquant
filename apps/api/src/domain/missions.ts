// Mission status changes (OQ-02 section 1, decision D21). Every change goes through the transition table and a
// compare-and-set on the mission revision, and the caller holds the mission lock (rows.ts, lockMission). The revision
// grows on every change of the mission, so a workflow that read an older revision learns that the mission moved.

import { writeAudit } from '../audit.ts';
import type { Queryable } from '../db/database.ts';
import type { ApiEnv } from '../env.ts';
import { findMission, type MissionRow } from './rows.ts';
import { assertTransition } from './transitions.ts';

export interface MissionPatch {
  readonly startedBy?: string;
  readonly blockedReason?: string;
  readonly withdrawnBy?: string;
  readonly withdrawnReason?: string;
  readonly outcome?: 'ELIGIBLE_FOUND' | 'NO_ELIGIBLE_CANDIDATE';
  readonly outcomeReason?: string;
}

async function reread(tx: Queryable, missionId: string): Promise<MissionRow> {
  return (await findMission(tx, missionId)) as MissionRow;
}

/** Change the status of a mission. Returns the mission as it now is. */
export async function transitionMission(
  tx: Queryable,
  env: Pick<ApiEnv, 'clock'>,
  mission: MissionRow,
  to: MissionRow['status'],
  patch: MissionPatch = {},
): Promise<MissionRow> {
  assertTransition('mission', mission.status, to);
  const now = env.clock();
  const result = await tx.query(
    `UPDATE missions SET status = $3, revision = revision + 1,
            started_by = COALESCE($4::text, started_by),
            started_at = CASE WHEN $4::text IS NULL THEN started_at ELSE $5::timestamptz END,
            blocked_reason = COALESCE($6::text, blocked_reason),
            withdrawn_by = COALESCE($7::text, withdrawn_by),
            withdrawn_at = CASE WHEN $7::text IS NULL THEN withdrawn_at ELSE $5::timestamptz END,
            withdrawn_reason = COALESCE($8::text, withdrawn_reason),
            outcome = COALESCE($9::text, outcome), outcome_reason = COALESCE($10::text, outcome_reason),
            concluded_at = CASE WHEN $9::text IS NULL THEN concluded_at ELSE $5::timestamptz END
      WHERE mission_id = $1 AND revision = $2`,
    [
      mission.mission_id,
      mission.revision,
      to,
      patch.startedBy ?? null,
      now,
      patch.blockedReason ?? null,
      patch.withdrawnBy ?? null,
      patch.withdrawnReason ?? null,
      patch.outcome ?? null,
      patch.outcomeReason ?? null,
    ],
  );
  if (result.rowCount !== 1) throw new Error(`The mission ${mission.mission_id} changed under its lock.`);
  return reread(tx, mission.mission_id);
}

/** Count a change of the mission that is not a status change, such as a Decision, as a new revision. */
export async function bumpMission(tx: Queryable, mission: MissionRow): Promise<MissionRow> {
  const result = await tx.query('UPDATE missions SET revision = revision + 1 WHERE mission_id = $1 AND revision = $2', [
    mission.mission_id,
    mission.revision,
  ]);
  if (result.rowCount !== 1) throw new Error(`The mission ${mission.mission_id} changed under its lock.`);
  return reread(tx, mission.mission_id);
}

/**
 * Work cannot continue: an IN_PROGRESS mission becomes BLOCKED with the reason (OQ-02 section 1). In S1 only
 * cancel_mission ends it. A mission that is already BLOCKED keeps its first reason, and a mission that is not
 * IN_PROGRESS is left as it is. Returns the mission as it now is.
 */
export async function blockMission(
  tx: Queryable,
  env: Pick<ApiEnv, 'clock'>,
  mission: MissionRow,
  reason: string,
  actor: string,
): Promise<MissionRow> {
  if (mission.status !== 'IN_PROGRESS') return mission;
  const bounded = reason.length > 1000 ? `${reason.slice(0, 997)}...` : reason;
  const next = await transitionMission(tx, env, mission, 'BLOCKED', { blockedReason: bounded });
  await writeAudit(tx, env.clock(), {
    eventType: 'mission.blocked',
    actor,
    subject: mission.mission_id,
    detail: { reason: bounded, revision: next.revision },
  });
  return next;
}

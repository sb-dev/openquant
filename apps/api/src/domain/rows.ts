// Row shapes and loaders shared by the guarded commands and attempt functions. Loaders that end in ForUpdate take
// the row lock. Lock order, everywhere: the mission, then the run or job, then its attempts, then budget pools by id.
// A function that takes locks out of that order can deadlock with one that follows it.

import type { Queryable } from '../db/database.ts';
import type { Role, ServiceKind } from '../manifest.ts';
import { reject } from './rejection.ts';

export type MissionStatus = 'CREATED' | 'IN_PROGRESS' | 'BLOCKED' | 'WITHDRAWN' | 'CONCLUDED';

export interface MissionRow {
  readonly mission_id: string;
  readonly status: MissionStatus;
  readonly revision: number;
  readonly blocked_reason: string | null;
  readonly objective: string;
  readonly instrument_id: string;
  readonly symbol: string;
  readonly provider: string;
  readonly provider_asset_id: string;
  readonly instrument_effective_from: string;
  readonly profile_id: string;
  readonly profile_revision: number;
  readonly policy_id: string;
  readonly policy_revision: number;
  readonly seed_draft_digest: string;
  readonly created_by: string;
  readonly started_by: string | null;
}

const MISSION_COLUMNS = `mission_id, status, revision, blocked_reason, objective, instrument_id, symbol, provider,
  provider_asset_id, to_char(instrument_effective_from, 'YYYY-MM-DD') AS instrument_effective_from, profile_id, profile_revision, policy_id, policy_revision,
  seed_draft_digest, created_by, started_by`;

export async function findMission(tx: Queryable, missionId: string, lock = false): Promise<MissionRow | undefined> {
  const { rows } = await tx.query<MissionRow>(
    `SELECT ${MISSION_COLUMNS} FROM missions WHERE mission_id = $1${lock ? ' FOR UPDATE' : ''}`,
    [missionId],
  );
  return rows[0];
}

/** The mission, locked, or a NOT_FOUND refusal. */
export async function lockMission(tx: Queryable, missionId: string): Promise<MissionRow> {
  const mission = await findMission(tx, missionId, true);
  if (mission === undefined) throw reject('NOT_FOUND', `The mission ${missionId} does not exist.`);
  return mission;
}

export interface MissionBudgetRow {
  readonly currency: string;
  readonly candidates: number;
  readonly experiments: number;
  readonly revisions_per_proposer: number;
  readonly new_families: number;
  readonly proposer_count: number;
  readonly model_spend: string;
  readonly model_spend_per_attempt: string;
  readonly proposer_spend: string;
  readonly proposer_attempts: number;
  readonly critic_spend: string;
  readonly critic_attempts: number;
  readonly provider_requests: string;
  readonly batch_compute_seconds: string;
  readonly agent_compute_seconds: string;
  readonly attempt_cap: number;
}

export async function loadMissionBudget(tx: Queryable, missionId: string): Promise<MissionBudgetRow> {
  const { rows } = await tx.query<MissionBudgetRow>(
    `SELECT currency, candidates, experiments, revisions_per_proposer, new_families, proposer_count, model_spend,
            model_spend_per_attempt, proposer_spend, proposer_attempts, critic_spend, critic_attempts,
            provider_requests, batch_compute_seconds, agent_compute_seconds, attempt_cap
       FROM mission_budgets WHERE mission_id = $1`,
    [missionId],
  );
  const row = rows[0];
  if (row === undefined) throw new Error(`The mission ${missionId} has no budget row.`);
  return row;
}

export interface Actor {
  readonly principalId: string;
  readonly kind: 'HUMAN' | 'SERVICE';
  readonly serviceKind: ServiceKind | null;
  readonly roles: readonly Role[];
}

export function hasRole(actor: Actor, role: Role): boolean {
  return actor.kind === 'HUMAN' && actor.roles.includes(role);
}

export function isService(actor: Actor, kind: ServiceKind): boolean {
  return actor.kind === 'SERVICE' && actor.serviceKind === kind;
}

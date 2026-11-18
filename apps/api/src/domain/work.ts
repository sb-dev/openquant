// Logical runs and jobs (OQ-05 section 4). A run is an evaluation run; a job is a retrieve, validate or assess job or
// the logical run of an agent. Both have one status of the five values, a compare-and-set revision and an attempt cap.
// Their operational attempts are separate rows (attempts.ts). Every status change goes through setWorkStatus: it
// checks the transition table, writes the new revision with a compare-and-set on the old one, and sets the columns
// that a status needs (the completion time, the failure code, the reason for waiting).

import type { Queryable } from '../db/database.ts';
import type { ApiEnv } from '../env.ts';
import { assertTransition } from './transitions.ts';

export type WorkKind = 'run' | 'job';
export type WorkStatus = 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
/** What the work is. `evaluate` is a run; the others are jobs. */
export type DispatchKind = 'retrieve' | 'validate' | 'evaluate' | 'assess' | 'agent';

export interface Work {
  readonly kind: WorkKind;
  readonly id: string;
  readonly status: WorkStatus;
  /** The mission of the work. Null only for a REPLAY run, which belongs to its replay record instead. */
  readonly missionId: string | null;
  /** The replay record of a REPLAY run (replay.ts), and null for all other work. */
  readonly replayId: string | null;
  readonly attemptCap: number;
  readonly revision: number;
  readonly dispatchKind: DispatchKind;
  readonly configurationId: string | null;
  readonly agentRole: 'PROPOSER' | 'CRITIC' | null;
  readonly trialSlot: string | null;
  readonly runSlot: string | null;
  readonly windowRole: 'DEVELOPMENT' | 'VALIDATION' | 'HOLDOUT' | null;
  readonly costScenario: 'BASE' | 'COST_STRESS' | null;
  readonly planDigest: string | null;
  readonly strategyHash: string | null;
  readonly repeatOfRun: string | null;
}

export const OPEN_STATUSES: readonly WorkStatus[] = ['QUEUED', 'RUNNING'];

interface WorkRow {
  id: string;
  status: WorkStatus;
  mission_id: string | null;
  attempt_cap: number;
  revision: number;
  job_kind: string | null;
  configuration_id: string | null;
  agent_role: 'PROPOSER' | 'CRITIC' | null;
  trial_slot: string | null;
  run_slot: string | null;
  window_role: Work['windowRole'];
  cost_scenario: Work['costScenario'];
  plan_digest: string | null;
  strategy_hash: string | null;
  repeat_of_run: string | null;
  replay_id: string | null;
}

const RUN_SELECT = `SELECT run_id AS id, status, mission_id, attempt_cap, revision, 'evaluate' AS job_kind,
  NULL::text AS configuration_id, NULL::text AS agent_role, trial_slot, run_slot, window_role, cost_scenario,
  plan_digest, strategy_hash, repeat_of_run, replay_id FROM runs`;
const JOB_SELECT = `SELECT job_id AS id, status, mission_id, attempt_cap, revision, kind AS job_kind, configuration_id,
  agent_role, trial_slot, NULL::text AS run_slot, NULL::text AS window_role, NULL::text AS cost_scenario,
  NULL::text AS plan_digest, NULL::text AS strategy_hash, NULL::text AS repeat_of_run, NULL::text AS replay_id FROM jobs`;

function toWork(kind: WorkKind, row: WorkRow): Work {
  // A REPLAY run belongs to its replay record and to no mission (migration 0011); every other work to a mission.
  if ((row.mission_id === null) === (row.replay_id === null)) {
    throw new Error(`The ${kind} ${row.id} must belong to exactly one mission or one replay.`);
  }
  return {
    kind,
    id: row.id,
    status: row.status,
    missionId: row.mission_id,
    replayId: row.replay_id,
    attemptCap: row.attempt_cap,
    revision: row.revision,
    dispatchKind: row.job_kind as DispatchKind,
    configurationId: row.configuration_id,
    agentRole: row.agent_role,
    trialSlot: row.trial_slot,
    runSlot: row.run_slot,
    windowRole: row.window_role,
    costScenario: row.cost_scenario,
    planDigest: row.plan_digest,
    strategyHash: row.strategy_hash,
    repeatOfRun: row.repeat_of_run,
  };
}

export async function findWork(tx: Queryable, kind: WorkKind, id: string, lock = false): Promise<Work | undefined> {
  const select = kind === 'run' ? `${RUN_SELECT} WHERE run_id = $1` : `${JOB_SELECT} WHERE job_id = $1`;
  const { rows } = await tx.query<WorkRow>(`${select}${lock ? ' FOR UPDATE' : ''}`, [id]);
  const row = rows[0];
  return row === undefined ? undefined : toWork(kind, row);
}

/** The run or job that an attempt belongs to, without locking it. */
export async function workOfAttempt(tx: Queryable, attemptId: string): Promise<Work | undefined> {
  const { rows } = await tx.query<{ run_id: string | null; job_id: string | null }>(
    'SELECT run_id, job_id FROM attempts WHERE attempt_id = $1',
    [attemptId],
  );
  const row = rows[0];
  if (row === undefined) return undefined;
  return row.run_id !== null ? findWork(tx, 'run', row.run_id) : findWork(tx, 'job', row.job_id as string);
}

/** Every open (QUEUED or RUNNING) run and job of a mission, locked, runs first. */
export async function lockOpenWork(tx: Queryable, missionId: string): Promise<Work[]> {
  const runs = await tx.query<WorkRow>(
    `${RUN_SELECT} WHERE mission_id = $1 AND status IN ('QUEUED', 'RUNNING') ORDER BY run_id FOR UPDATE`,
    [missionId],
  );
  const jobs = await tx.query<WorkRow>(
    `${JOB_SELECT} WHERE mission_id = $1 AND status IN ('QUEUED', 'RUNNING') ORDER BY job_id FOR UPDATE`,
    [missionId],
  );
  return [...runs.rows.map((row) => toWork('run', row)), ...jobs.rows.map((row) => toWork('job', row))];
}

export interface NewRun {
  readonly missionId: string;
  readonly runSlot: string;
  readonly trialSlot: string;
  readonly windowRole: 'DEVELOPMENT' | 'VALIDATION' | 'HOLDOUT';
  readonly costScenario: 'BASE' | 'COST_STRESS';
  readonly planDigest: string;
  readonly strategyHash: string;
  readonly attemptCap: number;
  readonly repeatOfRun?: string;
}

export async function insertRun(tx: Queryable, env: Pick<ApiEnv, 'ids' | 'clock'>, run: NewRun): Promise<Work> {
  const runId = env.ids.next('run');
  await tx.query(
    `INSERT INTO runs (run_id, mode, mission_id, run_slot, trial_slot, window_role, cost_scenario, plan_digest,
       strategy_hash, repeat_of_run, attempt_cap, created_at)
     VALUES ($1, 'BACKTEST', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      runId,
      run.missionId,
      run.runSlot,
      run.trialSlot,
      run.windowRole,
      run.costScenario,
      run.planDigest,
      run.strategyHash,
      run.repeatOfRun ?? null,
      run.attemptCap,
      env.clock(),
    ],
  );
  return (await findWork(tx, 'run', runId)) as Work;
}

/** The mission of mission work. A replay run has none, and no mission step reaches one: that is a defect. */
export function missionIdOf(work: Work): string {
  if (work.missionId === null) throw new Error(`The ${work.kind} ${work.id} is a replay run: it has no mission.`);
  return work.missionId;
}

export interface NewJob {
  readonly missionId: string;
  readonly kind: 'retrieve' | 'validate' | 'assess' | 'agent';
  readonly attemptCap: number;
  readonly trialSlot?: string;
  readonly configurationId?: string;
  readonly agentRole?: 'PROPOSER' | 'CRITIC';
  /** A validate job names the draft it validates and, for a revision, the registered parent. */
  readonly draftDigest?: string;
  readonly parentHash?: string;
}

export async function insertJob(tx: Queryable, env: Pick<ApiEnv, 'ids' | 'clock'>, job: NewJob): Promise<Work> {
  const jobId = env.ids.next('job');
  await tx.query(
    `INSERT INTO jobs (job_id, kind, mission_id, trial_slot, agent_role, configuration_id, attempt_cap, created_at,
       draft_digest, parent_hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      jobId,
      job.kind,
      job.missionId,
      job.trialSlot ?? null,
      job.agentRole ?? null,
      job.configurationId ?? null,
      job.attemptCap,
      env.clock(),
      job.draftDigest ?? null,
      job.parentHash ?? null,
    ],
  );
  return (await findWork(tx, 'job', jobId)) as Work;
}

export interface StatusChange {
  readonly failureCode?: string;
  readonly waitingReason?: string;
}

/**
 * Move a run or job to a new status with a compare-and-set on its revision. The caller holds the row lock, so a
 * lost compare-and-set is a defect, not a race, and it throws. Returns the work as it now is.
 */
export async function setWorkStatus(
  tx: Queryable,
  env: Pick<ApiEnv, 'clock'>,
  work: Work,
  to: WorkStatus,
  change: StatusChange = {},
): Promise<Work> {
  assertTransition(work.kind, work.status, to);
  const table = work.kind === 'run' ? 'runs' : 'jobs';
  const idColumn = work.kind === 'run' ? 'run_id' : 'job_id';
  const terminal = to === 'COMPLETED' || to === 'FAILED' || to === 'CANCELLED';
  const result = await tx.query(
    `UPDATE ${table}
        SET status = $3, revision = revision + 1, completed_at = $4, failure_code = $5, waiting_reason = $6
      WHERE ${idColumn} = $1 AND revision = $2`,
    [
      work.id,
      work.revision,
      to,
      terminal ? env.clock() : null,
      to === 'FAILED' ? (change.failureCode ?? 'FAILED') : null,
      to === 'QUEUED' ? (change.waitingReason ?? null) : null,
    ],
  );
  if (result.rowCount !== 1) throw new Error(`The ${work.kind} ${work.id} changed under its lock.`);
  return { ...work, status: to, revision: work.revision + 1 };
}

/** Record or clear why a QUEUED run or job has no live attempt (it waits for budget). Not a status change. */
export async function setWaitingReason(tx: Queryable, work: Work, reason: string | null): Promise<Work> {
  const table = work.kind === 'run' ? 'runs' : 'jobs';
  const idColumn = work.kind === 'run' ? 'run_id' : 'job_id';
  const result = await tx.query(
    `UPDATE ${table} SET waiting_reason = $3, revision = revision + 1 WHERE ${idColumn} = $1 AND revision = $2`,
    [work.id, work.revision, reason],
  );
  if (result.rowCount !== 1) throw new Error(`The ${work.kind} ${work.id} changed under its lock.`);
  return { ...work, revision: work.revision + 1 };
}

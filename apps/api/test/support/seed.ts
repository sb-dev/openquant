// Seed rows for the database tests: a small valid graph (principals, policy records, a started mission with its plan,
// slots and strategy versions), and helpers for runs, jobs and attempt bundles. Every test builds on this graph in a
// transaction that it rolls back, then breaks one invariant. Digests come from node:crypto, not from the code under test.

import { createHash } from 'node:crypto';

/** Anything with the query method of node-postgres: a Client, or a transaction handle of the adapter. */
export interface Exec {
  query(text: string, values?: readonly unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

export const sha = (label: string): string => `sha256:${createHash('sha256').update(label).digest('hex')}`;

export const ids = {
  admin: 'human-admin',
  steward: 'human-steward',
  researcher: 'human-researcher',
  viewer: 'human-viewer',
  batch: 'svc-batch',
  runner: 'svc-runner',
  workflows: 'svc-workflows',
  deploy: 'svc-deploy',
  cap: 'cap-1',
  profile: 'profile-1',
  policy: 'policy-1',
  approval: 'approval-1',
  mission: 'mission-1',
  planId: 'plan-1',
  strategy: 'strategy-1',
  seedSlot: 'slot-seed',
  slotA: 'slot-a',
  slotB: 'slot-b',
  proposerA: 'prop-a',
  proposerB: 'prop-b',
  critic: 'critic-1',
} as const;

export const digests = {
  plan: sha('plan'),
  calendar: sha('calendar'),
  seedDraft: sha('seed-draft'),
  seedStrategy: sha('seed-draft'),
  revisionStrategy: sha('revision-strategy'),
  revisionDraft: sha('revision-draft'),
  policyDoc: sha('policy-doc'),
  profileDoc: sha('profile-doc'),
  capDoc: sha('cap-doc'),
  validation: sha('validation'),
  manifest: sha('manifest'),
};

export const NOW = '2026-11-15T10:00:00Z';

export async function artefact(exec: Exec, digest: string, size = 100): Promise<string> {
  await exec.query(
    `INSERT INTO artefacts (digest, media_type, size_bytes, stored_at, uploaded_by)
     VALUES ($1, 'application/json', $2, $3, $4) ON CONFLICT DO NOTHING`,
    [digest, size, NOW, ids.admin],
  );
  return digest;
}

export async function seedPrincipals(exec: Exec): Promise<void> {
  const humans = [ids.admin, ids.steward, ids.researcher, ids.viewer];
  for (const id of humans) {
    await exec.query(
      `INSERT INTO principals (principal_id, kind, display_name, environment, created_at)
       VALUES ($1, 'HUMAN', $2, 'DEVELOPMENT', $3)`,
      [id, `Person ${id}`, NOW],
    );
  }
  const services: [string, string][] = [
    [ids.batch, 'batch'],
    [ids.runner, 'runner'],
    [ids.workflows, 'workflows'],
    [ids.deploy, 'deploy'],
  ];
  for (const [id, kind] of services) {
    await exec.query(
      `INSERT INTO principals (principal_id, kind, service_kind, display_name, environment, created_at)
       VALUES ($1, 'SERVICE', $2, $3, 'DEVELOPMENT', $4)`,
      [id, kind, `Service ${id}`, NOW],
    );
  }
  const roles: [string, string][] = [
    [ids.admin, 'Administrator'],
    [ids.steward, 'Steward'],
    [ids.researcher, 'Researcher'],
    [ids.viewer, 'Viewer'],
  ];
  for (const [id, role] of roles) {
    await exec.query('INSERT INTO principal_roles (principal_id, role, granted_at) VALUES ($1, $2, $3)', [
      id,
      role,
      NOW,
    ]);
  }
}

export async function seedPolicy(exec: Exec): Promise<void> {
  for (const digest of [digests.capDoc, digests.profileDoc, digests.policyDoc, digests.calendar, digests.plan]) {
    await artefact(exec, digest);
  }
  await exec.query(
    `INSERT INTO budget_caps (budget_id, revision, period_start, period_end, model_spend, currency, provider_requests,
       document_digest, registered_by, registered_at)
     VALUES ($1, 1, '2026-11-01', '2026-11-30', 210, 'USD', 120, $2, $3, $4)`,
    [ids.cap, digests.capDoc, ids.steward, NOW],
  );
  await exec.query(
    `INSERT INTO research_profiles (profile_id, revision, document_digest, budget_id, budget_revision, registered_by, registered_at)
     VALUES ($1, 1, $2, $3, 1, $4, $5)`,
    [ids.profile, digests.profileDoc, ids.cap, ids.steward, NOW],
  );
  await exec.query(
    `INSERT INTO cohort_policies (policy_id, revision, suite_id, document_digest, registered_by, registered_at)
     VALUES ($1, 1, 's1-suite', $2, $3, $4)`,
    [ids.policy, digests.policyDoc, ids.steward, NOW],
  );
  await exec.query(
    `INSERT INTO decisions (decision_id, kind, outcome, actor_id, actor_kind, policy_id, policy_revision, decided_at)
     VALUES ($1, 'POLICY_APPROVAL', 'APPROVED', $2, 'HUMAN', $3, 1, $4)`,
    [ids.approval, ids.steward, ids.policy, NOW],
  );
}

export async function seedMission(exec: Exec): Promise<void> {
  await artefact(exec, digests.seedDraft);
  await exec.query(
    `INSERT INTO seed_drafts (draft_digest, origin, strategy_id, registered_by, registered_at)
     VALUES ($1, 'researcher_authored', $2, $3, $4)`,
    [digests.seedDraft, ids.strategy, ids.researcher, NOW],
  );
  await exec.query(
    `INSERT INTO source_interpretations (draft_digest, sources, source_differences, recorded_at) VALUES ($1, '[]', '[]', $2)`,
    [digests.seedDraft, NOW],
  );
  await exec.query(
    `INSERT INTO missions (mission_id, status, objective, instrument_id, symbol, provider, provider_asset_id,
       instrument_effective_from, profile_id, profile_revision, policy_id, policy_revision, seed_draft_digest,
       created_by, created_at, started_by, started_at)
     VALUES ($1, 'IN_PROGRESS', 'Compare two proposers on one stock', 'alpaca:asset-1', 'AAPL', 'alpaca', 'asset-1',
       '2020-01-01', $2, 1, $3, 1, $4, $5, $6, $5, $6)`,
    [ids.mission, ids.profile, ids.policy, digests.seedDraft, ids.researcher, NOW],
  );
  // The pilot budget (decision record): 105 = 2 x 30 + 45, with 5 per attempt (6 and 9 attempts).
  await exec.query(
    `INSERT INTO mission_budgets (mission_id, currency, candidates, experiments, revisions_per_proposer, new_families,
       proposer_count, model_spend, model_spend_per_attempt, proposer_spend, proposer_attempts, critic_spend,
       critic_attempts, provider_requests, batch_compute_seconds, agent_compute_seconds, attempt_cap)
     VALUES ($1, 'USD', 3, 21, 2, 0, 2, 105, 5, 30, 6, 45, 9, 60, 7200, 18900, 3)`,
    [ids.mission],
  );
  const configurations: [string, string, string][] = [
    [ids.proposerA, 'PROPOSER', 'claude-opus-5-5'],
    [ids.proposerB, 'PROPOSER', 'claude-sonnet-5-5'],
    [ids.critic, 'CRITIC', 'claude-opus-5-5'],
  ];
  for (const [id, role, model] of configurations) {
    await exec.query(
      `INSERT INTO mission_agent_configurations (mission_id, configuration_id, role, executor_model, executor_effort,
         bundle_hash, cutoff_status, cutoff_unknown_reason)
       VALUES ($1, $2, $3, $4, 'executor_default', $5, 'unknown', 'The model documentation states no cutoff.')`,
      [ids.mission, id, role, model, sha('bundle')],
    );
  }
  await exec.query(
    `INSERT INTO evaluation_plans (plan_digest, plan_id, mission_id, profile_id, profile_revision, policy_id, policy_revision,
       suite_id, calendar_digest, warmup_sessions, d_start, d_end, v_start, v_end, h_start, h_end, recorded_by, recorded_at)
     VALUES ($1, $2, $3, $4, 1, $5, 1, 's1-suite', $6, 60, '2023-01-03', '2023-12-29', '2024-01-02', '2024-12-31',
       '2025-01-02', '2025-12-31', $7, $8)`,
    [digests.plan, ids.planId, ids.mission, ids.profile, ids.policy, digests.calendar, ids.workflows, NOW],
  );
  await exec.query(
    `INSERT INTO comparisons (plan_digest, cost_stress_multiplier, repeat_window_role, repeat_cost_scenario)
     VALUES ($1, 2, 'DEVELOPMENT', 'BASE')`,
    [digests.plan],
  );
  await exec.query(
    `INSERT INTO trial_slots (mission_id, trial_slot, plan_digest, slot_kind, strategy_id, draft_digest)
     VALUES ($1, $2, $3, 'SEED', $4, $5)`,
    [ids.mission, ids.seedSlot, digests.plan, ids.strategy, digests.seedDraft],
  );
  for (const [slot, configuration] of [
    [ids.slotA, ids.proposerA],
    [ids.slotB, ids.proposerB],
  ] as const) {
    await exec.query(
      `INSERT INTO trial_slots (mission_id, trial_slot, plan_digest, slot_kind, parent_slot, configuration_id)
       VALUES ($1, $2, $3, 'REVISION', $4, $5)`,
      [ids.mission, slot, digests.plan, ids.seedSlot, configuration],
    );
  }
  const cells: [string, string, string, string, string | null][] = [
    ['rs-d-base', 'DEVELOPMENT', 'BASE', 'EVALUATING_DECISION', null],
    ['rs-d-stress', 'DEVELOPMENT', 'COST_STRESS', 'EVALUATING_DECISION', null],
    ['rs-v-base', 'VALIDATION', 'BASE', 'EVALUATING_DECISION', null],
    ['rs-v-stress', 'VALIDATION', 'COST_STRESS', 'EVALUATING_DECISION', null],
    ['rs-h-base', 'HOLDOUT', 'BASE', 'FREEZE_CANDIDATES', null],
    ['rs-h-stress', 'HOLDOUT', 'COST_STRESS', 'FREEZE_CANDIDATES', null],
  ];
  for (const [slot, role, scenario, writer, replay] of cells) {
    await exec.query(
      `INSERT INTO run_slots (mission_id, run_slot, trial_slot, window_role, cost_scenario, written_by, replay_of)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [ids.mission, slot, ids.seedSlot, role, scenario, writer, replay],
    );
  }
  await exec.query(
    `INSERT INTO run_slots (mission_id, run_slot, trial_slot, window_role, cost_scenario, written_by, replay_of)
     VALUES ($1, 'rs-d-repeat', $2, 'DEVELOPMENT', 'BASE', 'EVALUATING_DECISION', 'rs-d-base')`,
    [ids.mission, ids.seedSlot],
  );
  await exec.query(
    `INSERT INTO run_slots (mission_id, run_slot, trial_slot, window_role, cost_scenario, written_by)
     VALUES ($1, 'rs-a-d-base', $2, 'DEVELOPMENT', 'BASE', 'EVALUATING_DECISION')`,
    [ids.mission, ids.slotA],
  );
  await artefact(exec, digests.seedStrategy);
  await exec.query(
    `INSERT INTO strategy_versions (strategy_hash, strategy_id, version, mission_id, registered_at) VALUES ($1, $2, 1, $3, $4)`,
    [digests.seedStrategy, ids.strategy, ids.mission, NOW],
  );
  await artefact(exec, digests.revisionStrategy);
  await exec.query(
    `INSERT INTO strategy_versions (strategy_hash, strategy_id, version, parent_hash, mission_id, registered_at)
     VALUES ($1, $2, 2, $3, $4, $5)`,
    [digests.revisionStrategy, ids.strategy, digests.seedStrategy, ids.mission, NOW],
  );
}

/** Principals, policy records and a started mission with its plan, slots and two strategy versions. */
export async function seedGraph(exec: Exec): Promise<void> {
  await seedPrincipals(exec);
  await seedPolicy(exec);
  await seedMission(exec);
}

export interface RunOptions {
  readonly runId: string;
  readonly status?: string;
  readonly runSlot?: string;
  readonly trialSlot?: string;
  readonly windowRole?: string;
  readonly costScenario?: string;
  readonly strategyHash?: string;
  readonly cap?: number;
}

const completion: Record<string, string> = {
  QUEUED: 'completed_at = NULL, failure_code = NULL',
  RUNNING: 'completed_at = NULL, failure_code = NULL',
  COMPLETED: `completed_at = '${NOW}', failure_code = NULL`,
  FAILED: `completed_at = '${NOW}', failure_code = 'WORKER_LOST'`,
  CANCELLED: `completed_at = '${NOW}', failure_code = NULL`,
};

/** Columns that a status needs, as the SET list of an UPDATE (statuses of runs and jobs). */
export function runCompanion(status: string): string {
  return completion[status] ?? '';
}

export async function insertRun(exec: Exec, options: RunOptions): Promise<void> {
  const status = options.status ?? 'QUEUED';
  const done = status === 'COMPLETED' || status === 'FAILED' || status === 'CANCELLED';
  await exec.query(
    `INSERT INTO runs (run_id, mode, status, mission_id, run_slot, trial_slot, window_role, cost_scenario, plan_digest,
       strategy_hash, attempt_cap, failure_code, created_at, completed_at)
     VALUES ($1, 'BACKTEST', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
    [
      options.runId,
      status,
      ids.mission,
      options.runSlot ?? 'rs-d-base',
      options.trialSlot ?? ids.seedSlot,
      options.windowRole ?? 'DEVELOPMENT',
      options.costScenario ?? 'BASE',
      digests.plan,
      options.strategyHash ?? digests.seedStrategy,
      options.cap ?? 3,
      status === 'FAILED' ? 'WORKER_LOST' : null,
      NOW,
      done ? NOW : null,
    ],
  );
}

export interface JobOptions {
  readonly jobId: string;
  readonly kind?: string;
  readonly status?: string;
  readonly cap?: number;
}

export async function insertJob(exec: Exec, options: JobOptions): Promise<void> {
  const status = options.status ?? 'QUEUED';
  const done = status === 'COMPLETED' || status === 'FAILED' || status === 'CANCELLED';
  const kind = options.kind ?? 'retrieve';
  await exec.query(
    `INSERT INTO jobs (job_id, kind, status, mission_id, agent_role, configuration_id, attempt_cap, failure_code, created_at, completed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      options.jobId,
      kind,
      status,
      ids.mission,
      kind === 'agent' ? 'PROPOSER' : null,
      kind === 'agent' ? ids.proposerA : null,
      options.cap ?? 3,
      status === 'FAILED' ? 'WORKER_LOST' : null,
      NOW,
      done ? NOW : null,
    ],
  );
}

/** A mission budget pool with the given limit; returns its id. Model spend belongs to the critic's allowance. */
export async function insertPool(exec: Exec, limit = 1000, dimension = 'BATCH_COMPUTE_SECONDS'): Promise<number> {
  const configuration = dimension === 'MODEL_SPEND' ? ids.critic : null;
  const result = await exec.query(
    configuration === null
      ? `INSERT INTO budget_pools (scope, mission_id, dimension, limit_amount) VALUES ('MISSION', $1, $2, $3)
         ON CONFLICT (mission_id, dimension) WHERE scope = 'MISSION' AND configuration_id IS NULL
         DO UPDATE SET limit_amount = EXCLUDED.limit_amount RETURNING pool_id`
      : `INSERT INTO budget_pools (scope, mission_id, dimension, limit_amount, configuration_id) VALUES ('MISSION', $1, $2, $3, $4)
         ON CONFLICT (mission_id, dimension, configuration_id) WHERE scope = 'MISSION' AND configuration_id IS NOT NULL
         DO UPDATE SET limit_amount = EXCLUDED.limit_amount RETURNING pool_id`,
    configuration === null ? [ids.mission, dimension, limit] : [ids.mission, dimension, limit, configuration],
  );
  return Number((result.rows[0] as { pool_id: string }).pool_id);
}

export interface AttemptOptions {
  readonly attemptId: string;
  readonly runId?: string;
  readonly jobId?: string;
  readonly revision?: number;
  readonly cap?: number;
  readonly status?: string;
  readonly poolId: number;
  readonly reserved?: number;
}

const claimedStatuses = new Set(['CLAIMED', 'COMPLETED', 'FAILED', 'LEASE_EXPIRED']);
const endedStatuses = new Set(['COMPLETED', 'FAILED', 'LEASE_EXPIRED', 'CANCELLED']);

/** An attempt with its reservation, one reservation line and its outbox row, as one commit writes them. */
export async function insertAttempt(exec: Exec, options: AttemptOptions): Promise<void> {
  const status = options.status ?? 'PENDING';
  const claimed = claimedStatuses.has(status);
  await exec.query(
    `INSERT INTO attempts (attempt_id, run_id, job_id, ownership_revision, attempt_cap, status, failure_code,
       worker_id, executable_name, executable_version, executable_digest, dispatch_digest, created_at, claimed_at, ended_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
    [
      options.attemptId,
      options.runId ?? null,
      options.jobId ?? null,
      options.revision ?? 1,
      options.cap ?? 3,
      status,
      status === 'FAILED' ? 'WORKER_LOST' : null,
      claimed ? 'worker-1' : null,
      claimed ? 'engine-batch' : null,
      claimed ? '0.0.0' : null,
      claimed ? sha('engine-batch') : null,
      claimed ? sha('dispatch') : null,
      NOW,
      claimed ? NOW : null,
      endedStatuses.has(status) ? NOW : null,
    ],
  );
  await exec.query(`INSERT INTO reservations (attempt_id, reserved_at) VALUES ($1, $2)`, [options.attemptId, NOW]);
  await exec.query(`INSERT INTO reservation_lines (attempt_id, pool_id, reserved) VALUES ($1, $2, $3)`, [
    options.attemptId,
    options.poolId,
    options.reserved ?? 10,
  ]);
  await exec.query(
    `INSERT INTO outbox (attempt_id, destination, message, message_digest, created_at)
     VALUES ($1, 'BATCH_QUEUE', '{"schema_version":"job-dispatch/1"}', $2, $3)`,
    [options.attemptId, sha(`message-${options.attemptId}`), NOW],
  );
  if (status === 'CLAIMED') {
    await insertLease(exec, options.attemptId, options.revision ?? 1, 'HELD');
  }
}

export async function insertLease(
  exec: Exec,
  attemptId: string,
  revision: number,
  status: 'HELD' | 'RELEASED' | 'EXPIRED',
  expiresAt = '2026-11-15T10:05:00Z',
): Promise<void> {
  await exec.query(
    `INSERT INTO leases (attempt_id, ownership_revision, status, granted_at, expires_at, released_at, capability_hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [attemptId, revision, status, NOW, expiresAt, status === 'HELD' ? null : NOW, sha(`capability-${attemptId}`)],
  );
}

/** A run and an attempt in the given states, with a pool that can hold the reservation. */
export async function runWithAttempt(
  exec: Exec,
  runId: string,
  attemptId: string,
  attemptStatus = 'PENDING',
  runStatus = 'QUEUED',
): Promise<void> {
  await insertRun(exec, { runId, status: runStatus });
  const poolId = await insertPool(exec);
  await insertAttempt(exec, { attemptId, runId, status: attemptStatus, poolId });
}

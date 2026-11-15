// The read models of the GET routes (routes/v1.json, "views"). They read authoritative state and say what is unknown:
// a value that nothing reported is `null` with its label, never zero (OQ-02 section 1.1). A view repeats none of the
// official run values: metrics and results are served unchanged by runs.metrics and runs.result. The shapes are owned
// here (apps/api); packages/api-client has no shared home for them yet (README, open points).

import type { Queryable } from './db/database.ts';
import { loadDocument } from './domain/store.ts';
import type { ApiEnv } from './env.ts';
import { ApiFailure } from './errors.ts';

type Timestamp = Date | null;
const iso = (date: Timestamp): string | null => (date === null ? null : `${date.toISOString().slice(0, 19)}Z`);

export function notFound(what: string, id: string): ApiFailure {
  return new ApiFailure('NOT_FOUND', `No ${what} has the ID ${id}.`);
}

async function requireMission(db: Queryable, missionId: string) {
  const { rows } = await db.query<{
    mission_id: string;
    status: string;
    outcome: string | null;
    outcome_reason: string | null;
    blocked_reason: string | null;
    objective: string;
    instrument_id: string;
    symbol: string;
    provider: string;
    provider_asset_id: string;
    instrument_effective_from: string;
    profile_id: string;
    profile_revision: number;
    policy_id: string;
    policy_revision: number;
    seed_draft_digest: string;
    created_by: string;
    created_at: Date;
    started_by: string | null;
    started_at: Timestamp;
    withdrawn_by: string | null;
    withdrawn_at: Timestamp;
    withdrawn_reason: string | null;
    concluded_at: Timestamp;
    revision: number;
  }>(
    `SELECT mission_id, status, outcome, outcome_reason, blocked_reason, objective, instrument_id, symbol, provider,
            provider_asset_id, to_char(instrument_effective_from, 'YYYY-MM-DD') AS instrument_effective_from, profile_id,
            profile_revision, policy_id, policy_revision, seed_draft_digest, created_by, created_at, started_by,
            started_at, withdrawn_by, withdrawn_at, withdrawn_reason, concluded_at, revision
       FROM missions WHERE mission_id = $1`,
    [missionId],
  );
  const mission = rows[0];
  if (mission === undefined) throw notFound('mission', missionId);
  return mission;
}

async function planDigestOf(db: Queryable, missionId: string): Promise<string | null> {
  const { rows } = await db.query<{ plan_digest: string }>(
    'SELECT plan_digest FROM evaluation_plans WHERE mission_id = $1',
    [missionId],
  );
  return rows[0]?.plan_digest ?? null;
}

// --- mission -------------------------------------------------------------------------------------------------------

export async function missionView(db: Queryable, missionId: string) {
  const mission = await requireMission(db, missionId);
  const budget = (
    await db.query(
      `SELECT currency, candidates, experiments, revisions_per_proposer, new_families, proposer_count, model_spend,
              model_spend_per_attempt, proposer_spend, proposer_attempts, critic_spend, critic_attempts,
              provider_requests::text AS provider_requests, batch_compute_seconds::text AS batch_compute_seconds,
              agent_compute_seconds::text AS agent_compute_seconds, attempt_cap
         FROM mission_budgets WHERE mission_id = $1`,
      [missionId],
    )
  ).rows[0];
  const pools = await db.query(
    `SELECT dimension, configuration_id, limit_amount::text AS "limit", committed::text AS committed, overrun::text AS overrun
       FROM budget_pools WHERE scope = 'MISSION' AND mission_id = $1 ORDER BY dimension, configuration_id NULLS FIRST`,
    [missionId],
  );
  const reservations = await db.query<{ status: string; reservations: number }>(
    `SELECT r.status, count(*)::int AS reservations FROM reservations r
       JOIN attempts a ON a.attempt_id = r.attempt_id
       LEFT JOIN runs ru ON ru.run_id = a.run_id LEFT JOIN jobs j ON j.job_id = a.job_id
      WHERE COALESCE(ru.mission_id, j.mission_id) = $1 GROUP BY r.status ORDER BY r.status`,
    [missionId],
  );
  const candidates = await db.query(
    `SELECT s.trial_slot, s.slot_kind AS kind, s.configuration_id, s.terminal_reason, t.strategy_hash, v.lifecycle,
            d.outcome AS decision, e.state AS eligibility
       FROM trial_slots s
       LEFT JOIN trials t ON t.mission_id = s.mission_id AND t.trial_slot = s.trial_slot AND t.status = 'REGISTERED'
       LEFT JOIN strategy_versions v ON v.strategy_hash = t.strategy_hash
       LEFT JOIN decisions d ON d.mission_id = s.mission_id AND d.trial_slot = s.trial_slot AND d.kind = 'DRAFT_TO_EVALUATING'
       LEFT JOIN eligibility e ON e.mission_id = s.mission_id AND e.strategy_hash = t.strategy_hash
      WHERE s.mission_id = $1 ORDER BY s.trial_slot`,
    [missionId],
  );
  const jobs = await db.query(
    `SELECT j.job_id, j.kind, j.status, j.trial_slot, j.agent_role, j.configuration_id, j.waiting_reason, j.failure_code,
            (SELECT count(*)::int FROM attempts a WHERE a.job_id = j.job_id) AS attempts,
            (SELECT a.attempt_id FROM attempts a WHERE a.job_id = j.job_id ORDER BY a.ownership_revision DESC LIMIT 1) AS latest_attempt
       FROM jobs j WHERE j.mission_id = $1 ORDER BY j.created_at, j.job_id`,
    [missionId],
  );
  const runs = await db.query<{ status: string; runs: number }>(
    'SELECT status, count(*)::int AS runs FROM runs WHERE mission_id = $1 GROUP BY status ORDER BY status',
    [missionId],
  );
  const attention = await db.query<{
    item_id: string;
    subject: string;
    reason: string;
    status: string;
    opened_at: Date;
  }>(
    'SELECT item_id, subject, reason, status, opened_at FROM attention_items WHERE mission_id = $1 ORDER BY opened_at, item_id',
    [missionId],
  );
  return {
    mission_id: mission.mission_id,
    status: mission.status,
    outcome: mission.outcome,
    outcome_reason: mission.outcome_reason,
    blocked_reason: mission.blocked_reason,
    withdrawn:
      mission.withdrawn_by === null
        ? null
        : { by: mission.withdrawn_by, at: iso(mission.withdrawn_at), reason: mission.withdrawn_reason },
    revision: mission.revision,
    objective: mission.objective,
    scope: {
      instrument_id: mission.instrument_id,
      symbol: mission.symbol,
      provider: mission.provider,
      provider_asset_id: mission.provider_asset_id,
      effective_from: mission.instrument_effective_from,
    },
    profile: { id: mission.profile_id, revision: mission.profile_revision },
    cohort_policy: { id: mission.policy_id, revision: mission.policy_revision },
    seed_draft_digest: mission.seed_draft_digest,
    plan_digest: await planDigestOf(db, missionId),
    created_by: mission.created_by,
    created_at: iso(mission.created_at),
    started_by: mission.started_by,
    started_at: iso(mission.started_at),
    concluded_at: iso(mission.concluded_at),
    budget: { limits: budget ?? null, pools: pools.rows },
    reservations: reservations.rows,
    candidates: candidates.rows,
    jobs: jobs.rows,
    runs: runs.rows,
    attention_items: attention.rows.map((item) => ({ ...item, opened_at: iso(item.opened_at) })),
  };
}

// --- plan ----------------------------------------------------------------------------------------------------------

/** The registered evaluation-plan/1 of the mission, as it was stored. */
export async function missionPlan(db: Queryable, env: Pick<ApiEnv, 'objects'>, missionId: string) {
  await requireMission(db, missionId);
  const digest = await planDigestOf(db, missionId);
  if (digest === null)
    throw new ApiFailure(
      'NOT_FOUND',
      'No evaluation plan is recorded for this mission yet: it is recorded when the retrieval is accepted.',
    );
  return loadDocument(env, 'evaluation-plan', digest);
}

// --- lineage -------------------------------------------------------------------------------------------------------

export async function lineageView(db: Queryable, missionId: string) {
  await requireMission(db, missionId);
  const versions = await db.query(
    `SELECT v.strategy_hash, v.strategy_id, v.version, v.parent_hash, v.lifecycle, v.registered_at,
            t.trial_slot, l.change_scope, l.validation_digest
       FROM strategy_versions v
       LEFT JOIN trials t ON t.strategy_hash = v.strategy_hash AND t.status = 'REGISTERED'
       LEFT JOIN strategy_lineage l ON l.child_hash = v.strategy_hash
      WHERE v.mission_id = $1 ORDER BY v.version, v.strategy_hash`,
    [missionId],
  );
  const runs = await db.query<{
    strategy_hash: string;
    run_id: string;
    run_slot: string;
    status: string;
    window_role: string;
    cost_scenario: string;
  }>(
    `SELECT strategy_hash, run_id, run_slot, status, window_role, cost_scenario FROM runs WHERE mission_id = $1 ORDER BY run_slot`,
    [missionId],
  );
  const findings = await db.query<{ strategy_hash: string; finding_id: string }>(
    'SELECT strategy_hash, finding_id FROM findings WHERE mission_id = $1 ORDER BY finding_id',
    [missionId],
  );
  const decisions = await db.query<{ strategy_hash: string; decision_id: string; outcome: string }>(
    `SELECT strategy_hash, decision_id, outcome FROM decisions WHERE mission_id = $1 AND kind = 'DRAFT_TO_EVALUATING' ORDER BY decision_id`,
    [missionId],
  );
  return {
    mission_id: missionId,
    versions: versions.rows.map((row) => ({
      ...row,
      registered_at: iso(row.registered_at as unknown as Date),
      runs: runs.rows
        .filter((run) => run.strategy_hash === row.strategy_hash)
        .map(({ strategy_hash: _, ...run }) => run),
      findings: findings.rows
        .filter((finding) => finding.strategy_hash === row.strategy_hash)
        .map((finding) => finding.finding_id),
      decisions: decisions.rows
        .filter((decision) => decision.strategy_hash === row.strategy_hash)
        .map(({ strategy_hash: _, ...decision }) => decision),
    })),
  };
}

// --- trials --------------------------------------------------------------------------------------------------------

export async function trialsView(db: Queryable, env: Pick<ApiEnv, 'environment'>, missionId: string) {
  await requireMission(db, missionId);
  const slots = await db.query(
    'SELECT trial_slot, slot_kind AS kind, configuration_id, parent_slot, terminal_reason, terminal_at FROM trial_slots WHERE mission_id = $1 ORDER BY trial_slot',
    [missionId],
  );
  const planned = await db.query(
    `SELECT s.run_slot, s.trial_slot, s.window_role, s.cost_scenario, s.written_by, s.replay_of,
            r.run_id, r.status AS run_status, r.mode, r.failure_code, r.waiting_reason, r.completed_at,
            (SELECT count(*)::int FROM attempts a WHERE a.run_id = r.run_id) AS attempts,
            (h.run_id IS NOT NULL) AS holdout_consumed
       FROM run_slots s
       LEFT JOIN runs r ON r.mission_id = s.mission_id AND r.run_slot = s.run_slot
       LEFT JOIN holdout_consumption h ON h.run_id = r.run_id
      WHERE s.mission_id = $1 ORDER BY s.trial_slot, s.run_slot`,
    [missionId],
  );
  const trials = await db.query(
    `SELECT trial_id, trial_slot, proposal_ordinal, draft_digest, status, strategy_hash, reason, created_at
       FROM trials WHERE mission_id = $1 ORDER BY trial_slot, proposal_ordinal`,
    [missionId],
  );
  return {
    mission_id: missionId,
    plan_digest: await planDigestOf(db, missionId),
    trial_slots: slots.rows.map((row) => ({ ...row, terminal_at: iso(row.terminal_at as Timestamp) })),
    run_slots: planned.rows.map((row) => {
      const {
        run_id,
        run_status,
        mode,
        failure_code,
        waiting_reason,
        completed_at,
        attempts,
        holdout_consumed,
        ...slot
      } = row as Record<string, unknown>;
      return {
        ...slot,
        run:
          run_id === null
            ? null
            : {
                run_id,
                status: run_status,
                mode,
                environment: env.environment,
                attempts,
                failure_code,
                waiting_reason,
                completed_at: iso(completed_at as Timestamp),
                holdout_consumed,
              },
      };
    }),
    trials: trials.rows.map((row) => ({ ...row, created_at: iso(row.created_at as unknown as Date) })),
  };
}

// --- findings ------------------------------------------------------------------------------------------------------

export async function findingsView(db: Queryable, missionId: string) {
  await requireMission(db, missionId);
  const findings = await db.query<{
    finding_id: string;
    strategy_hash: string;
    attempt_id: string;
    critique_digest: string;
    ordinal: number;
    category: string;
    finding_source: string;
    affects_executable_rule: boolean;
    required_evidence: boolean;
    recorded_at: Date;
  }>(
    `SELECT finding_id, strategy_hash, attempt_id, critique_digest, ordinal, category, finding_source,
            affects_executable_rule, required_evidence, recorded_at
       FROM findings WHERE mission_id = $1 ORDER BY strategy_hash, critique_digest, ordinal`,
    [missionId],
  );
  const treatments = await db.query<{
    finding_id: string;
    transition: string;
    treatment: string;
    policy_id: string;
    policy_revision: number;
    assigned_at: Date;
    resolved_by: string | null;
    resolved_at: Timestamp;
  }>(
    `SELECT t.finding_id, t.transition, t.treatment, t.policy_id, t.policy_revision, t.assigned_at, t.resolved_by, t.resolved_at
       FROM finding_treatments t JOIN findings f ON f.finding_id = t.finding_id WHERE f.mission_id = $1 ORDER BY t.finding_id, t.transition`,
    [missionId],
  );
  return {
    mission_id: missionId,
    findings: findings.rows.map((finding) => ({
      finding_id: finding.finding_id,
      strategy_hash: finding.strategy_hash,
      attempt_id: finding.attempt_id,
      critique_digest: finding.critique_digest,
      ordinal: finding.ordinal,
      category: finding.category,
      finding_source: finding.finding_source,
      applicability: [
        ...(finding.affects_executable_rule ? ['affects_executable_rule'] : []),
        ...(finding.required_evidence ? ['required_evidence'] : []),
      ],
      recorded_at: iso(finding.recorded_at),
      // No row for a transition: the policy has not assigned its treatment yet (the Decision or the gate report does).
      treatments: treatments.rows
        .filter((row) => row.finding_id === finding.finding_id)
        .map((row) => ({
          transition: row.transition,
          treatment: row.treatment,
          policy: { id: row.policy_id, revision: row.policy_revision },
          assigned_at: iso(row.assigned_at),
          resolved_by: row.resolved_by,
          resolved_at: iso(row.resolved_at),
        })),
    })),
  };
}

// --- gates ---------------------------------------------------------------------------------------------------------

export interface GatesRead {
  readonly view: unknown;
  /** The holdout runs whose observed values the view shows: reading them is consumption (OQ-02 section 3.3). */
  readonly revealedHoldoutRuns: string[];
}

export async function gatesView(db: Queryable, env: Pick<ApiEnv, 'objects'>, missionId: string): Promise<GatesRead> {
  await requireMission(db, missionId);
  const reports = await db.query<{
    report_digest: string;
    strategy_hash: string;
    policy_id: string;
    policy_revision: number;
    recorded_at: Date;
    state: string | null;
    reasons: unknown;
  }>(
    `SELECT g.report_digest, g.strategy_hash, g.policy_id, g.policy_revision, g.recorded_at, e.state, e.reasons
       FROM gate_reports g LEFT JOIN eligibility e ON e.mission_id = g.mission_id AND e.strategy_hash = g.strategy_hash
      WHERE g.mission_id = $1 ORDER BY g.strategy_hash`,
    [missionId],
  );
  const revealed = new Set<string>();
  const out = [];
  for (const row of reports.rows) {
    const report = await loadDocument(env, 'gate-report', row.report_digest);
    const holdoutRuns = await db.query<{ run_id: string }>(
      `SELECT run_id FROM runs WHERE mission_id = $1 AND window_role = 'HOLDOUT' AND run_id = ANY($2::text[])`,
      [
        missionId,
        report.gates.flatMap((gate) =>
          'observations' in gate ? (gate.observations ?? []).map((entry) => entry.run_id) : [],
        ),
      ],
    );
    for (const run of holdoutRuns.rows) revealed.add(run.run_id);
    out.push({
      strategy_hash: row.strategy_hash,
      report_digest: row.report_digest,
      cohort_policy: { id: row.policy_id, revision: row.policy_revision },
      recorded_at: iso(row.recorded_at),
      eligibility: row.state === null ? null : { state: row.state, reasons: row.reasons },
      report,
    });
  }
  return { view: { mission_id: missionId, reports: out }, revealedHoldoutRuns: [...revealed] };
}

// --- decisions -----------------------------------------------------------------------------------------------------

export async function decisionsView(db: Queryable, missionId: string) {
  const mission = await requireMission(db, missionId);
  const decisions = await db.query(
    `SELECT decision_id, kind, outcome, actor_id, actor_kind, policy_id, policy_revision, mission_id, trial_slot,
            strategy_hash, plan_digest, policy_approval_decision, mission_started_by, critique_status, critique_digest,
            reason, decided_at
       FROM decisions
      WHERE mission_id = $1 OR (kind = 'POLICY_APPROVAL' AND policy_id = $2 AND policy_revision = $3)
      ORDER BY decided_at, decision_id`,
    [missionId, mission.policy_id, mission.policy_revision],
  );
  return {
    mission_id: missionId,
    decisions: decisions.rows.map((row) => ({
      ...row,
      cohort_policy: { id: row.policy_id, revision: row.policy_revision },
      policy_id: undefined,
      policy_revision: undefined,
      decided_at: iso(row.decided_at as Date),
    })),
  };
}

// --- jobs and runs -------------------------------------------------------------------------------------------------

export async function jobView(db: Queryable, id: string) {
  let work = (
    await db.query<{
      id: string;
      kind: string;
      status: string;
      mission_id: string;
      trial_slot: string | null;
      agent_role: string | null;
      configuration_id: string | null;
      attempt_cap: number;
      failure_code: string | null;
      waiting_reason: string | null;
      created_at: Date;
      completed_at: Timestamp;
      revision: number;
    }>(
      `SELECT job_id AS id, kind, status, mission_id, trial_slot, agent_role, configuration_id, attempt_cap, failure_code,
              waiting_reason, created_at, completed_at, revision FROM jobs WHERE job_id = $1`,
      [id],
    )
  ).rows[0];
  let column = 'job_id';
  if (work === undefined) {
    // An evaluate job is a run, and its dispatch message names the run as its job.
    work = (
      await db.query<NonNullable<typeof work>>(
        `SELECT run_id AS id, 'evaluate' AS kind, status, mission_id, trial_slot, NULL::text AS agent_role,
                NULL::text AS configuration_id, attempt_cap, failure_code, waiting_reason, created_at, completed_at, revision
           FROM runs WHERE run_id = $1`,
        [id],
      )
    ).rows[0];
    column = 'run_id';
  }
  if (work === undefined) throw notFound('job', id);
  const attempts = await db.query<Record<string, unknown> & { attempt_id: string }>(
    `SELECT a.attempt_id, a.ownership_revision, a.status, a.failure_code, a.agent_outcome, a.worker_id, a.executable_name,
            a.executable_version, a.executable_digest, a.created_at, a.claimed_at, a.ended_at,
            l.status AS lease_status, l.granted_at AS lease_granted_at, l.expires_at AS lease_expires_at,
            o.destination, o.status AS dispatch_status, o.sent_at AS dispatch_sent_at, o.message_digest,
            r.status AS reservation_status
       FROM attempts a
       LEFT JOIN leases l ON l.attempt_id = a.attempt_id
       LEFT JOIN outbox o ON o.attempt_id = a.attempt_id
       LEFT JOIN reservations r ON r.attempt_id = a.attempt_id
      WHERE a.${column} = $1 ORDER BY a.ownership_revision`,
    [id],
  );
  const lines = await db.query<{
    attempt_id: string;
    dimension: string;
    configuration_id: string | null;
    reserved: string;
    used: string | null;
    usage_label: string | null;
  }>(
    `SELECT l.attempt_id, p.dimension, p.configuration_id, l.reserved::text AS reserved, l.used::text AS used, l.usage_label
       FROM reservation_lines l JOIN budget_pools p ON p.pool_id = l.pool_id
       JOIN attempts a ON a.attempt_id = l.attempt_id WHERE a.${column} = $1 ORDER BY l.attempt_id, p.dimension`,
    [id],
  );
  return {
    job_id: work.id,
    kind: work.kind,
    status: work.status,
    mission_id: work.mission_id,
    trial_slot: work.trial_slot,
    agent_role: work.agent_role,
    configuration_id: work.configuration_id,
    attempt_cap: work.attempt_cap,
    failure_code: work.failure_code,
    waiting_reason: work.waiting_reason,
    revision: work.revision,
    created_at: iso(work.created_at),
    completed_at: iso(work.completed_at),
    attempts: attempts.rows.map((attempt) => ({
      attempt_id: attempt.attempt_id,
      ownership_revision: attempt.ownership_revision,
      status: attempt.status,
      failure_code: attempt.failure_code,
      agent_outcome: attempt.agent_outcome,
      worker_id: attempt.worker_id,
      executable:
        attempt.executable_name === null
          ? null
          : { name: attempt.executable_name, version: attempt.executable_version, digest: attempt.executable_digest },
      created_at: iso(attempt.created_at as Date),
      claimed_at: iso(attempt.claimed_at as Timestamp),
      ended_at: iso(attempt.ended_at as Timestamp),
      lease:
        attempt.lease_status === null
          ? null
          : {
              status: attempt.lease_status,
              granted_at: iso(attempt.lease_granted_at as Date),
              expires_at: iso(attempt.lease_expires_at as Date),
            },
      dispatch: {
        destination: attempt.destination,
        status: attempt.dispatch_status,
        sent_at: iso(attempt.dispatch_sent_at as Timestamp),
        message_digest: attempt.message_digest,
      },
      // used is null while nothing reported it: unknown, not zero.
      reservation: {
        status: attempt.reservation_status,
        lines: lines.rows
          .filter((line) => line.attempt_id === attempt.attempt_id)
          .map(({ attempt_id: _, ...line }) => ({ ...line, used: line.used, usage: line.usage_label ?? 'unreported' })),
      },
    })),
  };
}

export interface RunDocument {
  readonly digest: string;
  readonly holdout: boolean;
}

/** The digest of the official metrics or result of a run, or NOT_FOUND while none is committed. */
export async function runDocument(db: Queryable, runId: string, which: 'metrics' | 'result'): Promise<RunDocument> {
  const run = await db.query<{ window_role: string | null }>('SELECT window_role FROM runs WHERE run_id = $1', [runId]);
  if (run.rows[0] === undefined) throw notFound('run', runId);
  const { rows } =
    which === 'metrics'
      ? await db.query<{ digest: string | null }>('SELECT metrics_digest AS digest FROM metrics WHERE run_id = $1', [
          runId,
        ])
      : await db.query<{ digest: string | null }>('SELECT result_digest AS digest FROM results WHERE run_id = $1', [
          runId,
        ]);
  const digest = rows[0]?.digest;
  if (digest === undefined || digest === null) {
    throw new ApiFailure(
      'NOT_FOUND',
      `The run ${runId} has no committed ${which}: a FAILED, INSUFFICIENT or unfinished run has none.`,
    );
  }
  return { digest, holdout: run.rows[0].window_role === 'HOLDOUT' };
}

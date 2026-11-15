// The mission commands of a Researcher (OQ-02 section 1, OQ-03 section 1, OQ-05 section 4):
//
//   create_mission   a CREATED mission with its budget, agent configurations and budget pools. The budget must lie within
//                    the maxima of the cohort policy and fit what is left of the period budget that the profile names;
//                    the mission takes its whole budget from that period budget when it is created.
//   run_mission_now  CREATED to IN_PROGRESS, and its first job, the retrieval, with its attempt, reservation and outbox
//                    entry in the same transaction. A budget that cannot cover the retrieval refuses the command.
//   cancel_mission   WITHDRAWN: its open runs become CANCELLED and its open agent attempts are cancelled (attempts.ts).

import type { CancelMission, CreateMission, RunMissionNow } from '@openquant/api-contracts';
import { writeAudit } from '../audit.ts';
import { cancelOpenWork, openAttempt } from '../domain/attempts.ts';
import { createMissionPools } from '../domain/budget.ts';
import { isCalendarDate, utcDate } from '../domain/dates.ts';
import { compareDecimal, subtractDecimal } from '../domain/decimal.ts';
import { loadPolicy, loadProfile } from '../domain/documents.ts';
import { transitionMission } from '../domain/missions.ts';
import { reject, revisionConflict } from '../domain/rejection.ts';
import { lockMission } from '../domain/rows.ts';
import { insertJob } from '../domain/work.ts';
import { missionBudgetProblem } from './policy-checks.ts';
import { type Applier, workContext } from './types.ts';

export const createMission: Applier<CreateMission> = async (context, { mission: spec }) => {
  const { tx, env, actor, request } = context;
  if (request.expected_revision !== 0) {
    throw reject('POLICY_VIOLATION', 'A new mission has no revision yet: expected_revision must be 0.');
  }
  const profile = await loadProfile(tx, env, spec.profile.id, spec.profile.revision);
  if (profile === undefined) {
    throw reject(
      'NOT_FOUND',
      `The research profile ${spec.profile.id} revision ${spec.profile.revision} is not registered.`,
    );
  }
  const policy = await loadPolicy(tx, env, spec.cohort_policy.id, spec.cohort_policy.revision);
  if (policy === undefined) {
    throw reject(
      'NOT_FOUND',
      `The cohort policy ${spec.cohort_policy.id} revision ${spec.cohort_policy.revision} is not registered.`,
    );
  }
  if (profile.digest !== spec.profile.digest || policy.digest !== spec.cohort_policy.digest) {
    throw reject('POLICY_VIOLATION', 'A reference names a digest that is not the digest of the registered record.');
  }
  const bound = policy.document.profile;
  if (bound.id !== profile.id || bound.revision !== profile.revision || bound.digest !== profile.digest) {
    throw reject('POLICY_VIOLATION', 'The cohort policy was registered for another revision of the profile.');
  }
  const seed = await tx.query('SELECT 1 FROM seed_drafts WHERE draft_digest = $1', [spec.seed_draft_digest]);
  if (seed.rows.length === 0) throw reject('NOT_FOUND', 'The seed draft is not registered.');
  const { instrument } = spec;
  if (instrument.provider !== profile.document.provider.adapter.name) {
    throw reject(
      'POLICY_VIOLATION',
      'The instrument is mapped by another provider than the one that the profile names.',
    );
  }
  if (instrument.instrument_id !== `${instrument.provider}:${instrument.provider_asset_id}`) {
    throw reject(
      'POLICY_VIOLATION',
      'The instrument ID is not the provider and the provider asset ID (PROVIDER_ASSET_ID).',
    );
  }
  if (!isCalendarDate(instrument.effective_from)) {
    throw reject('POLICY_VIOLATION', 'The instrument mapping starts on a date that is not on the calendar.');
  }
  const problem = missionBudgetProblem(spec, policy.document);
  if (problem !== undefined) throw reject('POLICY_VIOLATION', problem);

  // The period budget of the profile: the mission takes its budget from what is left of it.
  const budget = spec.budget;
  const pools = await tx.query<{
    pool_id: number;
    dimension: string;
    limit_amount: string;
    committed: string;
    currency: string;
    period_start: string;
    period_end: string;
  }>(
    `SELECT bp.pool_id::int AS pool_id, bp.dimension, bp.limit_amount::text AS limit_amount, bp.committed::text AS committed,
            bc.currency, to_char(bc.period_start, 'YYYY-MM-DD') AS period_start, to_char(bc.period_end, 'YYYY-MM-DD') AS period_end
       FROM budget_pools bp JOIN budget_caps bc ON bc.budget_id = bp.budget_id AND bc.revision = bp.budget_revision
      WHERE bp.scope = 'PERIOD' AND bp.budget_id = $1 ORDER BY bp.pool_id FOR UPDATE OF bp`,
    [profile.document.period_budget],
  );
  const today = utcDate(env.clock());
  const first = pools.rows[0];
  if (first === undefined) {
    throw reject(
      'POLICY_VIOLATION',
      `The period budget ${profile.document.period_budget} of the profile is not registered.`,
    );
  }
  if (today < first.period_start || today > first.period_end) {
    throw reject(
      'POLICY_VIOLATION',
      `The period budget covers ${first.period_start} to ${first.period_end}, not ${today}.`,
    );
  }
  if (first.currency !== budget.model_spend.currency) {
    throw reject('POLICY_VIOLATION', 'The model spend is not in the currency of the period budget.');
  }
  const asked: Record<string, string> = {
    MODEL_SPEND: budget.model_spend.amount,
    PROVIDER_REQUESTS: String(budget.provider_requests),
  };
  for (const pool of pools.rows) {
    const amount = asked[pool.dimension] as string;
    if (compareDecimal(amount, pool.limit_amount) > 0) {
      throw reject(
        'POLICY_VIOLATION',
        `The mission asks for ${amount} of ${pool.dimension}: the period budget holds only ${pool.limit_amount}.`,
      );
    }
    const left = subtractDecimal(pool.limit_amount, pool.committed);
    if (compareDecimal(amount, left) > 0) {
      throw reject(
        'BUDGET_EXHAUSTED',
        `The mission asks for ${amount} of ${pool.dimension}: ${left} is left of the period budget.`,
      );
    }
  }
  for (const pool of pools.rows) {
    await tx.query('UPDATE budget_pools SET committed = committed + $2::numeric WHERE pool_id = $1', [
      pool.pool_id,
      asked[pool.dimension],
    ]);
  }

  const now = env.clock();
  const missionId = env.ids.next('msn');
  await tx.query(
    `INSERT INTO missions (mission_id, objective, instrument_id, symbol, provider, provider_asset_id,
       instrument_effective_from, profile_id, profile_revision, policy_id, policy_revision, seed_draft_digest,
       created_by, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
    [
      missionId,
      spec.objective,
      instrument.instrument_id,
      instrument.symbol,
      instrument.provider,
      instrument.provider_asset_id,
      instrument.effective_from,
      profile.id,
      profile.revision,
      policy.id,
      policy.revision,
      spec.seed_draft_digest,
      actor.principalId,
      now,
    ],
  );
  await tx.query(
    `INSERT INTO mission_budgets (mission_id, currency, candidates, experiments, revisions_per_proposer, new_families,
       proposer_count, model_spend, model_spend_per_attempt, proposer_spend, proposer_attempts, critic_spend,
       critic_attempts, provider_requests, batch_compute_seconds, agent_compute_seconds, attempt_cap)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::numeric, $9::numeric, $10::numeric, $11, $12::numeric, $13, $14, $15, $16, $17)`,
    [
      missionId,
      budget.model_spend.currency,
      budget.candidates,
      budget.experiments,
      budget.revisions_per_proposer,
      budget.new_families,
      spec.proposers.length,
      budget.model_spend.amount,
      budget.model_spend_per_attempt.amount,
      budget.proposer_allowance.model_spend.amount,
      budget.proposer_allowance.agent_attempts,
      budget.critic_allowance.model_spend.amount,
      budget.critic_allowance.agent_attempts,
      budget.provider_requests,
      budget.batch_compute_seconds,
      budget.agent_compute_seconds,
      budget.attempt_cap,
    ],
  );
  const configurations = [
    ...spec.proposers.map((configuration) => ({ configuration, role: 'PROPOSER' })),
    { configuration: spec.critic, role: 'CRITIC' },
  ];
  for (const { configuration, role } of configurations) {
    const cutoff = configuration.knowledge_cutoff;
    await tx.query(
      `INSERT INTO mission_agent_configurations (mission_id, configuration_id, role, executor_model, executor_effort,
         bundle_hash, cutoff_status, cutoff, cutoff_source, cutoff_read_on, cutoff_unknown_reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        missionId,
        configuration.configuration_id,
        role,
        configuration.executor_profile.model,
        configuration.executor_profile.effort,
        configuration.bundle_hash,
        cutoff.status,
        cutoff.status === 'published' ? cutoff.cutoff : null,
        cutoff.status === 'published' ? cutoff.source : null,
        cutoff.status === 'published' ? cutoff.read_on : null,
        cutoff.status === 'unknown' ? cutoff.reason : null,
      ],
    );
  }
  await createMissionPools(tx, missionId, {
    proposerConfigurations: spec.proposers.map((entry) => entry.configuration_id),
    criticConfiguration: spec.critic.configuration_id,
    proposerSpend: budget.proposer_allowance.model_spend.amount,
    criticSpend: budget.critic_allowance.model_spend.amount,
    providerRequests: String(budget.provider_requests),
    batchComputeSeconds: String(budget.batch_compute_seconds),
    agentComputeSeconds: String(budget.agent_compute_seconds),
  });
  await writeAudit(tx, now, {
    eventType: 'mission.created',
    actor: actor.principalId,
    subject: missionId,
    commandId: request.command_id,
    detail: { profile: profile.id, policy: policy.id, seed_draft: spec.seed_draft_digest },
  });
  return { id: missionId, revision: 1 };
};

export const runMissionNow: Applier<RunMissionNow> = async (context, payload) => {
  const { tx, env, actor, request } = context;
  const mission = await lockMission(tx, payload.mission_id);
  if (request.expected_revision !== mission.revision)
    throw revisionConflict(`The mission ${mission.mission_id}`, mission.revision);
  if (mission.status !== 'CREATED') {
    throw reject(
      'REVISION_CONFLICT',
      `The mission is ${mission.status}, not CREATED: it was started or ended already.`,
      {
        currentRevision: mission.revision,
      },
    );
  }
  const started = await transitionMission(tx, env, mission, 'IN_PROGRESS', { startedBy: actor.principalId });
  const budget = await tx.query<{ attempt_cap: number }>(
    'SELECT attempt_cap FROM mission_budgets WHERE mission_id = $1',
    [mission.mission_id],
  );
  const retrieve = await insertJob(tx, env, {
    missionId: mission.mission_id,
    kind: 'retrieve',
    attemptCap: budget.rows[0]?.attempt_cap ?? 1,
  });
  const opened = await openAttempt(tx, workContext(context), retrieve);
  if (!opened.ok) {
    throw reject('BUDGET_EXHAUSTED', `The retrieval cannot be reserved: ${opened.reason}`);
  }
  await writeAudit(tx, env.clock(), {
    eventType: 'mission.started',
    actor: actor.principalId,
    subject: mission.mission_id,
    commandId: request.command_id,
    detail: { retrieve_job: retrieve.id, attempt: opened.attemptId },
  });
  return { id: mission.mission_id, revision: started.revision };
};

export const cancelMission: Applier<CancelMission> = async (context, payload) => {
  const { tx, env, actor, request } = context;
  const mission = await lockMission(tx, payload.mission_id);
  if (request.expected_revision !== mission.revision)
    throw revisionConflict(`The mission ${mission.mission_id}`, mission.revision);
  if (mission.status === 'WITHDRAWN' || mission.status === 'CONCLUDED') {
    throw reject('POLICY_VIOLATION', `The mission is ${mission.status}: it cannot be withdrawn.`);
  }
  const summary = await cancelOpenWork(tx, workContext(context), mission.mission_id);
  const withdrawn = await transitionMission(tx, env, mission, 'WITHDRAWN', {
    withdrawnBy: actor.principalId,
    withdrawnReason: payload.reason.length === 0 ? 'No reason given.' : payload.reason,
  });
  await writeAudit(tx, env.clock(), {
    eventType: 'mission.withdrawn',
    actor: actor.principalId,
    subject: mission.mission_id,
    commandId: request.command_id,
    detail: { ...summary },
  });
  return { id: mission.mission_id, revision: withdrawn.revision };
};

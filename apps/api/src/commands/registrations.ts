// The registration commands (OQ-02 sections 1, 3.1 and 4; OQ-03 section 1): a Steward registers research profiles,
// cohort policies and period budgets, and a Researcher registers a seed draft. Each new revision of a record is
// immutable and follows the one before it. `expected_revision` is the revision that the caller saw as the latest: 0 when
// the record does not exist yet. A caller that saw an older one is refused with REVISION_CONFLICT, and nothing changes.

import type {
  RegisterBudget,
  RegisterCohortPolicy,
  RegisterResearchProfile,
  RegisterSeed,
} from '@openquant/api-contracts';
import { canonicalJson } from '@openquant/api-contracts';
import { writeAudit } from '../audit.ts';
import { isCalendarDate } from '../domain/dates.ts';
import { compareDecimal, fitsMoney } from '../domain/decimal.ts';
import { loadProfile } from '../domain/documents.ts';
import { latestRevision, lockKey } from '../domain/locks.ts';
import { reject, revisionConflict } from '../domain/rejection.ts';
import { storeBytes, storeDocument } from '../domain/store.ts';
import { policyProblem, profileProblem } from './policy-checks.ts';
import type { Applier } from './types.ts';

const encoder = new TextEncoder();

/** The revision that a registration creates must be the one after the latest, and the caller must have seen the latest. */
function checkRevision(what: string, expected: number, latest: number, revision: number): void {
  if (expected !== latest) throw revisionConflict(what, latest);
  if (revision !== latest + 1) {
    throw reject(
      'POLICY_VIOLATION',
      `${what} is at revision ${latest}: the next revision is ${latest + 1}, not ${revision}.`,
    );
  }
}

export const registerBudget: Applier<RegisterBudget> = async ({ tx, env, actor, request }, { budget }) => {
  await lockKey(tx, `budget:${budget.budget_id}`);
  const what = `The budget ${budget.budget_id}`;
  const latest = await latestRevision(tx, 'budget_caps', 'budget_id', budget.budget_id);
  checkRevision(what, request.expected_revision, latest, budget.revision);
  const { period, model_spend: spend } = budget;
  if (!isCalendarDate(period.start) || !isCalendarDate(period.end)) {
    throw reject('POLICY_VIOLATION', 'The period holds a date that is not on the calendar.');
  }
  if (period.start > period.end) throw reject('POLICY_VIOLATION', 'The period ends before it starts.');
  if (!fitsMoney(spend.amount)) {
    throw reject('POLICY_VIOLATION', 'The model spend is not an amount that the ledger can hold.');
  }
  const now = env.clock();
  if (latest > 0) {
    // A new revision changes the amounts of a period, never the period or the currency: spend that the missions of the
    // period already hold stays counted, so a new revision cannot reset it (OQ-03 section 1).
    const previous = await tx.query<{ period_start: string; period_end: string; currency: string }>(
      `SELECT to_char(period_start, 'YYYY-MM-DD') AS period_start, to_char(period_end, 'YYYY-MM-DD') AS period_end, currency
         FROM budget_caps WHERE budget_id = $1 AND revision = $2`,
      [budget.budget_id, latest],
    );
    const before = previous.rows[0];
    if (before === undefined || before.period_start !== period.start || before.period_end !== period.end) {
      throw reject('POLICY_VIOLATION', `${what} covers another period: register a new budget for a new period.`);
    }
    if (before.currency !== spend.currency) throw reject('POLICY_VIOLATION', `${what} cannot change its currency.`);
    const pools = await tx.query<{ dimension: string; committed: string }>(
      `SELECT dimension, committed::text AS committed FROM budget_pools
        WHERE scope = 'PERIOD' AND budget_id = $1 ORDER BY pool_id FOR UPDATE`,
      [budget.budget_id],
    );
    const newLimits: Record<string, string> = {
      MODEL_SPEND: spend.amount,
      PROVIDER_REQUESTS: String(budget.provider_requests),
    };
    for (const pool of pools.rows) {
      const limit = newLimits[pool.dimension] as string;
      if (compareDecimal(limit, pool.committed) < 0) {
        throw reject(
          'POLICY_VIOLATION',
          `${what} cannot go below what its missions hold: ${pool.dimension} holds ${pool.committed}, the new limit is ${limit}.`,
        );
      }
    }
  }
  const stored = await storeBytes(tx, env, encoder.encode(canonicalJson(budget)), actor.principalId);
  await tx.query(
    `INSERT INTO budget_caps (budget_id, revision, period_start, period_end, model_spend, currency, provider_requests,
       document_digest, registered_by, registered_at)
     VALUES ($1, $2, $3, $4, $5::numeric, $6, $7, $8, $9, $10)`,
    [
      budget.budget_id,
      budget.revision,
      period.start,
      period.end,
      spend.amount,
      spend.currency,
      budget.provider_requests,
      stored.digest,
      actor.principalId,
      now,
    ],
  );
  if (latest === 0) {
    await tx.query(
      `INSERT INTO budget_pools (scope, budget_id, budget_revision, dimension, limit_amount)
       VALUES ('PERIOD', $1, $2, 'MODEL_SPEND', $3::numeric), ('PERIOD', $1, $2, 'PROVIDER_REQUESTS', $4::numeric)`,
      [budget.budget_id, budget.revision, spend.amount, String(budget.provider_requests)],
    );
  } else {
    await tx.query(
      `UPDATE budget_pools SET budget_revision = $2,
              limit_amount = CASE dimension WHEN 'MODEL_SPEND' THEN $3::numeric ELSE $4::numeric END
        WHERE scope = 'PERIOD' AND budget_id = $1`,
      [budget.budget_id, budget.revision, spend.amount, String(budget.provider_requests)],
    );
  }
  await writeAudit(tx, now, {
    eventType: 'budget.registered',
    actor: actor.principalId,
    subject: budget.budget_id,
    commandId: request.command_id,
    detail: { revision: budget.revision, digest: stored.digest },
  });
  return { id: budget.budget_id, revision: budget.revision };
};

export const registerResearchProfile: Applier<RegisterResearchProfile> = async (
  { tx, env, actor, request },
  { profile },
) => {
  await lockKey(tx, `profile:${profile.profile_id}`);
  const what = `The research profile ${profile.profile_id}`;
  const latest = await latestRevision(tx, 'research_profiles', 'profile_id', profile.profile_id);
  checkRevision(what, request.expected_revision, latest, profile.revision);
  const problem = profileProblem(profile);
  if (problem !== undefined) throw reject('POLICY_VIOLATION', problem);
  const budgetRevision = await latestRevision(tx, 'budget_caps', 'budget_id', profile.period_budget);
  if (budgetRevision === 0) {
    throw reject(
      'POLICY_VIOLATION',
      `The period budget ${profile.period_budget} that the profile names is not registered.`,
    );
  }
  const stored = await storeDocument(tx, env, 'research-profile', profile, actor.principalId);
  const now = env.clock();
  await tx.query(
    `INSERT INTO research_profiles (profile_id, revision, document_digest, budget_id, budget_revision, registered_by, registered_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      profile.profile_id,
      profile.revision,
      stored.ref.digest,
      profile.period_budget,
      budgetRevision,
      actor.principalId,
      now,
    ],
  );
  await writeAudit(tx, now, {
    eventType: 'research_profile.registered',
    actor: actor.principalId,
    subject: profile.profile_id,
    commandId: request.command_id,
    detail: { revision: profile.revision, digest: stored.ref.digest },
  });
  return { id: profile.profile_id, revision: profile.revision };
};

export const registerCohortPolicy: Applier<RegisterCohortPolicy> = async ({ tx, env, actor, request }, { policy }) => {
  await lockKey(tx, `policy:${policy.policy_id}`);
  const what = `The cohort policy ${policy.policy_id}`;
  const latest = await latestRevision(tx, 'cohort_policies', 'policy_id', policy.policy_id);
  checkRevision(what, request.expected_revision, latest, policy.revision);
  const profile = await loadProfile(tx, env, policy.profile.id, policy.profile.revision);
  if (profile === undefined) {
    throw reject(
      'NOT_FOUND',
      `The research profile ${policy.profile.id} revision ${policy.profile.revision} is not registered.`,
    );
  }
  if (profile.digest !== policy.profile.digest) {
    throw reject(
      'POLICY_VIOLATION',
      'The digest of the profile reference is not the digest of the registered profile.',
    );
  }
  const problem = policyProblem(policy, profile.document);
  if (problem !== undefined) throw reject('POLICY_VIOLATION', problem);
  const stored = await storeDocument(tx, env, 'cohort-policy', policy, actor.principalId);
  const now = env.clock();
  await tx.query(
    `INSERT INTO cohort_policies (policy_id, revision, suite_id, document_digest, registered_by, registered_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [policy.policy_id, policy.revision, policy.suite_id, stored.ref.digest, actor.principalId, now],
  );
  // Registering a policy is the Steward's approval of it. Every policy-determined Decision under this revision names
  // this Decision (OQ-02 section 1).
  const decisionId = env.ids.next('dec');
  await tx.query(
    `INSERT INTO decisions (decision_id, kind, outcome, actor_id, actor_kind, policy_id, policy_revision, command_id, decided_at)
     VALUES ($1, 'POLICY_APPROVAL', 'APPROVED', $2, 'HUMAN', $3, $4, $5, $6)`,
    [decisionId, actor.principalId, policy.policy_id, policy.revision, request.command_id, now],
  );
  await writeAudit(tx, now, {
    eventType: 'cohort_policy.registered',
    actor: actor.principalId,
    subject: policy.policy_id,
    commandId: request.command_id,
    detail: { revision: policy.revision, digest: stored.ref.digest, approval_decision: decisionId },
  });
  return { id: policy.policy_id, revision: policy.revision };
};

export const registerSeed: Applier<RegisterSeed> = async ({ tx, env, actor, request }, payload) => {
  const { draft } = payload;
  const what = `The seed draft of strategy ${draft.strategy_id}`;
  if (draft.version !== 1 || draft.parent !== undefined) {
    throw reject('POLICY_VIOLATION', 'A seed is version 1 of a new strategy and has no parent.');
  }
  const stored = await storeDocument(tx, env, 'strategy-artefact', draft, actor.principalId);
  const existing = await tx.query('SELECT 1 FROM seed_drafts WHERE draft_digest = $1', [stored.ref.digest]);
  if (existing.rows.length > 0 || request.expected_revision !== 0) {
    throw revisionConflict(what, existing.rows.length > 0 ? 1 : 0);
  }
  const sameStrategy = await tx.query('SELECT 1 FROM seed_drafts WHERE strategy_id = $1', [draft.strategy_id]);
  if (sameStrategy.rows.length > 0) {
    throw reject('POLICY_VIOLATION', `Another seed draft already has the strategy ${draft.strategy_id}.`);
  }
  const now = env.clock();
  await tx.query(
    `INSERT INTO seed_drafts (draft_digest, origin, strategy_id, registered_by, registered_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [stored.ref.digest, payload.origin, draft.strategy_id, actor.principalId, now],
  );
  await tx.query(
    `INSERT INTO source_interpretations (draft_digest, sources, source_differences, recorded_at)
     VALUES ($1, $2::jsonb, $3::jsonb, $4)`,
    [stored.ref.digest, JSON.stringify(payload.sources), JSON.stringify(payload.source_differences), now],
  );
  await writeAudit(tx, now, {
    eventType: 'seed.registered',
    actor: actor.principalId,
    subject: draft.strategy_id,
    commandId: request.command_id,
    detail: { draft_digest: stored.ref.digest },
  });
  return { id: draft.strategy_id, revision: 1 };
};

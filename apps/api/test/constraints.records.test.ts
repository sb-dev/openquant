// Constraint tests, part 1: identity, policy records, missions and strategies. Each test seeds the valid graph, shows
// that a correct row is accepted, and then breaks one invariant that a specification states. Every violation is
// named by SQLSTATE (23514 check, 23505 unique, 23503 foreign key) and by its constraint.

import { describe, expect, it } from 'vitest';
import { useRolledBackTransaction } from './support/rollback.ts';
import { artefact, digests, ids, NOW, sha } from './support/seed.ts';

const t = useRolledBackTransaction();

const CHECK = '23514';
const UNIQUE = '23505';
const FOREIGN_KEY = '23503';

describe('principals, roles and credentials (OQ-05 section 9)', () => {
  it('refuses an identifier outside the contract pattern', async () => {
    await t.violation(
      `INSERT INTO principals (principal_id, kind, display_name, environment, created_at) VALUES ('bad id', 'HUMAN', 'x', 'DEVELOPMENT', $1)`,
      [NOW],
      { code: CHECK, constraint: 'oq_identifier_pattern' },
    );
    await t.violation(
      `INSERT INTO principals (principal_id, kind, display_name, environment, created_at) VALUES ('-leading', 'HUMAN', 'x', 'DEVELOPMENT', $1)`,
      [NOW],
      { code: CHECK, constraint: 'oq_identifier_pattern' },
    );
    await t.violation(
      `INSERT INTO principals (principal_id, kind, display_name, environment, created_at) VALUES ($1, 'HUMAN', 'x', 'DEVELOPMENT', $2)`,
      ['a'.repeat(65), NOW],
      { code: CHECK, constraint: 'oq_identifier_pattern' },
    );
    await t.ok(
      `INSERT INTO principals (principal_id, kind, display_name, environment, created_at) VALUES ($1, 'HUMAN', 'x', 'DEVELOPMENT', $2)`,
      ['a'.repeat(64), NOW],
    );
  });

  it('refuses an environment other than the three of the contract', async () => {
    await t.violation(
      `INSERT INTO principals (principal_id, kind, display_name, environment, created_at) VALUES ('p-env', 'HUMAN', 'x', 'TESTING', $1)`,
      [NOW],
      { code: CHECK, constraint: 'oq_environment_values' },
    );
  });

  it('gives a service principal a service kind and a person none', async () => {
    await t.violation(
      `INSERT INTO principals (principal_id, kind, display_name, environment, created_at) VALUES ('svc-x', 'SERVICE', 'x', 'STAGING', $1)`,
      [NOW],
      { code: CHECK, constraint: 'principals_service_kind_shape' },
    );
    await t.violation(
      `INSERT INTO principals (principal_id, kind, service_kind, display_name, environment, created_at) VALUES ('human-x', 'HUMAN', 'batch', 'x', 'STAGING', $1)`,
      [NOW],
      { code: CHECK, constraint: 'principals_service_kind_shape' },
    );
    await t.violation(
      `INSERT INTO principals (principal_id, kind, service_kind, display_name, environment, created_at) VALUES ('svc-y', 'SERVICE', 'trader', 'x', 'STAGING', $1)`,
      [NOW],
      { code: CHECK },
    );
  });

  it('allows one service principal of each kind in each environment', async () => {
    await t.violation(
      `INSERT INTO principals (principal_id, kind, service_kind, display_name, environment, created_at) VALUES ('svc-batch-2', 'SERVICE', 'batch', 'second', 'DEVELOPMENT', $1)`,
      [NOW],
      { code: UNIQUE, constraint: 'principals_one_service_per_environment' },
    );
    await t.ok(
      `INSERT INTO principals (principal_id, kind, service_kind, display_name, environment, created_at) VALUES ('svc-batch-staging', 'SERVICE', 'batch', 'staging', 'STAGING', $1)`,
      [NOW],
    );
  });

  it('gives no role to a service principal and only the four roles to a person', async () => {
    await t.violation(
      `INSERT INTO principal_roles (principal_id, role, granted_at) VALUES ($1, 'Viewer', $2)`,
      [ids.batch, NOW],
      { code: FOREIGN_KEY, constraint: 'principal_roles_principal' },
    );
    await t.violation(
      `INSERT INTO principal_roles (principal_id, principal_kind, role, granted_at) VALUES ($1, 'SERVICE', 'Viewer', $2)`,
      [ids.batch, NOW],
      { code: CHECK, constraint: 'principal_roles_human_only' },
    );
    await t.violation(
      `INSERT INTO principal_roles (principal_id, role, granted_at) VALUES ($1, 'Operator', $2)`,
      [ids.viewer, NOW],
      { code: CHECK },
    );
    await t.violation(
      `INSERT INTO principal_roles (principal_id, role, granted_at) VALUES ($1, 'Viewer', $2)`,
      [ids.viewer, NOW],
      { code: UNIQUE, constraint: 'principal_roles_pkey' },
    );
  });

  it('stores a credential only as a SHA-256 hash', async () => {
    const insert = `INSERT INTO credentials (credential_id, principal_id, principal_kind, secret_hash, created_at) VALUES ($1, $2, 'HUMAN', $3, $4)`;
    await t.violation(insert, ['cred-1', ids.viewer, 'oqk1.cred-1.0123456789abcdef0123456789abcdef0123456789a', NOW], {
      code: CHECK,
      constraint: 'credentials_hash_only',
    });
    await t.violation(insert, ['cred-1', ids.viewer, 'sha256:ABCDEF', NOW], {
      code: CHECK,
      constraint: 'credentials_hash_only',
    });
    await t.violation(insert, ['cred-1', ids.viewer, `sha256:${'0'.repeat(63)}`, NOW], {
      code: CHECK,
      constraint: 'credentials_hash_only',
    });
    await t.ok(insert, ['cred-1', ids.viewer, sha('secret-one'), NOW]);
    await t.violation(insert, ['cred-2', ids.researcher, sha('secret-one'), NOW], {
      code: UNIQUE,
      constraint: 'credentials_hash_unique',
    });
  });

  it('names the operations of a service credential, and only of a service credential', async () => {
    await t.violation(
      `INSERT INTO credentials (credential_id, principal_id, principal_kind, secret_hash, created_at) VALUES ('cred-s', $1, 'SERVICE', $2, $3)`,
      [ids.batch, sha('s'), NOW],
      { code: CHECK, constraint: 'credentials_operations_shape' },
    );
    await t.violation(
      `INSERT INTO credentials (credential_id, principal_id, principal_kind, secret_hash, operations, created_at) VALUES ('cred-s', $1, 'SERVICE', $2, '{}', $3)`,
      [ids.batch, sha('s'), NOW],
      { code: CHECK, constraint: 'credentials_operations_shape' },
    );
    await t.violation(
      `INSERT INTO credentials (credential_id, principal_id, principal_kind, secret_hash, operations, created_at) VALUES ('cred-h', $1, 'HUMAN', $2, '{auth.token}', $3)`,
      [ids.viewer, sha('h'), NOW],
      { code: CHECK, constraint: 'credentials_operations_shape' },
    );
    await t.violation(
      `INSERT INTO credentials (credential_id, principal_id, principal_kind, secret_hash, operations, created_at) VALUES ('cred-s', $1, 'SERVICE', $2, '{"Not A Route"}', $3)`,
      [ids.batch, sha('s'), NOW],
      { code: CHECK, constraint: 'oq_route_id_pattern' },
    );
    await t.ok(
      `INSERT INTO credentials (credential_id, principal_id, principal_kind, secret_hash, operations, created_at) VALUES ('cred-s', $1, 'SERVICE', $2, '{attempts.claim}', $3)`,
      [ids.batch, sha('s'), NOW],
    );
  });

  it('binds a credential to a principal of the same kind and refuses an expiry before creation', async () => {
    await t.violation(
      `INSERT INTO credentials (credential_id, principal_id, principal_kind, secret_hash, operations, created_at)
       VALUES ('cred-k', $1, 'SERVICE', $2, '{attempts.claim}', $3)`,
      [ids.viewer, sha('k'), NOW],
      { code: FOREIGN_KEY, constraint: 'credentials_principal' },
    );
    await t.violation(
      `INSERT INTO credentials (credential_id, principal_id, principal_kind, secret_hash, created_at, expires_at) VALUES ('cred-e', $1, 'HUMAN', $2, $3, '2026-11-15T09:00:00Z')`,
      [ids.viewer, sha('e'), NOW],
      { code: CHECK, constraint: 'credentials_expiry_after_creation' },
    );
  });

  it('keeps the audit log append-only', async () => {
    const [row] = await t.ok(
      `INSERT INTO audit_events (occurred_at, actor, event_type, subject) VALUES ($1, 'system', 'test.event', 'subject-1') RETURNING audit_id`,
      [NOW],
    );
    expect(row?.audit_id).toBeDefined();
    await t.violation(`UPDATE audit_events SET actor = 'someone'`, [], {
      code: CHECK,
      constraint: 'audit_events_immutable',
    });
    await t.violation(`DELETE FROM audit_events`, [], { code: CHECK, constraint: 'audit_events_immutable' });
    await t.violation(
      `INSERT INTO audit_events (occurred_at, actor, event_type, subject) VALUES ($1, 'system', 'Not Valid', 'subject-1')`,
      [NOW],
      { code: CHECK },
    );
  });
});

describe('artefacts and registered records (OQ-05 section 7)', () => {
  it('refuses a digest that is not sha256 and lower-case hex, and a size above 1 GiB', async () => {
    const insert = `INSERT INTO artefacts (digest, media_type, size_bytes, stored_at, uploaded_by) VALUES ($1, 'application/json', $2, $3, $4)`;
    await t.violation(insert, [`sha256:${'A'.repeat(64)}`, 1, NOW, ids.admin], {
      code: CHECK,
      constraint: 'oq_digest_pattern',
    });
    await t.violation(insert, [`sha512:${'a'.repeat(64)}`, 1, NOW, ids.admin], {
      code: CHECK,
      constraint: 'oq_digest_pattern',
    });
    await t.violation(insert, [sha('big'), 1073741825, NOW, ids.admin], { code: CHECK });
    await t.violation(insert, [sha('negative'), -1, NOW, ids.admin], { code: CHECK });
    await t.ok(insert, [sha('exact-limit'), 1073741824, NOW, ids.admin]);
  });

  it('keeps an artefact immutable', async () => {
    await t.violation(`UPDATE artefacts SET size_bytes = 1`, [], { code: CHECK, constraint: 'artefacts_immutable' });
    await t.violation(`DELETE FROM artefacts`, [], { code: CHECK, constraint: 'artefacts_immutable' });
  });

  it('refuses a period that ends before it starts and a revision that skips a number', async () => {
    const insert = `INSERT INTO budget_caps (budget_id, revision, period_start, period_end, model_spend, currency, provider_requests, registered_by, registered_at)
      VALUES ($1, $2, $3, $4, 210, 'USD', 120, $5, $6)`;
    await t.violation(insert, ['cap-2', 1, '2026-12-01', '2026-11-30', ids.steward, NOW], {
      code: CHECK,
      constraint: 'budget_caps_period_order',
    });
    await t.violation(insert, [ids.cap, 3, '2026-12-01', '2026-12-31', ids.steward, NOW], {
      code: FOREIGN_KEY,
      constraint: 'budget_caps_previous',
    });
    await t.violation(insert, [ids.cap, 1, '2026-12-01', '2026-12-31', ids.steward, NOW], {
      code: UNIQUE,
      constraint: 'budget_caps_pkey',
    });
    await t.ok(insert, [ids.cap, 2, '2026-12-01', '2026-12-31', ids.steward, NOW]);
    await t.violation(`UPDATE budget_caps SET model_spend = 1000`, [], {
      code: CHECK,
      constraint: 'budget_caps_immutable',
    });
  });

  it('refuses a negative amount in a budget cap', async () => {
    await t.violation(
      `INSERT INTO budget_caps (budget_id, revision, period_start, period_end, model_spend, currency, provider_requests, registered_by, registered_at)
       VALUES ('cap-neg', 1, '2026-11-01', '2026-11-30', -1, 'USD', 1, $1, $2)`,
      [ids.steward, NOW],
      { code: CHECK, constraint: 'oq_money_not_negative' },
    );
  });

  it('numbers profile and policy revisions without a gap and keeps each document once', async () => {
    await t.violation(
      `INSERT INTO research_profiles (profile_id, revision, document_digest, budget_id, budget_revision, registered_by, registered_at)
       VALUES ($1, 3, $2, $3, 1, $4, $5)`,
      [ids.profile, digests.capDoc, ids.cap, ids.steward, NOW],
      { code: FOREIGN_KEY, constraint: 'research_profiles_previous' },
    );
    await t.violation(
      `INSERT INTO research_profiles (profile_id, revision, document_digest, budget_id, budget_revision, registered_by, registered_at)
       VALUES ($1, 2, $2, $3, 1, $4, $5)`,
      [ids.profile, digests.profileDoc, ids.cap, ids.steward, NOW],
      { code: UNIQUE, constraint: 'research_profiles_document_unique' },
    );
    await t.violation(
      `INSERT INTO research_profiles (profile_id, revision, document_digest, budget_id, budget_revision, registered_by, registered_at)
       VALUES ('profile-2', 1, $1, 'cap-missing', 1, $2, $3)`,
      [digests.capDoc, ids.steward, NOW],
      { code: FOREIGN_KEY, constraint: 'research_profiles_budget' },
    );
    await t.violation(
      `INSERT INTO cohort_policies (policy_id, revision, suite_id, document_digest, registered_by, registered_at) VALUES ($1, 3, 's1-suite', $2, $3, $4)`,
      [ids.policy, digests.capDoc, ids.steward, NOW],
      { code: FOREIGN_KEY, constraint: 'cohort_policies_previous' },
    );
    await t.violation(`UPDATE cohort_policies SET suite_id = 'other'`, [], {
      code: CHECK,
      constraint: 'cohort_policies_immutable',
    });
  });
});

describe('missions (OQ-02 section 1)', () => {
  const setStatus = (status: string, extra = '') =>
    `UPDATE missions SET status = '${status}'${extra ? `, ${extra}` : ''}`;

  it('is CONCLUDED if and only if it has an outcome, with a reason and a time', async () => {
    await t.violation(setStatus('CONCLUDED', `concluded_at = '${NOW}'`), [], {
      code: CHECK,
      constraint: 'missions_outcome_iff_concluded',
    });
    await t.violation(`UPDATE missions SET outcome = 'NO_ELIGIBLE_CANDIDATE', outcome_reason = 'none'`, [], {
      code: CHECK,
      constraint: 'missions_outcome_iff_concluded',
    });
    await t.violation(setStatus('CONCLUDED', `outcome = 'NO_ELIGIBLE_CANDIDATE', concluded_at = '${NOW}'`), [], {
      code: CHECK,
      constraint: 'missions_outcome_has_reason',
    });
    await t.violation(setStatus('CONCLUDED', `outcome = 'NO_ELIGIBLE_CANDIDATE', outcome_reason = 'none'`), [], {
      code: CHECK,
      constraint: 'missions_concluded_at',
    });
    await t.violation(setStatus('CONCLUDED', `outcome = 'MAYBE', outcome_reason = 'x', concluded_at = '${NOW}'`), [], {
      code: CHECK,
    });
    await t.ok(
      setStatus(
        'CONCLUDED',
        `outcome = 'NO_ELIGIBLE_CANDIDATE', outcome_reason = 'No candidate passed.', concluded_at = '${NOW}'`,
      ),
    );
  });

  it('names its reason when BLOCKED and its actor and time when WITHDRAWN', async () => {
    await t.violation(setStatus('BLOCKED'), [], { code: CHECK, constraint: 'missions_blocked_has_reason' });
    await t.ok(setStatus('BLOCKED', `blocked_reason = 'Budget exhausted.'`));
    await t.violation(setStatus('WITHDRAWN'), [], { code: CHECK, constraint: 'missions_withdrawn_shape' });
    await t.violation(setStatus('WITHDRAWN', `withdrawn_at = '${NOW}'`), [], {
      code: CHECK,
      constraint: 'missions_withdrawn_shape',
    });
    await t.ok(setStatus('WITHDRAWN', `withdrawn_by = '${ids.researcher}', withdrawn_at = '${NOW}'`));
  });

  it('records who started it before any work: IN_PROGRESS, BLOCKED and CONCLUDED need a starter', async () => {
    await t.violation(
      `INSERT INTO missions (mission_id, status, objective, instrument_id, symbol, provider, provider_asset_id, instrument_effective_from,
         profile_id, profile_revision, policy_id, policy_revision, seed_draft_digest, created_by, created_at)
       VALUES ('m-nostart', 'IN_PROGRESS', 'x', 'i', 'AAPL', 'alpaca', 'a', '2020-01-01', $1, 1, $2, 1, $3, $4, $5)`,
      [ids.profile, ids.policy, digests.seedDraft, ids.researcher, NOW],
      { code: CHECK, constraint: 'missions_started_before_work' },
    );
    await t.ok(
      `INSERT INTO missions (mission_id, status, objective, instrument_id, symbol, provider, provider_asset_id, instrument_effective_from,
         profile_id, profile_revision, policy_id, policy_revision, seed_draft_digest, created_by, created_at)
       VALUES ('m-created', 'CREATED', 'x', 'i', 'AAPL', 'alpaca', 'a', '2020-01-01', $1, 1, $2, 1, $3, $4, $5)`,
      [ids.profile, ids.policy, digests.seedDraft, ids.researcher, NOW],
    );
  });

  it('refuses a symbol that is not a ticker, and a profile or policy that is not registered', async () => {
    const insert = `INSERT INTO missions (mission_id, status, objective, instrument_id, symbol, provider, provider_asset_id, instrument_effective_from,
         profile_id, profile_revision, policy_id, policy_revision, seed_draft_digest, created_by, created_at)
       VALUES ('m-x', 'CREATED', 'x', 'i', $1, 'alpaca', 'a', '2020-01-01', $2, $3, $4, $5, $6, $7, $8)`;
    await t.violation(insert, ['aapl', ids.profile, 1, ids.policy, 1, digests.seedDraft, ids.researcher, NOW], {
      code: CHECK,
    });
    await t.violation(insert, ['AAPL', ids.profile, 2, ids.policy, 1, digests.seedDraft, ids.researcher, NOW], {
      code: FOREIGN_KEY,
      constraint: 'missions_profile',
    });
    await t.violation(insert, ['AAPL', ids.profile, 1, ids.policy, 7, digests.seedDraft, ids.researcher, NOW], {
      code: FOREIGN_KEY,
      constraint: 'missions_policy',
    });
    await t.violation(insert, ['AAPL', ids.profile, 1, ids.policy, 1, sha('unknown-draft'), ids.researcher, NOW], {
      code: FOREIGN_KEY,
    });
  });

  it('keeps the sums of the mission budget (OQ-03 section 1)', async () => {
    const insert = (overrides: Record<string, number>) => {
      const row: Record<string, number> = {
        model_spend: 105,
        per_attempt: 5,
        proposer_spend: 30,
        proposer_attempts: 6,
        critic_spend: 45,
        critic_attempts: 9,
        proposers: 2,
        cap: 3,
        ...overrides,
      };
      return [
        `INSERT INTO mission_budgets (mission_id, currency, candidates, experiments, revisions_per_proposer, new_families, proposer_count,
           model_spend, model_spend_per_attempt, proposer_spend, proposer_attempts, critic_spend, critic_attempts, provider_requests,
           batch_compute_seconds, agent_compute_seconds, attempt_cap)
         VALUES ($1, 'USD', 3, 21, 2, 0, $2, $3, $4, $5, $6, $7, $8, 60, 7200, 18900, $9)`,
        [
          'm-budget',
          row.proposers,
          row.model_spend,
          row.per_attempt,
          row.proposer_spend,
          row.proposer_attempts,
          row.critic_spend,
          row.critic_attempts,
          row.cap,
        ],
      ] as const;
    };
    await t.ok(
      `INSERT INTO missions (mission_id, status, objective, instrument_id, symbol, provider, provider_asset_id, instrument_effective_from,
         profile_id, profile_revision, policy_id, policy_revision, seed_draft_digest, created_by, created_at)
       VALUES ('m-budget', 'CREATED', 'x', 'i', 'AAPL', 'alpaca', 'a', '2020-01-01', $1, 1, $2, 1, $3, $4, $5)`,
      [ids.profile, ids.policy, digests.seedDraft, ids.researcher, NOW],
    );
    const [okSql, okValues] = insert({});
    await t.violation(...insert({ model_spend: 100 }), { code: CHECK, constraint: 'mission_budgets_model_spend_sum' });
    await t.violation(...insert({ proposers: 3 }), { code: CHECK, constraint: 'mission_budgets_model_spend_sum' });
    await t.violation(...insert({ proposer_attempts: 5 }), {
      code: CHECK,
      constraint: 'mission_budgets_proposer_allowance',
    });
    await t.violation(...insert({ critic_attempts: 10 }), {
      code: CHECK,
      constraint: 'mission_budgets_critic_allowance',
    });
    await t.violation(...insert({ cap: 0 }), { code: CHECK });
    await t.violation(...insert({ cap: 11 }), { code: CHECK });
    await t.ok(okSql, [...okValues]);
    await t.violation(`UPDATE mission_budgets SET attempt_cap = 4`, [], {
      code: CHECK,
      constraint: 'mission_budgets_immutable',
    });
  });

  it('has one critic configuration, and a published cutoff or an unknown one with its reason', async () => {
    await t.violation(
      `INSERT INTO mission_agent_configurations (mission_id, configuration_id, role, executor_model, executor_effort, bundle_hash, cutoff_status, cutoff_unknown_reason)
       VALUES ($1, 'critic-2', 'CRITIC', 'claude-sonnet-5-5', 'executor_default', $2, 'unknown', 'none stated')`,
      [ids.mission, sha('bundle')],
      { code: UNIQUE, constraint: 'mission_agent_one_critic' },
    );
    const insert = (status: string, cutoff: string | null, reason: string | null) =>
      t.violation(
        `INSERT INTO mission_agent_configurations (mission_id, configuration_id, role, executor_model, executor_effort, bundle_hash,
           cutoff_status, cutoff, cutoff_source, cutoff_read_on, cutoff_unknown_reason)
         VALUES ($1, 'prop-c', 'PROPOSER', 'm', 'executor_default', $2, $3, $4, $4, $5, $6)`,
        [ids.mission, sha('bundle'), status, cutoff, cutoff === null ? null : '2026-11-14', reason],
        { code: CHECK, constraint: 'mission_agent_cutoff_shape' },
      );
    await insert('published', null, null);
    await insert('published', '2026-06', 'also a reason');
    await insert('unknown', '2026-06', 'reason');
    await insert('unknown', null, null);
    await t.violation(
      `INSERT INTO mission_agent_configurations (mission_id, configuration_id, role, executor_model, executor_effort, bundle_hash, cutoff_status, cutoff_unknown_reason)
       VALUES ($1, 'prop-c', 'PROPOSER', 'm', 'extreme', $2, 'unknown', 'reason')`,
      [ids.mission, sha('bundle')],
      { code: CHECK },
    );
  });
});

describe('the evaluation plan and its slots (OQ-02 sections 3.1 and 3.3)', () => {
  it('is recorded once for a mission and never changed', async () => {
    await t.violation(
      `INSERT INTO evaluation_plans (plan_digest, plan_id, mission_id, profile_id, profile_revision, policy_id, policy_revision, suite_id,
         calendar_digest, warmup_sessions, d_start, d_end, v_start, v_end, h_start, h_end, recorded_by, recorded_at)
       VALUES ($1, 'plan-2', $2, $3, 1, $4, 1, 's1-suite', $5, 60, '2023-01-03', '2023-12-29', '2024-01-02', '2024-12-31', '2025-01-02', '2025-12-31', $6, $7)`,
      [digests.calendar, ids.mission, ids.profile, ids.policy, digests.calendar, ids.workflows, NOW],
      { code: UNIQUE, constraint: 'evaluation_plans_mission_once' },
    );
    await t.violation(`UPDATE evaluation_plans SET warmup_sessions = 61`, [], {
      code: CHECK,
      constraint: 'evaluation_plans_immutable',
    });
    await t.violation(`DELETE FROM comparisons`, [], { code: CHECK, constraint: 'comparisons_immutable' });
  });

  it('keeps the windows D, V and H in order and apart', async () => {
    const plan = (d: [string, string], v: [string, string], h: [string, string], mission = 'm-plan') =>
      [
        `INSERT INTO evaluation_plans (plan_digest, plan_id, mission_id, profile_id, profile_revision, policy_id, policy_revision, suite_id,
         calendar_digest, warmup_sessions, d_start, d_end, v_start, v_end, h_start, h_end, recorded_by, recorded_at)
       VALUES ($1, 'plan-x', $2, $3, 1, $4, 1, 's1-suite', $1, 60, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [digests.calendar, mission, ids.profile, ids.policy, ...d, ...v, ...h, ids.workflows, NOW],
      ] as const;
    await t.ok(
      `INSERT INTO missions (mission_id, status, objective, instrument_id, symbol, provider, provider_asset_id, instrument_effective_from,
         profile_id, profile_revision, policy_id, policy_revision, seed_draft_digest, created_by, created_at, started_by, started_at)
       VALUES ('m-plan', 'IN_PROGRESS', 'x', 'i', 'AAPL', 'alpaca', 'a', '2020-01-01', $1, 1, $2, 1, $3, $4, $5, $4, $5)`,
      [ids.profile, ids.policy, digests.seedDraft, ids.researcher, NOW],
    );
    const ordinary: [[string, string], [string, string], [string, string]] = [
      ['2023-01-03', '2023-12-29'],
      ['2024-01-02', '2024-12-31'],
      ['2025-01-02', '2025-12-31'],
    ];
    await t.violation(...plan(['2023-01-03', '2024-06-28'], ordinary[1], ordinary[2]), {
      code: CHECK,
      constraint: 'evaluation_plans_windows_do_not_overlap',
    });
    await t.violation(...plan(ordinary[0], ['2024-01-02', '2025-02-03'], ordinary[2]), {
      code: CHECK,
      constraint: 'evaluation_plans_windows_do_not_overlap',
    });
    await t.violation(...plan(ordinary[1], ordinary[0], ordinary[2]), {
      code: CHECK,
      constraint: 'evaluation_plans_windows_do_not_overlap',
    });
    await t.violation(...plan(['2023-12-29', '2023-01-03'], ordinary[1], ordinary[2]), {
      code: CHECK,
      constraint: 'evaluation_plans_window_d',
    });
    // The windows may touch at no session: D ends 2023-12-29 and V starts 2023-12-29 would overlap.
    await t.violation(...plan(ordinary[0], ['2023-12-29', '2024-12-31'], ordinary[2]), {
      code: CHECK,
      constraint: 'evaluation_plans_windows_do_not_overlap',
    });
    await t.ok(...plan(ordinary[0], ordinary[1], ordinary[2]));
  });

  it('keeps one seed slot, one revision slot for each configuration and the shape of each slot kind', async () => {
    const seed = `INSERT INTO trial_slots (mission_id, trial_slot, plan_digest, slot_kind, strategy_id, draft_digest) VALUES ($1, 'slot-seed-2', $2, 'SEED', 'strategy-2', $3)`;
    await t.violation(seed, [ids.mission, digests.plan, digests.seedDraft], {
      code: UNIQUE,
      constraint: 'trial_slots_one_seed',
    });
    await t.violation(
      `INSERT INTO trial_slots (mission_id, trial_slot, plan_digest, slot_kind, parent_slot, configuration_id) VALUES ($1, 'slot-a-2', $2, 'REVISION', $3, $4)`,
      [ids.mission, digests.plan, ids.seedSlot, ids.proposerA],
      { code: UNIQUE, constraint: 'trial_slots_one_revision_per_configuration' },
    );
    // The critic is not a proposer: it authors no revision.
    await t.violation(
      `INSERT INTO trial_slots (mission_id, trial_slot, plan_digest, slot_kind, parent_slot, configuration_id) VALUES ($1, 'slot-c', $2, 'REVISION', $3, $4)`,
      [ids.mission, digests.plan, ids.seedSlot, ids.critic],
      { code: FOREIGN_KEY, constraint: 'trial_slots_configuration' },
    );
    // A revision descends from the seed slot, not from another revision.
    await t.violation(
      `INSERT INTO trial_slots (mission_id, trial_slot, plan_digest, slot_kind, parent_slot, configuration_id) VALUES ($1, 'slot-g', $2, 'REVISION', $3, 'prop-none')`,
      [ids.mission, digests.plan, ids.slotA],
      { code: FOREIGN_KEY },
    );
    await t.violation(`UPDATE trial_slots SET parent_slot = $1 WHERE trial_slot = $2`, [ids.slotA, ids.slotB], {
      code: FOREIGN_KEY,
      constraint: 'trial_slots_parent',
    });
    await t.ok(`DELETE FROM trial_slots WHERE trial_slot = $1`, [ids.slotB]);
    await t.violation(
      `INSERT INTO trial_slots (mission_id, trial_slot, plan_digest, slot_kind, parent_slot, configuration_id) VALUES ($1, 'slot-d', $2, 'REVISION', 'slot-missing', $3)`,
      [ids.mission, digests.plan, ids.proposerB],
      { code: FOREIGN_KEY, constraint: 'trial_slots_parent' },
    );
    await t.violation(
      `INSERT INTO trial_slots (mission_id, trial_slot, plan_digest, slot_kind, strategy_id, draft_digest, parent_slot) VALUES ($1, 'slot-e', $2, 'SEED', 's', $3, $4)`,
      [ids.mission, digests.plan, digests.seedDraft, ids.seedSlot],
      { code: CHECK, constraint: 'trial_slots_shape' },
    );
    await t.violation(
      `INSERT INTO trial_slots (mission_id, trial_slot, plan_digest, slot_kind, parent_slot) VALUES ($1, 'slot-f', $2, 'REVISION', $3)`,
      [ids.mission, digests.plan, ids.seedSlot],
      { code: CHECK, constraint: 'trial_slots_shape' },
    );
  });

  it('ends a slot with a listed reason, and SEED_NOT_EVALUATED only for a revision slot', async () => {
    await t.violation(
      `UPDATE trial_slots SET terminal_reason = 'SEED_NOT_EVALUATED', terminal_at = '${NOW}' WHERE trial_slot = $1`,
      [ids.seedSlot],
      { code: CHECK, constraint: 'trial_slots_seed_not_evaluated_is_a_revision' },
    );
    await t.violation(
      `UPDATE trial_slots SET terminal_reason = 'GAVE_UP', terminal_at = '${NOW}' WHERE trial_slot = $1`,
      [ids.slotA],
      {
        code: CHECK,
      },
    );
    await t.violation(
      `UPDATE trial_slots SET terminal_reason = 'DECISION_DEFERRED' WHERE trial_slot = $1`,
      [ids.slotA],
      {
        code: CHECK,
        constraint: 'trial_slots_terminal_pair',
      },
    );
    await t.ok(
      `UPDATE trial_slots SET terminal_reason = 'SEED_NOT_EVALUATED', terminal_at = '${NOW}' WHERE trial_slot = $1`,
      [ids.slotA],
    );
  });

  it('writes HOLDOUT runs only through freeze_candidates and every other run through the Decision', async () => {
    const insert = `INSERT INTO run_slots (mission_id, run_slot, trial_slot, window_role, cost_scenario, written_by) VALUES ($1, $2, $3, $4, $5, $6)`;
    await t.violation(insert, [ids.mission, 'rs-x', ids.slotB, 'HOLDOUT', 'BASE', 'EVALUATING_DECISION'], {
      code: CHECK,
      constraint: 'run_slots_holdout_by_freeze',
    });
    await t.violation(insert, [ids.mission, 'rs-x', ids.slotB, 'VALIDATION', 'BASE', 'FREEZE_CANDIDATES'], {
      code: CHECK,
      constraint: 'run_slots_holdout_by_freeze',
    });
    await t.ok(insert, [ids.mission, 'rs-x', ids.slotB, 'HOLDOUT', 'BASE', 'FREEZE_CANDIDATES']);
  });

  it('plans each window and cost case of a slot once, with one repeat that names the slot it repeats', async () => {
    const insert = `INSERT INTO run_slots (mission_id, run_slot, trial_slot, window_role, cost_scenario, written_by, replay_of) VALUES ($1, $2, $3, $4, $5, 'EVALUATING_DECISION', $6)`;
    await t.violation(insert, [ids.mission, 'rs-again', ids.seedSlot, 'DEVELOPMENT', 'BASE', null], {
      code: UNIQUE,
      constraint: 'run_slots_one_per_cell',
    });
    await t.violation(insert, [ids.mission, 'rs-repeat-2', ids.seedSlot, 'DEVELOPMENT', 'BASE', 'rs-d-base'], {
      code: UNIQUE,
      constraint: 'run_slots_one_repeat_per_cell',
    });
    await t.violation(insert, [ids.mission, 'rs-self', ids.slotB, 'DEVELOPMENT', 'BASE', 'rs-self'], {
      code: CHECK,
      constraint: 'run_slots_replay_is_another_slot',
    });
    await t.violation(insert, [ids.mission, 'rs-orphan', ids.slotB, 'DEVELOPMENT', 'BASE', 'rs-nowhere'], {
      code: FOREIGN_KEY,
      constraint: 'run_slots_replay',
    });
    await t.violation(insert, [ids.mission, 'rs-unknown-slot', 'slot-nowhere', 'DEVELOPMENT', 'BASE', null], {
      code: FOREIGN_KEY,
      constraint: 'run_slots_trial',
    });
  });
});

describe('strategy versions, lineage and trials (OQ-02 sections 1, 3.1 and 4)', () => {
  const insertVersion = `INSERT INTO strategy_versions (strategy_hash, strategy_id, version, parent_hash, mission_id, registered_at)
    VALUES ($1, $2, $3, $4, $5, $6)`;

  it('has no PAPER lifecycle in S1: a version is DRAFT or EVALUATING', async () => {
    await t.violation(
      `INSERT INTO strategy_versions (strategy_hash, strategy_id, version, lifecycle, mission_id, registered_at) VALUES ($1, 'strategy-9', 1, 'PAPER', $2, $3)`,
      [digests.policyDoc, ids.mission, NOW],
      { code: CHECK, constraint: 'strategy_versions_s1_lifecycle' },
    );
    await t.ok(`UPDATE strategy_versions SET lifecycle = 'EVALUATING' WHERE strategy_hash = $1`, [
      digests.seedStrategy,
    ]);
    await t.violation(
      `UPDATE strategy_versions SET lifecycle = 'PAPER' WHERE strategy_hash = $1`,
      [digests.revisionStrategy],
      {
        code: CHECK,
      },
    );
    await t.violation(
      `UPDATE strategy_versions SET lifecycle = 'DRAFT' WHERE strategy_hash = $1`,
      [digests.seedStrategy],
      {
        code: CHECK,
        constraint: 'strategy_versions_lifecycle_transition',
      },
    );
  });

  it('is immutable apart from its lifecycle, and is never deleted', async () => {
    await t.violation(`UPDATE strategy_versions SET version = 9 WHERE strategy_hash = $1`, [digests.seedStrategy], {
      code: CHECK,
      constraint: 'strategy_versions_immutable',
    });
    await t.violation(`DELETE FROM strategy_versions WHERE strategy_hash = $1`, [digests.revisionStrategy], {
      code: CHECK,
      constraint: 'strategy_versions_immutable',
    });
  });

  it('has a parent exactly when it is not version 1, and the parent is a version of the same strategy', async () => {
    for (const label of ['v-a', 'v-b', 'v-c', 'v-d']) await artefact(t.exec, sha(label));
    await t.violation(insertVersion, [sha('v-a'), 'strategy-3', 1, digests.seedStrategy, ids.mission, NOW], {
      code: CHECK,
    });
    await t.violation(insertVersion, [sha('v-b'), ids.strategy, 3, null, ids.mission, NOW], {
      code: CHECK,
      constraint: 'strategy_versions_parent_iff_revision',
    });
    await t.violation(insertVersion, [sha('v-c'), 'strategy-3', 2, digests.seedStrategy, ids.mission, NOW], {
      code: FOREIGN_KEY,
      constraint: 'strategy_versions_parent',
    });
    await t.violation(insertVersion, [sha('v-d'), ids.strategy, 2, digests.seedStrategy, ids.mission, NOW], {
      code: UNIQUE,
      constraint: 'strategy_versions_identity',
    });
    // The hash is the artefact: no version without a stored strategy artefact.
    await t.violation(insertVersion, [sha('v-unstored'), ids.strategy, 3, digests.seedStrategy, ids.mission, NOW], {
      code: FOREIGN_KEY,
    });
  });

  it('records a revision change with its scope, for the parent that the version has', async () => {
    const insert = `INSERT INTO strategy_lineage (child_hash, parent_hash, change_scope, validation_digest, recorded_at) VALUES ($1, $2, $3, $4, $5)`;
    await t.violation(insert, [digests.revisionStrategy, digests.seedStrategy, 'BOTH', digests.plan, NOW], {
      code: CHECK,
    });
    await t.violation(insert, [digests.seedStrategy, digests.seedStrategy, 'ENTRY', digests.plan, NOW], {
      code: CHECK,
      constraint: 'strategy_lineage_child_differs',
    });
    await t.violation(insert, [digests.seedStrategy, digests.revisionStrategy, 'ENTRY', digests.plan, NOW], {
      code: FOREIGN_KEY,
      constraint: 'strategy_lineage_version',
    });
    await t.ok(insert, [digests.revisionStrategy, digests.seedStrategy, 'EXIT', digests.plan, NOW]);
    await t.violation(`UPDATE strategy_lineage SET change_scope = 'ENTRY'`, [], {
      code: CHECK,
      constraint: 'strategy_lineage_immutable',
    });
  });

  it('keeps every proposal as a trial and registers one trial for a slot', async () => {
    const insert = `INSERT INTO trials (trial_id, mission_id, trial_slot, proposal_ordinal, draft_digest, status, strategy_hash, reason, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`;
    await t.violation(
      insert,
      ['t-1', ids.mission, ids.slotA, 1, digests.revisionStrategy, 'REGISTERED', null, null, NOW],
      {
        code: CHECK,
        constraint: 'trials_registered_iff_version',
      },
    );
    await t.violation(
      insert,
      ['t-1', ids.mission, ids.slotA, 1, digests.revisionStrategy, 'INVALID', digests.revisionStrategy, 'x', NOW],
      {
        code: CHECK,
        constraint: 'trials_registered_iff_version',
      },
    );
    await t.violation(
      insert,
      ['t-1', ids.mission, ids.slotA, 1, digests.revisionStrategy, 'INVALID', null, null, NOW],
      {
        code: CHECK,
        constraint: 'trials_failed_has_reason',
      },
    );
    await t.ok(insert, [
      't-1',
      ids.mission,
      ids.slotA,
      1,
      digests.revisionStrategy,
      'REGISTERED',
      digests.revisionStrategy,
      null,
      NOW,
    ]);
    await t.violation(
      insert,
      ['t-2', ids.mission, ids.slotA, 2, digests.revisionStrategy, 'REGISTERED', digests.seedStrategy, null, NOW],
      {
        code: UNIQUE,
        constraint: 'trials_one_registered_per_slot',
      },
    );
    await t.violation(
      insert,
      ['t-3', ids.mission, ids.slotA, 1, digests.revisionStrategy, 'INVALID', null, 'REVISION_SCOPE', NOW],
      {
        code: UNIQUE,
        constraint: 'trials_proposal_unique',
      },
    );
    await t.ok(insert, [
      't-4',
      ids.mission,
      ids.slotA,
      2,
      digests.revisionStrategy,
      'INVALID',
      null,
      'REVISION_SCOPE',
      NOW,
    ]);
  });

  it('lets a trial leave DRAFTED once and never come back', async () => {
    await t.ok(
      `INSERT INTO trials (trial_id, mission_id, trial_slot, proposal_ordinal, draft_digest, created_at) VALUES ('t-d', $1, $2, 1, $3, $4)`,
      [ids.mission, ids.slotB, digests.revisionStrategy, NOW],
    );
    await t.ok(`UPDATE trials SET status = 'INVALID', reason = 'REVISION_SCOPE' WHERE trial_id = 't-d'`);
    await t.violation(
      `UPDATE trials SET status = 'REGISTERED', strategy_hash = '${digests.revisionStrategy}', reason = NULL WHERE trial_id = 't-d'`,
      [],
      { code: CHECK, constraint: 'trial_transition' },
    );
    await t.violation(`UPDATE trials SET status = 'DRAFTED', reason = NULL WHERE trial_id = 't-d'`, [], {
      code: CHECK,
      constraint: 'trial_transition',
    });
  });
});

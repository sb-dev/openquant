// The registration commands on a real PostgreSQL (OQ-02 sections 1, 3.1 and 4): a Steward registers the period budget,
// the research profile and the cohort policy; a Researcher registers a seed draft. Each record is an immutable revision
// that follows the one before it. Documents are the synthetic fixtures of the protocol manifest.

import { digest } from '@openquant/api-contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CommandOutcome } from '../src/commands/runner.ts';
import { ids } from './support/seed.ts';
import { createWorld, type Doc, registerRecords, type World } from './support/world.ts';

let world: World;

beforeAll(async () => {
  world = await createWorld();
});
afterAll(async () => {
  await world.drop();
});

function refusal(outcome: CommandOutcome): { code: string; message: string } {
  if (outcome.state !== 'REJECTED') throw new Error(`expected a refusal, got ${outcome.state}`);
  return outcome.status.error;
}

describe('register_budget', () => {
  it('stores the period budget with its two pools, its document and its audit row', async () => {
    const outcome = await world.apply('steward', { kind: 'register_budget', budget: world.docs.budget });
    expect(outcome.state).toBe('APPLIED');
    if (outcome.state !== 'APPLIED') return;
    expect(outcome.status.record).toEqual({ id: 'staging-period-cap', revision: 1 });
    const caps = await world.sql(
      `SELECT revision, to_char(period_start, 'YYYY-MM-DD') AS start, to_char(period_end, 'YYYY-MM-DD') AS stop,
              model_spend::text AS spend, currency, provider_requests::text AS requests, registered_by, document_digest
         FROM budget_caps WHERE budget_id = 'staging-period-cap'`,
    );
    expect(caps).toEqual([
      {
        revision: 1,
        start: '2026-11-01',
        stop: '2026-11-30',
        spend: '210.00000000',
        currency: 'USD',
        requests: '120',
        registered_by: ids.steward,
        document_digest: await digest(world.docs.budget),
      },
    ]);
    // The cap is held as two pools: 210 USD of model spend and 120 provider requests, nothing committed yet.
    const pools = await world.sql(
      `SELECT dimension, limit_amount::text AS limit_amount, committed::text AS committed, overrun::text AS overrun, budget_revision
         FROM budget_pools WHERE scope = 'PERIOD' AND budget_id = 'staging-period-cap' ORDER BY dimension`,
    );
    expect(pools).toEqual([
      {
        dimension: 'MODEL_SPEND',
        limit_amount: '210.00000000',
        committed: '0.00000000',
        overrun: '0.00000000',
        budget_revision: 1,
      },
      {
        dimension: 'PROVIDER_REQUESTS',
        limit_amount: '120.00000000',
        committed: '0.00000000',
        overrun: '0.00000000',
        budget_revision: 1,
      },
    ]);
    expect(await world.testApp.objects.head(await digest(world.docs.budget))).toEqual({ size: expect.any(Number) });
    const audit = await world.sql(
      `SELECT actor, subject, command_id FROM audit_events WHERE event_type = 'budget.registered'`,
    );
    expect(audit).toEqual([
      { actor: ids.steward, subject: 'staging-period-cap', command_id: outcome.status.command_id },
    ]);
  });

  it('refuses a stale expected revision with the current one, and a revision that skips a number', async () => {
    const budget = structuredClone(world.docs.budget) as Doc;
    budget.revision = 2;
    const stale = await world.apply('steward', { kind: 'register_budget', budget }, { expectedRevision: 0 });
    expect(refusal(stale).code).toBe('REVISION_CONFLICT');
    if (stale.state === 'REJECTED') expect(stale.failure.currentRevision).toBe(1);
    budget.revision = 3;
    const skipped = await world.apply('steward', { kind: 'register_budget', budget }, { expectedRevision: 1 });
    expect(refusal(skipped)).toMatchObject({ code: 'POLICY_VIOLATION' });
    expect(refusal(skipped).message).toContain('next revision is 2');
    const revisions = await world.sql(`SELECT revision FROM budget_caps WHERE budget_id = 'staging-period-cap'`);
    expect(revisions).toEqual([{ revision: 1 }]);
  });

  it('refuses a period that ends before it starts, a date that is not on the calendar, and an amount the ledger cannot hold', async () => {
    const attempt = async (edit: (budget: Doc) => void) => {
      const budget = structuredClone(world.docs.budget) as Doc;
      budget.budget_id = 'other-cap';
      edit(budget);
      return refusal(await world.apply('steward', { kind: 'register_budget', budget }));
    };
    expect((await attempt((b) => (b.period = { start: '2026-11-30', end: '2026-11-01' }))).message).toContain(
      'ends before',
    );
    expect((await attempt((b) => (b.period = { start: '2026-02-31', end: '2026-03-01' }))).message).toContain(
      'calendar',
    );
    expect((await attempt((b) => (b.model_spend.amount = '0.123456789'))).message).toContain('ledger');
    expect((await attempt((b) => (b.model_spend.amount = '10000000000000000'))).message).toContain('ledger');
    expect(await world.sql(`SELECT 1 FROM budget_caps WHERE budget_id = 'other-cap'`)).toEqual([]);
  });
});

describe('register_research_profile', () => {
  it('is refused until the period budget that it names is registered', async () => {
    const solo = await createWorld();
    const outcome = await solo.apply('steward', { kind: 'register_research_profile', profile: solo.docs.profile });
    expect(refusal(outcome)).toMatchObject({ code: 'POLICY_VIOLATION' });
    expect(refusal(outcome).message).toContain('staging-period-cap');
    await solo.drop();
  });

  it('stores the profile bound to the current revision of its period budget', async () => {
    const outcome = await world.apply('steward', { kind: 'register_research_profile', profile: world.docs.profile });
    expect(outcome.state).toBe('APPLIED');
    const rows = await world.sql(
      'SELECT revision, budget_id, budget_revision, document_digest, registered_by FROM research_profiles',
    );
    expect(rows).toEqual([
      {
        revision: 1,
        budget_id: 'staging-period-cap',
        budget_revision: 1,
        document_digest: world.records.profile.digest,
        registered_by: ids.steward,
      },
    ]);
    // The document is the canonical JSON of the profile, under its own digest.
    expect(await world.testApp.objects.head(world.records.profile.digest as never)).not.toBeNull();
  });

  it('numbers revisions from the latest: revision 2 needs expected revision 1', async () => {
    const next = structuredClone(world.docs.profile) as Doc;
    next.revision = 2;
    const wrong = await world.apply(
      'steward',
      { kind: 'register_research_profile', profile: next },
      { expectedRevision: 0 },
    );
    expect(refusal(wrong).code).toBe('REVISION_CONFLICT');
    const right = await world.apply(
      'steward',
      { kind: 'register_research_profile', profile: next },
      { expectedRevision: 1 },
    );
    expect(right.state).toBe('APPLIED');
    const revisions = await world.sql('SELECT revision FROM research_profiles ORDER BY revision');
    expect(revisions).toEqual([{ revision: 1 }, { revision: 2 }]);
  });

  it('refuses a data currency that is not the market currency and a history that ends before it starts', async () => {
    const edit = async (change: (profile: Doc) => void) => {
      const profile = structuredClone(world.docs.profile) as Doc;
      profile.profile_id = 'other-profile';
      change(profile);
      return refusal(await world.apply('steward', { kind: 'register_research_profile', profile }));
    };
    expect((await edit((p) => (p.data.currency = 'EUR'))).message).toContain('currency');
    expect((await edit((p) => (p.history = { start: '2025-12-31', end: '2022-01-01' }))).message).toContain(
      'ends before',
    );
  });
});

describe('register_cohort_policy', () => {
  const attempt = async (change: (policy: Doc) => void, expectedRevision = 0) => {
    const policy = structuredClone(world.docs.policy) as Doc;
    policy.policy_id = `policy-${Math.random().toString(16).slice(2, 10)}`;
    change(policy);
    return world.apply('steward', { kind: 'register_cohort_policy', policy }, { expectedRevision });
  };

  it('stores the policy and records the Steward approval Decision that every policy-determined Decision names', async () => {
    const outcome = await world.apply('steward', { kind: 'register_cohort_policy', policy: world.docs.policy });
    expect(outcome.state).toBe('APPLIED');
    if (outcome.state !== 'APPLIED') return;
    expect(outcome.status.record).toEqual({ id: 's1-aapl-daily-swing', revision: 1 });
    const policies = await world.sql('SELECT suite_id, document_digest FROM cohort_policies');
    expect(policies).toEqual([{ suite_id: 's1-single-stock-suite', document_digest: world.records.policy.digest }]);
    const decisions = await world.sql(
      `SELECT kind, outcome, actor_id, actor_kind, policy_id, policy_revision, command_id, mission_id FROM decisions`,
    );
    expect(decisions).toEqual([
      {
        kind: 'POLICY_APPROVAL',
        outcome: 'APPROVED',
        actor_id: ids.steward,
        actor_kind: 'HUMAN',
        policy_id: 's1-aapl-daily-swing',
        policy_revision: 1,
        command_id: outcome.status.command_id,
        mission_id: null,
      },
    ]);
  });

  it('is refused for a profile that is not registered, and for a digest that is not the digest of the profile', async () => {
    const missing = await attempt((p) => (p.profile = { ...p.profile, revision: 9 }));
    expect(refusal(missing).code).toBe('NOT_FOUND');
    const wrong = await attempt((p) => (p.profile = { ...p.profile, digest: `sha256:${'0'.repeat(64)}` }));
    expect(refusal(wrong)).toMatchObject({ code: 'POLICY_VIOLATION' });
  });

  it('applies the rules that a schema cannot state, one refusal for each rule', async () => {
    const rules: [string, (policy: Doc) => void, string][] = [
      ['a suite other than the one of the profile', (p) => (p.suite_id = 'another-suite'), 'suite'],
      [
        'an execution currency other than the market currency',
        (p) => (p.conditions.execution_policy.currency = 'EUR'),
        'currency',
      ],
      [
        'windows in the wrong order',
        (p) => {
          const [d, v] = p.conditions.windows.windows;
          [d.scored, v.scored] = [v.scored, d.scored];
        },
        'order',
      ],
      [
        'a window outside the history of the profile',
        (p) => (p.conditions.windows.windows[0].scored = { start: '2019-01-01', end: '2019-12-31' }),
        'outside the history',
      ],
      [
        'a window that is not on the calendar',
        (p) => (p.conditions.windows.windows[0].scored = { start: '2023-02-31', end: '2023-12-31' }),
        'calendar',
      ],
      ['a warm-up that fills the run', (p) => (p.conditions.windows.warmup_sessions = 400), 'warm-up'],
      [
        'a gate under the wrong evidence category',
        (p) => {
          const gate = p.gates.find((g: Doc) => g.gate === 'COST_STRESS');
          gate.category = 'CORRECTNESS';
        },
        'COST_STRESS',
      ],
      [
        'a finding category that blocks DRAFT to EVALUATING',
        (p) => {
          p.finding_treatment.find(
            (row: Doc) => row.category === 'causal_leakage' && row.transition === 'DRAFT_TO_EVALUATING',
          ).treatment = 'BLOCKING';
        },
        'blocks DRAFT to EVALUATING',
      ],
      [
        'an escalation on DRAFT to EVALUATING',
        (p) => {
          p.finding_treatment.find(
            (row: Doc) => row.category === 'method_advice' && row.transition === 'DRAFT_TO_EVALUATING',
          ).escalate_when = ['required_evidence'];
        },
        'blocks DRAFT to EVALUATING',
      ],
      [
        'a category with no treatment for EVALUATING to PAPER',
        (p) => {
          p.finding_treatment = p.finding_treatment.filter(
            (row: Doc) => !(row.category === 'portfolio_fit' && row.transition === 'EVALUATING_TO_PAPER'),
          );
        },
        'portfolio_fit',
      ],
      ['a treatment listed twice', (p) => p.finding_treatment.push(structuredClone(p.finding_treatment[0])), 'twice'],
    ];
    for (const [label, change, text] of rules) {
      const outcome = await attempt(change);
      expect(refusal(outcome).code, label).toBe('POLICY_VIOLATION');
      expect(refusal(outcome).message, label).toContain(text);
    }
    expect(await world.sql('SELECT 1 FROM cohort_policies WHERE policy_id <> $1', ['s1-aapl-daily-swing'])).toEqual([]);
  });
});

describe('register_seed', () => {
  it('stores the draft by its digest with its source-interpretation record, and names the strategy', async () => {
    const outcome = await world.apply('researcher', { kind: 'register_seed', ...world.docs.seed });
    expect(outcome.state).toBe('APPLIED');
    if (outcome.state !== 'APPLIED') return;
    expect(outcome.status.record).toEqual({ id: 'daily-swing-seed', revision: 1 });
    const drafts = await world.sql('SELECT draft_digest, origin, strategy_id, registered_by FROM seed_drafts');
    expect(drafts).toEqual([
      {
        draft_digest: world.records.seedDigest,
        origin: 'researcher_authored',
        strategy_id: 'daily-swing-seed',
        registered_by: ids.researcher,
      },
    ]);
    const interpretation = await world.sql('SELECT sources, source_differences FROM source_interpretations');
    expect(interpretation).toEqual([
      { sources: world.docs.seed.sources, source_differences: world.docs.seed.source_differences },
    ]);
    // The draft is not a Strategy Version: nothing in strategy_versions yet.
    expect(await world.sql('SELECT 1 FROM strategy_versions')).toEqual([]);
  });

  it('refuses the same draft again as a conflict at revision 1, and a draft of the same strategy with other content', async () => {
    const again = await world.apply('researcher', { kind: 'register_seed', ...world.docs.seed });
    expect(refusal(again).code).toBe('REVISION_CONFLICT');
    if (again.state === 'REJECTED') expect(again.failure.currentRevision).toBe(1);
    const other = structuredClone(world.docs.seed) as Doc;
    other.draft.contract.hypothesis = 'A different hypothesis about the same strategy.';
    const clash = await world.apply('researcher', { kind: 'register_seed', ...other });
    expect(refusal(clash).code).toBe('POLICY_VIOLATION');
    expect(refusal(clash).message).toContain('daily-swing-seed');
    expect(await world.sql('SELECT 1 FROM seed_drafts')).toHaveLength(1);
  });

  it('refuses a seed that is not version 1 of a new strategy', async () => {
    const second = structuredClone(world.docs.seed) as Doc;
    second.draft.strategy_id = 'another-strategy';
    second.draft.version = 2;
    expect(refusal(await world.apply('researcher', { kind: 'register_seed', ...second })).message).toContain(
      'version 1',
    );
    const child = structuredClone(world.docs.seed) as Doc;
    child.draft.strategy_id = 'child-strategy';
    child.draft.parent = { strategy_hash: world.records.seedDigest, changes: [] };
    expect(refusal(await world.apply('researcher', { kind: 'register_seed', ...child })).message).toContain(
      'no parent',
    );
  });
});

describe('the whole registration of the pilot, in order', () => {
  it('registers budget, profile, policy and seed through the commands and leaves one approval Decision', async () => {
    const solo = await createWorld();
    await registerRecords(solo);
    expect(await solo.sql('SELECT revision FROM budget_caps')).toEqual([{ revision: 1 }]);
    expect(await solo.sql('SELECT revision FROM research_profiles')).toEqual([{ revision: 1 }]);
    expect(await solo.sql('SELECT revision FROM cohort_policies')).toEqual([{ revision: 1 }]);
    expect(await solo.sql(`SELECT count(*)::int AS n FROM decisions WHERE kind = 'POLICY_APPROVAL'`)).toEqual([
      { n: 1 },
    ]);
    expect(solo.records.approvalId).toMatch(/^dec-/);
    await solo.drop();
  });
});

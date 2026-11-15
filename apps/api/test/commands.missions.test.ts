// create_mission, run_mission_now and cancel_mission on a real PostgreSQL (OQ-02 section 1, OQ-03 section 1, OQ-05
// section 4, decisions D21, D22 and D26). Expected numbers come from the pilot budget of the decision record: 3
// candidates, 21 experiments, 105 USD of model spend (2 x 30 for the proposers, 45 for the critic, 5 per attempt),
// 60 provider requests, 7,200 batch seconds, 18,900 agent seconds, an attempt cap of 3; and a period cap of 210 USD and
// 120 requests. The retrieval request is compared with the fixture that the lead wrote for the protocol manifest.

import { digest, parseContract } from '@openquant/api-contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CommandOutcome } from '../src/commands/runner.ts';
import { ids } from './support/seed.ts';
import {
  createMission,
  createWorld,
  type Doc,
  fixture,
  missionPayload,
  registerRecords,
  startMission,
  type World,
} from './support/world.ts';

function refusal(outcome: CommandOutcome): { code: string; message: string } {
  if (outcome.state !== 'REJECTED') throw new Error(`expected a refusal, got ${outcome.state}`);
  return outcome.status.error;
}

async function newWorld(options: Parameters<typeof createWorld>[0] = {}): Promise<World> {
  const world = await createWorld(options);
  await registerRecords(world);
  return world;
}

describe('create_mission', () => {
  let world: World;
  beforeAll(async () => {
    world = await newWorld();
  });
  afterAll(async () => {
    await world.drop();
  });

  it('creates a CREATED mission at revision 1 with its budget, its three configurations and its pools', async () => {
    const outcome = await world.apply('researcher', missionPayload(world));
    expect(outcome.state).toBe('APPLIED');
    if (outcome.state !== 'APPLIED') return;
    const missionId = outcome.status.record.id;
    expect(outcome.status.record.revision).toBe(1);
    expect(missionId).toMatch(/^msn-/);

    const missions = await world.sql(
      `SELECT status, revision, created_by, started_by, instrument_id, symbol, profile_id, profile_revision, policy_id,
              policy_revision, seed_draft_digest FROM missions WHERE mission_id = $1`,
      [missionId],
    );
    expect(missions).toEqual([
      {
        status: 'CREATED',
        revision: 1,
        created_by: ids.researcher,
        started_by: null,
        instrument_id: 'alpaca:11111111-2222-4333-8444-555555555555',
        symbol: 'AAPL',
        profile_id: 'aapl-us-daily-sip',
        profile_revision: 1,
        policy_id: 's1-aapl-daily-swing',
        policy_revision: 1,
        seed_draft_digest: world.records.seedDigest,
      },
    ]);
    const budget = await world.sql(
      `SELECT candidates, experiments, revisions_per_proposer, new_families, proposer_count, model_spend::text AS model_spend,
              model_spend_per_attempt::text AS per_attempt, proposer_spend::text AS proposer_spend, proposer_attempts,
              critic_spend::text AS critic_spend, critic_attempts, provider_requests::text AS provider_requests,
              batch_compute_seconds::text AS batch, agent_compute_seconds::text AS agent, attempt_cap
         FROM mission_budgets WHERE mission_id = $1`,
      [missionId],
    );
    expect(budget).toEqual([
      {
        candidates: 3,
        experiments: 21,
        revisions_per_proposer: 2,
        new_families: 0,
        proposer_count: 2,
        model_spend: '105.00000000',
        per_attempt: '5.00000000',
        proposer_spend: '30.00000000',
        proposer_attempts: 6,
        critic_spend: '45.00000000',
        critic_attempts: 9,
        provider_requests: '60',
        batch: '7200',
        agent: '18900',
        attempt_cap: 3,
      },
    ]);
    const configurations = await world.sql(
      `SELECT configuration_id, role, executor_model, cutoff_status, cutoff, cutoff_read_on::text AS read_on, cutoff_unknown_reason IS NOT NULL AS has_reason
         FROM mission_agent_configurations WHERE mission_id = $1 ORDER BY configuration_id`,
      [missionId],
    );
    expect(configurations).toEqual([
      {
        configuration_id: 'critic',
        role: 'CRITIC',
        executor_model: 'claude-opus-5-5',
        cutoff_status: 'published',
        cutoff: '2026-06',
        read_on: '2026-11-14',
        has_reason: false,
      },
      {
        configuration_id: 'proposer-a',
        role: 'PROPOSER',
        executor_model: 'claude-opus-5-5',
        cutoff_status: 'published',
        cutoff: '2026-06',
        read_on: '2026-11-14',
        has_reason: false,
      },
      // The cutoff of this model is not stated: it is recorded as unknown with the reason, never inferred (OQ-03 section 2).
      {
        configuration_id: 'proposer-b',
        role: 'PROPOSER',
        executor_model: 'claude-sonnet-5-5',
        cutoff_status: 'unknown',
        cutoff: null,
        read_on: null,
        has_reason: true,
      },
    ]);
    // Every configuration reserves from its own allowance: 30 and 30 for the proposers, 45 for the critic.
    const pools = await world.sql(
      `SELECT dimension, configuration_id, limit_amount::text AS lim, committed::text AS committed
         FROM budget_pools WHERE mission_id = $1 ORDER BY dimension, configuration_id NULLS FIRST`,
      [missionId],
    );
    expect(pools).toEqual([
      { dimension: 'AGENT_COMPUTE_SECONDS', configuration_id: null, lim: '18900.00000000', committed: '0.00000000' },
      { dimension: 'BATCH_COMPUTE_SECONDS', configuration_id: null, lim: '7200.00000000', committed: '0.00000000' },
      { dimension: 'MODEL_SPEND', configuration_id: 'critic', lim: '45.00000000', committed: '0.00000000' },
      { dimension: 'MODEL_SPEND', configuration_id: 'proposer-a', lim: '30.00000000', committed: '0.00000000' },
      { dimension: 'MODEL_SPEND', configuration_id: 'proposer-b', lim: '30.00000000', committed: '0.00000000' },
      { dimension: 'PROVIDER_REQUESTS', configuration_id: null, lim: '60.00000000', committed: '0.00000000' },
    ]);
    // The mission took its whole budget from the period cap: 105 of 210 USD and 60 of 120 requests.
    const period = await world.sql(
      `SELECT dimension, committed::text AS committed FROM budget_pools WHERE scope = 'PERIOD' ORDER BY dimension`,
    );
    expect(period).toEqual([
      { dimension: 'MODEL_SPEND', committed: '105.00000000' },
      { dimension: 'PROVIDER_REQUESTS', committed: '60.00000000' },
    ]);
    // No job, run or attempt exists before the mission starts.
    expect(await world.sql('SELECT 1 FROM jobs')).toEqual([]);
    expect(await world.sql('SELECT 1 FROM attempts')).toEqual([]);
  });

  it('fits a second mission at the maxima in the period cap of 210 USD and 120 requests, and refuses a third', async () => {
    const second = await world.apply('researcher', missionPayload(world));
    expect(second.state).toBe('APPLIED');
    const third = await world.apply('researcher', missionPayload(world));
    expect(refusal(third).code).toBe('BUDGET_EXHAUSTED');
    expect(refusal(third).message).toContain('0.00000000 is left');
    const period = await world.sql(
      `SELECT dimension, committed::text AS committed FROM budget_pools WHERE scope = 'PERIOD' ORDER BY dimension`,
    );
    expect(period).toEqual([
      { dimension: 'MODEL_SPEND', committed: '210.00000000' },
      { dimension: 'PROVIDER_REQUESTS', committed: '120.00000000' },
    ]);
    expect(await world.sql('SELECT 1 FROM missions')).toHaveLength(2);
  });

  it('refuses every budget that breaks a rule of the policy, and the refusal leaves nothing behind', async () => {
    const fresh = await newWorld();
    const before = await fresh.snapshot(['audit_events']);
    const rules: [string, (mission: Doc) => void, string][] = [
      ['candidates above the maximum', (m) => (m.budget.candidates = 4), 'candidates'],
      ['experiments above the maximum', (m) => (m.budget.experiments = 22), 'experiments'],
      ['a revision count above the maximum', (m) => (m.budget.revisions_per_proposer = 3), 'revisions_per_proposer'],
      ['new families above the maximum', (m) => (m.budget.new_families = 1), 'new_families'],
      ['an attempt cap above the maximum', (m) => (m.budget.attempt_cap = 4), 'attempt_cap'],
      ['provider requests above the maximum', (m) => (m.budget.provider_requests = 61), 'provider_requests'],
      ['batch seconds above the maximum', (m) => (m.budget.batch_compute_seconds = 7201), 'batch_compute_seconds'],
      ['agent seconds above the maximum', (m) => (m.budget.agent_compute_seconds = 18901), 'agent_compute_seconds'],
      [
        'a model spend that is not the allowances added up (104 for 2 x 30 + 45)',
        (m) => (m.budget.model_spend.amount = '104.00'),
        'added up',
      ],
      [
        'a proposer allowance that is not its attempts times the reservation (31 for 6 x 5)',
        (m) => {
          m.budget.proposer_allowance.model_spend.amount = '31.00';
          m.budget.model_spend.amount = '107.00';
        },
        'proposer allowance',
      ],
      [
        'a critic allowance that is not its attempts times the reservation (44 for 9 x 5)',
        (m) => {
          m.budget.critic_allowance.model_spend.amount = '44.00';
          m.budget.model_spend.amount = '104.00';
        },
        'critic allowance',
      ],
      [
        'agent seconds that do not cover 21 attempts of 900 seconds (18,899)',
        (m) => (m.budget.agent_compute_seconds = 18899),
        'agent compute seconds',
      ],
      [
        'fewer provider requests than attempts of the cap',
        (m) => (m.budget.provider_requests = 2),
        'at least one request',
      ],
      [
        'a model spend in another currency',
        (m) => {
          for (const money of [
            m.budget.model_spend,
            m.budget.model_spend_per_attempt,
            m.budget.proposer_allowance.model_spend,
            m.budget.critic_allowance.model_spend,
          ])
            money.currency = 'EUR';
        },
        'currency',
      ],
      [
        'two configurations with one identifier',
        (m) => (m.proposers[1].configuration_id = 'proposer-a'),
        'share an identifier',
      ],
      [
        'a critic that reuses a proposer identifier',
        (m) => (m.critic.configuration_id = 'proposer-a'),
        'share an identifier',
      ],
      [
        'an instrument ID that is not provider:asset',
        (m) => (m.instrument.instrument_id = 'alpaca:other'),
        'PROVIDER_ASSET_ID',
      ],
      ['an instrument of another provider', (m) => (m.instrument.provider = 'massive'), 'provider'],
    ];
    for (const [label, change, text] of rules) {
      const outcome = await fresh.apply('researcher', missionPayload(fresh, change));
      expect(refusal(outcome).code, label).toBe('POLICY_VIOLATION');
      expect(refusal(outcome).message, label).toContain(text);
    }
    // Nothing of any refused command remains: no mission, budget, pool, artefact or audit row, and the period untouched.
    const after = await fresh.snapshot(['audit_events']);
    expect(after).toEqual(before);
    // The only audit rows of the refused commands are the records of their refusal.
    const audit = await fresh.sql(
      `SELECT DISTINCT event_type FROM audit_events WHERE event_type NOT IN ('budget.registered', 'research_profile.registered', 'cohort_policy.registered', 'seed.registered')`,
    );
    expect(audit).toEqual([{ event_type: 'command.rejected' }]);
    await fresh.drop();
  });

  it('refuses a record that is not registered, a digest that differs, and an expected revision other than 0', async () => {
    const fresh = await newWorld();
    const missingProfile = await fresh.apply(
      'researcher',
      missionPayload(fresh, (m) => (m.profile.revision = 9)),
    );
    expect(refusal(missingProfile).code).toBe('NOT_FOUND');
    const missingPolicy = await fresh.apply(
      'researcher',
      missionPayload(fresh, (m) => (m.cohort_policy.id = 'nope')),
    );
    expect(refusal(missingPolicy).code).toBe('NOT_FOUND');
    const missingSeed = await fresh.apply(
      'researcher',
      missionPayload(fresh, (m) => (m.seed_draft_digest = `sha256:${'1'.repeat(64)}`)),
    );
    expect(refusal(missingSeed).code).toBe('NOT_FOUND');
    const wrongDigest = await fresh.apply(
      'researcher',
      missionPayload(fresh, (m) => (m.profile.digest = `sha256:${'2'.repeat(64)}`)),
    );
    expect(refusal(wrongDigest)).toMatchObject({ code: 'POLICY_VIOLATION' });
    const revision = await fresh.apply('researcher', missionPayload(fresh), { expectedRevision: 1 });
    expect(refusal(revision).message).toContain('expected_revision must be 0');
    expect(await fresh.sql('SELECT 1 FROM missions')).toEqual([]);
    await fresh.drop();
  });

  it('refuses a mission that the period budget can never hold with POLICY_VIOLATION, not BUDGET_EXHAUSTED', async () => {
    const small = await createWorld();
    small.docs.budget.model_spend.amount = '100.00';
    await registerRecords(small);
    const outcome = await small.apply('researcher', missionPayload(small));
    expect(refusal(outcome).code).toBe('POLICY_VIOLATION');
    expect(refusal(outcome).message).toContain('holds only 100.00000000');
    await small.drop();
  });

  it('refuses a mission created outside the period of the cap', async () => {
    const late = await newWorld();
    late.testApp.clock.set(new Date('2026-12-01T09:00:00Z'));
    const outcome = await late.apply('researcher', missionPayload(late));
    expect(refusal(outcome).message).toContain('2026-11-01 to 2026-11-30, not 2026-12-01');
    await late.drop();
  });
});

describe('run_mission_now', () => {
  it('starts the mission and writes its retrieval job, attempt, reservation and outbox entry in one transaction', async () => {
    const world = await newWorld();
    const missionId = await createMission(world);
    const started = await startMission(world);
    expect(started.revision).toBe(2);
    expect(
      await world.sql('SELECT status, revision, started_by FROM missions WHERE mission_id = $1', [missionId]),
    ).toEqual([{ status: 'IN_PROGRESS', revision: 2, started_by: ids.researcher }]);
    const jobs = await world.sql('SELECT job_id, kind, status, attempt_cap, mission_id, revision FROM jobs');
    expect(jobs).toEqual([
      { job_id: started.jobId, kind: 'retrieve', status: 'QUEUED', attempt_cap: 3, mission_id: missionId, revision: 1 },
    ]);
    const attempts = await world.sql('SELECT attempt_id, job_id, ownership_revision, status FROM attempts');
    expect(attempts).toEqual([
      { attempt_id: started.attemptId, job_id: started.jobId, ownership_revision: 1, status: 'PENDING' },
    ]);
    expect(await world.sql('SELECT status FROM reservations')).toEqual([{ status: 'RESERVED' }]);
    // The retrieval reserves 20 provider requests (60 over the attempt cap of 3) and the 600 seconds of its timeout.
    const lines = await world.sql(
      `SELECT bp.dimension, rl.reserved::text AS reserved, bp.committed::text AS committed
         FROM reservation_lines rl JOIN budget_pools bp ON bp.pool_id = rl.pool_id ORDER BY bp.dimension`,
    );
    expect(lines).toEqual([
      { dimension: 'BATCH_COMPUTE_SECONDS', reserved: '600.00000000', committed: '600.00000000' },
      { dimension: 'PROVIDER_REQUESTS', reserved: '20.00000000', committed: '20.00000000' },
    ]);
    const ledger = await world.sql(`SELECT entry_kind, amount::text AS amount FROM usage_ledger ORDER BY ledger_id`);
    expect(ledger.map((row) => row.entry_kind)).toEqual(['RESERVE', 'RESERVE']);
    await world.drop();
  });

  it('puts the dispatch message in the outbox: a job-dispatch/1 for its attempt, with the retrieval request stored by digest', async () => {
    const world = await newWorld();
    const missionId = await createMission(world);
    const started = await startMission(world);
    const outbox = await world.sql<{ destination: string; status: string; message: Doc; message_digest: string }>(
      'SELECT destination, status, message, message_digest FROM outbox',
    );
    expect(outbox).toHaveLength(1);
    const entry = outbox[0] as { destination: string; status: string; message: Doc; message_digest: string };
    expect([entry.destination, entry.status]).toEqual(['BATCH_QUEUE', 'PENDING']);
    // The message is valid, names its attempt, and its digest is the one that the worker will claim with.
    expect(parseContract('job-dispatch', JSON.stringify(entry.message)).ok).toBe(true);
    expect(entry.message_digest).toBe(await digest(entry.message));
    expect(entry.message).toMatchObject({
      schema_version: 'job-dispatch/1',
      environment: 'DEVELOPMENT',
      job_id: started.jobId,
      attempt: { attempt_id: started.attemptId, ownership_revision: 1 },
      mission_id: missionId,
      dispatched_at: '2026-11-15T10:00:00Z',
      inputs: { kind: 'retrieve' },
    });
    const reference = entry.message.inputs.request;
    const stored = await world.testApp.objects.get(reference.digest);
    expect(stored?.length).toBe(reference.size_bytes);
    const request = JSON.parse(new TextDecoder().decode(stored as Uint8Array)) as Doc;
    expect(await digest(request)).toBe(reference.digest);
    expect(parseContract('retrieval-request', JSON.stringify(request)).ok).toBe(true);
    // The lead's fixture of a retrieval for this mission, with only the identities and the times of this run replaced.
    const expected = fixture('retrieval-request.aapl-mission.json');
    expected.job_id = started.jobId;
    expected.attempt = { attempt_id: started.attemptId, ownership_revision: 1 };
    expected.environment = 'DEVELOPMENT';
    expected.deadline = '2026-11-15T10:10:00Z';
    expect(request).toEqual(expected);
    await world.drop();
  });

  it('refuses a stale revision, a mission that is not CREATED, an unknown mission, and a budget that cannot hold the retrieval', async () => {
    const world = await newWorld();
    const missionId = await createMission(world);
    const stale = await world.apply(
      'researcher',
      { kind: 'run_mission_now', mission_id: missionId },
      { expectedRevision: 5 },
    );
    expect(refusal(stale).code).toBe('REVISION_CONFLICT');
    if (stale.state === 'REJECTED') expect(stale.failure.currentRevision).toBe(1);
    const unknown = await world.apply(
      'researcher',
      { kind: 'run_mission_now', mission_id: 'msn-nope' },
      { expectedRevision: 1 },
    );
    expect(refusal(unknown).code).toBe('NOT_FOUND');
    await startMission(world);
    const again = await world.apply(
      'researcher',
      { kind: 'run_mission_now', mission_id: missionId },
      { expectedRevision: 2 },
    );
    expect(refusal(again).code).toBe('REVISION_CONFLICT');
    expect(refusal(again).message).toContain('IN_PROGRESS');
    expect(await world.sql('SELECT 1 FROM jobs')).toHaveLength(1);
    // 500 batch seconds cannot hold the 600 seconds of a retrieval: refused, and the mission is still CREATED.
    const tight = await createMission(world, (m) => (m.budget.batch_compute_seconds = 500));
    const outcome = await world.apply(
      'researcher',
      { kind: 'run_mission_now', mission_id: tight },
      { expectedRevision: 1 },
    );
    expect(refusal(outcome).code).toBe('BUDGET_EXHAUSTED');
    expect(refusal(outcome).message).toContain('BATCH_COMPUTE_SECONDS');
    expect(await world.sql('SELECT status, revision FROM missions WHERE mission_id = $1', [tight])).toEqual([
      { status: 'CREATED', revision: 1 },
    ]);
    expect(await world.sql('SELECT 1 FROM jobs WHERE mission_id = $1', [tight])).toEqual([]);
    await world.drop();
  });

  it('is refused with EXECUTION_DISABLED while research execution is off, and records nothing', async () => {
    const world = await newWorld({ researchExecution: false });
    const missionId = await createMission(world);
    const before = await world.sql('SELECT count(*)::int AS n FROM commands');
    await expect(
      world.apply('researcher', { kind: 'run_mission_now', mission_id: missionId }, { expectedRevision: 1 }),
    ).rejects.toMatchObject({ code: 'EXECUTION_DISABLED' });
    expect(await world.sql('SELECT count(*)::int AS n FROM commands')).toEqual(before);
    expect(await world.sql('SELECT status FROM missions WHERE mission_id = $1', [missionId])).toEqual([
      { status: 'CREATED' },
    ]);
    await world.drop();
  });
});

describe('cancel_mission', () => {
  it('withdraws a CREATED mission with its reason and its actor', async () => {
    const world = await newWorld();
    const missionId = await createMission(world);
    const outcome = await world.apply(
      'researcher',
      { kind: 'cancel_mission', mission_id: missionId, reason: 'The provider probe failed.' },
      { expectedRevision: 1 },
    );
    expect(outcome.state).toBe('APPLIED');
    if (outcome.state === 'APPLIED') expect(outcome.status.record).toEqual({ id: missionId, revision: 2 });
    expect(
      await world.sql(
        'SELECT status, revision, withdrawn_by, withdrawn_reason, withdrawn_at IS NOT NULL AS dated FROM missions',
      ),
    ).toEqual([
      {
        status: 'WITHDRAWN',
        revision: 2,
        withdrawn_by: ids.researcher,
        withdrawn_reason: 'The provider probe failed.',
        dated: true,
      },
    ]);
    await world.drop();
  });

  it('cancels the open work of a started mission: attempt CANCELLED, reservation RELEASED, outbox CANCELLED, job CANCELLED', async () => {
    const world = await newWorld();
    const missionId = await createMission(world);
    const started = await startMission(world);
    const outcome = await world.apply(
      'researcher',
      { kind: 'cancel_mission', mission_id: missionId, reason: 'Stopped.' },
      { expectedRevision: started.revision },
    );
    expect(outcome.state).toBe('APPLIED');
    expect(await world.sql('SELECT status FROM missions')).toEqual([{ status: 'WITHDRAWN' }]);
    expect(await world.sql('SELECT status, completed_at IS NOT NULL AS ended FROM jobs')).toEqual([
      { status: 'CANCELLED', ended: true },
    ]);
    expect(await world.sql('SELECT status FROM attempts')).toEqual([{ status: 'CANCELLED' }]);
    expect(await world.sql('SELECT status FROM outbox')).toEqual([{ status: 'CANCELLED' }]);
    expect(await world.sql('SELECT status, released_at IS NOT NULL AS released FROM reservations')).toEqual([
      { status: 'RELEASED', released: true },
    ]);
    // Everything that the retrieval reserved is back in the mission's pools.
    const pools = await world.sql(
      `SELECT dimension, committed::text AS committed FROM budget_pools WHERE scope = 'MISSION' AND mission_id = $1 ORDER BY dimension, configuration_id NULLS FIRST`,
      [missionId],
    );
    expect(pools.every((pool) => pool.committed === '0.00000000')).toBe(true);
    // The period budget keeps the mission's allocation: no S1 command returns it (README, limits).
    expect(
      await world.sql(
        `SELECT committed::text AS committed FROM budget_pools WHERE scope = 'PERIOD' AND dimension = 'MODEL_SPEND'`,
      ),
    ).toEqual([{ committed: '105.00000000' }]);
    await world.drop();
  });

  it('refuses a stale revision, an unknown mission and a mission that is withdrawn already', async () => {
    const world = await newWorld();
    const missionId = await createMission(world);
    const stale = await world.apply(
      'researcher',
      { kind: 'cancel_mission', mission_id: missionId, reason: 'x' },
      { expectedRevision: 0 },
    );
    expect(refusal(stale).code).toBe('REVISION_CONFLICT');
    const unknown = await world.apply(
      'researcher',
      { kind: 'cancel_mission', mission_id: 'msn-nope', reason: 'x' },
      { expectedRevision: 1 },
    );
    expect(refusal(unknown).code).toBe('NOT_FOUND');
    await world.apply(
      'researcher',
      { kind: 'cancel_mission', mission_id: missionId, reason: 'x' },
      { expectedRevision: 1 },
    );
    const twice = await world.apply(
      'researcher',
      { kind: 'cancel_mission', mission_id: missionId, reason: 'x' },
      { expectedRevision: 2 },
    );
    expect(refusal(twice)).toMatchObject({ code: 'POLICY_VIOLATION' });
    await world.drop();
  });
});

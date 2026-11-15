// record_evaluation_decision and freeze_candidates (OQ-02 sections 3.3 and 4; decisions D20 and D25), on a real
// PostgreSQL. The workflows service principal applies both under the approved cohort policy. An APPROVED Decision writes
// the five development and validation runs of the candidate with their attempts, reservations and outbox entries in one
// transaction; a DEFERRED Decision writes none; freeze_candidates writes the holdout runs, or concludes the mission when
// no candidate is in EVALUATING. Evaluation requests are compared with the fixtures of the protocol manifest.

import { digest, parseContract } from '@openquant/api-contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type CommandOutcome, executeCommand } from '../src/commands/runner.ts';
import {
  assignFindingTreatments,
  blockingFindings,
  recordHoldoutConsumption,
  treatmentOf,
} from '../src/domain/findings.ts';
import { finishRuns } from './support/attempts.ts';
import { completedCritique, decide, decisionPayload, failedCritique, missionRevision } from './support/pipeline.ts';
import { ids, sha } from './support/seed.ts';
import {
  actorOf,
  createMission,
  createWorld,
  type Doc,
  fixture,
  plannedWorld,
  recordRelease,
  registerRecords,
  startMission,
  type World,
} from './support/world.ts';

function refusal(outcome: CommandOutcome): { code: string; message: string } {
  if (outcome.state !== 'REJECTED')
    throw new Error(`expected a refusal, got ${outcome.state}: ${JSON.stringify(outcome.status)}`);
  return outcome.status.error;
}

async function pipeline(
  options: { evaluateSeconds?: number; release?: boolean; versions?: string[]; mission?: (mission: Doc) => void } = {},
): Promise<World> {
  return plannedWorld(options);
}

describe('record_evaluation_decision: APPROVED', () => {
  let world: World;
  let outcome: CommandOutcome;
  let before: Record<string, string>;

  beforeAll(async () => {
    world = await pipeline();
    const critique = await completedCritique(world, 'rev-a');
    before = await world.snapshot();
    outcome = await decide(world, 'rev-a', 'APPROVED', critique);
  });
  afterAll(async () => {
    await world.drop();
  });

  it('applies and records the Decision with the policy, the approval, the Researcher and the critique', async () => {
    expect(outcome.state).toBe('APPLIED');
    const decisions = await world.sql(
      `SELECT kind, outcome, actor_id, actor_kind, policy_id, policy_revision, trial_slot, plan_digest, policy_approval_decision,
              mission_started_by, critique_status, critique_digest, reason FROM decisions WHERE kind = 'DRAFT_TO_EVALUATING'`,
    );
    expect(decisions).toEqual([
      {
        kind: 'DRAFT_TO_EVALUATING',
        outcome: 'APPROVED',
        actor_id: ids.workflows,
        actor_kind: 'SERVICE',
        policy_id: 's1-aapl-daily-swing',
        policy_revision: 1,
        trial_slot: 'rev-a',
        plan_digest: world.records.planDigest,
        policy_approval_decision: world.records.approvalId,
        mission_started_by: ids.researcher,
        critique_status: 'COMPLETED',
        critique_digest: sha('critique-rev-a'),
        reason: null,
      },
    ]);
    expect(
      await world.sql(`SELECT lifecycle FROM strategy_versions WHERE strategy_hash = $1`, [sha('version-rev-a')]),
    ).toEqual([{ lifecycle: 'EVALUATING' }]);
  });

  it('writes the development and validation runs of the candidate: two windows, base and stress, and the repeat', async () => {
    const runs = await world.sql(
      `SELECT run_slot, window_role, cost_scenario, status, attempt_cap, strategy_hash, plan_digest,
              (repeat_of_run IS NOT NULL) AS is_repeat
         FROM runs WHERE trial_slot = 'rev-a' ORDER BY run_slot`,
    );
    expect(runs.map((run) => run.run_slot)).toEqual([
      'rev-a.d.base',
      'rev-a.d.base.repeat',
      'rev-a.d.stress',
      'rev-a.v.base',
      'rev-a.v.stress',
    ]);
    for (const run of runs) {
      expect(run).toMatchObject({
        status: 'QUEUED',
        attempt_cap: 3,
        strategy_hash: sha('version-rev-a'),
        plan_digest: world.records.planDigest,
      });
    }
    expect(runs.filter((run) => run.is_repeat).map((run) => run.run_slot)).toEqual(['rev-a.d.base.repeat']);
    // No holdout run: only freeze_candidates writes those (OQ-02 section 3.3).
    expect(await world.sql(`SELECT 1 FROM runs WHERE window_role = 'HOLDOUT'`)).toEqual([]);
    const repeat = await world.sql(
      `SELECT r.run_slot AS repeat, o.run_slot AS original FROM runs r JOIN runs o ON o.run_id = r.repeat_of_run`,
    );
    expect(repeat).toEqual([{ repeat: 'rev-a.d.base.repeat', original: 'rev-a.d.base' }]);
  });

  it('gives each run its attempt, reservation, reservation line and outbox entry, and each attempt revision 1', async () => {
    const attempts = await world.sql(
      `SELECT a.ownership_revision, a.status, r.status AS reservation, o.status AS outbox, o.destination
         FROM runs u JOIN attempts a ON a.run_id = u.run_id
         JOIN reservations r ON r.attempt_id = a.attempt_id JOIN outbox o ON o.attempt_id = a.attempt_id
        WHERE u.trial_slot = 'rev-a'`,
    );
    expect(attempts).toHaveLength(5);
    for (const row of attempts) {
      expect(row).toEqual({
        ownership_revision: 1,
        status: 'PENDING',
        reservation: 'RESERVED',
        outbox: 'PENDING',
        destination: 'BATCH_QUEUE',
      });
    }
    // 600 seconds for the retrieval, whose attempt is still pending, and 5 x 300 for the runs: 2,100 of 7,200.
    expect(
      await world.sql(
        `SELECT committed::text AS committed FROM budget_pools WHERE mission_id = $1 AND dimension = 'BATCH_COMPUTE_SECONDS'`,
        [world.records.missionId],
      ),
    ).toEqual([{ committed: '2100.00000000' }]);
  });

  it('counts the Decision as a change of the mission: the revision grows by one', async () => {
    if (outcome.state !== 'APPLIED') throw new Error('not applied');
    expect(outcome.status.record).toEqual({ id: world.records.missionId, revision: 3 });
    expect(await missionRevision(world)).toBe(3);
  });

  it('changes nothing else: the other candidates are untouched and the audit row names the command', async () => {
    const after = await world.snapshot([
      'audit_events',
      'decisions',
      'runs',
      'attempts',
      'reservations',
      'reservation_lines',
      'outbox',
      'usage_ledger',
      'budget_pools',
      'strategy_versions',
      'missions',
      'artefacts',
    ]);
    const unchanged = Object.fromEntries(Object.entries(before).filter(([table]) => table in after));
    expect(after).toEqual(unchanged);
    const audit = await world.sql(`SELECT actor, subject FROM audit_events WHERE event_type = 'decision.recorded'`);
    expect(audit).toEqual([{ actor: ids.workflows, subject: world.records.missionId }]);
  });

  it('writes evaluation requests that equal the fixtures of the protocol manifest, for the validation run and the repeat', async () => {
    const requestOf = async (runSlot: string) => {
      const rows = await world.sql<{ message: Doc; run_id: string }>(
        `SELECT o.message, u.run_id FROM runs u JOIN attempts a ON a.run_id = u.run_id JOIN outbox o ON o.attempt_id = a.attempt_id WHERE u.run_slot = $1`,
        [runSlot],
      );
      const row = rows[0] as { message: Doc; run_id: string };
      expect(parseContract('job-dispatch', JSON.stringify(row.message)).ok).toBe(true);
      const reference = row.message.inputs.request;
      const bytes = (await world.testApp.objects.get(reference.digest)) as Uint8Array;
      expect(bytes.length).toBe(reference.size_bytes);
      const request = JSON.parse(new TextDecoder().decode(bytes)) as Doc;
      expect(await digest(request)).toBe(reference.digest);
      expect(parseContract('evaluation-request', JSON.stringify(request)).ok).toBe(true);
      return { request, runId: row.run_id, message: row.message };
    };
    const validation = await requestOf('rev-a.v.base');
    const expectedValidation = fixture('evaluation-request.backtest.json');
    expectedValidation.run_id = validation.runId;
    expectedValidation.attempt = { attempt_id: validation.message.attempt.attempt_id, ownership_revision: 1 };
    expectedValidation.mission_id = world.records.missionId;
    expectedValidation.environment = 'DEVELOPMENT';
    expectedValidation.strategy.artefact.digest = sha('version-rev-a');
    expectedValidation.conditions.plan_digest = world.records.planDigest;
    // The pipeline registers the pilot policy with 300-second evaluate attempts: its digest is not the fixture's.
    expectedValidation.conditions.cohort_policy = world.records.policy;
    expect(validation.request).toEqual(expectedValidation);

    const original = await requestOf('rev-a.d.base');
    const repeat = await requestOf('rev-a.d.base.repeat');
    const expectedRepeat = fixture('evaluation-request.deterministic-repeat.json');
    expectedRepeat.run_id = repeat.runId;
    expectedRepeat.attempt = { attempt_id: repeat.message.attempt.attempt_id, ownership_revision: 1 };
    expectedRepeat.mission_id = world.records.missionId;
    expectedRepeat.environment = 'DEVELOPMENT';
    expectedRepeat.strategy.artefact.digest = sha('version-rev-a');
    expectedRepeat.conditions.plan_digest = world.records.planDigest;
    expectedRepeat.conditions.cohort_policy = world.records.policy;
    // The repeat names the run whose result it must reproduce.
    expectedRepeat.conditions.replay_of = original.runId;
    expect(repeat.request).toEqual(expectedRepeat);
  });

  it('doubles every cost parameter of the stress run and no other value: fee 5 to 10 bps, gap slippage 10 to 20, fixed fee 0', async () => {
    const rows = await world.sql<{ message: Doc }>(
      `SELECT o.message FROM runs u JOIN attempts a ON a.run_id = u.run_id JOIN outbox o ON o.attempt_id = a.attempt_id WHERE u.run_slot = 'rev-a.d.stress'`,
    );
    const reference = (rows[0] as { message: Doc }).message.inputs.request;
    const request = JSON.parse(
      new TextDecoder().decode((await world.testApp.objects.get(reference.digest)) as Uint8Array),
    ) as Doc;
    expect(request.input.policy.cost_model).toEqual({
      id: 'fixed_plus_bps@1',
      fixed_fee_per_fill: '0.00',
      fee_bps: '10',
      gap_exit_slippage_bps: '20',
    });
    expect(request.conditions).toMatchObject({
      window_role: 'DEVELOPMENT',
      cost_scenario: 'COST_STRESS',
      run_slot: 'rev-a.d.stress',
    });
    // Everything else of the policy is the base policy of the cohort.
    const base = fixture('cohort-policy.s1-pilot.json').conditions.execution_policy;
    expect({ ...request.input.policy, cost_model: undefined }).toEqual({ ...base, cost_model: undefined });
    // The development window has the holdout withheld and nothing else (the fixtures do the same).
    expect(request.holdout_exclusions).toHaveLength(1);
    expect(request.holdout_exclusions[0].window).toBe('HOLDOUT');
  });
});

describe('record_evaluation_decision: DEFERRED', () => {
  it('writes no run, no reservation and no outbox entry, and the slot ends with the reason', async () => {
    const world = await pipeline();
    const critique = await failedCritique(world, 'rev-b', 'refusal', 1);
    const before = await world.snapshot(['audit_events', 'decisions', 'trial_slots', 'missions', 'commands']);
    const outcome = await decide(world, 'rev-b', 'DEFERRED', critique);
    expect(outcome.state).toBe('APPLIED');
    const after = await world.snapshot(['audit_events', 'decisions', 'trial_slots', 'missions', 'commands']);
    expect(after).toEqual(before);
    expect(await world.sql('SELECT 1 FROM runs')).toEqual([]);
    const decision = await world.sql(
      `SELECT outcome, critique_status, critique_digest, reason FROM decisions WHERE kind = 'DRAFT_TO_EVALUATING'`,
    );
    expect(decision).toEqual([
      {
        outcome: 'DEFERRED',
        critique_status: 'NO_VALID_RESULT',
        critique_digest: null,
        reason:
          'The critique ended without a valid result: refusal after 1 attempt(s). The candidate is not evaluated.',
      },
    ]);
    expect(await world.sql(`SELECT terminal_reason FROM trial_slots WHERE trial_slot = 'rev-b'`)).toEqual([
      { terminal_reason: 'DECISION_DEFERRED' },
    ]);
    expect(
      await world.sql(`SELECT lifecycle FROM strategy_versions WHERE strategy_hash = $1`, [sha('version-rev-b')]),
    ).toEqual([{ lifecycle: 'DRAFT' }]);
    await world.drop();
  });

  it('after a retried outcome waits for the cap: a timeout is DEFERRED only once the third attempt of three has ended', async () => {
    const world = await pipeline();
    // Two timeouts: the job retries and is still QUEUED with a third attempt: it has not ended.
    const early = await failedCritique(world, 'rev-a', 'timeout', 2);
    const tooSoon = await decide(world, 'rev-a', 'DEFERRED', early);
    expect(refusal(tooSoon).code).toBe('POLICY_VIOLATION');
    expect(refusal(tooSoon).message).toContain('3 attempts of the cap');
    const exhausted = await failedCritique(world, 'rev-a', 'timeout', 3);
    const outcome = await decide(world, 'rev-a', 'DEFERRED', exhausted);
    expect(outcome.state).toBe('APPLIED');
    await world.drop();
  });

  it('is checked against the critique job: another outcome or another attempt count than the job recorded is refused', async () => {
    const world = await pipeline();
    await failedCritique(world, 'rev-a', 'refusal', 1);
    const wrongOutcome = await decide(world, 'rev-a', 'DEFERRED', {
      status: 'NO_VALID_RESULT',
      outcome: 'denied_capability',
      attempts: 1,
    });
    expect(refusal(wrongOutcome).message).toContain('not what the critique job recorded');
    const wrongCount = await decide(world, 'rev-a', 'DEFERRED', {
      status: 'NO_VALID_RESULT',
      outcome: 'refusal',
      attempts: 2,
    });
    expect(refusal(wrongCount).message).toContain('not what the critique job recorded');
    const noJob = await decide(world, 'rev-b', 'DEFERRED', {
      status: 'NO_VALID_RESULT',
      outcome: 'refusal',
      attempts: 1,
    });
    expect(refusal(noJob).message).toContain('No critique job');
    await world.drop();
  });

  it('cannot be combined with a completed critique, and APPROVED cannot be recorded without one; REJECTED is not recordable in S1', async () => {
    const world = await pipeline();
    const completed = await completedCritique(world, 'rev-a');
    const deferred = await decide(world, 'rev-a', 'DEFERRED', completed);
    expect(refusal(deferred).message).toContain('APPROVED Decision');
    const missing = await failedCritique(world, 'rev-b', 'refusal', 1);
    const approved = await decide(world, 'rev-b', 'APPROVED', missing);
    expect(refusal(approved).message).toContain('DEFERRED');
    const rejected = await decide(world, 'rev-a', 'APPROVED', completed, (payload) => (payload.outcome = 'REJECTED'));
    expect(refusal(rejected).message).toContain('REJECTED Decision cannot be recorded');
    expect(await world.sql('SELECT 1 FROM decisions WHERE kind = $1', ['DRAFT_TO_EVALUATING'])).toEqual([]);
    await world.drop();
  });
});

describe('record_evaluation_decision: what is checked first', () => {
  it('refuses every binding that does not hold, and each refusal leaves the Decision unwritten', async () => {
    const world = await pipeline();
    const critique = await completedCritique(world, 'rev-a');
    const cases: [string, (payload: Doc) => void, string, string][] = [
      ['an unknown plan digest', (p) => (p.plan_digest = sha('another-plan')), 'IDENTITY_MISMATCH', 'plan digest'],
      ['an unknown slot', (p) => (p.trial_slot = 'rev-z'), 'NOT_FOUND', 'rev-z'],
      [
        'a cohort policy of another digest',
        (p) => (p.authority.cohort_policy.digest = sha('policy')),
        'IDENTITY_MISMATCH',
        'another cohort policy',
      ],
      [
        'another Researcher than the one who started the mission',
        (p) => (p.authority.mission_started_by = ids.viewer),
        'IDENTITY_MISMATCH',
        'another Researcher',
      ],
      [
        'an approval that does not exist',
        (p) => (p.authority.policy_approval = 'dec-none'),
        'POLICY_VIOLATION',
        'approval',
      ],
      [
        'a strategy that is not the registered version of the slot',
        (p) => (p.strategy_hash = sha('version-rev-b')),
        'POLICY_VIOLATION',
        'registered version',
      ],
      [
        'a critique attempt that is not a critic attempt of this slot',
        (p) => (p.critique = { ...critique, attempt_id: 'att-nope' }),
        'POLICY_VIOLATION',
        'completed critic attempt',
      ],
      [
        'a critique result that is not a recorded artefact of this size',
        (p) => (p.critique = { ...critique, result: { ...critique.result, size_bytes: 1 } }),
        'IDENTITY_MISMATCH',
        'recorded artefact',
      ],
    ];
    for (const [label, edit, code, text] of cases) {
      const outcome = await decide(world, 'rev-a', 'APPROVED', critique, edit);
      expect(refusal(outcome).code, label).toBe(code);
      expect(refusal(outcome).message, label).toContain(text);
    }
    expect(await world.sql('SELECT 1 FROM decisions WHERE kind = $1', ['DRAFT_TO_EVALUATING'])).toEqual([]);
    expect(await world.sql('SELECT 1 FROM runs')).toEqual([]);
    // A stale revision is refused with the revision that is current.
    const stale = await world.apply(
      'workflows',
      decisionPayload(world, 'rev-a', sha('version-rev-a'), critique, 'APPROVED'),
      { expectedRevision: 1 },
    );
    expect(refusal(stale).code).toBe('REVISION_CONFLICT');
    if (stale.state === 'REJECTED') expect(stale.failure.currentRevision).toBe(await missionRevision(world));
    await world.drop();
  });

  it('refuses a second Decision for a slot, and a critique that belongs to another slot', async () => {
    const world = await pipeline();
    const critique = await completedCritique(world, 'rev-a');
    expect((await decide(world, 'rev-a', 'APPROVED', critique)).state).toBe('APPLIED');
    const again = await decide(world, 'rev-a', 'APPROVED', critique);
    expect(refusal(again).message).toContain('has its Decision already');
    const crossed = await decide(world, 'rev-b', 'APPROVED', critique);
    expect(refusal(crossed).code).toBe('POLICY_VIOLATION');
    expect(refusal(crossed).message).toContain('completed critic attempt of this trial slot');
    await world.drop();
  });

  it('needs an evaluation plan, a dataset snapshot, and a recorded release identity', async () => {
    const early = await createWorld();
    await registerRecords(early);
    await createMission(early);
    await startMission(early);
    const noPlan = await early.apply(
      'workflows',
      {
        ...decisionPayload(
          early,
          'seed',
          sha('x'),
          { status: 'NO_VALID_RESULT', outcome: 'refusal', attempts: 1 },
          'DEFERRED',
        ),
        plan_digest: sha('plan'),
      },
      { expectedRevision: 2 },
    );
    expect(refusal(noPlan).message).toContain('No evaluation plan');
    await early.drop();

    // Without a release identity the request cannot name the engine and method. That is a state of the deployment,
    // not a decision: the command stays PENDING, and the same command ID applies once the release is recorded.
    const world = await pipeline({ release: false });
    const critique = await completedCritique(world, 'rev-a');
    const payload = decisionPayload(world, 'rev-a', sha('version-rev-a'), critique, 'APPROVED');
    const request = world.command(payload, {
      expectedRevision: await missionRevision(world),
      commandId: 'cmd-wait-for-release',
    });
    const run = {
      env: world.testApp.env,
      db: world.testApp.env.database(),
      actor: actorOf('workflows'),
      builders: world.builders,
    };
    await expect(executeCommand(run, request as never)).rejects.toMatchObject({ code: 'EXECUTION_DISABLED' });
    expect(await world.sql('SELECT state FROM commands WHERE command_id = $1', ['cmd-wait-for-release'])).toEqual([
      { state: 'PENDING' },
    ]);
    expect(await world.sql('SELECT 1 FROM runs')).toEqual([]);
    await recordRelease(world);
    const replay = await executeCommand(run, request as never);
    expect(replay.state).toBe('APPLIED');
    expect(await world.sql('SELECT 1 FROM runs')).toHaveLength(5);
    await run.db.close();
    await world.drop();
  });
});

describe('record_evaluation_decision: budgets that run out', () => {
  it('with the proposed 600-second evaluation timeout the third candidate cannot be reserved: BLOCKED, nothing written', async () => {
    // The pilot proposes 600 seconds per evaluate attempt and 7,200 batch seconds per mission. Reserved up front,
    // 600 (retrieval) + 3 x 5 x 600 = 9,600 does not fit: two candidates fit (600 + 2 x 3,000 = 6,600), the third does not.
    const world = await pipeline({ evaluateSeconds: 600 });
    for (const slot of ['seed', 'rev-a']) {
      const critique = await completedCritique(world, slot);
      expect((await decide(world, slot, 'APPROVED', critique)).state).toBe('APPLIED');
    }
    expect(
      await world.sql(
        `SELECT committed::text AS committed FROM budget_pools WHERE mission_id = $1 AND dimension = 'BATCH_COMPUTE_SECONDS'`,
        [world.records.missionId],
      ),
    ).toEqual([{ committed: '6600.00000000' }]);
    const critique = await completedCritique(world, 'rev-b');
    const before = await world.snapshot(['audit_events', 'missions', 'commands']);
    const outcome = await decide(world, 'rev-b', 'APPROVED', critique);
    expect(refusal(outcome).code).toBe('BUDGET_EXHAUSTED');
    expect(refusal(outcome).message).toContain('BATCH_COMPUTE_SECONDS');
    // No run, attempt, reservation, outbox row or Decision of the third candidate; its version is still a DRAFT.
    expect(await world.snapshot(['audit_events', 'missions', 'commands'])).toEqual(before);
    expect(
      await world.sql(`SELECT lifecycle FROM strategy_versions WHERE strategy_hash = $1`, [sha('version-rev-b')]),
    ).toEqual([{ lifecycle: 'DRAFT' }]);
    // The mission is BLOCKED with the reason, in the same transaction as the refusal.
    const mission = await world.sql<{ status: string; blocked_reason: string }>(
      'SELECT status, blocked_reason FROM missions WHERE mission_id = $1',
      [world.records.missionId],
    );
    expect(mission[0]?.status).toBe('BLOCKED');
    expect(mission[0]?.blocked_reason).toContain('rev-b cannot be reserved');
    // From BLOCKED the only way out is withdrawal: every other command is refused with the reason.
    const next = await decide(world, 'rev-b', 'APPROVED', critique);
    expect(refusal(next).code).toBe('BUDGET_EXHAUSTED');
    expect(refusal(next).message).toContain('BLOCKED');
    const cancelled = await world.apply(
      'researcher',
      { kind: 'cancel_mission', mission_id: world.records.missionId, reason: 'The budget is exhausted.' },
      { expectedRevision: await missionRevision(world) },
    );
    expect(cancelled.state).toBe('APPLIED');
    expect(await world.sql('SELECT status FROM missions')).toEqual([{ status: 'WITHDRAWN' }]);
    await world.drop();
  });

  it('refuses the candidate beyond the candidates budget and the runs beyond the experiments budget, and blocks the mission', async () => {
    const few = await pipeline({ mission: (mission) => (mission.budget.candidates = 1) });
    const first = await completedCritique(few, 'seed');
    expect((await decide(few, 'seed', 'APPROVED', first)).state).toBe('APPLIED');
    const second = await completedCritique(few, 'rev-a');
    const over = await decide(few, 'rev-a', 'APPROVED', second);
    expect(refusal(over).code).toBe('BUDGET_EXHAUSTED');
    expect(refusal(over).message).toContain('may evaluate 1 candidates');
    expect(await few.sql('SELECT status FROM missions')).toEqual([{ status: 'BLOCKED' }]);
    await few.drop();

    const small = await pipeline({ mission: (mission) => (mission.budget.experiments = 4) });
    const critique = await completedCritique(small, 'seed');
    const outcome = await decide(small, 'seed', 'APPROVED', critique);
    expect(refusal(outcome).code).toBe('BUDGET_EXHAUSTED');
    expect(refusal(outcome).message).toContain('0 of 4 experiments and 5 more are planned');
    expect(await small.sql('SELECT status FROM missions')).toEqual([{ status: 'BLOCKED' }]);
    expect(await small.sql('SELECT 1 FROM runs')).toEqual([]);
    await small.drop();
  });
});

describe('freeze_candidates', () => {
  async function evaluated(world: World, slots: string[]) {
    for (const slot of slots) {
      const critique = await completedCritique(world, slot);
      expect((await decide(world, slot, 'APPROVED', critique)).state, slot).toBe('APPLIED');
      expect(await finishRuns(world, slot)).toBe(5);
    }
  }

  function freezePayload(world: World, slots: Doc[]): Doc {
    return {
      kind: 'freeze_candidates',
      mission_id: world.records.missionId,
      plan_digest: world.records.planDigest,
      slots,
    };
  }

  it('writes the holdout runs of every candidate in EVALUATING with their reservations and outbox entries, and nothing for the others', async () => {
    const world = await pipeline();
    await evaluated(world, ['seed', 'rev-a']);
    const deferred = await failedCritique(world, 'rev-b', 'refusal', 1);
    expect((await decide(world, 'rev-b', 'DEFERRED', deferred)).state).toBe('APPLIED');
    const revision = await missionRevision(world);
    const outcome = await world.apply(
      'workflows',
      freezePayload(world, [
        { trial_slot: 'seed', status: 'EVALUATING', strategy_hash: world.records.seedDigest },
        { trial_slot: 'rev-a', status: 'EVALUATING', strategy_hash: sha('version-rev-a') },
        { trial_slot: 'rev-b', status: 'NOT_EVALUATED', reason: 'DECISION_DEFERRED' },
      ]),
      { expectedRevision: revision },
    );
    expect(outcome.state).toBe('APPLIED');
    if (outcome.state === 'APPLIED')
      expect(outcome.status.record).toEqual({ id: world.records.missionId, revision: revision + 1 });
    const holdout = await world.sql(
      `SELECT trial_slot, run_slot, cost_scenario, status FROM runs WHERE window_role = 'HOLDOUT' ORDER BY run_slot`,
    );
    expect(holdout).toEqual([
      { trial_slot: 'rev-a', run_slot: 'rev-a.h.base', cost_scenario: 'BASE', status: 'QUEUED' },
      { trial_slot: 'rev-a', run_slot: 'rev-a.h.stress', cost_scenario: 'COST_STRESS', status: 'QUEUED' },
      { trial_slot: 'seed', run_slot: 'seed.h.base', cost_scenario: 'BASE', status: 'QUEUED' },
      { trial_slot: 'seed', run_slot: 'seed.h.stress', cost_scenario: 'COST_STRESS', status: 'QUEUED' },
    ]);
    // Each holdout run has an attempt, a reservation and an outbox entry; the deferred slot has no run at all.
    expect(
      await world.sql(
        `SELECT count(*)::int AS n FROM runs u JOIN attempts a ON a.run_id = u.run_id JOIN reservations r ON r.attempt_id = a.attempt_id JOIN outbox o ON o.attempt_id = a.attempt_id WHERE u.window_role = 'HOLDOUT' AND a.status = 'PENDING'`,
      ),
    ).toEqual([{ n: 4 }]);
    expect(await world.sql(`SELECT 1 FROM runs WHERE trial_slot = 'rev-b'`)).toEqual([]);
    expect(await world.sql(`SELECT status FROM missions`)).toEqual([{ status: 'IN_PROGRESS' }]);
    await world.drop();
  });

  it('runs when the seed was not evaluated: it writes no run, the revision slots end SEED_NOT_EVALUATED, the mission concludes NO_ELIGIBLE_CANDIDATE', async () => {
    const world = await pipeline();
    const deferred = await failedCritique(world, 'seed', 'refusal', 1);
    expect((await decide(world, 'seed', 'DEFERRED', deferred)).state).toBe('APPLIED');
    const revision = await missionRevision(world);
    const outcome = await world.apply(
      'workflows',
      freezePayload(world, [
        { trial_slot: 'seed', status: 'NOT_EVALUATED', reason: 'DECISION_DEFERRED' },
        { trial_slot: 'rev-a', status: 'NOT_EVALUATED', reason: 'SEED_NOT_EVALUATED' },
        { trial_slot: 'rev-b', status: 'NOT_EVALUATED', reason: 'SEED_NOT_EVALUATED' },
      ]),
      { expectedRevision: revision },
    );
    expect(outcome.state).toBe('APPLIED');
    expect(await world.sql('SELECT 1 FROM runs')).toEqual([]);
    expect(await world.sql('SELECT trial_slot, terminal_reason FROM trial_slots ORDER BY trial_slot')).toEqual([
      { trial_slot: 'rev-a', terminal_reason: 'SEED_NOT_EVALUATED' },
      { trial_slot: 'rev-b', terminal_reason: 'SEED_NOT_EVALUATED' },
      { trial_slot: 'seed', terminal_reason: 'DECISION_DEFERRED' },
    ]);
    const mission = await world.sql(
      `SELECT status, outcome, outcome_reason, concluded_at IS NOT NULL AS concluded FROM missions`,
    );
    expect(mission).toEqual([
      {
        status: 'CONCLUDED',
        outcome: 'NO_ELIGIBLE_CANDIDATE',
        outcome_reason:
          'No candidate is in EVALUATING (seed: DECISION_DEFERRED; rev-a: SEED_NOT_EVALUATED; rev-b: SEED_NOT_EVALUATED).',
        concluded: true,
      },
    ]);
    expect(await world.sql('SELECT outcome, slot_reasons FROM mission_outcomes')).toEqual([
      {
        outcome: 'NO_ELIGIBLE_CANDIDATE',
        slot_reasons: [
          { trial_slot: 'seed', reason: 'DECISION_DEFERRED' },
          { trial_slot: 'rev-a', reason: 'SEED_NOT_EVALUATED' },
          { trial_slot: 'rev-b', reason: 'SEED_NOT_EVALUATED' },
        ],
      },
    ]);
    await world.drop();
  });

  it('refuses a freeze that does not list every slot once, that names a slot with open runs, or whose reasons are not what the records show', async () => {
    const world = await pipeline();
    const critique = await completedCritique(world, 'seed');
    expect((await decide(world, 'seed', 'APPROVED', critique)).state).toBe('APPLIED');
    const seedSlot = { trial_slot: 'seed', status: 'EVALUATING', strategy_hash: world.records.seedDigest };
    const revisions = [
      { trial_slot: 'rev-a', status: 'NOT_EVALUATED', reason: 'NO_REGISTERED_VERSION' },
      { trial_slot: 'rev-b', status: 'NOT_EVALUATED', reason: 'NO_REGISTERED_VERSION' },
    ];
    const attempt = async (slots: Doc[]) =>
      refusal(
        await world.apply('workflows', freezePayload(world, slots), { expectedRevision: await missionRevision(world) }),
      );
    expect((await attempt([seedSlot])).message).toContain('not every trial slot');
    expect((await attempt([seedSlot, seedSlot, ...revisions])).message).toContain('not every trial slot');
    // The seed's runs have not ended: its slot is not terminal.
    expect((await attempt([seedSlot, ...revisions])).message).toContain('not terminal');
    await finishRuns(world, 'seed');
    // Both revision slots have a registered version, so NO_REGISTERED_VERSION is not what the records show.
    expect((await attempt([seedSlot, ...revisions])).message).toContain('NO_REGISTERED_VERSION');
    expect(
      (
        await attempt([
          seedSlot,
          { trial_slot: 'rev-a', status: 'NOT_EVALUATED', reason: 'SEED_NOT_EVALUATED' },
          revisions[1] as Doc,
        ])
      ).message,
    ).toContain('SEED_NOT_EVALUATED');
    expect(
      (
        await attempt([
          seedSlot,
          { trial_slot: 'rev-a', status: 'NOT_EVALUATED', reason: 'DECISION_DEFERRED' },
          revisions[1] as Doc,
        ])
      ).message,
    ).toContain('DECISION_DEFERRED');
    expect((await attempt([{ ...seedSlot, strategy_hash: sha('version-rev-a') }, ...revisions])).message).toContain(
      'no APPROVED Decision for this strategy',
    );
    expect(await world.sql(`SELECT 1 FROM runs WHERE window_role = 'HOLDOUT'`)).toEqual([]);
    await world.drop();
  });

  it('cannot freeze twice: the second freeze finds the holdout runs', async () => {
    const world = await pipeline({ versions: ['seed'] });
    await evaluated(world, ['seed']);
    const slots = [
      { trial_slot: 'seed', status: 'EVALUATING', strategy_hash: world.records.seedDigest },
      { trial_slot: 'rev-a', status: 'NOT_EVALUATED', reason: 'NO_REGISTERED_VERSION' },
      { trial_slot: 'rev-b', status: 'NOT_EVALUATED', reason: 'NO_REGISTERED_VERSION' },
    ];
    expect(
      (await world.apply('workflows', freezePayload(world, slots), { expectedRevision: await missionRevision(world) }))
        .state,
    ).toBe('APPLIED');
    const again = await world.apply('workflows', freezePayload(world, slots), {
      expectedRevision: await missionRevision(world),
    });
    expect(refusal(again).message).toContain('frozen already');
    await world.drop();
  });
});

describe('finding treatment and holdout consumption', () => {
  it('assigns the treatment of the registered policy to each finding for each transition, and never lets a critic set it', async () => {
    const world = await pipeline();
    const policy = { id: world.records.policy.id, revision: 1, document: world.docs.policy as never };
    // The findings table references attempts: write the critic attempt first, then the findings that it produced.
    const critique = await completedCritique(world, 'rev-a');
    const insert = `INSERT INTO findings (finding_id, mission_id, strategy_hash, attempt_id, critique_digest, ordinal, category, finding_source, affects_executable_rule, required_evidence, recorded_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'model_judgement', $8, false, '2026-11-15T10:00:00Z')`;
    const rows: [string, string, boolean][] = [
      ['f-quality', 'data_quality_alignment', false],
      ['f-hypothesis', 'hypothesis_assumption', true],
      ['f-advice', 'method_advice', false],
    ];
    for (const [index, [id, category, affects]] of rows.entries()) {
      await world.sql(insert, [
        id,
        world.records.missionId,
        sha('version-rev-a'),
        critique.attempt_id,
        critique.result.digest,
        index + 1,
        category,
        affects,
      ]);
    }
    const written = await world.tx((tx) =>
      assignFindingTreatments(tx, world.testApp.env, world.records.missionId as string, sha('version-rev-a'), policy),
    );
    expect(written).toBe(6);
    const treatments = await world.sql(
      `SELECT finding_id, transition, treatment FROM finding_treatments ORDER BY finding_id, transition`,
    );
    // The pilot policy: data_quality_alignment blocks EVALUATING to PAPER only; hypothesis and advice are advisory.
    expect(treatments).toEqual([
      { finding_id: 'f-advice', transition: 'DRAFT_TO_EVALUATING', treatment: 'ADVISORY' },
      { finding_id: 'f-advice', transition: 'EVALUATING_TO_PAPER', treatment: 'ADVISORY' },
      { finding_id: 'f-hypothesis', transition: 'DRAFT_TO_EVALUATING', treatment: 'ADVISORY' },
      { finding_id: 'f-hypothesis', transition: 'EVALUATING_TO_PAPER', treatment: 'ADVISORY' },
      { finding_id: 'f-quality', transition: 'DRAFT_TO_EVALUATING', treatment: 'ADVISORY' },
      { finding_id: 'f-quality', transition: 'EVALUATING_TO_PAPER', treatment: 'BLOCKING' },
    ]);
    // Idempotent, and in S1 nothing blocks DRAFT to EVALUATING while one finding blocks EVALUATING to PAPER.
    expect(
      await world.tx((tx) =>
        assignFindingTreatments(tx, world.testApp.env, world.records.missionId as string, sha('version-rev-a'), policy),
      ),
    ).toBe(0);
    expect(
      await world.tx((tx) =>
        blockingFindings(tx, world.records.missionId as string, sha('version-rev-a'), 'DRAFT_TO_EVALUATING'),
      ),
    ).toEqual([]);
    expect(
      await world.tx((tx) =>
        blockingFindings(tx, world.records.missionId as string, sha('version-rev-a'), 'EVALUATING_TO_PAPER'),
      ),
    ).toEqual(['f-quality']);
    // The Decision is APPROVED all the same: the blocking finding concerns the transition to PAPER.
    expect((await decide(world, 'rev-a', 'APPROVED', critique)).state).toBe('APPLIED');
    await world.drop();
  });

  it('escalates a finding when an escalate_when condition of its row holds', () => {
    const policy = structuredClone(fixture('cohort-policy.s1-pilot.json')) as Doc;
    const row = policy.finding_treatment.find(
      (entry: Doc) => entry.category === 'portfolio_fit' && entry.transition === 'EVALUATING_TO_PAPER',
    );
    row.escalate_when = ['affects_executable_rule', 'required_evidence'];
    const plain = { category: 'portfolio_fit', affects_executable_rule: false, required_evidence: false };
    expect(treatmentOf(policy as never, plain, 'EVALUATING_TO_PAPER')).toBe('ADVISORY');
    expect(treatmentOf(policy as never, { ...plain, affects_executable_rule: true }, 'EVALUATING_TO_PAPER')).toBe(
      'BLOCKING',
    );
    expect(treatmentOf(policy as never, { ...plain, required_evidence: true }, 'EVALUATING_TO_PAPER')).toBe('BLOCKING');
    expect(treatmentOf(policy as never, { ...plain, affects_executable_rule: true }, 'DRAFT_TO_EVALUATING')).toBe(
      'ADVISORY',
    );
    expect(() => treatmentOf({ ...policy, finding_treatment: [] } as never, plain, 'EVALUATING_TO_PAPER')).toThrow(
      /no treatment/,
    );
  });

  it('records the consumption of a holdout run once, never for another window, and keeps it', async () => {
    const world = await pipeline();
    const now = world.testApp.env;
    // A holdout run exists only after freeze_candidates; here one is written directly to test the record itself.
    await world.sql(
      `INSERT INTO runs (run_id, mode, mission_id, run_slot, trial_slot, window_role, cost_scenario, plan_digest, strategy_hash, attempt_cap, created_at)
       VALUES ('run-h', 'BACKTEST', $1, 'seed.h.base', 'seed', 'HOLDOUT', 'BASE', $2, $3, 3, '2026-11-15T10:00:00Z'),
              ('run-d', 'BACKTEST', $1, 'seed.d.base', 'seed', 'DEVELOPMENT', 'BASE', $2, $3, 3, '2026-11-15T10:00:00Z')`,
      [world.records.missionId, world.records.planDigest, world.records.seedDigest],
    );
    expect(await world.tx((tx) => recordHoldoutConsumption(tx, now, 'run-h', ids.researcher))).toBe(true);
    expect(await world.tx((tx) => recordHoldoutConsumption(tx, now, 'run-h', ids.researcher))).toBe(false);
    expect(await world.sql('SELECT run_id, revealed_by FROM holdout_consumption')).toEqual([
      { run_id: 'run-h', revealed_by: ids.researcher },
    ]);
    await expect(world.tx((tx) => recordHoldoutConsumption(tx, now, 'run-d', ids.researcher))).rejects.toThrow(
      /not a holdout run/,
    );
    await expect(world.tx((tx) => recordHoldoutConsumption(tx, now, 'run-none', ids.researcher))).rejects.toThrow(
      /does not exist/,
    );
    // The record is never removed or changed (migration 0006): consumption cannot be relabelled untouched.
    await expect(world.sql('DELETE FROM holdout_consumption')).rejects.toMatchObject({ code: '23514' });
    await world.drop();
  });
});

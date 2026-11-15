// One transaction for each guarded command (OQ-05 section 4: "each durable write in the table is one transaction with its
// audit record"; OQ-02 section 8). For each command that writes more than one row, a failure is injected after every
// write in turn, in the order that the command makes them, and after each failure the database must hold exactly what
// it held before: no run without its attempt, no reservation without its pool update, no audit row without its change,
// no half-applied Decision. The command stays PENDING and the next try, with the same command ID, goes on from there.
// The loop ends when a try makes fewer writes than the failure point: that try applies the command, and the test
// checks what it wrote. A write is an INSERT, UPDATE or DELETE statement of the application.

import { afterAll, describe, expect, it } from 'vitest';
import { type CommandOutcome, executeCommand } from '../src/commands/runner.ts';
import type { Database, Queryable } from '../src/db/database.ts';
import { claim, finishRuns } from './support/attempts.ts';
import { completedCritique, decide, decisionPayload, failedCritique, missionRevision } from './support/pipeline.ts';
import { sha } from './support/seed.ts';
import {
  type ActorName,
  actorOf,
  createMission,
  createWorld,
  type Doc,
  missionPayload,
  plannedWorld,
  registerRecords,
  type World,
} from './support/world.ts';

class InjectedFailure extends Error {
  constructor(write: number) {
    super(`injected failure after write ${write}`);
    this.name = 'InjectedFailure';
  }
}

const WRITE = /^\s*(insert|update|delete)\b/i;

/** A database that throws after its k-th write statement, counted over every transaction of one call. */
function failingAfter(db: Database, k: number) {
  let writes = 0;
  let fired = false;
  const wrap = (inner: Queryable): Queryable => ({
    query: (async (text: string, values?: readonly unknown[]) => {
      const result = await inner.query(text, values);
      if (WRITE.test(text)) {
        writes += 1;
        if (writes === k) {
          fired = true;
          throw new InjectedFailure(k);
        }
      }
      return result;
    }) as Queryable['query'],
  });
  const faulty: Database = {
    query: wrap(db).query,
    transaction: (work) => db.transaction((tx) => work(wrap(tx))),
    close: () => db.close(),
  };
  return { db: faulty, fired: () => fired };
}

interface Scenario {
  readonly world: World;
  readonly who: ActorName;
  readonly request: Doc;
  /** How the command ends when nothing fails. */
  readonly ends: 'APPLIED' | 'REJECTED';
}

const worlds: World[] = [];
afterAll(async () => {
  await Promise.all(worlds.map((world) => world.drop()));
});

/** Failure after every write, then the success. Returns how many writes the command makes in one try. */
async function afterEveryWrite(scenario: Scenario, label: string): Promise<number> {
  const { world, who, request, ends } = scenario;
  worlds.push(world);
  const baseline = await world.snapshot();
  const commandId = request.command_id as string;
  let outcome: CommandOutcome | undefined;
  let k = 1;
  for (; k <= 600; k += 1) {
    const faulty = failingAfter(world.testApp.env.database(), k);
    outcome = undefined;
    try {
      outcome = await executeCommand(
        { env: world.testApp.env, db: faulty.db, actor: actorOf(who), builders: world.builders },
        request as never,
      );
    } catch (error) {
      if (!(error instanceof InjectedFailure)) throw error;
    } finally {
      await faulty.db.close();
    }
    if (!faulty.fired()) break;
    // Nothing of the failed try remains, in any table: counts and contents of every row are as before.
    expect(await world.snapshot(), `${label}: after a failure at write ${k}`).toEqual(baseline);
    const state = await world.sql<{ state: string }>('SELECT state FROM commands WHERE command_id = $1', [commandId]);
    expect(
      state.length === 0 || state[0]?.state === 'PENDING',
      `${label}: the command is not decided at write ${k}`,
    ).toBe(true);
  }
  expect(k, `${label}: the command writes fewer than 600 rows`).toBeLessThan(600);
  expect(outcome?.state, `${label}: the try after the last failure`).toBe(ends);
  expect(await world.sql('SELECT state FROM commands WHERE command_id = $1', [commandId])).toEqual([{ state: ends }]);
  return k - 1;
}

describe('a failure after any write leaves nothing of the command behind', () => {
  it('register_budget: the cap, its two pools, its document row and its audit row', async () => {
    const world = await createWorld();
    const request = world.command({ kind: 'register_budget', budget: world.docs.budget });
    const writes = await afterEveryWrite({ world, who: 'steward', request, ends: 'APPLIED' }, 'register_budget');
    expect(writes).toBeGreaterThanOrEqual(5);
    expect(await world.sql('SELECT revision FROM budget_caps')).toEqual([{ revision: 1 }]);
    expect(await world.sql('SELECT count(*)::int AS n FROM budget_pools')).toEqual([{ n: 2 }]);
    expect(
      await world.sql(`SELECT count(*)::int AS n FROM audit_events WHERE event_type = 'budget.registered'`),
    ).toEqual([{ n: 1 }]);
  });

  it('register_research_profile and register_cohort_policy: the record, its approval Decision and its audit row', async () => {
    const world = await createWorld();
    await world.apply('steward', { kind: 'register_budget', budget: world.docs.budget });
    const profile = world.command({ kind: 'register_research_profile', profile: world.docs.profile });
    expect(
      await afterEveryWrite({ world, who: 'steward', request: profile, ends: 'APPLIED' }, 'register_research_profile'),
    ).toBeGreaterThanOrEqual(3);
    const policy = world.command({ kind: 'register_cohort_policy', policy: world.docs.policy });
    expect(
      await afterEveryWrite({ world, who: 'steward', request: policy, ends: 'APPLIED' }, 'register_cohort_policy'),
    ).toBeGreaterThanOrEqual(4);
    expect(await world.sql(`SELECT count(*)::int AS n FROM decisions WHERE kind = 'POLICY_APPROVAL'`)).toEqual([
      { n: 1 },
    ]);
  });

  it('register_seed: the draft, its source-interpretation record and its audit row', async () => {
    const world = await createWorld();
    const request = world.command({ kind: 'register_seed', ...world.docs.seed });
    expect(
      await afterEveryWrite({ world, who: 'researcher', request, ends: 'APPLIED' }, 'register_seed'),
    ).toBeGreaterThanOrEqual(4);
    expect(await world.sql('SELECT count(*)::int AS n FROM source_interpretations')).toEqual([{ n: 1 }]);
  });

  it('create_mission: the mission, its budget, its configurations, its pools and its draw on the period cap', async () => {
    const world = await createWorld();
    await registerRecords(world);
    const request = world.command(missionPayload(world));
    const writes = await afterEveryWrite({ world, who: 'researcher', request, ends: 'APPLIED' }, 'create_mission');
    expect(writes).toBeGreaterThanOrEqual(15);
    expect(await world.sql('SELECT count(*)::int AS n FROM missions')).toEqual([{ n: 1 }]);
    expect(await world.sql('SELECT count(*)::int AS n FROM mission_agent_configurations')).toEqual([{ n: 3 }]);
    expect(
      await world.sql(
        `SELECT committed::text AS committed FROM budget_pools WHERE scope = 'PERIOD' AND dimension = 'MODEL_SPEND'`,
      ),
    ).toEqual([{ committed: '105.00000000' }]);
  });

  it('run_mission_now: the start, the retrieval job, its attempt, reservation, ledger entries and outbox entry', async () => {
    const world = await createWorld();
    await registerRecords(world);
    const missionId = await createMission(world);
    const request = world.command({ kind: 'run_mission_now', mission_id: missionId }, { expectedRevision: 1 });
    const writes = await afterEveryWrite({ world, who: 'researcher', request, ends: 'APPLIED' }, 'run_mission_now');
    expect(writes).toBeGreaterThanOrEqual(10);
    expect(await world.sql('SELECT status FROM missions')).toEqual([{ status: 'IN_PROGRESS' }]);
    expect(await world.sql('SELECT count(*)::int AS n FROM jobs')).toEqual([{ n: 1 }]);
    expect(await world.sql('SELECT count(*)::int AS n FROM outbox')).toEqual([{ n: 1 }]);
  });

  it('cancel_mission: the withdrawal, every cancelled run, attempt and outbox entry, and every released reservation', async () => {
    const world = await plannedWorld();
    const critique = await completedCritique(world, 'rev-a');
    await decide(world, 'rev-a', 'APPROVED', critique);
    const claimed = await world.sql<{ attempt_id: string }>(
      `SELECT attempt_id FROM attempts WHERE run_id IS NOT NULL ORDER BY attempt_id LIMIT 1`,
    );
    await claim(world, claimed[0]?.attempt_id as string);
    const request = world.command(
      { kind: 'cancel_mission', mission_id: world.records.missionId, reason: 'Stop.' },
      { expectedRevision: await missionRevision(world) },
    );
    const writes = await afterEveryWrite({ world, who: 'researcher', request, ends: 'APPLIED' }, 'cancel_mission');
    expect(writes).toBeGreaterThanOrEqual(30);
    expect(await world.sql('SELECT status FROM missions')).toEqual([{ status: 'WITHDRAWN' }]);
    expect(await world.sql(`SELECT DISTINCT status FROM runs`)).toEqual([{ status: 'CANCELLED' }]);
  });

  it('record_evaluation_decision APPROVED: the Decision, the lifecycle, five runs with attempts, reservations and outbox entries', async () => {
    const world = await plannedWorld();
    const critique = await completedCritique(world, 'rev-a');
    const request = world.command(decisionPayload(world, 'rev-a', sha('version-rev-a'), critique, 'APPROVED'), {
      expectedRevision: await missionRevision(world),
    });
    const writes = await afterEveryWrite(
      { world, who: 'workflows', request, ends: 'APPLIED' },
      'record_evaluation_decision',
    );
    expect(writes).toBeGreaterThanOrEqual(50);
    expect(await world.sql('SELECT count(*)::int AS n FROM runs')).toEqual([{ n: 5 }]);
    expect(
      await world.sql(`SELECT lifecycle FROM strategy_versions WHERE strategy_hash = $1`, [sha('version-rev-a')]),
    ).toEqual([{ lifecycle: 'EVALUATING' }]);
    // 5 runs: 5 attempts, 5 reservations, 5 outbox rows, no more and no fewer.
    expect(
      await world.sql(
        `SELECT (SELECT count(*)::int FROM attempts a JOIN runs r ON r.run_id = a.run_id) AS attempts, (SELECT count(*)::int FROM reservations r JOIN attempts a ON a.attempt_id = r.attempt_id WHERE a.run_id IS NOT NULL) AS reservations, (SELECT count(*)::int FROM outbox o JOIN attempts a ON a.attempt_id = o.attempt_id WHERE a.run_id IS NOT NULL) AS outbox`,
      ),
    ).toEqual([{ attempts: 5, reservations: 5, outbox: 5 }]);
  });

  it('record_evaluation_decision DEFERRED: the Decision and the terminal slot, and no run', async () => {
    const world = await plannedWorld();
    const critique = await failedCritique(world, 'rev-b', 'refusal', 1);
    const request = world.command(decisionPayload(world, 'rev-b', sha('version-rev-b'), critique, 'DEFERRED'), {
      expectedRevision: await missionRevision(world),
    });
    expect(
      await afterEveryWrite(
        { world, who: 'workflows', request, ends: 'APPLIED' },
        'record_evaluation_decision deferred',
      ),
    ).toBeGreaterThanOrEqual(4);
    expect(await world.sql('SELECT count(*)::int AS n FROM runs')).toEqual([{ n: 0 }]);
  });

  it('freeze_candidates: the holdout runs of the candidates, with their attempts, reservations and outbox entries', async () => {
    const world = await plannedWorld({ versions: ['seed'] });
    const critique = await completedCritique(world, 'seed');
    await decide(world, 'seed', 'APPROVED', critique);
    await finishRuns(world, 'seed');
    const request = world.command(
      {
        kind: 'freeze_candidates',
        mission_id: world.records.missionId,
        plan_digest: world.records.planDigest,
        slots: [
          { trial_slot: 'seed', status: 'EVALUATING', strategy_hash: world.records.seedDigest },
          { trial_slot: 'rev-a', status: 'NOT_EVALUATED', reason: 'NO_REGISTERED_VERSION' },
          { trial_slot: 'rev-b', status: 'NOT_EVALUATED', reason: 'NO_REGISTERED_VERSION' },
        ],
      },
      { expectedRevision: await missionRevision(world) },
    );
    expect(
      await afterEveryWrite({ world, who: 'workflows', request, ends: 'APPLIED' }, 'freeze_candidates'),
    ).toBeGreaterThanOrEqual(20);
    expect(await world.sql(`SELECT count(*)::int AS n FROM runs WHERE window_role = 'HOLDOUT'`)).toEqual([{ n: 2 }]);
  });

  it('freeze_candidates that concludes the mission: the slots, the outcome and the mission row', async () => {
    const world = await plannedWorld();
    const critique = await failedCritique(world, 'seed', 'refusal', 1);
    await decide(world, 'seed', 'DEFERRED', critique);
    const request = world.command(
      {
        kind: 'freeze_candidates',
        mission_id: world.records.missionId,
        plan_digest: world.records.planDigest,
        slots: [
          { trial_slot: 'seed', status: 'NOT_EVALUATED', reason: 'DECISION_DEFERRED' },
          { trial_slot: 'rev-a', status: 'NOT_EVALUATED', reason: 'SEED_NOT_EVALUATED' },
          { trial_slot: 'rev-b', status: 'NOT_EVALUATED', reason: 'SEED_NOT_EVALUATED' },
        ],
      },
      { expectedRevision: await missionRevision(world) },
    );
    expect(
      await afterEveryWrite({ world, who: 'workflows', request, ends: 'APPLIED' }, 'freeze_candidates concluding'),
    ).toBeGreaterThanOrEqual(6);
    expect(await world.sql('SELECT status, outcome FROM missions')).toEqual([
      { status: 'CONCLUDED', outcome: 'NO_ELIGIBLE_CANDIDATE' },
    ]);
  });

  it('a refusal that blocks the mission: the refusal and the block are written together, or neither is', async () => {
    // With the proposed 600-second evaluate attempts the third candidate cannot be reserved (see the decision tests).
    const world = await plannedWorld({ evaluateSeconds: 600 });
    for (const slot of ['seed', 'rev-a']) {
      const critique = await completedCritique(world, slot);
      await decide(world, slot, 'APPROVED', critique);
    }
    const critique = await completedCritique(world, 'rev-b');
    const request = world.command(decisionPayload(world, 'rev-b', sha('version-rev-b'), critique, 'APPROVED'), {
      expectedRevision: await missionRevision(world),
    });
    expect(
      await afterEveryWrite({ world, who: 'workflows', request, ends: 'REJECTED' }, 'a refusal that blocks'),
    ).toBeGreaterThanOrEqual(3);
    expect(await world.sql('SELECT status FROM missions')).toEqual([{ status: 'BLOCKED' }]);
    expect(await world.sql(`SELECT 1 FROM runs WHERE trial_slot = 'rev-b'`)).toEqual([]);
  });
});

describe('the injection itself', () => {
  it('fires after the k-th write and not before, so a loop that passes has really cut each command at every write', async () => {
    const world = await createWorld();
    worlds.push(world);
    const db = world.testApp.env.database();
    const faulty = failingAfter(db, 2);
    await expect(
      faulty.db.transaction(async (tx) => {
        await tx.query('SELECT 1');
        await tx.query(
          `INSERT INTO audit_events (occurred_at, actor, event_type, subject) VALUES (now(), 'a', 'x.y', 's')`,
        );
        expect(faulty.fired()).toBe(false);
        await tx.query(
          `INSERT INTO audit_events (occurred_at, actor, event_type, subject) VALUES (now(), 'a', 'x.y', 's')`,
        );
        throw new Error('not reached');
      }),
    ).rejects.toBeInstanceOf(InjectedFailure);
    expect(faulty.fired()).toBe(true);
    expect(await world.sql('SELECT count(*)::int AS n FROM audit_events')).toEqual([{ n: 0 }]);
    await db.close();
  });
});

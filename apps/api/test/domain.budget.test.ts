// Budgets on a real PostgreSQL (OQ-03 section 1, OQ-05 section 4, decisions D22 and D26). Each attempt reserves its
// per-attempt cap before it is dispatched, from the allowance of its own configuration; settlement never returns more
// than the reservation; usage above it is an overrun that blocks further reservations; unknown usage stays reserved.
// Every expected number is worked by hand from the pilot budget: 5 USD per agent attempt, 30 USD and 6 attempts per
// proposer, 45 USD and 9 attempts for the critic, 900 agent seconds per attempt.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { completeAttempt } from '../src/domain/attempts.ts';
import { releaseReservation, settleReservation } from '../src/domain/budget.ts';
import { claim, complete, startAgentJob } from './support/attempts.ts';
import { ids } from './support/seed.ts';
import { plannedWorld, type World } from './support/world.ts';

let world: World;
beforeAll(async () => {
  world = await plannedWorld();
});
afterAll(async () => {
  await world.drop();
});

async function pool(w: World, dimension: string, configuration: string | null = null) {
  const rows = await w.sql<{ committed: string; overrun: string; lim: string }>(
    `SELECT committed::text AS committed, overrun::text AS overrun, limit_amount::text AS lim FROM budget_pools
      WHERE scope = 'MISSION' AND mission_id = $1 AND dimension = $2 AND configuration_id IS NOT DISTINCT FROM $3`,
    [w.records.missionId, dimension, configuration],
  );
  return rows[0] as { committed: string; overrun: string; lim: string };
}

async function reservation(w: World, attemptId: string) {
  const rows = await w.sql<{ status: string }>('SELECT status FROM reservations WHERE attempt_id = $1', [attemptId]);
  return rows[0]?.status;
}

async function lines(w: World, attemptId: string) {
  return w.sql(
    `SELECT bp.dimension, rl.reserved::text AS reserved, rl.used::text AS used, rl.usage_label AS label
       FROM reservation_lines rl JOIN budget_pools bp ON bp.pool_id = rl.pool_id WHERE rl.attempt_id = $1 ORDER BY bp.dimension`,
    [attemptId],
  );
}

describe('reserving before dispatch', () => {
  it('takes the per-attempt cap from the allowance of the configuration and the compute seconds of the timeout', async () => {
    const before = {
      critic: await pool(world, 'MODEL_SPEND', 'critic'),
      a: await pool(world, 'MODEL_SPEND', 'proposer-a'),
      agent: await pool(world, 'AGENT_COMPUTE_SECONDS'),
    };
    const job = await startAgentJob(world, { slot: 'seed' });
    expect(await lines(world, job.attemptId)).toEqual([
      { dimension: 'AGENT_COMPUTE_SECONDS', reserved: '900.00000000', used: null, label: null },
      { dimension: 'MODEL_SPEND', reserved: '5.00000000', used: null, label: null },
    ]);
    const critic = await pool(world, 'MODEL_SPEND', 'critic');
    expect(critic.committed).toBe('5.00000000');
    // No other configuration's allowance moved: a configuration reserves only from its own.
    expect((await pool(world, 'MODEL_SPEND', 'proposer-a')).committed).toBe(before.a.committed);
    expect((await pool(world, 'AGENT_COMPUTE_SECONDS')).committed).toBe('900.00000000');
    const ledger = await world.sql(
      `SELECT entry_kind, amount::text AS amount FROM usage_ledger WHERE attempt_id = $1 ORDER BY ledger_id`,
      [job.attemptId],
    );
    // The reservation is written line by line, in the order of the needs: model spend, then compute seconds.
    expect(ledger).toEqual([
      { entry_kind: 'RESERVE', amount: '5.00000000' },
      { entry_kind: 'RESERVE', amount: '900.00000000' },
    ]);
    expect(await reservation(world, job.attemptId)).toBe('RESERVED');
    expect(before.critic.committed).toBe('0.00000000');
  });

  it('cannot lend between configurations: a proposer that used its 30 USD is refused, the other proposer and the critic are not', async () => {
    const fresh = await plannedWorld();
    for (let made = 1; made <= 6; made += 1)
      await startAgentJob(fresh, { configuration: 'proposer-a', role: 'PROPOSER' });
    const a = await fresh.sql(
      `SELECT committed::text AS committed FROM budget_pools WHERE configuration_id = 'proposer-a' AND mission_id = $1`,
      [fresh.records.missionId],
    );
    expect(a).toEqual([{ committed: '30.00000000' }]);
    await expect(startAgentJob(fresh, { configuration: 'proposer-a', role: 'PROPOSER' })).rejects.toThrow(
      /MODEL_SPEND of the allowance of proposer-a cannot cover 5.00000000: 0.00000000 is left/,
    );
    expect((await startAgentJob(fresh, { configuration: 'proposer-b', role: 'PROPOSER' })).attemptId).toMatch(/^att-/);
    expect((await startAgentJob(fresh, { configuration: 'critic', role: 'CRITIC' })).attemptId).toMatch(/^att-/);
    await fresh.drop();
  });

  it('counts the agent attempts of an allowance apart from its spend: six attempts of 1 USD still end the allowance of six', async () => {
    const fresh = await plannedWorld();
    for (let made = 1; made <= 6; made += 1) {
      const job = await startAgentJob(fresh, { configuration: 'proposer-b', role: 'PROPOSER' });
      expect((await claim(fresh, job.attemptId)).ok).toBe(true);
      const done = await complete(fresh, job.attemptId, {
        usage: {
          MODEL_SPEND: { label: 'observed', amount: '1' },
          AGENT_COMPUTE_SECONDS: { label: 'observed', amount: '60' },
        },
      });
      expect(done.ok).toBe(true);
    }
    // 6 attempts spent 6 USD: 24 USD of the allowance of 30 is free, and the allowance of attempts is used up.
    expect(
      (
        await fresh.sql(
          `SELECT committed::text AS committed FROM budget_pools WHERE configuration_id = 'proposer-b' AND mission_id = $1`,
          [fresh.records.missionId],
        )
      )[0],
    ).toEqual({ committed: '6.00000000' });
    await expect(startAgentJob(fresh, { configuration: 'proposer-b', role: 'PROPOSER' })).rejects.toThrow(
      /grants 6 agent attempts and all were started/,
    );
    await fresh.drop();
  });

  it('lets exactly one of two concurrent reservations take the last of an allowance', async () => {
    const fresh = await plannedWorld();
    for (let made = 1; made <= 5; made += 1)
      await startAgentJob(fresh, { configuration: 'proposer-a', role: 'PROPOSER' });
    // 25 of 30 USD are reserved: 5 are left, for one attempt. Ten callers try at once.
    const outcomes = await Promise.allSettled(
      Array.from({ length: 10 }, () => startAgentJob(fresh, { configuration: 'proposer-a', role: 'PROPOSER' })),
    );
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(9);
    expect(
      (
        await fresh.sql(
          `SELECT committed::text AS committed FROM budget_pools WHERE configuration_id = 'proposer-a' AND mission_id = $1`,
          [fresh.records.missionId],
        )
      )[0],
    ).toEqual({ committed: '30.00000000' });
    await fresh.drop();
  });
});

describe('settlement: never more than the reservation', () => {
  // Each case: usage reported for model spend of an attempt that reserved 5.00, and the hand-worked result.
  // consumed = min(used, 5); returned = 5 - consumed; overrun = used - consumed.
  const cases: [string, string, string, string, string][] = [
    ['less than the reservation', '3.25', '3.25', '1.75', '0'],
    ['exactly the reservation', '5', '5', '0', '0'],
    ['nothing at all, observed', '0', '0', '5', '0'],
    ['above the reservation', '7.5', '5', '0', '2.5'],
    ['a fraction of a cent above', '5.000000001', '5', '0', '0.00000001'],
    ['a fraction below, rounded up', '4.999999991', '5', '0', '0'],
  ];
  for (const [label, used, consumed, returned, overrun] of cases) {
    it(`${label}: used ${used} consumes ${consumed}, returns ${returned}, overruns ${overrun}`, async () => {
      const fresh = await plannedWorld();
      const before = await fresh.sql<{ committed: string }>(
        `SELECT committed::text AS committed FROM budget_pools WHERE configuration_id = 'critic' AND mission_id = $1`,
        [fresh.records.missionId],
      );
      const job = await startAgentJob(fresh, { slot: 'seed' });
      await claim(fresh, job.attemptId);
      const done = await complete(fresh, job.attemptId, {
        usage: {
          MODEL_SPEND: { label: 'estimated', amount: used },
          AGENT_COMPUTE_SECONDS: { label: 'observed', amount: '100' },
        },
      });
      expect(done.ok).toBe(true);
      const after = await fresh.sql<{ committed: string; overrun: string }>(
        `SELECT committed::text AS committed, overrun::text AS overrun FROM budget_pools WHERE configuration_id = 'critic' AND mission_id = $1`,
        [fresh.records.missionId],
      );
      // The pool keeps what the attempt consumed, and nothing more than the reservation, whatever it reported.
      const expectedCommitted = (Number(before[0]?.committed) + Number(consumed)).toFixed(8);
      expect(after[0]?.committed).toBe(expectedCommitted);
      expect(Number(after[0]?.overrun).toFixed(8)).toBe(Number(overrun).toFixed(8));
      expect(Number(returned) + Number(consumed)).toBe(5);
      const ledger = await fresh.sql<{ entry_kind: string; amount: string }>(
        `SELECT entry_kind, amount::text AS amount FROM usage_ledger WHERE attempt_id = $1 AND pool_id = (SELECT pool_id FROM budget_pools WHERE configuration_id = 'critic' AND mission_id = $2) ORDER BY ledger_id`,
        [job.attemptId, fresh.records.missionId],
      );
      const kinds = ledger.map((row) => row.entry_kind);
      expect(kinds[0]).toBe('RESERVE');
      expect(kinds.includes('RELEASE')).toBe(Number(returned) > 0);
      expect(kinds.includes('OVERRUN')).toBe(Number(overrun) > 0);
      // An overrun blocks the mission: it is BLOCKED with the reason, and nothing more can be reserved.
      const mission = await fresh.sql<{ status: string; blocked_reason: string | null }>(
        'SELECT status, blocked_reason FROM missions WHERE mission_id = $1',
        [fresh.records.missionId],
      );
      expect(mission[0]?.status).toBe(Number(overrun) > 0 ? 'BLOCKED' : 'IN_PROGRESS');
      if (Number(overrun) > 0) {
        expect(mission[0]?.blocked_reason).toContain('went over its reservation');
        await expect(startAgentJob(fresh, { configuration: 'proposer-a', role: 'PROPOSER' })).rejects.toThrow(
          /BLOCKED|overrun/,
        );
      }
      expect(await fresh.sql('SELECT status FROM reservations WHERE attempt_id = $1', [job.attemptId])).toEqual([
        { status: 'SETTLED' },
      ]);
      await fresh.drop();
    });
  }

  it('refuses a usage amount that the ledger cannot hold, and changes nothing', async () => {
    const fresh = await plannedWorld();
    const job = await startAgentJob(fresh, { slot: 'seed' });
    await claim(fresh, job.attemptId);
    const before = await fresh.snapshot();
    await expect(
      fresh.tx((tx) =>
        completeAttempt(tx, fresh.work(ids.batch), {
          attemptId: job.attemptId,
          ownershipRevision: 1,
          workStatus: 'COMPLETED',
          usage: { MODEL_SPEND: { label: 'observed', amount: '10000000000000000' } },
        }),
      ),
    ).rejects.toMatchObject({ code: 'SCHEMA_VIOLATION' });
    expect(await fresh.snapshot()).toEqual(before);
    await fresh.drop();
  });

  it('settles once: a second settlement of the same reservation changes nothing', async () => {
    const fresh = await plannedWorld();
    const job = await startAgentJob(fresh, { slot: 'seed' });
    await claim(fresh, job.attemptId);
    await complete(fresh, job.attemptId, {
      usage: {
        MODEL_SPEND: { label: 'observed', amount: '2' },
        AGENT_COMPUTE_SECONDS: { label: 'observed', amount: '10' },
      },
    });
    const before = await fresh.snapshot();
    const again = await fresh.tx((tx) =>
      settleReservation(
        tx,
        job.attemptId,
        { MODEL_SPEND: { label: 'observed', amount: '1' } },
        fresh.testApp.clock.now(),
      ),
    );
    expect(again).toEqual({ status: 'UNCHANGED', overruns: [] });
    expect(await fresh.snapshot()).toEqual(before);
    await fresh.drop();
  });
});

describe('unknown usage is never zero', () => {
  it('keeps the full reservation, marks it UNRECONCILED, and settles it when a report arrives later', async () => {
    const fresh = await plannedWorld();
    const job = await startAgentJob(fresh, { slot: 'seed' });
    await claim(fresh, job.attemptId);
    // The attempt ended and reported no usage at all: not zero, unknown.
    const done = await complete(fresh, job.attemptId, { usage: {} });
    expect(done.ok && done.value.settled).toBe('UNRECONCILED');
    expect(await lines(fresh, job.attemptId)).toEqual([
      { dimension: 'AGENT_COMPUTE_SECONDS', reserved: '900.00000000', used: null, label: 'unknown' },
      { dimension: 'MODEL_SPEND', reserved: '5.00000000', used: null, label: 'unknown' },
    ]);
    expect(await reservation(fresh, job.attemptId)).toBe('UNRECONCILED');
    // The full amount still counts as spent.
    expect(
      (
        await fresh.sql(
          `SELECT committed::text AS committed FROM budget_pools WHERE configuration_id = 'critic' AND mission_id = $1`,
          [fresh.records.missionId],
        )
      )[0],
    ).toEqual({ committed: '5.00000000' });
    const unreconciled = await fresh.sql(
      `SELECT entry_kind, amount::text AS amount, usage_label FROM usage_ledger WHERE attempt_id = $1 AND entry_kind = 'UNRECONCILE' ORDER BY amount`,
      [job.attemptId],
    );
    expect(unreconciled).toEqual([
      { entry_kind: 'UNRECONCILE', amount: '5.00000000', usage_label: 'unknown' },
      { entry_kind: 'UNRECONCILE', amount: '900.00000000', usage_label: 'unknown' },
    ]);
    // Recovery reconciles it: the report arrives (a spend of 2) and the remainder goes back.
    const later = await fresh.tx((tx) =>
      settleReservation(
        tx,
        job.attemptId,
        {
          MODEL_SPEND: { label: 'estimated', amount: '2' },
          AGENT_COMPUTE_SECONDS: { label: 'observed', amount: '300' },
        },
        fresh.testApp.clock.now(),
      ),
    );
    expect(later.status).toBe('SETTLED');
    expect(await reservation(fresh, job.attemptId)).toBe('SETTLED');
    expect(
      (
        await fresh.sql(
          `SELECT committed::text AS committed FROM budget_pools WHERE configuration_id = 'critic' AND mission_id = $1`,
          [fresh.records.missionId],
        )
      )[0],
    ).toEqual({ committed: '2.00000000' });
    const kinds = await fresh.sql<{ entry_kind: string }>(
      `SELECT DISTINCT entry_kind FROM usage_ledger WHERE attempt_id = $1 ORDER BY entry_kind`,
      [job.attemptId],
    );
    expect(kinds.map((row) => row.entry_kind)).toEqual(['RECONCILE', 'RELEASE', 'RESERVE', 'UNRECONCILE']);
    await fresh.drop();
  });

  it('keeps the unknown line reserved when only some of the usage is reported', async () => {
    const fresh = await plannedWorld();
    const job = await startAgentJob(fresh, { slot: 'seed' });
    await claim(fresh, job.attemptId);
    const done = await complete(fresh, job.attemptId, {
      usage: { MODEL_SPEND: { label: 'estimated', amount: '3.25' }, AGENT_COMPUTE_SECONDS: { label: 'unknown' } },
    });
    expect(done.ok && done.value.settled).toBe('UNRECONCILED');
    expect(await lines(fresh, job.attemptId)).toEqual([
      { dimension: 'AGENT_COMPUTE_SECONDS', reserved: '900.00000000', used: null, label: 'unknown' },
      { dimension: 'MODEL_SPEND', reserved: '5.00000000', used: '3.25000000', label: 'estimated' },
    ]);
    expect(
      (
        await fresh.sql(
          `SELECT committed::text AS committed FROM budget_pools WHERE dimension = 'AGENT_COMPUTE_SECONDS' AND mission_id = $1`,
          [fresh.records.missionId],
        )
      )[0],
    ).toEqual({ committed: '900.00000000' });
    expect(
      (
        await fresh.sql(
          `SELECT committed::text AS committed FROM budget_pools WHERE configuration_id = 'critic' AND mission_id = $1`,
          [fresh.records.missionId],
        )
      )[0],
    ).toEqual({ committed: '3.25000000' });
    await fresh.drop();
  });
});

describe('releasing a reservation that nothing consumed', () => {
  it('returns every line to its pool, writes RELEASE entries, and releases once', async () => {
    const fresh = await plannedWorld();
    const job = await startAgentJob(fresh, { slot: 'seed' });
    expect(
      (
        await fresh.sql(
          `SELECT committed::text AS committed FROM budget_pools WHERE configuration_id = 'critic' AND mission_id = $1`,
          [fresh.records.missionId],
        )
      )[0],
    ).toEqual({ committed: '5.00000000' });
    expect(await fresh.tx((tx) => releaseReservation(tx, job.attemptId, fresh.testApp.clock.now()))).toBe(true);
    expect(
      (
        await fresh.sql(
          `SELECT committed::text AS committed FROM budget_pools WHERE configuration_id = 'critic' AND mission_id = $1`,
          [fresh.records.missionId],
        )
      )[0],
    ).toEqual({ committed: '0.00000000' });
    expect(await fresh.tx((tx) => releaseReservation(tx, job.attemptId, fresh.testApp.clock.now()))).toBe(false);
    expect(await reservation(fresh, job.attemptId)).toBe('RELEASED');
    await fresh.drop();
  });
});

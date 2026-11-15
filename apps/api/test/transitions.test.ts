// The transition table of OQ-05 section 4, tested against an independent literal written from the specification text.
// Every pair of states of every entity is tried: a listed transition succeeds and every other one is refused by the
// trigger, which names the entity. A terminal state has nothing to move to.

import { describe, expect, it } from 'vitest';
import { useRolledBackTransaction } from './support/rollback.ts';
import type { Exec } from './support/seed.ts';
import {
  digests,
  ids,
  insertAttempt,
  insertJob,
  insertLease,
  insertPool,
  insertRun,
  NOW,
  runCompanion,
} from './support/seed.ts';

const t = useRolledBackTransaction();

type Pair = readonly [string, string];

// OQ-05 section 4, read row by row. A run or job leaves QUEUED when an attempt is claimed (RUNNING) or the mission is
// cancelled (CANCELLED). It leaves RUNNING for a result (COMPLETED or FAILED), a lease expiry or retryable failure
// with a new attempt or none (back to QUEUED), or cancellation. An attempt is PENDING until it is claimed or
// cancelled, and a CLAIMED attempt ends COMPLETED, FAILED, LEASE_EXPIRED or CANCELLED. A lease is HELD until it is
// released or expires. A reservation is RESERVED until it is settled, released or left unreconciled, and an
// UNRECONCILED one is settled once the usage is reconciled. An outbox row is PENDING until it is sent or cancelled.
// A mission is CREATED until it is started or withdrawn, runs, may block, and ends WITHDRAWN or CONCLUDED.
const listed: Record<string, readonly Pair[]> = {
  run: [
    ['QUEUED', 'RUNNING'],
    ['QUEUED', 'CANCELLED'],
    ['RUNNING', 'QUEUED'],
    ['RUNNING', 'COMPLETED'],
    ['RUNNING', 'FAILED'],
    ['RUNNING', 'CANCELLED'],
  ],
  job: [
    ['QUEUED', 'RUNNING'],
    ['QUEUED', 'CANCELLED'],
    ['RUNNING', 'QUEUED'],
    ['RUNNING', 'COMPLETED'],
    ['RUNNING', 'FAILED'],
    ['RUNNING', 'CANCELLED'],
  ],
  attempt: [
    ['PENDING', 'CLAIMED'],
    ['PENDING', 'CANCELLED'],
    ['CLAIMED', 'COMPLETED'],
    ['CLAIMED', 'FAILED'],
    ['CLAIMED', 'LEASE_EXPIRED'],
    ['CLAIMED', 'CANCELLED'],
  ],
  lease: [
    ['HELD', 'RELEASED'],
    ['HELD', 'EXPIRED'],
  ],
  reservation: [
    ['RESERVED', 'SETTLED'],
    ['RESERVED', 'UNRECONCILED'],
    ['RESERVED', 'RELEASED'],
    ['UNRECONCILED', 'SETTLED'],
  ],
  outbox: [
    ['PENDING', 'SENT'],
    ['PENDING', 'CANCELLED'],
  ],
  mission: [
    ['CREATED', 'IN_PROGRESS'],
    ['CREATED', 'WITHDRAWN'],
    ['IN_PROGRESS', 'BLOCKED'],
    ['IN_PROGRESS', 'WITHDRAWN'],
    ['IN_PROGRESS', 'CONCLUDED'],
    ['BLOCKED', 'WITHDRAWN'],
  ],
  trial: [
    ['DRAFTED', 'INVALID'],
    ['DRAFTED', 'REGISTERED'],
    ['DRAFTED', 'DISCARDED'],
  ],
};

interface Entity {
  readonly name: string;
  readonly table: string;
  /** The WHERE clause that finds the row that `create` made. */
  readonly where: string;
  readonly states: readonly string[];
  readonly create: (exec: Exec) => Promise<void>;
  /** Assignments that make a row consistent in a state, so only the transition trigger can refuse it. */
  readonly companion: (state: string) => string;
}

const claimedColumns = `claimed_at = '${NOW}', worker_id = 'worker-1', executable_name = 'engine-batch', executable_version = '0.0.0', executable_digest = '${digests.plan}', dispatch_digest = '${digests.plan}'`;
const unclaimedColumns =
  'claimed_at = NULL, worker_id = NULL, executable_name = NULL, executable_version = NULL, executable_digest = NULL, dispatch_digest = NULL';

const entities: readonly Entity[] = [
  {
    name: 'run',
    table: 'runs',
    where: `run_id = 'run-t'`,
    states: ['QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED'],
    create: (exec) => insertRun(exec, { runId: 'run-t' }),
    companion: runCompanion,
  },
  {
    name: 'job',
    table: 'jobs',
    where: `job_id = 'job-t'`,
    states: ['QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED'],
    create: (exec) => insertJob(exec, { jobId: 'job-t' }),
    companion: runCompanion,
  },
  {
    name: 'attempt',
    table: 'attempts',
    where: `attempt_id = 'att-t'`,
    states: ['PENDING', 'CLAIMED', 'COMPLETED', 'FAILED', 'LEASE_EXPIRED', 'CANCELLED'],
    create: async (exec) => {
      await insertRun(exec, { runId: 'run-t' });
      await insertAttempt(exec, { attemptId: 'att-t', runId: 'run-t', poolId: await insertPool(exec) });
    },
    companion: (state) =>
      ({
        PENDING: `${unclaimedColumns}, ended_at = NULL, failure_code = NULL`,
        CLAIMED: `${claimedColumns}, ended_at = NULL, failure_code = NULL`,
        COMPLETED: `${claimedColumns}, ended_at = '${NOW}', failure_code = NULL`,
        FAILED: `${claimedColumns}, ended_at = '${NOW}', failure_code = 'WORKER_LOST'`,
        LEASE_EXPIRED: `${claimedColumns}, ended_at = '${NOW}', failure_code = NULL`,
        CANCELLED: `${claimedColumns}, ended_at = '${NOW}', failure_code = NULL`,
      })[state] ?? '',
  },
  {
    name: 'lease',
    table: 'leases',
    where: `attempt_id = 'att-t'`,
    states: ['HELD', 'RELEASED', 'EXPIRED'],
    create: async (exec) => {
      await insertRun(exec, { runId: 'run-t' });
      await insertAttempt(exec, { attemptId: 'att-t', runId: 'run-t', poolId: await insertPool(exec) });
      await insertLease(exec, 'att-t', 1, 'HELD');
    },
    companion: (state) => (state === 'HELD' ? 'released_at = NULL' : `released_at = '${NOW}'`),
  },
  {
    name: 'reservation',
    table: 'reservations',
    where: `attempt_id = 'att-t'`,
    states: ['RESERVED', 'SETTLED', 'UNRECONCILED', 'RELEASED'],
    create: async (exec) => {
      await insertRun(exec, { runId: 'run-t' });
      await insertAttempt(exec, { attemptId: 'att-t', runId: 'run-t', poolId: await insertPool(exec) });
    },
    companion: (state) =>
      ({
        RESERVED: 'settled_at = NULL, released_at = NULL',
        SETTLED: `settled_at = '${NOW}', released_at = NULL`,
        UNRECONCILED: 'settled_at = NULL, released_at = NULL',
        RELEASED: `settled_at = NULL, released_at = '${NOW}'`,
      })[state] ?? '',
  },
  {
    name: 'outbox',
    table: 'outbox',
    where: `attempt_id = 'att-t'`,
    states: ['PENDING', 'SENT', 'CANCELLED'],
    create: async (exec) => {
      await insertRun(exec, { runId: 'run-t' });
      await insertAttempt(exec, { attemptId: 'att-t', runId: 'run-t', poolId: await insertPool(exec) });
    },
    companion: (state) => (state === 'SENT' ? `sent_at = '${NOW}'` : 'sent_at = NULL'),
  },
  {
    name: 'mission',
    table: 'missions',
    where: `mission_id = 'mission-t'`,
    states: ['CREATED', 'IN_PROGRESS', 'BLOCKED', 'WITHDRAWN', 'CONCLUDED'],
    create: async (exec) => {
      await exec.query(
        `INSERT INTO missions (mission_id, status, objective, instrument_id, symbol, provider, provider_asset_id, instrument_effective_from,
           profile_id, profile_revision, policy_id, policy_revision, seed_draft_digest, created_by, created_at, started_by, started_at)
         VALUES ('mission-t', 'CREATED', 'x', 'i', 'AAPL', 'alpaca', 'a', '2020-01-01', $1, 1, $2, 1, $3, $4, $5, $4, $5)`,
        [ids.profile, ids.policy, digests.seedDraft, ids.researcher, NOW],
      );
    },
    companion: (state) => {
      const none = `blocked_reason = NULL, outcome = NULL, outcome_reason = NULL, concluded_at = NULL, withdrawn_by = NULL, withdrawn_at = NULL`;
      return (
        (
          {
            CREATED: none,
            IN_PROGRESS: none,
            BLOCKED: `${none.replace('blocked_reason = NULL', `blocked_reason = 'Budget exhausted.'`)}`,
            WITHDRAWN: `${none.replace('withdrawn_by = NULL, withdrawn_at = NULL', `withdrawn_by = '${ids.researcher}', withdrawn_at = '${NOW}'`)}`,
            CONCLUDED: `${none.replace(
              'outcome = NULL, outcome_reason = NULL, concluded_at = NULL',
              `outcome = 'NO_ELIGIBLE_CANDIDATE', outcome_reason = 'No candidate passed.', concluded_at = '${NOW}'`,
            )}`,
          } as Record<string, string>
        )[state] ?? ''
      );
    },
  },
  {
    name: 'trial',
    table: 'trials',
    where: `trial_id = 'trial-t'`,
    states: ['DRAFTED', 'INVALID', 'REGISTERED', 'DISCARDED'],
    create: async (exec) => {
      await exec.query(
        `INSERT INTO trials (trial_id, mission_id, trial_slot, proposal_ordinal, draft_digest, created_at) VALUES ('trial-t', $1, $2, 1, $3, $4)`,
        [ids.mission, ids.slotA, digests.revisionStrategy, NOW],
      );
    },
    companion: (state) =>
      ({
        DRAFTED: 'strategy_hash = NULL, reason = NULL',
        INVALID: `strategy_hash = NULL, reason = 'REVISION_SCOPE'`,
        REGISTERED: `strategy_hash = '${digests.revisionStrategy}', reason = NULL`,
        DISCARDED: `strategy_hash = NULL, reason = 'Superseded.'`,
      })[state] ?? '',
  },
];

// The states to pass through, after the first one, to get from `start` to `goal` along listed transitions.
function pathTo(entity: string, start: string, goal: string): string[] {
  const queue: { state: string; steps: string[] }[] = [{ state: start, steps: [] }];
  const seen = new Set([start]);
  for (const { state, steps } of queue) {
    if (state === goal) return steps;
    for (const [from, to] of listed[entity] ?? []) {
      if (from === state && !seen.has(to)) {
        seen.add(to);
        queue.push({ state: to, steps: [...steps, to] });
      }
    }
  }
  throw new Error(`${entity}: ${goal} cannot be reached from ${start} by listed transitions`);
}

function assign(entity: Entity, state: string): string {
  const extra = entity.companion(state);
  return `status = '${state}'${extra ? `, ${extra}` : ''}`;
}

describe('the transition table of OQ-05 section 4', () => {
  it('holds exactly the listed transitions, and the entities are exactly those of the specification', async () => {
    const rows = (await t.ok('SELECT entity, from_state, to_state FROM state_transitions')) as {
      entity: string;
      from_state: string;
      to_state: string;
    }[];
    const actual = rows.map((row) => `${row.entity} ${row.from_state} ${row.to_state}`).sort();
    const expected = Object.entries(listed)
      .flatMap(([entity, pairs]) => pairs.map(([from, to]) => `${entity} ${from} ${to}`))
      .sort();
    expect(actual).toEqual(expected);
    expect(entities.map((entity) => entity.name).sort()).toEqual(Object.keys(listed).sort());
  });

  it('refuses to change the table itself', async () => {
    await t.violation(`DELETE FROM state_transitions WHERE entity = 'run'`, [], {
      code: '23514',
      constraint: 'state_transitions_immutable',
    });
    // No transition can be added: a terminal state stays terminal.
    await t.violation(
      `INSERT INTO state_transitions (entity, from_state, to_state) VALUES ('run', 'COMPLETED', 'QUEUED')`,
      [],
      {
        code: '23514',
        constraint: 'state_transitions_immutable',
      },
    );
  });

  it('leaves a terminal state with no way out', () => {
    const terminal: Record<string, readonly string[]> = {
      run: ['COMPLETED', 'FAILED', 'CANCELLED'],
      job: ['COMPLETED', 'FAILED', 'CANCELLED'],
      attempt: ['COMPLETED', 'FAILED', 'LEASE_EXPIRED', 'CANCELLED'],
      lease: ['RELEASED', 'EXPIRED'],
      reservation: ['SETTLED', 'RELEASED'],
      outbox: ['SENT', 'CANCELLED'],
      mission: ['WITHDRAWN', 'CONCLUDED'],
      trial: ['INVALID', 'REGISTERED', 'DISCARDED'],
    };
    for (const [entity, states] of Object.entries(terminal)) {
      for (const [from] of listed[entity] ?? []) expect(states, `${entity} ${from}`).not.toContain(from);
    }
  });

  for (const entity of entities) {
    it(`${entity.name}: every listed transition is accepted and every other pair is refused`, async () => {
      const allowed = new Set((listed[entity.name] ?? []).map(([from, to]) => `${from}>${to}`));
      let accepted = 0;
      let refused = 0;
      for (const from of entity.states) {
        for (const to of entity.states) {
          if (from === to) continue;
          await t.ok('SAVEPOINT pair');
          await entity.create(t.exec);
          // Walk the row to the state to leave along listed transitions, so every state is shown to be reachable.
          for (const step of pathTo(entity.name, entity.states[0] as string, from)) {
            await t.ok(`UPDATE ${entity.table} SET ${assign(entity, step)} WHERE ${entity.where}`);
          }
          const sql = `UPDATE ${entity.table} SET ${assign(entity, to)} WHERE ${entity.where}`;
          if (allowed.has(`${from}>${to}`)) {
            const rows = await t.ok(`${sql} RETURNING status`);
            expect(rows[0]?.status, `${entity.name} ${from} to ${to}`).toBe(to);
            accepted += 1;
          } else {
            await t.violation(sql, [], { code: '23514', constraint: `${entity.name}_transition` });
            refused += 1;
          }
          await t.ok('ROLLBACK TO SAVEPOINT pair');
        }
      }
      expect(accepted).toBe(allowed.size);
      expect(accepted + refused).toBe(entity.states.length * (entity.states.length - 1));
    });
  }

  it('does not treat a write of the same status as a transition', async () => {
    await insertRun(t.exec, { runId: 'run-same' });
    await t.ok(`UPDATE runs SET status = 'QUEUED', revision = revision + 1 WHERE run_id = 'run-same'`);
  });

  it('refuses a status that is not one of the entity values', async () => {
    await insertRun(t.exec, { runId: 'run-x' });
    await t.violation(`UPDATE runs SET status = 'PAUSED' WHERE run_id = 'run-x'`, [], { code: '23514' });
    await t.violation(`UPDATE missions SET status = 'PAUSED'`, [], { code: '23514' });
  });
});

// The transition table as code (src/domain/transitions.ts) against the rows of OQ-05 section 4 and the table in the
// database. The literal below is written from the text of the specification, one line for each move that its table
// and its prose allow. It is not read from the code under test.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  assertTransition,
  canTransition,
  type Entity,
  isTerminal,
  TRANSITIONS,
  TransitionError,
} from '../src/domain/transitions.ts';
import { migratedDatabase, type TestDatabase } from './support/database.ts';

// Run and job: "Run or job QUEUED, attempt PENDING" at creation; a claim makes the run or job RUNNING; a retryable
// failure puts it back to QUEUED; a result gives COMPLETED or FAILED; cancellation gives CANCELLED, also from QUEUED
// (a run waiting for its claim, or for budget with no live attempt).
const WORK = [
  ['QUEUED', 'RUNNING'],
  ['QUEUED', 'CANCELLED'],
  ['RUNNING', 'QUEUED'],
  ['RUNNING', 'COMPLETED'],
  ['RUNNING', 'FAILED'],
  ['RUNNING', 'CANCELLED'],
];

const SPEC: Record<Entity, [string, string][]> = {
  run: WORK as [string, string][],
  job: WORK as [string, string][],
  // Claim; result submission (COMPLETED or FAILED); lease expiry; cancellation of a PENDING or a CLAIMED attempt.
  attempt: [
    ['PENDING', 'CLAIMED'],
    ['PENDING', 'CANCELLED'],
    ['CLAIMED', 'COMPLETED'],
    ['CLAIMED', 'FAILED'],
    ['CLAIMED', 'LEASE_EXPIRED'],
    ['CLAIMED', 'CANCELLED'],
  ],
  // HELD from a claim; RELEASED when the attempt ends while it holds the lease; EXPIRED when the lease time passes.
  lease: [
    ['HELD', 'RELEASED'],
    ['HELD', 'EXPIRED'],
  ],
  // Usage report: SETTLED; no report: UNRECONCILED, settled later by recovery; released when cancelled before a claim.
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
  // OQ-02 section 1: started, blocked by a budget, withdrawn by cancel_mission, concluded with an outcome. In S1 a
  // BLOCKED mission has no way out but withdrawal.
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

const STATES: Record<Entity, string[]> = {
  run: ['QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED'],
  job: ['QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED'],
  attempt: ['PENDING', 'CLAIMED', 'COMPLETED', 'FAILED', 'LEASE_EXPIRED', 'CANCELLED'],
  lease: ['HELD', 'RELEASED', 'EXPIRED'],
  reservation: ['RESERVED', 'SETTLED', 'UNRECONCILED', 'RELEASED'],
  outbox: ['PENDING', 'SENT', 'CANCELLED'],
  mission: ['CREATED', 'IN_PROGRESS', 'BLOCKED', 'WITHDRAWN', 'CONCLUDED'],
  trial: ['DRAFTED', 'INVALID', 'REGISTERED', 'DISCARDED'],
};

const entities = Object.keys(SPEC) as Entity[];

let database: TestDatabase;
beforeAll(async () => {
  database = await migratedDatabase();
});
afterAll(async () => {
  await database.drop();
});

describe('the transition table in code', () => {
  it('lists exactly the moves of the specification', () => {
    for (const entity of entities) {
      const listed = Object.entries(TRANSITIONS[entity]).flatMap(([from, targets]) =>
        targets.map((to) => `${from}>${to}`),
      );
      expect(listed.sort(), entity).toEqual(SPEC[entity].map(([from, to]) => `${from}>${to}`).sort());
    }
  });

  it('is the table that the database holds, row for row', async () => {
    const rows = await database.sql<{ entity: string; from_state: string; to_state: string }>(
      'SELECT entity, from_state, to_state FROM state_transitions ORDER BY entity, from_state, to_state',
    );
    const code = entities
      .flatMap((entity) =>
        Object.entries(TRANSITIONS[entity]).flatMap(([from, targets]) =>
          targets.map((to) => `${entity} ${from} ${to}`),
        ),
      )
      .sort();
    expect(rows.map((row) => `${row.entity} ${row.from_state} ${row.to_state}`).sort()).toEqual(code);
  });

  it('allows every listed move and refuses every other pair of states, for every entity', () => {
    let checked = 0;
    for (const entity of entities) {
      const allowed = new Set(SPEC[entity].map(([from, to]) => `${from}>${to}`));
      for (const from of STATES[entity]) {
        for (const to of STATES[entity]) {
          const listed = allowed.has(`${from}>${to}`);
          expect(canTransition(entity, from, to), `${entity} ${from} to ${to}`).toBe(listed);
          if (listed) expect(() => assertTransition(entity, from, to)).not.toThrow();
          else expect(() => assertTransition(entity, from, to), `${entity} ${from} to ${to}`).toThrow(TransitionError);
          checked += 1;
        }
      }
    }
    // 2 x 25 + 36 + 9 + 16 + 9 + 25 + 16 pairs.
    expect(checked).toBe(161);
  });

  it('refuses a state that no entity has, and a move from a terminal state', () => {
    expect(canTransition('run', 'PAUSED', 'RUNNING')).toBe(false);
    expect(canTransition('run', 'COMPLETED', 'QUEUED')).toBe(false);
    expect(canTransition('mission', 'CONCLUDED', 'IN_PROGRESS')).toBe(false);
    expect(() => assertTransition('attempt', 'COMPLETED', 'CLAIMED')).toThrow(/not a listed transition/);
  });

  it('knows the terminal states: those that no listed move leaves', () => {
    const terminal: Record<Entity, string[]> = {
      run: ['COMPLETED', 'FAILED', 'CANCELLED'],
      job: ['COMPLETED', 'FAILED', 'CANCELLED'],
      attempt: ['COMPLETED', 'FAILED', 'LEASE_EXPIRED', 'CANCELLED'],
      lease: ['RELEASED', 'EXPIRED'],
      reservation: ['SETTLED', 'RELEASED'],
      outbox: ['SENT', 'CANCELLED'],
      mission: ['WITHDRAWN', 'CONCLUDED'],
      trial: ['INVALID', 'REGISTERED', 'DISCARDED'],
    };
    for (const entity of entities) {
      expect(
        STATES[entity].filter((state) => isTerminal(entity, state)),
        entity,
      ).toEqual(terminal[entity]);
    }
  });
});

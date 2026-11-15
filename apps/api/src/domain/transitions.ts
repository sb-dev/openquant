// The transition table of OQ-05 section 4 as code. A command, workflow or worker can make only a listed transition;
// any other is a defect of the caller, so it throws an ordinary Error (the API answers INTERNAL and logs the cause).
// The same table is in the database (state_transitions and one trigger per status column, migration 0001): that is the
// second line of defence, and test/domain.transitions.test.ts proves that both lists are equal.
//
// States by entity (OQ-05 section 4 and OQ-02 sections 1 and 3.6):
//   run and job   QUEUED, RUNNING, COMPLETED, FAILED, CANCELLED (an `evaluate` job is a run; an agent's logical run is a job)
//   attempt       PENDING, CLAIMED, COMPLETED, FAILED, LEASE_EXPIRED, CANCELLED
//   lease         HELD, RELEASED, EXPIRED
//   reservation   RESERVED, SETTLED, UNRECONCILED, RELEASED
//   outbox        PENDING, SENT, CANCELLED
//   mission       CREATED, IN_PROGRESS, BLOCKED, WITHDRAWN, CONCLUDED
//   trial         DRAFTED, INVALID, REGISTERED, DISCARDED

export type Entity = 'run' | 'job' | 'attempt' | 'lease' | 'reservation' | 'outbox' | 'mission' | 'trial';

type Table = Readonly<Record<string, readonly string[]>>;

// RUNNING to QUEUED is the retry of a failed or expired attempt: the run or job waits for its next attempt, or for
// budget when no attempt can be reserved. QUEUED to RUNNING is a claim. A terminal state has no entry.
const work: Table = {
  QUEUED: ['RUNNING', 'CANCELLED'],
  RUNNING: ['QUEUED', 'COMPLETED', 'FAILED', 'CANCELLED'],
};

export const TRANSITIONS: Readonly<Record<Entity, Table>> = {
  run: work,
  job: work,
  attempt: {
    PENDING: ['CLAIMED', 'CANCELLED'],
    CLAIMED: ['COMPLETED', 'FAILED', 'LEASE_EXPIRED', 'CANCELLED'],
  },
  lease: { HELD: ['RELEASED', 'EXPIRED'] },
  reservation: {
    RESERVED: ['SETTLED', 'UNRECONCILED', 'RELEASED'],
    UNRECONCILED: ['SETTLED'],
  },
  outbox: { PENDING: ['SENT', 'CANCELLED'] },
  mission: {
    CREATED: ['IN_PROGRESS', 'WITHDRAWN'],
    IN_PROGRESS: ['BLOCKED', 'WITHDRAWN', 'CONCLUDED'],
    // In S1 the only way out of BLOCKED is withdrawal by cancel_mission: no command raises a budget (OQ-05 section 4).
    BLOCKED: ['WITHDRAWN'],
  },
  trial: { DRAFTED: ['INVALID', 'REGISTERED', 'DISCARDED'] },
};

export function canTransition(entity: Entity, from: string, to: string): boolean {
  return TRANSITIONS[entity][from]?.includes(to) ?? false;
}

export class TransitionError extends Error {
  constructor(entity: Entity, from: string, to: string) {
    super(`${entity} status ${from} to ${to} is not a listed transition.`);
    this.name = 'TransitionError';
  }
}

/** Throws unless the move is listed. Call it before the UPDATE; the database trigger repeats the check. */
export function assertTransition(entity: Entity, from: string, to: string): void {
  if (!canTransition(entity, from, to)) throw new TransitionError(entity, from, to);
}

/** The states that no transition leaves. */
export function isTerminal(entity: Entity, state: string): boolean {
  return (TRANSITIONS[entity][state]?.length ?? 0) === 0;
}

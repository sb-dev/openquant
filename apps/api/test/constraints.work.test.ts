// Constraint tests, part 2: runs, jobs, attempts, leases, the outbox, budget pools, reservations and the usage ledger
// (OQ-05 section 4; OQ-02 sections 3.6 and 8; OQ-03 section 1). Each test shows that a correct row is accepted and
// then breaks one invariant: one live attempt, the attempt cap, fencing revisions, one transaction for attempt,
// reservation and outbox, the budget limit and the usage rules.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { failureOf, migratedDatabase, type TestDatabase } from './support/database.ts';
import { useRolledBackTransaction } from './support/rollback.ts';
import {
  digests,
  ids,
  insertAttempt,
  insertJob,
  insertLease,
  insertPool,
  insertRun,
  NOW,
  seedGraph,
  sha,
} from './support/seed.ts';

const t = useRolledBackTransaction();

const CHECK = '23514';
const UNIQUE = '23505';
const FOREIGN_KEY = '23503';

/** A replay record (migration 0011): every REPLAY run names its own, and no other run names one. */
async function replayRecord(replayId: string, runId: string): Promise<void> {
  await t.ok(
    `INSERT INTO replays (replay_id, run_id, fixture_set, case_id, strategy_id, strategy_version, strategy_digest,
       input_digest, evaluate_seconds, requested_by, requested_at)
     VALUES ($1, $2, 's0', 'F0-smoke', 'f0-smoke', 1, $3, $3, 120, $4, $5)`,
    [replayId, runId, digests.seedStrategy, ids.admin, NOW],
  );
}

describe('runs (OQ-02 sections 3.6 and 8)', () => {
  it('belongs to a planned run slot and to one window, or is a replay with none of them', async () => {
    await insertRun(t.exec, { runId: 'run-ok' });
    await t.violation(
      `INSERT INTO runs (run_id, mode, mission_id, attempt_cap, created_at) VALUES ('run-bt', 'BACKTEST', $1, 3, $2)`,
      [ids.mission, NOW],
      { code: CHECK, constraint: 'runs_backtest_shape' },
    );
    await t.violation(
      `INSERT INTO runs (run_id, mode, mission_id, attempt_cap, created_at) VALUES ('run-replay', 'REPLAY', $1, 3, $2)`,
      [ids.mission, NOW],
      { code: CHECK, constraint: 'runs_backtest_shape' },
    );
    await replayRecord('rpl-1', 'run-replay');
    // A REPLAY run names its replay record (its own budget), and a backtest run names none.
    await t.violation(
      `INSERT INTO runs (run_id, mode, attempt_cap, created_at) VALUES ('run-replay', 'REPLAY', 3, $1)`,
      [NOW],
      { code: CHECK, constraint: 'runs_replay_record' },
    );
    await t.violation(`UPDATE runs SET replay_id = 'rpl-1' WHERE run_id = 'run-ok'`, [], {
      code: CHECK,
      constraint: 'runs_replay_record',
    });
    await t.ok(
      `INSERT INTO runs (run_id, mode, replay_id, attempt_cap, created_at) VALUES ('run-replay', 'REPLAY', 'rpl-1', 3, $1)`,
      [NOW],
    );
    await replayRecord('rpl-2', 'run-replay-2');
    await t.violation(
      `INSERT INTO runs (run_id, mode, replay_id, attempt_cap, repeat_of_run, created_at) VALUES ('run-replay-2', 'REPLAY', 'rpl-2', 3, 'run-replay', $1)`,
      [NOW],
      { code: CHECK, constraint: 'runs_backtest_shape' },
    );
    // One run per replay record.
    await t.violation(
      `INSERT INTO runs (run_id, mode, replay_id, attempt_cap, created_at) VALUES ('run-replay-3', 'REPLAY', 'rpl-1', 3, $1)`,
      [NOW],
      { code: UNIQUE, constraint: 'runs_one_per_replay' },
    );
  });

  it('runs only a planned slot, and a slot has at most one run', async () => {
    await insertRun(t.exec, { runId: 'run-1', runSlot: 'rs-d-base' });
    await t.violation(
      `INSERT INTO runs (run_id, mode, status, mission_id, run_slot, trial_slot, window_role, cost_scenario, plan_digest, strategy_hash, attempt_cap, created_at)
       VALUES ('run-2', 'BACKTEST', 'QUEUED', $1, 'rs-d-base', $2, 'DEVELOPMENT', 'BASE', $3, $4, 3, $5)`,
      [ids.mission, ids.seedSlot, digests.plan, digests.seedStrategy, NOW],
      { code: UNIQUE, constraint: 'runs_one_per_slot' },
    );
    await t.violation(
      `INSERT INTO runs (run_id, mode, status, mission_id, run_slot, trial_slot, window_role, cost_scenario, plan_digest, strategy_hash, attempt_cap, created_at)
       VALUES ('run-3', 'BACKTEST', 'QUEUED', $1, 'rs-unplanned', $2, 'DEVELOPMENT', 'BASE', $3, $4, 3, $5)`,
      [ids.mission, ids.seedSlot, digests.plan, digests.seedStrategy, NOW],
      { code: FOREIGN_KEY, constraint: 'runs_slot' },
    );
  });

  it('takes its window and cost case from the planned slot: a HOLDOUT run needs a HOLDOUT slot', async () => {
    await t.violation(
      `INSERT INTO runs (run_id, mode, status, mission_id, run_slot, trial_slot, window_role, cost_scenario, plan_digest, strategy_hash, attempt_cap, created_at)
       VALUES ('run-h', 'BACKTEST', 'QUEUED', $1, 'rs-d-stress', $2, 'HOLDOUT', 'COST_STRESS', $3, $4, 3, $5)`,
      [ids.mission, ids.seedSlot, digests.plan, digests.seedStrategy, NOW],
      { code: FOREIGN_KEY, constraint: 'runs_slot' },
    );
    await t.violation(
      `INSERT INTO runs (run_id, mode, status, mission_id, run_slot, trial_slot, window_role, cost_scenario, plan_digest, strategy_hash, attempt_cap, created_at)
       VALUES ('run-s', 'BACKTEST', 'QUEUED', $1, 'rs-d-stress', $2, 'DEVELOPMENT', 'BASE', $3, $4, 3, $5)`,
      [ids.mission, ids.seedSlot, digests.plan, digests.seedStrategy, NOW],
      { code: FOREIGN_KEY, constraint: 'runs_slot' },
    );
    await insertRun(t.exec, {
      runId: 'run-h-ok',
      runSlot: 'rs-h-base',
      windowRole: 'HOLDOUT',
    });
  });

  it('binds its plan to its mission', async () => {
    await t.violation(
      `INSERT INTO runs (run_id, mode, status, mission_id, run_slot, trial_slot, window_role, cost_scenario, plan_digest, strategy_hash, attempt_cap, created_at)
       VALUES ('run-p', 'BACKTEST', 'QUEUED', $1, 'rs-d-base', $2, 'DEVELOPMENT', 'BASE', $3, $4, 3, $5)`,
      [ids.mission, ids.seedSlot, digests.calendar, digests.seedStrategy, NOW],
      { code: FOREIGN_KEY, constraint: 'runs_plan' },
    );
  });

  it('is terminal with a completion time, FAILED with a code, and waits for budget only while QUEUED', async () => {
    for (const run of ['c', 'f', 'q', 'w']) await replayRecord(`rpl-${run}`, `run-${run}`);
    await t.violation(
      `INSERT INTO runs (run_id, mode, replay_id, status, attempt_cap, created_at) VALUES ('run-c', 'REPLAY', 'rpl-c', 'COMPLETED', 3, $1)`,
      [NOW],
      { code: CHECK, constraint: 'runs_terminal_completed_at' },
    );
    await t.violation(
      `INSERT INTO runs (run_id, mode, replay_id, status, attempt_cap, created_at, completed_at) VALUES ('run-f', 'REPLAY', 'rpl-f', 'FAILED', 3, $1, $1)`,
      [NOW],
      { code: CHECK, constraint: 'runs_failed_has_code' },
    );
    await t.violation(
      `INSERT INTO runs (run_id, mode, replay_id, status, attempt_cap, created_at, completed_at) VALUES ('run-q', 'REPLAY', 'rpl-q', 'QUEUED', 3, $1, $1)`,
      [NOW],
      { code: CHECK, constraint: 'runs_terminal_completed_at' },
    );
    await t.violation(
      `INSERT INTO runs (run_id, mode, replay_id, status, attempt_cap, waiting_reason, created_at) VALUES ('run-w', 'REPLAY', 'rpl-w', 'RUNNING', 3, 'waiting for budget', $1)`,
      [NOW],
      { code: CHECK, constraint: 'runs_waiting_only_when_queued' },
    );
    await t.ok(
      `INSERT INTO runs (run_id, mode, replay_id, status, attempt_cap, waiting_reason, created_at) VALUES ('run-w', 'REPLAY', 'rpl-w', 'QUEUED', 3, 'waiting for budget', $1)`,
      [NOW],
    );
  });

  it('has an attempt cap from 1 to 10', async () => {
    for (const cap of [0, 11]) {
      await t.violation(
        `INSERT INTO runs (run_id, mode, attempt_cap, created_at) VALUES ('run-cap', 'REPLAY', $1, $2)`,
        [cap, NOW],
        { code: CHECK },
      );
    }
  });
});

describe('jobs and agent runs (OQ-05 section 4)', () => {
  it('is a typed job, or an agent run with its role and configuration', async () => {
    await insertJob(t.exec, { jobId: 'job-ok', kind: 'retrieve' });
    await insertJob(t.exec, { jobId: 'job-agent', kind: 'agent' });
    await t.violation(
      `INSERT INTO jobs (job_id, kind, mission_id, attempt_cap, created_at) VALUES ('job-eval', 'evaluate', $1, 3, $2)`,
      [ids.mission, NOW],
      { code: CHECK },
    );
    await t.violation(
      `INSERT INTO jobs (job_id, kind, mission_id, attempt_cap, created_at) VALUES ('job-a', 'agent', $1, 3, $2)`,
      [ids.mission, NOW],
      { code: CHECK, constraint: 'jobs_agent_shape' },
    );
    await t.violation(
      `INSERT INTO jobs (job_id, kind, mission_id, agent_role, configuration_id, attempt_cap, created_at) VALUES ('job-r', 'retrieve', $1, 'PROPOSER', $2, 3, $3)`,
      [ids.mission, ids.proposerA, NOW],
      { code: CHECK, constraint: 'jobs_agent_shape' },
    );
    // The role must be the role of that configuration: the critic configuration is not a proposer.
    await t.violation(
      `INSERT INTO jobs (job_id, kind, mission_id, agent_role, configuration_id, attempt_cap, created_at) VALUES ('job-r2', 'agent', $1, 'PROPOSER', $2, 3, $3)`,
      [ids.mission, ids.critic, NOW],
      { code: FOREIGN_KEY, constraint: 'jobs_configuration' },
    );
  });

  it('follows the same completion rules as a run', async () => {
    await t.violation(
      `INSERT INTO jobs (job_id, kind, status, mission_id, attempt_cap, created_at) VALUES ('job-c', 'retrieve', 'COMPLETED', $1, 3, $2)`,
      [ids.mission, NOW],
      { code: CHECK, constraint: 'jobs_terminal_completed_at' },
    );
    await t.violation(
      `INSERT INTO jobs (job_id, kind, status, mission_id, attempt_cap, created_at, completed_at) VALUES ('job-f', 'retrieve', 'FAILED', $1, 3, $2, $2)`,
      [ids.mission, NOW],
      { code: CHECK, constraint: 'jobs_failed_has_code' },
    );
    await t.violation(
      `INSERT INTO jobs (job_id, kind, status, mission_id, attempt_cap, waiting_reason, created_at) VALUES ('job-w', 'retrieve', 'RUNNING', $1, 3, 'x', $2)`,
      [ids.mission, NOW],
      { code: CHECK, constraint: 'jobs_waiting_only_when_queued' },
    );
  });
});

describe('attempts (OQ-05 section 4: ownership, fencing and the attempt cap)', () => {
  it('belongs to exactly one logical run or job', async () => {
    await insertRun(t.exec, { runId: 'run-1' });
    await insertJob(t.exec, { jobId: 'job-1' });
    const poolId = await insertPool(t.exec);
    const insert = `INSERT INTO attempts (attempt_id, run_id, job_id, ownership_revision, attempt_cap, created_at) VALUES ('att-x', $1, $2, 1, 3, $3)`;
    await t.violation(insert, ['run-1', 'job-1', NOW], { code: CHECK, constraint: 'attempts_one_parent' });
    await t.violation(insert, [null, null, NOW], { code: CHECK, constraint: 'attempts_one_parent' });
    await insertAttempt(t.exec, { attemptId: 'att-run', runId: 'run-1', poolId });
    await insertAttempt(t.exec, { attemptId: 'att-job', jobId: 'job-1', poolId });
  });

  it('has at most one live attempt for a run and one for a job', async () => {
    await insertRun(t.exec, { runId: 'run-1' });
    await insertJob(t.exec, { jobId: 'job-1' });
    const poolId = await insertPool(t.exec);
    await insertAttempt(t.exec, { attemptId: 'att-1', runId: 'run-1', poolId });
    await t.violation(
      `INSERT INTO attempts (attempt_id, run_id, ownership_revision, attempt_cap, created_at) VALUES ('att-2', 'run-1', 2, 3, $1)`,
      [NOW],
      { code: UNIQUE, constraint: 'attempts_one_live_per_run' },
    );
    await insertAttempt(t.exec, { attemptId: 'att-j1', jobId: 'job-1', poolId });
    await t.violation(
      `INSERT INTO attempts (attempt_id, job_id, ownership_revision, attempt_cap, created_at) VALUES ('att-j2', 'job-1', 2, 3, $1)`,
      [NOW],
      { code: UNIQUE, constraint: 'attempts_one_live_per_job' },
    );
  });

  it('allows the next attempt once the live one has ended, and numbers revisions without a gap', async () => {
    await insertRun(t.exec, { runId: 'run-1', status: 'RUNNING' });
    const poolId = await insertPool(t.exec);
    await insertAttempt(t.exec, { attemptId: 'att-1', runId: 'run-1', poolId, status: 'LEASE_EXPIRED' });
    // Revision 3 needs revision 2.
    await t.violation(
      `INSERT INTO attempts (attempt_id, run_id, ownership_revision, attempt_cap, created_at) VALUES ('att-3', 'run-1', 3, 3, $1)`,
      [NOW],
      { code: FOREIGN_KEY, constraint: 'attempts_run_previous' },
    );
    // The same revision twice.
    await t.violation(
      `INSERT INTO attempts (attempt_id, run_id, ownership_revision, attempt_cap, created_at) VALUES ('att-1b', 'run-1', 1, 3, $1)`,
      [NOW],
      { code: UNIQUE, constraint: 'attempts_run_revision' },
    );
    await insertAttempt(t.exec, { attemptId: 'att-2', runId: 'run-1', revision: 2, poolId });
  });

  it('never exceeds the attempt cap, and the cap is the one of its run', async () => {
    await insertRun(t.exec, { runId: 'run-1', cap: 2 });
    const poolId = await insertPool(t.exec);
    await insertAttempt(t.exec, { attemptId: 'att-1', runId: 'run-1', poolId, cap: 2, status: 'FAILED' });
    await insertAttempt(t.exec, { attemptId: 'att-2', runId: 'run-1', revision: 2, poolId, cap: 2, status: 'FAILED' });
    await t.violation(
      `INSERT INTO attempts (attempt_id, run_id, ownership_revision, attempt_cap, created_at) VALUES ('att-3', 'run-1', 3, 2, $1)`,
      [NOW],
      { code: CHECK, constraint: 'attempts_cap_not_exceeded' },
    );
    await t.violation(
      `INSERT INTO attempts (attempt_id, run_id, ownership_revision, attempt_cap, created_at) VALUES ('att-4', 'run-1', 3, 5, $1)`,
      [NOW],
      { code: FOREIGN_KEY, constraint: 'attempts_run_cap' },
    );
  });

  it('keeps the claim identity of a claimed attempt and the end time of an ended one', async () => {
    await insertRun(t.exec, { runId: 'run-1', status: 'RUNNING' });
    await t.violation(
      `INSERT INTO attempts (attempt_id, run_id, ownership_revision, attempt_cap, status, created_at) VALUES ('att-1', 'run-1', 1, 3, 'CLAIMED', $1)`,
      [NOW],
      { code: CHECK, constraint: 'attempts_claimed_identity' },
    );
    await t.violation(
      `INSERT INTO attempts (attempt_id, run_id, ownership_revision, attempt_cap, status, created_at, claimed_at) VALUES ('att-1', 'run-1', 1, 3, 'PENDING', $1, $1)`,
      [NOW],
      { code: CHECK, constraint: 'attempts_pending_not_claimed' },
    );
    await t.violation(
      `INSERT INTO attempts (attempt_id, run_id, ownership_revision, attempt_cap, status, created_at, ended_at) VALUES ('att-1', 'run-1', 1, 3, 'PENDING', $1, $1)`,
      [NOW],
      { code: CHECK, constraint: 'attempts_ended_at' },
    );
    await t.violation(
      `INSERT INTO attempts (attempt_id, run_id, ownership_revision, attempt_cap, status, created_at, ended_at) VALUES ('att-1', 'run-1', 1, 3, 'CANCELLED', $1, NULL)`,
      [NOW],
      { code: CHECK, constraint: 'attempts_ended_at' },
    );
    await t.violation(
      `INSERT INTO attempts (attempt_id, run_id, ownership_revision, attempt_cap, status, created_at, claimed_at, worker_id, executable_name, executable_version, executable_digest, dispatch_digest, ended_at)
       VALUES ('att-1', 'run-1', 1, 3, 'FAILED', $1, $1, 'w', 'engine-batch', '0.0.0', $2, $2, $1)`,
      [NOW, sha('x')],
      { code: CHECK, constraint: 'attempts_failed_has_reason' },
    );
    await t.violation(
      `INSERT INTO attempts (attempt_id, run_id, ownership_revision, attempt_cap, agent_outcome, created_at) VALUES ('att-1', 'run-1', 1, 3, 'success', $1)`,
      [NOW],
      { code: CHECK },
    );
  });
});

describe('one transaction for attempt, reservation and outbox (OQ-05 section 4; A11)', () => {
  it('refuses an attempt without its reservation, a reservation line and its outbox row when the transaction commits', async () => {
    await insertRun(t.exec, { runId: 'run-1' });
    await t.ok(
      `INSERT INTO attempts (attempt_id, run_id, ownership_revision, attempt_cap, created_at) VALUES ('att-1', 'run-1', 1, 3, $1)`,
      [NOW],
    );
    await t.violation('SET CONSTRAINTS ALL IMMEDIATE', [], {
      code: CHECK,
      constraint: 'attempts_have_reservation_and_outbox',
    });
    await t.ok(`INSERT INTO reservations (attempt_id, reserved_at) VALUES ('att-1', $1)`, [NOW]);
    await t.violation('SET CONSTRAINTS ALL IMMEDIATE', [], {
      code: CHECK,
      constraint: 'attempts_have_reservation_and_outbox',
    });
    const poolId = await insertPool(t.exec);
    await t.ok(`INSERT INTO reservation_lines (attempt_id, pool_id, reserved) VALUES ('att-1', $1, 5)`, [poolId]);
    await t.violation('SET CONSTRAINTS ALL IMMEDIATE', [], {
      code: CHECK,
      constraint: 'attempts_have_reservation_and_outbox',
    });
    await t.ok(
      `INSERT INTO outbox (attempt_id, destination, message, message_digest, created_at) VALUES ('att-1', 'BATCH_QUEUE', '{}', $1, $2)`,
      [sha('m'), NOW],
    );
    await t.ok('SET CONSTRAINTS ALL IMMEDIATE');
  });

  it('refuses a reservation or an outbox row for an attempt that does not exist', async () => {
    await t.ok(`INSERT INTO reservations (attempt_id, reserved_at) VALUES ('att-ghost', $1)`, [NOW]);
    await t.violation('SET CONSTRAINTS ALL IMMEDIATE', [], {
      code: FOREIGN_KEY,
      constraint: 'reservations_attempt_id_fkey',
    });
  });

  it('refuses an outbox row for an attempt that does not exist', async () => {
    await t.ok(
      `INSERT INTO outbox (attempt_id, destination, message, message_digest, created_at) VALUES ('att-ghost', 'BATCH_QUEUE', '{}', $1, $2)`,
      [sha('m'), NOW],
    );
    await t.violation('SET CONSTRAINTS ALL IMMEDIATE', [], { code: FOREIGN_KEY, constraint: 'outbox_attempt_id_fkey' });
  });

  it('records a SENT outbox row with its time and refuses a destination that is not a dispatch target', async () => {
    await insertRun(t.exec, { runId: 'run-1' });
    const poolId = await insertPool(t.exec);
    await insertAttempt(t.exec, { attemptId: 'att-1', runId: 'run-1', poolId });
    await t.violation(`UPDATE outbox SET status = 'SENT'`, [], { code: CHECK, constraint: 'outbox_sent_has_time' });
    await t.violation(`UPDATE outbox SET destination = 'EMAIL'`, [], { code: CHECK });
    await t.violation(`UPDATE outbox SET message = '[]'::jsonb`, [], { code: CHECK });
    await t.ok(`UPDATE outbox SET status = 'SENT', sent_at = '${NOW}'`);
  });
});

describe('leases (OQ-05 section 4)', () => {
  it('is HELD exactly while its attempt is CLAIMED', async () => {
    await insertRun(t.exec, { runId: 'run-1', status: 'RUNNING' });
    const poolId = await insertPool(t.exec);
    // A CLAIMED attempt without a lease fails at commit, and with its HELD lease it passes. The attempt is written
    // without insertAttempt, which would also write the lease.
    await t.ok(
      `INSERT INTO attempts (attempt_id, run_id, ownership_revision, attempt_cap, status, created_at, claimed_at, worker_id, executable_name, executable_version, executable_digest, dispatch_digest)
       VALUES ('att-2', 'run-1', 1, 3, 'CLAIMED', $1, $1, 'w', 'engine-batch', '0.0.0', $2, $2)`,
      [NOW, sha('x')],
    );
    await t.ok(`INSERT INTO reservations (attempt_id, reserved_at) VALUES ('att-2', $1)`, [NOW]);
    await t.ok(`INSERT INTO reservation_lines (attempt_id, pool_id, reserved) VALUES ('att-2', $1, 5)`, [poolId]);
    await t.ok(
      `INSERT INTO outbox (attempt_id, destination, message, message_digest, created_at) VALUES ('att-2', 'BATCH_QUEUE', '{}', $1, $2)`,
      [sha('m2'), NOW],
    );
    await t.violation('SET CONSTRAINTS ALL IMMEDIATE', [], {
      code: CHECK,
      constraint: 'leases_held_iff_attempt_claimed',
    });
    await insertLease(t.exec, 'att-2', 1, 'HELD');
    await t.ok('SET CONSTRAINTS ALL IMMEDIATE');
  });

  it('is never HELD for an attempt that is not CLAIMED', async () => {
    await insertRun(t.exec, { runId: 'run-1' });
    const poolId = await insertPool(t.exec);
    await insertAttempt(t.exec, { attemptId: 'att-1', runId: 'run-1', poolId, status: 'PENDING' });
    await insertLease(t.exec, 'att-1', 1, 'HELD');
    await t.violation('SET CONSTRAINTS ALL IMMEDIATE', [], {
      code: CHECK,
      constraint: 'leases_held_iff_attempt_claimed',
    });
  });

  it('expires after it is granted, and is HELD exactly while it has not been released', async () => {
    await insertRun(t.exec, { runId: 'run-1', status: 'RUNNING' });
    const poolId = await insertPool(t.exec);
    await insertAttempt(t.exec, { attemptId: 'att-1', runId: 'run-1', poolId, status: 'LEASE_EXPIRED' });
    await t.violation(
      `INSERT INTO leases (attempt_id, ownership_revision, granted_at, expires_at, capability_hash) VALUES ('att-1', 1, $1, $1, $2)`,
      [NOW, sha('c')],
      { code: CHECK, constraint: 'leases_expiry_after_grant' },
    );
    await t.violation(
      `INSERT INTO leases (attempt_id, ownership_revision, status, granted_at, expires_at, capability_hash) VALUES ('att-1', 1, 'RELEASED', $1, '2026-11-15T10:05:00Z', $2)`,
      [NOW, sha('c')],
      { code: CHECK, constraint: 'leases_held_not_released' },
    );
    await t.violation(
      `INSERT INTO leases (attempt_id, ownership_revision, status, granted_at, expires_at, released_at, capability_hash) VALUES ('att-1', 1, 'HELD', $1, '2026-11-15T10:05:00Z', $1, $2)`,
      [NOW, sha('c')],
      { code: CHECK, constraint: 'leases_held_not_released' },
    );
    await t.violation(
      `INSERT INTO leases (attempt_id, ownership_revision, status, granted_at, expires_at, released_at, capability_hash) VALUES ('att-1', 1, 'EXPIRED', $1, '2026-11-15T10:05:00Z', $1, 'not-a-digest')`,
      [NOW],
      { code: CHECK, constraint: 'oq_digest_pattern' },
    );
  });

  it('carries the ownership revision of its attempt, and each capability once', async () => {
    await insertRun(t.exec, { runId: 'run-1', status: 'RUNNING' });
    await insertRun(t.exec, { runId: 'run-2', status: 'RUNNING', runSlot: 'rs-d-stress', costScenario: 'COST_STRESS' });
    const poolId = await insertPool(t.exec);
    await insertAttempt(t.exec, { attemptId: 'att-1', runId: 'run-1', poolId, status: 'LEASE_EXPIRED' });
    await insertAttempt(t.exec, { attemptId: 'att-2', runId: 'run-2', poolId, status: 'LEASE_EXPIRED' });
    await t.violation(
      `INSERT INTO leases (attempt_id, ownership_revision, status, granted_at, expires_at, released_at, capability_hash) VALUES ('att-1', 2, 'EXPIRED', $1, '2026-11-15T10:05:00Z', $1, $2)`,
      [NOW, sha('c1')],
      { code: FOREIGN_KEY, constraint: 'leases_attempt' },
    );
    await t.ok(
      `INSERT INTO leases (attempt_id, ownership_revision, status, granted_at, expires_at, released_at, capability_hash) VALUES ('att-1', 1, 'EXPIRED', $1, '2026-11-15T10:05:00Z', $1, $2)`,
      [NOW, sha('c1')],
    );
    await t.violation(
      `INSERT INTO leases (attempt_id, ownership_revision, status, granted_at, expires_at, released_at, capability_hash) VALUES ('att-2', 1, 'EXPIRED', $1, '2026-11-15T10:05:00Z', $1, $2)`,
      [NOW, sha('c1')],
      { code: UNIQUE, constraint: 'leases_capability_unique' },
    );
  });
});

describe('budget pools, reservations and the usage ledger (OQ-03 section 1)', () => {
  it('never commits more than its limit', async () => {
    const poolId = await insertPool(t.exec, 10);
    await t.violation(`UPDATE budget_pools SET committed = 11 WHERE pool_id = $1`, [poolId], {
      code: CHECK,
      constraint: 'budget_pools_not_overspent',
    });
    await t.ok(`UPDATE budget_pools SET committed = 10 WHERE pool_id = $1`, [poolId]);
    await t.violation(`UPDATE budget_pools SET committed = -1 WHERE pool_id = $1`, [poolId], { code: CHECK });
    await t.violation(`UPDATE budget_pools SET overrun = -1 WHERE pool_id = $1`, [poolId], { code: CHECK });
  });

  it('has the shape of its scope and keeps a configuration allowance to model spend', async () => {
    await t.violation(
      `INSERT INTO budget_pools (scope, mission_id, budget_id, budget_revision, dimension, limit_amount) VALUES ('MISSION', $1, $2, 1, 'MODEL_SPEND', 1)`,
      [ids.mission, ids.cap],
      { code: CHECK, constraint: 'budget_pools_scope_shape' },
    );
    await t.violation(
      `INSERT INTO budget_pools (scope, dimension, limit_amount) VALUES ('PERIOD', 'MODEL_SPEND', 1)`,
      [],
      { code: CHECK, constraint: 'budget_pools_scope_shape' },
    );
    await t.violation(
      `INSERT INTO budget_pools (scope, mission_id, configuration_id, dimension, limit_amount) VALUES ('MISSION', $1, $2, 'PROVIDER_REQUESTS', 1)`,
      [ids.mission, ids.critic],
      { code: CHECK, constraint: 'budget_pools_configuration_is_model_spend' },
    );
    await t.violation(
      `INSERT INTO budget_pools (scope, mission_id, dimension, limit_amount) VALUES ('MISSION', $1, 'CPU_HOURS', 1)`,
      [ids.mission],
      { code: CHECK },
    );
    await t.ok(
      `INSERT INTO budget_pools (scope, budget_id, budget_revision, dimension, limit_amount) VALUES ('PERIOD', $1, 1, 'MODEL_SPEND', 210)`,
      [ids.cap],
    );
    await t.violation(
      `INSERT INTO budget_pools (scope, budget_id, budget_revision, dimension, limit_amount) VALUES ('PERIOD', $1, 1, 'MODEL_SPEND', 210)`,
      [ids.cap],
      { code: UNIQUE, constraint: 'budget_pools_period_dimension' },
    );
    await t.violation(
      `INSERT INTO budget_pools (scope, budget_id, budget_revision, dimension, limit_amount) VALUES ('PERIOD', 'cap-none', 1, 'MODEL_SPEND', 210)`,
      [],
      { code: FOREIGN_KEY, constraint: 'budget_pools_period' },
    );
  });

  it('has one pool for each dimension of a mission, and one for each configuration allowance', async () => {
    await insertPool(t.exec, 5, 'MODEL_SPEND');
    await t.violation(
      `INSERT INTO budget_pools (scope, mission_id, configuration_id, dimension, limit_amount) VALUES ('MISSION', $1, $2, 'MODEL_SPEND', 5)`,
      [ids.mission, ids.critic],
      { code: UNIQUE, constraint: 'budget_pools_mission_configuration' },
    );
    await insertPool(t.exec, 5, 'PROVIDER_REQUESTS');
    await t.violation(
      `INSERT INTO budget_pools (scope, mission_id, dimension, limit_amount) VALUES ('MISSION', $1, 'PROVIDER_REQUESTS', 5)`,
      [ids.mission],
      { code: UNIQUE, constraint: 'budget_pools_mission_dimension' },
    );
  });

  it('records usage that is never negative and an unknown usage without an amount', async () => {
    await insertRun(t.exec, { runId: 'run-1' });
    const poolId = await insertPool(t.exec, 100, 'MODEL_SPEND');
    await insertAttempt(t.exec, { attemptId: 'att-1', runId: 'run-1', poolId });
    await t.violation(`UPDATE reservation_lines SET used = -0.01, usage_label = 'observed'`, [], {
      code: CHECK,
      constraint: 'reservation_lines_used_not_negative',
    });
    await t.violation(`UPDATE reservation_lines SET used = 0, usage_label = 'unknown'`, [], {
      code: CHECK,
      constraint: 'reservation_lines_label_matches_amount',
    });
    await t.violation(`UPDATE reservation_lines SET usage_label = 'observed'`, [], {
      code: CHECK,
      constraint: 'reservation_lines_label_matches_amount',
    });
    await t.violation(`UPDATE reservation_lines SET used = 3`, [], {
      code: CHECK,
      constraint: 'reservation_lines_label_matches_amount',
    });
    await t.violation(`UPDATE reservation_lines SET used = 3, usage_label = 'guessed'`, [], { code: CHECK });
    await t.ok(`UPDATE reservation_lines SET usage_label = 'unknown'`);
    await t.ok(`UPDATE reservation_lines SET used = 3.5, usage_label = 'estimated'`);
    await t.violation(`UPDATE reservation_lines SET reserved = -1`, [], { code: CHECK });
  });

  it('settles with a time, releases with a time, and appends to a ledger that is never edited', async () => {
    await insertRun(t.exec, { runId: 'run-1' });
    const poolId = await insertPool(t.exec);
    await insertAttempt(t.exec, { attemptId: 'att-1', runId: 'run-1', poolId });
    await t.violation(`UPDATE reservations SET status = 'SETTLED'`, [], {
      code: CHECK,
      constraint: 'reservations_settled_has_time',
    });
    await t.violation(`UPDATE reservations SET status = 'RELEASED'`, [], {
      code: CHECK,
      constraint: 'reservations_released_has_time',
    });
    await t.ok(`UPDATE reservations SET status = 'RELEASED', released_at = '${NOW}'`);
    await t.ok(
      `INSERT INTO usage_ledger (attempt_id, pool_id, entry_kind, amount, usage_label, recorded_at) VALUES ('att-1', $1, 'RELEASE', 10, 'observed', $2)`,
      [poolId, NOW],
    );
    await t.violation(
      `INSERT INTO usage_ledger (attempt_id, pool_id, entry_kind, amount, recorded_at) VALUES ('att-1', $1, 'RELEASE', -10, $2)`,
      [poolId, NOW],
      { code: CHECK },
    );
    await t.violation(
      `INSERT INTO usage_ledger (attempt_id, pool_id, entry_kind, amount, recorded_at) VALUES ('att-1', $1, 'REFUND', 10, $2)`,
      [poolId, NOW],
      { code: CHECK },
    );
    await t.violation(`UPDATE usage_ledger SET amount = 0`, [], { code: CHECK, constraint: 'usage_ledger_immutable' });
    await t.violation(`DELETE FROM usage_ledger`, [], { code: CHECK, constraint: 'usage_ledger_immutable' });
  });

  it('keeps an attention item resolved exactly when it has a resolution time', async () => {
    await t.violation(
      `INSERT INTO attention_items (item_id, mission_id, subject, reason, status, opened_at) VALUES ('att-i', $1, 'run-1', 'x', 'RESOLVED', $2)`,
      [ids.mission, NOW],
      { code: CHECK, constraint: 'attention_items_resolved_has_time' },
    );
    await t.ok(
      `INSERT INTO attention_items (item_id, mission_id, subject, reason, opened_at) VALUES ('att-i', $1, 'run-1', 'x', $2)`,
      [ids.mission, NOW],
    );
  });
});

// These two tests need committed data and real concurrency, so they use their own database.
describe('commit-time and concurrent behaviour (A11)', () => {
  let database: TestDatabase;
  beforeAll(async () => {
    database = await migratedDatabase();
    const client = await database.connect();
    try {
      await client.query('BEGIN');
      await seedGraph({ query: (text, values) => client.query(text, values as unknown[]) as never });
      await insertRun(
        { query: (text, values) => client.query(text, values as unknown[]) as never },
        { runId: 'run-committed' },
      );
      await client.query('COMMIT');
    } finally {
      await client.end();
    }
  });
  afterAll(async () => {
    await database.drop();
  });

  it('rolls everything back when the commit finds an attempt without its reservation and outbox row', async () => {
    const client = await database.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO attempts (attempt_id, run_id, ownership_revision, attempt_cap, created_at) VALUES ('att-lonely', 'run-committed', 1, 3, $1)`,
        [NOW],
      );
      const failure = await failureOf(client.query('COMMIT'));
      expect(failure).toMatchObject({ code: CHECK, constraint: 'attempts_have_reservation_and_outbox' });
    } finally {
      await client.end();
    }
    const rows = await database.sql<{ count: string }>(`SELECT count(*) FROM attempts WHERE attempt_id = 'att-lonely'`);
    expect(rows[0]?.count).toBe('0');
  });

  it('lets one of two overlapping reservations win and refuses the other, so the budget is never exceeded', async () => {
    const [pool] = await database.sql<{ pool_id: string }>(
      `INSERT INTO budget_pools (scope, mission_id, dimension, limit_amount) VALUES ('MISSION', $1, 'PROVIDER_REQUESTS', 10) RETURNING pool_id`,
      [ids.mission],
    );
    const poolId = pool?.pool_id;
    const first = await database.connect();
    const second = await database.connect();
    try {
      await first.query('BEGIN');
      await second.query('BEGIN');
      await first.query('UPDATE budget_pools SET committed = committed + 6 WHERE pool_id = $1', [poolId]);
      // The second reservation waits for the first one's row lock and re-reads the committed amount after it.
      const blocked = failureOf(
        second.query('UPDATE budget_pools SET committed = committed + 6 WHERE pool_id = $1', [poolId]),
      );
      await first.query('COMMIT');
      expect(await blocked).toMatchObject({ code: CHECK, constraint: 'budget_pools_not_overspent' });
      await second.query('ROLLBACK');
    } finally {
      await first.end();
      await second.end();
    }
    const rows = await database.sql<{ committed: string }>('SELECT committed FROM budget_pools WHERE pool_id = $1', [
      poolId,
    ]);
    expect(Number(rows[0]?.committed)).toBe(6);
  });
});

describe('replay budgets (OQ-05 section 4, replay runs)', () => {
  it('give a replay one pool of batch compute seconds, which belongs to no mission or period budget', async () => {
    await replayRecord('rpl-pool', 'run-pool');
    await t.ok(
      `INSERT INTO budget_pools (scope, replay_id, dimension, limit_amount) VALUES ('REPLAY', 'rpl-pool', 'BATCH_COMPUTE_SECONDS', 360)`,
    );
    for (const values of [
      // another dimension than batch compute seconds
      `('REPLAY', 'rpl-pool', NULL, 'MODEL_SPEND', 1)`,
      // a mission as well as a replay
      `('REPLAY', 'rpl-pool', '${ids.mission}', 'BATCH_COMPUTE_SECONDS', 1)`,
      // no replay
      `('REPLAY', NULL, NULL, 'BATCH_COMPUTE_SECONDS', 1)`,
      // a mission pool that names a replay
      `('MISSION', 'rpl-pool', '${ids.mission}', 'PROVIDER_REQUESTS', 1)`,
    ]) {
      await t.violation(
        `INSERT INTO budget_pools (scope, replay_id, mission_id, dimension, limit_amount) VALUES ${values}`,
        [],
        { code: CHECK, constraint: 'budget_pools_scope_shape' },
      );
    }
    await t.violation(
      `INSERT INTO budget_pools (scope, replay_id, dimension, limit_amount) VALUES ('REPLAY', 'rpl-pool', 'BATCH_COMPUTE_SECONDS', 1)`,
      [],
      { code: UNIQUE, constraint: 'budget_pools_replay' },
    );
  });
});

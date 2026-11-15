// Constraint tests, part 3: retrieval and validation results, findings, Decisions, holdout consumption, official
// results and metrics, gate reports, eligibility, mission outcomes, commands and release records (OQ-02 sections
// 3.3, 3.6, 4 and 8; OQ-05 sections 4, 7 and 11). Each test breaks one invariant that a specification states.

import { describe, expect, it } from 'vitest';
import { useRolledBackTransaction } from './support/rollback.ts';
import { artefact, digests, ids, insertAttempt, insertJob, insertPool, insertRun, NOW, sha } from './support/seed.ts';

const t = useRolledBackTransaction();

const CHECK = '23514';
const UNIQUE = '23505';
const FOREIGN_KEY = '23503';

// A run that ended, with the one attempt that accepted its result.
async function endedRun(
  runId: string,
  attemptId: string,
  runSlot: string,
  runStatus: string,
  options: { window?: string; cost?: string } = {},
) {
  await insertRun(t.exec, {
    runId,
    status: runStatus,
    runSlot,
    windowRole: options.window ?? 'DEVELOPMENT',
    costScenario: options.cost ?? 'BASE',
  });
  const poolId = await insertPool(t.exec);
  await insertAttempt(t.exec, { attemptId, runId, poolId, status: 'COMPLETED' });
}

const insertResult = `INSERT INTO results (run_id, attempt_id, run_status, outcome, outcome_code, submission_digest, input_digest, result_digest,
    engine_digest, method_digest, executable_digest, recorded_at)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`;

async function resultValues(
  runId: string,
  attemptId: string,
  runStatus: string,
  outcome: string,
  code: string | null,
  withResult = true,
) {
  const submission = sha(`submission-${runId}-${attemptId}`);
  const result = sha(`result-${runId}-${attemptId}`);
  await artefact(t.exec, submission);
  await artefact(t.exec, result);
  return [
    runId,
    attemptId,
    runStatus,
    outcome,
    code,
    submission,
    null,
    withResult ? result : null,
    sha('engine'),
    sha('method'),
    sha('engine-batch'),
    NOW,
  ];
}

describe('official results (OQ-02 sections 3.6 and 8; A11)', () => {
  it('accepts one result for a completed run from its COMPLETED attempt', async () => {
    await endedRun('run-1', 'att-1', 'rs-d-base', 'COMPLETED');
    await t.ok(insertResult, await resultValues('run-1', 'att-1', 'COMPLETED', 'COMPLETED', null));
  });

  it('keeps one official result for a run, however often the submission is delivered', async () => {
    await endedRun('run-1', 'att-1', 'rs-d-base', 'COMPLETED');
    const poolId = await insertPool(t.exec);
    await insertAttempt(t.exec, { attemptId: 'att-2', runId: 'run-1', revision: 2, poolId, status: 'COMPLETED' });
    await t.ok(insertResult, await resultValues('run-1', 'att-1', 'COMPLETED', 'COMPLETED', null));
    await t.violation(insertResult, await resultValues('run-1', 'att-2', 'COMPLETED', 'COMPLETED', null), {
      code: UNIQUE,
      constraint: 'results_pkey',
    });
    await t.violation(insertResult, await resultValues('run-1', 'att-1', 'COMPLETED', 'COMPLETED', null), {
      code: UNIQUE,
    });
  });

  it('is accepted only from a COMPLETED attempt of the same run', async () => {
    await endedRun('run-1', 'att-1', 'rs-d-base', 'COMPLETED');
    await insertRun(t.exec, {
      runId: 'run-2',
      status: 'COMPLETED',
      runSlot: 'rs-d-stress',
      costScenario: 'COST_STRESS',
    });
    const poolId = await insertPool(t.exec);
    await insertAttempt(t.exec, { attemptId: 'att-claimed', runId: 'run-2', poolId, status: 'FAILED' });
    // The attempt that ended FAILED, or that belongs to another run, cannot be the accepting attempt.
    await t.violation(insertResult, await resultValues('run-2', 'att-claimed', 'COMPLETED', 'COMPLETED', null), {
      code: FOREIGN_KEY,
      constraint: 'results_accepting_attempt',
    });
    await t.violation(insertResult, await resultValues('run-2', 'att-1', 'COMPLETED', 'COMPLETED', null), {
      code: FOREIGN_KEY,
      constraint: 'results_accepting_attempt',
    });
    await t.violation(insertResult, await resultValues('run-9', 'att-1', 'COMPLETED', 'COMPLETED', null), {
      code: FOREIGN_KEY,
    });
  });

  it('maps its outcome to the run status of OQ-02 section 3.6', async () => {
    await endedRun('run-c', 'att-c', 'rs-d-base', 'COMPLETED');
    await endedRun('run-f', 'att-f', 'rs-d-stress', 'FAILED', { cost: 'COST_STRESS' });
    // COMPLETED and INSUFFICIENT give a COMPLETED run. FAILED and NOT_PREPARED give a FAILED run.
    await t.violation(insertResult, await resultValues('run-c', 'att-c', 'COMPLETED', 'FAILED', 'INVALID_LEVEL'), {
      code: CHECK,
      constraint: 'results_outcome_maps_to_run_status',
    });
    await t.violation(insertResult, await resultValues('run-f', 'att-f', 'FAILED', 'COMPLETED', null), {
      code: CHECK,
      constraint: 'results_outcome_maps_to_run_status',
    });
    await t.violation(insertResult, await resultValues('run-f', 'att-f', 'FAILED', 'INSUFFICIENT', 'NO_WINDOW'), {
      code: CHECK,
      constraint: 'results_outcome_maps_to_run_status',
    });
    // The recorded run status must be the status that the run has.
    await t.violation(insertResult, await resultValues('run-f', 'att-f', 'COMPLETED', 'INSUFFICIENT', 'NO_WINDOW'), {
      code: FOREIGN_KEY,
      constraint: 'results_run_status',
    });
    await t.ok(insertResult, await resultValues('run-f', 'att-f', 'FAILED', 'FAILED', 'FUTURE_DATA'));
  });

  it('has a code unless it completed, and no result file only when the run was not prepared', async () => {
    await endedRun('run-f', 'att-f', 'rs-d-base', 'FAILED');
    await t.violation(insertResult, await resultValues('run-f', 'att-f', 'FAILED', 'FAILED', null), {
      code: CHECK,
      constraint: 'results_code_when_not_completed',
    });
    await t.violation(
      insertResult,
      await resultValues('run-f', 'att-f', 'FAILED', 'NOT_PREPARED', 'INPUT_MISMATCH', true),
      {
        code: CHECK,
        constraint: 'results_result_unless_not_prepared',
      },
    );
    await t.violation(insertResult, await resultValues('run-f', 'att-f', 'FAILED', 'FAILED', 'INVALID_LEVEL', false), {
      code: CHECK,
      constraint: 'results_result_unless_not_prepared',
    });
    await t.ok(insertResult, await resultValues('run-f', 'att-f', 'FAILED', 'NOT_PREPARED', 'INPUT_MISMATCH', false));
  });

  it('cannot be changed or removed, and pins the status of its run and attempt', async () => {
    await endedRun('run-1', 'att-1', 'rs-d-base', 'COMPLETED');
    await t.ok(insertResult, await resultValues('run-1', 'att-1', 'COMPLETED', 'COMPLETED', null));
    await t.violation(`UPDATE results SET outcome = 'FAILED'`, [], { code: CHECK, constraint: 'results_immutable' });
    await t.violation(`DELETE FROM results`, [], { code: CHECK, constraint: 'results_immutable' });
    // A completed run with a result cannot move: COMPLETED is terminal, and the foreign key keeps the pair.
    await t.violation(`UPDATE runs SET status = 'RUNNING', completed_at = NULL WHERE run_id = 'run-1'`, [], {
      code: CHECK,
      constraint: 'run_transition',
    });
  });
});

describe('official metrics (OQ-02 section 3.6)', () => {
  const insertMetrics = `INSERT INTO metrics (run_id, metrics_digest, method_digest, metric_scale, recorded_at) VALUES ($1, $2, $3, 6, $4)`;

  it('exist only for a run whose outcome is COMPLETED', async () => {
    await endedRun('run-c', 'att-c', 'rs-d-base', 'COMPLETED');
    await endedRun('run-i', 'att-i', 'rs-d-stress', 'COMPLETED', { cost: 'COST_STRESS' });
    await endedRun('run-f', 'att-f', 'rs-v-base', 'FAILED', { window: 'VALIDATION' });
    await t.ok(insertResult, await resultValues('run-c', 'att-c', 'COMPLETED', 'COMPLETED', null));
    await t.ok(insertResult, await resultValues('run-i', 'att-i', 'COMPLETED', 'INSUFFICIENT', 'NO_WINDOW'));
    await t.ok(insertResult, await resultValues('run-f', 'att-f', 'FAILED', 'FAILED', 'FUTURE_DATA'));
    const metrics = sha('metrics');
    await artefact(t.exec, metrics);
    await t.violation(insertMetrics, ['run-i', metrics, sha('method'), NOW], {
      code: FOREIGN_KEY,
      constraint: 'metrics_result',
    });
    await t.violation(insertMetrics, ['run-f', metrics, sha('method'), NOW], {
      code: FOREIGN_KEY,
      constraint: 'metrics_result',
    });
    await t.violation(insertMetrics, ['run-none', metrics, sha('method'), NOW], {
      code: FOREIGN_KEY,
      constraint: 'metrics_result',
    });
    await t.ok(insertMetrics, ['run-c', metrics, sha('method'), NOW]);
    await t.violation(insertMetrics, ['run-c', metrics, sha('method'), NOW], {
      code: UNIQUE,
      constraint: 'metrics_pkey',
    });
    await t.violation(`UPDATE metrics SET metric_scale = 2`, [], { code: CHECK, constraint: 'metrics_immutable' });
  });

  it('has a metric scale of at most 12', async () => {
    await endedRun('run-c', 'att-c', 'rs-d-base', 'COMPLETED');
    await t.ok(insertResult, await resultValues('run-c', 'att-c', 'COMPLETED', 'COMPLETED', null));
    const metrics = sha('metrics');
    await artefact(t.exec, metrics);
    await t.violation(
      `INSERT INTO metrics (run_id, metrics_digest, method_digest, metric_scale, recorded_at) VALUES ('run-c', $1, $2, 13, $3)`,
      [metrics, sha('method'), NOW],
      { code: CHECK },
    );
  });
});

describe('holdout consumption (OQ-02 section 3.3; A05)', () => {
  it('is recorded once for a HOLDOUT run and for no other run, and cannot be removed', async () => {
    await insertRun(t.exec, { runId: 'run-h', runSlot: 'rs-h-base', windowRole: 'HOLDOUT' });
    await insertRun(t.exec, { runId: 'run-d', runSlot: 'rs-d-base' });
    const insert = `INSERT INTO holdout_consumption (run_id, revealed_by, revealed_at) VALUES ($1, $2, $3)`;
    await t.violation(insert, ['run-d', ids.researcher, NOW], {
      code: FOREIGN_KEY,
      constraint: 'holdout_consumption_run',
    });
    await t.violation(insert, ['run-none', ids.researcher, NOW], {
      code: FOREIGN_KEY,
      constraint: 'holdout_consumption_run',
    });
    await t.ok(insert, ['run-h', ids.researcher, NOW]);
    await t.violation(insert, ['run-h', ids.admin, NOW], { code: UNIQUE, constraint: 'holdout_consumption_pkey' });
    await t.violation(`DELETE FROM holdout_consumption`, [], {
      code: CHECK,
      constraint: 'holdout_consumption_immutable',
    });
    await t.violation(`UPDATE holdout_consumption SET revealed_by = $1`, [ids.admin], {
      code: CHECK,
      constraint: 'holdout_consumption_immutable',
    });
  });
});

describe('retrieval and validation results (OQ-05 sections 4 and 7.1)', () => {
  async function completedJob(jobId: string, kind: string, attemptId: string) {
    await insertJob(t.exec, { jobId, kind, status: 'COMPLETED' });
    const poolId = await insertPool(t.exec);
    await insertAttempt(t.exec, { attemptId, jobId, poolId, status: 'COMPLETED' });
  }
  const insertRetrieval = `INSERT INTO retrieval_results (job_id, attempt_id, result_digest, outcome, manifest_digest, error_class, retryable, recorded_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`;

  it('records a snapshot for a successful retrieval and a class for a failed one', async () => {
    await completedJob('job-r', 'retrieve', 'att-r');
    const result = sha('retrieval-result');
    await artefact(t.exec, result);
    await artefact(t.exec, digests.manifest);
    await t.violation(insertRetrieval, ['job-r', 'att-r', result, 'COMPLETE', null, null, null, NOW], {
      code: CHECK,
      constraint: 'retrieval_results_snapshot_iff_success',
    });
    await t.violation(insertRetrieval, ['job-r', 'att-r', result, 'FAILED', digests.manifest, 'TIMEOUT', true, NOW], {
      code: CHECK,
      constraint: 'retrieval_results_snapshot_iff_success',
    });
    await t.violation(insertRetrieval, ['job-r', 'att-r', result, 'FAILED', null, null, null, NOW], {
      code: CHECK,
      constraint: 'retrieval_results_failure_shape',
    });
    await t.violation(insertRetrieval, ['job-r', 'att-r', result, 'COMPLETE', digests.manifest, 'TIMEOUT', true, NOW], {
      code: CHECK,
      constraint: 'retrieval_results_failure_shape',
    });
    await t.violation(insertRetrieval, ['job-r', 'att-r', result, 'FAILED', null, 'DISK_FULL', false, NOW], {
      code: CHECK,
    });
    await t.ok(insertRetrieval, ['job-r', 'att-r', result, 'FAILED', null, 'TIMEOUT', true, NOW]);
  });

  it('never marks authentication, permission, capability, cancellation or egress refusal as retryable', async () => {
    await completedJob('job-r', 'retrieve', 'att-r');
    const result = sha('retrieval-result');
    await artefact(t.exec, result);
    for (const errorClass of [
      'AUTHENTICATION',
      'PERMISSION',
      'UNSUPPORTED_CAPABILITY',
      'CANCELLED',
      'EGRESS_REFUSED',
    ]) {
      await t.violation(insertRetrieval, ['job-r', 'att-r', result, 'FAILED', null, errorClass, true, NOW], {
        code: CHECK,
        constraint: 'retrieval_results_never_retry',
      });
    }
    for (const errorClass of ['RATE_LIMITED', 'TIMEOUT', 'UNAVAILABLE_DATA', 'MALFORMED_RESPONSE']) {
      await t.ok('SAVEPOINT transient');
      await t.ok(insertRetrieval, ['job-r', 'att-r', result, 'FAILED', null, errorClass, true, NOW]);
      await t.ok('ROLLBACK TO SAVEPOINT transient');
    }
  });

  it('freezes one snapshot for a mission', async () => {
    await completedJob('job-r', 'retrieve', 'att-r');
    await artefact(t.exec, digests.manifest);
    const insert = `INSERT INTO dataset_manifests (manifest_digest, mission_id, job_id, completeness, retrieved_at) VALUES ($1, $2, 'job-r', $3, $4)`;
    await t.violation(insert, [digests.manifest, ids.mission, 'MOSTLY', NOW], { code: CHECK });
    await t.ok(insert, [digests.manifest, ids.mission, 'PARTIAL', NOW]);
    await artefact(t.exec, sha('second-manifest'));
    await t.violation(insert, [sha('second-manifest'), ids.mission, 'COMPLETE', NOW], {
      code: UNIQUE,
      constraint: 'dataset_manifests_one_snapshot_per_mission',
    });
    await t.violation(`UPDATE dataset_manifests SET completeness = 'COMPLETE'`, [], {
      code: CHECK,
      constraint: 'dataset_manifests_immutable',
    });
  });

  it('registers a Strategy Version only for a VALID validation result, with a scope only when valid', async () => {
    await completedJob('job-v', 'validate', 'att-v');
    const insert = `INSERT INTO validation_results (job_id, attempt_id, result_digest, draft_digest, status, change_scope, strategy_hash, recorded_at)
      VALUES ('job-v', 'att-v', $1, $2, $3, $4, $5, $6)`;
    const result = sha('validation-result');
    await artefact(t.exec, result);
    await t.violation(insert, [result, digests.seedDraft, 'INVALID', null, digests.seedStrategy, NOW], {
      code: CHECK,
      constraint: 'validation_results_registered_only_when_valid',
    });
    await t.violation(insert, [result, digests.seedDraft, 'INVALID', 'ENTRY', null, NOW], {
      code: CHECK,
      constraint: 'validation_results_scope_only_when_valid',
    });
    await t.violation(insert, [result, digests.seedDraft, 'MAYBE', null, null, NOW], { code: CHECK });
    await t.ok(insert, [result, digests.seedDraft, 'VALID', 'ENTRY', digests.revisionStrategy, NOW]);
  });
});

describe('findings and their treatment (OQ-02 sections 3.6 and 4)', () => {
  async function critiqueAttempt() {
    await insertJob(t.exec, { jobId: 'job-c', kind: 'agent', status: 'COMPLETED' });
    const poolId = await insertPool(t.exec);
    await insertAttempt(t.exec, { attemptId: 'att-c', jobId: 'job-c', poolId, status: 'COMPLETED' });
    await artefact(t.exec, sha('critique'));
  }
  const insertFinding = `INSERT INTO findings (finding_id, mission_id, strategy_hash, attempt_id, critique_digest, ordinal, category, finding_source,
      affects_executable_rule, required_evidence, recorded_at)
    VALUES ($1, $2, $3, 'att-c', $4, $5, $6, 'critic', false, false, $7)`;

  it('uses only the eleven categories, and keeps each position of a critique once', async () => {
    await critiqueAttempt();
    await t.violation(
      insertFinding,
      ['f-1', ids.mission, digests.seedStrategy, sha('critique'), 1, 'style_preference', NOW],
      { code: CHECK },
    );
    await t.ok(insertFinding, ['f-1', ids.mission, digests.seedStrategy, sha('critique'), 1, 'causal_leakage', NOW]);
    await t.violation(
      insertFinding,
      ['f-2', ids.mission, digests.seedStrategy, sha('critique'), 1, 'method_advice', NOW],
      {
        code: UNIQUE,
        constraint: 'findings_position',
      },
    );
    await t.violation(`UPDATE findings SET category = 'method_advice'`, [], {
      code: CHECK,
      constraint: 'findings_immutable',
    });
    await t.violation(`DELETE FROM findings`, [], { code: CHECK, constraint: 'findings_immutable' });
  });

  it('assigns a treatment per transition, never blocking DRAFT to EVALUATING in S1, and resolves it once', async () => {
    await critiqueAttempt();
    await t.ok(insertFinding, ['f-1', ids.mission, digests.seedStrategy, sha('critique'), 1, 'causal_leakage', NOW]);
    const insert = `INSERT INTO finding_treatments (finding_id, transition, treatment, policy_id, policy_revision, assigned_at) VALUES ('f-1', $1, $2, $3, 1, $4)`;
    await t.violation(insert, ['DRAFT_TO_EVALUATING', 'BLOCKING', ids.policy, NOW], {
      code: CHECK,
      constraint: 'finding_treatments_s1_no_block_on_draft',
    });
    await t.violation(insert, ['EVALUATING_TO_LIVE', 'BLOCKING', ids.policy, NOW], { code: CHECK });
    await t.violation(insert, ['EVALUATING_TO_PAPER', 'DISMISSED', ids.policy, NOW], { code: CHECK });
    await t.violation(insert, ['EVALUATING_TO_PAPER', 'BLOCKING', 'policy-none', NOW], {
      code: FOREIGN_KEY,
      constraint: 'finding_treatments_policy',
    });
    await t.ok(insert, ['EVALUATING_TO_PAPER', 'BLOCKING', ids.policy, NOW]);
    await t.violation(insert, ['EVALUATING_TO_PAPER', 'ADVISORY', ids.policy, NOW], {
      code: UNIQUE,
      constraint: 'finding_treatments_pkey',
    });
    await t.violation(`UPDATE finding_treatments SET treatment = 'ADVISORY'`, [], {
      code: CHECK,
      constraint: 'finding_treatments_immutable',
    });
    await t.violation(`UPDATE finding_treatments SET resolved_by = $1`, [ids.steward], {
      code: CHECK,
      constraint: 'finding_treatments_resolution_pair',
    });
    await t.ok(`UPDATE finding_treatments SET resolved_by = $1, resolved_at = $2`, [ids.steward, NOW]);
    await t.violation(`UPDATE finding_treatments SET resolved_by = $1, resolved_at = $2`, [ids.admin, NOW], {
      code: CHECK,
      constraint: 'finding_treatments_immutable',
    });
    await t.violation(`DELETE FROM finding_treatments`, [], {
      code: CHECK,
      constraint: 'finding_treatments_immutable',
    });
  });
});

describe('Decisions (OQ-02 sections 1 and 4)', () => {
  const decision = async (overrides: Record<string, unknown> = {}) => {
    const row: Record<string, unknown> = {
      decision_id: 'dec-1',
      kind: 'DRAFT_TO_EVALUATING',
      outcome: 'APPROVED',
      actor_id: ids.workflows,
      actor_kind: 'SERVICE',
      policy_id: ids.policy,
      policy_revision: 1,
      mission_id: ids.mission,
      trial_slot: ids.seedSlot,
      strategy_hash: digests.seedStrategy,
      plan_digest: digests.plan,
      policy_approval_decision: ids.approval,
      mission_started_by: ids.researcher,
      critique_status: 'COMPLETED',
      critique_digest: sha('critique'),
      reason: null,
      decided_at: NOW,
      ...overrides,
    };
    await artefact(t.exec, sha('critique'));
    const columns = Object.keys(row);
    return [
      `INSERT INTO decisions (${columns.join(', ')}) VALUES (${columns.map((_, index) => `$${index + 1}`).join(', ')})`,
      columns.map((column) => row[column]),
    ] as const;
  };

  it('records a policy-determined DRAFT to EVALUATING Decision under an approved policy', async () => {
    await t.ok(...(await decision()));
  });

  it('has no EVALUATING to PAPER Decision in S1, and no other kind', async () => {
    await t.violation(...(await decision({ kind: 'EVALUATING_TO_PAPER' })), {
      code: CHECK,
      constraint: 'decisions_kind_check',
    });
    await t.violation(...(await decision({ kind: 'LIVE_ACTIVATION' })), {
      code: CHECK,
      constraint: 'decisions_kind_check',
    });
  });

  it('is made by the workflows service for a draft and by a person for a policy approval', async () => {
    await t.violation(...(await decision({ actor_id: ids.steward, actor_kind: 'HUMAN' })), {
      code: CHECK,
      constraint: 'decisions_kind_shape',
    });
    await t.violation(
      ...(await decision({
        decision_id: 'dec-p',
        kind: 'POLICY_APPROVAL',
        actor_id: ids.workflows,
        actor_kind: 'SERVICE',
        mission_id: null,
        trial_slot: null,
        strategy_hash: null,
        plan_digest: null,
        policy_approval_decision: null,
        mission_started_by: null,
        critique_status: null,
        critique_digest: null,
      })),
      { code: CHECK, constraint: 'decisions_kind_shape' },
    );
    await t.violation(...(await decision({ actor_id: ids.researcher })), {
      code: FOREIGN_KEY,
      constraint: 'decisions_actor',
    });
  });

  it('names the approval, the Researcher who started the mission and the policy of the mission', async () => {
    await t.violation(...(await decision({ policy_approval_decision: null })), {
      code: CHECK,
      constraint: 'decisions_kind_shape',
    });
    await t.violation(...(await decision({ mission_started_by: null })), {
      code: CHECK,
      constraint: 'decisions_kind_shape',
    });
    await t.violation(...(await decision({ mission_started_by: ids.admin })), {
      code: FOREIGN_KEY,
      constraint: 'decisions_mission_started_by',
    });
    await t.violation(...(await decision({ policy_approval_decision: 'dec-nowhere' })), {
      code: FOREIGN_KEY,
      constraint: 'decisions_policy_approval',
    });
  });

  it('names an APPROVED approval of the policy revision of the mission, not another revision and not a rejected one', async () => {
    await t.ok(
      `INSERT INTO cohort_policies (policy_id, revision, suite_id, document_digest, registered_by, registered_at) VALUES ($1, 2, 's1-suite', $2, $3, $4)`,
      [ids.policy, digests.capDoc, ids.steward, NOW],
    );
    await t.ok(
      `INSERT INTO decisions (decision_id, kind, outcome, actor_id, actor_kind, policy_id, policy_revision, decided_at)
       VALUES ('approval-2', 'POLICY_APPROVAL', 'APPROVED', $1, 'HUMAN', $2, 2, $3)`,
      [ids.steward, ids.policy, NOW],
    );
    // The mission uses revision 1: an approval of revision 2 cannot stand in for it, and revision 2 is not its policy.
    await t.violation(...(await decision({ policy_approval_decision: 'approval-2' })), {
      code: FOREIGN_KEY,
      constraint: 'decisions_policy_approval',
    });
    await t.violation(...(await decision({ policy_revision: 2, policy_approval_decision: 'approval-2' })), {
      code: FOREIGN_KEY,
      constraint: 'decisions_mission_policy',
    });
  });

  it('does not accept a REJECTED approval as the authority of a Decision', async () => {
    // Decisions are immutable, so the seeded approval is rewritten as a rejection in this transaction only.
    await t.ok('ALTER TABLE decisions DISABLE TRIGGER decisions_immutable');
    await t.ok(`UPDATE decisions SET outcome = 'REJECTED' WHERE decision_id = $1`, [ids.approval]);
    await t.ok('ALTER TABLE decisions ENABLE TRIGGER decisions_immutable');
    await t.violation(...(await decision()), { code: FOREIGN_KEY, constraint: 'decisions_policy_approval' });
  });

  it('approves a policy revision once, and decides a slot once', async () => {
    await t.violation(
      `INSERT INTO decisions (decision_id, kind, outcome, actor_id, actor_kind, policy_id, policy_revision, decided_at)
       VALUES ('approval-again', 'POLICY_APPROVAL', 'APPROVED', $1, 'HUMAN', $2, 1, $3)`,
      [ids.steward, ids.policy, NOW],
      { code: UNIQUE, constraint: 'decisions_one_approval_per_policy' },
    );
    await t.ok(...(await decision()));
    await t.violation(...(await decision({ decision_id: 'dec-2', outcome: 'REJECTED' })), {
      code: UNIQUE,
      constraint: 'decisions_one_per_slot',
    });
  });

  it('is DEFERRED exactly when the critique ended without a valid result, and then names its reason', async () => {
    await t.violation(...(await decision({ outcome: 'DEFERRED', reason: 'refusal' })), {
      code: CHECK,
      constraint: 'decisions_deferred_iff_no_critique',
    });
    await t.violation(...(await decision({ critique_status: 'NO_VALID_RESULT', critique_digest: null })), {
      code: CHECK,
      constraint: 'decisions_deferred_iff_no_critique',
    });
    await t.violation(
      ...(await decision({ outcome: 'DEFERRED', critique_status: 'NO_VALID_RESULT', critique_digest: null })),
      {
        code: CHECK,
        constraint: 'decisions_deferred_has_reason',
      },
    );
    await t.violation(...(await decision({ critique_status: 'COMPLETED', critique_digest: null })), {
      code: CHECK,
      constraint: 'decisions_critique_result',
    });
    await t.ok(
      ...(await decision({
        outcome: 'DEFERRED',
        critique_status: 'NO_VALID_RESULT',
        critique_digest: null,
        reason: 'The critique ended with refusal after 1 attempt.',
      })),
    );
  });

  it('cannot be changed or removed', async () => {
    await t.ok(...(await decision()));
    await t.violation(`UPDATE decisions SET outcome = 'REJECTED'`, [], {
      code: CHECK,
      constraint: 'decisions_immutable',
    });
    await t.violation(`DELETE FROM decisions`, [], { code: CHECK, constraint: 'decisions_immutable' });
  });
});

describe('gate reports, eligibility and mission outcomes (OQ-02 sections 3.6 and 4)', () => {
  async function assessJob(jobId: string, attemptId: string, reportLabel: string, strategyHash = digests.seedStrategy) {
    await insertJob(t.exec, { jobId, kind: 'assess', status: 'COMPLETED' });
    const poolId = await insertPool(t.exec);
    await insertAttempt(t.exec, { attemptId, jobId, poolId, status: 'COMPLETED' });
    const report = sha(reportLabel);
    await artefact(t.exec, report);
    return [
      report,
      ids.mission,
      jobId,
      attemptId,
      strategyHash,
      digests.plan,
      ids.policy,
      1,
      sha('method'),
      NOW,
    ] as const;
  }
  const insertReport = `INSERT INTO gate_reports (report_digest, mission_id, job_id, attempt_id, strategy_hash, plan_digest, policy_id, policy_revision, method_digest, recorded_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`;
  const insertGate = `INSERT INTO gate_results (report_digest, gate_id, category, result, reason_code) VALUES ($1, $2, $3, $4, $5)`;

  it('has one report for each candidate of a mission, and each gate once in a report', async () => {
    const first = await assessJob('job-a1', 'att-a1', 'report-1');
    await t.ok(insertReport, [...first]);
    const second = await assessJob('job-a2', 'att-a2', 'report-2');
    await t.violation(insertReport, [...second], { code: UNIQUE, constraint: 'gate_reports_one_per_candidate' });
    await t.ok(insertReport, [...(await assessJob('job-a3', 'att-a3', 'report-3', digests.revisionStrategy))]);
    const [report] = first;
    await t.ok(insertGate, [report, 'DEFINITION_VALIDATION', 'CORRECTNESS', 'PASS', null]);
    await t.violation(insertGate, [report, 'DEFINITION_VALIDATION', 'CORRECTNESS', 'FAIL', null], {
      code: UNIQUE,
      constraint: 'gate_results_pkey',
    });
    await t.violation(insertGate, [report, 'LUCK', 'CORRECTNESS', 'PASS', null], { code: CHECK });
    await t.violation(insertGate, [report, 'WALK_FORWARD', 'EVERYTHING', 'PASS', null], { code: CHECK });
    await t.violation(insertGate, [sha('no-report'), 'WALK_FORWARD', 'HISTORICAL_VALIDITY', 'PASS', null], {
      code: FOREIGN_KEY,
    });
  });

  it('gives INSUFFICIENT and NOT_APPLICABLE a reason code, and PASS and FAIL none', async () => {
    const first = await assessJob('job-a1', 'att-a1', 'report-1');
    await t.ok(insertReport, [...first]);
    const [report] = first;
    await t.violation(insertGate, [report, 'PARAMETER_SENSITIVITY', 'ROBUSTNESS', 'INSUFFICIENT', null], {
      code: CHECK,
      constraint: 'gate_results_reason_iff_undecided',
    });
    await t.violation(insertGate, [report, 'RESAMPLING', 'ROBUSTNESS', 'NOT_APPLICABLE', null], {
      code: CHECK,
      constraint: 'gate_results_reason_iff_undecided',
    });
    await t.violation(insertGate, [report, 'WALK_FORWARD', 'HISTORICAL_VALIDITY', 'PASS', 'POLICY_RECORDED'], {
      code: CHECK,
      constraint: 'gate_results_reason_iff_undecided',
    });
    await t.violation(insertGate, [report, 'WALK_FORWARD', 'HISTORICAL_VALIDITY', 'FAIL', 'BELOW_THRESHOLD'], {
      code: CHECK,
      constraint: 'gate_results_reason_iff_undecided',
    });
    await t.violation(insertGate, [report, 'RESAMPLING', 'ROBUSTNESS', 'INSUFFICIENT', 'BECAUSE'], { code: CHECK });
    await t.ok(insertGate, [report, 'PARAMETER_SENSITIVITY', 'ROBUSTNESS', 'INSUFFICIENT', 'POLICY_RECORDED']);
    await t.violation(`UPDATE gate_results SET result = 'PASS', reason_code = NULL`, [], {
      code: CHECK,
      constraint: 'gate_results_immutable',
    });
  });

  it('records eligibility from a report of the same candidate, with reasons when it is not eligible', async () => {
    const first = await assessJob('job-a1', 'att-a1', 'report-1');
    await t.ok(insertReport, [...first]);
    const [report] = first;
    const insert = `INSERT INTO eligibility (mission_id, strategy_hash, report_digest, state, reasons, recorded_at) VALUES ($1, $2, $3, $4, $5, $6)`;
    await t.violation(insert, [ids.mission, digests.seedStrategy, report, 'NOT_ELIGIBLE', '[]', NOW], {
      code: CHECK,
      constraint: 'eligibility_not_eligible_has_reasons',
    });
    await t.violation(insert, [ids.mission, digests.revisionStrategy, report, 'NOT_ELIGIBLE', '["x"]', NOW], {
      code: FOREIGN_KEY,
      constraint: 'eligibility_report',
    });
    await t.violation(insert, [ids.mission, digests.seedStrategy, report, 'MAYBE', '[]', NOW], { code: CHECK });
    await t.ok(insert, [
      ids.mission,
      digests.seedStrategy,
      report,
      'NOT_ELIGIBLE',
      '["Parameter sensitivity is INSUFFICIENT."]',
      NOW,
    ]);
    await t.violation(insert, [ids.mission, digests.seedStrategy, report, 'ELIGIBLE', '[]', NOW], {
      code: UNIQUE,
      constraint: 'eligibility_pkey',
    });
  });

  it('closes a mission with the outcome that the mission itself carries', async () => {
    const insert = `INSERT INTO mission_outcomes (mission_id, outcome, slot_reasons, recorded_at) VALUES ($1, $2, $3, $4)`;
    // The mission is IN_PROGRESS: it has no outcome to repeat.
    await t.violation(insert, [ids.mission, 'NO_ELIGIBLE_CANDIDATE', '[{"slot":"slot-seed"}]', NOW], {
      code: FOREIGN_KEY,
      constraint: 'mission_outcomes_mission',
    });
    await t.ok(
      `UPDATE missions SET status = 'CONCLUDED', outcome = 'NO_ELIGIBLE_CANDIDATE', outcome_reason = 'No candidate passed.', concluded_at = '${NOW}'`,
    );
    await t.violation(insert, [ids.mission, 'ELIGIBLE_FOUND', '[{"slot":"slot-seed"}]', NOW], {
      code: FOREIGN_KEY,
      constraint: 'mission_outcomes_mission',
    });
    await t.violation(insert, [ids.mission, 'NO_ELIGIBLE_CANDIDATE', '[]', NOW], { code: CHECK });
    await t.ok(insert, [ids.mission, 'NO_ELIGIBLE_CANDIDATE', '[{"slot":"slot-seed"}]', NOW]);
    await t.violation(`UPDATE mission_outcomes SET outcome = 'ELIGIBLE_FOUND'`, [], {
      code: CHECK,
      constraint: 'mission_outcomes_immutable',
    });
    // The conclusion of the mission cannot change while the outcome record names it.
    await t.violation(`UPDATE missions SET outcome = 'ELIGIBLE_FOUND'`, [], { code: FOREIGN_KEY });
  });
});

describe('commands and release records (OQ-05 sections 3 and 11)', () => {
  const insertCommand = `INSERT INTO commands (command_id, kind, actor_id, body_digest, expected_revision, received_at) VALUES ($1, $2, $3, $4, $5, $6)`;

  it('has the nine command kinds, and a client command ID that appears once', async () => {
    await t.ok(insertCommand, ['cmd-1', 'create_mission', ids.researcher, sha('body-1'), 0, NOW]);
    await t.violation(insertCommand, ['cmd-1', 'create_mission', ids.researcher, sha('body-2'), 0, NOW], {
      code: UNIQUE,
      constraint: 'commands_pkey',
    });
    await t.violation(insertCommand, ['cmd-2', 'place_order', ids.researcher, sha('body-2'), 0, NOW], { code: CHECK });
    await t.violation(insertCommand, ['cmd-3', 'create_mission', ids.researcher, sha('body-3'), -1, NOW], {
      code: CHECK,
    });
    await t.violation(insertCommand, ['cmd 4', 'create_mission', ids.researcher, sha('body-4'), 0, NOW], {
      code: CHECK,
      constraint: 'oq_identifier_pattern',
    });
  });

  it('is PENDING, APPLIED with the record it produced, or REJECTED with an error code', async () => {
    await t.ok(insertCommand, ['cmd-1', 'create_mission', ids.researcher, sha('body-1'), 0, NOW]);
    await t.violation(`UPDATE commands SET state = 'APPLIED', applied_at = '${NOW}'`, [], {
      code: CHECK,
      constraint: 'commands_state_shape',
    });
    await t.violation(`UPDATE commands SET state = 'REJECTED', rejected_at = '${NOW}', error_code = 'FORBIDDEN'`, [], {
      code: CHECK,
      constraint: 'commands_state_shape',
    });
    await t.violation(`UPDATE commands SET error_code = 'FORBIDDEN', error_message = 'x'`, [], {
      code: CHECK,
      constraint: 'commands_state_shape',
    });
    await t.violation(
      `UPDATE commands SET state = 'REJECTED', rejected_at = '${NOW}', error_code = 'TEAPOT', error_message = 'x'`,
      [],
      { code: CHECK },
    );
    await t.ok(
      `UPDATE commands SET state = 'APPLIED', applied_at = '${NOW}', record_id = 'mission-9', record_revision = 1`,
    );
  });

  it('leaves PENDING once, and then never changes', async () => {
    await t.ok(insertCommand, ['cmd-1', 'create_mission', ids.researcher, sha('body-1'), 0, NOW]);
    await t.ok(
      `UPDATE commands SET state = 'REJECTED', rejected_at = '${NOW}', error_code = 'POLICY_VIOLATION', error_message = 'Over the maxima.'`,
    );
    await t.violation(
      `UPDATE commands SET state = 'APPLIED', applied_at = '${NOW}', rejected_at = NULL, error_code = NULL, error_message = NULL, record_id = 'x', record_revision = 1`,
      [],
      { code: CHECK, constraint: 'commands_immutable' },
    );
    await t.violation(`DELETE FROM commands`, [], { code: CHECK, constraint: 'commands_immutable' });
  });

  it('keeps the body digest of a pending command', async () => {
    await t.ok(insertCommand, ['cmd-1', 'create_mission', ids.researcher, sha('body-1'), 0, NOW]);
    await t.violation(`UPDATE commands SET body_digest = $1`, [sha('other')], {
      code: CHECK,
      constraint: 'commands_immutable',
    });
    await t.violation(`UPDATE commands SET actor_id = $1`, [ids.admin], {
      code: CHECK,
      constraint: 'commands_immutable',
    });
  });

  const manifest = (overrides: Record<string, unknown> = {}) => ({
    schema_version: 'release-manifest/1',
    environment: 'DEVELOPMENT',
    source_commit: 'a'.repeat(40),
    migration_level: '0007_control',
    ...overrides,
  });
  const insertRelease = `INSERT INTO release_records (environment, source_commit, manifest_digest, migration_level, document, recorded_by, recorded_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7)`;

  it('keeps the release manifest whole and records each manifest once per environment', async () => {
    const document = manifest();
    await t.ok(insertRelease, [
      'DEVELOPMENT',
      'a'.repeat(40),
      sha('manifest-1'),
      '0007_control',
      JSON.stringify(document),
      ids.deploy,
      NOW,
    ]);
    await t.violation(
      insertRelease,
      ['DEVELOPMENT', 'a'.repeat(40), sha('manifest-1'), '0007_control', JSON.stringify(document), ids.deploy, NOW],
      { code: UNIQUE, constraint: 'release_records_once_per_environment' },
    );
    await t.ok(insertRelease, [
      'DEVELOPMENT',
      'a'.repeat(40),
      sha('manifest-2'),
      '0007_control',
      JSON.stringify(document),
      ids.admin,
      NOW,
    ]);
    const rows = await t.ok(
      `SELECT release_id FROM release_records WHERE environment = 'DEVELOPMENT' ORDER BY release_id DESC`,
    );
    expect(rows).toHaveLength(2);
  });

  it('refuses a document that disagrees with the columns that index it', async () => {
    const bad = async (document: Record<string, unknown>) =>
      t.violation(
        insertRelease,
        ['DEVELOPMENT', 'a'.repeat(40), sha('manifest-x'), '0007_control', JSON.stringify(document), ids.deploy, NOW],
        { code: CHECK, constraint: 'release_records_document_matches' },
      );
    await bad(manifest({ environment: 'STAGING' }));
    await bad(manifest({ source_commit: 'b'.repeat(40) }));
    await bad(manifest({ migration_level: '0006_evidence' }));
    await bad(manifest({ schema_version: 'release-manifest/2' }));
    await t.violation(
      insertRelease,
      [
        'DEVELOPMENT',
        'xyz',
        sha('manifest-x'),
        '0007_control',
        JSON.stringify(manifest({ source_commit: 'xyz' })),
        ids.deploy,
        NOW,
      ],
      { code: CHECK },
    );
    await t.ok(insertRelease, [
      'DEVELOPMENT',
      'a'.repeat(40),
      sha('manifest-y'),
      '0007_control',
      JSON.stringify(manifest()),
      ids.deploy,
      NOW,
    ]);
    await t.violation(`UPDATE release_records SET migration_level = '0001_identity'`, [], {
      code: CHECK,
      constraint: 'release_records_immutable',
    });
    await t.violation(`DELETE FROM release_records`, [], { code: CHECK, constraint: 'release_records_immutable' });
  });
});

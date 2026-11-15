// The documents of an assessment: the gate report that the Rust assess job writes from the official results of one
// candidate and the registered cohort policy. The report is derived here from the policy fixture and the rows that the
// run results left behind; the values of the gates are chosen by the test, as the job's own calculation would choose them.

import type { Claimed, Flow, Started } from './flow.ts';
import { ENGINE_BATCH } from './flow.ts';
import type { Doc } from './world.ts';

export type Decided = 'PASS' | 'FAIL' | 'INSUFFICIENT';

/** What the S1 pilot job would report for a candidate that loses to buy-and-hold: no gate of the robustness suite passes. */
export const NOT_ELIGIBLE: Readonly<Record<string, Decided>> = {
  DEFINITION_VALIDATION: 'PASS',
  DETERMINISTIC_REPLAY: 'PASS',
  ACCOUNTING_RECONCILIATION: 'PASS',
  SIGNAL_DATA_TIMING: 'PASS',
  POINT_IN_TIME_DATA: 'PASS',
  BASE_COST_MODEL: 'PASS',
  EXCESS_OVER_BUY_AND_HOLD: 'FAIL',
  WALK_FORWARD: 'FAIL',
  MINIMUM_TRADE_COUNT: 'INSUFFICIENT',
  COST_STRESS: 'FAIL',
};

export async function gateReportFor(
  flow: Flow & Started,
  claimed: Pick<Claimed, 'attemptId' | 'ownershipRevision'>,
  jobId: string,
  strategyHash: string,
  decided: Readonly<Record<string, Decided>> = NOT_ELIGIBLE,
): Promise<Doc> {
  const { world } = flow;
  const policy = world.docs.policy;
  const [plan] = await world.sql<{ plan_digest: string }>(
    'SELECT plan_digest FROM evaluation_plans WHERE mission_id = $1',
    [flow.missionId],
  );
  const [validation] = await world.sql<{ result_digest: string }>(
    'SELECT result_digest FROM validation_results WHERE strategy_hash = $1',
    [strategyHash],
  );
  const manifests = await world.sql<{ manifest_digest: string }>(
    'SELECT manifest_digest FROM dataset_manifests WHERE mission_id = $1',
    [flow.missionId],
  );
  const runs = await world.sql<{
    run_id: string;
    window_role: string;
    cost_scenario: string;
    submission_digest: string;
    result_digest: string | null;
    metrics_digest: string | null;
  }>(
    `SELECT r.run_id, r.window_role, r.cost_scenario, s.submission_digest, s.result_digest, m.metrics_digest
       FROM runs r JOIN results s ON s.run_id = r.run_id LEFT JOIN metrics m ON m.run_id = r.run_id
      WHERE r.mission_id = $1 AND r.strategy_hash = $2 ORDER BY r.run_slot`,
    [flow.missionId, strategyHash],
  );
  const inputs: Doc[] = [
    { kind: 'EVALUATION_PLAN', digest: plan?.plan_digest },
    { kind: 'VALIDATION_RESULT', digest: validation?.result_digest },
    ...manifests.map((row) => ({ kind: 'DATASET_MANIFEST', digest: row.manifest_digest })),
  ];
  for (const run of runs) {
    inputs.push({ kind: 'EVALUATION_SUBMISSION', run_id: run.run_id, digest: run.submission_digest });
    if (run.result_digest !== null)
      inputs.push({ kind: 'EVALUATION_RESULT', run_id: run.run_id, digest: run.result_digest });
    if (run.metrics_digest !== null)
      inputs.push({ kind: 'EVALUATION_METRICS', run_id: run.run_id, digest: run.metrics_digest });
  }
  const observations = runs
    .filter((run) => run.cost_scenario === 'BASE' && run.window_role !== 'DEVELOPMENT')
    .map((run) => ({
      run_id: run.run_id,
      metric: 'excess_return_over_buy_and_hold',
      window: run.window_role,
      cost_scenario: run.cost_scenario,
      observed: '-0.258127',
      comparison: 'GREATER_THAN',
      threshold: '0',
      holds: false,
    }));
  const gates: Doc[] = (policy.gates as Doc[]).map((gate) => {
    const limitation = gate.limitation === undefined ? {} : { limitation: gate.limitation };
    if (gate.requirement !== 'REQUIRED') {
      return {
        result: gate.requirement === 'RECORDED_INSUFFICIENT' ? 'INSUFFICIENT' : 'NOT_APPLICABLE',
        gate: gate.gate,
        category: gate.category,
        reason_code: 'POLICY_RECORDED',
        reason: gate.reason,
      };
    }
    const result = decided[gate.gate as string] ?? 'PASS';
    if (result === 'INSUFFICIENT') {
      return {
        result,
        gate: gate.gate,
        category: gate.category,
        reason_code: 'BELOW_THRESHOLD',
        reason: 'Fewer closed trades than the policy requires.',
        ...limitation,
      };
    }
    return {
      result,
      gate: gate.gate,
      category: gate.category,
      evidence: [validation?.result_digest],
      observations: gate.gate === 'EXCESS_OVER_BUY_AND_HOLD' ? observations : [],
      ...limitation,
    };
  });
  return {
    schema_version: 'gate-report/1',
    job_id: jobId,
    attempt: { attempt_id: claimed.attemptId, ownership_revision: claimed.ownershipRevision },
    executable: { ...ENGINE_BATCH },
    method: structuredClone(flow.release.method),
    strategy_hash: strategyHash,
    cohort_policy: structuredClone(world.records.policy),
    inputs,
    gates,
    duration: { label: 'observed', milliseconds: 2310 },
  };
}

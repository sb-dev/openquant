// The pilot through the HTTP API on a real database, from the retrieval to the conclusion of the mission: the batch host
// and the runner claim their attempts and submit their results with capabilities, the workflows principal records the
// Decision and freezes the candidates, a Viewer reads the views. Every stage checks what the specifications require of it;
// the stages build on one another, in order.
//
// One candidate (the seed) is evaluated. The two revision slots end without a registered version (NO_REGISTERED_VERSION):
// their proposers are refused and make no proposal, which is what makes a revision slot terminal here (OQ-02 section 4).
// The mission then concludes NO_ELIGIBLE_CANDIDATE: the expected S1 outcome (OQ-02 section 3.2).

import { parseContract } from '@openquant/api-contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startAssessment } from '../src/domain/builders.ts';
import { gateReportFor } from './support/assess.ts';
import {
  type Claimed,
  claim,
  driveRetrieval,
  errorCode,
  type Flow,
  json,
  type Started,
  sha,
  startAssessmentOf,
  startedFlow,
  submit,
} from './support/flow.ts';
import { missionRevision } from './support/pipeline.ts';
import {
  CRITIQUE_FINDING,
  proposerEndsWithoutProposal,
  runsOf,
  submitEvaluation,
  toEvaluating,
} from './support/steps.ts';
import { readViews } from './support/views.ts';
import type { Doc } from './support/world.ts';

let flow: Flow & Started;
let seed: string;
let planDigest: string;

beforeAll(async () => {
  flow = await startedFlow();
  seed = flow.world.records.seedDigest;
});
afterAll(async () => {
  await flow.world.drop();
});

async function complete(runs: Awaited<ReturnType<typeof runsOf>>) {
  for (const run of runs) {
    const claimed = await claim(flow, run.attemptId);
    const { response } = await submitEvaluation(flow, claimed, run.runId);
    expect(response.status, run.runSlot).toBe(204);
  }
}

describe('the pilot, stage by stage', () => {
  it('1. the retrieval is accepted and the plan is recorded', async () => {
    expect((await driveRetrieval(flow)).response.status).toBe(204);
    const [plan] = await flow.world.sql<{ plan_digest: string }>('SELECT plan_digest FROM evaluation_plans');
    planDigest = plan?.plan_digest as string;
    expect(planDigest).toMatch(/^sha256:/);
    // A mission in progress, with most of its records still null: every read route answers the view contract of its route.
    await readViews(flow);
  });

  it('2. the seed is validated, criticised and approved by the policy-determined Decision: five runs are written', async () => {
    const blocking = {
      ...CRITIQUE_FINDING,
      category: 'causal_leakage',
      description: 'The entry reads the close of the signal session.',
      affected_elements: ['/definition/entry'],
      location: { area: 'definition', pointer: '/definition/entry' },
    };
    const { runs } = await toEvaluating(flow, [CRITIQUE_FINDING, blocking]);
    expect(runs.map((run) => run.runSlot)).toEqual([
      'seed.d.base',
      'seed.d.base.repeat',
      'seed.d.stress',
      'seed.v.base',
      'seed.v.stress',
    ]);
    const [version] = await flow.world.sql<{ lifecycle: string }>(
      'SELECT lifecycle FROM strategy_versions WHERE strategy_hash = $1',
      [seed],
    );
    expect(version?.lifecycle).toBe('EVALUATING');
    // A finding of the critic did not block this transition: in S1 no category does (OQ-02 section 4).
    const treatments = await flow.world.sql<{ category: string; transition: string; treatment: string }>(
      `SELECT f.category, t.transition, t.treatment FROM finding_treatments t JOIN findings f ON f.finding_id = t.finding_id ORDER BY f.category, t.transition`,
    );
    expect(treatments).toEqual([
      { category: 'causal_leakage', transition: 'DRAFT_TO_EVALUATING', treatment: 'ADVISORY' },
      { category: 'causal_leakage', transition: 'EVALUATING_TO_PAPER', treatment: 'BLOCKING' },
      { category: 'method_advice', transition: 'DRAFT_TO_EVALUATING', treatment: 'ADVISORY' },
      { category: 'method_advice', transition: 'EVALUATING_TO_PAPER', treatment: 'ADVISORY' },
    ]);
  });

  it('3. the development and validation runs complete with their official results', async () => {
    await complete(await runsOf(flow, 'seed'));
    const rows = await flow.world.sql<{ run_id: string; status: string }>(
      `SELECT run_id, status FROM runs WHERE window_role <> 'HOLDOUT'`,
    );
    expect(rows).toHaveLength(5);
    expect(rows.every((row) => row.status === 'COMPLETED')).toBe(true);
    expect(await flow.world.sql('SELECT 1 FROM results')).toHaveLength(5);
    expect(await flow.world.sql('SELECT 1 FROM metrics')).toHaveLength(5);
    // The deterministic repeat of the development base run gave the same evidence: equal result digests.
    const digests = await flow.world.sql<{ run_slot: string; result_digest: string }>(
      `SELECT r.run_slot, s.result_digest FROM runs r JOIN results s ON s.run_id = r.run_id WHERE r.run_slot IN ('seed.d.base', 'seed.d.base.repeat')`,
    );
    expect(new Set(digests.map((row) => row.result_digest)).size).toBe(1);
  });

  it('4. freeze_candidates writes the holdout runs of the candidate in EVALUATING and ends the two slots without a version', async () => {
    // Each proposer ran and was refused, so its revision slot has no proposal in flight and none to come.
    await proposerEndsWithoutProposal(flow, 'rev-a', 'proposer-a');
    await proposerEndsWithoutProposal(flow, 'rev-b', 'proposer-b');
    const frozen = await flow.world.apply(
      'workflows',
      {
        kind: 'freeze_candidates',
        mission_id: flow.missionId,
        plan_digest: planDigest,
        slots: [
          { trial_slot: 'seed', status: 'EVALUATING', strategy_hash: seed },
          { trial_slot: 'rev-a', status: 'NOT_EVALUATED', reason: 'NO_REGISTERED_VERSION' },
          { trial_slot: 'rev-b', status: 'NOT_EVALUATED', reason: 'NO_REGISTERED_VERSION' },
        ],
      },
      { expectedRevision: await missionRevision(flow.world) },
    );
    expect(frozen.state, JSON.stringify(frozen)).toBe('APPLIED');
    const holdout = await runsOf(flow, 'seed');
    expect(holdout.map((run) => run.runSlot)).toEqual(['seed.h.base', 'seed.h.stress']);
  });

  it('5. an assessment does not start before the holdout runs ended, and starts once they did', async () => {
    const early = await flow.world.tx((tx) =>
      startAssessment(tx, flow.work(), { missionId: flow.missionId, trialSlot: 'seed' }),
    );
    expect(early).toMatchObject({ ok: false });
    expect(early.ok === false && early.reason).toContain('has not ended');
    await complete(await runsOf(flow, 'seed'));
    const wrongSlot = await flow.world.tx((tx) =>
      startAssessment(tx, flow.work(), { missionId: flow.missionId, trialSlot: 'rev-a' }),
    );
    expect(wrongSlot).toMatchObject({ ok: false });
  });

  it('6. a holdout result that a Viewer reads is consumed, once per run, and never relabelled untouched', async () => {
    const viewer = await flow.person('viewer');
    const [holdout] = await flow.world.sql<{ run_id: string }>(
      `SELECT run_id FROM runs WHERE run_slot = 'seed.h.base'`,
    );
    expect(await flow.world.sql('SELECT 1 FROM holdout_consumption')).toHaveLength(0);
    expect((await flow.send('GET', `/v1/runs/${holdout?.run_id}/result`, viewer)).status).toBe(200);
    expect((await flow.send('GET', `/v1/runs/${holdout?.run_id}/metrics`, viewer)).status).toBe(200);
    const consumed = await flow.world.sql<{ run_id: string; revealed_by: string }>(
      'SELECT run_id, revealed_by FROM holdout_consumption',
    );
    expect(consumed).toEqual([{ run_id: holdout?.run_id, revealed_by: 'human-viewer' }]);
    // A development run is not a holdout: reading it consumes nothing.
    const [development] = await flow.world.sql<{ run_id: string }>(
      `SELECT run_id FROM runs WHERE run_slot = 'seed.d.base'`,
    );
    expect((await flow.send('GET', `/v1/runs/${development?.run_id}/result`, viewer)).status).toBe(200);
    expect(await flow.world.sql('SELECT 1 FROM holdout_consumption')).toHaveLength(1);
  });

  let assess: { jobId: string; attemptId: string };
  let claimed: Claimed;

  it('7. a gate report that is not the report of its job, policy and inputs is refused, and writes nothing', async () => {
    assess = await startAssessmentOf(flow, 'seed');
    claimed = await claim(flow, assess.attemptId);
    const base = () => gateReportFor(flow, claimed, assess.jobId, seed);
    const cases: [string, (report: Doc) => void][] = [
      ['another job', (report) => (report.job_id = 'job-other')],
      ['another candidate', (report) => (report.strategy_hash = sha('another candidate'))],
      ['another policy revision', (report) => (report.cohort_policy.digest = sha('another policy'))],
      ['another method', (report) => (report.method.digest = sha('another method'))],
      ['another executable', (report) => (report.executable.digest = sha('another binary'))],
      [
        'an input that the job was not given',
        (report) =>
          report.inputs.push({ kind: 'EVALUATION_RESULT', run_id: 'run-other', digest: sha('another result') }),
      ],
      ['evidence that is not among the inputs', (report) => (report.gates[0].evidence = [sha('unread')])],
      [
        'an observation of a run that is not the candidate’s',
        (report) =>
          (report.gates.find((gate: Doc) => gate.gate === 'EXCESS_OVER_BUY_AND_HOLD').observations[0].run_id =
            'run-other'),
      ],
      ['a gate left out', (report) => report.gates.pop()],
      ['a gate listed twice', (report) => report.gates.push(structuredClone(report.gates[0]))],
      [
        'a required gate that is NOT_APPLICABLE',
        (report) =>
          Object.assign(report.gates[0], {
            result: 'NOT_APPLICABLE',
            reason_code: 'POLICY_RECORDED',
            reason: 'x',
            evidence: undefined,
            observations: undefined,
          }),
      ],
      [
        'a gate that the policy records as INSUFFICIENT, decided as PASS',
        (report) =>
          Object.assign(
            report.gates.find((gate: Doc) => gate.gate === 'PARAMETER_SENSITIVITY'),
            {
              result: 'PASS',
              evidence: [report.inputs[1].digest],
              observations: [],
              reason_code: undefined,
              reason: undefined,
            },
          ),
      ],
      [
        'a policy reason that is not the policy’s text',
        (report) => (report.gates.find((gate: Doc) => gate.gate === 'RESAMPLING').reason = 'Not applicable.'),
      ],
      ['another category than the policy’s', (report) => (report.gates[0].category = 'ROBUSTNESS')],
      [
        'an approved limitation that is not repeated',
        (report) => delete report.gates.find((gate: Doc) => gate.gate === 'POINT_IN_TIME_DATA').limitation,
      ],
      [
        'an approved limitation that is rewritten',
        (report) =>
          (report.gates.find((gate: Doc) => gate.gate === 'POINT_IN_TIME_DATA').limitation = 'PASS covers everything.'),
      ],
    ];
    const before = await flow.world.snapshot(['audit_events']);
    const problems: string[] = [];
    for (const [label, edit] of cases) {
      const report = await base();
      edit(report);
      // A semantic-invalid case: the document satisfies its contract, and the API refuses it for the rule that it breaks.
      if (!parseContract('gate-report', JSON.stringify(report)).ok)
        problems.push(`${label}: the document is not schema-valid`);
      const response = await submit(flow, claimed, 'gate-report', report);
      if (response.status !== 422 || (await errorCode(response)) !== 'IDENTITY_MISMATCH')
        problems.push(`${label}: answered ${response.status}`);
    }
    expect(problems).toEqual([]);
    expect(await flow.world.snapshot(['audit_events'])).toEqual(before);
    const [attempt] = await flow.world.sql<{ status: string }>('SELECT status FROM attempts WHERE attempt_id = $1', [
      assess.attemptId,
    ]);
    expect(attempt?.status).toBe('CLAIMED');
  });

  it('8. the gate report is accepted: results, eligibility with its reasons, and the mission concludes without an eligible candidate', async () => {
    const report = await gateReportFor(flow, claimed, assess.jobId, seed);
    const response = await submit(flow, claimed, 'gate-report', report);
    expect(response.status, await response.clone().text()).toBe(204);
    const gates = await flow.world.sql<{ gate_id: string; result: string; reason_code: string | null }>(
      'SELECT gate_id, result, reason_code FROM gate_results ORDER BY gate_id',
    );
    expect(gates).toHaveLength(17);
    expect(gates.filter((gate) => gate.result === 'PASS')).toHaveLength(6);
    expect(gates.find((gate) => gate.gate_id === 'RESAMPLING')).toEqual({
      gate_id: 'RESAMPLING',
      result: 'NOT_APPLICABLE',
      reason_code: 'POLICY_RECORDED',
    });
    const [eligibility] = await flow.world.sql<{ state: string; reasons: string[] }>(
      'SELECT state, reasons FROM eligibility',
    );
    expect(eligibility?.state).toBe('NOT_ELIGIBLE');
    // Seven gates are not PASS and not NOT_APPLICABLE, and the critic's finding of causal leakage blocks EVALUATING to PAPER.
    expect(eligibility?.reasons).toHaveLength(8);
    expect(eligibility?.reasons.filter((reason) => reason.includes('blocks EVALUATING to PAPER'))).toHaveLength(1);
    expect(eligibility?.reasons).toContain('EXCESS_OVER_BUY_AND_HOLD is FAIL');
    expect(eligibility?.reasons).toContain('PARAMETER_SENSITIVITY is INSUFFICIENT');
    // No EVALUATING to PAPER Decision is written, and the lifecycle never reaches PAPER (OQ-02 section 4).
    expect(
      await flow.world.sql(`SELECT 1 FROM decisions WHERE kind NOT IN ('POLICY_APPROVAL', 'DRAFT_TO_EVALUATING')`),
    ).toHaveLength(0);
    const [mission] = await flow.world.sql<{ status: string; outcome: string; outcome_reason: string }>(
      'SELECT status, outcome, outcome_reason FROM missions WHERE mission_id = $1',
      [flow.missionId],
    );
    expect(mission).toMatchObject({ status: 'CONCLUDED', outcome: 'NO_ELIGIBLE_CANDIDATE' });
    const [outcome] = await flow.world.sql<{ slot_reasons: { trial_slot: string; reason: string }[] }>(
      'SELECT slot_reasons FROM mission_outcomes',
    );
    expect(outcome?.slot_reasons).toEqual([
      { trial_slot: 'rev-a', reason: 'NO_REGISTERED_VERSION' },
      { trial_slot: 'rev-b', reason: 'NO_REGISTERED_VERSION' },
      { trial_slot: 'seed', reason: 'NOT_ELIGIBLE' },
    ]);
    // The same report again is the stored outcome.
    expect((await submit(flow, claimed, 'gate-report', report)).status).toBe(204);
    expect(await flow.world.sql('SELECT 1 FROM gate_reports')).toHaveLength(1);
  });

  it('9. every budget is reconciled: nothing is reserved, and what was used is what the hosts reported', async () => {
    const reservations = await flow.world.sql<{ status: string; reservations: number }>(
      'SELECT status, count(*)::int AS reservations FROM reservations GROUP BY status ORDER BY status',
    );
    expect(reservations.filter((row) => row.status === 'RESERVED')).toEqual([]);
    const pools = await flow.world.sql<{ dimension: string; committed: string }>(
      `SELECT dimension, committed::text FROM budget_pools WHERE scope = 'MISSION' AND mission_id = $1 AND configuration_id IS NULL ORDER BY dimension`,
      [flow.missionId],
    );
    // Batch seconds: retrieval 5, validation 2, seven runs of 41 seconds, assessment 3 (2310 ms round up).
    const batch = 5 + 2 + 7 * 41 + 3;
    expect(pools.find((pool) => pool.dimension === 'BATCH_COMPUTE_SECONDS')?.committed).toBe(`${batch}.00000000`);
    // Agent seconds: the critic and the two refused proposers each reported 240 seconds (240000 ms).
    expect(pools.find((pool) => pool.dimension === 'AGENT_COMPUTE_SECONDS')?.committed).toBe('720.00000000');
    expect(pools.find((pool) => pool.dimension === 'PROVIDER_REQUESTS')?.committed).toBe('2.00000000');
  });
});

describe('the views of the concluded mission', () => {
  it('shows the mission with its candidates, jobs, budget and outcome', async () => {
    const viewer = await flow.person('viewer');
    const response = await flow.send('GET', `/v1/missions/${flow.missionId}`, viewer);
    expect(response.status).toBe(200);
    const view = await json<Doc>(response);
    expect(view).toMatchObject({
      mission_id: flow.missionId,
      status: 'CONCLUDED',
      outcome: 'NO_ELIGIBLE_CANDIDATE',
      plan_digest: planDigest,
    });
    expect(view.scope.symbol).toBe('AAPL');
    expect(view.candidates).toEqual([
      expect.objectContaining({
        trial_slot: 'rev-a',
        kind: 'REVISION',
        terminal_reason: 'NO_REGISTERED_VERSION',
        strategy_hash: null,
      }),
      expect.objectContaining({
        trial_slot: 'rev-b',
        kind: 'REVISION',
        terminal_reason: 'NO_REGISTERED_VERSION',
        strategy_hash: null,
      }),
      expect.objectContaining({
        trial_slot: 'seed',
        kind: 'SEED',
        strategy_hash: seed,
        lifecycle: 'EVALUATING',
        decision: 'APPROVED',
        eligibility: 'NOT_ELIGIBLE',
      }),
    ]);
    expect(view.jobs.map((job: Doc) => `${job.kind}:${job.status}`).sort()).toEqual([
      'agent:COMPLETED',
      'agent:FAILED',
      'agent:FAILED',
      'assess:COMPLETED',
      'retrieve:COMPLETED',
      'validate:COMPLETED',
    ]);
    expect(view.runs).toEqual([{ status: 'COMPLETED', runs: 7 }]);
    expect(view.budget.limits.attempt_cap).toBe(3);
    expect(view.budget.pools.length).toBeGreaterThanOrEqual(6);
    expect(view.attention_items).toEqual([]);
  });

  it('shows the plan unchanged, the lineage, the trials and the findings with their treatment per transition', async () => {
    const viewer = await flow.person('viewer');
    const plan = await flow.send('GET', `/v1/missions/${flow.missionId}/plan`, viewer);
    expect((await json<Doc>(plan)).run_slots).toHaveLength(21);
    const lineage = await json<Doc>(await flow.send('GET', `/v1/missions/${flow.missionId}/lineage`, viewer));
    expect(lineage.versions).toHaveLength(1);
    expect(lineage.versions[0]).toMatchObject({
      strategy_hash: seed,
      version: 1,
      parent_hash: null,
      lifecycle: 'EVALUATING',
      trial_slot: 'seed',
    });
    expect(lineage.versions[0].runs).toHaveLength(7);
    expect(lineage.versions[0].findings).toHaveLength(2);
    const trials = await json<Doc>(await flow.send('GET', `/v1/missions/${flow.missionId}/trials`, viewer));
    expect(trials.run_slots).toHaveLength(21);
    const planned = trials.run_slots.filter((slot: Doc) => slot.run === null);
    // The 14 planned runs of the two slots without a version are planned only: no run exists for them.
    expect(planned).toHaveLength(14);
    const holdout = trials.run_slots.find((slot: Doc) => slot.run_slot === 'seed.h.base');
    expect(holdout.run).toMatchObject({
      status: 'COMPLETED',
      mode: 'BACKTEST',
      environment: 'DEVELOPMENT',
      attempts: 1,
      holdout_consumed: true,
    });
    const untouched = trials.run_slots.find((slot: Doc) => slot.run_slot === 'seed.h.stress');
    expect(untouched.run.holdout_consumed).toBe(false);
    // The view repeats no official value of a run.
    expect(JSON.stringify(trials)).not.toContain('net_return');
    expect(trials.trials).toEqual([
      expect.objectContaining({ trial_slot: 'seed', status: 'REGISTERED', strategy_hash: seed }),
    ]);
    const findings = await json<Doc>(await flow.send('GET', `/v1/missions/${flow.missionId}/findings`, viewer));
    const leakage = findings.findings.find((finding: Doc) => finding.category === 'causal_leakage');
    expect(leakage).toMatchObject({ finding_source: 'model_judgement', applicability: ['affects_executable_rule'] });
    expect(leakage.treatments.map((row: Doc) => `${row.transition}:${row.treatment}`).sort()).toEqual([
      'DRAFT_TO_EVALUATING:ADVISORY',
      'EVALUATING_TO_PAPER:BLOCKING',
    ]);
  });

  it('shows the gate report with its eligibility, and the Decisions with their authority', async () => {
    const viewer = await flow.person('viewer');
    const gates = await json<Doc>(await flow.send('GET', `/v1/missions/${flow.missionId}/gates`, viewer));
    expect(gates.reports).toHaveLength(1);
    expect(gates.reports[0].eligibility.state).toBe('NOT_ELIGIBLE');
    // The report is the stored document: the policy's reason and the approved limitation are shown with the result.
    const pointInTime = gates.reports[0].report.gates.find((gate: Doc) => gate.gate === 'POINT_IN_TIME_DATA');
    expect(pointInTime.limitation).toContain('Provider revision history is not evidenced');
    const decisions = await json<Doc>(await flow.send('GET', `/v1/missions/${flow.missionId}/decisions`, viewer));
    expect(decisions.decisions.map((decision: Doc) => `${decision.kind}:${decision.outcome}`)).toEqual([
      'POLICY_APPROVAL:APPROVED',
      'DRAFT_TO_EVALUATING:APPROVED',
    ]);
    const evaluating = decisions.decisions[1];
    expect(evaluating).toMatchObject({
      actor_kind: 'SERVICE',
      trial_slot: 'seed',
      strategy_hash: seed,
      mission_started_by: 'human-researcher',
      critique_status: 'COMPLETED',
    });
    expect(evaluating.policy_approval_decision).toBe(decisions.decisions[0].decision_id);
  });

  it('shows a job with its attempts, lease, reservation and dispatch, and a run through the same route', async () => {
    const viewer = await flow.person('viewer');
    const [retrieve] = await flow.world.sql<{ job_id: string }>(`SELECT job_id FROM jobs WHERE kind = 'retrieve'`);
    const job = await json<Doc>(await flow.send('GET', `/v1/jobs/${retrieve?.job_id}`, viewer));
    expect(job).toMatchObject({ kind: 'retrieve', status: 'COMPLETED', attempt_cap: 3 });
    expect(job.attempts).toHaveLength(1);
    expect(job.attempts[0]).toMatchObject({
      ownership_revision: 1,
      status: 'COMPLETED',
      executable: { name: 'engine-batch' },
      lease: { status: 'RELEASED' },
      dispatch: { destination: 'BATCH_QUEUE', status: 'PENDING' },
      reservation: { status: 'SETTLED' },
    });
    expect(job.attempts[0].reservation.lines).toEqual([
      {
        dimension: 'BATCH_COMPUTE_SECONDS',
        configuration_id: null,
        reserved: '600.00000000',
        used: '5.00000000',
        usage_label: 'observed',
        usage: 'observed',
      },
      {
        dimension: 'PROVIDER_REQUESTS',
        configuration_id: null,
        reserved: '20.00000000',
        used: '2.00000000',
        usage_label: 'observed',
        usage: 'observed',
      },
    ]);
    const [run] = await flow.world.sql<{ run_id: string }>(`SELECT run_id FROM runs WHERE run_slot = 'seed.v.base'`);
    const evaluation = await json<Doc>(await flow.send('GET', `/v1/jobs/${run?.run_id}`, viewer));
    expect(evaluation).toMatchObject({ job_id: run?.run_id, kind: 'evaluate', status: 'COMPLETED' });
  });

  it('answers every read route with the view contract that the route manifest names', async () => {
    const views = await readViews(flow);
    expect(views[`/v1/missions/${flow.missionId}`]).toMatchObject({
      schema_version: 'mission-view/1',
      status: 'CONCLUDED',
    });
  });

  it('answers NOT_FOUND for what does not exist, and a command that was applied through its status route', async () => {
    const viewer = await flow.person('viewer');
    for (const path of [
      '/v1/missions/none',
      '/v1/missions/none/plan',
      '/v1/missions/none/lineage',
      '/v1/missions/none/trials',
      '/v1/missions/none/findings',
      '/v1/missions/none/gates',
      '/v1/missions/none/decisions',
      '/v1/jobs/none',
      '/v1/runs/none/result',
      '/v1/runs/none/metrics',
      '/v1/commands/none',
    ]) {
      const response = await flow.send('GET', path, viewer);
      expect(response.status, path).toBe(404);
      expect(await errorCode(response), path).toBe('NOT_FOUND');
    }
    const [command] = await flow.world.sql<{ command_id: string }>(
      `SELECT command_id FROM commands WHERE kind = 'freeze_candidates'`,
    );
    const status = await json<Doc>(await flow.send('GET', `/v1/commands/${command?.command_id}`, viewer));
    expect(status).toMatchObject({ form: 'status', kind: 'freeze_candidates', state: 'APPLIED' });
  });
});

// A release identity is required before any work is claimed and before any result is committed (OQ-05 sections 4 and
// 11): the engine, the method and the executables of the recorded release are what the evidence is checked against.
//
//   - a claim is refused while the environment has no recorded release, for every kind of work and for agent
//     attempts, whatever executable it names (EXECUTION_DISABLED, nothing is read or written);
//   - every one of the five result routes refuses a submission while no release is recorded, and the retrieval and
//     agent routes also refuse a claiming executable that the current release does not list.
//
// A release record is immutable by design, so the tests that need a result to arrive where none is recorded remove
// the rows with `removeReleases` (a test device that switches the immutability trigger off for one DELETE) and record
// the release again. The documents are derived in the test from the records of the mission (A04).

import { afterEach, describe, expect, it } from 'vitest';
import { gateReportFor } from './support/assess.ts';
import {
  AGENT_RUNNER,
  bytesOf,
  claim,
  claimRequest,
  driveRetrieval,
  ENGINE_BATCH,
  errorCode,
  type Flow,
  json,
  manifestFor,
  outboxOf,
  requestOf,
  retrievalResult,
  type Started,
  sha,
  startAgent,
  startAssessmentOf,
  startedFlow,
  startValidationOf,
  submit,
  upload,
} from './support/flow.ts';
import { decide } from './support/pipeline.ts';
import {
  agentResultDoc,
  proposerEndsWithoutProposal,
  runsOf,
  submitEvaluation,
  validationResult,
} from './support/steps.ts';
import { type Doc, recordRelease, recordRetrievalAndPlan, removeReleases, type World } from './support/world.ts';

const flows: (Flow & Started)[] = [];
afterEach(async () => {
  for (const flow of flows.splice(0)) await flow.world.drop();
});

async function fresh(options: Parameters<typeof startedFlow>[0] = {}): Promise<Flow & Started> {
  const flow = await startedFlow({
    ...options,
    policy: (policy) => {
      policy.limits.concurrent_batch_attempts = 10;
      policy.limits.concurrent_agent_attempts = 10;
    },
  });
  flows.push(flow);
  return flow;
}

const ROGUE = { name: 'rogue-binary', version: '9.9.9', digest: sha('rogue-binary') };

async function claimResponse(flow: Flow, attemptId: string, who: 'batch' | 'runner', executable: typeof ENGINE_BATCH) {
  const outbox = await outboxOf(flow, attemptId);
  return flow.send(
    'POST',
    `/v1/attempts/${attemptId}/claim`,
    flow.service(who),
    claimRequest(attemptId, outbox.revision, outbox.digest, executable),
  );
}

async function expectRefused(response: Response, code: string, message?: string): Promise<void> {
  const body = await json<{ code: string; message: string }>(response);
  expect(body.code).toBe(code);
  if (message !== undefined) expect(body.message).toContain(message);
}

/** The commands of the workflows principal name the plan that the retrieval recorded. */
async function recordPlanDigest(flow: Flow & Started): Promise<void> {
  const [plan] = await flow.world.sql<{ plan_digest: string }>('SELECT plan_digest FROM evaluation_plans');
  flow.world.records.planDigest = plan?.plan_digest as string;
}

/** Run `work` where the environment has no recorded release, then record the release again. */
async function withoutRelease<T>(world: World, work: () => Promise<T>): Promise<T> {
  await removeReleases(world);
  try {
    return await work();
  } finally {
    await recordRelease(world);
  }
}

describe('a claim while no release is recorded', () => {
  it('is refused for a retrieval, a validation and both agent roles, for any executable, and nothing is written', async () => {
    const flow = await fresh({ release: false });
    await recordRetrievalAndPlan(flow.world);
    const seed = flow.world.records.seedDigest;
    const validate = await startValidationOf(flow, { trialSlot: 'seed', draftDigest: seed });
    const proposer = await startAgent(flow, { slot: 'rev-a', role: 'PROPOSER', configuration: 'proposer-a' });
    const critic = await startAgent(flow, { slot: 'seed', role: 'CRITIC' });
    const cases: [string, string, 'batch' | 'runner', typeof ENGINE_BATCH][] = [
      ['a retrieval by the engine', flow.retrieve.attemptId, 'batch', ENGINE_BATCH],
      ['a retrieval by a binary that no release names', flow.retrieve.attemptId, 'batch', ROGUE],
      ['a validation', validate.attemptId, 'batch', ENGINE_BATCH],
      ['a proposer attempt', proposer.attemptId, 'runner', AGENT_RUNNER],
      ['a critic attempt', critic.attemptId, 'runner', AGENT_RUNNER],
      ['a critic attempt by a binary that no release names', critic.attemptId, 'runner', ROGUE],
    ];
    const before = await flow.world.snapshot();
    for (const [label, attemptId, who, executable] of cases) {
      const response = await claimResponse(flow, attemptId, who, executable);
      expect(response.status, label).toBe(409);
      await expectRefused(response, 'EXECUTION_DISABLED', 'release');
    }
    expect(await flow.world.snapshot()).toEqual(before);
    expect(await flow.world.sql('SELECT 1 FROM leases')).toHaveLength(0);
    const statuses = await flow.world.sql<{ status: string }>(`SELECT status FROM attempts WHERE status <> 'PENDING'`);
    expect(statuses).toEqual([]);

    // Once a release is recorded the same claims are granted, and a binary that it does not list is still refused.
    flow.release = await recordRelease(flow.world);
    expect((await claimResponse(flow, flow.retrieve.attemptId, 'batch', ROGUE)).status).toBe(422);
    await claim(flow, flow.retrieve.attemptId, 'batch', ENGINE_BATCH);
    await claim(flow, validate.attemptId, 'batch', ENGINE_BATCH);
    await claim(flow, proposer.attemptId, 'runner', AGENT_RUNNER);
    await claim(flow, critic.attemptId, 'runner', AGENT_RUNNER);
  });

  it('is refused for the runs of a candidate and for its assessment, which need a release to exist at all', async () => {
    const flow = await fresh();
    const seed = flow.world.records.seedDigest;
    expect((await driveRetrieval(flow)).response.status).toBe(204);
    await recordPlanDigest(flow);
    // The candidate is validated and criticised, and the Decision writes its five runs: each needs a release to be built.
    const validation = await startValidationOf(flow, { trialSlot: 'seed', draftDigest: seed });
    const validated = await claim(flow, validation.attemptId);
    const passed = await submit(
      flow,
      validated,
      'validation-result',
      validationResult(flow, validated, validation.jobId, seed),
    );
    expect(passed.status).toBe(204);
    const critic = await startAgent(flow, { slot: 'seed', role: 'CRITIC' });
    const criticClaim = await claim(flow, critic.attemptId, 'runner', AGENT_RUNNER);
    const output = await upload(
      flow,
      criticClaim,
      bytesOf({ schema_version: 'strategy-critique.result/1', findings: [] }),
    );
    const { message } = await outboxOf(flow, critic.attemptId);
    expect(
      (
        await submit(
          flow,
          criticClaim,
          'agent-result',
          agentResultDoc(criticClaim, message, {
            outcome: 'completion',
            output: { contract: 'strategy-critique.result/1', artefact: output },
          }),
        )
      ).status,
    ).toBe(204);
    const decided = await decide(flow.world, 'seed', 'APPROVED', {
      status: 'COMPLETED',
      attempt_id: critic.attemptId,
      result: output,
    });
    expect(decided.state).toBe('APPLIED');
    const runs = await runsOf(flow, 'seed');
    expect(runs).toHaveLength(5);
    await withoutRelease(flow.world, async () => {
      for (const run of runs) {
        const response = await claimResponse(flow, run.attemptId, 'batch', ENGINE_BATCH);
        expect(response.status, run.runSlot).toBe(409);
        await expectRefused(response, 'EXECUTION_DISABLED');
      }
    });
    expect(await flow.world.sql(`SELECT 1 FROM attempts WHERE status = 'CLAIMED'`)).toHaveLength(0);

    // Every run completes, the candidates are frozen, the holdout runs complete: then the assessment exists.
    for (const slot of ['rev-a', 'rev-b']) {
      await proposerEndsWithoutProposal(flow, slot, slot === 'rev-a' ? 'proposer-a' : 'proposer-b');
    }
    for (const run of runs) {
      const claimed = await claim(flow, run.attemptId);
      expect((await submitEvaluation(flow, claimed, run.runId)).response.status, run.runSlot).toBe(204);
    }
    const [mission] = await flow.world.sql<{ revision: number }>(
      'SELECT revision FROM missions WHERE mission_id = $1',
      [flow.missionId],
    );
    const [plan] = await flow.world.sql<{ plan_digest: string }>('SELECT plan_digest FROM evaluation_plans');
    const frozen = await flow.world.apply(
      'workflows',
      {
        kind: 'freeze_candidates',
        mission_id: flow.missionId,
        plan_digest: plan?.plan_digest,
        slots: [
          { trial_slot: 'seed', status: 'EVALUATING', strategy_hash: seed },
          { trial_slot: 'rev-a', status: 'NOT_EVALUATED', reason: 'NO_REGISTERED_VERSION' },
          { trial_slot: 'rev-b', status: 'NOT_EVALUATED', reason: 'NO_REGISTERED_VERSION' },
        ],
      },
      { expectedRevision: mission?.revision as number },
    );
    expect(frozen.state, JSON.stringify(frozen)).toBe('APPLIED');
    for (const run of await runsOf(flow, 'seed')) {
      const claimed = await claim(flow, run.attemptId);
      expect((await submitEvaluation(flow, claimed, run.runId)).response.status, run.runSlot).toBe(204);
    }
    const assess = await startAssessmentOf(flow, 'seed');
    await withoutRelease(flow.world, async () => {
      const response = await claimResponse(flow, assess.attemptId, 'batch', ENGINE_BATCH);
      expect(response.status).toBe(409);
      await expectRefused(response, 'EXECUTION_DISABLED');
    });
    expect(
      await flow.world.sql<{ status: string }>('SELECT status FROM attempts WHERE attempt_id = $1', [assess.attemptId]),
    ).toEqual([{ status: 'PENDING' }]);
    await claim(flow, assess.attemptId);
  });
});

describe('a result while no release is recorded', () => {
  it('is refused by every one of the five result routes, writes nothing, and is accepted once the release is back', async () => {
    const flow = await fresh();
    const { world } = flow;
    const seed = world.records.seedDigest;
    const refused = async (response: Response, label: string): Promise<void> => {
      expect(response.status, label).toBe(422);
      await expectRefused(response, 'IDENTITY_MISMATCH', 'No release identity is recorded');
    };

    // 1. The retrieval: the manifest would become the one frozen snapshot of the mission.
    const { jobId, attemptId } = flow.retrieve;
    const retrieval = await claim(flow, attemptId);
    const request = await requestOf(flow, attemptId);
    const manifestRef = await upload(
      flow,
      retrieval,
      bytesOf(manifestFor(flow, { jobId, attemptId, requestDigest: request.digest })),
    );
    const retrieved = retrievalResult(retrieval, jobId, request.digest, { status: 'COMPLETE', manifest: manifestRef });
    await withoutRelease(world, async () => {
      await refused(await submit(flow, retrieval, 'retrieval-result', retrieved), 'retrieval');
    });
    expect(await world.sql('SELECT 1 FROM dataset_manifests')).toHaveLength(0);
    expect(await world.sql('SELECT 1 FROM evaluation_plans')).toHaveLength(0);
    expect(
      await world.sql<{ status: string }>('SELECT status FROM attempts WHERE attempt_id = $1', [attemptId]),
    ).toEqual([{ status: 'CLAIMED' }]);
    expect((await submit(flow, retrieval, 'retrieval-result', retrieved)).status).toBe(204);
    expect(await world.sql('SELECT 1 FROM evaluation_plans')).toHaveLength(1);
    await recordPlanDigest(flow);

    // 2. The validation.
    const validation = await startValidationOf(flow, { trialSlot: 'seed', draftDigest: seed });
    const validated = await claim(flow, validation.attemptId);
    const verdict = validationResult(flow, validated, validation.jobId, seed);
    await withoutRelease(world, async () => {
      await refused(await submit(flow, validated, 'validation-result', verdict), 'validation');
    });
    expect(await world.sql('SELECT 1 FROM strategy_versions')).toHaveLength(0);
    expect((await submit(flow, validated, 'validation-result', verdict)).status).toBe(204);

    // 3. The critic.
    const critic = await startAgent(flow, { slot: 'seed', role: 'CRITIC' });
    const criticClaim = await claim(flow, critic.attemptId, 'runner', AGENT_RUNNER);
    const output = await upload(
      flow,
      criticClaim,
      bytesOf({ schema_version: 'strategy-critique.result/1', findings: [] }),
    );
    const { message } = await outboxOf(flow, critic.attemptId);
    const reported = agentResultDoc(criticClaim, message, {
      outcome: 'completion',
      output: { contract: 'strategy-critique.result/1', artefact: output },
    });
    await withoutRelease(world, async () => {
      await refused(await submit(flow, criticClaim, 'agent-result', reported), 'agent');
    });
    expect(await world.sql('SELECT 1 FROM agent_results')).toHaveLength(0);
    expect(
      await world.sql<{ status: string }>('SELECT status FROM attempts WHERE attempt_id = $1', [critic.attemptId]),
    ).toEqual([{ status: 'CLAIMED' }]);
    expect((await submit(flow, criticClaim, 'agent-result', reported)).status).toBe(204);

    // 4. An evaluation run of the candidate.
    const decided = await decide(world, 'seed', 'APPROVED', {
      status: 'COMPLETED',
      attempt_id: critic.attemptId,
      result: output,
    });
    expect(decided.state).toBe('APPLIED');
    const runs = await runsOf(flow, 'seed');
    const first = runs[0];
    if (first === undefined) throw new Error('The Decision wrote no run.');
    const evaluating = await claim(flow, first.attemptId);
    await withoutRelease(world, async () => {
      const attempt = await submitEvaluation(flow, evaluating, first.runId);
      await refused(attempt.response, 'evaluation');
    });
    expect(await world.sql('SELECT 1 FROM results')).toHaveLength(0);
    expect((await submitEvaluation(flow, evaluating, first.runId)).response.status).toBe(204);

    // 5. The gate report of the candidate: every run completes, the candidates are frozen, the assessment is claimed.
    for (const run of runs.slice(1)) {
      const claimed = await claim(flow, run.attemptId);
      expect((await submitEvaluation(flow, claimed, run.runId)).response.status, run.runSlot).toBe(204);
    }
    await proposerEndsWithoutProposal(flow, 'rev-a', 'proposer-a');
    await proposerEndsWithoutProposal(flow, 'rev-b', 'proposer-b');
    const [mission] = await world.sql<{ revision: number }>('SELECT revision FROM missions WHERE mission_id = $1', [
      flow.missionId,
    ]);
    const [plan] = await world.sql<{ plan_digest: string }>('SELECT plan_digest FROM evaluation_plans');
    const frozen = await world.apply(
      'workflows',
      {
        kind: 'freeze_candidates',
        mission_id: flow.missionId,
        plan_digest: plan?.plan_digest,
        slots: [
          { trial_slot: 'seed', status: 'EVALUATING', strategy_hash: seed },
          { trial_slot: 'rev-a', status: 'NOT_EVALUATED', reason: 'NO_REGISTERED_VERSION' },
          { trial_slot: 'rev-b', status: 'NOT_EVALUATED', reason: 'NO_REGISTERED_VERSION' },
        ],
      },
      { expectedRevision: mission?.revision as number },
    );
    expect(frozen.state, JSON.stringify(frozen)).toBe('APPLIED');
    for (const run of await runsOf(flow, 'seed')) {
      const claimed = await claim(flow, run.attemptId);
      expect((await submitEvaluation(flow, claimed, run.runId)).response.status, run.runSlot).toBe(204);
    }
    const assess = await startAssessmentOf(flow, 'seed');
    const assessing = await claim(flow, assess.attemptId);
    const report = await gateReportFor(flow, assessing, assess.jobId, seed);
    await withoutRelease(world, async () => {
      await refused(await submit(flow, assessing, 'gate-report', report), 'gate report');
    });
    expect(await world.sql('SELECT 1 FROM gate_reports')).toHaveLength(0);
    expect((await submit(flow, assessing, 'gate-report', report)).status).toBe(204);
  });
});

describe('a result from an executable that the current release does not list', () => {
  /** A newer release that lists other executables than the ones that the claim was granted to. */
  const replaced = (world: World) =>
    recordRelease(world, (release) => {
      release.executables = release.executables.map((entry: Doc) => ({ ...entry, digest: sha(`new-${entry.name}`) }));
    });

  it('is refused for a retrieval: no manifest is recorded, and the attempt stays claimed', async () => {
    const flow = await fresh();
    const { jobId, attemptId } = flow.retrieve;
    const claimed = await claim(flow, attemptId);
    const request = await requestOf(flow, attemptId);
    const manifestRef = await upload(
      flow,
      claimed,
      bytesOf(manifestFor(flow, { jobId, attemptId, requestDigest: request.digest })),
    );
    await replaced(flow.world);
    const response = await submit(
      flow,
      claimed,
      'retrieval-result',
      retrievalResult(claimed, jobId, request.digest, { status: 'COMPLETE', manifest: manifestRef }),
    );
    expect(response.status).toBe(422);
    expect(await errorCode(response)).toBe('IDENTITY_MISMATCH');
    expect(await flow.world.sql('SELECT 1 FROM dataset_manifests')).toHaveLength(0);
    expect(
      await flow.world.sql<{ status: string }>('SELECT status FROM attempts WHERE attempt_id = $1', [attemptId]),
    ).toEqual([{ status: 'CLAIMED' }]);
  });

  it('is refused for an agent report: nothing is recorded, and the attempt stays claimed', async () => {
    const flow = await fresh();
    const work = await startAgent(flow, { role: 'PROPOSER', configuration: 'proposer-a' });
    const claimed = await claim(flow, work.attemptId, 'runner', AGENT_RUNNER);
    const { message } = await outboxOf(flow, work.attemptId);
    const output = await upload(
      flow,
      claimed,
      bytesOf({ schema_version: 'strategy-formulation.result/1', proposal_kind: 'controlled_revision' }),
    );
    await replaced(flow.world);
    const response = await submit(
      flow,
      claimed,
      'agent-result',
      agentResultDoc(claimed, message, {
        outcome: 'completion',
        output: { contract: 'strategy-formulation.result/1', artefact: output },
      }),
    );
    expect(response.status).toBe(422);
    expect(await errorCode(response)).toBe('IDENTITY_MISMATCH');
    expect(await flow.world.sql('SELECT 1 FROM agent_results')).toHaveLength(0);
    expect(
      await flow.world.sql<{ status: string }>('SELECT status FROM attempts WHERE attempt_id = $1', [work.attemptId]),
    ).toEqual([{ status: 'CLAIMED' }]);
  });
});

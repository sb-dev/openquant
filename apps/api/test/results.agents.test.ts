// attempts.agent-result (OQ-03 sections 3 to 5; OQ-05 section 4; decisions D6 and D22): the runner reports what it
// observed, and the API checks the provenance against the dispatch, reads the role output again before it writes
// anything, settles the reservation from the reported usage and gives the logical run its status. A critic's findings
// are recorded as returned, labelled model_judgement. A timeout and a malformed result are retried within the attempt
// cap; a refusal, a denied capability, an authentication failure and a cancellation are not.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AGENT_RUNNER,
  bytesOf,
  claim,
  driveRetrieval,
  errorCode,
  type Flow,
  json,
  outboxOf,
  type Started,
  sha,
  startAgent,
  startedFlow,
  submit,
  upload,
} from './support/flow.ts';
import { agentResultDoc, driveCritique, driveValidation } from './support/steps.ts';
import type { Doc } from './support/world.ts';

let flow: Flow & Started;

beforeAll(async () => {
  flow = await startedFlow({
    policy: (policy) => {
      policy.limits.concurrent_agent_attempts = 10;
    },
  });
  expect((await driveRetrieval(flow)).response.status).toBe(204);
  expect(
    (await driveValidation(flow, { trialSlot: 'seed', draftDigest: flow.world.records.seedDigest })).response.status,
  ).toBe(204);
});
afterAll(async () => {
  await flow.world.drop();
});

const finding = (overrides: Doc = {}): Doc => ({
  category: 'method_advice',
  description: 'The strategy could state its holding period.',
  method_refs: [],
  evidence_refs: [],
  location: { area: 'rationale' },
  affected_elements: [],
  ...overrides,
});

describe('a critic that completes', () => {
  it('has its findings recorded as returned, with the attempt, the digest of its output and the label model_judgement', async () => {
    const findings = [
      finding(),
      finding({
        category: 'causal_leakage',
        description: 'The entry reads the close of the signal session.',
        affected_elements: ['/definition/entry'],
        location: { area: 'definition', pointer: '/definition/entry' },
      }),
      finding({
        category: 'hypothesis_assumption',
        related_categories: ['source_uncertainty'],
        proposed_tests: ['Compare with a shuffled calendar.'],
      }),
    ];
    const critique = await driveCritique(flow, 'seed', findings);
    expect(critique.response.status).toBe(204);
    const rows = await flow.world.sql<{
      ordinal: number;
      category: string;
      finding_source: string;
      affects_executable_rule: boolean;
      required_evidence: boolean;
      attempt_id: string;
      critique_digest: string;
    }>(
      'SELECT ordinal, category, finding_source, affects_executable_rule, required_evidence, attempt_id, critique_digest FROM findings ORDER BY ordinal',
    );
    expect(rows).toEqual([
      {
        ordinal: 1,
        category: 'method_advice',
        finding_source: 'model_judgement',
        affects_executable_rule: false,
        required_evidence: false,
        attempt_id: critique.work.attemptId,
        critique_digest: critique.output.digest,
      },
      {
        ordinal: 2,
        category: 'causal_leakage',
        finding_source: 'model_judgement',
        affects_executable_rule: true,
        required_evidence: false,
        attempt_id: critique.work.attemptId,
        critique_digest: critique.output.digest,
      },
      {
        ordinal: 3,
        category: 'hypothesis_assumption',
        finding_source: 'model_judgement',
        affects_executable_rule: false,
        required_evidence: false,
        attempt_id: critique.work.attemptId,
        critique_digest: critique.output.digest,
      },
    ]);
    const [linked] = await flow.world.sql<{
      job_id: string;
      role: string;
      outcome: string;
      output_contract: string;
      output_digest: string;
    }>('SELECT job_id, role, outcome, output_contract, output_digest FROM agent_results WHERE attempt_id = $1', [
      critique.work.attemptId,
    ]);
    expect(linked).toEqual({
      job_id: critique.work.jobId,
      role: 'CRITIC',
      outcome: 'completion',
      output_contract: 'strategy-critique.result/1',
      output_digest: critique.output.digest,
    });
    const [job] = await flow.world.sql<{ status: string }>('SELECT status FROM jobs WHERE job_id = $1', [
      critique.work.jobId,
    ]);
    expect(job?.status).toBe('COMPLETED');
    // The critic's allowance is its own pool: 3.25 estimated of the 5.00 that the attempt reserved, 240 of 900 seconds.
    const lines = await flow.world.sql<{
      dimension: string;
      configuration_id: string | null;
      reserved: string;
      used: string;
      usage_label: string;
    }>(
      `SELECT p.dimension, p.configuration_id, l.reserved::text, l.used::text, l.usage_label FROM reservation_lines l JOIN budget_pools p ON p.pool_id = l.pool_id
        WHERE l.attempt_id = $1 ORDER BY p.dimension`,
      [critique.work.attemptId],
    );
    expect(lines).toEqual([
      {
        dimension: 'AGENT_COMPUTE_SECONDS',
        configuration_id: null,
        reserved: '900.00000000',
        used: '240.00000000',
        usage_label: 'observed',
      },
      {
        dimension: 'MODEL_SPEND',
        configuration_id: 'critic',
        reserved: '5.00000000',
        used: '3.25000000',
        usage_label: 'estimated',
      },
    ]);
    // The treatment is the policy's to assign, never the critic's: none exists yet, and a finding carries no field for it.
    expect(await flow.world.sql('SELECT 1 FROM finding_treatments')).toHaveLength(0);
  });

  it('answers a redelivery with the stored outcome, and refuses another report from the same attempt', async () => {
    const critique = await driveCritique(flow, 'seed', []);
    expect(critique.response.status).toBe(204);
    const { message } = await outboxOf(flow, critique.work.attemptId);
    const same = agentResultDoc(critique.claimed, message, {
      outcome: 'completion',
      output: { contract: 'strategy-critique.result/1', artefact: critique.output },
    });
    const before = await flow.world.snapshot();
    expect((await submit(flow, critique.claimed, 'agent-result', same)).status).toBe(204);
    expect(await flow.world.snapshot()).toEqual(before);
    const other = agentResultDoc(
      critique.claimed,
      message,
      { outcome: 'completion', output: { contract: 'strategy-critique.result/1', artefact: critique.output } },
      (result) => {
        result.usage.cost = { label: 'estimated', amount: '4.99', currency: 'USD' };
      },
    );
    const refused = await submit(flow, critique.claimed, 'agent-result', other);
    expect(refused.status).toBe(422);
    expect(await errorCode(refused)).toBe('IDENTITY_MISMATCH');
  });
});

describe('a role output that does not satisfy its contract', () => {
  it('is refused with SCHEMA_VIOLATION, writes no finding, and leaves the attempt claimed', async () => {
    const bad: [string, unknown][] = [
      ['an unknown member', { schema_version: 'strategy-critique.result/1', findings: [], approved: true }],
      [
        'an unknown category',
        { schema_version: 'strategy-critique.result/1', findings: [finding({ category: 'looks_fine' })] },
      ],
      [
        'a finding source that the model supplied',
        { schema_version: 'strategy-critique.result/1', findings: [finding({ finding_source: 'policy' })] },
      ],
      [
        'a treatment that the model supplied',
        { schema_version: 'strategy-critique.result/1', findings: [finding({ treatment: 'ADVISORY' })] },
      ],
      [
        'a missing member of a finding',
        { schema_version: 'strategy-critique.result/1', findings: [{ category: 'method_advice', description: 'x' }] },
      ],
      [
        'too many findings',
        { schema_version: 'strategy-critique.result/1', findings: Array.from({ length: 65 }, () => finding()) },
      ],
      [
        'a description above 2000 characters',
        { schema_version: 'strategy-critique.result/1', findings: [finding({ description: 'x'.repeat(2001) })] },
      ],
      ['another schema version', { schema_version: 'strategy-critique.result/2', findings: [] }],
    ];
    const work = await startAgent(flow, { slot: 'seed', role: 'CRITIC' });
    const claimed = await claim(flow, work.attemptId, 'runner', AGENT_RUNNER);
    const { message } = await outboxOf(flow, work.attemptId);
    const findingsBefore = await flow.world.sql('SELECT 1 FROM findings');
    const outputs: [string, Uint8Array][] = [
      ...bad.map(([label, doc]) => [label, bytesOf(doc)] as [string, Uint8Array]),
      ['text that is not JSON', new TextEncoder().encode('{"schema_version": ')],
      [
        'a repeated key',
        new TextEncoder().encode('{"schema_version":"strategy-critique.result/1","findings":[],"findings":[]}'),
      ],
    ];
    for (const [label, bytes] of outputs) {
      const ref = await upload(flow, claimed, bytes);
      const response = await submit(
        flow,
        claimed,
        'agent-result',
        agentResultDoc(claimed, message, {
          outcome: 'completion',
          output: { contract: 'strategy-critique.result/1', artefact: ref },
        }),
      );
      expect(response.status, label).toBe(400);
      expect(await errorCode(response), label).toBe('SCHEMA_VIOLATION');
    }
    expect(await flow.world.sql('SELECT 1 FROM findings')).toEqual(findingsBefore);
    const [attempt] = await flow.world.sql<{ status: string }>('SELECT status FROM attempts WHERE attempt_id = $1', [
      work.attemptId,
    ]);
    expect(attempt?.status).toBe('CLAIMED');
  });

  it('is refused when it is the output of the other role', async () => {
    const work = await startAgent(flow, { slot: 'seed', role: 'CRITIC' });
    const claimed = await claim(flow, work.attemptId, 'runner', AGENT_RUNNER);
    const { message } = await outboxOf(flow, work.attemptId);
    const ref = await upload(
      flow,
      claimed,
      bytesOf({ schema_version: 'strategy-formulation.result/1', proposal_kind: 'seed_translation' }),
    );
    const response = await submit(
      flow,
      claimed,
      'agent-result',
      agentResultDoc(claimed, message, {
        outcome: 'completion',
        output: { contract: 'strategy-formulation.result/1', artefact: ref },
      }),
    );
    expect(response.status).toBe(422);
    expect(await errorCode(response)).toBe('IDENTITY_MISMATCH');
  });
});

describe('a report that does not bind to its dispatch', () => {
  it('is refused for another session, request, bundle or runner, and for a cost in another currency', async () => {
    const work = await startAgent(flow, { slot: 'seed', role: 'CRITIC' });
    const claimed = await claim(flow, work.attemptId, 'runner', AGENT_RUNNER);
    const { message } = await outboxOf(flow, work.attemptId);
    const ref = await upload(flow, claimed, bytesOf({ schema_version: 'strategy-critique.result/1', findings: [] }));
    const completion = { outcome: 'completion', output: { contract: 'strategy-critique.result/1', artefact: ref } };
    const cases: [string, (result: Doc) => void][] = [
      ['another session', (result) => (result.provenance.session_id = 'session-other')],
      ['another request', (result) => (result.provenance.input_hash = sha('another request'))],
      ['another bundle', (result) => (result.provenance.bundle_hash = sha('another bundle'))],
      ['another runner', (result) => (result.provenance.runner.digest = sha('another runner'))],
      [
        'a cost in another currency',
        (result) => (result.usage.cost = { label: 'estimated', amount: '1.00', currency: 'EUR' }),
      ],
    ];
    for (const [label, edit] of cases) {
      const response = await submit(flow, claimed, 'agent-result', agentResultDoc(claimed, message, completion, edit));
      expect(response.status, label).toBe(422);
      expect(await errorCode(response), label).toBe('IDENTITY_MISMATCH');
    }
    expect(await flow.world.sql('SELECT 1 FROM agent_results WHERE attempt_id = $1', [work.attemptId])).toHaveLength(0);
  });

  it('cannot be claimed by the batch host, which holds no authority over agent work', async () => {
    const work = await startAgent(flow, { slot: 'seed', role: 'CRITIC' });
    const response = await flow.send('POST', `/v1/attempts/${work.attemptId}/claim`, flow.service('batch'), {
      schema_version: 'attempt-claim/1',
      form: 'claim',
      attempt: { attempt_id: work.attemptId, ownership_revision: 1 },
      dispatch_digest: (await outboxOf(flow, work.attemptId)).digest,
      executable: AGENT_RUNNER,
      worker_id: 'worker-1',
    });
    expect(response.status).toBe(403);
  });
});

describe('an outcome other than a completion', () => {
  // The critic's allowance grants 9 agent attempts: the cases of this block have their own mission.
  let outFlow: Flow & Started;
  beforeAll(async () => {
    outFlow = await startedFlow({
      policy: (policy) => {
        policy.limits.concurrent_agent_attempts = 10;
      },
    });
    expect((await driveRetrieval(outFlow)).response.status).toBe(204);
    expect(
      (await driveValidation(outFlow, { trialSlot: 'seed', draftDigest: outFlow.world.records.seedDigest })).response
        .status,
    ).toBe(204);
  });
  afterAll(async () => {
    await outFlow.world.drop();
  });

  async function report(outcome: Doc, edit?: (result: Doc) => void) {
    const work = await startAgent(outFlow, { slot: 'seed', role: 'CRITIC' });
    const claimed = await claim(outFlow, work.attemptId, 'runner', AGENT_RUNNER);
    const { message } = await outboxOf(outFlow, work.attemptId);
    const response = await submit(outFlow, claimed, 'agent-result', agentResultDoc(claimed, message, outcome, edit));
    const attempts = await outFlow.world.sql<{
      attempt_id: string;
      ownership_revision: number;
      status: string;
      agent_outcome: string | null;
    }>(
      'SELECT attempt_id, ownership_revision, status, agent_outcome FROM attempts WHERE job_id = $1 ORDER BY ownership_revision',
      [work.jobId],
    );
    const [job] = await outFlow.world.sql<{ status: string; failure_code: string | null }>(
      'SELECT status, failure_code FROM jobs WHERE job_id = $1',
      [work.jobId],
    );
    return { work, claimed, response, attempts, job };
  }

  const never: [string, Doc][] = [
    ['a refusal', { outcome: 'refusal', diagnostic: 'The model declined the task.' }],
    [
      'a denied capability',
      {
        outcome: 'denied_capability',
        reason: 'CAPABILITY_DENIED',
        diagnostic: 'A tool was requested that the profile denies.',
      },
    ],
    [
      'an authentication failure',
      {
        outcome: 'authentication_failure',
        reason: 'CREDENTIAL_REJECTED',
        diagnostic: 'The executor credential was rejected.',
      },
    ],
    ['a cancellation', { outcome: 'cancellation', diagnostic: 'The host terminated the process tree.' }],
  ];
  for (const [label, outcome] of never) {
    it(`${label} ends the logical run at once: FAILED, never retried`, async () => {
      const { response, attempts, job } = await report(outcome);
      expect(response.status).toBe(204);
      expect(attempts).toHaveLength(1);
      expect(attempts[0]).toMatchObject({ status: 'FAILED', agent_outcome: outcome.outcome });
      expect(job?.status).toBe('FAILED');
    });
  }

  it('a timeout is retried: a new attempt of the same logical run, with its own session and result route, until the cap', async () => {
    const first = await report({
      outcome: 'timeout',
      diagnostic: 'The host terminated the process tree at the deadline.',
    });
    expect(first.response.status).toBe(204);
    expect(first.attempts).toHaveLength(2);
    expect(first.attempts[1]).toMatchObject({ ownership_revision: 2, status: 'PENDING' });
    expect(first.job?.status).toBe('QUEUED');
    const before = await outboxOf(outFlow, first.attempts[0]?.attempt_id as string);
    const retry = await outboxOf(outFlow, first.attempts[1]?.attempt_id as string);
    expect((retry.message.identity as Doc).attempt).toEqual({
      attempt_id: first.attempts[1]?.attempt_id,
      ownership_revision: 2,
    });
    expect((retry.message.identity as Doc).session_id).not.toBe((before.message.identity as Doc).session_id);
    expect(retry.message.result_route).toBe(`/v1/attempts/${first.attempts[1]?.attempt_id}/agent-result`);
    expect((retry.message.inputs as Doc).request).toEqual((before.message.inputs as Doc).request);
    // Two more timeouts exhaust the cap of 3 attempts.
    let current = first.attempts[1]?.attempt_id as string;
    for (let revision = 2; revision <= 3; revision += 1) {
      const claimed = await claim(outFlow, current, 'runner', AGENT_RUNNER);
      const { message } = await outboxOf(outFlow, current);
      const response = await submit(
        outFlow,
        claimed,
        'agent-result',
        agentResultDoc(claimed, message, { outcome: 'timeout', diagnostic: 'The deadline passed.' }),
      );
      expect(response.status).toBe(204);
      const next = await outFlow.world.sql<{ attempt_id: string }>(
        'SELECT attempt_id FROM attempts WHERE job_id = $1 AND ownership_revision = $2',
        [first.work.jobId, revision + 1],
      );
      if (revision === 2) current = next[0]?.attempt_id as string;
      else expect(next).toHaveLength(0);
    }
    const [job] = await outFlow.world.sql<{ status: string; failure_code: string }>(
      'SELECT status, failure_code FROM jobs WHERE job_id = $1',
      [first.work.jobId],
    );
    expect(job).toEqual({ status: 'FAILED', failure_code: 'AGENT_TIMEOUT' });
  });

  it('a malformed result is retried as well, and unknown usage keeps the full reservation: the reservation is UNRECONCILED', async () => {
    const { work, attempts, response } = await report(
      { outcome: 'malformed_result', reason: 'SCHEMA_INVALID', diagnostic: 'An unknown category.' },
      (result) => {
        result.usage.cost = { label: 'unknown', reason: 'The executor reported no cost.' };
      },
    );
    expect(response.status).toBe(204);
    expect(attempts[1]?.status).toBe('PENDING');
    const [reservation] = await outFlow.world.sql<{ status: string }>(
      'SELECT status FROM reservations WHERE attempt_id = $1',
      [attempts[0]?.attempt_id],
    );
    expect(reservation?.status).toBe('UNRECONCILED');
    const [line] = await outFlow.world.sql<{ used: string | null; usage_label: string }>(
      `SELECT l.used::text, l.usage_label FROM reservation_lines l JOIN budget_pools p ON p.pool_id = l.pool_id WHERE l.attempt_id = $1 AND p.dimension = 'MODEL_SPEND'`,
      [attempts[0]?.attempt_id],
    );
    expect(line).toEqual({ used: null, usage_label: 'unknown' });
    expect(work.jobId).toBeTruthy();
  });
});

describe('a proposer', () => {
  it('that completes has its output recorded and its run COMPLETED: the workflow that reads the proposal registers it', async () => {
    const work = await startAgent(flow, { slot: 'rev-a', role: 'PROPOSER', configuration: 'proposer-a' });
    const claimed = await claim(flow, work.attemptId, 'runner', AGENT_RUNNER);
    const { message } = await outboxOf(flow, work.attemptId);
    const output = await upload(
      flow,
      claimed,
      bytesOf({ schema_version: 'strategy-formulation.result/1', proposal_kind: 'controlled_revision' }),
    );
    const response = await submit(
      flow,
      claimed,
      'agent-result',
      agentResultDoc(claimed, message, {
        outcome: 'completion',
        output: { contract: 'strategy-formulation.result/1', artefact: output },
      }),
    );
    expect(response.status).toBe(204);
    const [linked] = await flow.world.sql<{ role: string; output_digest: string }>(
      'SELECT role, output_digest FROM agent_results WHERE attempt_id = $1',
      [work.attemptId],
    );
    expect(linked).toEqual({ role: 'PROPOSER', output_digest: output.digest });
    // The proposer's own allowance pays: 3.25 of the 5.00 reserved.
    const [line] = await flow.world.sql<{ configuration_id: string; used: string }>(
      `SELECT p.configuration_id, l.used::text FROM reservation_lines l JOIN budget_pools p ON p.pool_id = l.pool_id WHERE l.attempt_id = $1 AND p.dimension = 'MODEL_SPEND'`,
      [work.attemptId],
    );
    expect(line).toEqual({ configuration_id: 'proposer-a', used: '3.25000000' });
  });

  it('is refused when the output names no proposal kind that is defined', async () => {
    const work = await startAgent(flow, { slot: 'rev-b', role: 'PROPOSER', configuration: 'proposer-b' });
    const claimed = await claim(flow, work.attemptId, 'runner', AGENT_RUNNER);
    const { message } = await outboxOf(flow, work.attemptId);
    const output = await upload(
      flow,
      claimed,
      bytesOf({ schema_version: 'strategy-formulation.result/1', proposal_kind: 'anything' }),
    );
    const response = await submit(
      flow,
      claimed,
      'agent-result',
      agentResultDoc(claimed, message, {
        outcome: 'completion',
        output: { contract: 'strategy-formulation.result/1', artefact: output },
      }),
    );
    expect(response.status).toBe(400);
  });
});

describe('a runner that stopped after cancel_mission', () => {
  it('confirms the termination of the cancelled attempt: the reservation is settled from its report, never more than reserved', async () => {
    const started = await startedFlow();
    try {
      expect((await driveRetrieval(started)).response.status).toBe(204);
      expect(
        (await driveValidation(started, { trialSlot: 'seed', draftDigest: started.world.records.seedDigest })).response
          .status,
      ).toBe(204);
      const work = await startAgent(started, { slot: 'seed', role: 'CRITIC' });
      const claimed = await claim(started, work.attemptId, 'runner', AGENT_RUNNER);
      const { message } = await outboxOf(started, work.attemptId);
      const [mission] = await started.world.sql<{ revision: number }>(
        'SELECT revision FROM missions WHERE mission_id = $1',
        [started.missionId],
      );
      const cancelled = await started.world.apply(
        'researcher',
        { kind: 'cancel_mission', mission_id: started.missionId, reason: 'Withdrawn.' },
        { expectedRevision: mission?.revision as number },
      );
      expect(cancelled.state).toBe('APPLIED');
      // cancel_mission keeps the reservation of a claimed attempt until its termination is confirmed.
      const [held] = await started.world.sql<{ status: string }>(
        'SELECT status FROM reservations WHERE attempt_id = $1',
        [work.attemptId],
      );
      expect(held?.status).toBe('RESERVED');
      const stopped = agentResultDoc(
        claimed,
        message,
        { outcome: 'cancellation', diagnostic: 'The host terminated the process tree on cancellation.' },
        (result) => {
          result.usage.cost = { label: 'estimated', amount: '1.10', currency: 'USD' };
          result.usage.duration = { label: 'observed', milliseconds: 30000 };
        },
      );
      const response = await submit(started, claimed, 'agent-result', stopped);
      expect(response.status).toBe(204);
      const [settled] = await started.world.sql<{ status: string }>(
        'SELECT status FROM reservations WHERE attempt_id = $1',
        [work.attemptId],
      );
      expect(settled?.status).toBe('SETTLED');
      const [pool] = await started.world.sql<{ committed: string }>(
        `SELECT committed::text FROM budget_pools WHERE scope = 'MISSION' AND mission_id = $1 AND configuration_id = 'critic'`,
        [started.missionId],
      );
      expect(pool?.committed).toBe('1.10000000');
      const [attempt] = await started.world.sql<{ status: string }>(
        'SELECT status FROM attempts WHERE attempt_id = $1',
        [work.attemptId],
      );
      expect(attempt?.status).toBe('CANCELLED');
      expect(
        await started.world.sql('SELECT 1 FROM agent_results WHERE attempt_id = $1', [work.attemptId]),
      ).toHaveLength(0);
    } finally {
      await started.world.drop();
    }
  });

  it('a late completion from an attempt whose lease ended is rejected and recorded: LEASE_EXPIRED', async () => {
    const work = await startAgent(flow, { slot: 'seed', role: 'CRITIC' });
    const claimed = await claim(flow, work.attemptId, 'runner', AGENT_RUNNER);
    const { message } = await outboxOf(flow, work.attemptId);
    const output = await upload(flow, claimed, bytesOf({ schema_version: 'strategy-critique.result/1', findings: [] }));
    // The agent timeout of the pilot policy is 900 seconds, and the lease adds 60.
    flow.world.testApp.clock.advanceSeconds(961);
    const response = await submit(
      flow,
      claimed,
      'agent-result',
      agentResultDoc(claimed, message, {
        outcome: 'completion',
        output: { contract: 'strategy-critique.result/1', artefact: output },
      }),
    );
    expect(response.status).toBe(409);
    expect((await json<{ code: string }>(response)).code).toBe('LEASE_EXPIRED');
    expect(await flow.world.sql('SELECT 1 FROM agent_results WHERE attempt_id = $1', [work.attemptId])).toHaveLength(0);
  });
});

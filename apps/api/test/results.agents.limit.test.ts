// The output limit of the cohort policy (OQ-03 section 4, cohort-policy/1 ExecutionLimits): every proposer
// configuration and the critic get the same limit, agent_output_limit_bytes, and an agent output above it is a
// malformed result (decision D6: output overflow is malformed_result, with the reason OUTPUT_LIMIT_EXCEEDED of
// agent-attempt-result/1). The API is the backstop of the runner's own cap, so it holds both roles to the registered
// limit, which cohort-policy/1 caps at 512 KiB, the parse limit of a role output. An over-limit completion is
// recorded as that outcome and its attempt is settled: it is not left CLAIMED, and it is retried within the attempt
// cap like any other malformed result.
//
// The sizes are the byte lengths of the canonical JSON that the test uploads; they are counted here, not read from src.

import { validateContract } from '@openquant/api-contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AGENT_RUNNER,
  bytesOf,
  claim,
  driveRetrieval,
  type Flow,
  outboxOf,
  type Started,
  startAgent,
  startedFlow,
  submit,
  upload,
} from './support/flow.ts';
import { agentResultDoc, driveValidation } from './support/steps.ts';
import { type Doc, fixture } from './support/world.ts';

const LIMIT = 2048;

function finding(description: string): Doc {
  return {
    category: 'method_advice',
    description,
    method_refs: [],
    evidence_refs: [],
    location: { area: 'rationale' },
    affected_elements: [],
  };
}

/** A valid critic output of exactly `size` bytes: one finding whose description (at most 2000 characters) is the filler. */
function critiqueOfSize(size: number): Uint8Array {
  const shape = (description: string) => ({
    schema_version: 'strategy-critique.result/1',
    findings: [finding(description)],
  });
  const room = size - bytesOf(shape('')).length;
  if (room < 0 || room > 2000) throw new Error(`A critic output of ${size} bytes needs ${room} characters of filler.`);
  const bytes = bytesOf(shape('x'.repeat(room)));
  if (bytes.length !== size) throw new Error(`The critic output has ${bytes.length} bytes, not ${size}.`);
  return bytes;
}

/** A proposer output of exactly `size` bytes: the tag, the proposal kind and filler. */
function formulationOfSize(size: number): Uint8Array {
  const shape = (filler: string) => ({
    schema_version: 'strategy-formulation.result/1',
    proposal_kind: 'controlled_revision',
    filler,
  });
  const bytes = bytesOf(shape('x'.repeat(size - bytesOf(shape('')).length)));
  if (bytes.length !== size) throw new Error(`The proposer output has ${bytes.length} bytes, not ${size}.`);
  return bytes;
}

type Role = 'CRITIC' | 'PROPOSER';

const roles: {
  role: Role;
  slot: string;
  configuration: string;
  contract: string;
  output: (size: number) => Uint8Array;
}[] = [
  {
    role: 'CRITIC',
    slot: 'seed',
    configuration: 'critic',
    contract: 'strategy-critique.result/1',
    output: critiqueOfSize,
  },
  {
    role: 'PROPOSER',
    slot: 'rev-a',
    configuration: 'proposer-a',
    contract: 'strategy-formulation.result/1',
    output: formulationOfSize,
  },
];

async function limitedFlow(limit: number): Promise<Flow & Started> {
  const flow = await startedFlow({
    policy: (policy) => {
      policy.limits.concurrent_agent_attempts = 10;
      policy.limits.agent_output_limit_bytes = limit;
    },
  });
  expect((await driveRetrieval(flow)).response.status).toBe(204);
  expect(
    (await driveValidation(flow, { trialSlot: 'seed', draftDigest: flow.world.records.seedDigest })).response.status,
  ).toBe(204);
  return flow;
}

async function report(flow: Flow & Started, entry: (typeof roles)[number], bytes: Uint8Array) {
  const work = await startAgent(flow, { slot: entry.slot, role: entry.role, configuration: entry.configuration });
  const claimed = await claim(flow, work.attemptId, 'runner', AGENT_RUNNER);
  const output = await upload(flow, claimed, bytes);
  const { message } = await outboxOf(flow, work.attemptId);
  const result = agentResultDoc(claimed, message, {
    outcome: 'completion',
    output: { contract: entry.contract, artefact: output },
  });
  const response = await submit(flow, claimed, 'agent-result', result);
  return { work, claimed, output, result, response };
}

describe('an output above the limit of the policy', () => {
  let flow: Flow & Started;
  beforeAll(async () => {
    flow = await limitedFlow(LIMIT);
  });
  afterAll(async () => {
    await flow.world.drop();
  });

  for (const entry of roles) {
    it(`of the ${entry.role.toLowerCase()} is a malformed result: recorded as OUTPUT_LIMIT_EXCEEDED, settled, and retried`, async () => {
      const findingsBefore = await flow.world.sql('SELECT 1 FROM findings');
      const { work, response } = await report(flow, entry, entry.output(LIMIT + 1));
      expect(response.status).toBe(204);

      const attempts = await flow.world.sql<{
        ownership_revision: number;
        status: string;
        agent_outcome: string | null;
        failure_code: string | null;
      }>(
        'SELECT ownership_revision, status, agent_outcome, failure_code FROM attempts WHERE job_id = $1 ORDER BY ownership_revision',
        [work.jobId],
      );
      // The attempt is settled, not left CLAIMED; the malformed result is retried within the cap of 3 attempts.
      expect(attempts).toEqual([
        {
          ownership_revision: 1,
          status: 'FAILED',
          agent_outcome: 'malformed_result',
          failure_code: 'AGENT_MALFORMED_RESULT',
        },
        { ownership_revision: 2, status: 'PENDING', agent_outcome: null, failure_code: null },
      ]);
      expect(
        await flow.world.sql<{ status: string }>('SELECT status FROM jobs WHERE job_id = $1', [work.jobId]),
      ).toEqual([{ status: 'QUEUED' }]);
      expect(
        await flow.world.sql(
          'SELECT outcome, reason, output_contract, output_digest FROM agent_results WHERE attempt_id = $1',
          [work.attemptId],
        ),
      ).toEqual([
        { outcome: 'malformed_result', reason: 'OUTPUT_LIMIT_EXCEEDED', output_contract: null, output_digest: null },
      ]);
      // Nothing of the output is taken: no finding, and the run is not COMPLETED.
      expect(await flow.world.sql('SELECT 1 FROM findings')).toEqual(findingsBefore);
      // The model spend is settled from the reported usage (3.25 estimated of 5.00), the reservation is not left open.
      expect(await flow.world.sql(`SELECT status FROM reservations WHERE attempt_id = $1`, [work.attemptId])).toEqual([
        { status: 'SETTLED' },
      ]);
    });

    it(`of exactly the limit is a completion of the ${entry.role.toLowerCase()}`, async () => {
      const { work, response } = await report(flow, entry, entry.output(LIMIT));
      expect(response.status).toBe(204);
      expect(
        await flow.world.sql<{ outcome: string }>('SELECT outcome FROM agent_results WHERE attempt_id = $1', [
          work.attemptId,
        ]),
      ).toEqual([{ outcome: 'completion' }]);
      expect(
        await flow.world.sql<{ status: string }>('SELECT status FROM jobs WHERE job_id = $1', [work.jobId]),
      ).toEqual([{ status: 'COMPLETED' }]);
    });
  }
});

describe('a limit of 512 KiB, the parse limit of a role output', () => {
  const CEILING = 512 * 1024;
  let flow: Flow & Started;
  beforeAll(async () => {
    flow = await limitedFlow(CEILING);
  });
  afterAll(async () => {
    await flow.world.drop();
  });

  it('is the most that a cohort policy can register: one byte more is not a cohort-policy/1', () => {
    const policy = structuredClone(fixture('cohort-policy.s1-pilot.json')) as Doc;
    policy.limits.agent_output_limit_bytes = CEILING;
    expect(validateContract('cohort-policy', policy).ok).toBe(true);
    policy.limits.agent_output_limit_bytes = CEILING + 1;
    expect(validateContract('cohort-policy', policy).ok).toBe(false);
  });

  it('holds the proposer: an output of one byte more is malformed, one of the limit is a completion', async () => {
    const entry = roles[1] as (typeof roles)[number];
    const over = await report(flow, entry, entry.output(CEILING + 1));
    expect(over.response.status).toBe(204);
    expect(
      await flow.world.sql('SELECT outcome, reason FROM agent_results WHERE attempt_id = $1', [over.work.attemptId]),
    ).toEqual([{ outcome: 'malformed_result', reason: 'OUTPUT_LIMIT_EXCEEDED' }]);
    const at = await report(flow, entry, entry.output(CEILING));
    expect(at.response.status).toBe(204);
    expect(
      await flow.world.sql('SELECT outcome FROM agent_results WHERE attempt_id = $1', [at.work.attemptId]),
    ).toEqual([{ outcome: 'completion' }]);
  });
});

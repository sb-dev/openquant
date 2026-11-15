// Semantic-invalid cases of the API (OQ-05 section 7; OQ-02 sections 3.1 and 3.6): documents that pass the contract
// layer, because a schema cannot state the rule, and that the API refuses. Each case first shows that the document is
// valid for its contract (so the rule really lives in the API), then that the API refuses it with the code that the
// route lists, and that the refusal changed no row but its own audit record. The rules are the four families that the
// API owns beyond the schemas: budget arithmetic, hash binding, lineage and outcome mapping. Outcome mapping and the
// further binding cases of the evaluation route have their own tables in results.evaluation.test.ts.

import { createHash } from 'node:crypto';
import { parseContract } from '@openquant/api-contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { startValidation } from '../src/domain/builders.ts';
import { storeBytes } from '../src/domain/store.ts';
import {
  bytesOf,
  claim,
  createFlow,
  driveRetrieval,
  errorCode,
  type Flow,
  json,
  manifestFor,
  requestOf,
  retrievalResult,
  type Started,
  sha,
  startedFlow,
  submit,
  upload,
} from './support/flow.ts';
import { ids } from './support/seed.ts';
import { driveValidation } from './support/steps.ts';
import { type Doc, missionPayload, registerRecords } from './support/world.ts';

const flows: Flow[] = [];
async function fresh(): Promise<Flow & Started> {
  const flow = await startedFlow();
  flows.push(flow);
  return flow;
}
afterEach(async () => {
  for (const flow of flows.splice(0)) await flow.world.drop();
});

/** Every table except the audit log and the command records: what a refusal must leave as it found it. */
const state = (flow: Flow) => flow.world.snapshot(['audit_events', 'commands']);

describe('budget arithmetic: a mission budget that adds up wrongly', () => {
  const cases: [string, (mission: Doc) => void, string][] = [
    ['a model spend that is not the allowances added up', (m) => (m.budget.model_spend.amount = '104.00'), 'added up'],
    [
      'a proposer allowance that is not its attempts times the reservation',
      (m) => {
        m.budget.proposer_allowance.model_spend.amount = '31.00';
        m.budget.model_spend.amount = '107.00';
      },
      'proposer allowance',
    ],
    [
      'agent seconds that do not cover the attempts of the allowances',
      (m) => (m.budget.agent_compute_seconds = 18899),
      'agent compute seconds',
    ],
    [
      'fewer provider requests than the attempt cap needs',
      (m) => (m.budget.provider_requests = 2),
      'at least one request',
    ],
    [
      'a spend in another currency than the period budget',
      (m) => {
        for (const money of [
          m.budget.model_spend,
          m.budget.model_spend_per_attempt,
          m.budget.proposer_allowance.model_spend,
          m.budget.critic_allowance.model_spend,
        ])
          money.currency = 'EUR';
      },
      'currency',
    ],
  ];

  it('is refused with POLICY_VIOLATION through the route, although the command is valid for its contract', async () => {
    const flow = await createFlow();
    flows.push(flow as Flow & Started);
    await registerRecords(flow.world);
    const researcher = await flow.person('researcher');
    const before = await state(flow);
    for (const [label, change, text] of cases) {
      const body = flow.world.command(missionPayload(flow.world, change));
      expect(parseContract('command', JSON.stringify(body)).ok, `${label}: valid for command/1`).toBe(true);
      const response = await flow.send('POST', '/v1/missions', researcher, body);
      expect(response.status, label).toBe(422);
      const failure = await json<{ code: string; message: string }>(response);
      expect(failure.code, label).toBe('POLICY_VIOLATION');
      expect(failure.message, label).toContain(text);
    }
    expect(await state(flow)).toEqual(before);
  });
});

describe('hash binding: a result that is not the answer to its request', () => {
  it('is refused with IDENTITY_MISMATCH although it is valid for its contract, and the attempt stays claimed', async () => {
    const flow = await fresh();
    const { jobId, attemptId } = flow.retrieve;
    const claimed = await claim(flow, attemptId);
    const request = await requestOf(flow, attemptId);
    const manifest = manifestFor(flow, { jobId, attemptId, requestDigest: request.digest });
    const manifestRef = await upload(flow, claimed, bytesOf(manifest));
    const elsewhere: Doc = JSON.parse(JSON.stringify(manifest));
    elsewhere.retrieval.request_digest = sha('another request');
    const elsewhereRef = await upload(flow, claimed, bytesOf(elsewhere));
    const cases: [string, Doc][] = [
      [
        'a request digest that is not the digest of the request',
        retrievalResult(claimed, jobId, sha('another request'), { status: 'COMPLETE', manifest: manifestRef }),
      ],
      [
        'a manifest that answers another request than the one of its result',
        retrievalResult(claimed, jobId, request.digest, { status: 'COMPLETE', manifest: elsewhereRef }),
      ],
      [
        'a result for another job',
        retrievalResult(claimed, 'job-other', request.digest, { status: 'COMPLETE', manifest: manifestRef }),
      ],
    ];
    const before = await state(flow);
    for (const [label, result] of cases) {
      expect(parseContract('retrieval-result', JSON.stringify(result)).ok, `${label}: valid`).toBe(true);
      const response = await submit(flow, claimed, 'retrieval-result', result);
      expect(response.status, label).toBe(422);
      expect(await errorCode(response), label).toBe('IDENTITY_MISMATCH');
    }
    expect(await state(flow)).toEqual(before);
    expect(await flow.world.sql('SELECT status FROM attempts WHERE attempt_id = $1', [attemptId])).toEqual([
      { status: 'CLAIMED' },
    ]);
  });
});

describe('lineage: where a validation may start', () => {
  const oneDraft = (label: string) => bytesOf({ test_draft: label });

  async function withPlan(): Promise<Flow & Started> {
    const flow = await fresh();
    expect((await driveRetrieval(flow)).response.status).toBe(204);
    return flow;
  }
  async function draft(flow: Flow, label: string): Promise<string> {
    const bytes = oneDraft(label);
    await flow.world.tx((tx) => storeBytes(tx, flow.world.testApp.env, bytes, ids.workflows));
    return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  }
  const start = (flow: Flow & Started, input: { trialSlot: string; draftDigest: string; parentHash?: string }) =>
    flow.world.tx((tx) => startValidation(tx, flow.work(), { missionId: flow.missionId, ...input }));

  it('refuses a revision before the seed is registered, and a seed with a parent or with another draft', async () => {
    const flow = await withPlan();
    const other = await draft(flow, 'other');
    const seed = flow.world.records.seedDigest;
    const before = await state(flow);
    const refused: [string, Awaited<ReturnType<typeof start>>][] = [
      [
        'a revision of an unregistered seed',
        await start(flow, { trialSlot: 'rev-a', draftDigest: other, parentHash: seed }),
      ],
      ['a seed with a parent', await start(flow, { trialSlot: 'seed', draftDigest: seed, parentHash: sha('parent') })],
      ['a seed slot with another draft', await start(flow, { trialSlot: 'seed', draftDigest: other })],
      ['a slot that the plan does not have', await start(flow, { trialSlot: 'rev-z', draftDigest: other })],
    ];
    for (const [label, started] of refused) expect(started.ok, label).toBe(false);
    const reasons = refused.map(([, started]) => (started.ok ? '' : started.reason));
    expect(reasons[0]).toContain('no registered Strategy Version to revise');
    expect(reasons[1]).toContain('no parent');
    expect(reasons[2]).toContain('seed draft of the plan');
    expect(reasons[3]).toContain('no trial slot');
    // A refusal opens no trial, job, attempt or reservation.
    expect(await state(flow)).toEqual(before);
  });

  it('refuses a revision that is not a revision of the registered seed, and a revision without a parent', async () => {
    const flow = await withPlan();
    const seed = flow.world.records.seedDigest;
    expect((await driveValidation(flow, { trialSlot: 'seed', draftDigest: seed })).response.status).toBe(204);
    const other = await draft(flow, 'revision');
    const before = await state(flow);
    for (const [label, parentHash] of [
      ['a parent that is not the seed', sha('not the seed')],
      ['no parent', undefined],
    ] as const) {
      const started = await start(flow, {
        trialSlot: 'rev-a',
        draftDigest: other,
        ...(parentHash === undefined ? {} : { parentHash }),
      });
      expect(started.ok, label).toBe(false);
      expect(started.ok ? '' : started.reason, label).toContain(
        `revises the Strategy Version registered for seed: ${seed}`,
      );
    }
    expect(await state(flow)).toEqual(before);
    // The registered seed is a parent: the start is accepted, with its trial, job, attempt and reservation.
    const started = await start(flow, { trialSlot: 'rev-a', draftDigest: other, parentHash: seed });
    expect(started.ok).toBe(true);
  });

  it('refuses a proposal beyond the revisions of the mission budget for a slot, and leaves the other slot alone', async () => {
    const flow = await withPlan();
    const seed = flow.world.records.seedDigest;
    expect((await driveValidation(flow, { trialSlot: 'seed', draftDigest: seed })).response.status).toBe(204);
    // The pilot budget allows two proposals for each proposer configuration (revisions_per_proposer).
    const [budget] = await flow.world.sql<{ revisions_per_proposer: number }>(
      'SELECT revisions_per_proposer FROM mission_budgets WHERE mission_id = $1',
      [flow.missionId],
    );
    expect(budget?.revisions_per_proposer).toBe(2);
    for (const label of ['first', 'second']) {
      const started = await start(flow, {
        trialSlot: 'rev-a',
        draftDigest: await draft(flow, `rev-a ${label}`),
        parentHash: seed,
      });
      expect(started.ok, label).toBe(true);
    }
    const thirdDraft = await draft(flow, 'rev-a third');
    const before = await state(flow);
    const third = await start(flow, { trialSlot: 'rev-a', draftDigest: thirdDraft, parentHash: seed });
    expect(third.ok).toBe(false);
    expect(third.ok ? '' : third.reason).toContain('has used its 2 proposals');
    expect(await flow.world.sql('SELECT 1 FROM trials WHERE draft_digest = $1', [thirdDraft])).toHaveLength(0);
    expect(await state(flow)).toEqual(before);
    // The other proposer configuration has its own slot and its own count.
    const other = await start(flow, { trialSlot: 'rev-b', draftDigest: await draft(flow, 'rev-b'), parentHash: seed });
    expect(other.ok).toBe(true);
  });
});

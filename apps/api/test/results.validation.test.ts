// attempts.validation-result (OQ-02 sections 3.1 and 4; OQ-05 section 4; decisions D8 and D9): the Rust validate job ran
// the shared validator on a draft. The API binds the result to the draft and parent that the job asked about, to the
// declared changes of a revision, and to the release; a VALID result registers a Strategy Version in DRAFT with its
// lineage, an INVALID one registers nothing. Either way the job is COMPLETED.

import { parseContract } from '@openquant/api-contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { storeDocument } from '../src/domain/store.ts';
import { sameChanges } from '../src/domain/validation.ts';
import {
  claim,
  driveRetrieval,
  errorCode,
  type Flow,
  type Started,
  sha,
  startedFlow,
  startValidationOf,
  submit,
} from './support/flow.ts';
import { driveValidation, validationResult } from './support/steps.ts';
import { type Doc, fixture } from './support/world.ts';

const flows: (Flow & Started)[] = [];
async function fresh(): Promise<Flow & Started> {
  // A refused result leaves its attempt claimed, so the cases of one test hold several leases at once.
  const flow = await startedFlow({
    policy: (policy) => {
      policy.limits.concurrent_batch_attempts = 10;
    },
  });
  flows.push(flow);
  expect((await driveRetrieval(flow)).response.status).toBe(204);
  return flow;
}
afterEach(async () => {
  for (const flow of flows.splice(0)) await flow.world.drop();
});

const CHANGE = { path: '/definition/entry/args/1/args/0/params/value', from: '30', to: '32' };

/** The revision draft: the seed with version 2, its parent and the declared change. Stored as the workflow stores a draft. */
async function revisionDraft(flow: Flow & Started, edit?: (draft: Doc) => void): Promise<string> {
  const draft = structuredClone((fixture('command.register-seed.json').payload as Doc).draft) as Doc;
  draft.version = 2;
  draft.parent = { hash: flow.world.records.seedDigest, changes: [{ ...CHANGE }] };
  edit?.(draft);
  const stored = await flow.world.tx((tx) =>
    storeDocument(tx, flow.world.testApp.env, 'strategy-artefact', draft, 'svc-workflows'),
  );
  return stored.ref.digest;
}

const REVISION_OUTCOME: Doc = {
  status: 'VALID',
  max_lookback_sessions: 50,
  warmup_sessions: 60,
  computed_changes: [CHANGE],
  change_scope: 'ENTRY',
};

describe('a VALID seed', () => {
  it('registers Strategy Version 1 in DRAFT, completes the job, and settles the reservation from the measured duration', async () => {
    const flow = await fresh();
    const seed = flow.world.records.seedDigest;
    const { work, response } = await driveValidation(flow, { trialSlot: 'seed', draftDigest: seed });
    expect(response.status).toBe(204);
    const [version] = await flow.world.sql<Record<string, unknown>>(
      'SELECT strategy_hash, strategy_id, version, parent_hash, lifecycle, mission_id FROM strategy_versions',
    );
    expect(version).toEqual({
      strategy_hash: seed,
      strategy_id: 'daily-swing-seed',
      version: 1,
      parent_hash: null,
      lifecycle: 'DRAFT',
      mission_id: flow.missionId,
    });
    const [trial] = await flow.world.sql<{
      trial_slot: string;
      proposal_ordinal: number;
      status: string;
      strategy_hash: string;
    }>('SELECT trial_slot, proposal_ordinal, status, strategy_hash FROM trials');
    expect(trial).toEqual({ trial_slot: 'seed', proposal_ordinal: 1, status: 'REGISTERED', strategy_hash: seed });
    const [recorded] = await flow.world.sql<Record<string, unknown>>(
      'SELECT job_id, status, change_scope, strategy_hash, draft_digest FROM validation_results',
    );
    expect(recorded).toEqual({
      job_id: work.jobId,
      status: 'VALID',
      change_scope: null,
      strategy_hash: seed,
      draft_digest: seed,
    });
    expect(await flow.world.sql('SELECT 1 FROM strategy_lineage')).toHaveLength(0);
    const [job] = await flow.world.sql<{ status: string }>('SELECT status FROM jobs WHERE job_id = $1', [work.jobId]);
    expect(job?.status).toBe('COMPLETED');
    // 1840 ms round up to 2 of the 60 seconds that a validation reserves under the pilot policy.
    const [line] = await flow.world.sql<{ reserved: string; used: string }>(
      'SELECT reserved::text, used::text FROM reservation_lines WHERE attempt_id = $1',
      [work.attemptId],
    );
    expect(line).toEqual({ reserved: '60.00000000', used: '2.00000000' });
  });

  it('answers a redelivery with the stored outcome, and refuses another result from the same attempt', async () => {
    const flow = await fresh();
    const { claimed, work } = await driveValidation(flow, {
      trialSlot: 'seed',
      draftDigest: flow.world.records.seedDigest,
    });
    const same = validationResult(flow, claimed, work.jobId, flow.world.records.seedDigest);
    const before = await flow.world.snapshot();
    expect((await submit(flow, claimed, 'validation-result', same)).status).toBe(204);
    expect(await flow.world.snapshot()).toEqual(before);
    const other = validationResult(flow, claimed, work.jobId, flow.world.records.seedDigest, {
      status: 'VALID',
      max_lookback_sessions: 20,
      warmup_sessions: 60,
    });
    const refused = await submit(flow, claimed, 'validation-result', other);
    expect(refused.status).toBe(422);
    expect(await flow.world.sql('SELECT 1 FROM validation_results')).toHaveLength(1);
  });
});

describe('an INVALID draft', () => {
  it('registers nothing: the trial is INVALID with the diagnostics, the job is COMPLETED, and nothing reaches the lineage', async () => {
    const flow = await fresh();
    const outcome = {
      status: 'INVALID',
      diagnostics: [
        {
          code: 'UNSUPPORTED_OPERATOR',
          pointer: '/definition/entry',
          detail: 'The operator is not in the permitted set.',
        },
        { code: 'LOOKBACK_EXCEEDS_WARMUP', pointer: '', detail: 'The longest lookback is 61 sessions.' },
      ],
    };
    const { work, response } = await driveValidation(flow, {
      trialSlot: 'seed',
      draftDigest: flow.world.records.seedDigest,
      outcome,
    });
    expect(response.status).toBe(204);
    expect(await flow.world.sql('SELECT 1 FROM strategy_versions')).toHaveLength(0);
    const [trial] = await flow.world.sql<{ status: string; reason: string; strategy_hash: string | null }>(
      'SELECT status, reason, strategy_hash FROM trials',
    );
    expect(trial).toEqual({
      status: 'INVALID',
      reason: 'UNSUPPORTED_OPERATOR at /definition/entry; LOOKBACK_EXCEEDS_WARMUP',
      strategy_hash: null,
    });
    const [recorded] = await flow.world.sql<{ status: string; strategy_hash: string | null }>(
      'SELECT status, strategy_hash FROM validation_results',
    );
    expect(recorded).toEqual({ status: 'INVALID', strategy_hash: null });
    const [job] = await flow.world.sql<{ status: string }>('SELECT status FROM jobs WHERE job_id = $1', [work.jobId]);
    expect(job?.status).toBe('COMPLETED');
  });
});

describe('a revision', () => {
  async function withSeed() {
    const flow = await fresh();
    expect(
      (await driveValidation(flow, { trialSlot: 'seed', draftDigest: flow.world.records.seedDigest })).response.status,
    ).toBe(204);
    return flow;
  }

  it('registers Strategy Version 2 with its parent and the recorded lineage when the computed changes are the declared ones', async () => {
    const flow = await withSeed();
    const seed = flow.world.records.seedDigest;
    const draft = await revisionDraft(flow);
    const { response, work } = await driveValidation(flow, {
      trialSlot: 'rev-a',
      draftDigest: draft,
      parentHash: seed,
      outcome: REVISION_OUTCOME,
    });
    expect(response.status, await response.clone().text()).toBe(204);
    const versions = await flow.world.sql<{ strategy_hash: string; version: number; parent_hash: string | null }>(
      'SELECT strategy_hash, version, parent_hash FROM strategy_versions ORDER BY version',
    );
    expect(versions).toEqual([
      { strategy_hash: seed, version: 1, parent_hash: null },
      { strategy_hash: draft, version: 2, parent_hash: seed },
    ]);
    const [lineage] = await flow.world.sql<{
      child_hash: string;
      parent_hash: string;
      change_scope: string;
      validation_digest: string;
    }>('SELECT child_hash, parent_hash, change_scope, validation_digest FROM strategy_lineage');
    expect(lineage).toMatchObject({ child_hash: draft, parent_hash: seed, change_scope: 'ENTRY' });
    const [recorded] = await flow.world.sql<{ change_scope: string; result_digest: string }>(
      'SELECT change_scope, result_digest FROM validation_results WHERE job_id = $1',
      [work.jobId],
    );
    expect(recorded?.change_scope).toBe('ENTRY');
    expect(lineage?.validation_digest).toBe(recorded?.result_digest);
  });

  it('is INVALID with REVISION_SCOPE when it changes both rules: registered nothing, and its diagnostics are kept for the next attempt', async () => {
    const flow = await withSeed();
    const draft = await revisionDraft(flow);
    const outcome = {
      status: 'INVALID',
      diagnostics: [
        { code: 'REVISION_SCOPE', pointer: '', detail: 'The changes affect the entry rule and the exit rules.' },
      ],
    };
    const { response } = await driveValidation(flow, {
      trialSlot: 'rev-a',
      draftDigest: draft,
      parentHash: flow.world.records.seedDigest,
      outcome,
    });
    expect(response.status).toBe(204);
    expect(await flow.world.sql('SELECT 1 FROM strategy_versions')).toHaveLength(1);
    expect(await flow.world.sql('SELECT 1 FROM strategy_lineage')).toHaveLength(0);
    const trials = await flow.world.sql<{ trial_slot: string; status: string; reason: string | null }>(
      'SELECT trial_slot, status, reason FROM trials ORDER BY trial_slot',
    );
    expect(trials).toEqual([
      { trial_slot: 'rev-a', status: 'INVALID', reason: 'REVISION_SCOPE' },
      { trial_slot: 'seed', status: 'REGISTERED', reason: null },
    ]);
  });

  it('is refused when the changes that Rust computed are not the changes that the draft declares', async () => {
    const flow = await withSeed();
    const draft = await revisionDraft(flow);
    const refusals: [string, Doc][] = [
      ['another value', { ...REVISION_OUTCOME, computed_changes: [{ ...CHANGE, to: '33' }] }],
      ['another path', { ...REVISION_OUTCOME, computed_changes: [{ ...CHANGE, path: '/definition/exits/stop' }] }],
      [
        'an extra change',
        { ...REVISION_OUTCOME, computed_changes: [CHANGE, { path: '/definition/exits/stop', from: '1', to: '2' }] },
      ],
    ];
    // Each refused proposal is a trial of its slot, and a slot has two proposals: the cases alternate the two slots.
    for (const [index, [label, outcome]] of refusals.entries()) {
      const { response } = await driveValidation(flow, {
        trialSlot: index % 2 === 0 ? 'rev-a' : 'rev-b',
        draftDigest: draft,
        parentHash: flow.world.records.seedDigest,
        outcome,
      });
      expect(response.status, label).toBe(422);
      expect(await errorCode(response), label).toBe('IDENTITY_MISMATCH');
    }
    expect(await flow.world.sql('SELECT 1 FROM strategy_versions')).toHaveLength(1);
  });

  it('is refused when its draft names another parent, another strategy, or a version that exists already', async () => {
    const flow = await withSeed();
    const seed = flow.world.records.seedDigest;
    const cases: [string, (draft: Doc) => void][] = [
      ['another parent', (draft) => (draft.parent.hash = sha('another parent'))],
      ['another strategy than the parent', (draft) => (draft.strategy_id = 'another-strategy')],
      ['a version that is registered already', (draft) => (draft.version = 1)],
    ];
    for (const [index, [label, edit]] of cases.entries()) {
      const draft = await revisionDraft(flow, edit);
      const { response } = await driveValidation(flow, {
        trialSlot: index % 2 === 0 ? 'rev-a' : 'rev-b',
        draftDigest: draft,
        parentHash: seed,
        outcome: REVISION_OUTCOME,
      });
      expect(response.status, label).toBe(422);
      expect(await errorCode(response), label).toBe('IDENTITY_MISMATCH');
    }
  });
});

describe('a result that does not bind to its job', () => {
  it('is refused for another job, another draft, a parent on a seed, another engine, method or executable, and a warm-up that is not the policy’s', async () => {
    const flow = await fresh();
    const seed = flow.world.records.seedDigest;
    const work = await startValidationOf(flow, { trialSlot: 'seed', draftDigest: seed });
    const claimed = await claim(flow, work.attemptId);
    const base = (edit: (result: Doc) => void, outcome?: Doc) => {
      const result = validationResult(flow, claimed, work.jobId, seed, outcome);
      edit(result);
      return result;
    };
    const cases: [string, Doc][] = [
      ['another job', base((result) => (result.job_id = 'job-other'))],
      ['another draft', base((result) => (result.draft_digest = sha('another draft')))],
      ['a parent on a seed job', base((result) => (result.parent_hash = sha('parent')), REVISION_OUTCOME)],
      ['another engine', base((result) => (result.engine_digest = sha('another engine')))],
      ['another method', base((result) => (result.method.version = '2'))],
      ['another executable', base((result) => (result.executable.digest = sha('another binary')))],
      [
        'a warm-up that is not the policy’s',
        base(() => undefined, { status: 'VALID', max_lookback_sessions: 50, warmup_sessions: 59 }),
      ],
      [
        'a lookback beyond the warm-up',
        base(() => undefined, { status: 'VALID', max_lookback_sessions: 61, warmup_sessions: 60 }),
      ],
    ];
    const before = await flow.world.snapshot(['audit_events']);
    for (const [label, result] of cases) {
      expect(
        parseContract('validation-result', JSON.stringify(result)).ok,
        `${label}: the result is schema-valid`,
      ).toBe(true);
      const response = await submit(flow, claimed, 'validation-result', result);
      expect(response.status, label).toBe(422);
      expect(await errorCode(response), label).toBe('IDENTITY_MISMATCH');
    }
    expect(await flow.world.snapshot(['audit_events'])).toEqual(before);
    const [attempt] = await flow.world.sql<{ status: string }>('SELECT status FROM attempts WHERE attempt_id = $1', [
      work.attemptId,
    ]);
    expect(attempt?.status).toBe('CLAIMED');
    // The attempt is still the owner: a valid result is accepted afterwards.
    expect(
      (await submit(flow, claimed, 'validation-result', validationResult(flow, claimed, work.jobId, seed))).status,
    ).toBe(204);
  });
});

describe('the rule that compares declared and computed changes', () => {
  const a = { path: '/x', from: '1', to: '2' };
  const b = { path: '/y', from: '3', to: '4' };
  it('is a comparison of sets: order does not matter, a missing or an extra change does', () => {
    expect(sameChanges([a, b], [b, a])).toBe(true);
    expect(sameChanges([a], [a, b])).toBe(false);
    expect(sameChanges([a, b], [a])).toBe(false);
    expect(sameChanges([a, a], [a, b])).toBe(false);
    expect(sameChanges([], [])).toBe(true);
    expect(sameChanges([a], [{ ...a, to: '3' }])).toBe(false);
  });
});

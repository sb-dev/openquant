// The cohort policy applied to a draft before it can become a Strategy Version (OQ-02 section 4 step 2, OQ-03 section 4,
// cohort-policy/1 OperatorPermissions): "the API checks scope, bounds and lineage", and "execution-policy compatibility
// before accepting the immutable version". The Rust core checks operators, types, units and lookback but is not told the
// bounds, so a draft with a window or a constant outside parameter_bounds, or an operator that the policy does not
// permit, is reported VALID by Rust. The API must not register it. It checks twice:
//
//   - startValidation, before it dispatches a validate job: the proposal is recorded as an INVALID trial with the
//     diagnostics (they go to the next proposer attempt, like the diagnostics of Rust), and no job, attempt or
//     reservation is written;
//   - acceptValidationResult, before it registers: a VALID result for a draft that breaks the policy registers nothing,
//     records the trial as INVALID with the diagnostics, and the job is COMPLETED.
//
// The pilot policy bounds the windows at 60 or 59. The cases below register a policy that bounds the windows of the
// fixture seed (sma 50 and 20, rsi 14, atr 14, lag 1 and 2) or its operators differently. What each case expects is
// counted from the fixture seed draft, not read from src.

import { afterEach, describe, expect, it } from 'vitest';
import { openAttempt } from '../src/domain/attempts.ts';
import { startValidation } from '../src/domain/builders.ts';
import { storeDocument } from '../src/domain/store.ts';
import { insertJob } from '../src/domain/work.ts';
import { claim, driveRetrieval, type Flow, startedFlow, submit } from './support/flow.ts';
import { validationResult } from './support/steps.ts';
import { type Doc, fixture } from './support/world.ts';

const flows: (Flow & Awaited<ReturnType<typeof startedFlow>>)[] = [];
afterEach(async () => {
  for (const flow of flows.splice(0)) await flow.world.drop();
});

type Edit = (policy: Doc) => void;

const permission = (policy: Doc, operator: string): Doc =>
  policy.conditions.operators.permitted.find((entry: Doc) => entry.operator === operator);

const bounds =
  (operator: string, parameter: string, minimum: string, maximum: string): Edit =>
  (policy) => {
    permission(policy, operator).parameter_bounds = [{ parameter, minimum, maximum }];
  };

const forbid =
  (operator: string): Edit =>
  (policy) => {
    policy.conditions.operators.permitted = policy.conditions.operators.permitted.filter(
      (entry: Doc) => entry.operator !== operator,
    );
  };

async function fresh(edit: Edit) {
  const flow = await startedFlow({
    policy: (policy) => {
      policy.limits.concurrent_batch_attempts = 10;
      edit(policy);
    },
  });
  flows.push(flow);
  expect((await driveRetrieval(flow)).response.status).toBe(204);
  return flow;
}

const SEED = 'seed';

/** What startValidation does with the seed draft, in its own transaction as the workflow calls it. */
function start(flow: Awaited<ReturnType<typeof fresh>>, trialSlot = SEED, draftDigest = flow.world.records.seedDigest) {
  return flow.world.tx((tx) => startValidation(tx, flow.work(), { missionId: flow.missionId, trialSlot, draftDigest }));
}

/**
 * A validate job that was dispatched without the check of startValidation: a job that predates it. Its trial is
 * DRAFTED and its attempt is pending. The result of Rust for it is then the only thing that the API sees.
 */
async function dispatchedWithoutCheck(flow: Awaited<ReturnType<typeof fresh>>) {
  const draftDigest = flow.world.records.seedDigest;
  return flow.world.tx(async (tx) => {
    await tx.query(
      `INSERT INTO trials (trial_id, mission_id, trial_slot, proposal_ordinal, draft_digest, created_at)
       VALUES ('trial-unchecked', $1, 'seed', 1, $2, $3)`,
      [flow.missionId, draftDigest, '2026-11-15T10:00:00Z'],
    );
    const job = await insertJob(tx, flow.world.testApp.env, {
      missionId: flow.missionId,
      kind: 'validate',
      attemptCap: 3,
      trialSlot: 'seed',
      draftDigest,
    });
    const opened = await openAttempt(tx, flow.work(), job);
    if (!opened.ok) throw new Error(opened.reason);
    return { jobId: job.id, attemptId: opened.attemptId };
  });
}

const rows = async (flow: Awaited<ReturnType<typeof fresh>>) => ({
  versions: await flow.world.sql('SELECT strategy_hash FROM strategy_versions'),
  trials: await flow.world.sql<{ status: string; reason: string | null; proposal_ordinal: number }>(
    'SELECT status, reason, proposal_ordinal FROM trials ORDER BY proposal_ordinal',
  ),
  jobs: await flow.world.sql(`SELECT job_id FROM jobs WHERE kind = 'validate'`),
});

// The fixture seed draft: sma 50 at /definition/indicators/0, sma 20 at /1, rsi 14 at /2, atr 14 at /3, lag 1 and 2.
const cases: { label: string; edit: Edit; pointer: string; code: string; detail: string }[] = [
  {
    label: 'a window above the maximum',
    edit: bounds('operator:sma@1', 'window', '1', '30'),
    pointer: '/definition/indicators/0/expr/params/window',
    code: 'INVALID_PARAMETER',
    detail: 'above the maximum',
  },
  {
    label: 'a window below the minimum',
    edit: bounds('operator:sma@1', 'window', '25', '60'),
    pointer: '/definition/indicators/1/expr/params/window',
    code: 'INVALID_PARAMETER',
    detail: 'below the minimum',
  },
  {
    label: 'an operator that the policy does not permit',
    edit: forbid('operator:rsi_simple@1'),
    pointer: '/definition/indicators/2/expr/op',
    code: 'UNSUPPORTED_OPERATOR',
    detail: 'not permitted',
  },
];

describe('a draft that breaks the cohort policy is not dispatched', () => {
  for (const entry of cases) {
    it(`${entry.label}: an INVALID trial with the diagnostic, and no job, attempt or reservation`, async () => {
      const flow = await fresh(entry.edit);
      const before = await flow.world.snapshot(['trials', 'audit_events']);
      const started = await start(flow);
      expect(started.ok).toBe(false);
      if (started.ok) return;
      expect(started.diagnostics).toEqual([expect.objectContaining({ code: entry.code, pointer: entry.pointer })]);
      expect(started.diagnostics?.[0]?.detail).toContain(entry.detail);
      expect(started.reason).toContain(entry.pointer);
      expect(
        await flow.world.sql(`SELECT subject FROM audit_events WHERE event_type = 'trial.policy_violation'`),
      ).toEqual([{ subject: flow.missionId }]);
      const { trials, jobs, versions } = await rows(flow);
      // The proposal stays in the search history (A06) with the diagnostic that the next proposer attempt reads.
      expect(trials).toEqual([
        {
          status: 'INVALID',
          reason: expect.stringContaining(`${entry.code} at ${entry.pointer}`),
          proposal_ordinal: 1,
        },
      ]);
      expect(jobs).toEqual([]);
      expect(versions).toEqual([]);
      // Nothing else was written: no attempt, no reservation, no outbox entry, no pool movement.
      expect(await flow.world.snapshot(['trials', 'audit_events'])).toEqual(before);
    });

    it(`${entry.label}: a VALID result of Rust registers nothing, and the trial is INVALID with the diagnostic`, async () => {
      const flow = await fresh(entry.edit);
      const work = await dispatchedWithoutCheck(flow);
      const claimed = await claim(flow, work.attemptId);
      const result = validationResult(flow, claimed, work.jobId, flow.world.records.seedDigest);
      const response = await submit(flow, claimed, 'validation-result', result);
      expect(response.status).toBe(204);
      // Rust said VALID and the policy said otherwise: the refusal is in the audit log of the mission.
      expect(
        await flow.world.sql(`SELECT subject FROM audit_events WHERE event_type = 'trial.policy_violation'`),
      ).toEqual([{ subject: flow.missionId }]);
      const { trials, versions } = await rows(flow);
      expect(versions).toEqual([]);
      expect(trials).toEqual([
        {
          status: 'INVALID',
          reason: expect.stringContaining(`${entry.code} at ${entry.pointer}`),
          proposal_ordinal: 1,
        },
      ]);
      expect(await flow.world.sql('SELECT status, strategy_hash, change_scope FROM validation_results')).toEqual([
        { status: 'INVALID', strategy_hash: null, change_scope: null },
      ]);
      // The job is COMPLETED and its reservation settled from the measured duration: the result itself was accepted.
      expect(await flow.world.sql('SELECT status FROM jobs WHERE job_id = $1', [work.jobId])).toEqual([
        { status: 'COMPLETED' },
      ]);
      expect(await flow.world.sql('SELECT status FROM reservations WHERE attempt_id = $1', [work.attemptId])).toEqual([
        { status: 'SETTLED' },
      ]);
    });
  }

  it('a revision that breaks a bound is an INVALID trial that counts against the revision budget of its slot', async () => {
    // The seed (sma 20 and 50) sits on the bounds; a revision that widens the long window to 55 or 60 does not.
    const flow = await fresh(bounds('operator:sma@1', 'window', '20', '50'));
    const seed = await start(flow);
    if (!seed.ok) throw new Error(seed.reason);
    const claimed = await claim(flow, seed.attemptId);
    const registered = await submit(
      flow,
      claimed,
      'validation-result',
      validationResult(flow, claimed, seed.jobId, flow.world.records.seedDigest),
    );
    expect(registered.status).toBe(204);
    const revision = async (window: number) => {
      const draft = structuredClone((fixture('command.register-seed.json').payload as Doc).draft) as Doc;
      draft.version = 2;
      draft.parent = {
        hash: flow.world.records.seedDigest,
        changes: [{ path: '/definition/indicators/0/expr/params/window', from: '50', to: String(window) }],
      };
      draft.definition.indicators[0].expr.params.window = window;
      const stored = await flow.world.tx((tx) =>
        storeDocument(tx, flow.world.testApp.env, 'strategy-artefact', draft, 'svc-workflows'),
      );
      return flow.world.tx((tx) =>
        startValidation(tx, flow.work(), {
          missionId: flow.missionId,
          trialSlot: 'rev-a',
          draftDigest: stored.ref.digest,
          parentHash: flow.world.records.seedDigest,
        }),
      );
    };
    for (const window of [55, 60]) {
      const refused = await revision(window);
      expect(refused.ok).toBe(false);
      if (refused.ok) return;
      expect(refused.diagnostics).toEqual([
        expect.objectContaining({ code: 'INVALID_PARAMETER', pointer: '/definition/indicators/0/expr/params/window' }),
      ]);
      expect(refused.diagnostics?.[0]?.detail).toContain(`${window}`);
    }
    // Both proposals are in the search history, and the budget of 2 revisions per proposer is used up.
    expect(
      await flow.world.sql(
        `SELECT proposal_ordinal, status FROM trials WHERE trial_slot = 'rev-a' ORDER BY proposal_ordinal`,
      ),
    ).toEqual([
      { proposal_ordinal: 1, status: 'INVALID' },
      { proposal_ordinal: 2, status: 'INVALID' },
    ]);
    const third = await revision(40);
    expect(third.ok).toBe(false);
    expect(third.ok === false && third.reason).toContain('used its 2 proposals');
    expect(await flow.world.sql(`SELECT 1 FROM jobs WHERE kind = 'validate' AND trial_slot = 'rev-a'`)).toEqual([]);
  });
});

describe('a draft within the cohort policy is still accepted', () => {
  it('whose parameters sit exactly on the bounds: dispatched, and registered as a Strategy Version in DRAFT', async () => {
    // sma 20 and sma 50 are the smallest and the largest sma window of the seed: both bounds are inclusive.
    const flow = await fresh(bounds('operator:sma@1', 'window', '20', '50'));
    const started = await start(flow);
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const claimed = await claim(flow, started.attemptId);
    const response = await submit(
      flow,
      claimed,
      'validation-result',
      validationResult(flow, claimed, started.jobId, flow.world.records.seedDigest),
    );
    expect(response.status).toBe(204);
    expect(await flow.world.sql('SELECT strategy_hash, lifecycle FROM strategy_versions')).toEqual([
      { strategy_hash: flow.world.records.seedDigest, lifecycle: 'DRAFT' },
    ]);
    expect(await flow.world.sql('SELECT status, reason FROM trials')).toEqual([{ status: 'REGISTERED', reason: null }]);
  });
});

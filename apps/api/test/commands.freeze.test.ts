// freeze_candidates and the terminal state of a trial slot (OQ-02 section 4; command.schema.json): the workflows
// principal freezes "once every slot is terminal". A slot is terminal when its candidate's D and V runs ended, its
// Decision is DEFERRED, the seed was not evaluated, or no version passed validation for it, which for a revision slot
// means within the revision budget. So the command lists a slot as NOT_EVALUATED only when nothing of it is in flight:
// no DRAFTED trial, no open validate job and no open proposer run. NO_REGISTERED_VERSION on a revision slot also needs
// the revision budget used (the proposals that ended INVALID or DISCARDED equal revisions_per_proposer, 2 in the pilot)
// or a proposer run that ended without a proposal. A terminal slot takes no further proposal: startValidation refuses it.
//
// The records are written as the later parts write them (a stored draft, a trial row, a proposer run that was refused),
// and what each case expects comes from the sentences above, not from src.

import { afterEach, describe, expect, it } from 'vitest';
import type { CommandOutcome } from '../src/commands/runner.ts';
import { allBuilders, startValidation } from '../src/domain/builders.ts';
import { storeDocument } from '../src/domain/store.ts';
import { claim, complete, finishRuns, startAgentJob } from './support/attempts.ts';
import { completedCritique, decide, failedCritique, missionRevision, proposerEnded } from './support/pipeline.ts';
import { ids } from './support/seed.ts';
import { type Doc, fixture, plannedWorld, testAgentBuilder, type World } from './support/world.ts';

/** The context of the workflow: the builders of every kind of work that the API builds, and a stand-in for an agent's. */
const workflow = (world: World) => ({
  ...world.work(),
  builders: { ...allBuilders, agent: testAgentBuilder as never },
});

const worlds: World[] = [];
afterEach(async () => {
  for (const world of worlds.splice(0)) await world.drop();
});

/** The pilot with only the seed registered and evaluated: its five runs ended. The two revision slots have no version. */
async function seedEvaluated(): Promise<World> {
  const world = await plannedWorld({ versions: ['seed'] });
  worlds.push(world);
  const critique = await completedCritique(world, 'seed');
  expect((await decide(world, 'seed', 'APPROVED', critique)).state).toBe('APPLIED');
  expect(await finishRuns(world, 'seed')).toBe(5);
  return world;
}

function refusal(outcome: CommandOutcome): { code: string; message: string } {
  if (outcome.state !== 'REJECTED')
    throw new Error(`expected a refusal, got ${outcome.state}: ${JSON.stringify(outcome.status)}`);
  return outcome.status.error;
}

async function freeze(world: World, slots: Doc[]): Promise<CommandOutcome> {
  return world.apply(
    'workflows',
    { kind: 'freeze_candidates', mission_id: world.records.missionId, plan_digest: world.records.planDigest, slots },
    { expectedRevision: await missionRevision(world) },
  );
}

const seedSlot = (world: World): Doc => ({
  trial_slot: 'seed',
  status: 'EVALUATING',
  strategy_hash: world.records.seedDigest,
});
const none = (slot: string): Doc => ({ trial_slot: slot, status: 'NOT_EVALUATED', reason: 'NO_REGISTERED_VERSION' });

/** A revision draft: the seed as version 2, with its parent and one declared change. Stored as the workflow stores it. */
async function storeRevision(world: World, constant: string): Promise<string> {
  const draft = structuredClone((fixture('command.register-seed.json').payload as Doc).draft) as Doc;
  draft.version = 2;
  draft.parent = {
    hash: world.records.seedDigest,
    changes: [{ path: '/definition/entry/args/1/args/0/params/value', from: '30', to: constant }],
  };
  draft.definition.entry.condition.args[1].args[0].params.value = constant;
  const stored = await world.tx((tx) =>
    storeDocument(tx, world.testApp.env, 'strategy-artefact', draft, ids.researcher),
  );
  return stored.ref.digest;
}

/** One proposal of a slot that entered validation: a trial row with the status that its validation ended with. */
async function addTrial(
  world: World,
  slot: string,
  status: 'DRAFTED' | 'INVALID' | 'DISCARDED',
  constant: string,
): Promise<void> {
  const draft = await storeRevision(world, constant);
  const [ordinal] = await world.sql<{ next: number }>(
    `SELECT COALESCE(MAX(proposal_ordinal), 0)::int + 1 AS next FROM trials WHERE trial_slot = $1`,
    [slot],
  );
  await world.sql(
    `INSERT INTO trials (trial_id, mission_id, trial_slot, proposal_ordinal, draft_digest, status, reason, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      `trial-${slot}-${ordinal?.next}`,
      world.records.missionId,
      slot,
      ordinal?.next,
      draft,
      status,
      status === 'DRAFTED' ? null : 'INVALID_PARAMETER at /definition/entry',
      '2026-11-15T10:00:00Z',
    ],
  );
}

const unfrozen = async (world: World) => ({
  holdout: await world.sql(`SELECT 1 FROM runs WHERE window_role = 'HOLDOUT'`),
  terminal: await world.sql(`SELECT trial_slot FROM trial_slots WHERE terminal_reason IS NOT NULL`),
});

describe('freeze_candidates: a slot with a proposal in flight is not terminal', () => {
  it('refuses NO_REGISTERED_VERSION while a proposal is being validated: a DRAFTED trial with its open validate job', async () => {
    const world = await seedEvaluated();
    await proposerEnded(world, 'rev-b', 'proposer-b');
    const draft = await storeRevision(world, '32');
    const started = await world.tx((tx) =>
      startValidation(tx, workflow(world), {
        missionId: world.records.missionId as string,
        trialSlot: 'rev-a',
        draftDigest: draft,
        parentHash: world.records.seedDigest,
      }),
    );
    expect(started.ok).toBe(true);
    const refused = refusal(await freeze(world, [seedSlot(world), none('rev-a'), none('rev-b')]));
    expect(refused.code).toBe('POLICY_VIOLATION');
    expect(refused.message).toContain('rev-a');
    expect(refused.message).toContain('not terminal');
    expect(await unfrozen(world)).toEqual({ holdout: [], terminal: [] });
  });

  it('refuses it for a DRAFTED trial alone, for an open validate job alone, and for an open proposer run', async () => {
    const world = await seedEvaluated();
    // rev-b: a proposer run that is still open, with no proposal yet.
    await startAgentJob(world, { slot: 'rev-b', role: 'PROPOSER', configuration: 'proposer-b' });
    await addTrial(world, 'rev-a', 'DRAFTED', '32');
    const drafted = refusal(await freeze(world, [seedSlot(world), none('rev-a'), none('rev-b')]));
    expect(drafted.message).toContain('rev-a');
    expect(drafted.message).toContain('not terminal');
    // rev-a's proposal ended INVALID and its budget is used, but rev-b still has its proposer run open.
    await world.sql(`UPDATE trials SET status = 'INVALID', reason = 'INVALID_PARAMETER' WHERE trial_slot = 'rev-a'`);
    await addTrial(world, 'rev-a', 'INVALID', '33');
    const open = refusal(await freeze(world, [seedSlot(world), none('rev-a'), none('rev-b')]));
    expect(open.message).toContain('rev-b');
    expect(open.message).toContain('not terminal');
    expect(await unfrozen(world)).toEqual({ holdout: [], terminal: [] });
  });

  it('refuses any NOT_EVALUATED reason for a slot with an open proposer run, DECISION_DEFERRED and SEED_NOT_EVALUATED too', async () => {
    const world = await plannedWorld();
    worlds.push(world);
    const deferred = await failedCritique(world, 'seed', 'refusal', 1);
    expect((await decide(world, 'seed', 'DEFERRED', deferred)).state).toBe('APPLIED');
    await startAgentJob(world, { slot: 'rev-a', role: 'PROPOSER', configuration: 'proposer-a' });
    const slots: Doc[] = [
      { trial_slot: 'seed', status: 'NOT_EVALUATED', reason: 'DECISION_DEFERRED' },
      { trial_slot: 'rev-a', status: 'NOT_EVALUATED', reason: 'SEED_NOT_EVALUATED' },
      { trial_slot: 'rev-b', status: 'NOT_EVALUATED', reason: 'SEED_NOT_EVALUATED' },
    ];
    const refused = refusal(await freeze(world, slots));
    expect(refused.message).toContain('rev-a');
    expect(refused.message).toContain('not terminal');
    expect(await unfrozen(world)).toMatchObject({ holdout: [], terminal: [{ trial_slot: 'seed' }] });
  });
});

describe('freeze_candidates: NO_REGISTERED_VERSION for a revision slot needs its revision budget used', () => {
  it('refuses it while only one of the two proposals is used, and accepts it once the second has ended too', async () => {
    const world = await seedEvaluated();
    await proposerEnded(world, 'rev-b', 'proposer-b');
    // One proposal ended INVALID: the slot may still be proposed for, and its proposer run did not end without one.
    await addTrial(world, 'rev-a', 'INVALID', '32');
    const partly = refusal(await freeze(world, [seedSlot(world), none('rev-a'), none('rev-b')]));
    expect(partly.code).toBe('POLICY_VIOLATION');
    expect(partly.message).toContain('rev-a');
    expect(partly.message).toContain('NO_REGISTERED_VERSION');
    expect(partly.message).toContain('not terminal');
    expect(await unfrozen(world)).toEqual({ holdout: [], terminal: [] });
    // The second proposal ends INVALID too: 2 of the 2 revisions per proposer are used.
    await addTrial(world, 'rev-a', 'INVALID', '33');
    const used = await freeze(world, [seedSlot(world), none('rev-a'), none('rev-b')]);
    expect(used.state, JSON.stringify(used)).toBe('APPLIED');
    expect(await world.sql('SELECT trial_slot, terminal_reason FROM trial_slots ORDER BY trial_slot')).toEqual([
      { trial_slot: 'rev-a', terminal_reason: 'NO_REGISTERED_VERSION' },
      { trial_slot: 'rev-b', terminal_reason: 'NO_REGISTERED_VERSION' },
      { trial_slot: 'seed', terminal_reason: null },
    ]);
    expect(await world.sql(`SELECT trial_slot FROM runs WHERE window_role = 'HOLDOUT' ORDER BY run_slot`)).toEqual([
      { trial_slot: 'seed' },
      { trial_slot: 'seed' },
    ]);
  });

  it('counts a DISCARDED proposal as used as well, and accepts a slot whose proposer ended without any proposal', async () => {
    const world = await seedEvaluated();
    await addTrial(world, 'rev-a', 'DISCARDED', '32');
    await addTrial(world, 'rev-a', 'INVALID', '33');
    // rev-b made no proposal: its proposer run was refused and nothing is left open.
    await proposerEnded(world, 'rev-b', 'proposer-b');
    const frozen = await freeze(world, [seedSlot(world), none('rev-a'), none('rev-b')]);
    expect(frozen.state, JSON.stringify(frozen)).toBe('APPLIED');
  });

  it('refuses a slot that never had a proposal and whose proposer has not ended: the budget is unused', async () => {
    const world = await seedEvaluated();
    await proposerEnded(world, 'rev-b', 'proposer-b');
    const refused = refusal(await freeze(world, [seedSlot(world), none('rev-a'), none('rev-b')]));
    expect(refused.message).toContain('rev-a');
    expect(refused.message).toContain('not terminal');
  });

  it('does not count a proposer run that completed: its proposal is still to be validated', async () => {
    const world = await seedEvaluated();
    await proposerEnded(world, 'rev-b', 'proposer-b');
    // The proposer of rev-a completed, so a proposal exists that the workflow has not started to validate.
    const job = await startAgentJob(world, { slot: 'rev-a', role: 'PROPOSER', configuration: 'proposer-a' });
    const claimed = await claim(world, job.attemptId);
    if (!claimed.ok) throw claimed.failure;
    const completed = await complete(world, job.attemptId);
    if (!completed.ok) throw completed.failure;
    const refused = refusal(await freeze(world, [seedSlot(world), none('rev-a'), none('rev-b')]));
    expect(refused.message).toContain('rev-a');
    expect(refused.message).toContain('not terminal');
    expect(await unfrozen(world)).toEqual({ holdout: [], terminal: [] });
  });
});

describe('startValidation refuses a slot that is terminal', () => {
  it('writes no trial, job or attempt for a slot that freeze_candidates closed or that a Decision deferred', async () => {
    const world = await seedEvaluated();
    await proposerEnded(world, 'rev-a', 'proposer-a');
    await proposerEnded(world, 'rev-b', 'proposer-b');
    const frozen = await freeze(world, [seedSlot(world), none('rev-a'), none('rev-b')]);
    expect(frozen.state, JSON.stringify(frozen)).toBe('APPLIED');
    const draft = await storeRevision(world, '32');
    const before = await world.snapshot(['audit_events']);
    const started = await world.tx((tx) =>
      startValidation(tx, workflow(world), {
        missionId: world.records.missionId as string,
        trialSlot: 'rev-a',
        draftDigest: draft,
        parentHash: world.records.seedDigest,
      }),
    );
    expect(started).toMatchObject({ ok: false });
    expect(started.ok === false && started.reason).toContain('terminal');
    expect(started.ok === false && started.reason).toContain('NO_REGISTERED_VERSION');
    expect(await world.snapshot(['audit_events'])).toEqual(before);
  });
});

// The mission orchestrator (OQ-05 section 3, OQ-02 section 4, D8 and D18 to D22) on a real database with fake hosts.
// The fake batch worker and the fake runner live in this file: they take the messages that the dispatcher sends to the
// queue and the runner, claim each attempt through the real claim route and post their results through the real result
// routes. The orchestrator takes every step of the mission itself: after each committed result, in the request that
// committed it, and on the scheduled tick (runRecovery), which also dispatches what it wrote.
//
// The fake runner checks every request it receives with the runner's own checks from packages/agents (verifyRequest,
// checkDispatch), so a request that the API assembles must pass them: holdout exclusions that name V and H with their
// resolved sessions, compared exactly.

import {
  BUNDLE_HASH,
  checkDispatch,
  computeDifference,
  type StrategyCritiqueRequest,
  type StrategyFormulationRequest,
  verifyRequest,
} from '@openquant/agents';
import { type AgentDispatch, canonicalJson } from '@openquant/api-contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../src/db/database.ts';
import { advanceMission, workflowsActor } from '../src/orchestrator.ts';
import type { Dispatchers } from '../src/outbox.ts';
import { runRecovery } from '../src/recovery.ts';
import { gateReportFor } from './support/assess.ts';
import {
  AGENT_RUNNER,
  bytesOf,
  type Claimed,
  cancelMissionPayload,
  claim,
  claimRequest,
  errorCode,
  type Flow,
  manifestFor,
  outboxOf,
  requestOf,
  retrievalResult,
  type Started,
  startedFlow,
  submit,
  upload,
} from './support/flow.ts';
import { missionRevision } from './support/pipeline.ts';
import { agentResultDoc, CRITIQUE_FINDING, submitEvaluation, validationResult } from './support/steps.ts';
import { readViews } from './support/views.ts';
import type { Doc } from './support/world.ts';

/** What a fake host does with one kind of message. Returning false holds the message: the attempt stays claimed. */
interface Behaviour {
  /** The outcome of a validation, by the slot of the job and the ordinal of its draft in that slot. */
  validate?: (slot: string, ordinal: number) => Doc | undefined;
  /** The threshold that a proposer of a slot proposes, by the ordinal of its proposal. */
  threshold?: (slot: string, ordinal: number) => string;
  /** Hold the agent work of a role: claim it and post nothing. */
  holdAgent?: (role: string) => boolean;
}

interface Hosts {
  readonly batch: Doc[];
  readonly runner: Doc[];
  readonly cancels: string[];
  /** Agent attempts that a fake runner claimed and holds, with what it needs to post later. */
  readonly held: { claimed: Claimed; message: Doc }[];
  readonly dispatchers: Dispatchers;
}

function hosts(): Hosts {
  const batch: Doc[] = [];
  const runner: Doc[] = [];
  const cancels: string[] = [];
  return {
    batch,
    runner,
    cancels,
    held: [],
    dispatchers: {
      batch: { send: async (message) => void batch.push(message as Doc) },
      runner: {
        dispatch: async (message) => void runner.push(message as Doc),
        cancel: async (attemptId) => void cancels.push(attemptId),
      },
    },
  };
}

async function withDb<T>(flow: Flow, work: (db: Database) => Promise<T>): Promise<T> {
  const db = flow.world.testApp.env.database();
  try {
    return await work(db);
  } finally {
    await db.close();
  }
}

/** The scheduled tick: recovery, the orchestrator's catch-up and the dispatch of what is pending. */
const tick = (flow: Flow, fake: Hosts) =>
  withDb(flow, (db) => runRecovery(flow.world.testApp.env, db, { dispatchers: fake.dispatchers }));

async function ordinalOf(flow: Flow, draftDigest: string): Promise<{ slot: string; ordinal: number }> {
  const [trial] = await flow.world.sql<{ trial_slot: string; proposal_ordinal: number }>(
    `SELECT trial_slot, proposal_ordinal FROM trials WHERE draft_digest = $1 ORDER BY proposal_ordinal DESC LIMIT 1`,
    [draftDigest],
  );
  return { slot: trial?.trial_slot as string, ordinal: trial?.proposal_ordinal as number };
}

async function stored(flow: Flow, digest: string): Promise<Doc> {
  const bytes = await flow.world.testApp.objects.get(digest as never);
  return JSON.parse(new TextDecoder().decode(bytes as Uint8Array)) as Doc;
}

/** The fake batch worker: claim, then do what the job kind asks and post its result through the real route. */
async function batchHost(flow: Flow & Started, message: Doc, behaviour: Behaviour): Promise<Response> {
  const attemptId = message.attempt.attempt_id as string;
  const claimed = await claim(flow, attemptId);
  const inputs = message.inputs as Doc;
  switch (inputs.kind) {
    case 'retrieve': {
      const request = await requestOf(flow, attemptId);
      const manifest = manifestFor(flow, { jobId: message.job_id, attemptId, requestDigest: request.digest });
      const ref = await upload(flow, claimed, bytesOf(manifest));
      const result = retrievalResult(claimed, message.job_id, request.digest, { status: 'COMPLETE', manifest: ref });
      return submit(flow, claimed, 'retrieval-result', result);
    }
    case 'validate': {
      const draftDigest = inputs.draft.digest as string;
      const parentHash = inputs.parent?.digest as string | undefined;
      const { slot, ordinal } = await ordinalOf(flow, draftDigest);
      let outcome = behaviour.validate?.(slot, ordinal);
      if (outcome === undefined && parentHash !== undefined) {
        const draft = await stored(flow, draftDigest);
        outcome = {
          status: 'VALID',
          max_lookback_sessions: 50,
          warmup_sessions: 60,
          computed_changes: draft.parent.changes,
          change_scope: 'ENTRY',
        };
      }
      const result = validationResult(flow, claimed, message.job_id, draftDigest, outcome, parentHash);
      return submit(flow, claimed, 'validation-result', result);
    }
    case 'evaluate':
      return (await submitEvaluation(flow, claimed, message.job_id)).response;
    case 'assess':
      return submit(
        flow,
        claimed,
        'gate-report',
        await gateReportFor(flow, claimed, message.job_id, inputs.strategy_hash as string),
      );
    default:
      throw new Error(`The fake batch worker has no job of kind ${String(inputs.kind)}.`);
  }
}

/**
 * The fake runner: claim, read the request through the attempt's input route, check it as the runner does, and post a
 * completion with the role output. A proposer revises the seed's entry threshold; a critic returns one finding.
 */
async function runnerHost(flow: Flow & Started, message: Doc, behaviour: Behaviour, fake: Hosts): Promise<void> {
  const attemptId = message.identity.attempt.attempt_id as string;
  const claimed = await claim(flow, attemptId, 'runner', AGENT_RUNNER);
  const ref = message.inputs.request.artefact;
  const response = await flow.send('GET', `/v1/attempts/${attemptId}/inputs/${ref.digest}`, claimed.token);
  expect(response.status).toBe(200);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const contract = message.identity.role === 'critic' ? 'strategy-critique.request' : 'strategy-formulation.request';
  const verified = await verifyRequest(contract, bytes);
  expect(verified.ok ? [] : verified.refusals).toEqual([]);
  if (!verified.ok) return;
  expect(checkDispatch(message as AgentDispatch, { request: verified.request, artefact: verified.artefact })).toEqual(
    [],
  );
  if (behaviour.holdAgent?.(message.identity.role) === true) {
    fake.held.push({ claimed, message });
    return;
  }
  let output: Doc;
  let outputContract: string;
  if (message.identity.role === 'critic') {
    outputContract = 'strategy-critique.result/1';
    // One finding that names the candidate: findings are keyed by the digest of the critique and their position.
    const subject = (verified.request as StrategyCritiqueRequest).subject;
    output = {
      schema_version: outputContract,
      findings: [
        { ...CRITIQUE_FINDING, description: `Version ${subject.strategy.version} could state its holding period.` },
      ],
    };
  } else {
    outputContract = 'strategy-formulation.result/1';
    const request = verified.request as StrategyFormulationRequest;
    const subject = request.subject as Extract<StrategyFormulationRequest['subject'], { parent_hash: string }>;
    const parent = subject.parent as unknown as Doc;
    const [job] = await flow.world.sql<{ trial_slot: string; proposals: number }>(
      `SELECT j.trial_slot, (SELECT count(*)::int FROM trials t WHERE t.mission_id = j.mission_id AND t.trial_slot = j.trial_slot) AS proposals
         FROM jobs j WHERE j.job_id = $1`,
      [message.identity.run_id],
    );
    const proposed = structuredClone(parent);
    proposed.definition.indicators[5].expr.params.value =
      behaviour.threshold?.(job?.trial_slot as string, (job?.proposals as number) + 1) ?? '32';
    output = {
      schema_version: outputContract,
      proposal_kind: 'controlled_revision',
      parent_hash: subject.parent_hash,
      strategy: { operator_set: proposed.operator_set, contract: proposed.contract, definition: proposed.definition },
      source_refs: [],
      rule_changes: computeDifference(parent, proposed).declared,
      claims: {
        rationale: 'The development results suggest a higher weakness threshold.',
        expected_effect: 'More entries; evaluation can contradict this.',
        invalidation_conditions: ['No change in entry counts against the parent.'],
        requested_tests: ['The registered comparison against the parent.'],
      },
      unresolved: [],
      method_refs: [],
    };
  }
  const artefact = await upload(flow, claimed, new TextEncoder().encode(canonicalJson(output)));
  const result = agentResultDoc(claimed, message, {
    outcome: 'completion',
    output: { contract: outputContract, artefact },
  });
  const posted = await submit(flow, claimed, 'agent-result', result);
  const logged = flow.world.testApp.logs.filter((entry) => entry.level === 'error').slice(-3);
  expect(posted.status, `${await posted.clone().text()} ${JSON.stringify(logged)}`).toBe(204);
}

/** Tick and serve every dispatched message until nothing is dispatched any more or the round limit is reached. */
async function runUntilQuiet(flow: Flow & Started, fake: Hosts, behaviour: Behaviour = {}, rounds = 60) {
  for (let round = 0; round < rounds; round += 1) {
    await tick(flow, fake);
    if (fake.batch.length === 0 && fake.runner.length === 0) return;
    while (fake.batch.length > 0) {
      const response = await batchHost(flow, fake.batch.shift() as Doc, behaviour);
      const errors = flow.world.testApp.logs.filter((entry) => entry.level === 'error').slice(-3);
      expect(response.status, `${await response.clone().text()} ${JSON.stringify(errors)}`).toBe(204);
    }
    while (fake.runner.length > 0) await runnerHost(flow, fake.runner.shift() as Doc, behaviour, fake);
  }
  throw new Error('The mission did not settle within the round limit.');
}

/** A started pilot mission whose agent configurations use the behaviour bundle that this API assembles with. */
function orchestratedFlow(edit?: (mission: Doc) => void) {
  return startedFlow({
    orchestrate: true,
    mission: (mission) => {
      for (const configuration of [...mission.proposers, mission.critic]) configuration.bundle_hash = BUNDLE_HASH;
      edit?.(mission);
    },
  });
}

async function missionOf(flow: Flow & Started) {
  const [mission] = await flow.world.sql<{ status: string; outcome: string | null; blocked_reason: string | null }>(
    'SELECT status, outcome, blocked_reason FROM missions WHERE mission_id = $1',
    [flow.missionId],
  );
  return mission;
}

describe('a pilot-shaped mission driven by the orchestrator', () => {
  let flow: Flow & Started;
  const fake = hosts();
  // rev-b's first proposal leaves the entry scope: Rust validation says REVISION_SCOPE, and the second is registered.
  const behaviour: Behaviour = {
    validate: (slot, ordinal) =>
      slot === 'rev-b' && ordinal === 1
        ? {
            status: 'INVALID',
            diagnostics: [
              { code: 'REVISION_SCOPE', pointer: '', detail: 'The revision changes entry and exit rules.' },
            ],
          }
        : undefined,
    threshold: (slot, ordinal) => (slot === 'rev-a' ? '32' : ordinal === 1 ? '33' : '34'),
  };

  beforeAll(async () => {
    flow = await orchestratedFlow();
    // The first tick dispatches the retrieval that run_mission_now wrote; everything after it is the orchestrator's.
    await runUntilQuiet(flow, fake, behaviour);
  }, 240_000);
  afterAll(async () => {
    await flow.world.drop();
  });

  it('concludes NO_ELIGIBLE_CANDIDATE, the expected S1 outcome (D18), with no step taken by hand', async () => {
    expect(await missionOf(flow)).toMatchObject({ status: 'CONCLUDED', outcome: 'NO_ELIGIBLE_CANDIDATE' });
    const [outcome] = await flow.world.sql<{ slot_reasons: { trial_slot: string; reason: string }[] }>(
      'SELECT slot_reasons FROM mission_outcomes WHERE mission_id = $1',
      [flow.missionId],
    );
    expect(outcome?.slot_reasons).toEqual([
      { trial_slot: 'rev-a', reason: 'NOT_ELIGIBLE' },
      { trial_slot: 'rev-b', reason: 'NOT_ELIGIBLE' },
      { trial_slot: 'seed', reason: 'NOT_ELIGIBLE' },
    ]);
  });

  it('evaluated three candidates: 21 runs, three Decisions, three gate reports, the holdout runs written by the freeze', async () => {
    const runs = await flow.world.sql<{ window_role: string; status: string; runs: number }>(
      `SELECT window_role, status, count(*)::int AS runs FROM runs WHERE mission_id = $1 GROUP BY window_role, status ORDER BY window_role`,
      [flow.missionId],
    );
    expect(runs).toEqual([
      { window_role: 'DEVELOPMENT', status: 'COMPLETED', runs: 9 },
      { window_role: 'HOLDOUT', status: 'COMPLETED', runs: 6 },
      { window_role: 'VALIDATION', status: 'COMPLETED', runs: 6 },
    ]);
    const decisions = await flow.world.sql<{ trial_slot: string; outcome: string; actor_kind: string }>(
      `SELECT trial_slot, outcome, actor_kind FROM decisions WHERE mission_id = $1 AND kind = 'DRAFT_TO_EVALUATING' ORDER BY trial_slot`,
      [flow.missionId],
    );
    expect(decisions).toEqual([
      { trial_slot: 'rev-a', outcome: 'APPROVED', actor_kind: 'SERVICE' },
      { trial_slot: 'rev-b', outcome: 'APPROVED', actor_kind: 'SERVICE' },
      { trial_slot: 'seed', outcome: 'APPROVED', actor_kind: 'SERVICE' },
    ]);
    const eligibility = await flow.world.sql<{ state: string }>('SELECT state FROM eligibility WHERE mission_id = $1', [
      flow.missionId,
    ]);
    expect(eligibility.map((row) => row.state)).toEqual(['NOT_ELIGIBLE', 'NOT_ELIGIBLE', 'NOT_ELIGIBLE']);
    const frozen = await flow.world.sql<{ kind: string; state: string }>(
      `SELECT kind, state FROM commands WHERE kind IN ('freeze_candidates', 'record_evaluation_decision') ORDER BY kind`,
    );
    expect(frozen).toEqual([
      { kind: 'freeze_candidates', state: 'APPLIED' },
      { kind: 'record_evaluation_decision', state: 'APPLIED' },
      { kind: 'record_evaluation_decision', state: 'APPLIED' },
      { kind: 'record_evaluation_decision', state: 'APPLIED' },
    ]);
  });

  it('took the proposal path of D8: one critique per candidate, and a second proposal after one that failed validation', async () => {
    const trials = await flow.world.sql<{ trial_slot: string; proposal_ordinal: number; status: string }>(
      'SELECT trial_slot, proposal_ordinal, status FROM trials WHERE mission_id = $1 ORDER BY trial_slot, proposal_ordinal',
      [flow.missionId],
    );
    expect(trials).toEqual([
      { trial_slot: 'rev-a', proposal_ordinal: 1, status: 'REGISTERED' },
      { trial_slot: 'rev-b', proposal_ordinal: 1, status: 'INVALID' },
      { trial_slot: 'rev-b', proposal_ordinal: 2, status: 'REGISTERED' },
      { trial_slot: 'seed', proposal_ordinal: 1, status: 'REGISTERED' },
    ]);
    const agents = await flow.world.sql<{ trial_slot: string; agent_role: string; status: string; jobs: number }>(
      `SELECT trial_slot, agent_role, status, count(*)::int AS jobs FROM jobs WHERE mission_id = $1 AND kind = 'agent'
        GROUP BY trial_slot, agent_role, status ORDER BY trial_slot, agent_role`,
      [flow.missionId],
    );
    expect(agents).toEqual([
      { trial_slot: 'rev-a', agent_role: 'CRITIC', status: 'COMPLETED', jobs: 1 },
      { trial_slot: 'rev-a', agent_role: 'PROPOSER', status: 'COMPLETED', jobs: 1 },
      { trial_slot: 'rev-b', agent_role: 'CRITIC', status: 'COMPLETED', jobs: 1 },
      { trial_slot: 'rev-b', agent_role: 'PROPOSER', status: 'COMPLETED', jobs: 2 },
      { trial_slot: 'seed', agent_role: 'CRITIC', status: 'COMPLETED', jobs: 1 },
    ]);
    // The second proposer of rev-b read the diagnostics of the first proposal: development evidence only.
    const [second] = await flow.world.sql<{ message: Doc }>(
      `SELECT o.message FROM outbox o JOIN attempts a ON a.attempt_id = o.attempt_id JOIN jobs j ON j.job_id = a.job_id
        WHERE j.trial_slot = 'rev-b' AND j.agent_role = 'PROPOSER' ORDER BY j.created_at DESC, j.job_id DESC LIMIT 1`,
    );
    const request = (await stored(flow, second?.message.inputs.request.artefact.digest)) as StrategyFormulationRequest;
    expect(request.evidence_refs.map((item) => item.kind).sort()).toEqual([
      'draft_diagnostics',
      'evaluation_metrics',
      'evaluation_metrics',
      'evaluation_metrics',
      'finding',
    ]);
    expect(request.evidence_refs.find((item) => item.kind === 'draft_diagnostics')?.content).toContain(
      'REVISION_SCOPE',
    );
  });

  it('carries the resolved sessions of V and H in every agent request, as the plan and the frozen calendar give them', async () => {
    const messages = await flow.world.sql<{ message: Doc }>(
      `SELECT o.message FROM outbox o WHERE o.destination = 'AGENT_RUNNER' ORDER BY o.created_at, o.attempt_id`,
    );
    expect(messages).toHaveLength(6);
    const [plan] = await flow.world.sql<{ v_start: string; v_end: string; h_start: string; h_end: string }>(
      `SELECT to_char(v_start, 'YYYY-MM-DD') AS v_start, to_char(v_end, 'YYYY-MM-DD') AS v_end,
              to_char(h_start, 'YYYY-MM-DD') AS h_start, to_char(h_end, 'YYYY-MM-DD') AS h_end
         FROM evaluation_plans WHERE mission_id = $1`,
      [flow.missionId],
    );
    for (const { message } of messages) {
      const request = (await stored(flow, message.inputs.request.artefact.digest)) as StrategyCritiqueRequest;
      const exclusions = request.context.holdout_exclusions;
      expect(exclusions.map((item) => item.window)).toEqual(['VALIDATION', 'HOLDOUT']);
      const [v, h] = exclusions;
      expect(v?.range).toEqual({ start: plan?.v_start, end: plan?.v_end });
      expect(h?.range).toEqual({ start: plan?.h_start, end: plan?.h_end });
      // The synthetic calendar has every weekday and no holiday: 262 sessions in 2024, the first on 2024-01-01.
      expect(v?.sessions?.length).toBe(262);
      expect(v?.sessions?.[0]).toBe(plan?.v_start);
      expect(h?.sessions?.at(-1)).toBe(plan?.h_end);
      expect(message.inputs.holdout_exclusions).toEqual(exclusions);
    }
  });

  it('left every budget reconciled: no reservation is held', async () => {
    const held = await flow.world.sql(
      `SELECT 1 FROM reservations r JOIN attempts a ON a.attempt_id = r.attempt_id
         LEFT JOIN runs ru ON ru.run_id = a.run_id LEFT JOIN jobs j ON j.job_id = a.job_id
        WHERE COALESCE(ru.mission_id, j.mission_id) = $1 AND r.status = 'RESERVED'`,
      [flow.missionId],
    );
    expect(held).toEqual([]);
  });

  it('answers every read route with a body that the view contract of its route accepts', async () => {
    const views = await readViews(flow);
    expect(views[`/v1/missions/${flow.missionId}`]).toMatchObject({ status: 'CONCLUDED' });
  });

  it('writes nothing when the tick runs again on the concluded mission', async () => {
    const before = await flow.world.snapshot();
    const summary = await tick(flow, fake);
    expect(summary.orchestration).toEqual({ advanced: 0, errors: 0 });
    expect(await flow.world.snapshot()).toEqual(before);
  });
});

describe('the steps of the orchestrator are idempotent', () => {
  let flow: Flow & Started;
  const fake = hosts();

  beforeAll(async () => {
    flow = await orchestratedFlow();
  });
  afterAll(async () => {
    await flow.world.drop();
  });

  it('a repeated tick writes no second run, attempt or reservation, and a repeated advance takes no step', async () => {
    await tick(flow, fake);
    // The retrieval is accepted: the result route took the seed's validation step in the same request.
    const response = await batchHost(flow, fake.batch.shift() as Doc, {});
    expect(response.status).toBe(204);
    const validations = await flow.world.sql(`SELECT 1 FROM jobs WHERE kind = 'validate'`);
    expect(validations).toHaveLength(1);
    await tick(flow, fake);
    expect(fake.batch).toHaveLength(1);
    const before = await flow.world.snapshot();
    const again = await tick(flow, fake);
    expect(again.orchestration).toEqual({ advanced: 0, errors: 0 });
    expect(again.dispatch.sent).toBe(0);
    expect(await flow.world.snapshot()).toEqual(before);
    const steps = await withDb(flow, async (db) =>
      advanceMission(
        flow.world.testApp.env,
        db,
        (await workflowsActor(db, flow.world.testApp.env)) as never,
        flow.missionId,
      ),
    );
    expect(steps).toEqual([]);
    expect(await flow.world.snapshot()).toEqual(before);
  });

  it('a redelivered result returns the stored outcome and starts nothing twice', async () => {
    const message = fake.batch.shift() as Doc;
    const attemptId = message.attempt.attempt_id as string;
    const claimed = await claim(flow, attemptId);
    const result = validationResult(flow, claimed, message.job_id, message.inputs.draft.digest);
    expect((await submit(flow, claimed, 'validation-result', result)).status).toBe(204);
    // The orchestrator took the critique step in that request: one critic run with one attempt.
    const critics = await flow.world.sql(`SELECT 1 FROM jobs WHERE kind = 'agent' AND agent_role = 'CRITIC'`);
    expect(critics).toHaveLength(1);
    const before = await flow.world.snapshot(['audit_events']);
    expect((await submit(flow, claimed, 'validation-result', result)).status).toBe(204);
    expect(await flow.world.snapshot(['audit_events'])).toEqual(before);
    // A redelivered dispatch: the queue sends the same message again, and the second claim is refused.
    const outbox = await outboxOf(flow, attemptId);
    const second = await flow.send(
      'POST',
      `/v1/attempts/${attemptId}/claim`,
      flow.service('batch'),
      claimRequest(attemptId, outbox.revision, outbox.digest),
    );
    expect(second.status).toBe(409);
    expect(await errorCode(second)).toBe('ATTEMPT_NOT_CLAIMABLE');
  });
});

describe('a mission cancelled mid-flight', () => {
  let flow: Flow & Started;
  const fake = hosts();
  let held: { claimed: Claimed; message: Doc };

  beforeAll(async () => {
    flow = await orchestratedFlow();
    // The fake runner claims the seed's critique and holds it, running, when the Researcher cancels.
    await runUntilQuiet(flow, fake, { holdAgent: (role) => role === 'critic' });
    held = fake.held[0] as { claimed: Claimed; message: Doc };
  }, 120_000);
  afterAll(async () => {
    await flow.world.drop();
  });

  it('stops: the claimed critic attempt is cancelled and the runner is asked to end it, once', async () => {
    expect(held).toBeDefined();
    const researcher = await flow.person('researcher');
    const cancelled = await flow.send('POST', `/v1/missions/${flow.missionId}/cancel`, researcher, {
      schema_version: 'command/1',
      form: 'request',
      command_id: 'cmd-cancel-mid-flight',
      expected_revision: await missionRevision(flow.world),
      issued_at: '2026-11-15T10:00:00Z',
      payload: cancelMissionPayload(flow.missionId),
    });
    expect(cancelled.status, await cancelled.clone().text()).toBe(202);
    expect(await missionOf(flow)).toMatchObject({ status: 'WITHDRAWN' });
    // A runner that does not answer: the request stays PENDING and goes again on the next tick.
    const down: Dispatchers = {
      ...fake.dispatchers,
      runner: {
        dispatch: async () => undefined,
        cancel: async () => {
          throw new Error('The runner is unavailable.');
        },
      },
    };
    const failed = await withDb(flow, (db) => runRecovery(flow.world.testApp.env, db, { dispatchers: down }));
    expect(failed.cancellations).toEqual({ sent: 0, failed: 1, skipped: 0 });
    const summary = await tick(flow, fake);
    expect(summary.cancellations).toEqual({ sent: 1, failed: 0, skipped: 0 });
    expect(fake.cancels).toEqual([held.claimed.attemptId]);
    const [request] = await flow.world.sql<{ status: string }>(
      'SELECT status FROM runner_cancellations WHERE attempt_id = $1',
      [held.claimed.attemptId],
    );
    expect(request?.status).toBe('SENT');
    expect((await tick(flow, fake)).cancellations).toEqual({ sent: 0, failed: 0, skipped: 0 });
    expect(fake.cancels).toHaveLength(1);
  });

  it('takes no further step: the tick writes nothing and dispatches nothing', async () => {
    const before = await flow.world.snapshot();
    const summary = await tick(flow, fake);
    expect(summary.orchestration).toEqual({ advanced: 0, errors: 0 });
    expect(fake.batch).toEqual([]);
    expect(fake.runner).toEqual([]);
    expect(await flow.world.snapshot()).toEqual(before);
  });

  it("settles the reservation from the runner's cancellation report, which changes nothing else", async () => {
    const report = agentResultDoc(held.claimed, held.message, {
      outcome: 'cancellation',
      diagnostic: 'The attempt was cancelled and its process tree was ended.',
    });
    const response = await submit(flow, held.claimed, 'agent-result', report);
    expect(response.status).toBe(204);
    const [reservation] = await flow.world.sql<{ status: string }>(
      'SELECT status FROM reservations WHERE attempt_id = $1',
      [held.claimed.attemptId],
    );
    expect(reservation?.status).toBe('SETTLED');
    expect(await missionOf(flow)).toMatchObject({ status: 'WITHDRAWN' });
    expect(await flow.world.sql(`SELECT 1 FROM decisions WHERE kind = 'DRAFT_TO_EVALUATING'`)).toEqual([]);
  });
});

describe('a mission whose budget cannot cover the next step', () => {
  let flow: Flow & Started;
  const fake = hosts();

  beforeAll(async () => {
    // The critic's allowance holds one attempt of 5 USD: the seed's critique reports 3.25 USD, and the first revision's
    // critique cannot reserve another 5 USD from what is left.
    flow = await orchestratedFlow((mission) => {
      mission.budget.critic_allowance = { model_spend: { amount: '5.00', currency: 'USD' }, agent_attempts: 1 };
      mission.budget.model_spend = { amount: '65.00', currency: 'USD' };
    });
    await runUntilQuiet(flow, fake);
  }, 120_000);
  afterAll(async () => {
    await flow.world.drop();
  });

  it('is BLOCKED with the reason, and the critic run waits QUEUED with no attempt', async () => {
    const mission = await missionOf(flow);
    expect(mission?.status).toBe('BLOCKED');
    expect(mission?.blocked_reason).toMatch(
      /^The critic run of rev-a cannot be reserved: MODEL_SPEND of the allowance of critic/,
    );
    const critics = await flow.world.sql<{
      trial_slot: string;
      status: string;
      waiting_reason: string | null;
      attempts: number;
    }>(
      `SELECT j.trial_slot, j.status, j.waiting_reason,
              (SELECT count(*)::int FROM attempts a WHERE a.job_id = j.job_id) AS attempts
         FROM jobs j WHERE j.kind = 'agent' AND j.agent_role = 'CRITIC' ORDER BY j.created_at, j.job_id`,
    );
    expect(critics).toHaveLength(2);
    expect(critics[0]).toMatchObject({ trial_slot: 'seed', status: 'COMPLETED', attempts: 1 });
    expect(critics[1]).toMatchObject({ status: 'QUEUED', attempts: 0 });
    expect(critics[1]?.waiting_reason).toBe(mission?.blocked_reason);
  });

  it('stays BLOCKED: another tick takes no step and writes nothing', async () => {
    const before = await flow.world.snapshot();
    await tick(flow, fake);
    expect(await flow.world.snapshot()).toEqual(before);
    expect(await missionOf(flow)).toMatchObject({ status: 'BLOCKED' });
  });
});

// The two internal guarded commands of the workflows service principal (OQ-02 sections 1, 3.3 and 4; decisions D20 and
// D25). No route accepts them; ResearchWorkflow applies them through the command runner under the approved cohort policy.
//
//   record_evaluation_decision   the policy-determined DRAFT to EVALUATING Decision of one trial slot. An APPROVED Decision
//                                writes the development and validation runs of the candidate, with their attempts,
//                                reservations and outbox entries, in one transaction. A DEFERRED Decision writes none.
//   freeze_candidates            once every trial slot is terminal: the holdout runs of every candidate in EVALUATING,
//                                with their reservations and outbox entries, in one transaction. With no candidate in
//                                EVALUATING it writes no run and the mission concludes NO_ELIGIBLE_CANDIDATE. A slot is
//                                listed NOT_EVALUATED only when nothing of it is in flight (no DRAFTED trial, no open
//                                validate job, no open proposer run), and NO_REGISTERED_VERSION on a revision slot also
//                                needs its revision budget used or a proposer run that ended without a proposal.

import type { FreezeCandidates, RecordEvaluationDecision } from '@openquant/api-contracts';
import { writeAudit } from '../audit.ts';
import type { Queryable } from '../db/database.ts';
import { openAttempt } from '../domain/attempts.ts';
import { loadPolicy } from '../domain/documents.ts';
import { assignFindingTreatments, blockingFindings } from '../domain/findings.ts';
import { bumpMission, transitionMission } from '../domain/missions.ts';
import { reject, revisionConflict } from '../domain/rejection.ts';
import { loadMissionBudget, lockMission, type MissionRow } from '../domain/rows.ts';
import { artefactRef } from '../domain/store.ts';
import { insertRun, type Work } from '../domain/work.ts';
import { type Applier, type ApplyContext, workContext } from './types.ts';

/** The mission must be IN_PROGRESS and the caller must have read its current revision. */
async function openMission(context: ApplyContext, missionId: string): Promise<MissionRow> {
  const mission = await lockMission(context.tx, missionId);
  if (context.request.expected_revision !== mission.revision) {
    throw revisionConflict(`The mission ${missionId}`, mission.revision);
  }
  if (mission.status === 'BLOCKED') {
    throw reject('BUDGET_EXHAUSTED', `The mission is BLOCKED: ${mission.blocked_reason ?? 'no reason recorded'}.`);
  }
  if (mission.status !== 'IN_PROGRESS') {
    throw reject('POLICY_VIOLATION', `The mission is ${mission.status}: it is not IN_PROGRESS.`);
  }
  return mission;
}

async function checkPlan(tx: Queryable, missionId: string, planDigest: string): Promise<void> {
  const { rows } = await tx.query<{ plan_digest: string }>(
    'SELECT plan_digest FROM evaluation_plans WHERE mission_id = $1',
    [missionId],
  );
  const recorded = rows[0]?.plan_digest;
  if (recorded === undefined) {
    throw reject(
      'POLICY_VIOLATION',
      'No evaluation plan is recorded for the mission: no Decision or freeze can follow.',
    );
  }
  if (recorded !== planDigest) {
    throw reject('IDENTITY_MISMATCH', 'The plan digest is not the digest of the evaluation plan of the mission.');
  }
}

interface SlotRow {
  trial_slot: string;
  slot_kind: 'SEED' | 'REVISION';
  parent_slot: string | null;
  configuration_id: string | null;
  terminal_reason: string | null;
}

async function trialSlots(tx: Queryable, missionId: string): Promise<SlotRow[]> {
  const { rows } = await tx.query<SlotRow>(
    'SELECT trial_slot, slot_kind, parent_slot, configuration_id, terminal_reason FROM trial_slots WHERE mission_id = $1 ORDER BY trial_slot FOR UPDATE',
    [missionId],
  );
  return rows;
}

/**
 * What of a slot is still in flight, as a phrase, or undefined when nothing is: a proposal that entered validation and
 * has no verdict (a DRAFTED trial), a validate job that is open, or a proposer run of the slot's configuration that is
 * open. Such a slot is not terminal (OQ-02 section 4): its proposal can still register a Strategy Version.
 */
async function inFlight(tx: Queryable, missionId: string, slot: SlotRow): Promise<string | undefined> {
  const drafted = await tx.query(
    `SELECT 1 FROM trials WHERE mission_id = $1 AND trial_slot = $2 AND status = 'DRAFTED' LIMIT 1`,
    [missionId, slot.trial_slot],
  );
  if (drafted.rows.length > 0) return 'a proposal is DRAFTED and its validation has not ended';
  const validating = await tx.query(
    `SELECT 1 FROM jobs WHERE mission_id = $1 AND trial_slot = $2 AND kind = 'validate' AND status IN ('QUEUED', 'RUNNING') LIMIT 1`,
    [missionId, slot.trial_slot],
  );
  if (validating.rows.length > 0) return 'a validate job of the slot is open';
  const proposing = await tx.query(
    `SELECT 1 FROM jobs WHERE mission_id = $1 AND kind = 'agent' AND agent_role = 'PROPOSER' AND status IN ('QUEUED', 'RUNNING')
        AND (trial_slot = $2 OR configuration_id = $3) LIMIT 1`,
    [missionId, slot.trial_slot, slot.configuration_id],
  );
  if (proposing.rows.length > 0) return 'a proposer run of the slot is open';
  return undefined;
}

/**
 * Whether no version can still come for a revision slot: its revision budget is used (the proposals that ended INVALID
 * or DISCARDED equal revisions_per_proposer), or its proposer run ended without a proposal (the latest proposer run of
 * the slot FAILED). A proposer run that COMPLETED made a proposal, which has still to be validated.
 */
async function revisionsEnded(
  tx: Queryable,
  missionId: string,
  slot: SlotRow,
  revisionsPerProposer: number,
): Promise<{ readonly ended: boolean; readonly spent: number }> {
  const spent = await tx.query<{ spent: number }>(
    `SELECT count(*)::int AS spent FROM trials WHERE mission_id = $1 AND trial_slot = $2 AND status IN ('INVALID', 'DISCARDED')`,
    [missionId, slot.trial_slot],
  );
  const used = spent.rows[0]?.spent ?? 0;
  if (used >= revisionsPerProposer) return { ended: true, spent: used };
  const latest = await tx.query<{ status: string }>(
    `SELECT status FROM jobs WHERE mission_id = $1 AND kind = 'agent' AND agent_role = 'PROPOSER'
        AND (trial_slot = $2 OR configuration_id = $3) ORDER BY created_at DESC, job_id DESC LIMIT 1`,
    [missionId, slot.trial_slot, slot.configuration_id],
  );
  return { ended: latest.rows[0]?.status === 'FAILED', spent: used };
}

/** Write the planned runs of one trial slot that a step writes, each with its attempt, reservation and outbox entry. */
async function writePlannedRuns(
  context: ApplyContext,
  mission: MissionRow,
  planDigest: string,
  trialSlot: string,
  strategyHash: string,
  writtenBy: 'EVALUATING_DECISION' | 'FREEZE_CANDIDATES',
  attemptCap: number,
): Promise<Work[]> {
  const { tx, env } = context;
  const { rows } = await tx.query<{
    run_slot: string;
    window_role: 'DEVELOPMENT' | 'VALIDATION' | 'HOLDOUT';
    cost_scenario: 'BASE' | 'COST_STRESS';
    replay_of: string | null;
  }>(
    `SELECT run_slot, window_role, cost_scenario, replay_of FROM run_slots
      WHERE mission_id = $1 AND trial_slot = $2 AND written_by = $3
      ORDER BY (replay_of IS NOT NULL), window_role, cost_scenario`,
    [mission.mission_id, trialSlot, writtenBy],
  );
  const created = new Map<string, Work>();
  for (const slot of rows) {
    const original = slot.replay_of === null ? undefined : created.get(slot.replay_of);
    if (slot.replay_of !== null && original === undefined) {
      throw new Error(`The run slot ${slot.run_slot} repeats ${slot.replay_of}, which this step did not write.`);
    }
    const run = await insertRun(tx, env, {
      missionId: mission.mission_id,
      runSlot: slot.run_slot,
      trialSlot,
      windowRole: slot.window_role,
      costScenario: slot.cost_scenario,
      planDigest,
      strategyHash,
      attemptCap,
      ...(original === undefined ? {} : { repeatOfRun: original.id }),
    });
    const opened = await openAttempt(tx, workContext(context), run);
    if (!opened.ok) {
      const reason = `The runs of ${trialSlot} cannot be reserved: ${opened.reason}`;
      throw reject('BUDGET_EXHAUSTED', reason, { blockMission: { missionId: mission.mission_id, reason } });
    }
    created.set(slot.run_slot, run);
  }
  return [...created.values()];
}

/** Refuse, and block the mission, when the runs to write would take it past its experiment budget. */
async function checkExperiments(tx: Queryable, mission: MissionRow, adding: number): Promise<void> {
  const budget = await loadMissionBudget(tx, mission.mission_id);
  const { rows } = await tx.query<{ runs: number }>('SELECT count(*)::int AS runs FROM runs WHERE mission_id = $1', [
    mission.mission_id,
  ]);
  const existing = rows[0]?.runs ?? 0;
  if (existing + adding > budget.experiments) {
    const reason = `The mission has ${existing} of ${budget.experiments} experiments and ${adding} more are planned.`;
    throw reject('BUDGET_EXHAUSTED', reason, { blockMission: { missionId: mission.mission_id, reason } });
  }
}

const RETRIED_CRITIQUE_OUTCOMES = new Set(['timeout', 'malformed_result', 'lease_expired']);

/** The critic job of a slot must show what the workflow says it ended with. */
async function checkMissingCritique(
  tx: Queryable,
  mission: MissionRow,
  slot: string,
  critique: { outcome: string; attempts: number },
  attemptCap: number,
): Promise<void> {
  if (RETRIED_CRITIQUE_OUTCOMES.has(critique.outcome) && critique.attempts < attemptCap) {
    throw reject(
      'POLICY_VIOLATION',
      `A ${critique.outcome} is retried: the critique ends only when the ${attemptCap} attempts of the cap are used.`,
    );
  }
  const job = await tx.query<{ job_id: string; status: string }>(
    `SELECT job_id, status FROM jobs WHERE mission_id = $1 AND trial_slot = $2 AND agent_role = 'CRITIC'
      ORDER BY created_at DESC, job_id DESC LIMIT 1`,
    [mission.mission_id, slot],
  );
  const row = job.rows[0];
  if (row === undefined) throw reject('POLICY_VIOLATION', 'No critique job is recorded for the slot.');
  if (row.status !== 'FAILED' && row.status !== 'CANCELLED') {
    throw reject('POLICY_VIOLATION', `The critique job is ${row.status}: it has not ended without a valid result.`);
  }
  const attempts = await tx.query<{ status: string; agent_outcome: string | null }>(
    'SELECT status, agent_outcome FROM attempts WHERE job_id = $1 ORDER BY ownership_revision',
    [row.job_id],
  );
  const last = attempts.rows.at(-1);
  const lastOutcome = last?.status === 'LEASE_EXPIRED' ? 'lease_expired' : last?.agent_outcome;
  if (attempts.rows.length !== critique.attempts || lastOutcome !== critique.outcome) {
    throw reject('POLICY_VIOLATION', 'The critique evidence is not what the critique job recorded.');
  }
}

export const recordEvaluationDecision: Applier<RecordEvaluationDecision> = async (context, payload) => {
  const { tx, env, actor, request } = context;
  const mission = await openMission(context, payload.mission_id);
  await checkPlan(tx, mission.mission_id, payload.plan_digest);
  const budget = await loadMissionBudget(tx, mission.mission_id);

  const slot = (await trialSlots(tx, mission.mission_id)).find((entry) => entry.trial_slot === payload.trial_slot);
  if (slot === undefined) throw reject('NOT_FOUND', `The plan has no trial slot ${payload.trial_slot}.`);
  const decided = await tx.query(
    `SELECT 1 FROM decisions WHERE mission_id = $1 AND trial_slot = $2 AND kind = 'DRAFT_TO_EVALUATING'`,
    [mission.mission_id, slot.trial_slot],
  );
  if (decided.rows.length > 0)
    throw reject('POLICY_VIOLATION', `The slot ${slot.trial_slot} has its Decision already.`);

  // The authority: the approved cohort policy of the mission, the Steward's approval and the Researcher who started it.
  const { authority } = payload;
  const policy = await loadPolicy(tx, env, mission.policy_id, mission.policy_revision);
  if (policy === undefined) throw new Error(`The policy of mission ${mission.mission_id} is missing.`);
  const ref = authority.cohort_policy;
  if (ref.id !== policy.id || ref.revision !== policy.revision || ref.digest !== policy.digest) {
    throw reject('IDENTITY_MISMATCH', 'The authority names another cohort policy than the one of the mission.');
  }
  if (authority.mission_started_by !== mission.started_by) {
    throw reject('IDENTITY_MISMATCH', 'The authority names another Researcher than the one who started the mission.');
  }
  const approval = await tx.query(
    `SELECT 1 FROM decisions WHERE decision_id = $1 AND kind = 'POLICY_APPROVAL' AND outcome = 'APPROVED'
        AND policy_id = $2 AND policy_revision = $3`,
    [authority.policy_approval, policy.id, policy.revision],
  );
  if (approval.rows.length === 0) {
    throw reject('POLICY_VIOLATION', 'The approval Decision is not an approval of the cohort policy of the mission.');
  }

  const trial = await tx.query<{ trial_id: string }>(
    `SELECT trial_id FROM trials WHERE mission_id = $1 AND trial_slot = $2 AND status = 'REGISTERED' AND strategy_hash = $3`,
    [mission.mission_id, slot.trial_slot, payload.strategy_hash],
  );
  if (trial.rows.length === 0) {
    throw reject('POLICY_VIOLATION', 'The strategy is not the registered version of this trial slot.');
  }
  const version = await tx.query<{ lifecycle: string }>(
    'SELECT lifecycle FROM strategy_versions WHERE strategy_hash = $1',
    [payload.strategy_hash],
  );
  if (version.rows[0]?.lifecycle !== 'DRAFT') {
    throw reject('POLICY_VIOLATION', 'The strategy version is not a DRAFT: only a DRAFT moves to EVALUATING.');
  }

  const { critique } = payload;
  if (payload.outcome === 'REJECTED') {
    // In S1 no finding category blocks this transition (OQ-02 section 4): there is nothing that could reject.
    throw reject(
      'POLICY_VIOLATION',
      'In S1 no finding blocks DRAFT to EVALUATING: a REJECTED Decision cannot be recorded.',
    );
  }
  let critiqueDigest: string | null = null;
  let reason: string | null = null;
  if (critique.status === 'COMPLETED') {
    if (payload.outcome !== 'APPROVED') {
      throw reject(
        'POLICY_VIOLATION',
        'A completed critique gives an APPROVED Decision; only a critique without a result is DEFERRED.',
      );
    }
    const attempt = await tx.query<{
      status: string;
      mission_id: string;
      trial_slot: string | null;
      agent_role: string | null;
    }>(
      `SELECT a.status, j.mission_id, j.trial_slot, j.agent_role FROM attempts a JOIN jobs j ON j.job_id = a.job_id
        WHERE a.attempt_id = $1`,
      [critique.attempt_id],
    );
    const row = attempt.rows[0];
    if (
      row === undefined ||
      row.status !== 'COMPLETED' ||
      row.mission_id !== mission.mission_id ||
      row.trial_slot !== slot.trial_slot ||
      row.agent_role !== 'CRITIC'
    ) {
      throw reject('POLICY_VIOLATION', 'The critique attempt is not a completed critic attempt of this trial slot.');
    }
    const stored = await artefactRef(tx, critique.result.digest);
    if (
      stored === undefined ||
      stored.size_bytes !== critique.result.size_bytes ||
      stored.media_type !== critique.result.media_type
    ) {
      throw reject(
        'IDENTITY_MISMATCH',
        'The critique result is not a recorded artefact with this size and media type.',
      );
    }
    // The result that the Decision cites is the output of that attempt, which the agent-result route recorded.
    const produced = await tx.query<{ outcome: string; output_contract: string | null; output_digest: string | null }>(
      'SELECT outcome, output_contract, output_digest FROM agent_results WHERE attempt_id = $1',
      [critique.attempt_id],
    );
    const output = produced.rows[0];
    if (
      output === undefined ||
      output.outcome !== 'completion' ||
      output.output_contract !== 'strategy-critique.result/1' ||
      output.output_digest !== critique.result.digest
    ) {
      throw reject(
        'IDENTITY_MISMATCH',
        'The critique result is not the output that the completed critic attempt reported.',
      );
    }
    critiqueDigest = critique.result.digest;
    await assignFindingTreatments(tx, env, mission.mission_id, payload.strategy_hash, policy);
    const blocking = await blockingFindings(tx, mission.mission_id, payload.strategy_hash, 'DRAFT_TO_EVALUATING');
    if (blocking.length > 0) throw reject('POLICY_VIOLATION', 'A finding blocks DRAFT to EVALUATING.');
  } else {
    if (payload.outcome !== 'DEFERRED') {
      throw reject('POLICY_VIOLATION', 'A critique without a valid result gives a DEFERRED Decision.');
    }
    await checkMissingCritique(tx, mission, slot.trial_slot, critique, budget.attempt_cap);
    reason = `The critique ended without a valid result: ${critique.outcome} after ${critique.attempts} attempt(s). The candidate is not evaluated.`;
  }

  const now = env.clock();
  const decisionId = env.ids.next('dec');
  const approved = payload.outcome === 'APPROVED';
  let runs: Work[] = [];
  if (approved) {
    const planned = await tx.query<{ runs: number }>(
      `SELECT count(*)::int AS runs FROM run_slots WHERE mission_id = $1 AND trial_slot = $2 AND written_by = 'EVALUATING_DECISION'`,
      [mission.mission_id, slot.trial_slot],
    );
    const evaluating = await tx.query<{ versions: number }>(
      `SELECT count(*)::int AS versions FROM strategy_versions WHERE mission_id = $1 AND lifecycle = 'EVALUATING'`,
      [mission.mission_id],
    );
    if ((evaluating.rows[0]?.versions ?? 0) + 1 > budget.candidates) {
      const message = `The mission may evaluate ${budget.candidates} candidates and has ${evaluating.rows[0]?.versions ?? 0} already.`;
      throw reject('BUDGET_EXHAUSTED', message, { blockMission: { missionId: mission.mission_id, reason: message } });
    }
    await checkExperiments(tx, mission, planned.rows[0]?.runs ?? 0);
  }
  await tx.query(
    `INSERT INTO decisions (decision_id, kind, outcome, actor_id, actor_kind, policy_id, policy_revision, mission_id,
       trial_slot, strategy_hash, plan_digest, policy_approval_decision, mission_started_by, critique_status,
       critique_digest, reason, command_id, decided_at)
     VALUES ($1, 'DRAFT_TO_EVALUATING', $2, $3, 'SERVICE', $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
    [
      decisionId,
      payload.outcome,
      actor.principalId,
      policy.id,
      policy.revision,
      mission.mission_id,
      slot.trial_slot,
      payload.strategy_hash,
      payload.plan_digest,
      authority.policy_approval,
      authority.mission_started_by,
      critique.status,
      critiqueDigest,
      reason,
      request.command_id,
      now,
    ],
  );
  if (approved) {
    await tx.query(`UPDATE strategy_versions SET lifecycle = 'EVALUATING' WHERE strategy_hash = $1`, [
      payload.strategy_hash,
    ]);
    runs = await writePlannedRuns(
      context,
      mission,
      payload.plan_digest,
      slot.trial_slot,
      payload.strategy_hash,
      'EVALUATING_DECISION',
      budget.attempt_cap,
    );
  } else {
    // The candidate is not evaluated: the slot is terminal with the reason, and no run, reservation or outbox is written.
    await tx.query(
      'UPDATE trial_slots SET terminal_reason = $3, terminal_at = $4 WHERE mission_id = $1 AND trial_slot = $2',
      [mission.mission_id, slot.trial_slot, 'DECISION_DEFERRED', now],
    );
  }
  const next = await bumpMission(tx, mission);
  await writeAudit(tx, now, {
    eventType: 'decision.recorded',
    actor: actor.principalId,
    subject: mission.mission_id,
    commandId: request.command_id,
    detail: {
      decision: decisionId,
      trial_slot: slot.trial_slot,
      outcome: payload.outcome,
      strategy_hash: payload.strategy_hash,
      runs: runs.map((run) => run.id),
    },
  });
  return { id: mission.mission_id, revision: next.revision };
};

const RUN_ENDED = new Set(['COMPLETED', 'FAILED', 'CANCELLED']);

export const freezeCandidates: Applier<FreezeCandidates> = async (context, payload) => {
  const { tx, env, actor, request } = context;
  const mission = await openMission(context, payload.mission_id);
  await checkPlan(tx, mission.mission_id, payload.plan_digest);
  const budget = await loadMissionBudget(tx, mission.mission_id);
  const planned = await trialSlots(tx, mission.mission_id);
  const listed = payload.slots.map((entry) => entry.trial_slot);
  if (
    new Set(listed).size !== listed.length ||
    listed.length !== planned.length ||
    planned.some((entry) => !listed.includes(entry.trial_slot))
  ) {
    throw reject('POLICY_VIOLATION', 'The slots are not every trial slot of the plan, each once.');
  }
  const holdout = await tx.query('SELECT 1 FROM runs WHERE mission_id = $1 AND window_role = $2 LIMIT 1', [
    mission.mission_id,
    'HOLDOUT',
  ]);
  if (holdout.rows.length > 0)
    throw reject('POLICY_VIOLATION', 'The candidates are frozen already: holdout runs exist.');

  const seedSlot = planned.find((entry) => entry.slot_kind === 'SEED');
  const seedEvaluated = payload.slots.some(
    (entry) => entry.trial_slot === seedSlot?.trial_slot && entry.status === 'EVALUATING',
  );
  const evaluating: { slot: string; strategyHash: string }[] = [];
  const notEvaluated: { trial_slot: string; reason: string }[] = [];
  for (const entry of payload.slots) {
    const row = planned.find((candidate) => candidate.trial_slot === entry.trial_slot) as SlotRow;
    const decision = await tx.query<{ outcome: string; strategy_hash: string }>(
      `SELECT outcome, strategy_hash FROM decisions WHERE mission_id = $1 AND trial_slot = $2 AND kind = 'DRAFT_TO_EVALUATING'`,
      [mission.mission_id, entry.trial_slot],
    );
    const decided = decision.rows[0];
    if (entry.status === 'EVALUATING') {
      if (decided?.outcome !== 'APPROVED' || decided.strategy_hash !== entry.strategy_hash) {
        throw reject('POLICY_VIOLATION', `The slot ${entry.trial_slot} has no APPROVED Decision for this strategy.`);
      }
      const runs = await tx.query<{ status: string }>(
        `SELECT status FROM runs WHERE mission_id = $1 AND trial_slot = $2 AND window_role <> 'HOLDOUT'`,
        [mission.mission_id, entry.trial_slot],
      );
      if (runs.rows.length === 0 || runs.rows.some((run) => !RUN_ENDED.has(run.status))) {
        throw reject('POLICY_VIOLATION', `The slot ${entry.trial_slot} is not terminal: its runs have not all ended.`);
      }
      evaluating.push({ slot: entry.trial_slot, strategyHash: entry.strategy_hash });
      continue;
    }
    if (decided?.outcome === 'APPROVED') {
      throw reject('POLICY_VIOLATION', `The slot ${entry.trial_slot} has an APPROVED Decision: it is evaluated.`);
    }
    const open = await inFlight(tx, mission.mission_id, row);
    if (open !== undefined) {
      throw reject('POLICY_VIOLATION', `The slot ${entry.trial_slot} is not terminal: ${open}.`);
    }
    const registered = await tx.query(
      `SELECT 1 FROM trials WHERE mission_id = $1 AND trial_slot = $2 AND status = 'REGISTERED'`,
      [mission.mission_id, entry.trial_slot],
    );
    const revisionOfUnevaluatedSeed = row.slot_kind === 'REVISION' && !seedEvaluated;
    const consistent =
      entry.reason === 'SEED_NOT_EVALUATED'
        ? revisionOfUnevaluatedSeed && decided === undefined
        : !revisionOfUnevaluatedSeed &&
          (entry.reason === 'DECISION_DEFERRED'
            ? decided?.outcome === 'DEFERRED'
            : decided === undefined && registered.rows.length === 0);
    if (!consistent) {
      throw reject(
        'POLICY_VIOLATION',
        `The reason ${entry.reason} is not what the records show for the slot ${entry.trial_slot}.`,
      );
    }
    if (entry.reason === 'NO_REGISTERED_VERSION' && row.slot_kind === 'REVISION') {
      const left = await revisionsEnded(tx, mission.mission_id, row, budget.revisions_per_proposer);
      if (!left.ended) {
        throw reject(
          'POLICY_VIOLATION',
          `The reason NO_REGISTERED_VERSION is not what the records show for the slot ${entry.trial_slot}: the slot is not terminal, ` +
            `because ${left.spent} of its ${budget.revisions_per_proposer} revision proposals ended INVALID or DISCARDED ` +
            'and its proposer run has not ended without a proposal.',
        );
      }
    }
    notEvaluated.push({ trial_slot: entry.trial_slot, reason: entry.reason });
  }

  const now = env.clock();
  for (const entry of notEvaluated) {
    const row = planned.find((candidate) => candidate.trial_slot === entry.trial_slot) as SlotRow;
    if (row.terminal_reason !== null && row.terminal_reason !== entry.reason) {
      throw reject(
        'POLICY_VIOLATION',
        `The slot ${entry.trial_slot} ended with ${row.terminal_reason}, not ${entry.reason}.`,
      );
    }
    await tx.query(
      'UPDATE trial_slots SET terminal_reason = $3, terminal_at = COALESCE(terminal_at, $4) WHERE mission_id = $1 AND trial_slot = $2',
      [mission.mission_id, entry.trial_slot, entry.reason, now],
    );
  }
  let written = 0;
  let current = mission;
  if (evaluating.length === 0) {
    const reasons = notEvaluated.map((entry) => `${entry.trial_slot}: ${entry.reason}`).join('; ');
    current = await transitionMission(tx, env, mission, 'CONCLUDED', {
      outcome: 'NO_ELIGIBLE_CANDIDATE',
      outcomeReason: `No candidate is in EVALUATING (${reasons}).`,
    });
    await tx.query(
      `INSERT INTO mission_outcomes (mission_id, outcome, slot_reasons, recorded_at) VALUES ($1, 'NO_ELIGIBLE_CANDIDATE', $2::jsonb, $3)`,
      [mission.mission_id, JSON.stringify(notEvaluated), now],
    );
  } else {
    const adding = await tx.query<{ runs: number }>(
      `SELECT count(*)::int AS runs FROM run_slots WHERE mission_id = $1 AND written_by = 'FREEZE_CANDIDATES' AND trial_slot = ANY($2::text[])`,
      [mission.mission_id, evaluating.map((entry) => entry.slot)],
    );
    await checkExperiments(tx, mission, adding.rows[0]?.runs ?? 0);
    for (const entry of evaluating) {
      written += (
        await writePlannedRuns(
          context,
          mission,
          payload.plan_digest,
          entry.slot,
          entry.strategyHash,
          'FREEZE_CANDIDATES',
          budget.attempt_cap,
        )
      ).length;
    }
    current = await bumpMission(tx, mission);
  }
  await writeAudit(tx, now, {
    eventType: 'candidates.frozen',
    actor: actor.principalId,
    subject: mission.mission_id,
    commandId: request.command_id,
    detail: { evaluating: evaluating.map((entry) => entry.slot), not_evaluated: notEvaluated, holdout_runs: written },
  });
  return { id: mission.mission_id, revision: current.revision };
};

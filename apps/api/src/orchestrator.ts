// The mission orchestrator (OQ-05 section 3, ResearchWorkflow and EvaluationWorkflow; OQ-02 section 4; OQ-03 sections 1
// and 5; decisions D8, D19 to D22). It advances a mission through the proposal path of D8 with the guarded commands and
// the entry points that already exist, and adds no state of its own:
//
//   1. seed validation       once the plan is recorded, the seed draft's validate job (startValidation)
//   2. critique              a registered DRAFT version of a slot gets one critic run
//   3. Decision              the critic run ended: record_evaluation_decision, APPROVED with the critique or DEFERRED
//                            (an APPROVED Decision writes the D and V runs)
//   4. proposals             once the seed's D runs ended, each proposer configuration gets a proposer run for its
//                            revision slot, and after a proposal that ended INVALID one more, within the revision budget
//   5. registration          a completed proposer run's proposal is read with the shared parser and validated as a
//                            controlled revision of the seed (startValidation), or recorded as an INVALID trial
//   6. freeze                every trial slot is terminal: freeze_candidates with the reason of each slot (H runs,
//                            or the conclusion NO_ELIGIBLE_CANDIDATE when no candidate is in EVALUATING)
//   7. assessment            a frozen candidate whose runs all ended gets its assess job (startAssessment); the gate
//                            report concludes the mission when nothing is open (assessment.ts)
//
// Every step is a function of the recorded state. It locks the mission first (the lock order of rows.ts), reads what
// is done, and issues the next guarded command or job in one transaction, so a repeated step finds its own work and
// writes nothing: no second run, attempt or reservation. The internal commands take a command ID derived from the
// mission, its revision and the step, and the command runner returns the first result for a repeat. A mission that is
// not IN_PROGRESS is left alone: a BLOCKED mission (budget exhausted) waits for cancel_mission, and a WITHDRAWN one has
// stopped.
//
// It runs after each committed result, in the request that committed it (advanceAfterResult), and on the scheduled tick
// as catch-up (advanceMissions, from recovery.ts). It is not a Cloudflare Workflow: S1 keeps the orchestration in these
// steps and the application records (README, OQ-05 section 3).

import {
  parseFormulationResult,
  type StrategyFormulationRequest,
  type StrategyFormulationResult,
} from '@openquant/agents';
import type { CommandRequest, StrategyArtefact } from '@openquant/api-contracts';
import { digest, validateContract } from '@openquant/api-contracts';
import { type CommandOutcome, executeCommand, readCommand } from './commands/runner.ts';
import type { Database, Queryable } from './db/database.ts';
import { AgentRequestRefused, buildAgent } from './domain/agent-requests.ts';
import { openAttempt, type WorkContext } from './domain/attempts.ts';
import { allBuilders, startAssessment, startValidation } from './domain/builders.ts';
import type { DispatchBuilders } from './domain/dispatch.ts';
import { loadPolicy } from './domain/documents.ts';
import { blockMission } from './domain/missions.ts';
import { dispatchOf, storedBytes } from './domain/refs.ts';
import { type Actor, findMission, loadMissionBudget, lockMission, type MissionRow } from './domain/rows.ts';
import { artefactRef, loadDocument, storeDocument } from './domain/store.ts';
import { assertTransition } from './domain/transitions.ts';
import { insertJob, setWaitingReason } from './domain/work.ts';
import type { ApiEnv } from './env.ts';

/** The builders of every kind of work, with the request assembly of a first agent attempt. */
export const workflowBuilders: DispatchBuilders = { ...allBuilders, agent: buildAgent };

interface Step {
  readonly name: string;
  run(env: ApiEnv, db: Database, actor: Actor, missionId: string): Promise<boolean>;
}

const decoder = new TextDecoder();
const ENDED = ['COMPLETED', 'FAILED', 'CANCELLED'];

function context(env: ApiEnv, actor: Actor): WorkContext {
  return { env, actorId: actor.principalId, builders: workflowBuilders };
}

/** The active workflows service principal of the environment, under which the orchestrator writes. */
export async function workflowsActor(db: Queryable, env: Pick<ApiEnv, 'environment'>): Promise<Actor | undefined> {
  const { rows } = await db.query<{ principal_id: string }>(
    `SELECT principal_id FROM principals WHERE kind = 'SERVICE' AND service_kind = 'workflows' AND status = 'ACTIVE'
        AND environment = $1 ORDER BY principal_id LIMIT 1`,
    [env.environment],
  );
  const principalId = rows[0]?.principal_id;
  return principalId === undefined ? undefined : { principalId, kind: 'SERVICE', serviceKind: 'workflows', roles: [] };
}

/**
 * One transaction of a step: the mission locked first and IN_PROGRESS. A request that assembly refuses rolls the step
 * back; the mission is then BLOCKED with the reason in a transaction of its own (OQ-03 section 4: a blocked task).
 */
async function inMission(
  env: ApiEnv,
  db: Database,
  actor: Actor,
  missionId: string,
  work: (tx: Queryable, mission: MissionRow) => Promise<boolean>,
): Promise<boolean> {
  try {
    return await db.transaction(async (tx) => {
      const mission = await lockMission(tx, missionId);
      if (mission.status !== 'IN_PROGRESS') return false;
      return work(tx, mission);
    });
  } catch (error) {
    if (!(error instanceof AgentRequestRefused)) throw error;
    await db.transaction(async (tx) => {
      const mission = await lockMission(tx, missionId);
      await blockMission(tx, env, mission, error.message, actor.principalId);
    });
    return true;
  }
}

async function planDigestOf(tx: Queryable, missionId: string): Promise<string | undefined> {
  const { rows } = await tx.query<{ plan_digest: string }>(
    'SELECT plan_digest FROM evaluation_plans WHERE mission_id = $1',
    [missionId],
  );
  return rows[0]?.plan_digest;
}

interface SlotState {
  readonly trialSlot: string;
  readonly kind: 'SEED' | 'REVISION';
  readonly draftDigest: string | null;
  readonly parentSlot: string | null;
  readonly configurationId: string | null;
  readonly terminalReason: string | null;
  /** The registered version of the slot and its lifecycle, when one is registered. */
  readonly strategyHash: string | null;
  readonly lifecycle: string | null;
  readonly decision: 'APPROVED' | 'DEFERRED' | 'REJECTED' | null;
  readonly trials: number;
  readonly drafted: number;
  readonly spent: number;
}

async function slotsOf(tx: Queryable, missionId: string): Promise<SlotState[]> {
  const { rows } = await tx.query<{
    trial_slot: string;
    slot_kind: 'SEED' | 'REVISION';
    draft_digest: string | null;
    parent_slot: string | null;
    configuration_id: string | null;
    terminal_reason: string | null;
    strategy_hash: string | null;
    lifecycle: string | null;
    decision: SlotState['decision'];
    trials: number;
    drafted: number;
    spent: number;
  }>(
    `SELECT s.trial_slot, s.slot_kind, s.draft_digest, s.parent_slot, s.configuration_id, s.terminal_reason,
            t.strategy_hash, v.lifecycle, d.outcome AS decision,
            (SELECT count(*)::int FROM trials x WHERE x.mission_id = s.mission_id AND x.trial_slot = s.trial_slot) AS trials,
            (SELECT count(*)::int FROM trials x WHERE x.mission_id = s.mission_id AND x.trial_slot = s.trial_slot
                AND x.status = 'DRAFTED') AS drafted,
            (SELECT count(*)::int FROM trials x WHERE x.mission_id = s.mission_id AND x.trial_slot = s.trial_slot
                AND x.status IN ('INVALID', 'DISCARDED')) AS spent
       FROM trial_slots s
       LEFT JOIN trials t ON t.mission_id = s.mission_id AND t.trial_slot = s.trial_slot AND t.status = 'REGISTERED'
       LEFT JOIN strategy_versions v ON v.strategy_hash = t.strategy_hash
       LEFT JOIN decisions d ON d.mission_id = s.mission_id AND d.trial_slot = s.trial_slot AND d.kind = 'DRAFT_TO_EVALUATING'
      WHERE s.mission_id = $1 ORDER BY s.slot_kind DESC, s.trial_slot`,
    [missionId],
  );
  return rows.map((row) => ({
    trialSlot: row.trial_slot,
    kind: row.slot_kind,
    draftDigest: row.draft_digest,
    parentSlot: row.parent_slot,
    configurationId: row.configuration_id,
    terminalReason: row.terminal_reason,
    strategyHash: row.strategy_hash,
    lifecycle: row.lifecycle,
    decision: row.decision,
    trials: row.trials,
    drafted: row.drafted,
    spent: row.spent,
  }));
}

interface AgentJobRow {
  job_id: string;
  status: string;
}

async function agentJobs(
  tx: Queryable,
  missionId: string,
  slot: string,
  role: 'PROPOSER' | 'CRITIC',
): Promise<AgentJobRow[]> {
  const { rows } = await tx.query<AgentJobRow>(
    `SELECT job_id, status FROM jobs WHERE mission_id = $1 AND kind = 'agent' AND agent_role = $3 AND trial_slot = $2
      ORDER BY created_at, job_id`,
    [missionId, slot, role],
  );
  return rows;
}

async function openValidation(tx: Queryable, missionId: string, slot: string): Promise<boolean> {
  const { rows } = await tx.query(
    `SELECT 1 FROM jobs WHERE mission_id = $1 AND trial_slot = $2 AND kind = 'validate' AND status IN ('QUEUED', 'RUNNING')`,
    [missionId, slot],
  );
  return rows.length > 0;
}

/** Runs of a slot (other than the holdout runs): how many there are and how many are still open. */
async function runsOfSlot(tx: Queryable, missionId: string, slot: string, roles: readonly string[]) {
  const { rows } = await tx.query<{ total: number; open: number }>(
    `SELECT count(*)::int AS total, count(*) FILTER (WHERE status IN ('QUEUED', 'RUNNING'))::int AS open
       FROM runs WHERE mission_id = $1 AND trial_slot = $2 AND window_role = ANY($3::text[])`,
    [missionId, slot, roles],
  );
  return rows[0] ?? { total: 0, open: 0 };
}

/** Start one agent run of a slot with its first attempt; without budget the mission is BLOCKED with the reason. */
async function startAgentRun(
  tx: Queryable,
  ctx: WorkContext,
  mission: MissionRow,
  input: { slot: string; role: 'PROPOSER' | 'CRITIC'; configurationId: string },
): Promise<void> {
  const budget = await loadMissionBudget(tx, mission.mission_id);
  const job = await insertJob(tx, ctx.env, {
    missionId: mission.mission_id,
    kind: 'agent',
    attemptCap: budget.attempt_cap,
    trialSlot: input.slot,
    configurationId: input.configurationId,
    agentRole: input.role,
  });
  const opened = await openAttempt(tx, ctx, job);
  if (!opened.ok) {
    // OQ-05 section 4: no budget for the attempt leaves the run QUEUED with no live attempt and the reason, and the
    // mission BLOCKED with the same reason. Only cancel_mission ends it.
    const reason = `The ${input.role.toLowerCase()} run of ${input.slot} cannot be reserved: ${opened.reason}`.slice(
      0,
      1000,
    );
    await setWaitingReason(tx, job, reason);
    await blockMission(tx, ctx.env, mission, reason, ctx.actorId);
  }
}

// --- 1. seed validation ----------------------------------------------------------------------------------------------

const validateSeed: Step = {
  name: 'seed-validation',
  run: (env, db, actor, missionId) =>
    inMission(env, db, actor, missionId, async (tx, mission) => {
      if ((await planDigestOf(tx, missionId)) === undefined) return false;
      const seed = (await slotsOf(tx, missionId)).find((slot) => slot.kind === 'SEED');
      if (seed === undefined || seed.terminalReason !== null || seed.trials > 0 || seed.draftDigest === null) {
        return false;
      }
      await startValidation(tx, context(env, actor), {
        missionId: mission.mission_id,
        trialSlot: seed.trialSlot,
        draftDigest: seed.draftDigest,
      });
      return true;
    }),
};

// --- 2. critique -----------------------------------------------------------------------------------------------------

const critique: Step = {
  name: 'critique',
  run: (env, db, actor, missionId) =>
    inMission(env, db, actor, missionId, async (tx, mission) => {
      const critic = await tx.query<{ configuration_id: string }>(
        `SELECT configuration_id FROM mission_agent_configurations WHERE mission_id = $1 AND role = 'CRITIC'`,
        [missionId],
      );
      const criticId = critic.rows[0]?.configuration_id;
      if (criticId === undefined) return false;
      let acted = false;
      for (const slot of await slotsOf(tx, missionId)) {
        if (slot.strategyHash === null || slot.lifecycle !== 'DRAFT' || slot.decision !== null) continue;
        if ((await agentJobs(tx, missionId, slot.trialSlot, 'CRITIC')).length > 0) continue;
        await startAgentRun(tx, context(env, actor), mission, {
          slot: slot.trialSlot,
          role: 'CRITIC',
          configurationId: criticId,
        });
        acted = true;
        if ((await findMission(tx, missionId))?.status !== 'IN_PROGRESS') break;
      }
      return acted;
    }),
};

// --- internal commands -----------------------------------------------------------------------------------------------

function timestamp(date: Date): string {
  return `${date.toISOString().slice(0, 19)}Z`;
}

/**
 * Apply an internal command of the workflows principal with a command ID derived from the mission, its revision and
 * the step. A repeat of the step at the same revision finds the stored command and changes nothing; a command that the
 * crash of an earlier pass left PENDING is applied again with the same body (its issued_at is its received_at).
 */
async function issue(
  env: ApiEnv,
  db: Database,
  actor: Actor,
  mission: MissionRow,
  step: string,
  payload: CommandRequest['payload'],
): Promise<CommandOutcome | undefined> {
  const commandId = `wf-${(await digest({ mission: mission.mission_id, revision: mission.revision, step })).slice(7, 39)}`;
  const stored = await readCommand(db, commandId);
  if (stored !== undefined && stored.state !== 'PENDING') return undefined;
  const received =
    stored === undefined
      ? env.clock()
      : (await db.query<{ received_at: Date }>('SELECT received_at FROM commands WHERE command_id = $1', [commandId]))
          .rows[0]?.received_at;
  const now = received ?? env.clock();
  const request = {
    schema_version: 'command/1',
    form: 'request',
    command_id: commandId,
    expected_revision: mission.revision,
    issued_at: timestamp(now),
    payload,
  } as CommandRequest;
  // The command runner records received_at from the clock: the same instant as issued_at, so a repeat has one body.
  const fixed: ApiEnv = { ...env, clock: () => new Date(Math.floor(now.getTime() / 1000) * 1000) };
  const outcome = await executeCommand({ env: fixed, db, actor, builders: workflowBuilders }, request);
  if (outcome.state === 'REJECTED') {
    env.log({
      level: 'warn',
      message: `orchestrator: the ${payload.kind} command was refused`,
      mission_id: mission.mission_id,
      code: outcome.status.error.code,
    });
  }
  return outcome;
}

async function authority(tx: Queryable, env: ApiEnv, mission: MissionRow) {
  const policy = await loadPolicy(tx, env, mission.policy_id, mission.policy_revision);
  if (policy === undefined) throw new Error(`The policy of mission ${mission.mission_id} is missing.`);
  const approval = await tx.query<{ decision_id: string }>(
    `SELECT decision_id FROM decisions WHERE kind = 'POLICY_APPROVAL' AND outcome = 'APPROVED' AND policy_id = $1
        AND policy_revision = $2 ORDER BY decided_at DESC, decision_id DESC LIMIT 1`,
    [policy.id, policy.revision],
  );
  const approvalId = approval.rows[0]?.decision_id;
  if (approvalId === undefined || mission.started_by === null) return undefined;
  return {
    cohort_policy: { id: policy.id, revision: policy.revision, digest: policy.digest },
    policy_approval: approvalId,
    mission_started_by: mission.started_by,
  };
}

// --- 3. Decision -----------------------------------------------------------------------------------------------------

/** The critique evidence of a slot whose critic run ended, or undefined while it runs or has not started. */
async function critiqueEvidence(tx: Queryable, missionId: string, slot: string) {
  const jobs = await agentJobs(tx, missionId, slot, 'CRITIC');
  const job = jobs.at(-1);
  if (job === undefined) return undefined;
  if (job.status === 'COMPLETED') {
    const output = await tx.query<{ attempt_id: string; output_digest: string }>(
      `SELECT r.attempt_id, r.output_digest FROM agent_results r JOIN attempts a ON a.attempt_id = r.attempt_id
        WHERE r.job_id = $1 AND a.status = 'COMPLETED' AND r.outcome = 'completion'`,
      [job.job_id],
    );
    const row = output.rows[0];
    const ref = row === undefined ? undefined : await artefactRef(tx, row.output_digest);
    if (row === undefined || ref === undefined) return undefined;
    return { outcome: 'APPROVED' as const, critique: { status: 'COMPLETED', attempt_id: row.attempt_id, result: ref } };
  }
  if (job.status !== 'FAILED') return undefined;
  const attempts = await tx.query<{ status: string; agent_outcome: string | null }>(
    'SELECT status, agent_outcome FROM attempts WHERE job_id = $1 ORDER BY ownership_revision',
    [job.job_id],
  );
  const last = attempts.rows.at(-1);
  const outcome = last?.status === 'LEASE_EXPIRED' ? 'lease_expired' : last?.agent_outcome;
  if (outcome == null) return undefined;
  return {
    outcome: 'DEFERRED' as const,
    critique: { status: 'NO_VALID_RESULT', outcome, attempts: attempts.rows.length },
  };
}

const decide: Step = {
  name: 'decision',
  async run(env, db, actor, missionId) {
    const pending = await db.transaction(async (tx) => {
      const mission = await findMission(tx, missionId);
      if (mission?.status !== 'IN_PROGRESS') return undefined;
      const planDigest = await planDigestOf(tx, missionId);
      const granted = await authority(tx, env, mission);
      if (planDigest === undefined || granted === undefined) return undefined;
      for (const slot of await slotsOf(tx, missionId)) {
        if (slot.strategyHash === null || slot.lifecycle !== 'DRAFT' || slot.decision !== null) continue;
        const evidence = await critiqueEvidence(tx, missionId, slot.trialSlot);
        if (evidence === undefined) continue;
        return {
          mission,
          slot: slot.trialSlot,
          payload: {
            kind: 'record_evaluation_decision',
            mission_id: missionId,
            plan_digest: planDigest,
            trial_slot: slot.trialSlot,
            strategy_hash: slot.strategyHash,
            critique: evidence.critique,
            outcome: evidence.outcome,
            authority: granted,
          } as CommandRequest['payload'],
        };
      }
      return undefined;
    });
    if (pending === undefined) return false;
    const outcome = await issue(env, db, actor, pending.mission, `decision:${pending.slot}`, pending.payload);
    return outcome?.state === 'APPLIED';
  },
};

// --- 4. proposals ----------------------------------------------------------------------------------------------------

/** The seed is evaluated and its development runs have ended: the revisions can read the D results (OQ-02 section 4). */
async function seedReady(tx: Queryable, missionId: string, seed: SlotState | undefined): Promise<boolean> {
  if (seed?.decision !== 'APPROVED') return false;
  const runs = await runsOfSlot(tx, missionId, seed.trialSlot, ['DEVELOPMENT']);
  return runs.total > 0 && runs.open === 0;
}

const propose: Step = {
  name: 'proposal',
  run: (env, db, actor, missionId) =>
    inMission(env, db, actor, missionId, async (tx, mission) => {
      const slots = await slotsOf(tx, missionId);
      if (
        !(await seedReady(
          tx,
          missionId,
          slots.find((slot) => slot.kind === 'SEED'),
        ))
      )
        return false;
      const budget = await loadMissionBudget(tx, missionId);
      let acted = false;
      for (const slot of slots) {
        if (slot.kind !== 'REVISION' || slot.terminalReason !== null || slot.configurationId === null) continue;
        if (slot.strategyHash !== null || slot.drafted > 0) continue;
        if (await openValidation(tx, missionId, slot.trialSlot)) continue;
        const runs = await agentJobs(tx, missionId, slot.trialSlot, 'PROPOSER');
        if (runs.some((run) => !ENDED.includes(run.status))) continue;
        // A proposer run that ended without a proposal ends the slot (NO_REGISTERED_VERSION at the freeze).
        if (runs.at(-1)?.status === 'FAILED' || runs.at(-1)?.status === 'CANCELLED') continue;
        // A completed run whose proposal is not recorded yet is the registration step's.
        if (runs.filter((run) => run.status === 'COMPLETED').length > slot.trials) continue;
        if (slot.trials >= budget.revisions_per_proposer) continue;
        await startAgentRun(tx, context(env, actor), mission, {
          slot: slot.trialSlot,
          role: 'PROPOSER',
          configurationId: slot.configurationId,
        });
        acted = true;
        if ((await findMission(tx, missionId))?.status !== 'IN_PROGRESS') break;
      }
      return acted;
    }),
};

// --- 5. registration of a proposal -----------------------------------------------------------------------------------

/** Record a proposal that is not validated as an INVALID trial of its slot, with the reason the next proposer reads. */
async function invalidProposal(
  tx: Queryable,
  env: ApiEnv,
  missionId: string,
  slot: string,
  draftDigest: string,
  reason: string,
): Promise<void> {
  const ordinal = await tx.query<{ next: number }>(
    'SELECT COALESCE(MAX(proposal_ordinal), 0)::int + 1 AS next FROM trials WHERE mission_id = $1 AND trial_slot = $2',
    [missionId, slot],
  );
  const trialId = env.ids.next('trial');
  await tx.query(
    `INSERT INTO trials (trial_id, mission_id, trial_slot, proposal_ordinal, draft_digest, created_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [trialId, missionId, slot, ordinal.rows[0]?.next, draftDigest, env.clock()],
  );
  assertTransition('trial', 'DRAFTED', 'INVALID');
  await tx.query(`UPDATE trials SET status = 'INVALID', reason = $2 WHERE trial_id = $1`, [
    trialId,
    reason.length > 1000 ? `${reason.slice(0, 997)}...` : reason,
  ]);
}

/**
 * The draft of a proposal (OQ-03 section 4): the proposed strategy with the identity, version and parent that the API
 * assigns. The version is the next one of the seed's strategy in this mission: every proposal gets its own, so two
 * revisions that register never claim the same version.
 */
async function draftOf(
  tx: Queryable,
  missionId: string,
  seed: StrategyArtefact,
  proposal: Extract<StrategyFormulationResult, { proposal_kind: 'controlled_revision' }>,
): Promise<unknown> {
  const proposals = await tx.query<{ proposals: number }>(
    `SELECT count(*)::int AS proposals FROM trials t JOIN trial_slots s ON s.mission_id = t.mission_id AND s.trial_slot = t.trial_slot
      WHERE t.mission_id = $1 AND s.slot_kind = 'REVISION'`,
    [missionId],
  );
  return {
    schema_version: 'strategy-artefact/1',
    strategy_id: seed.strategy_id,
    version: seed.version + 1 + (proposals.rows[0]?.proposals ?? 0),
    operator_set: proposal.strategy.operator_set,
    parent: { hash: proposal.parent_hash, changes: proposal.rule_changes },
    contract: proposal.strategy.contract,
    definition: proposal.strategy.definition,
  };
}

const register: Step = {
  name: 'registration',
  run: (env, db, actor, missionId) =>
    inMission(env, db, actor, missionId, async (tx) => {
      const slots = await slotsOf(tx, missionId);
      const seed = slots.find((slot) => slot.kind === 'SEED');
      if (seed?.strategyHash == null) return false;
      let acted = false;
      for (const slot of slots) {
        if (slot.kind !== 'REVISION' || slot.terminalReason !== null) continue;
        const completed = (await agentJobs(tx, missionId, slot.trialSlot, 'PROPOSER')).filter(
          (run) => run.status === 'COMPLETED',
        );
        // The proposals of a slot are recorded in the order of its completed proposer runs, one trial each.
        const next = completed[slot.trials];
        if (next === undefined) continue;
        const output = await tx.query<{ attempt_id: string; output_digest: string }>(
          `SELECT r.attempt_id, r.output_digest FROM agent_results r JOIN attempts a ON a.attempt_id = r.attempt_id
            WHERE r.job_id = $1 AND a.status = 'COMPLETED' AND r.outcome = 'completion'`,
          [next.job_id],
        );
        const row = output.rows[0];
        if (row === undefined) continue;
        acted = true;
        const message = (await dispatchOf(tx, row.attempt_id)).message as {
          inputs: { request: { artefact: { digest: string } } };
        };
        const request = JSON.parse(
          decoder.decode(await storedBytes(env, message.inputs.request.artefact.digest)),
        ) as StrategyFormulationRequest;
        const parsed = parseFormulationResult(request, await storedBytes(env, row.output_digest));
        const reject = (reason: string) =>
          invalidProposal(tx, env, missionId, slot.trialSlot, row.output_digest, reason);
        if (!parsed.ok) {
          await reject(`The proposal does not parse: ${parsed.reason}: ${parsed.diagnostic}`);
          continue;
        }
        const proposal = parsed.value;
        if (proposal.proposal_kind !== 'controlled_revision' || proposal.parent_hash !== seed.strategyHash) {
          await reject('The proposal is not a controlled revision of the registered seed.');
          continue;
        }
        // Unresolved executable semantics block registration (OQ-03 section 1): the proposal stays draft material.
        if (proposal.unresolved.length > 0) {
          await reject(`The proposal leaves ${proposal.unresolved.length} executable rule(s) unresolved.`);
          continue;
        }
        // A proposal that cites a date of a withheld window used withheld data (OQ-02 section 3.3): it is never built
        // into a draft, since the draft drops the claims that show it. The reason names no date, so the next
        // request carries none.
        if (parsed.blockers.some((blocker) => blocker.code === 'HOLDOUT_REFERENCE')) {
          await reject('The proposal cites a date inside a withheld window.');
          continue;
        }
        const seedArtefact = await loadDocument(env, 'strategy-artefact', seed.strategyHash);
        const draft = await draftOf(tx, missionId, seedArtefact, proposal);
        if (!validateContract('strategy-artefact', draft).ok) {
          await reject('The proposed strategy does not form a strategy-artefact/1 document.');
          continue;
        }
        const stored = await storeDocument(tx, env, 'strategy-artefact', draft, actor.principalId);
        const started = await startValidation(tx, context(env, actor), {
          missionId,
          trialSlot: slot.trialSlot,
          draftDigest: stored.ref.digest,
          parentHash: seed.strategyHash,
        });
        // A refusal before the trial row (lineage, a used revision budget) is recorded here, so the slot can close.
        const recorded = await tx.query(
          'SELECT 1 FROM trials WHERE mission_id = $1 AND trial_slot = $2 AND draft_digest = $3',
          [missionId, slot.trialSlot, stored.ref.digest],
        );
        if (!started.ok && recorded.rows.length === 0 && (await findMission(tx, missionId))?.status === 'IN_PROGRESS') {
          await reject(started.reason);
        }
        if ((await findMission(tx, missionId))?.status !== 'IN_PROGRESS') break;
      }
      return acted;
    }),
};

// --- 6. freeze -------------------------------------------------------------------------------------------------------

type FreezeEntry =
  | { readonly trial_slot: string; readonly status: 'EVALUATING'; readonly strategy_hash: string }
  | {
      readonly trial_slot: string;
      readonly status: 'NOT_EVALUATED';
      readonly reason: 'DECISION_DEFERRED' | 'NO_REGISTERED_VERSION' | 'SEED_NOT_EVALUATED';
    };

/** The freeze entry of a slot once it is terminal (OQ-02 section 4), or undefined while it is not. */
async function terminalEntry(
  tx: Queryable,
  missionId: string,
  slot: SlotState,
  seedEvaluated: boolean,
  revisionsPerProposer: number,
): Promise<FreezeEntry | undefined> {
  if (slot.decision === 'APPROVED' && slot.strategyHash !== null) {
    const runs = await runsOfSlot(tx, missionId, slot.trialSlot, ['DEVELOPMENT', 'VALIDATION']);
    return runs.total > 0 && runs.open === 0
      ? { trial_slot: slot.trialSlot, status: 'EVALUATING', strategy_hash: slot.strategyHash }
      : undefined;
  }
  if (slot.decision === 'DEFERRED')
    return { trial_slot: slot.trialSlot, status: 'NOT_EVALUATED', reason: 'DECISION_DEFERRED' };
  if (slot.decision !== null) return undefined;
  if (slot.kind === 'REVISION' && !seedEvaluated) {
    const proposing = await agentJobs(tx, missionId, slot.trialSlot, 'PROPOSER');
    if (proposing.some((run) => !ENDED.includes(run.status))) return undefined;
    return { trial_slot: slot.trialSlot, status: 'NOT_EVALUATED', reason: 'SEED_NOT_EVALUATED' };
  }
  // Something of the slot is in flight: a registered version awaiting its critique and Decision, a proposal in
  // validation, or a proposer run.
  if (slot.strategyHash !== null || slot.drafted > 0 || (await openValidation(tx, missionId, slot.trialSlot))) {
    return undefined;
  }
  if (slot.kind === 'SEED') {
    return slot.trials > 0
      ? { trial_slot: slot.trialSlot, status: 'NOT_EVALUATED', reason: 'NO_REGISTERED_VERSION' }
      : undefined;
  }
  const runs = await agentJobs(tx, missionId, slot.trialSlot, 'PROPOSER');
  if (runs.some((run) => !ENDED.includes(run.status))) return undefined;
  if (runs.filter((run) => run.status === 'COMPLETED').length > slot.trials) return undefined;
  const lastFailed = runs.at(-1)?.status === 'FAILED';
  return slot.spent >= revisionsPerProposer || lastFailed
    ? { trial_slot: slot.trialSlot, status: 'NOT_EVALUATED', reason: 'NO_REGISTERED_VERSION' }
    : undefined;
}

const freeze: Step = {
  name: 'freeze',
  async run(env, db, actor, missionId) {
    const pending = await db.transaction(async (tx) => {
      const mission = await findMission(tx, missionId);
      if (mission?.status !== 'IN_PROGRESS') return undefined;
      const planDigest = await planDigestOf(tx, missionId);
      if (planDigest === undefined) return undefined;
      const frozen = await tx.query(`SELECT 1 FROM runs WHERE mission_id = $1 AND window_role = 'HOLDOUT' LIMIT 1`, [
        missionId,
      ]);
      if (frozen.rows.length > 0) return undefined;
      const budget = await loadMissionBudget(tx, missionId);
      const slots = await slotsOf(tx, missionId);
      const seed = slots.find((slot) => slot.kind === 'SEED');
      const seedEvaluated = seed?.decision === 'APPROVED';
      const entries: FreezeEntry[] = [];
      for (const slot of slots) {
        const entry = await terminalEntry(tx, missionId, slot, seedEvaluated, budget.revisions_per_proposer);
        if (entry === undefined) return undefined;
        entries.push(entry);
      }
      return {
        mission,
        payload: { kind: 'freeze_candidates', mission_id: missionId, plan_digest: planDigest, slots: entries } as never,
      };
    });
    if (pending === undefined) return false;
    const outcome = await issue(env, db, actor, pending.mission, 'freeze', pending.payload);
    return outcome?.state === 'APPLIED';
  },
};

// --- 7. assessment ---------------------------------------------------------------------------------------------------

const assess: Step = {
  name: 'assessment',
  run: (env, db, actor, missionId) =>
    inMission(env, db, actor, missionId, async (tx) => {
      const frozen = await tx.query(`SELECT 1 FROM runs WHERE mission_id = $1 AND window_role = 'HOLDOUT' LIMIT 1`, [
        missionId,
      ]);
      if (frozen.rows.length === 0) return false;
      let acted = false;
      for (const slot of await slotsOf(tx, missionId)) {
        if (slot.lifecycle !== 'EVALUATING') continue;
        const assessed = await tx.query(
          `SELECT 1 FROM jobs WHERE mission_id = $1 AND trial_slot = $2 AND kind = 'assess' AND status <> 'CANCELLED'`,
          [missionId, slot.trialSlot],
        );
        if (assessed.rows.length > 0) continue;
        const runs = await runsOfSlot(tx, missionId, slot.trialSlot, ['DEVELOPMENT', 'VALIDATION', 'HOLDOUT']);
        if (runs.open > 0) continue;
        const started = await startAssessment(tx, context(env, actor), { missionId, trialSlot: slot.trialSlot });
        acted = acted || started.ok;
        if ((await findMission(tx, missionId))?.status !== 'IN_PROGRESS') break;
      }
      return acted;
    }),
};

export const STEPS: readonly Step[] = [validateSeed, critique, decide, propose, register, freeze, assess];

/** At most this many rounds of every step in one call: each round that acts moves the mission by at least one step. */
const MAX_ROUNDS = 16;

/**
 * Advance one mission as far as its recorded state allows now. Returns the names of the steps that acted, in order.
 * Every step is idempotent, so a repeated call, an overlapping tick or a redelivered result writes nothing twice.
 */
export async function advanceMission(env: ApiEnv, db: Database, actor: Actor, missionId: string): Promise<string[]> {
  const acted: string[] = [];
  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    let progressed = false;
    for (const step of STEPS) {
      if (await step.run(env, db, actor, missionId)) {
        acted.push(step.name);
        progressed = true;
      }
    }
    if (!progressed) break;
  }
  return acted;
}

export interface AdvanceSummary {
  /** Missions in which at least one step acted. */
  readonly advanced: number;
  /** Missions whose advance threw: logged and tried again on the next tick. */
  readonly errors: number;
}

/** The catch-up of the scheduled tick: every IN_PROGRESS mission, the oldest first, at most `limit`. */
export async function advanceMissions(env: ApiEnv, db: Database, actor: Actor, limit: number): Promise<AdvanceSummary> {
  const missions = await db.query<{ mission_id: string }>(
    `SELECT mission_id FROM missions WHERE status = 'IN_PROGRESS' ORDER BY started_at, mission_id LIMIT $1`,
    [limit],
  );
  let advanced = 0;
  let errors = 0;
  for (const { mission_id: missionId } of missions.rows) {
    try {
      if ((await advanceMission(env, db, actor, missionId)).length > 0) advanced += 1;
    } catch (error) {
      errors += 1;
      env.log({
        level: 'error',
        message: 'orchestrator: the advance of a mission failed; the next tick tries again',
        mission_id: missionId,
        error: error instanceof Error ? error.name : 'unknown',
      });
    }
  }
  return { advanced, errors };
}

/**
 * The advance after a committed result, in the request that committed it. It never fails the request: the result is
 * committed, and the scheduled tick catches up with whatever this call could not do.
 */
export async function advanceAfterResult(env: ApiEnv, db: Database, attemptId: string): Promise<void> {
  try {
    const owner = await db.query<{ mission_id: string }>(
      `SELECT COALESCE(r.mission_id, j.mission_id) AS mission_id FROM attempts a
         LEFT JOIN runs r ON r.run_id = a.run_id LEFT JOIN jobs j ON j.job_id = a.job_id WHERE a.attempt_id = $1`,
      [attemptId],
    );
    const missionId = owner.rows[0]?.mission_id;
    const actor = await workflowsActor(db, env);
    if (missionId == null || actor === undefined) return;
    await advanceMission(env, db, actor, missionId);
  } catch (error) {
    env.log({
      level: 'error',
      message: 'orchestrator: the advance after a result failed; the scheduled tick catches up',
      attempt_id: attemptId,
      error: error instanceof Error ? error.name : 'unknown',
    });
  }
}

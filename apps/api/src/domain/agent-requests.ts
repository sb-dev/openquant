// The first attempt of agent work (OQ-03 sections 3 and 4, OQ-05 section 4). The workflow assembles the role request
// from trusted records with the shared request assembly of packages/agents, stores it by digest and dispatches it in an
// agent-dispatch/1 envelope. A retry repeats the message of the attempt before it (builders.ts, retryAgent).
//
// What a request carries (OQ-02 section 3.3, OQ-03 section 1, D20):
//   context    the mission's instrument, the information cutoff of the development window D, the operators and the
//              frozen cohort policy, the profile's provider capabilities, and holdout exclusions that name V and H with
//              their resolved scored sessions from the plan and the frozen calendar;
//   critic     the registered Strategy Version of its slot, and no evidence: critique follows registration and
//              precedes evaluation;
//   proposer   a controlled revision of the seed's registered version, with D results and findings only: the official
//              metrics of the seed's development runs, the seed's critic findings, and the diagnostics of the earlier
//              proposals of its slot that ended INVALID.
//
// Assembly refuses what it cannot build (a refusal is a value, never repaired); this module turns a refusal into an
// AgentRequestRefused error, which rolls the attempt back, and the orchestrator blocks the mission with the reason.

import {
  type Assembly,
  assembleCritiqueRequest,
  assembleFormulationRequest,
  BUNDLE_HASH,
  type EvidenceItem,
  type RoleContext,
  skillForRole,
} from '@openquant/agents';
import type { DatasetManifest, StrategyArtefact } from '@openquant/api-contracts';
import { validateContract } from '@openquant/api-contracts';
import type { Queryable } from '../db/database.ts';
import type { ApiEnv } from '../env.ts';
import { retryAgent } from './builders.ts';
import type { Binding, BuildContext, Dispatch, DispatchBuilder } from './dispatch.ts';
import { loadPlan, loadPolicy, loadProfile } from './documents.ts';
import { findMission, loadMissionBudget, type MissionRow } from './rows.ts';
import { loadDocument, storeBytes } from './store.ts';
import { missionIdOf, type Work } from './work.ts';

/** Assembly refused the request, or the records cannot give one: nothing is dispatched (OQ-03 section 4). */
export class AgentRequestRefused extends Error {
  readonly missionId: string;
  constructor(missionId: string, reason: string) {
    super(reason.length > 900 ? `${reason.slice(0, 897)}...` : reason);
    this.name = 'AgentRequestRefused';
    this.missionId = missionId;
  }
}

const encoder = new TextEncoder();
const iso = (date: Date): string => `${date.toISOString().slice(0, 19)}Z`;
const EVIDENCE_TEXT_LIMIT = 2000;

async function planOf(tx: Queryable, env: Pick<ApiEnv, 'objects'>, missionId: string) {
  const { rows } = await tx.query<{ plan_digest: string }>(
    'SELECT plan_digest FROM evaluation_plans WHERE mission_id = $1',
    [missionId],
  );
  const digest = rows[0]?.plan_digest;
  return digest === undefined ? undefined : loadPlan(tx, env, digest);
}

/** The resolved scored sessions of a window: the sessions of the frozen calendar from its first to its last. */
function scoredSessions(manifest: DatasetManifest, start: string, end: string): string[] {
  return manifest.content.calendar
    .map((entry) => entry.session)
    .filter((session) => session >= start && session <= end)
    .sort();
}

/** The fixed context of both roles, from the mission's records. */
async function roleContext(tx: Queryable, env: ApiEnv, mission: MissionRow): Promise<RoleContext> {
  const refuse = (reason: string) => new AgentRequestRefused(mission.mission_id, reason);
  const policy = await loadPolicy(tx, env, mission.policy_id, mission.policy_revision);
  const profile = await loadProfile(tx, env, mission.profile_id, mission.profile_revision);
  if (policy === undefined || profile === undefined) throw refuse('The mission names a missing profile or policy.');
  const plan = await planOf(tx, env, mission.mission_id);
  if (plan === undefined) throw refuse('No evaluation plan is recorded: no agent request can name its windows.');
  const manifests = await tx.query<{ manifest_digest: string }>(
    'SELECT manifest_digest FROM dataset_manifests WHERE mission_id = $1',
    [mission.mission_id],
  );
  const manifestDigest = manifests.rows[0]?.manifest_digest;
  if (manifestDigest === undefined) throw refuse('No dataset snapshot is recorded for the mission.');
  const manifest = await loadDocument(env, 'dataset-manifest', manifestDigest);
  const development = plan.windows.find((window) => window.role === 'DEVELOPMENT');
  if (development === undefined) throw refuse('The plan has no development window.');
  // In S1 every agent request, proposer and critic, withholds V and H, with the sessions that the plan resolved.
  const holdoutExclusions = plan.windows
    .filter((window) => window.role !== 'DEVELOPMENT')
    .map((window) => ({
      window: window.role,
      range: { start: window.resolved.scored_start, end: window.resolved.scored_end },
      label: window.label,
      sessions: scoredSessions(manifest, window.resolved.scored_start, window.resolved.scored_end),
    }));
  return {
    scope: {
      instrument_id: mission.instrument_id,
      symbol: mission.symbol,
      provider: mission.provider,
      provider_asset_id: mission.provider_asset_id,
      effective_from: mission.instrument_effective_from,
    },
    cutoff: development.resolved.information_cutoff,
    operators: policy.document.conditions.operators,
    provider_capabilities: [...profile.document.provider.required_capabilities],
    evaluation_policy: policy.document,
    holdout_exclusions: holdoutExclusions,
  } as unknown as RoleContext;
}

async function registeredArtefact(tx: Queryable, env: ApiEnv, missionId: string, slot: string) {
  const { rows } = await tx.query<{ strategy_hash: string }>(
    `SELECT strategy_hash FROM trials WHERE mission_id = $1 AND trial_slot = $2 AND status = 'REGISTERED'`,
    [missionId, slot],
  );
  const hash = rows[0]?.strategy_hash;
  if (hash === undefined) return undefined;
  return { hash, strategy: (await loadDocument(env, 'strategy-artefact', hash)) as StrategyArtefact };
}

function bounded(text: string): string {
  return text.length > EVIDENCE_TEXT_LIMIT ? `${text.slice(0, EVIDENCE_TEXT_LIMIT - 3)}...` : text;
}

/**
 * The revision context of a proposer (OQ-03 section 1: development-window results and findings only): the metrics of
 * the seed's development runs, the seed's critic findings and the diagnostics of the earlier INVALID proposals of the
 * slot. The text is rendered from the records, never copied from a model, and names no date.
 */
async function proposerEvidence(
  tx: Queryable,
  env: ApiEnv,
  missionId: string,
  seedHash: string,
  slot: string,
): Promise<EvidenceItem[]> {
  const evidence: EvidenceItem[] = [];
  const runs = await tx.query<{ run_slot: string; status: string; metrics_digest: string | null; completed_at: Date }>(
    `SELECT r.run_slot, r.status, m.metrics_digest, r.completed_at FROM runs r LEFT JOIN metrics m ON m.run_id = r.run_id
      WHERE r.mission_id = $1 AND r.strategy_hash = $2 AND r.window_role = 'DEVELOPMENT' AND r.completed_at IS NOT NULL
      ORDER BY r.run_slot`,
    [missionId, seedHash],
  );
  for (const run of runs.rows) {
    if (run.metrics_digest === null) continue;
    const metrics = await loadDocument(env, 'evaluation-metrics', run.metrics_digest);
    const values = Object.entries(metrics.strategy as unknown as Record<string, unknown>)
      .filter(([, entry]) => typeof entry === 'object' && entry !== null && 'value' in entry)
      .map(([name, entry]) => `${name} ${String((entry as { value: unknown }).value)}`);
    evidence.push({
      id: `metrics-${run.run_slot}`.slice(0, 64),
      kind: 'evaluation_metrics',
      record_digest: run.metrics_digest,
      recorded_at: iso(run.completed_at),
      content: bounded(
        `Official metrics of the seed's development run ${run.run_slot} (${run.status}): ${values.join(', ')}.`,
      ),
    } as EvidenceItem);
  }
  const findings = await tx.query<{
    finding_id: string;
    critique_digest: string;
    ordinal: number;
    category: string;
    affects_executable_rule: boolean;
    recorded_at: Date;
  }>(
    `SELECT finding_id, critique_digest, ordinal, category, affects_executable_rule, recorded_at FROM findings
      WHERE mission_id = $1 AND strategy_hash = $2 ORDER BY critique_digest, ordinal`,
    [missionId, seedHash],
  );
  for (const finding of findings.rows) {
    evidence.push({
      id: finding.finding_id,
      kind: 'finding',
      record_digest: finding.critique_digest,
      recorded_at: iso(finding.recorded_at),
      content: bounded(
        `Critic finding ${finding.ordinal} on the seed: category ${finding.category}` +
          `${finding.affects_executable_rule ? ', it affects an executable rule' : ''}.`,
      ),
    } as EvidenceItem);
  }
  const invalid = await tx.query<{ proposal_ordinal: number; draft_digest: string; reason: string; created_at: Date }>(
    `SELECT proposal_ordinal, draft_digest, reason, created_at FROM trials
      WHERE mission_id = $1 AND trial_slot = $2 AND status = 'INVALID' ORDER BY proposal_ordinal`,
    [missionId, slot],
  );
  for (const trial of invalid.rows) {
    evidence.push({
      id: `diagnostics-${slot}-${trial.proposal_ordinal}`.slice(0, 64),
      kind: 'draft_diagnostics',
      record_digest: trial.draft_digest,
      recorded_at: iso(trial.created_at),
      content: bounded(`Proposal ${trial.proposal_ordinal} of this slot was not registered: ${trial.reason}`),
    } as EvidenceItem);
  }
  return evidence.slice(0, 64);
}

function refusalText(assembly: Assembly<unknown>): string {
  if (assembly.ok) return '';
  return assembly.refusals.map((refusal) => `${refusal.code}: ${refusal.detail}`).join('; ');
}

/** Assemble, store and wrap the role request of the first attempt of an agent run. */
async function assembleDispatch(context: BuildContext, work: Work, binding: Binding): Promise<Dispatch> {
  const { tx, env, actorId } = context;
  const mission = await findMission(tx, missionIdOf(work));
  if (mission === undefined) throw new Error(`The mission ${work.missionId} does not exist.`);
  const refuse = (reason: string) => new AgentRequestRefused(mission.mission_id, reason);
  if (work.agentRole === null || work.configurationId === null || work.trialSlot === null) {
    throw new Error(`The agent run ${work.id} names no role, configuration or trial slot.`);
  }
  if (env.agentExecutorVersion === undefined) {
    throw refuse('No pinned executor version is configured for this environment: no agent work is dispatched.');
  }
  const configuration = await tx.query<{ executor_model: string; executor_effort: string; bundle_hash: string }>(
    `SELECT executor_model, executor_effort, bundle_hash FROM mission_agent_configurations
      WHERE mission_id = $1 AND configuration_id = $2`,
    [mission.mission_id, work.configurationId],
  );
  const config = configuration.rows[0];
  if (config === undefined) throw new Error(`The mission has no configuration ${work.configurationId}.`);
  if (config.bundle_hash !== BUNDLE_HASH) {
    throw refuse(
      `The configuration ${work.configurationId} names the behaviour bundle ${config.bundle_hash}; this API assembles requests with ${BUNDLE_HASH}.`,
    );
  }
  const policy = await loadPolicy(tx, env, mission.policy_id, mission.policy_revision);
  if (policy === undefined) throw new Error(`The policy of mission ${mission.mission_id} is missing.`);
  const budget = await loadMissionBudget(tx, mission.mission_id);
  const context_ = await roleContext(tx, env, mission);
  const role = work.agentRole === 'CRITIC' ? 'critic' : 'proposer';
  let assembly: Awaited<ReturnType<typeof assembleCritiqueRequest | typeof assembleFormulationRequest>>;
  if (role === 'critic') {
    const subject = await registeredArtefact(tx, env, mission.mission_id, work.trialSlot);
    if (subject === undefined)
      throw refuse(`The slot ${work.trialSlot} has no registered Strategy Version to criticise.`);
    assembly = await assembleCritiqueRequest({
      context: context_,
      subject: { strategy_hash: subject.hash, strategy: subject.strategy, source_refs: [] } as never,
      evidence: [],
    });
  } else {
    const parentSlot = await tx.query<{ parent_slot: string | null }>(
      'SELECT parent_slot FROM trial_slots WHERE mission_id = $1 AND trial_slot = $2',
      [mission.mission_id, work.trialSlot],
    );
    const seedSlot = parentSlot.rows[0]?.parent_slot;
    const parent = seedSlot == null ? undefined : await registeredArtefact(tx, env, mission.mission_id, seedSlot);
    if (parent === undefined) throw refuse(`The slot ${work.trialSlot} has no registered parent to revise.`);
    assembly = await assembleFormulationRequest({
      context: context_,
      subject: { proposal_kind: 'controlled_revision', parent_hash: parent.hash, parent: parent.strategy } as never,
      evidence: await proposerEvidence(tx, env, mission.mission_id, parent.hash, work.trialSlot),
    });
  }
  if (!assembly.ok) throw refuse(`Request assembly refused the ${role} request: ${refusalText(assembly)}`);
  const stored = await storeBytes(tx, env, encoder.encode(assembly.text), actorId);
  const skill = skillForRole(role);
  const message = {
    schema_version: 'agent-dispatch/1',
    environment: env.environment,
    identity: {
      mission_id: mission.mission_id,
      run_id: work.id,
      attempt: { attempt_id: binding.attemptId, ownership_revision: binding.ownershipRevision },
      session_id: env.ids.next('sess'),
      role,
      skill: { id: skill.id, version: skill.version },
      bundle_hash: assembly.bundle_hash,
    },
    execution: {
      executor: {
        version: env.agentExecutorVersion,
        profile: { model: config.executor_model, effort: config.executor_effort },
      },
      bounds: {
        timeout_seconds: policy.document.limits.agent_timeout_seconds,
        output_limit_bytes: policy.document.limits.agent_output_limit_bytes,
        cost_reservation: { amount: budget.model_spend_per_attempt, currency: budget.currency },
      },
      tools: [],
      required_capabilities: [...skill.required_capabilities],
    },
    inputs: {
      request: { contract: skill.request_contract, artefact: stored },
      holdout_exclusions: assembly.request.context.holdout_exclusions,
    },
    result_route: `/v1/attempts/${binding.attemptId}/agent-result`,
  };
  const checked = validateContract('agent-dispatch', message);
  if (!checked.ok) throw new Error(`The API built an invalid agent-dispatch message: ${checked.error.message}`);
  return { destination: 'AGENT_RUNNER', message: message as Record<string, unknown> };
}

/**
 * The builder of agent work: the first attempt assembles its request, a retry repeats the message of the attempt
 * before it for its own attempt, session and result route.
 */
export const buildAgent: DispatchBuilder = (context, work, binding) =>
  binding.ownershipRevision > 1 ? retryAgent(context, work, binding) : assembleDispatch(context, work, binding);

// The messages of the dispatch outbox (OQ-05 section 4). The attempt, its reservation and its outbox row are written in
// one transaction, and the outbox message names its attempt. A builder turns the logical run or job and the binding of
// a new attempt into that message and stores the request document it references; a retry builds a new message for its
// new attempt from the same run or job, so a builder reads only recorded state.
//
// This part builds the two kinds that its commands create: the retrieve job of run_mission_now and the evaluate runs
// of the DRAFT to EVALUATING Decision and of freeze_candidates. The validate, assess and agent messages need inputs
// that the later parts record; a caller that creates such work supplies its own builder, and a retry of such work
// without one fails loudly instead of sending an empty message.

import type {
  ArtefactRef,
  CohortPolicy,
  EvaluationPlan,
  JobDispatch,
  ReleaseManifest,
  ResearchProfile,
} from '@openquant/api-contracts';
import { validateContract } from '@openquant/api-contracts';
import type { Queryable } from '../db/database.ts';
import type { ApiEnv } from '../env.ts';
import { ApiFailure } from '../errors.ts';
import { multiplyDecimal } from './decimal.ts';
import { currentRelease, loadPlan, loadPolicy, loadProfile } from './documents.ts';
import { reject } from './rejection.ts';
import { findMission, loadMissionBudget } from './rows.ts';
import { artefactRef, storeDocument } from './store.ts';
import type { DispatchKind, Work } from './work.ts';

export interface Binding {
  readonly attemptId: string;
  readonly ownershipRevision: number;
}

export interface Dispatch {
  readonly destination: 'BATCH_QUEUE' | 'AGENT_RUNNER';
  readonly message: Record<string, unknown>;
}

export interface BuildContext {
  readonly tx: Queryable;
  readonly env: ApiEnv;
  /** The principal that the stored request documents are recorded under. */
  readonly actorId: string;
}

export type DispatchBuilder = (context: BuildContext, work: Work, binding: Binding) => Promise<Dispatch>;
export type DispatchBuilders = Partial<Record<DispatchKind, DispatchBuilder>>;

// The contracts give a retrieval request limits that neither the research profile nor the cohort policy carries
// (retrieval-request/1: max_retries and request_timeout_seconds). Until a registered record holds them, the API sets
// them here, the same for every mission. max_requests and max_response_bytes follow from the budget and the policy.
export const RETRIEVAL_MAX_RETRIES = 2;
export const RETRIEVAL_REQUEST_TIMEOUT_SECONDS = 30;
/** The dataset operations of a mission's retrieval. The probe-only capabilities of a profile are not retrieved. */
export const DATASET_OPERATIONS: readonly string[] = ['daily_bars', 'corporate_actions', 'calendar'];

/** The most provider requests that one retrieval attempt may make: the mission's budget over its attempt cap. */
export function retrievalRequestCap(providerRequests: string | number, attemptCap: number): number {
  return Math.floor(Number(providerRequests) / attemptCap);
}

/** UTC instant at which the wall clock of `timeZone` shows `hour:minute` on `date` (YYYY-MM-DD). */
export function zonedInstant(date: string, hour: number, minute: number, timeZone: string): Date {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  const offsetMinutes = (at: number): number => {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).formatToParts(new Date(at));
    const part = (type: string): number => Number(parts.find((entry) => entry.type === type)?.value);
    const asUtc = Date.UTC(part('year'), part('month') - 1, part('day'), part('hour'), part('minute'), part('second'));
    return (asUtc - at) / 60000;
  };
  let guess = wall - offsetMinutes(wall) * 60000;
  guess = wall - offsetMinutes(guess) * 60000;
  return new Date(guess);
}

function timestamp(date: Date): string {
  return `${date.toISOString().slice(0, 19)}Z`;
}

/**
 * The information cutoff of a retrieval: the availability time of the last scored bar (research profile rule
 * FINAL_SCORED_BAR_AVAILABILITY), taken from the last window rule of the cohort policy. The retrieved calendar does not
 * exist yet, so the bar is taken to close at 16:00 New York time on the last date: an early close makes the real
 * cutoff earlier, never later, so the bound only ever admits what the profile allows.
 */
export function retrievalCutoff(policy: CohortPolicy, profile: ResearchProfile): string {
  const lastEnd = policy.conditions.windows.windows
    .map((window) => window.scored.end)
    .sort()
    .at(-1) as string;
  const close = zonedInstant(lastEnd, 16, 0, profile.market.timezone);
  return timestamp(new Date(close.getTime() + profile.data.bar_availability.delay_minutes * 60000));
}

function assertValid(contract: 'job-dispatch', message: unknown): JobDispatch {
  const checked = validateContract(contract, message);
  if (!checked.ok) throw new Error(`The API built an invalid ${contract} message: ${checked.error.message}`);
  return checked.value;
}

export const buildRetrieve: DispatchBuilder = async ({ tx, env, actorId }, work, binding) => {
  const mission = await findMission(tx, work.missionId);
  if (mission === undefined) throw new Error(`The mission ${work.missionId} does not exist.`);
  const profile = await loadProfile(tx, env, mission.profile_id, mission.profile_revision);
  const policy = await loadPolicy(tx, env, mission.policy_id, mission.policy_revision);
  if (profile === undefined || policy === undefined) throw new Error('The mission names a missing profile or policy.');
  const budget = await loadMissionBudget(tx, mission.mission_id);
  const operations = profile.document.provider.required_capabilities.filter((capability) =>
    DATASET_OPERATIONS.includes(/^provider:[^/]+\/([a-z_]+)@/.exec(capability)?.[1] ?? ''),
  );
  if (operations.length === 0) throw new Error('The profile names no dataset operation to retrieve.');
  const now = env.clock();
  const stored = await storeDocument(
    tx,
    env,
    'retrieval-request',
    {
      schema_version: 'retrieval-request/1',
      job_id: work.id,
      attempt: { attempt_id: binding.attemptId, ownership_revision: binding.ownershipRevision },
      environment: env.environment,
      profile: { id: profile.id, revision: profile.revision, digest: profile.digest },
      instrument: {
        instrument_id: mission.instrument_id,
        symbol: mission.symbol,
        provider: mission.provider,
        provider_asset_id: mission.provider_asset_id,
        effective_from: mission.instrument_effective_from,
      },
      operations,
      range: profile.document.history,
      information_cutoff: retrievalCutoff(policy.document, profile.document),
      semantics: profile.document.data,
      limits: {
        max_requests: retrievalRequestCap(budget.provider_requests, budget.attempt_cap),
        max_retries: RETRIEVAL_MAX_RETRIES,
        request_timeout_seconds: RETRIEVAL_REQUEST_TIMEOUT_SECONDS,
        max_response_bytes: policy.document.limits.artefact_limit_bytes,
      },
      deadline: timestamp(new Date(now.getTime() + policy.document.limits.job_timeouts.retrieve_seconds * 1000)),
    },
    actorId,
  );
  return {
    destination: 'BATCH_QUEUE',
    message: assertValid('job-dispatch', {
      schema_version: 'job-dispatch/1',
      environment: env.environment,
      job_id: work.id,
      attempt: { attempt_id: binding.attemptId, ownership_revision: binding.ownershipRevision },
      mission_id: mission.mission_id,
      dispatched_at: timestamp(now),
      inputs: { kind: 'retrieve', request: stored.ref },
    }) as unknown as Record<string, unknown>,
  };
};

/** The execution policy of a cost scenario: the base policy, or the base with the stress components multiplied. */
export function scenarioPolicy(policy: CohortPolicy, scenario: 'BASE' | 'COST_STRESS') {
  const base = policy.conditions.execution_policy;
  if (scenario === 'BASE') return base;
  const { multiplier, components } = policy.conditions.cost_stress;
  const costModel = { ...base.cost_model };
  for (const component of components) costModel[component] = multiplyDecimal(costModel[component], multiplier);
  return { ...base, cost_model: costModel };
}

/**
 * The windows that an evaluation request withholds. The holdout stays withheld from every run that does not evaluate
 * it, and from no run that does (OQ-02 section 3.3); the fixtures of the protocol manifest do the same.
 */
export function holdoutExclusions(plan: EvaluationPlan, role: 'DEVELOPMENT' | 'VALIDATION' | 'HOLDOUT') {
  if (role === 'HOLDOUT') return [];
  return plan.windows
    .filter((window) => window.role === 'HOLDOUT')
    .map((window) => ({
      window: window.role,
      range: { start: window.resolved.scored_start, end: window.resolved.scored_end },
      label: window.label,
    }));
}

async function requireRef(tx: Queryable, digest: string, what: string): Promise<ArtefactRef> {
  const ref = await artefactRef(tx, digest);
  if (ref === undefined) throw reject('POLICY_VIOLATION', `The ${what} ${digest} is not a recorded artefact.`);
  return ref;
}

export const buildEvaluate: DispatchBuilder = async ({ tx, env, actorId }, work, binding) => {
  if (
    work.kind !== 'run' ||
    work.runSlot === null ||
    work.trialSlot === null ||
    work.windowRole === null ||
    work.costScenario === null ||
    work.planDigest === null ||
    work.strategyHash === null
  ) {
    throw new Error(`The work ${work.id} is not a planned backtest run.`);
  }
  const mission = await findMission(tx, work.missionId);
  if (mission === undefined) throw new Error(`The mission ${work.missionId} does not exist.`);
  const profile = await loadProfile(tx, env, mission.profile_id, mission.profile_revision);
  const policy = await loadPolicy(tx, env, mission.policy_id, mission.policy_revision);
  if (profile === undefined || policy === undefined) throw new Error('The mission names a missing profile or policy.');
  const release = (await currentRelease(tx, env.environment)) as ReleaseManifest | undefined;
  if (release === undefined) {
    throw new ApiFailure(
      'EXECUTION_DISABLED',
      `No release identity is recorded for ${env.environment}: an evaluation request needs the required engine and method.`,
    );
  }
  const plan = await loadPlan(tx, env, work.planDigest);
  const window = plan.windows.find((entry) => entry.role === work.windowRole);
  if (window === undefined) throw new Error(`The plan ${work.planDigest} has no ${work.windowRole} window.`);
  const manifest = await tx.query<{ manifest_digest: string }>(
    'SELECT manifest_digest FROM dataset_manifests WHERE mission_id = $1',
    [mission.mission_id],
  );
  const manifestDigest = manifest.rows[0]?.manifest_digest;
  if (manifestDigest === undefined) {
    throw reject('POLICY_VIOLATION', 'No dataset snapshot is recorded for the mission, so no run can be requested.');
  }
  const version = await tx.query<{ strategy_id: string; version: number }>(
    'SELECT strategy_id, version FROM strategy_versions WHERE strategy_hash = $1',
    [work.strategyHash],
  );
  const versionRow = version.rows[0];
  if (versionRow === undefined) throw new Error(`The strategy ${work.strategyHash} is not registered.`);
  const conditions = {
    profile: { id: profile.id, revision: profile.revision, digest: profile.digest },
    cohort_policy: { id: policy.id, revision: policy.revision, digest: policy.digest },
    suite_id: policy.document.suite_id,
    plan_digest: work.planDigest,
    trial_slot: work.trialSlot,
    run_slot: work.runSlot,
    window_role: work.windowRole,
    cost_scenario: work.costScenario,
    ...(work.repeatOfRun === null ? {} : { replay_of: work.repeatOfRun }),
  };
  const stored = await storeDocument(
    tx,
    env,
    'evaluation-request',
    {
      schema_version: 'evaluation-request/1',
      run_id: work.id,
      attempt: { attempt_id: binding.attemptId, ownership_revision: binding.ownershipRevision },
      mission_id: mission.mission_id,
      mode: 'BACKTEST',
      environment: env.environment,
      engine: release.engine,
      method: release.method,
      strategy: {
        strategy_id: versionRow.strategy_id,
        version: versionRow.version,
        artefact: await requireRef(tx, work.strategyHash, 'strategy'),
      },
      conditions,
      input: {
        source: 'PROVIDER_MANIFEST',
        manifest: await requireRef(tx, manifestDigest, 'dataset manifest'),
        windows: window.resolved,
        initial_capital: policy.document.conditions.initial_capital,
        policy: scenarioPolicy(policy.document, work.costScenario),
        // The evaluator is deterministic and reads no random seed. The contracts require the field, so it is fixed.
        seed: 0,
      },
      holdout_exclusions: holdoutExclusions(plan, work.windowRole),
    },
    actorId,
  );
  return {
    destination: 'BATCH_QUEUE',
    message: assertValid('job-dispatch', {
      schema_version: 'job-dispatch/1',
      environment: env.environment,
      job_id: work.id,
      attempt: { attempt_id: binding.attemptId, ownership_revision: binding.ownershipRevision },
      mission_id: mission.mission_id,
      dispatched_at: timestamp(env.clock()),
      inputs: { kind: 'evaluate', request: stored.ref },
    }) as unknown as Record<string, unknown>,
  };
};

export const defaultBuilders: DispatchBuilders = { retrieve: buildRetrieve, evaluate: buildEvaluate };

export function builderFor(builders: DispatchBuilders, work: Work): DispatchBuilder {
  const builder = builders[work.dispatchKind];
  if (builder === undefined) {
    throw new Error(`This part builds no dispatch message for ${work.dispatchKind} work: ${work.id}.`);
  }
  return builder;
}

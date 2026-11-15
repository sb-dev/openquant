// The evaluation plan (OQ-02 sections 3.1 and 3.3, decision D20). The API records it once, when the mission's retrieval
// is accepted: after retrieval, before any validation or run, and it never changes. The plan resolves the window rules
// of the cohort policy against the calendar of the frozen dataset manifest, lists the trial slots and every planned run
// slot, and records the scenarios. A planned slot is not a run: runs, reservations and outbox entries come later, from
// the Decision (development and validation) and from freeze_candidates (holdout).
//
// resolveWindows and buildPlan are pure, so a test derives the expected plan from the manifest by hand.

import type {
  ArtefactRef,
  CalendarSession,
  CohortPolicy,
  DatasetManifest,
  EvaluationPlan,
  RecordRef,
  ResolvedWindow,
  RunSlot,
  TrialSlot,
} from '@openquant/api-contracts';
import type { Queryable } from '../db/database.ts';
import type { ApiEnv } from '../env.ts';
import { loadPolicy, loadProfile } from './documents.ts';
import type { MissionRow } from './rows.ts';
import { storeDocument } from './store.ts';

export type WindowResolution =
  | { readonly ok: true; readonly windows: ResolvedWindow[] }
  | { readonly ok: false; readonly reason: string };

function timestamp(milliseconds: number): string {
  return `${new Date(milliseconds).toISOString().slice(0, 19)}Z`;
}

/** The availability of a bar under the profile rule SESSION_CLOSE_PLUS_DELAY: the close of its session plus the delay. */
export function barAvailability(session: CalendarSession, delayMinutes: number): string {
  return timestamp(Date.parse(session.close_at) + delayMinutes * 60_000);
}

/**
 * Resolve the window rules against the calendar. Each window gets its first and last scored session, the session that
 * starts its warm-up, the information cutoff (the availability of its last scored bar, research profile rule
 * FINAL_SCORED_BAR_AVAILABILITY) and the number of sessions of its run. A window that cannot be resolved, whose data
 * is missing or whose run exceeds the policy's session limit is a reason, not a guess: the mission is blocked with it.
 */
export function resolveWindows(policy: CohortPolicy, manifest: DatasetManifest): WindowResolution {
  const calendar = [...manifest.content.calendar].sort((a, b) => (a.session < b.session ? -1 : 1));
  const index = new Map(calendar.map((entry, position) => [entry.session, position]));
  const bars = new Map(manifest.content.bars.map((bar) => [bar.session, bar]));
  const missing = new Set(manifest.coverage.missing_sessions);
  const { warmup_sessions: warmup, max_sessions: maxSessions } = policy.conditions.windows;
  const windows: ResolvedWindow[] = [];
  for (const rule of policy.conditions.windows.windows) {
    const inside = calendar.filter((entry) => entry.session >= rule.scored.start && entry.session <= rule.scored.end);
    const first = inside[0];
    const last = inside.at(-1);
    if (first === undefined || last === undefined) {
      return {
        ok: false,
        reason: `The calendar has no session in the ${rule.role} window ${rule.scored.start} to ${rule.scored.end}.`,
      };
    }
    const firstIndex = index.get(first.session) as number;
    const lastIndex = index.get(last.session) as number;
    if (firstIndex < warmup) {
      return {
        ok: false,
        reason: `The calendar has fewer than ${warmup} sessions before the ${rule.role} window: its warm-up cannot start.`,
      };
    }
    const warmupStart = (calendar[firstIndex - warmup] as CalendarSession).session;
    for (let position = firstIndex - warmup; position <= lastIndex; position += 1) {
      const session = (calendar[position] as CalendarSession).session;
      if (missing.has(session) || !bars.has(session)) {
        return {
          ok: false,
          reason: `The retrieved data has no bar for the session ${session}, which the ${rule.role} run needs.`,
        };
      }
    }
    // The cutoff is the availability that the retrieved bar states; retrieval acceptance has checked it against the rule.
    const cutoff = (bars.get(last.session) as { available_at: string }).available_at;
    const paymentSessions = new Set<string>();
    for (const action of manifest.content.corporate_actions) {
      if (action.kind !== 'CASH_DIVIDEND') continue;
      if (action.effective_session < warmupStart || action.effective_session > last.session) continue;
      if (action.payment_session > last.session) paymentSessions.add(action.payment_session);
    }
    for (const session of paymentSessions) {
      if (!index.has(session)) {
        return {
          ok: false,
          reason: `The dividend payment session ${session} is not a session of the retrieved calendar.`,
        };
      }
    }
    const runSessions = lastIndex - (firstIndex - warmup) + 1 + paymentSessions.size;
    if (runSessions > maxSessions) {
      return {
        ok: false,
        reason: `The ${rule.role} run needs ${runSessions} sessions, above the limit of ${maxSessions}.`,
      };
    }
    windows.push({
      role: rule.role,
      rule: { start: rule.scored.start, end: rule.scored.end },
      label: rule.label,
      resolved: {
        warmup_start: warmupStart,
        scored_start: first.session,
        scored_end: last.session,
        information_cutoff: cutoff,
      },
      run_sessions: runSessions,
    });
  }
  return { ok: true, windows };
}

const WINDOW_CODE: Readonly<Record<'DEVELOPMENT' | 'VALIDATION' | 'HOLDOUT', string>> = {
  DEVELOPMENT: 'd',
  VALIDATION: 'v',
  HOLDOUT: 'h',
};
const COST_CODE: Readonly<Record<'BASE' | 'COST_STRESS', string>> = { BASE: 'base', COST_STRESS: 'stress' };

/** `rev-` and the configuration ID, without a leading `proposer-`; an ID that would not fit gets its ordinal. */
export function revisionSlotId(configurationId: string, ordinal: number, taken: ReadonlySet<string>): string {
  const candidate = `rev-${configurationId.replace(/^proposer-/, '')}`;
  return candidate.length <= 64 && !taken.has(candidate) ? candidate : `rev-${ordinal}`;
}

export interface PlanInputs {
  readonly missionId: string;
  readonly profile: RecordRef;
  readonly policy: RecordRef;
  readonly policyDocument: CohortPolicy;
  readonly calendar: ArtefactRef;
  readonly windows: readonly ResolvedWindow[];
  readonly seed: { readonly strategyId: string; readonly draftDigest: string };
  /** The proposer configurations of the mission, each with its slot for one controlled revision. */
  readonly proposers: readonly string[];
}

export function buildPlan(input: PlanInputs): EvaluationPlan {
  const taken = new Set<string>(['seed']);
  const trialSlots: TrialSlot[] = [
    { slot_id: 'seed', kind: 'seed', strategy_id: input.seed.strategyId, draft_digest: input.seed.draftDigest },
  ];
  [...input.proposers].sort().forEach((configurationId, position) => {
    const slotId = revisionSlotId(configurationId, position + 1, taken);
    taken.add(slotId);
    trialSlots.push({ slot_id: slotId, kind: 'revision', configuration_id: configurationId, parent_slot: 'seed' });
  });
  const stress = input.policyDocument.conditions.cost_stress.multiplier;
  const repeat = { window_role: 'DEVELOPMENT' as const, cost_scenario: 'BASE' as const };
  const runSlots: RunSlot[] = [];
  for (const slot of trialSlots) {
    for (const window of input.windows) {
      for (const scenario of ['BASE', 'COST_STRESS'] as const) {
        const id = `${slot.slot_id}.${WINDOW_CODE[window.role]}.${COST_CODE[scenario]}`;
        const writtenBy = window.role === 'HOLDOUT' ? 'FREEZE_CANDIDATES' : 'EVALUATING_DECISION';
        runSlots.push({
          run_slot_id: id,
          trial_slot: slot.slot_id,
          window_role: window.role,
          cost_scenario: scenario,
          written_by: writtenBy,
        });
        if (window.role === repeat.window_role && scenario === repeat.cost_scenario) {
          runSlots.push({
            run_slot_id: `${id}.repeat`,
            trial_slot: slot.slot_id,
            window_role: window.role,
            cost_scenario: scenario,
            written_by: writtenBy,
            replay_of: id,
          });
        }
      }
    }
  }
  return {
    schema_version: 'evaluation-plan/1',
    plan_id: `plan-${input.missionId}`.slice(0, 64),
    mission_id: input.missionId,
    profile: input.profile,
    cohort_policy: input.policy,
    suite_id: input.policyDocument.suite_id,
    calendar: input.calendar,
    windows: [...input.windows],
    trial_slots: trialSlots,
    scenarios: {
      cost_cases: [
        { cost_scenario: 'BASE', multiplier: '1' },
        { cost_scenario: 'COST_STRESS', multiplier: stress },
      ],
      deterministic_repeat: repeat,
    },
    run_slots: runSlots,
  };
}

export type PlanRecord =
  | { readonly ok: true; readonly planDigest: string }
  | { readonly ok: false; readonly reason: string };

/**
 * Record the plan of a mission from its frozen dataset manifest, with its comparison, trial slots and run slots, in the
 * caller's transaction. The plan is recorded once: a second call finds it and says so.
 */
export async function recordPlan(
  tx: Queryable,
  env: ApiEnv,
  mission: MissionRow,
  manifest: DatasetManifest,
  manifestRef: ArtefactRef,
  actorId: string,
): Promise<PlanRecord> {
  const existing = await tx.query<{ plan_digest: string }>(
    'SELECT plan_digest FROM evaluation_plans WHERE mission_id = $1',
    [mission.mission_id],
  );
  if (existing.rows[0] !== undefined) return { ok: true, planDigest: existing.rows[0].plan_digest };
  const profile = await loadProfile(tx, env, mission.profile_id, mission.profile_revision);
  const policy = await loadPolicy(tx, env, mission.policy_id, mission.policy_revision);
  if (profile === undefined || policy === undefined) throw new Error('The mission names a missing profile or policy.');
  const resolution = resolveWindows(policy.document, manifest);
  if (!resolution.ok) return resolution;
  const seed = await tx.query<{ strategy_id: string }>('SELECT strategy_id FROM seed_drafts WHERE draft_digest = $1', [
    mission.seed_draft_digest,
  ]);
  const proposers = await tx.query<{ configuration_id: string }>(
    `SELECT configuration_id FROM mission_agent_configurations WHERE mission_id = $1 AND role = 'PROPOSER'`,
    [mission.mission_id],
  );
  const plan = buildPlan({
    missionId: mission.mission_id,
    profile: { id: profile.id, revision: profile.revision, digest: profile.digest },
    policy: { id: policy.id, revision: policy.revision, digest: policy.digest },
    policyDocument: policy.document,
    calendar: manifestRef,
    windows: resolution.windows,
    seed: { strategyId: (seed.rows[0] as { strategy_id: string }).strategy_id, draftDigest: mission.seed_draft_digest },
    proposers: proposers.rows.map((row) => row.configuration_id),
  });
  const stored = await storeDocument(tx, env, 'evaluation-plan', plan, actorId);
  const planDigest = stored.ref.digest;
  const byRole = Object.fromEntries(plan.windows.map((window) => [window.role, window.resolved]));
  const [development, validation, holdout] = [byRole.DEVELOPMENT, byRole.VALIDATION, byRole.HOLDOUT];
  if (development === undefined || validation === undefined || holdout === undefined) {
    return { ok: false, reason: 'The cohort policy does not declare the three windows D, V and H.' };
  }
  await tx.query(
    `INSERT INTO evaluation_plans (plan_digest, plan_id, mission_id, profile_id, profile_revision, policy_id,
       policy_revision, suite_id, calendar_digest, warmup_sessions, d_start, d_end, v_start, v_end, h_start, h_end,
       recorded_by, recorded_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)`,
    [
      planDigest,
      plan.plan_id,
      mission.mission_id,
      profile.id,
      profile.revision,
      policy.id,
      policy.revision,
      plan.suite_id,
      manifestRef.digest,
      policy.document.conditions.windows.warmup_sessions,
      development.scored_start,
      development.scored_end,
      validation.scored_start,
      validation.scored_end,
      holdout.scored_start,
      holdout.scored_end,
      actorId,
      env.clock(),
    ],
  );
  await tx.query(
    `INSERT INTO comparisons (plan_digest, cost_stress_multiplier, repeat_window_role, repeat_cost_scenario)
     VALUES ($1, $2, $3, $4)`,
    [
      planDigest,
      policy.document.conditions.cost_stress.multiplier,
      plan.scenarios.deterministic_repeat.window_role,
      plan.scenarios.deterministic_repeat.cost_scenario,
    ],
  );
  for (const slot of plan.trial_slots) {
    if (slot.kind === 'seed') {
      await tx.query(
        `INSERT INTO trial_slots (mission_id, trial_slot, plan_digest, slot_kind, strategy_id, draft_digest)
         VALUES ($1, $2, $3, 'SEED', $4, $5)`,
        [mission.mission_id, slot.slot_id, planDigest, slot.strategy_id, slot.draft_digest],
      );
    } else {
      await tx.query(
        `INSERT INTO trial_slots (mission_id, trial_slot, plan_digest, slot_kind, parent_slot, configuration_id)
         VALUES ($1, $2, $3, 'REVISION', $4, $5)`,
        [mission.mission_id, slot.slot_id, planDigest, slot.parent_slot, slot.configuration_id],
      );
    }
  }
  // A repeat names the slot that it repeats, so the originals go first.
  const ordered = [...plan.run_slots].sort(
    (a, b) => Number(a.replay_of !== undefined) - Number(b.replay_of !== undefined),
  );
  for (const slot of ordered) {
    await tx.query(
      `INSERT INTO run_slots (mission_id, run_slot, trial_slot, window_role, cost_scenario, written_by, replay_of)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        mission.mission_id,
        slot.run_slot_id,
        slot.trial_slot,
        slot.window_role,
        slot.cost_scenario,
        slot.written_by,
        slot.replay_of ?? null,
      ],
    );
  }
  return { ok: true, planDigest };
}

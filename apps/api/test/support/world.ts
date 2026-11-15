// A world for the tests of the guarded commands: a fresh database, the four people and the workflows service principal,
// and helpers that build the records of the S1 pilot step by step through the real command runner, from the shared
// fixtures of the protocol manifest (synthetic documents). What a later part writes (the evaluation plan after the
// retrieval, the dataset manifest, the registered strategy versions, the critique results) the helpers write with SQL,
// the way the later part will, so that each test starts from a state that the system can reach.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJson, digest, type RecordRef } from '@openquant/api-contracts';
import { type CommandOutcome, executeCommand } from '../../src/commands/runner.ts';
import type { Database, Queryable } from '../../src/db/database.ts';
import type { WorkContext } from '../../src/domain/attempts.ts';
import { type DispatchBuilders, defaultBuilders } from '../../src/domain/dispatch.ts';
import type { Actor } from '../../src/domain/rows.ts';
import { createTestApp, type TestApp, type TestAppOptions } from './app.ts';
import { ids, seedPrincipals, sha } from './seed.ts';

const root = resolve(fileURLToPath(import.meta.url), '../../../../..');

// biome-ignore lint/suspicious/noExplicitAny: tests edit fixture documents by path.
export type Doc = Record<string, any>;

export function fixture(name: string): Doc {
  return JSON.parse(readFileSync(resolve(root, 'fixtures/protocol/valid', name), 'utf8')) as Doc;
}

export type ActorName = 'steward' | 'researcher' | 'viewer' | 'admin' | 'workflows' | 'batch' | 'runner' | 'deploy';

const roleOf: Partial<Record<ActorName, Actor['roles']>> = {
  steward: ['Steward'],
  researcher: ['Researcher'],
  viewer: ['Viewer'],
  admin: ['Administrator'],
};
const principalOf: Record<ActorName, string> = {
  steward: ids.steward,
  researcher: ids.researcher,
  viewer: ids.viewer,
  admin: ids.admin,
  workflows: ids.workflows,
  batch: ids.batch,
  runner: ids.runner,
  deploy: ids.deploy,
};

export function actorOf(name: ActorName): Actor {
  const service = ['workflows', 'batch', 'runner', 'deploy'].includes(name);
  return {
    principalId: principalOf[name],
    kind: service ? 'SERVICE' : 'HUMAN',
    serviceKind: service ? (name as 'workflows') : null,
    roles: roleOf[name] ?? [],
  };
}

/** A stand-in for the dispatch of an agent attempt, which a later part builds. */
export const testAgentBuilder = async (
  _context: unknown,
  work: { id: string },
  binding: { attemptId: string; ownershipRevision: number },
) => ({
  destination: 'AGENT_RUNNER' as const,
  message: { schema_version: 'agent-dispatch/1', test_stand_in: true, job_id: work.id, attempt: binding.attemptId },
});

export interface World {
  readonly testApp: TestApp;
  readonly builders: DispatchBuilders;
  /** Ids of the registered records. */
  readonly records: {
    profile: RecordRef;
    policy: RecordRef;
    seedDigest: string;
    budgetId: string;
    missionId?: string;
    planDigest?: string;
    approvalId?: string;
  };
  /** The registered documents, as the commands carried them. */
  readonly docs: { profile: Doc; policy: Doc; budget: Doc; seed: Doc; plan?: Doc };
  command(payload: Doc, options?: { expectedRevision?: number; commandId?: string }): Doc;
  apply(
    who: ActorName,
    payload: Doc,
    options?: { expectedRevision?: number; commandId?: string },
  ): Promise<CommandOutcome>;
  /** Apply a command request that is already built, as its principal, on a connection of its own. */
  execute(who: ActorName | Actor, request: Doc): Promise<CommandOutcome>;
  /** Run a function in one transaction. */
  tx<T>(work: (tx: Queryable) => Promise<T>): Promise<T>;
  work(actorId?: string): WorkContext;
  /** One row-text digest per table (apart from the commands), for the test that nothing remains of a failed command. */
  snapshot(ignore?: readonly string[]): Promise<Record<string, string>>;
  sql<R extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<R[]>;
  drop(): Promise<void>;
}

export interface WorldOptions extends TestAppOptions {
  /** Edit the cohort policy before it is registered. */
  readonly policy?: (policy: Doc) => void;
  readonly builders?: DispatchBuilders;
}

let commandCounter = 0;

export async function createWorld(options: WorldOptions = {}): Promise<World> {
  const testApp = await createTestApp(options);
  await testApp.database.db.transaction(async (tx) => {
    await seedPrincipals(tx);
  });
  const profile = fixture('research-profile.aapl-sip-daily.json');
  const policy = fixture('cohort-policy.s1-pilot.json');
  const profileRef: RecordRef = { id: profile.profile_id, revision: profile.revision, digest: await digest(profile) };
  policy.profile = profileRef;
  options.policy?.(policy);
  const policyRef: RecordRef = { id: policy.policy_id, revision: policy.revision, digest: await digest(policy) };
  const budget = fixture('command.register-budget.json').payload.budget;
  const seed = fixture('command.register-seed.json').payload;
  const builders: DispatchBuilders = { ...defaultBuilders, agent: testAgentBuilder as never, ...options.builders };

  const world: World = {
    testApp,
    builders,
    records: {
      profile: profileRef,
      policy: policyRef,
      seedDigest: await digest(seed.draft),
      budgetId: budget.budget_id,
    },
    docs: { profile, policy, budget, seed },
    command(payload, opts = {}) {
      commandCounter += 1;
      return {
        schema_version: 'command/1',
        form: 'request',
        command_id: opts.commandId ?? `cmd-test-${commandCounter}`,
        expected_revision: opts.expectedRevision ?? 0,
        issued_at: '2026-11-15T10:00:00Z',
        payload,
      };
    },
    async apply(who, payload, opts) {
      const db: Database = testApp.env.database();
      try {
        return await executeCommand(
          { env: testApp.env, db, actor: actorOf(who), builders },
          world.command(payload, opts) as never,
        );
      } finally {
        await db.close();
      }
    },
    async execute(who, request) {
      const db: Database = testApp.env.database();
      try {
        const actor = typeof who === 'string' ? actorOf(who) : who;
        return await executeCommand({ env: testApp.env, db, actor, builders }, request as never);
      } finally {
        await db.close();
      }
    },
    async tx(work) {
      const db = testApp.env.database();
      try {
        return await db.transaction(work);
      } finally {
        await db.close();
      }
    },
    work(actorId = ids.workflows) {
      return { env: testApp.env, actorId, builders };
    },
    async snapshot(ignore = []) {
      const tables = await testApp.database.sql<{ tablename: string }>(
        `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> ALL($1::text[]) ORDER BY tablename`,
        [['commands', 'schema_migrations', ...ignore]],
      );
      const out: Record<string, string> = {};
      for (const { tablename } of tables) {
        const rows = await testApp.database.sql<{ digest: string }>(
          `SELECT md5(COALESCE(string_agg(t::text, '|' ORDER BY t::text), '')) AS digest FROM ${tablename} t`,
        );
        out[tablename] = rows[0]?.digest ?? '';
      }
      return out;
    },
    sql: (text, values) => testApp.database.sql(text, values),
    drop: () => testApp.drop(),
  };
  return world;
}

function applied(outcome: CommandOutcome, what: string): { id: string; revision: number } {
  if (outcome.state !== 'APPLIED') {
    const detail =
      outcome.state === 'REJECTED' ? `${outcome.status.error.code}: ${outcome.status.error.message}` : 'pending';
    throw new Error(`${what} was not applied: ${detail}`);
  }
  return outcome.status.record;
}

/** Steward and Researcher registrations of the pilot: budget, profile, policy, seed. */
export async function registerRecords(world: World): Promise<void> {
  applied(await world.apply('steward', { kind: 'register_budget', budget: world.docs.budget }), 'the budget');
  applied(
    await world.apply('steward', { kind: 'register_research_profile', profile: world.docs.profile }),
    'the profile',
  );
  applied(await world.apply('steward', { kind: 'register_cohort_policy', policy: world.docs.policy }), 'the policy');
  applied(await world.apply('researcher', { kind: 'register_seed', ...world.docs.seed }), 'the seed');
  const approval = await world.sql<{ decision_id: string }>(
    `SELECT decision_id FROM decisions WHERE kind = 'POLICY_APPROVAL'`,
  );
  world.records.approvalId = approval[0]?.decision_id as string;
}

/** The create_mission payload of the pilot, bound to the registered records. */
export function missionPayload(world: World, edit?: (mission: Doc) => void): Doc {
  const mission = structuredClone(fixture('command.create-mission.json').payload.mission) as Doc;
  mission.profile = structuredClone(world.records.profile);
  mission.cohort_policy = structuredClone(world.records.policy);
  mission.seed_draft_digest = world.records.seedDigest;
  edit?.(mission);
  return { kind: 'create_mission', mission };
}

export async function createMission(world: World, edit?: (mission: Doc) => void): Promise<string> {
  const record = applied(await world.apply('researcher', missionPayload(world, edit)), 'the mission');
  world.records.missionId = record.id;
  return record.id;
}

/** Start the mission (run_mission_now): it becomes IN_PROGRESS and its retrieve job has its first attempt. */
export async function startMission(world: World): Promise<{ revision: number; jobId: string; attemptId: string }> {
  const missionId = world.records.missionId as string;
  const current = await world.sql<{ revision: number }>('SELECT revision FROM missions WHERE mission_id = $1', [
    missionId,
  ]);
  const record = applied(
    await world.apply(
      'researcher',
      { kind: 'run_mission_now', mission_id: missionId },
      { expectedRevision: current[0]?.revision as number },
    ),
    'run_mission_now',
  );
  const job = await world.sql<{ job_id: string; attempt_id: string }>(
    `SELECT j.job_id, a.attempt_id FROM jobs j JOIN attempts a ON a.job_id = j.job_id WHERE j.mission_id = $1 AND j.kind = 'retrieve'`,
    [missionId],
  );
  return { revision: record.revision, jobId: job[0]?.job_id as string, attemptId: job[0]?.attempt_id as string };
}

async function artefactRow(tx: Queryable, digestText: string, size = 100): Promise<void> {
  await tx.query(
    `INSERT INTO artefacts (digest, media_type, size_bytes, stored_at, uploaded_by)
     VALUES ($1, 'application/json', $2, $3, $4) ON CONFLICT DO NOTHING`,
    [digestText, size, '2026-11-15T10:00:00Z', ids.workflows],
  );
}

export interface PlannedWorld {
  readonly missionId: string;
  readonly planDigest: string;
  readonly retrieveJobId: string;
}

/**
 * What the retrieval result of a later part writes when the dataset is frozen: the dataset manifest, the evaluation
 * plan of the fixture bound to this mission and its records, and the plan's slots. The retrieve job and its attempt
 * must have ended; the helper completes them, with the usage of one provider request each.
 */
export async function recordRetrievalAndPlan(world: World): Promise<PlannedWorld> {
  const missionId = world.records.missionId as string;
  const plan = structuredClone(fixture('evaluation-plan.aapl-mission.json')) as Doc;
  plan.mission_id = missionId;
  plan.plan_id = `plan-${missionId}`;
  plan.profile = structuredClone(world.records.profile);
  plan.cohort_policy = structuredClone(world.records.policy);
  plan.trial_slots[0].draft_digest = world.records.seedDigest;
  const planDigest = await digest(plan);
  const bytes = new TextEncoder().encode(canonicalJson(plan));
  await world.testApp.objects.put(planDigest, bytes);
  const retrieve = await world.sql<{ job_id: string }>(
    `SELECT job_id FROM jobs WHERE mission_id = $1 AND kind = 'retrieve'`,
    [missionId],
  );
  const retrieveJobId = retrieve[0]?.job_id as string;
  await world.tx(async (tx) => {
    await artefactRow(tx, plan.calendar.digest, plan.calendar.size_bytes);
    await artefactRow(tx, planDigest, bytes.length);
    await tx.query(
      `INSERT INTO dataset_manifests (manifest_digest, mission_id, job_id, completeness, retrieved_at)
       VALUES ($1, $2, $3, 'COMPLETE', $4)`,
      [plan.calendar.digest, missionId, retrieveJobId, '2026-11-15T10:00:00Z'],
    );
    const windows = Object.fromEntries(plan.windows.map((window: Doc) => [window.role, window.resolved]));
    await tx.query(
      `INSERT INTO evaluation_plans (plan_digest, plan_id, mission_id, profile_id, profile_revision, policy_id, policy_revision,
         suite_id, calendar_digest, warmup_sessions, d_start, d_end, v_start, v_end, h_start, h_end, recorded_by, recorded_at)
       SELECT $1::text, $2::text, $3::text, profile_id, profile_revision, policy_id, policy_revision, $4::text, $5::text, 60,
         $6::date, $7::date, $8::date, $9::date, $10::date, $11::date, $12::text, $13::timestamptz
         FROM missions WHERE mission_id = $3`,
      [
        planDigest,
        plan.plan_id,
        missionId,
        plan.suite_id,
        plan.calendar.digest,
        windows.DEVELOPMENT.scored_start,
        windows.DEVELOPMENT.scored_end,
        windows.VALIDATION.scored_start,
        windows.VALIDATION.scored_end,
        windows.HOLDOUT.scored_start,
        windows.HOLDOUT.scored_end,
        ids.workflows,
        '2026-11-15T10:00:00Z',
      ],
    );
    await tx.query(
      `INSERT INTO comparisons (plan_digest, cost_stress_multiplier, repeat_window_role, repeat_cost_scenario) VALUES ($1, 2, 'DEVELOPMENT', 'BASE')`,
      [planDigest],
    );
    const seedSlot = plan.trial_slots.find((slot: Doc) => slot.kind === 'seed') as Doc;
    await tx.query(
      `INSERT INTO trial_slots (mission_id, trial_slot, plan_digest, slot_kind, strategy_id, draft_digest) VALUES ($1, $2, $3, 'SEED', $4, $5)`,
      [missionId, seedSlot.slot_id, planDigest, seedSlot.strategy_id, seedSlot.draft_digest],
    );
    for (const slot of plan.trial_slots.filter((entry: Doc) => entry.kind === 'revision')) {
      await tx.query(
        `INSERT INTO trial_slots (mission_id, trial_slot, plan_digest, slot_kind, parent_slot, configuration_id) VALUES ($1, $2, $3, 'REVISION', $4, $5)`,
        [missionId, slot.slot_id, planDigest, slot.parent_slot, slot.configuration_id],
      );
    }
    // Base runs first: a repeat refers to the slot that it repeats.
    const slots = [...plan.run_slots].sort(
      (a: Doc, b: Doc) => Number(a.replay_of !== undefined) - Number(b.replay_of !== undefined),
    );
    for (const slot of slots) {
      await tx.query(
        `INSERT INTO run_slots (mission_id, run_slot, trial_slot, window_role, cost_scenario, written_by, replay_of) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          missionId,
          slot.run_slot_id,
          slot.trial_slot,
          slot.window_role,
          slot.cost_scenario,
          slot.written_by,
          slot.replay_of ?? null,
        ],
      );
    }
  });
  world.records.planDigest = planDigest;
  world.docs.plan = plan;
  return { missionId, planDigest, retrieveJobId };
}

/** A recorded release identity for the environment: the engine and method that evaluation requests require. */
export async function recordRelease(world: World, edit?: (release: Doc) => void): Promise<Doc> {
  const release = structuredClone(fixture('release-manifest.staging.json')) as Doc;
  release.environment = world.testApp.env.environment;
  edit?.(release);
  await world.sql(
    `INSERT INTO release_records (environment, source_commit, manifest_digest, migration_level, document, recorded_by, recorded_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)`,
    [
      release.environment,
      release.source_commit,
      await digest(release),
      release.migration_level,
      JSON.stringify(release),
      ids.deploy,
      '2026-11-15T10:00:00Z',
    ],
  );
  return release;
}

/**
 * An environment with no recorded release. A release record is immutable by design, so this is a test device: the
 * immutability trigger is off for the one DELETE. It stands for a result that arrives where no release is recorded.
 */
export async function removeReleases(world: World): Promise<void> {
  await world.sql('ALTER TABLE release_records DISABLE TRIGGER release_records_immutable');
  await world.sql('DELETE FROM release_records');
  await world.sql('ALTER TABLE release_records ENABLE TRIGGER release_records_immutable');
}

export const SLOTS = { seed: 'seed', revA: 'rev-a', revB: 'rev-b' } as const;

/** The registered Strategy Versions of the slots, as the validation jobs of a later part register them. */
export async function registerVersions(
  world: World,
  slots: readonly string[] = ['seed', 'rev-a', 'rev-b'],
): Promise<Record<string, string>> {
  const missionId = world.records.missionId as string;
  const hashes: Record<string, string> = {};
  await world.tx(async (tx) => {
    for (const [index, slot] of slots.entries()) {
      const hash = slot === 'seed' ? world.records.seedDigest : sha(`version-${slot}`);
      hashes[slot] = hash;
      await artefactRow(tx, hash, 4979);
      await tx.query(
        `INSERT INTO strategy_versions (strategy_hash, strategy_id, version, parent_hash, mission_id, registered_at)
         VALUES ($1, 'daily-swing-seed', $2, $3, $4, $5)`,
        [
          hash,
          slot === 'seed' ? 1 : index + 1,
          slot === 'seed' ? null : world.records.seedDigest,
          missionId,
          '2026-11-15T10:00:00Z',
        ],
      );
      await tx.query(
        `INSERT INTO trials (trial_id, mission_id, trial_slot, proposal_ordinal, draft_digest, status, strategy_hash, created_at)
         VALUES ($1, $2, $3, 1, $4, 'REGISTERED', $4, $5)`,
        [`trial-${slot}`, missionId, slot, hash, '2026-11-15T10:00:00Z'],
      );
    }
  });
  return hashes;
}

export interface PlannedOptions {
  /** The batch seconds of one evaluate attempt in the cohort policy. The pilot proposes 600; 300 fits all 21 runs. */
  readonly evaluateSeconds?: number;
  readonly release?: boolean;
  readonly versions?: string[];
  readonly mission?: (mission: Doc) => void;
  readonly policy?: (policy: Doc) => void;
  readonly researchExecution?: boolean;
}

/**
 * The pilot after its first steps: records registered, the mission created and started (its retrieval attempt is
 * PENDING), the dataset manifest and the evaluation plan recorded, a release identity recorded and the three Strategy
 * Versions registered. The next step is a critique and a Decision.
 */
export async function plannedWorld(options: PlannedOptions = {}): Promise<World> {
  const world = await createWorld({
    ...(options.researchExecution === undefined ? {} : { researchExecution: options.researchExecution }),
    policy: (policy) => {
      policy.limits.job_timeouts.evaluate_seconds = options.evaluateSeconds ?? 300;
      options.policy?.(policy);
    },
  });
  await registerRecords(world);
  await createMission(world, options.mission);
  await startMission(world);
  await recordRetrievalAndPlan(world);
  if (options.release !== false) await recordRelease(world);
  await registerVersions(world, options.versions);
  return world;
}

/** The pilot started: records registered, the mission created and run_mission_now applied, its retrieval PENDING. */
export async function startedWorld(
  options: { readonly mission?: (mission: Doc) => void; readonly policy?: (policy: Doc) => void } = {},
): Promise<World & { readonly retrieve: { jobId: string; attemptId: string } }> {
  const world = await createWorld(options.policy === undefined ? {} : { policy: options.policy });
  await registerRecords(world);
  await createMission(world, options.mission);
  const started = await startMission(world);
  return Object.assign(world, { retrieve: { jobId: started.jobId, attemptId: started.attemptId } });
}

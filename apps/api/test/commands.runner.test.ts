// The life of a guarded command (OQ-05 sections 3, 4 and 9; command/1): accepted and durable, applied once, refused with
// a recorded reason, replayed by its client ID, read back by status. And who may apply which command: roles have no
// hierarchy, and the two internal commands belong to the workflows service principal alone.

import { digest, parseContract } from '@openquant/api-contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mayApply, readCommand } from '../src/commands/runner.ts';
import type { Actor } from '../src/domain/rows.ts';
import { ids } from './support/seed.ts';
import {
  type ActorName,
  actorOf,
  createWorld,
  type Doc,
  missionPayload,
  registerRecords,
  type World,
} from './support/world.ts';

let world: World;
beforeAll(async () => {
  world = await createWorld();
});
afterAll(async () => {
  await world.drop();
});

const commandRows = () =>
  world.sql(
    `SELECT command_id, kind, actor_id, state, record_id, record_revision, error_code FROM commands ORDER BY received_at, command_id`,
  );

describe('an accepted command', () => {
  it('is recorded with its actor, its body digest and its expected revision, and applied exactly once', async () => {
    const payload = { kind: 'register_budget', budget: world.docs.budget };
    const request = world.command(payload, { commandId: 'cmd-budget-1' });
    const outcome = await world.execute('steward', request);
    expect(outcome.state).toBe('APPLIED');
    const rows = await world.sql(
      `SELECT command_id, kind, actor_id, body_digest, expected_revision, state, record_id, record_revision, error_code,
              applied_at IS NOT NULL AS applied, rejected_at IS NOT NULL AS rejected FROM commands WHERE command_id = 'cmd-budget-1'`,
    );
    expect(rows).toEqual([
      {
        command_id: 'cmd-budget-1',
        kind: 'register_budget',
        actor_id: ids.steward,
        body_digest: await digest(request),
        expected_revision: 0,
        state: 'APPLIED',
        record_id: 'staging-period-cap',
        record_revision: 1,
        error_code: null,
        applied: true,
        rejected: false,
      },
    ]);
  });

  it('answers the same command ID with the same body by returning the first result, and writes nothing', async () => {
    const request = world.command(
      { kind: 'register_budget', budget: world.docs.budget },
      { commandId: 'cmd-budget-1' },
    );
    const first = await world.apply('steward', request.payload, { commandId: 'cmd-budget-1' });
    // `world.command` stamps the same fixed time, so the body is the same bytes.
    expect(first.state).toBe('APPLIED');
    const before = await world.snapshot();
    const again = await world.execute('steward', request);
    expect(again).toEqual(first);
    expect(await world.snapshot()).toEqual(before);
    expect(await world.sql(`SELECT count(*)::int AS n FROM budget_caps`)).toEqual([{ n: 1 }]);
    expect((await commandRows()).filter((row) => row.command_id === 'cmd-budget-1')).toHaveLength(1);
  });

  it('refuses the same command ID with another body, or from another principal, as COMMAND_ID_REUSED, and leaves the first untouched', async () => {
    const before = await world.sql(`SELECT * FROM commands WHERE command_id = 'cmd-budget-1'`);
    const otherBody = structuredClone(world.docs.budget) as Doc;
    otherBody.provider_requests = 999;
    await expect(
      world.apply('steward', { kind: 'register_budget', budget: otherBody }, { commandId: 'cmd-budget-1' }),
    ).rejects.toMatchObject({
      code: 'COMMAND_ID_REUSED',
    });
    // Another expected revision is another body too.
    await expect(
      world.apply(
        'steward',
        { kind: 'register_budget', budget: world.docs.budget },
        { commandId: 'cmd-budget-1', expectedRevision: 1 },
      ),
    ).rejects.toMatchObject({ code: 'COMMAND_ID_REUSED' });
    // The same bytes from another Steward are another command that happens to share an ID.
    await world.sql(
      `INSERT INTO principals (principal_id, kind, display_name, environment, created_at) VALUES ('human-steward-2', 'HUMAN', 'Second Steward', 'DEVELOPMENT', now())`,
    );
    const second: Actor = { principalId: 'human-steward-2', kind: 'HUMAN', serviceKind: null, roles: ['Steward'] };
    const request = world.command(
      { kind: 'register_budget', budget: world.docs.budget },
      { commandId: 'cmd-budget-1' },
    );
    await expect(world.execute(second, request)).rejects.toMatchObject({ code: 'COMMAND_ID_REUSED' });
    expect(await world.sql(`SELECT * FROM commands WHERE command_id = 'cmd-budget-1'`)).toEqual(before);
  });
});

describe('a refused command', () => {
  it('is recorded with its code and message, returns the same refusal for the same ID, and changes no state', async () => {
    const payload = { kind: 'run_mission_now', mission_id: 'msn-none' };
    const first = await world.apply('researcher', payload, { commandId: 'cmd-run-none', expectedRevision: 1 });
    expect(first.state).toBe('REJECTED');
    const row = await world.sql(
      `SELECT state, error_code, error_message, record_id, record_revision, applied_at, rejected_at IS NOT NULL AS rejected FROM commands WHERE command_id = 'cmd-run-none'`,
    );
    expect(row).toEqual([
      {
        state: 'REJECTED',
        error_code: 'NOT_FOUND',
        error_message: 'The mission msn-none does not exist.',
        record_id: null,
        record_revision: null,
        applied_at: null,
        rejected: true,
      },
    ]);
    const again = await world.apply('researcher', payload, { commandId: 'cmd-run-none', expectedRevision: 1 });
    expect(again).toEqual(first);
    expect(
      await world.sql(
        `SELECT count(*)::int AS n FROM audit_events WHERE event_type = 'command.rejected' AND command_id = 'cmd-run-none'`,
      ),
    ).toEqual([{ n: 1 }]);
  });

  it('keeps its first answer when the state that caused it changes: the client uses a new ID to try again', async () => {
    const fresh = await createWorld();
    await fresh.apply('steward', { kind: 'register_budget', budget: fresh.docs.budget });
    await fresh.apply('steward', { kind: 'register_research_profile', profile: fresh.docs.profile });
    await fresh.apply('steward', { kind: 'register_cohort_policy', policy: fresh.docs.policy });
    // The seed is not registered yet: the mission names a draft that does not exist.
    const mission = missionPayload(fresh);
    const refused = await fresh.apply('researcher', mission, { commandId: 'cmd-mission-early' });
    expect(refused.state === 'REJECTED' && refused.status.error.code).toBe('NOT_FOUND');
    await fresh.apply('researcher', { kind: 'register_seed', ...fresh.docs.seed });
    const replay = await fresh.apply('researcher', mission, { commandId: 'cmd-mission-early' });
    expect(replay.state).toBe('REJECTED');
    const retry = await fresh.apply('researcher', mission, { commandId: 'cmd-mission-late' });
    expect(retry.state).toBe('APPLIED');
    await fresh.drop();
  });
});

describe('a command that stayed PENDING', () => {
  it('is applied by a retry with its ID: a crash between acceptance and application loses nothing', async () => {
    const fresh = await createWorld();
    const request = fresh.command({ kind: 'register_budget', budget: fresh.docs.budget }, { commandId: 'cmd-crashed' });
    // The first request was accepted (step 1) and the process died before step 2.
    await fresh.sql(
      `INSERT INTO commands (command_id, kind, actor_id, body_digest, expected_revision, received_at) VALUES ($1, 'register_budget', $2, $3, 0, now())`,
      ['cmd-crashed', ids.steward, await digest(request)],
    );
    const status = await readCommand(await fresh.testApp.env.database(), 'cmd-crashed');
    expect(status?.state).toBe('PENDING');
    expect(await fresh.sql('SELECT 1 FROM budget_caps')).toEqual([]);
    const retried = await fresh.execute('steward', request);
    expect(retried.state).toBe('APPLIED');
    expect(await fresh.sql('SELECT revision FROM budget_caps')).toEqual([{ revision: 1 }]);
    await fresh.drop();
  });

  it('applies once when two requests with the same ID arrive together, and both read the same record', async () => {
    const fresh = await createWorld();
    await registerRecords(fresh);
    const payload = missionPayload(fresh);
    const outcomes = await Promise.all([
      fresh.apply('researcher', payload, { commandId: 'cmd-twice' }),
      fresh.apply('researcher', payload, { commandId: 'cmd-twice' }),
      fresh.apply('researcher', payload, { commandId: 'cmd-twice' }),
    ]);
    expect(outcomes.every((outcome) => outcome.state === 'APPLIED')).toBe(true);
    const records = outcomes.map((outcome) => (outcome.state === 'APPLIED' ? outcome.status.record.id : ''));
    expect(new Set(records).size).toBe(1);
    expect(await fresh.sql('SELECT 1 FROM missions')).toHaveLength(1);
    expect(await fresh.sql(`SELECT state FROM commands WHERE command_id = 'cmd-twice'`)).toEqual([
      { state: 'APPLIED' },
    ]);
    await fresh.drop();
  });
});

describe('the status of a command (commands.show)', () => {
  it('has the command/1 status form in each state, with second-precision UTC times', async () => {
    const applied = await readCommand(world.testApp.env.database(), 'cmd-budget-1');
    const rejected = await readCommand(world.testApp.env.database(), 'cmd-run-none');
    expect(applied?.status).toEqual({
      schema_version: 'command/1',
      form: 'status',
      command_id: 'cmd-budget-1',
      kind: 'register_budget',
      state: 'APPLIED',
      received_at: '2026-11-15T10:00:00Z',
      applied_at: '2026-11-15T10:00:00Z',
      record: { id: 'staging-period-cap', revision: 1 },
    });
    expect(rejected?.status).toEqual({
      schema_version: 'command/1',
      form: 'status',
      command_id: 'cmd-run-none',
      kind: 'run_mission_now',
      state: 'REJECTED',
      received_at: '2026-11-15T10:00:00Z',
      rejected_at: '2026-11-15T10:00:00Z',
      error: { code: 'NOT_FOUND', message: 'The mission msn-none does not exist.' },
    });
    for (const outcome of [applied, rejected]) {
      expect(parseContract('command', JSON.stringify(outcome?.status)).ok).toBe(true);
    }
    expect(await readCommand(world.testApp.env.database(), 'cmd-never-sent')).toBeUndefined();
  });

  it('shows a PENDING command as PENDING', async () => {
    await world.sql(
      `INSERT INTO commands (command_id, kind, actor_id, body_digest, expected_revision, received_at) VALUES ('cmd-pending', 'cancel_mission', $1, $2, 1, now())`,
      [ids.researcher, `sha256:${'a'.repeat(64)}`],
    );
    const status = (await readCommand(world.testApp.env.database(), 'cmd-pending'))?.status;
    expect(status).toMatchObject({ state: 'PENDING', kind: 'cancel_mission', command_id: 'cmd-pending' });
    expect(parseContract('command', JSON.stringify(status)).ok).toBe(true);
  });
});

describe('who may apply which command', () => {
  const kinds = [
    'register_research_profile',
    'register_cohort_policy',
    'register_budget',
    'register_seed',
    'create_mission',
    'run_mission_now',
    'cancel_mission',
    'record_evaluation_decision',
    'freeze_candidates',
  ] as const;
  const actors: ActorName[] = ['viewer', 'researcher', 'steward', 'admin', 'workflows', 'batch', 'runner', 'deploy'];
  // OQ-05 section 9 and OQ-02 section 1, one line for each kind. A role is applied as listed, with no hierarchy: an
  // Administrator is not a Steward and a Steward is not a Researcher. The decision and the freeze are the workflows
  // principal's, under an approved policy, and nobody else's.
  const allowed: Record<(typeof kinds)[number], ActorName[]> = {
    register_research_profile: ['steward'],
    register_cohort_policy: ['steward'],
    register_budget: ['steward'],
    register_seed: ['researcher'],
    create_mission: ['researcher'],
    run_mission_now: ['researcher'],
    cancel_mission: ['researcher'],
    record_evaluation_decision: ['workflows'],
    freeze_candidates: ['workflows'],
  };

  it('allows exactly the listed principal for each of the nine kinds', () => {
    for (const kind of kinds) {
      for (const name of actors) {
        expect(mayApply(kind, actorOf(name)), `${kind} by ${name}`).toBe(allowed[kind].includes(name));
      }
    }
  });

  it('refuses every other principal with FORBIDDEN before anything is recorded', async () => {
    const fresh = await createWorld();
    const payloads: Record<(typeof kinds)[number], Doc> = {
      register_research_profile: { kind: 'register_research_profile', profile: fresh.docs.profile },
      register_cohort_policy: { kind: 'register_cohort_policy', policy: fresh.docs.policy },
      register_budget: { kind: 'register_budget', budget: fresh.docs.budget },
      register_seed: { kind: 'register_seed', ...fresh.docs.seed },
      create_mission: missionPayload(fresh),
      run_mission_now: { kind: 'run_mission_now', mission_id: 'msn-1' },
      cancel_mission: { kind: 'cancel_mission', mission_id: 'msn-1', reason: 'x' },
      record_evaluation_decision: { kind: 'record_evaluation_decision', mission_id: 'msn-1' },
      freeze_candidates: { kind: 'freeze_candidates', mission_id: 'msn-1' },
    };
    let refused = 0;
    for (const kind of kinds) {
      for (const name of actors.filter((actor) => !allowed[kind].includes(actor))) {
        await expect(fresh.apply(name, payloads[kind] as Doc), `${kind} by ${name}`).rejects.toMatchObject({
          code: 'FORBIDDEN',
        });
        refused += 1;
      }
    }
    // 9 kinds x 7 principals that are not the right one.
    expect(refused).toBe(63);
    expect(await fresh.sql('SELECT 1 FROM commands')).toEqual([]);
    expect(await fresh.sql('SELECT 1 FROM audit_events')).toEqual([]);
    await fresh.drop();
  });

  it('gives a service principal no right to create, enlarge or approve: the only commands of the workflows principal are the two internal ones', () => {
    for (const kind of kinds) {
      if (allowed[kind].includes('workflows'))
        expect(['record_evaluation_decision', 'freeze_candidates']).toContain(kind);
    }
    for (const service of ['batch', 'runner', 'deploy'] as const) {
      expect(kinds.filter((kind) => mayApply(kind, actorOf(service)))).toEqual([]);
    }
  });
});

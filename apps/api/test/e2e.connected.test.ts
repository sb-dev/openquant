// The connected path end to end (OQ-06 section 8, S1 "connected path"; OQ-05 sections 4, 5, 7 and 8; OQ-02 sections
// 3.6 and 4). Everything that the product runs is real here: the API app on PostgreSQL with its orchestrator and its
// scheduled recovery pass, the built engine-batch binary (its queue consumer, egress module, claims, the retrieve,
// validate, evaluate and assess jobs of the shared Rust core), the agent runner's own modules with its claim, request
// checks and result parser, and the api-client that a person uses. Everything external is a loopback fake
// (support/connected.ts): the Cloudflare Queues pull endpoint, Alpaca with invented bars, and the CLI executor.
//
//   1. A pilot-shaped mission, driven through the api-client, concludes NO_ELIGIBLE_CANDIDATE: the seed and one
//      proposer's controlled revision are evaluated by Rust (D, V and H runs), the other proposer refuses.
//   2. Candidate cash isolation: every run of every candidate starts from the policy's capital, and replaying each run's
//      own strategy and input alone gives the same result digest, although the binary ran the candidates interleaved.
//   3. The S0 connected replay: every S0 case through the connected REPLAY path gives the digest of s0-replay, or, for a
//      case whose documents the core refuses before it prepares a run, an explicit NOT_PREPARED failure with the code.
//      The semantic-invalid seeds of the protocol fixtures fail the same way. A run that the binary loses after its
//      checkpoint journal was written resumes on a new attempt and gives the same digest.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { BUNDLE_HASH, computeDifference } from '@openquant/agents';
import { type AccessToken, ApiClient, type Fetch } from '@openquant/api-client';
import { canonicalJson, digest } from '@openquant/api-contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { allBuilders } from '../src/domain/builders.ts';
import { startReplay } from '../src/domain/replay.ts';
import {
  type ConnectedWorld,
  connectedWorld,
  DATA_HOST,
  ENGINE,
  PAPER_HOST,
  QUEUE_HOST,
  releaseManifest,
  repositoryRoot,
  requireS0Index,
  s0RejectedBeforeEvaluation,
} from './support/connected.ts';
import { actorOf, type Doc } from './support/world.ts';

const fixture = (name: string): Doc =>
  JSON.parse(readFileSync(resolve(repositoryRoot, 'fixtures/protocol/valid', name), 'utf8')) as Doc;
const fixtureBytes = (path: string): Uint8Array => readFileSync(resolve(repositoryRoot, 'fixtures', path));

const MISSION = fixture('command.create-mission.json').payload.mission as Doc;
const SEED = fixture('command.register-seed.json').payload as Doc;
const TERMINAL = ['COMPLETED', 'FAILED', 'CANCELLED'];

let world: ConnectedWorld;
let missionId: string;
let started: number;
let missionSeconds: number;
const tokens = {} as Record<'admin' | 'steward' | 'researcher' | 'viewer', AccessToken>;

const fetcher: Fetch = (url, init) => fetch(url, init as RequestInit) as never;
let counter = 0;
function clientFor(person?: keyof typeof tokens): ApiClient {
  return new ApiClient({
    baseUrl: world.apiUrl,
    fetch: fetcher,
    now: () => world.app.clock.now(),
    newCommandId: () => `cmd-e2e-${++counter}`,
    readBack: { attempts: 20, delayMs: 100 },
    ...(person === undefined ? {} : { auth: { accessToken: async () => tokens[person].access_token } }),
  });
}

/** The last part of what the binary and the runner logged, for a failure message. */
const diagnose = (): string => world.batchLog().slice(-6000);

async function until<T>(what: string, read: () => Promise<T | undefined>, seconds: number): Promise<T> {
  const deadline = Date.now() + seconds * 1000;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.\n${diagnose()}`);
    await new Promise((done) => setTimeout(done, 200));
  }
}

const sql = <R extends Record<string, unknown>>(text: string, values?: readonly unknown[]) =>
  world.app.database.sql<R>(text, values);

/** The controlled revision of proposer-a: the seed with the entry threshold raised from 30 to 32. */
async function revisionOfSeed(): Promise<Doc> {
  const parent = SEED.draft as Doc;
  const proposed = structuredClone(parent);
  proposed.definition.indicators[5].expr.params.value = '32';
  return {
    schema_version: 'strategy-formulation.result/1',
    proposal_kind: 'controlled_revision',
    parent_hash: await digest(parent),
    strategy: { operator_set: proposed.operator_set, contract: proposed.contract, definition: proposed.definition },
    source_refs: [],
    rule_changes: computeDifference(parent, proposed).declared,
    claims: {
      rationale: 'A higher weakness threshold admits entries after a shallower recovery.',
      expected_effect: 'More entries; the registered comparison can contradict this.',
      invalidation_conditions: ['No change in entry counts against the parent.'],
      requested_tests: ['The registered comparison against the parent.'],
    },
    unresolved: [],
    method_refs: [],
  };
}

/** start_replay as an Administrator, in one transaction (S1 has no route for it: replay.ts). */
async function replay(caseId: string, strategy: Uint8Array, input: Uint8Array, fixtureSet = 's0') {
  const db = world.app.env.database();
  try {
    return await db.transaction((tx) =>
      startReplay(
        tx,
        { env: world.app.env, actorId: actorOf('admin').principalId, builders: allBuilders },
        actorOf('admin'),
        { fixtureSet, caseId, strategy, input },
      ),
    );
  } finally {
    await db.close();
  }
}

async function terminalRuns(runIds: readonly string[], seconds: number) {
  return until(
    `${runIds.length} replay runs to end`,
    async () => {
      const rows = await sql<{ run_id: string; status: string; failure_code: string | null }>(
        'SELECT run_id, status, failure_code FROM runs WHERE run_id = ANY($1::text[])',
        [runIds],
      );
      return rows.length === runIds.length && rows.every((row) => TERMINAL.includes(row.status)) ? rows : undefined;
    },
    seconds,
  );
}

async function resultOf(runId: string) {
  const [row] = await sql<{ outcome: string; outcome_code: string | null; result_digest: string | null }>(
    'SELECT outcome, outcome_code, result_digest FROM results WHERE run_id = $1',
    [runId],
  );
  return row;
}

beforeAll(async () => {
  started = Date.now();
  world = await connectedWorld({
    instrument: MISSION.instrument,
    answers: {
      'strategy-formulation|claude-opus-5-5': { result: JSON.stringify(await revisionOfSeed()) },
      'strategy-formulation|claude-sonnet-5-5': { refusal: true },
      'strategy-critique|*': { result: JSON.stringify({ schema_version: 'strategy-critique.result/1', findings: [] }) },
    },
  });
  const bare = clientFor();
  for (const person of ['admin', 'steward', 'researcher', 'viewer'] as const) {
    tokens[person] = await bare.exchangeCredential(world.credentials[person]);
  }
  // The delivery job records the release: the engine, method, bundle and the executables that actually run here.
  const recorded = await fetch(`${world.apiUrl}/v1/releases`, {
    method: 'POST',
    headers: { authorization: `Bearer ${tokens.admin.access_token}`, 'content-type': 'application/json' },
    body: JSON.stringify(await releaseManifest(world)),
  });
  expect(recorded.status, await recorded.clone().text()).toBe(200);
  world.startBatch();
  world.startTicking();
}, 120_000);

afterAll(async () => {
  await world?.close();
});

describe('a pilot-shaped mission through the connected path', () => {
  it('concludes NO_ELIGIBLE_CANDIDATE, driven through the api-client, with no step taken by hand', async () => {
    const steward = clientFor('steward');
    const researcher = clientFor('researcher');
    const profile = fixture('research-profile.aapl-sip-daily.json');
    const policy = fixture('cohort-policy.s1-pilot.json');
    const profileRef = { id: profile.profile_id, revision: profile.revision, digest: await digest(profile) };
    policy.profile = profileRef;
    const policyRef = { id: policy.policy_id, revision: policy.revision, digest: await digest(policy) };
    const budget = fixture('command.register-budget.json').payload.budget;
    for (const outcome of [
      await steward.registerBudget(budget, { expectedRevision: 0 }),
      await steward.registerResearchProfile(profile as never, { expectedRevision: 0 }),
      await steward.registerCohortPolicy(policy as never, { expectedRevision: 0 }),
      await researcher.registerSeed(
        {
          draft: SEED.draft,
          origin: SEED.origin,
          sources: SEED.sources,
          source_differences: SEED.source_differences,
        } as never,
        { expectedRevision: 0 },
      ),
    ]) {
      expect(outcome.state, JSON.stringify(outcome)).toBe('APPLIED');
    }
    const mission = structuredClone(MISSION);
    mission.profile = profileRef;
    mission.cohort_policy = policyRef;
    mission.seed_draft_digest = await digest(SEED.draft);
    for (const configuration of [...mission.proposers, mission.critic]) configuration.bundle_hash = BUNDLE_HASH;
    const created = await researcher.createMission(mission as never, { expectedRevision: 0 });
    expect(created.state, JSON.stringify(created)).toBe('APPLIED');
    missionId = (created as { status: { record: { id: string } } }).status.record.id;
    const run = await researcher.runMissionNow(missionId, { expectedRevision: 1 });
    expect(run.state, JSON.stringify(run)).toBe('APPLIED');

    const viewer = clientFor('viewer');
    const view = await until(
      'the mission to conclude',
      async () => {
        const current = await viewer.mission(missionId);
        if (current.status === 'BLOCKED') throw new Error(`The mission is BLOCKED: ${JSON.stringify(current)}`);
        return current.status === 'CONCLUDED' ? current : undefined;
      },
      300,
    );
    missionSeconds = (Date.now() - started) / 1000;
    expect(view, diagnose()).toMatchObject({ status: 'CONCLUDED', outcome: 'NO_ELIGIBLE_CANDIDATE' });
    const [outcome] = await sql<{ slot_reasons: { trial_slot: string; reason: string }[] }>(
      'SELECT slot_reasons FROM mission_outcomes WHERE mission_id = $1',
      [missionId],
    );
    expect(outcome?.slot_reasons).toEqual([
      { trial_slot: 'rev-a', reason: 'NOT_ELIGIBLE' },
      { trial_slot: 'rev-b', reason: 'NO_REGISTERED_VERSION' },
      { trial_slot: 'seed', reason: 'NOT_ELIGIBLE' },
    ]);
  }, 360_000);

  it('evaluated two candidates in Rust: 14 runs and their results come from the running binary and engine', async () => {
    const runs = await sql<{ run_slot: string; status: string; executable_digest: string; engine_digest: string }>(
      `SELECT r.run_slot, r.status, s.executable_digest, s.engine_digest
         FROM runs r JOIN results s ON s.run_id = r.run_id WHERE r.mission_id = $1 ORDER BY r.run_slot`,
      [missionId],
    );
    expect(runs.map((run) => run.run_slot)).toEqual(
      ['rev-a', 'seed'].flatMap((slot) =>
        ['d.base', 'd.base.repeat', 'd.stress', 'h.base', 'h.stress', 'v.base', 'v.stress'].map(
          (run) => `${slot}.${run}`,
        ),
      ),
    );
    expect(runs.every((run) => run.status === 'COMPLETED')).toBe(true);
    expect(new Set(runs.map((run) => run.executable_digest))).toEqual(new Set([world.batchDigest]));
    expect(new Set(runs.map((run) => run.engine_digest))).toEqual(new Set([ENGINE.engine_digest]));
    // Every job of the mission was claimed by the binary or the runner of the release, and every batch job completed.
    const jobs = await sql<{ kind: string; status: string; executable: string }>(
      `SELECT j.kind, j.status, a.executable_digest AS executable
         FROM jobs j JOIN attempts a ON a.job_id = j.job_id WHERE j.mission_id = $1 ORDER BY j.kind`,
      [missionId],
    );
    for (const job of jobs) {
      expect(job.executable).toBe(job.kind === 'agent' ? world.runnerIdentity.digest : world.batchDigest);
    }
    expect(jobs.filter((job) => job.kind !== 'agent').every((job) => job.status === 'COMPLETED')).toBe(true);
    // The deterministic repeat gave the same result in each candidate.
    for (const slot of ['seed', 'rev-a']) {
      const pair = await sql<{ result_digest: string }>(
        `SELECT s.result_digest FROM runs r JOIN results s ON s.run_id = r.run_id
          WHERE r.mission_id = $1 AND r.run_slot IN ($2, $3)`,
        [missionId, `${slot}.d.base`, `${slot}.d.base.repeat`],
      );
      expect(new Set(pair.map((row) => row.result_digest)).size).toBe(1);
    }
    // The revision was validated by Rust and registered as version 2 of the seed, with its parent.
    const versions = await sql<{ version: number; parent_hash: string | null }>(
      'SELECT version, parent_hash FROM strategy_versions WHERE mission_id = $1 ORDER BY version',
      [missionId],
    );
    expect(versions).toEqual([
      { version: 1, parent_hash: null },
      { version: 2, parent_hash: await digest(SEED.draft) },
    ]);
    // The gate reports were written by Rust's assess job for both candidates.
    expect(await sql('SELECT 1 FROM gate_reports')).toHaveLength(2);
  });

  it('read the synthetic market through the egress allowlist only, and the queue in the documented shape', async () => {
    const hosts = new Set(world.seen.map((entry) => entry.split(' ')[1]?.split('/')[0]));
    expect([...hosts].sort()).toEqual(['api.cloudflare.com', 'api.openquant.test', DATA_HOST, PAPER_HOST].sort());
    expect(new Set(world.alpaca.requests.map((entry) => entry.replace(/[A-Z]+\/bars$/, 'SYMBOL/bars')))).toEqual(
      new Set([
        `GET ${PAPER_HOST}/v2/assets/${MISSION.instrument.symbol}`,
        `GET ${PAPER_HOST}/v2/calendar`,
        `GET ${DATA_HOST}/v2/stocks/SYMBOL/bars`,
        `GET ${DATA_HOST}/v1/corporate-actions`,
      ]),
    );
    expect(world.seen.some((entry) => entry.includes(QUEUE_HOST))).toBe(true);
    // Every message the dispatcher sent was acknowledged once its result was committed.
    expect(world.queue.pending).toBe(0);
    expect(await sql(`SELECT 1 FROM reservations WHERE status = 'RESERVED'`)).toEqual([]);
  });

  it('isolates candidate cash: each run starts from the policy capital and equals its own strategy and input alone', async () => {
    const runs = await sql<{
      run_id: string;
      trial_slot: string;
      run_slot: string;
      strategy_hash: string;
      input_digest: string;
      result_digest: string;
    }>(
      `SELECT r.run_id, r.trial_slot, r.run_slot, r.strategy_hash, s.input_digest, s.result_digest
         FROM runs r JOIN results s ON s.run_id = r.run_id WHERE r.mission_id = $1 ORDER BY r.run_slot`,
      [missionId],
    );
    const capital = fixture('cohort-policy.s1-pilot.json').conditions.initial_capital as string;
    const objects = world.app.objects;
    const bytesOf = async (hash: string) => (await objects.get(hash as never)) as Uint8Array;
    for (const run of runs) {
      const result = JSON.parse(new TextDecoder().decode(await bytesOf(run.result_digest))) as Doc;
      const first = result.journal.daily[0] as Doc;
      // No candidate starts with another's cash, reservations or positions.
      expect([first.cash_available, first.cash_reserved, first.positions], run.run_slot).toEqual([capital, '0.00', []]);
      const fills = (result.journal.cash_ledger as Doc[]).filter((entry) => String(entry.kind).startsWith('FILL'));
      // Every cash movement of a fill is a fill of this run, in order and amount: no other ledger's trade is in it.
      expect(
        fills.map((entry) => `${entry.kind}:${entry.amount}`),
        run.run_slot,
      ).toEqual(
        (result.journal.fills as Doc[]).map((fill) => `FILL_${fill.side}:${String(fill.cash_delta).replace('-', '')}`),
      );
    }
    // The candidates differ, so equality below is not the equality of two identical runs.
    const byWindow = (slot: string) => runs.filter((run) => run.trial_slot === slot).map((run) => run.result_digest);
    expect(byWindow('seed').some((digestText, index) => digestText !== byWindow('rev-a')[index])).toBe(true);
    // Each run, replayed alone from its own strategy and input, gives the same result: nothing of the other candidate,
    // which the binary evaluated in the same process and at the same time, reached its ledger.
    const replays: { runId: string; expected: string; slot: string }[] = [];
    for (const run of runs) {
      const started = await replay(
        `iso-${run.run_slot}`,
        await bytesOf(run.strategy_hash),
        await bytesOf(run.input_digest),
        'isolation',
      );
      replays.push({ runId: started.runId, expected: run.result_digest, slot: run.run_slot });
    }
    await terminalRuns(
      replays.map((entry) => entry.runId),
      180,
    );
    for (const entry of replays) {
      expect((await resultOf(entry.runId))?.result_digest, entry.slot).toBe(entry.expected);
    }
  }, 240_000);
});

describe('the S0 connected replay', () => {
  it('gives the s0-replay digest for every case, or an explicit NOT_PREPARED failure with the core code', async () => {
    const index = requireS0Index();
    expect(index.length).toBeGreaterThan(90);
    // The cases that s0-replay itself reports as "rejected before evaluation": the core refuses their documents before
    // it prepares a run. The harness then states a zero-state result; the batch job reports NOT_PREPARED with the same
    // code and no result, as OQ-02 section 3.6 maps a run that the core did not prepare.
    const refused = s0RejectedBeforeEvaluation();
    const manifest = JSON.parse(readFileSync(resolve(repositoryRoot, 'fixtures/protocol/manifest.json'), 'utf8')) as {
      entries: { path: string; expect: string }[];
    };
    for (const entry of manifest.entries) {
      // Every S0 document that the protocol manifest marks semantic-invalid is among them.
      const match = /^s0\/cases\/([^/]+)\/(strategy|input)\.json$/.exec(entry.path);
      if (match !== null && entry.expect === 'semantic_invalid') expect(refused.has(match[1] as string)).toBe(true);
    }
    const runs: { caseId: string; runId: string }[] = [];
    for (const entry of index) {
      const directory = `s0/cases/${entry.case}`;
      const file = JSON.parse(new TextDecoder().decode(fixtureBytes(`${directory}/case.json`))) as Doc;
      const started = await replay(
        entry.case,
        fixtureBytes(`${directory}/${file.strategy}`),
        fixtureBytes(`${directory}/${file.input}`),
      );
      runs.push({ caseId: entry.case, runId: started.runId });
    }
    await terminalRuns(
      runs.map((run) => run.runId),
      300,
    );
    const problems: string[] = [];
    for (const run of runs) {
      const expected = index.find((entry) => entry.case === run.caseId);
      const actual = await resultOf(run.runId);
      const code = refused.get(run.caseId);
      if (code !== undefined) {
        if (actual?.outcome !== 'NOT_PREPARED' || actual.outcome_code !== code)
          problems.push(`${run.caseId}: expected NOT_PREPARED ${code}, got ${JSON.stringify(actual)}`);
      } else if (actual?.result_digest !== expected?.result_digest) {
        problems.push(`${run.caseId}: expected ${expected?.result_digest}, got ${JSON.stringify(actual)}`);
      }
    }
    expect(problems, diagnose()).toEqual([]);
    // A replay is not a trial and not competition evidence: it wrote no trial, version, slot, Decision or gate.
    const replayRuns = await sql<{ n: number }>(
      `SELECT count(*)::int AS n FROM runs WHERE mode = 'REPLAY' AND (mission_id IS NOT NULL OR run_slot IS NOT NULL OR strategy_hash IS NOT NULL)`,
    );
    expect(replayRuns).toEqual([{ n: 0 }]);
  }, 360_000);

  it('fails each semantic-invalid seed of the protocol fixtures explicitly, with the code of the core', async () => {
    const manifest = JSON.parse(readFileSync(resolve(repositoryRoot, 'fixtures/protocol/manifest.json'), 'utf8')) as {
      entries: { path: string; contract: string; expect: string; code?: string }[];
    };
    const seeds = manifest.entries.filter(
      (entry) =>
        entry.contract === 'strategy-artefact' &&
        entry.expect === 'semantic_invalid' &&
        entry.path.startsWith('protocol/'),
    );
    expect(seeds.length).toBeGreaterThan(5);
    const input = JSON.parse(new TextDecoder().decode(fixtureBytes('s0/cases/F0-smoke/input.json'))) as Doc;
    const runs: { path: string; code: string; runId: string }[] = [];
    for (const seed of seeds) {
      const strategy = JSON.parse(new TextDecoder().decode(fixtureBytes(seed.path))) as Doc;
      // The frozen input names this strategy, so the strategy is the only defect.
      const own = { ...input, strategy_hash: await digest(strategy) };
      const started = await replay(
        'semantic-invalid',
        new TextEncoder().encode(canonicalJson(strategy)),
        new TextEncoder().encode(canonicalJson(own)),
        'protocol',
      );
      runs.push({ path: seed.path, code: seed.code as string, runId: started.runId });
    }
    const ended = await terminalRuns(
      runs.map((run) => run.runId),
      120,
    );
    for (const run of runs) {
      expect(
        ended.find((row) => row.run_id === run.runId),
        run.path,
      ).toMatchObject({ status: 'FAILED', failure_code: run.code });
      expect(await resultOf(run.runId), run.path).toMatchObject({
        outcome: 'NOT_PREPARED',
        outcome_code: run.code,
        result_digest: null,
      });
    }
  }, 180_000);

  it('resumes a run whose binary died after its checkpoint was written, on a new attempt, with the same digest', async () => {
    const caseId = 'SEM-04';
    const directory = `s0/cases/${caseId}`;
    const file = JSON.parse(new TextDecoder().decode(fixtureBytes(`${directory}/case.json`))) as Doc;
    const expected = requireS0Index().find((entry) => entry.case === caseId)?.result_digest;
    // Hold the first upload of the first attempt: the stepping, and its checkpoint journal, are done by then.
    let held: (() => void) | undefined;
    let first = '';
    world.hold = (method, path) => {
      if (first === '' || method !== 'PUT' || !path.startsWith(`/v1/attempts/${first}/artefacts/`)) return undefined;
      return new Promise<void>((release) => {
        held = release;
      });
    };
    const started = await replay(
      caseId,
      fixtureBytes(`${directory}/${file.strategy}`),
      fixtureBytes(`${directory}/${file.input}`),
    );
    first = started.attemptId;
    await until('the upload of the first attempt', async () => (held === undefined ? undefined : true), 60);
    await world.killBatch();
    world.hold = undefined;
    held?.();
    // Recovery fences the lost attempt once its lease has ended, and writes a new attempt with its own reservation.
    world.app.clock.advanceSeconds(120 + 60 + 1);
    const second = await until(
      'a second attempt',
      async () => {
        const rows = await sql<{ attempt_id: string }>(
          'SELECT attempt_id FROM attempts WHERE run_id = $1 AND ownership_revision = 2',
          [started.runId],
        );
        return rows[0]?.attempt_id;
      },
      30,
    );
    world.startBatch();
    await terminalRuns([started.runId], 120);
    expect((await resultOf(started.runId))?.result_digest, diagnose()).toBe(expected);
    expect(diagnose()).toMatch(
      new RegExp(
        `attempt ${second} evaluate done in \\d+ ms: evaluation-submission COMPLETED \\(resumed from a checkpoint at `,
      ),
    );
    const attempts = await sql<{ ownership_revision: number; status: string }>(
      'SELECT ownership_revision, status FROM attempts WHERE run_id = $1 ORDER BY ownership_revision',
      [started.runId],
    );
    expect(attempts).toEqual([
      { ownership_revision: 1, status: 'LEASE_EXPIRED' },
      { ownership_revision: 2, status: 'COMPLETED' },
    ]);
  }, 240_000);

  it('took the time recorded in the report', () => {
    // Recorded for the report: the whole mission from an empty database, the binary's start included.
    expect(missionSeconds).toBeGreaterThan(0);
    process.stdout.write(
      `connected mission: ${missionSeconds.toFixed(1)} s; whole file: ${((Date.now() - started) / 1000).toFixed(1)} s\n`,
    );
  });
});

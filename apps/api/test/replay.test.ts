// start_replay and the REPLAY path of the attempt routes (OQ-05 section 4, "Replay runs"; OQ-02 sections 3.4 and 3.6),
// on a real database with the batch host played through the HTTP routes. The connected test (e2e.connected.test.ts)
// runs the same path with the real binary; this file pins each rule on its own.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { canonicalJson, digest, parseContract } from '@openquant/api-contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../src/db/database.ts';
import { allBuilders } from '../src/domain/builders.ts';
import {
  REPLAY_ARTEFACT_LIMIT_BYTES,
  REPLAY_ATTEMPT_CAP,
  REPLAY_EVALUATE_SECONDS,
  startReplay,
} from '../src/domain/replay.ts';
import { runRecovery } from '../src/recovery.ts';
import { claim, createFlow, ENGINE_BATCH, errorCode, type Flow, submit, upload } from './support/flow.ts';
import { type ActorName, actorOf, type Doc, fixture, recordRelease } from './support/world.ts';

const root = resolve(import.meta.dirname, '../../..');
const s0 = (path: string): Uint8Array => readFileSync(resolve(root, 'fixtures/s0/cases', path));
const STRATEGY = s0('F0-smoke/strategy.json');
const INPUT = s0('F0-smoke/input.json');

let flow: Flow;

beforeAll(async () => {
  flow = await createFlow();
  flow.release = await recordRelease(flow.world);
});
afterAll(async () => {
  await flow.world.drop();
});

async function start(who: ActorName = 'admin', strategy = STRATEGY, input = INPUT) {
  const db: Database = flow.world.testApp.env.database();
  try {
    return await db.transaction((tx) =>
      startReplay(
        tx,
        { env: flow.world.testApp.env, actorId: actorOf(who).principalId, builders: allBuilders },
        actorOf(who),
        { fixtureSet: 's0', caseId: 'F0-smoke', strategy, input },
      ),
    );
  } finally {
    await db.close();
  }
}

const canonicalDigest = async (bytes: Uint8Array) => digest(JSON.parse(new TextDecoder().decode(bytes)));

describe('start_replay', () => {
  it('is an Administrator command: every other role and every service principal is refused and nothing is written', async () => {
    const before = await flow.world.snapshot(['audit_events']);
    for (const who of ['researcher', 'steward', 'viewer', 'workflows', 'batch', 'runner', 'deploy'] as const) {
      await expect(start(who), who).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }
    expect(await flow.world.snapshot(['audit_events'])).toEqual(before);
  });

  it('reserves its own budget before it dispatches: record, pool, run, attempt, reservation and outbox in one go', async () => {
    const periodBefore = await flow.world.sql(`SELECT * FROM budget_pools WHERE scope <> 'REPLAY' ORDER BY pool_id`);
    const started = await start();
    const [replay] = await flow.world.sql<Doc>('SELECT * FROM replays WHERE replay_id = $1', [started.replayId]);
    expect(replay).toMatchObject({
      run_id: started.runId,
      fixture_set: 's0',
      case_id: 'F0-smoke',
      strategy_digest: await canonicalDigest(STRATEGY),
      input_digest: await canonicalDigest(INPUT),
      evaluate_seconds: REPLAY_EVALUATE_SECONDS,
      requested_by: actorOf('admin').principalId,
    });
    const pools = await flow.world.sql<{ dimension: string; limit_amount: string; committed: string }>(
      `SELECT dimension, limit_amount::text AS limit_amount, committed::text AS committed FROM budget_pools WHERE replay_id = $1`,
      [started.replayId],
    );
    // The pool is the attempt cap times the evaluate timeout, fixed by the API; the first attempt holds one share.
    expect(pools).toEqual([
      {
        dimension: 'BATCH_COMPUTE_SECONDS',
        limit_amount: `${REPLAY_ATTEMPT_CAP * REPLAY_EVALUATE_SECONDS}.00000000`,
        committed: `${REPLAY_EVALUATE_SECONDS}.00000000`,
      },
    ]);
    const [run] = await flow.world.sql<Doc>(
      'SELECT mode, status, mission_id, run_slot, trial_slot, plan_digest, strategy_hash, replay_id, attempt_cap FROM runs WHERE run_id = $1',
      [started.runId],
    );
    expect(run).toEqual({
      mode: 'REPLAY',
      status: 'QUEUED',
      mission_id: null,
      run_slot: null,
      trial_slot: null,
      plan_digest: null,
      strategy_hash: null,
      replay_id: started.replayId,
      attempt_cap: REPLAY_ATTEMPT_CAP,
    });
    const [attempt] = await flow.world.sql<Doc>(
      `SELECT a.status, a.ownership_revision, r.status AS reservation, o.status AS outbox, o.destination, o.message
         FROM attempts a JOIN reservations r ON r.attempt_id = a.attempt_id JOIN outbox o ON o.attempt_id = a.attempt_id
        WHERE a.run_id = $1`,
      [started.runId],
    );
    expect(attempt).toMatchObject({
      status: 'PENDING',
      ownership_revision: 1,
      reservation: 'RESERVED',
      outbox: 'PENDING',
      destination: 'BATCH_QUEUE',
    });
    // The dispatch of a replay names no mission; its request is a REPLAY request of the frozen input.
    expect(attempt?.message.mission_id).toBeUndefined();
    expect(parseContract('job-dispatch', JSON.stringify(attempt?.message)).ok).toBe(true);
    const request = JSON.parse(
      new TextDecoder().decode(
        (await flow.world.testApp.objects.get(attempt?.message.inputs.request.digest)) as Uint8Array,
      ),
    ) as Doc;
    expect(request).toMatchObject({
      mode: 'REPLAY',
      run_id: started.runId,
      engine: flow.release.engine,
      method: flow.release.method,
      conditions: { fixture_set: 's0', case_id: 'F0-smoke' },
      strategy: { strategy_id: 'f0-smoke', version: 1, artefact: { digest: await canonicalDigest(STRATEGY) } },
      input: { source: 'INPUT_REFERENCE', input: { digest: await canonicalDigest(INPUT) } },
    });
    // No mission or period budget moved, and a replay is no trial, version or slot.
    expect(await flow.world.sql(`SELECT * FROM budget_pools WHERE scope <> 'REPLAY' ORDER BY pool_id`)).toEqual(
      periodBefore,
    );
    for (const table of ['trials', 'strategy_versions', 'run_slots', 'decisions'])
      expect(await flow.world.sql(`SELECT 1 FROM ${table}`), table).toEqual([]);
  });

  it('stores what the schema accepts, the core decides semantics, and the schema refuses the rest', async () => {
    const strategy = JSON.parse(new TextDecoder().decode(STRATEGY)) as Doc;
    strategy.definition.indicators[0].expr.op = 'operator:ema@1';
    expect((await start('admin', new TextEncoder().encode(canonicalJson(strategy)))).runId).toMatch(/^run-/);
    await expect(
      start('admin', new TextEncoder().encode('{"schema_version":"strategy-artefact/1"}')),
    ).rejects.toMatchObject({
      code: 'SCHEMA_VIOLATION',
    });
  });
});

describe('a replay attempt', () => {
  it('is claimed by the batch host with the lease of the replay timeout, and by no runner', async () => {
    const started = await start();
    await expect(claim(flow, started.attemptId, 'runner')).rejects.toThrow(/403/);
    const claimed = await claim(flow, started.attemptId);
    const lease = (Date.parse(claimed.leaseExpiresAt) - flow.world.testApp.clock.now().getTime()) / 1000;
    expect(lease).toBe(REPLAY_EVALUATE_SECONDS + 60);
  });

  it('takes no mission step: the mission-only result routes refuse it', async () => {
    const started = await start();
    const claimed = await claim(flow, started.attemptId);
    const validation = fixture('validation-result.valid-seed.json');
    validation.attempt = { attempt_id: started.attemptId, ownership_revision: 1 };
    const response = await submit(flow, claimed, 'validation-result', validation);
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      code: 'IDENTITY_MISMATCH',
      message: 'This attempt belongs to a replay run, which takes no mission step.',
    });
  });

  it('commits only the frozen input of its request, and a failure that the core reports before it prepared a run', async () => {
    const started = await start();
    const claimed = await claim(flow, started.attemptId);
    const [row] = await flow.world.sql<{ message: Doc; message_digest: string }>(
      'SELECT message, message_digest FROM outbox WHERE attempt_id = $1',
      [started.attemptId],
    );
    const requestRef = row?.message.inputs.request;
    const input = { digest: await canonicalDigest(INPUT), media_type: 'application/json', size_bytes: 0 };
    input.size_bytes = Number(
      (
        await flow.world.sql<{ size_bytes: string }>('SELECT size_bytes FROM artefacts WHERE digest = $1', [
          input.digest,
        ])
      )[0]?.size_bytes,
    );
    const submission = (evaluationInput: Doc) => ({
      schema_version: 'evaluation-submission/1',
      run_id: started.runId,
      attempt: { attempt_id: started.attemptId, ownership_revision: 1 },
      request_digest: requestRef.digest,
      mode: 'REPLAY',
      environment: flow.world.testApp.env.environment,
      executable: { ...ENGINE_BATCH },
      engine_digest: flow.release.engine.engine_digest,
      method: flow.release.method,
      evaluation: {
        status: 'NOT_PREPARED',
        code: 'UNSUPPORTED_OPERATOR',
        detail: 'operator:ema@1 is not in the reviewed catalogue.',
        input: evaluationInput,
      },
      duration: { label: 'observed', milliseconds: 40 },
    });
    const other = await upload(flow, claimed, new TextEncoder().encode('{"another":"input"}'));
    const refused = await submit(flow, claimed, 'evaluation-submission', submission(other));
    expect(refused.status).toBe(422);
    expect(await errorCode(refused)).toBe('IDENTITY_MISMATCH');
    const accepted = await submit(flow, claimed, 'evaluation-submission', submission(input));
    expect(accepted.status, await accepted.clone().text()).toBe(204);
    const [run] = await flow.world.sql<Doc>(
      'SELECT r.status, r.failure_code, s.outcome, s.result_digest FROM runs r JOIN results s ON s.run_id = r.run_id WHERE r.run_id = $1',
      [started.runId],
    );
    expect(run).toEqual({
      status: 'FAILED',
      failure_code: 'UNSUPPORTED_OPERATOR',
      outcome: 'NOT_PREPARED',
      result_digest: null,
    });
    const [pool] = await flow.world.sql<{ committed: string }>(
      'SELECT committed::text AS committed FROM budget_pools WHERE replay_id = $1',
      [started.replayId],
    );
    // The reported duration settled the reservation: one second, rounded up.
    expect(pool?.committed).toBe('1.00000000');
  });

  it('uploads at most the replay artefact limit', async () => {
    const started = await start();
    const claimed = await claim(flow, started.attemptId);
    // A replay has no cohort policy: its own limit applies, the pilot's artefact limit.
    const atLimit = await upload(
      flow,
      claimed,
      new Uint8Array(REPLAY_ARTEFACT_LIMIT_BYTES),
      'application/octet-stream',
    );
    expect(atLimit.size_bytes).toBe(REPLAY_ARTEFACT_LIMIT_BYTES);
    const big = new Uint8Array(REPLAY_ARTEFACT_LIMIT_BYTES + 1);
    const tooLarge = await flow.send(
      'PUT',
      `/v1/attempts/${started.attemptId}/artefacts/sha256:${createHash('sha256').update(big).digest('hex')}`,
      claimed.token,
      big,
    );
    expect(await errorCode(tooLarge)).toBe('LIMIT_EXCEEDED');
  });

  it('is retried from the replay pool when its lease ends, and fails with an attention item at the cap', async () => {
    const started = await start();
    const env = flow.world.testApp.env;
    for (let revision = 1; revision <= REPLAY_ATTEMPT_CAP; revision += 1) {
      const [attempt] = await flow.world.sql<{ attempt_id: string }>(
        'SELECT attempt_id FROM attempts WHERE run_id = $1 AND ownership_revision = $2',
        [started.runId, revision],
      );
      await claim(flow, attempt?.attempt_id as string);
      flow.world.testApp.clock.advanceSeconds(REPLAY_EVALUATE_SECONDS + 61);
      const db = env.database();
      try {
        await runRecovery(env, db, { dispatchers: {} });
      } finally {
        await db.close();
      }
      const [pool] = await flow.world.sql<{ committed: string }>(
        'SELECT committed::text AS committed FROM budget_pools WHERE replay_id = $1',
        [started.replayId],
      );
      // Each fenced attempt keeps its reservation until its termination is confirmed; the next one reserves anew.
      const held = Math.min(revision + 1, REPLAY_ATTEMPT_CAP) * REPLAY_EVALUATE_SECONDS;
      expect(pool?.committed, `after attempt ${revision}`).toBe(`${held}.00000000`);
    }
    const [run] = await flow.world.sql<Doc>('SELECT status, failure_code FROM runs WHERE run_id = $1', [started.runId]);
    expect(run).toEqual({ status: 'FAILED', failure_code: 'LEASE_EXPIRED' });
    const items = await flow.world.sql<{ mission_id: string | null; subject: string }>(
      `SELECT mission_id, subject FROM attention_items WHERE subject = $1`,
      [`run ${started.runId}`],
    );
    expect(items).toEqual([{ mission_id: null, subject: `run ${started.runId}` }]);
  });
});

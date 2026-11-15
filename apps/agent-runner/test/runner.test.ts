import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { digest } from '@openquant/api-contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { revisionOutput } from '../../../packages/agents/test/support/requests.ts';
import type { ApiFailure } from '../src/api-client.ts';
import { Runner } from '../src/runner.ts';
import {
  apiFailure,
  cleanup,
  dispatchFor,
  formulationRequest,
  isAlive,
  makeWorld,
  type Scenario,
  scratch,
  until,
} from './support/world.ts';

afterEach(cleanup);

async function build(scenario: Scenario, options: Parameters<typeof makeWorld>[1] = {}) {
  const assembled = await formulationRequest();
  const world = makeWorld(scenario, options);
  world.api.store(assembled.bytes);
  const logs: string[] = [];
  const runner = new Runner({
    config: world.config,
    api: world.api,
    log: (event, fields) => logs.push(JSON.stringify({ event, ...fields })),
    sleep: async () => undefined,
  });
  const dispatch = (attempt = 'attempt-1', extra: Parameters<typeof dispatchFor>[1] = {}) =>
    dispatchFor(assembled, { attempt, ...extra });
  const send = async (attempt = 'attempt-1', extra: Parameters<typeof dispatchFor>[1] = {}) => {
    const value = dispatch(attempt, extra);
    return runner.dispatch(value, await digest(value));
  };
  return { world, runner, logs, dispatch, send };
}

const good = async (): Promise<Scenario> => ({
  behaviour: 'result',
  resultText: JSON.stringify(await revisionOutput()),
});

describe('claim before anything starts', () => {
  it('claims the attempt before the executor is touched and answers before the attempt ends', async () => {
    const { world, runner, send } = await build({ behaviour: 'hang' });
    let callsAtClaim = -1;
    let scratchAtClaim: string[] = ['unset'];
    world.api.onClaim = () => {
      callsAtClaim = world.cli.calls().length;
      scratchAtClaim = readdirSync(world.scratchRoot);
    };
    const answer = await send();
    expect(answer).toEqual({ kind: 'accepted' });
    // At the claim nothing had run, not even the version probe, and no attempt directory existed.
    expect(callsAtClaim).toBe(0);
    expect(scratchAtClaim).toEqual([]);
    // The attempt runs on its own: the answer came while it was still running.
    expect(runner.running).toBe(1);
    expect(world.api.results).toEqual([]);
    runner.cancel('attempt-1');
    await runner.idle();
  });

  it('sends the claim with the attempt binding, the dispatch digest, the runner identity and a worker id', async () => {
    const { world, runner, dispatch } = await build(await good());
    const value = dispatch();
    await runner.dispatch(value, await digest(value));
    await runner.idle();
    expect(world.api.claims).toEqual([
      {
        schema_version: 'attempt-claim/1',
        form: 'claim',
        attempt: { attempt_id: 'attempt-1', ownership_revision: 1 },
        dispatch_digest: await digest(value),
        executable: world.config.identity,
        worker_id: 'worker-test',
      },
    ]);
  });

  it('spawns nothing when the claim is refused, for every refusal of the API', async () => {
    const refusals: readonly [ApiFailure, string, string][] = [
      [apiFailure(409, 'STALE_OWNERSHIP'), 'STALE_OWNERSHIP', 'NONE'],
      [apiFailure(409, 'ATTEMPT_NOT_CLAIMABLE'), 'ATTEMPT_NOT_CLAIMABLE', 'NONE'],
      [apiFailure(422, 'IDENTITY_MISMATCH'), 'IDENTITY_MISMATCH', 'NONE'],
      [apiFailure(409, 'EXECUTION_DISABLED'), 'EXECUTION_DISABLED', 'NONE'],
      [apiFailure(404, 'NOT_FOUND'), 'IDENTITY_MISMATCH', 'NONE'],
      [apiFailure(401, 'UNAUTHENTICATED'), 'UNAVAILABLE', 'NONE'],
      [apiFailure(400, 'SCHEMA_VIOLATION'), 'INTERNAL', 'NONE'],
      [apiFailure(0, 'NETWORK'), 'UNAVAILABLE', 'UNKNOWN'],
      [apiFailure(503, 'UNAVAILABLE'), 'UNAVAILABLE', 'UNKNOWN'],
      [apiFailure(200, 'BAD_RESPONSE'), 'UNAVAILABLE', 'UNKNOWN'],
    ];
    for (const [claim, code, stateChanged] of refusals) {
      const { world, runner, send } = await build(await good(), { apiOptions: { claim } });
      const answer = await send();
      expect(answer, code).toMatchObject({ kind: 'refused', code, stateChanged });
      await runner.idle();
      expect(world.cli.calls(), code).toEqual([]);
      expect(readdirSync(world.scratchRoot), code).toEqual([]);
      expect(world.api.events, code).toEqual(['claim']);
      expect(runner.running).toBe(0);
    }
  });

  it('lets the same attempt be dispatched again after a refused claim', async () => {
    const { world, runner, send } = await build(await good(), {
      apiOptions: { claim: apiFailure(503, 'UNAVAILABLE') },
    });
    expect(await send()).toMatchObject({ kind: 'refused' });
    world.api.options = {};
    expect(await send()).toEqual({ kind: 'accepted' });
    await runner.idle();
    expect(world.api.results).toHaveLength(1);
  });
});

describe('refusals before the claim', () => {
  it('refuses a dispatch for another environment without claiming', async () => {
    const { world, runner, send } = await build(await good());
    const answer = await send('attempt-1', { environment: 'PRODUCTION' });
    expect(answer).toMatchObject({ kind: 'refused', code: 'IDENTITY_MISMATCH', stateChanged: 'NONE' });
    expect(world.api.events).toEqual([]);
    expect(runner.running).toBe(0);
  });

  it('refuses a second dispatch of an attempt that it already runs, without claiming again', async () => {
    const { world, runner, send } = await build({ behaviour: 'hang' });
    expect(await send()).toEqual({ kind: 'accepted' });
    expect(await send()).toMatchObject({ kind: 'refused', code: 'ATTEMPT_NOT_CLAIMABLE' });
    expect(world.api.events.filter((event) => event === 'claim')).toHaveLength(1);
    runner.cancel('attempt-1');
    await runner.idle();
  });

  it('refuses a dispatch above its concurrency, without claiming, and takes one again when a place is free', async () => {
    const { world, runner, send } = await build({ behaviour: 'hang' }, { maxConcurrent: 1 });
    expect(await send('attempt-1')).toEqual({ kind: 'accepted' });
    expect(await send('attempt-2')).toMatchObject({ kind: 'refused', code: 'RATE_LIMITED', stateChanged: 'NONE' });
    expect(world.api.claims.map((claim) => claim.attempt.attempt_id)).toEqual(['attempt-1']);
    runner.cancel('attempt-1');
    await runner.idle();
    expect(await send('attempt-2')).toEqual({ kind: 'accepted' });
    runner.cancel('attempt-2');
    await runner.idle();
  });

  it('holds its place while the claim is in flight, so two dispatches of one attempt claim once', async () => {
    const { world, runner, send } = await build(await good());
    const [first, second] = await Promise.all([send(), send()]);
    expect([first.kind, second.kind].sort()).toEqual(['accepted', 'refused']);
    expect(world.api.claims).toHaveLength(1);
    await runner.idle();
  });
});

describe('a disabled executor', () => {
  it('claims, records a denial of capability for every dispatch, and starts nothing', async () => {
    const { world, runner, send } = await build(await good(), { enabled: false });
    expect(await send('attempt-1')).toEqual({ kind: 'accepted' });
    expect(await send('attempt-2')).toEqual({ kind: 'accepted' });
    await runner.idle();
    expect(world.api.results.map((result) => result.outcome)).toEqual([
      expect.objectContaining({ outcome: 'denied_capability', reason: 'EXECUTION_DISABLED' }),
      expect.objectContaining({ outcome: 'denied_capability', reason: 'EXECUTION_DISABLED' }),
    ]);
    expect(world.cli.calls()).toEqual([]);
    expect(readdirSync(world.scratchRoot)).toEqual([]);
    expect(world.api.claims).toHaveLength(2);
  });
});

describe('the attempt after the answer', () => {
  it('posts the completion on its own and records the end', async () => {
    const { world, runner, send } = await build(await good());
    await send();
    await runner.idle();
    expect(world.api.results).toHaveLength(1);
    expect(world.api.results[0]?.outcome.outcome).toBe('completion');
    expect(runner.ended).toEqual([{ posted: true, outcome: 'completion' }]);
    expect(runner.running).toBe(0);
  });

  it('runs two attempts at once with separate homes, working directories and sessions', async () => {
    const { world, runner, send } = await build(await good());
    await Promise.all([send('attempt-1'), send('attempt-2')]);
    await runner.idle();
    expect(world.api.results).toHaveLength(2);
    const runs = world.cli.calls().filter((call) => call.kind === 'run');
    expect(runs).toHaveLength(2);
    expect(new Set(runs.map((call) => call.env.HOME)).size).toBe(2);
    expect(new Set(runs.map((call) => call.cwd)).size).toBe(2);
    expect(new Set(runs.map((call) => call.args?.[(call.args?.indexOf('--session-id') ?? 0) + 1])).size).toBe(2);
  });

  it('cancels one attempt: the tree ends and a cancellation is recorded', async () => {
    const pidFile = join(scratch(), 'pid');
    const { world, runner, send } = await build({ behaviour: 'grandchild', pidFile });
    await send();
    await until(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').length > 0);
    expect(runner.cancel('attempt-1')).toBe(true);
    expect(runner.cancel('attempt-unknown')).toBe(false);
    await runner.idle();
    expect(world.api.results[0]?.outcome).toMatchObject({ outcome: 'cancellation' });
    await until(() => !isAlive(Number(readFileSync(pidFile, 'utf8'))), 5000);
  });

  it('posts nothing on shutdown and kills every executor tree: the leases expire and recovery fences new attempts', async () => {
    const pidFile = join(scratch(), 'pid');
    const { world, runner, send } = await build({ behaviour: 'grandchild', pidFile }, { maxConcurrent: 2 });
    await send('attempt-1');
    await until(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').length > 0);
    await runner.shutdown();
    expect(world.api.results).toEqual([]);
    expect(runner.ended).toEqual([expect.objectContaining({ posted: false, why: 'shutdown' })]);
    await until(() => !isAlive(Number(readFileSync(pidFile, 'utf8'))), 5000);
  });

  it('records a late completion that the API rejects and does not retry it', async () => {
    const { world, runner, send } = await build(await good(), {
      apiOptions: { result: apiFailure(409, 'LEASE_EXPIRED') },
    });
    await send();
    await runner.idle();
    expect(runner.ended).toEqual([expect.objectContaining({ posted: false, why: 'lease_lost' })]);
    expect(world.api.events.filter((event) => event === 'post')).toHaveLength(1);
  });

  it('leaves the attempt for fencing when the runner fails, and frees its place', async () => {
    const { world, runner, send } = await build(await good());
    world.api.fetchInput = async () => {
      throw new Error('boom');
    };
    expect(await send()).toEqual({ kind: 'accepted' });
    await runner.idle();
    expect(world.api.results).toEqual([]);
    expect(runner.ended).toEqual([expect.objectContaining({ posted: false, why: 'internal_error' })]);
    expect(runner.running).toBe(0);
    expect(world.cli.calls()).toEqual([]);
  });
});

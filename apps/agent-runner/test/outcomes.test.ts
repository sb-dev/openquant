// The seven execution outcomes of agent-attempt-result/1, each reached through the dispatch endpoint of the real runner
// with a fake executor (OQ-03 sections 4 to 6), and the refusal of a dispatch that names another bundle.
//
// The list of outcomes comes from the schema file, not from the runner: a new outcome in the contract fails this test
// until the runner and its tests handle it.

import { readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { BUNDLE_HASH } from '@openquant/agents';
import { type AgentAttemptResult, canonicalJson, validateContract } from '@openquant/api-contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { critiqueOutput, finding, revisionOutput } from '../../../packages/agents/test/support/requests.ts';
import { Runner } from '../src/runner.ts';
import { createDispatchServer } from '../src/server.ts';
import {
  cleanup,
  critiqueRequest,
  DISPATCH_TOKEN,
  type DispatchOptions,
  dispatchFor,
  formulationRequest,
  makeWorld,
  repositoryRoot,
  type Scenario,
  until,
  type World,
} from './support/world.ts';

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((done) => server.close(() => done()))));
  cleanup();
});

interface Started {
  readonly world: World;
  readonly runner: Runner;
  send(dispatch: ReturnType<typeof dispatchFor>): Promise<Response>;
}

async function start(scenario: Scenario, options: Parameters<typeof makeWorld>[1] = {}): Promise<Started> {
  const world = makeWorld(scenario, options);
  const runner = new Runner({ config: world.config, api: world.api, sleep: async () => undefined });
  const server = createDispatchServer({ runner, dispatchToken: DISPATCH_TOKEN, log: () => undefined });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  servers.push(server);
  const port = (server.address() as AddressInfo).port;
  return {
    world,
    runner,
    send: (dispatch) =>
      fetch(`http://127.0.0.1:${port}/v1/agent-attempts`, {
        method: 'POST',
        headers: { authorization: `Bearer ${DISPATCH_TOKEN}` },
        body: canonicalJson(dispatch),
      }),
  };
}

function posted(world: World): AgentAttemptResult {
  const [result] = world.api.results;
  if (!result) throw new Error('no result was posted');
  expect(world.api.results).toHaveLength(1);
  expect(validateContract('agent-attempt-result', result).ok).toBe(true);
  return result;
}

// The outcomes that the contract defines, read from the schema file.
const schema = JSON.parse(
  readFileSync(resolve(repositoryRoot, 'packages/api-contracts/schemas/agent-attempt-result.schema.json'), 'utf8'),
) as { $defs: Record<string, { properties?: { outcome?: { enum: string[] } } }> };
const OUTCOMES = Object.values(schema.$defs)
  .flatMap((definition) => definition.properties?.outcome?.enum ?? [])
  .sort();

interface Case {
  readonly outcome: string;
  readonly role?: 'proposer' | 'critic';
  readonly scenario: () => Promise<Scenario>;
  readonly dispatch?: DispatchOptions;
  readonly world?: Parameters<typeof makeWorld>[1];
  /** Cancel the attempt once the executor runs. */
  readonly cancel?: boolean;
  readonly detail?: Record<string, unknown>;
}

const cases: readonly Case[] = [
  {
    outcome: 'completion',
    scenario: async () => ({ behaviour: 'result', resultText: JSON.stringify(await revisionOutput()) }),
  },
  {
    outcome: 'completion',
    role: 'critic',
    scenario: async () => ({ behaviour: 'result', resultText: JSON.stringify(critiqueOutput(finding())) }),
  },
  {
    outcome: 'refusal',
    scenario: async () => ({ behaviour: 'result', resultText: 'No.', report: { stop_reason: 'refusal' } }),
  },
  {
    outcome: 'malformed_result',
    scenario: async () => ({ behaviour: 'result', resultText: 'Here is a strategy in words.' }),
    detail: { reason: 'NOT_JSON' },
  },
  {
    outcome: 'denied_capability',
    scenario: async () => ({ behaviour: 'result', resultText: '{}' }),
    world: { executor: { path: '/nonexistent/claude' } },
    detail: { reason: 'EXECUTABLE_MISSING' },
  },
  {
    outcome: 'authentication_failure',
    scenario: async () => ({
      behaviour: 'result',
      report: { is_error: true, api_error_status: 401, result: 'Invalid API key' },
      exitCode: 1,
    }),
    detail: { reason: 'CREDENTIAL_REJECTED' },
  },
  {
    outcome: 'timeout',
    scenario: async () => ({ behaviour: 'hang' }),
    dispatch: { timeoutSeconds: 1 },
  },
  {
    outcome: 'cancellation',
    scenario: async () => ({ behaviour: 'hang' }),
    cancel: true,
  },
];

describe('the seven outcomes of agent-attempt-result/1 through the dispatch endpoint', () => {
  it('are the seven that the schema defines, and every one has a case below', () => {
    expect(OUTCOMES).toEqual([
      'authentication_failure',
      'cancellation',
      'completion',
      'denied_capability',
      'malformed_result',
      'refusal',
      'timeout',
    ]);
    expect([...new Set(cases.map((item) => item.outcome))].sort()).toEqual(OUTCOMES);
  });

  for (const item of cases) {
    const role = item.role ?? 'proposer';
    it(`${item.outcome} for the ${role}: accepted with 202, then posted once with a valid envelope`, async () => {
      const assembled = role === 'critic' ? await critiqueRequest() : await formulationRequest();
      const started = await start(await item.scenario(), item.world);
      started.world.api.store(assembled.bytes);
      const dispatch = dispatchFor(assembled, { role, attempt: `attempt-${item.outcome}`, ...item.dispatch });
      const response = await started.send(dispatch);
      expect(response.status).toBe(202);
      if (item.cancel) {
        await until(() => started.world.cli.calls().some((call) => call.kind === 'run'));
        expect(started.runner.cancel(dispatch.identity.attempt.attempt_id)).toBe(true);
      }
      await started.runner.idle();
      const result = posted(started.world);
      expect(result.outcome).toMatchObject({ outcome: item.outcome, ...item.detail });
      expect(result.attempt).toEqual(dispatch.identity.attempt);
      expect(result.provenance.bundle_hash).toBe(BUNDLE_HASH);
      // Only a completion carries role output.
      expect('output' in result.outcome).toBe(item.outcome === 'completion');
      // The host wrote provenance, outcome and usage: none of it came from the model's text.
      expect(JSON.stringify(result)).not.toContain('Here is a strategy in words');
    });
  }
});

describe('a dispatch that names another behaviour bundle', () => {
  const other = `sha256:${'9'.repeat(64)}`;

  it('is claimed, recorded as a bundle mismatch and never reaches the executor', async () => {
    const assembled = await formulationRequest();
    const started = await start({ behaviour: 'result', resultText: JSON.stringify(await revisionOutput()) });
    started.world.api.store(assembled.bytes);
    const response = await started.send(dispatchFor(assembled, { bundleHash: other }));
    expect(response.status).toBe(202);
    await started.runner.idle();
    const result = posted(started.world);
    expect(result.outcome).toMatchObject({ outcome: 'denied_capability', reason: 'BUNDLE_MISMATCH' });
    const diagnostic = result.outcome.outcome === 'denied_capability' ? result.outcome.diagnostic : '';
    expect(diagnostic).toContain(other);
    expect(diagnostic).toContain(BUNDLE_HASH);
    // Not even the version was asked, the request was not read, and nothing was stored.
    expect(started.world.cli.calls()).toEqual([]);
    expect(started.world.api.events).toEqual(['claim', 'post']);
    expect(started.world.api.artefacts.size).toBe(0);
    // The result still names the bundle that the dispatch asked for, so the API can bind it to the attempt.
    expect(result.provenance.bundle_hash).toBe(other);
  });

  it('is not run on another attempt either: the same runner serves the next dispatch with the right bundle', async () => {
    const assembled = await formulationRequest();
    const started = await start({ behaviour: 'result', resultText: JSON.stringify(await revisionOutput()) });
    started.world.api.store(assembled.bytes);
    await started.send(dispatchFor(assembled, { attempt: 'attempt-a', bundleHash: other }));
    await started.runner.idle();
    await started.send(dispatchFor(assembled, { attempt: 'attempt-b' }));
    await started.runner.idle();
    expect(started.world.api.results.map((result) => result.outcome.outcome)).toEqual([
      'denied_capability',
      'completion',
    ]);
  });
});

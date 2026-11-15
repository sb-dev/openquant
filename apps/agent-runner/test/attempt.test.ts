import { readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BUNDLE_HASH,
  PROCEDURES,
  RESULT_SCHEMAS,
  type StrategyCritiqueRequest,
  type StrategyFormulationRequest,
} from '@openquant/agents';
import type { AgentAttemptResult, AgentDispatch, AttemptClaimGrant } from '@openquant/api-contracts';
import { validateContract } from '@openquant/api-contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyEdits, proposedForm, seedArtefact } from '../../../packages/agents/dev/world.ts';
import { sha256Text, stable } from '../../../packages/agents/test/support/oracle.ts';
import {
  BREAK_EVEN,
  claims,
  critiqueOutput,
  finding,
  revisionOutput,
  SEED_FOUR,
  SEED_ONE,
  THRESHOLD,
} from '../../../packages/agents/test/support/requests.ts';
import { type AttemptDeps, runAttempt } from '../src/attempt.ts';
import { instructionsFor } from '../src/bundle.ts';
import { type ExecutionFacts, type ExecutionRequest, execute } from '../src/executor.ts';
import { sha256Bytes } from '../src/text.ts';
import {
  API_TOKEN,
  type Assembled,
  apiFailure,
  CAPABILITY,
  cleanup,
  craftedRequest,
  critiqueRequest,
  DISPATCH_TOKEN,
  type DispatchOptions,
  dispatchFor,
  formulationRequest,
  HOST_SECRET,
  MODEL_KEY,
  makeWorld,
  type Scenario,
  storedRequest,
  type World,
} from './support/world.ts';

afterEach(cleanup);

/** What a fake executor reports for a run that started. */
const STARTED: ExecutionFacts = {
  executorVersion: '2.1.325',
  sessionId: undefined,
  model: undefined,
  provider: undefined,
  effort: undefined,
  costUsd: undefined,
  inputTokens: undefined,
  outputTokens: undefined,
  durationMs: 1,
  started: true,
};

interface Context {
  readonly world: World;
  readonly dispatch: AgentDispatch;
  readonly deps: AttemptDeps;
  readonly logs: string[];
}

interface Setup {
  role?: 'proposer' | 'critic';
  /** A stored request to use instead of the one that assembly builds. */
  assembled?: Assembled<StrategyFormulationRequest | StrategyCritiqueRequest>;
  dispatch?: DispatchOptions;
  world?: Parameters<typeof makeWorld>[1];
  storeRequest?: boolean;
  mutateDispatch?: (dispatch: AgentDispatch) => AgentDispatch;
}

async function setup(scenario: Scenario, options: Setup = {}): Promise<Context> {
  const assembled =
    options.assembled ?? (options.role === 'critic' ? await critiqueRequest() : await formulationRequest());
  const world = makeWorld(scenario, options.world);
  if (options.storeRequest !== false) world.api.store(assembled.bytes);
  const base = dispatchFor(assembled, { role: options.role ?? 'proposer', ...options.dispatch });
  const dispatch = options.mutateDispatch ? options.mutateDispatch(base) : base;
  const logs: string[] = [];
  let clock = Date.UTC(2026, 10, 15, 10, 0, 0);
  const deps: AttemptDeps = {
    config: world.config,
    api: world.api,
    execute: (request) => execute(world.config.executor, request),
    now: () => {
      clock += 1000;
      return clock;
    },
    log: (event, fields) => logs.push(JSON.stringify({ event, ...fields })),
    sleep: async () => undefined,
  };
  return { world, dispatch, deps, logs };
}

function grantFor(dispatch: AgentDispatch): AttemptClaimGrant {
  return {
    schema_version: 'attempt-claim/1',
    form: 'grant',
    attempt: dispatch.identity.attempt,
    granted_at: '2026-11-15T10:00:00Z',
    lease_expires_at: '2026-11-15T10:20:00Z',
    capability: { token: CAPABILITY },
  };
}

function go(context: Context, signal: AbortSignal = new AbortController().signal) {
  return runAttempt(context.dispatch, grantFor(context.dispatch), context.deps, signal);
}

/** No secret of the runner, the model or the attempt appears in what was posted or logged. */
function expectNoSecrets(context: Context): void {
  const text = JSON.stringify(context.world.api.results) + context.logs.join('\n');
  for (const secret of [MODEL_KEY, HOST_SECRET, DISPATCH_TOKEN, API_TOKEN, CAPABILITY])
    expect(text).not.toContain(secret);
}

function posted(context: Context): AgentAttemptResult {
  const [result] = context.world.api.results;
  if (!result) throw new Error('no result was posted');
  expect(context.world.api.results).toHaveLength(1);
  // Whatever the runner posts passes the shared validator.
  expect(validateContract('agent-attempt-result', result).ok).toBe(true);
  return result;
}

const reply = (output: unknown, extra: Partial<Scenario> = {}): Scenario => ({
  behaviour: 'result',
  resultText: JSON.stringify(output),
  ...extra,
});

describe('a completed proposer attempt', () => {
  it('validates the output, stores it under its digest and posts a completion with host-captured provenance', async () => {
    const output = await revisionOutput();
    const context = await setup(reply(output));
    const end = await go(context);
    expect(end).toEqual({ posted: true, outcome: 'completion' });

    const result = posted(context);
    expect(result.outcome.outcome).toBe('completion');
    if (result.outcome.outcome !== 'completion') return;
    // The stored role output is the canonical text of the output, hashed here without the runner's code.
    const expectedText = stable(output);
    const expectedDigest = sha256Text(expectedText);
    expect(result.outcome.output).toEqual({
      contract: 'strategy-formulation.result/1',
      artefact: { digest: expectedDigest, media_type: 'application/json', size_bytes: Buffer.byteLength(expectedText) },
    });
    expect(Buffer.from(context.world.api.artefacts.get(expectedDigest) ?? []).toString('utf8')).toBe(expectedText);

    expect(result.attempt).toEqual({ attempt_id: 'attempt-1', ownership_revision: 1 });
    expect(result.provenance).toEqual({
      session_id: 'session-attempt-1',
      input_hash: context.dispatch.inputs.request.artefact.digest,
      bundle_hash: BUNDLE_HASH,
      executor_version: { status: 'reported', value: '2.1.325' },
      provider: { status: 'reported', value: 'firstParty' },
      model: { status: 'reported', value: 'claude-opus-5-5' },
      // The fake reports no effort, so it stays unknown and is not inferred from the profile.
      effort: { status: 'unknown' },
      runner: context.world.config.identity,
    });
    expect(result.usage).toMatchObject({
      cost: { label: 'estimated', amount: '0.0123456', currency: 'USD' },
      input_tokens: { label: 'observed', count: 115 },
      output_tokens: { label: 'observed', count: 20 },
    });
    expect(result.usage.duration).toMatchObject({ label: 'observed' });
    expect(result.started_at < result.finished_at || result.started_at === result.finished_at).toBe(true);
    expectNoSecrets(context);
  });

  it('claims nothing itself, reads the input with the attempt capability, and stores before it posts', async () => {
    const context = await setup(reply(await revisionOutput()));
    await go(context);
    expect(context.world.api.events).toEqual(['fetch', 'put', 'post']);
    expect(new Set(context.world.api.capabilities)).toEqual(new Set([CAPABILITY]));
  });

  it('hands the executor the stored request bytes, not a copy of its own', async () => {
    const context = await setup({ behaviour: 'echo-stdin' });
    // The echoed request is not a valid proposal, so the attempt ends malformed; the point is what the CLI received.
    await go(context);
    const call = context.world.cli.calls().find((entry) => entry.kind === 'run');
    expect(call?.stdinSha256).toBe(context.dispatch.inputs.request.artefact.digest);
    expect(call?.stdinBytes).toBe(context.dispatch.inputs.request.artefact.size_bytes);
  });

  it('gives the executor the procedure of the role and its result schema, both from the built-in bundle module', async () => {
    const context = await setup(reply(await revisionOutput()));
    await go(context);
    const args = context.world.cli.calls().find((entry) => entry.kind === 'run')?.args ?? [];
    const prompt = args.find((argument) => argument.startsWith('--system-prompt=')) ?? '';
    expect(prompt).toBe(`--system-prompt=${instructionsFor('strategy-formulation')}`);
    expect(prompt).toContain('skill: strategy-formulation');
    expect(prompt).toContain(JSON.stringify(RESULT_SCHEMAS['strategy-formulation.result']));
    expect(prompt).not.toContain('skill: strategy-critique');
    expect(prompt).not.toContain('StrategyCritiqueResult');
  });
});

describe('a completed critic attempt', () => {
  it('posts a completion of the critique contract', async () => {
    const output = critiqueOutput(finding());
    const context = await setup(reply(output, { reportedModel: 'claude-opus-5-5' }), { role: 'critic' });
    expect(await go(context)).toEqual({ posted: true, outcome: 'completion' });
    const result = posted(context);
    expect(result.outcome).toMatchObject({ outcome: 'completion', output: { contract: 'strategy-critique.result/1' } });
    expect(context.world.api.artefacts.has(sha256Text(stable(output)))).toBe(true);
    const args = context.world.cli.calls().find((entry) => entry.kind === 'run')?.args ?? [];
    const prompt = args.find((argument) => argument.startsWith('--system-prompt=')) ?? '';
    expect(prompt).toContain('skill: strategy-critique');
    expect(prompt).toContain(JSON.stringify(RESULT_SCHEMAS['strategy-critique.result']));
    expect(prompt).not.toContain('StrategyFormulationResult');
  });

  it('accepts an empty finding list as a completion and does not turn it into an approval', async () => {
    const context = await setup(reply(critiqueOutput()), { role: 'critic' });
    expect(await go(context)).toEqual({ posted: true, outcome: 'completion' });
    expect(JSON.stringify(posted(context))).not.toMatch(/approv/i);
  });
});

describe('output that the shared validator refuses', () => {
  const cases: readonly [string, () => Promise<Scenario>, string][] = [
    [
      'text that is not JSON',
      async () => ({ behaviour: 'result', resultText: 'Here is my proposal: ...' }),
      'NOT_JSON',
    ],
    [
      'JSON in a code fence',
      async () => ({
        behaviour: 'result',
        resultText: `\`\`\`json\n${JSON.stringify(await revisionOutput())}\n\`\`\``,
      }),
      'NOT_JSON',
    ],
    [
      'a field that the schema does not know',
      async () => reply({ ...(await revisionOutput()), approval: 'approved' }),
      'SCHEMA_INVALID',
    ],
    [
      'an unknown version tag',
      async () => reply({ ...(await revisionOutput()), schema_version: 'strategy-formulation.result/2' }),
      'SCHEMA_INVALID',
    ],
    [
      'a source the request does not hold',
      async () => reply(await revisionOutput({ source_refs: ['ev-unknown'] })),
      'REFERENCE_INVALID',
    ],
    [
      'rule changes that are not the difference from the parent',
      async () =>
        reply(
          await revisionOutput({
            rule_changes: [{ path: '/definition/indicators/5/expr/params/value', from: '30', to: '31' }],
          }),
        ),
      'RULE_CHANGES_MISMATCH',
    ],
  ];

  for (const [name, scenario, reason] of cases) {
    it(`posts a malformed result for ${name}, and stores nothing`, async () => {
      const context = await setup(await scenario());
      const end = await go(context);
      expect(end).toEqual({ posted: true, outcome: 'malformed_result', reason });
      const result = posted(context);
      expect(result.outcome).toMatchObject({ outcome: 'malformed_result', reason });
      expect(result.outcome.outcome === 'malformed_result' && result.outcome.diagnostic.length).toBeGreaterThan(0);
      expect(context.world.api.artefacts.size).toBe(0);
      expect(context.world.api.events).not.toContain('put');
      // The model ran, so its cost is the executor's report and not a measured zero.
      expect(result.usage.cost).toMatchObject({ label: 'estimated' });
    });
  }

  it('refuses a critic finding that points outside the registered strategy', async () => {
    const context = await setup(
      reply(critiqueOutput(finding({ affected_elements: ['/definition/no/such/element'] }))),
      { role: 'critic' },
    );
    expect(await go(context)).toEqual({ posted: true, outcome: 'malformed_result', reason: 'REFERENCE_INVALID' });
  });

  it('refuses output that is over the dispatch output limit', async () => {
    const context = await setup(reply(await revisionOutput()), { dispatch: { outputLimitBytes: 64 } });
    expect(await go(context)).toEqual({ posted: true, outcome: 'malformed_result', reason: 'OUTPUT_LIMIT_EXCEEDED' });
  });
});

describe('outcomes of the executor', () => {
  it('posts a refusal when the model declines, and does not retry it', async () => {
    const context = await setup({
      behaviour: 'result',
      resultText: "I can't do that.",
      report: { stop_reason: 'refusal' },
    });
    expect(await go(context)).toEqual({ posted: true, outcome: 'refusal' });
  });

  it('posts an authentication failure when the executor rejects the credential', async () => {
    const context = await setup({
      behaviour: 'result',
      report: { is_error: true, api_error_status: 401, result: 'Invalid API key' },
      exitCode: 1,
    });
    expect(await go(context)).toEqual({
      posted: true,
      outcome: 'authentication_failure',
      reason: 'CREDENTIAL_REJECTED',
    });
    expectNoSecrets(context);
  });

  it('posts an authentication failure without starting the model when the credential is not set', async () => {
    const context = await setup(reply({}), { world: {} });
    const { ANTHROPIC_API_KEY: _key, ...rest } = context.world.config.executor.hostEnv;
    const deps = {
      ...context.deps,
      execute: (request: Parameters<typeof execute>[1]) =>
        execute({ ...context.world.config.executor, hostEnv: rest }, request),
    };
    const end = await runAttempt(context.dispatch, grantFor(context.dispatch), deps, new AbortController().signal);
    expect(end).toEqual({ posted: true, outcome: 'authentication_failure', reason: 'CREDENTIAL_MISSING' });
    expect(context.world.cli.calls().filter((call) => call.kind === 'run')).toEqual([]);
    expect(posted(context).usage.cost).toMatchObject({ label: 'observed', amount: '0' });
  });

  it('posts a timeout at the deadline of the dispatch, with unknown cost and tokens', async () => {
    const context = await setup({ behaviour: 'hang' }, { dispatch: { timeoutSeconds: 1 } });
    expect(await go(context)).toEqual({ posted: true, outcome: 'timeout' });
    const result = posted(context);
    expect(result.usage.cost).toMatchObject({ label: 'unknown' });
    expect(result.usage.input_tokens).toMatchObject({ label: 'unknown' });
    expect(result.usage.duration).toMatchObject({ label: 'observed' });
  });

  it('posts a malformed result with the overflow reason when the output is far over the limit, and ends the tree', async () => {
    const context = await setup({ behaviour: 'flood' }, { dispatch: { outputLimitBytes: 1024 } });
    expect(await go(context)).toEqual({ posted: true, outcome: 'malformed_result', reason: 'OUTPUT_LIMIT_EXCEEDED' });
  });

  it('posts an identity mismatch when the executor reports another session than the attempt, never a completion', async () => {
    const context = await setup(
      reply(await revisionOutput(), { reportedSession: '11111111-1111-4111-8111-111111111111' }),
    );
    expect(await go(context)).toEqual({ posted: true, outcome: 'malformed_result', reason: 'IDENTITY_MISMATCH' });
    expect(context.world.api.artefacts.size).toBe(0);
  });

  it('posts an identity mismatch when the executor reports another model than the requested one', async () => {
    const context = await setup(reply(await revisionOutput(), { reportedModel: 'claude-sonnet-5-5' }));
    expect(await go(context)).toEqual({ posted: true, outcome: 'malformed_result', reason: 'IDENTITY_MISMATCH' });
  });

  it('posts a cancellation when the attempt is cancelled while the executor runs', async () => {
    const context = await setup({ behaviour: 'hang' });
    const controller = new AbortController();
    const running = go(context, controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 600));
    controller.abort('cancel');
    expect(await running).toEqual({ posted: true, outcome: 'cancellation' });
  });

  it('posts nothing when the runner shuts down: a cancellation is final and a shutdown must be retried', async () => {
    const context = await setup({ behaviour: 'hang' });
    const controller = new AbortController();
    const running = go(context, controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 600));
    controller.abort('shutdown');
    expect(await running).toMatchObject({ posted: false, why: 'shutdown' });
    expect(context.world.api.results).toEqual([]);
  });
});

describe('what is denied before the executor starts', () => {
  async function denied(context: Context, reason: string, runs = 0) {
    const end = await go(context);
    expect(end).toEqual({ posted: true, outcome: 'denied_capability', reason });
    const result = posted(context);
    // The model was never called, so the usage is a measured zero and the reservation can be released.
    expect(result.usage).toMatchObject({
      cost: { label: 'observed', amount: '0', currency: 'USD' },
      input_tokens: { label: 'observed', count: 0 },
      output_tokens: { label: 'observed', count: 0 },
    });
    expect(context.world.cli.calls().filter((call) => call.kind === 'run')).toHaveLength(runs);
    expectNoSecrets(context);
    return result;
  }

  it('refuses every dispatch while execution is disabled, and starts nothing at all', async () => {
    const context = await setup(reply(await revisionOutput()), { world: { enabled: false } });
    await denied(context, 'EXECUTION_DISABLED');
    expect(context.world.cli.calls()).toEqual([]);
    expect(context.world.api.events).toEqual(['post']);
  });

  it('denies a missing executable', async () => {
    const context = await setup(reply({}), { world: { executor: { path: '/nonexistent/claude' } } });
    await denied(context, 'EXECUTABLE_MISSING');
  });

  it('denies an installed executor of another version than the pinned one, after asking its version once', async () => {
    const context = await setup({ behaviour: 'result', version: '2.0.1' });
    await denied(context, 'CAPABILITY_UNSUPPORTED');
    expect(context.world.cli.calls().map((call) => call.kind)).toEqual(['version']);
  });

  it('denies a dispatch that names another executor version than the pinned one, without asking the executor', async () => {
    const context = await setup(reply({}), { dispatch: { executorVersion: '2.2.0' } });
    await denied(context, 'CAPABILITY_UNSUPPORTED');
    expect(context.world.cli.calls()).toEqual([]);
  });

  it('denies a cost reservation in another currency than the one the executor reports', async () => {
    const context = await setup(reply({}), { dispatch: { currency: 'EUR' } });
    await denied(context, 'CAPABILITY_UNSUPPORTED');
  });

  it('denies a dispatch that names another bundle than the one installed, with a bundle mismatch', async () => {
    const context = await setup(reply({}), { dispatch: { bundleHash: `sha256:${'b'.repeat(64)}` } });
    const result = await denied(context, 'BUNDLE_MISMATCH');
    expect(result.outcome.outcome === 'denied_capability' && result.outcome.diagnostic).toContain(BUNDLE_HASH);
    // The record stays bound to the bundle that was dispatched.
    expect(result.provenance.bundle_hash).toBe(`sha256:${'b'.repeat(64)}`);
  });

  it('denies an installed bundle that differs from its manifest, and an extra file in it', async () => {
    const changed = await setup(reply({}));
    writeFileSync(
      join(changed.world.bundleDir, 'src/skills/strategy-formulation/procedure.md'),
      'replaced instructions',
    );
    await denied(changed, 'BUNDLE_MISMATCH');

    const extra = await setup(reply({}));
    writeFileSync(join(extra.world.bundleDir, 'expected.json'), '{}');
    const result = await denied(extra, 'BUNDLE_MISMATCH');
    expect(result.outcome.outcome === 'denied_capability' && result.outcome.diagnostic).toContain('expected.json');
  });

  it('denies a model profile that no configuration of the role registers', async () => {
    const context = await setup(reply({}), { dispatch: { model: 'claude-haiku-9' } });
    await denied(context, 'CAPABILITY_UNSUPPORTED');
  });

  it('denies a role that does not match the skill', async () => {
    const context = await setup(reply({}), {
      mutateDispatch: (dispatch) => ({ ...dispatch, identity: { ...dispatch.identity, role: 'critic' } }),
    });
    const result = await denied(context, 'CAPABILITY_DENIED');
    expect(result.outcome.outcome === 'denied_capability' && result.outcome.diagnostic).toContain(
      'ROLE_SKILL_MISMATCH',
    );
  });

  it('denies holdout exclusions that differ from the exclusions of the request', async () => {
    const context = await setup(reply({}), {
      mutateDispatch: (dispatch) => ({ ...dispatch, inputs: { ...dispatch.inputs, holdout_exclusions: [] } }),
    });
    const result = await denied(context, 'CAPABILITY_DENIED');
    expect(result.outcome.outcome === 'denied_capability' && result.outcome.diagnostic).toContain('HOLDOUT_EXCLUSIONS');
  });

  it('denies a result route that is not the route of the attempt', async () => {
    const context = await setup(reply({}), {
      mutateDispatch: (dispatch) => ({ ...dispatch, result_route: '/v1/attempts/other-attempt/agent-result' }),
    });
    const result = await denied(context, 'CAPABILITY_DENIED');
    expect(result.outcome.outcome === 'denied_capability' && result.outcome.diagnostic).toContain(
      'RESULT_ROUTE_MISMATCH',
    );
  });

  it('denies a stored request that is not the request the dispatch names, even when it is a valid request', async () => {
    const context = await setup(reply({}), { storeRequest: false });
    // Another valid request sits under the digest that the dispatch names: the critic request of the same pilot.
    const other = await critiqueRequest();
    context.world.api.stored.set(context.dispatch.inputs.request.artefact.digest, other.bytes);
    const result = await denied(context, 'CAPABILITY_DENIED');
    expect(result.outcome.outcome === 'denied_capability' && result.outcome.diagnostic).toContain(
      'digest or size differs',
    );
  });

  it('denies a request artefact that the API does not hold', async () => {
    const context = await setup(reply({}), { storeRequest: false });
    await denied(context, 'CAPABILITY_DENIED');
  });

  it('denies a request that matches its digest and does not satisfy the request schema', async () => {
    const context = await setup(reply({}), { storeRequest: false });
    const bytes = Buffer.from('{"schema_version":"strategy-formulation.request/1"}');
    context.world.api.stored.set(sha256Bytes(bytes), bytes);
    const mutated = {
      ...context.dispatch,
      inputs: {
        ...context.dispatch.inputs,
        request: {
          ...context.dispatch.inputs.request,
          artefact: { digest: sha256Bytes(bytes), media_type: 'application/json', size_bytes: bytes.length },
        },
      },
    };
    const deps = context.deps;
    const end = await runAttempt(mutated, grantFor(mutated), deps, new AbortController().signal);
    expect(end).toEqual({ posted: true, outcome: 'denied_capability', reason: 'CAPABILITY_DENIED' });
    expect(context.world.cli.calls()).toEqual([]);
  });
});

describe('failures of the runner are not outcomes', () => {
  it('retries a transient failure to read the request and then completes', async () => {
    const context = await setup(reply(await revisionOutput()), {
      world: { apiOptions: { transientInputFailures: 2 } },
    });
    expect(await go(context)).toEqual({ posted: true, outcome: 'completion' });
    expect(context.world.api.events.filter((event) => event === 'fetch')).toHaveLength(3);
  });

  it('posts nothing when the request cannot be read after the retries: recovery fences a new attempt', async () => {
    // An unavailable API, a body that broke off while it was read, and a redirect that is never followed.
    for (const input of [apiFailure(503, 'UNAVAILABLE'), apiFailure(200, 'NETWORK'), apiFailure(302, 'UNAVAILABLE')]) {
      const context = await setup(reply({}), { world: { apiOptions: { input } } });
      expect(await go(context), input.code).toMatchObject({ posted: false, why: 'api_unavailable' });
      expect(context.world.api.events.filter((event) => event === 'fetch')).toHaveLength(4);
      expect(context.world.api.results).toEqual([]);
      expect(context.world.cli.calls()).toEqual([]);
    }
  });

  it('denies the capability only for a request body above the role limit', async () => {
    const context = await setup(reply({}), { world: { apiOptions: { input: apiFailure(200, 'TOO_LARGE') } } });
    expect(await go(context)).toEqual({ posted: true, outcome: 'denied_capability', reason: 'CAPABILITY_DENIED' });
    expect(context.world.cli.calls()).toEqual([]);
  });

  it('posts nothing when the lease is already lost while it reads the request', async () => {
    const context = await setup(reply({}), { world: { apiOptions: { input: apiFailure(409, 'LEASE_EXPIRED') } } });
    expect(await go(context)).toMatchObject({ posted: false, why: 'lease_lost' });
    expect(context.world.api.results).toEqual([]);
  });

  it('starts nothing and posts nothing when the lease expired before the executor could start', async () => {
    const context = await setup(reply(await revisionOutput()));
    // The grant runs to 10:20. The input read takes 21 minutes, so the lease is gone before the executor starts.
    let clock = Date.UTC(2026, 10, 15, 10, 0, 0);
    const fetchInput = context.world.api.fetchInput.bind(context.world.api);
    context.world.api.fetchInput = async (...args) => {
      clock += 21 * 60_000;
      return fetchInput(...args);
    };
    const calls: ExecutionRequest[] = [];
    const deps: AttemptDeps = {
      ...context.deps,
      now: () => clock,
      execute: async (request) => {
        calls.push(request);
        throw new Error('the executor must not start');
      },
    };
    const end = await runAttempt(context.dispatch, grantFor(context.dispatch), deps, new AbortController().signal);
    expect(end).toEqual({ posted: false, why: 'lease_lost', detail: 'the lease expired before the executor started' });
    expect(calls).toEqual([]);
    expect(context.world.api.events).toEqual(['fetch']);
    expect(context.world.api.results).toEqual([]);
  });

  it('ends the executor at the lease expiry, not at the full timeout, and posts nothing', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      // A timeout of one hour, and a lease that ends five minutes after the executor starts at 10:15.
      const context = await setup(reply(await revisionOutput()), { dispatch: { timeoutSeconds: 3600 } });
      let started!: () => void;
      const running = new Promise<void>((resolve) => {
        started = resolve;
      });
      let seen: ExecutionRequest | undefined;
      let killed = false;
      const deps: AttemptDeps = {
        ...context.deps,
        now: () => Date.UTC(2026, 10, 15, 10, 15, 0),
        execute: (request) => {
          seen = request;
          started();
          return new Promise((resolve) => {
            request.signal?.addEventListener('abort', () => {
              killed = true;
              resolve({ kind: 'cancelled', diagnostic: 'the process tree was ended', facts: STARTED });
            });
          });
        },
      };
      const end = runAttempt(context.dispatch, grantFor(context.dispatch), deps, new AbortController().signal);
      await running;
      expect(seen?.timeoutMs).toBe(5 * 60_000);
      await vi.advanceTimersByTimeAsync(5 * 60_000 - 1);
      expect(killed).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(killed).toBe(true);
      expect(seen?.signal?.reason).toBe('lease_expired');
      expect(await end).toEqual({
        posted: false,
        why: 'lease_lost',
        detail: 'the lease expired while the executor ran; it was ended',
      });
      expect(context.world.api.results).toEqual([]);
      expect(context.logs.join('\n')).toContain('"stage":"during_execution"');
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not post a completion whose output could not be stored', async () => {
    const context = await setup(reply(await revisionOutput()), {
      world: { apiOptions: { artefact: apiFailure(409, 'STALE_OWNERSHIP') } },
    });
    expect(await go(context)).toMatchObject({ posted: false, why: 'lease_lost' });
    expect(context.world.api.results).toEqual([]);
  });

  it.each([
    ['LEASE_EXPIRED', 409],
    ['STALE_OWNERSHIP', 409],
  ] as const)('a late completion rejected with %s ends the attempt and is not retried', async (code, status) => {
    const context = await setup(reply(await revisionOutput()), {
      world: { apiOptions: { result: apiFailure(status, code) } },
    });
    const end = await go(context);
    expect(end).toMatchObject({ posted: false, why: 'lease_lost' });
    expect(context.world.api.events.filter((event) => event === 'post')).toHaveLength(1);
    expect(context.world.api.results).toEqual([]);
  });

  it('retries a transient failure to post the result and stops at a permanent one', async () => {
    const transient = await setup(reply(await revisionOutput()), {
      world: { apiOptions: { result: apiFailure(503, 'UNAVAILABLE') } },
    });
    expect(await go(transient)).toMatchObject({ posted: false, why: 'api_unavailable' });
    expect(transient.world.api.events.filter((event) => event === 'post')).toHaveLength(4);

    const permanent = await setup(reply(await revisionOutput()), {
      world: { apiOptions: { result: apiFailure(422, 'IDENTITY_MISMATCH') } },
    });
    expect(await go(permanent)).toMatchObject({ posted: false, why: 'internal_error' });
    expect(permanent.world.api.events.filter((event) => event === 'post')).toHaveLength(1);
  });

  it('posts nothing and kills the executor when the runner itself fails', async () => {
    const context = await setup(reply(await revisionOutput()));
    const deps: AttemptDeps = {
      ...context.deps,
      execute: async () => {
        throw new Error('unexpected failure with secret sk-ant-api03-ABCDEFGHIJKLMNOP');
      },
    };
    const end = await runAttempt(context.dispatch, grantFor(context.dispatch), deps, new AbortController().signal);
    expect(end).toMatchObject({ posted: false, why: 'internal_error' });
    expect(context.world.api.results).toEqual([]);
    expect(context.logs.join('\n')).not.toContain('sk-ant-api03-ABCDEFGHIJKLMNOP');
  });

  it('never posts an envelope that the shared validator rejects', async () => {
    const context = await setup(reply(await revisionOutput()));
    const broken = { ...context.world.config, identity: { ...context.world.config.identity, digest: 'not-a-digest' } };
    const end = await runAttempt(
      context.dispatch,
      grantFor(context.dispatch),
      { ...context.deps, config: broken },
      new AbortController().signal,
    );
    expect(end).toMatchObject({ posted: false, why: 'internal_error' });
    expect(context.world.api.results).toEqual([]);
    expect(context.logs.join('\n')).toContain('result_invalid');
  });
});

describe('the scratch space', () => {
  it('leaves no attempt directory behind after a completion, a failure or a timeout', async () => {
    for (const scenario of [
      reply(await revisionOutput()),
      { behaviour: 'raw', stdout: 'x', exitCode: 1 } as Scenario,
      { behaviour: 'hang' } as Scenario,
    ]) {
      const context = await setup(scenario, { dispatch: { timeoutSeconds: 1 } });
      await go(context);
      expect(readdirSync(context.world.scratchRoot)).toEqual([]);
    }
  });
});

describe('a stored request that request assembly would not have built', () => {
  // The API stores the request that assembly returned. The runner does not trust that: it runs the checks of assembly
  // again on the bytes it was given, before the dispatch checks and long before an executor starts.
  // The members that the cases change, as both roles share them (the two request types do not intersect).
  interface Loose {
    context: { holdout_exclusions: { window: string }[]; operators: { permitted: unknown[] } };
    supplied_methods: unknown[];
    evidence_refs: { content: string; kind: string }[];
    subject: { proposal_kind?: string; parent_hash?: string; strategy_hash?: string };
  }
  type Craft = (copy: Loose) => void;
  const cases: readonly [string, 'proposer' | 'critic', Craft, string][] = [
    [
      'a document that is valid JSON of the schema and not the canonical text of assembly',
      'proposer',
      () => undefined,
      'REQUEST_NOT_CANONICAL',
    ],
    [
      'exclusions that do not name the validation window',
      'proposer',
      (copy) => {
        copy.context.holdout_exclusions = copy.context.holdout_exclusions.filter(
          (item) => item.window !== 'VALIDATION',
        );
      },
      'HOLDOUT_EXCLUSIONS_INVALID',
    ],
    [
      'permitted operators that are not the operators of the frozen policy',
      'critic',
      (copy) => {
        copy.context.operators.permitted.pop();
      },
      'OPERATORS_MISMATCH',
    ],
    [
      'a method that the bundle does not supply',
      'proposer',
      (copy) => {
        copy.supplied_methods.push({
          id: 'm-1',
          rule_origin: 'primary_checked',
          category: 'method_advice',
          scope: 'seed',
        });
      },
      'METHODS_MISMATCH',
    ],
    [
      'evidence that names a day inside the holdout window',
      'critic',
      (copy) => {
        for (const item of copy.evidence_refs) item.content = 'The weak week of 2025-03-14.';
      },
      'HOLDOUT_OVERLAP',
    ],
    [
      'a parent hash that is not the digest of the parent',
      'proposer',
      (copy) => {
        if (copy.subject.proposal_kind === 'controlled_revision') copy.subject.parent_hash = `sha256:${'0'.repeat(64)}`;
      },
      'PARENT_HASH_MISMATCH',
    ],
    [
      'an unregistered draft: a strategy hash that is not the digest of the strategy',
      'critic',
      (copy) => {
        copy.subject.strategy_hash = `sha256:${'f'.repeat(64)}`;
      },
      'STRATEGY_HASH_MISMATCH',
    ],
    [
      'run metrics as critic evidence',
      'critic',
      (copy) => {
        for (const item of copy.evidence_refs) item.kind = 'evaluation_metrics';
      },
      'EVIDENCE_NOT_PERMITTED',
    ],
  ];

  for (const [name, role, craft, code] of cases) {
    it(`denies ${name} with the refusal ${code}, and starts nothing`, async () => {
      const base = role === 'critic' ? await critiqueRequest() : await formulationRequest();
      let assembled: Assembled<StrategyFormulationRequest | StrategyCritiqueRequest>;
      if (code === 'REQUEST_NOT_CANONICAL') {
        // The same document, pretty-printed: it satisfies the schema, but it is not what assembly writes.
        assembled = storedRequest(base.request, Buffer.from(JSON.stringify(base.request, null, 2), 'utf8'));
      } else {
        assembled = await craftedRequest<StrategyFormulationRequest | StrategyCritiqueRequest>(base, (copy) =>
          craft(copy as unknown as Loose),
        );
      }
      const context = await setup(reply(role === 'critic' ? critiqueOutput() : await revisionOutput()), {
        role,
        assembled,
      });
      expect(await go(context)).toEqual({ posted: true, outcome: 'denied_capability', reason: 'CAPABILITY_DENIED' });
      const result = posted(context);
      const diagnostic = result.outcome.outcome === 'denied_capability' ? result.outcome.diagnostic : '';
      expect(diagnostic).toContain(`not a request that assembly builds: ${code}`);
      // Not even the version probe ran, and nothing was stored: the executor was never asked.
      expect(context.world.cli.calls()).toEqual([]);
      expect(context.world.api.events).toEqual(['fetch', 'post']);
      expect(result.usage.cost).toMatchObject({ label: 'observed', amount: '0' });
    });
  }

  it('counts the further refusals and names only the first', async () => {
    const base = await formulationRequest();
    const assembled = await craftedRequest(base, (copy) => {
      copy.context.holdout_exclusions = [];
      copy.context.operators.permitted.pop();
    });
    const context = await setup(reply(await revisionOutput()), { assembled });
    await go(context);
    const result = posted(context);
    expect(result.outcome.outcome === 'denied_capability' && result.outcome.diagnostic).toMatch(/\(and \d+ more\)/);
  });

  it('builds the executor instructions from the procedure that the verified request carries', async () => {
    const context = await setup(reply(await revisionOutput()));
    await go(context);
    const args = context.world.cli.calls().find((entry) => entry.kind === 'run')?.args ?? [];
    expect(args).toContain(
      `--system-prompt=${instructionsFor('strategy-formulation', PROCEDURES['strategy-formulation'])}`,
    );
  });
});

describe('output that is valid JSON of the schema and carries blockers', () => {
  const operatorEdit = [{ op: 'replace' as const, path: '/definition/indicators/0/expr/op', value: 'operator:ema@1' }];

  it('is a completion with a logged notice when it uses an operator outside the permitted set: Rust validates it', async () => {
    const output = await revisionOutput({
      strategy: applyEdits(proposedForm(seedArtefact(SEED_ONE)), operatorEdit),
      rule_changes: [{ path: '/definition/indicators/0/expr/op', from: 'operator:sma@1', to: 'operator:ema@1' }],
    });
    const context = await setup(reply(output));
    expect(await go(context)).toEqual({ posted: true, outcome: 'completion' });
    const result = posted(context);
    expect(result.outcome.outcome).toBe('completion');
    // The draft is stored for the Rust core, whose INVALID diagnostics go to the next proposer attempt.
    expect(context.world.api.artefacts.size).toBe(1);
    expect(context.logs.join('\n')).toContain('"event":"result_notices","attempt":');
    expect(context.logs.join('\n')).toContain('"notices":"OPERATOR_NOT_PERMITTED"');
  });

  it('is a completion with a logged notice when it names a day inside the validation or holdout window', async () => {
    const output = await revisionOutput({
      claims: { ...claims, rationale: 'It avoids 2024-08-05T20:00:00Z and 2025-04-07.' },
    });
    const context = await setup(reply(output));
    expect(await go(context)).toEqual({ posted: true, outcome: 'completion' });
    expect(context.world.api.artefacts.size).toBe(1);
    expect(context.logs.join('\n')).toContain('"notices":"HOLDOUT_REFERENCE,HOLDOUT_REFERENCE"');
  });

  it('is still a completion when the revision changes both rules and an entry is unresolved: they are notices for the next proposal', async () => {
    const output = await revisionOutput({
      strategy: proposedForm(seedArtefact(SEED_FOUR)),
      rule_changes: [
        { path: THRESHOLD, from: '30', to: '32' },
        { path: BREAK_EVEN, from: '[]', to: 'break_even' },
      ],
      unresolved: [{ id: 'u1', element: THRESHOLD, question: 'Which close is meant?' }],
    });
    const context = await setup(reply(output));
    expect(await go(context)).toEqual({ posted: true, outcome: 'completion' });
    expect(context.world.api.artefacts.size).toBe(1);
  });

  it('keeps the exact rule-change check for a revision whose declared changes are not the difference', async () => {
    const output = await revisionOutput({
      strategy: proposedForm(seedArtefact(SEED_FOUR)),
      rule_changes: [{ path: THRESHOLD, from: '30', to: '32' }],
    });
    const context = await setup(reply(output));
    expect(await go(context)).toEqual({ posted: true, outcome: 'malformed_result', reason: 'RULE_CHANGES_MISMATCH' });
  });
});

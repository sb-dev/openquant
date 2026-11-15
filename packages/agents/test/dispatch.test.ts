// The dispatch checks that agent-dispatch/1 does not make: role, skill and request must match, the exclusions must
// name V and H, and the bundle and executor profile must be the registered ones (OQ-03 section 4).

import { type AgentDispatch, parseContract } from '@openquant/api-contracts';
import { describe, expect, test } from 'vitest';
import {
  assembleCritiqueRequest,
  assembleFormulationRequest,
  BUNDLE_HASH,
  checkDispatch,
  type DispatchRequest,
  type DispatchViolationCode,
} from '../src/index.ts';
import { readText } from './support/oracle.ts';
import { critiqueRequestInput, revisionInput } from './support/requests.ts';

const baseline = JSON.parse(readText('fixtures/protocol/valid/agent-dispatch.proposer.json')) as AgentDispatch;

async function proposerCase(): Promise<{ dispatch: AgentDispatch; assembled: DispatchRequest }> {
  const assembly = await assembleFormulationRequest(await revisionInput());
  if (!assembly.ok) throw new Error('refused');
  const dispatch = structuredClone(baseline);
  dispatch.identity.bundle_hash = BUNDLE_HASH;
  dispatch.inputs.request.artefact = structuredClone(assembly.artefact);
  dispatch.inputs.holdout_exclusions = structuredClone(assembly.request.context.holdout_exclusions);
  return { dispatch, assembled: { request: assembly.request, artefact: assembly.artefact } };
}

async function criticCase(): Promise<{ dispatch: AgentDispatch; assembled: DispatchRequest }> {
  const assembly = await assembleCritiqueRequest(await critiqueRequestInput());
  if (!assembly.ok) throw new Error('refused');
  const dispatch = structuredClone(baseline);
  dispatch.identity.role = 'critic';
  dispatch.identity.skill = { id: 'strategy-critique', version: '1' };
  dispatch.identity.bundle_hash = BUNDLE_HASH;
  dispatch.execution.executor.profile = { model: 'claude-opus-5-5', effort: 'executor_default' };
  dispatch.inputs.request = { contract: 'strategy-critique.request/1', artefact: structuredClone(assembly.artefact) };
  dispatch.inputs.holdout_exclusions = structuredClone(assembly.request.context.holdout_exclusions);
  return { dispatch, assembled: { request: assembly.request, artefact: assembly.artefact } };
}

function codesOf(dispatch: AgentDispatch, assembled: DispatchRequest): DispatchViolationCode[] {
  return checkDispatch(dispatch, assembled).map((item) => item.code);
}

describe('a dispatch that matches its request', () => {
  test('both roles pass, and both are valid envelopes', async () => {
    for (const make of [proposerCase, criticCase]) {
      const { dispatch, assembled } = await make();
      expect(parseContract('agent-dispatch', JSON.stringify(dispatch)).ok).toBe(true);
      expect(checkDispatch(dispatch, assembled)).toEqual([]);
    }
  });
});

describe('what the envelope schema accepts and the dispatch check refuses', () => {
  test('the envelope accepts a critic skill with the proposer role', async () => {
    const { dispatch } = await proposerCase();
    dispatch.identity.skill = { id: 'strategy-critique', version: '1' };
    expect(parseContract('agent-dispatch', JSON.stringify(dispatch)).ok).toBe(true);
  });

  test('a skill that serves another role', async () => {
    const { dispatch, assembled } = await proposerCase();
    dispatch.identity.skill = { id: 'strategy-critique', version: '1' };
    expect(codesOf(dispatch, assembled)).toContain('ROLE_SKILL_MISMATCH');
  });

  test('a role that does not match its skill', async () => {
    const { dispatch, assembled } = await proposerCase();
    dispatch.identity.role = 'critic';
    // The model of the proposer A profile is also the critic's, so only the role and skill disagree.
    expect(codesOf(dispatch, assembled)).toEqual(['ROLE_SKILL_MISMATCH']);
  });

  test('another version of the skill than the registry has', async () => {
    const { dispatch, assembled } = await proposerCase();
    dispatch.identity.skill = { id: 'strategy-formulation', version: '2' };
    expect(codesOf(dispatch, assembled)).toEqual(['SKILL_NOT_REGISTERED']);
  });

  test("a request contract that is not the skill's", async () => {
    const { dispatch, assembled } = await proposerCase();
    dispatch.inputs.request.contract = 'strategy-critique.request/1';
    expect(codesOf(dispatch, assembled)).toEqual(['REQUEST_CONTRACT_MISMATCH']);
  });

  test('a request that was assembled for the other role', async () => {
    const { dispatch } = await proposerCase();
    const { assembled } = await criticCase();
    expect(codesOf(dispatch, assembled)).toContain('REQUEST_CONTRACT_MISMATCH');
  });

  test.each([
    [
      'digest',
      (d: AgentDispatch) => {
        d.inputs.request.artefact.digest = `sha256:${'1'.repeat(64)}`;
      },
    ],
    [
      'size',
      (d: AgentDispatch) => {
        d.inputs.request.artefact.size_bytes += 1;
      },
    ],
    [
      'media type',
      (d: AgentDispatch) => {
        d.inputs.request.artefact.media_type = 'text/plain';
      },
    ],
  ])('a request artefact with another %s than the assembled request', async (_name, change) => {
    const { dispatch, assembled } = await proposerCase();
    change(dispatch);
    expect(codesOf(dispatch, assembled)).toEqual(['REQUEST_ARTEFACT_MISMATCH']);
  });

  test("exclusions that differ from the request's", async () => {
    const { dispatch, assembled } = await proposerCase();
    const holdout = dispatch.inputs.holdout_exclusions.find((item) => item.window === 'HOLDOUT');
    if (!holdout) throw new Error('no holdout');
    holdout.range.end = '2025-12-30';
    expect(codesOf(dispatch, assembled)).toContain('HOLDOUT_EXCLUSIONS_MISMATCH');
  });

  test('exclusions that omit V or H, in the dispatch and in the request alike', async () => {
    const { dispatch, assembled } = await proposerCase();
    dispatch.inputs.holdout_exclusions = dispatch.inputs.holdout_exclusions.filter(
      (item) => item.window !== 'VALIDATION',
    );
    const request = structuredClone(assembled.request);
    request.context.holdout_exclusions = request.context.holdout_exclusions.filter(
      (item) => item.window !== 'VALIDATION',
    );
    const violations = checkDispatch(dispatch, { ...assembled, request });
    expect(violations.map((item) => item.code)).toEqual(['HOLDOUT_EXCLUSIONS_INVALID']);
    expect(violations[0]?.detail).toMatch(/VALIDATION/);
  });

  test('a bundle hash that is not the one built into the module', async () => {
    const { dispatch, assembled } = await proposerCase();
    dispatch.identity.bundle_hash = baseline.identity.bundle_hash;
    expect(baseline.identity.bundle_hash).not.toBe(BUNDLE_HASH);
    expect(codesOf(dispatch, assembled)).toEqual(['BUNDLE_HASH_MISMATCH']);
  });

  test("required capabilities that are not the registry's", async () => {
    const { dispatch, assembled } = await proposerCase();
    dispatch.execution.required_capabilities = ['provider:alpaca/daily_bars@1'];
    expect(codesOf(dispatch, assembled)).toEqual(['CAPABILITIES_MISMATCH']);
  });

  test('a capability that the request does not make available', async () => {
    const { dispatch, assembled } = await proposerCase();
    dispatch.execution.required_capabilities = ['provider:other/quotes@1'];
    expect(codesOf(dispatch, assembled)).toEqual(['CAPABILITIES_MISMATCH', 'CAPABILITY_UNAVAILABLE']);
  });

  test.each([
    ['another model', { model: 'claude-haiku-5', effort: 'executor_default' as const }],
    ['another effort', { model: 'claude-opus-5-5', effort: 'max' as const }],
  ])('a profile with %s than any registered proposer configuration', async (_name, profile) => {
    const { dispatch, assembled } = await proposerCase();
    dispatch.execution.executor.profile = profile;
    expect(codesOf(dispatch, assembled)).toEqual(['PROFILE_NOT_REGISTERED']);
  });

  test('both proposer models are registered, and the critic uses its own profile', async () => {
    const { dispatch, assembled } = await proposerCase();
    dispatch.execution.executor.profile = { model: 'claude-sonnet-5-5', effort: 'executor_default' };
    expect(codesOf(dispatch, assembled)).toEqual([]);
    const critic = await criticCase();
    critic.dispatch.execution.executor.profile = { model: 'claude-sonnet-5-5', effort: 'executor_default' };
    expect(codesOf(critic.dispatch, critic.assembled)).toEqual(['PROFILE_NOT_REGISTERED']);
  });

  test('an output limit above the 512 KiB that a role result is parsed within', async () => {
    const { dispatch, assembled } = await proposerCase();
    dispatch.execution.bounds.output_limit_bytes = 524_289;
    expect(parseContract('agent-dispatch', JSON.stringify(dispatch)).ok).toBe(true);
    expect(codesOf(dispatch, assembled)).toEqual(['OUTPUT_LIMIT_TOO_HIGH']);
    dispatch.execution.bounds.output_limit_bytes = 524_288;
    expect(codesOf(dispatch, assembled)).toEqual([]);
  });

  test('a tool', async () => {
    const { dispatch, assembled } = await proposerCase();
    (dispatch.execution as { tools: string[] }).tools = ['tool:market-snapshot@1'];
    expect(codesOf(dispatch, assembled)).toEqual(['TOOLS_NOT_PERMITTED']);
  });

  test('a result route of another attempt', async () => {
    const { dispatch, assembled } = await proposerCase();
    dispatch.result_route = '/v1/attempts/att-other/agent-result';
    expect(codesOf(dispatch, assembled)).toEqual(['RESULT_ROUTE_MISMATCH']);
  });

  test('several mismatches are all reported', async () => {
    const { dispatch, assembled } = await proposerCase();
    dispatch.identity.bundle_hash = `sha256:${'2'.repeat(64)}`;
    dispatch.result_route = '/v1/attempts/att-other/agent-result';
    dispatch.execution.bounds.output_limit_bytes = 1_000_000;
    expect(codesOf(dispatch, assembled)).toEqual([
      'BUNDLE_HASH_MISMATCH',
      'OUTPUT_LIMIT_TOO_HIGH',
      'RESULT_ROUTE_MISMATCH',
    ]);
  });
});

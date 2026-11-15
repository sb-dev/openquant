// The static registry and the executor profiles (OQ-03 sections 2 and 3, pilot decision record D7).

import { type AgentDispatch, parseContract, workerBodyLimit } from '@openquant/api-contracts';
import { describe, expect, test } from 'vitest';
import {
  BUNDLE_HASH,
  profiles,
  profilesForRole,
  registry,
  SUPPLIED_METHODS,
  skillEntry,
  skillForRole,
} from '../src/index.ts';
import { readText } from './support/oracle.ts';

const dispatch = JSON.parse(readText('fixtures/protocol/valid/agent-dispatch.proposer.json')) as AgentDispatch;

describe('the registry', () => {
  test('has exactly the two pilot role modules, in order', () => {
    expect(registry.map((entry) => [entry.id, entry.version, entry.roles, entry.entry])).toEqual([
      ['strategy-formulation', '1', ['proposer'], 'role_module'],
      ['strategy-critique', '1', ['critic'], 'role_module'],
    ]);
  });

  test('each entry names its request and result contract, the contract tags of the role schemas', () => {
    expect(registry.map((entry) => [entry.request_contract, entry.result_contract])).toEqual([
      ['strategy-formulation.request/1', 'strategy-formulation.result/1'],
      ['strategy-critique.request/1', 'strategy-critique.result/1'],
    ]);
  });

  test('requires no capability and exposes no tool, source or method', () => {
    for (const entry of registry) {
      expect(entry.required_capabilities).toEqual([]);
      expect(entry.source_refs).toEqual([]);
      expect(entry.method_refs).toEqual([]);
    }
  });

  test('declares the 512 KiB limit of a strategy artefact for a request and a result', () => {
    for (const entry of registry) {
      expect(entry.limits).toEqual({ request_bytes: 524_288, output_bytes: 524_288 });
      expect(entry.limits.output_bytes).toBe(workerBodyLimit('strategy-artefact'));
    }
  });

  test('looks a skill up by id and by role, and knows no other', () => {
    expect(skillEntry('strategy-critique')?.roles).toEqual(['critic']);
    expect(skillEntry('strategy-sizing')).toBeUndefined();
    expect(skillForRole('proposer').id).toBe('strategy-formulation');
    expect(skillForRole('critic').id).toBe('strategy-critique');
  });

  test('the skill ids and versions are accepted by agent-dispatch/1', () => {
    for (const entry of registry) {
      const candidate = structuredClone(dispatch);
      candidate.identity.skill = { id: entry.id, version: entry.version };
      candidate.inputs.request.contract = entry.request_contract;
      candidate.identity.role = entry.roles[0] ?? 'proposer';
      expect(parseContract('agent-dispatch', JSON.stringify(candidate)).ok, entry.id).toBe(true);
    }
  });

  test('every entry point is a function that the module exports', async () => {
    const exports = (await import('../src/index.ts')) as Record<string, unknown>;
    for (const entry of registry) {
      expect(typeof exports[entry.entry_points.assemble]).toBe('function');
      expect(typeof exports[entry.entry_points.parse]).toBe('function');
    }
  });
});

describe('the executor profiles', () => {
  test('are two proposer models and one critic, as decision D7 records', () => {
    expect(
      profiles.map((entry) => [entry.configuration, entry.role, entry.profile.model, entry.profile.effort]),
    ).toEqual([
      ['proposer_a', 'proposer', 'claude-opus-5-5', 'executor_default'],
      ['proposer_b', 'proposer', 'claude-sonnet-5-5', 'executor_default'],
      ['critic', 'critic', 'claude-opus-5-5', 'executor_default'],
    ]);
    expect(profilesForRole('proposer')).toHaveLength(2);
    expect(profilesForRole('critic')).toHaveLength(1);
  });

  test('the two proposers differ in the model only, and all three share the one baseline bundle', () => {
    const [a, b, critic] = profiles;
    expect(a?.profile.model).not.toBe(b?.profile.model);
    expect(a?.profile.effort).toBe(b?.profile.effort);
    expect(new Set(profiles.map((entry) => entry.bundle_hash))).toEqual(new Set([BUNDLE_HASH]));
    expect(new Set(profiles.map((entry) => entry.bundle_id))).toEqual(new Set(['baseline']));
    expect(critic?.role).toBe('critic');
  });

  test("record each model's knowledge cutoff, or that the checked source does not state it", () => {
    const byModel = new Map(profiles.map((entry) => [entry.profile.model, entry.knowledge_cutoff]));
    expect(byModel.get('claude-opus-5-5')).toMatchObject({ state: 'reported', value: 'June 2026' });
    expect(byModel.get('claude-sonnet-5-5')).toMatchObject({ state: 'not_stated' });
    for (const entry of profiles) expect(entry.knowledge_cutoff.source).toMatch(/model-migration\.md/);
  });

  test('are accepted by agent-dispatch/1 as executor profiles', () => {
    for (const entry of profiles) {
      const candidate = structuredClone(dispatch);
      candidate.execution.executor.profile = { ...entry.profile };
      expect(parseContract('agent-dispatch', JSON.stringify(candidate)).ok, entry.configuration).toBe(true);
    }
  });

  test('the baseline bundle supplies no method', () => {
    expect(SUPPLIED_METHODS).toEqual([]);
  });
});

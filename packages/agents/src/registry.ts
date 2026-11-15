// The static registry of the product skills (OQ-03 section 3) and the executor profiles of the S1 pilot.
//
// One reviewed registry, no discovery. The pilot has two role modules, and neither exposes an agent-callable tool:
// `strategy-formulation` for the proposer and `strategy-critique` for the critic. A model supplies task arguments,
// never a module path, a client or an executable name. Worker-safe: no Node module.

import { BUNDLE_HASH, BUNDLE_ID } from '../dist/generated/bundle.ts';
import { ROLE_BODY_LIMIT } from './contract.ts';

export type Role = 'proposer' | 'critic';
export type SkillId = 'strategy-formulation' | 'strategy-critique';
export type RequestContract = 'strategy-formulation.request/1' | 'strategy-critique.request/1';
export type ResultContract = 'strategy-formulation.result/1' | 'strategy-critique.result/1';

export interface SkillEntry {
  readonly id: SkillId;
  readonly version: string;
  readonly description: string;
  /** The task that the module serves. */
  readonly task: string;
  readonly roles: readonly Role[];
  /** Role assembly and parsing, as opposed to an agent-callable tool (none before S3). */
  readonly entry: 'role_module';
  readonly request_contract: RequestContract;
  readonly result_contract: ResultContract;
  /** Required capabilities, `provider:<adapter-id>/<operation>@<version>`. Request assembly copies them. */
  readonly required_capabilities: readonly string[];
  readonly limits: {
    /** The largest role request, in bytes. */
    readonly request_bytes: number;
    /** The largest role result, in bytes: the dispatch output limit cannot be higher. */
    readonly output_bytes: number;
  };
  /** Source and method references of the module itself. The baseline bundle adopts none. */
  readonly source_refs: readonly string[];
  readonly method_refs: readonly string[];
  readonly entry_points: { readonly assemble: string; readonly parse: string };
}

export const registry: readonly SkillEntry[] = [
  {
    id: 'strategy-formulation',
    version: '1',
    description:
      'Proposer role module: assembles the request for a seed translation, a controlled revision or a new family and parses the proposal.',
    task: 'propose a strategy',
    roles: ['proposer'],
    entry: 'role_module',
    request_contract: 'strategy-formulation.request/1',
    result_contract: 'strategy-formulation.result/1',
    required_capabilities: [],
    limits: { request_bytes: ROLE_BODY_LIMIT, output_bytes: ROLE_BODY_LIMIT },
    source_refs: [],
    method_refs: [],
    entry_points: { assemble: 'assembleFormulationRequest', parse: 'parseFormulationResult' },
  },
  {
    id: 'strategy-critique',
    version: '1',
    description: 'Critic role module: assembles the request for a registered Strategy Version and parses the findings.',
    task: 'critique a registered strategy version',
    roles: ['critic'],
    entry: 'role_module',
    request_contract: 'strategy-critique.request/1',
    result_contract: 'strategy-critique.result/1',
    required_capabilities: [],
    limits: { request_bytes: ROLE_BODY_LIMIT, output_bytes: ROLE_BODY_LIMIT },
    source_refs: [],
    method_refs: [],
    entry_points: { assemble: 'assembleCritiqueRequest', parse: 'parseCritiqueResult' },
  },
];

export function skillEntry(id: string): SkillEntry | undefined {
  return registry.find((entry) => entry.id === id);
}

export function skillForRole(role: Role): SkillEntry {
  const entry = registry.find((item) => item.roles.includes(role));
  if (!entry) throw new Error(`no skill is registered for the role ${role}`);
  return entry;
}

/** A model's published knowledge cutoff, or the record that the checked source does not state it (OQ-03 section 2). */
export type KnowledgeCutoff =
  | { readonly state: 'reported'; readonly value: string; readonly source: string }
  | { readonly state: 'not_stated'; readonly source: string };

export interface ExecutorProfileEntry {
  /** The agent configuration: an executor profile plus the behaviour-bundle hash (OQ-03 section 2). */
  readonly configuration: 'proposer_a' | 'proposer_b' | 'critic';
  readonly role: Role;
  readonly profile: { readonly model: string; readonly effort: 'executor_default' };
  readonly bundle_id: string;
  readonly bundle_hash: string;
  readonly knowledge_cutoff: KnowledgeCutoff;
}

const CUTOFF_SOURCE =
  'Claude API reference shipped with Claude Code 2.1.325, claude-api/shared/model-migration.md, read 2026-11-14';
const opusCutoff: KnowledgeCutoff = { state: 'reported', value: 'June 2026', source: CUTOFF_SOURCE };
const sonnetCutoff: KnowledgeCutoff = { state: 'not_stated', source: CUTOFF_SOURCE };

/**
 * The three S1 agent configurations (pilot decision record D7): proposer A and proposer B differ in the model, the
 * critic has its own profile and sessions, and all three use the one zero-method baseline bundle.
 */
export const profiles: readonly ExecutorProfileEntry[] = [
  {
    configuration: 'proposer_a',
    role: 'proposer',
    profile: { model: 'claude-opus-5-5', effort: 'executor_default' },
    bundle_id: BUNDLE_ID,
    bundle_hash: BUNDLE_HASH,
    knowledge_cutoff: opusCutoff,
  },
  {
    configuration: 'proposer_b',
    role: 'proposer',
    profile: { model: 'claude-sonnet-5-5', effort: 'executor_default' },
    bundle_id: BUNDLE_ID,
    bundle_hash: BUNDLE_HASH,
    knowledge_cutoff: sonnetCutoff,
  },
  {
    configuration: 'critic',
    role: 'critic',
    profile: { model: 'claude-opus-5-5', effort: 'executor_default' },
    bundle_id: BUNDLE_ID,
    bundle_hash: BUNDLE_HASH,
    knowledge_cutoff: opusCutoff,
  },
];

export function profilesForRole(role: Role): readonly ExecutorProfileEntry[] {
  return profiles.filter((entry) => entry.role === role);
}

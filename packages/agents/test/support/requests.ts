// Assembled requests and valid outputs for the parsing tests. Strategies are the S0 seeds; the declared changes in the
// outputs are written by hand from the S0 fixtures (threshold 30 to 32, break-even added), not computed.

import { digest } from '@openquant/api-contracts';
import { critiqueInput, formulationInput, proposedForm, seedArtefact } from '../../dev/world.ts';
import {
  assembleCritiqueRequest,
  assembleFormulationRequest,
  type CritiqueInput,
  type FormulationInput,
} from '../../src/index.ts';
import type { StrategyCritiqueRequest, StrategyFormulationRequest } from '../../src/types.ts';

export const SEED_ONE = 'seed-1-rsi30-breakeven-off';
export const SEED_TWO = 'seed-2-rsi32-breakeven-off';
export const SEED_THREE = 'seed-3-rsi30-breakeven-on';
export const SEED_FOUR = 'seed-4-rsi32-breakeven-on';
export const THRESHOLD = '/definition/indicators/5/expr/params/value';
export const BREAK_EVEN = '/definition/exits/stop_adjustments';

export const FINDING = {
  id: 'ev-d-finding-1',
  kind: 'finding' as const,
  content:
    'Development-window per-stock finding: entries often followed a decision bar that closed lower on heavy volume.',
};

export async function revisionInput(overrides: Partial<FormulationInput> = {}): Promise<FormulationInput> {
  return {
    ...(await formulationInput({
      subject: { proposal_kind: 'controlled_revision', parent: { seed: SEED_ONE } },
      evidence: [FINDING],
    })),
    ...overrides,
  };
}

export async function revisionRequest(): Promise<StrategyFormulationRequest> {
  const assembly = await assembleFormulationRequest(await revisionInput());
  if (!assembly.ok) throw new Error(`the revision request was refused: ${JSON.stringify(assembly.refusals)}`);
  return assembly.request;
}

export async function seedRequest(): Promise<StrategyFormulationRequest> {
  const assembly = await assembleFormulationRequest(
    await formulationInput({
      subject: {
        proposal_kind: 'seed_translation',
        source: {
          source_id: 'src-note-1',
          media_type: 'text/plain',
          lines: ['Buy weakness above the 50-session mean.'],
        },
      },
      evidence: [],
    }),
  );
  if (!assembly.ok) throw new Error(`the seed request was refused: ${JSON.stringify(assembly.refusals)}`);
  return assembly.request;
}

export async function critiqueRequestInput(overrides: Partial<CritiqueInput> = {}): Promise<CritiqueInput> {
  return {
    ...(await critiqueInput({
      subject: { artefact: { seed: SEED_TWO } },
      evidence: [{ id: 'ev-note-1', kind: 'hypothesis', content: 'Earlier hypothesis note.' }],
    })),
    ...overrides,
  };
}

export async function critiqueRequest(): Promise<StrategyCritiqueRequest> {
  const assembly = await assembleCritiqueRequest(await critiqueRequestInput());
  if (!assembly.ok) throw new Error(`the critique request was refused: ${JSON.stringify(assembly.refusals)}`);
  return assembly.request;
}

export const claims = {
  rationale: 'The recorded finding motivates a higher weakness threshold.',
  expected_effect: 'More entries; evaluation can contradict this.',
  invalidation_conditions: ['No change in entry counts against the parent.'],
  requested_tests: ['The registered comparison against the parent.'],
};

/** A valid controlled-revision output: seed 1 to seed 2, declared as the S0 fixture declares it. */
export async function revisionOutput(overrides: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  return {
    schema_version: 'strategy-formulation.result/1',
    proposal_kind: 'controlled_revision',
    parent_hash: await digest(seedArtefact(SEED_ONE)),
    strategy: proposedForm(seedArtefact(SEED_TWO)),
    source_refs: ['ev-d-finding-1'],
    rule_changes: [{ path: THRESHOLD, from: '30', to: '32' }],
    claims,
    unresolved: [],
    method_refs: [],
    ...overrides,
  };
}

export function finding(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    category: 'hypothesis_assumption',
    description: 'The mechanism is stated but not argued.',
    method_refs: [],
    evidence_refs: [],
    location: { area: 'rationale' },
    affected_elements: [],
    ...overrides,
  };
}

export function critiqueOutput(...findings: Record<string, unknown>[]): Record<string, unknown> {
  return { schema_version: 'strategy-critique.result/1', findings };
}

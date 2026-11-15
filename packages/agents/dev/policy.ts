// Finding treatment under the synthetic fixture policy (packages/agents/evals/fixture-policy.json).
//
// This is development tooling for the offline suites. The registered cohort policy assigns treatment in production
// (OQ-02 section 3.6) and the API derives applicability from validated fields. Policy code derives applicability the
// same way: `affects_executable_rule` holds when `affected_elements` is not empty, and `required_evidence` holds when
// an evidence reference is evidence that the frozen policy requires. A model's own severity never enters.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { repositoryRoot } from './world.ts';

export type Transition = 'DRAFT_TO_EVALUATING' | 'EVALUATING_TO_PAPER';
export type Treatment = 'advisory' | 'blocking';
type Condition = 'affects_executable_rule' | 'required_evidence';

interface Row {
  readonly default: Treatment;
  readonly escalate_when?: readonly Condition[];
}

export interface FixturePolicy {
  readonly transitions: readonly Transition[];
  readonly treatments: Readonly<Record<string, Readonly<Record<Transition, Row>>>>;
}

export function loadFixturePolicy(): FixturePolicy {
  return JSON.parse(
    readFileSync(resolve(repositoryRoot, 'packages/agents/evals/fixture-policy.json'), 'utf8'),
  ) as FixturePolicy;
}

export interface TreatableFinding {
  readonly category: string;
  readonly affected_elements: readonly string[];
  readonly evidence_refs: readonly string[];
}

/** The treatment of a finding for each lifecycle transition. `requiredEvidence` holds the evidence ids that the policy requires. */
export function treatmentOf(
  policy: FixturePolicy,
  finding: TreatableFinding,
  requiredEvidence: ReadonlySet<string>,
): Record<Transition, Treatment> {
  const row = policy.treatments[finding.category];
  if (row === undefined) throw new Error(`the fixture policy has no category ${finding.category}`);
  const holds = (condition: Condition) =>
    condition === 'affects_executable_rule'
      ? finding.affected_elements.length > 0
      : finding.evidence_refs.some((id) => requiredEvidence.has(id));
  const result = {} as Record<Transition, Treatment>;
  for (const transition of policy.transitions) {
    const entry = row[transition];
    result[transition] =
      entry.default === 'blocking' || (entry.escalate_when ?? []).some(holds) ? 'blocking' : 'advisory';
  }
  return result;
}

// A draft checked against the cohort policy before it can become a Strategy Version (OQ-02 section 4 step 2: "the API
// checks scope, bounds and lineage"; OQ-03 section 4: "scope, bounds, lineage and execution-policy compatibility";
// cohort-policy/1 OperatorPermissions: "the API checks bounds; the Rust core checks operators, types, units and
// lookback"). The Rust validator is not told the bounds, so it reports VALID for a draft that a Steward's policy
// forbids. This module is the rule that the Steward registered, applied to the draft:
//
//   - every operator of every expression is one that the policy permits (operator_set included);
//   - every parameter that the policy bounds (window, periods, value) lies inside its inclusive bounds, compared as
//     exact decimals;
//   - the execution section is one that the registered execution policy supports (OQ-02 section 2.5).
//
// A violation is a diagnostic of validation-result/1 with the code POLICY_VIOLATION: an operator or operator set that is
// not permitted, a value outside its bounds, or an execution request that the policy does not support. The detail of
// each diagnostic names the rule. A draft that has no violation is not thereby valid: Rust still validates it.

import type { CohortPolicy, StrategyArtefact, ValidationCode } from '@openquant/api-contracts';
import { compareDecimal } from './decimal.ts';

export interface PolicyDiagnostic {
  readonly code: Extract<ValidationCode, 'POLICY_VIOLATION'>;
  /** A JSON Pointer into the strategy artefact. */
  readonly pointer: string;
  readonly detail: string;
}

/** validation-result/1 holds at most 64 diagnostics. */
export const MAX_POLICY_DIAGNOSTICS = 64;

type Expr = StrategyArtefact['definition']['entry']['condition'];

/** The execution that each registered execution policy supports: its phases (OQ-02 section 2.5). */
const SUPPORTED_EXECUTION: Readonly<Record<string, { readonly entry_fill: string; readonly decision: string }>> = {
  'daily-long-only-cash@1': { entry_fill: 'NEXT_OPEN', decision: 'AFTER_CLOSE' },
};

type BoundedParameter = 'window' | 'periods' | 'value';

function expressionsOf(draft: StrategyArtefact): { pointer: string; expr: Expr }[] {
  const { definition } = draft;
  const found: { pointer: string; expr: Expr }[] = [];
  for (const [index, entry] of definition.indicators.entries())
    found.push({ pointer: `/definition/indicators/${index}/expr`, expr: entry.expr });
  found.push({ pointer: '/definition/entry/condition', expr: definition.entry.condition });
  found.push({ pointer: '/definition/entry/rank', expr: definition.entry.rank });
  for (const [index, entry] of definition.entry.snapshots.entries())
    found.push({ pointer: `/definition/entry/snapshots/${index}/expr`, expr: entry.expr });
  found.push({ pointer: '/definition/exits/stop', expr: definition.exits.stop });
  found.push({ pointer: '/definition/exits/target', expr: definition.exits.target });
  for (const [index, entry] of definition.exits.stop_adjustments.entries()) {
    found.push({ pointer: `/definition/exits/stop_adjustments/${index}/trigger`, expr: entry.trigger });
    found.push({ pointer: `/definition/exits/stop_adjustments/${index}/new_level`, expr: entry.new_level });
  }
  return found;
}

/** Every violation of the policy in the draft, in document order and at most 64. Empty when the draft fits. */
export function policyDiagnostics(draft: StrategyArtefact, policy: CohortPolicy): PolicyDiagnostic[] {
  const found: PolicyDiagnostic[] = [];
  const add = (diagnostic: PolicyDiagnostic): void => {
    if (found.length < MAX_POLICY_DIAGNOSTICS) found.push(diagnostic);
  };
  const { operators, execution_policy: executionPolicy } = policy.conditions;

  if (draft.operator_set !== operators.operator_set) {
    add({
      code: 'POLICY_VIOLATION',
      pointer: '/operator_set',
      detail: `The operator set ${draft.operator_set} is not the operator set ${operators.operator_set} of the cohort policy.`,
    });
  }
  const permitted = new Map(operators.permitted.map((entry) => [entry.operator, entry.parameter_bounds]));

  const visit = (expr: Expr, pointer: string): void => {
    const bounds = permitted.get(expr.op);
    if (bounds === undefined) {
      add({
        code: 'POLICY_VIOLATION',
        pointer: `${pointer}/op`,
        detail: `The operator ${expr.op} is not permitted by the cohort policy.`,
      });
    } else {
      for (const bound of bounds) {
        const actual = (expr.params as Partial<Record<BoundedParameter, number | string>>)[bound.parameter];
        if (actual === undefined) continue;
        const text = String(actual);
        const where = `${pointer}/params/${bound.parameter}`;
        if (compareDecimal(text, bound.minimum) < 0) {
          add({
            code: 'POLICY_VIOLATION',
            pointer: where,
            detail: `The ${bound.parameter} ${text} of ${expr.op} is below the minimum ${bound.minimum} of the cohort policy.`,
          });
        } else if (compareDecimal(text, bound.maximum) > 0) {
          add({
            code: 'POLICY_VIOLATION',
            pointer: where,
            detail: `The ${bound.parameter} ${text} of ${expr.op} is above the maximum ${bound.maximum} of the cohort policy.`,
          });
        }
      }
    }
    for (const [index, argument] of expr.args.entries()) visit(argument, `${pointer}/args/${index}`);
  };
  for (const { pointer, expr } of expressionsOf(draft)) visit(expr, pointer);

  const supported = SUPPORTED_EXECUTION[executionPolicy.id];
  if (supported === undefined) {
    add({
      code: 'POLICY_VIOLATION',
      pointer: '/definition/execution',
      detail: `The execution policy ${executionPolicy.id} of the cohort policy is not one whose execution requests this API knows.`,
    });
  } else {
    for (const field of ['entry_fill', 'decision'] as const) {
      const requested = draft.definition.execution[field];
      if (requested !== supported[field]) {
        add({
          code: 'POLICY_VIOLATION',
          pointer: `/definition/execution/${field}`,
          detail: `The ${field} ${requested} is not the ${supported[field]} that the execution policy ${executionPolicy.id} supports.`,
        });
      }
    }
  }
  return found;
}

/** The diagnostics as the reason of an INVALID trial: the next proposer attempt reads it. At most 1000 characters. */
export function describePolicyDiagnostics(diagnostics: readonly PolicyDiagnostic[]): string {
  return diagnostics
    .map((entry) => `${entry.code} at ${entry.pointer}: ${entry.detail}`)
    .join('; ')
    .slice(0, 1000);
}

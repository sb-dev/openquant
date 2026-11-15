// The rule that a Steward registers in a cohort policy, applied to a draft (OQ-02 section 4 step 2; cohort-policy/1
// OperatorPermissions). The cases use the fixture seed draft, whose operators and parameters are counted below, and
// policies derived from the pilot policy: what each case expects follows from those numbers, not from src.
//
// The seed draft's expressions, in document order, and their bounded parameters:
//   indicators 0..7:  sma window 50, sma window 20, rsi_simple window 14, atr_simple window 14,
//                     const value 30, const value 30, lag periods 1, lag periods 2
//   entry condition:  const value 0 (at args/4/args/1) and const value 0 (at args/5/args/1)
//   entry rank:       const value 50 (args/0/args/0), const value 100 (args/1/args/0)
//   exits:            const value 2 (stop args/1/args/0), const value 5 (target args/1/args/0)
//   operator_set daily-long-only-seed@1; execution NEXT_OPEN, AFTER_CLOSE.

import type { CohortPolicy, StrategyArtefact } from '@openquant/api-contracts';
import { describe, expect, it } from 'vitest';
import { describePolicyDiagnostics, MAX_POLICY_DIAGNOSTICS, policyDiagnostics } from '../src/domain/policy-fit.ts';
import { type Doc, fixture } from './support/world.ts';

const draft = (): Doc => structuredClone((fixture('command.register-seed.json').payload as Doc).draft) as Doc;
const policy = (): Doc => structuredClone(fixture('cohort-policy.s1-pilot.json')) as Doc;
const check = (d: Doc, p: Doc) => policyDiagnostics(d as StrategyArtefact, p as CohortPolicy);

const permission = (p: Doc, operator: string): Doc =>
  p.conditions.operators.permitted.find((entry: Doc) => entry.operator === operator);

describe('the seed draft against the pilot policy', () => {
  it('has no violation: every operator is permitted and every bound holds', () => {
    expect(check(draft(), policy())).toEqual([]);
  });
});

describe('a parameter outside its bounds', () => {
  it('above the maximum is INVALID_PARAMETER at the parameter, and only there', () => {
    const p = policy();
    permission(p, 'operator:sma@1').parameter_bounds = [{ parameter: 'window', minimum: '1', maximum: '49' }];
    const found = check(draft(), p);
    expect(found).toEqual([
      {
        code: 'INVALID_PARAMETER',
        pointer: '/definition/indicators/0/expr/params/window',
        detail: 'The window 50 of operator:sma@1 is above the maximum 49 of the cohort policy.',
      },
    ]);
  });

  it('below the minimum is INVALID_PARAMETER at the parameter, and only there', () => {
    const p = policy();
    permission(p, 'operator:sma@1').parameter_bounds = [{ parameter: 'window', minimum: '21', maximum: '60' }];
    expect(check(draft(), p)).toEqual([
      {
        code: 'INVALID_PARAMETER',
        pointer: '/definition/indicators/1/expr/params/window',
        detail: 'The window 20 of operator:sma@1 is below the minimum 21 of the cohort policy.',
      },
    ]);
  });

  it('is inclusive: a value on the minimum or on the maximum is within the bounds', () => {
    const p = policy();
    permission(p, 'operator:sma@1').parameter_bounds = [{ parameter: 'window', minimum: '20', maximum: '50' }];
    expect(check(draft(), p)).toEqual([]);
  });

  it('bounds the periods of a lag and the window of an rsi and an atr, each by its own operator', () => {
    const p = policy();
    permission(p, 'operator:lag@1').parameter_bounds = [{ parameter: 'periods', minimum: '2', maximum: '59' }];
    permission(p, 'operator:rsi_simple@1').parameter_bounds = [{ parameter: 'window', minimum: '15', maximum: '59' }];
    permission(p, 'operator:atr_simple@1').parameter_bounds = [{ parameter: 'window', minimum: '1', maximum: '13' }];
    expect(check(draft(), p).map((entry) => entry.pointer)).toEqual([
      '/definition/indicators/2/expr/params/window',
      '/definition/indicators/3/expr/params/window',
      '/definition/indicators/6/expr/params/periods',
    ]);
  });

  it('compares the value of a constant as a decimal number, not as text, wherever the constant stands', () => {
    // '100' < '9' and '30' < '9' as text. As numbers only 0, 0, 2 and 5 are below 9.
    const p = policy();
    permission(p, 'operator:const@1').parameter_bounds = [{ parameter: 'value', minimum: '9', maximum: '100' }];
    expect(check(draft(), p).map((entry) => entry.pointer)).toEqual([
      '/definition/entry/condition/args/4/args/1/params/value',
      '/definition/entry/condition/args/5/args/1/params/value',
      '/definition/exits/stop/args/1/args/0/params/value',
      '/definition/exits/target/args/1/args/0/params/value',
    ]);
    permission(p, 'operator:const@1').parameter_bounds = [{ parameter: 'value', minimum: '0', maximum: '99.99' }];
    expect(check(draft(), p)).toEqual([
      expect.objectContaining({
        pointer: '/definition/entry/rank/args/1/args/0/params/value',
        detail: 'The value 100 of operator:const@1 is above the maximum 99.99 of the cohort policy.',
      }),
    ]);
  });

  it('applies no bound that the policy does not list: a parameter of an operator without a bound is free', () => {
    const p = policy();
    permission(p, 'operator:sma@1').parameter_bounds = [];
    permission(p, 'operator:lag@1').parameter_bounds = [{ parameter: 'periods', minimum: '1', maximum: '59' }];
    expect(check(draft(), p)).toEqual([]);
  });
});

describe('an operator that the policy does not permit', () => {
  it('is UNSUPPORTED_OPERATOR at the operator, wherever it stands in the tree', () => {
    const p = policy();
    p.conditions.operators.permitted = p.conditions.operators.permitted.filter(
      (entry: Doc) => entry.operator !== 'operator:rsi_simple@1' && entry.operator !== 'operator:div@1',
    );
    expect(check(draft(), p)).toEqual([
      {
        code: 'UNSUPPORTED_OPERATOR',
        pointer: '/definition/indicators/2/expr/op',
        detail: 'The operator operator:rsi_simple@1 is not permitted by the cohort policy.',
      },
      expect.objectContaining({
        code: 'UNSUPPORTED_OPERATOR',
        pointer: '/definition/entry/rank/args/0/args/1/op',
      }),
    ]);
  });

  it('is reported for a draft of another operator set', () => {
    const d = draft();
    d.operator_set = 'daily-long-only-seed@2';
    expect(check(d, policy())).toEqual([
      expect.objectContaining({ code: 'UNSUPPORTED_OPERATOR', pointer: '/operator_set' }),
    ]);
  });
});

describe('the execution section against the execution policy of the cohort', () => {
  it('is INVALID_PARAMETER where the draft asks for a phase that daily-long-only-cash@1 does not support', () => {
    const d = draft();
    d.definition.execution = { entry_fill: 'SAME_CLOSE', decision: 'BEFORE_OPEN' };
    expect(check(d, policy())).toEqual([
      expect.objectContaining({ code: 'INVALID_PARAMETER', pointer: '/definition/execution/entry_fill' }),
      expect.objectContaining({ code: 'INVALID_PARAMETER', pointer: '/definition/execution/decision' }),
    ]);
  });

  it('is INVALID_PARAMETER when the policy names an execution policy whose requests are not known', () => {
    const p = policy();
    p.conditions.execution_policy.id = 'daily-long-only-cash@2';
    expect(check(draft(), p)).toEqual([expect.objectContaining({ pointer: '/definition/execution' })]);
  });
});

describe('the diagnostics of a draft', () => {
  it('are at most 64, as validation-result/1 allows, and their text at most 1000 characters', () => {
    const d = draft();
    const leaf = { op: 'operator:nothing@1', args: [], params: {} };
    d.definition.indicators = Array.from({ length: 32 }, (_, index) => ({
      name: `ind${index}`,
      expr: { op: 'operator:nothing@1', args: Array.from({ length: 8 }, () => structuredClone(leaf)), params: {} },
    }));
    const found = check(d, policy());
    expect(found).toHaveLength(MAX_POLICY_DIAGNOSTICS);
    expect(found.every((entry) => entry.code === 'UNSUPPORTED_OPERATOR')).toBe(true);
    expect(describePolicyDiagnostics(found).length).toBeLessThanOrEqual(1000);
    expect(
      describePolicyDiagnostics(found).startsWith('UNSUPPORTED_OPERATOR at /definition/indicators/0/expr/op: '),
    ).toBe(true);
  });
});

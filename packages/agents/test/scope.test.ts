// The change scope of a controlled revision (OQ-02 section 3.1): ENTRY or EXIT registers, anything else does not.
// The S0 expectations are written by hand from the declared changes of the seeds: threshold 32 changes the entry
// rule, the break-even rule changes the exit rules, and seed 4 against seed 1 changes both.

import type { JsonObject } from '@openquant/api-contracts';
import { describe, expect, test } from 'vitest';
import { proposedForm, seedArtefact } from '../dev/world.ts';
import { classifyScope, computeDifference, type Scope } from '../src/index.ts';
import { withValue } from './support/oracle.ts';

const one = 'seed-1-rsi30-breakeven-off';
const two = 'seed-2-rsi32-breakeven-off';
const three = 'seed-3-rsi30-breakeven-on';
const four = 'seed-4-rsi32-breakeven-on';
const five = 'seed-5-rsi40-breakeven-off-data-only';

function scopeOf(parent: JsonObject, child: JsonObject): Scope {
  const proposed = proposedForm(child);
  return classifyScope(parent, proposed, computeDifference(parent, proposed).changes).scope;
}

describe('the S0 seeds', () => {
  test.each<[string, string, Scope]>([
    [one, two, 'ENTRY'],
    [one, three, 'EXIT'],
    [one, four, 'BOTH'],
    [two, four, 'EXIT'],
    [one, five, 'ENTRY'],
    [one, one, 'NONE'],
  ])('%s to %s is %s', (parent, child, expected) => {
    expect(scopeOf(seedArtefact(parent), seedArtefact(child))).toBe(expected);
  });
});

describe('a change under the rules of the definition', () => {
  const parent = seedArtefact(one);
  const change = (pointer: string, value: unknown) => withValue(parent, pointer, value);

  test('a change under the entry rule affects entry', () => {
    expect(scopeOf(parent, change('/definition/entry/condition/op', 'operator:or@1'))).toBe('ENTRY');
  });

  test('the stop multiple is an exit change', () => {
    expect(scopeOf(parent, change('/definition/exits/stop/args/1/args/0/params/value', '3'))).toBe('EXIT');
  });

  test('a changed indicator that only the exit rules reference is an exit change', () => {
    const base = withValue(parent, '/definition/indicators', [
      ...((parent.definition as JsonObject).indicators as unknown as JsonObject[]),
      { name: 'exit_level', expr: { op: 'operator:const@1', args: [], params: { value: '1', unit: 'RATIO' } } },
    ]);
    const reference = { op: 'operator:ref@1', args: [], params: { name: 'exit_level' } };
    const withExit = withValue(base, '/definition/exits/target', reference);
    const child = withValue(withExit, '/definition/indicators/8/expr/params/value', '2');
    expect(scopeOf(withExit, child)).toBe('EXIT');
  });

  test('a changed indicator that both rules reference is a change of both', () => {
    const base = withValue(parent, '/definition/exits/target', {
      op: 'operator:ref@1',
      args: [],
      params: { name: 'weak_threshold' },
    });
    const child = withValue(base, '/definition/indicators/5/expr/params/value', '33');
    expect(scopeOf(base, child)).toBe('BOTH');
  });
});

describe('a change that reaches a rule through other indicators', () => {
  // a is a constant, b reads a, c reads b, and only c is referenced by a rule. d is referenced by nothing.
  const ref = (name: string) => ({ op: 'operator:ref@1', args: [], params: { name } });
  const constant = (value: string) => ({ op: 'operator:const@1', args: [], params: { value, unit: 'RATIO' } });
  const definition = (entry: unknown, exits: unknown): JsonObject =>
    ({
      indicators: [
        { name: 'a', expr: constant('1') },
        { name: 'b', expr: { op: 'operator:add@1', args: [ref('a'), constant('1')], params: {} } },
        { name: 'c', expr: { op: 'operator:mul@1', args: [ref('b'), constant('2')], params: {} } },
        { name: 'd', expr: constant('9') },
      ],
      entry,
      exits,
    }) as unknown as JsonObject;
  const strategy = (entry: unknown, exits: unknown): JsonObject => ({ definition: definition(entry, exits) });
  const entryOnly = strategy({ condition: ref('c') }, { stop: constant('1') });
  const exitOnly = strategy({ condition: constant('1') }, { stop: ref('c') });

  function change(parent: JsonObject, pointer: string, value: unknown): Scope {
    const child = withValue(parent, pointer, value);
    return classifyScope(parent, child, computeDifference(parent, child).changes).scope;
  }

  test('the root indicator reaches the entry rule through two others', () => {
    expect(change(entryOnly, '/definition/indicators/0/expr/params/value', '5')).toBe('ENTRY');
  });

  test('and the exit rule when only the exit rule references the chain', () => {
    expect(change(exitOnly, '/definition/indicators/0/expr/params/value', '5')).toBe('EXIT');
  });

  test('an indicator that no rule references is outside a controlled revision', () => {
    expect(change(entryOnly, '/definition/indicators/3/expr/params/value', '5')).toBe('OUTSIDE');
  });

  test('a rename counts through the old name and the new name', () => {
    const renamed = withValue(entryOnly, '/definition/indicators/2/name', 'c2');
    expect(classifyScope(entryOnly, renamed, computeDifference(entryOnly, renamed).changes).scope).toBe('ENTRY');
  });

  test('an added indicator that no rule references is outside', () => {
    const added = withValue(entryOnly, '/definition/indicators', [
      ...((entryOnly.definition as JsonObject).indicators as unknown as JsonObject[]),
      { name: 'e', expr: constant('3') },
    ]);
    expect(classifyScope(entryOnly, added, computeDifference(entryOnly, added).changes).scope).toBe('OUTSIDE');
  });
});

describe('a change outside the entry and exit rules', () => {
  const parent = seedArtefact(one);
  test.each<[string, string, unknown]>([
    ['selection', '/definition/selection/slots', 4],
    ['sizing', '/definition/sizing/method', 'sizing:other@1'],
    ['execution', '/definition/execution/entry_fill', 'SAME_CLOSE'],
    ['the contract text', '/contract/hypothesis', 'A new hypothesis.'],
  ])('%s is outside', (_name, pointer, value) => {
    expect(scopeOf(parent, withValue(parent, pointer, value))).toBe('OUTSIDE');
  });

  test('one outside change makes an otherwise entry-only revision outside', () => {
    const child = withValue(
      withValue(parent, '/definition/indicators/5/expr/params/value', '32'),
      '/definition/selection/slots',
      4,
    );
    expect(scopeOf(parent, child)).toBe('OUTSIDE');
  });

  test('the operator set is outside', () => {
    const proposed = { ...proposedForm(parent), operator_set: 'another-set@1' };
    const changes = computeDifference(parent, proposed).changes;
    expect(changes.map((item) => item.path)).toEqual(['/operator_set']);
    expect(classifyScope(parent, proposed, changes).scope).toBe('OUTSIDE');
  });
});

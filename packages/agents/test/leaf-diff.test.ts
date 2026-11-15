// The leaf-level rule difference (OQ-03 section 3). The oracle is the set of S0 seed strategies: each variant declares
// its changes against its parent, and the Rust test `declared_changes_are_exactly_the_leaf_differences_to_the_parent`
// proves that those declarations are the real leaf differences. These tests reproduce them in TypeScript.

import { digest, type JsonObject, type JsonValue } from '@openquant/api-contracts';
import { describe, expect, test } from 'vitest';
import { proposedForm, seedArtefact } from '../dev/world.ts';
import {
  compareChanges,
  computeDifference,
  DECLARED_TEXT_LIMIT,
  leafChanges,
  render,
  renderValue,
} from '../src/index.ts';
import { leafPointers, withValue } from './support/oracle.ts';

const SEEDS = [
  'seed-1-rsi30-breakeven-off',
  'seed-2-rsi32-breakeven-off',
  'seed-3-rsi30-breakeven-on',
  'seed-4-rsi32-breakeven-on',
  'seed-5-rsi40-breakeven-off-data-only',
] as const;

interface Declared {
  readonly path: string;
  readonly from: string;
  readonly to: string;
}

const sortChanges = (changes: readonly Declared[]) =>
  [...changes].map(({ path, from, to }) => ({ path, from, to })).sort((a, b) => (a.path < b.path ? -1 : 1));

// The parent of each variant, as the Rust test PARENT table records it: seeds 2, 3 and 5 derive from seed 1, and seed 4
// from seed 2. The hash each child declares for its parent is checked against the digest of the parent file below.
const PARENT: readonly (readonly [string, string])[] = [
  [SEEDS[1], SEEDS[0]],
  [SEEDS[2], SEEDS[0]],
  [SEEDS[3], SEEDS[1]],
  [SEEDS[4], SEEDS[0]],
];

describe('the S0 variants', () => {
  test.each(PARENT)(
    '%s against %s: the computed difference equals the changes that the fixture declares',
    async (childName, parentName) => {
      const child = seedArtefact(childName);
      const parent = seedArtefact(parentName);
      expect((child.parent as JsonObject).hash).toBe(await digest(parent));
      const declared = (child.parent as JsonObject).changes as unknown as Declared[];
      expect(declared.length).toBeGreaterThan(0);
      const difference = computeDifference(parent, proposedForm(child));
      expect(sortChanges(difference.declared)).toEqual(sortChanges(declared));
      expect(difference.undeclarable).toEqual([]);
    },
  );

  test('seed 4 against seed 1 differs by both changes, and declares only one against seed 2', () => {
    const difference = computeDifference(seedArtefact(SEEDS[0]), proposedForm(seedArtefact(SEEDS[3])));
    expect(difference.declared.map((item) => item.path).sort()).toEqual([
      '/definition/exits/stop_adjustments',
      '/definition/indicators/5/expr/params/value',
    ]);
  });
});

describe('every scalar leaf of a seed', () => {
  const seed = proposedForm(seedArtefact(SEEDS[0]));
  const pointers = leafPointers(seed);

  test('there are leaves to mutate', () => {
    expect(pointers.length).toBeGreaterThan(60);
  });

  test('changing one leaf at a time gives exactly one change at that pointer', () => {
    for (const pointer of pointers) {
      const original = pointer
        .split('/')
        .slice(1)
        .reduce<unknown>((node, token) => (node as Record<string, unknown>)[token], seed);
      const replacement =
        typeof original === 'string'
          ? `${original}-changed`
          : typeof original === 'number'
            ? original + 1
            : original !== true;
      const changed = withValue(seed, pointer, replacement);
      const changes = leafChanges(seed as JsonValue, changed as JsonValue);
      expect(
        changes.map((change) => change.path),
        pointer,
      ).toEqual([pointer]);
      expect(renderValue(changes[0]?.from)).toBe(String(original));
      expect(renderValue(changes[0]?.to)).toBe(String(replacement));
    }
  });

  test('the difference is symmetric: swapping parent and child swaps from and to', () => {
    const a = proposedForm(seedArtefact(SEEDS[0]));
    const b = proposedForm(seedArtefact(SEEDS[3]));
    const forward = leafChanges(a, b).map(render);
    const backward = leafChanges(b, a).map(render);
    expect(forward.length).toBeGreaterThan(0);
    expect(sortChanges(backward)).toEqual(
      sortChanges(forward.map(({ path, from, to }) => ({ path, from: to, to: from }))),
    );
  });
});

describe('what the difference ignores and counts', () => {
  const base = seedArtefact(SEEDS[0]);

  test('identical strategies differ by nothing', () => {
    expect(computeDifference(base, proposedForm(base)).changes).toEqual([]);
  });

  test('the members that identify a version are not compared', () => {
    const other = {
      ...base,
      strategy_id: 'another-id',
      version: 9,
      parent: { hash: `sha256:${'0'.repeat(64)}`, changes: [] },
    };
    expect(computeDifference(base, other as JsonObject).changes).toEqual([]);
  });

  test('a changed contract text is a change at its pointer', () => {
    const child = proposedForm(withValue(base, '/contract/rationale', 'Changed'));
    expect(computeDifference(base, child).declared.map((item) => item.path)).toEqual(['/contract/rationale']);
  });

  test('a list of a different length is one change at the list, written as ids', () => {
    const rule = { id: 'break_even', trigger: {}, new_level: {}, effective: 'NEXT_SESSION' };
    const child = proposedForm(
      withValue(base, '/definition/exits/stop_adjustments', [rule, { ...rule, id: 'second' }]),
    );
    expect(computeDifference(base, child).declared).toEqual([
      { path: '/definition/exits/stop_adjustments', from: '[]', to: 'break_even,second' },
    ]);
  });

  test('an added indicator is one change at the list; its text is too long to declare, so it cannot be proposed', () => {
    const extra = {
      name: 'sma200',
      expr: {
        op: 'operator:sma@1',
        args: [{ op: 'operator:bar_field@1', args: [], params: { field: 'CLOSE' } }],
        params: { window: 200 },
      },
    };
    const indicators = (base.definition as JsonObject).indicators as JsonValue[];
    const child = proposedForm(withValue(base, '/definition/indicators', [...indicators, extra]));
    const difference = computeDifference(base, child);
    expect(difference.declared.map((item) => item.path)).toEqual(['/definition/indicators']);
    expect(Array.from(difference.declared[0]?.from ?? '').length).toBeGreaterThan(DECLARED_TEXT_LIMIT);
    expect(difference.undeclarable).toEqual(difference.declared);
  });

  test('a member present on one side only is a change from or to null', () => {
    const changes = leafChanges({ a: 1 }, { a: 1, b: 2 });
    expect(changes.map(render)).toEqual([{ path: '/b', from: 'null', to: '2' }]);
    expect(leafChanges({ b: 'x' }, {}).map(render)).toEqual([{ path: '/b', from: 'x', to: 'null' }]);
  });

  test('a changed scalar type is one change: a number against a string', () => {
    expect(leafChanges({ a: 1 }, { a: '1' }).map(render)).toEqual([{ path: '/a', from: '1', to: '1' }]);
  });
});

describe('how a value is written in a declared change', () => {
  test('text as itself, lists as ids or compact JSON with sorted keys, other values as JSON', () => {
    expect(renderValue('30')).toBe('30');
    expect(renderValue([])).toBe('[]');
    expect(renderValue([{ id: 'a' }, { id: 'b', x: 1 }])).toBe('a,b');
    expect(renderValue([{ z: 1, a: { y: true } }, 3])).toBe('{"a":{"y":true},"z":1},3');
    expect(renderValue(7)).toBe('7');
    expect(renderValue(false)).toBe('false');
    expect(renderValue(null)).toBe('null');
    expect(renderValue(undefined)).toBe('null');
    expect(renderValue({ b: 1, a: [] })).toBe('{"a":[],"b":1}');
  });
});

describe('comparing declared changes with the computed difference', () => {
  const one = { path: '/a', from: '1', to: '2' };
  const two = { path: '/b', from: '3', to: '4' };

  test('equal in any order', () => {
    expect(compareChanges([two, one], [one, two]).equal).toBe(true);
  });

  test('a computed change that is not declared is missing', () => {
    const result = compareChanges([one], [one, two]);
    expect(result.equal).toBe(false);
    expect(result.missing).toEqual([two]);
    expect(result.extra).toEqual([]);
  });

  test('a declared change that is not computed is extra, and so is a repeated one', () => {
    expect(compareChanges([one, two], [one]).extra).toEqual([two]);
    expect(compareChanges([one, one], [one]).extra).toEqual([one]);
  });

  test('a change with another value is both missing and extra', () => {
    const result = compareChanges([{ ...one, to: '9' }], [one]);
    expect(result.missing).toEqual([one]);
    expect(result.extra).toEqual([{ ...one, to: '9' }]);
  });
});

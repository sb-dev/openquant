// The value bound of the contract layer (validate.ts, strict-json.ts): it is never below what a valid
// document can hold, and past it the parse still applies every strict-JSON rule.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { contracts, isContractName, parseContract, StrictJsonError, valueBound } from '../src/index.ts';
import { MAX_NODES } from '../src/limits.ts';
import { type JsonValue, scanStrictJson } from '../src/strict-json.ts';
import { maxValues } from '../tools/generate.ts';
import { fixturesDir, readManifest } from './support/manifest.ts';

function count(value: JsonValue): number {
  if (Array.isArray(value)) return 1 + value.reduce<number>((sum, item) => sum + count(item), 0);
  if (typeof value === 'object' && value !== null) {
    return 1 + Object.values(value).reduce<number>((sum, item) => sum + count(item), 0);
  }
  return 1;
}

describe('the schema maximum of values', () => {
  const defs = {
    Leaf: { type: 'string' },
    Pair: {
      type: 'object',
      additionalProperties: false,
      properties: { a: { $ref: '#/$defs/Leaf' }, b: { type: 'integer' } },
    },
    Node: {
      type: 'object',
      additionalProperties: false,
      properties: { children: { type: 'array', maxItems: 2, items: { $ref: '#/$defs/Node' } } },
    },
  };
  test.each<[string, unknown, number]>([
    ['a scalar', { type: 'boolean' }, 1],
    ['a closed object counts every property as present', { $ref: '#/$defs/Pair' }, 3],
    ['an array counts maxItems items', { type: 'array', maxItems: 4, items: { $ref: '#/$defs/Pair' } }, 13],
    ['an empty array', { type: 'array', maxItems: 0, items: { $ref: '#/$defs/Pair' } }, 1],
    ['an enum counts its largest literal', { enum: ['a', ['b', 'c']] }, 3],
    ['oneOf takes the largest form', { oneOf: [{ type: 'string' }, { $ref: '#/$defs/Pair' }] }, 3],
    ['allOf takes the smallest part', { allOf: [{ $ref: '#/$defs/Pair' }, { type: 'string' }] }, 1],
    ['not removes documents and is ignored', { type: 'string', not: { pattern: '^-' } }, 1],
    ['an open object is unbounded', { type: 'object', properties: { a: { type: 'string' } } }, Infinity],
    ['an array without maxItems is unbounded', { type: 'array', items: { type: 'string' } }, Infinity],
    ['a schema without a type is unbounded', { description: 'anything' }, Infinity],
    ['a recursive reference is unbounded', { $ref: '#/$defs/Node' }, Infinity],
  ])('%s', (_label, schema, expected) => {
    expect(maxValues(defs as never, schema as never)).toBe(expected);
  });
});

describe('the value bound of each contract', () => {
  test('only the contracts that hold an Expr tree are unbounded', () => {
    const unbounded = Object.entries(contracts)
      .filter(([, contract]) => contract.maxValues === null)
      .map(([name]) => name);
    expect(unbounded.sort()).toEqual(['command', 'strategy-artefact']);
  });

  test('the bound is at least MAX_NODES, so Rust also finds an excess above it', () => {
    for (const name of Object.keys(contracts)) {
      if (!isContractName(name)) continue;
      const bound = valueBound(name);
      expect(bound, name).toBeGreaterThanOrEqual(MAX_NODES);
      if (contracts[name].maxValues !== null)
        expect(bound, name).toBeGreaterThanOrEqual(contracts[name].maxValues ?? 0);
    }
  });

  test('every accepted protocol fixture is within its schema maximum', () => {
    const { entries } = readManifest();
    let checked = 0;
    for (const entry of entries) {
      if (entry.expect === 'schema_invalid' || !isContractName(entry.contract)) continue;
      const maximum = contracts[entry.contract].maxValues ?? Number.POSITIVE_INFINITY;
      const values = count(JSON.parse(readFileSync(resolve(fixturesDir, entry.path), 'utf8')) as JsonValue);
      expect(values, entry.path).toBeLessThanOrEqual(maximum);
      checked += 1;
    }
    expect(checked).toBeGreaterThan(90);
  });

  test('a document just at the bound is parsed in full', () => {
    // 1 root + 1 version + 1 array + items = MAX_NODES values.
    const items = Array(MAX_NODES - 3)
      .fill('0')
      .join(',');
    const text = `{"schema_version":"api-error/1","violations":[${items}]}`;
    const result = parseContract('api-error', text);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('schema');
    const over = parseContract('api-error', text.replace('[0,', '[0,0,'));
    expect(over.ok).toBe(false);
    if (!over.ok) expect([over.error.kind, over.error.code]).toEqual(['value-bound', 'SCHEMA_VIOLATION']);
  });
});

describe('the scan past the bound', () => {
  const scan = (text: string, bound = 3) => scanStrictJson(text, { valueBound: bound });
  const kind = (text: string, bound = 3) => {
    try {
      scan(text, bound);
      return 'accepted';
    } catch (error) {
      if (error instanceof StrictJsonError) return error.kind;
      throw error;
    }
  };

  test('within the bound nothing changes', () => {
    expect(scan('[1,2]')).toEqual({ value: [1, 2] });
    // The array counts as a value: its third item is the fourth value.
    expect(scan('[1,2,3]')).toEqual({ value: [1, 2], exceededValueBound: 3 });
  });

  test('keeps the first values and a top-level schema_version read after the bound', () => {
    const { value, exceededValueBound } = scan('{"a":[1,2,3,4],"schema_version":"x/1","b":5}');
    expect(exceededValueBound).toBe(3);
    expect(value).toEqual({ schema_version: 'x/1' });
    expect(scan('{"a":[1,2,3],"schema_version":{"v":"x/1"}}').value).toEqual({ schema_version: null });
    expect(scan('{"a":[1,2,3],"schema_version":7}').value).toEqual({ schema_version: null });
    // Only a top-level member is kept, and a container that passed the bound is not attached.
    expect(scan('[[1,2,3],{"schema_version":"x/1"}]').value).toEqual([]);
  });

  test.each<[string, string, string]>([
    ['a duplicate key in a later object', '[0,0,0,{"a":1,"a":2}]', 'duplicate-key'],
    ['a duplicate key written with an escape', '[0,0,0,{"a":1,"\\u0061":2}]', 'duplicate-key'],
    ['a key repeated after its value passed the bound', '{"a":[0,0,0],"a":1}', 'duplicate-key'],
    ['a key repeated after the bound in a built object', '{"a":0,"b":[0,0],"a":1}', 'duplicate-key'],
    [
      'a repeated top-level schema_version',
      '{"schema_version":"x/1","b":[0,0,0],"schema_version":"x/1"}',
      'duplicate-key',
    ],
    ['a float', '[0,0,0,1.5]', 'float-number'],
    ['negative zero', '[0,0,0,-0]', 'float-number'],
    ['a control character in a string', '[0,0,0,"a\u0001"]', 'json'],
    ['a lone surrogate escape', '[0,0,0,"\\ud800"]', 'json'],
    ['a trailing comma', '[0,0,0,]', 'json'],
    ['trailing text', '[0,0,0] x', 'json'],
    ['deep nesting', `[0,0,0,${'['.repeat(130)}${']'.repeat(130)}]`, 'json'],
  ])('%s is still an error', (_label, text, expected) => {
    expect(kind(text)).toBe(expected);
  });

  test('a wide object past the bound finds a duplicate among many keys, and no false one', () => {
    const keys = Array.from({ length: 5000 }, (_, i) => `"k${i}":0`).join(',');
    expect(kind(`[0,0,0,{${keys}}]`)).toBe('accepted');
    expect(kind(`[0,0,0,{${keys},"k4999":1}]`)).toBe('duplicate-key');
    expect(kind(`[0,0,0,{${keys},"\\u006b17":1}]`)).toBe('duplicate-key');
    expect(kind(`{${keys},"k3":1}`, 100)).toBe('duplicate-key');
  });

  test('an unsafe integer past the bound is still reported', () => {
    expect(scan('[0,0,0,9007199254740993]').unsafeInteger).toBe('9007199254740993');
  });
});

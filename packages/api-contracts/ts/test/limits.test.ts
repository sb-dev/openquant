import { describe, expect, test } from 'vitest';
import {
  compareCodePoints,
  firstExcess,
  MAX_ARRAY_LEN,
  MAX_DEPTH,
  MAX_NODES,
  MAX_OBJECT_KEYS,
  MAX_STRING_BYTES,
} from '../src/limits.ts';
import type { JsonValue } from '../src/strict-json.ts';

const nest = (depth: number): JsonValue => {
  let value: JsonValue = 0;
  for (let level = 0; level < depth; level += 1) value = [value];
  return value;
};

describe('a document within the limits has no excess', () => {
  test.each<[string, JsonValue]>([
    ['scalars', 'text'],
    ['the largest array', Array(MAX_ARRAY_LEN).fill(0)],
    ['the widest object', Object.fromEntries(Array.from({ length: MAX_OBJECT_KEYS }, (_, i) => [`k${i}`, i]))],
    ['the longest string', 'x'.repeat(MAX_STRING_BYTES)],
    // 1 + 7 × (1 + 2856) = 20,000 values.
    ['the most values', Array.from({ length: 7 }, () => Array(2856).fill(0))],
    ['the deepest value', nest(MAX_DEPTH - 1)],
  ])('%s', (_label, value) => {
    expect(firstExcess(value)).toBeUndefined();
  });
});

describe('the first excess, in document order', () => {
  test.each<[string, JsonValue, string, RegExp]>([
    ['an array', { a: Array(MAX_ARRAY_LEN + 1).fill(0) }, '/a', /array of 8193 items is longer than 8192/],
    [
      'an object',
      [Object.fromEntries(Array.from({ length: MAX_OBJECT_KEYS + 1 }, (_, i) => [`k${i}`, i]))],
      '/0',
      /object of 65 properties is wider than 64/,
    ],
    [
      'a string, in bytes',
      { s: 'é'.repeat(MAX_STRING_BYTES / 2 + 1) },
      '/s',
      /string of 16386 bytes is longer than 16384/,
    ],
    // Values 1 to 16,004 are the root, two arrays of 8,000 and the third array; value 20,001 is item 3,996.
    [
      'the value count',
      Array.from({ length: 3 }, () => Array(8000).fill(0)),
      '/2/3996',
      new RegExp(`more than ${MAX_NODES} values`),
    ],
    ['the depth', nest(MAX_DEPTH), `/${Array(MAX_DEPTH).fill('0').join('/')}`, /deeper than 128 levels/],
  ])('%s', (_label, value, pointer, message) => {
    const excess = firstExcess(value);
    expect(excess).toMatchObject({ pointer, decimalGrammar: false });
    expect(excess?.message).toMatch(message);
    expect(excess?.message).toMatch(/the document is not examined further$/);
  });

  test('object keys are walked in byte order and escaped in the pointer', () => {
    const long = Array(MAX_ARRAY_LEN + 1).fill(0);
    expect(firstExcess({ b: long, 'a/~': long })?.pointer).toBe('/a~1~0');
  });
});

test('code point order is UTF-8 byte order', () => {
  const keys = ['\u{1f600}', '￿', 'b', 'a', 'é', ''];
  expect(keys.sort(compareCodePoints)).toEqual(['', 'a', 'b', 'é', '￿', '\u{1f600}']);
});

import { describe, expect, test } from 'vitest';
import { CanonicalError, canonicalJson, digest, digestBytes, parseStrictJson } from '../src/index.ts';

// Golden vectors from openquant_contracts::{parse_json, canonical_json, digest} at 9c96e54, produced
// by a scratch probe. They pin the TypeScript output to the Rust bytes: key order, escapes and the
// raw text of U+007F, U+2028 and non-ASCII characters.
const vectors = [
  {
    input:
      '{"b":"\\u0001\\u001f\\b\\f\\n\\r\\t\\"\\\\/\u007f é   \u{1f600}","a":[1,-2,true,false,null,9007199254740991,-9007199254740991],"B":{},"_":0,"aa":"","~":{"z":[],"y":{"x":null}}}',
    canonical:
      '{"B":{},"_":0,"a":[1,-2,true,false,null,9007199254740991,-9007199254740991],"aa":"","b":"\\u0001\\u001f\\b\\f\\n\\r\\t\\"\\\\/\u007f é   \u{1f600}","~":{"y":{"x":null},"z":[]}}',
    digest: 'sha256:20c01478b3a5f69cd6955cf6695d5c930ca424fb5fd242a2792fc973d9206014',
  },
  {
    input: '{"a\\u0000":1,"a":2,"a\\u001f":3,"A":4,"":5,"a b":["\\u00e9\\ud83d\\ude00"]}',
    canonical: '{"":5,"A":4,"a":2,"a\\u0000":1,"a\\u001f":3,"a b":["é\u{1f600}"]}',
    digest: 'sha256:40e8964a4a69e3cc388c339e2d4d3f686f2e6691a8c8110dcb1a1217b7f84dac',
  },
  { input: '[]', canonical: '[]', digest: 'sha256:4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945' },
  { input: '""', canonical: '""', digest: 'sha256:12ae32cb1ec02d01eda3581b127c1fee3b0dc53572ed6baf239721a03d82e126' },
  { input: '0', canonical: '0', digest: 'sha256:5feceb66ffc86f38d952786c6d696c79c2dbc239dd4e91b46729d73a27fb57e9' },
];

describe('canonical JSON equals the Rust bytes', () => {
  test.each(vectors)('$canonical', async ({ input, canonical, digest: expected }) => {
    const value = parseStrictJson(input);
    expect(canonicalJson(value)).toBe(canonical);
    expect(await digest(value)).toBe(expected);
  });
});

describe('escapes', () => {
  test('each control character below U+0020', () => {
    const short: Record<number, string> = { 8: '\\b', 9: '\\t', 10: '\\n', 12: '\\f', 13: '\\r' };
    for (let code = 0; code < 0x20; code += 1) {
      const expected = short[code] ?? `\\u${code.toString(16).padStart(4, '0')}`;
      expect(canonicalJson(String.fromCharCode(code))).toBe(`"${expected}"`);
    }
  });

  test('quote and backslash, and nothing else', () => {
    expect(canonicalJson('"\\/ \u007f\u0080  ﻿')).toBe('"\\"\\\\/ \u007f\u0080  ﻿"');
    expect(canonicalJson('\u{1f600}')).toBe('"\u{1f600}"');
  });

  test('keys are escaped like values', () => {
    expect(canonicalJson({ 'a\nb': 1 })).toBe('{"a\\nb":1}');
  });
});

describe('key order', () => {
  test('byte order, which puts upper case before lower case and _ between them', () => {
    expect(canonicalJson({ b: 1, a: 2, B: 3, _: 4, '': 5, aa: 6, 'a~': 7, '10': 8, '9': 9 })).toBe(
      '{"":5,"10":8,"9":9,"B":3,"_":4,"a":2,"aa":6,"a~":7,"b":1}',
    );
  });

  test('nested objects are sorted and arrays keep their order', () => {
    expect(canonicalJson({ z: [{ d: 1, c: 2 }, 3, 'x'], y: { b: { a: null } } })).toBe(
      '{"y":{"b":{"a":null}},"z":[{"c":2,"d":1},3,"x"]}',
    );
  });

  test('a null-prototype object is a plain object', () => {
    const value = Object.assign(Object.create(null) as Record<string, number>, { b: 1, a: 2 });
    expect(canonicalJson(value)).toBe('{"a":2,"b":1}');
  });
});

describe('values with no canonical form', () => {
  test.each<[string, unknown]>([
    ['a fraction', 1.5],
    ['an integer outside the exact range', 2 ** 53],
    ['NaN', Number.NaN],
    ['infinity', Number.POSITIVE_INFINITY],
    ['a non-ASCII key', { é: 1 }],
    ['a lone high surrogate', '\ud800'],
    ['a lone low surrogate', 'a\udc00'],
    ['undefined', undefined],
    ['undefined in an object', { a: undefined }],
    ['a hole in an array', Array<unknown>(2)],
    ['a bigint', 1n],
    ['a function', () => 1],
    ['a date', new Date(0)],
    ['a map', new Map()],
    ['128 nested arrays', JSON.parse('['.repeat(128) + ']'.repeat(128))],
  ])('%s', (_label, value) => {
    expect(() => canonicalJson(value)).toThrow(CanonicalError);
  });

  test('127 nested arrays have one', () => {
    const text = '['.repeat(127) + ']'.repeat(127);
    expect(canonicalJson(JSON.parse(text))).toBe(text);
  });

  test('negative zero is the integer zero', () => {
    expect(canonicalJson(-0)).toBe('0');
  });
});

test('digestBytes hashes raw bytes', async () => {
  expect(await digestBytes(new Uint8Array())).toBe(
    'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  );
  expect(await digestBytes(new TextEncoder().encode('abc'))).toBe(
    'sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  );
});

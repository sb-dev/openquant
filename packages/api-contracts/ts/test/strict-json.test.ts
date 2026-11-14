import { describe, expect, test } from 'vitest';
import {
  MAX_NESTING,
  MAX_PAYLOAD_BYTES,
  parseStrictJson,
  StrictJsonError,
  type StrictJsonErrorKind,
} from '../src/index.ts';
import { scanStrictJson } from '../src/strict-json.ts';

function kindOf(input: string | Uint8Array): StrictJsonErrorKind | 'accepted' {
  try {
    parseStrictJson(input);
    return 'accepted';
  } catch (error) {
    if (error instanceof StrictJsonError) {
      expect(error.code).toBe('SCHEMA_VIOLATION');
      return error.kind;
    }
    throw error;
  }
}

const nested = (depth: number, open: string, close: string, inner = '') =>
  open.repeat(depth) + inner + close.repeat(depth);

// The cases were run through openquant_contracts::parse_json at 9c96e54 in a scratch probe. Accepted
// texts are accepted there and rejected texts are rejected there, with two exceptions by design. An
// unsafe-integer text parses in Rust, and its schema then rejects it (see validate.ts). A raw lone
// surrogate cannot occur in a Rust string.
describe('the strict parser accepts what strict.rs accepts', () => {
  test.each([
    ['0', 0],
    ['-5', -5],
    ['9007199254740991', 9007199254740991],
    ['-9007199254740991', -9007199254740991],
    [' \t\n\r{} \n', {}],
    ['"\\u00E9\\u00e9"', 'éé'],
    ['"\\/\\b\\f\\n\\r\\t\\"\\\\"', '/\b\f\n\r\t"\\'],
    ['"\\ud83d\\ude00 😀"', '😀 😀'],
    ['"a\u007fb"', 'a\u007fb'],
    ['[true,false,null,"",[],{}]', [true, false, null, '', [], {}]],
    ['{"a":{"b":[1,{"c":"d"}]}}', { a: { b: [1, { c: 'd' }] } }],
  ])('%s', (text, value) => {
    expect(parseStrictJson(text)).toEqual(value);
  });

  test('127 nested arrays or objects are accepted', () => {
    expect(kindOf(nested(MAX_NESTING - 1, '[', ']'))).toBe('accepted');
    expect(kindOf(nested(MAX_NESTING - 1, '[', ']', '1'))).toBe('accepted');
    expect(kindOf(nested(MAX_NESTING - 1, '{"a":', '}', '0'))).toBe('accepted');
  });

  test('a __proto__ key is an own property, as with JSON.parse', () => {
    const value = parseStrictJson('{"__proto__":{"polluted":1}}') as Record<string, unknown>;
    expect(Object.keys(value)).toEqual(['__proto__']);
    expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe('the strict parser rejects what strict.rs rejects', () => {
  test.each<[string, string, StrictJsonErrorKind]>([
    ['a duplicate key', '{"a":1,"a":2}', 'duplicate-key'],
    ['a nested duplicate key', '{"a":{"b":1,"b":1}}', 'duplicate-key'],
    ['a duplicate key written with an escape', '{"a":1,"\\u0061":2}', 'duplicate-key'],
    ['a duplicate key before a float', '{"a":1,"a":2.5}', 'duplicate-key'],
    ['a fraction', '1.0', 'float-number'],
    ['an exponent', '1E2', 'float-number'],
    ['a float before a duplicate key', '{"a":1.5,"a":2}', 'float-number'],
    ['negative zero', '-0', 'float-number'],
    ['an integer above 2^64 - 1', '18446744073709551616', 'float-number'],
    ['an integer below -2^63', '-9223372036854775809', 'float-number'],
    ['an integer above 2^53 - 1', '9007199254740992', 'unsafe-integer'],
    ['2^64 - 1', '18446744073709551615', 'unsafe-integer'],
    ['-2^63', '-9223372036854775808', 'unsafe-integer'],
    ['a byte order mark', '﻿{}', 'json'],
    ['an escaped lone high surrogate', '"\\ud800"', 'json'],
    ['an escaped lone low surrogate', '"\\udc00"', 'json'],
    ['a high surrogate escape followed by text', '"\\ud800x"', 'json'],
    ['a raw lone surrogate', '"\ud800"', 'json'],
    ['a raw control character', '"a\u0001b"', 'json'],
    ['trailing characters', '{} x', 'json'],
    ['a NUL after the value', '{}\u0000', 'json'],
    ['form feed as whitespace', '\f{}', 'json'],
    ['a leading zero', '01', 'json'],
    ['a lone minus', '-', 'json'],
    ['empty text', '', 'json'],
    ['a trailing comma', '[1,]', 'json'],
    ['an invalid escape', '"\\x"', 'json'],
    ['an unterminated string', '"abc', 'json'],
    ['a single-quoted string', "'a'", 'json'],
    ['a bare word', 'nul', 'json'],
    ['a missing colon', '{"a" 1}', 'json'],
    ['a dot without digits', '1.', 'json'],
  ])('%s', (_label, text, kind) => {
    expect(kindOf(text)).toBe(kind);
  });

  test('128 nested arrays or objects exceed the serde_json recursion limit', () => {
    expect(kindOf(nested(MAX_NESTING, '[', ']'))).toBe('json');
    expect(kindOf(nested(MAX_NESTING, '{"a":', '}', '0'))).toBe('json');
  });

  test('a payload above 16 MiB of UTF-8 is too large, measured in bytes', () => {
    expect(kindOf(`0${' '.repeat(MAX_PAYLOAD_BYTES - 1)}`)).toBe('accepted');
    expect(kindOf(`0${' '.repeat(MAX_PAYLOAD_BYTES)}`)).toBe('too-large');
    // Two bytes per character: fewer code units than the limit, more bytes.
    expect(kindOf(`"${'é'.repeat(MAX_PAYLOAD_BYTES / 2)}"`)).toBe('too-large');
    expect(kindOf(new Uint8Array(MAX_PAYLOAD_BYTES + 1).fill(0x20))).toBe('too-large');
  });

  test('bytes must be valid UTF-8', () => {
    expect(kindOf(new Uint8Array([0x22, 0xff, 0x22]))).toBe('json');
    expect(kindOf(new Uint8Array([0x22, 0xc3, 0xa9, 0x22]))).toBe('accepted');
    expect(kindOf(new Uint8Array([0xef, 0xbb, 0xbf, 0x7b, 0x7d]))).toBe('json');
  });
});

test('the scan defers an unsafe integer and reports the first one', () => {
  expect(scanStrictJson('[9007199254740993, 18446744073709551615]')).toMatchObject({
    unsafeInteger: '9007199254740993',
  });
  expect(scanStrictJson('[1, 2]')).toEqual({ value: [1, 2] });
  expect(() => scanStrictJson('[9007199254740993, 1.5]')).toThrow(StrictJsonError);
});

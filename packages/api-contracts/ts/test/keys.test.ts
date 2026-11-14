// The key limit (MAX_KEY_BYTES, limits.ts; OQ-05 §7). The parse never decodes a key whose text is
// longer, and refuses its document with SCHEMA_VIOLATION after the version check. The limit never
// refuses a valid document, and Rust, which has no key limit, gives every such document the same
// code: every schema closes every object, so the long key is an unknown property there.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { contracts, isContractName, parseContract } from '../src/index.ts';
import { MAX_KEY_BYTES } from '../src/limits.ts';
import { StrictJsonError, type StrictScan, scanStrictJson } from '../src/strict-json.ts';
import { bundleDefs } from './support/error-shape.ts';
import { fixturesDir, readManifest } from './support/manifest.ts';
import { declaredNames, onlyDeclaredKeys } from './support/schema-text.ts';

const utf8Bytes = (text: string) => new TextEncoder().encode(text).length;
/** Every character of `text` as a \u escape: six bytes of text for each UTF-16 code unit. */
const escapeAll = (text: string) =>
  Array.from({ length: text.length }, (_, i) => `\\u${text.charCodeAt(i).toString(16).padStart(4, '0')}`).join('');

describe('the schemas admit only declared property names, and the key limit holds every one', () => {
  const defs = bundleDefs();
  const names = declaredNames(defs);

  test('the longest declared name, escaped in full, is within the limit', () => {
    const longest = Math.max(...[...names].map(utf8Bytes));
    expect(longest).toBe(25);
    expect([...names].filter((name) => utf8Bytes(name) === longest).sort()).toEqual([
      'automatic_paper_promotion',
      'concurrent_agent_attempts',
      'concurrent_batch_attempts',
    ]);
    // An escape writes one byte of a name as at most six bytes of text.
    expect(6 * longest).toBeLessThanOrEqual(MAX_KEY_BYTES);
    expect([...names].every((name) => /^[\x20-\x7e]*$/.test(name))).toBe(true);
  });

  test('every contract closes every object it admits', () => {
    for (const [name, contract] of Object.entries(contracts)) {
      expect(onlyDeclaredKeys(defs, { $ref: `#/$defs/${contract.typeName}` }, names), name).toBe(true);
    }
  });

  test.each<[string, unknown, boolean]>([
    ['a closed object', { type: 'object', additionalProperties: false, properties: { a: { type: 'string' } } }, true],
    ['an open object', { type: 'object', properties: { a: { type: 'string' } } }, false],
    ['a map', { type: 'object', additionalProperties: { type: 'string' } }, false],
    [
      'a closed object with an open property',
      { type: 'object', additionalProperties: false, properties: { a: { type: 'object' } } },
      false,
    ],
    ['an array of closed objects', { type: 'array', items: { $ref: '#/$defs/Closed' } }, true],
    ['an array without items', { type: 'array' }, false],
    ['a scalar', { type: 'string' }, true],
    ['no type', { description: 'anything' }, false],
    ['true', true, false],
    ['oneOf with an open branch', { oneOf: [{ $ref: '#/$defs/Closed' }, { type: 'object' }] }, false],
    ['anyOf of closed branches', { anyOf: [{ $ref: '#/$defs/Closed' }, { type: 'integer' }] }, true],
    ['allOf with one closed part', { allOf: [{ type: 'object' }, { $ref: '#/$defs/Closed' }] }, true],
    ['an enum of literal objects with declared keys', { enum: [{ a: 1 }] }, true],
    ['an enum of a literal object with another key', { enum: [{ other: 1 }] }, false],
    ['a recursive closed definition', { $ref: '#/$defs/Tree' }, true],
  ])('%s: %s', (_label, schema, expected) => {
    const sample = {
      Closed: { type: 'object', additionalProperties: false, properties: { a: { type: 'string' } } },
      Tree: {
        type: 'object',
        additionalProperties: false,
        properties: { a: { type: 'array', maxItems: 2, items: { $ref: '#/$defs/Tree' } } },
      },
    };
    expect(onlyDeclaredKeys(sample as never, schema as never, new Set(['a']))).toBe(expected);
  });

  test('every valid fixture with every key escaped in full parses to the same value', () => {
    let checked = 0;
    for (const entry of readManifest().entries) {
      if (entry.expect === 'schema_invalid' || !isContractName(entry.contract)) continue;
      const text = readFileSync(resolve(fixturesDir, entry.path), 'utf8');
      const escaped = text.replace(
        /"([A-Za-z0-9_]+)"(\s*:)/g,
        (_match, key: string, colon: string) => `"${escapeAll(key)}"${colon}`,
      );
      expect(escaped, entry.path).not.toBe(text);
      const original = parseContract(entry.contract, text);
      const rewritten = parseContract(entry.contract, escaped);
      expect(rewritten.ok, entry.path).toBe(true);
      if (original.ok && rewritten.ok) expect(rewritten.value).toEqual(original.value);
      checked += 1;
    }
    expect(checked).toBeGreaterThan(90);
  });
});

describe('the parse reads a long key without decoding it', () => {
  const scan = (text: string, bound = Number.POSITIVE_INFINITY): StrictScan =>
    scanStrictJson(text, { valueBound: bound, maxKeyBytes: MAX_KEY_BYTES });
  const kind = (text: string) => {
    try {
      scan(text);
      return 'accepted';
    } catch (error) {
      if (error instanceof StrictJsonError) return error.kind;
      throw error;
    }
  };
  const at = (bytes: number) => 'k'.repeat(bytes);

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('a key of MAX_KEY_BYTES bytes of text is read, one byte more is named and not built', () => {
    expect(scan(`{"${at(MAX_KEY_BYTES)}":1}`)).toEqual({ value: { [at(MAX_KEY_BYTES)]: 1 } });
    expect(scan(`{"a":1,"${at(MAX_KEY_BYTES + 1)}":2,"b":3}`)).toEqual({
      value: { a: 1 },
      longKey: { offset: 7, bytes: MAX_KEY_BYTES + 1, limit: MAX_KEY_BYTES },
    });
  });

  test('the limit counts the UTF-8 bytes of the text, escapes as written', () => {
    // é is two bytes; \n is two bytes of text for one decoded byte; a pair is four bytes either way.
    const e = 'é'.repeat(MAX_KEY_BYTES / 2);
    expect(scan(`{"${e}":0}`).longKey).toBeUndefined();
    expect(scan(`{"${e}a":0}`).longKey?.bytes).toBe(MAX_KEY_BYTES + 1);
    expect(scan(`{"${'\\n'.repeat(MAX_KEY_BYTES / 2)}":0}`).longKey).toBeUndefined();
    expect(scan(`{"${'\\n'.repeat(MAX_KEY_BYTES / 2)}a":0}`).longKey?.bytes).toBe(MAX_KEY_BYTES + 1);
    expect(scan(`{"${'😀'.repeat(MAX_KEY_BYTES / 4)}":0}`).longKey).toBeUndefined();
    expect(scan(`{"${'\\ud83d\\ude00'.repeat(MAX_KEY_BYTES / 12 + 1)}":0}`).longKey).toBeDefined();
  });

  test('a long key is never handed to the decoder', () => {
    const parse = vi.spyOn(JSON, 'parse');
    const key = `\\n${'a'.repeat(100_000)}一`;
    expect(scan(`{"x":[1],"${key}":{"${key}2":0},"z":"\\n"}`).longKey).toMatchObject({ offset: 9 });
    expect(parse.mock.calls.every(([text]) => String(text).length <= MAX_KEY_BYTES + 2)).toBe(true);
  });

  test('after a long key no value is built, and the top-level schema_version is still kept', () => {
    const long = at(MAX_KEY_BYTES + 1);
    expect(scan(`{"a":[1],"${long}":[2],"b":[3],"schema_version":"x/1"}`)).toMatchObject({
      value: { a: [1], schema_version: 'x/1' },
      longKey: { offset: 9 },
    });
    expect(scan(`{"o":{"${long}":0,"p":1},"schema_version":"x/1"}`).value).toEqual({ schema_version: 'x/1' });
  });

  test.each<[string, string, string]>([
    ['the same long key twice', `{"${at(300)}":0,"${at(300)}":1}`, 'duplicate-key'],
    ['the same long key written with escapes', `{"${at(300)}":0,"${escapeAll(at(20))}${at(280)}":1}`, 'duplicate-key'],
    ['a long key equal to a built key', `{"${at(100)}":0,"${escapeAll(at(50))}${at(50)}":1}`, 'duplicate-key'],
    ['a built key equal to an earlier long key', `{"${escapeAll(at(50))}${at(50)}":0,"${at(100)}":1}`, 'duplicate-key'],
    ['a key after a long key equal to a built key', `{"a":0,"${at(300)}":0,"\\u0061":1}`, 'duplicate-key'],
    ['different long keys', `{"${at(300)}":0,"${at(299)}b":1}`, 'accepted'],
    ['long keys equal up to their last character', `{"${at(300)}":0,"${at(300)}\\n":1}`, 'accepted'],
    ['a float after a long key', `{"${at(300)}":0,"b":1.5}`, 'float-number'],
    ['a bad escape in a long key', `{"${at(300)}\\x":0}`, 'json'],
    ['a lone surrogate in a long key', `{"${at(300)}\\ud800":0}`, 'json'],
    ['trailing text after a long key', `{"${at(300)}":0} x`, 'json'],
  ])('%s: %s', (_label, text, expected) => {
    expect(kind(text)).toBe(expected);
  });

  test('a wide object of long keys finds a duplicate among many, and no false one', () => {
    const keys = Array.from({ length: 3000 }, (_, i) => `"${at(MAX_KEY_BYTES)}${i}":0`).join(',');
    expect(kind(`{${keys}}`)).toBe('accepted');
    expect(kind(`{${keys},"${at(MAX_KEY_BYTES)}2999":1}`)).toBe('duplicate-key');
    expect(kind(`{${keys},"${escapeAll(at(MAX_KEY_BYTES))}17":1}`)).toBe('duplicate-key');
  });
});

describe('a contract refuses a long key after its version check, as Rust does', () => {
  const long = 'k'.repeat(MAX_KEY_BYTES + 1);
  const body = (version: string, extra: string) =>
    `{"schema_version":"${version}","code":"INTERNAL","message":"m","state_changed":"UNKNOWN","retry_safe":false,"diagnostic_ref":"diag-1"${extra}}`;
  const outcome = (text: string) => {
    const result = parseContract('api-error', text);
    return result.ok
      ? { verdict: 'accepted' }
      : { code: result.error.code, kind: result.error.kind, listingStopped: result.error.listingStopped };
  };

  test.each<[string, string, unknown]>([
    [
      'at the top level',
      body('api-error/1', `,"${long}":0`),
      { code: 'SCHEMA_VIOLATION', kind: 'structural-limit', listingStopped: true },
    ],
    [
      'one level down',
      body('api-error/1', `,"violations":[{"pointer":"","message":"m","${long}":0}]`),
      { code: 'SCHEMA_VIOLATION', kind: 'structural-limit', listingStopped: true },
    ],
    [
      'before the version',
      `{"${long}":0,${body('api-error/1', '').slice(1)}`,
      { code: 'SCHEMA_VIOLATION', kind: 'structural-limit', listingStopped: true },
    ],
    [
      'with another version',
      `{"${long}":0,${body('api-error/2', '').slice(1)}`,
      { code: 'UNSUPPORTED_SCHEMA_VERSION', kind: 'unsupported-version', listingStopped: false },
    ],
    [
      'with no version',
      `{"${long}":0,"code":"INTERNAL"}`,
      { code: 'SCHEMA_VIOLATION', kind: 'missing-version', listingStopped: false },
    ],
    [
      'twice, with another version',
      `{"${long}":0,"${long}":0,${body('api-error/2', '').slice(1)}`,
      { code: 'SCHEMA_VIOLATION', kind: 'duplicate-key', listingStopped: false },
    ],
    [
      'a declared name escaped in full',
      body('api-error/1', `,"${escapeAll('current_revision')}":3`),
      { verdict: 'accepted' },
    ],
  ])('%s', (_label, text, expected) => {
    expect(outcome(text)).toEqual(expected);
  });

  test('the violation names the key, its size and the limit', () => {
    const text = body('api-error/1', `,"${long}":0`);
    const result = parseContract('api-error', text);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.violations).toEqual([
      {
        pointer: '',
        message: `object key of ${MAX_KEY_BYTES + 1} bytes at offset ${text.indexOf(`"${long}"`)} is longer than ${MAX_KEY_BYTES}; the document is not examined further`,
        decimalGrammar: false,
      },
    ]);
  });
});

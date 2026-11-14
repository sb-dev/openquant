import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, expectTypeOf, test } from 'vitest';
import {
  type ContractFailureCode,
  type ContractName,
  contracts,
  DECIMAL_PATTERN,
  EXACT_MAX_LENGTH,
  EXACT_PATTERN,
  type Exact,
  type FailureCode,
  MAX_PAYLOAD_BYTES,
  parseContract,
  validateContract,
} from '../src/index.ts';
import { firstExcess, MAX_ARRAY_LEN, MAX_DEPTH, MAX_NODES, MAX_OBJECT_KEYS, MAX_STRING_BYTES } from '../src/limits.ts';
import { MAX_REPORTED_VIOLATIONS } from '../src/validate.ts';
import { fixturesDir, repositoryRoot } from './support/manifest.ts';

// Every expected code below was also confirmed against the Rust layer at 9c96e54 (parse_json then
// validate, through a scratch probe) for the checkpoint and evaluation-input cases.

// biome-ignore lint/suspicious/noExplicitAny: the tests edit fixture documents by path.
type Doc = Record<string, any>;

const fixture = (path: string): Doc => JSON.parse(readFileSync(resolve(fixturesDir, path), 'utf8')) as Doc;
const apiError = () => fixture('protocol/valid/api-error.stale-ownership.json');
const checkpoint = () => fixture('protocol/valid/checkpoint.exact-open-position-fraction.json');
const input = () => fixture('s0/cases/F0-smoke/input.json');

function outcome(contract: ContractName, text: string | Uint8Array) {
  const result = parseContract(contract, text);
  return result.ok
    ? { verdict: 'accepted' }
    : { verdict: 'rejected', code: result.error.code, kind: result.error.kind };
}

const rejected = (code: ContractFailureCode, kind: string) => ({ verdict: 'rejected', code, kind });

describe('the checks run in the Rust order', () => {
  test('a valid payload is accepted and typed', () => {
    const result = parseContract('api-error', JSON.stringify(apiError()));
    expect(result.ok).toBe(true);
    if (result.ok) expectTypeOf(result.value.schema_version).toEqualTypeOf<'api-error/1'>();
  });

  test('strict JSON first: SCHEMA_VIOLATION even when the version is also wrong', () => {
    const doc = JSON.stringify({ ...apiError(), schema_version: 'api-error/2' });
    expect(outcome('api-error', doc.replace('"current_revision":2', '"current_revision":2.5'))).toEqual(
      rejected('SCHEMA_VIOLATION', 'float-number'),
    );
    expect(outcome('api-error', `${doc.slice(0, -1)},"code":"X"}`)).toEqual(
      rejected('SCHEMA_VIOLATION', 'duplicate-key'),
    );
    expect(outcome('api-error', `${doc} x`)).toEqual(rejected('SCHEMA_VIOLATION', 'json'));
    expect(outcome('api-error', `${doc}${' '.repeat(MAX_PAYLOAD_BYTES)}`)).toEqual(
      rejected('SCHEMA_VIOLATION', 'too-large'),
    );
  });

  test('then the version: a missing or non-string version is SCHEMA_VIOLATION', () => {
    const { schema_version: _, ...rest } = apiError();
    expect(outcome('api-error', JSON.stringify(rest))).toEqual(rejected('SCHEMA_VIOLATION', 'missing-version'));
    expect(outcome('api-error', JSON.stringify({ ...rest, schema_version: 1 }))).toEqual(
      rejected('SCHEMA_VIOLATION', 'missing-version'),
    );
    expect(outcome('api-error', '[]')).toEqual(rejected('SCHEMA_VIOLATION', 'missing-version'));
    expect(outcome('api-error', '"api-error/1"')).toEqual(rejected('SCHEMA_VIOLATION', 'missing-version'));
  });

  test('another version tag is UNSUPPORTED_SCHEMA_VERSION, before any schema check', () => {
    expect(outcome('api-error', JSON.stringify({ schema_version: 'api-error/2', unknown: true }))).toEqual(
      rejected('UNSUPPORTED_SCHEMA_VERSION', 'unsupported-version'),
    );
    expect(outcome('checkpoint', JSON.stringify(apiError()))).toEqual(
      rejected('UNSUPPORTED_SCHEMA_VERSION', 'unsupported-version'),
    );
  });

  test('an integer above 2^53 - 1 is rejected after the version check, as the Rust schema rejects it', () => {
    const big = JSON.stringify(apiError()).replace('"current_revision":2', '"current_revision":9007199254740993');
    expect(outcome('api-error', big)).toEqual(rejected('SCHEMA_VIOLATION', 'unsafe-integer'));
    expect(outcome('api-error', big.replace('api-error/1', 'api-error/2'))).toEqual(
      rejected('UNSUPPORTED_SCHEMA_VERSION', 'unsupported-version'),
    );
  });

  test('then the schema', () => {
    expect(outcome('api-error', JSON.stringify({ ...apiError(), extra: 1 }))).toEqual(
      rejected('SCHEMA_VIOLATION', 'schema'),
    );
    expect(outcome('api-error', JSON.stringify({ ...apiError(), current_revision: 2 ** 31 }))).toEqual(
      rejected('SCHEMA_VIOLATION', 'schema'),
    );
  });
});

describe('decimal and Exact grammar failures are INVALID_DECIMAL', () => {
  test('a malformed Decimal alone', () => {
    const doc = checkpoint();
    doc.state.cash_available = '01.5';
    expect(outcome('checkpoint', JSON.stringify(doc))).toEqual(rejected('INVALID_DECIMAL', 'schema'));
  });

  test.each(['2/04', '1/0', '-0/3', '1.5/2', '+1/3', '1/-3', '1e5'])('a malformed Exact %s alone', (text) => {
    const doc = checkpoint();
    doc.state.positions[0].stop = text;
    expect(outcome('checkpoint', JSON.stringify(doc))).toEqual(rejected('INVALID_DECIMAL', 'schema'));
  });

  test('the Exact canonical rule is semantic: a non-reduced or terminating fraction passes here', () => {
    for (const text of ['2/6', '1/2', '4/1']) {
      const doc = checkpoint();
      doc.state.positions[0].stop = text;
      expect(outcome('checkpoint', JSON.stringify(doc))).toEqual({ verdict: 'accepted' });
    }
  });

  test('an Exact of 80 characters passes, a longer one fails maxLength: SCHEMA_VIOLATION', () => {
    const doc = checkpoint();
    doc.state.positions[0].stop = `1/${'3'.repeat(EXACT_MAX_LENGTH - 2)}`;
    expect(outcome('checkpoint', JSON.stringify(doc))).toEqual({ verdict: 'accepted' });
    doc.state.positions[0].stop = `1/${'3'.repeat(EXACT_MAX_LENGTH - 1)}`;
    expect(outcome('checkpoint', JSON.stringify(doc))).toEqual(rejected('SCHEMA_VIOLATION', 'schema'));
    doc.state.positions[0].stop = `1/0${'3'.repeat(EXACT_MAX_LENGTH - 2)}`;
    expect(outcome('checkpoint', JSON.stringify(doc))).toEqual(rejected('SCHEMA_VIOLATION', 'schema'));
  });

  test('a grammar failure with any other violation is SCHEMA_VIOLATION', () => {
    const doc = checkpoint();
    doc.state.cash_available = '01.5';
    doc.state.extra = true;
    expect(outcome('checkpoint', JSON.stringify(doc))).toEqual(rejected('SCHEMA_VIOLATION', 'schema'));
  });

  test('a decimal given as a number is SCHEMA_VIOLATION', () => {
    const doc = checkpoint();
    doc.state.cash_reserved = 0;
    expect(outcome('checkpoint', JSON.stringify(doc))).toEqual(rejected('SCHEMA_VIOLATION', 'schema'));
  });

  test('more than 20 grammar failures: 20 listed, one marker, still INVALID_DECIMAL', () => {
    const doc = input();
    const bars = doc.instruments[0].bars as Doc[];
    for (const bar of bars.slice(0, 7)) for (const field of ['open', 'high', 'low', 'close']) bar[field] = '1e5';
    const result = parseContract('evaluation-input', JSON.stringify(doc));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INVALID_DECIMAL');
    expect(result.error.violations).toHaveLength(MAX_REPORTED_VIOLATIONS + 1);
    expect(result.error.violations.at(-1)).toEqual({
      pointer: '',
      message: '8 further violation(s) not listed',
      decimalGrammar: true,
    });
    const eighth = bars[7];
    if (eighth === undefined) throw new Error('the F0 input has fewer than eight bars');
    eighth.extra = true;
    expect(outcome('evaluation-input', JSON.stringify(doc))).toEqual(rejected('SCHEMA_VIOLATION', 'schema'));
  });
});

describe('structural limits apply only to an invalid document', () => {
  // About 10 values per ledger entry: 2,500 entries is more than 20,000 values, within maxItems 4,000.
  const large = () => {
    const doc = checkpoint();
    const [entry] = doc.state.journal.cash_ledger as Doc[];
    doc.state.journal.cash_ledger = Array.from({ length: 2500 }, () => ({ ...entry }));
    return doc;
  };

  test('a valid document beyond the value limit is accepted', () => {
    expect(firstExcess(large())).toBeDefined();
    expect(outcome('checkpoint', JSON.stringify(large()))).toEqual({ verdict: 'accepted' });
  });

  test('an invalid one reports the excess, then its first violation: SCHEMA_VIOLATION even for a grammar failure', () => {
    const doc = large();
    doc.state.cash_available = '01.5';
    const result = parseContract('checkpoint', JSON.stringify(doc));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('SCHEMA_VIOLATION');
    expect(result.error.violations).toHaveLength(2);
    expect(result.error.violations[0]?.message).toMatch(/more than 20000 values/);
    expect(result.error.violations[1]).toMatchObject({ pointer: '/state/cash_available', decimalGrammar: true });
  });
});

describe('validateContract checks a value built in code through its canonical text', () => {
  test('a valid value gives a parsed copy', () => {
    const value = apiError();
    const result = validateContract('api-error', value);
    expect(result.ok && result.value).toEqual(value);
    expect(result.ok && result.value).not.toBe(value);
  });

  test.each<[string, unknown]>([
    ['a fraction', { ...apiError(), current_revision: 2.5 }],
    ['an inexact integer', { ...apiError(), current_revision: 2 ** 53 }],
    ['undefined', { ...apiError(), message: undefined }],
  ])('%s is SCHEMA_VIOLATION', (_label, value) => {
    const result = validateContract('api-error', value);
    expect(result.ok ? 'accepted' : result.error.code).toBe('SCHEMA_VIOLATION');
  });

  test('the version and schema checks follow', () => {
    const wrong = validateContract('api-error', { ...apiError(), schema_version: 'api-error/9' });
    expect(wrong.ok ? 'accepted' : wrong.error.code).toBe('UNSUPPORTED_SCHEMA_VERSION');
  });
});

describe('the TypeScript layer mirrors the Rust constants', () => {
  const rust = (file: string) => readFileSync(resolve(repositoryRoot, 'packages/api-contracts/rust/src', file), 'utf8');
  const rawString = (source: string, name: string) => {
    const match = new RegExp(`const ${name}: &str =\\s*r"([^"]*)";`).exec(source);
    if (!match?.[1]) throw new Error(`${name} not found`);
    return match[1];
  };
  const integer = (source: string, name: string) => {
    const match = new RegExp(`const ${name}: usize = ([0-9_ *]+);`).exec(source);
    if (!match?.[1]) throw new Error(`${name} not found`);
    return match[1]
      .split('*')
      .map((factor) => Number(factor.trim().replaceAll('_', '')))
      .reduce((a, b) => a * b, 1);
  };

  test('the decimal and Exact grammars of schema.rs', () => {
    expect(DECIMAL_PATTERN).toBe(rawString(rust('schema.rs'), 'DECIMAL_PATTERN'));
    expect(EXACT_PATTERN).toBe(rawString(rust('schema.rs'), 'EXACT_PATTERN'));
  });

  test('the limits of strict.rs, schema.rs, limits.rs and exact.rs', () => {
    expect(MAX_PAYLOAD_BYTES).toBe(integer(rust('strict.rs'), 'MAX_PAYLOAD_BYTES'));
    expect(MAX_REPORTED_VIOLATIONS).toBe(integer(rust('schema.rs'), 'MAX_REPORTED_VIOLATIONS'));
    expect(EXACT_MAX_LENGTH).toBe(integer(rust('exact.rs'), 'MAX_LEN'));
    const structural = { MAX_NODES, MAX_DEPTH, MAX_ARRAY_LEN, MAX_OBJECT_KEYS, MAX_STRING_BYTES };
    for (const [name, value] of Object.entries(structural)) {
      expect(value, name).toBe(integer(rust('limits.rs'), name));
    }
  });

  test('every version tag is <name>/<version of the $id>', () => {
    for (const [name, contract] of Object.entries(contracts)) {
      expect(contract.schemaId).toBe(`urn:openquant:schema:${name}:1`);
      expect(contract.versionTag).toBe(`${name}/1`);
    }
  });
});

test('types: Exact is opaque, and the contract codes are shared failure codes', () => {
  expectTypeOf<ContractFailureCode>().toExtend<FailureCode>();
  expectTypeOf<Exact>().toExtend<string>();
  expectTypeOf<string>().not.toExtend<Exact>();
  // @ts-expect-error a plain string is not an Exact
  const exact: Exact = '1/3';
  expect(exact).toBe('1/3');
});

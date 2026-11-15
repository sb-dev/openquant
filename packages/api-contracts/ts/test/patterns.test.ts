// The patterns of the schemas match in linear time (OQ-05 §7).
//
// The shared Decimal and Exact patterns of common.schema.json have a third alternative,
// -0\.[0-9]*[1-9][0-9]*, that backtracks quadratically in V8: a string such as -0.111...1x in any
// decimal field cost time quadratic in its length, however small the Worker byte limit is. The Rust
// engine matches in linear time. The generated validators therefore run an equivalent unambiguous
// form (tools/generate.ts, linearPattern), and these tests check that form: it matches the same
// strings, every pattern of every schema scales linearly under adversarial input, and a parse of an
// invalid decimal costs time in proportion to its length.

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assert, describe, expect, test } from 'vitest';
import { DECIMAL_PATTERN, EXACT_PATTERN, PATTERN_SCHEMA_TEXT } from '../dist/generated/contracts.ts';
import { parseContract } from '../src/index.ts';
import { linearPattern } from '../tools/generate.ts';
import { fixturesDir } from './support/manifest.ts';
import { adversarialInputs, hasUnboundedRepetition } from './support/regex-probe.ts';
import { MAX_RATIO, SCALE, scalingRatio } from './support/scaling.ts';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packagesDir = resolve(packageRoot, '../..');

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

// Every pattern, and every patternProperties key, of the JSON files in a directory.
function patternsIn(directory: string): Set<string> {
  const found = new Set<string>();
  const walk = (node: Json): void => {
    if (Array.isArray(node)) for (const item of node) walk(item);
    else if (typeof node === 'object' && node !== null) {
      for (const [key, value] of Object.entries(node)) {
        if (key === 'pattern' && typeof value === 'string') found.add(value);
        else if (key === 'patternProperties' && typeof value === 'object' && value !== null) {
          for (const name of Object.keys(value)) found.add(name);
        }
        walk(value);
      }
    }
  };
  for (const file of readdirSync(directory).filter((name) => name.endsWith('.json'))) {
    walk(JSON.parse(readFileSync(resolve(directory, file), 'utf8')) as Json);
  }
  return found;
}

const contractPatterns = patternsIn(resolve(packagesDir, 'api-contracts/schemas'));
const agentPatterns = patternsIn(resolve(packagesDir, 'agents/schemas'));

// The patterns that the generated validators construct, as the text of their JSON string literals.
function validatorPatterns(file: string): Set<string> {
  const text = readFileSync(resolve(packageRoot, 'dist/generated', file), 'utf8');
  const found = new Set<string>();
  for (const match of text.matchAll(/new RegExp\(("(?:[^"\\]|\\.)*"), "u"\)/g)) {
    found.add(JSON.parse(match[1] ?? '""') as string);
  }
  return found;
}

describe('the rewritten Decimal and Exact patterns', () => {
  test('differ from the schema text only in the third alternative, and the generator keeps the map back', () => {
    expect(linearPattern(DECIMAL_PATTERN)).not.toBe(DECIMAL_PATTERN);
    expect(linearPattern(EXACT_PATTERN)).not.toBe(EXACT_PATTERN);
    expect(linearPattern(DECIMAL_PATTERN)).toBe(DECIMAL_PATTERN.replace('-0\\.[0-9]*[1-9]', '-0\\.0*[1-9]'));
    expect(PATTERN_SCHEMA_TEXT).toEqual({
      [linearPattern(DECIMAL_PATTERN)]: DECIMAL_PATTERN,
      [linearPattern(EXACT_PATTERN)]: EXACT_PATTERN,
    });
    // A pattern with no such alternative is left alone.
    expect(linearPattern('^[0-9]+$')).toBe('^[0-9]+$');
  });

  test('accept and reject exactly the strings of the schema patterns, over every string of up to 7 characters of 7', () => {
    const alphabet = ['-', '.', '/', '0', '1', '9', 'x'];
    const pairs = [DECIMAL_PATTERN, EXACT_PATTERN].map((original) => ({
      original: new RegExp(original, 'u'),
      linear: new RegExp(linearPattern(original), 'u'),
    }));
    let strings = 0;
    let accepted = 0;
    let rejected = 0;
    const visit = (text: string, remaining: number): void => {
      strings += 1;
      for (const { original, linear } of pairs) {
        const verdict = original.test(text);
        if (verdict !== linear.test(text)) assert.fail(`the patterns differ on ${JSON.stringify(text)}`);
        if (verdict) accepted += 1;
        else rejected += 1;
      }
      if (remaining === 0) return;
      for (const char of alphabet) visit(text + char, remaining - 1);
    };
    visit('', 7);
    expect(strings).toBe(960_800);
    // The strings of both kinds are many, so the comparison is not vacuous.
    expect(accepted).toBeGreaterThan(10_000);
    expect(rejected).toBeGreaterThan(10_000);
  });
});

describe('the generated validators', () => {
  test('construct exactly the patterns of the schemas, the Decimal and Exact patterns in linear form', () => {
    const expected = new Set([...contractPatterns].map(linearPattern));
    expect(validatorPatterns('validators-first.js')).toEqual(expected);
    expect(validatorPatterns('validators-all.js')).toEqual(expected);
    expect(expected.has(DECIMAL_PATTERN)).toBe(false);
    expect(expected.has(EXACT_PATTERN)).toBe(false);
  });
});

describe('the patterns of every schema', () => {
  test('are read from the contracts and the agent role schemas', () => {
    expect(contractPatterns.size).toBeGreaterThanOrEqual(19);
    expect(agentPatterns.size).toBeGreaterThanOrEqual(1);
  });

  test('match adversarial input in linear time: eight times the text costs less than 20 times the work', () => {
    const size = 5_000;
    const slow: string[] = [];
    const probed: string[] = [];
    for (const schemaPattern of new Set([...contractPatterns, ...agentPatterns])) {
      // What a validator runs. The agent schemas are not bundled, so they run as they are written.
      const pattern = linearPattern(schemaPattern);
      if (!hasUnboundedRepetition(pattern)) continue;
      probed.push(pattern);
      const regex = new RegExp(pattern, 'u');
      const small = adversarialInputs(pattern, size);
      const large = adversarialInputs(pattern, size * SCALE);
      expect(large.length).toBe(small.length);
      small.forEach((text, index) => {
        const long = large[index] ?? '';
        const ratio = scalingRatio(
          () => regex.test(text),
          () => regex.test(long),
        );
        if (ratio >= MAX_RATIO)
          slow.push(`${pattern} on ${JSON.stringify(`${text.slice(0, 12)}...${text.slice(-4)}`)}`);
      });
    }
    expect(probed.length).toBeGreaterThanOrEqual(8);
    expect(slow).toEqual([]);
  });

  test('are checked by a probe that flags the quadratic alternative that the rewrite replaced', () => {
    for (const original of [DECIMAL_PATTERN, EXACT_PATTERN]) {
      const regex = new RegExp(original, 'u');
      const small = adversarialInputs(original, 2_000);
      const large = adversarialInputs(original, 2_000 * SCALE);
      const ratios = small.map((text, index) =>
        scalingRatio(
          () => regex.test(text),
          () => regex.test(large[index] ?? ''),
          1,
          50,
        ),
      );
      expect(Math.max(...ratios)).toBeGreaterThanOrEqual(MAX_RATIO);
    }
  });
});

interface DecimalField {
  readonly contract: 'command' | 'cohort-policy' | 'agent-attempt-result' | 'checkpoint';
  readonly fixture: string;
  readonly path: readonly (string | number)[];
}

// One field of each kind that holds a Decimal: a money amount in a oneOf root, a constrained
// decimal (StressMultiplier), a usage amount, a ledger value and, for Exact, a position's stop.
const FIELDS: readonly DecimalField[] = [
  { contract: 'command', fixture: 'command.register-budget', path: ['payload', 'budget', 'model_spend', 'amount'] },
  { contract: 'cohort-policy', fixture: 'cohort-policy.s1-pilot', path: ['conditions', 'cost_stress', 'multiplier'] },
  { contract: 'cohort-policy', fixture: 'cohort-policy.s1-pilot', path: ['conditions', 'initial_capital'] },
  { contract: 'agent-attempt-result', fixture: 'agent-attempt-result.completion', path: ['usage', 'cost', 'amount'] },
  { contract: 'checkpoint', fixture: 'checkpoint.pending-entry', path: ['state', 'cash_available'] },
  {
    contract: 'checkpoint',
    fixture: 'checkpoint.exact-open-position-fraction',
    path: ['state', 'positions', 0, 'stop'],
  },
];

// Invalid decimal texts of n characters that make a backtracking engine work hardest.
const SHAPES: readonly [name: string, build: (n: number) => string][] = [
  ['the reviewer text -0.111...1x', (n) => `-0.${'1'.repeat(n)}x`],
  ['zeros after -0. and no non-zero digit', (n) => `-0.${'0'.repeat(n)}`],
  ['digits and an x', (n) => `${'1'.repeat(n)}x`],
  ['a fraction and an x', (n) => `1.${'1'.repeat(n)}x`],
  ['a long fraction n/d and an x', (n) => `${'1'.repeat(n)}/${'1'.repeat(n)}x`],
];

function bodyWith(field: DecimalField, text: string): Uint8Array {
  const document = JSON.parse(
    readFileSync(resolve(fixturesDir, `protocol/valid/${field.fixture}.json`), 'utf8'),
  ) as Json;
  let node: Json = document;
  for (const step of field.path.slice(0, -1)) node = (node as Record<string | number, Json>)[step] ?? null;
  (node as Record<string | number, Json>)[field.path.at(-1) as string | number] = text;
  return new TextEncoder().encode(JSON.stringify(document));
}

const CASES = FIELDS.flatMap((field) =>
  SHAPES.map(([shape, build]) => ({ title: `${shape} in ${field.fixture} ${field.path.join('/')}`, field, build })),
);

describe('parseContract on bytes with one invalid decimal', () => {
  test.each(CASES)('$title costs time in proportion to its length', ({ field, build }) => {
    const n = 10_000;
    const small = bodyWith(field, build(n));
    const large = bodyWith(field, build(n * SCALE));
    expect(parseContract(field.contract, small).ok).toBe(false);
    expect(parseContract(field.contract, large).ok).toBe(false);
    const ratio = scalingRatio(
      () => parseContract(field.contract, small),
      () => parseContract(field.contract, large),
    );
    expect(ratio).toBeLessThan(MAX_RATIO);
  });
});

// The check of a submitted result before commit (src/result.ts, OQ-05 sections 4 and 7): the whole
// document is read with strict JSON and the structural limits, and only the head is built and
// validated.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { parseContract, RESULT_SCAN_LIMIT, scanEvaluationResult } from '../src/index.ts';
import { MAX_ARRAY_LEN, MAX_NODES, MAX_OBJECT_KEYS, MAX_STRING_BYTES } from '../src/limits.ts';
import { maxValues } from '../tools/generate.ts';
import { bundleDefs } from './support/error-shape.ts';
import { fixturesDir, readManifest, repositoryRoot } from './support/manifest.ts';

// biome-ignore lint/suspicious/noExplicitAny: the tests edit fixture documents by path.
type Doc = Record<string, any>;

const text = (path: string) => readFileSync(resolve(fixturesDir, path), 'utf8');
const f0 = (): Doc => JSON.parse(text('protocol/valid/evaluation-result.f0.json')) as Doc;

function outcome(input: string | Uint8Array) {
  const result = scanEvaluationResult(input);
  return result.ok
    ? { verdict: 'accepted' }
    : { verdict: 'rejected', code: result.error.code, kind: result.error.kind };
}

const STAND_INS = {
  journal: {
    signals: [],
    entries: [],
    fills: [],
    trades: [],
    cash_ledger: [],
    daily: [],
    corporate_actions: [],
    next_seq: 0,
  },
  final: {
    cash_available: '0',
    cash_reserved: '0',
    receivables: '0',
    positions_value: '0',
    equity: '0',
    open_positions: [],
  },
};

describe('the scan agrees with parseContract on the head', () => {
  const results = readManifest().entries.filter((entry) => entry.contract === 'evaluation-result');

  test('a valid result gives its head: the parsed result without journal and final', () => {
    const valid = results.filter((entry) => entry.expect === 'valid');
    expect(valid.length).toBeGreaterThan(0);
    for (const entry of valid) {
      const scanned = scanEvaluationResult(readFileSync(resolve(fixturesDir, entry.path)));
      const parsed = parseContract('evaluation-result', text(entry.path));
      expect(scanned.ok && parsed.ok, entry.path).toBe(true);
      if (!scanned.ok || !parsed.ok) continue;
      const { journal: _journal, final: _final, ...head } = parsed.value;
      expect(scanned.value).toEqual(head);
      expect(scanned.value).not.toHaveProperty('journal');
      expect(scanned.value).not.toHaveProperty('final');
    }
  });

  test('every result fixture: the scan gives the verdict and code of parseContract with stand-ins for journal and final', () => {
    expect(results.length).toBeGreaterThan(4);
    for (const entry of results) {
      const document = JSON.parse(text(entry.path)) as Doc;
      for (const member of ['journal', 'final'] as const) {
        if (Object.hasOwn(document, member)) document[member] = STAND_INS[member];
      }
      const expected = parseContract('evaluation-result', JSON.stringify(document));
      const scanned = scanEvaluationResult(text(entry.path));
      expect(scanned.ok ? 'accepted' : scanned.error.code, entry.path).toBe(
        expected.ok ? 'accepted' : expected.error.code,
      );
    }
  });
});

describe('the head is checked as parseContract checks it', () => {
  const rewrite = (edit: (document: Doc) => void) => {
    const document = f0();
    edit(document);
    return JSON.stringify(document);
  };

  test.each<[string, (document: Doc) => void, string, string]>([
    [
      'another version',
      (d) => (d.schema_version = 'evaluation-result/2'),
      'UNSUPPORTED_SCHEMA_VERSION',
      'unsupported-version',
    ],
    ['no version', (d) => delete d.schema_version, 'SCHEMA_VIOLATION', 'missing-version'],
    ['a malformed input hash', (d) => (d.input_hash = 'sha256:xyz'), 'SCHEMA_VIOLATION', 'schema'],
    ['an unknown outcome status', (d) => (d.outcome.status = 'DONE'), 'SCHEMA_VIOLATION', 'schema'],
    ['an unknown top-level member', (d) => (d.extra = 1), 'SCHEMA_VIOLATION', 'schema'],
    ['no journal', (d) => delete d.journal, 'SCHEMA_VIOLATION', 'schema'],
    ['no final', (d) => delete d.final, 'SCHEMA_VIOLATION', 'schema'],
    [
      'a head beyond the value bound',
      (d) => (d.outcome.at = Array(MAX_NODES).fill(0)),
      'SCHEMA_VIOLATION',
      'value-bound',
    ],
  ])('%s', (_label, edit, code, kind) => {
    expect(outcome(rewrite(edit))).toEqual({ verdict: 'rejected', code, kind });
  });

  test('journal and final are not validated against the schema, and their values do not count', () => {
    const document = f0();
    document.journal.signals = [{ not: 'a signal record' }];
    document.final.equity = 'not a decimal';
    // More values than the head's bound, all inside the journal.
    document.journal.daily = Array.from({ length: 8 }, () => Array(MAX_ARRAY_LEN).fill(0));
    expect(outcome(JSON.stringify(document))).toEqual({ verdict: 'accepted' });
  });

  test('the head of a valid result holds far fewer values than the bound', () => {
    const defs = bundleDefs();
    const result = defs.EvaluationResult as Doc;
    const { journal: _journal, final: _final, ...properties } = result.properties as Doc;
    const head = { ...result, properties, required: (result.required as string[]).filter((key) => key in properties) };
    expect(maxValues(defs as never, head as never)).toBeLessThan(MAX_NODES / 10);
  });
});

describe('the whole text is read with strict JSON and the structural limits', () => {
  const withJournal = (journal: string) => {
    const document = JSON.stringify(f0());
    const start = document.indexOf('"journal":') + '"journal":'.length;
    const end = document.indexOf(',"outcome":');
    expect(start).toBeGreaterThan(10);
    expect(end).toBeGreaterThan(start);
    return `${document.slice(0, start)}${journal}${document.slice(end)}`;
  };

  test.each<[string, string, string]>([
    ['a duplicate key', '{"a":1,"a":2}', 'duplicate-key'],
    ['a fraction', '[1.5]', 'float-number'],
    ['a bad escape', '["\\x"]', 'json'],
    ['a lone surrogate', '["\\ud800"]', 'json'],
    ['nesting of 128 levels', `${'['.repeat(127)}${']'.repeat(127)}`, 'json'],
    [
      'an array too long',
      `[${Array(MAX_ARRAY_LEN + 1)
        .fill(0)
        .join(',')}]`,
      'structural-limit',
    ],
    [
      'an object too wide',
      JSON.stringify(Object.fromEntries(Array.from({ length: MAX_OBJECT_KEYS + 1 }, (_, i) => [`k${i}`, 0]))),
      'structural-limit',
    ],
    ['a string too long', JSON.stringify('x'.repeat(MAX_STRING_BYTES + 1)), 'structural-limit'],
    // 8,193 escapes of é decode to 16,386 bytes.
    ['a string too long once decoded', `"${'\\u00e9'.repeat(MAX_STRING_BYTES / 2 + 1)}"`, 'structural-limit'],
  ])('%s inside the journal is rejected', (_label, journal, kind) => {
    expect(outcome(withJournal(journal))).toEqual({ verdict: 'rejected', code: 'SCHEMA_VIOLATION', kind });
  });

  test.each<[string, string]>([
    ['the longest array', `[${Array(MAX_ARRAY_LEN).fill(0).join(',')}]`],
    [
      'the widest object',
      JSON.stringify(Object.fromEntries(Array.from({ length: MAX_OBJECT_KEYS }, (_, i) => [`k${i}`, 0]))),
    ],
    ['the longest string', JSON.stringify('x'.repeat(MAX_STRING_BYTES))],
    ['the longest string of escapes', `"${'\\u00e9'.repeat(MAX_STRING_BYTES / 2)}"`],
    ['four-byte characters', JSON.stringify('😀'.repeat(MAX_STRING_BYTES / 4))],
    ['nesting of 127 levels in all', `${'['.repeat(126)}${']'.repeat(126)}`],
  ])('%s within the limits is read', (_label, journal) => {
    expect(outcome(withJournal(journal))).toEqual({ verdict: 'accepted' });
  });

  test('a skipped member that appears twice is a duplicate key', () => {
    const document = JSON.stringify(f0());
    const duplicated = document.replace('"journal":', '"journal":[],"journal":');
    expect(outcome(duplicated)).toEqual({ verdict: 'rejected', code: 'SCHEMA_VIOLATION', kind: 'duplicate-key' });
  });

  test('a key is not a string value: a long key is within the limits', () => {
    expect(outcome(withJournal(JSON.stringify({ ['k'.repeat(MAX_STRING_BYTES + 1)]: 0 })))).toEqual({
      verdict: 'accepted',
    });
  });
});

describe('the scan limit', () => {
  test('a result at the limit is scanned, one byte more is refused before the scan', () => {
    const document = JSON.stringify(f0());
    const at = new Uint8Array(RESULT_SCAN_LIMIT).fill(0x20);
    at.set(new TextEncoder().encode(document));
    expect(outcome(at)).toEqual({ verdict: 'accepted' });
    const over = new Uint8Array(RESULT_SCAN_LIMIT + 1).fill(0x20);
    over.set(new TextEncoder().encode(document));
    expect(outcome(over)).toEqual({ verdict: 'rejected', code: 'SCHEMA_VIOLATION', kind: 'too-large' });
  });

  test('the limit is the one the Rust measurement of the largest S0 result checks against', () => {
    const source = readFileSync(resolve(repositoryRoot, 'packages/quant-core/tests/result_size_bound.rs'), 'utf8');
    const match = /const RESULT_SCAN_LIMIT: usize = ([0-9_ *]+);/.exec(source);
    expect(match?.[1]).toBeDefined();
    const value = (match?.[1] ?? '')
      .split('*')
      .map((factor) => Number(factor.trim().replaceAll('_', '')))
      .reduce((a, b) => a * b, 1);
    expect(value).toBe(RESULT_SCAN_LIMIT);
  });
});

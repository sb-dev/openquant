// The parity comparison itself, on a small synthetic report.

import { describe, expect, test } from 'vitest';
import type { EntryResult } from './support/manifest.ts';
import { compareReport, PRODUCE_REPORT } from './support/parity.ts';

const SHA = 'a'.repeat(64);
const DIGEST = `sha256:${'b'.repeat(64)}`;

const results: EntryResult[] = [
  { path: 'protocol/valid/x.json', contract: 'api-error', expect: 'valid', verdict: 'accepted', digest: DIGEST },
  {
    path: 'protocol/invalid/y.json',
    contract: 'api-error',
    expect: 'schema_invalid',
    verdict: 'rejected',
    code: 'SCHEMA_VIOLATION',
  },
  { path: 's0/z.json', contract: 'checkpoint', expect: 'semantic_invalid', verdict: 'accepted', digest: DIGEST },
];

const report = (entries: unknown[] = results.map((r) => ({ ...r })), sha = SHA) => ({
  schema: 'contracts-report/1',
  manifest_sha256: sha,
  entries,
});

const withEntry = (index: number, change: Record<string, unknown>) =>
  report(results.map((r, i) => (i === index ? { ...r, ...change } : { ...r })));

test('an equal report has no problem', () => {
  expect(compareReport(report(), SHA, results)).toEqual([]);
});

describe('the report itself', () => {
  test('from another manifest: says how to produce a current one', () => {
    const [problem] = compareReport(report(undefined, 'c'.repeat(64)), SHA, results);
    expect(problem).toMatch(/another manifest/);
    expect(problem).toContain(PRODUCE_REPORT);
  });

  test.each<[string, unknown, RegExp]>([
    ['not an object', [], /not a JSON object/],
    ['null', null, /not a JSON object/],
    ['another schema', { ...report(), schema: 'contracts-report/2' }, /report schema/],
    ['no entries', { ...report(), entries: {} }, /no entries array/],
  ])('%s', (_label, value, problem) => {
    expect(compareReport(value, SHA, results).join('\n')).toMatch(problem);
  });
});

describe('each entry', () => {
  test.each<[string, unknown, RegExp]>([
    [
      'another verdict',
      withEntry(0, { verdict: 'rejected', code: 'SCHEMA_VIOLATION', digest: undefined }),
      /x\.json: Rust rejected SCHEMA_VIOLATION, TypeScript accepted/,
    ],
    [
      'another code',
      withEntry(1, { code: 'INVALID_DECIMAL' }),
      /y\.json: Rust rejected INVALID_DECIMAL, TypeScript rejected SCHEMA_VIOLATION/,
    ],
    [
      'another digest',
      withEntry(2, { digest: `sha256:${'c'.repeat(64)}` }),
      /z\.json: Rust accepted sha256:c+, TypeScript accepted sha256:b+/,
    ],
    ['another contract', withEntry(0, { contract: 'checkpoint' }), /x\.json: the report lists checkpoint\/valid/],
    ['another expectation', withEntry(1, { expect: 'valid' }), /y\.json: the report lists api-error\/valid/],
    ['accepted without a digest', withEntry(0, { digest: undefined }), /x\.json: malformed report entry/],
    ['rejected with a digest', withEntry(1, { digest: DIGEST }), /y\.json: malformed report entry/],
    ['no path', report([...results, { verdict: 'accepted' }]), /a report entry has no path/],
    ['missing', report(results.slice(1)), /x\.json: missing from the report/],
    [
      'extra',
      report([...results, { ...results[0], path: 'extra.json' }]),
      /extra\.json: in the report but not in the manifest/,
    ],
    ['listed twice', report([...results, { ...results[0] }]), /x\.json: listed twice/],
  ])('%s', (_label, value, problem) => {
    const problems = compareReport(value, SHA, results);
    expect(problems.join('\n')).toMatch(problem);
  });
});

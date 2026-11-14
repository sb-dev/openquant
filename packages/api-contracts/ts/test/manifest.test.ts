import { describe, expect, test } from 'vitest';
import { contracts } from '../src/index.ts';
import { type EntryResult, EXPECTATIONS, readManifest, runEntry } from './support/manifest.ts';

// semantic_invalid entries pass the TypeScript layer: their codes come from Rust semantic checks
// (OQ-05 §7). Change this count only in the change that adds or removes such a fixture.
const DEFERRED_SEMANTIC_CASES = 31;

const { entries } = readManifest();

describe('the protocol manifest', () => {
  test('every entry names a generated contract and a known expectation', () => {
    for (const entry of entries) {
      expect(Object.keys(contracts), entry.path).toContain(entry.contract);
      expect(EXPECTATIONS, entry.path).toContain(entry.expect);
      if (entry.expect === 'valid') expect(entry.code, entry.path).toBeUndefined();
      else expect(typeof entry.code, entry.path).toBe('string');
    }
  });

  test('every generated contract has a valid and a schema_invalid fixture', () => {
    for (const name of Object.keys(contracts)) {
      const own = entries.filter((entry) => entry.contract === name);
      expect(
        own.some((entry) => entry.expect === 'valid'),
        `${name} valid`,
      ).toBe(true);
      expect(
        own.some((entry) => entry.expect === 'schema_invalid'),
        `${name} schema_invalid`,
      ).toBe(true);
    }
  });
});

test('each entry gets the manifest verdict and code', async () => {
  const results: EntryResult[] = await Promise.all(entries.map(runEntry));
  const problems: string[] = [];
  for (const result of results) {
    const entry = entries.find((candidate) => candidate.path === result.path);
    if (entry?.expect === 'schema_invalid') {
      if (result.verdict !== 'rejected' || result.code !== entry.code) {
        problems.push(`${result.path}: expected rejected ${entry.code}, got ${result.verdict} ${result.code ?? ''}`);
      }
    } else if (result.verdict !== 'accepted') {
      problems.push(`${result.path}: expected accepted (${entry?.expect}), got rejected ${result.code}`);
    }
  }
  expect(problems, problems.join('\n')).toEqual([]);
  const deferred = results.filter((result) => result.expect === 'semantic_invalid' && result.verdict === 'accepted');
  expect(deferred).toHaveLength(DEFERRED_SEMANTIC_CASES);
  expect(
    results
      .filter((result) => result.verdict === 'accepted')
      .every((result) => /^sha256:[0-9a-f]{64}$/.test(result.digest ?? '')),
  ).toBe(true);
});

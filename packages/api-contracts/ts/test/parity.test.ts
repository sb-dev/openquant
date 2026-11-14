// Cross-runtime parity with the Rust contract layer (OQ-05 §7). This test never skips: without a
// current Rust report it fails and says how to produce one. Run it alone with pnpm verify:contracts.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { assert, expect, test } from 'vitest';
import { readManifest, reportPath, runEntry } from './support/manifest.ts';
import { compareReport, PRODUCE_REPORT } from './support/parity.ts';

test('TypeScript and Rust give the same verdict, code and digest for every protocol fixture', async () => {
  if (!existsSync(reportPath)) assert.fail(`The Rust contracts report is missing: ${reportPath}. ${PRODUCE_REPORT}`);
  let report: unknown;
  try {
    report = JSON.parse(readFileSync(reportPath, 'utf8'));
  } catch (error) {
    assert.fail(`The Rust contracts report is not JSON (${String(error)}). ${PRODUCE_REPORT}`);
  }
  const { bytes, entries } = readManifest();
  const manifestSha256 = createHash('sha256').update(bytes).digest('hex');
  const results = await Promise.all(entries.map(runEntry));
  const problems = compareReport(report, manifestSha256, results);
  expect(problems, problems.join('\n')).toEqual([]);
});

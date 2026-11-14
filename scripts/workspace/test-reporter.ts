import { resolve } from 'node:path';
import { workspaceTestFiles } from '../s0.ts';

// A node:test reporter for the workspace tests of `pnpm verify` (OQ-06 sections 1 and 7: a test task with no tests
// fails, and a zero-test run never stands in for a check). Node passes a run whose file defines no test, or whose
// tests are all skipped or marked todo, and it ignores a named file that does not exist. This reporter fails such a
// run: the files that ran must be exactly workspaceTestFiles in scripts/s0.ts, resolved from the working directory,
// each must run at least one test, and no test may be skipped or marked todo. It does not read the command line,
// so a file left out of it, or missing in any position, fails. It prints nothing otherwise; the spec reporter prints
// the results. scripts/s0.ts pins this file by its SHA-256, so a change to it is a reviewed change to the guard.

interface TestEvent {
  type: string;
  data?: { name?: string; nesting?: number; file?: string; skip?: unknown; todo?: unknown; details?: { type?: string } };
}

export default async function* requireTests(source: AsyncIterable<TestEvent>): AsyncGenerator<string> {
  const executed = new Map<string, number>();
  const skipped: string[] = [];
  for await (const { type, data } of source) {
    if ((type !== 'test:pass' && type !== 'test:fail') || data?.details?.type !== 'test') continue;
    const file = data.file ?? '(no file)';
    // In process isolation the runner reports a file that defines no test as a single test named after the file.
    const fileOnly = data.nesting === 0 && data.file !== undefined && resolve(data.name ?? '') === data.file;
    const notRun = Boolean(data.skip) || Boolean(data.todo);
    if (notRun) skipped.push(`${data.name} in ${file}`);
    executed.set(file, (executed.get(file) ?? 0) + (fileOnly || notRun ? 0 : 1));
  }
  const problems: string[] = [];
  if (executed.size === 0) problems.push('no test file ran');
  const expected = new Set(workspaceTestFiles.map((file) => resolve(file)));
  for (const file of workspaceTestFiles) if (!executed.has(resolve(file))) problems.push(`${file} did not run`);
  for (const file of executed.keys()) if (!expected.has(file)) problems.push(`${file} ran but is not in workspaceTestFiles (scripts/s0.ts)`);
  for (const [file, count] of executed) if (count === 0) problems.push(`${file} ran no test`);
  for (const test of skipped) problems.push(`skipped or todo: ${test}`);
  if (problems.length > 0) {
    process.exitCode = 1;
    yield `\nTest run failed: ${problems.join('; ')}\n`;
  }
}

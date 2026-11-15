import type { Reporter, TestModule } from 'vitest/node';

// A Vitest reporter for the test task (OQ-06 sections 1 and 7: a test task with no tests fails, and a zero-test run
// never stands in for a check). Vitest passes a run in which every test is skipped, filtered out by a name pattern
// or marked todo. This reporter fails such a run: every test module must run at least one test, and no test may be
// skipped, marked todo or left pending. The test script names it after the default reporter.
// scripts/s0.ts pins this file by its SHA-256, so a change to it is a reviewed change to the guard as well.
export default class RequireTests implements Reporter {
  onTestRunEnd(testModules: ReadonlyArray<TestModule>): void {
    const problems: string[] = [];
    if (testModules.length === 0) problems.push('no test module ran');
    for (const testModule of testModules) {
      let executed = 0;
      const notRun: string[] = [];
      for (const testCase of testModule.children.allTests()) {
        const { state } = testCase.result();
        if (state === 'passed' || state === 'failed') executed += 1;
        else notRun.push(`${testCase.fullName} (${state})`);
      }
      const name = testModule.relativeModuleId;
      if (executed === 0) problems.push(`${name} ran no test`);
      if (notRun.length > 0) problems.push(`${name} did not run ${notRun.length} tests, first ${notRun[0]}`);
    }
    if (problems.length > 0) {
      process.exitCode = 1;
      process.stderr.write(`\nTest run failed: ${problems.join('; ')}\n`);
    }
  }
}

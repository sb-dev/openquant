import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { stepEnvironment } from '../../environment.ts';
import { root } from '../../repository.ts';
import { expectedTypescriptCommands, expectedWorkspacePackages, workspaceTestFiles } from '../../s0.ts';

// The reporters run real test runs in a temporary directory. Each run takes stepEnvironment(), which also removes
// the NODE_TEST_CONTEXT of this runner, so the nested node --test runs as a runner of its own.
function inTemporary<T>(files: Record<string, string>, run: (directory: string) => T): T {
  const directory = mkdtempSync(resolve(tmpdir(), 'openquant-reporter-'));
  try {
    for (const [name, text] of Object.entries(files)) {
      mkdirSync(dirname(resolve(directory, name)), { recursive: true });
      writeFileSync(resolve(directory, name), text);
    }
    return run(directory);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

// U0, G5 and OQ-06 sections 1 and 7: the workspace tests fail a file that ran no test, any skipped or todo test, and a
// run in which the files that ran are not exactly workspaceTestFiles. The reporter resolves those paths from the
// working directory, so each run writes a test file at every listed path in a temporary directory, then changes one.
const nodeReporter = resolve(root, 'scripts/workspace/test-reporter.ts');
const nodeOptions = ['--test', '--test-reporter=spec', '--test-reporter-destination=stdout', `--test-reporter=${nodeReporter}`, '--test-reporter-destination=stderr'];
const passing = "import test from 'node:test';\ntest('runs', () => {});\n";
const [first, ...others] = workspaceTestFiles;
const last = workspaceTestFiles[workspaceTestFiles.length - 1];
function nodeRun(change: Record<string, string | null> = {}, names: readonly string[] = workspaceTestFiles, extra: string[] = []) {
  const files: Record<string, string> = Object.fromEntries(workspaceTestFiles.map((file) => [file, passing]));
  for (const [file, text] of Object.entries(change)) {
    if (text === null) delete files[file];
    else files[file] = text;
  }
  return inTemporary(files, (directory) => spawnSync(process.execPath, [...extra, ...nodeOptions, ...names], { cwd: directory, encoding: 'utf8', env: stepEnvironment() }));
}

test('the workspace test step names the node:test reporter and every test file', () => {
  const step = expectedTypescriptCommands.find((command) => command.includes(' --test '));
  assert.ok(step?.endsWith(`--test-reporter=./scripts/workspace/test-reporter.ts --test-reporter-destination=stderr ${workspaceTestFiles.join(' ')}`), step);
  assert.ok(!step?.includes('*'), 'no glob: a glob that matches nothing is a zero-test run');
});
test('the node:test reporter passes a run in which every listed file runs its tests', () => {
  const run = nodeRun();
  assert.equal(run.status, 0, run.stderr);
  assert.doesNotMatch(run.stderr, /Test run failed/);
});
test('the node:test reporter fails a file that defines no test', () => {
  const run = nodeRun({ [first]: "import test from 'node:test';\nvoid test;\n" });
  assert.equal(run.status, 1);
  assert.match(run.stderr, new RegExp(`Test run failed: .*${first.replaceAll('.', '\\.')} ran no test`));
});
test('the node:test reporter fails a skipped or todo test', () => {
  const skipped = nodeRun({ [last]: `${passing}test('later', { skip: true }, () => {});\n` });
  assert.equal(skipped.status, 1);
  assert.match(skipped.stderr, /skipped or todo: later in /);
  const todo = nodeRun({ [last]: `${passing}test.todo('someday', () => {});\n` });
  assert.equal(todo.status, 1);
  assert.match(todo.stderr, /skipped or todo: someday in /);
});
test('the node:test reporter fails a run filtered to nothing by a skip pattern', () => {
  const run = nodeRun({}, workspaceTestFiles, ['--test-skip-pattern=.']);
  assert.equal(run.status, 1);
  assert.match(run.stderr, /ran no test/);
});
test('G5: a listed test file that does not exist fails the run, in the first position as well as the last', () => {
  // Node alone passes these runs: it ignores a named file that is missing when another file is found. Under
  // node --test the first named file is process.argv[1], so a check of argv.slice(2) missed the first position.
  const firstMissing = nodeRun({ [first]: null });
  assert.equal(firstMissing.status, 1);
  assert.match(firstMissing.stderr, new RegExp(`Test run failed: ${first.replaceAll('.', '\\.')} did not run`));
  const lastMissing = nodeRun({ [last]: null });
  assert.equal(lastMissing.status, 1);
  assert.match(lastMissing.stderr, new RegExp(`Test run failed: ${last.replaceAll('.', '\\.')} did not run`));
  const alone = nodeRun({}, ['missing.test.ts']);
  assert.equal(alone.status, 1);
  assert.match(alone.stderr, /Could not find .*missing\.test\.ts/);
});
test('G5: the reporter compares the files that ran with workspaceTestFiles, not with the command line', () => {
  const leftOut = nodeRun({}, others);
  assert.equal(leftOut.status, 1);
  assert.match(leftOut.stderr, new RegExp(`${first.replaceAll('.', '\\.')} did not run`));
  const extra = 'scripts/workspace/tests/extra.test.ts';
  const unexpected = nodeRun({ [extra]: passing }, [...workspaceTestFiles, extra]);
  assert.equal(unexpected.status, 1);
  assert.match(unexpected.stderr, /extra\.test\.ts ran but is not in workspaceTestFiles \(scripts\/s0\.ts\)/);
});

// C8: Vitest passes a run in which every test is skipped or filtered out. The package reporter fails it.
const contracts = expectedWorkspacePackages.find((item) => item.name === '@openquant/api-contracts');
const packageDirectory = resolve(root, contracts?.directory ?? 'packages/api-contracts/ts');
function vitestRun(files: Record<string, string>, extra: string[] = [], reporter = true) {
  const vitest = resolve(packageDirectory, 'node_modules/vitest/vitest.mjs');
  const reporters = reporter ? ['--reporter=default', `--reporter=${resolve(packageDirectory, 'test-reporter.ts')}`] : ['--reporter=default'];
  return inTemporary(files, (directory) => spawnSync(process.execPath, [vitest, 'run', '--root', directory, '--globals', ...reporters, ...extra], { cwd: directory, encoding: 'utf8', env: stepEnvironment() }));
}
test('the test script of the package names the Vitest reporter', () => {
  assert.equal(contracts?.scripts.test, 'node tools/generate.ts && vitest run --reporter=default --reporter=./test-reporter.ts');
});
test('the Vitest reporter passes a run in which every test runs', () => {
  const run = vitestRun({ 'a.test.js': "test('runs', () => {});\n" });
  assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
  assert.doesNotMatch(run.stderr, /Test run failed/);
});
test('the Vitest reporter fails a run with a skipped or todo test', () => {
  const skipped = vitestRun({ 'a.test.js': "test('runs', () => {});\ntest.skip('later', () => {});\n" });
  assert.equal(skipped.status, 1);
  assert.match(skipped.stderr, /Test run failed: a\.test\.js did not run 1 tests, first later \(skipped\)/);
  const todo = vitestRun({ 'a.test.js': "test('runs', () => {});\ntest.todo('someday');\n" });
  assert.equal(todo.status, 1);
  assert.match(todo.stderr, /a\.test\.js did not run 1 tests, first someday/);
});
test('the Vitest reporter fails the reviewer\'s name pattern that matches no test, which Vitest alone passes', () => {
  const files = { 'a.test.js': "test('runs', () => {});\n" };
  const pattern = ['--testNamePattern', 'zzz-no-test-has-this-name'];
  const without = vitestRun(files, pattern, false);
  assert.equal(without.status, 0, 'without the reporter Vitest passes a run that executed no test');
  const run = vitestRun(files, pattern);
  assert.equal(run.status, 1);
  assert.match(run.stderr, /a\.test\.js ran no test/);
});

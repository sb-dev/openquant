import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { root } from '../../repository.ts';
import { pinnedPnpm } from '../../typescript.ts';
import { ciWorkflowErrors, constantFalse, dependabotErrors, workflowErrors, workflowFileErrors } from '../workflows.ts';

const ci = readFileSync(resolve(root, '.github/workflows/ci.yml'), 'utf8');
const dependabot = readFileSync(resolve(root, '.github/dependabot.yml'), 'utf8');
const pnpm = pinnedPnpm(root);

function replaceOnce(source: string, from: string | RegExp, to: string): string {
  const count = typeof from === 'string' ? source.split(from).length - 1 : [...source.matchAll(new RegExp(from.source, `${from.flags.replace('g', '')}g`))].length;
  assert.equal(count, 1, `the live ci.yml must hold this text exactly once: ${from}`);
  return source.replace(from, () => to);
}
function rejects(source: string, expected: RegExp, label: string) {
  const errors = ciWorkflowErrors(source, pnpm);
  assert.ok(errors.some((error) => expected.test(error)), `${label}: ${errors.join(' | ') || 'no error'}`);
}

test('the live workflows and Dependabot configuration pass', () => {
  assert.deepEqual(ciWorkflowErrors(ci, pnpm), []);
  assert.deepEqual(dependabotErrors(dependabot), []);
  assert.deepEqual(workflowFileErrors(root, pnpm), []);
});

// The eight edits of the S0 review (verification V2-1). Each passed the substring checks; each must fail here.
const verifyStep = '      - name: Verify repository\n        run: node scripts/verify.ts\n';
const rustStep = '      - name: Install pinned Rust toolchain\n        run: rustup toolchain install --profile minimal\n';
const pnpmStep = '      - name: Install locked dependencies\n        run: pnpm install --frozen-lockfile\n';
const comment = (block: string) => block.split('\n').map((line) => (line ? line.replace(/^( *)/, '$1# ') : line)).join('\n');
test('V2-1: verify with || true fails', () => rejects(replaceOnce(ci, 'run: node scripts/verify.ts', 'run: node scripts/verify.ts || true'), /must run node scripts\/verify\.ts in exactly one step, found 0/, '|| true'));
test('V2-1: an echo of the verify command fails', () => rejects(replaceOnce(ci, 'run: node scripts/verify.ts', 'run: echo node scripts/verify.ts'), /must run node scripts\/verify\.ts in exactly one step, found 0/, 'echo'));
test('V2-1: a constant false if on the verify step fails', () => {
  const source = replaceOnce(ci, verifyStep, verifyStep.replace('        run:', '        if: ${{ false }}\n        run:'));
  rejects(source, /step \d+ \(Verify repository\) is disabled by a constant false if/, 'if false');
  rejects(source, /the step that must run node scripts\/verify\.ts must not set if/, 'if on a required step');
});
test('V2-1: a commented install step fails', () => {
  rejects(replaceOnce(ci, rustStep, comment(rustStep)), /must install the pinned Rust toolchain in exactly one step, found 0/, 'commented rustup');
  rejects(replaceOnce(ci, pnpmStep, comment(pnpmStep)), /must install the locked dependencies in exactly one step, found 0/, 'commented pnpm install');
});
test('V2-1: an echo install step fails', () => {
  rejects(replaceOnce(ci, 'run: rustup toolchain install --profile minimal', 'run: echo rustup toolchain install --profile minimal'), /must install the pinned Rust toolchain in exactly one step, found 0/, 'echo rustup');
  rejects(replaceOnce(ci, 'run: pnpm install --frozen-lockfile', 'run: echo pnpm install --frozen-lockfile'), /must install the locked dependencies in exactly one step, found 0/, 'echo pnpm install');
});
test('V2-1: a commented timeout before a short one fails', () => {
  rejects(replaceOnce(ci, /    timeout-minutes: 30\n/, '    # timeout-minutes: 30\n    timeout-minutes: 10\n'), /needs timeout-minutes of at least 20, found 10/, 'short timeout');
});
test('V2-1: a removed push trigger fails', () => rejects(replaceOnce(ci, '  push:\n    branches: [main]\n', ''), /the push trigger is required/, 'no push'));
test('V2-1: a removed pull_request trigger fails', () => rejects(replaceOnce(ci, '  pull_request:\n', ''), /the pull_request trigger is required/, 'no pull_request'));

test('the triggers cannot be narrowed', () => {
  rejects(replaceOnce(ci, '  pull_request:\n', "  pull_request:\n    paths: ['docs/**']\n"), /pull_request trigger must not be filtered/, 'paths filter');
  rejects(replaceOnce(ci, '    branches: [main]\n', '    branches: [release]\n'), /push trigger may only filter branches, and must include main/, 'other branch');
});
test('a required step cannot change its shell, directory or failure handling', () => {
  rejects(replaceOnce(ci, verifyStep, `${verifyStep}        shell: 'true {0}'\n`), /run node scripts\/verify\.ts must not set shell/, 'shell');
  rejects(replaceOnce(ci, verifyStep, `${verifyStep}        working-directory: elsewhere\n`), /must not set working-directory/, 'working-directory');
  rejects(replaceOnce(ci, verifyStep, `${verifyStep}        continue-on-error: true\n`), /must not set continue-on-error/, 'continue-on-error');
});
test('a second verify step or a reordered install fails', () => {
  rejects(replaceOnce(ci, verifyStep, `${verifyStep}${verifyStep}`), /run node scripts\/verify\.ts in exactly one step, found 2/, 'two verify steps');
  rejects(replaceOnce(ci, `${rustStep}${verifyStep}`, `${verifyStep}${rustStep}`), /must install the pinned Rust toolchain after|run node scripts\/verify\.ts after/, 'verify before rustup');
});
test('pnpm must be the pinned version', () => rejects(replaceOnce(ci, `pnpm@${pnpm}`, 'pnpm@10.0.0'), new RegExp(`must install pnpm ${pnpm.replaceAll('.', '\\.')} in exactly one step, found 0`), 'pnpm version'));
test('a job cannot be disabled or allowed to fail', () => {
  rejects(replaceOnce(ci, '    timeout-minutes: 30\n', '    timeout-minutes: 30\n    if: false\n'), /job checks is disabled by a constant false if/, 'job if false');
  rejects(replaceOnce(ci, '    timeout-minutes: 30\n', '    timeout-minutes: 30\n    continue-on-error: true\n'), /job checks must not set continue-on-error/, 'job continue-on-error');
});
test('permissions stay read-only', () => {
  rejects(replaceOnce(ci, 'permissions:\n  contents: read\n', 'permissions:\n  contents: write\n'), /top-level permissions must be read-only/, 'top-level write');
  rejects(replaceOnce(ci, 'permissions:\n  contents: read\n', ''), /top-level permissions must be read-only/, 'no permissions');
  rejects(replaceOnce(ci, '    timeout-minutes: 30\n', '    timeout-minutes: 30\n    permissions:\n      pull-requests: write\n'), /job checks must not grant write permissions/, 'job write');
});
test('actions stay pinned to a full commit SHA', () => rejects(replaceOnce(ci, /actions\/checkout@[0-9a-f]{40}/, 'actions/checkout@v7'), /must use a full commit SHA: actions\/checkout@v7/, 'mutable action'));

test('the aggregate must need and check every other job', () => {
  const extra = '  extra:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo extra\n\n';
  rejects(replaceOnce(ci, '  ci:\n', `${extra}  ci:\n`), /the aggregate job ci must need extra/, 'unlisted job');
  const listed = replaceOnce(replaceOnce(ci, '  ci:\n', `${extra}  ci:\n`), 'needs: [checks]', 'needs: [checks, extra]');
  rejects(listed, /the aggregate job ci must check that extra succeeded/, 'unchecked job');
  rejects(replaceOnce(ci, "if: ${{ always() }}", "if: ${{ always() && false }}"), /must run with if: \$\{\{ always\(\) \}\} and nothing else/, 'always and false');
  rejects(replaceOnce(ci, 'test "$CHECK_RESULT" = success', 'test "$CHECK_RESULT" = success || true'), /may only run test "\$RESULT" = success/, '|| true in aggregate');
  rejects(replaceOnce(ci, 'run: test "$CHECK_RESULT" = success', 'run: |\n          exit 0\n          test "$CHECK_RESULT" = success'), /may only run test "\$RESULT" = success.*: exit 0/, 'exit 0 first');
  rejects(replaceOnce(ci, '${{ needs.checks.result }}', "'success'"), /must check that checks succeeded/, 'constant result');
});

test('constant false conditions are recognised and real conditions are not', () => {
  for (const value of [false, 0, null, 'false', '${{ false }}', ' ${{ false }} ', '${{ 0 }}', "${{ '' }}", 'FALSE']) assert.ok(constantFalse(value), String(value));
  for (const value of [true, '${{ always() }}', "github.event_name == 'push'", '${{ success() }}']) assert.ok(!constantFalse(value), String(value));
});
test('other workflows get the generic rules', () => {
  const other = "on: push\npermissions:\n  contents: read\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v7\n        continue-on-error: true\n";
  const errors = workflowErrors('.github/workflows/other.yml', other);
  assert.ok(errors.some((error) => /must use a full commit SHA/.test(error)), errors.join(' | '));
  assert.ok(errors.some((error) => /must not set continue-on-error/.test(error)), errors.join(' | '));
  assert.ok(workflowErrors('.github/workflows/other.yml', 'on: pull_request_target\npermissions: {}\njobs: {}\n').some((error) => /privileged triggers/.test(error)));
  assert.match(workflowErrors('.github/workflows/other.yml', 'on: push\non: pull_request\n')[0] ?? '', /invalid YAML/);
});
test('Dependabot keeps weekly grouped updates without automatic majors', () => {
  assert.match(dependabotErrors(dependabot.replace(/  - package-ecosystem: npm[\s\S]*$/, '')).join('\n'), /missing the npm ecosystem/);
  const npm = dependabot.slice(dependabot.indexOf('  - package-ecosystem: npm'));
  assert.match(dependabotErrors(dependabot.replace(npm, npm.replace("update-types: ['version-update:semver-major']", "update-types: ['version-update:semver-minor']"))).join('\n'), /npm must not propose major updates automatically/);
  assert.match(dependabotErrors(dependabot.replace(npm, npm.replace('interval: weekly', 'interval: daily'))).join('\n'), /npm updates must be weekly/);
});

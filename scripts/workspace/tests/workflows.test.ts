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
const verifyRun = /checks step 6 \(Verify repository\) must have run: "node scripts\/verify\.ts"/;
test('V2-1: verify with || true fails', () => rejects(replaceOnce(ci, 'run: node scripts/verify.ts', 'run: node scripts/verify.ts || true'), verifyRun, '|| true'));
test('V2-1: an echo of the verify command fails', () => rejects(replaceOnce(ci, 'run: node scripts/verify.ts', 'run: echo node scripts/verify.ts'), verifyRun, 'echo'));
test('V2-1: a constant false if on the verify step fails', () => {
  const source = replaceOnce(ci, verifyStep, verifyStep.replace('        run:', '        if: ${{ false }}\n        run:'));
  rejects(source, /step \d+ \(Verify repository\) is disabled by a constant false if/, 'if false');
  rejects(source, /checks step 6 \(Verify repository\) must not set if/, 'if on a required step');
});
test('V2-1: a commented install step fails', () => {
  rejects(replaceOnce(ci, rustStep, comment(rustStep)), /the checks job must have exactly 6 steps, found 5/, 'commented rustup');
  rejects(replaceOnce(ci, rustStep, comment(rustStep)), /checks step 5 \(Install pinned Rust toolchain\) must have name: "Install pinned Rust toolchain", found "Verify repository"/, 'commented rustup, shifted');
  rejects(replaceOnce(ci, pnpmStep, comment(pnpmStep)), /checks step 4 \(Install locked dependencies\) must have name/, 'commented pnpm install');
});
test('V2-1: an echo install step fails', () => {
  rejects(replaceOnce(ci, 'run: rustup toolchain install --profile minimal', 'run: echo rustup toolchain install --profile minimal'), /checks step 5 \(Install pinned Rust toolchain\) must have run: "rustup toolchain install --profile minimal", found "echo rustup/, 'echo rustup');
  rejects(replaceOnce(ci, 'run: pnpm install --frozen-lockfile', 'run: echo pnpm install --frozen-lockfile'), /checks step 4 \(Install locked dependencies\) must have run: "pnpm install --frozen-lockfile", found "echo pnpm/, 'echo pnpm install');
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
  rejects(replaceOnce(ci, verifyStep, `${verifyStep}        shell: 'true {0}'\n`), /checks step 6 \(Verify repository\) must not set shell/, 'shell');
  rejects(replaceOnce(ci, verifyStep, `${verifyStep}        working-directory: elsewhere\n`), /must not set working-directory/, 'working-directory');
  rejects(replaceOnce(ci, verifyStep, `${verifyStep}        continue-on-error: true\n`), /must not set continue-on-error/, 'continue-on-error');
});
test('a second verify step or a reordered install fails', () => {
  rejects(replaceOnce(ci, verifyStep, `${verifyStep}${verifyStep}`), /the checks job has an unexpected step 7/, 'two verify steps');
  rejects(replaceOnce(ci, verifyStep, `${verifyStep}${verifyStep}`), /exactly one step may mention scripts\/verify\.ts, found 2/, 'two verify steps');
  rejects(replaceOnce(ci, `${rustStep}${verifyStep}`, `${verifyStep}${rustStep}`), /checks step 5 \(Install pinned Rust toolchain\) must have name: "Install pinned Rust toolchain", found "Verify repository"/, 'verify before rustup');
});
test('pnpm must be the pinned version', () => rejects(replaceOnce(ci, `pnpm@${pnpm}`, 'pnpm@10.0.0'), new RegExp(`checks step 3 \\(Install pinned pnpm\\) must have run: "npm install --global --ignore-scripts pnpm@${pnpm.replaceAll('.', '\\.')}"`), 'pnpm version'));

// C0: the parsed checks must fix every input of the checks job, not only the run text of its required steps.
// The reviewer's combined edit: a step that defines a shell function named node, and BASH_ENV on the verify step,
// so that `node scripts/verify.ts` prints a line and exits 0.
const prepareShell = `      - name: Prepare shell\n        run: echo 'node() { echo verify skipped; }' > "$RUNNER_TEMP/env.sh"\n`;
const bashEnv = '        env:\n          BASH_ENV: ${{ runner.temp }}/env.sh\n';
test('C0: the reviewer\'s BASH_ENV edit fails: an extra step and env on the verify step', () => {
  const source = replaceOnce(replaceOnce(ci, rustStep, `${prepareShell}${rustStep}`), verifyStep, `${verifyStep}${bashEnv}`);
  rejects(source, /the checks job must have exactly 6 steps, found 7/, 'extra step');
  rejects(source, /checks step 5 \(Install pinned Rust toolchain\) must have name: "Install pinned Rust toolchain", found "Prepare shell"/, 'extra step in place');
  rejects(source, /the checks job has an unexpected step 7/, 'extra step at the end');
  rejects(source, /job checks step 7 must not set BASH_ENV/, 'BASH_ENV');
  rejects(replaceOnce(ci, verifyStep, `${verifyStep}${bashEnv}`), /checks step 6 \(Verify repository\) must not set env/, 'env alone');
});
test('C0: a checkout of a fixed commit, another repository or path fails', () => {
  const checkout = '          persist-credentials: false\n';
  rejects(replaceOnce(ci, checkout, `${checkout}          ref: 5b3c257bba3600b9143fcb5b3425886d6d2008db\n`), /checks step 1 \(Check out source\) must have with: \{"persist-credentials":false\}, found \{"persist-credentials":false,"ref":"5b3c257bba3600b9143fcb5b3425886d6d2008db"\}/, 'ref');
  rejects(replaceOnce(ci, checkout, `${checkout}          repository: someone/else\n`), /checks step 1 \(Check out source\) must have with:/, 'repository');
  rejects(replaceOnce(ci, checkout, '          persist-credentials: true\n'), /checks step 1 \(Check out source\) must have with:/, 'persisted credentials');
});
test('C0: an action at another commit or a changed setup-node input fails', () => {
  rejects(replaceOnce(ci, /actions\/checkout@[0-9a-f]{40}/, `actions/checkout@${'0'.repeat(40)}`), /checks step 1 \(Check out source\) must have uses: "actions\/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1"/, 'checkout commit');
  rejects(replaceOnce(ci, 'node-version-file: .node-version', 'node-version: 22'), /checks step 2 \(Set up Node\) must have with:/, 'node version');
});
test('C0: workflow and job env may set only the allowed variables, with their values', () => {
  const jobEnv = "    env:\n      CARGO_INCREMENTAL: '0'\n      CARGO_TERM_COLOR: always\n";
  rejects(replaceOnce(ci, jobEnv, `${jobEnv}      NODE_OPTIONS: --test-skip-pattern=.\n      RUSTFLAGS: --cap-lints=allow\n`), /job checks must not set NODE_OPTIONS/, 'NODE_OPTIONS');
  rejects(replaceOnce(ci, jobEnv, `${jobEnv}      NODE_OPTIONS: --test-skip-pattern=.\n      RUSTFLAGS: --cap-lints=allow\n`), /job checks must not set RUSTFLAGS/, 'RUSTFLAGS');
  rejects(replaceOnce(ci, jobEnv, `${jobEnv}      PATH: /tmp/fake\n`), /job checks may set only CARGO_INCREMENTAL and CARGO_TERM_COLOR, found PATH/, 'PATH');
  rejects(replaceOnce(ci, "CARGO_INCREMENTAL: '0'", "CARGO_INCREMENTAL: '1'"), /job checks must set CARGO_INCREMENTAL to "0", found "1"/, 'allowed key, other value');
  rejects(replaceOnce(ci, 'concurrency:\n', 'env:\n  BASH_ENV: /tmp/env.sh\nconcurrency:\n'), /the workflow must not set BASH_ENV/, 'workflow BASH_ENV');
  rejects(replaceOnce(ci, 'concurrency:\n', 'env:\n  GREETING: hello\nconcurrency:\n'), /the workflow may set only CARGO_INCREMENTAL and CARGO_TERM_COLOR, found GREETING/, 'workflow other key');
});
test('C0: a banned variable fails anywhere in the workflow', () => {
  const banned = ['BASH_ENV', 'ENV', 'NODE_OPTIONS', 'NODE_TEST_CONTEXT', 'RUSTFLAGS', 'RUSTDOCFLAGS', 'RUSTC_WRAPPER', 'RUSTC_WORKSPACE_WRAPPER', 'CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_RUNNER', 'CARGO_BUILD_RUSTFLAGS', 'TURBO_FORCE', 'npm_config_script_shell', 'pnpm_config_verify_deps_before_run', 'NPM_CONFIG_IGNORE_SCRIPTS', 'BIOME_CONFIG_PATH'];
  const aggregateEnv = '          CHECK_RESULT: ${{ needs.checks.result }}\n';
  const extra = '  extra:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo extra\n        env:\n          NAME: value\n\n';
  for (const name of banned) {
    rejects(replaceOnce(ci, aggregateEnv, `${aggregateEnv}          ${name}: x\n`), new RegExp(`job ci step 1 must not set ${name}`), `aggregate step ${name}`);
    rejects(replaceOnce(ci, '  ci:\n', `${extra.replace('NAME', name)}  ci:\n`), new RegExp(`job extra step 1 must not set ${name}`), `other job ${name}`);
  }
});
test('C0: the checks job keeps its keys, runner and name', () => {
  const timeout = '    timeout-minutes: 30\n';
  rejects(replaceOnce(ci, timeout, `${timeout}    container: attacker/image:latest\n`), /the checks job must not set container/, 'container');
  rejects(replaceOnce(ci, timeout, `${timeout}    services:\n      x:\n        image: y\n`), /the checks job must not set services/, 'services');
  rejects(replaceOnce(ci, timeout, `${timeout}    strategy:\n      matrix:\n        x: [1]\n`), /the checks job must not set strategy/, 'strategy');
  rejects(replaceOnce(ci, '    runs-on: ubuntu-latest\n    timeout-minutes: 30\n', '    runs-on: self-hosted\n    timeout-minutes: 30\n'), /the checks job must run on ubuntu-latest, found "self-hosted"/, 'self-hosted');
  rejects(replaceOnce(ci, 'name: Repository checks', 'name: Other checks'), /the checks job must be named Repository checks/, 'name');
  rejects(replaceOnce(ci, 'concurrency:\n', 'run-name: x\nconcurrency:\n'), /the workflow must not set run-name/, 'unknown workflow key');
});
test('C0: the aggregate job keeps a fixed shape', () => {
  const aggregate = '    timeout-minutes: 2\n';
  rejects(replaceOnce(ci, aggregate, `${aggregate}    env:\n      LEVEL: x\n`), /the aggregate job ci must not set env/, 'job env');
  rejects(replaceOnce(ci, aggregate, `${aggregate}    container: attacker/image:latest\n`), /the aggregate job ci must not set container/, 'container');
  rejects(replaceOnce(ci, '    runs-on: ubuntu-latest\n    timeout-minutes: 2\n', '    runs-on: self-hosted\n    timeout-minutes: 2\n'), /the aggregate job ci must run on ubuntu-latest/, 'runner');
  rejects(replaceOnce(ci, '      - name: Require successful checks\n', '      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1\n      - name: Require successful checks\n'), /an aggregate step may set only name, env and run/, 'uses step');
});

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

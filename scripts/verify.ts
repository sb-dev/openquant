import { spawnSync } from 'node:child_process';
import { stepEnvironment } from './environment.ts';
import { root } from './repository.ts';
import { cargoCommands, fixtureDigest, runCargo, toolchainPinError } from './rust.ts';
import { reportErrors } from './s0.ts';
import { dependencyInstallError, runTypescript, typescriptCommands } from './typescript.ts';

function fail(message: string): never {
  console.error(`\nVerification failed: ${message}`);
  process.exit(1);
}

// scripts/s0.ts compares this file, without comments and blank lines, with a literal copy of its code. A
// statement added anywhere (an early exit, an environment change) fails the repository checks. Every process
// starts with stepEnvironment() from scripts/environment.ts.

// 1. Repository checks and their regression tests (Node only; no dependency install).
for (const args of [['scripts/check-repository.ts'], ['--test', 'scripts/tests/repository.test.ts']]) {
  const result = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit', env: stepEnvironment() });
  if (result.error) console.error(result.error.message);
  if (result.status !== 0) process.exit(result.status ?? 1);
}

// 2. Rust: pinned toolchain, format, clippy, tests (unit, property, protocol, fixtures), replay.
const pinError = toolchainPinError(root);
if (pinError) fail(pinError);
const fixturesBefore = fixtureDigest(root);
for (const command of cargoCommands) {
  const status = runCargo(root, command);
  if (status !== 0) fail(`${command} exited with status ${status}`);
}
if (fixtureDigest(root) !== fixturesBefore) fail('fixtures changed while verification ran; golden data is never regenerated during a test');

// 3. The replay report must exist, list every case and show no failure.
const problems = reportErrors(root);
if (problems.length) fail(problems.join('\n'));

// 4. TypeScript: the installed dependencies must match pnpm-lock.yaml (never installed here), then the
// dependency-using workspace checks (including the Turborepo task list), Turborepo typecheck, lint, test and
// build without cached results, and the workspace tests.
const installError = dependencyInstallError(root);
if (installError) fail(installError);
const typescriptFixturesBefore = fixtureDigest(root);
for (const command of typescriptCommands) {
  const status = runTypescript(root, command);
  if (status !== 0) fail(`${command} exited with status ${status}`);
}
if (fixtureDigest(root) !== typescriptFixturesBefore) fail('fixtures changed while the TypeScript steps ran; golden data is never regenerated during a test');

console.log('\nVerification passed: repository checks, Rust format, clippy, tests, the S0 offline replay, the contracts report, and the TypeScript typecheck, lint, test, build and workspace checks. S1 is incomplete: the connected competition is not implemented.');

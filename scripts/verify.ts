import { spawnSync } from 'node:child_process';
import { root } from './repository.ts';
import { cargoCommands, fixtureDigest, runCargo, toolchainPinError } from './rust.ts';
import { reportErrors } from './s0.ts';

function fail(message: string): never {
  console.error(`\nVerification failed: ${message}`);
  process.exit(1);
}

// 1. Repository checks and their regression tests (Node only; no dependency install).
for (const args of [['scripts/check-repository.ts'], ['--test', 'scripts/tests/repository.test.ts']]) {
  const result = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit' });
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

console.log('\nVerification passed: repository checks, Rust format, clippy, tests and the S0 offline replay. Connected slices S1 and later remain unimplemented.');

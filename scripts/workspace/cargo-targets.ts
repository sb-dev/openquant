import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { stepEnvironment } from '../environment.ts';

// The Cargo test targets (OQ-06 sections 1 and 8; P1 review finding G4). `cargo test --workspace` passes when Cargo
// builds fewer test targets than the tracked integration test files, for example when a manifest turns off test
// discovery or a test target needs a feature that is never enabled. The manifest rules in scripts/s0.ts reject the
// known settings. This check asks Cargo which test targets it builds and fails when a tracked tests/*.rs or
// tests/*/main.rs of a workspace member is not one of them. verify.ts runs it in the workspace checks, after the Cargo
// steps, so the build is current and the command only lists the targets.

type Json = any;

export const noRunArguments = ['test', '--locked', '--workspace', '--no-run', '--message-format=json'] as const;

// The JSON messages of `cargo test --locked --workspace --no-run --message-format=json` in base.
export function cargoTestMessages(base: string): Json[] {
  const result = spawnSync('cargo', [...noRunArguments], { cwd: base, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, env: stepEnvironment() });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`cargo ${noRunArguments.join(' ')} exited with status ${result.status}: ${result.stderr}`);
  return result.stdout.split('\n').filter((line) => line.startsWith('{')).map((line) => JSON.parse(line));
}

// The integration test files that Cargo discovers in each member: tests/*.rs and tests/*/main.rs.
export function integrationTestFiles(files: Iterable<string>, members: readonly string[]): string[] {
  return [...files].filter((file) => members.some((member) => file.startsWith(`${member}/tests/`) && /^(?:[^/]+\.rs|[^/]+\/main\.rs)$/.test(file.slice(`${member}/tests/`.length)))).sort();
}

export function testTargetErrors(base: string, files: Iterable<string>, members: readonly string[], messages: readonly Json[]): string[] {
  const real = (path: string) => {
    try {
      return realpathSync(path);
    } catch {
      return resolve(path);
    }
  };
  const built = new Set<string>();
  for (const message of messages) {
    const target = message?.target;
    if (message?.reason !== 'compiler-artifact' || message.profile?.test !== true || typeof message.executable !== 'string') continue;
    if (Array.isArray(target?.kind) && target.kind.includes('test') && typeof target.src_path === 'string') built.add(real(target.src_path));
  }
  const expected = integrationTestFiles(files, members);
  if (expected.length === 0) return [`No tracked integration test file under tests/ of the workspace members ${members.join(', ')}`];
  return expected.filter((file) => !built.has(real(resolve(base, file)))).map((file) => `${file} is a tracked integration test, but cargo ${noRunArguments.join(' ')} builds no test target from it, so cargo test does not run it`);
}

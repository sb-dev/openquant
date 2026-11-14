import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { stepEnvironment } from './environment.ts';

// The TypeScript steps of `pnpm verify` (OQ-06 sections 1 and 2). They run after the Rust steps because the
// contract parity test reads the Rust contracts report. Each is real work; none prints success on its own.
// The workspace checks run first: among them, the Turborepo task list must hold exactly the expected package
// tasks, so a run with a package or a task missing cannot pass. Turborepo then runs with --force, so no cached
// task result can stand in for a run. The workspace test files are named one by one, so a missing file fails,
// and their reporter fails a run in which a file ran no test or a test was skipped.
// scripts/s0.ts compares this list, step by step and in order, with a literal copy of the expected steps.
export const typescriptCommands = [
  'pnpm exec node scripts/workspace/check-workspace.ts',
  'pnpm exec turbo run typecheck lint test build --force',
  'pnpm exec node --test --test-reporter=spec --test-reporter-destination=stdout --test-reporter=./scripts/workspace/test-reporter.ts --test-reporter-destination=stderr scripts/workspace/tests/boundaries.test.ts scripts/workspace/tests/licences.test.ts scripts/workspace/tests/reporters.test.ts scripts/workspace/tests/tasks.test.ts scripts/workspace/tests/workflows.test.ts',
] as const;

export const installCommand = 'pnpm install --frozen-lockfile';

// The pnpm version pinned by the packageManager field of the root package.json.
export function pinnedPnpm(base: string): string {
  const manifest = JSON.parse(readFileSync(resolve(base, 'package.json'), 'utf8'));
  const match = /^pnpm@(\d+\.\d+\.\d+)(?:\+.+)?$/.exec(String(manifest.packageManager));
  if (!match) throw new Error('package.json must pin pnpm in packageManager, for example pnpm@11.25.0');
  return match[1];
}

// The installed dependencies must be the ones in the committed lockfile. pnpm writes the lockfile it installed
// to node_modules/.pnpm/lock.yaml; verification compares the two byte for byte. It never installs or resolves.
export function dependencyInstallError(base: string): string | undefined {
  const instruction = `Run: ${installCommand}`;
  let pinned: string;
  try {
    pinned = pinnedPnpm(base);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  const result = spawnSync('pnpm', ['--version'], { cwd: base, encoding: 'utf8', env: stepEnvironment() });
  if ((result.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
    return `pnpm was not found on PATH. Verification needs pnpm ${pinned} (packageManager in package.json) and the dependencies locked in pnpm-lock.yaml. Install pnpm ${pinned}, then ${instruction}`;
  }
  if (result.error || result.status !== 0) {
    return `Cannot run pnpm ${pinned}: ${result.stderr ?? result.error?.message ?? ''}`;
  }
  if (result.stdout.trim() !== pinned) {
    return `Expected pnpm ${pinned} from package.json, found: ${result.stdout.trim()}. Install pnpm ${pinned}, then ${instruction}`;
  }
  const wanted = resolve(base, 'pnpm-lock.yaml');
  const installed = resolve(base, 'node_modules/.pnpm/lock.yaml');
  if (!existsSync(wanted)) return 'pnpm-lock.yaml is missing. Restore the committed lockfile; verification never resolves dependencies.';
  if (!existsSync(installed)) return `The dependencies in pnpm-lock.yaml are not installed. ${instruction}`;
  if (!readFileSync(installed).equals(readFileSync(wanted))) {
    return `The installed dependencies do not match pnpm-lock.yaml. ${instruction}`;
  }
  return undefined;
}

// Every step runs with stepEnvironment() (scripts/environment.ts): no inherited NODE_OPTIONS, NODE_TEST_* or
// TURBO_* variable, Turborepo telemetry off, and pnpm set to fail instead of installing.
export function runTypescript(base: string, command: string): number {
  const [program, ...args] = command.split(' ');
  console.log(`\n$ ${command}`);
  const result = spawnSync(program, args, { cwd: base, stdio: 'inherit', env: stepEnvironment() });
  if (result.error) console.error(result.error.message);
  return result.status ?? 1;
}

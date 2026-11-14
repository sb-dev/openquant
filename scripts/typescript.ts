import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// The TypeScript steps of `pnpm verify` (OQ-06 sections 1 and 2). They run after the Rust steps because the
// contract parity test reads the Rust contracts report. Each is real work; none prints success on its own.
// Turborepo runs with --force, so no cached task result can stand in for a run.
// scripts/s0.ts compares this list, step by step and in order, with a literal copy of the expected steps.
export const typescriptCommands = [
  'pnpm exec turbo run typecheck lint test build --force',
  'pnpm exec node scripts/workspace/check-workspace.ts',
  'pnpm exec node --test scripts/workspace/tests/*.test.ts',
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
  const result = spawnSync('pnpm', ['--version'], { cwd: base, encoding: 'utf8' });
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

export function runTypescript(base: string, command: string): number {
  const [program, ...args] = command.split(' ');
  console.log(`\n$ ${command}`);
  // No Turborepo telemetry. pnpm 11 installs before `exec` when it finds the install out of date; here it must
  // fail instead, so a step can never install silently.
  const env = { ...process.env, TURBO_TELEMETRY_DISABLED: '1', pnpm_config_verify_deps_before_run: 'error' };
  const result = spawnSync(program, args, { cwd: base, stdio: 'inherit', env });
  if (result.error) console.error(result.error.message);
  return result.status ?? 1;
}

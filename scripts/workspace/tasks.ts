import { spawnSync } from 'node:child_process';
import { stepEnvironment } from '../environment.ts';
import { expectedWorkspacePackages, workspaceTasks } from '../s0.ts';

// The Turborepo tasks that the TypeScript steps of `pnpm verify` run (OQ-06 section 1). Before Turborepo runs, its
// dry run must list exactly the typecheck, lint, test and build task of every package in expectedWorkspacePackages
// (scripts/s0.ts), each with the pinned script and no extra arguments. A workspace without a package, or a package
// without a task or with another script, cannot pass with fewer tasks: Turborepo runs zero tasks successfully.

type Json = any;

export const dryRunArguments = ['run', ...workspaceTasks, '--dry=json'] as const;

export function turboDryRun(base: string): Json {
  const result = spawnSync('turbo', [...dryRunArguments], { cwd: base, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, env: stepEnvironment() });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`turbo ${dryRunArguments.join(' ')} exited with status ${result.status}: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

export function turboTaskErrors(dryRun: Json): string[] {
  const label = `turbo ${dryRunArguments.join(' ')}`;
  const tasks: Json[] = Array.isArray(dryRun?.tasks) ? dryRun.tasks : [];
  if (!Array.isArray(dryRun?.tasks)) return [`${label} returned no task list`];
  const errors: string[] = [];
  const names = expectedWorkspacePackages.map((item) => item.name);
  const packages: string[] = Array.isArray(dryRun.packages) ? [...dryRun.packages].sort() : [];
  if (JSON.stringify(packages) !== JSON.stringify([...names].sort())) {
    errors.push(`Turborepo must see exactly the workspace packages ${names.join(', ')}; it sees ${packages.join(', ') || 'none'}`);
  }
  const expected = new Set<string>();
  for (const item of expectedWorkspacePackages) {
    for (const task of workspaceTasks) {
      const id = `${item.name}#${task}`;
      expected.add(id);
      const found = tasks.filter((entry) => entry?.taskId === id);
      if (found.length !== 1) { errors.push(`Turborepo must run ${id} once; ${label} lists it ${found.length} times`); continue; }
      const [entry] = found;
      if (entry.command !== item.scripts[task]) errors.push(`Turborepo would run ${id} as ${JSON.stringify(entry.command)}; expected ${JSON.stringify(item.scripts[task])}`);
      if (entry.directory !== item.directory) errors.push(`Turborepo would run ${id} in ${JSON.stringify(entry.directory)}; expected ${item.directory}`);
      if (!Array.isArray(entry.cliArguments) || entry.cliArguments.length > 0) errors.push(`Turborepo would pass extra arguments to ${id}: ${JSON.stringify(entry.cliArguments)}`);
    }
  }
  for (const entry of tasks) {
    if (!expected.has(entry?.taskId)) errors.push(`Turborepo would run a task that is not expected: ${entry?.taskId}`);
  }
  return errors;
}

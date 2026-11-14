import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { paths, root } from '../repository.ts';
import { cargoWorkspaceMembers } from '../s0.ts';
import { pinnedPnpm } from '../typescript.ts';
import { boundaryErrors } from './boundaries.ts';
import { cargoTestMessages, testTargetErrors } from './cargo-targets.ts';
import { installedPackages, licenceErrors } from './licences.ts';
import { turboDryRun, turboTaskErrors } from './tasks.ts';
import { workflowFileErrors } from './workflows.ts';

// Repository checks that need the installed dependencies or a current Cargo build. verify.ts runs them first in its
// TypeScript steps, after the Cargo steps and the dependency check, and before Turborepo runs.
// scripts/check-repository.ts stays free of dependencies and does not import them.
const errors: string[] = [];
const guard = (label: string, check: () => string[]) => {
  try {
    errors.push(...check());
  } catch (error) {
    errors.push(`${label}: ${error instanceof Error ? error.message : error}`);
  }
};
guard('Licences', () => licenceErrors(installedPackages(root)));
guard('Import boundaries', () => boundaryErrors(root));
guard('Workflows', () => workflowFileErrors(root, pinnedPnpm(root)));
guard('Turborepo tasks', () => turboTaskErrors(turboDryRun(root)));
guard('Cargo test targets', () => testTargetErrors(root, paths(root), cargoWorkspaceMembers(readFileSync(resolve(root, 'Cargo.toml'), 'utf8')), cargoTestMessages(root)));

if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}
console.log('Workspace checks passed: licences of the installed packages, import boundaries, workflows and Dependabot, the Turborepo task list, and the Cargo test targets.');

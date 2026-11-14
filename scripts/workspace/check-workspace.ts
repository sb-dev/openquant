import { root } from '../repository.ts';
import { pinnedPnpm } from '../typescript.ts';
import { boundaryErrors } from './boundaries.ts';
import { installedPackages, licenceErrors } from './licences.ts';
import { workflowFileErrors } from './workflows.ts';

// Repository checks that need the installed dependencies. verify.ts runs them in its TypeScript steps, after
// the dependency check. scripts/check-repository.ts stays free of dependencies and does not import them.
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

if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}
console.log('Workspace checks passed: licences of the installed packages, import boundaries, workflows and Dependabot.');

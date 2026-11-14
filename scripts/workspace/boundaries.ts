import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { posix, resolve } from 'node:path';
import { withoutComments } from '../s0.ts';

// Import boundaries over source text (OQ-05 sections 1, 5 and 9; AGENTS.md). Ink talks to the product only
// through Hono, Worker code runs without Node built-ins, and the agent runner holds no broker or engine code.
// A rule applies to every source file under its roots that exist; a root that does not exist yet has nothing
// to check. This reads import statements; it is not a module resolver.

export interface BoundaryRule { name: string; roots: readonly string[]; reason: (specifier: string, target: string | undefined) => string | undefined; }

const builtins = new Set(builtinModules.flatMap((name) => [name, name.replace(/^node:/, '')]));
const within = (target: string | undefined, directory: string) => target !== undefined && (target === directory || target.startsWith(`${directory}/`));

export const boundaryRules: readonly BoundaryRule[] = [
  {
    name: 'client code reaches the API only through Hono',
    roots: ['apps/cli', 'packages/api-client'],
    reason: (specifier, target) => (within(target, 'apps/api') || /^@openquant\/api(?:\/|$)/.test(specifier) ? 'imports apps/api' : undefined),
  },
  {
    name: 'Worker code uses no Node built-ins',
    roots: ['packages/api-contracts/ts/src', 'apps/api/src', 'packages/agents/src'],
    reason: (specifier) => (specifier.startsWith('node:') || builtins.has(specifier.split('/')[0]) ? `imports the Node built-in ${specifier}` : undefined),
  },
  {
    name: 'the agent runner holds no broker or engine code',
    roots: ['apps/agent-runner'],
    reason: (specifier, target) => {
      if (within(target, 'apps/engine') || /^@openquant\/engine(?:\/|$)/.test(specifier)) return 'imports apps/engine';
      if (/(?:^|[/@._-])brokers?(?:[/._-]|$)/i.test(specifier) || /^@alpacahq\//.test(specifier)) return 'imports broker code';
      return undefined;
    },
  },
];

const sourceFile = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const skipped = new Set(['node_modules', 'dist', '.turbo', '.wrangler', 'coverage', 'target', '.cache']);

// Module specifiers of static imports and re-exports, side-effect imports, dynamic import() and require().
export function importSpecifiers(source: string): string[] {
  const code = withoutComments(source);
  const found: string[] = [];
  for (const match of code.matchAll(/\b(?:import|export)\s+(?:type\s+)?(?:[^'";]*?\bfrom\s*)?['"]([^'"\n]+)['"]/g)) found.push(match[1]);
  for (const match of code.matchAll(/\b(?:import|require)\s*\(\s*['"`]([^'"`\n]+)['"`]\s*\)/g)) found.push(match[1]);
  return found;
}

// Violations in one file. `file` is the repository-relative path.
export function boundaryViolations(file: string, source: string, rules: readonly BoundaryRule[] = boundaryRules): string[] {
  const errors: string[] = [];
  for (const rule of rules) {
    if (!rule.roots.some((root) => within(file, root))) continue;
    for (const specifier of importSpecifiers(source)) {
      const target = specifier.startsWith('.') ? posix.normalize(posix.join(posix.dirname(file), specifier)) : undefined;
      const reason = rule.reason(specifier, target);
      if (reason) errors.push(`Import boundary (${rule.name}): ${file} ${reason}: ${specifier}`);
    }
  }
  return errors;
}

function sourceFiles(base: string, directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(resolve(base, directory), { withFileTypes: true })) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory() && !skipped.has(entry.name)) found.push(...sourceFiles(base, path));
    else if (entry.isFile() && sourceFile.test(entry.name)) found.push(path);
  }
  return found;
}

export function boundaryErrors(base: string): string[] {
  const errors: string[] = [];
  const files = new Set<string>();
  for (const rule of boundaryRules) {
    for (const root of rule.roots) if (existsSync(resolve(base, root))) for (const file of sourceFiles(base, root)) files.add(file);
  }
  for (const file of [...files].sort()) errors.push(...boundaryViolations(file, readFileSync(resolve(base, file), 'utf8')));
  return errors;
}

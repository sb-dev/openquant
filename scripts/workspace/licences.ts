import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

// Licence allowlist for the installed npm packages (OQ-06 section 2.2: licences). The list was derived from the
// dependency tree locked in pnpm-lock.yaml when the TypeScript workspace was added. Any other licence, or a
// package without one, fails verification until a reviewer adds it here with a reason.

// Permissive licences accepted for any package.
export const permissiveLicences: readonly string[] = ['MIT', 'ISC', 'Apache-2.0', 'BSD-3-Clause', 'MIT OR Apache-2.0'];

// Licences accepted only for the named packages. All are development tools; none is distributed.
export const reviewedLicences: Readonly<Record<string, RegExp>> = {
  // lightningcss and its platform binaries, through vite (Vitest). File-level copyleft on unmodified files.
  'MPL-2.0': /^lightningcss(?:-[a-z0-9-]+)?$/,
  // argparse, a port of the Python module, through js-yaml (json-schema-to-typescript and its ref parser).
  'Python-2.0': /^argparse$/,
  'PSF-2.0': /^argparse$/,
};

export interface InstalledPackage { name: string; version: string; licence: string | undefined; }

function licenceOf(manifest: any): string | undefined {
  if (typeof manifest.license === 'string' && manifest.license.trim()) return manifest.license.trim();
  if (Array.isArray(manifest.licenses)) {
    const types = manifest.licenses.map((item: any) => item?.type).filter((type: unknown) => typeof type === 'string');
    if (types.length) return types.join(' OR ');
  }
  return undefined;
}

// Every package pnpm installed: node_modules/.pnpm/<id>/node_modules/<name>. Dependencies of a package are
// symlinks beside it and are listed under their own id, so symlinks are skipped.
export function installedPackages(base: string): InstalledPackage[] {
  const store = resolve(base, 'node_modules/.pnpm');
  if (!existsSync(store)) throw new Error('node_modules/.pnpm is missing. Run: pnpm install --frozen-lockfile');
  const packages: InstalledPackage[] = [];
  for (const entry of readdirSync(store, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const modules = resolve(store, entry.name, 'node_modules');
    if (!existsSync(modules)) continue;
    for (const item of readdirSync(modules)) {
      const names = item.startsWith('@') ? readdirSync(resolve(modules, item)).map((child) => `${item}/${child}`) : [item];
      for (const name of names) {
        const directory = resolve(modules, name);
        if (lstatSync(directory).isSymbolicLink() || !existsSync(resolve(directory, 'package.json'))) continue;
        const manifest = JSON.parse(readFileSync(resolve(directory, 'package.json'), 'utf8'));
        packages.push({ name: manifest.name ?? name, version: manifest.version ?? '?', licence: licenceOf(manifest) });
      }
    }
  }
  return packages.sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`));
}

export function licenceErrors(packages: readonly InstalledPackage[]): string[] {
  const errors: string[] = [];
  if (packages.length === 0) errors.push('No installed npm packages were found to check');
  for (const item of packages) {
    const id = `${item.name}@${item.version}`;
    if (!item.licence) { errors.push(`Installed package has no licence: ${id}`); continue; }
    if (permissiveLicences.includes(item.licence)) continue;
    const named = reviewedLicences[item.licence];
    if (named?.test(item.name)) continue;
    errors.push(`Licence not on the allowlist: ${id} is ${item.licence}`);
  }
  return errors;
}

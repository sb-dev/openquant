// Independent helpers for the tests: they share no code with the modules under test, so a defect in one path
// cannot hide in the other (OQ-02 section 9, A04).

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const repositoryRoot = resolve(packageRoot, '../..');

/** Sorted-key compact JSON, written independently of the canonical serialiser in @openquant/api-contracts. */
export function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${stable(child)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function sha256Text(text: string): string {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

export function sha256File(path: string): string {
  return `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`;
}

export function readText(relative: string): string {
  return readFileSync(resolve(repositoryRoot, relative), 'utf8');
}

export function readJson<T = unknown>(relative: string): T {
  return JSON.parse(readText(relative)) as T;
}

/** The pointers of every scalar leaf of a JSON value, found with an explicit stack. */
export function leafPointers(root: unknown): string[] {
  const found: string[] = [];
  const stack: [string, unknown][] = [['', root]];
  while (stack.length > 0) {
    const [pointer, value] = stack.pop() as [string, unknown];
    if (Array.isArray(value)) {
      value.forEach((item, index) => {
        stack.push([`${pointer}/${index}`, item]);
      });
    } else if (typeof value === 'object' && value !== null) {
      for (const [key, child] of Object.entries(value)) stack.push([`${pointer}/${key}`, child]);
    } else {
      found.push(pointer);
    }
  }
  return found.sort();
}

/** Set one value of a deep copy of a JSON document. The pointer must name an existing member. */
export function withValue<T>(document: T, pointer: string, value: unknown): T {
  const copy = structuredClone(document) as Record<string, unknown>;
  const tokens = pointer.split('/').slice(1);
  const last = tokens.pop() as string;
  let node: unknown = copy;
  for (const token of tokens) node = (node as Record<string, unknown>)[token];
  const target = node as Record<string, unknown>;
  if (!(last in target)) throw new Error(`no member at ${pointer}`);
  target[last] = value;
  return copy as T;
}

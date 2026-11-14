// Runs the shared protocol fixtures (fixtures/protocol/manifest.json) through the TypeScript layer.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { digest, isContractName, parseContract } from '../../src/index.ts';

export const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
export const fixturesDir = resolve(repositoryRoot, 'fixtures');
export const manifestPath = resolve(fixturesDir, 'protocol/manifest.json');
export const reportPath = resolve(repositoryRoot, 'local-runs/contracts/report.json');

export const EXPECTATIONS = ['valid', 'schema_invalid', 'semantic_invalid'] as const;
export type Expectation = (typeof EXPECTATIONS)[number];

export interface ManifestEntry {
  readonly path: string;
  readonly contract: string;
  readonly expect: Expectation;
  readonly code?: string;
}

/** One entry's TypeScript outcome, in the shape of a contracts-report/1 entry. */
export interface EntryResult {
  readonly path: string;
  readonly contract: string;
  readonly expect: Expectation;
  readonly verdict: 'accepted' | 'rejected';
  readonly code?: string;
  readonly digest?: string;
}

function isExpectation(value: unknown): value is Expectation {
  return EXPECTATIONS.some((expect) => expect === value);
}

export function readManifest(): { readonly bytes: Uint8Array; readonly entries: readonly ManifestEntry[] } {
  const bytes = readFileSync(manifestPath);
  const manifest = JSON.parse(bytes.toString('utf8')) as { schema?: unknown; entries?: unknown };
  if (manifest.schema !== 's0-protocol-manifest/1') throw new Error('unexpected protocol manifest schema');
  if (!Array.isArray(manifest.entries)) throw new Error('the protocol manifest has no entries');
  const entries = manifest.entries.map((raw: Record<string, unknown>) => {
    const { path, contract, expect, code } = raw;
    if (typeof path !== 'string' || typeof contract !== 'string' || !isExpectation(expect)) {
      throw new Error(`malformed manifest entry: ${JSON.stringify(raw)}`);
    }
    return typeof code === 'string' ? { path, contract, expect, code } : { path, contract, expect };
  });
  return { bytes, entries };
}

export async function runEntry(entry: ManifestEntry): Promise<EntryResult> {
  if (!isContractName(entry.contract)) throw new Error(`${entry.path}: unknown contract ${entry.contract}`);
  const result = parseContract(entry.contract, readFileSync(resolve(fixturesDir, entry.path)));
  const base = { path: entry.path, contract: entry.contract, expect: entry.expect };
  if (!result.ok) return { ...base, verdict: 'rejected', code: result.error.code };
  return { ...base, verdict: 'accepted', digest: await digest(result.value) };
}

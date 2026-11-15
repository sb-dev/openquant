// wrangler.jsonc against the code that reads the bindings (workers-best-practices: names must match in both
// directions, and the file holds no identifier and no secret). wrangler itself is not installed, so the file is read
// here as JSONC, and the binding names are compared with the WorkerBindings interface of src/env.ts.

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const api = resolve(fileURLToPath(import.meta.url), '../..');
const read = (path: string) => readFileSync(resolve(api, path), 'utf8');

/** JSONC to JSON: line comments and block comments outside strings are dropped. */
function stripComments(text: string): string {
  let out = '';
  let index = 0;
  while (index < text.length) {
    const char = text[index] as string;
    const next = text[index + 1];
    if (char === '"') {
      let end = index + 1;
      while (text[end] !== '"') end += text[end] === '\\' ? 2 : 1;
      out += text.slice(index, end + 1);
      index = end + 1;
    } else if (char === '/' && next === '/') {
      while (index < text.length && text[index] !== '\n') index += 1;
    } else if (char === '/' && next === '*') {
      index = text.indexOf('*/', index + 2) + 2;
    } else {
      out += char;
      index += 1;
    }
  }
  return out;
}

interface WranglerConfig {
  name: string;
  main: string;
  compatibility_date: string;
  compatibility_flags: string[];
  observability: { enabled: boolean; traces: { enabled: boolean } };
  vars: Record<string, string>;
  hyperdrive: { binding: string }[];
  r2_buckets: { binding: string }[];
  [key: string]: unknown;
}

const config = JSON.parse(stripComments(read('wrangler.jsonc'))) as WranglerConfig;

/** The names of the WorkerBindings interface in src/env.ts. */
function declaredBindings(): string[] {
  const source = read('src/env.ts');
  const body = /export interface WorkerBindings \{([\s\S]*?)\n\}/.exec(source)?.[1] ?? '';
  return [...body.matchAll(/^\s*readonly ([A-Z][A-Z0-9_]*)\??:/gm)].map((match) => match[1] as string).sort();
}

const secretNames = read('.dev.vars.example')
  .split('\n')
  .filter((line) => /^[A-Z][A-Z0-9_]*=/.test(line))
  .map((line) => line.split('=')[0] as string);

describe('wrangler.jsonc', () => {
  it('names the bindings, variables and secrets that WorkerBindings declares, and no others', () => {
    const configured = [
      ...config.hyperdrive.map((entry) => entry.binding),
      ...config.r2_buckets.map((entry) => entry.binding),
      ...Object.keys(config.vars),
      ...secretNames,
    ].sort();
    expect(configured).toEqual(declaredBindings());
    expect(declaredBindings()).toEqual(['ARTEFACTS', 'HYPERDRIVE', 'OPENQUANT_ENVIRONMENT', 'TOKEN_SIGNING_KEY']);
  });

  it('is read by the code under exactly those names: every name that the Worker reads from its bindings is declared', () => {
    const used = [...read('src/worker.ts').matchAll(/\bbindings\.([A-Z][A-Z0-9_]*)/g)].map(
      (match) => match[1] as string,
    );
    expect(used.length).toBeGreaterThan(3);
    for (const name of used) expect(declaredBindings(), name).toContain(name);
    for (const name of declaredBindings()) expect(used, `${name} is declared and never read`).toContain(name);
  });

  it('holds no identifier, no bucket name, no account, and no value that looks like a secret', () => {
    const forbidden = [
      'id',
      'bucket_name',
      'account_id',
      'zone_id',
      'database_id',
      'routes',
      'route',
      'kv_namespaces',
      'secrets',
      'localConnectionString',
    ];
    const walk = (value: unknown, path: string): void => {
      if (typeof value === 'object' && value !== null) {
        for (const [key, child] of Object.entries(value)) {
          expect(forbidden, `${path}.${key}`).not.toContain(key);
          walk(child, `${path}.${key}`);
        }
      }
    };
    walk(config, 'config');
    expect(config.vars).toEqual({ OPENQUANT_ENVIRONMENT: 'DEVELOPMENT' });
    expect(JSON.stringify(config)).not.toMatch(/postgres(?:ql)?:\/\/|oqk1\.|oqa1\.|sk-|Bearer /i);
    // A secret has its name in .dev.vars.example and an empty value, never a value.
    expect(
      read('.dev.vars.example')
        .split('\n')
        .filter((line) => /^[A-Z][A-Z0-9_]*=/.test(line)),
    ).toEqual(['TOKEN_SIGNING_KEY=']);
  });

  it('enables nodejs_compat for pg, a current compatibility date, and logs and traces', () => {
    expect(config.compatibility_flags).toContain('nodejs_compat');
    expect(config.compatibility_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(config.compatibility_date >= '2026-11-15').toBe(true);
    expect(config.observability).toEqual({ enabled: true, traces: { enabled: true } });
  });

  it('points at the Worker entry, which exists, and binds Hyperdrive and R2 once each', () => {
    expect(config.main).toBe('src/worker.ts');
    expect(existsSync(resolve(api, config.main))).toBe(true);
    expect(config.hyperdrive).toEqual([{ binding: 'HYPERDRIVE' }]);
    expect(config.r2_buckets).toEqual([{ binding: 'ARTEFACTS' }]);
    expect(config.name).toBe('openquant-api');
  });

  it('is not configured to skip anything: no passThroughOnException, no remote bindings, no unsafe settings', () => {
    expect(JSON.stringify(config)).not.toMatch(/passThrough|"remote"|unsafe|dev\./);
    expect(read('src/worker.ts')).not.toContain('passThroughOnException');
  });
});

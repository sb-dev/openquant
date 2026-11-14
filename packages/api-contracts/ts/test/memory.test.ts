// The contract layer parses the densest bodies within the memory of a Worker isolate (128 MB). Each
// case runs test/support/dense-body.ts in a child Node process whose heap is limited to 128 MB, so
// an unbounded parse dies there instead of passing on a large test machine.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { MAX_PAYLOAD_BYTES } from '../src/index.ts';
import { repositoryRoot } from './support/manifest.ts';

const script = resolve(dirname(fileURLToPath(import.meta.url)), 'support/dense-body.ts');
const WORKER_HEAP = '--max-old-space-size=128';
// The largest text the parser accepts, as dense as the shape allows.
const LARGEST = MAX_PAYLOAD_BYTES - 2;

function run(...args: string[]) {
  const child = spawnSync(process.execPath, [WORKER_HEAP, script, ...args], { encoding: 'utf8', timeout: 120_000 });
  return { status: child.status, signal: child.signal, stdout: child.stdout, stderr: child.stderr };
}

function outcome(...args: string[]): Record<string, unknown> {
  const child = run(...args);
  expect(child.status, child.stderr.slice(-2000)).toBe(0);
  return JSON.parse(child.stdout) as Record<string, unknown>;
}

describe('a body of 16 MiB of dense values is rejected under a 128 MB heap', () => {
  test.each(['zeros', 'arrays', 'objects', 'keys'])('%s', (shape) => {
    expect(outcome(shape, 'api-error', String(LARGEST))).toMatchObject({
      verdict: 'rejected',
      code: 'SCHEMA_VIOLATION',
      kind: 'value-bound',
      bytes: LARGEST,
    });
  });

  test('the control: building every value of the objects body exhausts the same heap', () => {
    const child = run('objects', 'api-error', String(LARGEST), 'unbounded');
    expect(child.status === 0 && child.signal === null, 'the unbounded parse should run out of memory').toBe(false);
    expect(child.stderr).toMatch(/heap out of memory|Allocation failed/);
  });
});

test('a command body at the route limit parses under a 128 MB heap', () => {
  // command/1 has no value bound: its schema is recursive (an Expr tree in a seed draft). The API
  // refuses a larger command body before parsing it (routes/v1.json, OQ-05 §7).
  const manifest = JSON.parse(
    readFileSync(resolve(repositoryRoot, 'packages/api-contracts/routes/v1.json'), 'utf8'),
  ) as {
    routes: { request: { contract?: string }; max_body_bytes?: number }[];
  };
  const limits = manifest.routes.filter((route) => route.request.contract === 'command').map((r) => r.max_body_bytes);
  expect(limits.length).toBeGreaterThan(0);
  const limit = Math.max(...limits.map((value) => value ?? Number.POSITIVE_INFINITY));
  expect(Number.isFinite(limit)).toBe(true);
  expect(outcome('objects', 'command', String(limit))).toMatchObject({ verdict: 'rejected', code: 'SCHEMA_VIOLATION' });
});

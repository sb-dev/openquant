// Every contract has a Worker byte limit (workerBodyLimit, OQ-05 §7). The densest bodies at that
// limit must parse within 64 MB, half of a Worker isolate's 128 MB. Each case runs
// test/support/dense-body.ts in a child Node process whose heap is limited to 128 MB. The child
// reports the peak of its heap plus its external memory, which holds the body bytes, typed arrays
// and, in Node, the decoded text. Its own baseline of about 20 MiB is included.
//
// Two kinds of body are measured. The dense shapes build the most values, or the most heap per
// byte, that the parse can be made to build; they never reach the violation listing, because each
// exceeds the value bound or a structural limit. The errors shapes are invalid documents of exactly
// MAX_NODES values whose listing creates the most Ajv errors the contract allows
// (support/error-shape.ts), padded to the byte limit with spaces or with long two-byte strings: the
// listing runs, and its errors are counted against the bound of test/errors.test.ts.

import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import {
  type ContractName,
  contracts,
  isContractName,
  MAX_PAYLOAD_BYTES,
  RESULT_SCAN_LIMIT,
  workerBodyLimit,
} from '../src/index.ts';
import { MAX_NODES } from '../src/limits.ts';
import { errorBound } from './support/error-bound.ts';
import { bundleDefs } from './support/error-shape.ts';

const script = resolve(dirname(fileURLToPath(import.meta.url)), 'support/dense-body.ts');
const resultScript = resolve(dirname(fileURLToPath(import.meta.url)), 'support/dense-result.ts');
const WORKER_HEAP = '--max-old-space-size=128';
/** 64 MB, in MiB as the child reports it. */
const BUDGET_MIB = (64 * 1000 * 1000) / 2 ** 20;
const SHAPES = ['zeros', 'arrays', 'objects', 'singletons', 'nested', 'keys', 'shapes', 'escapes', 'wide'] as const;
const ERROR_SHAPES = ['errors', 'errors-wide'] as const;

interface Child {
  readonly status: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

function run(...args: string[]): Promise<Child> {
  return runScript(script, ...args);
}

function runScript(path: string, ...args: string[]): Promise<Child> {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [WORKER_HEAP, path, ...args], { timeout: 120_000 });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', fail);
    child.on('close', (status, signal) => done({ status, signal, stdout, stderr }));
  });
}

async function outcome(...args: string[]): Promise<Record<string, unknown>> {
  return outcomeOf(script, ...args);
}

async function outcomeOf(path: string, ...args: string[]): Promise<Record<string, unknown>> {
  const child = await runScript(path, ...args);
  expect(child.status, child.stderr.slice(-2000)).toBe(0);
  return JSON.parse(child.stdout) as Record<string, unknown>;
}

const names = Object.keys(contracts).filter(isContractName);

test('every contract has a Worker byte limit within the strict-JSON limit', () => {
  expect(names).toHaveLength(Object.keys(contracts).length);
  for (const name of names) {
    expect(workerBodyLimit(name), name).toBeGreaterThan(0);
    expect(workerBodyLimit(name), name).toBeLessThanOrEqual(MAX_PAYLOAD_BYTES);
  }
  // The contracts whose parse may build every value get the smaller limit.
  const small = names.filter((name) => workerBodyLimit(name) < 4 * 1024 * 1024).sort();
  expect(small).toEqual(['checkpoint', 'command', 'evaluation-result', 'strategy-artefact']);
});

describe('the densest bodies at each Worker byte limit parse within 64 MB', () => {
  const cases = names.flatMap((name) => SHAPES.map((shape) => [name, shape] as [ContractName, string]));
  test.concurrent.each(cases)('%s %s', async (name, shape) => {
    const limit = workerBodyLimit(name);
    const result = await outcome(shape, name, String(limit));
    expect(result).toMatchObject({ verdict: 'rejected', bytes: limit });
    expect(result.peakTotalMiB, JSON.stringify(result)).toBeLessThanOrEqual(BUDGET_MIB);
  });
});

describe('the violation listing of the error-maximising body at each Worker byte limit stays within 64 MB', () => {
  const defs = bundleDefs();
  const cases = names.flatMap((name) => ERROR_SHAPES.map((shape) => [name, shape] as [ContractName, string]));
  test.concurrent.each(cases)('%s %s', async (name, shape) => {
    const limit = workerBodyLimit(name);
    const result = await outcome(shape, name, String(limit));
    // The listing ran on a document of exactly MAX_NODES values.
    expect(result).toMatchObject({ verdict: 'rejected', bytes: limit, values: MAX_NODES, listingStopped: false });
    const { errorsPerValue } = errorBound(defs, contracts[name].typeName);
    expect(result.ajvErrors, JSON.stringify(result)).toBeLessThanOrEqual(errorsPerValue * MAX_NODES);
    expect(result.peakTotalMiB, JSON.stringify(result)).toBeLessThanOrEqual(BUDGET_MIB);
  });
});

describe('the scan of a submitted result at RESULT_SCAN_LIMIT stays within 64 MB', () => {
  // The journal is read but not built: memory is the bytes, the decoded text and the head.
  test.concurrent.each(['zeros', 'objects', 'keys', 'nested', 'escapes', 'wide'])('%s journal', async (shape) => {
    const result = await outcomeOf(resultScript, shape, String(RESULT_SCAN_LIMIT));
    expect(result).toMatchObject({ verdict: 'accepted', bytes: RESULT_SCAN_LIMIT });
    expect(result.peakTotalMiB, JSON.stringify(result)).toBeLessThanOrEqual(BUDGET_MIB);
  });

  test('an extra top-level member is built only up to the value bound', async () => {
    const result = await outcomeOf(resultScript, 'head', String(RESULT_SCAN_LIMIT));
    expect(result).toMatchObject({ verdict: 'rejected', kind: 'value-bound', bytes: RESULT_SCAN_LIMIT });
    expect(result.peakTotalMiB, JSON.stringify(result)).toBeLessThanOrEqual(BUDGET_MIB);
  });
});

describe('the value bound alone keeps a 16 MiB body within a 128 MB heap', () => {
  // The largest text the parser accepts, as dense as the shape allows.
  const LARGEST = MAX_PAYLOAD_BYTES - 2;
  test.concurrent.each(['zeros', 'objects', 'nested', 'keys'])('%s', async (shape) => {
    expect(await outcome(shape, 'api-error', String(LARGEST))).toMatchObject({
      verdict: 'rejected',
      code: 'SCHEMA_VIOLATION',
      kind: 'value-bound',
      bytes: LARGEST,
    });
  });

  test('the control: building every value of the objects body exhausts the same heap', async () => {
    const child = await run('objects', 'api-error', String(LARGEST), 'unbounded');
    expect(child.status === 0 && child.signal === null, 'the unbounded parse should run out of memory').toBe(false);
    expect(child.stderr).toMatch(/heap out of memory|Allocation failed/);
  });
});

// The result scan of an evaluation submission (OQ-05 sections 4 and 7): a result is larger than the 512 KiB Worker parse
// limit, so the API scans it, within 8 MiB, and builds only its head. These tests submit results of 2 MiB and of exactly
// 8 MiB with a large journal that a whole parse would reject for its size, and a journal that the scan refuses for its
// array limit. The cited result is served back byte for byte. The documents are synthetic.

import { RESULT_SCAN_LIMIT, workerBodyLimit } from '@openquant/api-contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  bytesOf,
  claim,
  digestOfBytes,
  driveRetrieval,
  errorCode,
  type Flow,
  type Started,
  startedFlow,
} from './support/flow.ts';
import { type runsOf, submitEvaluation, toEvaluating } from './support/steps.ts';
import type { Doc } from './support/world.ts';

let flow: Flow & Started;
let runs: Awaited<ReturnType<typeof runsOf>>;
const slot = (runSlot: string) => runs.find((run) => run.runSlot === runSlot) as (typeof runs)[number];

beforeAll(async () => {
  flow = await startedFlow();
  expect((await driveRetrieval(flow)).response.status).toBe(204);
  runs = (await toEvaluating(flow)).runs;
});
afterAll(async () => {
  await flow.world.drop();
});

/**
 * Set the journal of a result to entries of one padded string each, so that the whole result has exactly `target`
 * bytes. 8,000 entries stay below the array limit of 8,192, and each string below the 16,384 bytes of a string.
 */
function padJournal(result: Doc, target: number): void {
  const entries = 8000;
  result.journal = [];
  const base = bytesOf(result).length;
  const entry = (pad: number) => ({ pad: 'x'.repeat(pad) });
  // `{"pad":""}` is 10 bytes; entries are separated by one comma; the empty journal already holds its brackets.
  const each = Math.floor((target - base - (entries - 1) - 10 * entries) / entries);
  result.journal = Array.from({ length: entries }, () => entry(each));
  const gap = target - bytesOf(result).length;
  result.journal[entries - 1] = entry(each + gap);
  if (bytesOf(result).length !== target) throw new Error('The padded result is not the size that the test asked for.');
}

describe('a result that only the scan reads', () => {
  it('is accepted at 2 MiB, above the parse limit of its contract, and committed and served unchanged', async () => {
    expect(workerBodyLimit('evaluation-result')).toBe(512 * 1024);
    const run = slot('seed.d.base');
    const claimed = await claim(flow, run.attemptId);
    const { response, docs, refs } = await submitEvaluation(flow, claimed, run.runId, {
      edit: { result: (doc) => padJournal(doc, 2 * 1024 * 1024) },
    });
    expect(response.status, await response.clone().text()).toBe(204);
    expect(bytesOf(docs.result).length).toBe(2 * 1024 * 1024);
    expect(refs.result?.size_bytes).toBe(2 * 1024 * 1024);

    const [row] = await flow.world.sql<{ run_status: string; result_digest: string }>(
      'SELECT run_status, result_digest FROM results WHERE run_id = $1',
      [run.runId],
    );
    expect(row).toEqual({ run_status: 'COMPLETED', result_digest: refs.result?.digest });
    const served = await flow.send('GET', `/v1/runs/${run.runId}/result`, await flow.person('viewer'));
    expect(served.status).toBe(200);
    const bytes = new Uint8Array(await served.arrayBuffer());
    expect(bytes.length).toBe(2 * 1024 * 1024);
    expect(digestOfBytes(bytes)).toBe(refs.result?.digest);
  });

  it('is accepted at exactly 8 MiB, the scan limit, which the policy of the pilot lets a host upload', async () => {
    expect(RESULT_SCAN_LIMIT).toBe(8 * 1024 * 1024);
    const run = slot('seed.d.stress');
    const claimed = await claim(flow, run.attemptId);
    const { response, refs } = await submitEvaluation(flow, claimed, run.runId, {
      edit: { result: (doc) => padJournal(doc, RESULT_SCAN_LIMIT) },
    });
    expect(response.status, await response.clone().text()).toBe(204);
    expect(refs.result?.size_bytes).toBe(RESULT_SCAN_LIMIT);
    const [row] = await flow.world.sql<{ run_status: string; result_digest: string }>(
      'SELECT run_status, result_digest FROM results WHERE run_id = $1',
      [run.runId],
    );
    expect(row).toEqual({ run_status: 'COMPLETED', result_digest: refs.result?.digest });
  });

  it('is refused when the scan finds an array above its limit, with the contract code, and the attempt stays claimed', async () => {
    const run = slot('seed.v.base');
    const claimed = await claim(flow, run.attemptId);
    const { response } = await submitEvaluation(flow, claimed, run.runId, {
      edit: {
        result: (doc) => {
          // 8,193 items: one above the array limit of every contract. The document is small, but the scan refuses it.
          doc.journal = Array.from({ length: 8193 }, () => 0);
        },
      },
    });
    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe('SCHEMA_VIOLATION');
    expect(await flow.world.sql('SELECT 1 FROM results WHERE run_id = $1', [run.runId])).toHaveLength(0);
    expect(await flow.world.sql('SELECT status FROM attempts WHERE attempt_id = $1', [run.attemptId])).toEqual([
      { status: 'CLAIMED' },
    ]);
  });

  it('is refused when a head binding fails at full size: another strategy in an 8 MiB result is IDENTITY_MISMATCH', async () => {
    const run = slot('seed.v.stress');
    const claimed = await claim(flow, run.attemptId);
    const { response } = await submitEvaluation(flow, claimed, run.runId, {
      edit: {
        result: (doc) => {
          doc.strategy_hash = digestOfBytes(bytesOf('another strategy'));
          padJournal(doc, RESULT_SCAN_LIMIT);
        },
      },
    });
    expect(response.status).toBe(422);
    expect(await errorCode(response)).toBe('IDENTITY_MISMATCH');
    expect(await flow.world.sql('SELECT 1 FROM results WHERE run_id = $1', [run.runId])).toHaveLength(0);
  });
});

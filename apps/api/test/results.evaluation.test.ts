// attempts.evaluation-submission (OQ-05 sections 4 and 7; OQ-02 sections 3.6 and 8; decisions D5, D6 and D14): the API
// commits one official result per run, only from the current owner of the live attempt, after the cited result has been
// scanned and every binding holds. The outcome then maps to run status. Requests go through the real Hono app on a real
// database, and the documents are synthetic.

import { parseContract } from '@openquant/api-contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mapOutcome } from '../src/domain/outcomes.ts';
import { runRecovery } from '../src/recovery.ts';
import {
  bytesOf,
  type Claimed,
  claim,
  digestOfBytes,
  driveRetrieval,
  ENGINE_BATCH,
  errorCode,
  type Flow,
  json,
  type Started,
  startedFlow,
  submit,
  upload,
  uploadDoc,
} from './support/flow.ts';
import { evaluationDocs, type runsOf, submitEvaluation, toEvaluating } from './support/steps.ts';
import type { Doc } from './support/world.ts';

let flow: Flow & Started;
let runs: Awaited<ReturnType<typeof runsOf>>;
let claimedBase: Claimed | undefined;
const slot = (runSlot: string) => runs.find((run) => run.runSlot === runSlot) as (typeof runs)[number];

beforeAll(async () => {
  flow = await startedFlow();
  expect((await driveRetrieval(flow)).response.status).toBe(204);
  runs = (await toEvaluating(flow)).runs;
});
afterAll(async () => {
  await flow.world.drop();
});

describe('the outcome of a run maps to its status (OQ-02 section 3.6)', () => {
  // The table of the specification, written out: the numerical outcome and its code, the run status, what the gates read,
  // and whether the failure belongs to the platform (an attention item).
  const table: [
    string,
    'COMPLETED' | 'FAILED' | 'INSUFFICIENT' | 'NOT_PREPARED',
    string | undefined,
    string,
    string,
    boolean,
  ][] = [
    ['a completed run', 'COMPLETED', undefined, 'COMPLETED', 'ASSESS', false],
    ['an invalid level', 'FAILED', 'INVALID_LEVEL', 'FAILED', 'CORRECTNESS_FAIL', false],
    ['an unsupported operator', 'FAILED', 'UNSUPPORTED_OPERATOR', 'FAILED', 'CORRECTNESS_FAIL', false],
    ['an operator type mismatch', 'FAILED', 'OPERATOR_TYPE_MISMATCH', 'FAILED', 'CORRECTNESS_FAIL', false],
    ['an operator unit mismatch', 'FAILED', 'OPERATOR_UNIT_MISMATCH', 'FAILED', 'CORRECTNESS_FAIL', false],
    ['an invalid parameter', 'FAILED', 'INVALID_PARAMETER', 'FAILED', 'CORRECTNESS_FAIL', false],
    ['future data', 'FAILED', 'FUTURE_DATA', 'FAILED', 'INSUFFICIENT', true],
    ['events out of order', 'FAILED', 'EVENT_OUT_OF_ORDER', 'FAILED', 'INSUFFICIENT', true],
    ['an invalid input', 'FAILED', 'INVALID_INPUT', 'FAILED', 'INSUFFICIENT', true],
    ['a schema violation', 'FAILED', 'SCHEMA_VIOLATION', 'FAILED', 'INSUFFICIENT', true],
    ['an identity mismatch', 'FAILED', 'IDENTITY_MISMATCH', 'FAILED', 'INSUFFICIENT', true],
    ['an unsupported policy', 'FAILED', 'UNSUPPORTED_POLICY', 'FAILED', 'INSUFFICIENT', true],
    ['a checkpoint mismatch', 'FAILED', 'CHECKPOINT_MISMATCH', 'FAILED', 'INSUFFICIENT', true],
    ['an arithmetic overflow', 'FAILED', 'ARITHMETIC_OVERFLOW', 'FAILED', 'OUTSIDE_ENGINE_DOMAIN', false],
    ['a missing required bar', 'INSUFFICIENT', 'MISSING_REQUIRED_BAR', 'COMPLETED', 'INSUFFICIENT', false],
    [
      'an unsupported corporate action',
      'INSUFFICIENT',
      'UNSUPPORTED_CORPORATE_ACTION',
      'COMPLETED',
      'INSUFFICIENT',
      false,
    ],
    ['a fractional entitlement', 'INSUFFICIENT', 'FRACTIONAL_ENTITLEMENT', 'COMPLETED', 'INSUFFICIENT', false],
    ['an unsupported valuation', 'INSUFFICIENT', 'UNSUPPORTED_VALUATION', 'COMPLETED', 'INSUFFICIENT', false],
    [
      'a submission that ended before the core prepared the run (identity)',
      'NOT_PREPARED',
      'IDENTITY_MISMATCH',
      'FAILED',
      'INSUFFICIENT',
      true,
    ],
    [
      'a submission that ended before the core prepared the run (an operator code)',
      'NOT_PREPARED',
      'INVALID_PARAMETER',
      'FAILED',
      'CORRECTNESS_FAIL',
      false,
    ],
  ];
  for (const [label, status, code, runStatus, gates, attention] of table) {
    it(`${label}: run ${runStatus}, gates ${gates}${attention ? ', an attention item' : ''}`, () => {
      expect(mapOutcome(status, code)).toEqual({ runStatus, gates, attention });
    });
  }
});

describe('a submission that does not bind', () => {
  // Each case breaks one binding of a run that is claimed and uploaded. The submission is refused whole: nothing but its
  // upload and the audit record of the refusal is written, and the attempt stays claimed for the next try.
  type Edit = NonNullable<Parameters<typeof submitEvaluation>[3]>;
  const cases: [string, number, string, Edit][] = [
    ['another run', 422, 'IDENTITY_MISMATCH', { edit: { submission: (doc) => (doc.run_id = 'run-other') } }],
    [
      'another request digest',
      422,
      'IDENTITY_MISMATCH',
      { edit: { submission: (doc) => (doc.request_digest = digestOfBytes(bytesOf('other'))) } },
    ],
    ['another mode', 422, 'IDENTITY_MISMATCH', { edit: { submission: (doc) => (doc.mode = 'REPLAY') } }],
    ['another environment', 422, 'IDENTITY_MISMATCH', { edit: { submission: (doc) => (doc.environment = 'STAGING') } }],
    [
      'another engine digest',
      422,
      'IDENTITY_MISMATCH',
      { edit: { submission: (doc) => (doc.engine_digest = digestOfBytes(bytesOf('engine'))) } },
    ],
    [
      'another method',
      422,
      'IDENTITY_MISMATCH',
      { edit: { submission: (doc) => (doc.method.digest = digestOfBytes(bytesOf('method'))) } },
    ],
    [
      'another executable than the one that claimed',
      422,
      'IDENTITY_MISMATCH',
      { edit: { submission: (doc) => (doc.executable.version = '9.9.9') } },
    ],
    [
      'a result of another strategy',
      422,
      'IDENTITY_MISMATCH',
      { edit: { result: (doc) => (doc.strategy_hash = digestOfBytes(bytesOf('strategy'))) } },
    ],
    [
      'a result that names another input hash',
      422,
      'IDENTITY_MISMATCH',
      { edit: { result: (doc) => (doc.input_hash = digestOfBytes(bytesOf('input'))) } },
    ],
    [
      'a result of another engine',
      422,
      'IDENTITY_MISMATCH',
      { edit: { result: (doc) => (doc.engine_digest = digestOfBytes(bytesOf('engine'))) } },
    ],
    [
      'a result outcome that the submission does not repeat',
      422,
      'IDENTITY_MISMATCH',
      { edit: { result: (doc) => (doc.outcome = { status: 'FAILED', code: 'INVALID_LEVEL' }) } },
    ],
    [
      'an input that evaluates another window',
      422,
      'IDENTITY_MISMATCH',
      { edit: { input: (doc) => (doc.windows.scored_end = doc.windows.scored_start) } },
    ],
    [
      'an input with another information cutoff',
      422,
      'IDENTITY_MISMATCH',
      { edit: { input: (doc) => (doc.windows.information_cutoff = '2020-01-01T00:00:00Z') } },
    ],
    [
      'an input with another capital',
      422,
      'IDENTITY_MISMATCH',
      { edit: { input: (doc) => (doc.initial_capital = '1.00') } },
    ],
    [
      'an input with another execution policy',
      422,
      'IDENTITY_MISMATCH',
      { edit: { input: (doc) => (doc.policy.cost_model.fee_bps = '0') } },
    ],
    ['an input with another seed', 422, 'IDENTITY_MISMATCH', { edit: { input: (doc) => (doc.seed = 5) } }],
    [
      'an input of another strategy',
      422,
      'IDENTITY_MISMATCH',
      { edit: { input: (doc) => (doc.strategy_hash = digestOfBytes(bytesOf('strategy'))) } },
    ],
    [
      'an input of another dataset',
      422,
      'IDENTITY_MISMATCH',
      { edit: { input: (doc) => (doc.dataset.version = '99') } },
    ],
    [
      'an input of another instrument',
      422,
      'IDENTITY_MISMATCH',
      { edit: { input: (doc) => (doc.instruments[0].instrument_id = 'alpaca:other') } },
    ],
    ['metrics of another run', 422, 'IDENTITY_MISMATCH', { edit: { metrics: (doc) => (doc.run_id = 'run-other') } }],
    [
      'metrics that derive from another result',
      422,
      'IDENTITY_MISMATCH',
      { edit: { metrics: (doc) => (doc.source.result_digest = digestOfBytes(bytesOf('result'))) } },
    ],
    ['metrics of another method', 422, 'IDENTITY_MISMATCH', { edit: { metrics: (doc) => (doc.method.version = '2') } }],
    [
      'metrics of another window',
      422,
      'IDENTITY_MISMATCH',
      { edit: { metrics: (doc) => (doc.window.role = 'HOLDOUT') } },
    ],
    [
      'metrics of another cost case',
      422,
      'IDENTITY_MISMATCH',
      { edit: { metrics: (doc) => (doc.window.cost_scenario = 'COST_STRESS') } },
    ],
    ['metrics at another scale', 422, 'IDENTITY_MISMATCH', { edit: { metrics: (doc) => (doc.metric_scale = 4) } }],
    [
      'a failure code on a completed outcome',
      422,
      'IDENTITY_MISMATCH',
      { edit: { result: (doc) => (doc.outcome = { status: 'COMPLETED', code: 'INVALID_LEVEL' }) } },
    ],
    [
      'a FAILED outcome with a code of an INSUFFICIENT outcome',
      422,
      'IDENTITY_MISMATCH',
      { status: 'FAILED', code: 'MISSING_REQUIRED_BAR' },
    ],
    [
      'an INSUFFICIENT outcome with a code of a FAILED outcome',
      422,
      'IDENTITY_MISMATCH',
      { status: 'INSUFFICIENT', code: 'INVALID_LEVEL' },
    ],
    [
      'a result with a member that the schema does not define',
      400,
      'SCHEMA_VIOLATION',
      { edit: { result: (doc) => (doc.extra = 1) } },
    ],
    [
      'a result with an unsupported schema version',
      400,
      'UNSUPPORTED_SCHEMA_VERSION',
      { edit: { result: (doc) => (doc.schema_version = 'evaluation-result/2') } },
    ],
  ];

  it('is refused for each binding with the code that the route lists, writes nothing, and leaves the attempt claimed', async () => {
    const run = slot('seed.d.base');
    claimedBase = await claim(flow, run.attemptId);
    const problems: string[] = [];
    for (const [label, status, code, options] of cases) {
      const before = await flow.world.snapshot(['audit_events', 'artefacts']);
      const { response, docs } = await submitEvaluation(flow, claimedBase, run.runId, options);
      // The submission itself satisfies its contract: it is refused for the rule that its documents break.
      if (!parseContract('evaluation-submission', JSON.stringify(docs.submission)).ok)
        problems.push(`${label}: the submission is not schema-valid`);
      if (response.status !== status || (await errorCode(response)) !== code)
        problems.push(`${label}: answered ${response.status}`);
      const after = await flow.world.snapshot(['audit_events', 'artefacts']);
      if (JSON.stringify(after) !== JSON.stringify(before)) problems.push(`${label}: state changed`);
    }
    expect(problems).toEqual([]);
    const audit = await flow.world.sql('SELECT 1 FROM audit_events WHERE event_type = $1 AND subject = $2', [
      'attempt.submission_refused',
      run.attemptId,
    ]);
    expect(audit).toHaveLength(cases.length);
    const [attempt] = await flow.world.sql<{ status: string }>('SELECT status FROM attempts WHERE attempt_id = $1', [
      run.attemptId,
    ]);
    expect(attempt?.status).toBe('CLAIMED');
    expect(await flow.world.sql('SELECT 1 FROM results')).toHaveLength(0);
  });

  it('is refused when it cites an artefact that was not uploaded, or one with another size', async () => {
    const run = slot('seed.d.base');
    const claimed = claimedBase as Claimed;
    // Another seed gives an input, a result and metrics that no earlier case of this test uploaded.
    const { docs } = await evaluationDocs(flow, claimed, run.runId, { edit: { input: (doc) => (doc.seed = 7) } });
    const ghost = (doc: Doc) => ({
      digest: digestOfBytes(bytesOf(doc)),
      media_type: 'application/json',
      size_bytes: bytesOf(doc).length,
    });
    // Nothing was uploaded: the submission cites three documents that no row records.
    docs.submission.evaluation = {
      status: 'COMPLETED',
      input: ghost(docs.input),
      result: ghost(docs.result),
      metrics: ghost(docs.metrics),
    };
    const ghosts = await submit(flow, claimed, 'evaluation-submission', docs.submission);
    expect(ghosts.status).toBe(422);
    const ghostBody = await json<{ code: string; message: string }>(ghosts);
    expect(ghostBody.code).toBe('IDENTITY_MISMATCH');
    expect(ghostBody.message).toContain('not an uploaded artefact');
    // The same documents uploaded, and the result cited with one byte more than it holds.
    const input = await uploadDoc(flow, claimed, docs.input);
    const result = await uploadDoc(flow, claimed, docs.result);
    const metrics = await uploadDoc(flow, claimed, docs.metrics);
    docs.submission.evaluation = {
      status: 'COMPLETED',
      input,
      result: { ...result, size_bytes: result.size_bytes + 1 },
      metrics,
    };
    const wrongSize = await submit(flow, claimed, 'evaluation-submission', docs.submission);
    expect(wrongSize.status).toBe(422);
    expect(await flow.world.sql('SELECT 1 FROM results')).toHaveLength(0);
  });
});

describe('an accepted submission', () => {
  let accepted: Awaited<ReturnType<typeof submitEvaluation>>;

  it('commits the one official result of the run: the run, the attempt, the result and the metrics, and settles the usage', async () => {
    const run = slot('seed.d.base');
    accepted = await submitEvaluation(flow, claimedBase as Claimed, run.runId);
    const { response, refs } = accepted;
    expect(response.status, await response.clone().text()).toBe(204);
    const [row] = await flow.world.sql<Record<string, string | null>>(
      `SELECT run_status, outcome, outcome_code, input_digest, result_digest, engine_digest, method_digest, executable_digest
         FROM results WHERE run_id = $1`,
      [run.runId],
    );
    expect(row).toEqual({
      run_status: 'COMPLETED',
      outcome: 'COMPLETED',
      outcome_code: null,
      input_digest: refs.input?.digest,
      result_digest: refs.result?.digest,
      engine_digest: flow.release.engine.engine_digest,
      method_digest: flow.release.method.digest,
      executable_digest: ENGINE_BATCH.digest,
    });
    const [metrics] = await flow.world.sql<{ metrics_digest: string; metric_scale: number }>(
      'SELECT metrics_digest, metric_scale FROM metrics WHERE run_id = $1',
      [run.runId],
    );
    expect(metrics).toEqual({ metrics_digest: refs.metrics?.digest, metric_scale: 6 });
    const [state] = await flow.world.sql<{ run: string; attempt: string; lease: string; reservation: string }>(
      `SELECT r.status AS run, a.status AS attempt, l.status AS lease, s.status AS reservation
         FROM runs r JOIN attempts a ON a.run_id = r.run_id JOIN leases l ON l.attempt_id = a.attempt_id JOIN reservations s ON s.attempt_id = a.attempt_id
        WHERE r.run_id = $1`,
      [run.runId],
    );
    expect(state).toEqual({ run: 'COMPLETED', attempt: 'COMPLETED', lease: 'RELEASED', reservation: 'SETTLED' });
    // 41000 ms of the host's own duration are 41 seconds of the 600 reserved.
    const [line] = await flow.world.sql<{ reserved: string; used: string }>(
      'SELECT l.reserved::text, l.used::text FROM reservation_lines l WHERE l.attempt_id = $1',
      [run.attemptId],
    );
    expect(line).toEqual({ reserved: '600.00000000', used: '41.00000000' });
  });

  it('is served unchanged by the run routes: the bytes hash to the digests that the result records', async () => {
    const run = slot('seed.d.base');
    const viewer = await flow.person('viewer');
    const result = await flow.send('GET', `/v1/runs/${run.runId}/result`, viewer);
    expect(result.status).toBe(200);
    expect(digestOfBytes(new Uint8Array(await result.arrayBuffer()))).toBe(accepted.refs.result?.digest);
    const metrics = await flow.send('GET', `/v1/runs/${run.runId}/metrics`, viewer);
    expect(digestOfBytes(new Uint8Array(await metrics.arrayBuffer()))).toBe(accepted.refs.metrics?.digest);
  });

  it('answers a redelivery with the stored outcome and writes nothing: the run has one official result', async () => {
    const run = slot('seed.d.base');
    const before = await flow.world.snapshot();
    const again = await submit(flow, claimedBase as Claimed, 'evaluation-submission', accepted.docs.submission);
    expect(again.status).toBe(204);
    expect(await flow.world.snapshot()).toEqual(before);
    expect(await flow.world.sql('SELECT 1 FROM results WHERE run_id = $1', [run.runId])).toHaveLength(1);
  });

  it('refuses another submission from the same attempt: it cannot replace the accepted evidence', async () => {
    const other = { ...accepted.docs.submission, duration: { label: 'observed', milliseconds: 99000 } };
    const refused = await submit(flow, claimedBase as Claimed, 'evaluation-submission', other);
    expect(refused.status).toBe(422);
    expect(await errorCode(refused)).toBe('IDENTITY_MISMATCH');
    const [line] = await flow.world.sql<{ used: string }>(
      'SELECT l.used::text FROM reservation_lines l WHERE l.attempt_id = $1',
      [slot('seed.d.base').attemptId],
    );
    expect(line?.used).toBe('41.00000000');
  });
});

describe('the other outcomes', () => {
  async function submitAs(runSlot: string, options: Parameters<typeof submitEvaluation>[3]) {
    const run = slot(runSlot);
    const claimed = await claim(flow, run.attemptId);
    const { response } = await submitEvaluation(flow, claimed, run.runId, options);
    expect(response.status).toBe(204);
    const [row] = await flow.world.sql<{
      run: string;
      failure_code: string | null;
      outcome: string;
      outcome_code: string | null;
      result_digest: string | null;
      metrics: number;
      items: number;
    }>(
      `SELECT r.status AS run, r.failure_code, s.outcome, s.outcome_code, s.result_digest,
              (SELECT count(*)::int FROM metrics WHERE run_id = r.run_id) AS metrics,
              (SELECT count(*)::int FROM attention_items WHERE subject = 'run ' || r.run_id) AS items
         FROM runs r JOIN results s ON s.run_id = r.run_id WHERE r.run_id = $1`,
      [run.runId],
    );
    return { run, row };
  }

  it('FAILED with an operator code: the run is FAILED, the candidate is at fault, no metrics and no attention item', async () => {
    const { row } = await submitAs('seed.v.base', { status: 'FAILED', code: 'INVALID_LEVEL' });
    expect(row).toMatchObject({
      run: 'FAILED',
      failure_code: 'INVALID_LEVEL',
      outcome: 'FAILED',
      outcome_code: 'INVALID_LEVEL',
      metrics: 0,
      items: 0,
    });
    expect(row?.result_digest).toMatch(/^sha256:/);
  });

  it('FAILED with FUTURE_DATA: the run is FAILED and the platform is at fault: an attention item is opened', async () => {
    const { row } = await submitAs('seed.v.stress', { status: 'FAILED', code: 'FUTURE_DATA' });
    expect(row).toMatchObject({ run: 'FAILED', failure_code: 'FUTURE_DATA', outcome: 'FAILED', metrics: 0, items: 1 });
  });

  it('INSUFFICIENT: the run is COMPLETED with no metrics, and the metrics route says so', async () => {
    const { run, row } = await submitAs('seed.d.stress', { status: 'INSUFFICIENT', code: 'MISSING_REQUIRED_BAR' });
    expect(row).toMatchObject({
      run: 'COMPLETED',
      failure_code: null,
      outcome: 'INSUFFICIENT',
      outcome_code: 'MISSING_REQUIRED_BAR',
      metrics: 0,
      items: 0,
    });
    const viewer = await flow.person('viewer');
    const metrics = await flow.send('GET', `/v1/runs/${run.runId}/metrics`, viewer);
    expect(metrics.status).toBe(404);
    expect((await json<{ message: string }>(metrics)).message).toContain('no committed metrics');
    expect((await flow.send('GET', `/v1/runs/${run.runId}/result`, viewer)).status).toBe(200);
  });

  it('NOT_PREPARED: the run is FAILED by its code, no result document exists, and the platform is at fault', async () => {
    const { run, row } = await submitAs('seed.d.base.repeat', { status: 'NOT_PREPARED', code: 'IDENTITY_MISMATCH' });
    expect(row).toMatchObject({
      run: 'FAILED',
      failure_code: 'IDENTITY_MISMATCH',
      outcome: 'NOT_PREPARED',
      result_digest: null,
      metrics: 0,
      items: 1,
    });
    const viewer = await flow.person('viewer');
    expect((await flow.send('GET', `/v1/runs/${run.runId}/result`, viewer)).status).toBe(404);
  });
});

describe('a result above the scan limit', () => {
  it('commits no result: the run fails as a platform failure with an attention item, and the caller is told LIMIT_EXCEEDED', async () => {
    const big = await startedFlow({
      policy: (policy) => {
        // The route accepts 16 MiB: the policy lets the host upload that much, and the API scans 8 MiB at most.
        policy.limits.artefact_limit_bytes = 16 * 1024 * 1024;
      },
    });
    try {
      expect((await driveRetrieval(big)).response.status).toBe(204);
      const { runs: planned } = await toEvaluating(big);
      const run = planned[0] as (typeof planned)[number];
      const claimed = await claim(big, run.attemptId);
      const { docs } = await evaluationDocs(big, claimed, run.runId);
      const huge = new Uint8Array(8 * 1024 * 1024 + 1).fill(32);
      const input = await uploadDoc(big, claimed, docs.input);
      const result = await upload(big, claimed, huge);
      docs.submission.evaluation = { status: 'FAILED', code: 'INVALID_LEVEL', input, result };
      const response = await submit(big, claimed, 'evaluation-submission', docs.submission);
      expect(response.status).toBe(413);
      expect(await errorCode(response)).toBe('LIMIT_EXCEEDED');
      const [state] = await big.world.sql<{
        run: string;
        failure_code: string;
        attempt: string;
        results: number;
        items: number;
      }>(
        `SELECT r.status AS run, r.failure_code, a.status AS attempt, (SELECT count(*)::int FROM results) AS results,
                (SELECT count(*)::int FROM attention_items WHERE subject = 'run ' || r.run_id) AS items
           FROM runs r JOIN attempts a ON a.run_id = r.run_id WHERE r.run_id = $1`,
        [run.runId],
      );
      expect(state).toEqual({
        run: 'FAILED',
        failure_code: 'RESULT_TOO_LARGE',
        attempt: 'FAILED',
        results: 0,
        items: 1,
      });
    } finally {
      await big.world.drop();
    }
  });
});

describe('a late submission, and the race with cancellation', () => {
  async function evaluating() {
    const started = await startedFlow();
    expect((await driveRetrieval(started)).response.status).toBe(204);
    const { runs: planned } = await toEvaluating(started);
    return { started, planned };
  }

  async function ready(started: Flow & Started, claimed: Claimed, runId: string) {
    const prepared = await evaluationDocs(started, claimed, runId);
    prepared.docs.submission.evaluation = {
      status: 'COMPLETED',
      input: await uploadDoc(started, claimed, prepared.docs.input),
      result: await uploadDoc(started, claimed, prepared.docs.result),
      metrics: await uploadDoc(started, claimed, prepared.docs.metrics),
    };
    return prepared.docs.submission;
  }

  it('is rejected and recorded after the lease: LEASE_EXPIRED, then STALE_OWNERSHIP once recovery fenced a new attempt', async () => {
    const { started, planned } = await evaluating();
    try {
      const run = planned[0] as (typeof planned)[number];
      const claimed = await claim(started, run.attemptId);
      const submission = await ready(started, claimed, run.runId);
      // The lease of an evaluation is 600 seconds plus 60.
      started.world.testApp.clock.advanceSeconds(661);
      const late = await submit(started, claimed, 'evaluation-submission', submission);
      expect(late.status).toBe(409);
      expect(await errorCode(late)).toBe('LEASE_EXPIRED');
      expect(await started.world.sql('SELECT 1 FROM results')).toHaveLength(0);
      // Recovery fences the attempt and writes the next one of the same run: now the late host is stale.
      const summary = await runRecovery(started.world.testApp.env, started.world.testApp.database.db, {
        dispatchers: {},
      });
      expect(summary.leasesExpired).toBe(1);
      expect(summary.retried).toBe(1);
      const stale = await submit(started, claimed, 'evaluation-submission', submission);
      expect(stale.status).toBe(409);
      expect(await errorCode(stale)).toBe('STALE_OWNERSHIP');
      const rejected = await started.world.sql('SELECT 1 FROM audit_events WHERE event_type = $1 AND subject = $2', [
        'attempt.late_submission_rejected',
        run.attemptId,
      ]);
      expect(rejected).toHaveLength(2);
      expect(await started.world.sql('SELECT 1 FROM results')).toHaveLength(0);
      const attempts = await started.world.sql<{ ownership_revision: number; status: string }>(
        'SELECT ownership_revision, status FROM attempts WHERE run_id = $1 ORDER BY ownership_revision',
        [run.runId],
      );
      expect(attempts).toEqual([
        { ownership_revision: 1, status: 'LEASE_EXPIRED' },
        { ownership_revision: 2, status: 'PENDING' },
      ]);
    } finally {
      await started.world.drop();
    }
  });

  it('is rejected after cancel_mission, and a result that committed first survives the cancellation', async () => {
    const { started, planned } = await evaluating();
    try {
      const [first, second] = planned as [(typeof planned)[number], (typeof planned)[number]];
      const done = await claim(started, first.attemptId);
      const pending = await claim(started, second.attemptId);
      const submission = await ready(started, pending, second.runId);
      expect((await submitEvaluation(started, done, first.runId)).response.status).toBe(204);
      const [mission] = await started.world.sql<{ revision: number }>(
        'SELECT revision FROM missions WHERE mission_id = $1',
        [started.missionId],
      );
      const cancelled = await started.world.apply(
        'researcher',
        { kind: 'cancel_mission', mission_id: started.missionId, reason: 'The Researcher withdrew the mission.' },
        { expectedRevision: mission?.revision as number },
      );
      expect(cancelled.state).toBe('APPLIED');
      const rejected = await submit(started, pending, 'evaluation-submission', submission);
      expect(rejected.status).toBe(409);
      expect(await errorCode(rejected)).toBe('LEASE_EXPIRED');
      const statuses = await started.world.sql<{ run_id: string; status: string }>(
        'SELECT run_id, status FROM runs WHERE run_id = ANY($1::text[]) ORDER BY run_id',
        [[first.runId, second.runId]],
      );
      expect(Object.fromEntries(statuses.map((row) => [row.run_id, row.status]))).toEqual({
        [first.runId]: 'COMPLETED',
        [second.runId]: 'CANCELLED',
      });
      expect(await started.world.sql('SELECT 1 FROM results')).toHaveLength(1);
    } finally {
      await started.world.drop();
    }
  });

  it('gives one winner when the submission and the cancellation race: either the result commits or the run is cancelled', async () => {
    const { started, planned } = await evaluating();
    try {
      const run = planned[0] as (typeof planned)[number];
      const claimed = await claim(started, run.attemptId);
      const submission = await ready(started, claimed, run.runId);
      const [mission] = await started.world.sql<{ revision: number }>(
        'SELECT revision FROM missions WHERE mission_id = $1',
        [started.missionId],
      );
      const [response, cancel] = await Promise.all([
        submit(started, claimed, 'evaluation-submission', submission),
        started.world.apply(
          'researcher',
          { kind: 'cancel_mission', mission_id: started.missionId, reason: 'A race.' },
          { expectedRevision: mission?.revision as number },
        ),
      ]);
      expect(cancel.state).toBe('APPLIED');
      const [state] = await started.world.sql<{ run: string; attempt: string; results: number }>(
        `SELECT r.status AS run, a.status AS attempt, (SELECT count(*)::int FROM results) AS results
           FROM runs r JOIN attempts a ON a.run_id = r.run_id WHERE r.run_id = $1`,
        [run.runId],
      );
      if (response.status === 204) {
        expect(state).toEqual({ run: 'COMPLETED', attempt: 'COMPLETED', results: 1 });
      } else {
        expect(response.status).toBe(409);
        expect(state).toEqual({ run: 'CANCELLED', attempt: 'CANCELLED', results: 0 });
      }
    } finally {
      await started.world.drop();
    }
  });
});

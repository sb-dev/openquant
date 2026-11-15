// attempts.retrieval-result (OQ-05 sections 4 and 7.1; OQ-02 sections 3.1 and 3.3): the batch host froze the provider
// data as a dataset manifest and the API accepts it only when every binding holds. It records the snapshot, completes
// the job with its coverage, settles the usage with unknown kept explicit, and records the evaluation plan with the
// windows resolved against the calendar of the manifest. A failure is classified and retried only when it is transient.
//
// The synthetic calendar is every weekday from 2022-01-03 to 2025-12-31. Expected windows are derived here by hand from
// the window rules of the pilot policy and that calendar.

import { parseContract } from '@openquant/api-contracts';
import { afterEach, describe, expect, it } from 'vitest';
import {
  bytesOf,
  claim,
  digestOfBytes,
  driveRetrieval,
  errorCode,
  type Flow,
  json,
  manifestFor,
  requestOf,
  retrievalResult,
  type Started,
  sha,
  startedFlow,
  submit,
  upload,
  weekdays,
} from './support/flow.ts';
import type { Doc } from './support/world.ts';

const flows: (Flow & Started)[] = [];
async function fresh(options: Parameters<typeof startedFlow>[0] = {}): Promise<Flow & Started> {
  const flow = await startedFlow(options);
  flows.push(flow);
  return flow;
}
afterEach(async () => {
  for (const flow of flows.splice(0)) await flow.world.drop();
});

const SESSIONS = weekdays('2022-01-03', '2025-12-31');

/** The window of a calendar-date rule by hand: first and last session inside it, 60 sessions of warm-up before. */
function expectedWindow(start: string, end: string) {
  const inside = SESSIONS.filter((session) => session >= start && session <= end);
  const first = inside[0] as string;
  const last = inside.at(-1) as string;
  const firstIndex = SESSIONS.indexOf(first);
  return {
    warmup_start: SESSIONS[firstIndex - 60] as string,
    scored_start: first,
    scored_end: last,
    information_cutoff: `${last}T23:00:00Z`,
    run_sessions: SESSIONS.indexOf(last) - (firstIndex - 60) + 1,
  };
}

describe('a COMPLETE snapshot', () => {
  it('is recorded with its plan: the windows resolve against the calendar of the manifest, and the slots follow the policy', async () => {
    const flow = await fresh();
    const { response, manifestRef } = await driveRetrieval(flow);
    expect(response.status).toBe(204);

    const [job] = await flow.world.sql<{ status: string }>('SELECT status FROM jobs WHERE job_id = $1', [
      flow.retrieve.jobId,
    ]);
    expect(job?.status).toBe('COMPLETED');
    const [attempt] = await flow.world.sql<{ status: string; result_digest: string }>(
      'SELECT status, result_digest FROM attempts WHERE attempt_id = $1',
      [flow.retrieve.attemptId],
    );
    expect(attempt?.status).toBe('COMPLETED');
    expect(attempt?.result_digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    const manifests = await flow.world.sql<{ manifest_digest: string; completeness: string }>(
      'SELECT manifest_digest, completeness FROM dataset_manifests',
    );
    expect(manifests).toEqual([{ manifest_digest: manifestRef.digest, completeness: 'COMPLETE' }]);
    const [retrieval] = await flow.world.sql<{ outcome: string; manifest_digest: string }>(
      'SELECT outcome, manifest_digest FROM retrieval_results',
    );
    expect(retrieval).toEqual({ outcome: 'COMPLETE', manifest_digest: manifestRef.digest });

    // The plan, through the route that serves it unchanged.
    const viewer = await flow.person('viewer');
    const planResponse = await flow.send('GET', `/v1/missions/${flow.missionId}/plan`, viewer);
    expect(planResponse.status).toBe(200);
    const plan = await json<{
      windows: { role: string; rule: unknown; label: string; resolved: unknown; run_sessions: number }[];
      trial_slots: unknown[];
      run_slots: {
        run_slot_id: string;
        trial_slot: string;
        window_role: string;
        cost_scenario: string;
        written_by: string;
        replay_of?: string;
      }[];
      scenarios: unknown;
      calendar: { digest: string };
    }>(planResponse);
    expect(plan.calendar.digest).toBe(manifestRef.digest);
    const windows = {
      DEVELOPMENT: expectedWindow('2023-01-01', '2023-12-31'),
      VALIDATION: expectedWindow('2024-01-01', '2024-12-31'),
      HOLDOUT: expectedWindow('2025-01-01', '2025-12-31'),
    };
    expect(plan.windows.map((window) => window.role)).toEqual(['DEVELOPMENT', 'VALIDATION', 'HOLDOUT']);
    for (const window of plan.windows) {
      const { run_sessions, ...resolved } = windows[window.role as keyof typeof windows];
      expect(window.resolved, window.role).toEqual(resolved);
      expect(window.run_sessions, window.role).toBe(run_sessions);
      expect(window.label).toBe('historical window within model training period');
    }
    // The 2023 window by hand: the first weekday of 2023 is Monday 2 January, the last is Friday 29 December.
    expect(windows.DEVELOPMENT.scored_start).toBe('2023-01-02');
    expect(windows.DEVELOPMENT.scored_end).toBe('2023-12-29');
    expect(plan.trial_slots).toEqual([
      { slot_id: 'seed', kind: 'seed', strategy_id: 'daily-swing-seed', draft_digest: flow.world.records.seedDigest },
      { slot_id: 'rev-a', kind: 'revision', configuration_id: 'proposer-a', parent_slot: 'seed' },
      { slot_id: 'rev-b', kind: 'revision', configuration_id: 'proposer-b', parent_slot: 'seed' },
    ]);
    // 3 candidates x (3 windows x 2 cost cases + 1 repeat of the development base run) = 21 planned runs.
    expect(plan.run_slots).toHaveLength(21);
    const ofSeed = plan.run_slots.filter((slot) => slot.trial_slot === 'seed');
    expect(ofSeed.map((slot) => slot.run_slot_id).sort()).toEqual(
      [
        'seed.d.base',
        'seed.d.base.repeat',
        'seed.d.stress',
        'seed.h.base',
        'seed.h.stress',
        'seed.v.base',
        'seed.v.stress',
      ].sort(),
    );
    expect(ofSeed.filter((slot) => slot.written_by === 'FREEZE_CANDIDATES').map((slot) => slot.window_role)).toEqual([
      'HOLDOUT',
      'HOLDOUT',
    ]);
    expect(ofSeed.find((slot) => slot.run_slot_id === 'seed.d.base.repeat')?.replay_of).toBe('seed.d.base');
    expect(plan.scenarios).toEqual({
      cost_cases: [
        { cost_scenario: 'BASE', multiplier: '1' },
        { cost_scenario: 'COST_STRESS', multiplier: '2' },
      ],
      deterministic_repeat: { window_role: 'DEVELOPMENT', cost_scenario: 'BASE' },
    });
    const rows = await flow.world.sql<{ slots: number; runs: number; d_start: string; h_end: string }>(
      `SELECT (SELECT count(*) FROM trial_slots)::int AS slots, (SELECT count(*) FROM run_slots)::int AS runs,
              to_char(d_start, 'YYYY-MM-DD') AS d_start, to_char(h_end, 'YYYY-MM-DD') AS h_end FROM evaluation_plans`,
    );
    expect(rows).toEqual([{ slots: 3, runs: 21, d_start: '2023-01-02', h_end: '2025-12-31' }]);
    const [mission] = await flow.world.sql<{ status: string; revision: number }>(
      'SELECT status, revision FROM missions WHERE mission_id = $1',
      [flow.missionId],
    );
    expect(mission?.status).toBe('IN_PROGRESS');
  });

  it('settles the reservation with what the host reported: the unused part returns, and an unknown value stays reserved', async () => {
    const flow = await fresh();
    await driveRetrieval(flow);
    const lines = await flow.world.sql<{ dimension: string; reserved: string; used: string; usage_label: string }>(
      `SELECT p.dimension, l.reserved::text AS reserved, l.used::text AS used, l.usage_label
         FROM reservation_lines l JOIN budget_pools p ON p.pool_id = l.pool_id WHERE l.attempt_id = $1 ORDER BY p.dimension`,
      [flow.retrieve.attemptId],
    );
    // 60 provider requests over an attempt cap of 3 reserve 20; the host used 2. 600 seconds were reserved, and 4120 ms
    // round up to 5. The unused part returns to the pools.
    expect(lines).toEqual([
      { dimension: 'BATCH_COMPUTE_SECONDS', reserved: '600.00000000', used: '5.00000000', usage_label: 'observed' },
      { dimension: 'PROVIDER_REQUESTS', reserved: '20.00000000', used: '2.00000000', usage_label: 'observed' },
    ]);
    const pools = await flow.world.sql<{ dimension: string; committed: string }>(
      `SELECT dimension, committed::text FROM budget_pools WHERE scope = 'MISSION' AND mission_id = $1 AND dimension IN ('PROVIDER_REQUESTS', 'BATCH_COMPUTE_SECONDS') ORDER BY dimension`,
      [flow.missionId],
    );
    expect(pools).toEqual([
      { dimension: 'BATCH_COMPUTE_SECONDS', committed: '5.00000000' },
      { dimension: 'PROVIDER_REQUESTS', committed: '2.00000000' },
    ]);
  });

  it('keeps an unreported value reserved and the reservation UNRECONCILED: unknown usage is never zero', async () => {
    const flow = await fresh();
    await driveRetrieval(flow, {
      resultEdit: (result) => {
        result.usage.provider_requests = { label: 'unknown', reason: 'The provider did not report its request count.' };
      },
    });
    const lines = await flow.world.sql<{ dimension: string; used: string | null; usage_label: string }>(
      `SELECT p.dimension, l.used::text AS used, l.usage_label FROM reservation_lines l JOIN budget_pools p ON p.pool_id = l.pool_id WHERE l.attempt_id = $1 ORDER BY p.dimension`,
      [flow.retrieve.attemptId],
    );
    expect(lines).toEqual([
      { dimension: 'BATCH_COMPUTE_SECONDS', used: '5.00000000', usage_label: 'observed' },
      { dimension: 'PROVIDER_REQUESTS', used: null, usage_label: 'unknown' },
    ]);
    const [reservation] = await flow.world.sql<{ status: string }>(
      'SELECT status FROM reservations WHERE attempt_id = $1',
      [flow.retrieve.attemptId],
    );
    expect(reservation?.status).toBe('UNRECONCILED');
    const [pool] = await flow.world.sql<{ committed: string }>(
      `SELECT committed::text FROM budget_pools WHERE scope = 'MISSION' AND mission_id = $1 AND dimension = 'PROVIDER_REQUESTS'`,
      [flow.missionId],
    );
    // The full reservation of 20 counts as spent until a report settles it.
    expect(pool?.committed).toBe('20.00000000');
  });

  it('answers a redelivery with the stored outcome and a different document for the same attempt with a refusal', async () => {
    const flow = await fresh();
    const { claimed, manifestRef } = await driveRetrieval(flow);
    const request = await requestOf(flow, flow.retrieve.attemptId);
    const same = retrievalResult(claimed, flow.retrieve.jobId, request.digest, {
      status: 'COMPLETE',
      manifest: manifestRef,
    });
    // The same submission, as a redelivered message makes it: one capability, one result, nothing new written.
    const before = await flow.world.snapshot();
    const again = await submit(flow, claimed, 'retrieval-result', same);
    expect(again.status).toBe(204);
    expect(await flow.world.snapshot()).toEqual(before);
    const other = retrievalResult(
      claimed,
      flow.retrieve.jobId,
      request.digest,
      { status: 'COMPLETE', manifest: manifestRef },
      (result) => {
        result.usage.duration = { label: 'observed', milliseconds: 9999 };
      },
    );
    const refused = await submit(flow, claimed, 'retrieval-result', other);
    expect(refused.status).toBe(422);
    expect(await errorCode(refused)).toBe('IDENTITY_MISMATCH');
    const manifests = await flow.world.sql('SELECT 1 FROM dataset_manifests');
    expect(manifests).toHaveLength(1);
  });
});

describe('a snapshot that does not bind to its request', () => {
  it('is refused with IDENTITY_MISMATCH for each binding, leaves the attempt claimed and records the refusal', async () => {
    const flow = await fresh();
    const { jobId, attemptId } = flow.retrieve;
    const claimed = await claim(flow, attemptId);
    const request = await requestOf(flow, attemptId);
    const base = { jobId, attemptId, requestDigest: request.digest };
    const cases: [string, Partial<Parameters<typeof manifestFor>[1]>][] = [
      ['a manifest of another attempt', { attemptId: 'att-another' }],
      ['a manifest of another job', { jobId: 'job-another' }],
      ['a manifest that answers another request', { requestDigest: sha('another request') }],
      ['another instrument', { edit: (manifest) => (manifest.instrument.symbol = 'MSFT') }],
      ['another profile revision', { edit: (manifest) => (manifest.source.profile.digest = sha('another profile')) }],
      [
        'another executable inside the manifest',
        { edit: (manifest) => (manifest.source.executable.digest = sha('another binary')) },
      ],
      ['other data semantics', { edit: (manifest) => (manifest.semantics.minimum_end_age_minutes = 30) }],
      ['another requested range', { edit: (manifest) => (manifest.coverage.requested.end = '2025-06-30') }],
      [
        'a bar whose availability is not the session close plus the delay',
        {
          edit: (manifest) =>
            (manifest.content.bars[10].available_at = `${manifest.content.bars[10].session}T22:00:00Z`),
        },
      ],
      ['a status that the coverage does not repeat', { completeness: 'PARTIAL', missing: [] }],
    ];
    const before = await flow.world.snapshot(['audit_events', 'artefacts']);
    for (const [label, options] of cases) {
      const manifest = manifestFor(flow, { ...base, ...options });
      const ref = await upload(flow, claimed, bytesOf(manifest));
      // The result states COMPLETE; the last case claims a manifest whose coverage says PARTIAL.
      const result = retrievalResult(claimed, jobId, request.digest, { status: 'COMPLETE', manifest: ref });
      expect(parseContract('retrieval-result', JSON.stringify(result)).ok, `${label}: the result is schema-valid`).toBe(
        true,
      );
      const response = await submit(flow, claimed, 'retrieval-result', result);
      expect(response.status, label).toBe(422);
      expect(await errorCode(response), label).toBe('IDENTITY_MISMATCH');
    }
    expect(await flow.world.snapshot(['audit_events', 'artefacts'])).toEqual(before);
    const refusals = await flow.world.sql('SELECT 1 FROM audit_events WHERE event_type = $1 AND subject = $2', [
      'attempt.submission_refused',
      attemptId,
    ]);
    expect(refusals).toHaveLength(cases.length);
    const [attempt] = await flow.world.sql<{ status: string }>('SELECT status FROM attempts WHERE attempt_id = $1', [
      attemptId,
    ]);
    expect(attempt?.status).toBe('CLAIMED');
  });

  it('is refused when it names another job, another request or another executable than the attempt has', async () => {
    const flow = await fresh();
    const { jobId, attemptId } = flow.retrieve;
    const claimed = await claim(flow, attemptId);
    const request = await requestOf(flow, attemptId);
    const ref = await upload(
      flow,
      claimed,
      bytesOf(manifestFor(flow, { jobId, attemptId, requestDigest: request.digest })),
    );
    const outcome = { status: 'COMPLETE', manifest: ref };
    for (const [label, edit] of [
      ['another job', (result: Doc) => (result.job_id = 'job-other')],
      ['another request digest', (result: Doc) => (result.request_digest = sha('other'))],
      ['another executable', (result: Doc) => (result.executable = { ...result.executable, version: '9.9.9' })],
    ] as const) {
      const response = await submit(
        flow,
        claimed,
        'retrieval-result',
        retrievalResult(claimed, jobId, request.digest, outcome, edit),
      );
      expect(response.status, label).toBe(422);
      expect(await errorCode(response), label).toBe('IDENTITY_MISMATCH');
    }
  });

  it('is refused when the manifest was never uploaded, or is cited with another size', async () => {
    const flow = await fresh();
    const { jobId, attemptId } = flow.retrieve;
    const claimed = await claim(flow, attemptId);
    const request = await requestOf(flow, attemptId);
    const manifest = bytesOf(manifestFor(flow, { jobId, attemptId, requestDigest: request.digest }));
    const notUploaded = {
      digest: digestOfBytes(manifest),
      media_type: 'application/json',
      size_bytes: manifest.length,
    };
    const missing = await submit(
      flow,
      claimed,
      'retrieval-result',
      retrievalResult(claimed, jobId, request.digest, { status: 'COMPLETE', manifest: notUploaded }),
    );
    expect(missing.status).toBe(422);
    expect(await errorCode(missing)).toBe('IDENTITY_MISMATCH');
    const uploaded = await upload(flow, claimed, manifest);
    const wrongSize = await submit(
      flow,
      claimed,
      'retrieval-result',
      retrievalResult(claimed, jobId, request.digest, {
        status: 'COMPLETE',
        manifest: { ...uploaded, size_bytes: uploaded.size_bytes + 1 },
      }),
    );
    expect(wrongSize.status).toBe(422);
  });
});

describe('a snapshot that cannot give the mission its plan', () => {
  it('blocks the mission with the reason, and opens an attention item, when a bar that a run needs is missing (PARTIAL)', async () => {
    const flow = await fresh();
    // The calendar has no holidays, so the first scored session of the 2024 validation window is Monday 2024-01-01: the
    // bar that a run of that window needs is missing.
    const gone = '2024-01-01';
    const { response } = await driveRetrieval(flow, { manifest: { missing: [gone] } });
    expect(response.status).toBe(204);
    const [job] = await flow.world.sql<{ status: string }>('SELECT status FROM jobs WHERE job_id = $1', [
      flow.retrieve.jobId,
    ]);
    expect(job?.status).toBe('COMPLETED');
    const [mission] = await flow.world.sql<{ status: string; blocked_reason: string }>(
      'SELECT status, blocked_reason FROM missions WHERE mission_id = $1',
      [flow.missionId],
    );
    expect(mission?.status).toBe('BLOCKED');
    expect(mission?.blocked_reason).toContain(gone);
    expect(await flow.world.sql('SELECT 1 FROM evaluation_plans')).toHaveLength(0);
    // The snapshot is recorded, with its coverage: it is evidence even though no run can use it.
    const manifests = await flow.world.sql<{ completeness: string }>('SELECT completeness FROM dataset_manifests');
    expect(manifests).toEqual([{ completeness: 'PARTIAL' }]);
    const items = await flow.world.sql<{ status: string; reason: string }>(
      'SELECT status, reason FROM attention_items WHERE mission_id = $1',
      [flow.missionId],
    );
    expect(items).toHaveLength(1);
    expect(items[0]?.status).toBe('OPEN');
  });

  it('records the plan when the missing sessions are not in any run (PARTIAL outside the windows)', async () => {
    const flow = await fresh();
    // The earliest warm-up starts in October 2022: the first days of the history are in no run.
    const { response } = await driveRetrieval(flow, { manifest: { missing: ['2022-01-03', '2022-01-04'] } });
    expect(response.status).toBe(204);
    const [mission] = await flow.world.sql<{ status: string }>('SELECT status FROM missions WHERE mission_id = $1', [
      flow.missionId,
    ]);
    expect(mission?.status).toBe('IN_PROGRESS');
    expect(await flow.world.sql('SELECT 1 FROM evaluation_plans')).toHaveLength(1);
    const [manifest] = await flow.world.sql<{ completeness: string }>('SELECT completeness FROM dataset_manifests');
    expect(manifest?.completeness).toBe('PARTIAL');
  });

  it('blocks the mission when there are no observations, and when the calendar is too short for the warm-up', async () => {
    const none = await fresh();
    expect((await driveRetrieval(none, { manifest: { completeness: 'NO_OBSERVATIONS' } })).response.status).toBe(204);
    const [blocked] = await none.world.sql<{ status: string; blocked_reason: string }>(
      'SELECT status, blocked_reason FROM missions WHERE mission_id = $1',
      [none.missionId],
    );
    expect(blocked?.status).toBe('BLOCKED');
    expect(blocked?.blocked_reason).toContain('no observations');

    const short = await fresh();
    const { response } = await driveRetrieval(short, {
      manifest: {
        edit: (manifest) => {
          // A calendar that starts in December 2022 leaves fewer than 60 sessions before the first window.
          manifest.content.calendar = manifest.content.calendar.filter(
            (entry: { session: string }) => entry.session >= '2022-12-01',
          );
          manifest.content.bars = manifest.content.bars.filter(
            (bar: { session: string }) => bar.session >= '2022-12-01',
          );
        },
      },
    });
    expect(response.status).toBe(204);
    const [mission] = await short.world.sql<{ status: string; blocked_reason: string }>(
      'SELECT status, blocked_reason FROM missions WHERE mission_id = $1',
      [short.missionId],
    );
    expect(mission?.status).toBe('BLOCKED');
    expect(mission?.blocked_reason).toContain('warm-up');
    expect(await short.world.sql('SELECT 1 FROM evaluation_plans')).toHaveLength(0);
  });
});

describe('a retrieval that failed', () => {
  async function failWith(flow: Flow & Started, attemptId: string, outcome: Record<string, unknown>) {
    const claimed = await claim(flow, attemptId);
    const request = await requestOf(flow, attemptId);
    const response = await submit(
      flow,
      claimed,
      'retrieval-result',
      retrievalResult(claimed, flow.retrieve.jobId, request.digest, outcome),
    );
    return { claimed, response };
  }
  const attemptsOf = (flow: Flow & Started) =>
    flow.world.sql<{ attempt_id: string; ownership_revision: number; status: string; failure_code: string | null }>(
      'SELECT attempt_id, ownership_revision, status, failure_code FROM attempts WHERE job_id = $1 ORDER BY ownership_revision',
      [flow.retrieve.jobId],
    );

  it('retries a transient class with a new attempt of the same job, up to the cap, then fails the job and blocks the mission', async () => {
    const flow = await fresh();
    const transient = {
      status: 'FAILED',
      error: 'RATE_LIMITED',
      retryable: true,
      retry_after_seconds: 30,
      detail: 'The provider asked to wait.',
    };
    let current = flow.retrieve.attemptId;
    for (const revision of [1, 2]) {
      const { response } = await failWith(flow, current, transient);
      expect(response.status, `attempt ${revision}`).toBe(204);
      const attempts = await attemptsOf(flow);
      expect(attempts.at(-1)).toMatchObject({ ownership_revision: revision + 1, status: 'PENDING' });
      current = attempts.at(-1)?.attempt_id as string;
      const [job] = await flow.world.sql<{ status: string }>('SELECT status FROM jobs WHERE job_id = $1', [
        flow.retrieve.jobId,
      ]);
      expect(job?.status, `after attempt ${revision}`).toBe('QUEUED');
    }
    const { response } = await failWith(flow, current, transient);
    expect(response.status).toBe(204);
    // The attempt cap is 3: the third failure ends the job.
    expect(await attemptsOf(flow)).toMatchObject([
      { ownership_revision: 1, status: 'FAILED', failure_code: 'RETRIEVAL_RATE_LIMITED' },
      { ownership_revision: 2, status: 'FAILED' },
      { ownership_revision: 3, status: 'FAILED' },
    ]);
    const [job] = await flow.world.sql<{ status: string; failure_code: string }>(
      'SELECT status, failure_code FROM jobs WHERE job_id = $1',
      [flow.retrieve.jobId],
    );
    expect(job).toEqual({ status: 'FAILED', failure_code: 'RETRIEVAL_RATE_LIMITED' });
    const [mission] = await flow.world.sql<{ status: string; blocked_reason: string }>(
      'SELECT status, blocked_reason FROM missions WHERE mission_id = $1',
      [flow.missionId],
    );
    expect(mission?.status).toBe('BLOCKED');
    expect(mission?.blocked_reason).toContain('RATE_LIMITED');
    const recorded = await flow.world.sql<{ outcome: string; error_class: string; retryable: boolean }>(
      'SELECT outcome, error_class, retryable FROM retrieval_results',
    );
    expect(recorded).toEqual([{ outcome: 'FAILED', error_class: 'RATE_LIMITED', retryable: true }]);
    expect(await flow.world.sql('SELECT 1 FROM attention_items WHERE mission_id = $1', [flow.missionId])).toHaveLength(
      1,
    );
  });

  it('never retries authentication, permission, unsupported capability, cancellation or an egress refusal', async () => {
    for (const error of ['AUTHENTICATION', 'PERMISSION', 'UNSUPPORTED_CAPABILITY', 'CANCELLED', 'EGRESS_REFUSED']) {
      const flow = await fresh();
      const { response } = await failWith(flow, flow.retrieve.attemptId, {
        status: 'FAILED',
        error,
        retryable: false,
        detail: 'refused',
      });
      expect(response.status, error).toBe(204);
      expect(await attemptsOf(flow), error).toHaveLength(1);
      const [job] = await flow.world.sql<{ status: string; failure_code: string }>(
        'SELECT status, failure_code FROM jobs WHERE job_id = $1',
        [flow.retrieve.jobId],
      );
      expect(job, error).toEqual({ status: 'FAILED', failure_code: `RETRIEVAL_${error}` });
      const [mission] = await flow.world.sql<{ status: string }>('SELECT status FROM missions WHERE mission_id = $1', [
        flow.missionId,
      ]);
      expect(mission?.status, error).toBe('BLOCKED');
    }
  });

  it('refuses a result that marks a never-retried class as retryable: the contract rejects it', async () => {
    const flow = await fresh();
    const { response } = await failWith(flow, flow.retrieve.attemptId, {
      status: 'FAILED',
      error: 'EGRESS_REFUSED',
      retryable: true,
      detail: 'x',
    });
    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe('SCHEMA_VIOLATION');
  });

  it('leaves the job QUEUED with no live attempt, and the mission BLOCKED, when no budget covers the retry', async () => {
    // A mission may make 3 provider requests: an attempt reserves 1 (3 over an attempt cap of 3). The host reports 3.
    // The usage above the reservation is an overrun, which blocks further reservations (OQ-05 section 4).
    const flow = await fresh({
      mission: (mission) => {
        mission.budget.provider_requests = 3;
      },
    });
    const transient = { status: 'FAILED', error: 'TIMEOUT', retryable: true, detail: 'The provider did not answer.' };
    const claimed = await claim(flow, flow.retrieve.attemptId);
    const request = await requestOf(flow, flow.retrieve.attemptId);
    const result = retrievalResult(claimed, flow.retrieve.jobId, request.digest, transient, (doc) => {
      doc.usage.provider_requests = { label: 'observed', count: 3 };
    });
    expect((await submit(flow, claimed, 'retrieval-result', result)).status).toBe(204);
    const attempts = await attemptsOf(flow);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.status).toBe('FAILED');
    const [job] = await flow.world.sql<{ status: string; waiting_reason: string }>(
      'SELECT status, waiting_reason FROM jobs WHERE job_id = $1',
      [flow.retrieve.jobId],
    );
    expect(job?.status).toBe('QUEUED');
    expect(job?.waiting_reason).toContain('waits for budget');
    const [mission] = await flow.world.sql<{ status: string; blocked_reason: string }>(
      'SELECT status, blocked_reason FROM missions WHERE mission_id = $1',
      [flow.missionId],
    );
    expect(mission?.status).toBe('BLOCKED');
    expect(mission?.blocked_reason).toContain('PROVIDER_REQUESTS');
    const [pool] = await flow.world.sql<{ overrun: string }>(
      `SELECT overrun::text FROM budget_pools WHERE scope = 'MISSION' AND mission_id = $1 AND dimension = 'PROVIDER_REQUESTS'`,
      [flow.missionId],
    );
    // 3 used against a reservation of 1: the overrun is 2.
    expect(pool?.overrun).toBe('2.00000000');
  });
});

describe('a late retrieval result', () => {
  it('is rejected with LEASE_EXPIRED once the lease ended, recorded in the audit log, and changes nothing', async () => {
    const flow = await fresh();
    const { jobId, attemptId } = flow.retrieve;
    const claimed = await claim(flow, attemptId);
    const request = await requestOf(flow, attemptId);
    const ref = await upload(
      flow,
      claimed,
      bytesOf(manifestFor(flow, { jobId, attemptId, requestDigest: request.digest })),
    );
    // The pilot lease for a retrieval is 600 seconds plus 60: the host is late.
    flow.world.testApp.clock.advanceSeconds(661);
    const before = await flow.world.snapshot(['audit_events']);
    const response = await submit(
      flow,
      claimed,
      'retrieval-result',
      retrievalResult(claimed, jobId, request.digest, { status: 'COMPLETE', manifest: ref }),
    );
    expect(response.status).toBe(409);
    expect(await errorCode(response)).toBe('LEASE_EXPIRED');
    expect(await flow.world.snapshot(['audit_events'])).toEqual(before);
    const audit = await flow.world.sql<{ detail: { code: string } }>(
      'SELECT detail FROM audit_events WHERE event_type = $1 AND subject = $2',
      ['attempt.late_submission_rejected', attemptId],
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]?.detail.code).toBe('LEASE_EXPIRED');
    expect(await flow.world.sql('SELECT 1 FROM dataset_manifests')).toHaveLength(0);
  });
});

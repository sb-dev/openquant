// attempts.claim (OQ-05 section 4, "Attempt PENDING: Claim with attempt-claim/1"): a host claims its attempt through the
// guarded API before it executes anything. The claim takes a lease for the attempt timeout of the cohort policy plus a
// grace and returns a capability that is valid for this attempt and lasts as long as the lease. Requests go through the
// real Hono app on a real database.

import { parseContract } from '@openquant/api-contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp } from './support/app.ts';
import {
  cancelMissionPayload,
  claim,
  claimRequest,
  driveRetrieval,
  ENGINE_BATCH,
  errorCode,
  type Flow,
  json,
  outboxOf,
  type Started,
  sha,
  startedFlow,
  startValidationOf,
} from './support/flow.ts';

let flow: Flow & Started;
const ATTEMPT_PATH = (attemptId: string) => `/v1/attempts/${attemptId}/claim`;

beforeAll(async () => {
  flow = await startedFlow();
});
afterAll(async () => {
  await flow.world.drop();
});

describe('a claim that is refused', () => {
  it('changes nothing: the credential, the host, the executable, the dispatch digest, the revision and the path are all checked', async () => {
    const { attemptId } = flow.retrieve;
    const outbox = await outboxOf(flow, attemptId);
    const good = claimRequest(attemptId, outbox.revision, outbox.digest);
    // The exchange of a person's credential writes its own audit row, so it happens before the snapshot.
    const researcher = await flow.person('researcher');
    const before = await flow.world.snapshot();
    const refused: [string, Response, number, string][] = [
      ['no credential', await flow.send('POST', ATTEMPT_PATH(attemptId), undefined, good), 401, 'UNAUTHENTICATED'],
      ['a person', await flow.send('POST', ATTEMPT_PATH(attemptId), researcher, good), 403, 'FORBIDDEN'],
      [
        'the deploy credential',
        await flow.send('POST', ATTEMPT_PATH(attemptId), flow.service('deploy'), good),
        403,
        'FORBIDDEN',
      ],
      // The runner is not the host of batch work: a credential that may claim attempts claims only its own.
      [
        'the runner for batch work',
        await flow.send('POST', ATTEMPT_PATH(attemptId), flow.service('runner'), good),
        403,
        'FORBIDDEN',
      ],
      [
        'an executable that the release does not list',
        await flow.send(
          'POST',
          ATTEMPT_PATH(attemptId),
          flow.service('batch'),
          claimRequest(attemptId, outbox.revision, outbox.digest, { ...ENGINE_BATCH, digest: sha('another binary') }),
        ),
        422,
        'IDENTITY_MISMATCH',
      ],
      [
        'the digest of another message',
        await flow.send(
          'POST',
          ATTEMPT_PATH(attemptId),
          flow.service('batch'),
          claimRequest(attemptId, outbox.revision, sha('another message')),
        ),
        422,
        'IDENTITY_MISMATCH',
      ],
      [
        'another ownership revision',
        await flow.send(
          'POST',
          ATTEMPT_PATH(attemptId),
          flow.service('batch'),
          claimRequest(attemptId, outbox.revision + 1, outbox.digest),
        ),
        409,
        'STALE_OWNERSHIP',
      ],
      [
        'the attempt of another path',
        await flow.send('POST', ATTEMPT_PATH('att-elsewhere'), flow.service('batch'), good),
        400,
        'SCHEMA_VIOLATION',
      ],
      [
        'an attempt that does not exist',
        await flow.send(
          'POST',
          ATTEMPT_PATH('att-none'),
          flow.service('batch'),
          claimRequest('att-none', 1, outbox.digest),
        ),
        404,
        'NOT_FOUND',
      ],
    ];
    for (const [label, response, status, code] of refused) {
      expect(response.status, label).toBe(status);
      expect(await errorCode(response), label).toBe(code);
    }
    expect(await flow.world.snapshot()).toEqual(before);
    const [attempt] = await flow.world.sql<{ status: string }>('SELECT status FROM attempts WHERE attempt_id = $1', [
      attemptId,
    ]);
    expect(attempt?.status).toBe('PENDING');
  });
});

describe('a claim that is granted', () => {
  it('takes a lease of the policy timeout plus the grace, and returns a capability that expires with it', async () => {
    const { attemptId, jobId } = flow.retrieve;
    const outbox = await outboxOf(flow, attemptId);
    const response = await flow.send(
      'POST',
      ATTEMPT_PATH(attemptId),
      flow.service('batch'),
      claimRequest(attemptId, outbox.revision, outbox.digest),
    );
    expect(response.status).toBe(200);
    const text = await response.text();
    const parsed = parseContract('attempt-claim', text);
    expect(parsed.ok).toBe(true);
    const grant = JSON.parse(text) as {
      form: string;
      granted_at: string;
      lease_expires_at: string;
      capability: { token: string };
      attempt: unknown;
    };
    expect(grant.form).toBe('grant');
    expect(grant.attempt).toEqual({ attempt_id: attemptId, ownership_revision: 1 });
    // The test clock starts at 2026-11-15T10:00:00Z. The pilot policy gives a retrieval 600 seconds, and the lease adds 60.
    expect(grant.granted_at).toBe('2026-11-15T10:00:00Z');
    expect(grant.lease_expires_at).toBe('2026-11-15T10:11:00Z');
    expect(grant.capability.token).toMatch(/^[A-Za-z0-9._~-]{32,512}$/);

    const [attempt] = await flow.world.sql<Record<string, unknown>>(
      'SELECT status, worker_id, executable_name, executable_digest, dispatch_digest FROM attempts WHERE attempt_id = $1',
      [attemptId],
    );
    expect(attempt).toMatchObject({
      status: 'CLAIMED',
      worker_id: 'worker-1',
      executable_name: 'engine-batch',
      executable_digest: ENGINE_BATCH.digest,
      dispatch_digest: outbox.digest,
    });
    const [lease] = await flow.world.sql<{ status: string; expires_at: Date }>(
      'SELECT status, expires_at FROM leases WHERE attempt_id = $1',
      [attemptId],
    );
    expect(lease?.status).toBe('HELD');
    expect(lease?.expires_at.toISOString()).toBe('2026-11-15T10:11:00.000Z');
    const [job] = await flow.world.sql<{ status: string }>('SELECT status FROM jobs WHERE job_id = $1', [jobId]);
    expect(job?.status).toBe('RUNNING');
    const audit = await flow.world.sql('SELECT 1 FROM audit_events WHERE event_type = $1 AND subject = $2', [
      'attempt.claimed',
      attemptId,
    ]);
    expect(audit).toHaveLength(1);

    // Only the hash of the capability is stored: no table holds the token.
    const tables = await flow.world.sql<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public'`,
    );
    for (const { tablename } of tables) {
      const hits = await flow.world.sql(`SELECT 1 FROM ${tablename} t WHERE t::text LIKE '%' || $1 || '%' LIMIT 1`, [
        grant.capability.token,
      ]);
      expect(hits, `the token is stored in ${tablename}`).toEqual([]);
    }
  });

  it('refuses a second claim of the same attempt, and the same host cannot claim it again', async () => {
    const { attemptId } = flow.retrieve;
    const outbox = await outboxOf(flow, attemptId);
    const again = await flow.send(
      'POST',
      ATTEMPT_PATH(attemptId),
      flow.service('batch'),
      claimRequest(attemptId, outbox.revision, outbox.digest),
    );
    expect(again.status).toBe(409);
    expect(await errorCode(again)).toBe('ATTEMPT_NOT_CLAIMABLE');
  });
});

describe('a claim in a deployment with research execution off', () => {
  it('is refused with EXECUTION_DISABLED, and nothing is read or written', async () => {
    const started = await startedFlow();
    try {
      const off = await createTestApp({
        database: started.world.testApp.database,
        researchExecution: false,
        signingKey: started.world.testApp.env.secrets.tokenSigningKey,
      });
      const { attemptId } = started.retrieve;
      const outbox = await outboxOf(started, attemptId);
      const before = await started.world.snapshot();
      const response = await off.request(ATTEMPT_PATH(attemptId), {
        method: 'POST',
        headers: { authorization: `Bearer ${started.service('batch')}` },
        body: JSON.stringify(claimRequest(attemptId, outbox.revision, outbox.digest)),
      });
      expect(response.status).toBe(409);
      expect(await errorCode(response)).toBe('EXECUTION_DISABLED');
      expect(await started.world.snapshot()).toEqual(before);
    } finally {
      await started.world.drop();
    }
  });
});

describe('a claim of work that was cancelled', () => {
  it('is refused with ATTEMPT_NOT_CLAIMABLE: cancel_mission cancelled the attempt before it was claimed', async () => {
    const started = await startedFlow();
    try {
      const mission = await started.world.sql<{ revision: number }>(
        'SELECT revision FROM missions WHERE mission_id = $1',
        [started.missionId],
      );
      const cancelled = await started.world.apply('researcher', cancelMissionPayload(started.missionId), {
        expectedRevision: mission[0]?.revision as number,
      });
      expect(cancelled.state).toBe('APPLIED');
      const outbox = await outboxOf(started, started.retrieve.attemptId);
      const response = await started.send(
        'POST',
        ATTEMPT_PATH(started.retrieve.attemptId),
        started.service('batch'),
        claimRequest(started.retrieve.attemptId, outbox.revision, outbox.digest),
      );
      expect(response.status).toBe(409);
      expect(await errorCode(response)).toBe('ATTEMPT_NOT_CLAIMABLE');
    } finally {
      await started.world.drop();
    }
  });
});

describe('the concurrency limit of the cohort policy', () => {
  it('refuses a claim beyond the limit with RATE_LIMITED, which is safe to repeat, and grants it once an attempt has ended', async () => {
    const limited = await startedFlow({
      policy: (policy) => {
        policy.limits.concurrent_batch_attempts = 1;
      },
    });
    try {
      // The retrieval ends, so the plan exists and validations can start.
      const retrieval = await driveRetrieval(limited);
      expect(retrieval.response.status).toBe(204);
      const first = await startValidationOf(limited, {
        trialSlot: 'seed',
        draftDigest: limited.world.records.seedDigest,
      });
      const second = await startValidationOf(limited, {
        trialSlot: 'seed',
        draftDigest: limited.world.records.seedDigest,
      });
      await claim(limited, first.attemptId);
      const outbox = await outboxOf(limited, second.attemptId);
      const refused = await limited.send(
        'POST',
        ATTEMPT_PATH(second.attemptId),
        limited.service('batch'),
        claimRequest(second.attemptId, outbox.revision, outbox.digest),
      );
      expect(refused.status).toBe(429);
      const body = await json<{ code: string; retry_safe: boolean; state_changed: string }>(refused);
      expect(body).toMatchObject({ code: 'RATE_LIMITED', retry_safe: true, state_changed: 'NONE' });
      const [attempt] = await limited.world.sql<{ status: string }>(
        'SELECT status FROM attempts WHERE attempt_id = $1',
        [second.attemptId],
      );
      expect(attempt?.status).toBe('PENDING');
      // An attempt that cannot be claimed is told why even when the mission is at its limit: "try later" would make its
      // host retry for ever. The first attempt is claimed already, and the second is claimed with a revision it lacks.
      const firstOutbox = await outboxOf(limited, first.attemptId);
      const again = await limited.send(
        'POST',
        ATTEMPT_PATH(first.attemptId),
        limited.service('batch'),
        claimRequest(first.attemptId, firstOutbox.revision, firstOutbox.digest),
      );
      expect(again.status).toBe(409);
      expect((await json<{ code: string }>(again)).code).toBe('ATTEMPT_NOT_CLAIMABLE');
      const stale = await limited.send(
        'POST',
        ATTEMPT_PATH(second.attemptId),
        limited.service('batch'),
        claimRequest(second.attemptId, outbox.revision + 1, outbox.digest),
      );
      expect(stale.status).toBe(409);
      expect((await json<{ code: string }>(stale)).code).toBe('STALE_OWNERSHIP');
      // The lease of the first attempt ends: the limit counts leases that are held.
      limited.world.testApp.clock.advanceSeconds(300 + 60 + 1);
      const granted = await claim(limited, second.attemptId);
      expect(granted.attemptId).toBe(second.attemptId);
    } finally {
      await limited.world.drop();
    }
  });
});

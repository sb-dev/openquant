// attempts.input and attempts.artefact (OQ-05 section 5, decision D13): a Fly host holds no storage credential. It reads
// the inputs that its dispatch names through an attempt-scoped route, and uploads its artefacts through another, where the
// Worker verifies the content hash and writes the content-addressed key. The capability expires with the lease.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  bytesOf,
  type Claimed,
  claim,
  digestOfBytes,
  errorCode,
  type Flow,
  outboxOf,
  requestOf,
  type Started,
  sha,
  startedFlow,
  upload,
} from './support/flow.ts';

let flow: Flow & Started;
let claimed: Claimed;
let requestDigest: string;

beforeAll(async () => {
  flow = await startedFlow();
  claimed = await claim(flow, flow.retrieve.attemptId);
  requestDigest = (await requestOf(flow, flow.retrieve.attemptId)).digest;
});
afterAll(async () => {
  await flow.world.drop();
});

const inputPath = (attemptId: string, digest: string) => `/v1/attempts/${attemptId}/inputs/${digest}`;
const artefactPath = (attemptId: string, digest: string) => `/v1/attempts/${attemptId}/artefacts/${digest}`;

describe('attempts.input', () => {
  it('serves the artefact that the dispatch message names, unchanged, with its media type and digest', async () => {
    const response = await flow.send('GET', inputPath(claimed.attemptId, requestDigest), claimed.token);
    expect(response.status).toBe(200);
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(digestOfBytes(bytes)).toBe(requestDigest);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(response.headers.get('x-content-digest')).toBe(requestDigest);
    expect(JSON.parse(new TextDecoder().decode(bytes))).toMatchObject({
      schema_version: 'retrieval-request/1',
      job_id: flow.retrieve.jobId,
    });
  });

  it('answers NOT_FOUND for an artefact that the attempt was not given, even when it exists, and for a malformed digest', async () => {
    // The seed draft is recorded and has nothing to do with this retrieval.
    const draft = flow.world.records.seedDigest;
    const recorded = await flow.world.sql('SELECT 1 FROM artefacts WHERE digest = $1', [draft]);
    expect(recorded).toHaveLength(1);
    for (const digest of [draft, sha('nothing'), 'sha256:not-hex', 'x']) {
      const response = await flow.send('GET', inputPath(claimed.attemptId, digest), claimed.token);
      expect(response.status, digest).toBe(404);
      expect(await errorCode(response), digest).toBe('NOT_FOUND');
    }
  });

  it('is refused for another attempt than the capability names, and without a capability', async () => {
    const other = await flow.send('GET', inputPath('att-elsewhere', requestDigest), claimed.token);
    expect(other.status).toBe(403);
    const none = await flow.send('GET', inputPath(claimed.attemptId, requestDigest), undefined);
    expect(none.status).toBe(401);
    const service = await flow.send('GET', inputPath(claimed.attemptId, requestDigest), flow.service('batch'));
    expect(service.status).toBe(403);
  });
});

describe('attempts.artefact', () => {
  it('stores the bytes under their digest, records who uploaded them, and accepts the same upload again', async () => {
    const bytes = bytesOf({ uploaded: 'by the batch host', n: 1 });
    const ref = await upload(flow, claimed, bytes);
    expect(ref.digest).toBe(digestOfBytes(bytes));
    expect(await flow.world.testApp.objects.get(ref.digest as never)).toEqual(bytes);
    const [row] = await flow.world.sql<{
      media_type: string;
      size_bytes: string;
      uploaded_by: string;
      uploaded_by_attempt: string;
    }>('SELECT media_type, size_bytes, uploaded_by, uploaded_by_attempt FROM artefacts WHERE digest = $1', [
      ref.digest,
    ]);
    expect(row).toEqual({
      media_type: 'application/json',
      size_bytes: String(bytes.length),
      uploaded_by: 'svc-batch',
      uploaded_by_attempt: claimed.attemptId,
    });
    // The same bytes again are the same object: nothing changes.
    const before = await flow.world.snapshot(['audit_events']);
    expect(await upload(flow, claimed, bytes)).toEqual(ref);
    expect(await flow.world.snapshot(['audit_events'])).toEqual(before);
  });

  it('takes the media type of the request, or octet-stream when it names none that is valid', async () => {
    const text = new TextEncoder().encode('plain text artefact');
    expect((await upload(flow, claimed, text, 'text/plain; charset=utf-8')).digest).toBe(digestOfBytes(text));
    const [plain] = await flow.world.sql<{ media_type: string }>('SELECT media_type FROM artefacts WHERE digest = $1', [
      digestOfBytes(text),
    ]);
    expect(plain?.media_type).toBe('text/plain');
    const opaque = new TextEncoder().encode('no content type');
    const response = await flow.send(
      'PUT',
      artefactPath(claimed.attemptId, digestOfBytes(opaque)),
      claimed.token,
      opaque,
    );
    expect(response.status).toBe(204);
    const [row] = await flow.world.sql<{ media_type: string }>('SELECT media_type FROM artefacts WHERE digest = $1', [
      digestOfBytes(opaque),
    ]);
    expect(row?.media_type).toBe('application/octet-stream');
  });

  it('refuses bytes that do not hash to the digest of the path with DIGEST_MISMATCH, and stores nothing', async () => {
    const bytes = new TextEncoder().encode('these bytes');
    const before = await flow.world.snapshot(['audit_events']);
    const wrong = await flow.send('PUT', artefactPath(claimed.attemptId, sha('other bytes')), claimed.token, bytes);
    expect(wrong.status).toBe(422);
    expect(await errorCode(wrong)).toBe('DIGEST_MISMATCH');
    const malformed = await flow.send('PUT', artefactPath(claimed.attemptId, 'sha256:xyz'), claimed.token, bytes);
    expect(malformed.status).toBe(422);
    expect(await errorCode(malformed)).toBe('DIGEST_MISMATCH');
    expect(await flow.world.snapshot(['audit_events'])).toEqual(before);
    expect(await flow.world.testApp.objects.head(sha('other bytes') as never)).toBeNull();
  });

  it('refuses an artefact above the limit of the cohort policy with LIMIT_EXCEEDED, below the 16 MiB of the route', async () => {
    const limit = 8 * 1024 * 1024;
    const big = new Uint8Array(limit + 1).fill(7);
    const response = await flow.send('PUT', artefactPath(claimed.attemptId, digestOfBytes(big)), claimed.token, big);
    expect(response.status).toBe(413);
    expect(await errorCode(response)).toBe('LIMIT_EXCEEDED');
    expect(await flow.world.sql('SELECT 1 FROM artefacts WHERE digest = $1', [digestOfBytes(big)])).toHaveLength(0);
    const exact = new Uint8Array(limit).fill(7);
    const accepted = await flow.send(
      'PUT',
      artefactPath(claimed.attemptId, digestOfBytes(exact)),
      claimed.token,
      exact,
    );
    expect(accepted.status).toBe(204);
  });

  it('is refused for another attempt, and a service credential cannot upload', async () => {
    const bytes = new TextEncoder().encode('x');
    expect(
      (await flow.send('PUT', artefactPath('att-elsewhere', digestOfBytes(bytes)), claimed.token, bytes)).status,
    ).toBe(403);
    expect(
      (await flow.send('PUT', artefactPath(claimed.attemptId, digestOfBytes(bytes)), flow.service('batch'), bytes))
        .status,
    ).toBe(403);
  });
});

describe('after the lease', () => {
  it('reads and writes nothing: the capability expires with the lease', async () => {
    const outbox = await outboxOf(flow, claimed.attemptId);
    expect(outbox.revision).toBe(1);
    flow.world.testApp.clock.advanceSeconds(661);
    const bytes = new TextEncoder().encode('too late');
    const read = await flow.send('GET', inputPath(claimed.attemptId, requestDigest), claimed.token);
    expect(read.status).toBe(409);
    expect(await errorCode(read)).toBe('LEASE_EXPIRED');
    const write = await flow.send('PUT', artefactPath(claimed.attemptId, digestOfBytes(bytes)), claimed.token, bytes);
    expect(write.status).toBe(409);
    expect(await errorCode(write)).toBe('LEASE_EXPIRED');
    expect(await flow.world.sql('SELECT 1 FROM artefacts WHERE digest = $1', [digestOfBytes(bytes)])).toHaveLength(0);
  });
});

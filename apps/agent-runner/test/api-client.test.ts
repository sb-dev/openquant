import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { AttemptClaimRequest } from '@openquant/api-contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HttpApiClient, isTransient, validBaseUrl } from '../src/api-client.ts';
import { sha256Bytes } from '../src/text.ts';
import { type ControlApi, errorJson, startControlApi } from './support/control-api.ts';
import { API_TOKEN, CAPABILITY, cleanup, TEST_IDENTITY } from './support/world.ts';

let api: ControlApi;
let client: HttpApiClient;

const claim: AttemptClaimRequest = {
  schema_version: 'attempt-claim/1',
  form: 'claim',
  attempt: { attempt_id: 'attempt-1', ownership_revision: 3 },
  dispatch_digest: `sha256:${'c'.repeat(64)}`,
  executable: TEST_IDENTITY,
  worker_id: 'worker-test',
};

beforeEach(async () => {
  api = await startControlApi();
  client = new HttpApiClient({ baseUrl: `http://127.0.0.1:${api.port}`, credential: API_TOKEN, timeoutMs: 1500 });
});

afterEach(async () => {
  await api.close();
  cleanup();
});

describe('validBaseUrl', () => {
  it('takes https, and http only on a loopback address', () => {
    expect(validBaseUrl('https://api.example.test')).toBe('https://api.example.test');
    expect(validBaseUrl('https://api.example.test/base/')).toBe('https://api.example.test/base');
    expect(validBaseUrl('http://127.0.0.1:8787')).toBe('http://127.0.0.1:8787');
    expect(validBaseUrl('http://localhost:8787')).toBe('http://localhost:8787');
  });

  it('refuses plain http to another host, a credential in the URL, a query, a fragment and text that is no URL', () => {
    for (const value of [
      'http://api.example.test',
      'ftp://127.0.0.1',
      'https://user:pass@api.example.test',
      'https://api.example.test?x=1',
      'https://api.example.test#a',
      'api.example.test',
      '',
    ]) {
      expect(validBaseUrl(value), value).toBeUndefined();
    }
  });

  it('refuses a base URL that is not allowed when the client is built', () => {
    expect(() => new HttpApiClient({ baseUrl: 'http://api.example.test', credential: 'x', timeoutMs: 100 })).toThrow(
      /https/,
    );
  });
});

describe('claim', () => {
  it('sends the claim with the service credential and returns the grant', async () => {
    const answer = await client.claim(claim);
    expect(answer.ok).toBe(true);
    if (!answer.ok) return;
    expect(answer.value).toMatchObject({ form: 'grant', attempt: claim.attempt, capability: { token: CAPABILITY } });
    const [request] = api.seen;
    expect(request?.method).toBe('POST');
    expect(request?.path).toBe('/v1/attempts/attempt-1/claim');
    expect(request?.authorization).toBe(`Bearer ${API_TOKEN}`);
    expect(request?.contentType).toBe('application/json');
    expect(JSON.parse(request?.body.toString('utf8') ?? '')).toEqual(claim);
  });

  it('reports the code of an api-error body, whatever its status', async () => {
    for (const [status, code] of [
      [409, 'ATTEMPT_NOT_CLAIMABLE'],
      [409, 'STALE_OWNERSHIP'],
      [422, 'IDENTITY_MISMATCH'],
      [409, 'EXECUTION_DISABLED'],
    ] as const) {
      api.nextClaim = { status, body: errorJson(code) };
      expect(await client.claim(claim), code).toMatchObject({ ok: false, status, code });
    }
  });

  it('falls back to the status when the body is not an api-error', async () => {
    api.nextClaim = { status: 503, body: 'upstream down' };
    expect(await client.claim(claim)).toMatchObject({ ok: false, code: 'UNAVAILABLE' });
    api.nextClaim = { status: 404, body: '' };
    expect(await client.claim(claim)).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    api.nextClaim = { status: 418, body: '' };
    expect(await client.claim(claim)).toMatchObject({ ok: false, code: 'BAD_RESPONSE' });
  });

  it('refuses a grant for another attempt or another ownership revision, and an answer that is not a grant', async () => {
    const grant = (attempt: unknown) =>
      JSON.stringify({
        schema_version: 'attempt-claim/1',
        form: 'grant',
        attempt,
        granted_at: '2026-11-15T10:00:00Z',
        lease_expires_at: '2026-11-15T10:20:00Z',
        capability: { token: CAPABILITY },
      });
    api.nextClaim = { status: 200, body: grant({ attempt_id: 'attempt-other', ownership_revision: 3 }) };
    expect(await client.claim(claim)).toMatchObject({ ok: false, code: 'BAD_RESPONSE' });
    api.nextClaim = { status: 200, body: grant({ attempt_id: 'attempt-1', ownership_revision: 4 }) };
    expect(await client.claim(claim)).toMatchObject({ ok: false, code: 'BAD_RESPONSE' });
    api.nextClaim = { status: 200, body: JSON.stringify(claim) };
    expect(await client.claim(claim)).toMatchObject({ ok: false, code: 'BAD_RESPONSE' });
    api.nextClaim = { status: 200, body: 'not json' };
    expect(await client.claim(claim)).toMatchObject({ ok: false, code: 'BAD_RESPONSE' });
  });

  it('never follows a redirect, so the credential cannot be sent to another host', async () => {
    api.nextClaim = { status: 302, body: '', headers: { location: 'http://127.0.0.1:9/steal' } };
    expect(await client.claim(claim)).toMatchObject({ ok: false, status: 302, code: 'UNAVAILABLE' });
    expect(api.seen).toHaveLength(1);
  });

  it('reports no answer within the timeout as a network failure, without the credential in the message', async () => {
    api.delayMs = 3000;
    const answer = await client.claim(claim);
    expect(answer).toMatchObject({ ok: false, status: 0, code: 'NETWORK' });
    expect(JSON.stringify(answer)).not.toContain(API_TOKEN);
    expect(isTransient(answer as never)).toBe(true);
  });

  it('reports a server that is not there as a network failure', async () => {
    const dead = new HttpApiClient({ baseUrl: 'http://127.0.0.1:1', credential: API_TOKEN, timeoutMs: 1000 });
    expect(await dead.claim(claim)).toMatchObject({ ok: false, code: 'NETWORK' });
  });
});

describe('the routes of the attempt', () => {
  it('reads an input with the capability and not with the service credential', async () => {
    const bytes = Buffer.from([0, 1, 2, 3, 250]);
    const digest = sha256Bytes(bytes);
    api.inputs.set(digest, bytes);
    const answer = await client.fetchInput('attempt-1', digest, CAPABILITY, 1024);
    expect(answer.ok && Buffer.compare(Buffer.from(answer.value), bytes)).toBe(0);
    expect(api.seen[0]?.path).toBe(`/v1/attempts/attempt-1/inputs/${encodeURIComponent(digest)}`);
    expect(api.seen[0]?.authorization).toBe(`Bearer ${CAPABILITY}`);
  });

  it('refuses an input that is longer than the limit it was asked for', async () => {
    const bytes = Buffer.alloc(5000, 1);
    const digest = sha256Bytes(bytes);
    api.inputs.set(digest, bytes);
    expect(await client.fetchInput('attempt-1', digest, CAPABILITY, 4999)).toMatchObject({
      ok: false,
      code: 'TOO_LARGE',
    });
    expect(await client.fetchInput('attempt-1', digest, CAPABILITY, 5000)).toMatchObject({ ok: true });
  });

  it('reports an input that does not exist, and a wrong capability', async () => {
    expect(await client.fetchInput('attempt-1', `sha256:${'0'.repeat(64)}`, CAPABILITY, 1024)).toMatchObject({
      ok: false,
      code: 'NOT_FOUND',
    });
    expect(await client.fetchInput('attempt-1', `sha256:${'0'.repeat(64)}`, 'wrong', 1024)).toMatchObject({
      ok: false,
      code: 'UNAUTHENTICATED',
    });
  });

  it('stores an artefact under its digest with the capability, and the API verifies the digest', async () => {
    const bytes = Buffer.from('{"role":"output"}');
    const digest = sha256Bytes(bytes);
    expect(await client.putArtefact('attempt-1', digest, bytes, CAPABILITY)).toEqual({ ok: true, value: undefined });
    expect(api.artefacts.get(digest)?.toString()).toBe('{"role":"output"}');
    expect(api.seen[0]).toMatchObject({
      method: 'PUT',
      authorization: `Bearer ${CAPABILITY}`,
      contentType: 'application/octet-stream',
    });
    expect(await client.putArtefact('attempt-1', `sha256:${'1'.repeat(64)}`, bytes, CAPABILITY)).toMatchObject({
      ok: false,
      code: 'DIGEST_MISMATCH',
    });
  });

  it('posts the attempt result as canonical JSON with the capability', async () => {
    const result = { schema_version: 'agent-attempt-result/1', b: 1, a: 2 } as never;
    expect(await client.postAgentResult('attempt-1', result, CAPABILITY)).toEqual({ ok: true, value: undefined });
    expect(api.seen[0]).toMatchObject({
      method: 'POST',
      path: '/v1/attempts/attempt-1/agent-result',
      authorization: `Bearer ${CAPABILITY}`,
      contentType: 'application/json',
    });
    expect(api.seen[0]?.body.toString('utf8')).toBe('{"a":2,"b":1,"schema_version":"agent-attempt-result/1"}');
  });

  it('encodes an attempt id that would otherwise change the path', async () => {
    await client.postAgentResult('a/../b?x', { schema_version: 'agent-attempt-result/1' } as never, CAPABILITY);
    expect(api.seen[0]?.path).toBe('/v1/attempts/a%2F..%2Fb%3Fx/agent-result');
  });
});

describe('an answer that breaks off or redirects is not an oversized body', () => {
  let server: Server | undefined;

  afterEach(async () => {
    const open = server;
    server = undefined;
    if (open) await new Promise<void>((done) => open.close(() => done()));
  });

  /** A loopback server that answers every request with `answer`; returns a client for it. */
  async function serve(answer: Parameters<typeof createServer>[1]): Promise<HttpApiClient> {
    server = createServer(answer);
    await new Promise<void>((done) => server?.listen(0, '127.0.0.1', done));
    const { port } = server.address() as AddressInfo;
    return new HttpApiClient({ baseUrl: `http://127.0.0.1:${port}`, credential: API_TOKEN, timeoutMs: 1500 });
  }

  it('reports a connection reset in the middle of the body as a transient network failure', async () => {
    const reset = await serve((_request, response) => {
      response.writeHead(200, { 'content-length': '100000', 'content-type': 'application/json' });
      response.write(Buffer.alloc(40_000, 0x20), () => response.socket?.destroy());
    });
    const answer = await reset.fetchInput('attempt-1', `sha256:${'0'.repeat(64)}`, CAPABILITY, 512 * 1024);
    expect(answer).toMatchObject({ ok: false, status: 200, code: 'NETWORK' });
    expect(isTransient(answer as never)).toBe(true);
  });

  it('reports a redirect of an input as an unavailable API, retried and never followed', async () => {
    let requests = 0;
    const redirect = await serve((_request, response) => {
      requests += 1;
      response.writeHead(307, { location: 'http://127.0.0.1:9/elsewhere', 'content-length': '0' });
      response.end();
    });
    const answer = await redirect.fetchInput('attempt-1', `sha256:${'0'.repeat(64)}`, CAPABILITY, 1024);
    expect(answer).toMatchObject({ ok: false, status: 307, code: 'UNAVAILABLE' });
    expect(isTransient(answer as never)).toBe(true);
    expect(requests).toBe(1);
  });
});

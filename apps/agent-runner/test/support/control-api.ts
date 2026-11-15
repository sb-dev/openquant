// A loopback control API for the HTTP tests: the claim, input, artefact and result routes of the attempt, with the
// credential rules of routes/v1.json. It runs on 127.0.0.1 only and keeps what it receives in memory.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { canonicalJson, parseContract } from '@openquant/api-contracts';
import { sha256Bytes } from '../../src/text.ts';
import { API_TOKEN, CAPABILITY } from './world.ts';

export interface Seen {
  readonly method: string;
  readonly path: string;
  readonly authorization: string | undefined;
  readonly contentType: string | undefined;
  readonly body: Buffer;
}

export interface ControlApi {
  readonly server: Server;
  port: number;
  readonly seen: Seen[];
  readonly inputs: Map<string, Uint8Array>;
  readonly artefacts: Map<string, Buffer>;
  readonly results: unknown[];
  /** Replace the answer to the next claim: a status and a body. */
  nextClaim: { status: number; body: string; headers?: Record<string, string> } | undefined;
  delayMs: number;
  close(): Promise<void>;
}

async function read(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

function reply(
  response: ServerResponse,
  status: number,
  body: string | Uint8Array = '',
  headers: Record<string, string> = {},
): void {
  response.writeHead(status, { 'content-length': Buffer.byteLength(body), ...headers });
  response.end(body);
}

export function errorJson(code: string, message = 'refused'): string {
  return canonicalJson({
    schema_version: 'api-error/1',
    code,
    message,
    state_changed: 'NONE',
    retry_safe: false,
    diagnostic_ref: 'diag-test',
  });
}

export async function startControlApi(): Promise<ControlApi> {
  const seen: Seen[] = [];
  const state: ControlApi = {
    server: undefined as unknown as Server,
    port: 0,
    seen,
    inputs: new Map(),
    artefacts: new Map(),
    results: [],
    nextClaim: undefined,
    delayMs: 0,
    close: async () => undefined,
  };
  const server = createServer(async (request, response) => {
    const body = await read(request);
    const path = new URL(request.url ?? '/', 'http://x').pathname;
    seen.push({
      method: request.method ?? '',
      path,
      authorization: request.headers.authorization,
      contentType: request.headers['content-type'],
      body,
    });
    if (state.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, state.delayMs));
    const claim = /^\/v1\/attempts\/([^/]+)\/claim$/.exec(path);
    const input = /^\/v1\/attempts\/([^/]+)\/inputs\/([^/]+)$/.exec(path);
    const artefact = /^\/v1\/attempts\/([^/]+)\/artefacts\/([^/]+)$/.exec(path);
    const result = /^\/v1\/attempts\/([^/]+)\/agent-result$/.exec(path);
    if (claim && request.method === 'POST') {
      if (request.headers.authorization !== `Bearer ${API_TOKEN}`)
        return reply(response, 401, errorJson('UNAUTHENTICATED'));
      if (state.nextClaim) {
        const next = state.nextClaim;
        state.nextClaim = undefined;
        return reply(response, next.status, next.body, next.headers);
      }
      const parsed = parseContract('attempt-claim', body);
      if (!parsed.ok || parsed.value.form !== 'claim') return reply(response, 400, errorJson('SCHEMA_VIOLATION'));
      return reply(
        response,
        200,
        canonicalJson({
          schema_version: 'attempt-claim/1',
          form: 'grant',
          attempt: parsed.value.attempt,
          granted_at: '2026-11-15T10:00:00Z',
          lease_expires_at: '2026-11-15T10:20:00Z',
          capability: { token: CAPABILITY },
        }),
        { 'content-type': 'application/json' },
      );
    }
    // The attempt routes take the attempt capability and nothing else.
    if (request.headers.authorization !== `Bearer ${CAPABILITY}`)
      return reply(response, 401, errorJson('UNAUTHENTICATED'));
    if (input && request.method === 'GET') {
      const bytes = state.inputs.get(decodeURIComponent(input[2] ?? ''));
      return bytes ? reply(response, 200, bytes) : reply(response, 404, errorJson('NOT_FOUND'));
    }
    if (artefact && request.method === 'PUT') {
      const digest = decodeURIComponent(artefact[2] ?? '');
      if (sha256Bytes(body) !== digest) return reply(response, 422, errorJson('DIGEST_MISMATCH'));
      state.artefacts.set(digest, body);
      return reply(response, 204);
    }
    if (result && request.method === 'POST') {
      state.results.push(JSON.parse(body.toString('utf8')));
      return reply(response, 204);
    }
    return reply(response, 404, errorJson('NOT_FOUND'));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  state.port = (server.address() as AddressInfo).port;
  (state as { server: Server }).server = server;
  state.close = () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  return state;
}

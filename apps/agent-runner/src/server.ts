// The endpoints of the runner: `POST /v1/agent-attempts` (route `runner.dispatch` in routes/v1.json) and
// `POST /v1/agent-attempts/{attempt_id}/cancel` (route `runner.cancel`, below), both with the workflows credential.
//
// The dispatch, in order: the route, the credential of the workflows principal, the body limit checked while the body arrives and
// before anything parses it, the shared strict parser for `agent-dispatch/1`, then the runner, which claims the
// attempt before it starts anything. The answer is 202 with no body once the claim is durable, or an `api-error/1`
// body whose status follows the route manifest. No error body carries a credential or a stack trace.

import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  type ApiError,
  type ApiErrorCode,
  apiViolations,
  type ContractError,
  digest,
  parseContract,
  workerBodyLimit,
} from '@openquant/api-contracts';
import type { Logger } from './attempt.ts';
import type { Runner } from './runner.ts';

export const DISPATCH_PATH = '/v1/agent-attempts';
/** The `max_body_bytes` of the route: the Worker byte limit of `agent-dispatch/1`, 4 MiB. */
export const DISPATCH_BODY_LIMIT: number = workerBodyLimit('agent-dispatch');

/** The HTTP status of each error code, as `error_status` of the route manifest states it. */
export const ERROR_STATUS: Readonly<Partial<Record<ApiErrorCode, number>>> = {
  UNSUPPORTED_SCHEMA_VERSION: 400,
  SCHEMA_VIOLATION: 400,
  INVALID_DECIMAL: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  STALE_OWNERSHIP: 409,
  ATTEMPT_NOT_CLAIMABLE: 409,
  IDENTITY_MISMATCH: 422,
  EXECUTION_DISABLED: 409,
  LIMIT_EXCEEDED: 413,
  RATE_LIMITED: 429,
  UNAVAILABLE: 503,
  INTERNAL: 500,
};

const RETRY_SAFE: ReadonlySet<ApiErrorCode> = new Set(['RATE_LIMITED', 'UNAVAILABLE']);

export function apiError(
  code: ApiErrorCode,
  message: string,
  extra: { readonly stateChanged?: 'NONE' | 'UNKNOWN'; readonly violations?: ReturnType<typeof apiViolations> } = {},
): ApiError {
  return {
    schema_version: 'api-error/1',
    code,
    message: message.slice(0, 1000),
    state_changed: extra.stateChanged ?? 'NONE',
    retry_safe: RETRY_SAFE.has(code),
    diagnostic_ref: `diag-${randomUUID()}`,
    ...(extra.violations === undefined ? {} : { violations: extra.violations }),
  };
}

function send(response: ServerResponse, status: number, body: ApiError | undefined): void {
  const text = body === undefined ? '' : JSON.stringify(body);
  response.writeHead(status, {
    'content-length': Buffer.byteLength(text),
    ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    'cache-control': 'no-store',
  });
  response.end(text);
}

function refuse(response: ServerResponse, error: ApiError, close = false): void {
  const status = ERROR_STATUS[error.code] ?? 500;
  if (close) response.setHeader('connection', 'close');
  send(response, status, error);
}

function bearer(request: IncomingMessage): string | undefined {
  const header = request.headers.authorization;
  const match = typeof header === 'string' ? /^Bearer ([^\s]+)$/.exec(header) : null;
  return match?.[1];
}

/** Constant-time comparison of two secrets of any length. */
export function sameSecret(provided: string, expected: string): boolean {
  const a = createHash('sha256').update(provided).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

type Body = { readonly ok: true; readonly bytes: Buffer } | { readonly ok: false };

/** Read at most `limit` bytes. The declared length is checked first, and the real length while it arrives. */
function readBody(request: IncomingMessage, limit: number): Promise<Body> {
  return new Promise((resolve) => {
    const declared = request.headers['content-length'];
    if (declared !== undefined && Number(declared) > limit) {
      resolve({ ok: false });
      return;
    }
    const chunks: Buffer[] = [];
    let total = 0;
    request.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > limit) {
        request.removeAllListeners('data');
        request.resume();
        resolve({ ok: false });
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve({ ok: true, bytes: Buffer.concat(chunks) }));
    request.on('error', () => resolve({ ok: false }));
  });
}

export interface ServerOptions {
  readonly runner: Runner;
  /** The secret that the workflows principal presents. */
  readonly dispatchToken: string;
  readonly log: Logger;
}

/**
 * The cancel route of the runner (`runner.cancel`): `POST /v1/agent-attempts/{attempt_id}/cancel`, no body. It ends the
 * process tree of the attempt when this runner runs it, and answers 204 either way, so a repeated or late request is
 * harmless (OQ-05 section 4: cancel_mission's cancellation request; OQ-03 section 5).
 */
export const CANCEL_PATH = /^\/v1\/agent-attempts\/([A-Za-z0-9][A-Za-z0-9._:-]{0,63})\/cancel$/;

export function createDispatchServer(options: ServerOptions): Server {
  const { runner, dispatchToken, log } = options;
  const server = createServer(async (request, response) => {
    try {
      const path = new URL(request.url ?? '/', 'http://runner.invalid').pathname;
      const cancel = CANCEL_PATH.exec(path);
      if ((path !== DISPATCH_PATH && cancel === null) || request.method !== 'POST') {
        refuse(response, apiError('NOT_FOUND', 'there is no such route'), true);
        return;
      }
      const token = bearer(request);
      if (token === undefined || !sameSecret(token, dispatchToken)) {
        log('dispatch_unauthenticated', {});
        refuse(response, apiError('UNAUTHENTICATED', 'the dispatch credential is missing or invalid'), true);
        return;
      }
      if (cancel !== null) {
        // The route has no body: whatever was sent is not read.
        const attemptId = cancel[1] as string;
        const running = runner.cancel(attemptId);
        log('cancel_requested', { attempt: attemptId, running });
        response.setHeader('connection', 'close');
        send(response, 204, undefined);
        return;
      }
      const body = await readBody(request, DISPATCH_BODY_LIMIT);
      if (!body.ok) {
        refuse(response, apiError('LIMIT_EXCEEDED', `the body is larger than ${DISPATCH_BODY_LIMIT} bytes`), true);
        return;
      }
      const parsed = parseContract('agent-dispatch', body.bytes);
      if (!parsed.ok) {
        const error: ContractError = parsed.error;
        refuse(response, apiError(error.code, error.message, { violations: apiViolations(error) }));
        return;
      }
      const dispatch = parsed.value;
      const answer = await runner.dispatch(dispatch, await digest(dispatch));
      if (answer.kind === 'refused') {
        refuse(response, apiError(answer.code, answer.message, { stateChanged: answer.stateChanged }));
        return;
      }
      send(response, 202, undefined);
    } catch (error) {
      log('dispatch_failed', { detail: error instanceof Error ? error.name : 'unknown' });
      if (!response.headersSent)
        refuse(
          response,
          apiError('INTERNAL', 'the runner failed while it handled the dispatch', { stateChanged: 'UNKNOWN' }),
        );
    }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  return server;
}

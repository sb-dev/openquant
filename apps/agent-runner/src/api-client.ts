// The runner's side of the control API (OQ-05 sections 4, 5 and 9; routes `attempts.*` in routes/v1.json).
//
// `ApiClient` is the interface that the runner depends on. The runner claims the attempt with its service
// credential. The grant carries an attempt-scoped capability, and every later call (input, artefact, result) uses
// only that capability. The runner holds no R2 or database credential (OQ-05 section 5). A failure is a value, never
// an exception, so the caller decides what is final and what is left for fencing and retry.

import {
  type AgentAttemptResult,
  type ApiErrorCode,
  type AttemptClaimGrant,
  type AttemptClaimRequest,
  canonicalJson,
  parseContract,
} from '@openquant/api-contracts';

export type ApiFailureCode = ApiErrorCode | 'NETWORK' | 'BAD_RESPONSE';

export interface ApiFailure {
  readonly ok: false;
  /** The HTTP status, or 0 when the request never got an answer. */
  readonly status: number;
  readonly code: ApiFailureCode;
  readonly message: string;
}

export type ApiResult<T> = { readonly ok: true; readonly value: T } | ApiFailure;

export interface ApiClient {
  /** Claim the attempt before any work starts. A refusal means nothing may be started. */
  claim(request: AttemptClaimRequest): Promise<ApiResult<AttemptClaimGrant>>;
  /** Read the stored bytes of one input of the attempt, at most `maxBytes`. */
  fetchInput(attemptId: string, digest: string, capability: string, maxBytes: number): Promise<ApiResult<Uint8Array>>;
  /** Store one immutable artefact under its digest. */
  putArtefact(attemptId: string, digest: string, bytes: Uint8Array, capability: string): Promise<ApiResult<undefined>>;
  /** Submit the host-captured attempt result. */
  postAgentResult(attemptId: string, result: AgentAttemptResult, capability: string): Promise<ApiResult<undefined>>;
}

export function failure(status: number, code: ApiFailureCode, message: string): ApiFailure {
  return { ok: false, status, code, message };
}

/** A failure that a retry of the same call can cure: the other side is not reachable or is overloaded. */
export function isTransient(result: ApiFailure): boolean {
  return (
    result.code === 'NETWORK' ||
    result.code === 'UNAVAILABLE' ||
    result.code === 'RATE_LIMITED' ||
    result.code === 'INTERNAL'
  );
}

export interface HttpApiOptions {
  readonly baseUrl: string;
  /** The service credential of the runner principal. Used only for the claim. */
  readonly credential: string;
  readonly timeoutMs: number;
  readonly fetch?: typeof fetch;
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** The base URL is HTTPS, except for a loopback address that tests and local development use. */
export function validBaseUrl(value: string): string | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.username || url.password || url.search || url.hash) return undefined;
  if (url.protocol === 'https:') return url.origin + url.pathname.replace(/\/+$/, '');
  if (url.protocol === 'http:' && LOOPBACK.has(url.hostname)) return url.origin + url.pathname.replace(/\/+$/, '');
  return undefined;
}

const STATUS_CODE: Readonly<Record<number, ApiErrorCode>> = {
  400: 'SCHEMA_VIOLATION',
  401: 'UNAUTHENTICATED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'ATTEMPT_NOT_CLAIMABLE',
  413: 'LIMIT_EXCEEDED',
  422: 'IDENTITY_MISMATCH',
  429: 'RATE_LIMITED',
  503: 'UNAVAILABLE',
};

export class HttpApiClient implements ApiClient {
  readonly #base: string;
  readonly #credential: string;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;

  constructor(options: HttpApiOptions) {
    const base = validBaseUrl(options.baseUrl);
    if (base === undefined) throw new Error('the API base URL must be https, or http on a loopback address');
    this.#base = base;
    this.#credential = options.credential;
    this.#timeoutMs = options.timeoutMs;
    this.#fetch = options.fetch ?? fetch;
  }

  async claim(request: AttemptClaimRequest): Promise<ApiResult<AttemptClaimGrant>> {
    const answer = await this.#call(
      'POST',
      `/v1/attempts/${encodeURIComponent(request.attempt.attempt_id)}/claim`,
      this.#credential,
      canonicalJson(request),
      1_048_576,
    );
    if (!answer.ok) return answer;
    const parsed = parseContract('attempt-claim', answer.value);
    if (!parsed.ok || parsed.value.form !== 'grant') {
      return failure(200, 'BAD_RESPONSE', 'the claim answer is not an attempt-claim/1 grant');
    }
    const { attempt } = parsed.value;
    if (
      attempt.attempt_id !== request.attempt.attempt_id ||
      attempt.ownership_revision !== request.attempt.ownership_revision
    ) {
      return failure(200, 'BAD_RESPONSE', 'the grant names another attempt or ownership revision than the claim');
    }
    return { ok: true, value: parsed.value };
  }

  fetchInput(attemptId: string, digest: string, capability: string, maxBytes: number): Promise<ApiResult<Uint8Array>> {
    return this.#call(
      'GET',
      `/v1/attempts/${encodeURIComponent(attemptId)}/inputs/${encodeURIComponent(digest)}`,
      capability,
      undefined,
      maxBytes,
    );
  }

  async putArtefact(
    attemptId: string,
    digest: string,
    bytes: Uint8Array,
    capability: string,
  ): Promise<ApiResult<undefined>> {
    const answer = await this.#call(
      'PUT',
      `/v1/attempts/${encodeURIComponent(attemptId)}/artefacts/${encodeURIComponent(digest)}`,
      capability,
      bytes,
      4096,
    );
    return answer.ok ? { ok: true, value: undefined } : answer;
  }

  async postAgentResult(
    attemptId: string,
    result: AgentAttemptResult,
    capability: string,
  ): Promise<ApiResult<undefined>> {
    const answer = await this.#call(
      'POST',
      `/v1/attempts/${encodeURIComponent(attemptId)}/agent-result`,
      capability,
      canonicalJson(result),
      4096,
    );
    return answer.ok ? { ok: true, value: undefined } : answer;
  }

  async #call(
    method: string,
    path: string,
    token: string,
    body: string | Uint8Array | undefined,
    maxBytes: number,
  ): Promise<ApiResult<Uint8Array>> {
    let response: Response;
    try {
      response = await this.#fetch(`${this.#base}${path}`, {
        method,
        redirect: 'manual',
        signal: AbortSignal.timeout(this.#timeoutMs),
        headers: {
          authorization: `Bearer ${token}`,
          ...(body === undefined
            ? {}
            : { 'content-type': typeof body === 'string' ? 'application/json' : 'application/octet-stream' }),
        },
        ...(body === undefined ? {} : { body: typeof body === 'string' ? body : Buffer.from(body) }),
      });
    } catch (error) {
      // The message of a fetch error never carries the header, but keep it short in any case.
      return failure(
        0,
        'NETWORK',
        `the API call ${method} ${path.replace(/\/[^/]*$/, '/...')} failed: ${(error as Error).name}`,
      );
    }
    const read = await readBounded(response, maxBytes);
    if (response.status >= 200 && response.status < 300) {
      if (!read.ok) return failure(response.status, 'BAD_RESPONSE', 'the API answer is longer than the limit');
      return { ok: true, value: read.bytes };
    }
    if (response.status >= 300 && response.status < 400) {
      return failure(
        response.status,
        'BAD_RESPONSE',
        'the API answered with a redirect, which the runner never follows',
      );
    }
    const parsed = read.ok ? parseContract('api-error', read.bytes) : undefined;
    const code: ApiFailureCode =
      parsed?.ok === true
        ? parsed.value.code
        : (STATUS_CODE[response.status] ?? (response.status >= 500 ? 'UNAVAILABLE' : 'BAD_RESPONSE'));
    return failure(response.status, code, parsed?.ok === true ? parsed.value.message : `HTTP ${response.status}`);
  }
}

async function readBounded(
  response: Response,
  limit: number,
): Promise<{ ok: true; bytes: Uint8Array } | { ok: false }> {
  if (!response.body) return { ok: true, bytes: new Uint8Array() };
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel();
        return { ok: false };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false };
  }
  return { ok: true, bytes: Buffer.concat(chunks) };
}

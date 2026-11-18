// Typed errors of the client (OQ-04 section 12, OQ-05 section 8). An api-error/1 body maps to one ApiError subclass by
// its code. A request that got no answer is a TransportError: its outcome is unknown, because a timeout does not prove
// that nothing changed. An answer that fails its contract is a ResponseContractError: the client never acts on it.

import type { ApiError as ApiErrorBody, ApiErrorCode, MissionView } from '@openquant/api-contracts';

export type { ApiErrorBody };

export abstract class ClientError extends Error {
  abstract readonly kind: string;
}

/** An error answer of the API, as its api-error/1 body states it. */
export class ApiError extends ClientError {
  readonly kind: string = 'api';
  readonly status: number;
  readonly code: ApiErrorCode;
  readonly body: ApiErrorBody;

  constructor(status: number, body: ApiErrorBody) {
    super(`${body.code}: ${body.message}`);
    this.name = new.target.name;
    this.status = status;
    this.code = body.code;
    this.body = body;
  }

  /** NONE only when the API has authoritative evidence that nothing changed. */
  get stateChanged(): 'NONE' | 'UNKNOWN' {
    return this.body.state_changed;
  }
  get retrySafe(): boolean {
    return this.body.retry_safe;
  }
  get diagnosticRef(): string {
    return this.body.diagnostic_ref;
  }
}

/** UNAUTHENTICATED: no credential, or one that is unknown, expired, revoked or for another environment. */
export class UnauthenticatedError extends ApiError {
  override readonly kind = 'unauthenticated';
}
/** FORBIDDEN: the caller's roles do not allow the route. */
export class ForbiddenError extends ApiError {
  override readonly kind = 'forbidden';
}
export class NotFoundError extends ApiError {
  override readonly kind = 'not-found';
}

/** What the client read after a stale revision: the current revision and, where a read route exists, the snapshot. */
export interface Resync {
  readonly currentRevision: number | undefined;
  readonly mission?: MissionView;
}

/** REVISION_CONFLICT: the expected revision is stale. The client resynchronises before anything else is offered. */
export class RevisionConflictError extends ApiError {
  override readonly kind = 'revision-conflict';
  resync: Resync;
  constructor(status: number, body: ApiErrorBody) {
    super(status, body);
    this.resync = { currentRevision: body.current_revision };
  }
  get currentRevision(): number | undefined {
    return this.resync.mission?.revision ?? this.resync.currentRevision;
  }
}

/** COMMAND_ID_REUSED: the command ID belongs to another command, or another body. */
export class CommandIdReusedError extends ApiError {
  override readonly kind = 'command-id-reused';
}
/** The request broke its contract or a body limit: SCHEMA_VIOLATION, UNSUPPORTED_SCHEMA_VERSION, INVALID_DECIMAL, LIMIT_EXCEEDED. */
export class InvalidRequestError extends ApiError {
  override readonly kind = 'invalid-request';
}
/** A rule refused the command: POLICY_VIOLATION, BUDGET_EXHAUSTED, EXECUTION_DISABLED and the other domain codes. */
export class RefusedError extends ApiError {
  override readonly kind = 'refused';
}
/** UNAVAILABLE or RATE_LIMITED. */
export class UnavailableError extends ApiError {
  override readonly kind = 'unavailable';
}
/** INTERNAL. */
export class InternalApiError extends ApiError {
  override readonly kind = 'internal';
}

const INVALID_REQUEST: ReadonlySet<ApiErrorCode> = new Set([
  'SCHEMA_VIOLATION',
  'UNSUPPORTED_SCHEMA_VERSION',
  'INVALID_DECIMAL',
  'LIMIT_EXCEEDED',
]);

/** The typed error of an api-error/1 body. */
export function apiErrorOf(status: number, body: ApiErrorBody): ApiError {
  switch (body.code) {
    case 'UNAUTHENTICATED':
      return new UnauthenticatedError(status, body);
    case 'FORBIDDEN':
      return new ForbiddenError(status, body);
    case 'NOT_FOUND':
      return new NotFoundError(status, body);
    case 'REVISION_CONFLICT':
      return new RevisionConflictError(status, body);
    case 'COMMAND_ID_REUSED':
      return new CommandIdReusedError(status, body);
    case 'UNAVAILABLE':
    case 'RATE_LIMITED':
      return new UnavailableError(status, body);
    case 'INTERNAL':
      return new InternalApiError(status, body);
    default:
      return INVALID_REQUEST.has(body.code) ? new InvalidRequestError(status, body) : new RefusedError(status, body);
  }
}

/** No answer arrived: the connection failed or the deadline passed. For a command the outcome is unknown. */
export class TransportError extends ClientError {
  readonly kind = 'transport';
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'TransportError';
  }
}

/** The answer failed its contract (or an error answer is not api-error/1). The client does not use it. */
export class ResponseContractError extends ClientError {
  readonly kind = 'response-contract';
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'ResponseContractError';
    this.status = status;
  }
}

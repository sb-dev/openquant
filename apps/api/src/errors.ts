// api-error/1 (OQ-05 section 7): the error body of every route. An ApiFailure carries what the body states. The status
// of each code comes from the route manifest, and a body never repeats request text, credentials or a stack.

import type { ApiError, ApiErrorCode, ApiViolation } from '@openquant/api-contracts';
import { apiViolations, type ContractError, type ContractErrorKind } from '@openquant/api-contracts';
import { statusOf } from './manifest.ts';

export interface FailureOptions {
  readonly violations?: readonly ApiViolation[] | undefined;
  /** NONE only when the API has authoritative evidence that nothing changed (api-error/1). */
  readonly stateChanged?: 'NONE' | 'UNKNOWN';
  readonly retrySafe?: boolean;
  readonly currentRevision?: number;
}

const MAX_MESSAGE = 1000;

export class ApiFailure extends Error {
  readonly code: ApiErrorCode;
  readonly violations: readonly ApiViolation[] | undefined;
  readonly stateChanged: 'NONE' | 'UNKNOWN';
  readonly retrySafe: boolean;
  readonly currentRevision: number | undefined;

  constructor(code: ApiErrorCode, message: string, options: FailureOptions = {}) {
    super(message);
    this.name = 'ApiFailure';
    this.code = code;
    this.violations = options.violations;
    this.stateChanged = options.stateChanged ?? 'NONE';
    this.retrySafe = options.retrySafe ?? false;
    this.currentRevision = options.currentRevision;
  }

  get status(): number {
    return statusOf(this.code);
  }
}

/** The body of an error response. Optional members are left out, never undefined. */
export function errorBody(failure: ApiFailure, diagnosticRef: string): ApiError {
  const body: ApiError = {
    schema_version: 'api-error/1',
    code: failure.code,
    message: failure.message.length > MAX_MESSAGE ? failure.message.slice(0, MAX_MESSAGE) : failure.message,
    state_changed: failure.stateChanged,
    retry_safe: failure.retrySafe,
    diagnostic_ref: diagnosticRef,
  };
  if (failure.currentRevision !== undefined) body.current_revision = failure.currentRevision;
  if (failure.violations !== undefined && failure.violations.length > 0) body.violations = [...failure.violations];
  return body;
}

// A rejection says which rule failed, never what the body held: a body can carry text that must not be echoed.
const CONTRACT_MESSAGES: Readonly<Record<ContractErrorKind, string>> = {
  'too-large': 'The request body is larger than the strict JSON limit.',
  json: 'The request body is not valid strict JSON.',
  'duplicate-key': 'The request body repeats an object key.',
  'float-number': 'The request body holds a number that is not an integer.',
  'unsafe-integer': 'The request body holds an integer outside the exact range.',
  'structural-limit': 'The request body exceeds a structural limit of the contract layer.',
  'missing-version': 'The request body has no schema_version string.',
  'unsupported-version': 'The request body names a schema version that this API does not accept.',
  'value-bound': 'The request body holds more values than the contract allows.',
  schema: 'The request body does not satisfy its contract.',
};

/** A contract rejection as an api-error/1: its code, and the listing of the contract layer cut to the API limits. */
export function fromContractError(error: ContractError): ApiFailure {
  return new ApiFailure(error.code, CONTRACT_MESSAGES[error.kind], { violations: apiViolations(error) });
}

export function limitExceeded(limit: number): ApiFailure {
  return new ApiFailure(
    'LIMIT_EXCEEDED',
    `The request body is larger than the limit of ${limit} bytes for this route.`,
  );
}

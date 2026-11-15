// Contract errors and failure codes, mirroring packages/api-contracts/rust/src/error.rs.

import type { ApiViolation } from '../dist/generated/types.ts';
import type { StrictJsonErrorKind } from './strict-json.ts';

/** The shared failure codes the contract layer reports. */
export type ContractFailureCode = 'SCHEMA_VIOLATION' | 'UNSUPPORTED_SCHEMA_VERSION' | 'INVALID_DECIMAL';

/** One schema violation with the JSON pointer of the offending value. */
export interface SchemaViolation {
  readonly pointer: string;
  readonly message: string;
  /** True when the value failed the shared decimal or Exact grammar. */
  readonly decimalGrammar: boolean;
}

/**
 * value-bound: the document holds more values than any document valid against its contract can
 * hold (validate.ts), or a scanned result head holds more text than a valid head (result.ts).
 * structural-limit: an object key longer than the key limit, reported after the version check, or,
 * in the result scan, an array, object or string past its limit. Both are SCHEMA_VIOLATION.
 */
export type ContractErrorKind =
  | StrictJsonErrorKind
  | 'missing-version'
  | 'unsupported-version'
  | 'value-bound'
  | 'schema';

/**
 * The code of a rejection, as `ContractError::failure_code` gives it in Rust. A schema rejection is
 * INVALID_DECIMAL only when every violation is a decimal-grammar one.
 */
export function failureCode(kind: ContractErrorKind, violations: readonly SchemaViolation[]): ContractFailureCode {
  if (kind === 'unsupported-version') return 'UNSUPPORTED_SCHEMA_VERSION';
  if (kind === 'schema' && violations.length > 0 && violations.every((v) => v.decimalGrammar)) {
    return 'INVALID_DECIMAL';
  }
  return 'SCHEMA_VIOLATION';
}

/** Why a payload was rejected. */
export class ContractError extends Error {
  readonly kind: ContractErrorKind;
  readonly code: ContractFailureCode;
  /**
   * Schema violations. When the listing ran: at most 20, then one entry without a pointer that
   * stands for all later ones and is decimal-grammar only if every one of them is. When it stopped
   * (listingStopped): the limit that stopped it, then, for a structural limit, the first violation
   * (Rust gives one generic entry instead).
   */
  readonly violations: readonly SchemaViolation[];
  /**
   * True when the document was not listed in full: it holds more values than its value bound
   * (kind value-bound), it holds a key longer than the key limit or, in the result scan, another
   * structural excess (kind structural-limit), or, invalid, it exceeds a structural limit such as
   * more than MAX_NODES values (limits.ts). At most the first violation was then found, and the
   * code is SCHEMA_VIOLATION.
   */
  readonly listingStopped: boolean;

  constructor(
    kind: ContractErrorKind,
    message: string,
    violations: readonly SchemaViolation[] = [],
    listingStopped = false,
  ) {
    super(message);
    this.name = 'ContractError';
    this.kind = kind;
    this.violations = violations;
    this.listingStopped = listingStopped;
    this.code = listingStopped ? 'SCHEMA_VIOLATION' : failureCode(kind, violations);
  }
}

/** The longest ApiViolation pointer and message, in characters (code points), as the schema states. */
export const API_POINTER_MAX_LENGTH = 1024;
export const API_MESSAGE_MAX_LENGTH = 1000;

// Cut text to at most `maximum` code points, never inside a surrogate pair. A string of at most
// `maximum` UTF-16 code units has at most that many code points and is returned as it is.
function cut(text: string, maximum: number): string {
  if (text.length <= maximum) return text;
  const points = Array.from(text);
  return points.length <= maximum ? text : points.slice(0, maximum).join('');
}

/**
 * The `violations` of the `api-error/1` body for a rejected payload, or undefined when the error
 * lists none (OQ-05 §7). The entries are the contract layer's listing, in order: at most 20 violations
 * and one last entry, with an empty pointer, that counts the rest, so at most 21 entries. A pointer or a
 * message longer than the schema maximum is cut to it. The decimal-grammar flag is not sent.
 */
export function apiViolations(error: ContractError): ApiViolation[] | undefined {
  if (error.violations.length === 0) return undefined;
  return error.violations.map(({ pointer, message }) => ({
    pointer: cut(pointer, API_POINTER_MAX_LENGTH),
    message: cut(message, API_MESSAGE_MAX_LENGTH),
  }));
}

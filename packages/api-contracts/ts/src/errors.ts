// Contract errors and failure codes, mirroring packages/api-contracts/rust/src/error.rs.

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

export type ContractErrorKind = StrictJsonErrorKind | 'missing-version' | 'unsupported-version' | 'schema';

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
   * Schema violations: at most 20, then one entry without a pointer that stands for all later ones
   * and is decimal-grammar only if every one of them is. A document beyond the structural limits
   * holds the limit it exceeds, then its first violation.
   */
  readonly violations: readonly SchemaViolation[];

  constructor(kind: ContractErrorKind, message: string, violations: readonly SchemaViolation[] = []) {
    super(message);
    this.name = 'ContractError';
    this.kind = kind;
    this.violations = violations;
    this.code = failureCode(kind, violations);
  }
}

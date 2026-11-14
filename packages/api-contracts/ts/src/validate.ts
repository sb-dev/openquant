// The TypeScript contract layer, mirroring packages/api-contracts/rust (OQ-05 §7).
//
// The checks run in the order Rust runs them, so a payload gets the same verdict and code:
//
// 1. strict JSON (strict-json.ts): size, grammar, duplicate keys, non-integer numbers, nesting;
// 2. the version tag: missing or not a string is SCHEMA_VIOLATION, another tag is
//    UNSUPPORTED_SCHEMA_VERSION (schema.rs `validate`);
// 3. an integer whose magnitude is above 2^53 - 1: SCHEMA_VIOLATION. Rust reaches the schema with it
//    and the schema rejects it, because every schema integer has a maximum below 2^31 and every
//    object is closed;
// 4. the schema, first error only. A valid document stops here;
// 5. for an invalid document beyond the structural limits (limits.ts): SCHEMA_VIOLATION;
// 6. otherwise every violation is listed. The code is INVALID_DECIMAL when every violation is a
//    failure of the Decimal or Exact pattern (an Exact text longer than 80 characters fails
//    maxLength, which is SCHEMA_VIOLATION), and SCHEMA_VIOLATION otherwise (error.rs).
//
// Semantic rules stay in Rust: the Exact canonical form, decimal range and scale, operator types and
// run preparation. A payload that passes here may still be rejected there.

import {
  type ContractName,
  type ContractTypes,
  contracts,
  DECIMAL_PATTERN,
  EXACT_PATTERN,
} from '../dist/generated/contracts.ts';
import { byContract as allErrorValidators } from '../dist/generated/validators-all.js';
import { byContract as firstErrorValidators, type ValidatorError } from '../dist/generated/validators-first.js';
import { CanonicalError, canonicalJson } from './canonical.ts';
import { ContractError, type ContractErrorKind, type SchemaViolation } from './errors.ts';
import { firstExcess } from './limits.ts';
import { type JsonValue, StrictJsonError, scanStrictJson } from './strict-json.ts';

/** Violations listed one by one. Later ones are counted in one marker entry. */
export const MAX_REPORTED_VIOLATIONS = 20;

export type ContractResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ContractError };

export function isContractName(name: string): name is ContractName {
  return Object.hasOwn(contracts, name);
}

function reject(kind: ContractErrorKind, message: string, violations: readonly SchemaViolation[] = []) {
  return { ok: false, error: new ContractError(kind, message, violations) } as const;
}

function violation(error: ValidatorError | undefined): SchemaViolation {
  if (error === undefined) return { pointer: '', message: 'the schema rejected the document', decimalGrammar: false };
  const pattern = error.keyword === 'pattern' ? error.params.pattern : undefined;
  return {
    pointer: error.instancePath,
    message: `${error.instancePath || '/'} ${error.message ?? error.keyword}`,
    decimalGrammar: pattern === DECIMAL_PATTERN || pattern === EXACT_PATTERN,
  };
}

// The first violations, then one marker for the rest that is decimal-grammar only if all of them are.
function collect(errors: readonly ValidatorError[], first: SchemaViolation): SchemaViolation[] {
  const listed = errors.slice(0, MAX_REPORTED_VIOLATIONS).map(violation);
  const omitted = errors.slice(MAX_REPORTED_VIOLATIONS).map(violation);
  // The first-error pass rejected the document, so never turn that into success.
  if (listed.length === 0) listed.push(first);
  if (omitted.length > 0) {
    listed.push({
      pointer: '',
      message: `${omitted.length} further violation(s) not listed`,
      decimalGrammar: omitted.every((v) => v.decimalGrammar),
    });
  }
  return listed;
}

function schemaVersion(value: JsonValue): JsonValue | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return Object.hasOwn(value, 'schema_version') ? value.schema_version : undefined;
}

function check<C extends ContractName>(
  contract: C,
  value: JsonValue,
  unsafeInteger: string | undefined,
): ContractResult<ContractTypes[C]> {
  const expected = contracts[contract].versionTag;
  const found = schemaVersion(value);
  if (typeof found !== 'string') return reject('missing-version', 'missing or non-string schema_version');
  if (found !== expected) {
    return reject(
      'unsupported-version',
      `unsupported schema_version ${JSON.stringify(found)}; expected ${JSON.stringify(expected)}`,
    );
  }
  if (unsafeInteger !== undefined) {
    return reject('unsafe-integer', `integer ${unsafeInteger} is outside the exact range of 2^53 - 1`);
  }
  const quick = firstErrorValidators[contract];
  if (quick(value)) return { ok: true, value: value as unknown as ContractTypes[C] };
  const first = violation(quick.errors?.[0]);
  const excess = firstExcess(value);
  if (excess !== undefined) return reject('schema', 'payload violates the schema at 2 location(s)', [excess, first]);
  const full = allErrorValidators[contract];
  full(value);
  const violations = collect(full.errors ?? [], first);
  return reject('schema', `payload violates the schema at ${violations.length} location(s)`, violations);
}

/**
 * Parse a payload as one contract: strict JSON text or UTF-8 bytes, then the version, then the
 * schema. Never throws for a bad payload.
 */
export function parseContract<C extends ContractName>(
  contract: C,
  input: string | Uint8Array,
): ContractResult<ContractTypes[C]> {
  try {
    const { value, unsafeInteger } = scanStrictJson(input);
    return check(contract, value, unsafeInteger);
  } catch (error) {
    if (error instanceof StrictJsonError) return reject(error.kind, error.message);
    throw error;
  }
}

/**
 * Validate a value built in code: it passes when its canonical JSON text parses as the contract. The
 * result holds that parsed copy. A value with no JSON text (a non-integer number, an integer outside
 * the exact range, a lone surrogate, a non-ASCII key or a non-JSON object) is SCHEMA_VIOLATION.
 */
export function validateContract<C extends ContractName>(
  contract: C,
  value: unknown,
): ContractResult<ContractTypes[C]> {
  let text: string;
  try {
    text = canonicalJson(value);
  } catch (error) {
    if (error instanceof CanonicalError) return reject('json', error.message);
    throw error;
  }
  return parseContract(contract, text);
}

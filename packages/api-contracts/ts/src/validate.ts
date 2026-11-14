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
// 4. an object key whose text is longer than MAX_KEY_BYTES (limits.ts): SCHEMA_VIOLATION, and the
//    listing stopped. The parse never decodes such a key, and builds no value after it. Rust reaches
//    the schema with it, and the schema rejects it: every object is closed and no declared name is
//    that long (test/keys.test.ts);
// 5. more values than the contract's value bound: SCHEMA_VIOLATION (see below);
// 6. the schema, with the first-error validator, which decides validity at any size. A valid
//    document stops here;
// 7. an invalid document beyond the structural limits (limits.ts), such as one with more than
//    MAX_NODES (4,096) values, is not listed: it reports the limit, then its first violation, marks
//    the listing as stopped (ContractError.listingStopped) and is SCHEMA_VIOLATION;
// 8. otherwise the all-errors validator lists the violations, 20 and a counted rest, at a cost
//    bounded by MAX_NODES (limits.ts). The code is INVALID_DECIMAL when every violation is a failure
//    of the Decimal or Exact pattern (an Exact text longer than 80 characters fails maxLength, which
//    is SCHEMA_VIOLATION), and SCHEMA_VIOLATION otherwise (error.rs).
//
// The value bound limits what the parse builds. It is the larger of the most values a document
// valid against the contract's schema can hold (tools/generate.ts derives it from the closed objects
// and the array maxItems) and MAX_NODES. A document above it is therefore invalid, and it has more
// than MAX_NODES values, so Rust reports SCHEMA_VIOLATION for it too (limits.rs), once its strict
// JSON and its version tag pass. The parse still checks the whole text past the bound, so a
// strict-JSON error or a wrong version gives the same code as in Rust. A contract whose schema is
// recursive (an Expr tree) has no such maximum and no bound.
//
// The Worker byte limit (`workerBodyLimit`) keeps a Worker's parse within memory: with the value
// bound for most contracts, and alone for the others. The API applies it before it parses a body
// (routes/v1.json, OQ-05 §7). parseContract itself accepts the 16 MiB that Rust accepts.
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
import { firstExcess, MAX_KEY_BYTES, MAX_NODES } from './limits.ts';
import { type JsonValue, StrictJsonError, type StrictScan, scanStrictJson } from './strict-json.ts';

/** Violations listed one by one. Later ones are counted in one marker entry. */
export const MAX_REPORTED_VIOLATIONS = 20;

export type ContractResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ContractError };

export function isContractName(name: string): name is ContractName {
  return Object.hasOwn(contracts, name);
}

export function reject(
  kind: ContractErrorKind,
  message: string,
  violations: readonly SchemaViolation[] = [],
  listingStopped = false,
) {
  return { ok: false, error: new ContractError(kind, message, violations, listingStopped) } as const;
}

function violation(error: ValidatorError | undefined): SchemaViolation {
  if (error === undefined) return { pointer: '', message: 'the schema rejected the document', decimalGrammar: false };
  return {
    pointer: error.instancePath,
    message: `${error.instancePath || '/'} ${error.message ?? error.keyword}`,
    decimalGrammar: isDecimalGrammar(error),
  };
}

function isDecimalGrammar(error: ValidatorError): boolean {
  const pattern = error.keyword === 'pattern' ? error.params.pattern : undefined;
  return pattern === DECIMAL_PATTERN || pattern === EXACT_PATTERN;
}

// The first violations, then one marker for the rest that is decimal-grammar only if all of them
// are. The rest are counted and classified in place, so no violation is built for them.
function collect(errors: readonly ValidatorError[], first: SchemaViolation): SchemaViolation[] {
  const listed = errors.slice(0, MAX_REPORTED_VIOLATIONS).map(violation);
  // The first-error pass rejected the document, so never turn that into success.
  if (listed.length === 0) listed.push(first);
  let omitted = 0;
  let omittedAllDecimal = true;
  for (let index = MAX_REPORTED_VIOLATIONS; index < errors.length; index += 1) {
    omitted += 1;
    const error = errors[index];
    if (error === undefined || !isDecimalGrammar(error)) omittedAllDecimal = false;
  }
  if (omitted > 0) {
    listed.push({
      pointer: '',
      message: `${omitted} further violation(s) not listed`,
      decimalGrammar: omittedAllDecimal,
    });
  }
  return listed;
}

function schemaVersion(value: JsonValue): JsonValue | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return Object.hasOwn(value, 'schema_version') ? value.schema_version : undefined;
}

/**
 * The most values a parse of this contract builds: no document valid against the contract holds
 * more. Infinite for a contract whose schema is recursive.
 */
export function valueBound(contract: ContractName): number {
  const schemaMaximum: number | null = contracts[contract].maxValues;
  return schemaMaximum === null ? Number.POSITIVE_INFINITY : Math.max(MAX_NODES, schemaMaximum);
}

/** The largest value bound for which a contract gets the larger Worker byte limit. */
const SMALL_VALUE_BOUND = 100_000;

/**
 * The largest body, in UTF-8 bytes, that a Worker parses as this contract (OQ-05 §7). The API
 * refuses a larger request body with LIMIT_EXCEEDED before it parses it, and never parses a larger
 * stored artefact. A contract with a value bound of at most 100,000 gets 4 MiB: past its bound the
 * parse only checks the text. Any other contract gets 512 KiB, because its parse may build every
 * value: command/1 and strategy-artefact/1 hold a recursive Expr tree, and checkpoint/1 and
 * evaluation-result/1 can hold more than a million values. test/memory.test.ts parses, for every
 * contract at its limit, the bodies that build the most values or the most heap per byte, and the
 * invalid body whose violation listing creates the most Ajv errors, each within 64 MB, half of a
 * Worker isolate's memory.
 */
export function workerBodyLimit(contract: ContractName): number {
  return valueBound(contract) <= SMALL_VALUE_BOUND ? 4 * 1024 * 1024 : 512 * 1024;
}

/** A rejection whose listing stopped: one violation without a pointer that states why. */
function stopped(kind: ContractErrorKind, message: string) {
  return reject(kind, message, [{ pointer: '', message, decimalGrammar: false }], true);
}

/** A strict-JSON error as a rejection. A structural limit stops the listing. */
export function rejectStrictJson(error: StrictJsonError) {
  return error.kind === 'structural-limit' ? stopped(error.kind, error.message) : reject(error.kind, error.message);
}

/**
 * The checks after strict JSON: the version, an unsafe integer, a key past the key limit, the value
 * and text bounds and the schema, with the violation listing within the structural limits.
 * scanEvaluationResult (result.ts) shares them.
 */
export function checkScanned<C extends ContractName>(contract: C, scan: StrictScan): ContractResult<ContractTypes[C]> {
  const { value, unsafeInteger, longKey, exceededValueBound, exceededTextBound } = scan;
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
  if (longKey !== undefined) {
    return stopped(
      'structural-limit',
      `object key of ${longKey.bytes} bytes at offset ${longKey.offset} is longer than ${longKey.limit}; the document is not examined further`,
    );
  }
  if (exceededValueBound !== undefined) {
    return stopped(
      'value-bound',
      `document has more than ${exceededValueBound} values; the document is not examined further`,
    );
  }
  if (exceededTextBound !== undefined) {
    return stopped(
      'value-bound',
      `document has more than ${exceededTextBound} bytes of strings and keys; the document is not examined further`,
    );
  }
  // Validity is decided here, at any size.
  const quick = firstErrorValidators[contract];
  if (quick(value)) return { ok: true, value: value as unknown as ContractTypes[C] };
  const first = violation(quick.errors?.[0]);
  // The listing runs only within the structural limits, which bound its Ajv errors.
  const excess = firstExcess(value);
  if (excess !== undefined) {
    return reject('schema', 'payload violates the schema at 2 location(s)', [excess, first], true);
  }
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
    return checkScanned(
      contract,
      scanStrictJson(input, { valueBound: valueBound(contract), maxKeyBytes: MAX_KEY_BYTES }),
    );
  } catch (error) {
    if (error instanceof StrictJsonError) return rejectStrictJson(error);
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

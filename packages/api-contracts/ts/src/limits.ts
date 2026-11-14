// Structural limits that gate the full diagnostic pass of schema validation, mirroring
// packages/api-contracts/rust/src/limits.rs.
//
// Validation first runs the first-error validator, which decides validity at any size. Only an
// invalid document within these limits goes on to the all-errors validator, which lists its
// violations. A document beyond a limit reports that limit, then its first violation: the listing
// stopped (ContractError.listingStopped), and the code is SCHEMA_VIOLATION even when the first
// violation is a decimal-grammar one.
//
// The listing costs memory in proportion to the errors Ajv creates, and one value can carry up to
// 34 of them (test/support/error-bound.ts derives the most for each contract from the schemas).
// MAX_NODES therefore bounds the listing: at most 4,096 values, so at most 34 × 4,096 = 139,264
// errors. test/memory.test.ts parses the document with the most errors of every contract at its
// Worker byte limit within 64 MB. The other limits only stop the walk early.
//
// A valid document returns before this check, so the limits never reject one, although a valid
// result or checkpoint can hold more than MAX_NODES values. They do not bound the parse, which builds
// the document before validation runs. The contract's value bound and Worker byte limit bound the
// parse instead (validate.ts, strict-json.ts).
// The walk visits values in the order Rust does: arrays by index, object keys in byte order (the
// serde_json map is sorted), and stops at the first excess.

import type { SchemaViolation } from './errors.ts';
import { utf8Length } from './platform.ts';
import type { JsonObject, JsonValue } from './strict-json.ts';

/** Values in the whole document. An invalid document with more is not listed in full. */
export const MAX_NODES = 4_096;
/** Nesting depth. */
export const MAX_DEPTH = 128;
/** Items in one array. */
export const MAX_ARRAY_LEN = 8_192;
/** Properties in one object. */
export const MAX_OBJECT_KEYS = 64;
/** Bytes in one string. */
export const MAX_STRING_BYTES = 16_384;
/**
 * Bytes in the text of one object key, between its quotes, before its escapes are decoded. The
 * parse of a contract never decodes a longer key (strict-json.ts) and refuses its document with
 * SCHEMA_VIOLATION after the version check (validate.ts). Every schema closes every object, so a
 * valid document holds only declared property names. The longest is 25 bytes, and an escape writes
 * one byte as at most six, so a declared name takes at most 150 bytes of text: the limit never
 * refuses a valid document. test/keys.test.ts derives both numbers from the schemas.
 *
 * Rust has no such limit and gives the same code: its parser keeps every key, and its schema then
 * rejects the unknown property, which is never a decimal-grammar violation.
 */
export const MAX_KEY_BYTES = 256;

type Segment = number | string;
type Child = readonly [Segment, JsonValue];

interface Frame {
  readonly via: Segment | undefined;
  readonly children: Iterator<Child>;
}

function isObject(value: JsonValue): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Code point order, which is UTF-8 byte order. */
export function compareCodePoints(a: string, b: string): number {
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const x = a.codePointAt(index) ?? 0;
    const y = b.codePointAt(index) ?? 0;
    if (x !== y) return x - y;
    if (x > 0xffff) index += 1;
  }
  return a.length - b.length;
}

function* arrayChildren(items: readonly JsonValue[]): Iterator<Child> {
  for (const [index, item] of items.entries()) yield [index, item];
}

function* objectChildren(entries: JsonObject): Iterator<Child> {
  for (const key of Object.keys(entries).sort(compareCodePoints)) yield [key, entries[key] ?? null];
}

function pointer(frames: readonly Frame[], last: Segment | undefined): string {
  const segments = frames.map((frame) => frame.via).filter((segment) => segment !== undefined);
  if (last !== undefined) segments.push(last);
  return segments.map((segment) => `/${String(segment).replaceAll('~', '~0').replaceAll('/', '~1')}`).join('');
}

function exceeded(value: JsonValue, nodes: number, depth: number): string | undefined {
  if (depth >= MAX_DEPTH) return `nesting is deeper than ${MAX_DEPTH} levels`;
  if (nodes > MAX_NODES) return `document has more than ${MAX_NODES} values`;
  if (typeof value === 'string') {
    const bytes = utf8Length(value);
    if (bytes > MAX_STRING_BYTES) return `string of ${bytes} bytes is longer than ${MAX_STRING_BYTES}`;
  } else if (Array.isArray(value)) {
    if (value.length > MAX_ARRAY_LEN) return `array of ${value.length} items is longer than ${MAX_ARRAY_LEN}`;
  } else if (isObject(value)) {
    const keys = Object.keys(value).length;
    if (keys > MAX_OBJECT_KEYS) return `object of ${keys} properties is wider than ${MAX_OBJECT_KEYS}`;
  }
  return undefined;
}

/** The first value, in document order, that exceeds a structural limit. */
export function firstExcess(root: JsonValue): SchemaViolation | undefined {
  const frames: Frame[] = [];
  let nodes = 0;
  let next: readonly [Segment | undefined, JsonValue] | undefined = [undefined, root];
  for (;;) {
    if (next !== undefined) {
      const [via, value] = next;
      next = undefined;
      nodes += 1;
      const message = exceeded(value, nodes, frames.length);
      if (message !== undefined) {
        return {
          pointer: pointer(frames, via),
          message: `${message}; the document is not examined further`,
          decimalGrammar: false,
        };
      }
      if (Array.isArray(value)) frames.push({ via, children: arrayChildren(value) });
      else if (isObject(value)) frames.push({ via, children: objectChildren(value) });
    }
    const frame = frames.at(-1);
    if (frame === undefined) return undefined;
    const item = frame.children.next();
    if (item.done) frames.pop();
    else next = item.value;
  }
}

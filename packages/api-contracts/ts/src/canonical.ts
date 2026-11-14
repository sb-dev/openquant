// Canonical JSON and SHA-256 identities, mirroring packages/api-contracts/rust/src/canonical.rs.
//
// Values hold only objects with ASCII keys, arrays, strings, integers, booleans and null. Keys sort
// by byte order, which equals UTF-16 code-unit order for ASCII. The output has no insignificant
// whitespace. A string escapes `"`, `\`, the five short control escapes \b \t \n \f \r and every
// other character below U+0020 as \u00xx in lower-case hex; every other character is written as
// it is, including U+007F and non-ASCII text. The digest is SHA-256 over the UTF-8 bytes.

import { sha256Hex, utf8 } from './platform.ts';
import { MAX_NESTING } from './strict-json.ts';

/** `sha256:` and 64 lower-case hex digits. */
export type Sha256Digest = `sha256:${string}`;

/** A value with no canonical form. Rust reports the same case as SCHEMA_VIOLATION. */
export class CanonicalError extends Error {
  readonly code = 'SCHEMA_VIOLATION';

  constructor(message: string) {
    super(`cannot canonicalise payload: ${message}`);
    this.name = 'CanonicalError';
  }
}

const SHORT_ESCAPES: Readonly<Record<number, string>> = {
  34: '\\"',
  92: '\\\\',
  8: '\\b',
  9: '\\t',
  10: '\\n',
  12: '\\f',
  13: '\\r',
};

function writeString(text: string, out: string[]): void {
  out.push('"');
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdfff) {
      const low = text.charCodeAt(index + 1);
      if (code > 0xdbff || !(low >= 0xdc00 && low <= 0xdfff)) throw new CanonicalError('lone surrogate in a string');
      index += 1;
      continue;
    }
    const replacement = SHORT_ESCAPES[code] ?? (code < 0x20 ? `\\u${code.toString(16).padStart(4, '0')}` : undefined);
    if (replacement === undefined) continue;
    out.push(text.slice(start, index), replacement);
    start = index + 1;
  }
  out.push(text.slice(start), '"');
}

function isAscii(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) if (text.charCodeAt(index) > 0x7f) return false;
  return true;
}

function isPlainObject(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function writeValue(value: unknown, out: string[], depth: number): void {
  if (value === null) out.push('null');
  else if (value === true) out.push('true');
  else if (value === false) out.push('false');
  else if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new CanonicalError(`non-integer or inexact number ${value}`);
    out.push(String(value));
  } else if (typeof value === 'string') writeString(value, out);
  else if (typeof value === 'object') {
    if (depth + 1 >= MAX_NESTING) throw new CanonicalError(`nesting of ${MAX_NESTING} arrays or objects`);
    if (Array.isArray(value)) {
      out.push('[');
      for (let index = 0; index < value.length; index += 1) {
        if (index > 0) out.push(',');
        writeValue(value[index], out, depth + 1);
      }
      out.push(']');
    } else if (isPlainObject(value)) {
      const keys = Object.keys(value);
      const bad = keys.find((key) => !isAscii(key));
      if (bad !== undefined) throw new CanonicalError(`non-ASCII object key ${JSON.stringify(bad)}`);
      keys.sort();
      out.push('{');
      keys.forEach((key, index) => {
        if (index > 0) out.push(',');
        writeString(key, out);
        out.push(':');
        writeValue(value[key], out, depth + 1);
      });
      out.push('}');
    } else throw new CanonicalError('only plain objects and arrays are JSON containers');
  } else throw new CanonicalError(`${typeof value} is not a JSON value`);
}

/**
 * Canonical JSON text of a value.
 *
 * @throws CanonicalError for a non-integer or inexact number, a non-ASCII key, a lone surrogate or
 * anything that is not a JSON value.
 */
export function canonicalJson(value: unknown): string {
  const out: string[] = [];
  writeValue(value, out, 0);
  return out.join('');
}

/** `sha256:<64 lower-case hex>` of raw bytes. */
export async function digestBytes(bytes: Uint8Array): Promise<Sha256Digest> {
  return `sha256:${await sha256Hex(bytes)}`;
}

/**
 * Identity digest of a value: SHA-256 over its canonical JSON.
 *
 * @throws CanonicalError when the value has no canonical form.
 */
export async function digest(value: unknown): Promise<Sha256Digest> {
  return digestBytes(utf8.encode(canonicalJson(value)));
}

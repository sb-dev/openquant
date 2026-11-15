// Small JSON helpers for the role modules: JSON Pointer lookup, equality and string collection.
// Worker-safe: no Node module.

import { canonicalJson, type JsonObject, type JsonValue } from '@openquant/api-contracts';

export type { JsonObject, JsonValue };

export function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A typed contract value seen as plain JSON. The parsers return values built from strict JSON, so this is exact. */
export function asJson(value: unknown): JsonValue {
  return value as JsonValue;
}

export function asObject(value: unknown): JsonObject {
  if (!isObject(value)) throw new TypeError('expected a JSON object');
  return value;
}

/** Equality of two JSON values by canonical text: key order and whitespace do not matter. */
export function jsonEqual(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

const ARRAY_INDEX = /^(?:0|[1-9][0-9]*)$/;

/** One RFC 6901 token, or undefined when it holds a `~` that is not `~0` or `~1`. */
function unescapeToken(token: string): string | undefined {
  if (/~(?![01])/.test(token)) return undefined;
  return token.replaceAll('~1', '/').replaceAll('~0', '~');
}

export type PointerLookup = { readonly found: true; readonly value: JsonValue } | { readonly found: false };

/** Resolve an RFC 6901 JSON Pointer in `root`. The empty pointer is the root. */
export function resolvePointer(root: JsonValue, pointer: string): PointerLookup {
  if (pointer === '') return { found: true, value: root };
  if (!pointer.startsWith('/')) return { found: false };
  let current: JsonValue = root;
  for (const raw of pointer.slice(1).split('/')) {
    const token = unescapeToken(raw);
    if (token === undefined) return { found: false };
    if (Array.isArray(current)) {
      if (!ARRAY_INDEX.test(token)) return { found: false };
      const item: JsonValue | undefined = current[Number(token)];
      if (item === undefined) return { found: false };
      current = item;
    } else if (isObject(current)) {
      if (!Object.hasOwn(current, token)) return { found: false };
      current = current[token] as JsonValue;
    } else {
      return { found: false };
    }
  }
  return { found: true, value: current };
}

/** Escape one object key or array index as a JSON Pointer token. */
export function pointerToken(token: string | number): string {
  return String(token).replaceAll('~', '~0').replaceAll('/', '~1');
}

/** Every string value of a JSON document (object keys are not strings of the document). */
export function stringValues(value: JsonValue, out: string[] = []): string[] {
  if (typeof value === 'string') {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) stringValues(item, out);
  } else if (isObject(value)) {
    for (const child of Object.values(value)) stringValues(child, out);
  }
  return out;
}

// TextEncoder is a global in Workers and Node. The package compiles without DOM or Node type libraries.
const encoder = new (
  globalThis as unknown as { TextEncoder: new () => { encode(input: string): Uint8Array } }
).TextEncoder();

/** The UTF-8 bytes of a text, without a Node module. */
export function utf8Bytes(text: string): Uint8Array {
  return encoder.encode(text);
}

/** Cut text to at most `maximum` code points, never inside a surrogate pair. */
export function cutText(text: string, maximum: number): string {
  if (text.length <= maximum) return text;
  const points = Array.from(text);
  return points.length <= maximum ? text : points.slice(0, maximum).join('');
}

/** Printable ASCII only, for a diagnostic that may carry model-chosen text. */
export function printable(text: string): string {
  let out = '';
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    out += code >= 0x20 && code < 0x7f ? char : '?';
  }
  return out;
}

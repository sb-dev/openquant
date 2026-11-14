// Strict JSON parsing, mirroring packages/api-contracts/rust/src/strict.rs (OQ-05 §7).
//
// The Rust parser is serde_json with a visitor that rejects duplicate keys and every number that is
// not an integer. This parser accepts and rejects the same texts:
//
// - the RFC 8259 grammar, with only space, tab, line feed and carriage return as whitespace;
// - no control character below U+0020 inside a string, and no lone surrogate, escaped or not;
// - a duplicate object key, compared after unescaping, is an error;
// - a number with a fraction or an exponent is an error, and so is `-0`, an integer above 2^64 - 1
//   or an integer below -2^63 (serde_json reads all of these as floating-point numbers);
// - 128 nested arrays or objects are an error (the serde_json recursion limit);
// - a text longer than 16 MiB in UTF-8 is an error.
//
// TypeScript numbers are exact only up to 2^53 - 1, so an integer of larger magnitude is rejected
// as well. The Rust parser accepts such an integer and its schema then rejects it. To give the same
// code when the version tag is also wrong, the contract layer reports it after the version check
// (see `scanStrictJson`). Every error here is SCHEMA_VIOLATION.
//
// Memory. Building every value of a dense 16 MiB text, such as `[{},{},…]`, takes several hundred MB
// of heap, far more than a 128 MB Worker isolate. `scanStrictJson` therefore takes a value bound: the
// parser builds at most that many values. Past the bound it still reads the whole text and applies
// every rule above, so a strict-JSON error anywhere is still reported, but it keeps only the
// top-level schema_version member, which the version check needs; it keeps that member also when
// its own value is the one that passes the bound. Object keys past the bound are held as a hash and
// a text offset, not as strings. The contract layer sets the bound from the contract's schema so
// that only an invalid document can exceed it (validate.ts). The values it does build are compact:
// each array is copied off a shared stack at its exact length, and a string with escapes is decoded
// in one piece. The Worker byte limit of each contract bounds the rest (validate.ts).

import { utf8, utf8Length } from './platform.ts';

export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
export interface JsonObject {
  [key: string]: JsonValue;
}

/** Largest accepted payload, in UTF-8 bytes (`MAX_PAYLOAD_BYTES` in strict.rs). */
export const MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;
/** Nesting of this many arrays or objects is refused (the serde_json recursion limit). */
export const MAX_NESTING = 128;

export type StrictJsonErrorKind = 'too-large' | 'json' | 'duplicate-key' | 'float-number' | 'unsafe-integer';

/** A text that breaks the strict JSON rules. Every kind reports SCHEMA_VIOLATION. */
export class StrictJsonError extends Error {
  readonly code = 'SCHEMA_VIOLATION';
  readonly kind: StrictJsonErrorKind;

  constructor(kind: StrictJsonErrorKind, message: string) {
    super(message);
    this.name = 'StrictJsonError';
    this.kind = kind;
  }
}

export interface ScanOptions {
  /**
   * The most values the parse builds. A text with more values is still read to the end and checked,
   * but only its first `valueBound` values and the top-level schema_version member are kept.
   */
  readonly valueBound?: number;
}

/**
 * A parsed value, the first integer whose magnitude is above 2^53 - 1, if any, and the value bound
 * when the text holds more values than it. The value is then incomplete.
 */
export interface StrictScan {
  readonly value: JsonValue;
  readonly unsafeInteger?: string;
  readonly exceededValueBound?: number;
}

const U64_MAX = 18446744073709551615n;
const I64_MIN = -9223372036854775808n;
/** Keys an object keeps in a plain list before it moves them to a hash table. */
const SMALL_KEY_SET = 16;

const isDigit = (code: number) => code >= 0x30 && code <= 0x39;
const isHigh = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLow = (code: number) => code >= 0xdc00 && code <= 0xdfff;

/**
 * The keys of one object that were not stored on a built object. A key is held as its hash and the
 * text offset of its opening quote; equal hashes are compared by reading the keys again. The hash
 * seed is random, so a text cannot be prepared to make the keys collide.
 */
class KeySet {
  private readonly parser: Parser;
  private readonly seed: number;
  private smallKeys: string[] | undefined = [];
  private smallOffsets: number[] = [];
  private hashes = new Int32Array(0);
  private offsets = new Int32Array(0);
  private size = 0;

  constructor(parser: Parser, seed: number) {
    this.parser = parser;
    this.seed = seed;
  }

  private hash(key: string): number {
    let h = this.seed;
    for (let index = 0; index < key.length; index += 1) {
      h = Math.imul(h ^ key.charCodeAt(index), 0x5bd1e995);
      h ^= h >>> 15;
    }
    h = Math.imul(h ^ (h >>> 13), 0x5bd1e995);
    return h ^ (h >>> 15);
  }

  private insert(hash: number, offset: number, key: string | undefined): boolean {
    const mask = this.offsets.length - 1;
    let slot = hash & mask;
    for (;;) {
      const stored = this.offsets[slot] ?? -1;
      if (stored < 0) break;
      if (key !== undefined && this.hashes[slot] === hash && this.parser.keyAt(stored) === key) return true;
      slot = (slot + 1) & mask;
    }
    this.hashes[slot] = hash;
    this.offsets[slot] = offset;
    this.size += 1;
    return false;
  }

  private grow(): void {
    const hashes = this.hashes;
    const offsets = this.offsets;
    const capacity = Math.max(64, offsets.length * 2);
    this.hashes = new Int32Array(capacity);
    this.offsets = new Int32Array(capacity).fill(-1);
    this.size = 0;
    for (let slot = 0; slot < offsets.length; slot += 1) {
      const offset = offsets[slot] ?? -1;
      if (offset >= 0) this.insert(hashes[slot] ?? 0, offset, undefined);
    }
  }

  /** True when the key is already present; otherwise adds it. */
  hasOrAdd(key: string, offset: number): boolean {
    if (this.smallKeys !== undefined) {
      if (this.smallKeys.includes(key)) return true;
      this.smallKeys.push(key);
      this.smallOffsets.push(offset);
      if (this.smallKeys.length <= SMALL_KEY_SET) return false;
      const keys = this.smallKeys;
      this.smallKeys = undefined;
      this.grow();
      for (const [index, small] of keys.entries())
        this.insert(this.hash(small), this.smallOffsets[index] ?? 0, undefined);
      this.smallOffsets = [];
      return false;
    }
    if ((this.size + 1) * 2 > this.offsets.length) this.grow();
    return this.insert(this.hash(key), offset, key);
  }
}

class Parser {
  private readonly text: string;
  private readonly bound: number;
  private readonly seed = (Math.random() * 0x100000000) | 0;
  private index = 0;
  /** The items of the arrays being read, innermost last (see `parseArray`). */
  private readonly stack: JsonValue[] = [];
  private depth = 0;
  private values = 0;
  /** False once more than `bound` values were read. Values are then checked, not built. */
  private building = true;
  unsafeInteger: string | undefined;

  constructor(text: string, bound: number) {
    this.text = text;
    this.bound = bound;
  }

  get exceeded(): boolean {
    return !this.building;
  }

  fail(kind: StrictJsonErrorKind, message: string): never {
    throw new StrictJsonError(kind, `${message} at offset ${this.index}`);
  }

  skipWhitespace(): void {
    for (;;) {
      const code = this.text.charCodeAt(this.index);
      if (code !== 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) return;
      this.index += 1;
    }
  }

  parseDocument(): JsonValue {
    this.skipWhitespace();
    const value = this.parseValue(true);
    this.skipWhitespace();
    if (this.index < this.text.length) this.fail('json', 'trailing characters');
    return value;
  }

  /** The key whose opening quote is at `offset`. The text there was read once already. */
  keyAt(offset: number): string {
    const resume = this.index;
    this.index = offset;
    const key = this.parseString(true);
    this.index = resume;
    return key;
  }

  parseValue(root = false): JsonValue {
    this.values += 1;
    if (this.values > this.bound) this.building = false;
    const code = this.text.charCodeAt(this.index);
    if (code === 0x7b) return this.parseObject(root);
    if (code === 0x5b) return this.parseArray();
    if (code === 0x22) return this.parseString(this.building);
    if (code === 0x2d || isDigit(code)) return this.parseNumber();
    for (const [literal, value] of [
      ['true', true],
      ['false', false],
      ['null', null],
    ] as const) {
      if (this.text.startsWith(literal, this.index)) {
        this.index += literal.length;
        return value;
      }
    }
    return this.fail('json', Number.isNaN(code) ? 'end of text while parsing a value' : 'expected a value');
  }

  enter(): void {
    this.depth += 1;
    if (this.depth >= MAX_NESTING) this.fail('json', 'recursion limit exceeded');
    this.index += 1;
  }

  parseArray(): JsonValue[] {
    this.enter();
    this.skipWhitespace();
    if (this.text.charCodeAt(this.index) === 0x5d) {
      this.index += 1;
      this.depth -= 1;
      return [];
    }
    // Items collect on the shared stack. The array is then copied off it at its exact length:
    // V8 gives an array that grows by push room for at least 16 items, so `[[[…[0]…]]]` would
    // take about 100 bytes of heap for each byte of text instead of about 35.
    const start = this.stack.length;
    for (;;) {
      this.skipWhitespace();
      const item = this.parseValue();
      if (this.building) this.stack.push(item);
      this.skipWhitespace();
      const code = this.text.charCodeAt(this.index);
      this.index += 1;
      if (code === 0x5d) break;
      if (code !== 0x2c) this.fail('json', 'expected , or ] in an array');
    }
    this.depth -= 1;
    const items = this.stack.slice(start);
    this.stack.length = start;
    return items;
  }

  parseObject(root: boolean): JsonObject {
    this.enter();
    const out: JsonObject = {};
    // Keys read after the bound was passed: they are not stored on `out`.
    let later: KeySet | undefined;
    this.skipWhitespace();
    if (this.text.charCodeAt(this.index) === 0x7d) {
      this.index += 1;
      this.depth -= 1;
      return out;
    }
    for (;;) {
      this.skipWhitespace();
      if (this.text.charCodeAt(this.index) !== 0x22) this.fail('json', 'expected a string key');
      const offset = this.index;
      const key = this.parseString(true);
      // A key is on `out` (read while building) or in `later` (read after the bound was passed).
      if (Object.hasOwn(out, key) || later?.hasOrAdd(key, offset)) {
        this.fail('duplicate-key', `duplicate object key: ${key}`);
      }
      this.skipWhitespace();
      if (this.text.charCodeAt(this.index) !== 0x3a) this.fail('json', 'expected : after a key');
      this.index += 1;
      this.skipWhitespace();
      // The version check needs the top-level schema_version wherever it is, also when its own
      // value is the one that passes the bound. A string value is always read and stored; it
      // counts as a value like any other. Another value past the bound is stored as null, a
      // non-string.
      const keep = root && key === 'schema_version';
      const value = keep && this.text.charCodeAt(this.index) === 0x22 ? this.keptString() : this.parseValue();
      if (this.building || keep) {
        // An own property even for __proto__, as JSON.parse does.
        Object.defineProperty(out, key, {
          value: !this.building && typeof value !== 'string' ? null : value,
          enumerable: true,
          writable: true,
          configurable: true,
        });
      } else if (later === undefined) {
        // The first key that is not stored on `out`. It was checked against `out` above.
        later = new KeySet(this, this.seed);
        later.hasOrAdd(key, offset);
      }
      this.skipWhitespace();
      const code = this.text.charCodeAt(this.index);
      this.index += 1;
      if (code === 0x7d) break;
      if (code !== 0x2c) this.fail('json', 'expected , or } in an object');
    }
    this.depth -= 1;
    return out;
  }

  /** A string value that is kept even when it passes the bound. It counts as a value. */
  keptString(): string {
    this.values += 1;
    if (this.values > this.bound) this.building = false;
    return this.parseString(true);
  }

  hexEscape(): number {
    const digits = this.text.slice(this.index, this.index + 4);
    if (!/^[0-9A-Fa-f]{4}$/.test(digits)) this.fail('json', 'invalid \\u escape');
    this.index += 4;
    return Number.parseInt(digits, 16);
  }

  /** Read a string. When `keep` is false it is checked and an empty string is returned. */
  parseString(keep: boolean): string {
    const open = this.index;
    this.index += 1;
    let escaped = false;
    for (;;) {
      const code = this.text.charCodeAt(this.index);
      if (Number.isNaN(code)) this.fail('json', 'end of text while parsing a string');
      if (code === 0x22) break;
      if (code < 0x20) this.fail('json', 'control character in a string');
      if (isHigh(code)) {
        if (!isLow(this.text.charCodeAt(this.index + 1))) this.fail('json', 'lone surrogate in a string');
        this.index += 2;
        continue;
      }
      if (isLow(code)) this.fail('json', 'lone surrogate in a string');
      this.index += 1;
      if (code === 0x5c) {
        this.checkEscape();
        escaped = true;
      }
    }
    this.index += 1;
    if (!keep) return '';
    if (!escaped) return this.text.slice(open + 1, this.index - 1);
    // JSON.parse decodes the literal checked above into one flat string. Appending each decoded
    // escape instead builds a chain of string parts: 16 MiB of escapes would take about 256 MB.
    return JSON.parse(this.text.slice(open, this.index)) as string;
  }

  /** Check one escape after its backslash. */
  checkEscape(): void {
    const code = this.text.charCodeAt(this.index);
    this.index += 1;
    switch (code) {
      case 0x22:
      case 0x5c:
      case 0x2f:
      case 0x62:
      case 0x66:
      case 0x6e:
      case 0x72:
      case 0x74:
        return;
      case 0x75: {
        const unit = this.hexEscape();
        if (isLow(unit)) this.fail('json', 'lone surrogate in a \\u escape');
        if (!isHigh(unit)) return;
        if (this.text.charCodeAt(this.index) !== 0x5c || this.text.charCodeAt(this.index + 1) !== 0x75) {
          this.fail('json', 'unexpected end of a surrogate pair escape');
        }
        this.index += 2;
        const low = this.hexEscape();
        if (!isLow(low)) this.fail('json', 'lone surrogate in a \\u escape');
        return;
      }
      default:
        this.fail('json', 'invalid escape');
    }
  }

  digits(): void {
    if (!isDigit(this.text.charCodeAt(this.index))) this.fail('json', 'invalid number');
    while (isDigit(this.text.charCodeAt(this.index))) this.index += 1;
  }

  parseNumber(): number {
    const start = this.index;
    const negative = this.text.charCodeAt(this.index) === 0x2d;
    if (negative) this.index += 1;
    if (this.text.charCodeAt(this.index) === 0x30) {
      this.index += 1;
      if (isDigit(this.text.charCodeAt(this.index))) this.fail('json', 'invalid number');
    } else {
      this.digits();
    }
    const integerEnd = this.index;
    let float = false;
    if (this.text.charCodeAt(this.index) === 0x2e) {
      this.index += 1;
      this.digits();
      float = true;
    }
    const exponent = this.text.charCodeAt(this.index);
    if (exponent === 0x65 || exponent === 0x45) {
      this.index += 1;
      const sign = this.text.charCodeAt(this.index);
      if (sign === 0x2b || sign === 0x2d) this.index += 1;
      this.digits();
      float = true;
    }
    const literal = this.text.slice(start, integerEnd);
    if (float || literal === '-0') {
      this.fail('float-number', 'floating-point number is not allowed: use an integer or a decimal string');
    }
    // 15 digits are always within 2^53 - 1.
    if (literal.length - (negative ? 1 : 0) <= 15) return Number(literal);
    const big = BigInt(literal);
    if (big > U64_MAX || big < I64_MIN) {
      this.fail('float-number', 'integer outside the 64-bit range is read as a floating-point number');
    }
    const value = Number(literal);
    if (!Number.isSafeInteger(value)) this.unsafeInteger ??= literal;
    return value;
  }
}

/**
 * Parse strict JSON text, or UTF-8 bytes (invalid UTF-8 is an error), and report the first integer
 * whose magnitude is above 2^53 - 1 instead of rejecting it. The contract layer rejects it after the
 * version check. With a value bound, a text with more values is still checked to its end, but the
 * result keeps only its first values and its top-level schema_version, and names the bound. Use
 * `parseStrictJson` everywhere else.
 *
 * @throws StrictJsonError
 */
export function scanStrictJson(input: string | Uint8Array, options: ScanOptions = {}): StrictScan {
  let text: string;
  if (typeof input === 'string') {
    if (input.length > MAX_PAYLOAD_BYTES / 3 && utf8Length(input) > MAX_PAYLOAD_BYTES) {
      throw new StrictJsonError('too-large', `payload exceeds ${MAX_PAYLOAD_BYTES} bytes`);
    }
    text = input;
  } else {
    if (input.byteLength > MAX_PAYLOAD_BYTES) {
      throw new StrictJsonError('too-large', `payload exceeds ${MAX_PAYLOAD_BYTES} bytes`);
    }
    const decoded = utf8.decode(input);
    if (decoded === undefined) throw new StrictJsonError('json', 'payload is not valid UTF-8');
    text = decoded;
  }
  const bound = options.valueBound ?? Number.POSITIVE_INFINITY;
  const parser = new Parser(text, bound);
  const value = parser.parseDocument();
  return {
    value,
    ...(parser.unsafeInteger === undefined ? {} : { unsafeInteger: parser.unsafeInteger }),
    ...(parser.exceeded ? { exceededValueBound: bound } : {}),
  };
}

/**
 * Parse strict JSON. Duplicate keys, non-integer numbers and integers whose magnitude is above
 * 2^53 - 1 are errors.
 *
 * @throws StrictJsonError
 */
export function parseStrictJson(input: string | Uint8Array): JsonValue {
  const { value, unsafeInteger } = scanStrictJson(input);
  if (unsafeInteger !== undefined) {
    throw new StrictJsonError('unsafe-integer', `integer ${unsafeInteger} is outside the exact range of 2^53 - 1`);
  }
  return value;
}

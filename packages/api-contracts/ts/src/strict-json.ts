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

/** A parsed value, and the first integer whose magnitude is above 2^53 - 1, if any. */
export interface StrictScan {
  readonly value: JsonValue;
  readonly unsafeInteger?: string;
}

const U64_MAX = 18446744073709551615n;
const I64_MIN = -9223372036854775808n;

const isDigit = (code: number) => code >= 0x30 && code <= 0x39;
const isHigh = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLow = (code: number) => code >= 0xdc00 && code <= 0xdfff;

class Parser {
  private readonly text: string;
  private index = 0;
  private depth = 0;
  unsafeInteger: string | undefined;

  constructor(text: string) {
    this.text = text;
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
    const value = this.parseValue();
    this.skipWhitespace();
    if (this.index < this.text.length) this.fail('json', 'trailing characters');
    return value;
  }

  parseValue(): JsonValue {
    const code = this.text.charCodeAt(this.index);
    if (code === 0x7b) return this.parseObject();
    if (code === 0x5b) return this.parseArray();
    if (code === 0x22) return this.parseString();
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
    const items: JsonValue[] = [];
    this.skipWhitespace();
    if (this.text.charCodeAt(this.index) === 0x5d) {
      this.index += 1;
      this.depth -= 1;
      return items;
    }
    for (;;) {
      this.skipWhitespace();
      items.push(this.parseValue());
      this.skipWhitespace();
      const code = this.text.charCodeAt(this.index);
      this.index += 1;
      if (code === 0x5d) break;
      if (code !== 0x2c) this.fail('json', 'expected , or ] in an array');
    }
    this.depth -= 1;
    return items;
  }

  parseObject(): JsonObject {
    this.enter();
    const out: JsonObject = {};
    this.skipWhitespace();
    if (this.text.charCodeAt(this.index) === 0x7d) {
      this.index += 1;
      this.depth -= 1;
      return out;
    }
    for (;;) {
      this.skipWhitespace();
      if (this.text.charCodeAt(this.index) !== 0x22) this.fail('json', 'expected a string key');
      const key = this.parseString();
      if (Object.hasOwn(out, key)) this.fail('duplicate-key', `duplicate object key: ${key}`);
      this.skipWhitespace();
      if (this.text.charCodeAt(this.index) !== 0x3a) this.fail('json', 'expected : after a key');
      this.index += 1;
      this.skipWhitespace();
      // An own property even for __proto__, as JSON.parse does.
      Object.defineProperty(out, key, {
        value: this.parseValue(),
        enumerable: true,
        writable: true,
        configurable: true,
      });
      this.skipWhitespace();
      const code = this.text.charCodeAt(this.index);
      this.index += 1;
      if (code === 0x7d) break;
      if (code !== 0x2c) this.fail('json', 'expected , or } in an object');
    }
    this.depth -= 1;
    return out;
  }

  hexEscape(): number {
    const digits = this.text.slice(this.index, this.index + 4);
    if (!/^[0-9A-Fa-f]{4}$/.test(digits)) this.fail('json', 'invalid \\u escape');
    this.index += 4;
    return Number.parseInt(digits, 16);
  }

  parseString(): string {
    this.index += 1;
    let out = '';
    let start = this.index;
    for (;;) {
      const code = this.text.charCodeAt(this.index);
      if (Number.isNaN(code)) this.fail('json', 'end of text while parsing a string');
      if (code === 0x22) {
        out += this.text.slice(start, this.index);
        this.index += 1;
        return out;
      }
      if (code < 0x20) this.fail('json', 'control character in a string');
      if (isHigh(code)) {
        if (!isLow(this.text.charCodeAt(this.index + 1))) this.fail('json', 'lone surrogate in a string');
        this.index += 2;
        continue;
      }
      if (isLow(code)) this.fail('json', 'lone surrogate in a string');
      if (code !== 0x5c) {
        this.index += 1;
        continue;
      }
      out += this.text.slice(start, this.index);
      this.index += 1;
      out += this.parseEscape();
      start = this.index;
    }
  }

  parseEscape(): string {
    const code = this.text.charCodeAt(this.index);
    this.index += 1;
    switch (code) {
      case 0x22:
        return '"';
      case 0x5c:
        return '\\';
      case 0x2f:
        return '/';
      case 0x62:
        return '\b';
      case 0x66:
        return '\f';
      case 0x6e:
        return '\n';
      case 0x72:
        return '\r';
      case 0x74:
        return '\t';
      case 0x75: {
        const unit = this.hexEscape();
        if (isLow(unit)) this.fail('json', 'lone surrogate in a \\u escape');
        if (!isHigh(unit)) return String.fromCharCode(unit);
        if (this.text.charCodeAt(this.index) !== 0x5c || this.text.charCodeAt(this.index + 1) !== 0x75) {
          this.fail('json', 'unexpected end of a surrogate pair escape');
        }
        this.index += 2;
        const low = this.hexEscape();
        if (!isLow(low)) this.fail('json', 'lone surrogate in a \\u escape');
        return String.fromCharCode(unit, low);
      }
      default:
        return this.fail('json', 'invalid escape');
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
 * version check. Use `parseStrictJson` everywhere else.
 *
 * @throws StrictJsonError
 */
export function scanStrictJson(input: string | Uint8Array): StrictScan {
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
  const parser = new Parser(text);
  const value = parser.parseDocument();
  return parser.unsafeInteger === undefined ? { value } : { value, unsafeInteger: parser.unsafeInteger };
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

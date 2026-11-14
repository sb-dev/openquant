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
// its own value is the one that passes the bound. The contract layer sets the bound from the
// contract's schema so that only an invalid document can exceed it (validate.ts). The values it does
// build are compact: each array is copied off a shared stack at its exact length, and a string with
// escapes is decoded in one piece. The Worker byte limit of each contract bounds the rest
// (validate.ts).
//
// Object keys. A key is read without copying it: the parser measures it, in the bytes of its text
// and of its decoded form, and hashes its decoded code units. It decodes a key only when the key is
// stored on a built object or compared with one, and only when the decoded key is within the key
// limit (`maxKeyBytes`). Every other key is held in its object's key set as the text offset of its
// opening quote and bits of its hash (KeySet, below), and two keys that may be equal are compared by
// reading both texts again, one decoded code unit at a time. The hash seed is random, so a text
// cannot be prepared to make keys collide.
// A key whose text is longer than the key limit is never decoded or stored: the scan names the
// first one, stops building values, and reads the rest of the text with every rule, duplicate keys
// included. The contract layer reports it after the version check, as Rust would reach its schema
// with it.
//
// A scan can also skip top-level members: it reads them with every rule but builds none of their
// values and does not count them towards the value bound. With structural limits it checks the
// length of every array, object and string value over the whole text, built or not, before it
// decodes a string. With a text bound it stops building once the strings and keys it built hold
// more decoded bytes than the bound. The check of a submitted result uses all three (result.ts).

import { utf8, utf8Length } from './platform.ts';

export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
export interface JsonObject {
  [key: string]: JsonValue;
}

/** Largest accepted payload, in UTF-8 bytes (`MAX_PAYLOAD_BYTES` in strict.rs). */
export const MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;
/** Nesting of this many arrays or objects is refused (the serde_json recursion limit). */
export const MAX_NESTING = 128;

export type StrictJsonErrorKind =
  | 'too-large'
  | 'json'
  | 'duplicate-key'
  | 'float-number'
  | 'unsafe-integer'
  | 'structural-limit';

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

/** Structural limits that a scan checks over the whole text, built or not (limits.ts). */
export interface ScanLimits {
  /** Items in one array. */
  readonly maxArrayItems: number;
  /** Properties in one object. */
  readonly maxObjectKeys: number;
  /** UTF-8 bytes of one string value, after its escapes are decoded. */
  readonly maxStringBytes: number;
}

export interface ScanOptions {
  /**
   * The most values the parse builds. A text with more values is still read to the end and checked,
   * but only its first `valueBound` values and the top-level schema_version member are kept.
   */
  readonly valueBound?: number;
  /**
   * The longest object key, in UTF-8 bytes of its text between the quotes. A longer key is never
   * decoded: the scan names the first one in `longKey` and builds no more values.
   */
  readonly maxKeyBytes?: number;
  /**
   * Top-level members that are read with every rule but never built, and whose values do not count
   * towards the value bound. The scan names those present in `skipped`.
   */
  readonly skip?: readonly string[];
  /** Structural limits to check over the whole text. An excess is a structural-limit error. */
  readonly limits?: ScanLimits;
  /**
   * The most decoded UTF-8 bytes of the strings and keys that the parse builds. Past it the parse
   * builds no more values, as past the value bound, and names the bound in `exceededTextBound`.
   */
  readonly textBound?: number;
}

/** The first object key longer than the key limit: its opening quote, its text bytes and the limit. */
export interface LongKey {
  readonly offset: number;
  readonly bytes: number;
  readonly limit: number;
}

/**
 * A parsed value, the first integer whose magnitude is above 2^53 - 1, if any, the first key longer
 * than the key limit, if any, and the value bound or text bound when the text holds more than that.
 * The value is then incomplete. `skipped` names the skipped top-level members that the text holds,
 * in text order.
 */
export interface StrictScan {
  readonly value: JsonValue;
  readonly unsafeInteger?: string;
  readonly longKey?: LongKey;
  readonly exceededValueBound?: number;
  readonly exceededTextBound?: number;
  readonly skipped?: readonly string[];
}

const U64_MAX = 18446744073709551615n;
const I64_MIN = -9223372036854775808n;
/** Digits of 2^64 - 1. An integer with more is outside the 64-bit range. */
const U64_DIGITS = 20;
/** Keys an object keeps in a plain list before it moves them to a hash table. */
export const SMALL_KEY_SET = 16;
/** Slots of the first hash table of an object's keys. */
export const KEY_TABLE_MIN_SLOTS = 64;
/** The most keys a hash table of `slots` slots holds, three quarters of them. One more doubles it. */
export const keyTableHolds = (slots: number) => Math.floor((slots * 3) / 4);

const isDigit = (code: number) => code >= 0x30 && code <= 0x39;
const isHigh = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLow = (code: number) => code >= 0xdc00 && code <= 0xdfff;

/** The value of one hexadecimal digit, or -1. */
function hexDigit(code: number): number {
  if (code >= 0x30 && code <= 0x39) return code - 0x30;
  if (code >= 0x41 && code <= 0x46) return code - 0x37;
  if (code >= 0x61 && code <= 0x66) return code - 0x57;
  return -1;
}

/** One step of the key hash, over one decoded UTF-16 code unit. */
function mix(hash: number, unit: number): number {
  const h = Math.imul(hash ^ unit, 0x5bd1e995);
  return h ^ (h >>> 15);
}

function finish(hash: number): number {
  const h = Math.imul(hash ^ (hash >>> 13), 0x5bd1e995);
  return h ^ (h >>> 15);
}

/** The bits of a key-table slot that hold the key's text offset. */
const OFFSET_BITS = 0xffffff;

/**
 * The keys of one object that were not stored on a built object, each held as the text offset of its
 * opening quote and its hash, or bits of it, without its text. Keys that may be equal are compared
 * by reading their texts again, so a duplicate is found exactly, whatever the length of the key.
 *
 * Past SMALL_KEY_SET keys the set is a table of 32-bit slots, searched by linear probing from the
 * low bits of the hash. A slot holds the offset in its low 24 bits, as a text has at most
 * MAX_PAYLOAD_BYTES = 2^24 code units, and the top 8 bits of the hash above them. Keys whose slots
 * have the same top 8 bits are compared by their texts. A slot of 0 is empty: a key's opening quote
 * always follows the brace of its object. The table holds at most three quarters of its slots and
 * doubles when one more key would pass that, hashing each key again from the text. So n keys take
 * at most 4 × 8n/3 bytes, about 11 bytes a key; a doubling briefly adds the old table, half as
 * large, and the tables it leaves behind take as much again until they are collected. The parse
 * allocates nothing else for a key it does not build.
 */
class KeySet {
  private readonly parser: Parser;
  /** Hash and offset pairs while the set is small. */
  private small: number[] | undefined = [];
  private table = new Int32Array(0);
  private size = 0;

  constructor(parser: Parser) {
    this.parser = parser;
  }

  private insert(hash: number, offset: number, check: boolean): boolean {
    const table = this.table;
    const mask = table.length - 1;
    const slot = (hash & ~OFFSET_BITS) | offset;
    let at = hash & mask;
    for (;;) {
      const stored = table[at] ?? 0;
      if (stored === 0) break;
      if (check && (stored ^ slot) >>> 24 === 0 && this.parser.sameKey(stored & OFFSET_BITS, offset)) return true;
      at = (at + 1) & mask;
    }
    table[at] = slot;
    this.size += 1;
    return false;
  }

  private grow(): void {
    const old = this.table;
    this.table = new Int32Array(Math.max(KEY_TABLE_MIN_SLOTS, 2 * old.length));
    this.size = 0;
    for (const stored of old) {
      if (stored === 0) continue;
      const offset = stored & OFFSET_BITS;
      this.insert(this.parser.hashKeyAt(offset), offset, false);
    }
  }

  /** True when a key equal to the key at `offset` is already present; otherwise adds it. */
  hasOrAdd(hash: number, offset: number): boolean {
    const small = this.small;
    if (small !== undefined) {
      for (let index = 0; index < small.length; index += 2) {
        if (small[index] === hash && this.parser.sameKey(small[index + 1] ?? 0, offset)) return true;
      }
      small.push(hash, offset);
      if (small.length <= 2 * SMALL_KEY_SET) return false;
      this.small = undefined;
      this.grow();
      for (let index = 0; index < small.length; index += 2)
        this.insert(small[index] ?? 0, small[index + 1] ?? 0, false);
      return false;
    }
    if (this.size + 1 > keyTableHolds(this.table.length)) this.grow();
    return this.insert(hash, offset, true);
  }
}

/** The UTF-8 bytes of one UTF-16 code unit outside a surrogate pair. */
const utf8Bytes = (code: number) => (code < 0x80 ? 1 : code < 0x800 ? 2 : 3);

class Parser {
  private readonly text: string;
  private readonly bound: number;
  private readonly maxKeyBytes: number;
  private readonly skip: ReadonlySet<string>;
  private readonly limits: ScanLimits | undefined;
  private readonly textBound: number;
  /** The skipped top-level members present, in text order. */
  readonly skipped: string[] = [];
  /** The last string read by `scanString`: its decoded UTF-8 bytes. */
  private stringBytes = 0;
  /** The last string read: the UTF-8 bytes of its text between the quotes. */
  private rawBytes = 0;
  /** The last string read: whether it holds an escape. */
  private escaped = false;
  /** The last string read with hashing: the hash of its decoded code units. */
  private keyHash = 0;
  /** The low surrogate of the last escape read, or -1. */
  private escapeLow = -1;
  /** The position after the last code unit read by `unitAt`. */
  private nextUnit = 0;
  private readonly seed = (Math.random() * 0x100000000) | 0;
  private index = 0;
  /** The items of the arrays being read, innermost last (see `parseArray`). */
  private readonly stack: JsonValue[] = [];
  private depth = 0;
  private values = 0;
  /** Decoded UTF-8 bytes of the strings and keys built so far. */
  private builtText = 0;
  /**
   * False once more than `bound` values were read, once a key longer than the key limit was read,
   * or once the built text passed the text bound. Values are then checked, not built.
   */
  private building = true;
  unsafeInteger: string | undefined;
  longKey: LongKey | undefined;
  exceededText = false;

  constructor(text: string, options: ScanOptions) {
    this.text = text;
    this.bound = options.valueBound ?? Number.POSITIVE_INFINITY;
    this.maxKeyBytes = options.maxKeyBytes ?? Number.POSITIVE_INFINITY;
    this.skip = new Set(options.skip ?? []);
    this.limits = options.limits;
    this.textBound = options.textBound ?? Number.POSITIVE_INFINITY;
  }

  get exceeded(): boolean {
    return this.values > this.bound;
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

  /** Count one value, and stop building past the value bound. */
  countValue(): void {
    this.values += 1;
    if (this.values > this.bound) this.building = false;
  }

  /**
   * Add `bytes` of decoded text to what the parse built, or stop building when that would pass the
   * text bound. True when the text may be built.
   */
  buildText(bytes: number): boolean {
    if (!this.building) return false;
    if (this.builtText + bytes > this.textBound) {
      this.exceededText = true;
      this.building = false;
      return false;
    }
    this.builtText += bytes;
    return true;
  }

  parseValue(root = false): JsonValue {
    this.countValue();
    const code = this.text.charCodeAt(this.index);
    if (code === 0x7b) return this.parseObject(root);
    if (code === 0x5b) return this.parseArray();
    if (code === 0x22) {
      const open = this.index;
      this.scanString(false);
      this.checkStringBytes();
      return this.buildText(this.stringBytes) ? this.decodeString(open) : '';
    }
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

  /** With limits, a string value longer than the limit is an error. Called before it is decoded. */
  checkStringBytes(): void {
    if (this.limits !== undefined && this.stringBytes > this.limits.maxStringBytes) {
      this.fail('structural-limit', `string of ${this.stringBytes} bytes is longer than ${this.limits.maxStringBytes}`);
    }
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
    const maxItems = this.limits?.maxArrayItems ?? Number.POSITIVE_INFINITY;
    for (let items = 1; ; items += 1) {
      if (items > maxItems) this.fail('structural-limit', `array of more than ${maxItems} items`);
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

  /** Name the first key longer than the key limit, and build no more values. */
  noteLongKey(offset: number): void {
    this.longKey ??= { offset, bytes: this.rawBytes, limit: this.maxKeyBytes };
    this.building = false;
  }

  parseObject(root: boolean): JsonObject {
    this.enter();
    const out: JsonObject = {};
    // Keys stored on `out`. Every other key is held in `later`, as a hash and a text offset.
    let stored = 0;
    let later: KeySet | undefined;
    this.skipWhitespace();
    if (this.text.charCodeAt(this.index) === 0x7d) {
      this.index += 1;
      this.depth -= 1;
      return out;
    }
    const maxKeys = this.limits?.maxObjectKeys ?? Number.POSITIVE_INFINITY;
    for (let keys = 1; ; keys += 1) {
      if (keys > maxKeys) this.fail('structural-limit', `object of more than ${maxKeys} properties`);
      this.skipWhitespace();
      if (this.text.charCodeAt(this.index) !== 0x22) this.fail('json', 'expected a string key');
      const offset = this.index;
      this.scanString(true);
      const hash = this.keyHash;
      const keyBytes = this.stringBytes;
      const long = this.rawBytes > this.maxKeyBytes;
      if (long) this.noteLongKey(offset);
      // The key is decoded only when it may be stored on `out`, compared with a key stored there, or,
      // at the top level, compared with schema_version and the skipped members; and only when it
      // decodes to at most the key limit. A key stored on `out` has a text within the limit, so a
      // key that decodes to more cannot equal one.
      const needed = root || stored > 0 || (this.building && !long);
      const key = needed && keyBytes <= this.maxKeyBytes ? this.decodeString(offset) : undefined;
      if ((key !== undefined && stored > 0 && Object.hasOwn(out, key)) || later?.hasOrAdd(hash, offset)) {
        this.fail('duplicate-key', `duplicate object key${key === undefined ? '' : `: ${key}`}`);
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
      // A skipped member is read with every rule but not built, and its values are not counted.
      const skipped = root && key !== undefined && this.skip.has(key);
      let value: JsonValue = null;
      if (skipped) {
        const values = this.values;
        this.building = false;
        this.parseValue();
        this.values = values;
        this.building = !this.exceeded && this.longKey === undefined && !this.exceededText;
        this.skipped.push(key);
      } else if (keep && this.text.charCodeAt(this.index) === 0x22) {
        value = this.keptString();
      } else {
        value = this.parseValue();
      }
      if (key !== undefined && !long && !skipped && (keep || this.buildText(keyBytes))) {
        // An own property even for __proto__, as JSON.parse does.
        Object.defineProperty(out, key, {
          value: !this.building && typeof value !== 'string' ? null : value,
          enumerable: true,
          writable: true,
          configurable: true,
        });
        stored += 1;
      } else if (later === undefined) {
        // The first key that is not stored on `out`. It was checked against `out` above.
        later = new KeySet(this);
        later.hasOrAdd(hash, offset);
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
    this.countValue();
    const open = this.index;
    this.scanString(false);
    this.checkStringBytes();
    this.buildText(this.stringBytes);
    return this.decodeString(open);
  }

  /**
   * Check one escape after its backslash. Return the decoded code unit, and set `escapeLow` to the
   * low surrogate of an escaped pair, or to -1.
   */
  checkEscape(): number {
    const code = this.text.charCodeAt(this.index);
    this.index += 1;
    this.escapeLow = -1;
    switch (code) {
      case 0x22:
      case 0x5c:
      case 0x2f:
        return code;
      case 0x62:
        return 0x08;
      case 0x66:
        return 0x0c;
      case 0x6e:
        return 0x0a;
      case 0x72:
        return 0x0d;
      case 0x74:
        return 0x09;
      case 0x75: {
        const unit = this.hexEscape();
        if (isLow(unit)) this.fail('json', 'lone surrogate in a \\u escape');
        if (!isHigh(unit)) return unit;
        if (this.text.charCodeAt(this.index) !== 0x5c || this.text.charCodeAt(this.index + 1) !== 0x75) {
          this.fail('json', 'unexpected end of a surrogate pair escape');
        }
        this.index += 2;
        const low = this.hexEscape();
        if (!isLow(low)) this.fail('json', 'lone surrogate in a \\u escape');
        this.escapeLow = low;
        return unit;
      }
      default:
        return this.fail('json', 'invalid escape');
    }
  }

  /** Read four hexadecimal digits without copying them. */
  hexEscape(): number {
    let unit = 0;
    for (let digit = 0; digit < 4; digit += 1) {
      const value = hexDigit(this.text.charCodeAt(this.index + digit));
      if (value < 0) this.fail('json', 'invalid \\u escape');
      unit = unit * 16 + value;
    }
    this.index += 4;
    return unit;
  }

  /**
   * Read and check a string without copying it, from its opening quote to after its closing quote.
   * Set `stringBytes`, `rawBytes` and `escaped`, and with `hashing` the hash of its decoded code
   * units in `keyHash`.
   */
  scanString(hashing: boolean): void {
    this.index += 1;
    let escaped = false;
    let bytes = 0;
    let raw = 0;
    let hash = this.seed;
    for (;;) {
      const code = this.text.charCodeAt(this.index);
      if (Number.isNaN(code)) this.fail('json', 'end of text while parsing a string');
      if (code === 0x22) break;
      if (code < 0x20) this.fail('json', 'control character in a string');
      if (isHigh(code)) {
        const low = this.text.charCodeAt(this.index + 1);
        if (!isLow(low)) this.fail('json', 'lone surrogate in a string');
        this.index += 2;
        bytes += 4;
        raw += 4;
        if (hashing) hash = mix(mix(hash, code), low);
        continue;
      }
      if (isLow(code)) this.fail('json', 'lone surrogate in a string');
      if (code === 0x5c) {
        const start = this.index;
        this.index += 1;
        const unit = this.checkEscape();
        const low = this.escapeLow;
        bytes += low < 0 ? utf8Bytes(unit) : 4;
        raw += this.index - start;
        escaped = true;
        if (hashing) hash = low < 0 ? mix(hash, unit) : mix(mix(hash, unit), low);
        continue;
      }
      this.index += 1;
      const size = utf8Bytes(code);
      bytes += size;
      raw += size;
      if (hashing) hash = mix(hash, code);
    }
    this.index += 1;
    this.stringBytes = bytes;
    this.rawBytes = raw;
    this.escaped = escaped;
    if (hashing) this.keyHash = finish(hash);
  }

  /** The decoded string whose opening quote is at `open`, after `scanString` read it. */
  decodeString(open: number): string {
    if (!this.escaped) return this.text.slice(open + 1, this.index - 1);
    // JSON.parse decodes the literal checked above into one flat string. Appending each decoded
    // escape instead builds a chain of string parts: 16 MiB of escapes would take about 256 MB.
    return JSON.parse(this.text.slice(open, this.index)) as string;
  }

  /** The decoded code unit at `at` in a string that was checked; sets `nextUnit` past it. */
  unitAt(at: number): number {
    const code = this.text.charCodeAt(at);
    if (code !== 0x5c) {
      this.nextUnit = at + 1;
      return code;
    }
    const kind = this.text.charCodeAt(at + 1);
    if (kind === 0x75) {
      this.nextUnit = at + 6;
      let unit = 0;
      for (let digit = 2; digit < 6; digit += 1) unit = unit * 16 + hexDigit(this.text.charCodeAt(at + digit));
      return unit;
    }
    this.nextUnit = at + 2;
    switch (kind) {
      case 0x62:
        return 0x08;
      case 0x66:
        return 0x0c;
      case 0x6e:
        return 0x0a;
      case 0x72:
        return 0x0d;
      case 0x74:
        return 0x09;
      default:
        return kind;
    }
  }

  /** The hash of the checked key whose opening quote is at `open`, as `scanString` computed it. */
  hashKeyAt(open: number): number {
    let hash = this.seed;
    // An unescaped quote ends a key; an escaped one starts with a backslash.
    for (let at = open + 1; this.text.charCodeAt(at) !== 0x22; at = this.nextUnit) hash = mix(hash, this.unitAt(at));
    return finish(hash);
  }

  /** True when the checked keys whose opening quotes are at `a` and `b` decode to the same text. */
  sameKey(a: number, b: number): boolean {
    let p = a + 1;
    let q = b + 1;
    for (;;) {
      // An unescaped quote ends a key; an escaped one starts with a backslash.
      const endP = this.text.charCodeAt(p) === 0x22;
      const endQ = this.text.charCodeAt(q) === 0x22;
      if (endP || endQ) return endP && endQ;
      const x = this.unitAt(p);
      p = this.nextUnit;
      const y = this.unitAt(q);
      q = this.nextUnit;
      if (x !== y) return false;
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
    const digits = integerEnd - start - (negative ? 1 : 0);
    if (float || (negative && digits === 1 && this.text.charCodeAt(start + 1) === 0x30)) {
      this.fail('float-number', 'floating-point number is not allowed: use an integer or a decimal string');
    }
    // 15 digits are always within 2^53 - 1. More than 20 are always outside the 64-bit range, and
    // are refused without reading them as a BigInt.
    if (digits <= 15) return Number(this.text.slice(start, integerEnd));
    const literal = this.text.slice(start, integerEnd);
    const big = digits > U64_DIGITS ? undefined : BigInt(literal);
    if (big === undefined || big > U64_MAX || big < I64_MIN) {
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
 * result keeps only its first values and its top-level schema_version, and names the bound. With a
 * key limit, the first longer key is named, not decoded. Use `parseStrictJson` everywhere else.
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
  const parser = new Parser(text, options);
  const value = parser.parseDocument();
  return {
    value,
    ...(parser.unsafeInteger === undefined ? {} : { unsafeInteger: parser.unsafeInteger }),
    ...(parser.longKey === undefined ? {} : { longKey: parser.longKey }),
    ...(parser.exceeded ? { exceededValueBound: options.valueBound ?? Number.POSITIVE_INFINITY } : {}),
    ...(parser.exceededText ? { exceededTextBound: options.textBound ?? Number.POSITIVE_INFINITY } : {}),
    ...(options.skip === undefined ? {} : { skipped: parser.skipped }),
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

// Parses one dense body as a contract and prints the outcome and the peak memory as JSON.
// test/memory.test.ts runs it in a child process under `node --max-old-space-size=128`, the memory
// of a Worker isolate.
//
// Usage: node dense-body.ts <shape> <contract> <bytes> [unbounded]
//
// Each shape puts the most JSON values, or the most heap per byte, that the parser can be made to
// build into exactly <bytes> bytes (trailing spaces pad the rest):
//
// zeros       {"schema_version":"<tag>","violations":[0,0,…]}
// arrays      {"schema_version":"<tag>","violations":[[],[],…]}
// objects     {"schema_version":"<tag>","violations":[{},{},…]}
// singletons  {"schema_version":"<tag>","violations":[[0],[0],…]}: each array holds one item
// nested      {"schema_version":"<tag>","violations":[[[…[0]…]],…]}: chains of 100 arrays
// keys        {"schema_version":"<tag>","k0":0,"k1":0,…} with distinct keys
// shapes      {"schema_version":"<tag>","violations":[{"0":0},{"1":0},…]}: each key is new, so
//             each object has a new hidden class
// escapes     {"schema_version":"<tag>","violations":"\n\n…"}: one string of escapes
// wide        {"schema_version":"<tag>","violations":"\naa…a一"}: one escape and one character
//             outside Latin-1, so the text and the decoded string take two bytes a character
// long-key    {"schema_version":"<tag>","\naa…a一":0}: one key of the same form that fills the body
// nested-key  {"schema_version":"<tag>","violations":{"\naa…a一":0}}: the same key one level down
//
// The set shapes put the most keys that the parse holds only in its key sets (strict-json.ts
// KeySet), without decoding them. A first member stops building: "y" holds zeros until the document
// passes the value bound, or, in the shapes ending in -long, a key one byte longer than
// MAX_KEY_BYTES has the value 0. Member "x" then holds keys with the value 0, each object's keys distinct and shortest
// first: the 93 one-character ASCII keys that need no escape, the 1,920 one-character keys of two
// UTF-8 bytes, which make the text two bytes a character, the 8,649 two-character ASCII keys, then
// three-character ASCII keys, until the body is full.
//
// set-keys            {"schema_version":"<tag>","y":[0,0,…],"x":{" ":0,"!":0,…}}: one object
// set-objects         {"schema_version":"<tag>","y":[0,0,…],"x":{" ":0,…,"…":{" ":0,…,"…":{…}}}}:
//                     the same keys spread over nested objects, each the value of the last key of
//                     the one before. Each object holds one key more than the table of the next
//                     smaller size takes, the smallest object first, so every table is twice as
//                     large as its keys need, and all of them are live at once
// set-keys-long       set-keys after a long key, which costs fewer bytes than the value bound
// set-objects-long    set-objects after a long key
//
// errors      the document of the contract whose violation listing creates the most Ajv errors
//             (support/error-shape.ts), with MAX_NODES values, so the listing runs
// errors-wide the same, with long strings under an extra key in place of some items: each string
//             holds MAX_STRING_BYTES bytes and one character outside Latin-1, so the strings and
//             the decoded text take two bytes a character while the listing runs
//
// "unbounded" parses the body with parseStrictJson, which builds every value, as a control.
//
// For the errors shapes the child also reports how many values the document holds and how many
// errors the all-errors validator creates for it, counted after the measurement.
//
// The peak is the largest heap V8 reported before any garbage collection during the parse, or
// after the parse. External memory holds the body bytes, typed arrays and, in Node, the decoded
// text; peakTotalMiB adds it to the heap, and test/memory.test.ts checks that sum.

import { GCProfiler, getHeapStatistics } from 'node:v8';
import { byContract as allErrorValidators } from '../../dist/generated/validators-all.js';
import { contracts, isContractName, parseContract, parseStrictJson, valueBound } from '../../src/index.ts';
import { MAX_KEY_BYTES, MAX_NODES, MAX_STRING_BYTES } from '../../src/limits.ts';
import { KEY_TABLE_MIN_SLOTS, keyTableHolds, SMALL_KEY_SET } from '../../src/strict-json.ts';
import { errorShape } from './error-shape.ts';

const MiB = 2 ** 20;
const [shape = '', contract = '', size = '', mode = ''] = process.argv.slice(2);
if (!isContractName(contract)) throw new Error(`unknown contract ${contract}`);
const bytes = new Uint8Array(Number(size)).fill(0x20);
let at = 0;
const write = (text: string) => {
  for (let index = 0; index < text.length; index += 1) bytes[at + index] = text.charCodeAt(index);
  at += text.length;
};
/** Room left before the closing text of `tail` bytes. */
const room = (tail: number) => bytes.length - at - tail;
const tag = contracts[contract].versionTag;

/** The 93 ASCII characters that a key holds without an escape. */
const ASCII = Array.from({ length: 0x5f }, (_, index) => 0x20 + index).filter((code) => code !== 0x22 && code !== 0x5c);
const ascii = (index: number) => ASCII[index] ?? 0;
/** One-character keys of two UTF-8 bytes, U+0080 to U+07FF. */
const TWO_BYTE = 0x800 - 0x80;
/** Keys of one byte, and of at most two. */
const ONE = ASCII.length;
const TWO = ONE + TWO_BYTE + ONE * ONE;

/** Write key `index` of an object, shortest first, with its quotes. */
function writeKey(index: number): void {
  bytes[at++] = 0x22;
  if (index < ONE) bytes[at++] = ascii(index);
  else if (index < ONE + TWO_BYTE) {
    const code = 0x80 + index - ONE;
    bytes[at++] = 0xc0 | (code >> 6);
    bytes[at++] = 0x80 | (code & 0x3f);
  } else if (index < TWO) {
    const pair = index - ONE - TWO_BYTE;
    bytes[at++] = ascii(Math.floor(pair / ONE));
    bytes[at++] = ascii(pair % ONE);
  } else {
    const triple = index - TWO;
    bytes[at++] = ascii(Math.floor(triple / (ONE * ONE)));
    bytes[at++] = ascii(Math.floor(triple / ONE) % ONE);
    bytes[at++] = ascii(triple % ONE);
  }
  bytes[at++] = 0x22;
}

/** Bytes of the members `"key":0` of keys 0 to n - 1 of one object, with the commas between them. */
function membersBytes(n: number): number {
  const two = Math.min(Math.max(n - ONE, 0), TWO - ONE);
  return Math.min(n, ONE) + 2 * two + 3 * Math.max(n - TWO, 0) + 4 * n + Math.max(n - 1, 0);
}

/** Bytes of nested objects of `sizes` keys: each but the last holds the next as its last value. */
const objectsBytes = (sizes: readonly number[]) =>
  sizes.reduce((sum, size) => sum + 2 + membersBytes(size), 0) - Math.max(sizes.length - 1, 0);

/** Write nested objects of `sizes` keys, outermost first. */
function writeObjects(sizes: readonly number[]): void {
  sizes.forEach((size, depth) => {
    write('{');
    for (let key = 0; key < size; key += 1) {
      if (key > 0) write(',');
      writeKey(key);
      write(':');
      if (key < size - 1 || depth === sizes.length - 1) write('0');
    }
  });
  write('}'.repeat(sizes.length));
}

/** The most keys of one object within `room` bytes. */
function oneObject(room: number): number[] {
  let [fits, over] = [0, room];
  while (over - fits > 1) {
    const size = Math.floor((fits + over) / 2);
    if (2 + membersBytes(size) <= room) fits = size;
    else over = size;
  }
  return [fits];
}

/**
 * Objects within `room` bytes whose key tables are each twice as large as their keys need: an object
 * of n keys has a table of `slots` slots when n is one more than the table of slots / 2 holds. The
 * largest that fit are taken first, then they are nested smallest first, and the keys left over go
 * to the largest, whose table they do not grow.
 */
function spreadObjects(room: number): number[] {
  const sizes: number[] = [];
  for (let slots = 2 ** 22; slots >= KEY_TABLE_MIN_SLOTS; slots /= 2) {
    const size = slots === KEY_TABLE_MIN_SLOTS ? SMALL_KEY_SET + 1 : keyTableHolds(slots / 2) + 1;
    while (objectsBytes([...sizes, size]) <= room) sizes.push(size);
  }
  sizes.reverse();
  const last = sizes.length - 1;
  const grown = () => sizes.map((size, index) => (index === last ? size + 1 : size));
  while (objectsBytes(grown()) <= room) sizes[last] = (sizes[last] ?? 0) + 1;
  return sizes;
}

const items: Record<string, string> = { zeros: '0', arrays: '[]', objects: '{}', singletons: '[0]' };
let counted: { strings: number } | undefined;
let keySets: { keys: number; objects: number; largestObject: number } | undefined;
if (shape === 'errors' || shape === 'errors-wide') {
  const { open, item, close, skeleton } = errorShape(contract);
  // A string of MAX_STRING_BYTES bytes: ASCII, then 一 (U+4E00), three bytes in UTF-8.
  const stringBytes = MAX_STRING_BYTES + 2;
  let strings = 0;
  if (shape === 'errors-wide') {
    const fixed = open.length + close.length + ',"pad":[]'.length + (MAX_NODES - skeleton) * (item.length + 1);
    strings = Math.max(0, Math.floor((bytes.length - fixed) / (stringBytes + 1)));
  }
  // The pad array and its strings are values too.
  const repeated = MAX_NODES - skeleton - (shape === 'errors-wide' ? strings + 1 : 0);
  write(open);
  for (let index = 0; index < repeated; index += 1) write(index === 0 ? item : `,${item}`);
  write(close.slice(0, -1));
  if (shape === 'errors-wide') {
    write(',"pad":[');
    for (let index = 0; index < strings; index += 1) {
      write(index === 0 ? '"' : ',"');
      write('a'.repeat(MAX_STRING_BYTES - 3));
      bytes.set([0xe4, 0xb8, 0x80], at);
      at += 3;
      write('"');
    }
    write(']');
  }
  write('}');
  counted = { strings };
} else if (shape === 'keys') {
  write(`{"schema_version":"${tag}"`);
  for (let key = 0; ; key += 1) {
    const member = `,"k${key.toString(36)}":0`;
    if (room(1) < member.length) break;
    write(member);
  }
  write('}');
} else if (shape === 'shapes') {
  write(`{"schema_version":"${tag}","violations":[0`);
  for (let key = 0; ; key += 1) {
    const item = `,{"${key.toString(36)}":0}`;
    if (room(2) < item.length) break;
    write(item);
  }
  write(']}');
} else if (shape === 'escapes' || shape === 'wide') {
  write(`{"schema_version":"${tag}","violations":"`);
  if (shape === 'escapes') {
    while (room(2) >= 2) write('\\n');
  } else {
    // 一 (U+4E00) is three bytes in UTF-8.
    write('\\n');
    while (room(5) >= 1) write('a');
    bytes.set([0xe4, 0xb8, 0x80], at);
    at += 3;
  }
  write('"}');
} else if (shape === 'long-key' || shape === 'nested-key') {
  const nested = shape === 'nested-key';
  write(`{"schema_version":"${tag}",${nested ? '"violations":{' : ''}"\\n`);
  // The `a` run is written in place, so the setup leaves no long string behind.
  const end = bytes.length - (nested ? 8 : 7);
  bytes.fill(0x61, at, end);
  at = end;
  bytes.set([0xe4, 0xb8, 0x80], at);
  at += 3;
  write(nested ? '":0}}' : '":0}');
} else if (shape.startsWith('set-')) {
  write(`{"schema_version":"${tag}",`);
  if (shape.endsWith('-long')) write(`"${'a'.repeat(MAX_KEY_BYTES + 1)}":0,`);
  else {
    const bound = valueBound(contract);
    if (!Number.isFinite(bound)) throw new Error(`${contract} has no value bound`);
    // The root, schema_version, y and bound - 1 zeros: two values more than the bound.
    write('"y":[0');
    for (let value = 2; value < bound; value += 1) write(',0');
    write('],');
  }
  write('"x":');
  const sizes = (shape.startsWith('set-objects') ? spreadObjects : oneObject)(room(1));
  writeObjects(sizes);
  write('}');
  keySets = {
    keys: sizes.reduce((sum, size) => sum + size, 0),
    objects: sizes.length,
    largestObject: Math.max(...sizes),
  };
} else if (shape === 'nested') {
  const chain = `${'['.repeat(100)}0${']'.repeat(100)}`;
  write(`{"schema_version":"${tag}","violations":[0`);
  while (room(2) >= chain.length + 1) write(`,${chain}`);
  write(']}');
} else {
  const item = items[shape];
  if (item === undefined) throw new Error(`unknown shape ${shape}`);
  write(`{"schema_version":"${tag}","violations":[${item}`);
  while (room(2) >= item.length + 1) write(`,${item}`);
  write(']}');
}

const before = getHeapStatistics();
const profiler = new GCProfiler();
profiler.start();
const started = Date.now();
let outcome: Record<string, unknown>;
if (mode === 'unbounded') {
  parseStrictJson(bytes);
  outcome = { verdict: 'parsed' };
} else {
  const result = parseContract(contract, bytes);
  outcome = result.ok
    ? { verdict: 'accepted' }
    : {
        verdict: 'rejected',
        code: result.error.code,
        kind: result.error.kind,
        listingStopped: result.error.listingStopped,
        violations: result.error.violations.length,
      };
}
const milliseconds = Date.now() - started;
const after = getHeapStatistics();
const collections = profiler.stop().statistics;
const samples = [
  ...collections.map((event) => event.beforeGC.heapStatistics),
  { usedHeapSize: after.used_heap_size, externalMemory: after.external_memory },
];
const peak = (read: (sample: (typeof samples)[number]) => number) => Math.max(...samples.map(read));
if (counted !== undefined) {
  const validate = allErrorValidators[contract];
  const document = parseStrictJson(bytes);
  const values = (value: unknown): number => {
    if (Array.isArray(value)) return 1 + value.reduce<number>((sum, item) => sum + values(item), 0);
    if (typeof value === 'object' && value !== null) {
      return 1 + Object.values(value).reduce<number>((sum, item) => sum + values(item), 0);
    }
    return 1;
  };
  outcome.values = values(document);
  outcome.ajvErrors = validate(document) ? 0 : (validate.errors?.length ?? 0);
  outcome.strings = counted.strings;
}
if (keySets !== undefined) Object.assign(outcome, keySets);
console.log(
  JSON.stringify({
    ...outcome,
    bytes: bytes.length,
    milliseconds,
    gcs: collections.length,
    baselineHeapMiB: before.used_heap_size / MiB,
    peakHeapMiB: peak((sample) => sample.usedHeapSize) / MiB,
    peakExternalMiB: peak((sample) => sample.externalMemory) / MiB,
    peakTotalMiB: peak((sample) => sample.usedHeapSize + sample.externalMemory) / MiB,
  }),
);

// Scans one dense evaluation-result/1 body with scanEvaluationResult and prints the outcome and the
// peak memory as JSON, as dense-body.ts does for parseContract. test/memory.test.ts runs it in a
// child process under `node --max-old-space-size=128`.
//
// Usage: node dense-result.ts <shape> <bytes>
//
// The body is the F0 result with its journal replaced by the densest content that the structural
// limits allow (trailing spaces pad the rest). The scan reads the journal but builds none of it:
//
// zeros    [[0,0,…],[0,0,…],…]: arrays of MAX_ARRAY_LEN zeros
// objects  [[{},{},…],…]: arrays of MAX_ARRAY_LEN empty objects
// keys     [{"k0":0,…},…]: objects of MAX_OBJECT_KEYS keys, so each object holds a key set
// nested   [[[…[0]…]],…]: chains of 120 arrays
// escapes  ["\n\n…",…]: strings of MAX_STRING_BYTES decoded bytes, two bytes of text each
// wide     ["aa…a一",…]: strings of MAX_STRING_BYTES bytes, each with one character outside
//          Latin-1, so the decoded text takes two bytes a character
// head     the journal is valid and an extra top-level member holds `[0,0,…]` arrays: the head is
//          built up to its value bound, then only read
// head-strings  the journal is valid and an extra top-level member holds strings of
//          MAX_STRING_BYTES decoded bytes, each with an escape and a character outside Latin-1:
//          the head builds them, decoded and two bytes a character, within its value bound
// root-key the journal is valid and one extra top-level member has a key that fills the body: an
//          escape, then `a`, then a character outside Latin-1
// journal-key  the journal is one object whose only key fills the body in the same way

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GCProfiler, getHeapStatistics } from 'node:v8';
import { scanEvaluationResult } from '../../src/index.ts';
import { MAX_ARRAY_LEN, MAX_OBJECT_KEYS, MAX_STRING_BYTES } from '../../src/limits.ts';

const MiB = 2 ** 20;
const [shape = '', size = ''] = process.argv.slice(2);
const fixture = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../../fixtures/protocol/valid/evaluation-result.f0.json',
);
const document = JSON.stringify(JSON.parse(readFileSync(fixture, 'utf8')));
const bytes = new Uint8Array(Number(size)).fill(0x20);
let at = 0;
const write = (text: string) => {
  for (let index = 0; index < text.length; index += 1) bytes[at + index] = text.charCodeAt(index);
  at += text.length;
};
const room = (tail: number) => bytes.length - at - tail;

const journalStart = document.indexOf('"journal":') + '"journal":'.length;
const journalEnd = document.indexOf(',"outcome":');
const [before, after] =
  shape === 'head' || shape === 'head-strings'
    ? [`${document.slice(0, -1)},"extra":`, '}']
    : shape === 'root-key'
      ? [`${document.slice(0, -1)},`, ':0}']
      : [document.slice(0, journalStart), document.slice(journalEnd)];

// A key or string of an escape, `a` up to the room left before `tail` bytes, and 一 (U+4E00, three
// bytes in UTF-8). The `a` run is written in place, so the setup leaves no long string behind.
function longText(tail: number): void {
  write('"\\n');
  const end = bytes.length - tail - 4;
  bytes.fill(0x61, at, end);
  at = end;
  bytes.set([0xe4, 0xb8, 0x80], at);
  at += 3;
  write('"');
}

// Writes `[` item, item, … `]` groups of at most `perGroup` items inside one outer array.
function groups(item: string, perGroup: number): void {
  write('[');
  let first = true;
  while (room(after.length + 3) >= item.length + 3) {
    write(first ? '[' : ',[');
    first = false;
    for (let index = 0; index < perGroup && room(after.length + 2) >= item.length + 1; index += 1) {
      write(index === 0 ? item : `,${item}`);
    }
    write(']');
  }
  write(']');
}

write(before);
if (shape === 'root-key') longText(after.length);
else if (shape === 'journal-key') {
  write('{');
  longText(after.length + 3);
  write(':0}');
} else if (shape === 'head-strings') {
  // Each string is MAX_STRING_BYTES + 3 bytes of text and decodes to MAX_STRING_BYTES bytes: the
  // escape decodes to one byte and 一 to three.
  const item = MAX_STRING_BYTES + 3;
  write('[');
  for (let first = true; room(after.length + 1) >= item + 1; first = false) {
    if (!first) write(',');
    write('"\\n');
    bytes.fill(0x61, at, at + MAX_STRING_BYTES - 4);
    at += MAX_STRING_BYTES - 4;
    bytes.set([0xe4, 0xb8, 0x80], at);
    at += 3;
    write('"');
  }
  write(']');
} else if (shape === 'zeros' || shape === 'head') groups('0', MAX_ARRAY_LEN);
else if (shape === 'objects') groups('{}', MAX_ARRAY_LEN);
else if (shape === 'keys') {
  const object = `{${Array.from({ length: MAX_OBJECT_KEYS }, (_, key) => `"k${key}":0`).join(',')}}`;
  groups(object, MAX_ARRAY_LEN);
} else if (shape === 'nested') groups(`${'['.repeat(120)}0${']'.repeat(120)}`, MAX_ARRAY_LEN);
else if (shape === 'escapes') groups(`"${'\\n'.repeat(MAX_STRING_BYTES)}"`, MAX_ARRAY_LEN);
else if (shape === 'wide') {
  // 一 (U+4E00) is three bytes in UTF-8; written as raw bytes below.
  write('[[');
  let first = true;
  while (room(after.length + 2) >= MAX_STRING_BYTES + 3) {
    write(first ? '"' : ',"');
    first = false;
    write('a'.repeat(MAX_STRING_BYTES - 3));
    bytes.set([0xe4, 0xb8, 0x80], at);
    at += 3;
    write('"');
  }
  write(']]');
} else throw new Error(`unknown shape ${shape}`);
write(after);

const baseline = getHeapStatistics();
const profiler = new GCProfiler();
profiler.start();
const started = Date.now();
const result = scanEvaluationResult(bytes);
const milliseconds = Date.now() - started;
const end = getHeapStatistics();
const samples = [
  ...profiler.stop().statistics.map((event) => event.beforeGC.heapStatistics),
  { usedHeapSize: end.used_heap_size, externalMemory: end.external_memory },
];
const peak = (read: (sample: (typeof samples)[number]) => number) => Math.max(...samples.map(read));
console.log(
  JSON.stringify({
    ...(result.ok
      ? { verdict: 'accepted' }
      : {
          verdict: 'rejected',
          code: result.error.code,
          kind: result.error.kind,
          listingStopped: result.error.listingStopped,
        }),
    bytes: bytes.length,
    written: at,
    milliseconds,
    baselineHeapMiB: baseline.used_heap_size / MiB,
    peakHeapMiB: peak((sample) => sample.usedHeapSize) / MiB,
    peakExternalMiB: peak((sample) => sample.externalMemory) / MiB,
    peakTotalMiB: peak((sample) => sample.usedHeapSize + sample.externalMemory) / MiB,
  }),
);

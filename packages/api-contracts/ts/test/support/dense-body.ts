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
//
// "unbounded" parses the body with parseStrictJson, which builds every value, as a control.
//
// The peak is the largest heap V8 reported before any garbage collection during the parse, or
// after the parse. External memory holds the body bytes, typed arrays and, in Node, the decoded
// text; peakTotalMiB adds it to the heap, and test/memory.test.ts checks that sum.

import { GCProfiler, getHeapStatistics } from 'node:v8';
import { contracts, isContractName, parseContract, parseStrictJson } from '../../src/index.ts';

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

const items: Record<string, string> = { zeros: '0', arrays: '[]', objects: '{}', singletons: '[0]' };
if (shape === 'keys') {
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
    : { verdict: 'rejected', code: result.error.code, kind: result.error.kind };
}
const milliseconds = Date.now() - started;
const after = getHeapStatistics();
const samples = [
  ...profiler.stop().statistics.map((event) => event.beforeGC.heapStatistics),
  { usedHeapSize: after.used_heap_size, externalMemory: after.external_memory },
];
const peak = (read: (sample: (typeof samples)[number]) => number) => Math.max(...samples.map(read));
console.log(
  JSON.stringify({
    ...outcome,
    bytes: bytes.length,
    milliseconds,
    baselineHeapMiB: before.used_heap_size / MiB,
    peakHeapMiB: peak((sample) => sample.usedHeapSize) / MiB,
    peakExternalMiB: peak((sample) => sample.externalMemory) / MiB,
    peakTotalMiB: peak((sample) => sample.usedHeapSize + sample.externalMemory) / MiB,
  }),
);

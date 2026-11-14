// Parses one dense body as a contract and prints the outcome as JSON. test/memory.test.ts runs it in
// a child process under `node --max-old-space-size=128`, the memory of a Worker isolate.
//
// Usage: node dense-body.ts <shape> <contract> <bytes> [unbounded]
//
// shape: zeros    {"schema_version":"<contract>/1","violations":[0,0,…]}
//        arrays   {"schema_version":"<contract>/1","violations":[[],[],…]}
//        objects  {"schema_version":"<contract>/1","violations":[{},{},…]}
//        keys     {"schema_version":"<contract>/1","k0":0,"k1":0,…} with distinct keys
// The body is padded with trailing spaces to exactly <bytes>. "unbounded" parses it with
// parseStrictJson, which builds every value, as a control.

import { contracts, isContractName, parseContract, parseStrictJson } from '../../src/index.ts';

const [shape = '', contract = '', size = '', mode = ''] = process.argv.slice(2);
if (!isContractName(contract)) throw new Error(`unknown contract ${contract}`);
const bytes = new Uint8Array(Number(size)).fill(0x20);
let at = 0;
const write = (text: string) => {
  for (let index = 0; index < text.length; index += 1) bytes[at + index] = text.charCodeAt(index);
  at += text.length;
};
const tag = contracts[contract].versionTag;
if (shape === 'keys') {
  write(`{"schema_version":"${tag}"`);
  // Room for the closing brace.
  for (let key = 0; ; key += 1) {
    const member = `,"k${key.toString(36)}":0`;
    if (at + member.length + 1 > bytes.length) break;
    write(member);
  }
  write('}');
} else {
  const item = { zeros: '0', arrays: '[]', objects: '{}' }[shape];
  if (item === undefined) throw new Error(`unknown shape ${shape}`);
  write(`{"schema_version":"${tag}","violations":[${item}`);
  while (at + item.length + 3 <= bytes.length) write(`,${item}`);
  write(']}');
}

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
const memory = process.memoryUsage();
console.log(
  JSON.stringify({
    ...outcome,
    bytes: bytes.length,
    milliseconds: Date.now() - started,
    heapUsedMiB: Math.round(memory.heapUsed / 2 ** 20),
    rssMiB: Math.round(memory.rss / 2 ** 20),
  }),
);

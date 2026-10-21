import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, cpSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { root, checkRepository } from '../repository.ts';

function mutated(change: (directory: string) => void, expected: RegExp) {
  const temporary = mkdtempSync(resolve(tmpdir(),'openquant-check-'));
  try {
    const copy = resolve(temporary,'repo');
    cpSync(root,copy,{recursive:true,filter:(path)=>!/(^|\/)(\.git|node_modules)(\/|$)/.test(path)});
    change(copy);
    assert.ok(checkRepository(copy).some((error)=>expected.test(error)),`Expected rejection matching ${expected}`);
  } finally { rmSync(temporary,{recursive:true,force:true}); }
}
function edit(base: string, path: string, change: (text: string) => string) {
  const absolute = resolve(base,path);
  writeFileSync(absolute,change(readFileSync(absolute,'utf8')));
}

test('baseline repository satisfies its declared checks',()=>assert.deepEqual(checkRepository(root),[]));
test('a metadata change requires regenerated index',()=>mutated((base)=>edit(base,'docs/specs/01-product-design-spec.md',(t)=>t.replace('version: 1.0.0','version: 1.1.0')),/Spec index drift/));
test('lost product acceptance fails',()=>mutated((base)=>edit(base,'docs/specs/02-trading-domain-and-evaluation-spec.md',(t)=>t.replace(/^\| \*\*A12\*\*.*\n/m,'')),/A acceptance identifiers/));
test('missing local link target fails',()=>mutated((base)=>edit(base,'README.md',(t)=>t+'\n[Missing](docs/missing.md)\n'),/missing local link/));
test('missing local heading fails',()=>mutated((base)=>edit(base,'README.md',(t)=>t+'\n[Missing](docs/specs/01-product-design-spec.md#missing-heading)\n'),/missing anchor/));
test('altered source bytes fail provenance',()=>mutated((base)=>edit(base,'docs/research-logs/imported/openquant-design-spec-v2.md',(t)=>t+'\nChanged\n'),/Source hash mismatch/));
test('new unstaged file in an archive requires a new file map',()=>mutated((base)=>writeFileSync(resolve(base,'extra.txt'),'extra\n'),/Repository tree drift/));
test('mutable action reference fails',()=>mutated((base)=>edit(base,'.github/workflows/ci.yml',(t)=>t.replace(/actions\/checkout@[0-9a-f]{40}/,'actions/checkout@v7')),/Action must use a full commit SHA/));
test('CI secret use fails',()=>mutated((base)=>edit(base,'.github/workflows/ci.yml',(t)=>t+'\n# '+'secrets.'+'EXAMPLE\n'),/CI must not use secrets/));
test('archive manifest cannot leave its directory',()=>mutated((base)=>edit(base,'docs/research-logs/imported/manifest.json',(t)=>t.replace('"file": "2026-09-14','"file": "../2026-09-14')),/Invalid archive path/));

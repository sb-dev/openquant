import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, cpSync, rmSync, readFileSync, writeFileSync, readlinkSync, symlinkSync, renameSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { root, checkRepository, paths } from '../repository.ts';

function mutationErrors(change: (directory: string) => void): string[] {
  const temporary = mkdtempSync(resolve(tmpdir(),'openquant-check-'));
  try {
    const copy = resolve(temporary,'repo');
    cpSync(root,copy,{recursive:true,verbatimSymlinks:true,filter:(path)=>!/(^|\/)(\.git|node_modules)(\/|$)/.test(path)});
    change(copy);
    return checkRepository(copy);
  } finally { rmSync(temporary,{recursive:true,force:true}); }
}
function mutated(change: (directory: string) => void, expected: RegExp) {
  assert.ok(mutationErrors(change).some((error)=>expected.test(error)),`Expected rejection matching ${expected}`);
}
function edit(base: string, path: string, change: (text: string) => string) {
  const absolute = resolve(base,path);
  writeFileSync(absolute,change(readFileSync(absolute,'utf8')));
}
function replaceLink(base: string, path: string, target: string) {
  const absolute = resolve(base,path);
  rmSync(absolute,{recursive:true,force:true});
  symlinkSync(target,absolute,'dir');
}
function git(base: string, ...args: string[]) {
  const result = spawnSync('git',args,{cwd:base,encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
}

test('baseline repository satisfies its declared checks',()=>assert.deepEqual(checkRepository(root),[]));
test('removing a declared skill and its alias fails inventory verification',()=>mutated((base)=>{
  rmSync(resolve(base,'.agents/skills/rust-review'),{recursive:true});
  rmSync(resolve(base,'.claude/skills/rust-review'));
},/Declared skill is missing: rust-review/));
test('removing a shared skill alias fails inventory verification',()=>mutated((base)=>{
  rmSync(resolve(base,'.claude/skills/openquant-ai-engineering'));
},/Claude skill alias is missing: openquant-ai-engineering/));
test('a regular file cannot stand in for a shared skill alias',()=>mutated((base)=>{
  const alias = resolve(base,'.claude/skills/openquant-ai-engineering');
  rmSync(alias);
  writeFileSync(alias,'../../.agents/skills/openquant-ai-engineering');
},/Claude skill alias must be a symlink/));
test('missing portable support files fail completeness verification',()=>mutated((base)=>{
  rmSync(resolve(base,'.agents/skills/rust-review/upstream/scripts/build_run_plan.py'));
},/Missing tracked skill resource/));
test('modified portable support files require a provenance update',()=>mutated((base)=>{
  edit(base,'.agents/skills/rust-review/upstream/scripts/build_run_plan.py',(text)=>text+'\n# Changed\n');
},/Portable skill hash mismatch/));
test('modified adapted skills require a provenance update',()=>mutated((base)=>{
  edit(base,'.agents/skills/ml4t-fetch-data/SKILL.md',(text)=>text+'\nChanged retrieval policy.\n');
},/Adapted skill hash mismatch/));
test('adaptation manifests reject paths outside declared skills',()=>mutated((base)=>{
  edit(base,'.claude/skill-sources.json',(text)=>{
    const source = JSON.parse(text);
    source.adaptations[0].file = '../outside.md';
    return JSON.stringify(source);
  });
},/Invalid adapted skill path/));
test('a metadata change requires regenerated index',()=>mutated((base)=>edit(base,'docs/specs/01-product-design-spec.md',(t)=>t.replace(/^version: .+$/m,'version: 99.0.0')),/Spec index drift/));
test('lost product acceptance fails',()=>mutated((base)=>edit(base,'docs/specs/02-trading-domain-and-evaluation-spec.md',(t)=>t.replace(/^\| \*\*A12\*\*.*\n/m,'')),/A acceptance identifiers/));
test('missing local link target fails',()=>mutated((base)=>edit(base,'README.md',(t)=>t+'\n[Missing](docs/missing.md)\n'),/missing local link/));
test('missing local heading fails',()=>mutated((base)=>edit(base,'README.md',(t)=>t+'\n[Missing](docs/specs/01-product-design-spec.md#missing-heading)\n'),/missing anchor/));
test('vendored skill links may refer to unselected upstream documentation',()=>{
  const errors = mutationErrors((base)=>{
    const directory = resolve(base,'.agents/skills/vendor-fixture');
    mkdirSync(directory,{recursive:true});
    writeFileSync(resolve(directory,'SKILL.md'),'# Vendor fixture\n\n[Upstream](missing-upstream.md)\n');
  });
  assert.ok(!errors.some((error)=>error.includes('missing-upstream.md')),errors.join('\n'));
});
test('first-party Claude guidance still rejects missing links',()=>mutated((base)=>{
  mkdirSync(resolve(base,'.claude'),{recursive:true});
  writeFileSync(resolve(base,'.claude/README.md'),'# Claude guidance\n\n[Missing](missing-first-party.md)\n');
},/\.claude\/README\.md: missing local link missing-first-party\.md/));
test('vendored skills still reject credential patterns',()=>mutated((base)=>{
  const directory = resolve(base,'.agents/skills/vendor-fixture');
  mkdirSync(directory,{recursive:true});
  writeFileSync(resolve(directory,'SKILL.md'),'# Vendor fixture\n\nghp_'+'x'.repeat(36)+'\n');
},/Potential credential in \.agents\/skills\/vendor-fixture\/SKILL\.md/));
test('archive preserves allowed skill aliases and matches the Git inventory',()=>{
  const errors = mutationErrors((base)=>{
    const archiveFiles = paths(base);
    assert.deepEqual(archiveFiles,paths(root));
    const aliases = archiveFiles.filter((file)=>file.startsWith('.claude/skills/'));
    assert.ok(aliases.length > 0);
    for (const alias of aliases) {
      const name = alias.slice('.claude/skills/'.length);
      assert.ok(!name.includes('/'),'Archive must not traverse skill aliases');
      assert.equal(readlinkSync(resolve(base,alias)),`../../.agents/skills/${name}`);
      assert.ok(archiveFiles.includes(`.agents/skills/${name}/SKILL.md`));
    }
  });
  assert.deepEqual(errors,[]);
});
test('skill aliases reject a different skill target',()=>mutated((base)=>{
  replaceLink(base,'.claude/skills/hono','../../.agents/skills/node');
},/Symlink not allowed: \.claude\/skills\/hono/));
test('skill aliases reject an external target',()=>mutated((base)=>{
  replaceLink(base,'.claude/skills/hono',resolve(base,'..'));
},/Symlink not allowed: \.claude\/skills\/hono/));
test('archive inventories dangling skill aliases and rejects them',()=>mutated((base)=>{
  rmSync(resolve(base,'.agents/skills/hono'),{recursive:true});
  assert.ok(paths(base).includes('.claude/skills/hono'));
},/Dangling skill symlink: \.claude\/skills\/hono/));
test('skill aliases require the canonical SKILL.md in the Git index',()=>mutated((base)=>{
  git(base,'init','--quiet');
  git(base,'add','--all');
  git(base,'rm','--cached','--quiet','.agents/skills/hono/SKILL.md');
},/Skill symlink requires a regular tracked canonical SKILL\.md: \.claude\/skills\/hono/));
test('skill aliases reject a symlink in place of canonical SKILL.md',()=>mutated((base)=>{
  replaceLink(base,'.agents/skills/hono/SKILL.md','../node/SKILL.md');
},/Skill symlink requires a regular tracked canonical SKILL\.md: \.claude\/skills\/hono/));
test('tracked files cannot escape through a symlink ancestor',()=>mutated((base)=>{
  git(base,'init','--quiet');
  git(base,'add','--all');
  const target = resolve(base,'.agents/skills/hono');
  const external = resolve(base,'../external-skill');
  renameSync(target,external);
  symlinkSync(external,target,'dir');
},/Symlink ancestor not allowed: \.agents\/skills\/hono\/SKILL\.md/));
test('altered source bytes fail provenance',()=>mutated((base)=>edit(base,'docs/research-logs/imported/openquant-design-spec-v2.md',(t)=>t+'\nChanged\n'),/Source hash mismatch/));
test('new unstaged file in an archive requires a new file map',()=>mutated((base)=>writeFileSync(resolve(base,'extra.txt'),'extra\n'),/Repository tree drift/));
test('mutable action reference fails',()=>mutated((base)=>edit(base,'.github/workflows/ci.yml',(t)=>t.replace(/actions\/checkout@[0-9a-f]{40}/,'actions/checkout@v7')),/Action must use a full commit SHA/));
test('CI secret use fails',()=>mutated((base)=>edit(base,'.github/workflows/ci.yml',(t)=>t+'\n# '+'secrets.'+'EXAMPLE\n'),/CI must not use secrets/));
test('archive manifest cannot leave its directory',()=>mutated((base)=>edit(base,'docs/research-logs/imported/manifest.json',(t)=>t.replace('"file": "2026-09-14','"file": "../2026-09-14')),/Invalid archive path/));

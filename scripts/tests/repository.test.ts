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

const agents = 'packages/agents';
const sourcesPath = `${agents}/src/methods/sources.json`;
const chanNote = `${agents}/src/methods/chan-algorithmic-trading.md`;
const proposerProcedure = `${agents}/src/skills/strategy-formulation/procedure.md`;
const criticProcedure = `${agents}/src/skills/strategy-critique/procedure.md`;
const fixturePolicy = `${agents}/evals/fixture-policy.json`;
const proposerCases = `${agents}/evals/strategy-formulation/fixtures/dataset.json`;
const criticCases = `${agents}/evals/strategy-critique/fixtures/dataset.json`;
function editJson(base: string, path: string, change: (value: any) => void) {
  edit(base,path,(text)=>{ const value = JSON.parse(text); change(value); return JSON.stringify(value,null,2)+'\n'; });
}
function chanSource(value: any) { return value.sources.find((source: any)=>source.id==='chan-algorithmic-trading'); }

test('unlisted agent assets fail the layout allowlist',()=>mutated((base)=>writeFileSync(resolve(base,`${agents}/src/extra.md`),'Extra\n'),/Unexpected agent asset: packages\/agents\/src\/extra\.md/));
test('a missing method note fails',()=>mutated((base)=>rmSync(resolve(base,chanNote)),/Missing agent asset: packages\/agents\/src\/methods\/chan-algorithmic-trading\.md/));
test('primary_checked requires a recorded primary page check',()=>mutated((base)=>edit(base,chanNote,(t)=>t.replace('| `summary_claim_unverified` |','| `primary_checked` |')),/claims primary_checked without a recorded primary page check/));
test('rule categories must come from OQ-03',()=>mutated((base)=>edit(base,chanNote,(t)=>t.replace('| `causal_leakage` |','| `lookahead` |')),/Unknown category lookahead/));
test('rule IDs must stay in sequence',()=>mutated((base)=>edit(base,chanNote,(t)=>t.replace('| `CHAN-02` |','| `CHAN-20` |')),/Rule CHAN-20 is out of sequence/));
test('rule pages must exist in the recorded summary',()=>mutated((base)=>editJson(base,sourcesPath,(value)=>{ chanSource(value).summary.pages = 1; }),/Invalid summary page for CHAN-/));
test('summary digests must be SHA-256 values',()=>mutated((base)=>editJson(base,sourcesPath,(value)=>{ chanSource(value).summary.sha256 = 'unknown'; }),/Invalid summary digest: chan-algorithmic-trading/));
test('runtime assets cannot reference evaluation cases',()=>mutated((base)=>edit(base,criticProcedure,(t)=>t+'\nCompare SC-01.\n'),/Runtime asset references evaluation material/));
test('runtime assets cannot contain links',()=>mutated((base)=>edit(base,chanNote,(t)=>t+'\n[OQ-03](../../../../docs/specs/03-model-backed-execution-spec.md)\n'),/Runtime asset contains a link/));
test('agent assets reject blockquotes',()=>mutated((base)=>edit(base,chanNote,(t)=>t+'\n> Quoted source text.\n'),/Blockquote not allowed/));
test('procedures cannot cite unknown rules',()=>mutated((base)=>edit(base,proposerProcedure,(t)=>t+'\nSee `CHAN-99`.\n'),/Unknown rule reference CHAN-99/));
test('the critic category table must match OQ-03',()=>mutated((base)=>edit(base,criticProcedure,(t)=>t.replace(/^\| `operational_risk` \|.*\n/m,'')),/Critic procedure categories differ from OQ-03 §4: missing \[operational_risk\]/));
test('a new OQ-03 category requires the agent assets to change',()=>mutated((base)=>edit(base,'docs/specs/03-model-backed-execution-spec.md',(t)=>t.replace(/^(\| `method_advice` \|.*\n)/m,'$1| `new_category` | Example. |\n')),/Fixture policy categories differ from OQ-03 §4: missing \[new_category\]/));
test('the fixture policy must stay synthetic',()=>mutated((base)=>editJson(base,fixturePolicy,(value)=>{ value.synthetic = false; }),/Fixture policy must be marked synthetic/));
test('blocking treatments cannot escalate',()=>mutated((base)=>editJson(base,fixturePolicy,(value)=>{ value.treatments.causal_leakage.escalate_when = ['required_evidence']; }),/Blocking treatment cannot escalate: causal_leakage/));
test('fresh cases must record consumption',()=>mutated((base)=>editJson(base,criticCases,(value)=>{ delete value.cases.find((item: any)=>item.split==='fresh').consumed; }),/consumed is required for fresh cases/));
test('finding treatment must follow the fixture policy',()=>mutated((base)=>editJson(base,criticCases,(value)=>{
  const finding = value.cases.flatMap((item: any)=>item.expected.findings).find((item: any)=>item.treatment==='blocking');
  finding.treatment = 'advisory';
}),/treatment for [a-z_]+ differs from fixture policy/));
test('cases cannot permit tools before S3',()=>mutated((base)=>editJson(base,proposerCases,(value)=>{ value.cases[0].permitted_tools = ['tool:market-snapshot@1']; }),/permits tools before S3/));
test('required critic defects stay covered',()=>mutated((base)=>editJson(base,criticCases,(value)=>{
  value.cases = value.cases.filter((item: any)=>!item.covers.includes('same_close_signal_fill'));
}),/Uncovered required case in .*: same_close_signal_fill/));
test('fresh-required proposer cases need a fresh split',()=>mutated((base)=>editJson(base,proposerCases,(value)=>{
  for (const item of value.cases.filter((entry: any)=>entry.covers.includes('holdout_leakage'))) { item.split = 'tuning'; delete item.consumed; }
}),/Required case has no fresh case in .*: holdout_leakage/));
test('case requirements must name existing sections',()=>mutated((base)=>editJson(base,proposerCases,(value)=>{ value.cases[0].requirements = ['OQ-03 §9']; }),/references missing requirement OQ-03 §9/));
test('case outcomes must come from OQ-03',()=>mutated((base)=>editJson(base,proposerCases,(value)=>{
  value.cases.find((item: any)=>item.expected.dispatch==='dispatched').expected.attempt_outcome = 'success';
}),/unknown attempt outcome success/));
test('findings must use a known finding_source',()=>mutated((base)=>editJson(base,criticCases,(value)=>{
  value.cases.flatMap((item: any)=>item.expected.findings)[0].finding_source = 'critic';
}),/unknown finding_source critic/));
test('expected findings must name a location',()=>mutated((base)=>editJson(base,criticCases,(value)=>{
  delete value.cases.flatMap((item: any)=>item.expected.findings)[0].location;
}),/Invalid case SC-\d{2} in .*: expected\.findings\.location/));
test('affects_executable_rule follows affected elements',()=>mutated((base)=>editJson(base,criticCases,(value)=>{
  value.cases.flatMap((item: any)=>item.expected.findings).find((item: any)=>item.affected_elements.length).affected_elements = [];
}),/affects_executable_rule must hold exactly when affected_elements is non-empty/));
test('every finding category stays covered',()=>mutated((base)=>editJson(base,criticCases,(value)=>{
  for (const item of value.cases) item.expected.findings = item.expected.findings.filter((finding: any)=>finding.category!=='operational_risk');
}),/Uncovered finding category in .*: operational_risk/));

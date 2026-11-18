import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, cpSync, copyFileSync, rmSync, readFileSync, readdirSync, writeFileSync, readlinkSync, symlinkSync, renameSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { delimiter, relative, resolve, sep } from 'node:path';
import { root, checkRepository, paths, isIgnored, credentialErrors } from '../repository.ts';

// Paths that are not part of a checkout: the names that scripts/repository.ts ignores (installed
// dependencies and local output) and nested worktrees. The test is applied to the path relative to the
// copied root, so a checkout that itself lives under .claude/worktrees is still copied in full.
function notCopied(path: string): boolean {
  return path.split('/').some(isIgnored) || /(^|\/)\.claude\/worktrees(\/|$)/.test(path);
}
function copyRepository(source: string, destination: string) {
  cpSync(source,destination,{recursive:true,verbatimSymlinks:true,filter:(path)=>!notCopied(relative(source,path).split(sep).join('/'))});
}
function mutationErrors(change: (directory: string) => void, source: string = root): string[] {
  const temporary = mkdtempSync(resolve(tmpdir(),'openquant-check-'));
  try {
    const copy = resolve(temporary,'repo');
    copyRepository(source,copy);
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
test('the repository copy works from a path inside .claude/worktrees and skips only a nested one',()=>{
  const temporary = mkdtempSync(resolve(tmpdir(),'openquant-worktree-'));
  try {
    const checkout = resolve(temporary,'.claude/worktrees/agent-checkout');
    mkdirSync(resolve(temporary,'.claude/worktrees'),{recursive:true});
    copyRepository(root,checkout);
    assert.ok(existsSync(resolve(checkout,'scripts/verify.ts')),'the copy of the repository root must not be filtered by its own location');
    mkdirSync(resolve(checkout,'.claude/worktrees/stray'),{recursive:true});
    writeFileSync(resolve(checkout,'.claude/worktrees/stray/file.txt'),'stray\n');
    const copied: string[] = [];
    assert.deepEqual(mutationErrors((base)=>{ copied.push(...paths(base)); },checkout),[]);
    assert.ok(copied.includes('scripts/verify.ts'));
    assert.ok(!copied.some((file)=>file.startsWith('.claude/worktrees/')),'a nested .claude/worktrees directory is not copied');
  } finally { rmSync(temporary,{recursive:true,force:true}); }
});
test('the archive walk and the test copy skip the same local output and installed dependencies',()=>{
  const temporary = mkdtempSync(resolve(tmpdir(),'openquant-output-'));
  try {
    const checkout = resolve(temporary,'checkout');
    copyRepository(root,checkout);
    const output = ['dist/x.js','packages/api-contracts/ts/dist/generated/types.ts','.turbo/cache/x','apps/api/.wrangler/state/x','coverage/lcov.info','.cache/x','node_modules/x/index.js','local-runs/s0/report.md','packages/api-contracts/ts/tsconfig.tsbuildinfo','target/debug/x'];
    for (const file of output) { mkdirSync(resolve(checkout,file,'..'),{recursive:true}); writeFileSync(resolve(checkout,file),'output\n'); }
    assert.deepEqual(paths(checkout),paths(root),'an extracted archive is read without local output');
    assert.deepEqual(mutationErrors((base)=>{ for (const file of output) assert.ok(!existsSync(resolve(base,file)),`copied: ${file}`); },checkout),[]);
  } finally { rmSync(temporary,{recursive:true,force:true}); }
});
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
// G6: the text check requires the version comment on every action line, before any install; its form only.
test('G6: an action without a version comment or with a malformed one fails',()=>{
  const versionComment = /(?<=actions\/checkout@[0-9a-f]{40}) # v\d+\.\d+\.\d+/;
  for (const comment of ['',' # v7',' # 7.0.1',' # v7.0.1 latest']) {
    mutated((base)=>edit(base,'.github/workflows/ci.yml',(t)=>replaceOnce(t.replace(versionComment,'VERSION'),'VERSION',comment)),/Action must end its line with a version comment # v<major>\.<minor>\.<patch>: \.github\/workflows\/ci\.yml: actions\/checkout@[0-9a-f]{40}/);
  }
});
test('CI secret use fails',()=>mutated((base)=>edit(base,'.github/workflows/ci.yml',(t)=>t+'\n# '+'secrets.'+'EXAMPLE\n'),/CI must not use secrets/));
// Credential patterns: each test value is assembled at run time, so this file holds no credential shape.
test('each credential pattern finds its token and leaves names, prefixes and placeholders alone',()=>{
  const cases: Array<[string,string,string]> = [
    ['Anthropic key',`ANTHROPIC_API_KEY=${'sk-ant-'}api03-${'A1b-'.repeat(24)}`,'Anthropic keys start with sk-ant-, for example sk-ant-api03-<key>.'],
    ['Fly.io token',`FLY_API_TOKEN=${'fo1'}_${'Ab3_'.repeat(11)}`,'Fly.io tokens start with fo1_ or FlyV1 fm2_.'],
    ['Fly.io token',`Authorization: ${'FlyV1'} fm2_${'lJPE'.repeat(20)}`,'Authorization: FlyV1 fm2_<token>'],
    ['Alpaca key ID',`APCA_API_KEY_ID=${'PK'}${'A1B2C3D4E5F6G7H8I9'}`,`An order reference ${'PK'}${'A1B2C3D4E5F6G7H8I9'} outside a key context, and APCA_API_KEY_ID= left empty.`],
    ['Alpaca secret key',`"APCA_API_SECRET_KEY": "${'aB3d'.repeat(10)}"`,'APCA_API_SECRET_KEY: ${{ secrets.ALPACA_PAPER_SECRET }}'],
    ['Cloudflare token',`CLOUDFLARE_API_TOKEN=${'aB3_'.repeat(10)}`,'CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}'],
    ['Postgres URL with a password',`DATABASE_URL=${'postgres'}://openquant:${'s3cret'}@localhost:5432/openquant`,'postgres://openquant@localhost:5432/openquant and postgresql://openquant:${PGPASSWORD}@localhost/openquant'],
  ];
  for (const [label,positive,negative] of cases) {
    assert.deepEqual(credentialErrors('docs/example.md',positive),[`Potential credential in docs/example.md: ${label}`],positive);
    assert.deepEqual(credentialErrors('docs/example.md',negative),[],negative);
  }
});
test('vendored examples may hold a database URL with a password, first-party files may not',()=>{
  const url = `${'postgresql'}://user:${'pass'}@localhost:5432/db`;
  assert.deepEqual(credentialErrors('.agents/skills/node/rules/environment.md',url),[]);
  assert.deepEqual(credentialErrors('docs/research-logs/imported/example.md',url),[]);
  mutated((base)=>edit(base,'README.md',(t)=>`${t}\n${url}\n`),/Potential credential in README\.md: Postgres URL with a password/);
});
test('a tracked .dev.vars.example is allowed and a .dev.vars file is not',()=>{
  const errors = mutationErrors((base)=>{
    // The tracked example keeps its names, which infra/environments/staging.json must equal.
    writeFileSync(resolve(base,'apps/api/.dev.vars.example'),readFileSync(resolve(base,'apps/api/.dev.vars.example'),'utf8'));
    writeFileSync(resolve(base,'apps/api/.dev.vars'),'CLOUDFLARE_API_TOKEN=\n');
  });
  assert.ok(errors.includes('Private file must not be tracked: apps/api/.dev.vars'),errors.join('\n'));
  assert.ok(!errors.some((error)=>error.includes('.dev.vars.example')),errors.join('\n'));
});
const extraJob = '  extra:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo extra\n\n';
test('the CI aggregate must need every other job',()=>mutated((base)=>edit(base,'.github/workflows/ci.yml',(t)=>replaceOnce(t,'  ci:\n',`${extraJob}  ci:\n`)),/CI aggregate must need every other job: extra/));
test('the CI aggregate must check the result of every job it needs',()=>{
  const listed = (t: string) => replaceOnce(replaceOnce(t,'  ci:\n',`${extraJob}  ci:\n`),'needs: [checks]','needs:\n      - checks\n      - extra');
  mutated((base)=>edit(base,'.github/workflows/ci.yml',listed),/CI aggregate must check the result of extra/);
  mutated((base)=>edit(base,'.github/workflows/ci.yml',(t)=>listed(t).replace('= success','= success # needs.extra.result')),/CI aggregate must check the result of extra/);
  mutated((base)=>edit(base,'.github/workflows/ci.yml',(t)=>replaceOnce(t,'${{ needs.checks.result }}',"'success'")),/CI aggregate must check the result of checks/);
  const checked = mutationErrors((base)=>edit(base,'.github/workflows/ci.yml',(t)=>listed(t).replace('        run: test "$CHECK_RESULT" = success\n','        run: test "$CHECK_RESULT" = success\n      - env:\n          EXTRA_RESULT: ${{ needs.extra.result }}\n        run: test "$EXTRA_RESULT" = success\n')));
  assert.ok(!checked.some((error)=>/CI aggregate/.test(error)),checked.join('\n'));
});
test('archive manifest cannot leave its directory',()=>mutated((base)=>edit(base,'docs/research-logs/imported/manifest.json',(t)=>t.replace('"file": "2026-09-14','"file": "../2026-09-14')),/Invalid archive path/));

const agents = 'packages/agents';
const sourcesPath = `${agents}/src/methods/sources.json`;
const chanNote = `${agents}/src/methods/chan-algorithmic-trading.md`;
const proposerProcedure = `${agents}/src/skills/strategy-formulation/procedure.md`;
const criticProcedure = `${agents}/src/skills/strategy-critique/procedure.md`;
const fixturePolicy = `${agents}/evals/fixture-policy.json`;
const proposerCases = `${agents}/evals/strategy-formulation/fixtures/dataset.json`;
const criticCases = `${agents}/evals/strategy-critique/fixtures/dataset.json`;
const manifestFile = `${agents}/bundle.manifest.json`;
const agentFixtures = 'fixtures/agent-results';
function editJson(base: string, path: string, change: (value: any) => void) {
  edit(base,path,(text)=>{ const value = JSON.parse(text); change(value); return JSON.stringify(value,null,2)+'\n'; });
}
function chanSource(value: any) { return value.sources.find((source: any)=>source.id==='chan-algorithmic-trading'); }
// Edit a bundle file and record its new SHA-256 in the manifest, so a test sees the rule it targets and not the hash drift.
function bundleEdit(base: string, path: string, change: (text: string) => string) {
  edit(base,`${agents}/${path}`,change);
  const digest = `sha256:${createHash('sha256').update(readFileSync(resolve(base,`${agents}/${path}`))).digest('hex')}`;
  editJson(base,manifestFile,(value)=>{ value.files.find((file: any)=>file.path===path).sha256 = digest; });
}
// List one more file in the manifest with its real digest, keeping the paths sorted.
function listInManifest(base: string, path: string, content = 'Content.\n') {
  const absolute = resolve(base,`${agents}/${path}`);
  const outside = path.startsWith('/') || /^[A-Za-z]:/.test(path) || path.includes('\\') || path.split('/').includes('..');
  if (!outside) { mkdirSync(resolve(absolute,'..'),{recursive:true}); if (!existsSync(absolute)) writeFileSync(absolute,content); }
  const digest = `sha256:${createHash('sha256').update(outside ? content : readFileSync(absolute)).digest('hex')}`;
  editJson(base,manifestFile,(value)=>{ value.files.push({ path, sha256: digest }); value.files.sort((a: any,b: any)=>a.path<b.path?-1:a.path>b.path?1:0); });
}

test('unlisted agent assets fail the layout allowlist',()=>mutated((base)=>writeFileSync(resolve(base,`${agents}/src/extra.md`),'Extra\n'),/Unexpected agent asset: packages\/agents\/src\/extra\.md/));
test('a missing method note fails',()=>mutated((base)=>rmSync(resolve(base,chanNote)),/Missing agent asset: packages\/agents\/src\/methods\/chan-algorithmic-trading\.md/));
test('primary_checked requires a recorded primary page check',()=>mutated((base)=>edit(base,chanNote,(t)=>t.replace('| `summary_claim_unverified` |','| `primary_checked` |')),/claims primary_checked without a recorded primary page check/));
function primaryCheck(record: Record<string, string>) {
  return (base: string) => {
    editJson(base,sourcesPath,(value)=>{ chanSource(value).primary_pages_checked = [record]; });
    edit(base,chanNote,(t)=>t.replace('| `summary_claim_unverified` |','| `primary_checked` |'));
  };
}
test('a rule-only primary page record does not permit primary_checked',()=>mutated(primaryCheck({ rule: 'CHAN-01' }),/Invalid primary page record in .*: CHAN-01 needs locator, pages, checked_on and checked_by/));
test('a complete primary page record permits primary_checked',()=>{
  const errors = mutationErrors(primaryCheck({ rule: 'CHAN-01', locator: 'Example edition, chapter 1', pages: 'p. 1', checked_on: '2026-11-11', checked_by: 'maintainer' }));
  assert.ok(!errors.some((error)=>/primary/.test(error)),errors.join('\n'));
});
test('rule categories must come from OQ-03',()=>mutated((base)=>edit(base,chanNote,(t)=>t.replace('| `causal_leakage` |','| `lookahead` |')),/Unknown category lookahead/));
test('rule IDs must stay in sequence',()=>mutated((base)=>edit(base,chanNote,(t)=>t.replace('| `CHAN-02` |','| `CHAN-20` |')),/Rule CHAN-20 is out of sequence/));
test('rule pages must exist in the recorded summary',()=>mutated((base)=>editJson(base,sourcesPath,(value)=>{ chanSource(value).summary.pages = 1; }),/Invalid summary page for CHAN-/));
test('summary digests must be SHA-256 values',()=>mutated((base)=>editJson(base,sourcesPath,(value)=>{ chanSource(value).summary.sha256 = 'unknown'; }),/Invalid summary digest: chan-algorithmic-trading/));
test('runtime assets cannot reference evaluation cases',()=>mutated((base)=>bundleEdit(base,'src/skills/strategy-critique/procedure.md',(t)=>t+'\nCompare SC-01.\n'),/Runtime asset references evaluation material/));
test('runtime assets cannot contain links',()=>mutated((base)=>edit(base,chanNote,(t)=>t+'\n[OQ-03](../../../../docs/specs/03-model-backed-execution-spec.md)\n'),/Runtime asset contains a link/));
test('agent assets reject blockquotes',()=>mutated((base)=>edit(base,chanNote,(t)=>t+'\n> Quoted source text.\n'),/Blockquote not allowed/));
test('the critic category table must match OQ-03',()=>mutated((base)=>bundleEdit(base,'src/skills/strategy-critique/procedure.md',(t)=>t.replace(/^\| `operational_risk` \|.*\n/m,'')),/Critic procedure categories differ from OQ-03 §4: missing \[operational_risk\]/));
test('a new OQ-03 category requires the agent assets to change',()=>mutated((base)=>edit(base,'docs/specs/03-model-backed-execution-spec.md',(t)=>t.replace(/^(\| `method_advice` \|.*\n)/m,'$1| `new_category` | Example. |\n')),/Fixture policy categories differ from OQ-03 §4: missing \[new_category\]/));
test('the fixture policy must stay synthetic',()=>mutated((base)=>editJson(base,fixturePolicy,(value)=>{ value.synthetic = false; }),/Fixture policy must be marked synthetic/));
test('blocking treatments cannot escalate',()=>mutated((base)=>editJson(base,fixturePolicy,(value)=>{ value.treatments.causal_leakage.EVALUATING_TO_PAPER.escalate_when = ['required_evidence']; }),/Blocking treatment cannot escalate: causal_leakage/));
test('the fixture policy has one treatment per category and lifecycle transition, and S1 blocks none at DRAFT_TO_EVALUATING',()=>{
  mutated((base)=>editJson(base,fixturePolicy,(value)=>{ delete value.treatments.causal_leakage.DRAFT_TO_EVALUATING; }),/Fixture policy needs one treatment per transition \[DRAFT_TO_EVALUATING, EVALUATING_TO_PAPER\] for causal_leakage/);
  mutated((base)=>editJson(base,fixturePolicy,(value)=>{ value.treatments.hypothesis_assumption = { default: 'advisory' }; }),/Fixture policy needs one treatment per transition .* for hypothesis_assumption/);
  mutated((base)=>editJson(base,fixturePolicy,(value)=>{ value.transitions = ['DRAFT_TO_EVALUATING']; }),/Fixture policy transitions must be exactly \[DRAFT_TO_EVALUATING, EVALUATING_TO_PAPER\]/);
  mutated((base)=>editJson(base,fixturePolicy,(value)=>{ value.treatments.causal_leakage.DRAFT_TO_EVALUATING.default = 'blocking'; }),/No finding category blocks DRAFT_TO_EVALUATING in S1: causal_leakage/);
  mutated((base)=>editJson(base,fixturePolicy,(value)=>{ value.treatments.portfolio_fit.DRAFT_TO_EVALUATING.escalate_when = ['required_evidence']; }),/No finding category blocks DRAFT_TO_EVALUATING in S1: portfolio_fit/);
});
test('fresh cases must record consumption',()=>mutated((base)=>editJson(base,criticCases,(value)=>{ delete value.cases.find((item: any)=>item.split==='fresh').consumed; }),/consumed is required for fresh cases/));
test('finding treatment must follow the fixture policy for each transition',()=>{
  const flip = (transition: string) => (base: string) => editJson(base,criticCases,(value)=>{
    const finding = value.cases.flatMap((item: any)=>item.expected.findings).find((item: any)=>item.treatment[transition]==='blocking');
    finding.treatment[transition] = 'advisory';
  });
  mutated(flip('EVALUATING_TO_PAPER'),/treatment for [a-z_]+ at EVALUATING_TO_PAPER differs from fixture policy/);
  mutated((base)=>editJson(base,criticCases,(value)=>{ value.cases.flatMap((item: any)=>item.expected.findings)[0].treatment.DRAFT_TO_EVALUATING = 'blocking'; }),/treatment for [a-z_]+ at DRAFT_TO_EVALUATING differs from fixture policy/);
  mutated((base)=>editJson(base,criticCases,(value)=>{ value.cases.flatMap((item: any)=>item.expected.findings)[0].treatment = 'blocking'; }),/Invalid case SC-\d{2} in .*: expected\.findings\.treatment/);
});
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
const roleSchema = `${agents}/schemas/strategy-critique.result.schema.json`;
test('the role schemas are exactly the five listed files',()=>{
  mutated((base)=>writeFileSync(resolve(base,`${agents}/schemas/extra.schema.json`),'{}\n'),/Shipped file is not listed in the bundle manifest: packages\/agents\/schemas\/extra\.schema\.json/);
  mutated((base)=>rmSync(resolve(base,`${agents}/schemas/role-common.schema.json`)),/Missing agent asset: packages\/agents\/schemas\/role-common\.schema\.json/);
  mutated((base)=>writeFileSync(resolve(base,roleSchema),'{\n'),/Invalid JSON in packages\/agents\/schemas\/strategy-critique\.result\.schema\.json/);
});
test('the link and blockquote rules read Markdown only',()=>{
  const errors = mutationErrors((base)=>{
    editJson(base,sourcesPath,(value)=>{ value.description = `${value.description} Pattern [a](b).`; });
    bundleEdit(base,'schemas/strategy-critique.result.schema.json',(t)=>{ const value = JSON.parse(t); value.description = 'Matches [a](b) and > c.'; return JSON.stringify(value,null,2)+'\n'; });
  });
  assert.ok(!errors.some((error)=>error.includes(sourcesPath) || error.includes(roleSchema)),errors.join('\n'));
  mutated((base)=>edit(base,`${agents}/schemas/README.md`,(t)=>`${t}\n> Quoted schema text.\n`),/Blockquote not allowed in agent asset packages\/agents\/schemas\/README\.md/);
  mutated((base)=>bundleEdit(base,'src/skills/strategy-formulation/procedure.md',(t)=>`${t}\n[OQ-03](../../../../../docs/specs/03-model-backed-execution-spec.md)\n`),/Runtime asset contains a link: packages\/agents\/src\/skills\/strategy-formulation\/procedure\.md/);
});

// The behaviour-bundle manifest (OQ-03 section 3): an exact allowlist of paths and content hashes.
test('the baseline repository passes the bundle manifest check, and an edit that records its hash does too',()=>{
  const errors = mutationErrors((base)=>bundleEdit(base,'src/skills/strategy-formulation/procedure.md',(t)=>`${t}\nOne more sentence.\n`));
  assert.deepEqual(errors.filter((error)=>/bundle|Bundle|manifest/.test(error)),[],errors.join('\n'));
});
test('a missing or unreadable manifest fails',()=>{
  mutated((base)=>rmSync(resolve(base,manifestFile)),/Missing agent asset: packages\/agents\/bundle\.manifest\.json/);
  mutated((base)=>writeFileSync(resolve(base,manifestFile),'{\n'),/Invalid JSON in packages\/agents\/bundle\.manifest\.json/);
  mutated((base)=>writeFileSync(resolve(base,manifestFile),'[]\n'),/bundle manifest: the manifest is not an object/);
});
test('the manifest has exactly the reviewed keys, format, skills and an empty method list',()=>{
  mutated((base)=>editJson(base,manifestFile,(value)=>{ value.extra = true; }),/Bundle manifest keys must be exactly \[derived, files, format, id, methods, skills, version\]/);
  mutated((base)=>editJson(base,manifestFile,(value)=>{ value.format = 'openquant-agent-bundle/2'; }),/Bundle manifest format must be openquant-agent-bundle\/1/);
  mutated((base)=>editJson(base,manifestFile,(value)=>{ value.methods = ['CHAN-01']; }),/Bundle manifest methods must be an empty list: the baseline bundle adopts no method note/);
  mutated((base)=>editJson(base,manifestFile,(value)=>{ value.skills.reverse(); }),/Bundle manifest skills must be exactly \[strategy-formulation, strategy-critique\], in this order/);
  mutated((base)=>editJson(base,manifestFile,(value)=>{ value.skills[0].procedure = 'src/skills/other/procedure.md'; }),/Invalid bundle manifest skill: strategy-formulation/);
});
test('a listed file that is missing fails',()=>mutated((base)=>rmSync(resolve(base,roleSchema)),/Bundle file is missing: packages\/agents\/schemas\/strategy-critique\.result\.schema\.json/));
test('a shipped file whose content drifted from its recorded hash fails',()=>{
  mutated((base)=>edit(base,proposerProcedure,(t)=>`${t}\nOne more sentence.\n`),/Bundle file changed after the manifest recorded it: packages\/agents\/src\/skills\/strategy-formulation\/procedure\.md; run pnpm --filter @openquant\/agents run bundle:update/);
  mutated((base)=>editJson(base,roleSchema,(value)=>{ value.description = 'Changed.'; }),/Bundle file changed after the manifest recorded it: packages\/agents\/schemas\/strategy-critique\.result\.schema\.json/);
  mutated((base)=>editJson(base,manifestFile,(value)=>{ value.files[0].sha256 = 'sha256:short'; }),/Bundle file has no SHA-256 digest: schemas\/role-common\.schema\.json/);
});
test('an unlisted file among the shipped files fails',()=>{
  mutated((base)=>writeFileSync(resolve(base,`${agents}/src/skills/strategy-critique/notes.md`),'Notes.\n'),/Shipped file is not listed in the bundle manifest: packages\/agents\/src\/skills\/strategy-critique\/notes\.md/);
  mutated((base)=>writeFileSync(resolve(base,`${agents}/src/skills/strategy-critique/expected.json`),'{}\n'),/Shipped file is not listed in the bundle manifest: packages\/agents\/src\/skills\/strategy-critique\/expected\.json/);
  mutated((base)=>{ mkdirSync(resolve(base,`${agents}/schemas/sub`)); writeFileSync(resolve(base,`${agents}/schemas/sub/inner.json`),'{}\n'); },/Shipped file is not listed in the bundle manifest: packages\/agents\/schemas\/sub\/inner\.json/);
  mutated((base)=>writeFileSync(resolve(base,`${agents}/src/skills/strategy-critique/helper.ts`),'export const x = 1;\n'),/Shipped file is not listed in the bundle manifest: packages\/agents\/src\/skills\/strategy-critique\/helper\.ts/);
});
test('the manifest cannot list an evaluation file, an expected answer, a development script, a method note or a private snapshot',()=>{
  const cases: [string, string, RegExp][] = [
    ['evals/fixture-policy.json','{}\n',/Bundle file is an evaluation file: evals\/fixture-policy\.json/],
    ['fixtures/agent-results/context.pilot.json','{}\n',/Bundle file is an evaluation file: fixtures\/agent-results\/context\.pilot\.json/],
    ['src/skills/strategy-critique/expected.json','{}\n',/Bundle file is an expected answer: src\/skills\/strategy-critique\/expected\.json/],
    ['schemas/expected-findings.schema.json','{}\n',/Bundle file is an expected answer: schemas\/expected-findings\.schema\.json/],
    ['dev/eval-fixtures.ts','export {};\n',/Bundle file is a development script: dev\/eval-fixtures\.ts/],
    ['tools/generate.ts','export {};\n',/Bundle file is a development script: tools\/generate\.ts/],
    ['test/bundle.test.ts','export {};\n',/Bundle file is a development script: test\/bundle\.test\.ts/],
    ['src/index.ts','export {};\n',/Bundle file is a development script: src\/index\.ts/],
    ['src/methods/sources.json','{}\n',/Bundle file is a method note, which the baseline bundle does not adopt: src\/methods\/sources\.json/],
    ['src/methods/chan-algorithmic-trading.md','Note.\n',/Bundle file is a method note/],
    ['src/skills/strategy-critique/private-snapshot.md','Snapshot.\n',/Bundle file is a private snapshot: src\/skills\/strategy-critique\/private-snapshot\.md/],
    ['schemas/licensed.schema.json','{}\n',/Bundle file is a private snapshot: schemas\/licensed\.schema\.json/],
    ['README.md','Readme.\n',/Bundle file is not a procedure or a role schema: README\.md/],
    ['package.json','{}\n',/Bundle file is not a procedure or a role schema: package\.json/],
  ];
  for (const [path,content,expected] of cases) mutated((base)=>listInManifest(base,path,content),expected);
});
test('the manifest cannot list a path outside the package or a path twice, and its paths stay sorted',()=>{
  mutated((base)=>listInManifest(base,'../api-contracts/README.md','Readme.\n'),/Bundle file is not a canonical path inside the package: \.\.\/api-contracts\/README\.md/);
  mutated((base)=>listInManifest(base,'schemas/../README.md','Readme.\n'),/Bundle file is not a canonical path inside the package: schemas\/\.\.\/README\.md/);
  mutated((base)=>listInManifest(base,'/etc/hostname','host\n'),/Bundle file is not a relative path: \/etc\/hostname/);
  mutated((base)=>listInManifest(base,'C:/Windows/win.ini','x\n'),/Bundle file is not a relative path: C:\/Windows\/win\.ini/);
  mutated((base)=>listInManifest(base,'schemas\\role-common.schema.json','x\n'),/Bundle file is not a relative path/);
  mutated((base)=>editJson(base,manifestFile,(value)=>{ value.files.push(structuredClone(value.files[0])); }),/Bundle manifest files must be sorted by path, each path once/);
  mutated((base)=>editJson(base,manifestFile,(value)=>{ value.files.reverse(); }),/Bundle manifest files must be sorted by path, each path once/);
});
test('the derived entries name the result contracts with a digest',()=>{
  mutated((base)=>editJson(base,manifestFile,(value)=>{ value.derived.pop(); }),/Bundle manifest derived entries must name the result contracts \[strategy-formulation\.result\/1, strategy-critique\.result\/1\]/);
  mutated((base)=>editJson(base,manifestFile,(value)=>{ value.derived[0].sha256 = 'sha256:short'; }),/Bundle manifest derived entries must name the result contracts/);
});
test('procedures cite no method rule, no draft marker and no unknown front matter',()=>{
  mutated((base)=>bundleEdit(base,'src/skills/strategy-formulation/procedure.md',(t)=>`${t}\nSee CHAN-07.\n`),/Procedure cites a method rule, which the baseline bundle does not adopt: packages\/agents\/src\/skills\/strategy-formulation\/procedure\.md: CHAN-07/);
  mutated((base)=>bundleEdit(base,'src/skills/strategy-critique/procedure.md',(t)=>t.replace('bundle: baseline','status: draft')),/Invalid procedure metadata: packages\/agents\/src\/skills\/strategy-critique\/procedure\.md/);
  mutated((base)=>bundleEdit(base,'src/skills/strategy-critique/procedure.md',(t)=>t.replace('## Method selection','## Method choice')),/Procedure sections differ from/);
});
test('the Output section of a procedure must name every field of its result schema',()=>{
  const drop = (field: string) => (t: string) => { const at = t.indexOf('\n## Output\n'); return t.slice(0,at)+t.slice(at).replace(`\`${field}\``,field); };
  mutated((base)=>bundleEdit(base,'src/skills/strategy-formulation/procedure.md',drop('no_parent')),/Procedure Output section does not describe the result field `no_parent`: packages\/agents\/src\/skills\/strategy-formulation\/procedure\.md/);
  mutated((base)=>bundleEdit(base,'src/skills/strategy-critique/procedure.md',drop('affected_elements')),/Procedure Output section does not describe the result field `affected_elements`/);
  mutated((base)=>bundleEdit(base,'schemas/strategy-critique.result.schema.json',(t)=>{ const value = JSON.parse(t); value.$defs.CritiqueFinding.properties.confidence = { type: 'string' }; return JSON.stringify(value,null,2)+'\n'; }),/Procedure Output section does not describe the result field `confidence`/);
});
test('files in the explicitly listed non-bundle directories are accepted, and any other file is not',()=>{
  const errors = mutationErrors((base)=>{
    for (const path of ['src/helper.ts','src/nested/helper.ts','test/extra.test.ts','test/support/helper.ts','tools/extra.ts','dev/extra.ts']) {
      mkdirSync(resolve(base,agents,path,'..'),{recursive:true});
      writeFileSync(resolve(base,agents,path),'export {};\n');
    }
  });
  assert.ok(!errors.some((error)=>/agent asset/i.test(error)),errors.join('\n'));
  for (const path of ['scratch/notes.md','test/data.json','tools/run.js','dev/notes.md','evals/extra.json','evals/strategy-critique/notes.md','src/skills/helper.ts','src/methods/helper.ts','docs/note.md']) {
    mutated((base)=>{ mkdirSync(resolve(base,agents,path,'..'),{recursive:true}); writeFileSync(resolve(base,agents,path),'x\n'); },new RegExp(`Unexpected agent asset: packages/agents/${path.replaceAll('.','\\.')}`));
  }
});

// The offline agent fixtures: labelled synthetic responses (OQ-03 section 6).
test('agent fixtures are labelled synthetic and sit in their suite',()=>{
  const fixture = `${agentFixtures}/strategy-critique/empty-findings.json`;
  mutated((base)=>editJson(base,fixture,(value)=>{ value.label = 'recorded'; }),/Agent fixture must be labelled synthetic until a real model has produced it: fixtures\/agent-results\/strategy-critique\/empty-findings\.json/);
  mutated((base)=>editJson(base,`${agentFixtures}/context.pilot.json`,(value)=>{ value.label = 'recorded'; }),/Agent fixture must be labelled synthetic .*: fixtures\/agent-results\/context\.pilot\.json/);
  mutated((base)=>editJson(base,fixture,(value)=>{ value.id = 'other'; }),/Agent fixture suite and id must match its path/);
  mutated((base)=>editJson(base,fixture,(value)=>{ value.suite = 'strategy-formulation'; }),/Agent fixture suite and id must match its path/);
  mutated((base)=>editJson(base,fixture,(value)=>{ delete value.purpose; }),/Agent fixture states no purpose/);
  mutated((base)=>editJson(base,fixture,(value)=>{ value.response_text = 'x'; }),/Agent fixture needs a refusal and no response, or exactly one response and an expectation/);
  mutated((base)=>editJson(base,fixture,(value)=>{ delete value.expect; }),/Agent fixture needs a refusal and no response, or exactly one response and an expectation/);
  mutated((base)=>writeFileSync(resolve(base,`${agentFixtures}/strategy-critique/stray.txt`),'x\n'),/Unexpected agent fixture: fixtures\/agent-results\/strategy-critique\/stray\.txt/);
  mutated((base)=>{ mkdirSync(resolve(base,`${agentFixtures}/other-suite`)); writeFileSync(resolve(base,`${agentFixtures}/other-suite/x.json`),'{}\n'); },/Unexpected agent fixture: fixtures\/agent-results\/other-suite\/x\.json/);
});
test('a case links only responses that exist, in its own suite',()=>{
  mutated((base)=>editJson(base,criticCases,(value)=>{ value.cases[0].recorded_responses = [`${agentFixtures}/strategy-critique/missing.json`]; }),/untracked recorded response fixtures\/agent-results\/strategy-critique\/missing\.json/);
  mutated((base)=>editJson(base,criticCases,(value)=>{ value.cases[0].recorded_responses = [`${agentFixtures}/strategy-formulation/valid-revision-entry.json`]; }),/references a response of another suite/);
  mutated((base)=>editJson(base,criticCases,(value)=>{ value.cases[0].recorded_responses = ['packages/agents/README.md']; }),/untracked recorded response packages\/agents\/README\.md/);
});

// The evaluation command `pnpm agents:eval` (OQ-06 section 7): the root script generates the bundle module, then runs the
// harness of the agent runner, which is a tracked file. A change of the script, or no harness, fails the checks.
test('the agents:eval root script runs the generator and then the tracked harness',()=>{
  const script = 'node packages/agents/tools/generate.ts && node apps/agent-runner/tools/agents-eval.ts';
  assert.equal(JSON.parse(readFileSync(resolve(root,'package.json'),'utf8')).scripts['agents:eval'],script);
  assert.equal(expectedRootScripts['agents:eval'],script);
  for (const file of ['packages/agents/tools/generate.ts','apps/agent-runner/tools/agents-eval.ts']) assert.ok(existsSync(resolve(root,file)),file);
  workspaceMutation((base)=>editJson(base,'package.json',(value)=>{ value.scripts['agents:eval'] = 'node apps/agent-runner/tools/agents-eval.ts --mode live'; }),/^package\.json must have exactly these scripts/);
  workspaceMutation((base)=>editJson(base,'package.json',(value)=>{ delete value.scripts['agents:eval']; }),/^package\.json must have exactly these scripts/);
});

// S0: Rust verification, fixtures and protocol rules.
import { reportErrors, reportSections, caseSections, s0Rows, expectedCargoCommands, cargoCommandErrors, verifyDriverErrors, rustModuleErrors, withoutComments, expectedTypescriptCommands, typescriptCommandErrors, typescriptModuleErrors, environmentModuleErrors, spawnEnvironmentErrors, verifyModuleErrors, codeLines, workspacePackageList, workspaceTestFiles, workspaceErrors, scanSource, topLevelCode, topLevelErrors, ciVariableErrors, guardedModules, parseToml, cargoManifestErrors, pnpmWorkspaceErrors, expectedRootScripts, hookScript } from '../s0.ts';
import { isRemovedVariable, stepEnvironment } from '../environment.ts';
import { cargoCommands, toolchainChannel, toolchainPinError } from '../rust.ts';
import { typescriptCommands, dependencyInstallError, pinnedPnpm } from '../typescript.ts';

// The Cargo steps are compared with a literal list kept in scripts/s0.ts, not with the file they came from.
const steps: string[] = [...cargoCommands];
const withStep = (from: string, to?: string) => {
  assert.ok(steps.includes(from),`the live list no longer holds: ${from}`);
  return steps.flatMap((step)=>step===from ? (to===undefined ? [] : [to]) : [step]);
};
test('the literal list and the live Cargo steps agree',()=>{
  assert.deepEqual(cargoCommandErrors(cargoCommands),[]);
  assert.deepEqual(steps,[...expectedCargoCommands]);
});
test('a Cargo step cannot be dropped, shortened or changed',()=>{
  const fmt = 'cargo fmt --all --check';
  const clippy = 'cargo clippy --workspace --all-targets --locked -- -D warnings';
  const tests = 'cargo test --workspace --locked';
  const batch = steps.find((step)=>step.includes('--bin engine-batch'))!;
  const replay = steps.find((step)=>step.includes('--bin s0-replay'))!;
  const report = steps.find((step)=>step.includes('--bin contracts-report'))!;
  const mutations: Record<string,string[]> = {
    'drop fmt': withStep(fmt),
    'drop clippy': withStep(clippy),
    'drop test': withStep(tests),
    'drop replay': withStep(replay),
    'test with --lib': withStep(tests,`${tests} --lib`),
    'test with --no-run': withStep(tests,`${tests} --no-run`),
    'test without --locked': withStep(tests,'cargo test --workspace'),
    'clippy without -D warnings': withStep(clippy,clippy.replace(' -- -D warnings','')),
    'clippy without --locked': withStep(clippy,clippy.replace(' --locked','')),
    'replay without --locked': withStep(replay,replay.replace(' --locked','')),
    'replay to another directory': withStep(replay,replay.replace('local-runs/s0','local-runs/other')),
    'drop the engine-batch build': withStep(batch),
    'engine-batch build without --locked': withStep(batch,batch.replace(' --locked','')),
    'engine-batch build of another binary': withStep(batch,batch.replace('--bin engine-batch','--bin s0-replay')),
    'engine-batch build of the whole package': withStep(batch,batch.replace(' --bin engine-batch','')),
    'engine-batch build before the tests': [...steps.slice(0,2),batch,tests,...steps.slice(4)],
    'drop the contracts report': withStep(report),
    'contracts report without --locked': withStep(report,report.replace(' --locked','')),
    'contracts report to another directory': withStep(report,report.replace('local-runs/contracts','local-runs/other')),
    'contracts report before the replay': [...steps.slice(0,4),report,replay],
    'fmt without --check': withStep(fmt,'cargo fmt --all'),
    'no steps': [],
    'a step twice': [...steps,fmt],
    'an unexpected extra step': [...steps,'cargo build'],
    'reordered steps': [steps[1],steps[0],...steps.slice(2)],
  };
  for (const [name,list] of Object.entries(mutations)) assert.notDeepEqual(cargoCommandErrors(list),[],name);
  assert.match(cargoCommandErrors(withStep(fmt)).join('\n'),/scripts\/rust\.ts must run: cargo fmt --all --check/);
  assert.match(cargoCommandErrors(withStep(tests,`${tests} --lib`)).join('\n'),/must run: cargo test --workspace --locked[\s\S]*not expected: cargo test --workspace --locked --lib/);
});
// The list check imports the live module, so the wiring is proved by running the checker in a mutated copy. The checker
// runs as it does locally: without the CI, GITHUB_* and RUNNER_* variables, and without this runner's NODE_TEST_*.
function localEnvironment(): Record<string,string|undefined> {
  return Object.fromEntries(Object.entries(process.env).filter(([name])=>!/^(?:CI|GITHUB_.*|RUNNER_.*|NODE_TEST_.*)$/i.test(name)));
}
function checkerRun(change: (directory: string) => void, tests?: string) {
  const temporary = mkdtempSync(resolve(tmpdir(),'openquant-checker-'));
  try {
    const copy = resolve(temporary,'repo');
    copyRepository(root,copy);
    change(copy);
    const result = spawnSync(process.execPath,['scripts/check-repository.ts'],{cwd:copy,encoding:'utf8',env:localEnvironment()});
    // With a test name, the copy's own regression tests run as well, filtered to that test.
    const suite = tests === undefined ? undefined : spawnSync(process.execPath,['--test',`--test-name-pattern=${tests}`,'scripts/tests/repository.test.ts'],{cwd:copy,encoding:'utf8',env:localEnvironment()});
    return { status: result.status, output: `${result.stdout}${result.stderr}`, testStatus: suite?.status, testOutput: `${suite?.stdout ?? ''}${suite?.stderr ?? ''}` };
  } finally { rmSync(temporary,{recursive:true,force:true}); }
}
test('the repository check rejects a Cargo step dropped from scripts/rust.ts',()=>{
  const run = checkerRun((base)=>edit(base,'scripts/rust.ts',(t)=>t.replace("  'cargo fmt --all --check',\n",'')));
  assert.equal(run.status,1);
  assert.match(run.output,/scripts\/rust\.ts must run: cargo fmt --all --check/);
});
test('the repository check rejects a Cargo test step that runs no tests',()=>{
  const run = checkerRun((base)=>edit(base,'scripts/rust.ts',(t)=>t.replace("'cargo test --workspace --locked'","'cargo test --workspace --locked --lib'")));
  assert.equal(run.status,1);
  assert.match(run.output,/must run: cargo test --workspace --locked/);
});

const liveVerify = readFileSync(resolve(root,'scripts/verify.ts'),'utf8');
const liveRust = readFileSync(resolve(root,'scripts/rust.ts'),'utf8');
function replaceOnce(source: string, from: string, to: string): string {
  assert.equal(source.split(from).length,2,`the live source must hold this text exactly once: ${from}`);
  return source.replace(from,()=>to);
}
test('the live verify driver and Rust module hold every required code shape',()=>{
  assert.deepEqual(verifyDriverErrors(liveVerify),[]);
  assert.deepEqual(rustModuleErrors(liveRust),[]);
});
test('verify.ts cannot lose the exit-code, digest, toolchain pin or report checks',()=>{
  // The Cargo and TypeScript loops hold the same status check, so each mutation names its loop.
  const cargoRun = 'const status = runCargo(root, command);\n  ';
  const statusCheck = 'if (status !== 0) fail(`${command} exited with status ${status}`);';
  const mutations: Record<string,[string,RegExp]> = {
    'exit-code check removed': [replaceOnce(liveVerify,cargoRun+statusCheck,cargoRun),/run every Cargo command and fail on a non-zero exit status/],
    'exit-code check disabled': [replaceOnce(liveVerify,`${cargoRun}if (status !== 0) fail(`,`${cargoRun}if (false) fail(`),/run every Cargo command and fail on a non-zero exit status/],
    'exit-code check only in a line comment': [replaceOnce(liveVerify,cargoRun+statusCheck,`${cargoRun}// ${statusCheck}`),/run every Cargo command and fail on a non-zero exit status/],
    'exit-code check only in a block comment': [replaceOnce(liveVerify,cargoRun+statusCheck,`${cargoRun}/* ${statusCheck} */`),/run every Cargo command and fail on a non-zero exit status/],
    'Cargo steps not run': [liveVerify.replaceAll('runCargo','skipCargo'),/run every Cargo command and fail on a non-zero exit status/],
    'digest comparison disabled': [replaceOnce(liveVerify,"if (fixtureDigest(root) !== fixturesBefore) fail(",'if (false) fail('),/compare the fixture digest after the Cargo steps/],
    'digest comparison removed': [replaceOnce(liveVerify,/if \(fixtureDigest\(root\) !== fixturesBefore\) fail\([^\n]*\n/.exec(liveVerify)![0],''),/compare the fixture digest after the Cargo steps/],
    'digest never recorded': [replaceOnce(liveVerify,'const fixturesBefore = fixtureDigest(root);','const fixturesBefore = "";'),/record the fixture digest before the Cargo steps/],
    'pin check removed': [replaceOnce(liveVerify,'if (pinError) fail(pinError);',''),/fail when the pinned toolchain is not the one that runs/],
    'pin check only in a comment': [replaceOnce(liveVerify,'if (pinError) fail(pinError);','// if (pinError) fail(pinError);'),/fail when the pinned toolchain is not the one that runs/],
    'report check replaced': [replaceOnce(liveVerify,'const problems = reportErrors(root);','const problems: string[] = [];'),/fail on any replay report problem/],
    'report problems ignored': [replaceOnce(liveVerify,'if (problems.length) fail(problems.join(\'\\n\'));',''),/fail on any replay report problem/],
    'repository check status ignored': [replaceOnce(liveVerify,'if (result.status !== 0) process.exit(result.status ?? 1);',''),/stop when the repository checks or their tests fail/],
    'repository tests dropped': [replaceOnce(liveVerify,", ['--test', 'scripts/tests/repository.test.ts']",''),/stop when the repository checks or their tests fail/],
    'fail does not exit': [replaceOnce(liveVerify,'  process.exit(1);\n}','}'),/define fail\(\) to print "Verification failed" and exit with status 1/],
  };
  for (const [name,[source,expected]] of Object.entries(mutations)) {
    const errors = verifyDriverErrors(source);
    assert.ok(errors.some((error)=>expected.test(error)),`${name}: ${errors.join(' | ') || 'no error'}`);
  }
});
test('verify.ts checks must keep their order',()=>{
  const pin = 'const pinError = toolchainPinError(root);\nif (pinError) fail(pinError);\n';
  const moved = replaceOnce(liveVerify,pin,'').replace('// 3. The replay report',`${pin}// 3. The replay report`);
  assert.match(verifyDriverErrors(moved).join('\n'),/must fail when the pinned toolchain is not the one that runs before it can record the fixture digest/);
});
test('verify.ts cannot lose the dependency check, the TypeScript loop or its digest comparison',()=>{
  const typescriptRun = 'const status = runTypescript(root, command);\n  ';
  const statusCheck = 'if (status !== 0) fail(`${command} exited with status ${status}`);';
  const loop = /for \(const command of typescriptCommands\) \{[\s\S]*?\n\}\n/.exec(liveVerify)![0];
  const compare = /if \(fixtureDigest\(root\) !== typescriptFixturesBefore\) fail\([^\n]*\n/.exec(liveVerify)![0];
  const install = 'if (installError) fail(installError);';
  const mutations: Record<string,[string,RegExp]> = {
    'TypeScript loop removed': [replaceOnce(liveVerify,loop,''),/run every TypeScript command and fail on a non-zero exit status/],
    'TypeScript steps not run': [liveVerify.replaceAll('runTypescript','skipTypescript'),/run every TypeScript command and fail on a non-zero exit status/],
    'TypeScript status ignored': [replaceOnce(liveVerify,typescriptRun+statusCheck,typescriptRun),/run every TypeScript command and fail on a non-zero exit status/],
    'TypeScript status check disabled': [replaceOnce(liveVerify,`${typescriptRun}if (status !== 0) fail(`,`${typescriptRun}if (false) fail(`),/run every TypeScript command and fail on a non-zero exit status/],
    'TypeScript status check only in a comment': [replaceOnce(liveVerify,typescriptRun+statusCheck,`${typescriptRun}// ${statusCheck}`),/run every TypeScript command and fail on a non-zero exit status/],
    'TypeScript digest comparison removed': [replaceOnce(liveVerify,compare,''),/compare the fixture digest after the TypeScript steps/],
    'TypeScript digest comparison only in a comment': [replaceOnce(liveVerify,compare,`/* ${compare.trim()} */\n`),/compare the fixture digest after the TypeScript steps/],
    'TypeScript digest never recorded': [replaceOnce(liveVerify,'const typescriptFixturesBefore = fixtureDigest(root);','const typescriptFixturesBefore = fixturesBefore;'),/record the fixture digest before the TypeScript steps/],
    'dependency check removed': [replaceOnce(liveVerify,install,''),/fail when the installed dependencies do not match pnpm-lock\.yaml/],
    'dependency check only in a comment': [replaceOnce(liveVerify,install,`// ${install}`),/fail when the installed dependencies do not match pnpm-lock\.yaml/],
    'dependency check replaced': [replaceOnce(liveVerify,'const installError = dependencyInstallError(root);','const installError = undefined;'),/fail when the installed dependencies do not match pnpm-lock\.yaml/],
  };
  for (const [name,[source,expected]] of Object.entries(mutations)) {
    const errors = verifyDriverErrors(source);
    assert.ok(errors.some((error)=>expected.test(error)),`${name}: ${errors.join(' | ') || 'no error'}`);
  }
});
test('the TypeScript block must follow the report check and come before the success message',()=>{
  const block = liveVerify.slice(liveVerify.indexOf('// 4. TypeScript'),liveVerify.indexOf("console.log('\\nVerification passed"));
  const early = replaceOnce(liveVerify,block,'').replace('// 3. The replay report',`${block}// 3. The replay report`);
  assert.match(verifyDriverErrors(early).join('\n'),/must fail on any replay report problem before it can fail when the installed dependencies do not match pnpm-lock\.yaml/);
  const late = `${replaceOnce(liveVerify,block,'')}\n${block}`;
  assert.match(verifyDriverErrors(late).join('\n'),/must compare the fixture digest after the TypeScript steps before it can report success only after those checks/);
  const install = 'const installError = dependencyInstallError(root);\nif (installError) fail(installError);\n';
  const checkLast = replaceOnce(liveVerify,install,'').replace("\nconsole.log('\\nVerification passed",`\n${install}console.log('\\nVerification passed`);
  assert.match(verifyDriverErrors(checkLast).join('\n'),/must fail when the installed dependencies do not match pnpm-lock\.yaml before it can record the fixture digest before the TypeScript steps/);
});
const liveTypescript = readFileSync(resolve(root,'scripts/typescript.ts'),'utf8');
const liveEnvironment = readFileSync(resolve(root,'scripts/environment.ts'),'utf8');
test('the live TypeScript module holds every required code shape and the expected steps',()=>{
  assert.deepEqual(typescriptModuleErrors(liveTypescript),[]);
  assert.deepEqual(typescriptCommandErrors(typescriptCommands),[]);
  assert.deepEqual([...typescriptCommands],[...expectedTypescriptCommands]);
});
test('typescript.ts cannot ignore the exit status, drop its environment, skip the lockfile comparison or install',()=>{
  const mutations: Record<string,[string,RegExp]> = {
    'status ignored': [replaceOnce(liveTypescript,'return result.status ?? 1;','return 0;'),/runTypescript must return the exit status/],
    'status only in a comment': [replaceOnce(liveTypescript,'return result.status ?? 1;','// return result.status ?? 1;\n  return 0;'),/runTypescript must return the exit status/],
    'environment not passed': [replaceOnce(liveTypescript,"{ cwd: base, stdio: 'inherit', env: stepEnvironment() }","{ cwd: base, stdio: 'inherit' }"),/runTypescript must run each step with env: stepEnvironment\(\)/],
    'lockfile comparison disabled': [replaceOnce(liveTypescript,'if (!readFileSync(installed).equals(readFileSync(wanted))) {','if (false) {'),/compare node_modules\/\.pnpm\/lock\.yaml with pnpm-lock\.yaml/],
    'lockfile comparison only in a comment': [replaceOnce(liveTypescript,'if (!readFileSync(installed).equals(readFileSync(wanted))) {','// if (!readFileSync(installed).equals(readFileSync(wanted))) {\n  if (false) {'),/compare node_modules\/\.pnpm\/lock\.yaml with pnpm-lock\.yaml/],
    'pnpm version not compared': [replaceOnce(liveTypescript,'if (result.stdout.trim() !== pinned) {','if (false) {'),/compare the running pnpm version with packageManager/],
    'silent install': [replaceOnce(liveTypescript,"spawnSync('pnpm', ['--version']","spawnSync('pnpm', ['install']"),/must never install, add or update dependencies/],
    'instruction weakened': [replaceOnce(liveTypescript,"installCommand = 'pnpm install --frozen-lockfile'","installCommand = 'pnpm install'"),/must tell the user to run: pnpm install --frozen-lockfile/],
  };
  for (const [name,[source,expected]] of Object.entries(mutations)) {
    const errors = typescriptModuleErrors(source);
    assert.ok(errors.some((error)=>expected.test(error)),`${name}: ${errors.join(' | ') || 'no error'}`);
  }
  const telemetry = environmentModuleErrors(replaceOnce(liveEnvironment,"environment.TURBO_TELEMETRY_DISABLED = '1';",''));
  assert.ok(telemetry.some((error)=>/TURBO_TELEMETRY_DISABLED=1/.test(error)),telemetry.join(' | '));
  const install = environmentModuleErrors(replaceOnce(liveEnvironment,"environment.pnpm_config_verify_deps_before_run = 'error';","environment.pnpm_config_verify_deps_before_run = 'install';"));
  assert.ok(install.some((error)=>/verify-deps-before-run=error/.test(error)),install.join(' | '));
});
test('a TypeScript step cannot be dropped, cached, changed or joined by an install',()=>{
  const live: string[] = [...typescriptCommands];
  const [check,turbo,tests] = live;
  const mutations: Record<string,string[]> = {
    'drop turbo': [check,tests],
    'turbo without --force': [check,turbo.replace(' --force',''),tests],
    'turbo without test': [check,turbo.replace(' test ',' '),tests],
    'drop the workspace checks': [turbo,tests],
    'drop the workspace tests': [check,turbo],
    'an install step': ['pnpm install --frozen-lockfile',...live],
    'reordered steps': [turbo,check,tests],
    'a step twice': [...live,turbo],
    'no steps': [],
    'workspace tests by a glob': [check,turbo,'pnpm exec node --test scripts/workspace/tests/*.test.ts'],
    'workspace tests without the reporter': [check,turbo,tests.replace(' --test-reporter=./scripts/workspace/test-reporter.ts --test-reporter-destination=stderr','')],
    'a workspace test file left out': [check,turbo,tests.replace(' scripts/workspace/tests/tasks.test.ts','')],
  };
  for (const [name,list] of Object.entries(mutations)) assert.notDeepEqual(typescriptCommandErrors(list),[],name);
  assert.match(typescriptCommandErrors([check,turbo.replace(' --force',''),tests]).join('\n'),/scripts\/typescript\.ts must run: pnpm exec turbo run typecheck lint test build --force[\s\S]*not expected: pnpm exec turbo run typecheck lint test build$/m);
  assert.deepEqual(workspaceTestFiles.map((file)=>tests.includes(` ${file}`)),workspaceTestFiles.map(()=>true),'the test step names every workspace test file');
});
test('the repository check rejects a TypeScript step dropped from scripts/typescript.ts',()=>{
  const run = checkerRun((base)=>edit(base,'scripts/typescript.ts',(t)=>replaceOnce(t,"  'pnpm exec node scripts/workspace/check-workspace.ts',\n",'')));
  assert.equal(run.status,1);
  assert.match(run.output,/scripts\/typescript\.ts must run: pnpm exec node scripts\/workspace\/check-workspace\.ts/);
});
test('pnpm must fail instead of installing before a script',()=>{
  mutated((base)=>edit(base,'pnpm-workspace.yaml',(t)=>replaceOnce(t,'verifyDepsBeforeRun: error\n','')),/pnpm-workspace\.yaml must set verifyDepsBeforeRun: error/);
  mutated((base)=>edit(base,'pnpm-workspace.yaml',(t)=>replaceOnce(t,'verifyDepsBeforeRun: error\n','verifyDepsBeforeRun: install\n')),/pnpm-workspace\.yaml must set verifyDepsBeforeRun: error/);
  mutated((base)=>edit(base,'pnpm-workspace.yaml',(t)=>replaceOnce(t,'verifyDepsBeforeRun: error\n','# verifyDepsBeforeRun: error\n')),/pnpm-workspace\.yaml must set verifyDepsBeforeRun: error/);
});
test('the repository check rejects a verify.ts without its dependency check',()=>mutated((base)=>edit(base,'scripts/verify.ts',(t)=>replaceOnce(t,'if (installError) fail(installError);',''))
  ,/scripts\/verify\.ts must fail when the installed dependencies do not match pnpm-lock\.yaml/));
test('rust.ts cannot ignore the exit status or the pinned version',()=>{
  assert.match(rustModuleErrors(replaceOnce(liveRust,'return result.status ?? 1;','return 0;')).join('\n'),/runCargo must return the exit status/);
  assert.match(rustModuleErrors(replaceOnce(liveRust,'return result.status ?? 1;','// return result.status ?? 1;\n  return 0;')).join('\n'),/runCargo must return the exit status/);
  assert.match(rustModuleErrors(replaceOnce(liveRust,'if (!result.stdout.startsWith(`rustc ${channel} `)) {','if (false) {')).join('\n'),/compare the installed rustc version/);
});
test('comments are removed but string literals are kept',()=>{
  assert.equal(withoutComments("const a = 'https://x'; // gone\nconst b = `//kept`; /* gone */ const c = \"/*kept*/\";").replace(/\s+/g,' '),"const a = 'https://x'; const b = `//kept`; const c = \"/*kept*/\";");
});
test('the repository check rejects a verify.ts without its exit-code check',()=>mutated((base)=>edit(base,'scripts/verify.ts',(t)=>replaceOnce(t,'runCargo(root, command);\n  if (status !== 0) fail(','runCargo(root, command);\n  if (false) fail(')),/scripts\/verify\.ts must run every Cargo command and fail on a non-zero exit status/));
test('the repository check rejects a runCargo that returns success',()=>mutated((base)=>edit(base,'scripts/rust.ts',(t)=>replaceOnce(t,'return result.status ?? 1;','return 0;')),/runCargo must return the exit status/));

// Behavioural tests of the verify driver. The real scripts run in a temporary root. Its other inputs are
// stand-ins: scripts/check-repository.ts and scripts/tests/repository.test.ts (the driver's Node steps would
// otherwise run this test file again), and `cargo`, `rustc` and `pnpm`, which are shell scripts placed first
// on PATH. The root also holds package.json, a lockfile and, unless a test removes or changes it, the copy
// that pnpm writes on install. The driver, rust.ts, typescript.ts, s0.ts and the rest of scripts/ are
// byte-for-byte copies, so nothing in a normal verification run can switch a step off.
interface Driver {
  cases?: string[]; replay?: string[] | 'failing' | 'none'; checkStatus?: number; testsFail?: boolean;
  cargoFails?: string; touchFixtures?: boolean; rustc?: string;
  pnpmFails?: string; touchFixturesInTypescript?: boolean; install?: 'current' | 'missing' | 'stale'; pnpmVersion?: string;
  inherit?: Record<string,string>; edit?: Record<string,(text: string) => string>;
}
// The variables that stepEnvironment() removes (scripts/environment.ts), written out again here: every stand-in
// refuses to run when one of them reaches it. TURBO_TELEMETRY_DISABLED=1 and pnpm_config_verify_deps_before_run=error
// are the two values that the driver sets itself.
const removedVariables = '^(BASH_ENV|ENV|NODE_OPTIONS|RUSTFLAGS|RUSTDOCFLAGS|RUSTDOC|RUSTC_WRAPPER|RUSTC_WORKSPACE_WRAPPER|CARGO_BUILD_RUSTFLAGS|CARGO_BUILD_RUSTDOCFLAGS|CARGO_BUILD_RUSTDOC|CARGO_ENCODED_RUSTFLAGS|CARGO_ENCODED_RUSTDOCFLAGS|CARGO_BUILD_RUSTC_WRAPPER|CARGO_BUILD_RUSTC_WORKSPACE_WRAPPER|BIOME_CONFIG_PATH|NODE_TEST_[A-Z0-9_]*|TURBO_[A-Z0-9_]*|(NPM|PNPM)_CONFIG_[^=]*|CARGO_TARGET_[A-Z0-9_]+_(RUNNER|RUSTFLAGS|RUSTDOCFLAGS|LINKER))=';
const shellLeakCheck = (tool: string) => `leaked=$(env | grep -iE "$STAND_IN_REMOVED" | grep -v '^TURBO_TELEMETRY_DISABLED=1$' | grep -v '^pnpm_config_verify_deps_before_run=error$' | cut -d= -f1 | tr '\\n' ' '); if [ -n "$leaked" ]; then echo "stand-in ${tool}: removed variable reached the step: $leaked" >&2; exit 3; fi`;
// The stand-in tests run under node --test, which sets NODE_TEST_CONTEXT and NODE_TEST_WORKER_ID for them itself;
// the stand-in repository checks, started with the same environment, see every removed variable.
const nodeLeakCheck = (tool: string, own: string = '^$') => `const leaked = Object.entries(process.env).filter(([name, value]) => new RegExp(process.env.STAND_IN_REMOVED ?? '', 'i').test(\`\${name}=\`) && !(name === 'TURBO_TELEMETRY_DISABLED' && value === '1') && !(name === 'pnpm_config_verify_deps_before_run' && value === 'error') && !/${own}/.test(name)).map(([name]) => name);\nif (leaked.length > 0) { console.error(\`stand-in ${tool}: removed variable reached the step: \${leaked.join(' ')}\`); process.exit(3); }\n`;
function driverRun(options: Driver = {}) {
  const temporary = mkdtempSync(resolve(tmpdir(),'openquant-driver-'));
  try {
    const base = resolve(temporary,'root');
    const bin = resolve(temporary,'bin');
    const cases = options.cases ?? ['CASE-1'];
    mkdirSync(resolve(base,'scripts/tests'),{recursive:true});
    mkdirSync(bin);
    for (const file of readdirSync(resolve(root,'scripts')).filter((name)=>name.endsWith('.ts'))) copyFileSync(resolve(root,'scripts',file),resolve(base,'scripts',file));
    for (const [file,change] of Object.entries(options.edit ?? {})) edit(base,file,change);
    writeFileSync(resolve(base,'scripts/check-repository.ts'),`${nodeLeakCheck('repository checks')}console.log('stand-in repository checks');\nprocess.exit(${options.checkStatus ?? 0});\n`);
    writeFileSync(resolve(base,'scripts/tests/repository.test.ts'),`import test from 'node:test';\n${nodeLeakCheck('repository tests','^NODE_TEST_(CONTEXT|WORKER_ID)$')}test('stand-in repository tests',()=>{${options.testsFail ? " throw new Error('stand-in failure');" : ''}});\n`);
    copyFileSync(resolve(root,'rust-toolchain.toml'),resolve(base,'rust-toolchain.toml'));
    copyFileSync(resolve(root,'package.json'),resolve(base,'package.json'));
    const lockfile = 'lockfileVersion: \'9.0\'\n\nimporters:\n\n  .: {}\n';
    writeFileSync(resolve(base,'pnpm-lock.yaml'),lockfile);
    if ((options.install ?? 'current') !== 'missing') {
      mkdirSync(resolve(base,'node_modules/.pnpm'),{recursive:true});
      writeFileSync(resolve(base,'node_modules/.pnpm/lock.yaml'),options.install === 'stale' ? lockfile.replace('{}','{ devDependencies: {} }') : lockfile);
    }
    for (const id of cases) { mkdirSync(resolve(base,`fixtures/s0/cases/${id}`),{recursive:true}); writeFileSync(resolve(base,`fixtures/s0/cases/${id}/case.json`),'{}\n'); }
    const replay = options.replay ?? cases;
    if (replay !== 'none') {
      const ids = replay === 'failing' ? cases : replay;
      mkdirSync(resolve(temporary,'replay'));
      writeFileSync(resolve(temporary,'replay/report.md'),replayReport(ids));
      writeFileSync(resolve(temporary,'replay/index.json'),replayIndex(ids,replay !== 'failing'));
    }
    // One log for every stand-in, so the tests can check the order across Cargo and TypeScript steps.
    const log = resolve(temporary,'steps.log');
    writeFileSync(resolve(bin,'cargo'),[
      '#!/bin/sh',
      'echo "cargo $*" >> "$STAND_IN_LOG"',
      shellLeakCheck('cargo'),
      'if [ "$STAND_IN_FAIL" = "$*" ]; then echo "stand-in cargo fails: $*" >&2; exit 1; fi',
      'if [ "$1" = test ] && [ -n "$STAND_IN_TOUCH" ]; then echo changed >> fixtures/s0/cases/CASE-1/case.json; fi',
      'if [ "$1" = run ] && [ -d "$STAND_IN_REPLAY" ]; then mkdir -p local-runs/s0 && cp "$STAND_IN_REPLAY"/* local-runs/s0/; fi',
      'exit 0',
      '',
    ].join('\n'),{mode:0o755});
    writeFileSync(resolve(bin,'rustc'),`#!/bin/sh\n${shellLeakCheck('rustc')}\necho '${options.rustc ?? `rustc ${toolchainChannel(root)} (stand-in 2000-01-01)`}'\n`,{mode:0o755});
    // The stand-in pnpm answers the version check, records each step and refuses to run a step without the
    // environment that stepEnvironment() sets, or with a variable that it removes. It never installs anything.
    writeFileSync(resolve(bin,'pnpm'),[
      '#!/bin/sh',
      shellLeakCheck('pnpm'),
      'if [ "$1" = --version ]; then echo "$STAND_IN_PNPM_VERSION"; exit 0; fi',
      'echo "pnpm $*" >> "$STAND_IN_LOG"',
      'if [ "$TURBO_TELEMETRY_DISABLED" != 1 ] || [ "$pnpm_config_verify_deps_before_run" != error ]; then echo "stand-in pnpm: step environment not set" >&2; exit 2; fi',
      'if [ "$STAND_IN_PNPM_FAIL" = "$*" ]; then echo "stand-in pnpm fails: $*" >&2; exit 1; fi',
      'if [ "$2" = turbo ] && [ -n "$STAND_IN_PNPM_TOUCH" ]; then echo changed >> fixtures/s0/cases/CASE-1/case.json; fi',
      'exit 0',
      '',
    ].join('\n'),{mode:0o755});
    const env: Record<string,string|undefined> = { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}`, STAND_IN_LOG: log, STAND_IN_REPLAY: resolve(temporary,'replay'),
      STAND_IN_FAIL: options.cargoFails ?? '', STAND_IN_TOUCH: options.touchFixtures ? '1' : '', STAND_IN_REMOVED: removedVariables,
      STAND_IN_PNPM_FAIL: options.pnpmFails ?? '', STAND_IN_PNPM_TOUCH: options.touchFixturesInTypescript ? '1' : '', STAND_IN_PNPM_VERSION: options.pnpmVersion ?? pinnedPnpm(root) };
    delete env.NODE_TEST_CONTEXT; // a nested `node --test` must run as a runner, not as a child of this one
    delete env.TURBO_TELEMETRY_DISABLED; // the driver must set these two itself
    delete env.pnpm_config_verify_deps_before_run;
    Object.assign(env,options.inherit ?? {});
    const result = spawnSync(process.execPath,['scripts/verify.ts'],{cwd:base,env,encoding:'utf8',timeout:60000});
    const steps = existsSync(log) ? readFileSync(log,'utf8').split('\n').filter(Boolean) : [];
    const only = (tool: string) => steps.filter((line)=>line.startsWith(`${tool} `)).map((line)=>line.slice(tool.length+1));
    return { status: result.status, stdout: result.stdout, stderr: result.stderr, steps, cargo: only('cargo'), pnpm: only('pnpm') };
  } finally { rmSync(temporary,{recursive:true,force:true}); }
}
const driverSkip = process.platform === 'win32' ? 'the driver tests use sh stand-ins for cargo, rustc and pnpm' : false;
const cargoArguments = expectedCargoCommands.map((command)=>command.replace(/^cargo /,''));
const pnpmArguments = expectedTypescriptCommands.map((command)=>command.replace(/^pnpm /,''));
test('the verify driver runs every Cargo step, then every TypeScript step, in order, and passes when all pass',{skip:driverSkip},()=>{
  const run = driverRun();
  assert.equal(run.status,0,`${run.stdout}${run.stderr}`);
  assert.match(run.stdout,/Verification passed/);
  assert.deepEqual(run.cargo,cargoArguments);
  assert.deepEqual(run.pnpm,pnpmArguments);
  assert.deepEqual(run.steps,[...expectedCargoCommands,...expectedTypescriptCommands]);
});
test('the verify driver fails when any one Cargo step exits non-zero, and runs nothing after it',{skip:driverSkip},()=>{
  cargoArguments.forEach((step,position)=>{
    const run = driverRun({cargoFails:step});
    assert.equal(run.status,1,step);
    assert.ok(run.stderr.includes(`Verification failed: ${expectedCargoCommands[position]} exited with status 1`),`${step}: ${run.stderr}`);
    assert.ok(!run.stdout.includes('Verification passed'),step);
    assert.deepEqual(run.cargo,cargoArguments.slice(0,position+1),step);
    assert.deepEqual(run.pnpm,[],step);
  });
});
test('the verify driver fails when any one TypeScript step exits non-zero, and runs nothing after it',{skip:driverSkip},()=>{
  pnpmArguments.forEach((step,position)=>{
    const run = driverRun({pnpmFails:step});
    assert.equal(run.status,1,step);
    assert.ok(run.stderr.includes(`Verification failed: ${expectedTypescriptCommands[position]} exited with status 1`),`${step}: ${run.stderr}`);
    assert.ok(!run.stdout.includes('Verification passed'),step);
    assert.deepEqual(run.cargo,cargoArguments,step);
    assert.deepEqual(run.pnpm,pnpmArguments.slice(0,position+1),step);
  });
});
test('the verify driver fails before any TypeScript step when the install is missing or stale, and says how to install',{skip:driverSkip},()=>{
  for (const [install,message] of [['missing',/Verification failed: The dependencies in pnpm-lock\.yaml are not installed\. Run: pnpm install --frozen-lockfile/],['stale',/Verification failed: The installed dependencies do not match pnpm-lock\.yaml\. Run: pnpm install --frozen-lockfile/]] as const) {
    const run = driverRun({install});
    assert.equal(run.status,1,install);
    assert.match(run.stderr,message,install);
    assert.deepEqual(run.cargo,cargoArguments,install);
    assert.deepEqual(run.pnpm,[],install);
    assert.ok(!run.stdout.includes('Verification passed'),install);
  }
  const version = driverRun({pnpmVersion:'10.0.0'});
  assert.equal(version.status,1);
  assert.match(version.stderr,/Verification failed: Expected pnpm \d+\.\d+\.\d+ from package\.json, found: 10\.0\.0\. Install pnpm \d+\.\d+\.\d+, then Run: pnpm install --frozen-lockfile/);
  assert.deepEqual(version.pnpm,[]);
});
test('the dependency check explains a missing pnpm',()=>{
  const saved = process.env.PATH;
  process.env.PATH = resolve(tmpdir(),'openquant-no-pnpm-here');
  try { assert.match(dependencyInstallError(root) ?? '',/pnpm was not found on PATH\. Verification needs pnpm \d+\.\d+\.\d+ .*Run: pnpm install --frozen-lockfile/); }
  finally { process.env.PATH = saved; }
});
test('the verify driver fails when a TypeScript step changes a fixture',{skip:driverSkip},()=>{
  const run = driverRun({touchFixturesInTypescript:true});
  assert.equal(run.status,1);
  assert.match(run.stderr,/Verification failed: fixtures changed while the TypeScript steps ran/);
  assert.ok(!run.stdout.includes('Verification passed'));
});
test('the verify driver fails before any Cargo step when the pinned toolchain is not the one that runs',{skip:driverSkip},()=>{
  const run = driverRun({rustc:'rustc 0.0.1 (stand-in 2000-01-01)'});
  assert.equal(run.status,1);
  assert.match(run.stderr,/Verification failed: Expected rustc \d+\.\d+\.\d+ from rust-toolchain\.toml, found: rustc 0\.0\.1/);
  assert.deepEqual(run.steps,[]);
});
test('the verify driver fails when a Cargo step changes a fixture',{skip:driverSkip},()=>{
  const run = driverRun({touchFixtures:true});
  assert.equal(run.status,1);
  assert.match(run.stderr,/Verification failed: fixtures changed while verification ran/);
  assert.ok(!run.stdout.includes('Verification passed'));
  assert.deepEqual(run.pnpm,[]);
});
test('the verify driver fails on a replay report problem',{skip:driverSkip},()=>{
  const failing = driverRun({replay:'failing'});
  assert.equal(failing.status,1);
  assert.match(failing.stderr,/Verification failed: [\s\S]*Replay case failed: CASE-1/);
  assert.deepEqual(failing.pnpm,[]);
  const missing = driverRun({replay:'none'});
  assert.equal(missing.status,1);
  assert.match(missing.stderr,/Verification failed: Missing replay report/);
  const partial = driverRun({cases:['CASE-1','CASE-2'],replay:['CASE-1']});
  assert.equal(partial.status,1);
  assert.match(partial.stderr,/Verification failed: [\s\S]*omits the fixture case CASE-2/);
  assert.ok(!partial.stdout.includes('Verification passed'));
});
test('the verify driver stops before Cargo when the repository checks or their tests fail',{skip:driverSkip},()=>{
  const check = driverRun({checkStatus:3});
  assert.equal(check.status,3);
  assert.deepEqual(check.steps,[]);
  const tests = driverRun({testsFail:true});
  assert.notEqual(tests.status,0);
  assert.deepEqual(tests.steps,[]);
  assert.ok(!tests.stdout.includes('Verification passed'));
});

// C6: verify.ts must equal its reviewed code (scripts/s0.ts), so a statement added anywhere fails the repository
// checks, which run as step 1 of verify and as their own CI step before any install (C6R).
const stepOne = '// 1. Repository checks';
test('C6: verify.ts cannot exit early or change the environment before step 1',()=>{
  const early = replaceOnce(liveVerify,stepOne,`if (process.env.CI) process.exit(0);\n${stepOne}`);
  assert.match(verifyDriverErrors(early).join('\n'),/scripts\/verify\.ts must keep the reviewed code of the whole file \(scripts\/s0\.ts\), comments and blank lines aside; code line \d+ differs: expected "for \(const args of .*found "if \(process\.env\.CI\) process\.exit\(0\);"/);
  const poisoned = replaceOnce(liveVerify,stepOne,`process.env.NODE_OPTIONS = '--test-skip-pattern=.';\n${stepOne}`);
  assert.match(verifyDriverErrors(poisoned).join('\n'),/must keep the reviewed code of the whole file .*found "process\.env\.NODE_OPTIONS = '--test-skip-pattern=\.';"/);
  const appended = `${liveVerify}\nprocess.exitCode = 0;\n`;
  assert.match(verifyDriverErrors(appended).join('\n'),/expected "\(nothing\)", found "process\.exitCode = 0;"/);
});
test('C6: comments and blank lines of verify.ts may change, its code may not',()=>{
  assert.deepEqual(verifyDriverErrors(liveVerify.replace(stepOne,`${stepOne}, explained at more length\n\n// over two lines`)),[]);
  assert.match(verifyDriverErrors(liveVerify.replace("stdio: 'inherit', env: stepEnvironment() });","stdio: 'inherit' });")).join('\n'),/code line \d+ differs/);
  assert.deepEqual(codeLines('a; // x\n\n  /* y */\nb;   \nconst c = "//";\n'),['a;','b;','const c = "//";']);
});
test('C6: the repository check rejects the reviewer\'s early exit in verify.ts',()=>{
  const run = checkerRun((base)=>edit(base,'scripts/verify.ts',(t)=>replaceOnce(t,stepOne,`if (process.env.CI) process.exit(0);\n${stepOne}`)));
  assert.equal(run.status,1);
  assert.match(run.output,/scripts\/verify\.ts must keep the reviewed code of the whole file/);
});
test('C6: a module that verify.ts imports cannot exit early, read the environment or replace a function',()=>{
  const assets = readFileSync(resolve(root,'scripts/agent-assets.ts'),'utf8');
  assert.deepEqual(verifyModuleErrors('scripts/agent-assets.ts',assets),[]);
  const cases: Array<[string,RegExp]> = [
    ['if (process.env.CI) process.exit(0);',/scripts\/agent-assets\.ts must not use process:/],
    ["globalThis['process'].exit(0);",/must not use globalThis:/],
    ["const later = await import('node:process');",/must not use import\(\):/],
    ["eval('1');",/must not use eval:/],
    ["Array.prototype.includes = () => true;",/must not use prototype:/],
  ];
  for (const [statement,expected] of cases) assert.match(verifyModuleErrors('scripts/agent-assets.ts',`${assets}\n${statement}\n`).join('\n'),expected,statement);
  assert.match(verifyModuleErrors('scripts/rust.ts',`${liveRust}\nrunCargo = () => 0;\n`).join('\n'),/scripts\/rust\.ts must not reassign its function runCargo/);
  assert.match(verifyModuleErrors('scripts/typescript.ts',`${liveTypescript}\ndependencyInstallError ??= () => undefined;\n`).join('\n'),/must not reassign its function dependencyInstallError/);
  mutated((base)=>edit(base,'scripts/repository.ts',(t)=>`${t}\nif (process.env.CI) process.exit(0);\n`),/scripts\/repository\.ts must not use process/);
  mutated((base)=>edit(base,'scripts/repository.ts',(t)=>replaceOnce(t,"export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');","export const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');")),/scripts\/repository\.ts must set root to the directory above scripts\//);
});

// C7: every process that verification starts takes stepEnvironment(), which removes the variables that could
// switch a step off. One example of each removed name and pattern.
const removedExamples: Record<string,string> = {
  BASH_ENV: '/tmp/openquant-no-such-env.sh', ENV: '/tmp/openquant-no-such-env.sh', NODE_OPTIONS: '--test-skip-pattern=.', NODE_TEST_CONTEXT: 'child-v8',
  RUSTFLAGS: '--cap-lints=allow', RUSTDOCFLAGS: '--cap-lints=allow', RUSTC_WRAPPER: 'true', RUSTC_WORKSPACE_WRAPPER: 'true',
  CARGO_BUILD_RUSTFLAGS: '--cap-lints=allow', CARGO_BUILD_RUSTDOCFLAGS: '--cap-lints=allow', CARGO_ENCODED_RUSTFLAGS: '--cap-lints=allow', CARGO_ENCODED_RUSTDOCFLAGS: '--cap-lints=allow',
  CARGO_BUILD_RUSTC_WRAPPER: 'true', CARGO_BUILD_RUSTC_WORKSPACE_WRAPPER: 'true', CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_RUNNER: 'true',
  CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_RUSTFLAGS: '--cap-lints=allow', CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_RUSTDOCFLAGS: '--cap-lints=allow', CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_LINKER: 'true',
  TURBO_FORCE: 'false', TURBO_TELEMETRY_DISABLED: '0', BIOME_CONFIG_PATH: '/tmp',
  RUSTDOC: 'true', CARGO_BUILD_RUSTDOC: 'true', // the binary that runs the Rust doc tests (guards-2)
  pnpm_config_node_options: '--test-skip-pattern=.', PNPM_CONFIG_NODE_OPTIONS: '--test-skip-pattern=.', npm_config_node_options: '--test-skip-pattern=.', NPM_CONFIG_NODE_OPTIONS: '--test-skip-pattern=.', // pnpm turns these into NODE_OPTIONS (guards-1)
  pnpm_config_script_shell: '/bin/true', NPM_CONFIG_USERCONFIG: '/tmp/openquant-no-such-npmrc',
};
test('C7: stepEnvironment removes the variables that could switch a step off and keeps proxy, certificate and toolchain variables',()=>{
  for (const name of [...Object.keys(removedExamples),'node_options','Rustflags','Rustdoc','npm_config_user_agent','Pnpm_Config_Registry']) assert.ok(isRemovedVariable(name),name);
  const kept = ['PATH','HOME','HTTPS_PROXY','NO_PROXY','NODE_EXTRA_CA_CERTS','SSL_CERT_FILE','RUSTUP_TOOLCHAIN','RUSTUP_HOME','CARGO_HOME','CARGO_TARGET_DIR','CARGO_INCREMENTAL','CARGO_PROFILE_DEV_DEBUG','CARGO_TERM_COLOR','CARGO_BUILD_JOBS','RUSTDOCX','NPM_CONFIGURED'];
  for (const name of kept) assert.ok(!isRemovedVariable(name),name);
  const saved = { ...process.env };
  try {
    Object.assign(process.env,removedExamples,{OPENQUANT_KEPT:'kept'});
    const environment = stepEnvironment();
    for (const name of Object.keys(removedExamples).filter((name)=>name!=='TURBO_TELEMETRY_DISABLED')) assert.equal(environment[name],undefined,name);
    assert.equal(environment.TURBO_TELEMETRY_DISABLED,'1');
    assert.equal(environment.pnpm_config_verify_deps_before_run,'error');
    assert.equal(environment.OPENQUANT_KEPT,'kept');
    assert.equal(environment.PATH,process.env.PATH);
  } finally {
    for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name];
    Object.assign(process.env,saved);
  }
});
test('C7: the verify driver removes every inherited variable before any step starts',{skip:driverSkip},()=>{
  const run = driverRun({inherit:removedExamples});
  assert.equal(run.status,0,`${run.stdout}${run.stderr}`);
  assert.match(run.stdout,/Verification passed/);
  assert.deepEqual(run.steps,[...expectedCargoCommands,...expectedTypescriptCommands]);
});
test('C7: a stand-in fails when a removed variable reaches its step, so the driver tests catch a leak',{skip:driverSkip},()=>{
  const spawnOptions = "{ cwd: base, stdio: 'inherit', env: stepEnvironment() }";
  const cargo = driverRun({edit:{'scripts/rust.ts':(t)=>replaceOnce(t,spawnOptions,"{ cwd: base, stdio: 'inherit', env: { ...stepEnvironment(), CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_RUNNER: 'true' } }")}});
  assert.equal(cargo.status,1);
  assert.match(cargo.stderr,/stand-in cargo: removed variable reached the step: CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_RUNNER/);
  assert.match(cargo.stderr,/Verification failed: cargo fmt --all --check exited with status 3/);
  const pnpm = driverRun({edit:{'scripts/typescript.ts':(t)=>replaceOnce(t,spawnOptions,"{ cwd: base, stdio: 'inherit', env: { ...stepEnvironment(), NODE_OPTIONS: '--test-skip-pattern=.' } }")}});
  assert.equal(pnpm.status,1);
  assert.match(pnpm.stderr,/stand-in pnpm: removed variable reached the step: NODE_OPTIONS/);
  assert.match(pnpm.stderr,new RegExp(`Verification failed: ${expectedTypescriptCommands[0]} exited with status 3`));
  assert.deepEqual(pnpm.cargo,cargoArguments);
  const repository = driverRun({inherit:{NODE_OPTIONS:'--test-skip-pattern=.'},edit:{'scripts/environment.ts':(t)=>replaceOnce(t,"  'NODE_OPTIONS',\n",'')}});
  assert.equal(repository.status,3);
  assert.match(repository.stderr,/stand-in repository checks: removed variable reached the step: NODE_OPTIONS/);
  assert.deepEqual(repository.steps,[]);
  // The stand-ins also catch a pnpm setting and the Rust doc test binary, each let through by a copy that drops its rule.
  const pnpmSetting = driverRun({inherit:{pnpm_config_node_options:'--test-skip-pattern=.'},edit:{'scripts/environment.ts':(t)=>replaceOnce(t,'/^(?:NPM|PNPM)_CONFIG_/, ','')}});
  assert.equal(pnpmSetting.status,3);
  assert.match(pnpmSetting.stderr,/stand-in repository checks: removed variable reached the step: (?:\S+ )*pnpm_config_node_options/);
  for (const [name,line] of [['RUSTDOC',"  'RUSTDOC',\n"],['CARGO_BUILD_RUSTDOC',"  'CARGO_BUILD_RUSTDOC',\n"]] as const) {
    const doctest = driverRun({inherit:{[name]:'true'},edit:{'scripts/environment.ts':(t)=>replaceOnce(t,line,'')}});
    assert.equal(doctest.status,3,name);
    assert.match(doctest.stderr,new RegExp(`stand-in repository checks: removed variable reached the step: ${name}`));
  }
});
test('C7: the guards reject the reviewer\'s environment edits of runCargo and runTypescript',()=>{
  const cargoEnv = replaceOnce(liveRust,"  const result = spawnSync(program, args, { cwd: base, stdio: 'inherit', env: stepEnvironment() });","  const env = args[0] === 'test' ? { ...process.env, CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_RUNNER: 'true' } : process.env;\n  const result = spawnSync(program, args, { cwd: base, stdio: 'inherit', env });");
  const rust = rustModuleErrors(cargoEnv).join('\n');
  assert.match(rust,/scripts\/rust\.ts must keep the reviewed code of runCargo/);
  assert.match(rust,/scripts\/rust\.ts: every spawnSync call must pass env: stepEnvironment\(\) as the last option \(1 of 2 do\)/);
  assert.match(rust,/scripts\/rust\.ts must not use process/);
  const typescriptEnv = replaceOnce(liveTypescript,"  const result = spawnSync(program, args, { cwd: base, stdio: 'inherit', env: stepEnvironment() });","  const result = spawnSync(program, args, { cwd: base, stdio: 'inherit', env: { ...stepEnvironment(), NODE_OPTIONS: '--test-skip-pattern=.' } });");
  const typescript = typescriptModuleErrors(typescriptEnv).join('\n');
  assert.match(typescript,/scripts\/typescript\.ts must keep the reviewed code of runTypescript/);
  assert.match(typescript,/scripts\/typescript\.ts: every spawnSync call must pass env: stepEnvironment\(\)/);
  assert.match(environmentModuleErrors(replaceOnce(liveEnvironment,"  'RUSTFLAGS',\n",'')).join('\n'),/scripts\/environment\.ts must keep the reviewed code of the whole file/);
  assert.match(environmentModuleErrors(replaceOnce(liveEnvironment,"/^TURBO_/, ",'')).join('\n'),/scripts\/environment\.ts must keep the reviewed code of the whole file/);
  assert.match(environmentModuleErrors(replaceOnce(liveEnvironment,"/^(?:NPM|PNPM)_CONFIG_/, ",'')).join('\n'),/scripts\/environment\.ts must keep the reviewed code of the whole file/);
  for (const line of ["  'RUSTDOC',\n","  'CARGO_BUILD_RUSTDOC',\n"]) {
    assert.match(environmentModuleErrors(replaceOnce(liveEnvironment,line,'')).join('\n'),/scripts\/environment\.ts must keep the reviewed code of the whole file/,line);
  }
});
// guards-1: pnpm turns pnpm_config_node_options into the NODE_OPTIONS of the process that `pnpm exec node` starts, so
// an inherited setting could switch off the workspace checks and tests. This test runs the real pnpm, at the version
// pinned in package.json, in a scratch project (pnpm applies the setting there because of the packageManager field)
// with a test that fails and a setting that skips every test. With the setting in the environment the run exits 0,
// which shows that the setting switches the step off; with the environment of stepEnvironment() it exits 1. The
// project has no dependencies, so pnpm's check of installed dependencies is off here.
function stepEnvironmentWith(variables: Record<string,string>) {
  const saved = { ...process.env };
  try {
    Object.assign(process.env,variables);
    return stepEnvironment();
  } finally {
    for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name];
    Object.assign(process.env,saved);
  }
}
test('C7: a pnpm setting in the environment cannot switch off a step that pnpm exec starts',{skip:driverSkip},()=>{
  const temporary = mkdtempSync(resolve(tmpdir(),'openquant-pnpm-setting-'));
  try {
    writeFileSync(resolve(temporary,'package.json'),JSON.stringify({name:'scratch',private:true,packageManager:`pnpm@${pinnedPnpm(root)}`}));
    writeFileSync(resolve(temporary,'fails.test.ts'),"import test from 'node:test';\ntest('fails',()=>{ throw new Error('expected failure'); });\n");
    const run = (environment: Record<string,string|undefined>) => {
      const result = spawnSync('pnpm',['exec','node','--test','fails.test.ts'],{cwd:temporary,encoding:'utf8',timeout:60000,env:{...environment,pnpm_config_verify_deps_before_run:'false'}});
      assert.equal(result.error,undefined,`this test runs the real pnpm ${pinnedPnpm(root)}: ${result.error?.message}`);
      return result;
    };
    const skipAll = '--test-skip-pattern=.';
    const switchedOff = run({...stepEnvironment(),pnpm_config_node_options:skipAll});
    assert.equal(switchedOff.status,0,`the setting switches the step off when it reaches pnpm: ${switchedOff.stdout}${switchedOff.stderr}`);
    assert.equal(run(stepEnvironment()).status,1,'the failing test fails the step');
    for (const name of ['pnpm_config_node_options','PNPM_CONFIG_NODE_OPTIONS','npm_config_node_options','NPM_CONFIG_NODE_OPTIONS']) {
      const result = run(stepEnvironmentWith({[name]:skipAll}));
      assert.equal(result.status,1,`${name} must not switch off the step: ${result.stdout}${result.stderr}`);
    }
  } finally { rmSync(temporary,{recursive:true,force:true}); }
});
test('C7: every spawnSync in a verification script passes stepEnvironment()',()=>{
  const repository = readFileSync(resolve(root,'scripts/repository.ts'),'utf8');
  assert.deepEqual(spawnEnvironmentErrors('scripts/repository.ts',repository),[]);
  const withoutEnvironment = replaceOnce(repository,", encoding: 'utf8', env: stepEnvironment() });",", encoding: 'utf8' });");
  assert.match(spawnEnvironmentErrors('scripts/repository.ts',withoutEnvironment).join('\n'),/every spawnSync call must pass env: stepEnvironment\(\) as the last option \(0 of 1 do\)/);
  assert.match(spawnEnvironmentErrors('scripts/repository.ts',repository.replace("import { spawnSync } from 'node:child_process';","import { spawnSync, execSync } from 'node:child_process';")).join('\n'),/may import only spawnSync from node:child_process/);
  const header = "import { spawnSync } from 'node:child_process';\nimport { stepEnvironment } from './environment.ts';\n";
  assert.match(spawnEnvironmentErrors('x.ts',`${header}const run = spawnSync;\nrun('x', [], { env: stepEnvironment() });\n`).join('\n'),/\(0 of 1 do\)/);
  assert.match(spawnEnvironmentErrors('x.ts',`${header}spawnSync('x', [], { env: stepEnvironment(), ...{ env: {} } });\n`).join('\n'),/\(0 of 1 do\)/);
  assert.match(spawnEnvironmentErrors('x.ts',`${header}const stepEnvironment = () => ({});\nspawnSync('x', [], { env: stepEnvironment() });\n`).join('\n'),/must import stepEnvironment from scripts\/environment\.ts and not define its own/);
  mutated((base)=>edit(base,'scripts/repository.ts',(t)=>replaceOnce(t,", encoding: 'utf8', env: stepEnvironment() });",", encoding: 'utf8' });")),/scripts\/repository\.ts: every spawnSync call must pass env: stepEnvironment\(\)/);
  mutated((base)=>edit(base,'scripts/workspace/tasks.ts',(t)=>replaceOnce(t,', env: stepEnvironment() });',' });')),/scripts\/workspace\/tasks\.ts: every spawnSync call must pass env: stepEnvironment\(\)/);
});

// U1: Cargo configuration and manifests can switch off what the Cargo steps check.
const cargoConfig = '[build]\nrustflags = ["--cap-lints", "allow"]\n[target.x86_64-unknown-linux-gnu]\nrunner = ["sh", "-c", \'case "$0" in */deps/*) exit 0 ;; esac; exec "$0" "$@"\']\n';
test('U1: a tracked Cargo configuration fails, at the root or in a crate',()=>{
  mutated((base)=>{ mkdirSync(resolve(base,'.cargo')); writeFileSync(resolve(base,'.cargo/config.toml'),cargoConfig); },/Cargo configuration must not be tracked: \.cargo\/config\.toml/);
  mutated((base)=>{ mkdirSync(resolve(base,'packages/api-contracts/rust/.cargo')); writeFileSync(resolve(base,'packages/api-contracts/rust/.cargo/config'),cargoConfig); },/Cargo configuration must not be tracked: packages\/api-contracts\/rust\/\.cargo\/config$/);
});
test('U1: a manifest cannot turn off test discovery or a test harness',()=>{
  const settings: Array<[string,string,string]> = [
    ['packages/api-contracts/rust/Cargo.toml','autotests','[package]\nautotests = false\n'],
    ['packages/quant-core/Cargo.toml','autobins','[package]\nautobins = false\n'],
    ['apps/engine/Cargo.toml','test','[package]\n'],
    ['packages/api-contracts/rust/Cargo.toml','harness','[package]\n'],
  ];
  for (const [manifest,key,head] of settings) {
    const tail = key === 'test' ? '\n[lib]\ntest = false\n' : key === 'harness' ? '\n[[test]]\nname = "registry"\nharness = false\n' : '';
    mutated((base)=>edit(base,manifest,(t)=>`${replaceOnce(t,'[package]\n',head)}${tail}`),new RegExp(`${manifest.replaceAll('.','\\.')} must not set (?:package|lib|test\\[0\\])\\.${key} = false: Cargo would leave tests unbuilt or unrun`));
  }
});

// C8: the scripts and configuration behind the Turborepo tasks are pinned or checked, and a test task fails when
// it ran no test or skipped one (see also scripts/workspace/tests/reporters.test.ts).
const contractsManifest = 'packages/api-contracts/ts/package.json';
const runnerManifest = 'apps/agent-runner/package.json';
const clientManifest = 'packages/api-client/package.json';
const cliManifest = 'apps/cli/package.json';
// workspaceErrors reads only the workspace configuration, the package and scripts/workspace, so most of its
// mutations use a small copy of those files and call it directly. The reviewer's edits below run the whole
// repository check on a full copy, which proves that s0Errors applies these rules.
function workspaceMutation(change: (directory: string) => void, expected: RegExp) {
  const temporary = mkdtempSync(resolve(tmpdir(),'openquant-workspace-'));
  try {
    const kept = (file: string) => file.startsWith('packages/api-contracts/ts/') || file.startsWith('apps/api/') || file.startsWith('packages/agents/') || file.startsWith('apps/agent-runner/') || file.startsWith('packages/api-client/') || file.startsWith('apps/cli/') || file.startsWith('scripts/workspace/') || ['package.json','pnpm-workspace.yaml','tsconfig.base.json','biome.json'].includes(file);
    for (const file of paths(root).filter(kept)) { mkdirSync(resolve(temporary,file,'..'),{recursive:true}); copyFileSync(resolve(root,file),resolve(temporary,file)); }
    assert.deepEqual(workspaceErrors(temporary,new Set(paths(temporary))),[],'the small copy passes before the change');
    change(temporary);
    const errors = workspaceErrors(temporary,new Set(paths(temporary)));
    assert.ok(errors.some((error)=>expected.test(error)),`Expected rejection matching ${expected}: ${errors.join(' | ') || 'no error'}`);
  } finally { rmSync(temporary,{recursive:true,force:true}); }
}
const vitestConfig = 'packages/api-contracts/ts/vitest.config.ts';
test('C8: the reviewer\'s four edits behind the TypeScript tasks fail',()=>{
  mutated((base)=>editJson(base,contractsManifest,(value)=>{ value.scripts.test = 'node tools/generate.ts'; }),/packages\/api-contracts\/ts\/package\.json must have the test script "node tools\/generate\.ts && vitest run --reporter=default --reporter=\.\/test-reporter\.ts", found "node tools\/generate\.ts"/);
  mutated((base)=>edit(base,vitestConfig,(t)=>replaceOnce(t,'    passWithNoTests: false,\n',"    passWithNoTests: false,\n    testNamePattern: 'zzz-no-test-has-this-name',\n")),/vitest\.config\.ts must not set testNamePattern/);
  mutated((base)=>editJson(base,'tsconfig.base.json',(value)=>{ value.compilerOptions.noCheck = true; }),/tsconfig\.base\.json must not set noCheck/);
  mutated((base)=>editJson(base,'biome.json',(value)=>{ value.linter.enabled = false; }),/biome\.json linter must be \{"enabled":true,"rules":\{"preset":"recommended"\}\}, found \{"enabled":false/);
});
test('C8: every task script of the package is pinned',()=>{
  for (const task of ['typecheck','lint','build'] as const) {
    workspaceMutation((base)=>editJson(base,contractsManifest,(value)=>{ value.scripts[task] = 'node tools/generate.ts'; }),new RegExp(`package\\.json must have the ${task} script`));
  }
  workspaceMutation((base)=>editJson(base,contractsManifest,(value)=>{ value.scripts.test = value.scripts.test.replace(' --reporter=./test-reporter.ts',''); }),/must have the test script/);
});
test('C8: Vitest cannot pass an empty run or allow .only, and the reporters and Vitest configuration are pinned',()=>{
  workspaceMutation((base)=>edit(base,vitestConfig,(t)=>replaceOnce(t,'passWithNoTests: false','passWithNoTests: true')),/vitest\.config\.ts must set passWithNoTests: false, and only that/);
  workspaceMutation((base)=>edit(base,vitestConfig,(t)=>replaceOnce(t,'    passWithNoTests: false,\n','    passWithNoTests: false,\n    allowOnly: true,\n')),/vitest\.config\.ts must not set allowOnly/);
  workspaceMutation((base)=>edit(base,vitestConfig,(t)=>replaceOnce(t,"include: ['test/**/*.test.ts']","include: ['test/parity.test.ts']")),/packages\/api-contracts\/ts\/vitest\.config\.ts changed: review the change, then set its SHA-256 in pinnedFiles/);
  workspaceMutation((base)=>edit(base,'packages/api-contracts/ts/test-reporter.ts',(t)=>replaceOnce(t,'      process.exitCode = 1;\n','')),/packages\/api-contracts\/ts\/test-reporter\.ts changed/);
  workspaceMutation((base)=>edit(base,'scripts/workspace/test-reporter.ts',(t)=>replaceOnce(t,'    process.exitCode = 1;\n','')),/scripts\/workspace\/test-reporter\.ts changed/);
});
// guards-3: scripts/workspace/check-workspace.ts runs the five dependency-using guards and decides the exit status,
// so a deleted guard call or an exit status of 0 would let step 1 of the TypeScript steps print its success line
// without running a guard. The file is pinned by SHA-256 like the reporters.
test('C8: check-workspace.ts is pinned: a deleted guard call or an exit status of 0 fails the repository check',()=>{
  const guards = ['Licences','Import boundaries','Workflows','Turborepo tasks','Cargo test targets'];
  const source = readFileSync(resolve(root,'scripts/workspace/check-workspace.ts'),'utf8');
  for (const label of guards) assert.ok(new RegExp(`^guard\\('${label}', `,'m').test(source),`${label} is still a guard call`);
  const changed = /scripts\/workspace\/check-workspace\.ts changed: review the change, then set its SHA-256 in pinnedFiles in scripts\/s0\.ts to [0-9a-f]{64}/;
  for (const label of guards) {
    const run = checkerRun((base)=>edit(base,'scripts/workspace/check-workspace.ts',(t)=>t.replace(new RegExp(`^guard\\('${label}', .*\\n`,'m'),'')));
    assert.equal(run.status,1,label);
    assert.match(run.output,changed,label);
  }
  const exitZero = checkerRun((base)=>edit(base,'scripts/workspace/check-workspace.ts',(t)=>replaceOnce(t,'process.exit(1);','process.exit(0);')));
  assert.equal(exitZero.status,1);
  assert.match(exitZero.output,changed);
  workspaceMutation((base)=>edit(base,'scripts/workspace/check-workspace.ts',(t)=>replaceOnce(t,'process.exit(1);','process.exit(0);')),changed);
});
test('C8: test sources cannot skip, focus or postpone a test, and sources cannot switch off a check',()=>{
  // Any test file of the package with a top-level test() call, so the test does not depend on one file's text.
  const testFile = paths(root).find((file)=>/^packages\/api-contracts\/ts\/test\/.+\.test\.ts$/.test(file) && /^\s*test\(/m.test(readFileSync(resolve(root,file),'utf8')));
  assert.ok(testFile,'the package has a test file with a test() call');
  const name = testFile.split('/').at(-1)!.replaceAll('.','\\.');
  for (const modifier of ['skip','only','todo','skipIf','runIf']) {
    workspaceMutation((base)=>edit(base,testFile,(t)=>t.replace(/^(\s*)test\(/m,`$1test.${modifier}(`)),new RegExp(`${name} must not use \\.${modifier}: every test runs in verification`));
  }
  workspaceMutation((base)=>edit(base,'packages/api-contracts/ts/src/index.ts',(t)=>`// @ts-nocheck\n${t}`),/src\/index\.ts must not use @ts-nocheck/);
  workspaceMutation((base)=>edit(base,'packages/api-contracts/ts/src/index.ts',(t)=>`// biome-ignore-all lint: none\n${t}`),/src\/index\.ts must not use biome-ignore-all/);
  workspaceMutation((base)=>editJson(base,'packages/api-contracts/ts/tsconfig.json',(value)=>{ value.compilerOptions.strict = false; }),/packages\/api-contracts\/ts\/tsconfig\.json must not turn strict off/);
  workspaceMutation((base)=>editJson(base,'tsconfig.base.json',(value)=>{ delete value.compilerOptions.strict; }),/tsconfig\.base\.json must set strict: true/);
  workspaceMutation((base)=>writeFileSync(resolve(base,'packages/api-contracts/ts/biome.json'),'{"root":false,"linter":{"enabled":false}}\n'),/Only the root biome\.json may configure Biome: packages\/api-contracts\/ts\/biome\.json/);
  workspaceMutation((base)=>editJson(base,'biome.json',(value)=>{ value.overrides = [{ includes: ['src/**'], linter: { enabled: false } }]; }),/biome\.json must not set overrides/);
});

// C9 and U0: the workspace packages and the workspace test files are literal lists in scripts/s0.ts.
test('C9: the reviewer\'s empty workspace fails: pnpm-workspace.yaml must list exactly the expected packages',()=>{
  mutated((base)=>edit(base,'pnpm-workspace.yaml',(t)=>replaceOnce(t,'  - packages/api-contracts/ts\n','  - packages/none-yet\n')),/pnpm-workspace\.yaml must list exactly these packages, one per line, in this order: packages\/api-contracts\/ts, apps\/api, packages\/agents, apps\/agent-runner, packages\/api-client, apps\/cli; found packages\/none-yet, apps\/api, packages\/agents, apps\/agent-runner, packages\/api-client, apps\/cli/);
  workspaceMutation((base)=>edit(base,'pnpm-workspace.yaml',(t)=>replaceOnce(t,'  - apps/api\n','  - packages/agents\n  - apps/api\n')),/found packages\/api-contracts\/ts, packages\/agents, apps\/api, packages\/agents, apps\/agent-runner, packages\/api-client, apps\/cli/);
  workspaceMutation((base)=>edit(base,'pnpm-workspace.yaml',(t)=>replaceOnce(t,'  - apps/cli\n','  - apps/cli\n  - packages/other\n')),/found packages\/api-contracts\/ts, apps\/api, packages\/agents, apps\/agent-runner, packages\/api-client, apps\/cli, packages\/other/);
  workspaceMutation((base)=>edit(base,'pnpm-workspace.yaml',(t)=>replaceOnce(t,'  - apps/cli\n','')),/found packages\/api-contracts\/ts, apps\/api, packages\/agents, apps\/agent-runner, packages\/api-client$/);
  workspaceMutation((base)=>edit(base,'pnpm-workspace.yaml',(t)=>replaceOnce(t,'  - packages/api-client\n','')),/found packages\/api-contracts\/ts, apps\/api, packages\/agents, apps\/agent-runner, apps\/cli$/);
  workspaceMutation((base)=>edit(base,'pnpm-workspace.yaml',(t)=>replaceOnce(t,'  - packages/agents\n','')),/found packages\/api-contracts\/ts, apps\/api, apps\/agent-runner, packages\/api-client, apps\/cli$/);
  workspaceMutation((base)=>editJson(base,clientManifest,(value)=>{ value.name = '@openquant/other'; }),/package\.json must be named @openquant\/api-client/);
  workspaceMutation((base)=>editJson(base,cliManifest,(value)=>{ value.name = '@openquant/other'; }),/package\.json must be named @openquant\/cli/);
  workspaceMutation((base)=>editJson(base,runnerManifest,(value)=>{ value.name = '@openquant/other'; }),/package\.json must be named @openquant\/agent-runner/);
  workspaceMutation((base)=>editJson(base,contractsManifest,(value)=>{ value.name = '@openquant/other'; }),/package\.json must be named @openquant\/api-contracts/);
  assert.equal(workspacePackageList('packages: [packages/api-contracts/ts]\n'),undefined);
  assert.deepEqual(workspacePackageList('# list\npackages:\n  # one\n  - a\n\n  - b\nother: x\n  - c\n'),['a','b']);
});
test('U0: every workspace test file must be tracked and named in the test step',()=>{
  workspaceMutation((base)=>rmSync(resolve(base,'scripts/workspace/tests/workflows.test.ts')),/Missing workspace test file: scripts\/workspace\/tests\/workflows\.test\.ts/);
  workspaceMutation((base)=>writeFileSync(resolve(base,'scripts/workspace/tests/extra.test.ts'),"import test from 'node:test';\ntest('x',()=>{});\n"),/Workspace test file is not run by verification: scripts\/workspace\/tests\/extra\.test\.ts/);
  // The reviewer's rename of the test directory, after which the glob matched no file and the step passed.
  mutated((base)=>renameSync(resolve(base,'scripts/workspace/tests'),resolve(base,'scripts/workspace/specs')),/Missing workspace test file: scripts\/workspace\/tests\/boundaries\.test\.ts/);
});

// P4 part B: the agent runner is a workspace package like the others, so its task scripts, its Vitest configuration and
// its reporter are pinned and its tests cannot be skipped. The import boundary of the runner is tested in
// scripts/workspace/tests/boundaries.test.ts.
test('P4: the task scripts of the agent runner are pinned',()=>{
  for (const task of ['typecheck','lint','test','build'] as const) {
    workspaceMutation((base)=>editJson(base,runnerManifest,(value)=>{ value.scripts[task] = 'node --version'; }),new RegExp(`apps/agent-runner/package\\.json must have the ${task} script`));
  }
  workspaceMutation((base)=>editJson(base,runnerManifest,(value)=>{ value.scripts.test = value.scripts.test.replace(' --reporter=./test-reporter.ts',''); }),/apps\/agent-runner\/package\.json must have the test script/);
  workspaceMutation((base)=>editJson(base,runnerManifest,(value)=>{ value.scripts.postinstall = 'node -e 0'; }),/apps\/agent-runner\/package\.json/);
});
test('P4: the Vitest configuration and the reporter of the agent runner are pinned and cannot skip a test',()=>{
  const config = 'apps/agent-runner/vitest.config.ts';
  workspaceMutation((base)=>edit(base,config,(t)=>replaceOnce(t,'passWithNoTests: false','passWithNoTests: true')),/apps\/agent-runner\/vitest\.config\.ts must set passWithNoTests: false, and only that/);
  workspaceMutation((base)=>edit(base,config,(t)=>replaceOnce(t,"include: ['test/**/*.test.ts']","include: ['test/config.test.ts']")),/apps\/agent-runner\/vitest\.config\.ts changed: review the change, then set its SHA-256 in pinnedFiles/);
  workspaceMutation((base)=>edit(base,'apps/agent-runner/test-reporter.ts',(t)=>replaceOnce(t,'      process.exitCode = 1;\n','')),/apps\/agent-runner\/test-reporter\.ts changed/);
  const testFile = 'apps/agent-runner/test/config.test.ts';
  for (const modifier of ['skip','only','todo']) {
    workspaceMutation((base)=>edit(base,testFile,(t)=>t.replace(/^(\s*)it\(/m,`$1it.${modifier}(`)),/config\.test\.ts must not use \.(?:skip|only|todo): every test runs in verification/);
  }
  workspaceMutation((base)=>editJson(base,'apps/agent-runner/tsconfig.json',(value)=>{ value.compilerOptions.strict = false; }),/apps\/agent-runner\/tsconfig\.json must not turn strict off/);
});

// P5.2: the API client and the CLI are workspace packages like the others: their task scripts, Vitest configurations
// and reporters are pinned and their tests cannot be skipped. Their import boundaries are tested in
// scripts/workspace/tests/boundaries.test.ts.
test('P5.2: the task scripts of the API client and the CLI are pinned',()=>{
  for (const [directory, manifest] of [['packages/api-client',clientManifest],['apps/cli',cliManifest]] as const) {
    for (const task of ['typecheck','lint','test','build'] as const) {
      workspaceMutation((base)=>editJson(base,manifest,(value)=>{ value.scripts[task] = 'node --version'; }),new RegExp(`${directory}/package\\.json must have the ${task} script`));
    }
    workspaceMutation((base)=>editJson(base,manifest,(value)=>{ value.scripts.test = value.scripts.test.replace(' --reporter=./test-reporter.ts',''); }),new RegExp(`${directory}/package\\.json must have the test script`));
    workspaceMutation((base)=>editJson(base,manifest,(value)=>{ value.scripts.prepare = 'node -e 0'; }),new RegExp(`${directory}/package\\.json must not have the prepare script`));
  }
});
test('P5.2: the Vitest configurations and reporters of the API client and the CLI are pinned and cannot skip a test',()=>{
  for (const [directory, testFile] of [['packages/api-client','packages/api-client/test/client.test.ts'],['apps/cli','apps/cli/test/format.test.ts']] as const) {
    workspaceMutation((base)=>edit(base,`${directory}/vitest.config.ts`,(t)=>replaceOnce(t,'passWithNoTests: false','passWithNoTests: true')),new RegExp(`${directory}/vitest\\.config\\.ts must set passWithNoTests: false, and only that`));
    workspaceMutation((base)=>edit(base,`${directory}/test-reporter.ts`,(t)=>replaceOnce(t,'      process.exitCode = 1;\n','')),new RegExp(`${directory}/test-reporter\\.ts changed`));
    workspaceMutation((base)=>edit(base,testFile,(t)=>t.replace(/^(\s*)it\(/m,'$1it.skip(')),/must not use \.skip: every test runs in verification/);
    workspaceMutation((base)=>editJson(base,`${directory}/tsconfig.json`,(value)=>{ value.compilerOptions.strict = false; }),new RegExp(`${directory}/tsconfig\\.json must not turn strict off`));
  }
});

// G1 of the P1 review: pnpm-workspace.yaml may set only the reviewed keys, in the reviewed form, and no other tracked
// file configures pnpm. scriptShell or nodeOptions there would let every pnpm step pass without running.
const workspaceFile = 'pnpm-workspace.yaml';
const liveWorkspace = readFileSync(resolve(root,workspaceFile),'utf8');
test('G1: the reviewer\'s scriptShell and nodeOptions fail the repository check',()=>{
  for (const setting of ['scriptShell: /bin/true','nodeOptions: --import=data:text/javascript,if(!process.env.NODE_TEST_CONTEXT)process.exit(0)']) {
    const run = checkerRun((base)=>edit(base,workspaceFile,(t)=>`${t}${setting}\n`));
    assert.equal(run.status,1,setting);
    assert.match(run.output,new RegExp(`pnpm-workspace\\.yaml must not set ${setting.split(':')[0]}: it may set only packages, verifyDepsBeforeRun, allowBuilds`),setting);
  }
});
test('G1: pnpm-workspace.yaml may set only packages, verifyDepsBeforeRun: error and the reviewed allowBuilds',()=>{
  assert.deepEqual(pnpmWorkspaceErrors(liveWorkspace),[]);
  for (const key of ['scriptShell','shellEmulator','nodeOptions','enablePrePostScripts','pnpmfile','overrides','packageExtensions','hooks','catalog','onlyBuiltDependencies']) {
    assert.match(pnpmWorkspaceErrors(`${liveWorkspace}${key}: x\n`).join('\n'),new RegExp(`pnpm-workspace\\.yaml must not set ${key}:`),key);
  }
  const forms: Record<string,string> = {
    'a quoted key': '"scriptShell": /bin/true\n',
    'a single-quoted key': "'nodeOptions': --require=./x.cjs\n",
    'a kebab-case key': 'script-shell: /bin/true\n',
    'a flow mapping': '{scriptShell: /bin/true}\n',
    'a complex key': '? scriptShell\n: /bin/true\n',
    'a second document': '---\nscriptShell: /bin/true\n',
  };
  for (const [name,addition] of Object.entries(forms)) assert.match(pnpmWorkspaceErrors(`${liveWorkspace}${addition}`).join('\n'),/is not in the reviewed form|must not set scriptShell/,name);
  assert.match(pnpmWorkspaceErrors(replaceOnce(liveWorkspace,'  - packages/api-contracts/ts\n','  - packages/api-contracts/ts\n  scriptShell: /bin/true\n')).join('\n'),/line \d+ is not in the reviewed form .*"  scriptShell: \/bin\/true"/);
  assert.match(pnpmWorkspaceErrors(replaceOnce(liveWorkspace,'verifyDepsBeforeRun: error\n','verifyDepsBeforeRun: &strict error\n')).join('\n'),/must set verifyDepsBeforeRun: error/);
  assert.match(pnpmWorkspaceErrors(replaceOnce(liveWorkspace,'esbuild: false','esbuild: true')).join('\n'),/allowBuilds must be exactly \{"esbuild":false\}, found \{"esbuild":true\}/);
  assert.match(pnpmWorkspaceErrors(replaceOnce(liveWorkspace,'  esbuild: false\n','  esbuild: false\n  turbo: true\n')).join('\n'),/allowBuilds must be exactly \{"esbuild":false\}, found \{"esbuild":false,"turbo":true\}/);
  assert.match(pnpmWorkspaceErrors(`${liveWorkspace}packages:\n  - other\n`).join('\n'),/sets packages twice/);
});
test('G1: no other tracked file configures pnpm: a nested pnpm-workspace.yaml, a pnpmfile or an .npmrc with script settings',()=>{
  // pnpm reads the nearest pnpm-workspace.yaml when Turborepo runs a package script, so a nested one applies there.
  workspaceMutation((base)=>writeFileSync(resolve(base,'packages/api-contracts/ts/pnpm-workspace.yaml'),'scriptShell: /bin/true\n'),/Only the root pnpm-workspace\.yaml may configure pnpm: packages\/api-contracts\/ts\/pnpm-workspace\.yaml/);
  workspaceMutation((base)=>writeFileSync(resolve(base,'.pnpmfile.cjs'),'module.exports = { hooks: {} };\n'),/A pnpmfile must not be tracked: \.pnpmfile\.cjs/);
  workspaceMutation((base)=>writeFileSync(resolve(base,'packages/api-contracts/ts/pnpmfile.mjs'),'export const hooks = {};\n'),/A pnpmfile must not be tracked: packages\/api-contracts\/ts\/pnpmfile\.mjs/);
  workspaceMutation((base)=>writeFileSync(resolve(base,'.npmrc'),'script-shell=/bin/true\n'),/^\.npmrc must not set script-shell/);
  workspaceMutation((base)=>writeFileSync(resolve(base,'packages/api-contracts/ts/.npmrc'),'# local\nnode_options = --require=./x.cjs\n'),/packages\/api-contracts\/ts\/\.npmrc must not set node-options/);
});

// G2: no install script runs. The root scripts are a literal set, no manifest defines an install lifecycle script or a
// pre or post hook, and CI installs with --ignore-scripts.
const reviewerPostinstall = 'test -z "$GITHUB_PATH" || { mkdir -p "$RUNNER_TEMP/bin" && printf \'#!/bin/sh\\necho verify skipped\\n\' > "$RUNNER_TEMP/bin/node" && chmod +x "$RUNNER_TEMP/bin/node" && echo "$RUNNER_TEMP/bin" >> "$GITHUB_PATH"; }';
test('G2: the reviewer\'s root postinstall fails the repository check',()=>{
  const run = checkerRun((base)=>editJson(base,'package.json',(value)=>{ value.scripts.postinstall = reviewerPostinstall; }));
  assert.equal(run.status,1);
  assert.match(run.output,/package\.json must have exactly these scripts/);
  assert.match(run.output,/package\.json must not have the postinstall script: pnpm runs install lifecycle scripts and pre and post hooks on its own/);
});
test('G2: the root scripts are a literal set, and no manifest may define an install lifecycle script or a hook',()=>{
  assert.deepEqual(JSON.parse(readFileSync(resolve(root,'package.json'),'utf8')).scripts,expectedRootScripts);
  workspaceMutation((base)=>editJson(base,'package.json',(value)=>{ value.scripts.verify = 'true'; }),/^package\.json must have exactly these scripts/);
  workspaceMutation((base)=>editJson(base,'package.json',(value)=>{ delete value.scripts.test; }),/^package\.json must have exactly these scripts/);
  for (const name of ['preinstall','install','postinstall','prepare','prepublish','prepublishOnly','prepack','preverify','pnpm:devPreinstall']) {
    workspaceMutation((base)=>editJson(base,'package.json',(value)=>{ value.scripts[name] = 'echo hook'; }),new RegExp(`^package\\.json must not have the ${name} script`));
    workspaceMutation((base)=>editJson(base,contractsManifest,(value)=>{ value.scripts[name] = 'echo hook'; }),new RegExp(`^packages/api-contracts/ts/package\\.json must not have the ${name} script`));
  }
  workspaceMutation((base)=>editJson(base,contractsManifest,(value)=>{ value.scripts.pretest = 'exit 0'; }),/must not have the pretest script/);
  workspaceMutation((base)=>editJson(base,'package.json',(value)=>{ value.pnpm = { overrides: { vitest: '0.0.0' } }; }),/^package\.json must not set pnpm/);
  assert.ok(['test','typecheck','verify:repository','generate:tree'].every((name)=>!hookScript(name)));
  mutated((base)=>edit(base,'.github/workflows/ci.yml',(t)=>replaceOnce(t,'run: pnpm install --frozen-lockfile --ignore-scripts','run: pnpm install --frozen-lockfile')),/CI must install the locked dependencies with pnpm install --frozen-lockfile --ignore-scripts before node scripts\/verify\.ts/);
});

// G3 and C6R: check-repository.ts, s0.ts and every module they import run their top-level code before any check. Their
// top-level code may not use process, the environment or an exit, no verification script reads CI variables, and CI
// runs the repository checks as their own step, so a CI-only early exit in verify.ts fails there.
const localTest = '^baseline repository satisfies its declared checks$';
test('G3: the reviewer\'s GITHUB_ACTIONS early exit in s0.ts fails the local repository check and the repository tests',()=>{
  const imports = "import { typescriptCommands } from './typescript.ts';\n";
  const run = checkerRun((base)=>edit(base,'scripts/s0.ts',(t)=>replaceOnce(t,imports,`${imports}\nif (process.env.GITHUB_ACTIONS) process.exit(0);\n`)),localTest);
  assert.equal(run.status,1,run.output);
  assert.match(run.output,/scripts\/s0\.ts must not use process: verify\.ts and check-repository\.ts import it/);
  assert.match(run.output,/scripts\/s0\.ts must not use process, env, exit outside a function body/);
  assert.match(run.output,/scripts\/s0\.ts must not read the CI, GITHUB_\* or RUNNER_\* variables \(GITHUB_ACTIONS\)/);
  assert.equal(run.testStatus,1,run.testOutput);
  assert.match(run.testOutput,/baseline repository satisfies its declared checks/);
});
test('C6R: a CI early exit in check-repository.ts fails the local repository check and the repository tests',()=>{
  const imports = "import { checkRepository, root } from './repository.ts';\n";
  const run = checkerRun((base)=>edit(base,'scripts/check-repository.ts',(t)=>replaceOnce(t,imports,`${imports}if (process.env.CI) process.exit(0);\n`)),localTest);
  assert.equal(run.status,1,run.output);
  assert.match(run.output,/scripts\/check-repository\.ts must keep the reviewed code of the whole file \(scripts\/s0\.ts\), comments and blank lines aside; code line 2 differs: expected "function report\(errors: readonly string\[\]\): void \{", found "if \(process\.env\.CI\) process\.exit\(0\);"/);
  assert.match(run.output,/scripts\/check-repository\.ts must not use process, env, exit outside a function body/);
  assert.match(run.output,/scripts\/check-repository\.ts must not read the CI, GITHUB_\* or RUNNER_\* variables \(CI\)/);
  assert.equal(run.testStatus,1,run.testOutput);
});
test('C6R: CI runs the repository checks as their own step before any install and before verify',()=>{
  const step = '      - name: Check repository\n        run: node scripts/check-repository.ts\n';
  const verify = '      - name: Verify repository\n        run: node scripts/verify.ts\n';
  mutated((base)=>edit(base,'.github/workflows/ci.yml',(t)=>replaceOnce(t,step,'')),/CI must run node scripts\/check-repository\.ts as its own step before any install and before node scripts\/verify\.ts/);
  mutated((base)=>edit(base,'.github/workflows/ci.yml',(t)=>replaceOnce(replaceOnce(t,step,''),verify,`${verify}${step}`)),/CI must run node scripts\/check-repository\.ts as its own step before any install/);
});
test('G3: the top-level code of a guarded module may not use process, the environment, an exit or dynamic code',()=>{
  assert.deepEqual(guardedModules(root),['scripts/agent-assets.ts','scripts/check-repository.ts','scripts/development-skills.ts','scripts/environment.ts','scripts/infrastructure.ts','scripts/repository.ts','scripts/rust.ts','scripts/s0.ts','scripts/typescript.ts']);
  for (const file of guardedModules(root)) assert.deepEqual(topLevelErrors(file,readFileSync(resolve(root,file),'utf8')),[],file);
  const s0 = readFileSync(resolve(root,'scripts/s0.ts'),'utf8');
  assert.deepEqual(verifyModuleErrors('scripts/s0.ts',s0),[]);
  const cases: Array<[string,RegExp]> = [
    ['if (process.env.GITHUB_ACTIONS) process.exit(0);',/must not use process, env, exit outside a function body/],
    ["globalThis['process'].exit(0);",/must not use globalThis, exit outside/],
    ["const later = await import('node:process');",/must not use import\(\) outside/],
    ["const loaded = require('node:process');",/must not use require\(\) outside/],
    ["eval('1');",/must not use eval outside/],
    ["new Function('return 1')();",/must not use Function outside/],
    ['Reflect.apply(Math.max, null, []);',/must not use Reflect outside/],
    ['const hidden = `${process.exitCode = 0}`;',/must not use process outside/],
    ['const early = (() => { if (process.env.CI) process.exit(0); })();',/must not use process, env, exit outside/],
    ['if (true) { process.exitCode = 0; }',/must not use process outside/],
  ];
  for (const [statement,expected] of cases) assert.match(topLevelErrors('scripts/s0.ts',`${s0}\n${statement}\n`).join('\n'),expected,statement);
  assert.match(verifyModuleErrors('scripts/s0.ts',`${s0}\nexport function later(): void { process.exitCode = 0; }\n`).join('\n'),/scripts\/s0\.ts must not use process:/);
  // A named function body runs only when called, and a string or regular-expression literal is not code.
  assert.deepEqual(topLevelErrors('x.ts',"export function stop(code = 1): void {\n  process.exit(code);\n}\nconst text = 'process.exit(0)';\nconst shape = /process\\.env/;\n"),[]);
  assert.match(topLevelErrors('x.ts',"import { exit } from 'node:process';\n").join('\n'),/may import only node:crypto, node:fs, node:path, node:url, node:child_process and \.\/\*\.ts modules, found node:process/);
  assert.match(topLevelErrors('x.ts',"import { createRequire } from 'node:module';\n").join('\n'),/found node:module/);
});
test('G3: no verification script reads the CI, GITHUB_* or RUNNER_* variables',()=>{
  for (const file of paths(root).filter((item)=>/^scripts\/(?:workspace\/)?[^/]+\.ts$/.test(item))) assert.deepEqual(ciVariableErrors(file,readFileSync(resolve(root,file),'utf8')),[],file);
  const reads: Array<[string,string]> = [
    ['return process.env.CI;','CI'],
    ["return process.env['GITHUB_ACTIONS'];",'"GITHUB_ACTIONS"'],
    ['const { RUNNER_TEMP } = process.env; return RUNNER_TEMP;','RUNNER_TEMP'],
    ["return 'GITHUB_PATH' in process.env;",'"GITHUB_PATH"'],
    ['return Object.keys(process.env).some((name) => /^GITHUB_/.test(name));','/^GITHUB_/'],
    ['return process.env[`CI`];','"CI"'],
  ];
  for (const [code,name] of reads) {
    const errors = ciVariableErrors('scripts/workspace/tasks.ts',`export function inCi() {\n  ${code}\n}\n`).join('\n');
    assert.ok(errors.startsWith(`scripts/workspace/tasks.ts must not read the CI, GITHUB_* or RUNNER_* variables (${name})`),`${code}: ${errors}`);
  }
  assert.deepEqual(ciVariableErrors('x.ts',"const message = 'CI must install the pinned Rust toolchain';\n"),[],'a message that mentions CI is not a read');
  mutated((base)=>edit(base,'scripts/workspace/tasks.ts',(t)=>`${t}\nexport const inCi = process.env.CI !== undefined;\n`),/scripts\/workspace\/tasks\.ts must not read the CI, GITHUB_\* or RUNNER_\* variables \(CI\)/);
});
test('the source scanner blanks literals, keeps template expressions and line breaks, and finds top-level code',()=>{
  const source = "const a = 'x // y'; // gone\nconst b = /[/]'\"/g.test(`t${c + '}'}u`);\n/* a\nb */ const d = e / f / g;\n";
  const { code, literals } = scanSource(source);
  assert.equal(code.split('\n').length,source.split('\n').length);
  assert.deepEqual(literals.map((literal)=>[literal.kind,literal.text]),[['string','x // y'],['regex',"[/]'\""],['template','t'],['string','}'],['template','u']]);
  assert.match(code,/const d = e \/ f \/ g;/);
  assert.match(code,/\$\{c \+ ' '\}/);
  const top = topLevelCode(scanSource('export function f(a = {}): string {\n  return process.env.X ?? "";\n}\nconst x = () => process;\n').code);
  assert.ok(!top.includes('process.env'),top);
  assert.match(top,/const x = \(\) => process;/);
});

// G4: Cargo manifests are read with a small TOML reader, so a quoted, dotted or inline key counts. The workspace checks
// also compare the test targets Cargo builds with the tracked tests/*.rs (scripts/workspace/tests/cargo-targets.test.ts).
const contractsCargo = 'packages/api-contracts/rust/Cargo.toml';
test('G4: the reviewer\'s quoted autotests and never-enabled required-features fail the repository check',()=>{
  mutated((base)=>edit(base,contractsCargo,(t)=>replaceOnce(t,'[package]\n','[package]\n"autotests" = false\n')),/packages\/api-contracts\/rust\/Cargo\.toml must not set package\.autotests = false: Cargo would leave tests unbuilt or unrun/);
  mutated((base)=>edit(base,contractsCargo,(t)=>`${t}\n[[test]]\nname = "registry"\npath = "tests/registry.rs"\nrequired-features = ["never"]\n\n[features]\nnever = []\n`),/packages\/api-contracts\/rust\/Cargo\.toml must not set test\[0\]\.required-features: Cargo skips a target whose required features are not enabled/);
});
test('G4: every form of a test switch in a manifest fails, and the tracked manifests pass',()=>{
  for (const file of paths(root).filter((item)=>/(^|\/)Cargo\.toml$/.test(item))) assert.deepEqual(cargoManifestErrors(file,readFileSync(resolve(root,file),'utf8')),[],file);
  const forms: Record<string,string> = {
    'a single-quoted key': "[package]\n'autotests' = false\n",
    'a dotted root key': 'package.autobins = false\n[dependencies]\n',
    'an inline lib table': 'lib = { test = false }\n',
    'a dotted lib key': 'lib.doctest = false\n',
    'a quoted lib header': '["lib"]\nharness = false\n',
    'a spaced header and a quoted key': '[ lib ]\n"test" = false\n',
    'an array of inline test tables': 'test = [{ name = "x", harness = false }]\n',
    'a bin with required-features': '[[bin]]\nname = "x"\nrequired-features = []\n',
    'autoexamples': '[package]\nautoexamples = false\n',
    'autobenches before a comment': '[package]\nautobenches = false # off\n',
    'an underscore spelling': '[package]\nauto_tests = false\n',
  };
  for (const [name,source] of Object.entries(forms)) assert.notDeepEqual(cargoManifestErrors('x/Cargo.toml',source),[],name);
  assert.match(cargoManifestErrors('x/Cargo.toml','[package\nname = "x"\n')[0] ?? '',/x\/Cargo\.toml: cannot read the manifest/);
  const parsed = parseToml('a."b.c" = \'d\' # note\n[[e]]\nf = [1, "two", { g = true },]\n[[e]]\n[h . "i"]\nj = """\nk\\tl"""\nm = [\n  "n", # o\n]\n');
  assert.deepEqual(JSON.parse(JSON.stringify(parsed)),{a:{'b.c':'d'},e:[{f:['1','two',{g:true}]},{}],h:{i:{j:'k\tl',m:['n']}}});
  assert.throws(()=>parseToml('a = 1\na = 2\n'),/duplicate key a/);
});

test('the Rust toolchain must be pinned exactly',()=>mutated((base)=>edit(base,'rust-toolchain.toml',(t)=>t.replace(/channel = "[^"]+"/,'channel = "stable"')),/must pin an exact toolchain version/));
test('the toolchain file must keep rustfmt and clippy',()=>mutated((base)=>edit(base,'rust-toolchain.toml',(t)=>t.replace('"clippy"','"rust-docs"')),/must include clippy/));
test('the lockfile is required',()=>mutated((base)=>rmSync(resolve(base,'Cargo.lock')),/Missing Rust workspace file: Cargo\.lock/));
test('workspace members need manifests',()=>mutated((base)=>rmSync(resolve(base,'apps/engine/Cargo.toml')),/Workspace member has no tracked manifest: apps\/engine/));
test('CI must install the pinned toolchain before verification',()=>mutated((base)=>edit(base,'.github/workflows/ci.yml',(t)=>t.replace(/      - name: Install pinned Rust toolchain\n        run: rustup toolchain install --profile minimal\n/,'')),/CI must install the pinned Rust toolchain/));
test('CI needs time for a cold Cargo build',()=>mutated((base)=>edit(base,'.github/workflows/ci.yml',(t)=>t.replace('timeout-minutes: 30','timeout-minutes: 10')),/timeout-minutes of at least 20/));
const f0Dir = 'fixtures/s0/cases/F0-smoke';
test('a case without expected values fails',()=>mutated((base)=>rmSync(resolve(base,`${f0Dir}/expected.json`)),/Case F0-smoke: missing expected file expected\.json/));
test('a case without a derivation fails',()=>mutated((base)=>rmSync(resolve(base,`${f0Dir}/derivation.md`)),/Case F0-smoke: missing derivation file derivation\.md/));
test('a completed case must state its sections',()=>mutated((base)=>editJson(base,`${f0Dir}/expected.json`,(value)=>{ delete value.expect.fills; }),/a completed case must state fills/));
test('a rejected case must state its failure code',()=>mutated((base)=>editJson(base,`${f0Dir}/expected.json`,(value)=>{ value.expect.outcome = { status: 'FAILED' }; }),/a rejected case must state its failure code/));
test('an oracle-derived case binds the oracle script by hash',()=>mutated((base)=>editJson(base,`${f0Dir}/expected.json`,(value)=>{ value.origin = { kind: 'oracle', oracle: 'missing.py', oracle_sha256: 'abc' }; }),/oracle script missing/));
test('a case cannot claim an unknown S0 row',()=>mutated((base)=>editJson(base,`${f0Dir}/case.json`,(value)=>{ value.covers.push('Imaginary row'); }),/unknown S0 row in covers: Imaginary row/));
test('coverage cannot name a missing case',()=>mutated((base)=>editJson(base,'fixtures/s0/coverage.json',(value)=>{ value.rows['Local replay'] = ['NOPE']; }),/names a missing case: NOPE/));
test('coverage must match what the case declares',()=>mutated((base)=>editJson(base,'fixtures/s0/coverage.json',(value)=>{ value.rows['Cash dividend'] = ['F0-smoke']; }),/listed for "Cash dividend" but does not declare it/));
test('removing the cases of any required S0 row fails verification',()=>{
  const errors = mutationErrors((base)=>editJson(base,'fixtures/s0/coverage.json',(value)=>{ for (const row of s0Rows) value.rows[row] = []; }));
  for (const row of s0Rows) assert.ok(errors.some((e)=>e.includes(`S0 row has no case: ${row}`)),row);
});
test('deleting the case directories of a listed row fails',()=>mutated((base)=>{
  for (const id of ['C-03','C-04','C-04a','C-04b','C-04c','C-05','R-01']) rmSync(resolve(base,`fixtures/s0/cases/${id}`),{recursive:true});
},/Coverage for "Cash dividend" names a missing case: C-03/));
test('a case that declares a row must be listed for it',()=>mutated((base)=>editJson(base,'fixtures/s0/coverage.json',(value)=>{
  value.rows['Cash dividend'] = value.rows['Cash dividend'].filter((id: string)=>id!=='C-03');
}),/Case C-03 declares "Cash dividend" but coverage\.json does not list it/));
test('a protocol fixture missing from the manifest fails',()=>mutated((base)=>writeFileSync(resolve(base,'fixtures/protocol/valid/extra.json'),'{}\n'),/Protocol fixture is not in the manifest/));
test('a manifest entry without a file fails',()=>mutated((base)=>rmSync(resolve(base,'fixtures/protocol/invalid/strategy.version-2.json')),/Protocol manifest lists a missing file/));

// reportErrors compares the replay output with fixtures/s0/cases, so the temporary root holds both.
function reportDirectory(change: (directory: string) => void, cases: string[] = ['CASE-1']): string[] {
  const temporary = mkdtempSync(resolve(tmpdir(),'openquant-report-'));
  try {
    mkdirSync(resolve(temporary,'local-runs/s0'),{recursive:true});
    for (const id of cases) mkdirSync(resolve(temporary,`fixtures/s0/cases/${id}`),{recursive:true});
    change(resolve(temporary,'local-runs/s0'));
    return reportErrors(temporary);
  } finally { rmSync(temporary,{recursive:true,force:true}); }
}
function caseBlock(id: string) { return `## ${id} — Title [PASS]\n\n${caseSections.join('\n\n')}\n`; }
// A report in the layout of apps/engine/src/report.rs. `claimed` is the number in the "- cases:" line.
function replayReport(ids: string[], claimed: number = ids.length) {
  return `# S0 local replay report\n\n- source revision: \`x\`\n- cases: ${claimed}, passed: ${claimed}, failed: 0\n\n## Summary\n\n## Acceptance row coverage\n\n${ids.map(caseBlock).join('\n')}\n## Remaining limitations\n`;
}
function replayIndex(ids: string[], passed: boolean = true) { return JSON.stringify({schema:'s0-replay-index/1',cases:ids.map((id)=>({case:id,passed}))}); }
const goodReport = replayReport(['CASE-1']);
function replayOutput(ids: string[], cases: string[], claimed: number = ids.length): string[] {
  return reportDirectory((dir)=>{
    writeFileSync(resolve(dir,'report.md'),replayReport(ids,claimed));
    writeFileSync(resolve(dir,'index.json'),replayIndex(ids));
  },cases);
}
test('the replay report must exist',()=>assert.match(reportErrors(resolve(tmpdir(),'openquant-no-report'))[0] ?? '',/Missing replay report/));
test('a complete passing report is accepted',()=>assert.deepEqual(reportDirectory((dir)=>{
  writeFileSync(resolve(dir,'report.md'),goodReport);
  writeFileSync(resolve(dir,'index.json'),JSON.stringify({cases:[{case:'CASE-1',passed:true}]}));
}),[]));
test('a failing case fails the report check',()=>assert.ok(reportDirectory((dir)=>{
  writeFileSync(resolve(dir,'report.md'),goodReport);
  writeFileSync(resolve(dir,'index.json'),JSON.stringify({cases:[{case:'CASE-1',passed:false}]}));
}).some((e)=>/Replay case failed: CASE-1/.test(e))));
test('a report without limitations fails',()=>assert.ok(reportDirectory((dir)=>{
  writeFileSync(resolve(dir,'report.md'),goodReport.replace('## Remaining limitations\n',''));
  writeFileSync(resolve(dir,'index.json'),JSON.stringify({cases:[{case:'CASE-1',passed:true}]}));
}).some((e)=>/lacks the section: ## Remaining limitations/.test(e))));
test('a report without the row coverage section fails',()=>assert.ok(reportDirectory((dir)=>{
  writeFileSync(resolve(dir,'report.md'),goodReport.replace('## Acceptance row coverage\n',''));
  writeFileSync(resolve(dir,'index.json'),JSON.stringify({cases:[{case:'CASE-1',passed:true}]}));
}).some((e)=>/lacks the section: ## Acceptance row coverage/.test(e))));
test('a case section of the report cannot be dropped',()=>{
  for (const heading of caseSections) {
    assert.ok(reportDirectory((dir)=>{
      writeFileSync(resolve(dir,'report.md'),goodReport.replace(`${heading}\n\n`,'').replace(`\n${heading}\n`,'\n'));
      writeFileSync(resolve(dir,'index.json'),JSON.stringify({cases:[{case:'CASE-1',passed:true}]}));
    }).some((e)=>e.includes(`Report section for case CASE-1 lacks: ${heading}`)),heading);
  }
});
test('the report headings stay a known list',()=>assert.equal(reportSections.length+caseSections.length,15));
test('a missing rustc explains how to install the pinned toolchain',()=>{
  const saved = process.env.PATH;
  process.env.PATH = resolve(tmpdir(),'openquant-no-rust-here');
  try { assert.match(toolchainPinError(root) ?? '',/rustc was not found on PATH.*rustup toolchain install/); }
  finally { process.env.PATH = saved; }
});
test('a report that omits a case fails',()=>assert.ok(reportDirectory((dir)=>{
  writeFileSync(resolve(dir,'report.md'),goodReport);
  writeFileSync(resolve(dir,'index.json'),JSON.stringify({cases:[{case:'CASE-1',passed:true},{case:'CASE-2',passed:true}]}));
},['CASE-1','CASE-2']).some((e)=>/no section for case CASE-2/.test(e))));

// F2: the replay must hold exactly the cases under fixtures/s0/cases.
const inventory = (count: number) => Array.from({length:count},(_,position)=>`C-${String(position+1).padStart(2,'0')}`);
test('a replay output with exactly the fixture cases is accepted',()=>assert.deepEqual(replayOutput(inventory(5),inventory(5)),[]));
test('a replay of 10 of 67 cases fails even though every listed case passed',()=>{
  const errors = replayOutput(inventory(10),inventory(67));
  assert.ok(errors.some((e)=>e==='Replay index omits the fixture case C-11'),errors.join('\n'));
  assert.ok(errors.some((e)=>e==='Report omits the fixture case C-67'),errors.join('\n'));
  assert.ok(errors.some((e)=>e==='Report says cases: 10 but fixtures/s0/cases has 67'),errors.join('\n'));
  assert.equal(errors.filter((e)=>/Replay case failed/.test(e)).length,0);
});
test('a replay with an index of fewer cases than the report fails',()=>{
  const errors = reportDirectory((dir)=>{
    writeFileSync(resolve(dir,'report.md'),replayReport(inventory(3)));
    writeFileSync(resolve(dir,'index.json'),replayIndex(inventory(2)));
  },inventory(3));
  assert.ok(errors.some((e)=>e==='Replay index omits the fixture case C-03'),errors.join('\n'));
  assert.ok(!errors.some((e)=>/^Report /.test(e)),errors.join('\n'));
});
test('a replay with a report of fewer cases than the index fails',()=>{
  const errors = reportDirectory((dir)=>{
    writeFileSync(resolve(dir,'report.md'),replayReport(inventory(2),3));
    writeFileSync(resolve(dir,'index.json'),replayIndex(inventory(3)));
  },inventory(3));
  assert.ok(errors.some((e)=>e==='Report omits the fixture case C-03'),errors.join('\n'));
  assert.ok(errors.some((e)=>/no section for case C-03/.test(e)),errors.join('\n'));
  assert.ok(!errors.some((e)=>/^Replay index /.test(e)),errors.join('\n'));
});
test('a replay that lists a case with no fixture directory fails',()=>{
  const errors = replayOutput([...inventory(3),'EXTRA'],inventory(3));
  assert.ok(errors.some((e)=>e==='Replay index lists EXTRA, which has no directory under fixtures/s0/cases'),errors.join('\n'));
  assert.ok(errors.some((e)=>e==='Report lists EXTRA, which has no directory under fixtures/s0/cases'),errors.join('\n'));
});
test('a replay that lists a case twice fails',()=>{
  const errors = replayOutput(['C-01','C-02','C-01'],['C-01','C-02']);
  assert.ok(errors.some((e)=>e==='Replay index lists a case twice: C-01'),errors.join('\n'));
  assert.ok(errors.some((e)=>e==='Report lists a case twice: C-01'),errors.join('\n'));
});
test('the case count in the report header must match the fixtures',()=>{
  const wrong = replayOutput(inventory(3),inventory(3),5);
  assert.deepEqual(wrong,['Report says cases: 5 but fixtures/s0/cases has 3']);
  const without = reportDirectory((dir)=>{
    writeFileSync(resolve(dir,'report.md'),replayReport(inventory(3)).replace(/^- cases: .*\n/m,''));
    writeFileSync(resolve(dir,'index.json'),replayIndex(inventory(3)));
  },inventory(3));
  assert.deepEqual(without,['Report lacks the "- cases: N, passed: P, failed: F" summary line']);
});
test('a replay needs fixture cases to compare with',()=>{
  const errors = reportDirectory((dir)=>{
    writeFileSync(resolve(dir,'report.md'),goodReport);
    writeFileSync(resolve(dir,'index.json'),replayIndex(['CASE-1']));
  },[]);
  assert.ok(errors.some((e)=>/fixtures\/s0\/cases has no case directories/.test(e)),errors.join('\n'));
});
test('a case directory deleted from the fixtures is noticed by the replay check',()=>{
  const errors = replayOutput(inventory(3),inventory(2));
  assert.ok(errors.some((e)=>/Replay index lists C-03, which has no directory/.test(e)),errors.join('\n'));
});

// F5: every protocol manifest entry uses the vocabulary the Rust tests select by.
function manifestEdit(change: (entries: any[]) => void) {
  return (base: string) => editJson(base,'fixtures/protocol/manifest.json',(value)=>change(value.entries));
}
test('a manifest entry with an unrecognised expect value fails',()=>mutated(manifestEdit((entries)=>{
  entries.find((entry)=>entry.path==='protocol/invalid/strategy.version-2.json').expect = 'ignored';
}),/Protocol manifest entry protocol\/invalid\/strategy\.version-2\.json: expect must be one of valid, schema_invalid, semantic_invalid, found "ignored"/));
test('a manifest entry with a missing expect value fails',()=>mutated(manifestEdit((entries)=>{ delete entries[0].expect; }),/expect must be one of valid, schema_invalid, semantic_invalid, found undefined/));
test('a manifest entry with an unknown contract fails',()=>mutated(manifestEdit((entries)=>{ entries[0].contract = 'strategy'; }),/contract must be one of strategy-artefact, evaluation-input, evaluation-result, checkpoint, evaluation-plan, evaluation-request, evaluation-submission, job-dispatch, attempt-claim, command, research-profile, cohort-policy, dataset-manifest, retrieval-request, retrieval-result, validation-result, evaluation-metrics, gate-report, agent-dispatch, agent-attempt-result, api-error, release-manifest, system-identity-view, mission-view, lineage-view, trials-view, findings-view, gates-view, decisions-view, job-view, found "strategy"/));
test('an invalid manifest entry must state its failure code',()=>mutated(manifestEdit((entries)=>{
  delete entries.find((entry)=>entry.expect==='schema_invalid').code;
}),/an invalid fixture must state its expected failure code/));
test('a manifest cannot list a file twice',()=>mutated(manifestEdit((entries)=>{ entries.push({ ...entries[0] }); }),/is listed twice/));
test('a manifest entry needs a path',()=>mutated(manifestEdit((entries)=>{ delete entries[0].path; }),/Protocol manifest entry 0 has no path/));

// Infrastructure files (scripts/infrastructure.ts). Each rule is shown on the tracked file with one change; the
// unchanged files pass.
import { dockerfileErrors, engineDockerfileErrors, runnerDockerfileErrors, dockerignoreErrors, flyProfileErrors, terraformErrors, terraformVariables, environmentProfileErrors, infrastructureErrors, type ProfileContext } from '../infrastructure.ts';
const infra = {
  engine: 'apps/engine/Dockerfile',
  runner: 'apps/agent-runner/Dockerfile',
  batch: 'infra/fly/openquant-staging-engine-batch.toml',
  agent: 'infra/fly/openquant-staging-agent-runner.toml',
  staging: 'infra/environments/staging.json',
};
const tracked = (path: string) => readFileSync(resolve(root, path), 'utf8');
const runnerPins = { node: '24.19.0', pnpm: '11.25.0', executor: '2.1.325' };
const terraformSources = (): Record<string, string> => Object.fromEntries(['main.tf', 'outputs.tf', 'variables.tf', 'versions.tf'].map((name) => [`infra/terraform/${name}`, tracked(`infra/terraform/${name}`)]));
function profileContext(): ProfileContext {
  return {
    files: new Set(paths(root)),
    flyProfiles: { [infra.batch]: tracked(infra.batch), [infra.agent]: tracked(infra.agent) },
    workerVariables: ['OPENQUANT_ENVIRONMENT', 'OPENQUANT_RESEARCH_EXECUTION', 'AGENT_EXECUTOR_VERSION', 'FLY_ENGINE_BATCH_APP', 'FLY_AGENT_RUNNER_APP'],
    workerSecrets: ['TOKEN_SIGNING_KEY', 'AGENT_RUNNER_URL', 'AGENT_RUNNER_CREDENTIAL', 'FLY_MACHINES_READ_TOKEN'],
    terraformVariables: terraformVariables(terraformSources()),
  };
}
function rejects(errors: string[], expected: RegExp) {
  assert.ok(errors.some((error) => expected.test(error)), `Expected rejection matching ${expected}, found ${JSON.stringify(errors)}`);
}
test('the tracked infrastructure files pass their checks',()=>{
  assert.deepEqual(infrastructureErrors(root, new Set(paths(root))), []);
  for (const file of [infra.engine, infra.runner]) assert.deepEqual(dockerfileErrors(file, tracked(file)), []);
  assert.deepEqual(engineDockerfileErrors(tracked(infra.engine), '1.97.0'), []);
  assert.deepEqual(runnerDockerfileErrors(tracked(infra.runner), runnerPins), []);
  assert.deepEqual(dockerignoreErrors(tracked('.dockerignore')), []);
  for (const file of [infra.batch, infra.agent]) assert.deepEqual(flyProfileErrors(file, tracked(file)), []);
  assert.deepEqual(terraformErrors(terraformSources()), []);
  assert.deepEqual(environmentProfileErrors(infra.staging, JSON.parse(tracked(infra.staging)), profileContext()), []);
});
test('a Dockerfile base image must be pinned by digest, and a later stage may name an earlier one',()=>{
  const text = tracked(infra.engine);
  rejects(dockerfileErrors(infra.engine, text.replace(/@sha256:[0-9a-f]{64} AS build/, ' AS build')), /base image must name a tag and pin its digest/);
  rejects(dockerfileErrors(infra.engine, text.replace(/^FROM debian:bookworm-slim@sha256:[0-9a-f]{64}$/m, `FROM debian@sha256:${'a'.repeat(64)}`)), /base image must name a tag/);
  assert.deepEqual(dockerfileErrors(infra.engine, `${text}\nFROM build AS again\nUSER 10001\n`), []);
});
test('a Dockerfile must end as a user that is not root',()=>{
  const text = tracked(infra.runner);
  rejects(dockerfileErrors(infra.runner, text.replace(/^USER node$/m, '')), /must end with USER set to a user that is not root/);
  rejects(dockerfileErrors(infra.runner, text.replace(/^USER node$/m, 'USER root')), /not root/);
  rejects(dockerfileErrors(infra.engine, tracked(infra.engine).replace(/^USER 10001:10001$/m, 'USER 0:0')), /not root/);
  // A USER of an earlier stage does not count for the final one.
  rejects(dockerfileErrors(infra.engine, `${tracked(infra.engine)}\nFROM build AS last\n`), /not root/);
});
test('a Dockerfile must not bake a credential into ENV or ARG',()=>{
  for (const line of ['ENV ANTHROPIC_API_KEY=x', 'ARG OPENQUANT_API_TOKEN', 'ENV A=1 \\\n    FLY_MACHINES_READ_TOKEN=y']) {
    rejects(dockerfileErrors(infra.runner, tracked(infra.runner).replace(/^USER node$/m, `${line}\nUSER node`)), /must not name a credential/);
  }
});
test('the engine image is a locked release build on the pinned Rust toolchain',()=>{
  const text = tracked(infra.engine);
  rejects(engineDockerfileErrors(text, '1.98.0'), /must use the rust:1\.98\.0 image of rust-toolchain\.toml/);
  rejects(engineDockerfileErrors(text.replace('cargo build --release --locked', 'cargo build --locked'), '1.97.0'), /must be a locked release build/);
  rejects(engineDockerfileErrors(text.replace('cargo build --release --locked', 'cargo build --release'), '1.97.0'), /must be a locked release build/);
  rejects(engineDockerfileErrors(text.replace('RUN cargo build', 'ENV CARGO_PROFILE_RELEASE_DEBUG_ASSERTIONS=true\nRUN cargo build'), '1.97.0'), /must not turn debug assertions on/);
});
test('the runner image pins Node, pnpm and the executor version that the Worker dispatches',()=>{
  const text = tracked(infra.runner);
  rejects(runnerDockerfileErrors(text, { ...runnerPins, node: '24.20.0' }), /must use the node:24\.20\.0 image of \.node-version/);
  rejects(runnerDockerfileErrors(text, { ...runnerPins, pnpm: '11.26.0' }), /must install pnpm@11\.26\.0/);
  rejects(runnerDockerfileErrors(text.replace('pnpm install --frozen-lockfile --ignore-scripts', 'pnpm install'), runnerPins), /--frozen-lockfile --ignore-scripts/);
  rejects(runnerDockerfileErrors(text, { ...runnerPins, executor: '2.1.326' }), /must install @anthropic-ai\/claude-code@2\.1\.326/);
  rejects(runnerDockerfileErrors(text.replace('AGENT_RUNNER_EXECUTOR_VERSION=2.1.325', 'AGENT_RUNNER_EXECUTOR_VERSION=2.1.324'), runnerPins), /must set AGENT_RUNNER_EXECUTOR_VERSION=2\.1\.325/);
});
test('.dockerignore keeps history, dependencies and credential files out of the build context',()=>{
  const text = tracked('.dockerignore');
  for (const entry of ['.git', '**/.dev.vars', '**/*.tfvars']) rejects(dockerignoreErrors(text.split('\n').filter((line) => line !== entry).join('\n')), new RegExp(`must exclude ${entry.replace(/[.*]/g, '\\$&')}$`));
  rejects(dockerignoreErrors(`${text}!apps/api/.dev.vars\n`), /must not re-include a path/);
});
test('a Fly profile is the app it is named after, with one region, size and restart policy, and no build',()=>{
  const text = tracked(infra.batch);
  rejects(flyProfileErrors(infra.batch, text.replace('app = "openquant-staging-engine-batch"', 'app = "openquant-staging-other"')), /app must be openquant-staging-engine-batch/);
  rejects(flyProfileErrors(infra.batch, text.replace('primary_region = "iad"\n', '')), /must name one primary_region/);
  rejects(flyProfileErrors(infra.batch, text.replace(/\[\[vm\]\][^[]*/, '')), /must set one \[\[vm\]\] with size and memory/);
  rejects(flyProfileErrors(infra.batch, text.replace(/\[\[restart\]\][\s\S]*$/, '')), /must set one \[\[restart\]\] policy/);
  rejects(flyProfileErrors(infra.batch, `${text}\n[build]\n  dockerfile = "apps/engine/Dockerfile"\n`), /must not build/);
  rejects(flyProfileErrors('infra/fly/openquant-staging-paper.toml', text.replace('openquant-staging-engine-batch', 'openquant-staging-paper')), /unknown Fly profile/);
});
test('a Fly profile sets no credential in [env]',()=>{
  rejects(flyProfileErrors(infra.batch, tracked(infra.batch).replace('[env]\n', '[env]\n  OPENQUANT_QUEUE_TOKEN = "x"\n')), /\[env\] must not set OPENQUANT_QUEUE_TOKEN/);
});
test('the batch host serves nothing',()=>{
  const text = tracked(infra.batch);
  rejects(flyProfileErrors(infra.batch, `${text}\n[http_service]\n  internal_port = 8080\n`), /the batch host serves nothing/);
  rejects(flyProfileErrors(infra.batch, `${text}\n[[services]]\n  internal_port = 8080\n`), /the batch host serves nothing/);
});
test('the runner serves its dispatch port behind TLS on every interface, and the proxy never stops its Machines',()=>{
  const text = tracked(infra.agent);
  rejects(flyProfileErrors(infra.agent, text.replace('internal_port = 8080', 'internal_port = 8081')), /internal_port is AGENT_RUNNER_PORT/);
  rejects(flyProfileErrors(infra.agent, text.replace('AGENT_RUNNER_HOST = "0.0.0.0"', 'AGENT_RUNNER_HOST = "127.0.0.1"')), /AGENT_RUNNER_HOST must be 0\.0\.0\.0/);
  rejects(flyProfileErrors(infra.agent, text.replace('auto_stop_machines = "off"', 'auto_stop_machines = "stop"')), /auto_stop_machines = "off"/);
  rejects(flyProfileErrors(infra.agent, text.replace('handlers = ["tls", "http"]', 'handlers = ["http"]')), /must terminate TLS/);
  rejects(flyProfileErrors(infra.agent, `${text}\n[http_service]\n  internal_port = 8080\n`), /not \[http_service\]/);
});
test('Terraform pins every provider exactly and sets required_version once',()=>{
  const sources = terraformSources();
  const versions = 'infra/terraform/versions.tf';
  for (const pin of ['~> 5.28', '>= 5.28.1', '5.28.1']) rejects(terraformErrors({ ...sources, [versions]: sources[versions].replace('"= 5.28.1"', `"${pin}"`) }), /must pin one exact version/);
  rejects(terraformErrors({ ...sources, [versions]: sources[versions].replace(/\s+version = "= 5\.28\.1"/, '') }), /must pin one exact version/);
  rejects(terraformErrors({ ...sources, [versions]: sources[versions].replace('source  = "cloudflare/cloudflare"', '') }), /must name its source/);
  rejects(terraformErrors({ ...sources, [versions]: sources[versions].replace(/required_version = .*\n/, '') }), /must set required_version once/);
  rejects(terraformErrors({ ...sources, [versions]: sources[versions].replace(/required_providers \{[\s\S]*?\n {2}\}\n/, '') }), /must declare required_providers once/);
  rejects(terraformErrors({}), /must hold the Terraform configuration/);
});
test('Terraform leaves the state backend to init',()=>{
  const sources = terraformSources();
  const versions = 'infra/terraform/versions.tf';
  rejects(terraformErrors({ ...sources, [versions]: sources[versions].replace('backend "s3" {}', 'backend "s3" {\n    bucket = "state"\n  }') }), /the backend block must be empty/);
  rejects(terraformErrors({ ...sources, [versions]: sources[versions].replace('backend "s3" {}', '') }), /one empty backend block/);
});
test('Terraform disables Hyperdrive caching and holds no literal identifier',()=>{
  const sources = terraformSources();
  const main = 'infra/terraform/main.tf';
  const caching = /\n {2}caching = \{\n {4}disabled = true\n {2}\}\n/;
  rejects(terraformErrors({ ...sources, [main]: sources[main].replace('disabled = true', 'disabled = false') }), /must disable caching/);
  rejects(terraformErrors({ ...sources, [main]: sources[main].replace(caching, '\n') }), /must disable caching/);
  // A comment does not satisfy the rule.
  rejects(terraformErrors({ ...sources, [main]: sources[main].replace(caching, '\n  # caching = { disabled = true }\n') }), /must disable caching/);
  rejects(terraformErrors({ ...sources, [main]: sources[main].replace('account_id = var.cloudflare_account_id', `account_id = "${'0123456789abcdef'.repeat(2)}"`) }), /a literal identifier is not allowed/);
});
test('a tracked Terraform variable file fails',()=>mutated((base)=>{
  writeFileSync(resolve(base,'infra/terraform/staging.tfvars'),'worker_name = "openquant-api"\n');
},/Terraform variable files, plans and provider caches are not tracked/));
test('the environment profile has a fixed shape of names, never a value',()=>{
  const check = (change: (value: any) => void) => { const value = JSON.parse(tracked(infra.staging)); change(value); return environmentProfileErrors(infra.staging, value, profileContext()); };
  rejects(check((value) => { value.cloudflare.worker.values = { TOKEN_SIGNING_KEY: 'x' }; }), /must not have values: a profile holds names only/);
  rejects(check((value) => { value.fly['openquant-staging-engine-batch'].secrets.push('OPENQUANT_API_TOKEN=abc'); }), /must hold names only, found "OPENQUANT_API_TOKEN=abc"/);
  rejects(check((value) => { value.fly['openquant-staging-agent-runner'].settings.push('AGENT_RUNNER_DISPATCH_TOKEN'); }), /names a credential; list it under secrets/);
  rejects(check((value) => { value.hosts.agent_runner = 'https://openquant-staging-agent-runner.fly.dev'; }), /hosts\.agent_runner must be a host name/);
  rejects(check((value) => { value.environment = 'PRODUCTION'; }), /does not match the file name/);
  rejects(check((value) => { value.fly['openquant-staging-agent-runner'].secrets.push('OPENQUANT_API_TOKEN'); }), /OPENQUANT_API_TOKEN is listed twice/);
  rejects(check((value) => { delete value.fly['openquant-staging-agent-runner'].optional_secrets; }), /must have optional_secrets/);
});
test('the environment profile agrees with the Fly profiles, the Worker and Terraform',()=>{
  const check = (change: (value: any) => void) => { const value = JSON.parse(tracked(infra.staging)); change(value); return environmentProfileErrors(infra.staging, value, profileContext()); };
  rejects(check((value) => { value.fly['openquant-staging-engine-batch'].config = infra.agent; }), /configures "openquant-staging-agent-runner", not openquant-staging-engine-batch/);
  rejects(check((value) => { value.fly['openquant-staging-engine-batch'].dockerfile = 'apps/engine/Missing.Dockerfile'; }), /dockerfile must name a tracked file/);
  rejects(check((value) => { delete value.fly['openquant-staging-agent-runner']; }), /openquant-staging-agent-runner\.toml is not listed under fly/);
  rejects(check((value) => { value.fly['openquant-staging-engine-batch'].settings.push('OPENQUANT_CONCURRENCY'); }), /OPENQUANT_CONCURRENCY is set in \[env\]/);
  rejects(check((value) => { value.cloudflare.worker.secrets.pop(); }), /secrets must equal the names of apps\/api\/\.dev\.vars\.example/);
  rejects(check((value) => { value.cloudflare.worker.variables.pop(); }), /variables must equal the vars of apps\/api\/wrangler\.jsonc/);
  rejects(check((value) => { value.cloudflare.worker.fly_apps.FLY_ENGINE_BATCH_APP = 'openquant-staging-paper'; }), /must name an app listed under fly/);
  rejects(check((value) => { value.cloudflare.terraform.variables.pop(); }), /must equal the variables of infra\/terraform/);
  rejects(check((value) => { value.cloudflare.terraform.secret_variables = []; }), /must equal the sensitive variables/);
});
test('the infrastructure checks run with the repository checks',()=>mutated((base)=>edit(base,infra.engine,(t)=>t.replace(/^USER 10001:10001$/m,'USER root')),/apps\/engine\/Dockerfile: the final stage must end with USER set to a user that is not root/));
test('an environment profile without its checks fails',()=>mutated((base)=>{
  writeFileSync(resolve(base,'infra/environments/production.json'),'{}\n');
},/infra\/environments\/production\.json: an environment profile needs its checks/));

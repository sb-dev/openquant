import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, cpSync, copyFileSync, rmSync, readFileSync, readdirSync, writeFileSync, readlinkSync, symlinkSync, renameSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { delimiter, relative, resolve, sep } from 'node:path';
import { root, checkRepository, paths } from '../repository.ts';

// Directories that are not part of a checkout. The pattern is applied to the path relative to the
// copied root, so a checkout that itself lives under .claude/worktrees is still copied in full.
const notCopied = /(^|\/)(\.git|node_modules|target|local-runs|\.claude\/worktrees)(\/|$)/;
function copyRepository(source: string, destination: string) {
  cpSync(source,destination,{recursive:true,verbatimSymlinks:true,filter:(path)=>!notCopied.test(relative(source,path).split(sep).join('/'))});
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

// S0: Rust verification, fixtures and protocol rules.
import { reportErrors, reportSections, caseSections, s0Rows, expectedCargoCommands, cargoCommandErrors, verifyDriverErrors, rustModuleErrors, withoutComments } from '../s0.ts';
import { cargoCommands, toolchainChannel, toolchainPinError } from '../rust.ts';

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
  const replay = steps.find((step)=>step.startsWith('cargo run'))!;
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
// The list check imports the live module, so the wiring is proved by running the checker in a mutated copy.
function checkerRun(change: (directory: string) => void) {
  const temporary = mkdtempSync(resolve(tmpdir(),'openquant-checker-'));
  try {
    const copy = resolve(temporary,'repo');
    copyRepository(root,copy);
    change(copy);
    const result = spawnSync(process.execPath,['scripts/check-repository.ts'],{cwd:copy,encoding:'utf8'});
    return { status: result.status, output: `${result.stdout}${result.stderr}` };
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
  const statusCheck = 'if (status !== 0) fail(`${command} exited with status ${status}`);';
  const mutations: Record<string,[string,RegExp]> = {
    'exit-code check removed': [replaceOnce(liveVerify,statusCheck,''),/run every Cargo command and fail on a non-zero exit status/],
    'exit-code check disabled': [replaceOnce(liveVerify,'if (status !== 0) fail(','if (false) fail('),/run every Cargo command and fail on a non-zero exit status/],
    'exit-code check only in a line comment': [replaceOnce(liveVerify,statusCheck,`// ${statusCheck}`),/run every Cargo command and fail on a non-zero exit status/],
    'exit-code check only in a block comment': [replaceOnce(liveVerify,statusCheck,`/* ${statusCheck} */`),/run every Cargo command and fail on a non-zero exit status/],
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
test('rust.ts cannot ignore the exit status or the pinned version',()=>{
  assert.match(rustModuleErrors(replaceOnce(liveRust,'return result.status ?? 1;','return 0;')).join('\n'),/runCargo must return the exit status/);
  assert.match(rustModuleErrors(replaceOnce(liveRust,'return result.status ?? 1;','// return result.status ?? 1;\n  return 0;')).join('\n'),/runCargo must return the exit status/);
  assert.match(rustModuleErrors(replaceOnce(liveRust,'if (!result.stdout.startsWith(`rustc ${channel} `)) {','if (false) {')).join('\n'),/compare the installed rustc version/);
});
test('comments are removed but string literals are kept',()=>{
  assert.equal(withoutComments("const a = 'https://x'; // gone\nconst b = `//kept`; /* gone */ const c = \"/*kept*/\";").replace(/\s+/g,' '),"const a = 'https://x'; const b = `//kept`; const c = \"/*kept*/\";");
});
test('the repository check rejects a verify.ts without its exit-code check',()=>mutated((base)=>edit(base,'scripts/verify.ts',(t)=>replaceOnce(t,'if (status !== 0) fail(','if (false) fail(')),/scripts\/verify\.ts must run every Cargo command and fail on a non-zero exit status/));
test('the repository check rejects a runCargo that returns success',()=>mutated((base)=>edit(base,'scripts/rust.ts',(t)=>replaceOnce(t,'return result.status ?? 1;','return 0;')),/runCargo must return the exit status/));

// Behavioural tests of the verify driver. The real scripts run in a temporary root. Two of its inputs are
// stand-ins: scripts/check-repository.ts and scripts/tests/repository.test.ts (the driver's Node steps would
// otherwise run this test file again), and `cargo` and `rustc`, which are shell scripts placed first on PATH.
// The driver, rust.ts, s0.ts and the rest of scripts/ are byte-for-byte copies, so nothing in a normal
// verification run can switch a step off.
interface Driver {
  cases?: string[]; replay?: string[] | 'failing' | 'none'; checkStatus?: number; testsFail?: boolean;
  cargoFails?: string; touchFixtures?: boolean; rustc?: string;
}
function driverRun(options: Driver = {}) {
  const temporary = mkdtempSync(resolve(tmpdir(),'openquant-driver-'));
  try {
    const base = resolve(temporary,'root');
    const bin = resolve(temporary,'bin');
    const cases = options.cases ?? ['CASE-1'];
    mkdirSync(resolve(base,'scripts/tests'),{recursive:true});
    mkdirSync(bin);
    for (const file of readdirSync(resolve(root,'scripts')).filter((name)=>name.endsWith('.ts'))) copyFileSync(resolve(root,'scripts',file),resolve(base,'scripts',file));
    writeFileSync(resolve(base,'scripts/check-repository.ts'),`console.log('stand-in repository checks');\nprocess.exit(${options.checkStatus ?? 0});\n`);
    writeFileSync(resolve(base,'scripts/tests/repository.test.ts'),`import test from 'node:test';\ntest('stand-in repository tests',()=>{${options.testsFail ? " throw new Error('stand-in failure');" : ''}});\n`);
    copyFileSync(resolve(root,'rust-toolchain.toml'),resolve(base,'rust-toolchain.toml'));
    for (const id of cases) { mkdirSync(resolve(base,`fixtures/s0/cases/${id}`),{recursive:true}); writeFileSync(resolve(base,`fixtures/s0/cases/${id}/case.json`),'{}\n'); }
    const replay = options.replay ?? cases;
    if (replay !== 'none') {
      const ids = replay === 'failing' ? cases : replay;
      mkdirSync(resolve(temporary,'replay'));
      writeFileSync(resolve(temporary,'replay/report.md'),replayReport(ids));
      writeFileSync(resolve(temporary,'replay/index.json'),replayIndex(ids,replay !== 'failing'));
    }
    const log = resolve(temporary,'cargo.log');
    writeFileSync(resolve(bin,'cargo'),[
      '#!/bin/sh',
      'echo "$*" >> "$STAND_IN_LOG"',
      'if [ "$STAND_IN_FAIL" = "$1" ]; then echo "stand-in cargo fails: $1" >&2; exit 1; fi',
      'if [ "$1" = test ] && [ -n "$STAND_IN_TOUCH" ]; then echo changed >> fixtures/s0/cases/CASE-1/case.json; fi',
      'if [ "$1" = run ] && [ -d "$STAND_IN_REPLAY" ]; then mkdir -p local-runs/s0 && cp "$STAND_IN_REPLAY"/* local-runs/s0/; fi',
      'exit 0',
      '',
    ].join('\n'),{mode:0o755});
    writeFileSync(resolve(bin,'rustc'),`#!/bin/sh\necho '${options.rustc ?? `rustc ${toolchainChannel(root)} (stand-in 2000-01-01)`}'\n`,{mode:0o755});
    const env: Record<string,string|undefined> = { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}`, STAND_IN_LOG: log, STAND_IN_REPLAY: resolve(temporary,'replay'),
      STAND_IN_FAIL: options.cargoFails ?? '', STAND_IN_TOUCH: options.touchFixtures ? '1' : '' };
    delete env.NODE_TEST_CONTEXT; // a nested `node --test` must run as a runner, not as a child of this one
    const result = spawnSync(process.execPath,['scripts/verify.ts'],{cwd:base,env,encoding:'utf8',timeout:60000});
    const cargo = existsSync(log) ? readFileSync(log,'utf8').split('\n').filter(Boolean) : [];
    return { status: result.status, stdout: result.stdout, stderr: result.stderr, cargo };
  } finally { rmSync(temporary,{recursive:true,force:true}); }
}
const driverSkip = process.platform === 'win32' ? 'the driver tests use sh stand-ins for cargo and rustc' : false;
const cargoArguments = expectedCargoCommands.map((command)=>command.replace(/^cargo /,''));
test('the verify driver runs every Cargo step in order and passes when all of them pass',{skip:driverSkip},()=>{
  const run = driverRun();
  assert.equal(run.status,0,run.stderr);
  assert.match(run.stdout,/Verification passed/);
  assert.deepEqual(run.cargo,cargoArguments);
});
test('the verify driver fails when any one Cargo step exits non-zero, and runs nothing after it',{skip:driverSkip},()=>{
  ['fmt','clippy','test','run'].forEach((subcommand,position)=>{
    const run = driverRun({cargoFails:subcommand});
    assert.equal(run.status,1,subcommand);
    assert.ok(run.stderr.includes(`Verification failed: ${expectedCargoCommands[position]} exited with status 1`),`${subcommand}: ${run.stderr}`);
    assert.ok(!run.stdout.includes('Verification passed'),subcommand);
    assert.deepEqual(run.cargo,cargoArguments.slice(0,position+1),subcommand);
  });
});
test('the verify driver fails before any Cargo step when the pinned toolchain is not the one that runs',{skip:driverSkip},()=>{
  const run = driverRun({rustc:'rustc 0.0.1 (stand-in 2000-01-01)'});
  assert.equal(run.status,1);
  assert.match(run.stderr,/Verification failed: Expected rustc \d+\.\d+\.\d+ from rust-toolchain\.toml, found: rustc 0\.0\.1/);
  assert.deepEqual(run.cargo,[]);
});
test('the verify driver fails when a Cargo step changes a fixture',{skip:driverSkip},()=>{
  const run = driverRun({touchFixtures:true});
  assert.equal(run.status,1);
  assert.match(run.stderr,/Verification failed: fixtures changed while verification ran/);
  assert.ok(!run.stdout.includes('Verification passed'));
});
test('the verify driver fails on a replay report problem',{skip:driverSkip},()=>{
  const failing = driverRun({replay:'failing'});
  assert.equal(failing.status,1);
  assert.match(failing.stderr,/Verification failed: [\s\S]*Replay case failed: CASE-1/);
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
  assert.deepEqual(check.cargo,[]);
  const tests = driverRun({testsFail:true});
  assert.notEqual(tests.status,0);
  assert.deepEqual(tests.cargo,[]);
  assert.ok(!tests.stdout.includes('Verification passed'));
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
test('a manifest entry with an unknown contract fails',()=>mutated(manifestEdit((entries)=>{ entries[0].contract = 'strategy'; }),/contract must be one of strategy-artefact, evaluation-input, evaluation-result, checkpoint, evaluation-plan, evaluation-request, evaluation-submission, job-dispatch, attempt-claim, command, research-profile, cohort-policy, dataset-manifest, retrieval-request, retrieval-result, validation-result, evaluation-metrics, gate-report, agent-dispatch, agent-attempt-result, api-error, release-manifest, found "strategy"/));
test('an invalid manifest entry must state its failure code',()=>mutated(manifestEdit((entries)=>{
  delete entries.find((entry)=>entry.expect==='schema_invalid').code;
}),/an invalid fixture must state its expected failure code/));
test('a manifest cannot list a file twice',()=>mutated(manifestEdit((entries)=>{ entries.push({ ...entries[0] }); }),/is listed twice/));
test('a manifest entry needs a path',()=>mutated(manifestEdit((entries)=>{ delete entries[0].path; }),/Protocol manifest entry 0 has no path/));

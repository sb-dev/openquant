import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { posix, resolve } from 'node:path';
import { cargoCommands } from './rust.ts';
import { typescriptCommands } from './typescript.ts';

// OQ-06 section 8: the S0 rows of "Connected slices and acceptance cases".
export const s0Rows = [
  'Definition execution',
  'Shared payloads',
  'Seed semantics',
  'Entry variants',
  'Unplanned non-trading events',
  'Split across an ex-date',
  'Cash dividend',
  'Entry and exit phases',
  'Cash and quantities',
  'Invalid inputs',
  'Local replay',
] as const;

// Headings the replay report must contain. They mirror REPORT_SECTIONS and CASE_SECTIONS in
// apps/engine/src/report.rs. A drift fails verification when the real report is checked.
export const reportSections = [
  '# S0 local replay report',
  '## Summary',
  '## Acceptance row coverage',
  '## Remaining limitations',
] as const;
export const caseSections = [
  '### Identities',
  '### Signals',
  '### Entry intents',
  '### Fills',
  '### Trades',
  '### Cash ledger',
  '### Corporate actions applied',
  '### Daily cash, positions and equity',
  '### Final state',
  '### Expected versus actual',
  '### Determinism and restore',
] as const;

const outcomeSections = ['fills', 'trades', 'cash_ledger', 'daily', 'final'];

// The Rust steps that verification must run, in this order. This is a literal on purpose: the
// expectation must not be read from scripts/rust.ts, which is the file being checked. A change to a
// step (including --locked, -D warnings, --lib or --no-run) is a change to this list in review.
export const expectedCargoCommands: readonly string[] = [
  'cargo fmt --all --check',
  'cargo clippy --workspace --all-targets --locked -- -D warnings',
  'cargo test --workspace --locked',
  'cargo run --locked -p openquant-engine --bin s0-replay -- --out local-runs/s0',
  'cargo run --locked -p openquant-contracts --bin contracts-report -- --out local-runs/contracts',
];

// The TypeScript steps that verification must run after the dependency check, in this order (OQ-06 sections
// 1 and 2). A literal for the same reason: it must not be read from scripts/typescript.ts. The workspace checks
// run first and compare the Turborepo task list with expectedWorkspacePackages. Turborepo runs without cached
// results (--force). The workspace test files are named one by one, so a missing file fails, and their
// reporter fails a file that ran no test or any skipped test.
export const workspaceTestFiles: readonly string[] = [
  'scripts/workspace/tests/boundaries.test.ts',
  'scripts/workspace/tests/licences.test.ts',
  'scripts/workspace/tests/reporters.test.ts',
  'scripts/workspace/tests/tasks.test.ts',
  'scripts/workspace/tests/workflows.test.ts',
];
export const expectedTypescriptCommands: readonly string[] = [
  'pnpm exec node scripts/workspace/check-workspace.ts',
  'pnpm exec turbo run typecheck lint test build --force',
  `pnpm exec node --test --test-reporter=spec --test-reporter-destination=stdout --test-reporter=./scripts/workspace/test-reporter.ts --test-reporter-destination=stderr ${workspaceTestFiles.join(' ')}`,
];

// The workspace packages, in the order pnpm-workspace.yaml lists them (OQ-06 section 1), and the exact script
// behind each Turborepo task. A literal, so the expectation is not read from the files being checked. The test
// script names the reporter that fails a run with no executed test or a skipped one. The workspace checks compare
// this list with the Turborepo dry run before Turborepo runs.
export const workspaceTasks = ['typecheck', 'lint', 'test', 'build'] as const;
export interface WorkspacePackage {
  directory: string;
  name: string;
  scripts: Readonly<Record<(typeof workspaceTasks)[number], string>>;
}
export const expectedWorkspacePackages: readonly WorkspacePackage[] = [
  {
    directory: 'packages/api-contracts/ts',
    name: '@openquant/api-contracts',
    scripts: {
      typecheck: 'node tools/generate.ts && tsc -p tsconfig.json && tsc -p tsconfig.test.json',
      lint: 'biome check --error-on-warnings .',
      test: 'node tools/generate.ts && vitest run --reporter=default --reporter=./test-reporter.ts',
      build: 'node tools/generate.ts && tsc -p tsconfig.json && node tools/bundle-check.ts',
    },
  },
];

// Files that decide whether a test run counts, pinned by SHA-256 of their bytes: the two reporters and the Vitest
// configuration. A change to one is a change to this list in the same review.
export const pinnedFiles: Readonly<Record<string, string>> = {
  'scripts/workspace/test-reporter.ts': '7457088ad4e295409b74bb5a92397f42efca6bb446ab87aace1dbdf30e0c3d1e',
  'packages/api-contracts/ts/test-reporter.ts': '5a19ae965e6153903150f7fe3e37fc39a1e5b26a7729bb115065b70faf1d865d',
  'packages/api-contracts/ts/vitest.config.ts': '58433531d0bf46b50dba6178f0ce16c6b86c1972d8b3021edcbd9e3c3d5550fb',
};

// Protocol manifest vocabulary. The Rust tests select entries by these exact expect values. For
// contracts, packages/api-contracts/rust/tests/protocol.rs and the contracts-report binary reject an
// unknown name. packages/quant-core/tests/protocol.rs checks the engine contracts, skips the connected
// envelopes by name and panics on an unknown name. The engine list is the Contract enum and the
// connected list is the Envelope enum in packages/api-contracts/rust/src/lib.rs (OQ-05 section 7).
export const protocolExpectations: readonly string[] = ['valid', 'schema_invalid', 'semantic_invalid'];
export const protocolEngineContracts: readonly string[] = ['strategy-artefact', 'evaluation-input', 'evaluation-result', 'checkpoint'];
export const protocolConnectedContracts: readonly string[] = ['evaluation-plan', 'evaluation-request', 'evaluation-submission', 'job-dispatch', 'attempt-claim', 'command', 'research-profile', 'cohort-policy', 'dataset-manifest', 'retrieval-request', 'retrieval-result', 'validation-result', 'evaluation-metrics', 'gate-report', 'agent-dispatch', 'agent-attempt-result', 'api-error', 'release-manifest'];

// Exact equality with the expected list: same steps, same flags, same order, nothing extra.
function stepListErrors(file: string, kind: string, expected: readonly string[], commands: readonly string[]): string[] {
  const errors: string[] = [];
  for (const command of expected) {
    if (!commands.includes(command)) errors.push(`${file} must run: ${command}`);
  }
  for (const command of commands) {
    if (!expected.includes(command)) errors.push(`${file} runs a ${kind} step that is not expected: ${command}`);
  }
  const same = commands.length === expected.length && commands.every((command, index) => command === expected[index]);
  if (!same && errors.length === 0) errors.push(`${file} must list the ${kind} steps once each, in this order: ${expected.join(' | ')}`);
  return errors;
}

export function cargoCommandErrors(commands: readonly string[]): string[] {
  return stepListErrors('scripts/rust.ts', 'Rust', expectedCargoCommands, commands);
}

export function typescriptCommandErrors(commands: readonly string[]): string[] {
  return stepListErrors('scripts/typescript.ts', 'TypeScript', expectedTypescriptCommands, commands);
}

// Source text without comments, so a comment cannot satisfy a code-shape check. String and template
// literals are kept whole. This is not a parser; it is enough for the two small scripts it reads.
export function withoutComments(source: string): string {
  const token = /('(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\.|[^`\\])*`)|\/\/[^\n]*|\/\*[\s\S]*?\*\//g;
  return source.replace(token, (match, literal) => (literal === undefined ? ' ' : match));
}

// The code of a source file: no comments, no trailing spaces and no blank lines. The literal copies below hold the
// reviewed code of the files that run verification in this form, so a comment or a blank line may change freely
// and any other change, such as an added statement, an early exit or an environment change, does not pass.
export function codeLines(source: string): string[] {
  return withoutComments(source).split('\n').map((line) => line.trimEnd()).filter((line) => line.trim() !== '');
}

// The code lines of one top-level function, from its declaration to the closing brace at column 0.
export function functionLines(source: string, name: string): string[] {
  const lines = codeLines(source);
  const start = lines.findIndex((line) => line.startsWith(`export function ${name}(`));
  if (start < 0) return [];
  const end = lines.indexOf('}', start);
  return lines.slice(start, end < 0 ? undefined : end + 1);
}

function codeDifference(file: string, part: string, expected: readonly string[], actual: readonly string[]): string[] {
  for (let index = 0; index < Math.max(expected.length, actual.length); index += 1) {
    if (expected[index] !== actual[index]) {
      return [`${file} must keep the reviewed code of ${part} (scripts/s0.ts), comments and blank lines aside; code line ${index + 1} differs: expected ${JSON.stringify(expected[index] ?? '(nothing)')}, found ${JSON.stringify(actual[index] ?? '(nothing)')}`];
    }
  }
  return [];
}

// The reviewed code of scripts/verify.ts, the whole file. Lines with single quotes are written in double quotes.
export const expectedVerifyCode: readonly string[] = [
  "import { spawnSync } from 'node:child_process';",
  "import { stepEnvironment } from './environment.ts';",
  "import { root } from './repository.ts';",
  "import { cargoCommands, fixtureDigest, runCargo, toolchainPinError } from './rust.ts';",
  "import { reportErrors } from './s0.ts';",
  "import { dependencyInstallError, runTypescript, typescriptCommands } from './typescript.ts';",
  'function fail(message: string): never {',
  '  console.error(`\\nVerification failed: ${message}`);',
  '  process.exit(1);',
  '}',
  "for (const args of [['scripts/check-repository.ts'], ['--test', 'scripts/tests/repository.test.ts']]) {",
  "  const result = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit', env: stepEnvironment() });",
  '  if (result.error) console.error(result.error.message);',
  '  if (result.status !== 0) process.exit(result.status ?? 1);',
  '}',
  'const pinError = toolchainPinError(root);',
  'if (pinError) fail(pinError);',
  'const fixturesBefore = fixtureDigest(root);',
  'for (const command of cargoCommands) {',
  '  const status = runCargo(root, command);',
  '  if (status !== 0) fail(`${command} exited with status ${status}`);',
  '}',
  "if (fixtureDigest(root) !== fixturesBefore) fail('fixtures changed while verification ran; golden data is never regenerated during a test');",
  'const problems = reportErrors(root);',
  "if (problems.length) fail(problems.join('\\n'));",
  'const installError = dependencyInstallError(root);',
  'if (installError) fail(installError);',
  'const typescriptFixturesBefore = fixtureDigest(root);',
  'for (const command of typescriptCommands) {',
  '  const status = runTypescript(root, command);',
  '  if (status !== 0) fail(`${command} exited with status ${status}`);',
  '}',
  "if (fixtureDigest(root) !== typescriptFixturesBefore) fail('fixtures changed while the TypeScript steps ran; golden data is never regenerated during a test');",
  "console.log('\\nVerification passed: repository checks, Rust format, clippy, tests, the S0 offline replay, the contracts report, and the TypeScript typecheck, lint, test, build and workspace checks. S1 is incomplete: the connected competition is not implemented.');",
];

// The reviewed code of scripts/environment.ts, the whole file: the environment of every process verification starts.
export const expectedEnvironmentCode: readonly string[] = [
  'const removedNames: ReadonlySet<string> = new Set([',
  "  'BASH_ENV',",
  "  'ENV',",
  "  'NODE_OPTIONS',",
  "  'RUSTFLAGS',",
  "  'RUSTDOCFLAGS',",
  "  'RUSTC_WRAPPER',",
  "  'RUSTC_WORKSPACE_WRAPPER',",
  "  'CARGO_BUILD_RUSTFLAGS',",
  "  'CARGO_BUILD_RUSTDOCFLAGS',",
  "  'CARGO_ENCODED_RUSTFLAGS',",
  "  'CARGO_ENCODED_RUSTDOCFLAGS',",
  "  'CARGO_BUILD_RUSTC_WRAPPER',",
  "  'CARGO_BUILD_RUSTC_WORKSPACE_WRAPPER',",
  "  'BIOME_CONFIG_PATH',",
  ']);',
  'const removedPatterns: readonly RegExp[] = [/^NODE_TEST_/, /^TURBO_/, /^CARGO_TARGET_.+_(?:RUNNER|RUSTFLAGS|RUSTDOCFLAGS|LINKER)$/];',
  'export function isRemovedVariable(name: string): boolean {',
  '  const key = name.toUpperCase();',
  '  return removedNames.has(key) || removedPatterns.some((pattern) => pattern.test(key));',
  '}',
  'export function stepEnvironment(): Record<string, string | undefined> {',
  '  const environment: Record<string, string | undefined> = { ...process.env };',
  '  for (const name of Object.keys(environment)) {',
  '    if (isRemovedVariable(name)) delete environment[name];',
  '  }',
  "  environment.TURBO_TELEMETRY_DISABLED = '1';",
  "  environment.pnpm_config_verify_deps_before_run = 'error';",
  '  return environment;',
  '}',
];

// The reviewed code of runCargo in scripts/rust.ts and runTypescript in scripts/typescript.ts.
export const expectedRunCargoCode: readonly string[] = [
  'export function runCargo(base: string, command: string): number {',
  "  const [program, ...args] = command.split(' ');",
  '  console.log(`\\n$ ${command}`);',
  "  const result = spawnSync(program, args, { cwd: base, stdio: 'inherit', env: stepEnvironment() });",
  '  if (result.error) console.error(result.error.message);',
  '  return result.status ?? 1;',
  '}',
];
export const expectedRunTypescriptCode: readonly string[] = [
  'export function runTypescript(base: string, command: string): number {',
  "  const [program, ...args] = command.split(' ');",
  '  console.log(`\\n$ ${command}`);',
  "  const result = spawnSync(program, args, { cwd: base, stdio: 'inherit', env: stepEnvironment() });",
  '  if (result.error) console.error(result.error.message);',
  '  return result.status ?? 1;',
  '}',
];

// Code shapes that scripts/verify.ts must keep, in this order. Each is the statement that makes a
// step bind: the exit-code checks, the toolchain pin check, the fixture digest comparisons, the report
// check and the dependency check before the TypeScript steps. The behavioural tests run the real driver
// as well; these shapes fail fast and say what is missing.
const driverShapes: ReadonlyArray<readonly [string, RegExp]> = [
  ['stop when the repository checks or their tests fail', /for\s*\(\s*const\s+args\s+of\s+\[\s*\[\s*'scripts\/check-repository\.ts'\s*\]\s*,\s*\[\s*'--test'\s*,\s*'scripts\/tests\/repository\.test\.ts'\s*\]\s*\]\s*\)\s*\{\s*const\s+result\s*=\s*spawnSync\(\s*process\.execPath\s*,\s*args\s*,\s*\{[^}]*\}\s*\)\s*;\s*(?:if\s*\(\s*result\.error\s*\)\s*console\.error\(\s*result\.error\.message\s*\)\s*;\s*)?if\s*\(\s*result\.status\s*!==\s*0\s*\)\s*process\.exit\(\s*result\.status\s*\?\?\s*1\s*\)/],
  ['fail when the pinned toolchain is not the one that runs', /const\s+pinError\s*=\s*toolchainPinError\(\s*root\s*\)\s*;\s*if\s*\(\s*pinError\s*\)\s*fail\(\s*pinError\s*\)\s*;/],
  ['record the fixture digest before the Cargo steps', /const\s+fixturesBefore\s*=\s*fixtureDigest\(\s*root\s*\)\s*;/],
  ['run every Cargo command and fail on a non-zero exit status', /for\s*\(\s*const\s+command\s+of\s+cargoCommands\s*\)\s*\{\s*const\s+status\s*=\s*runCargo\(\s*root\s*,\s*command\s*\)\s*;\s*if\s*\(\s*status\s*!==\s*0\s*\)\s*fail\(/],
  ['compare the fixture digest after the Cargo steps', /if\s*\(\s*fixtureDigest\(\s*root\s*\)\s*!==\s*fixturesBefore\s*\)\s*fail\(/],
  ['fail on any replay report problem', /const\s+problems\s*=\s*reportErrors\(\s*root\s*\)\s*;\s*if\s*\(\s*problems\.length\s*\)\s*fail\(/],
  ['fail when the installed dependencies do not match pnpm-lock.yaml', /const\s+installError\s*=\s*dependencyInstallError\(\s*root\s*\)\s*;\s*if\s*\(\s*installError\s*\)\s*fail\(\s*installError\s*\)\s*;/],
  ['record the fixture digest before the TypeScript steps', /const\s+typescriptFixturesBefore\s*=\s*fixtureDigest\(\s*root\s*\)\s*;/],
  ['run every TypeScript command and fail on a non-zero exit status', /for\s*\(\s*const\s+command\s+of\s+typescriptCommands\s*\)\s*\{\s*const\s+status\s*=\s*runTypescript\(\s*root\s*,\s*command\s*\)\s*;\s*if\s*\(\s*status\s*!==\s*0\s*\)\s*fail\(/],
  ['compare the fixture digest after the TypeScript steps', /if\s*\(\s*fixtureDigest\(\s*root\s*\)\s*!==\s*typescriptFixturesBefore\s*\)\s*fail\(/],
  ['report success only after those checks', /console\.log\(\s*'\\nVerification passed/],
];
const driverFail = /function\s+fail\(\s*message\s*:\s*string\s*\)\s*:\s*never\s*\{\s*console\.error\(`\\nVerification failed: \$\{message\}`\)\s*;\s*process\.exit\(\s*1\s*\)\s*;\s*\}/;

export function verifyDriverErrors(source: string): string[] {
  const code = withoutComments(source);
  const errors: string[] = [];
  if (!driverFail.test(code)) errors.push('scripts/verify.ts must define fail() to print "Verification failed" and exit with status 1');
  const positions = driverShapes.map(([purpose, shape]) => {
    const match = shape.exec(code);
    if (!match) errors.push(`scripts/verify.ts must ${purpose}`);
    return match?.index;
  });
  for (let step = 1; step < driverShapes.length; step += 1) {
    const [before, after] = [positions[step - 1], positions[step]];
    if (before !== undefined && after !== undefined && before > after) {
      errors.push(`scripts/verify.ts must ${driverShapes[step - 1][0]} before it can ${driverShapes[step][0]}`);
    }
  }
  errors.push(...codeDifference('scripts/verify.ts', 'the whole file', expectedVerifyCode, codeLines(source)));
  return errors;
}

// scripts/environment.ts: the whole file, and the two settings that every step needs.
export function environmentModuleErrors(source: string): string[] {
  const code = withoutComments(source);
  const errors: string[] = [];
  if (!/environment\.TURBO_TELEMETRY_DISABLED\s*=\s*'1'\s*;/.test(code) || !/environment\.pnpm_config_verify_deps_before_run\s*=\s*'error'\s*;/.test(code)) {
    errors.push('scripts/environment.ts stepEnvironment must run each step with TURBO_TELEMETRY_DISABLED=1 and pnpm verify-deps-before-run=error');
  }
  errors.push(...codeDifference('scripts/environment.ts', 'the whole file', expectedEnvironmentCode, codeLines(source)));
  return errors;
}

// Every process that verification starts takes stepEnvironment(). In each script that starts one, the only
// child_process import is spawnSync, stepEnvironment comes from scripts/environment.ts, and every spawnSync call
// ends with an options object literal whose last property is env: stepEnvironment().
export function spawnEnvironmentErrors(file: string, source: string): string[] {
  const code = withoutComments(source);
  if (!/\bchild_process\b|\bspawnSync\b/.test(code)) return [];
  const errors: string[] = [];
  const spawnImport = /^import \{ spawnSync \} from 'node:child_process';$/m;
  if (!spawnImport.test(code) || [...code.matchAll(/\bchild_process\b/g)].length !== 1) errors.push(`${file} may import only spawnSync from node:child_process, once`);
  if (!/^import \{ stepEnvironment \} from '\.\.?\/environment\.ts';$/m.test(code) || /\b(?:function|const|let|var|class)\s+stepEnvironment\b/.test(code)) {
    errors.push(`${file} must import stepEnvironment from scripts/environment.ts and not define its own`);
  }
  const uses = [...code.matchAll(/\bspawnSync\b/g)].length - (spawnImport.test(code) ? 1 : 0);
  const calls = [...code.matchAll(/\bspawnSync\([^;{]*\{\s*(?:(?:cwd|stdio|encoding|maxBuffer)\s*:\s*[^,{}]+,\s*)*env\s*:\s*stepEnvironment\(\)\s*\}\s*\)/g)].length;
  if (uses === 0 || calls !== uses) errors.push(`${file}: every spawnSync call must pass env: stepEnvironment() as the last option (${calls} of ${uses} do)`);
  return errors;
}

// The modules that verify.ts imports run their top-level code before step 1. They may not use process,
// globalThis, eval, Function, Reflect, prototypes, require or a dynamic import, and may not reassign a function
// they declare, so none of them can exit early, change the environment of a step or replace a checked function.
// scripts/environment.ts reads process.env and is checked whole; scripts/s0.ts is this guard.
export const verifyModules: readonly string[] = ['scripts/repository.ts', 'scripts/rust.ts', 'scripts/typescript.ts', 'scripts/development-skills.ts', 'scripts/agent-assets.ts'];
export function verifyModuleErrors(file: string, source: string): string[] {
  const code = withoutComments(source);
  const errors: string[] = [];
  const used = /\b(?:process|globalThis|global|eval|Function|Reflect|prototype|__proto__)\b|\b(?:import|require)\s*\(/.exec(code);
  if (used) errors.push(`${file} must not use ${used[0].replace(/\s*\($/, '()')}: verify.ts imports it, and only scripts/environment.ts reads the environment`);
  for (const [, name] of code.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)/g)) {
    if (new RegExp(`(?<!\\b(?:const|let|var)\\s+)(?<![.\\w$])${name.replace(/\$/g, '\\$')}\\s*(?:[-+*/%&|^]|\\*\\*|<<|>>>?|&&|\\|\\||\\?\\?)?=(?![=>])`).test(code)) errors.push(`${file} must not reassign its function ${name}`);
  }
  return errors;
}

// The parts of scripts/rust.ts whose behaviour the driver relies on. The driver tests exercise them.
export function rustModuleErrors(source: string): string[] {
  const code = withoutComments(source);
  const errors: string[] = [];
  if (!/return\s+result\.status\s*\?\?\s*1\s*;/.test(code)) errors.push('scripts/rust.ts runCargo must return the exit status of the command, or 1 when it did not run');
  if (!/stdout\.startsWith\(\s*`rustc \$\{channel\} `\s*\)/.test(code)) errors.push('scripts/rust.ts must compare the installed rustc version with the pinned channel');
  errors.push(...codeDifference('scripts/rust.ts', 'runCargo', expectedRunCargoCode, functionLines(source, 'runCargo')));
  errors.push(...spawnEnvironmentErrors('scripts/rust.ts', source));
  errors.push(...verifyModuleErrors('scripts/rust.ts', source));
  return errors;
}

// The parts of scripts/typescript.ts whose behaviour the driver relies on. The driver tests exercise them.
export function typescriptModuleErrors(source: string): string[] {
  const code = withoutComments(source);
  const errors: string[] = [];
  const body = (name: string) => new RegExp(`export\\s+function\\s+${name}\\s*\\([^)]*\\)\\s*:[^{]*\\{([\\s\\S]*?)\\n\\}`).exec(code)?.[1] ?? '';
  const run = body('runTypescript');
  if (!/return\s+result\.status\s*\?\?\s*1\s*;/.test(run)) errors.push('scripts/typescript.ts runTypescript must return the exit status of the command, or 1 when it did not run');
  if (!/spawnSync\(\s*program\s*,\s*args\s*,\s*\{[^}]*\benv\s*:\s*stepEnvironment\(\)\s*\}\s*\)/.test(run)) {
    errors.push('scripts/typescript.ts runTypescript must run each step with env: stepEnvironment()');
  }
  const check = body('dependencyInstallError');
  if (!/'node_modules\/\.pnpm\/lock\.yaml'/.test(check) || !/'pnpm-lock\.yaml'/.test(check) || !/if\s*\(\s*!\s*readFileSync\(\s*installed\s*\)\.equals\(\s*readFileSync\(\s*wanted\s*\)\s*\)\s*\)\s*\{?\s*return\s/.test(check)) {
    errors.push('scripts/typescript.ts dependencyInstallError must compare node_modules/.pnpm/lock.yaml with pnpm-lock.yaml byte for byte');
  }
  if (!/if\s*\(\s*result\.stdout\.trim\(\)\s*!==\s*pinned\s*\)\s*\{?\s*return\s/.test(check)) errors.push('scripts/typescript.ts dependencyInstallError must compare the running pnpm version with packageManager');
  if (!/export\s+const\s+installCommand\s*=\s*'pnpm install --frozen-lockfile'\s*;/.test(code)) errors.push('scripts/typescript.ts must tell the user to run: pnpm install --frozen-lockfile');
  if (/['"`](?:install|add|update)['"`]/.test(code)) errors.push('scripts/typescript.ts must never install, add or update dependencies');
  errors.push(...codeDifference('scripts/typescript.ts', 'runTypescript', expectedRunTypescriptCode, functionLines(source, 'runTypescript')));
  errors.push(...spawnEnvironmentErrors('scripts/typescript.ts', source));
  errors.push(...verifyModuleErrors('scripts/typescript.ts', source));
  return errors;
}

function text(base: string, path: string): string {
  return readFileSync(resolve(base, path), 'utf8');
}

function json(base: string, path: string): any {
  return JSON.parse(text(base, path));
}

// The packages block of pnpm-workspace.yaml, one `  - path` line per package. Another form gives undefined.
export function workspacePackageList(source: string): string[] | undefined {
  const lines = source.split('\n');
  const start = lines.findIndex((line) => /^packages:[ \t]*$/.test(line));
  if (start < 0) return undefined;
  const list: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const item = /^  - ([^\s#'"]+)[ \t]*$/.exec(line);
    if (item) list.push(item[1]);
    else if (!/^[ \t]*(?:#.*)?$/.test(line)) break;
  }
  return list;
}

// The TypeScript workspace (OQ-06 sections 1 and 7): the package list, each package's task scripts, the files
// pinned by digest, the named workspace test files, and the settings that would let a check pass without checking:
// tsc noCheck or strict off, Biome's linter off, Vitest test selection or a passing empty run, and skipped tests.
export function workspaceErrors(base: string, files: ReadonlySet<string>): string[] {
  const errors: string[] = [];
  const expected = expectedWorkspacePackages.map((item) => item.directory);
  const listed = workspacePackageList(text(base, 'pnpm-workspace.yaml'));
  if (JSON.stringify(listed) !== JSON.stringify(expected)) {
    errors.push(`pnpm-workspace.yaml must list exactly these packages, one per line, in this order: ${expected.join(', ')}; found ${listed?.join(', ') || 'none'}`);
  }
  for (const item of expectedWorkspacePackages) {
    const path = `${item.directory}/package.json`;
    if (!files.has(path)) { errors.push(`Missing workspace package manifest: ${path}`); continue; }
    const manifest = json(base, path);
    if (manifest.name !== item.name) errors.push(`${path} must be named ${item.name}, found ${JSON.stringify(manifest.name)}`);
    for (const task of workspaceTasks) {
      const script = manifest.scripts?.[task];
      if (script !== item.scripts[task]) errors.push(`${path} must have the ${task} script ${JSON.stringify(item.scripts[task])}, found ${JSON.stringify(script)}`);
    }
  }
  for (const [path, digest] of Object.entries(pinnedFiles)) {
    if (!files.has(path)) { errors.push(`Missing pinned file: ${path}`); continue; }
    const actual = createHash('sha256').update(readFileSync(resolve(base, path))).digest('hex');
    if (actual !== digest) errors.push(`${path} changed: review the change, then set its SHA-256 in pinnedFiles in scripts/s0.ts to ${actual}`);
  }
  for (const file of workspaceTestFiles) if (!files.has(file)) errors.push(`Missing workspace test file: ${file}`);
  for (const file of [...files].sort()) {
    if (/^scripts\/workspace\/tests\/[^/]+\.test\.ts$/.test(file) && !workspaceTestFiles.includes(file)) {
      errors.push(`Workspace test file is not run by verification: ${file}. Add it to workspaceTestFiles in scripts/s0.ts`);
    }
    const name = file.split('/').at(-1) ?? '';
    if (/^tsconfig.*\.json$/.test(name)) {
      const source = text(base, file);
      if (/"noCheck"/.test(source)) errors.push(`${file} must not set noCheck: tsc would not report type errors`);
      if (/"strict"\s*:\s*false/.test(source)) errors.push(`${file} must not turn strict off`);
    }
    if (/^biome\.jsonc?$/.test(name) && file !== 'biome.json') errors.push(`Only the root biome.json may configure Biome: ${file}`);
    if (/^(?:vitest|vite)\.(?:config|workspace)\.[cm]?[jt]s$/.test(name)) {
      const code = withoutComments(text(base, file));
      for (const option of ['testNamePattern', 'allowOnly']) if (new RegExp(`\\b${option}\\b`).test(code)) errors.push(`${file} must not set ${option}`);
      if (!/\bpassWithNoTests\s*:\s*false\b/.test(code) || /\bpassWithNoTests\s*:\s*(?!\s|false\b)/.test(code)) errors.push(`${file} must set passWithNoTests: false, and only that`);
    }
    const directory = expected.find((item) => file.startsWith(`${item}/`));
    if (directory === undefined || !/\.[cm]?[jt]sx?$/.test(name)) continue;
    const source = text(base, file);
    if (/@ts-nocheck\b/.test(source)) errors.push(`${file} must not use @ts-nocheck`);
    if (/biome-ignore-all\b/.test(source)) errors.push(`${file} must not use biome-ignore-all`);
    if (/(^|\/)test\//.test(file.slice(directory.length)) || /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(name)) {
      const skip = /\.(skip|only|todo|skipIf|runIf)\b/.exec(withoutComments(source));
      if (skip) errors.push(`${file} must not use .${skip[1]}: every test runs in verification`);
    }
  }
  if (json(base, 'tsconfig.base.json').compilerOptions?.strict !== true) errors.push('tsconfig.base.json must set strict: true');
  const biome = json(base, 'biome.json');
  if (JSON.stringify(biome.linter) !== JSON.stringify({ enabled: true, rules: { preset: 'recommended' } })) {
    errors.push(`biome.json linter must be {"enabled":true,"rules":{"preset":"recommended"}}, found ${JSON.stringify(biome.linter)}`);
  }
  if (biome.formatter?.enabled !== true) errors.push('biome.json must keep the formatter enabled');
  if ('overrides' in biome) errors.push('biome.json must not set overrides');
  return errors;
}

// Static S0 rules. They run with the other repository checks, before any Cargo step.
export function s0Errors(base: string, files: Set<string>): string[] {
  const errors: string[] = [];
  const guard = (label: string, check: () => void) => {
    try { check(); } catch (error) { errors.push(`${label}: ${error}`); }
  };

  guard('Rust workspace', () => {
    for (const file of ['Cargo.toml', 'Cargo.lock', 'rust-toolchain.toml']) {
      if (!files.has(file)) errors.push(`Missing Rust workspace file: ${file}`);
    }
    const members = /members\s*=\s*\[([^\]]*)\]/.exec(text(base, 'Cargo.toml'));
    if (!members) throw new Error('Cargo.toml declares no workspace members');
    for (const member of [...members[1].matchAll(/"([^"]+)"/g)].map((m) => m[1])) {
      if (!files.has(`${member}/Cargo.toml`)) errors.push(`Workspace member has no tracked manifest: ${member}`);
    }
    const toolchain = text(base, 'rust-toolchain.toml');
    const channel = /^channel\s*=\s*"([^"]+)"/m.exec(toolchain)?.[1];
    if (!channel || !/^\d+\.\d+\.\d+$/.test(channel)) errors.push('rust-toolchain.toml must pin an exact toolchain version');
    for (const component of ['rustfmt', 'clippy']) {
      if (!new RegExp(`components\\s*=\\s*\\[[^\\]]*"${component}"`).test(toolchain)) errors.push(`rust-toolchain.toml must include ${component}`);
    }
    // Cargo reads .cargo/config.toml in the directory it runs in and in every parent. Rustflags such as
    // --cap-lints, a test runner, a wrapper or an alias there would change what the Cargo steps check. A manifest
    // that turns off target discovery or a test harness would leave tests unbuilt or unrun.
    for (const file of [...files].sort()) {
      if (/(^|\/)\.cargo\/config(\.toml)?$/.test(file)) errors.push(`Cargo configuration must not be tracked: ${file}`);
      if (!/(^|\/)Cargo\.toml$/.test(file)) continue;
      for (const match of text(base, file).matchAll(/\b(autotests|autobins|test|harness|doctest)\s*=\s*false\b/g)) {
        errors.push(`${file} must not set ${match[1]} = false: Cargo would leave tests unbuilt or unrun`);
      }
    }
  });

  guard('Rust verification', () => {
    // The imported list is the one the driver runs. It is compared with the literal expectation above.
    errors.push(...cargoCommandErrors(cargoCommands));
    errors.push(...rustModuleErrors(text(base, 'scripts/rust.ts')));
    errors.push(...verifyDriverErrors(text(base, 'scripts/verify.ts')));
    errors.push(...environmentModuleErrors(text(base, 'scripts/environment.ts')));
    for (const file of verifyModules.filter((item) => item !== 'scripts/rust.ts' && item !== 'scripts/typescript.ts')) errors.push(...verifyModuleErrors(file, text(base, file)));
    for (const file of [...files].filter((item) => /^scripts\/(?:workspace\/)?[^/]+\.ts$/.test(item) && !['scripts/rust.ts', 'scripts/typescript.ts', 'scripts/s0.ts'].includes(item)).sort()) {
      errors.push(...spawnEnvironmentErrors(file, text(base, file)));
    }
    if (!/^export const root = resolve\(dirname\(fileURLToPath\(import\.meta\.url\)\), '\.\.'\);$/m.test(withoutComments(text(base, 'scripts/repository.ts')))) {
      errors.push('scripts/repository.ts must set root to the directory above scripts/');
    }
    const ci = text(base, '.github/workflows/ci.yml');
    const install = ci.indexOf('rustup toolchain install');
    const run = ci.indexOf('node scripts/verify.ts');
    if (install < 0 || run < 0 || install > run) errors.push('CI must install the pinned Rust toolchain before node scripts/verify.ts');
    const timeout = /timeout-minutes:\s*(\d+)/.exec(ci.slice(ci.indexOf('checks:')));
    if (!timeout || Number(timeout[1]) < 20) errors.push('CI checks job needs timeout-minutes of at least 20 for a cold Cargo build');
    const dependencies = ci.indexOf('pnpm install --frozen-lockfile');
    if (dependencies < 0 || run < 0 || dependencies > run) errors.push('CI must install the locked dependencies with pnpm install --frozen-lockfile before node scripts/verify.ts');
  });

  guard('TypeScript verification', () => {
    // The imported list is the one the driver runs. It is compared with the literal expectation above.
    errors.push(...typescriptCommandErrors(typescriptCommands));
    errors.push(...typescriptModuleErrors(text(base, 'scripts/typescript.ts')));
    // pnpm 11 otherwise installs before `pnpm verify` and every other `pnpm run` when the install is out of date.
    if (!/^verifyDepsBeforeRun:[ \t]*error[ \t]*$/m.test(text(base, 'pnpm-workspace.yaml'))) errors.push('pnpm-workspace.yaml must set verifyDepsBeforeRun: error, so pnpm never installs before a script');
    errors.push(...workspaceErrors(base, files));
  });

  const caseDirs = [...new Set([...files].map((f) => /^fixtures\/s0\/cases\/([^/]+)\//.exec(f)?.[1]).filter((c): c is string => !!c))].sort();
  guard('S0 cases', () => {
    if (caseDirs.length === 0) errors.push('fixtures/s0/cases has no cases');
    for (const id of caseDirs) {
      const dir = `fixtures/s0/cases/${id}`;
      guard(`Case ${id}`, () => {
        if (!files.has(`${dir}/case.json`)) throw new Error('missing case.json');
        const file = json(base, `${dir}/case.json`);
        if (file.id !== id) errors.push(`Case ${id}: case.json id is ${file.id}`);
        for (const key of ['strategy', 'input', 'expected', 'derivation']) {
          // A case may name a shared seed strategy by a relative path such as ../../strategies/x.json.
          const target = typeof file[key] === 'string' ? posix.normalize(`${dir}/${file[key]}`) : '';
          if (!target.startsWith('fixtures/s0/') || !files.has(target)) errors.push(`Case ${id}: missing ${key} file ${file[key]}`);
        }
        if (!Array.isArray(file.covers) || file.covers.length === 0) errors.push(`Case ${id}: covers no S0 row`);
        for (const row of file.covers ?? []) {
          if (!(s0Rows as readonly string[]).includes(row)) errors.push(`Case ${id}: unknown S0 row in covers: ${row}`);
        }
        if (!files.has(`${dir}/${file.expected}`)) return;
        const expected = json(base, `${dir}/${file.expected}`);
        if (expected.schema !== 's0-expected/1' || expected.case !== id) errors.push(`Case ${id}: expected.json header is wrong`);
        const expect = expected.expect ?? {};
        if (!expect.outcome || typeof expect.outcome.status !== 'string') errors.push(`Case ${id}: expected.json states no outcome`);
        if (expect.outcome?.status === 'COMPLETED') {
          for (const section of outcomeSections) {
            if (!(section in expect)) errors.push(`Case ${id}: a completed case must state ${section}`);
          }
        } else if (typeof expect.outcome?.code !== 'string') {
          errors.push(`Case ${id}: a rejected case must state its failure code`);
        }
        const origin = expected.origin ?? {};
        if (typeof origin.kind !== 'string') errors.push(`Case ${id}: expected.json has no origin.kind`);
        if (typeof origin.oracle_sha256 === 'string') {
          const oracle = `fixtures/s0/oracle/${origin.oracle}`;
          if (!files.has(oracle)) errors.push(`Case ${id}: oracle script missing: ${oracle}`);
          else if (createHash('sha256').update(readFileSync(resolve(base, oracle))).digest('hex') !== origin.oracle_sha256) {
            errors.push(`Case ${id}: expected values were derived by an oracle script that has since changed`);
          }
        }
      });
    }
  });

  guard('S0 coverage', () => {
    if (!files.has('fixtures/s0/coverage.json')) { errors.push('Missing fixtures/s0/coverage.json'); return; }
    const coverage = json(base, 'fixtures/s0/coverage.json');
    const rows = coverage.rows ?? {};
    for (const row of Object.keys(rows)) {
      if (!(s0Rows as readonly string[]).includes(row)) errors.push(`Coverage names an unknown S0 row: ${row}`);
    }
    for (const row of s0Rows) {
      const cases: string[] = rows[row] ?? [];
      if (cases.length === 0) errors.push(`S0 row has no case: ${row}`);
      for (const id of cases) {
        if (!caseDirs.includes(id)) { errors.push(`Coverage for "${row}" names a missing case: ${id}`); continue; }
        const covers: string[] = json(base, `fixtures/s0/cases/${id}/case.json`).covers ?? [];
        if (!covers.includes(row)) errors.push(`Case ${id} is listed for "${row}" but does not declare it`);
      }
    }
    // A case that declares a row must be listed for it, so coverage cannot drift from the cases.
    for (const id of caseDirs) {
      const covers: string[] = json(base, `fixtures/s0/cases/${id}/case.json`).covers ?? [];
      for (const row of covers) {
        if ((s0Rows as readonly string[]).includes(row) && !(rows[row] ?? []).includes(id)) {
          errors.push(`Case ${id} declares "${row}" but coverage.json does not list it`);
        }
      }
    }
  });

  guard('Protocol fixtures', () => {
    const manifest = json(base, 'fixtures/protocol/manifest.json');
    if (!Array.isArray(manifest.entries)) throw new Error('manifest.json has no entries list');
    const protocolContracts = [...protocolEngineContracts, ...protocolConnectedContracts];
    const listed = new Set<string>();
    for (const [position, entry] of manifest.entries.entries()) {
      if (typeof entry?.path !== 'string' || entry.path === '') { errors.push(`Protocol manifest entry ${position} has no path`); continue; }
      const label = `Protocol manifest entry ${entry.path}`;
      if (listed.has(entry.path)) errors.push(`${label} is listed twice`);
      listed.add(entry.path);
      // The Rust tests select entries by these values and skip any other, so an unknown value leaves a fixture untested.
      if (!protocolExpectations.includes(entry.expect)) errors.push(`${label}: expect must be one of ${protocolExpectations.join(', ')}, found ${JSON.stringify(entry.expect)}`);
      if (!protocolContracts.includes(entry.contract)) errors.push(`${label}: contract must be one of ${protocolContracts.join(', ')}, found ${JSON.stringify(entry.contract)}`);
      if (entry.expect !== 'valid' && typeof entry.code !== 'string') errors.push(`${label}: an invalid fixture must state its expected failure code`);
    }
    for (const file of files) {
      if (!file.startsWith('fixtures/protocol/') || file === 'fixtures/protocol/manifest.json' || file === 'fixtures/protocol/README.md') continue;
      if (!listed.has(file.slice('fixtures/'.length))) errors.push(`Protocol fixture is not in the manifest: ${file}`);
    }
    for (const path of listed) {
      if (!files.has(`fixtures/${path}`)) errors.push(`Protocol manifest lists a missing file: ${path}`);
    }
  });

  return errors;
}

// Reports a difference between the case ids found in the output and the case directories.
function sameCases(label: string, found: string[], inventory: string[], errors: string[]) {
  for (const id of found.filter((item, position) => found.indexOf(item) !== position)) errors.push(`${label} lists a case twice: ${id}`);
  for (const id of inventory) {
    if (!found.includes(id)) errors.push(`${label} omits the fixture case ${id}`);
  }
  for (const id of found) {
    if (!inventory.includes(id)) errors.push(`${label} lists ${id}, which has no directory under fixtures/s0/cases`);
  }
}

// Checks the report written by the replay step. A missing or failing report fails verification.
// The index and the report must hold exactly the cases that fixtures/s0/cases contains, so a replay
// of part of the inventory cannot pass.
export function reportErrors(base: string): string[] {
  const errors: string[] = [];
  const directory = 'local-runs/s0';
  if (!existsSync(resolve(base, `${directory}/report.md`))) return [`Missing replay report: ${directory}/report.md`];
  const report = text(base, `${directory}/report.md`);
  for (const heading of reportSections) {
    if (!report.includes(heading)) errors.push(`Report lacks the section: ${heading}`);
  }
  let inventory: string[] = [];
  try {
    inventory = readdirSync(resolve(base, 'fixtures/s0/cases'), { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  } catch (error) { errors.push(`Fixture case inventory: ${error}`); }
  if (inventory.length === 0) errors.push('fixtures/s0/cases has no case directories to compare the replay with');
  const header = /^- cases: (\d+), passed: (\d+), failed: (\d+)$/m.exec(report);
  if (!header) errors.push('Report lacks the "- cases: N, passed: P, failed: F" summary line');
  else if (Number(header[1]) !== inventory.length) errors.push(`Report says cases: ${header[1]} but fixtures/s0/cases has ${inventory.length}`);
  sameCases('Report', [...report.matchAll(/^## (\S+) — /gm)].map((match) => match[1]), inventory, errors);
  try {
    const index = json(base, `${directory}/index.json`);
    const cases = index.cases as Array<{ case: string; passed: boolean }>;
    if (!Array.isArray(cases) || cases.length === 0) errors.push('Replay index lists no cases');
    sameCases('Replay index', (cases ?? []).map((item) => item.case), inventory, errors);
    for (const item of cases ?? []) {
      if (!item.passed) errors.push(`Replay case failed: ${item.case}`);
      const start = report.indexOf(`\n## ${item.case} — `);
      if (start < 0) { errors.push(`Report has no section for case ${item.case}`); continue; }
      const end = report.indexOf('\n## ', start + 1);
      const block = report.slice(start, end < 0 ? undefined : end);
      for (const heading of caseSections) {
        if (!block.includes(`\n${heading}`)) errors.push(`Report section for case ${item.case} lacks: ${heading}`);
      }
    }
  } catch (error) { errors.push(`Replay index: ${error}`); }
  return errors;
}

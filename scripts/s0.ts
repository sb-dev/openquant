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
  'cargo build --locked -p openquant-engine --bin engine-batch',
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
  'scripts/workspace/tests/cargo-targets.test.ts',
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
  {
    directory: 'apps/api',
    name: '@openquant/api',
    scripts: {
      typecheck: 'tsc -p tsconfig.json && tsc -p tsconfig.test.json',
      lint: 'biome check --error-on-warnings .',
      test: 'vitest run --reporter=default --reporter=./test-reporter.ts',
      build: 'tsc -p tsconfig.json && node tools/bundle-check.ts',
    },
  },
];

// Files that decide whether a test run counts or which guards run, pinned by SHA-256 of their bytes: the two
// reporters, the Vitest configuration and the script that runs the dependency-using workspace guards. A change to
// one, such as a new guard in check-workspace.ts, is a change to this list in the same review.
export const pinnedFiles: Readonly<Record<string, string>> = {
  'scripts/workspace/test-reporter.ts': '17f7f7f7a69e261ae259db4e46cb49fdc66b1dbdb890642deee7b34a5339eff7',
  'scripts/workspace/check-workspace.ts': '75d3b28748b91c4509c1747d4d957dd6b6a0476e65e98db3411cf5bfe184859f',
  'packages/api-contracts/ts/test-reporter.ts': '5a19ae965e6153903150f7fe3e37fc39a1e5b26a7729bb115065b70faf1d865d',
  'packages/api-contracts/ts/vitest.config.ts': '58433531d0bf46b50dba6178f0ce16c6b86c1972d8b3021edcbd9e3c3d5550fb',
  'apps/api/test-reporter.ts': '5a19ae965e6153903150f7fe3e37fc39a1e5b26a7729bb115065b70faf1d865d',
  'apps/api/vitest.config.ts': 'b6d168e53c593d66690652dac99f253dee97a055834a01279ba76baaf257d151',
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

// A literal of a source file: a string, a static part of a template literal, or a regular expression.
export interface SourceLiteral {
  kind: 'string' | 'template' | 'regex';
  text: string;
}
const regexKeywords: ReadonlySet<string> = new Set(['return', 'typeof', 'case', 'in', 'of', 'new', 'delete', 'void', 'throw', 'instanceof', 'do', 'else', 'yield', 'await']);
const sourceWord = /[A-Za-z_$][\w$]*|\d[\w.]*/y;

// Source text without comments and with the contents of string, template and regular-expression literals blanked,
// and those literals listed apart. The expressions inside a template literal stay code, so code cannot hide in one.
// Line breaks are kept. This is not a parser: a `/` after `)` or `]` is read as a division. It is enough for the
// scripts it reads, and the tests run it on each of them.
export function scanSource(source: string): { code: string; literals: SourceLiteral[] } {
  const literals: SourceLiteral[] = [];
  const out: string[] = [];
  const templates: number[] = [];
  const blank = (part: string) => part.replace(/[^\n]/g, ' ');
  let depth = 0;
  let previous = '';
  let at = 0;
  // Reads a template literal from just after its backtick, or after the brace that closes one of its expressions.
  const template = (start: number): number => {
    let index = start;
    while (index < source.length && source[index] !== '`' && !(source[index] === '$' && source[index + 1] === '{')) index += source[index] === '\\' ? 2 : 1;
    literals.push({ kind: 'template', text: source.slice(start, index) });
    out.push(blank(source.slice(start, index)));
    if (index >= source.length) return index;
    if (source[index] === '`') {
      out.push('`');
      previous = 'literal';
      return index + 1;
    }
    out.push('${');
    templates.push(depth);
    depth += 1;
    previous = '{';
    return index + 2;
  };
  while (at < source.length) {
    const char = source[at];
    const next = source[at + 1];
    if (char === '/' && next === '/') {
      const end = source.indexOf('\n', at);
      out.push(' ');
      at = end < 0 ? source.length : end;
      continue;
    }
    if (char === '/' && next === '*') {
      const end = source.indexOf('*/', at + 2);
      const stop = end < 0 ? source.length : end + 2;
      out.push(' ', source.slice(at, stop).replace(/[^\n]/g, ''));
      at = stop;
      continue;
    }
    if (char === "'" || char === '"') {
      let index = at + 1;
      while (index < source.length && source[index] !== char && source[index] !== '\n') index += source[index] === '\\' ? 2 : 1;
      const closed = source[index] === char;
      literals.push({ kind: 'string', text: source.slice(at + 1, index) });
      out.push(char, blank(source.slice(at + 1, index)), closed ? char : '');
      at = closed ? index + 1 : index;
      previous = 'literal';
      continue;
    }
    if (char === '`') {
      out.push('`');
      at = template(at + 1);
      continue;
    }
    if (char === '}' && templates.length > 0 && templates[templates.length - 1] === depth - 1) {
      templates.pop();
      depth -= 1;
      out.push('}');
      at = template(at + 1);
      continue;
    }
    if (char === '/' && (previous === '' || /^[(,=:[!&|?{};+\-*%<>~^]$/.test(previous) || regexKeywords.has(previous))) {
      let index = at + 1;
      let inClass = false;
      while (index < source.length && source[index] !== '\n' && (inClass || source[index] !== '/')) {
        if (source[index] === '\\') index += 1;
        else if (source[index] === '[') inClass = true;
        else if (source[index] === ']') inClass = false;
        index += 1;
      }
      if (source[index] === '/') {
        const flags = /^[a-z]*/.exec(source.slice(index + 1))?.[0] ?? '';
        literals.push({ kind: 'regex', text: source.slice(at + 1, index) });
        out.push('/', blank(source.slice(at + 1, index)), '/', flags);
        at = index + 1 + flags.length;
        previous = 'literal';
        continue;
      }
    }
    sourceWord.lastIndex = at;
    const word = sourceWord.exec(source);
    if (word) {
      out.push(word[0]);
      previous = word[0];
      at += word[0].length;
      continue;
    }
    if (char === '{') depth += 1;
    else if (char === '}') depth -= 1;
    out.push(char);
    if (!/\s/.test(char)) previous = char;
    at += 1;
  }
  return { code: out.join(''), literals };
}

// The top-level code of a scanned source: everything except the named function declarations at the top level, whose
// bodies run only when they are called. Arrow functions, class bodies and initialisers stay top-level code.
export function topLevelCode(code: string): string {
  const depths: number[] = [];
  let depth = 0;
  for (let index = 0; index < code.length; index += 1) {
    const char = code[index];
    depths.push(depth);
    if (char === '(' || char === '[' || char === '{') depth += 1;
    else if (char === ')' || char === ']' || char === '}') depth -= 1;
  }
  depths.push(depth);
  const closing = (open: number): number => {
    for (let index = open + 1; index < code.length; index += 1) if (depths[index + 1] === depths[open] && ')]}'.includes(code[index])) return index;
    return code.length - 1;
  };
  const kept = code.split('');
  for (const match of code.matchAll(/((?:^|[;}\n])[ \t]*)((?:export[ \t]+(?:default[ \t]+)?)?(?:async[ \t]+)?function\b[ \t]*\*?[ \t]*[A-Za-z_$][\w$]*[^(]*\()/g)) {
    const start = match.index + match[1].length;
    if (depths[start] !== 0) continue;
    const parameters = closing(start + match[2].length - 1);
    const body = code.slice(parameters).search(/[{;]/);
    if (body < 0 || code[parameters + body] !== '{') continue;
    const end = closing(parameters + body);
    for (let index = start; index <= end; index += 1) if (kept[index] !== '\n') kept[index] = ' ';
  }
  return kept.join('');
}

// The modules whose top-level code runs before any check, because scripts/check-repository.ts or scripts/s0.ts imports
// them, directly or not. verify.ts imports no other. Each may import only Node's crypto, fs, path, url and
// child_process modules and modules beside it, and none of its top-level code may use process, globalThis, the
// environment, an exit, eval, Function, Reflect, a prototype, require or a dynamic import (OQ-06 section 2.2).
export const guardEntries: readonly string[] = ['scripts/check-repository.ts', 'scripts/s0.ts'];
const allowedImport = /^(?:node:(?:crypto|fs|path|url|child_process)|\.\/[\w.-]+\.ts)$/;
export function importSpecifiers(source: string): string[] {
  return [...withoutComments(source).matchAll(/^[ \t]*(?:import|export)\b[^;'"`]*?\bfrom[ \t]*(['"])([^'"\n]+)\1|^[ \t]*import[ \t]*(['"])([^'"\n]+)\3/gm)].map((match) => match[2] ?? match[4]);
}
export function guardedModules(base: string): string[] {
  const seen = new Set<string>();
  const visit = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const specifier of importSpecifiers(text(base, file))) {
      if (specifier.startsWith('./') || specifier.startsWith('../')) visit(posix.normalize(posix.join(posix.dirname(file), specifier)));
    }
  };
  for (const entry of guardEntries) visit(entry);
  return [...seen].sort();
}
export function topLevelErrors(file: string, source: string): string[] {
  const errors: string[] = [];
  for (const specifier of importSpecifiers(source)) {
    if (!allowedImport.test(specifier)) errors.push(`${file} may import only node:crypto, node:fs, node:path, node:url, node:child_process and ./*.ts modules, found ${specifier}: check-repository.ts and verify.ts run it before any check`);
  }
  const top = topLevelCode(scanSource(source).code);
  const used = [...new Set([...top.matchAll(/\b(?:process|globalThis|global|env|exit|eval|Function|Reflect|prototype|__proto__)\b|\b(?:import|require)\s*\(/g)].map((match) => match[0].replace(/\s*\($/, '()')))];
  if (used.length > 0) errors.push(`${file} must not use ${used.join(', ')} outside a function body: its top-level code runs when check-repository.ts or verify.ts imports it, before any check`);
  return errors;
}

// No verification script reads the CI, GITHUB_* or RUNNER_* variables, so the checks do the same work locally and in
// CI. Names in code, string literals that are exactly such a name, and regular expressions that mention one count.
// The patterns below spell the names as [C]I and \x5f, so that the rule does not find itself in this file.
const ciVariableName = /^(?:[C]I|GITHUB\x5f[A-Z0-9_]*|RUNNER\x5f[A-Z0-9_]*)$/;
export function ciVariableErrors(file: string, source: string): string[] {
  const { code, literals } = scanSource(source);
  const names = new Set<string>([...code.matchAll(/\b(?:[C]I|GITHUB\x5f\w*|RUNNER\x5f\w*)\b/g)].map((match) => match[0]));
  for (const literal of literals) {
    if (literal.kind === 'regex' ? /GITHUB\x5f|RUNNER\x5f|(?<![\w$])[C]I(?![\w$])/.test(literal.text) : ciVariableName.test(literal.text)) {
      names.add(literal.kind === 'regex' ? `/${literal.text}/` : JSON.stringify(literal.text));
    }
  }
  return names.size > 0 ? [`${file} must not read the CI, GITHUB_* or RUNNER_* variables (${[...names].join(', ')}): verification does the same work locally and in CI`] : [];
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
  "  'RUSTDOC',",
  "  'RUSTC_WRAPPER',",
  "  'RUSTC_WORKSPACE_WRAPPER',",
  "  'CARGO_BUILD_RUSTFLAGS',",
  "  'CARGO_BUILD_RUSTDOCFLAGS',",
  "  'CARGO_BUILD_RUSTDOC',",
  "  'CARGO_ENCODED_RUSTFLAGS',",
  "  'CARGO_ENCODED_RUSTDOCFLAGS',",
  "  'CARGO_BUILD_RUSTC_WRAPPER',",
  "  'CARGO_BUILD_RUSTC_WORKSPACE_WRAPPER',",
  "  'BIOME_CONFIG_PATH',",
  ']);',
  'const removedPatterns: readonly RegExp[] = [/^NODE_TEST_/, /^TURBO_/, /^(?:NPM|PNPM)_CONFIG_/, /^CARGO_TARGET_.+_(?:RUNNER|RUSTFLAGS|RUSTDOCFLAGS|LINKER)$/];',
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

// The reviewed code of scripts/check-repository.ts, the whole file. CI runs it as its own step before any install,
// so a change to verify.ts that only CI would notice still fails there.
export const expectedCheckRepositoryCode: readonly string[] = [
  "import { checkRepository, root } from './repository.ts';",
  'function report(errors: readonly string[]): void {',
  '  for (const error of errors) console.error(error);',
  '  if (errors.length) process.exitCode = 1;',
  "  else console.log('Repository checks passed: specs, acceptance IDs, links, source hashes, file map, agent assets, verification guards, and workflow conventions.');",
  '}',
  'report(checkRepository(root));',
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

// The modules that verify.ts and check-repository.ts import run their top-level code before step 1. Anywhere in
// their code, outside string and regular-expression literals, they may not use process, globalThis, eval, Function,
// Reflect, prototypes, require or a dynamic import, and may not reassign a function they declare, so none of them
// can exit early, change the environment of a step or replace a checked function. scripts/s0.ts, this guard, is held
// to the same rule. scripts/environment.ts reads process.env and scripts/check-repository.ts sets the exit code; both
// are checked whole against their reviewed code.
export const verifyModules: readonly string[] = ['scripts/repository.ts', 'scripts/rust.ts', 'scripts/typescript.ts', 'scripts/development-skills.ts', 'scripts/agent-assets.ts', 'scripts/s0.ts'];
export function verifyModuleErrors(file: string, source: string): string[] {
  const code = scanSource(source).code;
  const errors: string[] = [];
  const used = /\b(?:process|globalThis|global|eval|Function|Reflect|prototype|__proto__)\b|\b(?:import|require)\s*\(/.exec(code);
  if (used) errors.push(`${file} must not use ${used[0].replace(/\s*\($/, '()')}: verify.ts and check-repository.ts import it, and only scripts/environment.ts reads the environment`);
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

// A small TOML reader for Cargo manifests: tables, arrays of tables, dotted, bare and quoted keys, basic, literal and
// multi-line strings, arrays and inline tables. Numbers and dates are kept as their text. It throws on anything else,
// so a manifest it cannot read fails the checks instead of passing them.
export type TomlValue = string | boolean | TomlValue[] | TomlTable;
export interface TomlTable {
  [key: string]: TomlValue;
}
// An object that is not an array: a TOML table, or a JSON object of a manifest.
export function isTomlTable(value: unknown): value is TomlTable {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
const isObject = isTomlTable;
export function parseToml(source: string): TomlTable {
  const table = (): TomlTable => Object.create(null);
  const root = table();
  let at = 0;
  const fail = (message: string): never => {
    throw new Error(`${message} at line ${source.slice(0, at).split('\n').length}`);
  };
  const space = () => {
    while (source[at] === ' ' || source[at] === '\t') at += 1;
  };
  const comment = () => {
    if (source[at] === '#') while (at < source.length && source[at] !== '\n') at += 1;
  };
  const blank = () => {
    for (;;) {
      space();
      comment();
      if (source[at] !== '\n' && source[at] !== '\r') return;
      at += 1;
    }
  };
  const lineEnd = () => {
    space();
    comment();
    if (source.startsWith('\r\n', at)) at += 2;
    else if (source[at] === '\n') at += 1;
    else if (at < source.length) fail('expected the end of the line');
  };
  const escapes: Readonly<Record<string, string>> = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\' };
  const string = (): string => {
    const quote = source[at];
    const multi = source.startsWith(quote.repeat(3), at);
    at += multi ? 3 : 1;
    if (multi && source.startsWith('\r\n', at)) at += 2;
    else if (multi && source[at] === '\n') at += 1;
    let value = '';
    for (;;) {
      if (at >= source.length) fail('unterminated string');
      if (multi ? source.startsWith(quote.repeat(3), at) : source[at] === quote) {
        at += multi ? 3 : 1;
        return value;
      }
      if (!multi && source[at] === '\n') fail('line break in a string');
      if (quote === '"' && source[at] === '\\') {
        const escape = source[at + 1] ?? '';
        const unicode = /^(?:u([0-9A-Fa-f]{4})|U([0-9A-Fa-f]{8}))/.exec(source.slice(at + 1, at + 10));
        if (Object.hasOwn(escapes, escape)) {
          value += escapes[escape];
          at += 2;
        } else if (unicode) {
          value += String.fromCodePoint(Number.parseInt(unicode[1] ?? unicode[2], 16));
          at += 1 + unicode[0].length;
        } else if (multi && /^\\[ \t]*\r?\n/.test(source.slice(at, at + 64))) {
          at += 1;
          while (at < source.length && /[ \t\r\n]/.test(source[at])) at += 1;
        } else fail('invalid escape in a string');
        continue;
      }
      value += source[at];
      at += 1;
    }
  };
  const bareKey = /[A-Za-z0-9_-]+/y;
  const key = (): string[] => {
    const parts: string[] = [];
    for (;;) {
      space();
      if (source[at] === '"' || source[at] === "'") {
        if (source.startsWith(source[at].repeat(3), at)) fail('a key cannot be a multi-line string');
        parts.push(string());
      } else {
        bareKey.lastIndex = at;
        const match = bareKey.exec(source) ?? fail('expected a key');
        parts.push(match[0]);
        at = bareKey.lastIndex;
      }
      space();
      if (source[at] !== '.') return parts;
      at += 1;
    }
  };
  const assign = (target: TomlTable, path: readonly string[], item: TomlValue) => {
    let current = target;
    for (const part of path.slice(0, -1)) {
      if (!Object.hasOwn(current, part)) current[part] = table();
      const next = current[part];
      current = isTomlTable(next) ? next : fail(`${path.join('.')} extends a value that is not a table`);
    }
    const last = path[path.length - 1];
    if (Object.hasOwn(current, last)) fail(`duplicate key ${path.join('.')}`);
    current[last] = item;
  };
  const bareValue = /[A-Za-z0-9_:.+-]+/y;
  const value = (): TomlValue => {
    const char = source[at];
    if (char === '"' || char === "'") return string();
    if (char === '[') {
      at += 1;
      const items: TomlValue[] = [];
      for (;;) {
        blank();
        if (source[at] === ']') {
          at += 1;
          return items;
        }
        items.push(value());
        blank();
        if (source[at] === ',') at += 1;
        else if (source[at] !== ']') fail('expected , or ] in an array');
      }
    }
    if (char === '{') {
      at += 1;
      const inline = table();
      space();
      if (source[at] === '}') {
        at += 1;
        return inline;
      }
      for (;;) {
        const path = key();
        if (source[at] !== '=') fail('expected = in an inline table');
        at += 1;
        space();
        assign(inline, path, value());
        space();
        if (source[at] === '}') {
          at += 1;
          return inline;
        }
        if (source[at] !== ',') fail('expected , or } in an inline table');
        at += 1;
      }
    }
    bareValue.lastIndex = at;
    const match = bareValue.exec(source) ?? fail('expected a value');
    at = bareValue.lastIndex;
    return match[0] === 'true' ? true : match[0] === 'false' ? false : match[0];
  };
  // The table that a [header] or [[header]] opens. A dotted header walks into the last entry of an array of tables.
  const open = (path: readonly string[], array: boolean): TomlTable => {
    let current = root;
    path.forEach((part, index) => {
      if (array && index === path.length - 1) {
        if (!Object.hasOwn(current, part)) current[part] = [];
        const list = current[part];
        const entry = table();
        if (!Array.isArray(list)) fail(`${path.join('.')} is not an array of tables`);
        (list as TomlValue[]).push(entry);
        current = entry;
        return;
      }
      if (!Object.hasOwn(current, part)) current[part] = table();
      const next = current[part];
      const target = Array.isArray(next) ? next[next.length - 1] : next;
      current = isTomlTable(target) ? target : fail(`${path.join('.')} is not a table`);
    });
    return current;
  };
  let current = root;
  for (;;) {
    blank();
    if (at >= source.length) return root;
    const array = source.startsWith('[[', at);
    if (source[at] === '[') {
      at += array ? 2 : 1;
      const path = key();
      if (!source.startsWith(array ? ']]' : ']', at)) fail('expected the end of a table header');
      at += array ? 2 : 1;
      lineEnd();
      current = open(path, array);
      continue;
    }
    const path = key();
    if (source[at] !== '=') fail('expected =');
    at += 1;
    space();
    assign(current, path, value());
    lineEnd();
  }
}

// The members of the Cargo workspace in the root Cargo.toml.
export function cargoWorkspaceMembers(source: string): string[] {
  const workspace = parseToml(source).workspace;
  const members = isTomlTable(workspace) ? workspace.members : undefined;
  if (!Array.isArray(members) || members.length === 0 || !members.every((member) => typeof member === 'string')) throw new Error('Cargo.toml declares no workspace members');
  return members as string[];
}

// Manifest settings that leave tests unbuilt or unrun (OQ-06 sections 1 and 8), read from the parsed manifest, so a
// quoted, dotted or inline-table key counts as well. Keys compare without case, hyphens or underscores. Any of
// autotests, autobins, autoexamples, autobenches, test, harness or doctest set to false anywhere fails, and so does
// required-features on a [[test]] or [[bin]] target, because Cargo skips such a target unless the feature is enabled.
const testSwitches: ReadonlySet<string> = new Set(['autotests', 'autobins', 'autoexamples', 'autobenches', 'test', 'harness', 'doctest']);
const normalKey = (key: string) => key.toLowerCase().replace(/[-_]/g, '');
export function cargoManifestErrors(file: string, source: string): string[] {
  let manifest: TomlTable;
  try {
    manifest = parseToml(source);
  } catch (error) {
    return [`${file}: cannot read the manifest: ${error instanceof Error ? error.message : error}`];
  }
  const errors: string[] = [];
  const walk = (item: TomlValue, path: string) => {
    if (Array.isArray(item)) item.forEach((entry, index) => walk(entry, `${path}[${index}]`));
    if (!isTomlTable(item)) return;
    for (const [key, entry] of Object.entries(item)) {
      const where = path ? `${path}.${key}` : key;
      if (entry === false && testSwitches.has(normalKey(key))) errors.push(`${file} must not set ${where} = false: Cargo would leave tests unbuilt or unrun`);
      walk(entry, where);
    }
  };
  walk(manifest, '');
  for (const kind of ['test', 'bin']) {
    const targets = manifest[kind];
    (Array.isArray(targets) ? targets : [targets]).forEach((target, index) => {
      if (!isTomlTable(target)) return;
      for (const key of Object.keys(target)) {
        if (normalKey(key) === 'requiredfeatures') errors.push(`${file} must not set ${kind}[${index}].${key}: Cargo skips a target whose required features are not enabled, so its tests would not run`);
      }
    });
  }
  return errors;
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

// The reviewed form of pnpm-workspace.yaml (OQ-06 section 1): comment and blank lines, `packages:` with one `  - path`
// line per package, `verifyDepsBeforeRun: error`, and `allowBuilds:` with one `  name: true|false` line per reviewed
// entry. pnpm reads many other settings from this file, and some decide how every script runs or what is installed
// (scriptShell, shellEmulator, nodeOptions, enablePrePostScripts, pnpmfile, hooks, overrides, packageExtensions), so
// any other key, and any other line form (a quoted key, a flow mapping, an anchor), fails.
export const pnpmWorkspaceKeys: readonly string[] = ['packages', 'verifyDepsBeforeRun', 'allowBuilds'];
export const expectedAllowBuilds: Readonly<Record<string, boolean>> = { esbuild: false };
export function pnpmWorkspaceErrors(source: string): string[] {
  const file = 'pnpm-workspace.yaml';
  const errors: string[] = [];
  const keys: string[] = [];
  const builds: Record<string, boolean> = {};
  let verify: string | undefined;
  let section = '';
  source.split('\n').forEach((line, index) => {
    if (/^[ \t]*(?:#.*)?$/.test(line)) return;
    const top = /^([A-Za-z][A-Za-z0-9]*):(?:[ \t]+(\S.*?))?[ \t]*$/.exec(line);
    if (top) {
      const [, key, value] = top;
      section = key;
      if (keys.includes(key)) errors.push(`${file} sets ${key} twice`);
      keys.push(key);
      if (!pnpmWorkspaceKeys.includes(key)) errors.push(`${file} must not set ${key}: it may set only ${pnpmWorkspaceKeys.join(', ')}, because other pnpm settings, such as scriptShell or nodeOptions, change how every script runs`);
      else if (key === 'verifyDepsBeforeRun') verify = value;
      else if (value !== undefined) errors.push(`${file} must write ${key} as a block, one entry per line`);
      return;
    }
    if (section === 'packages' && /^  - [^\s#'"]+[ \t]*$/.test(line)) return;
    const build = /^  ([A-Za-z0-9@][\w@./-]*):[ \t]+(true|false)[ \t]*$/.exec(line);
    if (section === 'allowBuilds' && build) {
      if (Object.hasOwn(builds, build[1])) errors.push(`${file} lists ${build[1]} twice in allowBuilds`);
      builds[build[1]] = build[2] === 'true';
      return;
    }
    errors.push(`${file} line ${index + 1} is not in the reviewed form (comments, packages, verifyDepsBeforeRun: error, allowBuilds): ${JSON.stringify(line)}`);
  });
  if (verify !== 'error') errors.push(`${file} must set verifyDepsBeforeRun: error, so pnpm never installs before a script`);
  const sorted = (entries: Readonly<Record<string, boolean>>) => JSON.stringify(Object.entries(entries).sort(([left], [right]) => left.localeCompare(right)));
  if (sorted(builds) !== sorted(expectedAllowBuilds)) errors.push(`${file} allowBuilds must be exactly ${JSON.stringify(expectedAllowBuilds)}, found ${JSON.stringify(builds)}`);
  return errors;
}

// The scripts of the root package.json, exactly. A literal, so the expectation is not read from the file it checks.
export const expectedRootScripts: Readonly<Record<string, string>> = {
  verify: 'node scripts/verify.ts',
  'verify:repository': 'node scripts/check-repository.ts',
  'verify:contracts': 'pnpm --filter @openquant/api-contracts run test:parity',
  test: 'node --test scripts/tests/repository.test.ts',
  'generate:spec-index': 'node scripts/generate-spec-index.ts',
  'generate:tree': 'node scripts/generate-repository-tree.ts',
};

// Script names that pnpm runs on its own: install lifecycle scripts, pnpm:devPreinstall, and pre and post hooks. CI
// installs with --ignore-scripts as well; neither the root nor a workspace package may define one.
export function hookScript(name: string): boolean {
  return /^(?:pre|post)/.test(name) || ['install', 'dependencies', 'pnpm:devPreinstall'].includes(name);
}

// Tracked files from which pnpm or npm read settings or hooks besides the root pnpm-workspace.yaml: another
// pnpm-workspace.yaml (pnpm reads the nearest one when Turborepo runs a package script), a pnpmfile, and an .npmrc that
// sets the script shell, Node options or hooks.
const npmrcScriptSettings: ReadonlySet<string> = new Set(['script-shell', 'shell-emulator', 'node-options', 'pnpmfile', 'global-pnpmfile', 'enable-pre-post-scripts']);
export function packageManagerFileErrors(file: string, source: string): string[] {
  const name = file.split('/').at(-1) ?? '';
  if (/^pnpm-workspace\.ya?ml$/.test(name) && file !== 'pnpm-workspace.yaml') return [`Only the root pnpm-workspace.yaml may configure pnpm: ${file}`];
  if (/^\.?pnpmfile\.[cm]?[jt]s$/.test(name)) return [`A pnpmfile must not be tracked: ${file}: its hooks would change what pnpm installs or runs`];
  if (name !== '.npmrc') return [];
  const keys = source.split('\n').map((line) => /^[ \t]*([^#;=\s][^=]*?)[ \t]*=/.exec(line)?.[1].toLowerCase().replace(/_/g, '-')).filter((key): key is string => key !== undefined);
  return keys.filter((key) => npmrcScriptSettings.has(key)).map((key) => `${file} must not set ${key}: it would change how pnpm runs scripts`);
}

// The TypeScript workspace (OQ-06 sections 1 and 7): the package list, each package's task scripts, the files
// pinned by digest, the named workspace test files, and the settings that would let a check pass without checking:
// tsc noCheck or strict off, Biome's linter off, Vitest test selection or a passing empty run, and skipped tests.
export function workspaceErrors(base: string, files: ReadonlySet<string>): string[] {
  const errors: string[] = [];
  const expected = expectedWorkspacePackages.map((item) => item.directory);
  const workspace = text(base, 'pnpm-workspace.yaml');
  const listed = workspacePackageList(workspace);
  if (JSON.stringify(listed) !== JSON.stringify(expected)) {
    errors.push(`pnpm-workspace.yaml must list exactly these packages, one per line, in this order: ${expected.join(', ')}; found ${listed?.join(', ') || 'none'}`);
  }
  errors.push(...pnpmWorkspaceErrors(workspace));
  const root = json(base, 'package.json');
  const rootScripts = isObject(root.scripts) ? root.scripts : {};
  const sameScripts = Object.keys(rootScripts).length === Object.keys(expectedRootScripts).length && Object.entries(expectedRootScripts).every(([name, script]) => rootScripts[name] === script);
  if (!sameScripts) errors.push(`package.json must have exactly these scripts: ${JSON.stringify(expectedRootScripts)}; found ${JSON.stringify(root.scripts)}`);
  const manifests: Array<[string, any]> = [['package.json', root]];
  for (const item of expectedWorkspacePackages) {
    const path = `${item.directory}/package.json`;
    if (!files.has(path)) { errors.push(`Missing workspace package manifest: ${path}`); continue; }
    const manifest = json(base, path);
    manifests.push([path, manifest]);
    if (manifest.name !== item.name) errors.push(`${path} must be named ${item.name}, found ${JSON.stringify(manifest.name)}`);
    for (const task of workspaceTasks) {
      const script = manifest.scripts?.[task];
      if (script !== item.scripts[task]) errors.push(`${path} must have the ${task} script ${JSON.stringify(item.scripts[task])}, found ${JSON.stringify(script)}`);
    }
  }
  for (const [path, manifest] of manifests) {
    for (const name of Object.keys(isObject(manifest.scripts) ? manifest.scripts : {})) {
      if (hookScript(name)) errors.push(`${path} must not have the ${name} script: pnpm runs install lifecycle scripts and pre and post hooks on its own, outside the reviewed steps`);
    }
    if ('pnpm' in manifest) errors.push(`${path} must not set pnpm: pnpm settings belong in the reviewed pnpm-workspace.yaml`);
  }
  for (const file of [...files].sort()) {
    if (/(?:^|\/)(?:pnpm-workspace\.ya?ml|\.?pnpmfile\.[cm]?[jt]s|\.npmrc)$/.test(file)) errors.push(...packageManagerFileErrors(file, text(base, file)));
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
    for (const member of cargoWorkspaceMembers(text(base, 'Cargo.toml'))) {
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
    // that turns off target discovery or a test harness, or makes a target need a feature, would leave tests unbuilt
    // or unrun. The workspace checks also compare the test targets that Cargo builds with the tracked tests/*.rs.
    for (const file of [...files].sort()) {
      if (/(^|\/)\.cargo\/config(\.toml)?$/.test(file)) errors.push(`Cargo configuration must not be tracked: ${file}`);
      if (/(^|\/)Cargo\.toml$/.test(file)) errors.push(...cargoManifestErrors(file, text(base, file)));
    }
  });

  guard('Rust verification', () => {
    // The imported list is the one the driver runs. It is compared with the literal expectation above.
    errors.push(...cargoCommandErrors(cargoCommands));
    errors.push(...rustModuleErrors(text(base, 'scripts/rust.ts')));
    errors.push(...verifyDriverErrors(text(base, 'scripts/verify.ts')));
    errors.push(...environmentModuleErrors(text(base, 'scripts/environment.ts')));
    errors.push(...codeDifference('scripts/check-repository.ts', 'the whole file', expectedCheckRepositoryCode, codeLines(text(base, 'scripts/check-repository.ts'))));
    for (const file of verifyModules.filter((item) => item !== 'scripts/rust.ts' && item !== 'scripts/typescript.ts')) errors.push(...verifyModuleErrors(file, text(base, file)));
    // G3: the top-level code of check-repository.ts, s0.ts and every module they import runs before any check.
    for (const file of guardedModules(base)) errors.push(...topLevelErrors(file, text(base, file)));
    for (const file of [...files].filter((item) => /^scripts\/(?:workspace\/)?[^/]+\.ts$/.test(item)).sort()) {
      if (!['scripts/rust.ts', 'scripts/typescript.ts', 'scripts/s0.ts'].includes(file)) errors.push(...spawnEnvironmentErrors(file, text(base, file)));
      errors.push(...ciVariableErrors(file, text(base, file)));
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
    const dependencies = ci.indexOf('pnpm install --frozen-lockfile --ignore-scripts');
    if (dependencies < 0 || run < 0 || dependencies > run) errors.push('CI must install the locked dependencies with pnpm install --frozen-lockfile --ignore-scripts before node scripts/verify.ts');
    // C6R: the repository checks run as their own CI step, before any install, so they do not depend on verify.ts.
    const check = ci.indexOf('node scripts/check-repository.ts');
    if (check < 0 || [ci.indexOf('npm install --global'), dependencies, install, run].some((position) => position >= 0 && position < check)) {
      errors.push('CI must run node scripts/check-repository.ts as its own step before any install and before node scripts/verify.ts');
    }
  });

  guard('TypeScript verification', () => {
    // The imported list is the one the driver runs. It is compared with the literal expectation above.
    errors.push(...typescriptCommandErrors(typescriptCommands));
    errors.push(...typescriptModuleErrors(text(base, 'scripts/typescript.ts')));
    // workspaceErrors also requires verifyDepsBeforeRun: error in pnpm-workspace.yaml: pnpm 11 otherwise installs before
    // `pnpm verify` and every other `pnpm run` when the install is out of date.
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

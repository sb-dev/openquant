import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { posix, resolve } from 'node:path';
import { cargoCommands } from './rust.ts';

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
];

// Protocol manifest vocabulary. The Rust tests select entries by these exact expect values. For
// contracts, packages/api-contracts/rust/tests/protocol.rs and the contracts-report binary reject an
// unknown name. packages/quant-core/tests/protocol.rs checks the engine contracts, skips the connected
// envelopes by name and panics on an unknown name. The engine list is the Contract enum and the
// connected list is the Envelope enum in packages/api-contracts/rust/src/lib.rs (OQ-05 section 7).
export const protocolExpectations: readonly string[] = ['valid', 'schema_invalid', 'semantic_invalid'];
export const protocolEngineContracts: readonly string[] = ['strategy-artefact', 'evaluation-input', 'evaluation-result', 'checkpoint'];
export const protocolConnectedContracts: readonly string[] = ['evaluation-plan', 'evaluation-request', 'evaluation-submission', 'job-dispatch', 'attempt-claim', 'command', 'research-profile', 'cohort-policy', 'dataset-manifest', 'retrieval-request', 'retrieval-result', 'validation-result', 'evaluation-metrics', 'gate-report', 'agent-dispatch', 'agent-attempt-result', 'api-error', 'release-manifest'];

// Exact equality with the expected list: same steps, same flags, same order, nothing extra.
export function cargoCommandErrors(commands: readonly string[]): string[] {
  const errors: string[] = [];
  for (const command of expectedCargoCommands) {
    if (!commands.includes(command)) errors.push(`scripts/rust.ts must run: ${command}`);
  }
  for (const command of commands) {
    if (!expectedCargoCommands.includes(command)) errors.push(`scripts/rust.ts runs a Rust step that is not expected: ${command}`);
  }
  const same = commands.length === expectedCargoCommands.length && commands.every((command, index) => command === expectedCargoCommands[index]);
  if (!same && errors.length === 0) errors.push(`scripts/rust.ts must list the Rust steps once each, in this order: ${expectedCargoCommands.join(' | ')}`);
  return errors;
}

// Source text without comments, so a comment cannot satisfy a code-shape check. String and template
// literals are kept whole. This is not a parser; it is enough for the two small scripts it reads.
export function withoutComments(source: string): string {
  const token = /('(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\.|[^`\\])*`)|\/\/[^\n]*|\/\*[\s\S]*?\*\//g;
  return source.replace(token, (match, literal) => (literal === undefined ? ' ' : match));
}

// Code shapes that scripts/verify.ts must keep, in this order. Each is the statement that makes a
// step bind: the exit-code checks, the toolchain pin check, the fixture digest comparison and the
// report check. The behavioural tests run the real driver as well; these shapes fail fast and say what is missing.
const driverShapes: ReadonlyArray<readonly [string, RegExp]> = [
  ['stop when the repository checks or their tests fail', /for\s*\(\s*const\s+args\s+of\s+\[\s*\[\s*'scripts\/check-repository\.ts'\s*\]\s*,\s*\[\s*'--test'\s*,\s*'scripts\/tests\/repository\.test\.ts'\s*\]\s*\]\s*\)\s*\{\s*const\s+result\s*=\s*spawnSync\(\s*process\.execPath\s*,\s*args\s*,\s*\{[^}]*\}\s*\)\s*;\s*(?:if\s*\(\s*result\.error\s*\)\s*console\.error\(\s*result\.error\.message\s*\)\s*;\s*)?if\s*\(\s*result\.status\s*!==\s*0\s*\)\s*process\.exit\(\s*result\.status\s*\?\?\s*1\s*\)/],
  ['fail when the pinned toolchain is not the one that runs', /const\s+pinError\s*=\s*toolchainPinError\(\s*root\s*\)\s*;\s*if\s*\(\s*pinError\s*\)\s*fail\(\s*pinError\s*\)\s*;/],
  ['record the fixture digest before the Cargo steps', /const\s+fixturesBefore\s*=\s*fixtureDigest\(\s*root\s*\)\s*;/],
  ['run every Cargo command and fail on a non-zero exit status', /for\s*\(\s*const\s+command\s+of\s+cargoCommands\s*\)\s*\{\s*const\s+status\s*=\s*runCargo\(\s*root\s*,\s*command\s*\)\s*;\s*if\s*\(\s*status\s*!==\s*0\s*\)\s*fail\(/],
  ['compare the fixture digest after the Cargo steps', /if\s*\(\s*fixtureDigest\(\s*root\s*\)\s*!==\s*fixturesBefore\s*\)\s*fail\(/],
  ['fail on any replay report problem', /const\s+problems\s*=\s*reportErrors\(\s*root\s*\)\s*;\s*if\s*\(\s*problems\.length\s*\)\s*fail\(/],
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
  return errors;
}

// The parts of scripts/rust.ts whose behaviour the driver relies on. The driver tests exercise them.
export function rustModuleErrors(source: string): string[] {
  const code = withoutComments(source);
  const errors: string[] = [];
  if (!/return\s+result\.status\s*\?\?\s*1\s*;/.test(code)) errors.push('scripts/rust.ts runCargo must return the exit status of the command, or 1 when it did not run');
  if (!/stdout\.startsWith\(\s*`rustc \$\{channel\} `\s*\)/.test(code)) errors.push('scripts/rust.ts must compare the installed rustc version with the pinned channel');
  return errors;
}

function text(base: string, path: string): string {
  return readFileSync(resolve(base, path), 'utf8');
}

function json(base: string, path: string): any {
  return JSON.parse(text(base, path));
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
  });

  guard('Rust verification', () => {
    // The imported list is the one the driver runs. It is compared with the literal expectation above.
    errors.push(...cargoCommandErrors(cargoCommands));
    errors.push(...rustModuleErrors(text(base, 'scripts/rust.ts')));
    errors.push(...verifyDriverErrors(text(base, 'scripts/verify.ts')));
    const ci = text(base, '.github/workflows/ci.yml');
    const install = ci.indexOf('rustup toolchain install');
    const run = ci.indexOf('node scripts/verify.ts');
    if (install < 0 || run < 0 || install > run) errors.push('CI must install the pinned Rust toolchain before node scripts/verify.ts');
    const timeout = /timeout-minutes:\s*(\d+)/.exec(ci.slice(ci.indexOf('checks:')));
    if (!timeout || Number(timeout[1]) < 20) errors.push('CI checks job needs timeout-minutes of at least 20 for a cold Cargo build');
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

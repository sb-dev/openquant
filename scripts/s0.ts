import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
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
    const rust = text(base, 'scripts/rust.ts');
    for (const command of cargoCommands) {
      if (!rust.includes(`'${command}'`)) errors.push(`scripts/rust.ts must run: ${command}`);
    }
    const verify = text(base, 'scripts/verify.ts');
    if (!/cargoCommands/.test(verify) || !/runCargo/.test(verify)) errors.push('scripts/verify.ts must run the Cargo commands from scripts/rust.ts');
    if (!/fixtureDigest/.test(verify)) errors.push('scripts/verify.ts must guard fixtures against changes during verification');
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
    const listed = new Set<string>(manifest.entries.map((e: any) => e.path));
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

// Checks the report written by the replay step. A missing or failing report fails verification.
export function reportErrors(base: string): string[] {
  const errors: string[] = [];
  const directory = 'local-runs/s0';
  if (!existsSync(resolve(base, `${directory}/report.md`))) return [`Missing replay report: ${directory}/report.md`];
  const report = text(base, `${directory}/report.md`);
  for (const heading of reportSections) {
    if (!report.includes(heading)) errors.push(`Report lacks the section: ${heading}`);
  }
  try {
    const index = json(base, `${directory}/index.json`);
    const cases = index.cases as Array<{ case: string; passed: boolean }>;
    if (!Array.isArray(cases) || cases.length === 0) errors.push('Replay index lists no cases');
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

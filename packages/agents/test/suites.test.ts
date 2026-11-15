// The offline suites of fixtures/agent-results: every case runs through request assembly and result parsing with a
// labelled synthetic response, and the expected values in each fixture were written by hand (OQ-03 section 6). No test
// here calls a model.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { type FixtureReport, fixtureFiles, readFixture, runFixture } from '../dev/fixture-runner.ts';
import { loadFixturePolicy, treatmentOf } from '../dev/policy.ts';
import { packageRoot, readJson, readText } from './support/oracle.ts';

const files = fixtureFiles();
const byName = (suite: string) =>
  files.filter((file) => file.includes(`/${suite}/`)).map((file) => basename(file, '.json'));
const categories = [
  'hypothesis_assumption',
  'data_quality_alignment',
  'causal_leakage',
  'execution_accounting_assumption',
  'search_overfitting',
  'policy_mismatch',
  'portfolio_fit',
  'operational_risk',
  'source_uncertainty',
  'missing_evidence',
  'method_advice',
];

describe('every fixture', () => {
  test.each(files.map((file) => [`${basename(resolve(file, '..'))}/${basename(file, '.json')}`, file] as const))(
    '%s gives the expected outcome',
    async (_name, file) => {
      const report: FixtureReport = await runFixture(file);
      expect(report.problems).toEqual([]);
    },
  );
});

describe('the suites', () => {
  test('are not empty and hold the cases of the pilot specification', () => {
    expect(byName('strategy-formulation').length).toBeGreaterThanOrEqual(20);
    expect(byName('strategy-critique').length).toBeGreaterThanOrEqual(25);
    expect(byName('strategy-formulation')).toEqual(
      expect.arrayContaining([
        'valid-revision-entry',
        'valid-revision-exit',
        'revision-scope-both',
        'operator-outside-set',
        'unresolved-entries',
        'oversized-result',
        'holdout-leak-attempt',
        'holdout-evidence-overlap',
        'rule-changes-wrong-value',
        'parent-hash-mismatch',
        'valid-seed-translation',
        'valid-new-family',
        'not-json',
        'unknown-field',
      ]),
    );
    expect(byName('strategy-critique')).toEqual(
      expect.arrayContaining([
        'causal-leak-candidate',
        'empty-findings',
        'unknown-category',
        'approval-field',
        'unregistered-subject',
        'unsupplied-method-ref',
      ]),
    );
  });

  test('every fixture is labelled synthetic, names its suite and states its purpose', () => {
    for (const file of files) {
      const fixture = readFixture(file);
      expect(fixture.label, file).toBe('synthetic');
      expect(file).toContain(`/${fixture.suite}/`);
      expect(basename(file, '.json')).toBe(fixture.id);
      expect(fixture.purpose.length).toBeGreaterThan(40);
    }
    expect(readJson<{ label: string }>('fixtures/agent-results/context.pilot.json').label).toBe('synthetic');
  });

  test('every critic category has a valid completion with a finding of that category', () => {
    const covered = new Set<string>();
    for (const file of files.filter((item) => item.includes('/strategy-critique/'))) {
      const expectation = readFixture(file).expect as
        | { outcome?: string; findings?: { category: string }[] }
        | undefined;
      if (expectation?.outcome !== 'completion') continue;
      for (const item of expectation.findings ?? []) covered.add(item.category);
    }
    expect([...covered].sort()).toEqual([...categories].sort());
  });

  test('every expected finding states the treatment of both transitions, and none blocks DRAFT_TO_EVALUATING', () => {
    let count = 0;
    for (const file of files.filter((item) => item.includes('/strategy-critique/'))) {
      const expectation = readFixture(file).expect as
        | { findings?: { treatment: Record<string, string> }[] }
        | undefined;
      for (const item of expectation?.findings ?? []) {
        count += 1;
        expect(Object.keys(item.treatment).sort(), file).toEqual(['DRAFT_TO_EVALUATING', 'EVALUATING_TO_PAPER']);
        expect(item.treatment.DRAFT_TO_EVALUATING, file).toBe('advisory');
      }
    }
    expect(count).toBeGreaterThanOrEqual(15);
  });

  test('the treatments in the fixtures are the cohort policy table of the pilot, where the synthetic policy has no escalation', () => {
    const pilot = readJson<{
      finding_treatment: { category: string; transition: string; treatment: string; escalate_when: string[] }[];
    }>('fixtures/protocol/valid/cohort-policy.s1-pilot.json');
    const policy = loadFixturePolicy();
    for (const row of pilot.finding_treatment.filter((item) => item.escalate_when.length === 0)) {
      const entry = policy.treatments[row.category]?.[row.transition as 'DRAFT_TO_EVALUATING'];
      if (row.category === 'source_uncertainty' || row.category === 'missing_evidence') continue;
      expect(entry?.default, `${row.category} ${row.transition}`).toBe(row.treatment.toLowerCase());
    }
  });

  test('the fixture policy escalates source_uncertainty with an affected rule and missing_evidence with required evidence', () => {
    const policy = loadFixturePolicy();
    const finding = (category: string, affected: string[], evidence: string[]) => ({
      category,
      affected_elements: affected,
      evidence_refs: evidence,
    });
    const required = new Set(['required-1']);
    expect(treatmentOf(policy, finding('source_uncertainty', [], []), required)).toEqual({
      DRAFT_TO_EVALUATING: 'advisory',
      EVALUATING_TO_PAPER: 'advisory',
    });
    expect(treatmentOf(policy, finding('source_uncertainty', ['/definition/entry'], []), required)).toEqual({
      DRAFT_TO_EVALUATING: 'advisory',
      EVALUATING_TO_PAPER: 'blocking',
    });
    expect(treatmentOf(policy, finding('missing_evidence', [], ['other']), required).EVALUATING_TO_PAPER).toBe(
      'advisory',
    );
    expect(treatmentOf(policy, finding('missing_evidence', [], ['required-1']), required).EVALUATING_TO_PAPER).toBe(
      'blocking',
    );
    expect(
      treatmentOf(policy, finding('method_advice', ['/definition/entry'], ['required-1']), required)
        .EVALUATING_TO_PAPER,
    ).toBe('advisory');
    expect(() => treatmentOf(policy, finding('unknown', [], []), required)).toThrow(/no category unknown/);
  });
});

describe('the runner detects a wrong expectation', () => {
  async function mutate(name: string, change: (fixture: Record<string, unknown>) => void): Promise<FixtureReport> {
    const source = files.find((file) => basename(file, '.json') === name);
    if (!source) throw new Error(`no fixture ${name}`);
    const fixture = JSON.parse(readText(source.slice(source.indexOf('fixtures/')))) as Record<string, unknown>;
    change(fixture);
    const directory = mkdtempSync(resolve(tmpdir(), 'openquant-fixture-'));
    try {
      const target = resolve(directory, `${name}.json`);
      writeFileSync(target, JSON.stringify(fixture));
      return await runFixture(target);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }

  test('an expected scope that is not the scope', async () => {
    const report = await mutate('valid-revision-entry', (fixture) => {
      ((fixture.expect as Record<string, unknown>).revision as Record<string, unknown>).scope = 'EXIT';
    });
    expect(report.problems.join(' ')).toMatch(/scope ENTRY is not the expected EXIT/);
  });

  test('a blocker that the result does not carry, and one that it does', async () => {
    const missing = await mutate('operator-outside-set', (fixture) => {
      (fixture.expect as Record<string, unknown>).blockers = [];
    });
    expect(missing.problems.join(' ')).toMatch(/blockers: unexpected/);
    const extra = await mutate('valid-revision-entry', (fixture) => {
      (fixture.expect as Record<string, unknown>).blockers = [{ code: 'REVISION_SCOPE' }];
    });
    expect(extra.problems.join(' ')).toMatch(/blockers: missing/);
  });

  test('a treatment that the policy does not give', async () => {
    const report = await mutate('category-causal-leakage', (fixture) => {
      const findings = (fixture.expect as { findings: { treatment: Record<string, string> }[] }).findings;
      (findings[0] as { treatment: Record<string, string> }).treatment.EVALUATING_TO_PAPER = 'advisory';
    });
    expect(report.problems.join(' ')).toMatch(/findings: (unexpected|missing)/);
  });

  test('a malformed reason that is not the reason', async () => {
    const report = await mutate('not-json', (fixture) => {
      (fixture.expect as Record<string, unknown>).reason = 'SCHEMA_INVALID';
    });
    expect(report.problems.join(' ')).toMatch(/reason NOT_JSON is not the expected SCHEMA_INVALID/);
  });

  test('a fixture that is not labelled synthetic', async () => {
    const report = await mutate('not-json', (fixture) => {
      fixture.label = 'recorded';
    });
    expect(report.problems.join(' ')).toMatch(/labelled synthetic/);
  });

  test('a refusal that assembly does not give', async () => {
    const report = await mutate('valid-revision-entry', (fixture) => {
      fixture.assembly = { outcome: 'refused', codes: ['HOLDOUT_OVERLAP'] };
    });
    expect(report.problems.join(' ')).toMatch(/assembly succeeded, but the fixture expects a refusal/);
  });
});

describe('the development script', () => {
  const run = (...args: string[]) =>
    spawnSync(process.execPath, ['dev/eval-fixtures.ts', ...args], { cwd: packageRoot, encoding: 'utf8' });

  test('runs every fixture in fixture mode and says that no model was called', () => {
    const result = run();
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toMatch(
      /\d+ synthetic fixtures \(strategy-formulation \d+, strategy-critique \d+\), 0 failed\. No model was called\./,
    );
    expect(result.stdout).not.toMatch(/^FAIL/m);
  });

  test('refuses any other mode', () => {
    const result = run('--mode', 'live');
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/fixture mode only/);
  });
});

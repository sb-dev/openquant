// Runs the offline agent suites in fixtures/agent-results (development tooling, fixture mode only).
//
// Each fixture is one synthetic case: a request recipe, an optional expectation about request assembly, a canned
// response and the outcome that the role module must give. The runner assembles the request, parses the canned
// response and returns the differences from the expectation. It never calls a model. A fixture is labelled synthetic:
// it cannot count as a real-model result (OQ-03 section 6).

import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { canonicalJson, type JsonObject, type JsonValue } from '@openquant/api-contracts';
import {
  assembleCritiqueRequest,
  assembleFormulationRequest,
  parseCritiqueResult,
  parseFormulationResult,
} from '../src/index.ts';
import { asObject, isObject } from '../src/json.ts';
import { loadFixturePolicy, treatmentOf } from './policy.ts';
import {
  type CritiqueRecipe,
  critiqueInput,
  type FormulationRecipe,
  fixturesRoot,
  formulationInput,
  type ResponseSpec,
  responseText,
} from './world.ts';

export const SUITES = ['strategy-formulation', 'strategy-critique'] as const;
export type Suite = (typeof SUITES)[number];

export interface FixtureReport {
  readonly file: string;
  readonly suite: string;
  readonly id: string;
  readonly problems: readonly string[];
}

interface Fixture extends ResponseSpec {
  readonly label?: string;
  readonly suite: Suite;
  readonly id: string;
  readonly purpose: string;
  readonly request: FormulationRecipe | CritiqueRecipe;
  /** Evidence ids that the frozen policy requires (critique only). */
  readonly required_evidence?: readonly string[];
  readonly assembly?: { readonly outcome: 'ok' } | { readonly outcome: 'refused'; readonly codes: readonly string[] };
  readonly expect?: JsonObject;
}

export function fixtureFiles(root: string = fixturesRoot): string[] {
  return SUITES.flatMap((suite) => {
    let names: string[];
    try {
      names = readdirSync(resolve(root, suite));
    } catch {
      return [];
    }
    return names
      .filter((name) => name.endsWith('.json'))
      .sort()
      .map((name) => resolve(root, suite, name));
  });
}

export function readFixture(file: string): Fixture {
  return JSON.parse(readFileSync(file, 'utf8')) as Fixture;
}

const same = (left: unknown, right: unknown) => canonicalJson(left) === canonicalJson(right);

function multisetDifference(label: string, actual: readonly JsonValue[], expected: readonly JsonValue[]): string[] {
  const remaining = expected.map((item) => canonicalJson(item));
  const problems: string[] = [];
  for (const item of actual) {
    const text = canonicalJson(item);
    const at = remaining.indexOf(text);
    if (at < 0) problems.push(`${label}: unexpected ${text}`);
    else remaining.splice(at, 1);
  }
  for (const text of remaining) problems.push(`${label}: missing ${text}`);
  return problems;
}

export async function runFixture(file: string): Promise<FixtureReport> {
  const fixture = readFixture(file);
  const problems: string[] = [];
  const report = () => ({ file, suite: fixture.suite, id: fixture.id, problems });
  if (fixture.label !== 'synthetic')
    problems.push('a fixture is labelled synthetic until a real model has produced it');
  const critique = fixture.suite === 'strategy-critique';
  const assembly = critique
    ? await assembleCritiqueRequest(await critiqueInput(fixture.request as CritiqueRecipe))
    : await assembleFormulationRequest(await formulationInput(fixture.request as FormulationRecipe));
  const wanted = fixture.assembly ?? { outcome: 'ok' };
  if (wanted.outcome === 'refused') {
    if (assembly.ok) problems.push('assembly succeeded, but the fixture expects a refusal');
    else
      problems.push(
        ...multisetDifference(
          'refusal codes',
          [...new Set(assembly.refusals.map((item) => item.code))],
          [...wanted.codes],
        ),
      );
    return report();
  }
  if (!assembly.ok) {
    problems.push(`assembly refused: ${assembly.refusals.map((item) => item.code).join(', ')}`);
    return report();
  }
  const expect = fixture.expect;
  if (expect === undefined) {
    problems.push('the fixture states no expectation');
    return report();
  }
  const output = await responseText(fixture);
  if (critique) {
    const parsed = parseCritiqueResult(assembly.request as Parameters<typeof parseCritiqueResult>[0], output);
    if (!parsed.ok) {
      if (expect.outcome !== 'malformed_result') problems.push(`malformed: ${parsed.reason}: ${parsed.diagnostic}`);
      else if (expect.reason !== parsed.reason)
        problems.push(`reason ${parsed.reason} is not the expected ${String(expect.reason)}: ${parsed.diagnostic}`);
      return report();
    }
    if (expect.outcome !== 'completion') problems.push(`parsed as a completion, expected ${String(expect.outcome)}`);
    if (expect.empty_is_not_pass !== parsed.emptyIsNotPass)
      problems.push(`empty_is_not_pass is ${parsed.emptyIsNotPass}`);
    if (parsed.findings.some((finding) => finding.finding_source !== 'model_judgement'))
      problems.push('a finding is not labelled model_judgement');
    const policy = loadFixturePolicy();
    const required = new Set(fixture.required_evidence ?? []);
    const actual = parsed.findings.map((finding) => ({
      category: finding.category,
      area: finding.location.area,
      affected_elements: finding.affected_elements,
      treatment: treatmentOf(policy, finding, required),
    }));
    problems.push(...multisetDifference('findings', actual, (expect.findings as JsonValue[] | undefined) ?? []));
    return report();
  }
  const parsed = parseFormulationResult(assembly.request as Parameters<typeof parseFormulationResult>[0], output);
  if (!parsed.ok) {
    if (expect.outcome !== 'malformed_result') problems.push(`malformed: ${parsed.reason}: ${parsed.diagnostic}`);
    else if (expect.reason !== parsed.reason)
      problems.push(`reason ${parsed.reason} is not the expected ${String(expect.reason)}: ${parsed.diagnostic}`);
    return report();
  }
  if (expect.outcome !== 'completion') problems.push(`parsed as a completion, expected ${String(expect.outcome)}`);
  const blockers = parsed.blockers.map((blocker) => ({ code: blocker.code, pointer: blocker.pointer ?? '' }));
  const wantedBlockers = ((expect.blockers as JsonObject[] | undefined) ?? []).map((item) => ({
    code: item.code,
    pointer: item.pointer ?? '',
  }));
  problems.push(...multisetDifference('blockers', blockers, wantedBlockers as JsonValue[]));
  const revision = expect.revision;
  if (parsed.revision === undefined) {
    if (revision !== undefined) problems.push('the fixture expects a revision, and the result has none');
  } else if (!isObject(revision)) {
    problems.push('the fixture states no expected revision scope and changes');
  } else {
    if (revision.scope !== parsed.revision.scope)
      problems.push(`scope ${parsed.revision.scope} is not the expected ${String(revision.scope)}`);
    problems.push(
      ...multisetDifference(
        'computed changes',
        parsed.revision.computed as unknown as JsonValue[],
        asObject(revision).computed_changes as JsonValue[],
      ),
    );
  }
  if (!same(parsed.value, JSON.parse(output))) problems.push('the parsed value differs from the output');
  return report();
}

export async function runFixtures(root?: string): Promise<FixtureReport[]> {
  const reports: FixtureReport[] = [];
  for (const file of fixtureFiles(root)) reports.push(await runFixture(file));
  return reports;
}

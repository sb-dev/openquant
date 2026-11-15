// Result parsing of the critic (OQ-03 section 4): typed findings with references that come from the request, labelled
// model_judgement, with no approval, closure or treatment.

import { beforeAll, describe, expect, test } from 'vitest';
import { type CritiqueParse, parseCritiqueResult } from '../src/index.ts';
import type { StrategyCritiqueRequest } from '../src/types.ts';
import { critiqueOutput, critiqueRequest, finding } from './support/requests.ts';

let request: StrategyCritiqueRequest;
beforeAll(async () => {
  request = await critiqueRequest();
});

const parse = (output: unknown): CritiqueParse => parseCritiqueResult(request, JSON.stringify(output));

function malformedOf(result: CritiqueParse) {
  if (result.ok) throw new Error('expected a malformed result');
  return result;
}

describe('a valid result', () => {
  test('labels every finding model_judgement, whatever the model sent', () => {
    const result = parse(
      critiqueOutput(finding(), finding({ category: 'causal_leakage', location: { area: 'expected_effect' } })),
    );
    expect(result.ok && result.findings.map((item) => item.finding_source)).toEqual([
      'model_judgement',
      'model_judgement',
    ]);
    expect(result.ok && result.emptyIsNotPass).toBe(false);
  });

  test('keeps the findings and adds nothing else: no treatment, severity or approval', () => {
    const output = critiqueOutput(
      finding({ related_categories: ['policy_mismatch'], proposed_tests: ['Replay with next-open fills.'] }),
    );
    const result = parse(output);
    expect(result.ok && result.value).toEqual(output);
    expect(result.ok && Object.keys(result.findings[0] ?? {}).sort()).toEqual([
      'affected_elements',
      'category',
      'description',
      'evidence_refs',
      'finding_source',
      'location',
      'method_refs',
      'proposed_tests',
      'related_categories',
    ]);
  });

  test('an empty list is a completion and is flagged: it is not a pass', () => {
    const result = parse(critiqueOutput());
    expect(result).toMatchObject({ ok: true, findings: [], emptyIsNotPass: true });
  });

  test('every category of OQ-03 section 4 is accepted', () => {
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
    const result = parse(critiqueOutput(...categories.map((category) => finding({ category }))));
    expect(result.ok && result.findings.map((item) => item.category)).toEqual(categories);
  });
});

describe('malformed results', () => {
  test.each<[string, Record<string, unknown>]>([
    ['an unknown category', { category: 'lookahead_bias' }],
    ['an approval field', { approved: true }],
    ['a closure field', { resolved: true }],
    ['a severity', { severity: 'high' }],
    ['a treatment', { treatment: 'blocking' }],
    ['a finding_source that the model chose', { finding_source: 'deterministic_check' }],
    ['a missing location', { location: undefined }],
    ['an unknown location area', { location: { area: 'holdout' } }],
    ['a wrong type', { description: ['a list'] }],
  ])('%s makes the whole result malformed as SCHEMA_INVALID', (_name, override) => {
    const result = malformedOf(parse(critiqueOutput(finding(), finding(override))));
    expect(result.reason).toBe('SCHEMA_INVALID');
  });

  test('a stray top-level field and a missing findings list', () => {
    expect(malformedOf(parse({ ...critiqueOutput(), approved: true })).reason).toBe('SCHEMA_INVALID');
    expect(malformedOf(parse({ schema_version: 'strategy-critique.result/1' })).reason).toBe('SCHEMA_INVALID');
  });

  test('a method that the request did not supply', () => {
    const result = malformedOf(parse(critiqueOutput(finding({ method_refs: ['rule-from-memory'] }))));
    expect(result.reason).toBe('REFERENCE_INVALID');
    expect(result.diagnostic).toMatch(/findings\[0\]\.method_refs/);
  });

  test('a method that the request supplied is cited', () => {
    const supplied = structuredClone(request);
    supplied.supplied_methods = [
      { id: 'rule-a', rule_origin: 'summariser_recommendation', category: 'method_advice', scope: 'seed' },
    ];
    const result = parseCritiqueResult(supplied, JSON.stringify(critiqueOutput(finding({ method_refs: ['rule-a'] }))));
    expect(result.ok).toBe(true);
  });

  test('an evidence reference that is not in the request, and one that is', () => {
    expect(malformedOf(parse(critiqueOutput(finding({ evidence_refs: ['ev-invented'] })))).reason).toBe(
      'REFERENCE_INVALID',
    );
    expect(parse(critiqueOutput(finding({ evidence_refs: ['ev-note-1'] }))).ok).toBe(true);
  });

  test.each([
    ['an element that does not exist', '/definition/exits/trailing_stop'],
    ['a contract element, which is not a definition element', '/contract/rationale'],
    ['a pointer with a bad escape', '/definition/exits/~2'],
    ['an index that does not exist', '/definition/indicators/99'],
  ])('affected_elements naming %s', (_name, pointer) => {
    expect(malformedOf(parse(critiqueOutput(finding({ affected_elements: [pointer] })))).reason).toBe(
      'REFERENCE_INVALID',
    );
  });

  test('affected_elements naming definition elements, including an array item and the definition itself', () => {
    const result = parse(
      critiqueOutput(
        finding({ affected_elements: ['/definition', '/definition/indicators/5', '/definition/exits/stop'] }),
      ),
    );
    expect(result.ok).toBe(true);
  });

  test('a location pointer for a contract or definition area must name an element of that part of the subject', () => {
    expect(
      parse(critiqueOutput(finding({ location: { area: 'definition', pointer: '/definition/exits/target' } }))).ok,
    ).toBe(true);
    expect(
      parse(critiqueOutput(finding({ location: { area: 'contract', pointer: '/contract/intended_conditions/0' } }))).ok,
    ).toBe(true);
    for (const location of [
      { area: 'definition', pointer: '/definition/costs' },
      { area: 'definition', pointer: '/contract/rationale' },
      { area: 'contract', pointer: '/definition/exits/target' },
    ]) {
      expect(malformedOf(parse(critiqueOutput(finding({ location })))).reason, JSON.stringify(location)).toBe(
        'REFERENCE_INVALID',
      );
    }
  });

  test('a pointer of another area is free text that names the item, and is not resolved', () => {
    expect(parse(critiqueOutput(finding({ location: { area: 'source_refs', pointer: 'src-note-1' } }))).ok).toBe(true);
  });

  test('a document that is not JSON, or is too long', () => {
    expect(malformedOf(parseCritiqueResult(request, 'Looks fine to me.')).reason).toBe('NOT_JSON');
    expect(malformedOf(parseCritiqueResult(request, ' '.repeat(524_289))).reason).toBe('OUTPUT_LIMIT_EXCEEDED');
  });
});

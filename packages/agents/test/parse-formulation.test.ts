// Result parsing of the proposer (OQ-03 sections 3 and 4): malformed reasons, the exact rule differences and the
// blockers that keep a completion from registering.

import { digest } from '@openquant/api-contracts';
import { beforeAll, describe, expect, test } from 'vitest';
import { applyEdits, proposedForm, seedArtefact } from '../dev/world.ts';
import { type FormulationParse, parseFormulationResult, ROLE_BODY_LIMIT } from '../src/index.ts';
import type { StrategyFormulationRequest } from '../src/types.ts';
import {
  BREAK_EVEN,
  claims,
  revisionOutput,
  revisionRequest,
  SEED_FOUR,
  SEED_ONE,
  SEED_THREE,
  SEED_TWO,
  seedRequest,
  THRESHOLD,
} from './support/requests.ts';

let revision: StrategyFormulationRequest;
let seed: StrategyFormulationRequest;
beforeAll(async () => {
  revision = await revisionRequest();
  seed = await seedRequest();
});

const parse = (request: StrategyFormulationRequest, output: unknown): FormulationParse =>
  parseFormulationResult(request, typeof output === 'string' ? output : JSON.stringify(output));

function malformedOf(result: FormulationParse) {
  if (result.ok) throw new Error('expected a malformed result');
  return result;
}

describe('a valid controlled revision', () => {
  test('completes with the value, no blocker, the scope and the computed changes', async () => {
    const output = await revisionOutput();
    const result = parse(revision, output);
    expect(result).toEqual({
      ok: true,
      value: output,
      blockers: [],
      revision: { computed: [{ path: THRESHOLD, from: '30', to: '32' }], scope: 'ENTRY' },
    });
  });

  test('accepts bytes as well as text', async () => {
    const bytes = new TextEncoder().encode(JSON.stringify(await revisionOutput()));
    expect(parseFormulationResult(revision, bytes).ok).toBe(true);
  });

  test('the order of the declared changes does not matter', async () => {
    const both = await revisionOutput({
      strategy: proposedForm(seedArtefact(SEED_FOUR)),
      rule_changes: [
        { path: THRESHOLD, from: '30', to: '32' },
        { path: BREAK_EVEN, from: '[]', to: 'break_even' },
      ],
    });
    const reversed = { ...both, rule_changes: [...(both.rule_changes as unknown[])].reverse() };
    expect(parse(revision, both)).toMatchObject({ ok: true });
    expect(parse(revision, reversed)).toMatchObject({ ok: true });
  });
});

describe('malformed results', () => {
  test.each<[string, (output: Record<string, unknown>) => Record<string, unknown>, string]>([
    ['an unknown field', (o) => ({ ...o, approved: true }), 'SCHEMA_INVALID'],
    ['a missing parent hash', ({ parent_hash: _omit, ...rest }) => rest, 'SCHEMA_INVALID'],
    ['no_parent on a revision', (o) => ({ ...o, no_parent: true }), 'SCHEMA_INVALID'],
    ['an empty list of rule changes', (o) => ({ ...o, rule_changes: [] }), 'SCHEMA_INVALID'],
    ['another contract tag', (o) => ({ ...o, schema_version: 'strategy-formulation.result/2' }), 'SCHEMA_INVALID'],
    [
      'a proposal kind that is not the requested kind',
      (o) => ({ ...o, proposal_kind: 'new_family' }),
      'SCHEMA_INVALID',
    ],
  ])('%s', async (_name, change, reason) => {
    expect(malformedOf(parse(revision, change(await revisionOutput()))).reason).toBe(reason);
  });

  test('a well-formed proposal of another kind than the request is a reference error', async () => {
    const family = {
      schema_version: 'strategy-formulation.result/1',
      proposal_kind: 'new_family',
      no_parent: true,
      strategy: proposedForm(seedArtefact(SEED_TWO)),
      source_refs: [],
      rule_changes: [],
      claims,
      unresolved: [],
      method_refs: [],
    };
    expect(malformedOf(parse(revision, family)).reason).toBe('REFERENCE_INVALID');
  });

  test("a parent hash that is not the request's", async () => {
    const result = malformedOf(
      parse(revision, await revisionOutput({ parent_hash: await digest(seedArtefact(SEED_TWO)) })),
    );
    expect(result.reason).toBe('REFERENCE_INVALID');
    expect(result.diagnostic).toMatch(/parent_hash/);
  });

  test('a source reference that the request does not hold, and one that it does', async () => {
    expect(malformedOf(parse(revision, await revisionOutput({ source_refs: ['ev-invented'] }))).reason).toBe(
      'REFERENCE_INVALID',
    );
    expect(parse(revision, await revisionOutput({ source_refs: [] })).ok).toBe(true);
  });

  test('the source of a seed translation is a valid source reference, and an unknown one is not', async () => {
    const output = {
      schema_version: 'strategy-formulation.result/1',
      proposal_kind: 'seed_translation',
      no_parent: true,
      strategy: proposedForm(seedArtefact(SEED_ONE)),
      source_refs: ['src-note-1'],
      rule_changes: [],
      claims,
      unresolved: [],
      source_differences: [{ element: '/definition/execution', source: 'Not stated.', draft: 'Next open.' }],
      method_refs: [],
    };
    expect(parse(seed, output).ok).toBe(true);
    expect(malformedOf(parse(seed, { ...output, source_refs: ['src-other'] })).reason).toBe('REFERENCE_INVALID');
    expect(malformedOf(parse(seed, { ...output, source_differences: undefined })).reason).toBe('SCHEMA_INVALID');
  });

  test('a cited method, because the baseline bundle supplies none', async () => {
    const result = malformedOf(parse(revision, await revisionOutput({ method_refs: ['any-rule'] })));
    expect(result.reason).toBe('REFERENCE_INVALID');
    expect(result.diagnostic).toMatch(/any-rule/);
  });

  test('a method that the request does supply is a valid citation', async () => {
    const supplied = structuredClone(revision);
    supplied.supplied_methods = [
      { id: 'rule-a', rule_origin: 'summary_claim_unverified', category: 'method_advice', scope: 'seed' },
    ];
    expect(parse(supplied, await revisionOutput({ method_refs: ['rule-a'] })).ok).toBe(true);
  });

  test('an unresolved id used twice, and an unresolved element that is not in the strategy', async () => {
    const entry = (id: string, element: string) => ({ id, element, question: 'Open?' });
    expect(
      malformedOf(parse(revision, await revisionOutput({ unresolved: [entry('u', THRESHOLD), entry('u', THRESHOLD)] })))
        .reason,
    ).toBe('REFERENCE_INVALID');
    expect(
      malformedOf(parse(revision, await revisionOutput({ unresolved: [entry('u', '/definition/nope')] }))).reason,
    ).toBe('REFERENCE_INVALID');
    expect(parse(revision, await revisionOutput({ unresolved: [entry('u', '')] })).ok).toBe(true);
  });
});

describe('exact rule changes', () => {
  test.each<[string, Record<string, unknown>]>([
    ['a wrong value', { rule_changes: [{ path: THRESHOLD, from: '30', to: '31' }] }],
    ['a wrong prior value', { rule_changes: [{ path: THRESHOLD, from: '29', to: '32' }] }],
    ['a wrong path', { rule_changes: [{ path: '/definition/indicators/4/expr/params/value', from: '30', to: '32' }] }],
    [
      'an extra change',
      {
        rule_changes: [
          { path: THRESHOLD, from: '30', to: '32' },
          { path: BREAK_EVEN, from: '[]', to: 'break_even' },
        ],
      },
    ],
    [
      'a repeated change',
      {
        rule_changes: [
          { path: THRESHOLD, from: '30', to: '32' },
          { path: THRESHOLD, from: '30', to: '32' },
        ],
      },
    ],
  ])('%s makes the result malformed', async (_name, override) => {
    const result = malformedOf(parse(revision, await revisionOutput(override)));
    expect(result.reason).toBe('RULE_CHANGES_MISMATCH');
    expect(result.diagnostic.length).toBeLessThanOrEqual(2000);
  });

  test('an unlisted edit makes the result malformed, and the diagnostic names it', async () => {
    const result = malformedOf(
      parse(revision, await revisionOutput({ strategy: proposedForm(seedArtefact(SEED_FOUR)) })),
    );
    expect(result.reason).toBe('RULE_CHANGES_MISMATCH');
    expect(result.diagnostic).toContain(BREAK_EVEN);
  });

  test('a strategy equal to the parent has no change to declare', async () => {
    const result = malformedOf(
      parse(revision, await revisionOutput({ strategy: proposedForm(seedArtefact(SEED_ONE)) })),
    );
    expect(result.reason).toBe('RULE_CHANGES_MISMATCH');
  });

  test('a change that is too long to declare cannot be proposed', async () => {
    const strategy = applyEdits(proposedForm(seedArtefact(SEED_ONE)), [
      {
        op: 'add',
        path: '/definition/indicators/-',
        value: {
          name: 'sma200',
          expr: {
            op: 'operator:sma@1',
            args: [{ op: 'operator:bar_field@1', args: [], params: { field: 'CLOSE' } }],
            params: { window: 200 },
          },
        },
      },
    ]);
    const result = malformedOf(
      parse(
        revision,
        await revisionOutput({ strategy, rule_changes: [{ path: '/definition/indicators', from: 'x', to: 'y' }] }),
      ),
    );
    expect(result.reason).toBe('RULE_CHANGES_MISMATCH');
    expect(result.diagnostic).toMatch(/cannot be declared exactly in 256 characters/);
  });
});

describe('blockers on a completion', () => {
  test('an entry and an exit change together are a REVISION_SCOPE blocker, and still a completion', async () => {
    const result = parse(
      revision,
      await revisionOutput({
        strategy: proposedForm(seedArtefact(SEED_FOUR)),
        rule_changes: [
          { path: THRESHOLD, from: '30', to: '32' },
          { path: BREAK_EVEN, from: '[]', to: 'break_even' },
        ],
      }),
    );
    expect(result).toMatchObject({ ok: true, revision: { scope: 'BOTH' } });
    expect(result.ok && result.blockers.map((item) => item.code)).toEqual(['REVISION_SCOPE']);
  });

  test('an exit-only change has no blocker', async () => {
    const result = parse(
      revision,
      await revisionOutput({
        strategy: proposedForm(seedArtefact(SEED_THREE)),
        rule_changes: [{ path: BREAK_EVEN, from: '[]', to: 'break_even' }],
      }),
    );
    expect(result).toMatchObject({ ok: true, blockers: [], revision: { scope: 'EXIT' } });
  });

  test('a change outside the entry and exit rules is a REVISION_SCOPE blocker', async () => {
    const strategy = applyEdits(proposedForm(seedArtefact(SEED_ONE)), [
      { op: 'replace', path: '/definition/selection/slots', value: 4 },
    ]);
    const result = parse(
      revision,
      await revisionOutput({ strategy, rule_changes: [{ path: '/definition/selection/slots', from: '5', to: '4' }] }),
    );
    expect(result).toMatchObject({ ok: true, revision: { scope: 'OUTSIDE' } });
    expect(result.ok && result.blockers).toEqual([
      { code: 'REVISION_SCOPE', detail: 'the revision changes something outside the entry and exit rules' },
    ]);
  });

  test('an operator outside the permitted set is a blocker at its pointer, in a revision and in a seed translation', async () => {
    const edits = [{ op: 'replace' as const, path: '/definition/indicators/0/expr/op', value: 'operator:ema@1' }];
    const strategy = applyEdits(proposedForm(seedArtefact(SEED_ONE)), edits);
    const result = parse(
      revision,
      await revisionOutput({
        strategy,
        rule_changes: [{ path: '/definition/indicators/0/expr/op', from: 'operator:sma@1', to: 'operator:ema@1' }],
      }),
    );
    expect(result.ok && result.blockers).toEqual([
      {
        code: 'OPERATOR_NOT_PERMITTED',
        detail: 'operator:ema@1 is not a permitted operator',
        pointer: '/definition/indicators/0/expr/op',
      },
    ]);
    const translation = {
      schema_version: 'strategy-formulation.result/1',
      proposal_kind: 'seed_translation',
      no_parent: true,
      strategy,
      source_refs: [],
      rule_changes: [],
      claims,
      unresolved: [],
      source_differences: [{ element: '/definition/indicators/0', source: 'An exponential mean.', draft: 'The same.' }],
      method_refs: [],
    };
    const parsed = parse(seed, translation);
    expect(parsed.ok && parsed.blockers.map((item) => item.code)).toEqual(['OPERATOR_NOT_PERMITTED']);
  });

  test('every unresolved entry is a blocker with the pointer of its element', async () => {
    const result = parse(
      revision,
      await revisionOutput({
        unresolved: [
          { id: 'u1', element: THRESHOLD, question: 'First?' },
          { id: 'u2', element: '', question: 'Second?' },
        ],
      }),
    );
    expect(result.ok && result.blockers.map((item) => [item.code, item.pointer])).toEqual([
      ['UNRESOLVED_ASSUMPTION', THRESHOLD],
      ['UNRESOLVED_ASSUMPTION', '/unresolved/1'],
    ]);
  });

  test('a date inside a withheld window is a blocker, and the day before the window is not', async () => {
    const blocked = parse(
      revision,
      await revisionOutput({ claims: { ...claims, rationale: 'Avoids the move of 2024-01-02 and of 2025-12-31.' } }),
    );
    expect(blocked.ok && blocked.blockers.map((item) => item.code)).toEqual(['HOLDOUT_REFERENCE', 'HOLDOUT_REFERENCE']);
    const clear = parse(
      revision,
      await revisionOutput({ claims: { ...claims, rationale: 'Seen until 2024-01-01 and from 2023-03-01.' } }),
    );
    expect(clear.ok && clear.blockers).toEqual([]);
  });

  test('a date in the strategy text is screened like a date in the claims', async () => {
    const strategy = applyEdits(proposedForm(seedArtefact(SEED_TWO)), [
      { op: 'replace', path: '/contract/hypothesis', value: 'Tuned on 2025-06-02.' },
    ]);
    const result = parse(
      revision,
      await revisionOutput({
        strategy,
        rule_changes: [
          {
            path: '/contract/hypothesis',
            from: (seedArtefact(SEED_ONE).contract as { hypothesis: string }).hypothesis,
            to: 'Tuned on 2025-06-02.',
          },
          { path: THRESHOLD, from: '30', to: '32' },
        ],
      }),
    );
    expect(result.ok && result.blockers.map((item) => item.code)).toEqual(['REVISION_SCOPE', 'HOLDOUT_REFERENCE']);
  });
});

describe('the size limit', () => {
  test('a result of exactly 512 KiB parses and one byte more is OUTPUT_LIMIT_EXCEEDED', async () => {
    const text = JSON.stringify(await revisionOutput());
    const padded = (size: number) => text + ' '.repeat(size - new TextEncoder().encode(text).byteLength);
    expect(parseFormulationResult(revision, padded(ROLE_BODY_LIMIT)).ok).toBe(true);
    expect(malformedOf(parseFormulationResult(revision, padded(ROLE_BODY_LIMIT + 1))).reason).toBe(
      'OUTPUT_LIMIT_EXCEEDED',
    );
  });

  test('a document that is not JSON is NOT_JSON', () => {
    expect(malformedOf(parse(revision, 'I propose a change.')).reason).toBe('NOT_JSON');
  });
});

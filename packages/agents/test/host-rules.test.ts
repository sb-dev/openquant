// The checks that a host applies to the artefacts it did not assemble itself (OQ-03 sections 3 and 4): a stored
// request is verified the way assembly would have built it, and the output of an attempt is accepted only when it
// followed the request. The runner calls both; the API can call the same exports.

import { digest } from '@openquant/api-contracts';
import { describe, expect, test } from 'vitest';
import { applyEdits, proposedForm, seedArtefact } from '../dev/world.ts';
import {
  type Assembly,
  assembleCritiqueRequest,
  assembleFormulationRequest,
  BUNDLE_HASH,
  HOST_REFUSED_BLOCKERS,
  PROCEDURES,
  parseFormulationForHost,
  parseFormulationResult,
  type RefusalCode,
  ROLE_BODY_LIMIT,
  type StrategyCritiqueRequest,
  type StrategyFormulationRequest,
  verifyRequest,
} from '../src/index.ts';
import { sha256Text, stable } from './support/oracle.ts';
import {
  BREAK_EVEN,
  claims,
  critiqueRequest,
  critiqueRequestInput,
  revisionInput,
  revisionOutput,
  revisionRequest,
  SEED_FOUR,
  SEED_ONE,
  seedRequest,
  THRESHOLD,
} from './support/requests.ts';

const encoder = new TextEncoder();
const bytesOf = (value: unknown) => encoder.encode(stable(value));

async function codes(assembly: Assembly<unknown>): Promise<RefusalCode[]> {
  return assembly.ok ? [] : assembly.refusals.map((item) => item.code);
}

function changed<T>(request: T, change: (copy: T) => void): T {
  const copy = structuredClone(request);
  change(copy);
  return copy;
}

describe('verifyRequest accepts what assembly built', () => {
  test('a proposer request: the same text, digest, size, instructions and bundle hash', async () => {
    const assembled = await assembleFormulationRequest(await revisionInput());
    if (!assembled.ok) throw new Error('refused');
    const bytes = encoder.encode(assembled.text);
    const verified = await verifyRequest('strategy-formulation.request', bytes);
    expect(verified.ok).toBe(true);
    if (!verified.ok) return;
    expect(verified.text).toBe(assembled.text);
    expect(verified.artefact).toEqual(assembled.artefact);
    expect(verified.artefact.digest).toBe(sha256Text(assembled.text));
    expect(verified.instructions).toBe(PROCEDURES['strategy-formulation']);
    expect(verified.bundle_hash).toBe(BUNDLE_HASH);
    expect(verified.request).toEqual(assembled.request);
  });

  test('a critic request', async () => {
    const assembled = await assembleCritiqueRequest(await critiqueRequestInput());
    if (!assembled.ok) throw new Error('refused');
    const verified = await verifyRequest('strategy-critique.request', encoder.encode(assembled.text));
    expect(verified.ok && verified.artefact).toEqual(assembled.artefact);
    expect(verified.ok && verified.instructions).toBe(PROCEDURES['strategy-critique']);
  });

  test('a seed translation request', async () => {
    const request = await seedRequest();
    expect((await verifyRequest('strategy-formulation.request', bytesOf(request))).ok).toBe(true);
  });
});

describe('verifyRequest refuses a stored request that assembly would not have produced', () => {
  test('bytes that are not JSON, and JSON that is not a request', async () => {
    const notJson = await verifyRequest('strategy-formulation.request', encoder.encode('not json'));
    expect(await codes(notJson)).toEqual(['REQUEST_INVALID']);
    const request = await revisionRequest();
    const unknownField = changed(request, (copy) => {
      (copy as unknown as Record<string, unknown>).extra = 1;
    });
    expect(await codes(await verifyRequest('strategy-formulation.request', bytesOf(unknownField)))).toEqual([
      'REQUEST_INVALID',
    ]);
  });

  test('a request of the other role', async () => {
    const critic = await critiqueRequest();
    expect(await codes(await verifyRequest('strategy-formulation.request', bytesOf(critic)))).toEqual([
      'REQUEST_INVALID',
    ]);
  });

  test('a request above the limit is refused as too large before it is parsed', async () => {
    const big = new Uint8Array(ROLE_BODY_LIMIT + 1).fill(0x20);
    expect(await codes(await verifyRequest('strategy-critique.request', big))).toEqual(['REQUEST_TOO_LARGE']);
  });

  test('pretty-printed text is the same document and not the canonical text of assembly', async () => {
    const request = await revisionRequest();
    const pretty = encoder.encode(JSON.stringify(request, null, 2));
    expect(await codes(await verifyRequest('strategy-formulation.request', pretty))).toEqual(['REQUEST_NOT_CANONICAL']);
    // The same members in another order are not canonical either.
    const reordered = encoder.encode(JSON.stringify(Object.fromEntries(Object.entries(request).reverse())));
    expect(await codes(await verifyRequest('strategy-formulation.request', reordered))).toEqual([
      'REQUEST_NOT_CANONICAL',
    ]);
  });

  test('a method that the bundle does not supply', async () => {
    const request = changed(await revisionRequest(), (copy) => {
      copy.supplied_methods.push({
        id: 'm-1',
        rule_origin: 'primary_checked',
        category: 'method_advice',
        scope: 'seed',
      } as never);
    });
    expect(await codes(await verifyRequest('strategy-formulation.request', bytesOf(request)))).toEqual([
      'METHODS_MISMATCH',
    ]);
  });

  test('exclusions that do not name V and H, or repeat another label than the policy', async () => {
    const withoutValidation = changed(await revisionRequest(), (copy) => {
      copy.context.holdout_exclusions = copy.context.holdout_exclusions.filter((item) => item.window !== 'VALIDATION');
    });
    expect(await codes(await verifyRequest('strategy-formulation.request', bytesOf(withoutValidation)))).toEqual([
      'HOLDOUT_EXCLUSIONS_INVALID',
    ]);
    const relabelled = changed(await critiqueRequest(), (copy) => {
      const holdout = copy.context.holdout_exclusions.find((item) => item.window === 'HOLDOUT');
      if (holdout) holdout.label = 'untouched holdout';
    });
    expect(await codes(await verifyRequest('strategy-critique.request', bytesOf(relabelled)))).toEqual([
      'HOLDOUT_EXCLUSIONS_INVALID',
    ]);
  });

  test('operators that are not the operators of the frozen policy', async () => {
    const request = changed(await revisionRequest(), (copy) => {
      copy.context.operators.permitted.pop();
    });
    expect(await codes(await verifyRequest('strategy-formulation.request', bytesOf(request)))).toEqual([
      'OPERATORS_MISMATCH',
    ]);
  });

  test('evidence with a duplicate id, and evidence that names a date inside a withheld window', async () => {
    const duplicate = changed(await revisionRequest(), (copy) => {
      copy.evidence_refs.push(structuredClone(copy.evidence_refs[0] as never));
    });
    expect(await codes(await verifyRequest('strategy-formulation.request', bytesOf(duplicate)))).toEqual([
      'DUPLICATE_EVIDENCE_ID',
    ]);
    const leaking = changed(await critiqueRequest(), (copy) => {
      (copy.evidence_refs[0] as { content: string }).content = 'Seen again on 2025-03-14.';
    });
    expect(await codes(await verifyRequest('strategy-critique.request', bytesOf(leaking)))).toEqual([
      'HOLDOUT_OVERLAP',
    ]);
  });

  test('a parent hash that is not the digest of the parent, and a subject hash that is not the digest of the strategy', async () => {
    const parent = changed(await revisionRequest(), (copy) => {
      if (copy.subject.proposal_kind === 'controlled_revision') copy.subject.parent_hash = `sha256:${'0'.repeat(64)}`;
    });
    expect(await codes(await verifyRequest('strategy-formulation.request', bytesOf(parent)))).toEqual([
      'PARENT_HASH_MISMATCH',
    ]);
    const subject = changed(await critiqueRequest(), (copy) => {
      copy.subject.strategy_hash = `sha256:${'f'.repeat(64)}`;
    });
    expect(await codes(await verifyRequest('strategy-critique.request', bytesOf(subject)))).toEqual([
      'STRATEGY_HASH_MISMATCH',
    ]);
  });

  test('a critic request that carries run metrics', async () => {
    const request: StrategyCritiqueRequest = changed(await critiqueRequest(), (copy) => {
      (copy.evidence_refs[0] as { kind: string }).kind = 'evaluation_metrics';
    });
    expect(await codes(await verifyRequest('strategy-critique.request', bytesOf(request)))).toEqual([
      'EVIDENCE_NOT_PERMITTED',
    ]);
  });

  test('reports every refusal at once, not only the first', async () => {
    const request = changed(await revisionRequest(), (copy) => {
      copy.context.holdout_exclusions = [];
      copy.context.operators.permitted.pop();
    });
    const refusals = await codes(await verifyRequest('strategy-formulation.request', bytesOf(request)));
    expect(new Set(refusals)).toEqual(new Set(['HOLDOUT_EXCLUSIONS_INVALID', 'OPERATORS_MISMATCH']));
  });
});

describe('parseFormulationForHost', () => {
  const edits = [{ op: 'replace' as const, path: '/definition/indicators/0/expr/op', value: 'operator:ema@1' }];

  test('names the two blockers that make a completion a failed attempt, and no other', () => {
    expect([...HOST_REFUSED_BLOCKERS].sort()).toEqual(['HOLDOUT_REFERENCE', 'OPERATOR_NOT_PERMITTED']);
  });

  test('accepts a valid revision exactly as the parse module does', async () => {
    const request = (await revisionRequest()) as StrategyFormulationRequest;
    const output = JSON.stringify(await revisionOutput());
    expect(parseFormulationForHost(request, output)).toEqual(parseFormulationResult(request, output));
    expect(parseFormulationForHost(request, output)).toMatchObject({ ok: true, blockers: [] });
  });

  test('an operator outside the permitted set is a malformed result with REFERENCE_INVALID and the pointer', async () => {
    const request = await revisionRequest();
    const output = JSON.stringify(
      await revisionOutput({
        strategy: applyEdits(proposedForm(seedArtefact(SEED_ONE)), edits),
        rule_changes: [{ path: '/definition/indicators/0/expr/op', from: 'operator:sma@1', to: 'operator:ema@1' }],
      }),
    );
    // The parse module reports it as a blocker of a completion.
    expect(parseFormulationResult(request, output)).toMatchObject({ ok: true });
    const result = parseFormulationForHost(request, output);
    expect(result).toMatchObject({ ok: false, reason: 'REFERENCE_INVALID' });
    expect(!result.ok && result.diagnostic).toBe(
      '1 refused blocker(s): OPERATOR_NOT_PERMITTED at /definition/indicators/0/expr/op: operator:ema@1 is not a permitted operator',
    );
  });

  test('a date inside the validation or holdout window is a malformed result, and the day before is not', async () => {
    const request = await revisionRequest();
    const leaking = JSON.stringify(
      await revisionOutput({ claims: { ...claims, rationale: 'Avoids 2024-01-02 and 2025-12-31.' } }),
    );
    const result = parseFormulationForHost(request, leaking);
    expect(result).toMatchObject({ ok: false, reason: 'REFERENCE_INVALID' });
    expect(!result.ok && result.diagnostic).toMatch(/^2 refused blocker\(s\): HOLDOUT_REFERENCE/);
    expect(!result.ok && result.diagnostic).toContain('2024-01-02');
    const clear = JSON.stringify(await revisionOutput({ claims: { ...claims, rationale: 'Seen until 2024-01-01.' } }));
    expect(parseFormulationForHost(request, clear).ok).toBe(true);
  });

  test('lists at most three refused blockers and counts all of them', async () => {
    const request = await revisionRequest();
    const dates = ['2024-02-01', '2024-03-01', '2024-04-01', '2024-05-01'];
    const result = parseFormulationForHost(
      request,
      JSON.stringify(await revisionOutput({ claims: { ...claims, rationale: dates.join(' ') } })),
    );
    expect(!result.ok && result.diagnostic.startsWith('4 refused blocker(s):')).toBe(true);
    expect(!result.ok && (result.diagnostic.match(/HOLDOUT_REFERENCE/g) ?? []).length).toBe(3);
  });

  test('a revision of both rules and an unresolved entry stay notices on a completion', async () => {
    const request = await revisionRequest();
    const both = JSON.stringify(
      await revisionOutput({
        strategy: proposedForm(seedArtefact(SEED_FOUR)),
        rule_changes: [
          { path: THRESHOLD, from: '30', to: '32' },
          { path: BREAK_EVEN, from: '[]', to: 'break_even' },
        ],
        unresolved: [{ id: 'u1', element: THRESHOLD, question: 'Which close?' }],
      }),
    );
    const result = parseFormulationForHost(request, both);
    expect(result.ok && result.blockers.map((item) => item.code).sort()).toEqual([
      'REVISION_SCOPE',
      'UNRESOLVED_ASSUMPTION',
    ]);
  });

  test('keeps the malformed reasons of the parse module: a rule change that is not the difference', async () => {
    const request = await revisionRequest();
    const output = JSON.stringify(await revisionOutput({ rule_changes: [{ path: THRESHOLD, from: '30', to: '31' }] }));
    expect(parseFormulationForHost(request, output)).toMatchObject({ ok: false, reason: 'RULE_CHANGES_MISMATCH' });
  });

  test('digest of the request parent is the digest that the oracle computes', async () => {
    // A guard for the helper: the revision output binds the parent the request holds.
    const request = await revisionRequest();
    expect(request.subject.proposal_kind === 'controlled_revision' && request.subject.parent_hash).toBe(
      await digest(seedArtefact(SEED_ONE)),
    );
  });
});

// Request assembly (OQ-03 sections 3 and 4): what a request carries, how it is bound, and every refusal.

import { digest, type JsonValue } from '@openquant/api-contracts';
import { describe, expect, test } from 'vitest';
import { seedArtefact } from '../dev/world.ts';
import {
  type Assembly,
  assembleCritiqueRequest,
  assembleFormulationRequest,
  BUNDLE_HASH,
  PROCEDURES,
  type RefusalCode,
  ROLE_BODY_LIMIT,
} from '../src/index.ts';
import type { EvidenceItem, HoldoutExclusion, RoleContext } from '../src/types.ts';
import { sha256Text, stable } from './support/oracle.ts';
import { critiqueRequestInput, FINDING, revisionInput, SEED_ONE } from './support/requests.ts';

const encoder = new TextEncoder();

async function codes(assembly: Assembly<unknown>): Promise<RefusalCode[]> {
  return assembly.ok ? [] : assembly.refusals.map((item) => item.code);
}

function withContext(context: RoleContext, change: (copy: RoleContext) => void): RoleContext {
  const copy = structuredClone(context);
  change(copy);
  return copy;
}

// A V or H exclusion that leaves sessions of its policy window out, and a date in the part that it leaves out. The
// policy windows are 2024-01-01 to 2024-12-31 (V) and 2025-01-01 to 2025-12-31 (H); the full exclusions start at the
// first sessions 2024-01-02 and 2025-01-02.
const NARROWED: readonly (readonly ['VALIDATION' | 'HOLDOUT', string, string, string])[] = [
  ['VALIDATION', '2024-07-01', '2024-12-31', '2024-03-15'],
  ['VALIDATION', '2024-01-02', '2024-12-27', '2024-12-30'],
  ['HOLDOUT', '2025-12-31', '2025-12-31', '2025-01-02'],
  ['HOLDOUT', '2025-01-03', '2025-12-31', '2025-01-02'],
];

/** An exclusion narrowed consistently: its range and its sessions both leave out what lies outside start..end. */
function narrowed(context: RoleContext, window: string, start: string, end: string): RoleContext {
  return withContext(context, (copy) => {
    const exclusion = copy.holdout_exclusions.find((item) => item.window === window);
    if (!exclusion) throw new Error(`the request names no ${window} exclusion`);
    exclusion.range = { start, end };
    exclusion.sessions = (exclusion.sessions ?? []).filter((session) => session >= start && session <= end);
  });
}

const evidenceDated = (date: string): EvidenceItem[] => [
  {
    ...FINDING,
    record_digest: `sha256:${'c'.repeat(64)}`,
    recorded_at: '2023-12-29T22:00:00Z',
    content: `Seen on ${date}.`,
  },
];

describe('a proposer request for a controlled revision', () => {
  test('is bound by the digest of its canonical text, its size and its media type', async () => {
    const assembly = await assembleFormulationRequest(await revisionInput());
    expect(assembly.ok).toBe(true);
    if (!assembly.ok) return;
    const text = stable(assembly.request);
    expect(assembly.text).toBe(text);
    expect(assembly.artefact).toEqual({
      digest: sha256Text(text),
      media_type: 'application/json',
      size_bytes: encoder.encode(text).byteLength,
    });
    expect(assembly.request.schema_version).toBe('strategy-formulation.request/1');
  });

  test('takes its instructions and its bundle hash from the generated module', async () => {
    const assembly = await assembleFormulationRequest(await revisionInput());
    expect(assembly.ok && assembly.instructions).toBe(PROCEDURES['strategy-formulation']);
    expect(assembly.ok && assembly.bundle_hash).toBe(BUNDLE_HASH);
  });

  test('carries the parent, its hash, the development evidence and the withheld windows, and nothing else', async () => {
    const assembly = await assembleFormulationRequest(await revisionInput());
    if (!assembly.ok) throw new Error('refused');
    const { request } = assembly;
    expect(Object.keys(request).sort()).toEqual([
      'context',
      'evidence_refs',
      'schema_version',
      'subject',
      'supplied_methods',
    ]);
    expect(request.subject.proposal_kind).toBe('controlled_revision');
    if (request.subject.proposal_kind !== 'controlled_revision') return;
    expect(request.subject.parent_hash).toBe(await digest(seedArtefact(SEED_ONE)));
    expect(request.evidence_refs.map((item) => item.id)).toEqual([FINDING.id]);
    expect(request.context.holdout_exclusions.map((item) => item.window)).toEqual(['VALIDATION', 'HOLDOUT']);
    expect(Object.keys(request.context).sort()).toEqual([
      'cutoff',
      'evaluation_policy',
      'holdout_exclusions',
      'operators',
      'provider_capabilities',
      'scope',
    ]);
  });

  test('supplies no method: the module decides, and a caller cannot add one', async () => {
    const input = {
      ...(await revisionInput()),
      supplied_methods: [{ id: 'm', rule_origin: 'primary_checked', category: 'method_advice', scope: 'seed' }],
    };
    const assembly = await assembleFormulationRequest(input);
    expect(assembly.ok && assembly.request.supplied_methods).toEqual([]);
  });

  test('is the same bytes each time', async () => {
    const first = await assembleFormulationRequest(await revisionInput());
    const second = await assembleFormulationRequest(await revisionInput());
    expect(first.ok && second.ok && first.artefact.digest === second.artefact.digest).toBe(true);
  });
});

describe('a proposer request for a seed translation and a new family', () => {
  test('a seed translation carries its source text', async () => {
    const input = await revisionInput({
      subject: {
        proposal_kind: 'seed_translation',
        source: {
          source_id: 'src-1',
          content_digest: `sha256:${'a'.repeat(64)}`,
          media_type: 'text/plain',
          lines: ['Buy weakness.'],
        },
      },
      evidence: [],
    });
    const assembly = await assembleFormulationRequest(input);
    expect(assembly.ok && assembly.request.subject.proposal_kind).toBe('seed_translation');
  });

  test('a new family carries no parent', async () => {
    const assembly = await assembleFormulationRequest(
      await revisionInput({ subject: { proposal_kind: 'new_family' } }),
    );
    expect(assembly.ok && assembly.request.subject).toEqual({ proposal_kind: 'new_family' });
  });

  test('a source above the request limit is refused as too large', async () => {
    const lines = Array.from({ length: 3000 }, (_, index) => `${index} ${'x'.repeat(190)}`);
    const input = await revisionInput({
      subject: {
        proposal_kind: 'seed_translation',
        source: { source_id: 'src-big', content_digest: `sha256:${'b'.repeat(64)}`, media_type: 'text/plain', lines },
      },
      evidence: [],
    });
    expect(encoder.encode(JSON.stringify(input)).byteLength).toBeGreaterThan(ROLE_BODY_LIMIT);
    expect(await codes(await assembleFormulationRequest(input))).toEqual(['REQUEST_TOO_LARGE']);
  });
});

describe('refusals of a proposer request', () => {
  test('a request that breaks its schema is refused with the first violation', async () => {
    const input = await revisionInput();
    const broken = {
      ...input,
      evidence: [{ ...(input.evidence[0] as EvidenceItem), kind: 'rumour' }],
    } as unknown as typeof input;
    const assembly = await assembleFormulationRequest(broken);
    expect(await codes(assembly)).toEqual(['REQUEST_INVALID']);
    expect(!assembly.ok && assembly.refusals[0]?.detail).toMatch(/evidence_refs\/0\/kind/);
  });

  test('a value with no JSON form is refused as invalid', async () => {
    const input = await revisionInput();
    const broken = {
      ...input,
      evidence: [{ ...(input.evidence[0] as EvidenceItem), content: Number.NaN }],
    } as unknown as typeof input;
    expect(await codes(await assembleFormulationRequest(broken))).toEqual(['REQUEST_INVALID']);
  });

  test('exclusions that omit the validation window are refused', async () => {
    const input = await revisionInput();
    const context = withContext(input.context, (copy) => {
      copy.holdout_exclusions = copy.holdout_exclusions.filter((item) => item.window !== 'VALIDATION');
    });
    const assembly = await assembleFormulationRequest({ ...input, context });
    expect(await codes(assembly)).toEqual(['HOLDOUT_EXCLUSIONS_INVALID']);
    expect(!assembly.ok && assembly.refusals[0]?.detail).toMatch(/VALIDATION/);
  });

  test('exclusions that omit the holdout window are refused', async () => {
    const input = await revisionInput();
    const context = withContext(input.context, (copy) => {
      copy.holdout_exclusions = copy.holdout_exclusions.filter((item) => item.window !== 'HOLDOUT');
    });
    expect(await codes(await assembleFormulationRequest({ ...input, context }))).toEqual([
      'HOLDOUT_EXCLUSIONS_INVALID',
    ]);
  });

  test('no exclusions at all are refused for both windows', async () => {
    const input = await revisionInput();
    const context = withContext(input.context, (copy) => {
      copy.holdout_exclusions = [];
    });
    const assembly = await assembleFormulationRequest({ ...input, context });
    expect(!assembly.ok && assembly.refusals.map((item) => item.detail).join(' ')).toMatch(/VALIDATION.*HOLDOUT/);
  });

  test('a window named twice is refused', async () => {
    const input = await revisionInput();
    const context = withContext(input.context, (copy) => {
      copy.holdout_exclusions = [
        ...copy.holdout_exclusions,
        structuredClone(copy.holdout_exclusions[0] as HoldoutExclusion),
      ];
    });
    expect(await codes(await assembleFormulationRequest({ ...input, context }))).toEqual([
      'HOLDOUT_EXCLUSIONS_INVALID',
    ]);
  });

  test('an exclusion with another label than the policy window, or outside its dates, is refused', async () => {
    const input = await revisionInput();
    const relabelled = withContext(input.context, (copy) => {
      (copy.holdout_exclusions[1] as HoldoutExclusion).label = 'untouched holdout';
    });
    expect(await codes(await assembleFormulationRequest({ ...input, context: relabelled }))).toEqual([
      'HOLDOUT_EXCLUSIONS_INVALID',
    ]);
    const moved = withContext(input.context, (copy) => {
      const holdout = copy.holdout_exclusions[1] as HoldoutExclusion;
      holdout.range = { start: '2024-06-03', end: '2025-12-31' };
      holdout.sessions = ['2024-06-03', ...(holdout.sessions ?? [])];
    });
    expect(await codes(await assembleFormulationRequest({ ...input, context: moved }))).toEqual([
      'HOLDOUT_EXCLUSIONS_INVALID',
    ]);
  });

  test.each(NARROWED)(
    'a %s exclusion whose range is narrowed to %s..%s is refused, and evidence dated %s in the omitted part too',
    async (window, start, end, date) => {
      const input = await revisionInput({ evidence: evidenceDated(date) });
      const context = withContext(input.context, (copy) => {
        const exclusion = copy.holdout_exclusions.find((item) => item.window === window) as HoldoutExclusion;
        exclusion.range = { start, end };
      });
      const assembly = await assembleFormulationRequest({ ...input, context });
      expect(await codes(assembly)).toEqual(['HOLDOUT_EXCLUSIONS_INVALID', 'HOLDOUT_OVERLAP']);
      expect(!assembly.ok && assembly.refusals[0]?.detail).toBe(
        `the ${window} exclusion range is not the first and the last of its sessions`,
      );
    },
  );

  test.each(NARROWED)(
    'a %s exclusion whose sessions are narrowed to %s..%s still withholds evidence dated %s in the policy window',
    async (window, start, end, date) => {
      const input = await revisionInput({ evidence: evidenceDated(date) });
      const context = narrowed(input.context, window, start, end);
      expect(await codes(await assembleFormulationRequest({ ...input, context }))).toEqual(['HOLDOUT_OVERLAP']);
    },
  );

  test('an exclusion is compared with its resolved sessions exactly: no weekday is guessed to be a holiday', async () => {
    // The exchange closed on two weekdays at the start of V (2024-01-01 and 2024-01-02, say): its first resolved
    // session is 2024-01-03. A weekday rule would refuse the gap of two weekdays; the sessions of the plan decide.
    const input = await revisionInput();
    const context = narrowed(input.context, 'VALIDATION', '2024-01-03', '2024-12-31');
    expect(await codes(await assembleFormulationRequest({ ...input, context }))).toEqual([]);
  });

  test('a V or H exclusion without its sessions, or with sessions out of order, is refused', async () => {
    const input = await revisionInput();
    const bare = withContext(input.context, (copy) => {
      delete (copy.holdout_exclusions[0] as HoldoutExclusion).sessions;
    });
    const missing = await assembleFormulationRequest({ ...input, context: bare });
    expect(await codes(missing)).toEqual(['HOLDOUT_EXCLUSIONS_INVALID']);
    expect(!missing.ok && missing.refusals[0]?.detail).toBe(
      'the VALIDATION exclusion does not carry the resolved sessions of its window',
    );
    const shuffled = withContext(input.context, (copy) => {
      const sessions = (copy.holdout_exclusions[1] as HoldoutExclusion).sessions as string[];
      [sessions[1], sessions[2]] = [sessions[2] as string, sessions[1] as string];
    });
    const unordered = await assembleFormulationRequest({ ...input, context: shuffled });
    expect(!unordered.ok && unordered.refusals.map((item) => item.detail)).toEqual([
      'the sessions of the HOLDOUT exclusion are not in strictly increasing order',
    ]);
  });

  test('operators that are not the policy operators are refused', async () => {
    const input = await revisionInput();
    const context = withContext(input.context, (copy) => {
      copy.operators = { ...copy.operators, permitted: copy.operators.permitted.slice(0, 5) };
    });
    expect(await codes(await assembleFormulationRequest({ ...input, context }))).toEqual(['OPERATORS_MISMATCH']);
  });

  test('a parent hash that is not the digest of the parent is refused', async () => {
    const input = await revisionInput();
    const subject = { ...input.subject, parent_hash: `sha256:${'0'.repeat(64)}` } as typeof input.subject;
    expect(await codes(await assembleFormulationRequest({ ...input, subject }))).toEqual(['PARENT_HASH_MISMATCH']);
  });

  test('an evidence id used twice is refused', async () => {
    const input = await revisionInput();
    const evidence = [...input.evidence, { ...(input.evidence[0] as EvidenceItem), content: 'Another record.' }];
    expect(await codes(await assembleFormulationRequest({ ...input, evidence }))).toEqual(['DUPLICATE_EVIDENCE_ID']);
  });
});

describe('the date screen of the withheld windows', () => {
  const evidenceWith = (content: string): EvidenceItem[] => [
    { ...FINDING, record_digest: `sha256:${'c'.repeat(64)}`, recorded_at: '2023-12-29T22:00:00Z', content },
  ];

  test.each([
    ['the first session of the validation window', '2024-01-02', true],
    ['the last session of the holdout window', '2025-12-31', true],
    ['a date inside the validation window', '2024-07-04', true],
    ['an exchange holiday at the start of the validation policy window', '2024-01-01', true],
    ['the day before the validation policy window starts', '2023-12-31', false],
    ['the last session of the development window', '2023-12-29', false],
    ['a date after the holdout window', '2026-01-02', false],
    ['an ISO timestamp inside the validation window', '2024-06-03T20:00:00Z', true],
    ['an ISO timestamp with an offset', '2024-06-03T00:00:00+00:00', true],
    ['a date joined by an underscore', 'file_2024-06-03.csv', true],
    ['a date with a Z suffix', '2024-06-03Z', true],
    ['a date with slashes', '2024/06/03', true],
    ['a compact date', '20240603', true],
    ['a compact timestamp', '20240603T200000Z', true],
    ['a timestamp the day before the validation policy window', '2023-12-31T23:59:59Z', false],
    ['an eight-digit number that is no calendar date', '20241399', false],
  ])('%s', async (_name, date, refused) => {
    const input = await revisionInput({ evidence: evidenceWith(`The member closed lower on ${date}.`) });
    expect(await codes(await assembleFormulationRequest(input))).toEqual(refused ? ['HOLDOUT_OVERLAP'] : []);
  });

  test('an exclusion that omits one weekday at the window edge still withholds that date', async () => {
    const input = await revisionInput({ evidence: evidenceWith('Observed held-out result on 2025-12-31.') });
    const context = narrowed(input.context, 'HOLDOUT', '2025-01-02', '2025-12-30');
    expect(await codes(await assembleFormulationRequest({ ...input, context }))).toEqual(['HOLDOUT_OVERLAP']);
  });

  test('a date in the record text is found wherever it stands, and one record is refused once per date', async () => {
    const input = await revisionInput({
      evidence: evidenceWith('From 2024-03-01, then again 2025-03-14, and 2024-03-01.'),
    });
    const assembly = await assembleFormulationRequest(input);
    expect(await codes(assembly)).toEqual(['HOLDOUT_OVERLAP']);
    expect(!assembly.ok && assembly.refusals[0]?.detail).toMatch(/2024-03-01, 2025-03-14/);
  });
});

describe('a critic request', () => {
  test('carries one registered version bound by the digest of its artefact', async () => {
    const input = await critiqueRequestInput();
    const assembly = await assembleCritiqueRequest(input);
    expect(assembly.ok).toBe(true);
    if (!assembly.ok) return;
    expect(assembly.request.schema_version).toBe('strategy-critique.request/1');
    expect(assembly.request.subject.strategy_hash).toBe(
      sha256Text(stable(assembly.request.subject.strategy as unknown as JsonValue)),
    );
    expect(assembly.artefact.digest).toBe(sha256Text(assembly.text));
    expect(assembly.instructions).toBe(PROCEDURES['strategy-critique']);
    expect(assembly.request.context.holdout_exclusions.map((item) => item.window)).toEqual(['VALIDATION', 'HOLDOUT']);
  });

  test('a hash that is not the digest of the registered artefact is refused', async () => {
    const input = await critiqueRequestInput();
    const subject = { ...input.subject, strategy_hash: `sha256:${'0'.repeat(64)}` };
    expect(await codes(await assembleCritiqueRequest({ ...input, subject }))).toEqual(['STRATEGY_HASH_MISMATCH']);
  });

  test('the hash of an edited artefact no longer binds', async () => {
    const input = await critiqueRequestInput();
    const strategy = { ...input.subject.strategy, version: input.subject.strategy.version + 1 };
    expect(await codes(await assembleCritiqueRequest({ ...input, subject: { ...input.subject, strategy } }))).toEqual([
      'STRATEGY_HASH_MISMATCH',
    ]);
  });

  test('run metrics as evidence are refused: critique precedes evaluation', async () => {
    const input = await critiqueRequestInput();
    const evidence = [{ ...(input.evidence[0] as EvidenceItem), kind: 'evaluation_metrics' as const }];
    const assembly = await assembleCritiqueRequest({ ...input, evidence });
    expect(await codes(assembly)).toEqual(['EVIDENCE_NOT_PERMITTED']);
  });

  test('exclusions and dates are screened as for the proposer', async () => {
    const input = await critiqueRequestInput();
    const context = withContext(input.context, (copy) => {
      copy.holdout_exclusions = [];
    });
    expect(await codes(await assembleCritiqueRequest({ ...input, context }))).toEqual([
      'HOLDOUT_EXCLUSIONS_INVALID',
      'HOLDOUT_EXCLUSIONS_INVALID',
    ]);
    const evidence = [{ ...(input.evidence[0] as EvidenceItem), content: 'Seen on 2025-06-02.' }];
    expect(await codes(await assembleCritiqueRequest({ ...input, evidence }))).toEqual(['HOLDOUT_OVERLAP']);
  });

  test.each(NARROWED)(
    'a %s exclusion narrowed to %s..%s still withholds evidence dated %s in the omitted part',
    async (window, start, end, date) => {
      const input = await critiqueRequestInput();
      const evidence = [{ ...(input.evidence[0] as EvidenceItem), content: `Seen on ${date}.` }];
      const context = narrowed(input.context, window, start, end);
      expect(await codes(await assembleCritiqueRequest({ ...input, context, evidence }))).toEqual(['HOLDOUT_OVERLAP']);
    },
  );

  test('an exclusion that omits one weekday at the window edge still withholds that date', async () => {
    const input = await critiqueRequestInput();
    const evidence = [{ ...(input.evidence[0] as EvidenceItem), content: 'Observed held-out result on 2025-12-31.' }];
    const context = narrowed(input.context, 'HOLDOUT', '2025-01-02', '2025-12-30');
    expect(await codes(await assembleCritiqueRequest({ ...input, context, evidence }))).toEqual(['HOLDOUT_OVERLAP']);
  });

  test('supplies no method', async () => {
    const assembly = await assembleCritiqueRequest(await critiqueRequestInput());
    expect(assembly.ok && assembly.request.supplied_methods).toEqual([]);
  });
});

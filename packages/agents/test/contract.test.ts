// The role contract adapter: byte limit, strict JSON, version tag and schema, with one bounded diagnostic.

import { workerBodyLimit } from '@openquant/api-contracts';
import { describe, expect, test } from 'vitest';
import { DIAGNOSTIC_LIMIT, parseRole, ROLE_BODY_LIMIT } from '../src/index.ts';
import { critiqueOutput, finding, revisionOutput } from './support/requests.ts';

const critiqueText = (...findings: Record<string, unknown>[]) => JSON.stringify(critiqueOutput(...findings));

describe('the limit', () => {
  test('is the Worker limit of a strategy artefact, 512 KiB', () => {
    expect(ROLE_BODY_LIMIT).toBe(workerBodyLimit('strategy-artefact'));
    expect(ROLE_BODY_LIMIT).toBe(524_288);
  });

  test('a document of exactly the limit parses and one byte more is refused before it is read', () => {
    const base = critiqueText();
    const atLimit = base + ' '.repeat(ROLE_BODY_LIMIT - base.length);
    expect(parseRole('strategy-critique.result', atLimit).ok).toBe(true);
    const over = parseRole('strategy-critique.result', `${atLimit} `);
    expect(over).toMatchObject({ ok: false, reason: 'OUTPUT_LIMIT_EXCEEDED' });
  });

  test('the limit counts bytes, not characters', () => {
    const base = critiqueText();
    // 'é' is two bytes: the padded document is below the limit in characters and above it in bytes.
    const padded = `${base}${'é'.repeat(Math.floor((ROLE_BODY_LIMIT - base.length) / 2) + 1)}`;
    expect(padded.length).toBeLessThanOrEqual(ROLE_BODY_LIMIT);
    expect(parseRole('strategy-critique.result', padded)).toMatchObject({ ok: false, reason: 'OUTPUT_LIMIT_EXCEEDED' });
  });

  test('a lower limit can be passed for a request', () => {
    expect(parseRole('strategy-critique.result', critiqueText(), 10)).toMatchObject({
      ok: false,
      reason: 'OUTPUT_LIMIT_EXCEEDED',
    });
  });
});

describe('text that is not JSON, or JSON that the strict rules refuse', () => {
  test('prose', () => {
    expect(parseRole('strategy-critique.result', 'No findings.')).toMatchObject({ ok: false, reason: 'NOT_JSON' });
  });

  test('bytes that are not UTF-8', () => {
    expect(parseRole('strategy-critique.result', new Uint8Array([0x7b, 0xff, 0x7d]))).toMatchObject({
      ok: false,
      reason: 'NOT_JSON',
    });
  });

  test('a truncated document', () => {
    expect(parseRole('strategy-critique.result', critiqueText().slice(0, 20))).toMatchObject({
      ok: false,
      reason: 'NOT_JSON',
    });
  });

  test.each([
    [
      'a duplicate key',
      '{"schema_version":"strategy-critique.result/1","schema_version":"strategy-critique.result/1","findings":[]}',
    ],
    ['a fraction', '{"schema_version":"strategy-critique.result/1","findings":[],"x":1.5}'],
    ['an exponent', '{"schema_version":"strategy-critique.result/1","findings":[],"x":1e3}'],
    ['an integer beyond 2^53', '{"schema_version":"strategy-critique.result/1","findings":[],"x":9007199254740993}'],
  ])('%s is a schema violation, not a value to repair', (_name, text) => {
    expect(parseRole('strategy-critique.result', text)).toMatchObject({ ok: false, reason: 'SCHEMA_INVALID' });
  });

  test('nesting of 130 levels is refused by the JSON reader', () => {
    const text = `{"schema_version":"strategy-critique.result/1","findings":[],"x":${'['.repeat(130)}${']'.repeat(130)}}`;
    expect(parseRole('strategy-critique.result', text)).toMatchObject({ ok: false, reason: 'NOT_JSON' });
  });
});

describe('the version tag', () => {
  test.each([
    ['missing', '{"findings":[]}'],
    ['not a string', '{"schema_version":1,"findings":[]}'],
    ['another version', '{"schema_version":"strategy-critique.result/2","findings":[]}'],
    ['the tag of another contract', '{"schema_version":"strategy-formulation.result/1","findings":[]}'],
  ])('%s', (_name, text) => {
    expect(parseRole('strategy-critique.result', text)).toMatchObject({ ok: false, reason: 'SCHEMA_INVALID' });
  });
});

describe('the schema', () => {
  test('a valid critic result parses to the document', () => {
    const output = critiqueOutput(finding());
    const parsed = parseRole('strategy-critique.result', JSON.stringify(output));
    expect(parsed).toEqual({ ok: true, value: output });
  });

  test('an unknown field, a missing field and a wrong type are each refused', () => {
    for (const bad of [
      { ...finding(), approved: true },
      { ...finding(), location: undefined },
      { ...finding(), description: 7 },
      { ...finding(), category: 'lookahead_bias' },
    ]) {
      expect(parseRole('strategy-critique.result', critiqueText(bad)), JSON.stringify(bad)).toMatchObject({
        ok: false,
        reason: 'SCHEMA_INVALID',
      });
    }
  });

  test('64 findings parse and 65 do not', () => {
    expect(parseRole('strategy-critique.result', critiqueText(...Array.from({ length: 64 }, () => finding()))).ok).toBe(
      true,
    );
    expect(
      parseRole('strategy-critique.result', critiqueText(...Array.from({ length: 65 }, () => finding()))),
    ).toMatchObject({ ok: false, reason: 'SCHEMA_INVALID' });
  });

  test('a diagnostic names the unknown field, with printable text only and within the bound', () => {
    const parsed = parseRole(
      'strategy-critique.result',
      critiqueText({ ...finding(), [`x\u0007${'y'.repeat(5000)}`]: 1 }),
    );
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.diagnostic.length).toBeLessThanOrEqual(DIAGNOSTIC_LIMIT);
    expect(parsed.diagnostic).toMatch(/must NOT have additional properties/);
    expect(parsed.diagnostic).toMatch(/^[\x20-\x7e]*$/);
  });

  test('the diagnostic of a proposal points into the branch that the proposal kind chose', async () => {
    const parsed = parseRole('strategy-formulation.result', JSON.stringify(await revisionOutput({ approved: true })));
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.diagnostic).toContain('approved');
    expect(parsed.diagnostic).not.toMatch(/oneOf/);
  });

  test('a request contract is parsed with the same limit and the same rules', () => {
    expect(parseRole('strategy-formulation.request', '{}')).toMatchObject({ ok: false, reason: 'SCHEMA_INVALID' });
  });
});

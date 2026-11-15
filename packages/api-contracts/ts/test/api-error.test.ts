// The api-error/1 body carries the violation listing of the contract layer (OQ-05 §7).
//
// The listing is at most 20 violations and one counted entry, so 21 entries, and a pointer into a
// nested Expr is longer than 256 characters. The API maps a ContractError onto api-error/1 with
// `apiViolations`, which cuts a pointer or a message longer than the schema maximum.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  API_MESSAGE_MAX_LENGTH,
  API_POINTER_MAX_LENGTH,
  apiViolations,
  ContractError,
  type ContractName,
  parseContract,
} from '../src/index.ts';
import { MAX_REPORTED_VIOLATIONS } from '../src/validate.ts';
import { fixturesDir } from './support/manifest.ts';

// biome-ignore lint/suspicious/noExplicitAny: the tests edit fixture documents by path.
type Doc = Record<string, any>;

const fixture = (path: string): Doc => JSON.parse(readFileSync(resolve(fixturesDir, path), 'utf8')) as Doc;

/** The api-error/1 body that the API sends for a rejected body. */
function errorBody(error: ContractError): Doc {
  const violations = apiViolations(error);
  return {
    schema_version: 'api-error/1',
    code: error.code,
    message: `The request body violates the contract at ${error.violations.length} location(s).`,
    state_changed: 'NONE',
    retry_safe: false,
    diagnostic_ref: 'diag-1',
    ...(violations === undefined ? {} : { violations }),
  };
}

function rejection(contract: ContractName, document: Doc): ContractError {
  const result = parseContract(contract, JSON.stringify(document));
  if (result.ok) throw new Error('the document was accepted');
  return result.error;
}

function expectCarried(error: ContractError): Doc {
  const body = errorBody(error);
  const parsed = parseContract('api-error', JSON.stringify(body));
  expect(parsed.ok, JSON.stringify(parsed.ok ? '' : parsed.error.violations)).toBe(true);
  return body;
}

// A strategy whose first indicator is an Expr tree `depth` levels deep with an unknown property at
// the bottom, so one violation has a pointer of about 7 characters a level.
function deepStrategy(depth: number): Doc {
  const strategy = fixture('s0/strategies/seed-1-rsi30-breakeven-off.json');
  let expr: Doc = { op: 'operator:bar_field@1', args: [], params: { field: 'CLOSE' }, bogus: true };
  for (let level = 0; level < depth; level += 1) expr = { op: 'operator:sma@1', args: [expr], params: { window: 2 } };
  strategy.definition.indicators[0].expr = expr;
  return strategy;
}

describe('the violation listing as an api-error/1 body', () => {
  test('a command with one bad decimal lists 21 entries, and api-error/1 carries all of them', () => {
    const command = fixture('protocol/valid/command.register-budget.json');
    command.payload.budget.model_spend.amount = '01.5';
    const error = rejection('command', command);
    // One bad value under the four-way root oneOf of command/1: every branch rejects the document.
    expect(error.code).toBe('SCHEMA_VIOLATION');
    expect(error.violations).toHaveLength(MAX_REPORTED_VIOLATIONS + 1);
    const marker = error.violations.at(-1);
    expect(marker?.pointer).toBe('');
    expect(marker?.message).toMatch(/^\d+ further violation\(s\) not listed$/);
    const body = expectCarried(error);
    expect(body.violations).toHaveLength(21);
    expect(body.violations.at(-1)).toEqual({ pointer: '', message: marker?.message });
    // The decimal-grammar flag stays in the contract layer.
    expect(Object.keys(body.violations[0]).sort()).toEqual(['message', 'pointer']);
  });

  test('a pointer into a deep Expr is longer than 256 characters and api-error/1 carries it', () => {
    const error = rejection('strategy-artefact', deepStrategy(55));
    const longest = Math.max(...error.violations.map((v) => v.pointer.length));
    expect(longest).toBeGreaterThan(256);
    expect(longest).toBeLessThanOrEqual(API_POINTER_MAX_LENGTH);
    const body = expectCarried(error);
    expect(body.violations.map((v: Doc) => v.pointer)).toEqual(error.violations.map((v) => v.pointer));
  });

  test('the deepest pointer within the nesting limit is shorter than the schema maximum', () => {
    // Expr is the only recursive definition. Each level adds `/args/0`, 7 characters, and two levels of
    // nesting, so the 128-level nesting limit stops a pointer well below 1,024 characters.
    let longest = 0;
    let deepest = 0;
    for (let depth = 55; depth < 80; depth += 1) {
      const result = parseContract('strategy-artefact', JSON.stringify(deepStrategy(depth)));
      if (result.ok) throw new Error('the document was accepted');
      if (result.error.kind !== 'schema') break;
      deepest = depth;
      longest = Math.max(longest, ...result.error.violations.map((v) => v.pointer.length));
    }
    expect(deepest).toBeGreaterThan(55);
    expect(deepest).toBeLessThan(79);
    expect(longest).toBeGreaterThan(400);
    expect(longest).toBeLessThan(API_POINTER_MAX_LENGTH);
  });

  test('an error with no violation has no violations member', () => {
    const result = parseContract('command', '{"schema_version":"command/2"}');
    if (result.ok) throw new Error('accepted');
    expect(apiViolations(result.error)).toBeUndefined();
    expect('violations' in expectCarried(result.error)).toBe(false);
  });

  test('a pointer or a message beyond the schema maximum is cut to it, never inside a surrogate pair', () => {
    const astral = '\u{1F600}';
    const error = new ContractError('schema', 'x', [
      { pointer: `/${'a'.repeat(5_000)}`, message: 'm'.repeat(5_000), decimalGrammar: false },
      { pointer: `/${astral.repeat(2_000)}`, message: astral.repeat(1_500), decimalGrammar: false },
      { pointer: '/kept', message: 'kept', decimalGrammar: true },
    ]);
    const violations = apiViolations(error) ?? [];
    expect(violations.map((v) => [Array.from(v.pointer).length, Array.from(v.message).length])).toEqual([
      [API_POINTER_MAX_LENGTH, API_MESSAGE_MAX_LENGTH],
      [API_POINTER_MAX_LENGTH, API_MESSAGE_MAX_LENGTH],
      [5, 4],
    ]);
    expect(violations[1]?.pointer).toBe(`/${astral.repeat(API_POINTER_MAX_LENGTH - 1)}`);
    for (const { pointer, message } of violations) {
      expect(pointer.isWellFormed()).toBe(true);
      expect(message.isWellFormed()).toBe(true);
    }
    expectCarried(error);
  });

  test('the maximal fixture is the largest listing: 21 entries, the longest pointer and message', () => {
    const body = fixture('protocol/valid/api-error.maximal-listing.json');
    expect(body.violations).toHaveLength(MAX_REPORTED_VIOLATIONS + 1);
    expect(Array.from(body.violations[0].pointer)).toHaveLength(API_POINTER_MAX_LENGTH);
    expect(Array.from(body.violations[0].message)).toHaveLength(API_MESSAGE_MAX_LENGTH);
    expect(body.violations.at(-1).pointer).toBe('');
    expect(parseContract('api-error', JSON.stringify(body)).ok).toBe(true);
    // One entry more, or one more character in a pointer, is outside the contract.
    const more = structuredClone(body);
    more.violations.push({ pointer: '/x', message: 'x' });
    expect(parseContract('api-error', JSON.stringify(more)).ok).toBe(false);
    const longer = structuredClone(body);
    longer.violations[0].pointer += 'a';
    expect(parseContract('api-error', JSON.stringify(longer)).ok).toBe(false);
  });
});

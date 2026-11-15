// The cost of listing the violations of an invalid document (OQ-05 §7, src/limits.ts). The listing
// runs the all-errors validator only within MAX_NODES values, and the work and memory it takes grow
// with the Ajv errors it creates. Every bound here counts errors or validator calls; none is timed.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, test } from 'vitest';
import { byContract as allErrorValidators } from '../dist/generated/validators-all.js';
import { type ContractName, contracts, isContractName, parseContract } from '../src/index.ts';
import { MAX_NODES } from '../src/limits.ts';
import { MAX_REPORTED_VIOLATIONS } from '../src/validate.ts';
import { appendErrorsInPlace, BUNDLE_ID, linearPattern } from '../tools/generate.ts';
import { countedValidators } from './support/counted-validators.ts';
import { errorBound } from './support/error-bound.ts';
import { bundleDefs, errorShape, errorShapeText } from './support/error-shape.ts';
import { fixturesDir, readManifest } from './support/manifest.ts';

/** The most Ajv errors one value can carry, over every contract (command/1 at /payload). */
const MAX_ERRORS_PER_VALUE = 34;
/** The most Ajv errors a listing can create: MAX_NODES values at the most errors per value. */
const MAX_LISTED_ERRORS = MAX_ERRORS_PER_VALUE * MAX_NODES;
/** The most schemas applied to one value, over every contract (cohort-policy/1 and command/1). */
const MAX_APPLICATIONS_PER_VALUE = 25;

const here = dirname(fileURLToPath(import.meta.url));
const defs = bundleDefs();
const names = Object.keys(contracts).filter(isContractName);
const bounds = new Map(names.map((name) => [name, errorBound(defs, contracts[name].typeName)]));
const boundOf = (name: ContractName) => {
  const bound = bounds.get(name);
  if (bound === undefined) throw new Error(`no bound for ${name}`);
  return bound;
};

// biome-ignore lint/suspicious/noExplicitAny: the tests edit fixture documents by path.
type Doc = Record<string, any>;

function countValues(value: unknown): number {
  if (Array.isArray(value)) return 1 + value.reduce<number>((sum, item) => sum + countValues(item), 0);
  if (typeof value === 'object' && value !== null) {
    return 1 + Object.values(value).reduce<number>((sum, item) => sum + countValues(item), 0);
  }
  return 1;
}

function ajvErrors(name: ContractName, document: unknown): number {
  const validate = allErrorValidators[name];
  return validate(document) ? 0 : (validate.errors?.length ?? 0);
}

describe('the Ajv errors of a listing are bounded', () => {
  test(`no value carries more than ${MAX_ERRORS_PER_VALUE} errors, so a listing creates at most ${MAX_LISTED_ERRORS}`, () => {
    const perValue = names.map((name) => [name, boundOf(name).errorsPerValue] as const);
    for (const [name, errors] of perValue) expect(errors, name).toBeLessThanOrEqual(MAX_ERRORS_PER_VALUE);
    expect(Math.max(...perValue.map(([, errors]) => errors))).toBe(MAX_ERRORS_PER_VALUE);
    expect(MAX_LISTED_ERRORS).toBe(139_264);
  });

  test.each(names)('%s: the error-maximising document at MAX_NODES values stays within the bound', (name) => {
    const bound = boundOf(name);
    const shape = errorShape(name, defs);
    const text = errorShapeText(shape, MAX_NODES);
    const document: unknown = JSON.parse(text);
    expect(countValues(document)).toBe(MAX_NODES);
    const errors = ajvErrors(name, document);
    expect(errors).toBeLessThanOrEqual(bound.errorsPerValue * MAX_NODES);
    if (bound.worstItem?.kind === 'object') {
      // `{}` misses every required property, so each item reaches its bound: the document is the
      // worst one the analysis allows for a repeated value.
      const items = MAX_NODES - shape.skeleton;
      expect(errors).toBeGreaterThanOrEqual(bound.worstItem.errors * items);
    }
    // The listing ran and kept 20 violations and a counted rest.
    const result = parseContract(name, text);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.listingStopped).toBe(false);
    expect(result.error.violations.length).toBe(Math.min(errors, MAX_REPORTED_VIOLATIONS + 1));
  });

  test('the bound holds on every invalid protocol fixture', () => {
    let checked = 0;
    for (const entry of readManifest().entries) {
      if (entry.expect === 'valid' || !isContractName(entry.contract)) continue;
      let document: unknown;
      try {
        document = JSON.parse(readFileSync(resolve(fixturesDir, entry.path), 'utf8'));
      } catch {
        continue; // not JSON text that Ajv could see
      }
      expect(ajvErrors(entry.contract, document), entry.path).toBeLessThanOrEqual(
        boundOf(entry.contract).errorsPerValue * countValues(document),
      );
      checked += 1;
    }
    expect(checked).toBeGreaterThan(150);
  });

  test('one value more stops the listing: only the first violation is found', () => {
    for (const name of names) {
      const result = parseContract(name, errorShapeText(errorShape(name, defs), MAX_NODES + 1));
      expect(result.ok, name).toBe(false);
      if (result.ok) continue;
      expect(result.error.listingStopped, name).toBe(true);
      expect(result.error.code, name).toBe('SCHEMA_VIOLATION');
      expect(result.error.violations.length, name).toBeLessThanOrEqual(2);
    }
  });
});

describe('validation work per value does not grow with depth', () => {
  // A cycle among the definitions, found by a depth-first walk of their references.
  function recursiveDefinitions(): string[] {
    const references = (schema: unknown, out: Set<string>): Set<string> => {
      if (Array.isArray(schema)) for (const item of schema) references(item, out);
      else if (typeof schema === 'object' && schema !== null) {
        for (const [key, value] of Object.entries(schema)) {
          if (key === '$ref' && typeof value === 'string') out.add(value.slice('#/$defs/'.length));
          else references(value, out);
        }
      }
      return out;
    };
    const graph = new Map(Object.entries(defs).map(([name, schema]) => [name, references(schema, new Set())]));
    const reaches = (from: string, to: string, seen = new Set<string>()): boolean => {
      for (const next of graph.get(from) ?? []) {
        if (next === to) return true;
        if (!seen.has(next)) {
          seen.add(next);
          if (reaches(next, to, seen)) return true;
        }
      }
      return false;
    };
    return [...graph.keys()].filter((name) => reaches(name, name)).sort();
  }

  test('Expr is the only recursive definition, and it applies no oneOf, anyOf, allOf or not', () => {
    expect(recursiveDefinitions()).toEqual(['Expr']);
    const expr = JSON.stringify(defs.Expr);
    for (const keyword of ['oneOf', 'anyOf', 'allOf', '"not"']) expect(expr).not.toContain(keyword);
  });

  test(`at most ${MAX_APPLICATIONS_PER_VALUE} schemas apply to one value, in every contract`, () => {
    // errorBound expands each distinct set of applied schemas once and fails if a set grows
    // without end, so a finite result is the proof that depth cannot multiply the work.
    const perValue = names.map((name) => boundOf(name).applicationsPerValue);
    expect(Math.max(...perValue)).toBe(MAX_APPLICATIONS_PER_VALUE);
  });

  // A chain of `depth` Expr nodes, each the only argument of the one above it.
  function chain(depth: number, leaf: unknown): unknown {
    let node = leaf;
    for (let level = 1; level < depth; level += 1) node = { op: 'operator:abs@1', args: [node], params: {} };
    return node;
  }
  const fixture = (path: string) => JSON.parse(readFileSync(resolve(fixturesDir, path), 'utf8')) as Doc;
  const placements: [ContractName, string, (document: Doc, expr: unknown) => void][] = [
    [
      'strategy-artefact',
      's0/strategies/seed-1-rsi30-breakeven-off.json',
      (document, expr) => {
        document.definition.entry.condition = expr;
      },
    ],
    [
      'command',
      'protocol/valid/command.register-seed.json',
      (document, expr) => {
        document.payload.draft.definition.indicators[0].expr = expr;
      },
    ],
  ];
  const leaves: [string, unknown][] = [
    ['valid', { op: 'operator:bar_field@1', args: [], params: { field: 'CLOSE' } }],
    ['invalid', {}],
  ];
  // Depths within the 128 levels of nesting that strict JSON allows: each node takes two.
  const DEPTHS = [1, 2, 3, 10, 30, 55];

  test.each(
    placements.flatMap(([name, path, place]) =>
      leaves.map(([label, leaf]) => [name, label, path, place, leaf] as const),
    ),
  )(
    '%s, %s leaf: the calls of both validators grow by the same amount per node',
    async (name, _label, path, place, leaf) => {
      for (const mode of ['first', 'all'] as const) {
        const counted = await countedValidators(mode);
        const calls = DEPTHS.map((depth) => {
          const document = fixture(path);
          place(document, chain(depth, leaf));
          counted.reset();
          counted.byContract[name](document);
          return { depth, calls: counted.calls(), values: countValues(document) };
        });
        const [one, two] = calls;
        if (one === undefined || two === undefined) throw new Error('no depths');
        const perNode = two.calls - one.calls;
        expect(perNode, mode).toBeGreaterThan(0);
        for (const { depth, calls: made, values } of calls) {
          expect(made, `${mode} at depth ${depth}`).toBe(one.calls + (depth - 1) * perNode);
          expect(made, `${mode} at depth ${depth}`).toBeLessThanOrEqual(boundOf(name).applicationsPerValue * values);
        }
      }
    },
  );

  test('on every error-maximising document, both validators stay within the applications bound', async () => {
    for (const mode of ['first', 'all'] as const) {
      const counted = await countedValidators(mode);
      for (const name of names) {
        const document: unknown = JSON.parse(errorShapeText(errorShape(name, defs), MAX_NODES));
        counted.reset();
        counted.byContract[name](document);
        expect(counted.calls(), `${mode} ${name}`).toBeLessThanOrEqual(boundOf(name).applicationsPerValue * MAX_NODES);
      }
    }
  });
});

describe('the generated validators append errors in place', () => {
  test('no generated validator copies its errors with concat', () => {
    for (const mode of ['first', 'all']) {
      const code = readFileSync(resolve(here, `../dist/generated/validators-${mode}.js`), 'utf8');
      expect(code).not.toMatch(/\.concat\s*\(/);
      expect(code).toContain('const appendErrors = (target, source) => {');
      expect(code).toContain(': appendErrors(vErrors, ');
    }
  });

  test('the rewrite covers both callee forms and refuses code it does not cover', () => {
    const direct = 'vErrors = vErrors === null ? validate55.errors : vErrors.concat(validate55.errors);';
    const wrapped = 'vErrors = vErrors === null ? wrapper0.validate.errors : vErrors.concat(wrapper0.validate.errors);';
    for (const [text, callee] of [
      [direct, 'validate55'],
      [wrapped, 'wrapper0.validate'],
    ] as const) {
      expect(appendErrorsInPlace(text)).toBe(
        `vErrors = vErrors === null ? ${callee}.errors : appendErrors(vErrors, ${callee}.errors);`,
      );
    }
    expect(() => appendErrorsInPlace('vErrors = vErrors.concat(other.errors);')).toThrow(/concat/);
  });

  test('the errors, and their order, equal those of Ajv compiled at run time without the rewrite', () => {
    // The reference runs the same patterns as the generated validators: this test is about the
    // append rewrite, and test/patterns.test.ts about the pattern rewrite.
    const bundle = JSON.parse(readFileSync(resolve(here, '../dist/generated/bundle.json'), 'utf8'), (key, value) =>
      key === 'pattern' && typeof value === 'string' ? linearPattern(value) : value,
    );
    const ajv = new Ajv2020({ strict: true, allErrors: true, unicodeRegExp: true, inlineRefs: false });
    ajv.addSchema(bundle);
    const project = (
      errors: readonly { instancePath: string; schemaPath: string; keyword: string; params: unknown }[],
    ) => errors.map(({ instancePath, schemaPath, keyword, params }) => ({ instancePath, schemaPath, keyword, params }));
    let compared = 0;
    const documents: [ContractName, unknown][] = names.map((name) => [
      name,
      JSON.parse(errorShapeText(errorShape(name, defs), 200)),
    ]);
    for (const entry of readManifest().entries) {
      if (entry.expect !== 'schema_invalid' || !isContractName(entry.contract)) continue;
      try {
        documents.push([entry.contract, JSON.parse(readFileSync(resolve(fixturesDir, entry.path), 'utf8'))]);
      } catch {
        // not JSON text
      }
    }
    for (const [name, document] of documents) {
      const reference = ajv.getSchema(`${BUNDLE_ID}#/$defs/${contracts[name].typeName}`);
      if (reference === undefined) throw new Error(`no run-time validator for ${name}`);
      const generated = allErrorValidators[name];
      expect(generated(document)).toBe(reference(document));
      expect(project(generated.errors ?? [])).toEqual(project(reference.errors ?? []));
      compared += 1;
    }
    expect(compared).toBeGreaterThan(170);
  });
});

// The leaf-level rule difference of a controlled revision and its change scope (OQ-03 section 3, OQ-02 section 3.1).
//
// Result parsing compares the rule changes that a proposal declares with the parent at the level of the changed
// definition leaves. The Rust validation job recomputes the same difference independently (`computed_changes` of
// validation-result/1), and shared fixtures show that both agree. The reference implementation is `changes` and
// `render` in packages/quant-core/tests/variants_seed.rs, which this file follows:
//
// - objects are compared member by member and arrays of equal length item by item;
// - a member that is present on one side only, an array of a different length and a different scalar are each one
//   change at that JSON Pointer;
// - a changed value is written as a declared text: a string as itself, an empty list as `[]`, a list of named rules
//   (items with a string `id`) as their ids joined with commas, anything else as compact JSON with sorted keys,
//   and a missing member as `null`.
//
// The compared body is the strategy without its identity: schema_version, strategy_id, version and parent. The
// proposer's `strategy` omits them, so the parent is reduced the same way. Worker-safe: no Node module.

import { canonicalJson } from '@openquant/api-contracts';
import { isObject, type JsonObject, type JsonValue, jsonEqual, pointerToken } from './json.ts';

/** A changed leaf with the values as they are, before they are written as declared text. */
export interface LeafChange {
  readonly path: string;
  readonly from: JsonValue | undefined;
  readonly to: JsonValue | undefined;
}

/** A change as a proposal declares it (`StrategyChange` of strategy-artefact/1). */
export interface DeclaredChange {
  readonly path: string;
  readonly from: string;
  readonly to: string;
}

/** The longest `path`, `from` or `to` of a declared change (`StrategyChange`). */
export const DECLARED_TEXT_LIMIT = 256;

const IDENTITY_MEMBERS = ['schema_version', 'strategy_id', 'version', 'parent'] as const;

/** The members of a strategy artefact that describe it, without the ones that identify the version. */
export function strategyBody(strategy: JsonObject): JsonObject {
  return Object.fromEntries(Object.entries(strategy).filter(([key]) => !IDENTITY_MEMBERS.some((name) => name === key)));
}

function compareKeys(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function collect(path: string, left: JsonValue, right: JsonValue, out: LeafChange[]): void {
  if (isObject(left) && isObject(right)) {
    const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort(compareKeys);
    for (const key of keys) {
      const child = `${path}/${pointerToken(key)}`;
      const before = Object.hasOwn(left, key) ? left[key] : undefined;
      const after = Object.hasOwn(right, key) ? right[key] : undefined;
      if (before !== undefined && after !== undefined) collect(child, before, after, out);
      else out.push({ path: child, from: before, to: after });
    }
  } else if (Array.isArray(left) && Array.isArray(right) && left.length === right.length) {
    left.forEach((item, index) => {
      collect(`${path}/${index}`, item, right[index] as JsonValue, out);
    });
  } else if (!jsonEqual(left, right)) {
    out.push({ path, from: left, to: right });
  }
}

/** The minimal differing subtrees of two JSON values, ordered by path. */
export function leafChanges(parent: JsonValue, child: JsonValue): LeafChange[] {
  const out: LeafChange[] = [];
  collect('', parent, child, out);
  return out;
}

/** How a changed value is written in a declared change. */
export function renderValue(value: JsonValue | undefined): string {
  if (value === undefined || value === null) return 'null';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    return value
      .map((item) => (isObject(item) && typeof item.id === 'string' ? item.id : canonicalJson(item)))
      .join(',');
  }
  return canonicalJson(value);
}

export function render(change: LeafChange): DeclaredChange {
  return { path: change.path, from: renderValue(change.from), to: renderValue(change.to) };
}

export interface ComputedDifference {
  readonly changes: readonly LeafChange[];
  readonly declared: readonly DeclaredChange[];
  /** A computed change whose path or text is longer than a declared change can hold, so it cannot be declared. */
  readonly undeclarable: readonly DeclaredChange[];
}

/** The difference between a registered parent and a proposed strategy, as a proposal would have to declare it. */
export function computeDifference(parent: JsonObject, proposed: JsonObject): ComputedDifference {
  const changes = leafChanges(strategyBody(parent), strategyBody(proposed));
  const declared = changes.map(render);
  const undeclarable = declared.filter((change) =>
    [change.path, change.from, change.to].some((text) => Array.from(text).length > DECLARED_TEXT_LIMIT),
  );
  return { changes, declared, undeclarable };
}

const key = (change: DeclaredChange) => canonicalJson([change.path, change.from, change.to]);

export interface ChangeComparison {
  readonly equal: boolean;
  /** Computed changes that the proposal does not declare. */
  readonly missing: readonly DeclaredChange[];
  /** Declared changes that are not in the computed difference, a repeated change included. */
  readonly extra: readonly DeclaredChange[];
}

/** Compare declared and computed changes as multisets: the order of a declaration does not matter. */
export function compareChanges(
  declared: readonly DeclaredChange[],
  computed: readonly DeclaredChange[],
): ChangeComparison {
  const remaining = new Map<string, DeclaredChange[]>();
  for (const change of computed) remaining.set(key(change), [...(remaining.get(key(change)) ?? []), change]);
  const extra: DeclaredChange[] = [];
  for (const change of declared) {
    const bucket = remaining.get(key(change));
    if (bucket && bucket.length > 0) bucket.pop();
    else extra.push(change);
  }
  const missing = [...remaining.values()].flat();
  return { equal: missing.length === 0 && extra.length === 0, missing, extra };
}

// ---------------------------------------------------------------------------------------------------------------
// Change scope
// ---------------------------------------------------------------------------------------------------------------

/**
 * The rule a revision changes, by dependency (`ChangeScope` of validation-result/1): ENTRY or EXIT for a controlled
 * revision. NONE (no change), BOTH (entry and exits) and OUTSIDE (a change that is not part of the entry or exit
 * rules) are what `REVISION_SCOPE` rejects.
 */
export type Scope = 'ENTRY' | 'EXIT' | 'BOTH' | 'NONE' | 'OUTSIDE';

export interface ScopeResult {
  readonly scope: Scope;
  /** The effect of each change: the rules it reaches, or OUTSIDE. */
  readonly effects: readonly { readonly path: string; readonly effect: 'ENTRY' | 'EXIT' | 'BOTH' | 'OUTSIDE' }[];
}

const REFERENCE_OPERATOR = 'operator:ref@1';

// The names that an expression tree references through the reference operator.
function referencedNames(value: JsonValue, out: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) referencedNames(item, out);
  } else if (isObject(value)) {
    if (value.op === REFERENCE_OPERATOR && isObject(value.params) && typeof value.params.name === 'string') {
      out.add(value.params.name);
    }
    for (const child of Object.values(value)) referencedNames(child, out);
  }
  return out;
}

interface Indicator {
  readonly name: string;
  readonly expr: JsonValue;
}

function indicatorsOf(definition: JsonValue | undefined): Indicator[] {
  if (!isObject(definition) || !Array.isArray(definition.indicators)) return [];
  return definition.indicators.flatMap((item) =>
    isObject(item) && typeof item.name === 'string' ? [{ name: item.name, expr: item.expr ?? null }] : [],
  );
}

// The indicators that depend on `seeds`, directly or through other indicators, the seeds included.
function dependents(indicators: readonly Indicator[], seeds: ReadonlySet<string>): Set<string> {
  const affected = new Set(seeds);
  for (let changed = true; changed; ) {
    changed = false;
    for (const indicator of indicators) {
      if (affected.has(indicator.name)) continue;
      if ([...referencedNames(indicator.expr)].some((name) => affected.has(name))) {
        affected.add(indicator.name);
        changed = true;
      }
    }
  }
  return affected;
}

function section(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

/**
 * Classify a revision's changes by dependency (OQ-02 section 3.1). A change under `/definition/entry` affects the
 * entry rule and a change under `/definition/exits` the exit rules. A changed indicator counts as a change to every
 * entry or exit rule that references it, directly or through other indicators, in the parent or in the child. Every
 * other change is outside a controlled revision: selection, sizing, execution, an indicator that no entry or exit
 * rule references, and anything outside the definition. The text is followed literally: an exit that reads the entry
 * snapshot is not taken to depend on the indicators that the snapshot expression references.
 */
export function classifyScope(parent: JsonObject, proposed: JsonObject, changes: readonly LeafChange[]): ScopeResult {
  const sides = [parent, proposed].map((strategy) => {
    const definition = isObject(strategy.definition) ? strategy.definition : undefined;
    return {
      indicators: indicatorsOf(definition),
      entry: referencedNames(definition?.entry ?? null),
      exits: referencedNames(definition?.exits ?? null),
    };
  });
  const effects: { path: string; effect: 'ENTRY' | 'EXIT' | 'BOTH' | 'OUTSIDE' }[] = [];
  for (const change of changes) {
    const { path } = change;
    let entry = false;
    let exits = false;
    let outside = false;
    if (section(path, '/definition/entry')) {
      entry = true;
    } else if (section(path, '/definition/exits')) {
      exits = true;
    } else if (section(path, '/definition/indicators')) {
      const seeds = changedIndicatorNames(path, parent, proposed);
      for (const side of sides) {
        const affected = dependents(
          side.indicators,
          new Set([...seeds].filter((name) => side.indicators.some((indicator) => indicator.name === name))),
        );
        if ([...affected].some((name) => side.entry.has(name))) entry = true;
        if ([...affected].some((name) => side.exits.has(name))) exits = true;
      }
      outside = !entry && !exits;
    } else {
      outside = true;
    }
    effects.push({ path, effect: outside ? 'OUTSIDE' : entry && exits ? 'BOTH' : entry ? 'ENTRY' : 'EXIT' });
  }
  const kinds = new Set(effects.map((item) => item.effect));
  let scope: Scope;
  if (effects.length === 0) scope = 'NONE';
  else if (kinds.has('OUTSIDE')) scope = 'OUTSIDE';
  else if (kinds.has('BOTH') || (kinds.has('ENTRY') && kinds.has('EXIT'))) scope = 'BOTH';
  else scope = kinds.has('ENTRY') ? 'ENTRY' : 'EXIT';
  return { scope, effects };
}

// The names of the indicators that a change under /definition/indicators touches: the indicator at the index in the
// parent and in the proposal, or, when the whole list changed length, every name that was added, removed or changed.
function changedIndicatorNames(path: string, parent: JsonObject, proposed: JsonObject): Set<string> {
  const left = indicatorsOf(isObject(parent.definition) ? parent.definition : undefined);
  const right = indicatorsOf(isObject(proposed.definition) ? proposed.definition : undefined);
  const names = new Set<string>();
  const index = /^\/definition\/indicators\/(0|[1-9][0-9]*)(?:\/|$)/.exec(path)?.[1];
  if (index !== undefined) {
    for (const side of [left, right]) {
      const found = side[Number(index)];
      if (found) names.add(found.name);
    }
    return names;
  }
  const byName = (indicators: readonly Indicator[]) =>
    new Map(indicators.map((item) => [item.name, canonicalJson(item.expr)]));
  const leftMap = byName(left);
  const rightMap = byName(right);
  for (const [name, expr] of leftMap) if (rightMap.get(name) !== expr) names.add(name);
  for (const [name, expr] of rightMap) if (leftMap.get(name) !== expr) names.add(name);
  return names;
}

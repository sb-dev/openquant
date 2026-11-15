// Result parsing of the proposer role module (OQ-03 sections 3 and 4).
//
// Skill code checks structure, reference membership and exact rule differences (OQ-03 section 3). A result that fails
// any of them is malformed: the attempt is retried within its cap and the host keeps no part of the output. A result
// that passes is a completion, and may still carry blockers. A blocker is an early, non-authoritative notice that the
// application will refuse to register the proposal: an unresolved entry, a revision that is not an entry-only or
// exit-only change, an operator outside the permitted set, and a date inside a withheld window. No blocker turns a
// completion into a malformed result, in this module or in the agent runner: skill code does not repeat the Rust
// core's operator, type, unit and lookback validation (OQ-03 section 3). The draft is kept: the Rust core returns
// INVALID with its diagnostics for an operator outside the set, and those go to the next proposer attempt (OQ-02
// section 4); the API checks scope, bounds and lineage and decides on the notices.
//
// Worker-safe: no Node module.

import { type Malformed, malformed, parseRole } from './contract.ts';
import { datesInExclusions } from './holdout.ts';
import { asJson, asObject, isObject, type JsonValue, pointerToken, resolvePointer, stringValues } from './json.ts';
import { classifyScope, compareChanges, computeDifference, type DeclaredChange, type Scope } from './leaf-diff.ts';
import type { StrategyFormulationRequest, StrategyFormulationResult } from './types.ts';

export type BlockerCode = 'UNRESOLVED_ASSUMPTION' | 'REVISION_SCOPE' | 'OPERATOR_NOT_PERMITTED' | 'HOLDOUT_REFERENCE';

export interface Blocker {
  readonly code: BlockerCode;
  readonly detail: string;
  /** A JSON Pointer into the proposed strategy, where one applies. */
  readonly pointer?: string;
}

export interface RevisionFacts {
  /** The leaf difference from the parent, written as a proposal would declare it. */
  readonly computed: readonly DeclaredChange[];
  readonly scope: Scope;
}

export type FormulationParse =
  | {
      readonly ok: true;
      readonly value: StrategyFormulationResult;
      readonly blockers: readonly Blocker[];
      /** Present for a controlled revision. */
      readonly revision?: RevisionFacts;
    }
  | Malformed;

const OPERATOR_KEY = 'op';

// Every operator of every expression of the proposed strategy, with the pointer of its `op` member.
function operatorsIn(value: JsonValue, pointer = '', out: { pointer: string; op: string }[] = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      operatorsIn(item, `${pointer}/${index}`, out);
    });
  } else if (isObject(value)) {
    for (const [key, child] of Object.entries(value)) {
      const path = `${pointer}/${pointerToken(key)}`;
      if (key === OPERATOR_KEY && typeof child === 'string') out.push({ pointer: path, op: child });
      else operatorsIn(child, path, out);
    }
  }
  return out;
}

function summary(changes: readonly DeclaredChange[]): string {
  return changes
    .slice(0, 3)
    .map((change) => `${change.path} (${change.from.slice(0, 40)} to ${change.to.slice(0, 40)})`)
    .join('; ');
}

/**
 * Parse the output of a proposer attempt against its request. `request` is the frozen request that assembly returned.
 * Returns the validated result with its blockers, or the reason the result is malformed.
 */
export function parseFormulationResult(
  request: StrategyFormulationRequest,
  output: string | Uint8Array,
): FormulationParse {
  const parsed = parseRole('strategy-formulation.result', output);
  if (!parsed.ok) return parsed;
  const { value } = parsed;
  const { subject } = request;
  if (value.proposal_kind !== subject.proposal_kind) {
    return malformed(
      'REFERENCE_INVALID',
      `the proposal kind ${value.proposal_kind} is not the requested kind ${subject.proposal_kind}`,
    );
  }
  const strategy = asJson(value.strategy);
  const known = new Set<string>(request.evidence_refs.map((item) => item.id));
  if (subject.proposal_kind === 'seed_translation') known.add(subject.source.source_id);
  for (const ref of value.source_refs) {
    if (!known.has(ref))
      return malformed('REFERENCE_INVALID', `source_refs cites ${ref}, which the request does not hold`);
  }
  const methods = new Set<string>(request.supplied_methods.map((item) => item.id));
  for (const ref of value.method_refs) {
    if (!methods.has(ref))
      return malformed('REFERENCE_INVALID', `method_refs cites ${ref}, which the request did not supply`);
  }
  const identifiers = new Set<string>();
  for (const [index, entry] of value.unresolved.entries()) {
    if (identifiers.has(entry.id))
      return malformed('REFERENCE_INVALID', `unresolved entry id ${entry.id} is used twice`);
    identifiers.add(entry.id);
    if (!resolvePointer(strategy, entry.element).found) {
      return malformed(
        'REFERENCE_INVALID',
        `unresolved[${index}].element ${entry.element} is not an element of strategy`,
      );
    }
  }
  let revision: RevisionFacts | undefined;
  if (value.proposal_kind === 'controlled_revision' && subject.proposal_kind === 'controlled_revision') {
    if (value.parent_hash !== subject.parent_hash) {
      return malformed('REFERENCE_INVALID', 'parent_hash is not the parent hash of the request');
    }
    const difference = computeDifference(asObject(subject.parent), asObject(strategy));
    if (difference.undeclarable.length > 0) {
      return malformed(
        'RULE_CHANGES_MISMATCH',
        `a change cannot be declared exactly in 256 characters: ${summary(difference.undeclarable)}`,
      );
    }
    const comparison = compareChanges(value.rule_changes, difference.declared);
    if (!comparison.equal) {
      return malformed(
        'RULE_CHANGES_MISMATCH',
        `rule_changes differ from the parent: ${comparison.missing.length} change(s) not declared${
          comparison.missing.length ? ` [${summary(comparison.missing)}]` : ''
        }, ${comparison.extra.length} declared change(s) not in the difference${
          comparison.extra.length ? ` [${summary(comparison.extra)}]` : ''
        }`,
      );
    }
    revision = {
      computed: difference.declared,
      scope: classifyScope(asObject(subject.parent), asObject(strategy), difference.changes).scope,
    };
  }
  return {
    ok: true,
    value,
    blockers: blockersOf(request, value, strategy, revision),
    ...(revision ? { revision } : {}),
  };
}

function blockersOf(
  request: StrategyFormulationRequest,
  value: StrategyFormulationResult,
  strategy: JsonValue,
  revision: RevisionFacts | undefined,
): Blocker[] {
  const blockers: Blocker[] = [];
  for (const [index, entry] of value.unresolved.entries()) {
    blockers.push({
      code: 'UNRESOLVED_ASSUMPTION',
      detail: `${entry.id}: ${entry.question.slice(0, 200)}`,
      pointer: entry.element === '' ? `/unresolved/${index}` : entry.element,
    });
  }
  if (revision && revision.scope !== 'ENTRY' && revision.scope !== 'EXIT') {
    const detail: Record<Exclude<Scope, 'ENTRY' | 'EXIT'>, string> = {
      NONE: 'the revision changes nothing',
      BOTH: 'the revision changes both the entry rule and the exit rules',
      OUTSIDE: 'the revision changes something outside the entry and exit rules',
    };
    blockers.push({ code: 'REVISION_SCOPE', detail: detail[revision.scope] });
  }
  const permitted = new Set<string>(request.context.operators.permitted.map((item) => item.operator));
  for (const { pointer, op } of operatorsIn(strategy)) {
    if (!permitted.has(op)) {
      blockers.push({ code: 'OPERATOR_NOT_PERMITTED', detail: `${op} is not a permitted operator`, pointer });
    }
  }
  const dates = datesInExclusions(stringValues(asJson(value)).join('\n'), request.context.holdout_exclusions);
  for (const date of dates) {
    blockers.push({ code: 'HOLDOUT_REFERENCE', detail: `the proposal mentions ${date}, inside a withheld window` });
  }
  return blockers;
}

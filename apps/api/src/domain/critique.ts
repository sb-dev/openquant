// The API's own reading of a role output (OQ-05 section 2: "the guarded API calls its result parsing before its own
// authority and acceptance checks"). The shared parsers of the role modules live in packages/agents, which the API does
// not import yet (P4 builds it, P5 wires it in). Until then the API reads what it must record, and nothing more:
//
//   strategy-critique.result/1    a strict, closed reading of the schema in packages/agents/schemas, so that the findings
//                                 that the API writes (and the policy treats) are exactly what the critic returned;
//   strategy-formulation.result/1 the tag and the proposal kind only: the proposal is assembled, bounded and registered by
//                                 the workflow that reads it (OQ-03 section 3), not by this route.
//
// Both are strict JSON (no duplicate key, no float, no unsafe integer). A reference check against the request (cited
// methods, evidence and elements) is the shared parser's job and is not repeated here; the API owns scope, bounds and
// policy only (packages/agents/schemas/README.md, "Parsing").

import type { JsonObject, JsonValue } from '@openquant/api-contracts';
import { parseStrictJson } from '@openquant/api-contracts';

export const FINDING_CATEGORIES = [
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
] as const;
export type FindingCategoryName = (typeof FINDING_CATEGORIES)[number];

const AREAS = ['contract', 'definition', 'source_refs', 'evidence', 'rationale', 'expected_effect', 'requested_tests'];
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

export interface Finding {
  readonly category: FindingCategoryName;
  readonly description: string;
  readonly affectedElements: readonly string[];
}

export type CritiqueReading =
  | { readonly ok: true; readonly findings: readonly Finding[] }
  | { readonly ok: false; readonly reason: string };

function isObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function onlyKeys(value: JsonObject, required: readonly string[], optional: readonly string[]): string | undefined {
  for (const key of required) if (!(key in value)) return `the member ${key} is missing`;
  for (const key of Object.keys(value))
    if (!required.includes(key) && !optional.includes(key)) return `the member ${key} is not defined`;
  return undefined;
}

function strings(
  value: JsonValue | undefined,
  maxItems: number,
  maxLength: number,
  pattern?: RegExp,
): string[] | undefined {
  if (!Array.isArray(value) || value.length > maxItems) return undefined;
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || item.length > maxLength || (pattern !== undefined && !pattern.test(item)))
      return undefined;
    out.push(item);
  }
  return out;
}

function readFinding(value: JsonValue, position: number): Finding | string {
  const where = `findings[${position}]`;
  if (!isObject(value)) return `${where} is not an object`;
  const keys = onlyKeys(
    value,
    ['category', 'description', 'method_refs', 'evidence_refs', 'location', 'affected_elements'],
    ['related_categories', 'proposed_tests'],
  );
  if (keys !== undefined) return `${where}: ${keys}`;
  const { category, description, location } = value;
  if (typeof category !== 'string' || !(FINDING_CATEGORIES as readonly string[]).includes(category)) {
    return `${where}: the category is not one of the eleven categories`;
  }
  if (typeof description !== 'string' || description.length > 2000)
    return `${where}: the description is not a string of at most 2000 characters`;
  if (strings(value.method_refs, 16, 64, IDENTIFIER) === undefined)
    return `${where}: method_refs is not at most 16 identifiers`;
  if (strings(value.evidence_refs, 16, 64, IDENTIFIER) === undefined)
    return `${where}: evidence_refs is not at most 16 identifiers`;
  const affected = strings(value.affected_elements, 32, 256);
  if (affected === undefined) return `${where}: affected_elements is not at most 32 pointers of at most 256 characters`;
  if (!isObject(location)) return `${where}: the location is not an object`;
  const locationKeys = onlyKeys(location, ['area'], ['pointer']);
  if (locationKeys !== undefined) return `${where}: location: ${locationKeys}`;
  if (typeof location.area !== 'string' || !AREAS.includes(location.area))
    return `${where}: the location area is not defined`;
  if (location.pointer !== undefined && (typeof location.pointer !== 'string' || location.pointer.length > 256)) {
    return `${where}: the location pointer is not a string of at most 256 characters`;
  }
  if (value.related_categories !== undefined) {
    const related = strings(value.related_categories, 10, 64);
    if (related === undefined || !related.every((name) => (FINDING_CATEGORIES as readonly string[]).includes(name))) {
      return `${where}: related_categories holds a value that is not a category`;
    }
  }
  if (value.proposed_tests !== undefined && strings(value.proposed_tests, 32, 1000) === undefined) {
    return `${where}: proposed_tests is not at most 32 strings of at most 1000 characters`;
  }
  return { category: category as FindingCategoryName, description, affectedElements: affected };
}

/** Read a critic's output. A value that the schema would not accept is refused with the first rule that it breaks. */
export function readCritique(bytes: Uint8Array): CritiqueReading {
  let value: JsonValue;
  try {
    value = parseStrictJson(bytes);
  } catch {
    return { ok: false, reason: 'the output is not strict JSON' };
  }
  if (!isObject(value)) return { ok: false, reason: 'the output is not an object' };
  const keys = onlyKeys(value, ['schema_version', 'findings'], []);
  if (keys !== undefined) return { ok: false, reason: keys };
  if (value.schema_version !== 'strategy-critique.result/1')
    return { ok: false, reason: 'the schema version is not strategy-critique.result/1' };
  const list = value.findings;
  if (!Array.isArray(list) || list.length > 64)
    return { ok: false, reason: 'findings is not a list of at most 64 findings' };
  const findings: Finding[] = [];
  for (const [position, item] of list.entries()) {
    const read = readFinding(item, position);
    if (typeof read === 'string') return { ok: false, reason: read };
    findings.push(read);
  }
  return { ok: true, findings };
}

/** The tag and the proposal kind of a proposer's output: the workflow that reads the proposal assembles and bounds it. */
export function readFormulation(
  bytes: Uint8Array,
): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
  let value: JsonValue;
  try {
    value = parseStrictJson(bytes);
  } catch {
    return { ok: false, reason: 'the output is not strict JSON' };
  }
  if (!isObject(value) || value.schema_version !== 'strategy-formulation.result/1') {
    return { ok: false, reason: 'the schema version is not strategy-formulation.result/1' };
  }
  if (!['seed_translation', 'controlled_revision', 'new_family'].includes(String(value.proposal_kind))) {
    return { ok: false, reason: 'the proposal kind is not defined' };
  }
  return { ok: true };
}

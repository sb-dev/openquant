// Builders for the offline agent suites: the synthetic context, the S0 seed strategies and the recipes that the
// fixtures in fixtures/agent-results use (development tooling, fixture mode only: nothing here calls a model).
//
// A fixture does not repeat an 11 KB strategy or the 15 KB cohort policy. It names an S0 seed strategy by file and
// lists the edits to apply, and the loader builds the request or the response. The expected values in a fixture are
// written by hand from the S0 fixtures and the specifications, not computed here.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { digest, digestBytes, type JsonObject, type JsonValue } from '@openquant/api-contracts';
import type { CritiqueInput, FormulationInput } from '../src/assemble.ts';
import { asObject, isObject, resolvePointer } from '../src/json.ts';
import type { CritiqueSubject, EvidenceItem, FormulationSubject, RoleContext } from '../src/types.ts';

export const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
export const fixturesRoot = resolve(repositoryRoot, 'fixtures/agent-results');

export function readJson(path: string): JsonValue {
  return JSON.parse(readFileSync(resolve(repositoryRoot, path), 'utf8')) as JsonValue;
}

export function seedArtefact(name: string): JsonObject {
  return asObject(readJson(`fixtures/s0/strategies/${name}.json`));
}

/** The proposer's form of a strategy: the artefact without its schema version, identity, version and parent. */
export function proposedForm(artefact: JsonObject): JsonObject {
  const { schema_version: _a, strategy_id: _b, version: _c, parent: _d, ...rest } = artefact;
  return rest;
}

// ---------------------------------------------------------------------------------------------------------------
// Edits
// ---------------------------------------------------------------------------------------------------------------

export interface Edit {
  readonly op: 'replace' | 'add' | 'remove';
  readonly path: string;
  readonly value?: JsonValue;
}

function unescapeToken(token: string): string {
  return token.replaceAll('~1', '/').replaceAll('~0', '~');
}

/** Apply edits to a deep copy of a JSON document. `add` appends to an array with the token `-`. */
export function applyEdits(document: JsonValue, edits: readonly Edit[] = []): JsonValue {
  const copy = structuredClone(document);
  for (const edit of edits) {
    const tokens = edit.path.split('/').slice(1).map(unescapeToken);
    const last = tokens.pop();
    if (last === undefined) throw new Error('an edit needs a path below the root');
    const parent = tokens.length === 0 ? copy : resolveIn(copy, tokens);
    if (Array.isArray(parent)) {
      const at = last === '-' ? parent.length : Number(last);
      if (edit.op === 'remove') parent.splice(at, 1);
      else if (edit.op === 'add') parent.splice(at, 0, edit.value ?? null);
      else if (at >= parent.length) throw new Error(`no element at ${edit.path}`);
      else parent[at] = edit.value ?? null;
    } else if (isObject(parent)) {
      if (edit.op === 'remove') delete parent[last];
      else if (edit.op === 'replace' && !Object.hasOwn(parent, last)) throw new Error(`no member at ${edit.path}`);
      else parent[last] = edit.value ?? null;
    } else {
      throw new Error(`cannot edit ${edit.path}`);
    }
  }
  return copy;
}

function resolveIn(root: JsonValue, tokens: readonly string[]): JsonValue {
  const found = resolvePointer(
    root,
    `/${tokens.map((token) => token.replaceAll('~', '~0').replaceAll('/', '~1')).join('/')}`,
  );
  if (!found.found) throw new Error(`no value at /${tokens.join('/')}`);
  return found.value;
}

// ---------------------------------------------------------------------------------------------------------------
// Placeholders in a recipe or a response
// ---------------------------------------------------------------------------------------------------------------

/** `{ "$artefact": { "seed": name, "edits": [...] } }` stands for a registered strategy artefact. */
interface ArtefactRecipe {
  readonly seed: string;
  readonly edits?: readonly Edit[];
}

function recipeOf(value: JsonValue | undefined): ArtefactRecipe {
  if (!isObject(value) || typeof value.seed !== 'string') throw new Error('an artefact recipe needs a seed name');
  return { seed: value.seed, ...(Array.isArray(value.edits) ? { edits: value.edits as unknown as Edit[] } : {}) };
}

export function artefactFrom(recipe: ArtefactRecipe): JsonObject {
  return asObject(applyEdits(seedArtefact(recipe.seed), recipe.edits));
}

/**
 * Replace the placeholders of a JSON value:
 * - `{ "$artefact": recipe }`: the registered strategy artefact;
 * - `{ "$strategy": recipe }`: its proposer form, without identity, version and parent;
 * - `{ "$digest_of": recipe }`: the digest of the registered artefact.
 */
export async function resolvePlaceholders(value: JsonValue): Promise<JsonValue> {
  if (Array.isArray(value)) return Promise.all(value.map(resolvePlaceholders));
  if (!isObject(value)) return value;
  const keys = Object.keys(value);
  if (keys.length === 1 && keys[0] === '$artefact') return artefactFrom(recipeOf(value.$artefact));
  if (keys.length === 1 && keys[0] === '$strategy') return proposedForm(artefactFrom(recipeOf(value.$strategy)));
  if (keys.length === 1 && keys[0] === '$digest_of') return digest(artefactFrom(recipeOf(value.$digest_of)));
  const out: JsonObject = {};
  for (const [key, child] of Object.entries(value)) out[key] = await resolvePlaceholders(child);
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Request input
// ---------------------------------------------------------------------------------------------------------------

export async function loadContext(name = 'pilot'): Promise<RoleContext> {
  const file = asObject(readJson(`fixtures/agent-results/context.${name}.json`));
  const { label: _label, purpose: _purpose, evaluation_policy_path: policyPath, ...rest } = file;
  if (typeof policyPath !== 'string') throw new Error('the context names no policy path');
  const policy = asObject(readJson(policyPath));
  const conditions = asObject(policy.conditions);
  return { ...rest, operators: conditions.operators, evaluation_policy: policy } as unknown as RoleContext;
}

interface EvidenceRecipe {
  readonly id: string;
  readonly kind?: EvidenceItem['kind'];
  readonly recorded_at?: string;
  readonly content: string;
}

async function evidenceItems(recipes: readonly EvidenceRecipe[] | undefined): Promise<EvidenceItem[]> {
  return Promise.all(
    (recipes ?? []).map(async (item) => ({
      id: item.id,
      kind: item.kind ?? 'finding',
      record_digest: await digest({ synthetic_record: item.id }),
      recorded_at: item.recorded_at ?? '2023-12-29T22:00:00Z',
      content: item.content,
    })),
  );
}

async function sourceText(source: JsonObject): Promise<JsonObject> {
  const lines = (source.lines as string[] | undefined) ?? [];
  const text = `${lines.join('\n')}\n`;
  return {
    source_id: source.source_id as string,
    content_digest:
      (source.content_digest as string | undefined) ?? (await digestBytes(new TextEncoder().encode(text))),
    media_type: (source.media_type as string | undefined) ?? 'text/x-python',
    lines,
  };
}

export interface FormulationRecipe {
  readonly context?: string;
  readonly subject: JsonObject;
  readonly evidence?: readonly EvidenceRecipe[];
}

export async function formulationInput(recipe: FormulationRecipe): Promise<FormulationInput> {
  const subject = recipe.subject;
  let built: JsonObject;
  if (subject.proposal_kind === 'controlled_revision') {
    const parent = artefactFrom(recipeOf(subject.parent));
    built = {
      proposal_kind: 'controlled_revision',
      parent_hash: (subject.parent_hash as string | undefined) ?? (await digest(parent)),
      parent,
      ...(subject.parent_claims === undefined ? {} : { parent_claims: subject.parent_claims }),
    };
  } else if (subject.proposal_kind === 'seed_translation') {
    built = { proposal_kind: 'seed_translation', source: await sourceText(asObject(subject.source)) };
  } else {
    built = { proposal_kind: 'new_family' };
  }
  return {
    context: await loadContext(recipe.context),
    subject: built as unknown as FormulationSubject,
    evidence: await evidenceItems(recipe.evidence as EvidenceRecipe[] | undefined),
  };
}

export interface CritiqueRecipe {
  readonly context?: string;
  readonly subject: JsonObject;
  readonly evidence?: readonly EvidenceRecipe[];
}

export async function critiqueInput(recipe: CritiqueRecipe): Promise<CritiqueInput> {
  const subject = recipe.subject;
  const strategy = artefactFrom(recipeOf(subject.artefact));
  const built: JsonObject = {
    strategy_hash: (subject.strategy_hash as string | undefined) ?? (await digest(strategy)),
    strategy,
    source_refs: (subject.source_refs as string[] | undefined) ?? [],
    ...(subject.claims === undefined ? {} : { claims: subject.claims }),
  };
  return {
    context: await loadContext(recipe.context),
    subject: built as unknown as CritiqueSubject,
    evidence: await evidenceItems(recipe.evidence as EvidenceRecipe[] | undefined),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------------------------------------------

export interface ResponseSpec {
  readonly response?: JsonValue;
  readonly response_text?: string;
  readonly response_pad?: { readonly base: JsonValue; readonly bytes: number };
}

/** The exact output text of a fixture: a JSON document, raw text, or a document padded with spaces to a size. */
export async function responseText(spec: ResponseSpec): Promise<string> {
  if (spec.response_text !== undefined) return spec.response_text;
  if (spec.response_pad !== undefined) {
    const base = JSON.stringify(await resolvePlaceholders(spec.response_pad.base));
    const used = new TextEncoder().encode(base).byteLength;
    if (used > spec.response_pad.bytes) throw new Error('the padded response is larger than its target size');
    return base + ' '.repeat(spec.response_pad.bytes - used);
  }
  if (spec.response === undefined) throw new Error('a fixture needs a response, response_text or response_pad');
  return JSON.stringify(await resolvePlaceholders(spec.response));
}

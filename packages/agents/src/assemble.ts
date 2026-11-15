// Pure request assembly for the two role modules (OQ-03 sections 3 and 4).
//
// Assembly fills every field of a role request from trusted host context. The proposer request carries the seed
// source or the registered parent, the development-window evidence and findings that the host selected, the permitted
// operators with their bounds, the frozen policy and the holdout exclusions that name V and H. The critic request
// carries one registered Strategy Version. Neither request carries a result of the candidate: critique follows
// registration and precedes evaluation. The module reads no filesystem: the instructions come from the generated
// bundle module, and the request binds the bundle hash.
//
// A refusal is a value, not an exception. The host turns it into a blocked task with its reason (OQ-03 section 4):
// nothing is dispatched, and nothing is repaired or replaced silently. Worker-safe: no Node module.

import { type ArtefactRef, CanonicalError, canonicalJson, digest, digestBytes } from '@openquant/api-contracts';
import { BUNDLE_HASH, PROCEDURES, SUPPLIED_METHODS } from '../dist/generated/bundle.ts';
import { parseRole, type RoleContractName } from './contract.ts';
import { datesInExclusions, exclusionIssues } from './holdout.ts';
import { asJson, jsonEqual, utf8Bytes } from './json.ts';
import { skillEntry } from './registry.ts';
import type {
  CritiqueSubject,
  EvidenceItem,
  FormulationSubject,
  RoleContext,
  StrategyCritiqueRequest,
  StrategyFormulationRequest,
} from './types.ts';

export type RefusalCode =
  | 'REQUEST_INVALID'
  | 'REQUEST_TOO_LARGE'
  | 'HOLDOUT_EXCLUSIONS_INVALID'
  | 'HOLDOUT_OVERLAP'
  | 'OPERATORS_MISMATCH'
  | 'DUPLICATE_EVIDENCE_ID'
  | 'PARENT_HASH_MISMATCH'
  | 'STRATEGY_HASH_MISMATCH'
  | 'EVIDENCE_NOT_PERMITTED'
  | 'REQUEST_NOT_CANONICAL'
  | 'METHODS_MISMATCH';

export interface Refusal {
  readonly code: RefusalCode;
  readonly detail: string;
  /** A JSON Pointer into the request, where one applies. */
  readonly pointer?: string;
}

export type Assembly<R> =
  | {
      readonly ok: true;
      readonly request: R;
      /** The canonical JSON text of the request: what the artefact digest covers. */
      readonly text: string;
      readonly artefact: ArtefactRef;
      /** The role procedure from the bundle module: the instructions of the executor. */
      readonly instructions: string;
      readonly bundle_hash: string;
    }
  | { readonly ok: false; readonly refusals: readonly Refusal[] };

export interface FormulationInput {
  readonly context: RoleContext;
  readonly subject: FormulationSubject;
  /** Authorised evidence: per-stock findings, earlier hypotheses, failed trials, development-window results and diagnostics of a rejected draft. */
  readonly evidence: readonly EvidenceItem[];
}

export interface CritiqueInput {
  readonly context: RoleContext;
  readonly subject: CritiqueSubject;
  readonly evidence: readonly EvidenceItem[];
}

function refuse<R>(...refusals: Refusal[]): Assembly<R> {
  return { ok: false, refusals };
}

// The checks that both roles share, on a request that already passed its schema.
function sharedRefusals(context: RoleContext, evidence: readonly EvidenceItem[]): Refusal[] {
  const refusals: Refusal[] = [];
  for (const issue of exclusionIssues(context.holdout_exclusions, context.evaluation_policy)) {
    refusals.push({ code: 'HOLDOUT_EXCLUSIONS_INVALID', detail: issue, pointer: '/context/holdout_exclusions' });
  }
  if (!jsonEqual(context.operators, context.evaluation_policy.conditions.operators)) {
    refusals.push({
      code: 'OPERATORS_MISMATCH',
      detail: 'the permitted operators are not the operators of the frozen cohort policy',
      pointer: '/context/operators',
    });
  }
  const seen = new Set<string>();
  evidence.forEach((item, index) => {
    if (seen.has(item.id)) {
      refusals.push({
        code: 'DUPLICATE_EVIDENCE_ID',
        detail: `evidence id ${item.id} is used twice`,
        pointer: `/evidence_refs/${index}/id`,
      });
    }
    seen.add(item.id);
    const dates = datesInExclusions(item.content, context.holdout_exclusions);
    if (dates.length > 0) {
      refusals.push({
        code: 'HOLDOUT_OVERLAP',
        detail: `evidence ${item.id} mentions ${dates.slice(0, 3).join(', ')}, inside a withheld window`,
        pointer: `/evidence_refs/${index}/content`,
      });
    }
  });
  return refusals;
}

async function finish<R>(
  contract: RoleContractName,
  skill: 'strategy-formulation' | 'strategy-critique',
  request: unknown,
  extra: (parsed: R) => Promise<Refusal[]>,
): Promise<Assembly<R>> {
  let text: string;
  try {
    text = canonicalJson(request);
  } catch (error) {
    if (error instanceof CanonicalError) return refuse({ code: 'REQUEST_INVALID', detail: error.message });
    throw error;
  }
  const size = utf8Bytes(text).byteLength;
  const limit = skillEntry(skill)?.limits.request_bytes ?? 0;
  if (size > limit) {
    return refuse({ code: 'REQUEST_TOO_LARGE', detail: `the request is ${size} bytes; the limit is ${limit}` });
  }
  const parsed = parseRole(contract, text);
  if (!parsed.ok) return refuse({ code: 'REQUEST_INVALID', detail: parsed.diagnostic });
  const refusals = await extra(parsed.value as R);
  if (refusals.length > 0) return { ok: false, refusals };
  return {
    ok: true,
    request: parsed.value as R,
    text,
    artefact: { digest: await digestBytes(utf8Bytes(text)), media_type: 'application/json', size_bytes: size },
    instructions: PROCEDURES[skill],
    bundle_hash: BUNDLE_HASH,
  };
}

async function formulationRefusals(parsed: StrategyFormulationRequest): Promise<Refusal[]> {
  const refusals = sharedRefusals(parsed.context, parsed.evidence_refs);
  const { subject } = parsed;
  if (subject.proposal_kind === 'controlled_revision') {
    const actual = await digest(asJson(subject.parent));
    if (actual !== subject.parent_hash) {
      refusals.push({
        code: 'PARENT_HASH_MISMATCH',
        detail: 'parent_hash is not the digest of the registered parent artefact',
        pointer: '/subject/parent_hash',
      });
    }
  }
  return refusals;
}

async function critiqueRefusals(parsed: StrategyCritiqueRequest): Promise<Refusal[]> {
  const refusals = sharedRefusals(parsed.context, parsed.evidence_refs);
  const actual = await digest(asJson(parsed.subject.strategy));
  if (actual !== parsed.subject.strategy_hash) {
    refusals.push({
      code: 'STRATEGY_HASH_MISMATCH',
      detail:
        'strategy_hash is not the digest of the registered strategy artefact; an unregistered draft is never critiqued',
      pointer: '/subject/strategy_hash',
    });
  }
  parsed.evidence_refs.forEach((item, index) => {
    if (item.kind === 'evaluation_metrics') {
      refusals.push({
        code: 'EVIDENCE_NOT_PERMITTED',
        detail: `evidence ${item.id} holds evaluation metrics; critique precedes evaluation`,
        pointer: `/evidence_refs/${index}/kind`,
      });
    }
  });
  return refusals;
}

/**
 * Assemble the request of the proposer. `supplied_methods` comes from the bundle module, never from the caller: the
 * baseline bundle supplies none. A controlled revision names the registered parent by the digest of its artefact.
 */
export async function assembleFormulationRequest(
  input: FormulationInput,
): Promise<Assembly<StrategyFormulationRequest>> {
  const request = {
    schema_version: 'strategy-formulation.request/1',
    context: input.context,
    subject: input.subject,
    evidence_refs: input.evidence,
    supplied_methods: SUPPLIED_METHODS,
  };
  return finish<StrategyFormulationRequest>(
    'strategy-formulation.request',
    'strategy-formulation',
    request,
    formulationRefusals,
  );
}

/**
 * Assemble the request of the critic. The subject must be a registered Strategy Version: `strategy_hash` is the
 * digest of the registered artefact, so a hash that the proposer computed for a draft never binds. The request
 * carries no evaluation metrics: critique precedes evaluation.
 */
export async function assembleCritiqueRequest(input: CritiqueInput): Promise<Assembly<StrategyCritiqueRequest>> {
  const request = {
    schema_version: 'strategy-critique.request/1',
    context: input.context,
    subject: input.subject,
    evidence_refs: input.evidence,
    supplied_methods: SUPPLIED_METHODS,
  };
  return finish<StrategyCritiqueRequest>('strategy-critique.request', 'strategy-critique', request, critiqueRefusals);
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

interface RequestOf {
  readonly 'strategy-formulation.request': StrategyFormulationRequest;
  readonly 'strategy-critique.request': StrategyCritiqueRequest;
}

export type RequestContractName = keyof RequestOf;

/**
 * Check a stored request the way assembly would have built it. The runner calls this on the artefact that the
 * dispatch names: the host that executes a request does not trust that an earlier step assembled it. The request
 * must satisfy its schema, be the canonical text that assembly writes, carry the supplied methods of the bundle module
 * and nothing else, and pass every refusal of assembly: holdout exclusions that name V and H, the operators of the
 * frozen policy, unique evidence ids, no date inside a withheld window in the evidence, the digest of the registered
 * parent or subject, and no run metrics for the critic. A refusal is a value.
 */
export async function verifyRequest<C extends RequestContractName>(
  contract: C,
  bytes: Uint8Array,
): Promise<Assembly<RequestOf[C]>> {
  const skill = contract === 'strategy-formulation.request' ? 'strategy-formulation' : 'strategy-critique';
  const limit = skillEntry(skill)?.limits.request_bytes ?? 0;
  if (bytes.byteLength > limit) {
    return refuse({
      code: 'REQUEST_TOO_LARGE',
      detail: `the request is ${bytes.byteLength} bytes; the limit is ${limit}`,
    });
  }
  const parsed = parseRole(contract, bytes);
  if (!parsed.ok) return refuse({ code: 'REQUEST_INVALID', detail: parsed.diagnostic });
  const request = parsed.value as RequestOf[C];
  const refusals: Refusal[] = [];
  let text: string | undefined;
  try {
    text = canonicalJson(request);
  } catch (error) {
    if (!(error instanceof CanonicalError)) throw error;
    refusals.push({ code: 'REQUEST_INVALID', detail: error.message });
  }
  if (text !== undefined && !sameBytes(utf8Bytes(text), bytes)) {
    refusals.push({
      code: 'REQUEST_NOT_CANONICAL',
      detail: 'the stored request is not the canonical text that request assembly writes',
    });
  }
  if (!jsonEqual(request.supplied_methods, SUPPLIED_METHODS)) {
    refusals.push({
      code: 'METHODS_MISMATCH',
      detail: 'the request supplies other methods than the behaviour bundle supplies',
      pointer: '/supplied_methods',
    });
  }
  refusals.push(
    ...(contract === 'strategy-formulation.request'
      ? await formulationRefusals(request as StrategyFormulationRequest)
      : await critiqueRefusals(request as StrategyCritiqueRequest)),
  );
  if (refusals.length > 0 || text === undefined) return { ok: false, refusals };
  return {
    ok: true,
    request,
    text,
    artefact: { digest: await digestBytes(bytes), media_type: 'application/json', size_bytes: bytes.byteLength },
    instructions: PROCEDURES[skill],
    bundle_hash: BUNDLE_HASH,
  };
}

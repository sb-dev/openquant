// Parsing of role requests and results against the role schemas (OQ-03 section 4, OQ-05 section 7).
//
// The shared contract layer, `parseContract` of @openquant/api-contracts, bundles only the schemas in
// packages/api-contracts/schemas, and its $id grammar has no dot, so it cannot take the role contracts
// (strategy-formulation.request and so on). This adapter applies the same checks in the same order with the
// validators that tools/generate.ts builds from the role schemas and the schemas they reference: the byte limit,
// strict JSON (grammar, duplicate keys, non-integer numbers, integers above 2^53 - 1, nesting), the version tag and
// the schema, with the validator that stops at the first error. A rejection carries one bounded diagnostic. It maps
// onto the malformed-result reasons of agent-attempt-result/1. When the shared layer bundles the role schemas,
// this file reduces to a call of `parseContract`.
//
// A role result holds a strategy draft, so it is parsed within the strategy-artefact/1 Worker limit, 512 KiB
// (OQ-05 section 7).

import { parseStrictJson, StrictJsonError, workerBodyLimit } from '@openquant/api-contracts';
import { type ContractName, type ContractTypes, contracts } from '../dist/generated/contracts.ts';
import {
  byContract,
  ControlledRevisionProposal,
  NewFamilyProposal,
  SeedTranslationProposal,
} from '../dist/generated/validators-first.js';
import { cutText, isObject, printable, utf8Bytes } from './json.ts';

/** The longest role request or result, in UTF-8 bytes: the Worker limit of a strategy artefact, 512 KiB. */
export const ROLE_BODY_LIMIT: number = workerBodyLimit('strategy-artefact');
/** The longest diagnostic (`AgentDiagnostic` of agent-attempt-result/1), in characters. */
export const DIAGNOSTIC_LIMIT = 2000;

export type RoleContractName = ContractName;
export type { ContractTypes };

/** The reasons of a malformed result (`AgentMalformedResult` of agent-attempt-result/1). */
export type MalformedReason =
  | 'NOT_JSON'
  | 'SCHEMA_INVALID'
  | 'REFERENCE_INVALID'
  | 'RULE_CHANGES_MISMATCH'
  | 'IDENTITY_MISMATCH'
  | 'OUTPUT_LIMIT_EXCEEDED';

export interface Malformed {
  readonly ok: false;
  readonly reason: MalformedReason;
  /** Bounded, printable and free of credentials: at most DIAGNOSTIC_LIMIT characters. */
  readonly diagnostic: string;
}

export type RoleParse<T> = { readonly ok: true; readonly value: T } | Malformed;

export function malformed(reason: MalformedReason, diagnostic: string): Malformed {
  return { ok: false, reason, diagnostic: cutText(printable(diagnostic), DIAGNOSTIC_LIMIT) };
}

export function isRoleContract(name: string): name is RoleContractName {
  return Object.hasOwn(contracts, name);
}

// The validator of the oneOf branch that a proposal kind selects. A failing oneOf lists the first error of every
// branch, so the diagnostic is taken from the branch that the document chose for itself: it points at the real defect.
const BRANCH_OF_KIND: Readonly<Record<string, typeof SeedTranslationProposal>> = {
  seed_translation: SeedTranslationProposal,
  controlled_revision: ControlledRevisionProposal,
  new_family: NewFamilyProposal,
};

interface ValidatorError {
  readonly instancePath: string;
  readonly schemaPath: string;
  readonly keyword: string;
  readonly params: Readonly<Record<string, unknown>>;
  readonly message?: string;
}

function describe(error: ValidatorError): string {
  const added =
    error.keyword === 'additionalProperties' ? ` (${String(error.params.additionalProperty).slice(0, 64)})` : '';
  return `${error.instancePath || '/'} ${error.message ?? error.keyword}${added}`;
}

function schemaDiagnostic(value: unknown, errors: readonly ValidatorError[] | null | undefined): string {
  const kind = isObject(value) && typeof value.proposal_kind === 'string' ? value.proposal_kind : undefined;
  const branch = kind !== undefined && Object.hasOwn(BRANCH_OF_KIND, kind) ? BRANCH_OF_KIND[kind] : undefined;
  if (branch !== undefined && !branch(value)) {
    const own = branch.errors?.[0];
    if (own !== undefined) return describe(own);
  }
  const all = errors ?? [];
  const chosen = all.find((error) => error.keyword !== 'oneOf') ?? all[0];
  return chosen === undefined ? 'the schema rejected the document' : describe(chosen);
}

/**
 * Parse a role request or result as one role contract: at most `limit` bytes, then strict JSON, then the version tag,
 * then the schema. Never throws for a bad payload. The reasons follow agent-attempt-result/1: OUTPUT_LIMIT_EXCEEDED
 * above the limit, NOT_JSON for text that is not valid UTF-8 JSON, SCHEMA_INVALID for everything else that is wrong
 * with the document itself.
 */
export function parseRole<C extends RoleContractName>(
  contract: C,
  input: string | Uint8Array,
  limit: number = ROLE_BODY_LIMIT,
): RoleParse<ContractTypes[C]> {
  const size = typeof input === 'string' ? utf8Bytes(input).byteLength : input.byteLength;
  if (size > limit) return malformed('OUTPUT_LIMIT_EXCEEDED', `the document is ${size} bytes; the limit is ${limit}`);
  let value: unknown;
  try {
    value = parseStrictJson(input);
  } catch (error) {
    if (error instanceof StrictJsonError) {
      return malformed(error.kind === 'json' ? 'NOT_JSON' : 'SCHEMA_INVALID', error.message);
    }
    throw error;
  }
  const expected = contracts[contract].versionTag;
  const found = isObject(value) && Object.hasOwn(value, 'schema_version') ? value.schema_version : undefined;
  if (typeof found !== 'string') return malformed('SCHEMA_INVALID', 'missing or non-string schema_version');
  if (found !== expected) {
    return malformed(
      'SCHEMA_INVALID',
      `unsupported schema_version ${JSON.stringify(found.slice(0, 64))}; expected ${JSON.stringify(expected)}`,
    );
  }
  const validate = byContract[contract];
  if (validate(value)) return { ok: true, value: value as ContractTypes[C] };
  return malformed('SCHEMA_INVALID', schemaDiagnostic(value, validate.errors));
}

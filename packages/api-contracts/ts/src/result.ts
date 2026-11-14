// The API's check of a submitted evaluation-result/1 before it commits the result as official
// (OQ-05 sections 4 and 7).
//
// A Worker parses a whole contract only within that contract's Worker byte limit, 512 KiB for
// evaluation-result/1 (validate.ts). A result within the S0 limits can be larger:
// packages/quant-core/tests/result_size_bound.rs measures 2,369,582 bytes, most of them signal
// records with 32 indicators each, and such a document can hold more values than a Worker can build.
// The API therefore never parses a whole result. scanEvaluationResult reads the whole document, up to
// RESULT_SCAN_LIMIT bytes, with every strict-JSON rule and the structural limits of limits.ts on
// every array, object and string. It builds only the head: every top-level member except journal and
// final, at most MAX_NODES values. The head is validated against the evaluation-result/1 schema with
// journal and final, when present, replaced by minimal valid values, so a missing, unknown or invalid
// top-level member is rejected as parseContract would reject it. The API then binds the head to the
// request and the submission. The content of journal and final is checked only for its grammar and
// structural limits here: the Rust evaluate job validates the whole result before it uploads it.
//
// Memory: the bytes, the decoded text and the head. test/memory.test.ts scans the densest documents
// at RESULT_SCAN_LIMIT within 64 MB.

import type { EvaluationResult } from '../dist/generated/types.ts';
import type { ContractError } from './errors.ts';
import { MAX_ARRAY_LEN, MAX_NODES, MAX_OBJECT_KEYS, MAX_STRING_BYTES } from './limits.ts';
import { utf8Length } from './platform.ts';
import { type JsonObject, StrictJsonError, scanStrictJson } from './strict-json.ts';
import { checkScanned, reject } from './validate.ts';

/**
 * The largest evaluation-result/1, in UTF-8 bytes, that the API scans before it commits it. It is
 * more than twice the largest result the S0 limits allow (result_size_bound.rs). The API refuses to
 * commit a larger result with LIMIT_EXCEEDED, and the run fails as a platform failure.
 */
export const RESULT_SCAN_LIMIT = 8 * 1024 * 1024;

/** The top-level members of a result that the API builds and binds. */
export type EvaluationResultHead = Omit<EvaluationResult, 'journal' | 'final'>;

/** The members read for their grammar and structural limits only. */
const UNBUILT = ['journal', 'final'] as const;

/** Minimal valid values that stand in for the unbuilt members during validation. */
function standIns(): Record<(typeof UNBUILT)[number], JsonObject> {
  return {
    journal: {
      signals: [],
      entries: [],
      fills: [],
      trades: [],
      cash_ledger: [],
      daily: [],
      corporate_actions: [],
      next_seq: 0,
    },
    final: {
      cash_available: '0',
      cash_reserved: '0',
      receivables: '0',
      positions_value: '0',
      equity: '0',
      open_positions: [],
    },
  };
}

type HeadResult =
  | { readonly ok: true; readonly value: EvaluationResultHead }
  | { readonly ok: false; readonly error: ContractError };

/**
 * Check a submitted evaluation-result/1 without building journal and final: strict JSON and the
 * structural limits over the whole text, then the version, the value bound of the head and the
 * schema, as parseContract checks them. Never throws for a bad payload. A payload above
 * RESULT_SCAN_LIMIT is refused as too-large.
 */
export function scanEvaluationResult(input: string | Uint8Array): HeadResult {
  const size = typeof input === 'string' ? utf8Length(input) : input.byteLength;
  if (size > RESULT_SCAN_LIMIT) {
    return reject('too-large', `result of ${size} bytes exceeds the scan limit of ${RESULT_SCAN_LIMIT}`);
  }
  try {
    const { value, unsafeInteger, exceededValueBound, skipped } = scanStrictJson(input, {
      valueBound: MAX_NODES,
      skip: UNBUILT,
      limits: { maxArrayItems: MAX_ARRAY_LEN, maxObjectKeys: MAX_OBJECT_KEYS, maxStringBytes: MAX_STRING_BYTES },
    });
    const stand = standIns();
    let document = value;
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      document = { ...value };
      for (const member of UNBUILT) if (skipped?.includes(member)) document[member] = stand[member];
    }
    const checked = checkScanned('evaluation-result', document, unsafeInteger, exceededValueBound);
    if (!checked.ok) return checked;
    const { journal: _journal, final: _final, ...head } = checked.value;
    return { ok: true, value: head };
  } catch (error) {
    if (error instanceof StrictJsonError) return reject(error.kind, error.message);
    throw error;
  }
}

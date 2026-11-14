// The API's check of a submitted evaluation-result/1 before it commits the result as official
// (OQ-05 sections 4 and 7).
//
// A Worker parses a whole contract only within that contract's Worker byte limit, 512 KiB for
// evaluation-result/1 (validate.ts). A result within the S0 limits can be larger:
// packages/quant-core/tests/result_size_bound.rs measures 2,369,582 bytes, most of them signal
// records with 32 indicators each, and such a document can hold more values than a Worker can build.
// The API therefore never parses a whole result. scanEvaluationResult reads the whole document, up to
// RESULT_SCAN_LIMIT bytes, with every strict-JSON rule and the array, object, string and key limits
// of limits.ts on every array, object, string and key, but not the value limit. It builds only the
// head: every top-level member except journal and final, at most MAX_NODES values and HEAD_TEXT_BOUND
// bytes of strings and keys. The head is validated against the evaluation-result/1 schema with
// journal and final, when present, replaced by minimal valid values, so a missing, unknown or invalid
// top-level member is rejected as parseContract would reject it. The API then binds the head to the
// request and the submission. The content of journal and final is checked only for its grammar and
// structural limits here: the Rust evaluate job validates the whole result before it uploads it.
//
// Memory. At its peak the scan holds:
// - the body: the bytes, which the caller holds, and the decoded text, which takes one byte a
//   character, or two once any character is outside Latin-1, so at most twice the bytes;
// - the head: at most MAX_NODES values and HEAD_TEXT_BOUND decoded bytes of strings and keys. A string
//   without an escape is a slice of the text; one with an escape is a decoded copy; a stored key is
//   copied again when V8 internalizes it. Past either bound the scan builds nothing more;
// - the parse state: the stack of built array items, and for each open object a set of at most
//   MAX_OBJECT_KEYS hashes and text offsets, without key text, below 128 levels of nesting;
// - transient copies, one at a time: a top-level key or a key compared with a built object's keys,
//   decoded and at most MAX_KEY_BYTES; the top-level schema_version, at most MAX_STRING_BYTES; a number
//   of at most 20 digits. A longer key, string or number is refused before it is decoded or copied;
// - the validation of the head, and its violation listing, which MAX_NODES bounds (limits.ts).
// test/memory.test.ts scans bodies of RESULT_SCAN_LIMIT that maximise each of these: dense journals,
// a head past its value bound, a head of escaped two-byte strings past its text bound, and an escaped
// two-byte key that fills the body at the top level and inside journal. Each stays within 64 MB.

import type { EvaluationResult } from '../dist/generated/types.ts';
import type { ContractError } from './errors.ts';
import { MAX_ARRAY_LEN, MAX_KEY_BYTES, MAX_NODES, MAX_OBJECT_KEYS, MAX_STRING_BYTES } from './limits.ts';
import { utf8Length } from './platform.ts';
import { type JsonObject, StrictJsonError, scanStrictJson } from './strict-json.ts';
import { checkScanned, reject, rejectStrictJson } from './validate.ts';

/**
 * The largest evaluation-result/1, in UTF-8 bytes, that the API scans before it commits it. It is
 * more than twice the largest result the S0 limits allow (result_size_bound.rs). The API refuses to
 * commit a larger result with LIMIT_EXCEEDED, and the run fails as a platform failure.
 */
export const RESULT_SCAN_LIMIT = 8 * 1024 * 1024;

/**
 * The most decoded UTF-8 bytes of strings and keys that the scan builds in the head. A valid head
 * holds at most 8,729 (test/result.test.ts derives the most from the schema), so only an invalid
 * head passes it. Past it the scan builds nothing more and the result is refused as SCHEMA_VIOLATION.
 */
export const HEAD_TEXT_BOUND = 64 * 1024;

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
 * array, object, string and key limits over the whole text, then the version, the bounds of the head
 * and the schema, as parseContract checks them. Never throws for a bad payload. A payload above
 * RESULT_SCAN_LIMIT is refused as too-large.
 */
export function scanEvaluationResult(input: string | Uint8Array): HeadResult {
  const size = typeof input === 'string' ? utf8Length(input) : input.byteLength;
  if (size > RESULT_SCAN_LIMIT) {
    return reject('too-large', `result of ${size} bytes exceeds the scan limit of ${RESULT_SCAN_LIMIT}`);
  }
  try {
    const scan = scanStrictJson(input, {
      valueBound: MAX_NODES,
      maxKeyBytes: MAX_KEY_BYTES,
      skip: UNBUILT,
      limits: { maxArrayItems: MAX_ARRAY_LEN, maxObjectKeys: MAX_OBJECT_KEYS, maxStringBytes: MAX_STRING_BYTES },
      textBound: HEAD_TEXT_BOUND,
    });
    const { value, skipped } = scan;
    const stand = standIns();
    let document = value;
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      document = { ...value };
      for (const member of UNBUILT) if (skipped?.includes(member)) document[member] = stand[member];
    }
    const checked = checkScanned('evaluation-result', { ...scan, value: document });
    if (!checked.ok) return checked;
    const { journal: _journal, final: _final, ...head } = checked.value;
    return { ok: true, value: head };
  } catch (error) {
    if (error instanceof StrictJsonError) return rejectStrictJson(error);
    throw error;
  }
}

// Artefacts and registered documents. A document that the API stores (a profile, a policy, a draft, an evaluation
// request) is its canonical JSON, so its SHA-256 equals the digest of its payload (connected-common ArtefactRef). The
// bytes go to the object store first and the artefact row second, in the caller's transaction: an object that no row
// names is harmless and content-addressed, and a row never names bytes that were not stored ("upload results before
// accepting their manifest", OQ-02 section 8).

import type { ArtefactRef, ContractName, ContractTypes } from '@openquant/api-contracts';
import {
  canonicalJson,
  digestBytes,
  parseContract,
  type Sha256Digest,
  validateContract,
} from '@openquant/api-contracts';
import type { Queryable } from '../db/database.ts';
import type { ApiEnv } from '../env.ts';

const encoder = new TextEncoder();

export const JSON_MEDIA_TYPE = 'application/json';

export interface StoredDocument {
  readonly ref: ArtefactRef;
  readonly bytes: Uint8Array;
}

/** Store canonical JSON bytes under their digest and record the artefact row. Idempotent. */
export async function storeBytes(
  tx: Queryable,
  env: Pick<ApiEnv, 'objects' | 'clock'>,
  bytes: Uint8Array,
  uploadedBy: string,
  mediaType: string = JSON_MEDIA_TYPE,
): Promise<ArtefactRef> {
  const digest = await digestBytes(bytes);
  await env.objects.put(digest, bytes);
  await tx.query(
    `INSERT INTO artefacts (digest, media_type, size_bytes, stored_at, uploaded_by)
     VALUES ($1, $2, $3, $4, $5) ON CONFLICT (digest) DO NOTHING`,
    [digest, mediaType, bytes.length, env.clock(), uploadedBy],
  );
  return { digest, media_type: mediaType, size_bytes: bytes.length };
}

/** Validate a document against its contract, store its canonical JSON and return the reference. */
export async function storeDocument<C extends ContractName>(
  tx: Queryable,
  env: Pick<ApiEnv, 'objects' | 'clock'>,
  contract: C,
  value: unknown,
  uploadedBy: string,
): Promise<StoredDocument> {
  const checked = validateContract(contract, value);
  if (!checked.ok) {
    // A document that the API builds itself must be valid: this is a defect, not a client error.
    throw new Error(`The API built an invalid ${contract} document: ${checked.error.message}`);
  }
  const bytes = encoder.encode(canonicalJson(value));
  return { ref: await storeBytes(tx, env, bytes, uploadedBy), bytes };
}

/** The reference of an artefact that is already recorded, or undefined. */
export async function artefactRef(tx: Queryable, digest: string): Promise<ArtefactRef | undefined> {
  const { rows } = await tx.query<{ media_type: string; size_bytes: string }>(
    'SELECT media_type, size_bytes FROM artefacts WHERE digest = $1',
    [digest],
  );
  const row = rows[0];
  return row === undefined
    ? undefined
    : { digest: digest as Sha256Digest, media_type: row.media_type, size_bytes: Number(row.size_bytes) };
}

/** Read a stored document by digest and parse it as its contract. Throws when the object is missing or altered. */
export async function loadDocument<C extends ContractName>(
  env: Pick<ApiEnv, 'objects'>,
  contract: C,
  digest: string,
): Promise<ContractTypes[C]> {
  const bytes = await env.objects.get(digest as Sha256Digest);
  if (bytes === null) throw new Error(`The object ${digest} is not in the object store.`);
  if ((await digestBytes(bytes)) !== digest) throw new Error(`The object ${digest} does not match its digest.`);
  const parsed = parseContract(contract, bytes);
  if (!parsed.ok) throw new Error(`The stored ${contract} ${digest} no longer parses: ${parsed.error.message}`);
  return parsed.value;
}

// References to stored artefacts, as the attempt routes check them (OQ-05 sections 4, 5 and 7). A worker uploads its
// artefacts first and cites them by digest and size afterwards; "unregistered artefacts are not evidence" (OQ-02 section
// 8), so a citation of an artefact that no row records, or with another size, is refused. A stored document is parsed
// only within the byte limit of its contract, because the Worker never builds a larger one (OQ-05 section 7).

import type { ArtefactRef, ContractError, ContractName, ContractTypes } from '@openquant/api-contracts';
import { digestBytes, parseContract, type Sha256Digest, workerBodyLimit } from '@openquant/api-contracts';
import type { Queryable } from '../db/database.ts';
import type { ApiEnv } from '../env.ts';
import { ApiFailure, fromContractError } from '../errors.ts';

/** A contract failure as the answer of a result route: INVALID_DECIMAL is not in their lists, so it is a schema violation. */
export function contractFailure(error: ContractError): ApiFailure {
  const failure = fromContractError(error);
  return failure.code === 'INVALID_DECIMAL'
    ? new ApiFailure('SCHEMA_VIOLATION', failure.message, { violations: failure.violations })
    : failure;
}

/** The citation must name an artefact that a row records, with the size that the citation states. */
export async function requireStoredRef(tx: Queryable, ref: ArtefactRef, what: string): Promise<void> {
  const { rows } = await tx.query<{ size_bytes: string }>('SELECT size_bytes FROM artefacts WHERE digest = $1', [
    ref.digest,
  ]);
  const stored = rows[0];
  if (stored === undefined || Number(stored.size_bytes) !== ref.size_bytes) {
    throw new ApiFailure(
      'IDENTITY_MISMATCH',
      `The ${what} is not an uploaded artefact with this digest and size: upload it before it is cited.`,
    );
  }
}

/** The bytes of a recorded artefact, verified against its digest. A recorded artefact that is missing is a defect. */
export async function storedBytes(env: Pick<ApiEnv, 'objects'>, digest: string): Promise<Uint8Array> {
  const bytes = await env.objects.get(digest as Sha256Digest);
  if (bytes === null) throw new Error(`The recorded artefact ${digest} is not in the object store.`);
  if ((await digestBytes(bytes)) !== digest) throw new Error(`The stored object ${digest} does not match its digest.`);
  return bytes;
}

/**
 * Load a cited artefact as its contract, within the Worker byte limit of that contract. A document that a worker
 * uploaded and that does not parse is the worker's fault (SCHEMA_VIOLATION); one above the limit is LIMIT_EXCEEDED.
 */
export async function loadCited<C extends ContractName>(
  tx: Queryable,
  env: Pick<ApiEnv, 'objects'>,
  contract: C,
  ref: ArtefactRef,
  what: string,
): Promise<ContractTypes[C]> {
  await requireStoredRef(tx, ref, what);
  if (ref.size_bytes > workerBodyLimit(contract)) {
    throw new ApiFailure('LIMIT_EXCEEDED', `The ${what} is larger than the limit of a ${contract} document.`);
  }
  const parsed = parseContract(contract, await storedBytes(env, ref.digest));
  if (!parsed.ok) throw contractFailure(parsed.error);
  return parsed.value;
}

function isRef(value: unknown): value is ArtefactRef {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.digest === 'string' &&
    typeof record.media_type === 'string' &&
    typeof record.size_bytes === 'number' &&
    Object.keys(record).length === 3
  );
}

/** Every artefact reference that a JSON document holds, at any depth, in document order. */
export function referencesIn(value: unknown, found: ArtefactRef[] = []): ArtefactRef[] {
  if (isRef(value)) {
    found.push(value);
    return found;
  }
  if (Array.isArray(value)) for (const item of value) referencesIn(item, found);
  else if (typeof value === 'object' && value !== null)
    for (const item of Object.values(value)) referencesIn(item, found);
  return found;
}

export interface DispatchRecord {
  readonly destination: 'BATCH_QUEUE' | 'AGENT_RUNNER';
  readonly message: Record<string, unknown>;
  readonly digest: string;
  readonly status: 'PENDING' | 'SENT' | 'CANCELLED';
}

/** The dispatch message of an attempt, as the outbox stored it. */
export async function dispatchOf(tx: Queryable, attemptId: string): Promise<DispatchRecord> {
  const { rows } = await tx.query<{
    destination: DispatchRecord['destination'];
    message: Record<string, unknown>;
    message_digest: string;
    status: DispatchRecord['status'];
  }>('SELECT destination, message, message_digest, status FROM outbox WHERE attempt_id = $1', [attemptId]);
  const row = rows[0];
  if (row === undefined) throw new Error(`The attempt ${attemptId} has no outbox entry.`);
  return { destination: row.destination, message: row.message, digest: row.message_digest, status: row.status };
}

/** The request artefact that a retrieve or evaluate message names. */
export function requestRefOf(message: Record<string, unknown>): ArtefactRef {
  const inputs = message.inputs as { request?: ArtefactRef } | undefined;
  if (inputs?.request === undefined) throw new Error('The dispatch message names no request.');
  return inputs.request;
}

export interface ClaimedExecutable {
  readonly name: string;
  readonly version: string;
  readonly digest: string;
}

/** The executable that claimed the attempt (attempt-claim/1): results must come from the same one. */
export async function claimedExecutable(tx: Queryable, attemptId: string): Promise<ClaimedExecutable> {
  const { rows } = await tx.query<{ name: string | null; version: string | null; digest: string | null }>(
    'SELECT executable_name AS name, executable_version AS version, executable_digest AS digest FROM attempts WHERE attempt_id = $1',
    [attemptId],
  );
  const row = rows[0];
  if (row?.name == null || row.version == null || row.digest == null) {
    throw new Error(`The attempt ${attemptId} was not claimed: it has no executable.`);
  }
  return { name: row.name, version: row.version, digest: row.digest };
}

export function sameExecutable(
  left: { name: string; version: string; digest: string },
  right: { name: string; version: string; digest: string },
): boolean {
  return left.name === right.name && left.version === right.version && left.digest === right.digest;
}

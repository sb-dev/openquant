// The content-addressed object store (OQ-05 section 5): immutable inputs, results and checkpoints in R2, keyed by the
// SHA-256 of their bytes. The Worker verifies the hash before it writes, so a key can never hold other bytes than its
// digest names. Fly hosts hold no R2 credentials; they upload through attempt-scoped routes (D13).

import { digestBytes, type Sha256Digest } from '@openquant/api-contracts';

export interface StoredObject {
  readonly size: number;
}

export interface ObjectStore {
  /** Store bytes under their digest. Throws DigestMismatchError when the bytes do not hash to it. Idempotent. */
  put(digest: Sha256Digest, bytes: Uint8Array): Promise<void>;
  get(digest: Sha256Digest): Promise<Uint8Array | null>;
  head(digest: Sha256Digest): Promise<StoredObject | null>;
}

export class DigestMismatchError extends Error {
  readonly expected: string;
  readonly actual: string;

  constructor(expected: string, actual: string) {
    super('The bytes do not match the declared SHA-256 digest.');
    this.name = 'DigestMismatchError';
    this.expected = expected;
    this.actual = actual;
  }
}

const DIGEST = /^sha256:([0-9a-f]{64})$/;

/** `sha256/<64 hex digits>`: the object key of a digest. */
export function objectKey(digest: string): string {
  const match = DIGEST.exec(digest);
  if (!match) throw new Error('A digest is sha256: followed by 64 lower-case hex digits.');
  return `sha256/${match[1]}`;
}

/** Throws unless the bytes hash to the digest. */
export async function verifyDigest(digest: Sha256Digest, bytes: Uint8Array): Promise<void> {
  const actual = await digestBytes(bytes);
  if (actual !== digest) throw new DigestMismatchError(digest, actual);
}

export function createR2ObjectStore(bucket: R2Bucket): ObjectStore {
  return {
    async put(digest, bytes) {
      await verifyDigest(digest, bytes);
      const key = objectKey(digest);
      // The same bytes under the same key are the same object: an upload that repeats stores nothing new.
      if ((await bucket.head(key)) !== null) return;
      await bucket.put(key, bytes, { sha256: digest.slice('sha256:'.length) });
    },
    async get(digest) {
      const object = await bucket.get(objectKey(digest));
      return object === null ? null : new Uint8Array(await object.arrayBuffer());
    },
    async head(digest) {
      const object = await bucket.head(objectKey(digest));
      return object === null ? null : { size: object.size };
    },
  };
}

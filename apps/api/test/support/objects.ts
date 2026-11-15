// An in-memory object store with the contract of src/store/objects.ts: a test double for the R2 adapter. It verifies
// the digest like the real adapter does, so a test that stores wrong bytes fails the same way.

import type { Sha256Digest } from '@openquant/api-contracts';
import { type ObjectStore, objectKey, verifyDigest } from '../../src/store/objects.ts';

export interface MemoryObjectStore extends ObjectStore {
  /** The keys held, in the form of the R2 adapter: sha256/<hex>. */
  keys(): string[];
  /** How many times put was called with bytes that were not yet stored. */
  readonly writes: () => number;
}

export function createMemoryObjectStore(): MemoryObjectStore {
  const objects = new Map<string, Uint8Array>();
  let writes = 0;
  return {
    async put(digest: Sha256Digest, bytes: Uint8Array): Promise<void> {
      await verifyDigest(digest, bytes);
      const key = objectKey(digest);
      if (objects.has(key)) return;
      objects.set(key, bytes.slice());
      writes += 1;
    },
    async get(digest: Sha256Digest): Promise<Uint8Array | null> {
      return objects.get(objectKey(digest))?.slice() ?? null;
    },
    async head(digest: Sha256Digest) {
      const bytes = objects.get(objectKey(digest));
      return bytes === undefined ? null : { size: bytes.length };
    },
    keys: () => [...objects.keys()].sort(),
    writes: () => writes,
  };
}

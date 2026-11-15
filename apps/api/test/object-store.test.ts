// The content-addressed object store (OQ-05 section 5): the R2 adapter against a fake bucket, and the in-memory double
// that other tests use. Both keep the same contract, and neither stores bytes under a digest that they do not hash to.

import { createHash, randomBytes } from 'node:crypto';
import type { Sha256Digest } from '@openquant/api-contracts';
import { describe, expect, it } from 'vitest';
import { createR2ObjectStore, DigestMismatchError, type ObjectStore, objectKey } from '../src/store/objects.ts';
import { createMemoryObjectStore } from './support/objects.ts';

const digestOf = (bytes: Uint8Array): Sha256Digest => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

interface FakeBucket {
  readonly objects: Map<string, Uint8Array>;
  readonly puts: { key: string; sha256: unknown }[];
  head(key: string): Promise<{ size: number } | null>;
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>;
  put(key: string, value: Uint8Array, options?: { sha256?: string }): Promise<unknown>;
}

function fakeBucket(): FakeBucket {
  const objects = new Map<string, Uint8Array>();
  const puts: { key: string; sha256: unknown }[] = [];
  return {
    objects,
    puts,
    async head(key) {
      const bytes = objects.get(key);
      return bytes === undefined ? null : { size: bytes.length };
    },
    async get(key) {
      const bytes = objects.get(key);
      return bytes === undefined ? null : { arrayBuffer: async () => bytes.slice().buffer };
    },
    async put(key, value, options) {
      puts.push({ key, sha256: options?.sha256 });
      // R2 verifies the checksum that the caller sends: the fake does the same, with node:crypto.
      if (options?.sha256 !== undefined && options.sha256 !== createHash('sha256').update(value).digest('hex')) {
        throw new Error('checksum mismatch');
      }
      objects.set(key, value.slice());
      return {};
    },
  };
}

const stores: [string, () => { store: ObjectStore; keys: () => string[]; writes: () => number }][] = [
  [
    'the R2 adapter',
    () => {
      const bucket = fakeBucket();
      return {
        store: createR2ObjectStore(bucket as never),
        keys: () => [...bucket.objects.keys()].sort(),
        writes: () => bucket.puts.length,
      };
    },
  ],
  [
    'the in-memory double',
    () => {
      const memory = createMemoryObjectStore();
      return { store: memory, keys: () => memory.keys(), writes: () => memory.writes() };
    },
  ],
];

describe.each(stores)('%s', (_name, make) => {
  it('stores bytes under the key that their SHA-256 gives and returns them', async () => {
    const { store, keys } = make();
    const bytes = new Uint8Array(randomBytes(1000));
    const digest = digestOf(bytes);
    await store.put(digest, bytes);
    expect(keys()).toEqual([`sha256/${createHash('sha256').update(bytes).digest('hex')}`]);
    expect(await store.get(digest)).toEqual(bytes);
    expect(await store.head(digest)).toEqual({ size: 1000 });
  });

  it('refuses bytes that do not hash to the digest, and stores nothing', async () => {
    const { store, keys, writes } = make();
    const bytes = new Uint8Array(randomBytes(64));
    const other = digestOf(new Uint8Array(randomBytes(64)));
    await expect(store.put(other, bytes)).rejects.toBeInstanceOf(DigestMismatchError);
    await expect(store.put(other, bytes)).rejects.toMatchObject({ expected: other, actual: digestOf(bytes) });
    expect(keys()).toEqual([]);
    expect(writes()).toBe(0);
    expect(await store.head(other)).toBeNull();
  });

  it('stores the same bytes once: a repeated upload writes nothing new', async () => {
    const { store, keys, writes } = make();
    const bytes = new Uint8Array(randomBytes(32));
    const digest = digestOf(bytes);
    await store.put(digest, bytes);
    await store.put(digest, bytes);
    await store.put(digest, bytes.slice());
    expect(writes()).toBe(1);
    expect(keys()).toHaveLength(1);
  });

  it('returns null for a digest that was never stored, and keeps empty and large objects', async () => {
    const { store } = make();
    expect(await store.get(digestOf(new Uint8Array([1])))).toBeNull();
    expect(await store.head(digestOf(new Uint8Array([1])))).toBeNull();
    const empty = new Uint8Array(0);
    await store.put(digestOf(empty), empty);
    expect(await store.head(digestOf(empty))).toEqual({ size: 0 });
    expect(await store.get(digestOf(empty))).toEqual(empty);
    const large = new Uint8Array(randomBytes(1024 * 1024));
    await store.put(digestOf(large), large);
    expect((await store.get(digestOf(large)))?.length).toBe(1024 * 1024);
  });

  it('does not share memory with the caller: changing the bytes afterwards changes nothing stored', async () => {
    const { store } = make();
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const digest = digestOf(bytes);
    await store.put(digest, bytes);
    bytes[0] = 9;
    const stored = await store.get(digest);
    expect(stored).toEqual(new Uint8Array([1, 2, 3, 4]));
    (stored as Uint8Array)[1] = 8;
    expect(await store.get(digest)).toEqual(new Uint8Array([1, 2, 3, 4]));
  });
});

describe('the R2 adapter', () => {
  it('sends the checksum to R2, so the platform verifies the bytes a second time', async () => {
    const bucket = fakeBucket();
    const store = createR2ObjectStore(bucket as never);
    const bytes = new Uint8Array(randomBytes(40));
    await store.put(digestOf(bytes), bytes);
    expect(bucket.puts).toEqual([
      { key: objectKey(digestOf(bytes)), sha256: createHash('sha256').update(bytes).digest('hex') },
    ]);
  });

  it('does not overwrite an object that is already there', async () => {
    const bucket = fakeBucket();
    const store = createR2ObjectStore(bucket as never);
    const bytes = new Uint8Array(randomBytes(40));
    await store.put(digestOf(bytes), bytes);
    await store.put(digestOf(bytes), bytes);
    expect(bucket.puts).toHaveLength(1);
  });
});

describe('object keys', () => {
  it('are sha256/<hex>, and a malformed digest has none', () => {
    const hex = 'ab'.repeat(32);
    expect(objectKey(`sha256:${hex}`)).toBe(`sha256/${hex}`);
    for (const bad of [
      '',
      'sha256:',
      `sha256:${hex.toUpperCase()}`,
      `sha512:${hex}`,
      `sha256:${hex}0`,
      `../sha256:${hex}`,
      `sha256:${hex.slice(1)}`,
    ]) {
      expect(() => objectKey(bad), bad).toThrow(/sha256: followed by 64 lower-case hex digits/);
    }
  });
});

// The Web platform members this package uses: fetch, AbortController, setTimeout and WebCrypto. Workers, Node 24 and
// browsers provide them as globals. The package compiles without DOM or Node type libraries (as
// packages/api-contracts/ts/src/platform.ts does), so this module types the few members it needs.

export interface FetchResponse {
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface FetchInit {
  readonly method: 'GET' | 'POST';
  readonly headers: Record<string, string>;
  readonly body?: string;
  readonly signal?: unknown;
}

/** The fetch function the client calls: the global fetch, or a test double such as a Hono app's request method. */
export type Fetch = (url: string, init: FetchInit) => Promise<FetchResponse>;

interface WebPlatform {
  readonly fetch?: Fetch;
  readonly AbortController: new () => { readonly signal: unknown; abort(reason?: unknown): void };
  readonly crypto: { getRandomValues(array: Uint8Array): Uint8Array };
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const web = globalThis as unknown as WebPlatform;

export function globalFetch(): Fetch {
  const fetch = web.fetch;
  if (fetch === undefined) throw new Error('This runtime has no global fetch: pass one to the client.');
  return (url, init) => fetch.call(globalThis, url, init);
}

/** Run `work` with an abort signal that fires after `ms` milliseconds. */
export async function withDeadline<T>(ms: number, work: (signal: unknown) => Promise<T>): Promise<T> {
  const controller = new web.AbortController();
  const timer = web.setTimeout(() => controller.abort(new Error(`no answer within ${ms} ms`)), ms);
  try {
    return await work(controller.signal);
  } finally {
    web.clearTimeout(timer);
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    web.setTimeout(resolve, ms);
  });
}

/** 96 random bits as 24 lowercase hexadecimal digits. */
export function randomHex(): string {
  const bytes = web.crypto.getRandomValues(new Uint8Array(12));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

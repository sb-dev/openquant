// Reading a request body within the limit of its route (OQ-05 section 7: "the API refuses a larger body with
// LIMIT_EXCEEDED before parsing it"). A declared Content-Length above the limit is refused without reading. Without
// one, or with a smaller one that is false, the reader counts bytes and stops at the first byte above the limit,
// so no body is buffered past limit + one chunk. A Worker isolate has 128 MB: never call request.text() on a body
// whose size is not bounded.

import { limitExceeded } from './errors.ts';

export async function readBounded(request: Request, limit: number): Promise<Uint8Array> {
  const declared = request.headers.get('content-length');
  if (declared !== null && /^[0-9]+$/.test(declared) && Number(declared) > limit) {
    await request.body?.cancel().catch(() => undefined);
    throw limitExceeded(limit);
  }
  const stream = request.body;
  if (stream === null) return new Uint8Array(0);
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      throw limitExceeded(limit);
    }
    chunks.push(value);
  }
  if (chunks.length === 1 && chunks[0] !== undefined) return chunks[0];
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

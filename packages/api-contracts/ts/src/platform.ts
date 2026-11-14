// The Web platform APIs this package uses: TextEncoder, TextDecoder and WebCrypto. Workers, Node 24
// and browsers all provide them as globals. The package compiles without DOM or Node type libraries,
// so this module types the few members it needs.

interface WebPlatform {
  readonly crypto: {
    readonly subtle: { digest(algorithm: 'SHA-256', data: Uint8Array): Promise<ArrayBuffer> };
  };
  readonly TextEncoder: new () => { encode(input: string): Uint8Array };
  readonly TextDecoder: new (
    label: 'utf-8',
    options: { fatal: boolean; ignoreBOM: boolean },
  ) => { decode(input: Uint8Array): string };
}

const web = globalThis as unknown as WebPlatform;
const encoder = new web.TextEncoder();
// fatal: invalid UTF-8 is an error. ignoreBOM: a byte order mark stays in the text, where the
// parser rejects it, as serde_json does.
const decoder = new web.TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

export const utf8 = {
  encode: (text: string): Uint8Array => encoder.encode(text),
  /** The text, or undefined when the bytes are not valid UTF-8. */
  decode: (bytes: Uint8Array): string | undefined => {
    try {
      return decoder.decode(bytes);
    } catch {
      return undefined;
    }
  },
};

/** UTF-8 length of a string. A lone surrogate counts as the 3 bytes of its replacement character. */
export function utf8Length(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && (text.charCodeAt(index + 1) & 0xfc00) === 0xdc00) {
      bytes += 4;
      index += 1;
    } else bytes += 3;
  }
  return bytes;
}

/** SHA-256 of bytes as 64 lower-case hex digits. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const hash = new Uint8Array(await web.crypto.subtle.digest('SHA-256', bytes));
  let out = '';
  for (const byte of hash) out += byte.toString(16).padStart(2, '0');
  return out;
}

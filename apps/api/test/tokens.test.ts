// Tokens and encodings (OQ-05 section 9, D12). The MAC is also computed by hand with node:crypto, so a token is not
// checked only against the code that made it.

import { createHmac, randomBytes } from 'node:crypto';
import { parseContract } from '@openquant/api-contracts';
import { describe, expect, it } from 'vitest';
import { constantTimeEqual, fromBase64Url, toBase64Url } from '../src/auth/encoding.ts';
import {
  ACCESS_TOKEN_SECONDS,
  accessTokenExpired,
  parseSigningKey,
  signAccessToken,
  signCapability,
  verifyAccessToken,
  verifyCapability,
} from '../src/auth/tokens.ts';

const key = new Uint8Array(randomBytes(32));
const claims = { sub: 'human-steward', env: 'STAGING', iat: 1_700_000_000, exp: 1_700_000_900 } as const;
const capability = {
  sub: 'svc-batch',
  env: 'STAGING',
  att: 'att-1',
  own: 2,
  iat: 1_700_000_000,
  exp: 1_700_000_300,
} as const;

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
// A token built by hand: node:crypto signs `<prefix>.<payload>`.
function byHand(prefix: string, payload: unknown, withKey: Uint8Array = key): string {
  const body = b64(payload);
  const mac = createHmac('sha256', withKey).update(`${prefix}.${body}`).digest('base64url');
  return `${prefix}.${body}.${mac}`;
}

describe('access tokens', () => {
  it('verify after they are signed, and carry exactly the claims that were signed', async () => {
    const token = await signAccessToken(key, claims);
    expect(await verifyAccessToken(key, token)).toEqual({ ok: true, claims });
    expect(token.startsWith('oqa1.')).toBe(true);
  });

  it('have the MAC that HMAC-SHA-256 over prefix.payload gives, computed independently', async () => {
    const token = await signAccessToken(key, claims);
    const [prefix, payload, mac] = token.split('.') as [string, string, string];
    expect(mac).toBe(createHmac('sha256', key).update(`${prefix}.${payload}`).digest('base64url'));
    expect(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))).toEqual(claims);
    // A token built by hand with the same key verifies.
    expect(await verifyAccessToken(key, byHand('oqa1', claims))).toEqual({ ok: true, claims });
  });

  it('are valid until the expiry second and refused from it: 15 minutes', () => {
    expect(ACCESS_TOKEN_SECONDS).toBe(900);
    const issued = { ...claims, iat: 1000, exp: 1000 + ACCESS_TOKEN_SECONDS };
    expect(accessTokenExpired(issued, 1000)).toBe(false);
    expect(accessTokenExpired(issued, 1899)).toBe(false);
    expect(accessTokenExpired(issued, 1900)).toBe(true);
    expect(accessTokenExpired(issued, 5000)).toBe(true);
  });

  it('are refused after one flipped bit of the payload or of the signature, or a wrong key', async () => {
    const token = await signAccessToken(key, claims);
    const [prefix, payload, mac] = token.split('.') as [string, string, string];
    const flip = (text: string, at: number) => {
      const bytes = Buffer.from(text, 'base64url');
      bytes[at % bytes.length] = (bytes[at % bytes.length] as number) ^ 1;
      return bytes.toString('base64url');
    };
    for (const at of [0, 5, 20]) {
      expect(await verifyAccessToken(key, `${prefix}.${flip(payload, at)}.${mac}`)).toEqual({
        ok: false,
        reason: 'signature',
      });
      expect(await verifyAccessToken(key, `${prefix}.${payload}.${flip(mac, at)}`)).toEqual({
        ok: false,
        reason: 'signature',
      });
    }
    expect(await verifyAccessToken(new Uint8Array(randomBytes(32)), token)).toEqual({ ok: false, reason: 'signature' });
  });

  it('are refused when truncated, empty, of another type or not in the alphabet', async () => {
    const token = await signAccessToken(key, claims);
    const [prefix, payload, mac] = token.split('.') as [string, string, string];
    const malformed = [
      '',
      'oqa1',
      'oqa1.',
      'oqa1..',
      `${prefix}.${payload}`,
      `${prefix}.${payload}.${mac}.extra`,
      `${prefix}.${payload}.${mac.slice(0, -2)}`,
      `${prefix}.${payload}+/=.${mac}`,
      `oqp1.${payload}.${mac}`,
      `oqk1.${payload}.${mac}`,
      `${prefix}.%%%.${mac}`,
    ];
    for (const text of malformed) {
      const result = await verifyAccessToken(key, text);
      expect(result.ok, text).toBe(false);
    }
  });

  it('do not verify as capabilities, and a capability does not verify as an access token', async () => {
    const access = await signAccessToken(key, claims);
    const cap = await signCapability(key, capability);
    expect((await verifyCapability(key, access)).ok).toBe(false);
    expect((await verifyAccessToken(key, cap)).ok).toBe(false);
    // The prefix is inside the MAC: a token re-labelled with the other prefix fails its signature.
    const relabelled = `oqp1.${access.split('.').slice(1).join('.')}`;
    expect(await verifyCapability(key, relabelled)).toEqual({ ok: false, reason: 'signature' });
  });

  it('are refused when the signed claims are not an access token, whoever signed them', async () => {
    const bad: unknown[] = [
      { ...claims, sub: 'has space' },
      { ...claims, env: 'LIVE' },
      { ...claims, exp: claims.iat },
      { ...claims, exp: claims.iat - 1 },
      { ...claims, iat: 1.5 },
      { ...claims, iat: -1 },
      { ...claims, extra: true },
      { sub: claims.sub, env: claims.env, iat: claims.iat },
      [],
      'text',
      null,
    ];
    for (const payload of bad)
      expect((await verifyAccessToken(key, byHand('oqa1', payload))).ok, JSON.stringify(payload)).toBe(false);
  });
});

describe('attempt capabilities', () => {
  it('verify, carry the attempt and its ownership revision, and match the pattern of attempt-claim/1', async () => {
    const token = await signCapability(key, capability);
    expect(await verifyCapability(key, token)).toEqual({ ok: true, claims: capability });
    expect(token).toMatch(/^[A-Za-z0-9._~-]{32,512}$/);
    expect(token.startsWith('oqp1.')).toBe(true);
    const grant = {
      schema_version: 'attempt-claim/1',
      form: 'grant',
      attempt: { attempt_id: 'att-1', ownership_revision: 2 },
      granted_at: '2026-11-15T10:00:00Z',
      lease_expires_at: '2026-11-15T10:05:00Z',
      capability: { token },
    };
    expect(parseContract('attempt-claim', JSON.stringify(grant)).ok).toBe(true);
  });

  it('have the MAC computed by hand, and expire with the lease: the expiry is a claim, judged against the lease', async () => {
    const token = await signCapability(key, capability);
    const [prefix, payload, mac] = token.split('.') as [string, string, string];
    expect(mac).toBe(createHmac('sha256', key).update(`${prefix}.${payload}`).digest('base64url'));
    // A capability still verifies after its expiry claim passed: the lease row, not the token, tells why it is dead.
    expect(await verifyCapability(key, token)).toEqual({ ok: true, claims: capability });
  });

  it('are refused when the claims are not a capability', async () => {
    const bad: unknown[] = [
      { ...capability, att: 'bad id' },
      { ...capability, own: 0 },
      { ...capability, own: 1.5 },
      { ...capability, att: undefined },
      { sub: capability.sub, env: capability.env, iat: capability.iat, exp: capability.exp },
      { ...capability, extra: 1 },
    ];
    for (const payload of bad)
      expect((await verifyCapability(key, byHand('oqp1', payload))).ok, JSON.stringify(payload)).toBe(false);
  });
});

describe('the signing key', () => {
  it('is refused when it holds fewer than 32 bytes, for signing and for verifying', async () => {
    const short = new Uint8Array(randomBytes(31));
    await expect(signAccessToken(short, claims)).rejects.toThrow(/at least 32 bytes/);
    await expect(verifyAccessToken(short, await signAccessToken(key, claims))).rejects.toThrow(/at least 32 bytes/);
    await expect(signAccessToken(new Uint8Array(randomBytes(32)), claims)).resolves.toMatch(/^oqa1\./);
  });

  it('is read from base64url text of at least 32 bytes, and an error never echoes the text', () => {
    const good = randomBytes(32).toString('base64url');
    expect(parseSigningKey(good)).toHaveLength(32);
    expect(parseSigningKey(`  ${good}\n`)).toHaveLength(32);
    for (const text of [undefined, '', randomBytes(31).toString('base64url'), `${good}+`, 'not base64 url!!']) {
      expect(() => parseSigningKey(text)).toThrow(/at least 32 bytes/);
      if (text) expect(() => parseSigningKey(text)).toThrow(expect.not.stringContaining(text));
    }
  });
});

describe('encodings', () => {
  it('round-trip base64url for every length of a small range, without padding', () => {
    for (let length = 0; length <= 70; length += 1) {
      const bytes = new Uint8Array(randomBytes(length));
      const text = toBase64Url(bytes);
      expect(text).toBe(Buffer.from(bytes).toString('base64url'));
      expect(text).not.toMatch(/[+/=]/);
      expect(fromBase64Url(text)).toEqual(bytes);
    }
  });

  it('refuse text outside the alphabet and a length that no byte string has', () => {
    for (const text of ['a+b', 'a/b', 'ab==', 'a b', 'é', 'a', 'abcde'])
      expect(fromBase64Url(text), text).toBeUndefined();
    expect(fromBase64Url('')).toEqual(new Uint8Array(0));
  });

  it('compare byte strings of equal and different length', () => {
    const a = new Uint8Array([1, 2, 3]);
    expect(constantTimeEqual(a, new Uint8Array([1, 2, 3]))).toBe(true);
    expect(constantTimeEqual(a, new Uint8Array([1, 2, 4]))).toBe(false);
    expect(constantTimeEqual(a, new Uint8Array([1, 2]))).toBe(false);
    expect(constantTimeEqual(new Uint8Array([]), new Uint8Array([]))).toBe(true);
    expect(constantTimeEqual(new Uint8Array([0]), new Uint8Array([]))).toBe(false);
  });
});

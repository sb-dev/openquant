// App-issued tokens (OQ-05 section 9, decision D12), signed with WebCrypto.
//
//   oqa1.<payload>.<signature>   access token of a person: 15 minutes, subject only; roles are read per request
//   oqp1.<payload>.<signature>   attempt capability: valid for one attempt, to the end of its lease
//
// The payload is base64url JSON and the signature is HMAC-SHA-256 over `<prefix>.<payload>`, so a token of one type
// never verifies as the other. Verification here checks the signature and the shape, not the time: an access token is
// refused at its expiry (accessTokenExpired), while a capability is judged against its lease row, because a late
// submission from an expired lease must be told LEASE_EXPIRED or STALE_OWNERSHIP, not "unauthenticated" (OQ-05 §4).
// The capability matches the pattern `^[A-Za-z0-9._~-]{32,512}$` of attempt-claim/1.

import type { DeploymentEnvironment } from '../env.ts';
import { DEPLOYMENT_ENVIRONMENTS } from '../env.ts';
import { fromBase64Url, toBase64Url, utf8Bytes } from './encoding.ts';

export const ACCESS_TOKEN_SECONDS = 15 * 60;
export const MIN_KEY_BYTES = 32;
const ACCESS_PREFIX = 'oqa1';
const CAPABILITY_PREFIX = 'oqp1';
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

export interface AccessClaims {
  readonly sub: string;
  readonly env: DeploymentEnvironment;
  /** Issued at and expiry, in seconds since the epoch. The token is valid while now < exp. */
  readonly iat: number;
  readonly exp: number;
}

export interface CapabilityClaims extends AccessClaims {
  readonly att: string;
  readonly own: number;
}

export type TokenCheck<T> =
  | { readonly ok: true; readonly claims: T }
  | { readonly ok: false; readonly reason: 'malformed' | 'signature' };

/** The signing key from its secret text: base64url of at least 32 bytes. Throws without echoing the text. */
export function parseSigningKey(secret: string | undefined): Uint8Array {
  const bytes = secret === undefined ? undefined : fromBase64Url(secret.trim());
  if (bytes === undefined || bytes.length < MIN_KEY_BYTES) {
    throw new Error(`The token signing key must be base64url text of at least ${MIN_KEY_BYTES} bytes.`);
  }
  return bytes;
}

async function hmacKey(key: Uint8Array, usages: ('sign' | 'verify')[]): Promise<CryptoKey> {
  if (key.length < MIN_KEY_BYTES) throw new Error(`The token signing key must hold at least ${MIN_KEY_BYTES} bytes.`);
  return crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, usages);
}

async function sign(key: Uint8Array, prefix: string, claims: object): Promise<string> {
  const payload = toBase64Url(utf8Bytes(JSON.stringify(claims)));
  const mac = await crypto.subtle.sign('HMAC', await hmacKey(key, ['sign']), utf8Bytes(`${prefix}.${payload}`));
  return `${prefix}.${payload}.${toBase64Url(new Uint8Array(mac))}`;
}

async function verify(key: Uint8Array, prefix: string, token: string): Promise<TokenCheck<unknown>> {
  const parts = token.split('.');
  const [head, payload, signature] = parts;
  if (parts.length !== 3 || head !== prefix || payload === undefined || signature === undefined) {
    return { ok: false, reason: 'malformed' };
  }
  const mac = fromBase64Url(signature);
  const bytes = fromBase64Url(payload);
  if (mac === undefined || bytes === undefined) return { ok: false, reason: 'malformed' };
  // crypto.subtle.verify compares the MAC without leaking where it differs.
  const valid = await crypto.subtle.verify(
    'HMAC',
    await hmacKey(key, ['verify']),
    mac,
    utf8Bytes(`${prefix}.${payload}`),
  );
  if (!valid) return { ok: false, reason: 'signature' };
  try {
    return {
      ok: true,
      claims: JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes)) as unknown,
    };
  } catch {
    return { ok: false, reason: 'malformed' };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function seconds(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function baseClaims(value: unknown): AccessClaims | undefined {
  if (!isRecord(value)) return undefined;
  const { sub, env, iat, exp } = value;
  if (typeof sub !== 'string' || !IDENTIFIER.test(sub)) return undefined;
  if (typeof env !== 'string' || !(DEPLOYMENT_ENVIRONMENTS as readonly string[]).includes(env)) return undefined;
  if (!seconds(iat) || !seconds(exp) || exp <= iat) return undefined;
  return { sub, env: env as DeploymentEnvironment, iat, exp };
}

async function check<T>(
  key: Uint8Array,
  prefix: string,
  token: string,
  shape: (claims: unknown) => T | undefined,
): Promise<TokenCheck<T>> {
  const result = await verify(key, prefix, token);
  if (!result.ok) return result;
  const claims = shape(result.claims);
  return claims === undefined ? { ok: false, reason: 'malformed' } : { ok: true, claims };
}

export function signAccessToken(key: Uint8Array, claims: AccessClaims): Promise<string> {
  const { sub, env, iat, exp } = claims;
  return sign(key, ACCESS_PREFIX, { sub, env, iat, exp });
}

export function verifyAccessToken(key: Uint8Array, token: string): Promise<TokenCheck<AccessClaims>> {
  return check(key, ACCESS_PREFIX, token, (claims) => {
    const base = baseClaims(claims);
    // An access token has exactly the four claims: a capability signed under its own prefix cannot pass as one.
    return base !== undefined && isRecord(claims) && Object.keys(claims).length === 4 ? base : undefined;
  });
}

export function signCapability(key: Uint8Array, claims: CapabilityClaims): Promise<string> {
  const { sub, env, iat, exp, att, own } = claims;
  return sign(key, CAPABILITY_PREFIX, { sub, env, att, own, iat, exp });
}

export function verifyCapability(key: Uint8Array, token: string): Promise<TokenCheck<CapabilityClaims>> {
  return check(key, CAPABILITY_PREFIX, token, (claims) => {
    const base = baseClaims(claims);
    if (base === undefined || !isRecord(claims) || Object.keys(claims).length !== 6) return undefined;
    const { att, own } = claims;
    if (typeof att !== 'string' || !IDENTIFIER.test(att)) return undefined;
    if (typeof own !== 'number' || !Number.isSafeInteger(own) || own < 1) return undefined;
    return { ...base, att, own };
  });
}

/** An access token is valid while the time is before its expiry; at the expiry second it is already refused. */
export function accessTokenExpired(claims: AccessClaims, nowSeconds: number): boolean {
  return nowSeconds >= claims.exp;
}

export const tokenPrefixes = { access: ACCESS_PREFIX, capability: CAPABILITY_PREFIX } as const;

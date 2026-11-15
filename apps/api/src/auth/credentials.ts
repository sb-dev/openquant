// Long-lived credentials (OQ-05 section 9): a person's application credential, which only the token route accepts, and
// the environment- and operation-scoped credentials of service principals. A credential is a 256-bit random secret.
// The database stores only a hash of the secret, with a domain prefix, and looks the row up by the credential id, so
// a stolen database holds nothing that can be presented. The secret is shown once, when it is issued.
//
//   oqk1.<credential id>.<secret>

import { writeAudit } from '../audit.ts';
import type { Queryable } from '../db/database.ts';
import type { IdGenerator } from '../env.ts';
import type { Role, ServiceKind } from '../manifest.ts';
import { constantTimeEqualText, randomBytes, sha256Bytes, toBase64Url, toHex, utf8Bytes } from './encoding.ts';

export const CREDENTIAL_PREFIX = 'oqk1';
const CREDENTIAL_TOKEN = /^oqk1\.([A-Za-z0-9][A-Za-z0-9_-]{0,63})\.([A-Za-z0-9_-]{43})$/;

export interface ParsedCredential {
  readonly credentialId: string;
  readonly secret: string;
}

export function parseCredentialToken(token: string): ParsedCredential | undefined {
  const match = CREDENTIAL_TOKEN.exec(token);
  return match?.[1] === undefined || match[2] === undefined ? undefined : { credentialId: match[1], secret: match[2] };
}

async function domainHash(domain: string, text: string): Promise<string> {
  return `sha256:${toHex(await sha256Bytes(utf8Bytes(`${domain}\n${text}`)))}`;
}

/** The stored form of a credential secret. */
export function credentialHash(secret: string): Promise<string> {
  return domainHash('openquant-credential-v1', secret);
}

/** The stored form of an attempt capability token: leases.capability_hash. */
export function capabilityHash(token: string): Promise<string> {
  return domainHash('openquant-capability-v1', token);
}

/** Compare two stored hashes without leaking where they differ. */
export function hashesEqual(left: string, right: string): boolean {
  return constantTimeEqualText(left, right);
}

export interface IssuedCredential {
  readonly credentialId: string;
  /** The credential as the caller presents it. It is returned once and stored nowhere. */
  readonly token: string;
  readonly hash: string;
}

async function newCredential(ids: IdGenerator): Promise<IssuedCredential> {
  const credentialId = ids.next('cred');
  const secret = toBase64Url(randomBytes(32));
  return { credentialId, token: `${CREDENTIAL_PREFIX}.${credentialId}.${secret}`, hash: await credentialHash(secret) };
}

export interface NewPrincipal {
  readonly principalId: string;
  readonly kind: 'HUMAN' | 'SERVICE';
  readonly serviceKind?: ServiceKind;
  readonly displayName: string;
  readonly environment: string;
}

export async function createPrincipal(tx: Queryable, now: Date, principal: NewPrincipal): Promise<void> {
  await tx.query(
    `INSERT INTO principals (principal_id, kind, service_kind, display_name, environment, created_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      principal.principalId,
      principal.kind,
      principal.serviceKind ?? null,
      principal.displayName,
      principal.environment,
      now,
    ],
  );
}

export async function grantRole(
  tx: Queryable,
  now: Date,
  principalId: string,
  role: Role,
  grantedBy: string | null,
): Promise<void> {
  await tx.query('INSERT INTO principal_roles (principal_id, role, granted_by, granted_at) VALUES ($1, $2, $3, $4)', [
    principalId,
    role,
    grantedBy,
    now,
  ]);
}

export interface CredentialRequest {
  readonly principalId: string;
  readonly principalKind: 'HUMAN' | 'SERVICE';
  /** Route ids of a service credential; none for a person. */
  readonly operations?: readonly string[];
  readonly expiresAt?: Date;
  readonly issuedBy: string;
}

/** Issue a credential in the caller's transaction, with its audit row. Only the hash is stored. */
export async function issueCredential(
  tx: Queryable,
  ids: IdGenerator,
  now: Date,
  request: CredentialRequest,
): Promise<IssuedCredential> {
  const issued = await newCredential(ids);
  await tx.query(
    `INSERT INTO credentials (credential_id, principal_id, principal_kind, secret_hash, operations, created_at, expires_at)
     VALUES ($1, $2, $3, $4, $5::text[], $6, $7)`,
    [
      issued.credentialId,
      request.principalId,
      request.principalKind,
      issued.hash,
      request.operations === undefined ? null : [...request.operations],
      now,
      request.expiresAt ?? null,
    ],
  );
  await writeAudit(tx, now, {
    eventType: 'auth.credential_issued',
    actor: request.issuedBy,
    subject: request.principalId,
    detail: { credential_id: issued.credentialId },
  });
  return issued;
}

export async function revokeCredential(
  tx: Queryable,
  now: Date,
  credentialId: string,
  revokedBy: string,
): Promise<void> {
  await tx.query('UPDATE credentials SET revoked_at = $2 WHERE credential_id = $1 AND revoked_at IS NULL', [
    credentialId,
    now,
  ]);
  await writeAudit(tx, now, {
    eventType: 'auth.credential_revoked',
    actor: revokedBy,
    subject: credentialId,
  });
}

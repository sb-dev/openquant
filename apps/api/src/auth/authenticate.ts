// Who is calling (OQ-05 section 9). The Authorization header carries one of three credentials:
//
//   oqk1.…  a long-lived credential: a person's (token route only) or a service principal's, scoped to operations
//   oqa1.…  a person's 15-minute access token; roles come from the database on every request, so a revoked role
//           stops working at once
//   oqp1.…  an attempt capability: valid for one attempt, to the end of its lease
//
// A missing, malformed, unknown, expired, revoked or wrong-environment credential is "not authenticated" (null here;
// the route layer answers UNAUTHENTICATED). Authorisation, which decides FORBIDDEN, is in authorize.ts.

import type { Queryable } from '../db/database.ts';
import type { ApiEnv, DeploymentEnvironment } from '../env.ts';
import type { Role, ServiceKind } from '../manifest.ts';
import { capabilityHash, credentialHash, hashesEqual, parseCredentialToken } from './credentials.ts';
import { accessTokenExpired, tokenPrefixes, verifyAccessToken, verifyCapability } from './tokens.ts';

export interface Principal {
  readonly id: string;
  readonly kind: 'HUMAN' | 'SERVICE';
  readonly serviceKind: ServiceKind | null;
  readonly displayName: string;
}

/**
 * What a valid capability says about its attempt now (OQ-05 section 4):
 * live: the attempt is CLAIMED, its lease is HELD and has not expired;
 * lease_expired: the lease ran out (or was marked expired) and no newer attempt of the same run or job exists;
 * stale: a newer attempt of the same run or job exists, so this one has lost ownership;
 * ended: the attempt completed, failed or was cancelled; its route decides what a repeat gets.
 */
export type AttemptState = 'live' | 'lease_expired' | 'stale' | 'ended';

export interface AttemptAccess {
  readonly attemptId: string;
  readonly ownershipRevision: number;
  readonly state: AttemptState;
  readonly leaseExpiresAt: Date;
  readonly runId: string | null;
  readonly jobId: string | null;
}

export type Caller =
  | { readonly kind: 'human_credential'; readonly principal: Principal; readonly credentialId: string }
  | { readonly kind: 'human'; readonly principal: Principal; readonly roles: readonly Role[] }
  | {
      readonly kind: 'service';
      readonly principal: Principal;
      readonly credentialId: string;
      readonly operations: readonly string[];
    }
  | { readonly kind: 'attempt'; readonly principal: Principal; readonly attempt: AttemptAccess };

interface PrincipalRow {
  principal_id: string;
  kind: 'HUMAN' | 'SERVICE';
  service_kind: ServiceKind | null;
  display_name: string;
  status: string;
  environment: string;
}

function toPrincipal(row: PrincipalRow): Principal {
  return { id: row.principal_id, kind: row.kind, serviceKind: row.service_kind, displayName: row.display_name };
}

function active(row: PrincipalRow, environment: DeploymentEnvironment): boolean {
  return row.status === 'ACTIVE' && row.environment === environment;
}

function bearer(header: string | null): string | undefined {
  const match = /^Bearer ([^\s]+)$/i.exec(header ?? '');
  return match?.[1];
}

async function byCredential(env: ApiEnv, db: Queryable, token: string): Promise<Caller | null> {
  const parsed = parseCredentialToken(token);
  if (parsed === undefined) return null;
  const { rows } = await db.query<
    PrincipalRow & {
      secret_hash: string;
      operations: string[] | null;
      expires_at: Date | null;
      revoked_at: Date | null;
    }
  >(
    `SELECT c.secret_hash, c.operations::text[] AS operations, c.expires_at, c.revoked_at,
            p.principal_id, p.kind, p.service_kind, p.display_name, p.status, p.environment
       FROM credentials c JOIN principals p ON p.principal_id = c.principal_id AND p.kind = c.principal_kind
      WHERE c.credential_id = $1`,
    [parsed.credentialId],
  );
  const row = rows[0];
  const now = env.clock();
  if (row === undefined || row.revoked_at !== null || (row.expires_at !== null && row.expires_at <= now)) return null;
  if (!active(row, env.environment)) return null;
  if (!hashesEqual(row.secret_hash, await credentialHash(parsed.secret))) return null;
  const principal = toPrincipal(row);
  return row.kind === 'HUMAN'
    ? { kind: 'human_credential', principal, credentialId: parsed.credentialId }
    : { kind: 'service', principal, credentialId: parsed.credentialId, operations: row.operations ?? [] };
}

async function byAccessToken(env: ApiEnv, db: Queryable, token: string): Promise<Caller | null> {
  const checked = await verifyAccessToken(env.secrets.tokenSigningKey, token);
  if (!checked.ok) return null;
  const { claims } = checked;
  if (accessTokenExpired(claims, Math.floor(env.clock().getTime() / 1000)) || claims.env !== env.environment)
    return null;
  const { rows } = await db.query<PrincipalRow>(
    `SELECT principal_id, kind, service_kind, display_name, status, environment FROM principals WHERE principal_id = $1`,
    [claims.sub],
  );
  const row = rows[0];
  if (row === undefined || row.kind !== 'HUMAN' || !active(row, env.environment)) return null;
  const roles = await db.query<{ role: Role }>(
    'SELECT role FROM principal_roles WHERE principal_id = $1 ORDER BY role',
    [claims.sub],
  );
  return { kind: 'human', principal: toPrincipal(row), roles: roles.rows.map((entry) => entry.role) };
}

async function byCapability(env: ApiEnv, db: Queryable, token: string): Promise<Caller | null> {
  const checked = await verifyCapability(env.secrets.tokenSigningKey, token);
  if (!checked.ok || checked.claims.env !== env.environment) return null;
  const { claims } = checked;
  const { rows } = await db.query<
    PrincipalRow & {
      attempt_id: string;
      ownership_revision: number;
      attempt_status: string;
      run_id: string | null;
      job_id: string | null;
      lease_status: string;
      expires_at: Date;
      capability_hash: string;
      newer: boolean;
    }
  >(
    `SELECT p.principal_id, p.kind, p.service_kind, p.display_name, p.status, p.environment,
            a.attempt_id, a.ownership_revision, a.status AS attempt_status, a.run_id, a.job_id,
            l.status AS lease_status, l.expires_at, l.capability_hash,
            EXISTS (SELECT 1 FROM attempts n
                     WHERE n.ownership_revision > a.ownership_revision
                       AND ((a.run_id IS NOT NULL AND n.run_id = a.run_id) OR (a.job_id IS NOT NULL AND n.job_id = a.job_id))) AS newer
       FROM attempts a
       JOIN leases l ON l.attempt_id = a.attempt_id
       JOIN principals p ON p.principal_id = $2
      WHERE a.attempt_id = $1`,
    [claims.att, claims.sub],
  );
  const row = rows[0];
  if (row === undefined || row.kind !== 'SERVICE' || !active(row, env.environment)) return null;
  // The token must be the one that this lease was granted with, for this revision.
  if (row.ownership_revision !== claims.own || !hashesEqual(row.capability_hash, await capabilityHash(token)))
    return null;
  const expired = row.lease_status !== 'HELD' || row.expires_at <= env.clock();
  const ended = ['COMPLETED', 'FAILED', 'CANCELLED'].includes(row.attempt_status);
  const state: AttemptState = row.newer
    ? 'stale'
    : ended
      ? 'ended'
      : row.attempt_status === 'CLAIMED' && !expired
        ? 'live'
        : 'lease_expired';
  return {
    kind: 'attempt',
    principal: toPrincipal(row),
    attempt: {
      attemptId: row.attempt_id,
      ownershipRevision: row.ownership_revision,
      state,
      leaseExpiresAt: row.expires_at,
      runId: row.run_id,
      jobId: row.job_id,
    },
  };
}

/** The caller of a request, or null when the credential is missing or not valid. */
export async function authenticate(env: ApiEnv, db: Queryable, authorization: string | null): Promise<Caller | null> {
  const token = bearer(authorization);
  if (token === undefined) return null;
  if (token.startsWith(`${tokenPrefixes.access}.`)) return byAccessToken(env, db, token);
  if (token.startsWith(`${tokenPrefixes.capability}.`)) return byCapability(env, db, token);
  return byCredential(env, db, token);
}

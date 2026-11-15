// auth.token: a person's long-lived credential for a 15-minute access token (OQ-05 section 9, D12). The token names
// the person and nothing else; roles are read from the database on every request. The issue is written in one
// transaction with its audit row (the credential id, never the secret).

import { writeAudit } from '../audit.ts';
import { ACCESS_TOKEN_SECONDS, signAccessToken } from '../auth/tokens.ts';
import { ApiFailure } from '../errors.ts';
import type { Role } from '../manifest.ts';
import { type AccessTokenView, utcTimestamp } from '../views.ts';
import { type Handler, json } from './context.ts';

export const authToken: Handler = async ({ env, db, caller, diagnosticRef }) => {
  if (caller.kind !== 'human_credential') throw new ApiFailure('FORBIDDEN', 'This credential may not call this route.');
  const issuedAt = Math.floor(env.clock().getTime() / 1000);
  const expiresAt = issuedAt + ACCESS_TOKEN_SECONDS;
  const roles = await db.query<{ role: Role }>(
    'SELECT role FROM principal_roles WHERE principal_id = $1 ORDER BY role',
    [caller.principal.id],
  );
  const accessToken = await signAccessToken(env.secrets.tokenSigningKey, {
    sub: caller.principal.id,
    env: env.environment,
    iat: issuedAt,
    exp: expiresAt,
  });
  await db.transaction((tx) =>
    writeAudit(tx, env.clock(), {
      eventType: 'auth.token_issued',
      actor: caller.principal.id,
      subject: caller.principal.id,
      diagnosticRef,
      detail: { credential_id: caller.credentialId, expires_at: utcTimestamp(new Date(expiresAt * 1000)) },
    }),
  );
  const view: AccessTokenView = {
    access_token: accessToken,
    token_type: 'Bearer',
    issued_at: utcTimestamp(new Date(issuedAt * 1000)),
    expires_at: utcTimestamp(new Date(expiresAt * 1000)),
    principal: { id: caller.principal.id, display_name: caller.principal.displayName, kind: 'HUMAN' },
    roles: roles.rows.map((row) => row.role),
  };
  return json(200, view);
};

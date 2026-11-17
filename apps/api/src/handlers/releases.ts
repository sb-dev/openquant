// releases.record (OQ-05 sections 9 and 11, OQ-06 section 3, decision D23). deploy.yml builds a release-manifest/1, and the
// protected delivery job records it here with the `deploy` service credential (or an Administrator does). The route
// answers with the system identity that it now serves, so the job reads back what was stored.
//
// A manifest is for one environment and states the migration level that the delivery job applied. Both must be those of
// this API: a manifest of another environment, or one that claims a migration level that the database is not at, is not
// recorded (IDENTITY_MISMATCH). The same manifest recorded twice is one record. Its request carries no expected
// revision, so the route lists no REVISION_CONFLICT.

import type { ReleaseManifest } from '@openquant/api-contracts';
import { canonicalJson, digest } from '@openquant/api-contracts';
import { writeAudit } from '../audit.ts';
import { readMigrationLevel } from '../db/migration-level.ts';
import { ApiFailure } from '../errors.ts';
import { type Handler, json } from './context.ts';
import { buildSystemIdentity } from './system-identity.ts';

export const recordRelease: Handler = async ({ env, db, caller, body, route }) => {
  if (body.kind !== 'contract') throw new Error('The release route has no manifest body.');
  const manifest = body.value as ReleaseManifest;
  if (manifest.environment !== env.environment) {
    throw new ApiFailure(
      'IDENTITY_MISMATCH',
      `The manifest is for ${manifest.environment}, and this API serves ${env.environment}.`,
    );
  }
  const level = await readMigrationLevel(db);
  if (manifest.migration_level !== level) {
    throw new ApiFailure(
      'IDENTITY_MISMATCH',
      'The migration level of the manifest is not the migration level of the database.',
    );
  }
  const manifestDigest = await digest(manifest);
  await db.transaction(async (tx) => {
    const inserted = await tx.query(
      `INSERT INTO release_records (environment, source_commit, manifest_digest, migration_level, document, recorded_by, recorded_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7) ON CONFLICT (environment, manifest_digest) DO NOTHING`,
      [
        manifest.environment,
        manifest.source_commit,
        manifestDigest,
        manifest.migration_level,
        canonicalJson(manifest),
        caller.principal.id,
        env.clock(),
      ],
    );
    if (inserted.rowCount === 1) {
      await writeAudit(tx, env.clock(), {
        eventType: 'release.recorded',
        actor: caller.principal.id,
        subject: manifestDigest,
        detail: { environment: manifest.environment, source_commit: manifest.source_commit },
      });
    }
  });
  return json(route.success_status, await buildSystemIdentity(env, db));
};
